package agent

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type Config struct {
	Server  string
	Token   string
	Version string
}

type stateData struct {
	Server     string `json:"server"`
	ServerID   string `json:"server_id"`
	AgentToken string `json:"agent_token"`
}

type Agent struct {
	cfg      *Config
	serverID string
	agentTok string
	dir      string
	credsDir string
	mu       sync.Mutex
}

type enrollResp struct {
	ServerID   string `json:"server_id"`
	AgentToken string `json:"agent_token"`
}

type wsCmd struct {
	Type    string          `json:"type"`
	ID      string          `json:"id"`
	Action  string          `json:"action"`
	Nonce   string          `json:"nonce"`
	Expires int64           `json:"expires_at"`
	Payload json.RawMessage `json:"payload"`
}

type setCredPayload struct {
	Tool        string            `json:"tool"`
	Credentials map[string]string `json:"credentials"`
}

type removeCredPayload struct {
	Tool           string   `json:"tool"`
	EnvKeysToRemove []string `json:"env_keys_to_remove"`
}

type writeConfigPayload struct {
	Tool    string `json:"tool"`
	Format  string `json:"format"`
	Content string `json:"content"`
}

type restTaskResponse struct {
	Task *restTask `json:"task"`
}

type restTask struct {
	ID      string          `json:"id"`
	Action  string          `json:"action"`
	Payload json.RawMessage `json:"payload"`
}

type restResultBody struct {
	Ok     bool            `json:"ok"`
	Result json.RawMessage `json:"result"`
	Error  string          `json:"error"`
}

func New(cfg *Config) (*Agent, error) {
	home, _ := os.UserHomeDir()
	dir := filepath.Join(home, ".ai-console-agent")
	credsDir := filepath.Join(dir, "creds")
	os.MkdirAll(credsDir, 0755)
	return &Agent{cfg: cfg, dir: dir, credsDir: credsDir}, nil
}

func (a *Agent) ServerID() string { return a.serverID }

func (a *Agent) loadState() bool {
	data, err := os.ReadFile(filepath.Join(a.dir, "state.json"))
	if err != nil {
		return false
	}
	var s stateData
	if err := json.Unmarshal(data, &s); err != nil {
		return false
	}
	if s.ServerID == "" || s.AgentToken == "" {
		return false
	}
	a.serverID = s.ServerID
	a.agentTok = s.AgentToken
	if s.Server != "" && a.cfg.Server == "" {
		a.cfg.Server = s.Server
	}
	log.Printf("loaded saved state: server_id=%s", a.serverID)
	return true
}

func (a *Agent) saveState() {
	state := stateData{
		Server:     a.cfg.Server,
		ServerID:   a.serverID,
		AgentToken: a.agentTok,
	}
	data, _ := json.Marshal(state)
	os.WriteFile(filepath.Join(a.dir, "state.json"), data, 0600)
}

func (a *Agent) Enroll(ctx context.Context) error {
	if a.loadState() && a.cfg.Token == "" {
		return nil
	}
	if a.cfg.Token == "" {
		return fmt.Errorf("no enroll token and no saved state")
	}

	host, _ := os.Hostname()
	body := map[string]interface{}{
		"token":    a.cfg.Token,
		"hostname": host,
		"os":       runtime.GOOS,
		"arch":     runtime.GOARCH,
		"host":     host,
		"version":  a.cfg.Version,
		"tools":    detectTools(),
	}
	data, _ := json.Marshal(body)
	req, _ := http.NewRequestWithContext(ctx, "POST", a.cfg.Server+"/agent/enroll", bytes.NewReader(data))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("enroll request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return fmt.Errorf("enroll failed %d: %s", resp.StatusCode, string(b))
	}
	var r enrollResp
	if err := json.NewDecoder(resp.Body).Decode(&r); err != nil {
		return fmt.Errorf("enroll decode: %w", err)
	}
	a.serverID = r.ServerID
	a.agentTok = r.AgentToken
	a.saveState()
	log.Printf("enrolled: server_id=%s", a.serverID)
	return nil
}

func (a *Agent) Run(ctx context.Context) error {
	if err := a.Enroll(ctx); err != nil {
		return err
	}

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		if err := a.connectWS(ctx); err != nil {
			log.Printf("ws error: %v, falling back to REST polling", err)
			a.pollRest(ctx)

		}

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(5 * time.Second):
		}
	}
}

func (a *Agent) connectWS(ctx context.Context) error {
	u, err := url.Parse(a.cfg.Server)
	if err != nil {
		return err
	}
	scheme := "ws"
	if u.Scheme == "https" {
		scheme = "wss"
	}
	wsURL := fmt.Sprintf("%s://%s/agent/ws?token=%s", scheme, u.Host, a.agentTok)

	conn, _, err := websocket.DefaultDialer.DialContext(ctx, wsURL, nil)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer conn.Close()

	log.Printf("ws connected")

	heartbeat := time.NewTicker(60 * time.Second)
	defer heartbeat.Stop()

	done := make(chan error, 1)
	go func() {
		for {
			_, msg, err := conn.ReadMessage()
			if err != nil {
				done <- err
				return
			}
			var cmd wsCmd
			if err := json.Unmarshal(msg, &cmd); err != nil {
				continue
			}
			if cmd.Type == "ack" {
				continue
			}
			if cmd.Type == "cmd" {
				go func(cmd wsCmd) {
					a.handleCmdWS(conn, &cmd)
				}(cmd)
			}
		}
	}()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case err := <-done:
			return err
		case <-heartbeat.C:
			a.sendHeartbeat(conn)
		}
	}
}

func (a *Agent) pollRest(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}

		req, _ := http.NewRequestWithContext(ctx, "GET", a.cfg.Server+"/agent/tasks", nil)
		req.Header.Set("Authorization", "Bearer "+a.agentTok)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			log.Printf("rest poll error: %v", err)
			continue
		}
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 65536))
		resp.Body.Close()
		if resp.StatusCode != 200 {
			log.Printf("rest poll: %d", resp.StatusCode)
			continue
		}

		var tr restTaskResponse
		if err := json.Unmarshal(body, &tr); err != nil || tr.Task == nil {
			continue
		}

		task := tr.Task
		log.Printf("rest task: %s %s", task.ID, task.Action)
		result, errStr := a.handleCmd(task.Action, task.Payload)
		ok := errStr == ""

		var resultJSON json.RawMessage
		if result != nil {
			resultJSON, _ = json.Marshal(result)
		}
		report := map[string]interface{}{
			"ok":     ok,
			"result": json.RawMessage{},
			"error":  errStr,
		}
		if resultJSON != nil {
			report["result"] = resultJSON
		}
		reportData, _ := json.Marshal(report)

		req2, _ := http.NewRequestWithContext(ctx, "POST",
			fmt.Sprintf("%s/agent/tasks/%s/result", a.cfg.Server, task.ID),
			bytes.NewReader(reportData))
		req2.Header.Set("Content-Type", "application/json")
		req2.Header.Set("Authorization", "Bearer "+a.agentTok)
		r, err := http.DefaultClient.Do(req2)
		if err != nil {
			log.Printf("rest report error: %v", err)
			continue
		}
		io.Copy(io.Discard, r.Body)
		r.Body.Close()

		// after processing a task, send heartbeat to update status
		a.restHeartbeat()
	}
}

func (a *Agent) restHeartbeat() {
	host, _ := os.Hostname()
	body := map[string]interface{}{
		"status":  "online",
		"host":    host,
		"tools":   detectTools(),
		"version": a.cfg.Version,
	}
	data, _ := json.Marshal(body)
	req, _ := http.NewRequestWithContext(context.Background(), "POST", a.cfg.Server+"/agent/heartbeat", bytes.NewReader(data))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+a.agentTok)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
}

func (a *Agent) sendHeartbeat(conn *websocket.Conn) {
	host, _ := os.Hostname()
	msg := map[string]interface{}{
		"type": "heartbeat",
		"id":   fmt.Sprintf("hb-%d", time.Now().UnixNano()),
		"payload": map[string]interface{}{
			"status":  "online",
			"host":    host,
			"tools":   detectTools(),
			"version": a.cfg.Version,
		},
	}
	b, _ := json.Marshal(msg)
	conn.WriteMessage(websocket.TextMessage, b)
}

func (a *Agent) handleCmdWS(conn *websocket.Conn, cmd *wsCmd) {
	result, errStr := a.handleCmd(cmd.Action, cmd.Payload)
	ok := errStr == ""
	a.sendResult(conn, cmd, ok, result, errStr)
}

func (a *Agent) sendResult(conn *websocket.Conn, cmd *wsCmd, ok bool, result map[string]interface{}, errStr string) {
	status := "ok"
	if !ok {
		status = "err"
	}
	msg := map[string]interface{}{
		"type":   "cmd_result",
		"id":     cmd.ID,
		"status": status,
		"payload": map[string]interface{}{
			"result": result,
			"error":  errStr,
		},
	}
	b, _ := json.Marshal(msg)
	conn.WriteMessage(websocket.TextMessage, b)
}

func (a *Agent) handleCmd(action string, payload []byte) (map[string]interface{}, string) {
	switch action {
	case "set_credential":
		return a.handleSetCred(payload)
	case "remove_credential":
		return a.handleRemoveCred(payload)
	case "read_config":
		return a.handleReadConfig(payload)
	case "write_config":
		return a.handleWriteConfig(payload)
	case "list_config_backups":
		return a.handleListBackups(payload)
	case "restore_config_backup":
		return a.handleRestoreBackup(payload)
	case "detect_tools":
		return map[string]interface{}{"tools": detectTools()}, ""
	case "upgrade_agent":
		return a.handleUpgradeAgent(payload)
	case "upgrade_tool":
		return a.handleUpgradeTool(payload)
	}
	return nil, fmt.Sprintf("unknown action: %s", action)
}

// --- credential handling ---

func (a *Agent) credFile(tool string) string {
	return filepath.Join(a.credsDir, tool+".sh")
}

func (a *Agent) handleSetCred(payload []byte) (map[string]interface{}, string) {
	var p setCredPayload
	if err := json.Unmarshal(payload, &p); err != nil {
		return nil, fmt.Sprintf("bad payload: %v", err)
	}

	var lines []string
	for k, v := range p.Credentials {
		lines = append(lines, fmt.Sprintf("export %s='%s'", k, shellEscape(v)))
	}
	content := strings.Join(lines, "\n") + "\n"

	path := a.credFile(p.Tool)
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		return nil, fmt.Sprintf("write %s: %v", path, err)
	}

	a.ensureCredSourcing()
	return map[string]interface{}{"path": path, "format": "shell", "keys": mapKeys(p.Credentials)}, ""
}

func (a *Agent) handleRemoveCred(payload []byte) (map[string]interface{}, string) {
	var p removeCredPayload
	if err := json.Unmarshal(payload, &p); err != nil {
		return nil, fmt.Sprintf("bad payload: %v", err)
	}

	result := map[string]interface{}{}
	var removed []string

	path := a.credFile(p.Tool)
	if _, err := os.Stat(path); err == nil {
		if err := os.Remove(path); err != nil {
			return nil, fmt.Sprintf("remove %s: %v", path, err)
		}
		removed = append(removed, path)
	}

	for _, k := range p.EnvKeysToRemove {
		os.Unsetenv(k)
	}

	result["removed"] = removed
	result["env_keys_cleared"] = p.EnvKeysToRemove
	return result, ""
}

// --- config handling ---

func toolConfigPath(tool string) string {
	home, _ := os.UserHomeDir()
	switch tool {
	case "codex":
		return filepath.Join(home, ".codex", "config.toml")
	case "claude":
		return filepath.Join(home, ".claude", "settings.json")
	case "gemini":
		return filepath.Join(home, ".gemini", "settings.json")
	case "opencode":
		return filepath.Join(home, ".config", "opencode", "opencode.json")
	}
	return ""
}

func (a *Agent) handleReadConfig(payload []byte) (map[string]interface{}, string) {
	var p writeConfigPayload
	json.Unmarshal(payload, &p)
	path := toolConfigPath(p.Tool)
	if path == "" {
		return nil, "unsupported tool"
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]interface{}{"content": "", "format": formatForTool(p.Tool), "path": path}, ""
		}
		return nil, fmt.Sprintf("read %s: %v", path, err)
	}
	return map[string]interface{}{"content": string(data), "format": formatForTool(p.Tool), "path": path}, ""
}

func (a *Agent) handleWriteConfig(payload []byte) (map[string]interface{}, string) {
	var p writeConfigPayload
	if err := json.Unmarshal(payload, &p); err != nil {
		return nil, fmt.Sprintf("bad payload: %v", err)
	}
	path := toolConfigPath(p.Tool)
	if path == "" {
		return nil, "unsupported tool"
	}
	os.MkdirAll(filepath.Dir(path), 0755)

	backupPath := backupFilePath(path)
	if existing, err := os.ReadFile(path); err == nil {
		os.WriteFile(backupPath, existing, 0644)
	}
	if err := os.WriteFile(path, []byte(p.Content), 0644); err != nil {
		return nil, fmt.Sprintf("write %s: %v", path, err)
	}
	return map[string]interface{}{"path": path, "format": p.Format, "content": p.Content, "backup": filepath.Base(backupPath)}, ""
}

// --- backups ---

func backupFilePath(path string) string {
	dir := filepath.Dir(path)
	base := filepath.Base(path)
	ts := time.Now().Format("20060102_150405")
	return filepath.Join(dir, fmt.Sprintf(".%s.bak.%s", base, ts))
}

func (a *Agent) handleListBackups(payload []byte) (map[string]interface{}, string) {
	var p writeConfigPayload
	json.Unmarshal(payload, &p)
	path := toolConfigPath(p.Tool)
	if path == "" {
		return nil, "unsupported tool"
	}
	dir := filepath.Dir(path)
	prefix := fmt.Sprintf(".%s.bak.", filepath.Base(path))
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Sprintf("list %s: %v", dir, err)
	}
	var backups []string
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), prefix) {
			backups = append(backups, e.Name())
		}
	}
	return map[string]interface{}{"backups": backups, "path": path}, ""
}

func (a *Agent) handleRestoreBackup(payload []byte) (map[string]interface{}, string) {
	var p struct {
		Tool   string `json:"tool"`
		Backup string `json:"backup"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return nil, fmt.Sprintf("bad payload: %v", err)
	}
	path := toolConfigPath(p.Tool)
	if path == "" {
		return nil, "unsupported tool"
	}
	dir := filepath.Dir(path)
	backupPath := filepath.Join(dir, p.Backup)
	if p.Backup == "" {
		entries, _ := os.ReadDir(dir)
		var latest string
		var latestTs time.Time
		prefix := fmt.Sprintf(".%s.bak.", filepath.Base(path))
		for _, e := range entries {
			if !strings.HasPrefix(e.Name(), prefix) {
				continue
			}
			info, _ := e.Info()
			if info.ModTime().After(latestTs) {
				latestTs = info.ModTime()
				latest = e.Name()
			}
		}
		if latest == "" {
			return nil, "no backups found"
		}
		backupPath = filepath.Join(dir, latest)
	}
	data, err := os.ReadFile(backupPath)
	if err != nil {
		return nil, fmt.Sprintf("read backup %s: %v", backupPath, err)
	}
	currentBackup := backupFilePath(path)
	if existing, err := os.ReadFile(path); err == nil {
		os.WriteFile(currentBackup, existing, 0644)
	}
	if err := os.WriteFile(path, data, 0644); err != nil {
		return nil, fmt.Sprintf("restore %s: %v", path, err)
	}
	return map[string]interface{}{"path": path, "restored_from": filepath.Base(backupPath), "backup_of_current": filepath.Base(currentBackup)}, ""
}

// --- upgrade ---

func (a *Agent) handleUpgradeAgent(payload []byte) (map[string]interface{}, string) {
	exe, _ := os.Executable()
	oldVersion := a.cfg.Version

	url := fmt.Sprintf("%s/agent/binary/%s/%s", a.cfg.Server, runtime.GOOS, runtime.GOARCH)
	resp, err := http.Get(url)
	if err != nil {
		return nil, fmt.Sprintf("download: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return nil, fmt.Sprintf("download failed %d: %s", resp.StatusCode, string(b))
	}

	tmpPath := exe + ".new"
	f, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0700)
	if err != nil {
		return nil, fmt.Sprintf("create tmp: %v", err)
	}
	n, err := io.Copy(f, resp.Body)
	f.Close()
	if err != nil {
		os.Remove(tmpPath)
		return nil, fmt.Sprintf("write tmp: %v", err)
	}
	if n < 1024 {
		os.Remove(tmpPath)
		return nil, fmt.Sprintf("downloaded binary too small (%d bytes)", n)
	}

	test := exec.Command(tmpPath, "--version")
	test.Stdout = io.Discard
	test.Stderr = io.Discard
	if err := test.Run(); err != nil {
		os.Remove(tmpPath)
		return nil, fmt.Sprintf("new binary is not executable: %v", err)
	}

	backupPath := exe + ".bak"
	os.Remove(backupPath)
	if err := os.Rename(exe, backupPath); err != nil {
		os.Remove(tmpPath)
		return nil, fmt.Sprintf("backup current: %v", err)
	}
	if err := os.Rename(tmpPath, exe); err != nil {
		os.Rename(backupPath, exe)
		os.Remove(tmpPath)
		return nil, fmt.Sprintf("install new: %v", err)
	}

	go func() { time.Sleep(200 * time.Millisecond); os.Exit(0) }()

	return map[string]interface{}{
		"old_version": oldVersion,
		"new_version": a.cfg.Version,
		"path":        exe,
		"backup":      backupPath,
		"restart":     "agent will restart with new binary",
	}, ""
}

func (a *Agent) handleUpgradeTool(payload []byte) (map[string]interface{}, string) {
	var p struct {
		Tool    string `json:"tool"`
		Version string `json:"version"`
	}
	json.Unmarshal(payload, &p)
	out, _ := exec.Command(p.Tool, "--version").CombinedOutput()
	return map[string]interface{}{"tool": p.Tool, "old_version": firstLine(string(out)), "new_version": p.Version}, ""
}

// --- helpers ---

func detectTools() []map[string]interface{} {
	var tools []map[string]interface{}
	for _, t := range []string{"codex", "claude", "gemini", "opencode"} {
		path, _ := exec.LookPath(t)
		installed := path != ""
		version := ""
		if installed {
			out, err := exec.Command(t, "--version").CombinedOutput()
			if err == nil {
				version = firstLine(string(out))
			}
		}
		tools = append(tools, map[string]interface{}{
			"name": t, "installed": installed, "version": version, "path": path,
		})
	}
	return tools
}

func (a *Agent) ensureCredSourcing() {
	home, _ := os.UserHomeDir()
	for _, rc := range []string{".bashrc", ".zshrc"} {
		rcfile := filepath.Join(home, rc)
		if _, err := os.Stat(rcfile); err != nil {
			continue
		}
		data, _ := os.ReadFile(rcfile)
		if bytes.Contains(data, []byte(".ai-console-agent/creds")) {
			continue
		}
		f, err := os.OpenFile(rcfile, os.O_APPEND|os.O_WRONLY, 0644)
		if err != nil {
			continue
		}
		fmt.Fprintf(f, "\n# AI Console: auto-load credentials\nfor f in \"$HOME\"/.ai-console-agent/creds/*.sh; do\n  [ -f \"$f\" ] && . \"$f\"\ndone\n")
		f.Close()
	}
}

func shellEscape(s string) string { return strings.ReplaceAll(s, "'", "'\"'\"'") }
func mapKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m { keys = append(keys, k) }
	return keys
}
func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 { return s[:i] }
	return s
}
func formatForTool(tool string) string {
	if tool == "codex" { return "toml" }
	return "json"
}
func fingerprint(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])[:12]
}
