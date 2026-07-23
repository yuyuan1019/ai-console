package agent

import (
	"bytes"
	"context"
	"crypto/rand"
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
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// ponytail (BUG-05, 2.0): protocol version is hard-coded to 2. The server
// refuses any other value at enroll/heartbeat/ws-handshake. No back-compat
// fallback lives in this binary.
const ProtocolVersion = 2

type Config struct {
	Server  string
	Token   string
	Version string
}

type stateData struct {
	Server          string `json:"server"`
	ServerID        string `json:"server_id"`
	AgentToken      string `json:"agent_token"`
	AgentInstanceID string `json:"agent_instance_id"`
}

type Agent struct {
	cfg        *Config
	serverID   string
	agentTok   string
	instanceID string
	dir        string
	credsDir   string
	journal    *taskJournal
	mu         sync.Mutex
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
	Tool           string            `json:"tool"`
	Credentials    map[string]string `json:"credentials"`
	CredentialType string            `json:"credential_type"`
	CredentialJSON string            `json:"credential_json"`
}

type removeCredPayload struct {
	Tool            string   `json:"tool"`
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
	ID        string          `json:"id"`
	Action    string          `json:"action"`
	Nonce     string          `json:"nonce"`
	ExpiresAt int64           `json:"expires_at"`
	Payload   json.RawMessage `json:"payload"`
}

func New(cfg *Config) (*Agent, error) {
	home, _ := os.UserHomeDir()
	dir := filepath.Join(home, ".ai-console-agent")
	credsDir := filepath.Join(dir, "creds")
	// ponytail (BUG-01): private dirs. 0700 is required so peer users on the
	// host can't list creds/*.sh or read the state.json that pins server ID
	// and long-lived agent token. MkdirAll is idempotent; if it fails we still
	// return the Agent so the caller can log/exit — permission enforcement is
	// re-attempted at every startup via enforceOwnedPathPermissions().
	os.MkdirAll(dir, 0700)
	os.MkdirAll(credsDir, 0700)
	_ = os.Chmod(dir, 0700)
	_ = os.Chmod(credsDir, 0700)
	journal, jerr := openTaskJournal(filepath.Join(dir, "task-journal.json"))
	if jerr != nil {
		// ponytail (BUG-05): journal load errors are logged but don't abort;
		// journal is best-effort de-dup, not a correctness gate. Fresh install
		// will start with an empty journal and rebuild the file on first write.
		log.Printf("task-journal load: %v (continuing with empty journal)", jerr)
	}
	return &Agent{cfg: cfg, dir: dir, credsDir: credsDir, journal: journal}, nil
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
	a.instanceID = s.AgentInstanceID
	if s.Server != "" && a.cfg.Server == "" {
		a.cfg.Server = s.Server
	}
	log.Printf("loaded saved state: server_id=%s", a.serverID)
	return true
}

func (a *Agent) saveState() error {
	if a.instanceID == "" {
		// ponytail (BUG-08): every agent must persist a UUID before it can
		// enroll. Generated on first startup and locked to state.json.
		a.instanceID = newUUIDv4()
	}
	state := stateData{
		Server:          a.cfg.Server,
		ServerID:        a.serverID,
		AgentToken:      a.agentTok,
		AgentInstanceID: a.instanceID,
	}
	data, err := json.Marshal(state)
	if err != nil {
		return fmt.Errorf("marshal state: %w", err)
	}
	// ponytail (BUG-08): atomic + 0600. Bare WriteFile would leave a torn
	// state.json if the process crashes mid-write; a partial JSON also breaks
	// the instance-id locking. writeFileAtomic handles the tempfile+sync+
	// rename dance so recovery is deterministic.
	if err := writeFileAtomic(filepath.Join(a.dir, "state.json"), data, 0600); err != nil {
		return fmt.Errorf("save state: %w", err)
	}
	return nil
}

// newUUIDv4 returns a random UUID (RFC 4122 §4.4). We use crypto/rand instead
// of pulling in a UUID module to keep the agent binary standard-library-only.
func newUUIDv4() string {
	var b [16]byte
	_, err := rand.Read(b[:])
	if err != nil {
		// crypto/rand should never fail on supported platforms; a fallback
		// pseudorandom UUID would violate BUG-08's uniqueness contract, so
		// panic here so the caller sees the failure and refuses to enroll.
		panic(fmt.Sprintf("crypto/rand failed: %v", err))
	}
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant RFC 4122
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func (a *Agent) Enroll(ctx context.Context) error {
	if a.loadState() && a.cfg.Token == "" {
		// ponytail (BUG-08): if state.json is missing agent_instance_id
		// (fresh install may pre-date it), persist a new UUID now.
		if a.instanceID == "" {
			if err := a.saveState(); err != nil {
				return fmt.Errorf("persist instance id: %w", err)
			}
		}
		return nil
	}
	if a.cfg.Token == "" {
		return fmt.Errorf("no enroll token and no saved state")
	}

	// ponytail (BUG-08): mint the instance UUID BEFORE enrolling so the
	// enroll body carries it; server rejects enroll without agent_instance_id.
	if a.instanceID == "" {
		a.instanceID = newUUIDv4()
	}
	host, _ := os.Hostname()
	body := map[string]interface{}{
		"token":             a.cfg.Token,
		"hostname":          host,
		"os":                runtime.GOOS,
		"arch":              runtime.GOARCH,
		"host":              host,
		"version":           a.cfg.Version,
		"protocol_version":  ProtocolVersion,
		"agent_instance_id": a.instanceID,
		"tools":             detectTools(),
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
	// ponytail (BUG-08): persist state before returning. Enroll consumed a
	// one-time token; if we drop the agent token now nothing recovers.
	if err := a.saveState(); err != nil {
		return fmt.Errorf("enroll persist state: %w", err)
	}
	log.Printf("enrolled: server_id=%s", a.serverID)
	return nil
}

func (a *Agent) Run(ctx context.Context) error {
	if err := a.Enroll(ctx); err != nil {
		return err
	}

	// ponytail (BUG-01): tighten permissions on known Agent-owned paths every
	// startup. Not a one-shot migration — idempotent, symlink-safe (Lstat), and
	// no delete/move/rewrite. Recovers from partial failures on a later boot.
	a.enforceOwnedPathPermissions()

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

// enforceOwnedPathPermissions runs at every startup. It only chmods known
// files/dirs; never deletes, moves, renames or rewrites content. It uses
// os.Lstat to avoid following symlinks — an attacker who could plant a
// symlink inside a known dir must not be able to redirect chmod onto a file
// outside the known set. Failures are logged but do not block startup, and
// the next startup will retry each item.
//
// Files considered "owned" by the Agent for the purposes of this scan:
//   - ~/.ai-console-agent (dir) and creds/ subdir     → 0700
//   - creds/*.sh                                       → 0600
//   - state.json, task-journal.json                    → 0600
//   - each tool's config file (~/.codex/config.toml, ~/.claude/settings.json,
//     ~/.gemini/settings.json, ~/.config/opencode/opencode.json)
//     and its parent directory                         → 0600 / 0700
//   - ~/.codex/auth.json, ~/.claude/.credentials.json → 0600
//   - .<basename>.bak.* files inside each config dir   → 0600
//
// The purpose is to close the historical 0644 permission surface without
// touching content. Symlinks and non-regular files are skipped.
func (a *Agent) enforceOwnedPathPermissions() {
	chmodFile := func(path string, mode os.FileMode) {
		info, err := os.Lstat(path)
		if err != nil {
			return
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return // never follow symlinks
		}
		if !info.Mode().IsRegular() {
			return
		}
		if err := os.Chmod(path, mode); err != nil {
			log.Printf("perm fixup: chmod %s -> %04o failed: %v", path, mode, err)
		}
	}
	chmodDir := func(path string, mode os.FileMode) {
		info, err := os.Lstat(path)
		if err != nil {
			return
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return
		}
		if !info.IsDir() {
			return
		}
		if err := os.Chmod(path, mode); err != nil {
			log.Printf("perm fixup: chmod dir %s -> %04o failed: %v", path, mode, err)
		}
	}
	chmodBackups := func(dir string) {
		entries, err := os.ReadDir(dir)
		if err != nil {
			return
		}
		for _, e := range entries {
			name := e.Name()
			if !strings.Contains(name, ".bak.") {
				continue
			}
			chmodFile(filepath.Join(dir, name), 0600)
		}
	}

	// Agent-private paths.
	chmodDir(a.dir, 0700)
	chmodDir(a.credsDir, 0700)
	chmodFile(filepath.Join(a.dir, "state.json"), 0600)
	chmodFile(filepath.Join(a.dir, "task-journal.json"), 0600)
	if entries, err := os.ReadDir(a.credsDir); err == nil {
		for _, e := range entries {
			if strings.HasSuffix(e.Name(), ".sh") {
				chmodFile(filepath.Join(a.credsDir, e.Name()), 0600)
			}
		}
	}

	// Tool config paths + backups. Skip if the dir doesn't exist yet (nothing
	// to tighten on a fresh host).
	for _, tool := range []string{"codex", "claude", "gemini", "opencode"} {
		cfgPath := toolConfigPath(tool)
		if cfgPath == "" {
			continue
		}
		dir := filepath.Dir(cfgPath)
		if _, err := os.Lstat(dir); err != nil {
			continue
		}
		chmodDir(dir, 0700)
		chmodFile(cfgPath, 0600)
		chmodBackups(dir)
	}

	// Account-login secret files live next to each tool's config.
	chmodFile(a.codexAuthFile(), 0600)
	chmodFile(a.claudeAccountCredentialFile(), 0600)
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
	// ponytail (BUG-05, 2.0): agent token goes in Authorization header, NOT
	// in the URL query. Reverse-proxy access logs, browser history and error
	// dumps commonly retain query strings; a leaked long-lived agent token is
	// full remote control.
	wsURL := fmt.Sprintf("%s://%s/agent/ws", scheme, u.Host)
	header := http.Header{}
	header.Set("Authorization", "Bearer "+a.agentTok)
	// ponytail (DSM): some reverse proxies (Synology DSM reverse proxy) strip
	// the standard Authorization header before it reaches the backend. Mirror
	// the token into a custom X-Agent-Token header, which unknown custom
	// headers pass through untouched. The server accepts either (see
	// agentTokenFromRequest in routes.ts). Sent on every authed request below.
	header.Set("X-Agent-Token", a.agentTok)

	conn, _, err := websocket.DefaultDialer.DialContext(ctx, wsURL, header)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer conn.Close()

	log.Printf("ws connected")

	// ponytail: ping/pong detects half-open connections. A reverse proxy idle
	// timeout (nginx default 60s) closes the link silently; without read
	// deadlines the agent never notices and tasks never arrive. Pong resets
	// the read deadline; 25s ping stays under the 60s proxy_read_timeout.
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(90 * time.Second))
		return nil
	})
	conn.SetReadDeadline(time.Now().Add(90 * time.Second))

	// Initial protocol-2 heartbeat so the server can record protocol_version
	// on the servers row before dispatching backlog. Without this the server's
	// backlog flush would find agent_protocol_version=NULL (impossible under
	// 019's CHECK, but defensive) and skip us.
	a.sendHeartbeat(conn)

	heartbeat := time.NewTicker(25 * time.Second)
	defer heartbeat.Stop()

	// ponytail (BUG-05): task worker channel + single consumer goroutine. Old
	// design spawned an unbounded per-command goroutine, so two writes racing
	// through handleWriteConfig on the same tool file could interleave. 2.0:
	// each command executes sequentially. Buffer 64 is a soft cap; Console
	// enforces the "one running per server" invariant so the queue normally
	// stays at 0-1.
	cmdQueue := make(chan wsCmd, 64)
	workerDone := make(chan struct{})
	// Lease ticker tracks the currently-executing task so the worker can
	// renew via WS cmd_lease every 45s. Runs on the worker goroutine so it
	// naturally stops between tasks.
	go func() {
		defer close(workerDone)
		for cmd := range cmdQueue {
			a.handleCmdWSWithLease(ctx, conn, &cmd)
		}
	}()

	done := make(chan error, 1)
	go func() {
		for {
			_, msg, err := conn.ReadMessage()
			if err != nil {
				done <- err
				return
			}
			conn.SetReadDeadline(time.Now().Add(90 * time.Second))
			var cmd wsCmd
			if err := json.Unmarshal(msg, &cmd); err != nil {
				continue
			}
			if cmd.Type == "ack" || cmd.Type == "cmd_lease_ack" || cmd.Type == "cmd_result_rejected" {
				continue
			}
			if cmd.Type == "cmd" {
				select {
				case cmdQueue <- cmd:
				default:
					// ponytail (BUG-05): queue full is a hard signal. Report
					// a nonce-bound failure so Console can retry (attempt_count
					// increments) rather than silently drop a command that
					// would then hit the reaper.
					a.sendResult(conn, &cmd, false, nil, "agent queue full")
				}
			}
		}
	}()

	for {
		select {
		case <-ctx.Done():
			close(cmdQueue)
			<-workerDone
			return ctx.Err()
		case err := <-done:
			close(cmdQueue)
			<-workerDone
			return err
		case <-heartbeat.C:
			if err := a.wsWritePing(conn); err != nil {
				close(cmdQueue)
				<-workerDone
				return err
			}
			a.sendHeartbeat(conn)
		}
	}
}

func (a *Agent) pollRest(ctx context.Context) {
	// ponytail: single round then return, so Run retries WS. Previously this
	// looped forever, trapping the agent in REST mode and never reconnecting
	// WS. Heartbeat every round keeps console status honest even with no tasks
	// (previously only sent after a task).
	select {
	case <-ctx.Done():
		return
	case <-time.After(30 * time.Second):
	}

	a.restHeartbeat()

	req, _ := http.NewRequestWithContext(ctx, "GET", a.cfg.Server+"/agent/tasks", nil)
	req.Header.Set("Authorization", "Bearer "+a.agentTok)
	req.Header.Set("X-Agent-Token", a.agentTok)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		log.Printf("rest poll error: %v", err)
		return
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 65536))
	resp.Body.Close()
	if resp.StatusCode != 200 {
		log.Printf("rest poll: %d", resp.StatusCode)
		return
	}

	var tr restTaskResponse
	if err := json.Unmarshal(body, &tr); err != nil || tr.Task == nil {
		return
	}

	task := tr.Task
	log.Printf("rest task: %s %s", task.ID, task.Action)
	// ponytail (BUG-05): journal-hit fast-path also here — REST claim can hit
	// a task the agent already completed if the previous result POST failed
	// after successful side-effects.
	if cached, ok := a.journalGet(task.ID); ok {
		a.restReport(ctx, task.ID, task.Nonce, cached.Ok, cached.Result, cached.Error)
		return
	}
	result, errStr := a.handleCmd(task.Action, task.Payload)
	ok := errStr == ""
	// Account-login documents contain refresh tokens. The read is idempotent,
	// so never cache its plaintext result in task-journal.json; if reporting
	// fails, a re-delivery safely reads the source file again.
	if task.Action != "read_account_credential" {
		a.journalPut(task.ID, task.Action, ok, result, errStr)
	}
	a.restReport(ctx, task.ID, task.Nonce, ok, result, errStr)
}

func (a *Agent) restReport(ctx context.Context, taskID, nonce string, ok bool, result map[string]interface{}, errStr string) {
	var resultJSON json.RawMessage
	if result != nil {
		resultJSON, _ = json.Marshal(result)
	}
	report := map[string]interface{}{
		"nonce":  nonce,
		"ok":     ok,
		"result": json.RawMessage("{}"),
		"error":  errStr,
	}
	if resultJSON != nil {
		report["result"] = resultJSON
	}
	reportData, _ := json.Marshal(report)

	req2, _ := http.NewRequestWithContext(ctx, "POST",
		fmt.Sprintf("%s/agent/tasks/%s/result", a.cfg.Server, taskID),
		bytes.NewReader(reportData))
	req2.Header.Set("Content-Type", "application/json")
	req2.Header.Set("Authorization", "Bearer "+a.agentTok)
	req2.Header.Set("X-Agent-Token", a.agentTok)
	r, err := http.DefaultClient.Do(req2)
	if err != nil {
		log.Printf("rest report error: %v", err)
		return
	}
	io.Copy(io.Discard, r.Body)
	r.Body.Close()
}

func (a *Agent) restHeartbeat() {
	host, _ := os.Hostname()
	body := map[string]interface{}{
		"status":           "online",
		"host":             host,
		"tools":            detectTools(),
		"version":          a.cfg.Version,
		"protocol_version": ProtocolVersion,
	}
	data, _ := json.Marshal(body)
	req, _ := http.NewRequestWithContext(context.Background(), "POST", a.cfg.Server+"/agent/heartbeat", bytes.NewReader(data))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+a.agentTok)
	req.Header.Set("X-Agent-Token", a.agentTok)
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
			"status":           "online",
			"host":             host,
			"tools":            detectTools(),
			"version":          a.cfg.Version,
			"protocol_version": ProtocolVersion,
		},
	}
	b, _ := json.Marshal(msg)
	a.wsWriteText(conn, b)
}

// handleCmdWSWithLease wraps handleCmdWS with:
//   - journal fast-path so a re-delivered task returns the cached result
//     instead of re-executing side effects,
//   - a 45s lease-renew ticker over WS so the console reaper doesn't reclaim
//     the task while a long-running action (e.g. tool upgrade) is in flight.
func (a *Agent) handleCmdWSWithLease(ctx context.Context, conn *websocket.Conn, cmd *wsCmd) {
	// bug 25: Expires（ms epoch）是 WS cmd 协议字段，落地校验——队列延迟或重放
	// 导致过期命令不应被执行。cmd.Expires==0 视为无 deadline。
	if cmd.Expires > 0 && time.Now().UnixMilli() > cmd.Expires {
		a.sendResult(conn, cmd, false, nil, "command expired")
		return
	}
	if cached, ok := a.journalGet(cmd.ID); ok {
		a.sendResult(conn, cmd, cached.Ok, cached.Result, cached.Error)
		return
	}

	// ponytail (BUG-05): renew the lease every 45s while the action runs.
	// 2 minute server-side extension per call; task journal captures the
	// final result before Exit for the upgrade path.
	leaseCtx, cancelLease := context.WithCancel(ctx)
	defer cancelLease()
	go func() {
		ticker := time.NewTicker(45 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-leaseCtx.Done():
				return
			case <-ticker.C:
				msg, _ := json.Marshal(map[string]interface{}{
					"type":  "cmd_lease",
					"id":    cmd.ID,
					"nonce": cmd.Nonce,
				})
				if err := a.wsWriteText(conn, msg); err != nil {
					return
				}
			}
		}
	}()

	result, errStr := a.handleCmd(cmd.Action, cmd.Payload)
	ok := errStr == ""
	// ponytail (BUG-05): persist to journal BEFORE reporting. If the network
	// drops between here and the ack, the redelivery path finds the entry.
	// Exception: account credential reads are idempotent and contain refresh
	// tokens, so persisting their result would create a second plaintext copy.
	if cmd.Action != "read_account_credential" {
		a.journalPut(cmd.ID, cmd.Action, ok, result, errStr)
	}
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
		"nonce":  cmd.Nonce,
		"status": status,
		"payload": map[string]interface{}{
			"result": result,
			"error":  errStr,
		},
	}
	b, _ := json.Marshal(msg)
	a.wsWriteText(conn, b)
}

// wsWriteText serializes WS writes; gorilla/websocket allows only one
// concurrent writer. ponytail: handleCmdWS runs per-command goroutines that
// race with sendHeartbeat — unsynchronized writes corrupt frames and can
// drop the connection (one more cause of "quickly offline").
// wsWriteText serializes WS writes; gorilla/websocket allows only one
// concurrent writer. ponytail: handleCmdWS runs per-command goroutines that
// race with sendHeartbeat — unsynchronized writes corrupt frames and can
// drop the connection (one more cause of "quickly offline").
// 写超时确保对端停读 WS 帧时 WriteMessage 不会永久阻塞并持 a.mu，否则
// wsWritePing/sendHeartbeat 也被卡死，绕过 90s 读超时恢复路径（bug 15）。
func (a *Agent) wsWriteText(conn *websocket.Conn, b []byte) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return conn.WriteMessage(websocket.TextMessage, b)
}

func (a *Agent) wsWritePing(conn *websocket.Conn) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	return conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second))
}

func (a *Agent) handleCmd(action string, payload []byte) (map[string]interface{}, string) {
	switch action {
	case "set_credential":
		return a.handleSetCred(payload)
	case "remove_credential":
		return a.handleRemoveCred(payload)
	case "read_config":
		return a.handleReadConfig(payload)
	case "read_account_credential":
		return a.handleReadAccountCredential(payload)
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
	case "manage_tool":
		return a.handleManageTool(payload)
	}
	return nil, fmt.Sprintf("unknown action: %s", action)
}

// --- credential handling ---

// validTools mirrors the toolConfigPath switch: only these tools may name a
// credential or config file. Anything else is rejected to prevent
// filepath.Join(credsDir, tool+".sh") from escaping credsDir (bug 13).
var validTools = map[string]bool{"codex": true, "claude": true, "gemini": true, "opencode": true, "pi": true, "hermes": true}

func validTool(tool string) bool { return validTools[tool] }

// envKeyRe matches a POSIX/shell-safe environment variable name. Credential
// keys are interpolated raw into `export KEY='...'`, so an unchecked key like
// "foo; rm -rf ~; bar" would be executed when the creds file is sourced (bug 14).
var envKeyRe = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

func (a *Agent) credFile(tool string) string {
	return filepath.Join(a.credsDir, tool+".sh")
}

// ponytail: codex stores its key in ~/.codex/auth.json (codex-native, env-free).
// config.toml uses requires_openai_auth=true so codex reads the key from here.
func (a *Agent) codexAuthFile() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".codex", "auth.json")
}

func (a *Agent) claudeAccountCredentialFile() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".claude", ".credentials.json")
}

func validateAccountCredential(tool string, data []byte) error {
	var root map[string]interface{}
	if err := json.Unmarshal(data, &root); err != nil {
		return fmt.Errorf("credential is not valid JSON: %v", err)
	}
	stringField := func(values map[string]interface{}, key string) string {
		value, _ := values[key].(string)
		return strings.TrimSpace(value)
	}
	if tool == "codex" {
		tokens, ok := root["tokens"].(map[string]interface{})
		if !ok || stringField(tokens, "access_token") == "" || stringField(tokens, "refresh_token") == "" {
			return fmt.Errorf("Codex auth.json has no account access/refresh tokens")
		}
		return nil
	}
	if tool == "claude" {
		oauth, ok := root["claudeAiOauth"].(map[string]interface{})
		if !ok || stringField(oauth, "accessToken") == "" || stringField(oauth, "refreshToken") == "" {
			return fmt.Errorf("Claude credentials have no subscription access/refresh tokens")
		}
		return nil
	}
	return fmt.Errorf("account credentials are unsupported for %s", tool)
}

func (a *Agent) handleReadAccountCredential(payload []byte) (map[string]interface{}, string) {
	var p struct {
		Tool string `json:"tool"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return nil, fmt.Sprintf("bad payload: %v", err)
	}
	var path string
	if p.Tool == "codex" {
		path = a.codexAuthFile()
	} else if p.Tool == "claude" {
		path = a.claudeAccountCredentialFile()
	} else {
		return nil, "account credential import supports only codex and claude"
	}
	data, err := os.ReadFile(path)
	if err != nil && p.Tool == "claude" && runtime.GOOS == "darwin" {
		// Claude Code stores subscription credentials in Login Keychain on some
		// macOS versions instead of ~/.claude/.credentials.json.
		data, err = exec.Command("security", "find-generic-password", "-s", "Claude Code-credentials", "-w").Output()
		if err == nil {
			path = "macOS Keychain: Claude Code-credentials"
		}
	}
	if err != nil {
		loginCommand := "codex login"
		if p.Tool == "claude" {
			loginCommand = "claude auth login"
		}
		return nil, fmt.Sprintf("read %s: %v; log in with `%s` on this machine first", path, err, loginCommand)
	}
	if len(data) > 1024*1024 {
		return nil, "account credential file exceeds 1 MiB"
	}
	if err := validateAccountCredential(p.Tool, data); err != nil {
		return nil, err.Error()
	}
	return map[string]interface{}{"tool": p.Tool, "path": path, "format": "json", "content": string(data)}, ""
}

func (a *Agent) handleSetCred(payload []byte) (map[string]interface{}, string) {
	var p setCredPayload
	if err := json.Unmarshal(payload, &p); err != nil {
		return nil, fmt.Sprintf("bad payload: %v", err)
	}
	// bug 13: 白名单校验 tool，防止 credFile 拼接出 credsDir 之外的路径。
	if !validTool(p.Tool) {
		return nil, "unsupported tool"
	}

	if p.Tool == "opencode" || p.Tool == "pi" || p.Tool == "hermes" {
		// These tools keep provider credentials inside their native config file;
		// write_config owns delivery and no shell credential file is needed.
		return map[string]interface{}{"format": "inline-config", "keys": []string{}}, ""
	}

	if p.CredentialType != "" {
		expected := map[string]string{"codex": "codex_subscription", "claude": "claude_subscription"}[p.Tool]
		if expected == "" || p.CredentialType != expected {
			return nil, "credential type does not match tool"
		}
		data := []byte(p.CredentialJSON)
		if err := validateAccountCredential(p.Tool, data); err != nil {
			return nil, err.Error()
		}
		path := a.codexAuthFile()
		if p.Tool == "claude" {
			path = a.claudeAccountCredentialFile()
		}
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			return nil, fmt.Sprintf("mkdir %s: %v", filepath.Dir(path), err)
		}
		_ = os.Chmod(filepath.Dir(path), 0700)
		backup := ""
		if existing, err := os.ReadFile(path); err == nil {
			backupPath := backupFilePath(path)
			if err := writeFileAtomic(backupPath, existing, 0600); err != nil {
				return nil, fmt.Sprintf("backup %s: %v", backupPath, err)
			}
			backup = filepath.Base(backupPath)
		}
		if err := writeFileAtomic(path, data, 0600); err != nil {
			return nil, fmt.Sprintf("write %s: %v", path, err)
		}
		return map[string]interface{}{"path": path, "format": "subscription-json", "credential_type": p.CredentialType, "backup": backup}, ""
	}

	if p.Tool == "codex" {
		key := p.Credentials["OPENAI_API_KEY"]
		if key == "" {
			return nil, "missing OPENAI_API_KEY for codex"
		}
		authJSON, _ := json.Marshal(map[string]string{"OPENAI_API_KEY": key})
		path := a.codexAuthFile()
		// BUG-01: codex config dir 0700; atomic write of auth.json 0600.
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			return nil, fmt.Sprintf("mkdir %s: %v", filepath.Dir(path), err)
		}
		_ = os.Chmod(filepath.Dir(path), 0700)
		if err := writeFileAtomic(path, authJSON, 0600); err != nil {
			return nil, fmt.Sprintf("write %s: %v", path, err)
		}
		return map[string]interface{}{"path": path, "format": "auth.json", "keys": []string{"OPENAI_API_KEY"}}, ""
	}

	var lines []string
	for k, v := range p.Credentials {
		// bug 14: key 原样插值进 `export KEY='...'`，不校验会被 .bashrc source 时 RCE。
		if !envKeyRe.MatchString(k) {
			return nil, "invalid credential key: " + k
		}
		lines = append(lines, fmt.Sprintf("export %s='%s'", k, shellEscape(v)))
	}
	content := strings.Join(lines, "\n") + "\n"

	path := a.credFile(p.Tool)
	// BUG-01: atomic + 0600. writeFileAtomic also runs an explicit chmod after
	// rename so an inherited 0644 file (from an older agent) is tightened.
	if err := writeFileAtomic(path, []byte(content), 0600); err != nil {
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
	// bug 13: 白名单校验 tool。
	if !validTool(p.Tool) {
		return nil, "unsupported tool"
	}

	result := map[string]interface{}{}
	var removed []string

	if p.Tool == "codex" {
		authPath := a.codexAuthFile()
		if _, err := os.Stat(authPath); err == nil {
			if err := os.Remove(authPath); err != nil {
				return nil, fmt.Sprintf("remove %s: %v", authPath, err)
			}
			removed = append(removed, authPath)
		}
		// also clean up legacy creds/codex.sh from older agent versions
		if legacy := a.credFile("codex"); legacy != authPath {
			if _, err := os.Stat(legacy); err == nil {
				os.Remove(legacy)
				removed = append(removed, legacy)
			}
		}
	} else {
		path := a.credFile(p.Tool)
		if _, err := os.Stat(path); err == nil {
			if err := os.Remove(path); err != nil {
				return nil, fmt.Sprintf("remove %s: %v", path, err)
			}
			removed = append(removed, path)
		}
		if p.Tool == "claude" {
			accountPath := a.claudeAccountCredentialFile()
			if _, err := os.Stat(accountPath); err == nil {
				if err := os.Remove(accountPath); err != nil {
					return nil, fmt.Sprintf("remove %s: %v", accountPath, err)
				}
				removed = append(removed, accountPath)
			}
		}
	}

	// bug 26: 不再 os.Unsetenv(p.EnvKeysToRemove)。凭据在 creds/*.sh，由用户交互
	// shell source，daemon 从不持有这些 env——Unsetenv 是空操作，却报 env_keys_cleared
	// 误导。真正的清理是上面的文件删除。
	result["removed"] = removed
	result["cred_files_removed"] = len(removed)
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
	case "pi":
		// ponytail: pi 读 ~/.pi/agent/models.json（自定义 provider/model 配置）。
		// 凭据（apiKey）内联在 provider 块，与 opencode 同构——无独立凭据文件。
		return filepath.Join(home, ".pi", "agent", "models.json")
	case "hermes":
		// Hermes accepts JSON syntax in config.yaml because JSON is a YAML subset.
		// Provider credentials are intentionally kept in this private 0600 file.
		return filepath.Join(home, ".hermes", "config.yaml")
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
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, fmt.Sprintf("mkdir %s: %v", dir, err)
	}
	_ = os.Chmod(dir, 0700)

	backupPath := backupFilePath(path)
	if existing, err := os.ReadFile(path); err == nil {
		// bug 16: 备份写失败必须中止，否则线上写成功但原始配置无备份可恢复。
		// BUG-01: backup 0600 — was 0644, letting peer users read secrets.
		if berr := writeFileAtomic(backupPath, existing, 0600); berr != nil {
			return nil, fmt.Sprintf("backup %s: %v", backupPath, berr)
		}
	}
	if err := writeFileAtomic(path, []byte(p.Content), 0600); err != nil {
		return nil, fmt.Sprintf("write %s: %v", path, err)
	}
	// ponytail (BUG-01): result no longer echoes p.Content. content_sha256
	// is a stable fingerprint that lets the console verify rollout without
	// storing plaintext in agent_tasks.result_json. Server-side scrubs the
	// content field even if a legacy agent returns it.
	sum := sha256.Sum256([]byte(p.Content))
	return map[string]interface{}{
		"path":           path,
		"format":         p.Format,
		"content_sha256": hex.EncodeToString(sum[:]),
		"backup":         filepath.Base(backupPath),
	}, ""
}

// writeFileAtomic writes data to path via a same-directory temp file with the
// requested mode, fsyncs, renames on top of any existing file, and fsyncs the
// parent directory so the metadata survives crash. Also explicitly chmods
// after rename because os.OpenFile mode is masked by umask.
func writeFileAtomic(path string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	base := filepath.Base(path)
	tmp, err := os.CreateTemp(dir, "."+base+".tmp-*")
	if err != nil {
		return fmt.Errorf("open tmp: %w", err)
	}
	tmpPath := tmp.Name()
	// If anything below fails, remove the leftover temp file so the config
	// dir doesn't accumulate half-written garbage that later scans might
	// misinterpret as a backup.
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(tmpPath)
		}
	}()
	if err := os.Chmod(tmpPath, mode); err != nil {
		tmp.Close()
		return fmt.Errorf("chmod tmp: %w", err)
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return fmt.Errorf("write tmp: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return fmt.Errorf("sync tmp: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close tmp: %w", err)
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return fmt.Errorf("rename: %w", err)
	}
	cleanup = false
	// Explicit chmod in case rename target existed with wider mode; and to
	// defeat umask.
	_ = os.Chmod(path, mode)
	// Best-effort parent fsync so the rename hits disk. Ignore errors on
	// platforms that don't support directory fsync (e.g. Windows).
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync()
		_ = d.Close()
	}
	return nil
}

// --- backups ---

// backupFilePath 命名 path 的备份。时间戳为毫秒精度，并在同名文件已存在时
// 追加数字后缀，避免同 tool 同秒/同毫秒两次 write_config 互相覆盖备份、静默丢失
// 原始配置（bug 24）。
func backupFilePath(path string) string {
	dir := filepath.Dir(path)
	base := filepath.Base(path)
	ts := time.Now().Format("20060102_150405.000")
	candidate := filepath.Join(dir, fmt.Sprintf(".%s.bak.%s", base, ts))
	if _, err := os.Stat(candidate); err != nil {
		return candidate
	}
	for i := 2; ; i++ {
		next := filepath.Join(dir, fmt.Sprintf(".%s.bak.%s.%d", base, ts, i))
		if _, err := os.Stat(next); err != nil {
			return next
		}
	}
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
	var backupPath string
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
	} else {
		// p.Backup must be a bare filename inside the config dir. Reject anything
		// containing a path separator or a traversal segment so it cannot escape dir
		// (e.g. "../../etc/passwd"), which would read arbitrary files and clobber the
		// live config.
		if filepath.Base(p.Backup) != p.Backup || p.Backup == "." || p.Backup == ".." {
			return nil, "invalid backup name"
		}
		backupPath = filepath.Join(dir, p.Backup)
	}
	data, err := os.ReadFile(backupPath)
	if err != nil {
		return nil, fmt.Sprintf("read backup %s: %v", backupPath, err)
	}
	currentBackup := backupFilePath(path)
	if existing, err := os.ReadFile(path); err == nil {
		// bug 16: 同 handleWriteConfig——备份写失败要中止。
		// BUG-01: backup 0600 — was 0644.
		if berr := writeFileAtomic(currentBackup, existing, 0600); berr != nil {
			return nil, fmt.Sprintf("backup current %s: %v", currentBackup, berr)
		}
	}
	if err := writeFileAtomic(path, data, 0600); err != nil {
		return nil, fmt.Sprintf("restore %s: %v", path, err)
	}
	return map[string]interface{}{"path": path, "restored_from": filepath.Base(backupPath), "backup_of_current": filepath.Base(currentBackup)}, ""
}

// --- upgrade ---

// manifestEntry mirrors the JSON produced by build-dist.sh / served by the
// Console at /agent/manifest.json.
type manifestEntry struct {
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}
type manifestFile struct {
	Version  string                   `json:"version"`
	Binaries map[string]manifestEntry `json:"binaries"`
}

// ponytail (BUG-07): allowInsecure controls whether http:// upgrades are
// permitted. Default is false; users must pass --allow-insecure at install
// time to opt in (typically localhost/lab). Production Consoles must serve
// HTTPS. Also enforced in CheckRedirect below so a redirect can't downgrade.
var allowInsecure = false

func (a *Agent) handleUpgradeAgent(_ []byte) (map[string]interface{}, string) {
	exe, err := os.Executable()
	if err != nil {
		return nil, fmt.Sprintf("resolve exe: %v", err)
	}
	oldVersion := a.cfg.Version

	consoleURL, err := url.Parse(a.cfg.Server)
	if err != nil {
		return nil, fmt.Sprintf("bad console URL: %v", err)
	}
	if consoleURL.Scheme != "https" && !allowInsecure {
		return nil, "console URL must be HTTPS for agent self-upgrade (set --allow-insecure to override)"
	}

	// ponytail (BUG-07): dedicated http.Client with:
	//   - overall Timeout (defence against a stuck download exhausting the
	//     upgrade slot forever),
	//   - CheckRedirect that refuses cross-host redirects AND HTTPS→HTTP
	//     downgrade even for localhost dev,
	//   - no shared transport (default client is package-global and could
	//     inherit whatever the app configured elsewhere).
	client := &http.Client{
		Timeout: 5 * time.Minute,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) == 0 {
				return nil
			}
			orig := via[0].URL
			if req.URL.Host != orig.Host {
				return fmt.Errorf("cross-host redirect denied: %s -> %s", orig.Host, req.URL.Host)
			}
			if orig.Scheme == "https" && req.URL.Scheme != "https" {
				return fmt.Errorf("https downgrade redirect denied")
			}
			return nil
		},
	}

	// 1) Fetch manifest and pick our platform's expected size + sha256.
	manifestURL := strings.TrimRight(a.cfg.Server, "/") + "/agent/manifest.json"
	mreq, err := http.NewRequest("GET", manifestURL, nil)
	if err != nil {
		return nil, fmt.Sprintf("build manifest req: %v", err)
	}
	mresp, err := client.Do(mreq)
	if err != nil {
		return nil, fmt.Sprintf("fetch manifest: %v", err)
	}
	mdata, _ := io.ReadAll(io.LimitReader(mresp.Body, 1<<20))
	mresp.Body.Close()
	if mresp.StatusCode != 200 {
		return nil, fmt.Sprintf("manifest %d: %s", mresp.StatusCode, string(mdata))
	}
	var manifest manifestFile
	if err := json.Unmarshal(mdata, &manifest); err != nil {
		return nil, fmt.Sprintf("parse manifest: %v", err)
	}
	platform := runtime.GOOS + "-" + runtime.GOARCH
	entry, ok := manifest.Binaries[platform]
	if !ok || entry.Size <= 0 || entry.SHA256 == "" {
		return nil, fmt.Sprintf("manifest has no entry for %s", platform)
	}

	// 2) Download binary. Cap length at expected size + 1KB slack; anything
	// larger implies a tampered response and we bail before writing.
	binURL := fmt.Sprintf("%s/agent/binary/%s/%s", strings.TrimRight(a.cfg.Server, "/"), runtime.GOOS, runtime.GOARCH)
	breq, err := http.NewRequest("GET", binURL, nil)
	if err != nil {
		return nil, fmt.Sprintf("build binary req: %v", err)
	}
	bresp, err := client.Do(breq)
	if err != nil {
		return nil, fmt.Sprintf("download: %v", err)
	}
	defer bresp.Body.Close()
	if bresp.StatusCode != 200 {
		b, _ := io.ReadAll(io.LimitReader(bresp.Body, 1024))
		return nil, fmt.Sprintf("download failed %d: %s", bresp.StatusCode, string(b))
	}

	tmpPath := exe + ".new"
	f, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0700)
	if err != nil {
		return nil, fmt.Sprintf("create tmp: %v", err)
	}
	hasher := sha256.New()
	written, err := io.Copy(io.MultiWriter(f, hasher), io.LimitReader(bresp.Body, entry.Size+1024))
	f.Close()
	if err != nil {
		os.Remove(tmpPath)
		return nil, fmt.Sprintf("write tmp: %v", err)
	}

	// 3) Verify size THEN sha256. Size mismatch is nearly always a truncated
	// or padded response — refusing early keeps the hash-mismatch error
	// message meaningful for the harder-to-diagnose tamper case.
	if written != entry.Size {
		os.Remove(tmpPath)
		return nil, fmt.Sprintf("binary size mismatch: got %d, want %d", written, entry.Size)
	}
	gotHash := hex.EncodeToString(hasher.Sum(nil))
	if gotHash != entry.SHA256 {
		os.Remove(tmpPath)
		return nil, fmt.Sprintf("binary sha256 mismatch: got %s, want %s", gotHash, entry.SHA256)
	}

	// 4) Confirm the binary reports the expected version. Belt-and-braces:
	//    if a tampered binary somehow shared the same hash (only possible
	//    if the manifest itself was also swapped), --version disagreement
	//    still stops the install.
	test := exec.Command(tmpPath, "--version")
	verOut, verErr := test.CombinedOutput()
	if verErr != nil {
		os.Remove(tmpPath)
		return nil, fmt.Sprintf("new binary is not executable: %v", verErr)
	}
	gotVer := strings.TrimSpace(string(verOut))
	if gotVer != manifest.Version {
		os.Remove(tmpPath)
		return nil, fmt.Sprintf("new binary --version reported %q, expected %q", gotVer, manifest.Version)
	}

	// 5) Atomic swap. .bak retained so a bad rollout can be undone by hand.
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
		"old_version":    oldVersion,
		"new_version":    manifest.Version,
		"path":           exe,
		"backup":         backupPath,
		"restart":        "agent will restart with new binary",
		"content_sha256": gotHash,
	}, ""
}

// npmToolPackages is deliberately an allowlist: a console task can only
// manage one of the CLI packages we support, never an arbitrary npm package.
var npmToolPackages = map[string]string{
	"codex":    "@openai/codex",
	"claude":   "@anthropic-ai/claude-code",
	"gemini":   "@google/gemini-cli",
	"opencode": "opencode-ai",
	"pi":       "@earendil-works/pi-coding-agent",
}

var npmVersionRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)
var semverTokenRe = regexp.MustCompile(`(?i)v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)`)

func canonicalSemver(value string) (string, bool) {
	match := semverTokenRe.FindStringSubmatch(strings.TrimSpace(value))
	if len(match) != 2 {
		return "", false
	}
	return strings.ToLower(match[1]), true
}

func resolvedExecutablePath(path string) string {
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return path
	}
	return resolved
}

func openCodeInstallMethod(path string) string {
	normalized := strings.ToLower(filepath.ToSlash(resolvedExecutablePath(path)))
	switch {
	case strings.Contains(normalized, "/pnpm/") || strings.Contains(normalized, "/.local/share/pnpm/"):
		return "pnpm"
	case strings.Contains(normalized, "/.bun/"):
		return "bun"
	case strings.Contains(normalized, "/homebrew/") || strings.Contains(normalized, "/.linuxbrew/") || strings.Contains(normalized, "/cellar/opencode/"):
		return "brew"
	case strings.Contains(normalized, "/node_modules/opencode-ai/"):
		return "npm"
	case strings.Contains(normalized, "/.opencode/bin/") || strings.Contains(normalized, "/.local/bin/"):
		return "curl"
	default:
		return ""
	}
}

func openCodeNpmPrefix(path string) string {
	resolved := filepath.ToSlash(resolvedExecutablePath(path))
	const marker = "/lib/node_modules/opencode-ai/"
	index := strings.Index(strings.ToLower(resolved), marker)
	if index <= 0 {
		return ""
	}
	prefix := filepath.FromSlash(resolved[:index])
	if !filepath.IsAbs(prefix) {
		return ""
	}
	return prefix
}

func installedTool(tool string) (path, version string) {
	path, _ = exec.LookPath(tool)
	if path == "" && tool == "hermes" {
		// User services do not always inherit ~/.local/bin even though the
		// official Hermes installer places its command shim there.
		home, _ := os.UserHomeDir()
		candidate := filepath.Join(home, ".local", "bin", "hermes")
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() && info.Mode()&0111 != 0 {
			path = candidate
		}
	}
	if path == "" {
		return "", ""
	}
	out, err := exec.Command(path, "--version").CombinedOutput()
	if err == nil {
		version = firstLine(string(out))
	}
	return path, version
}

func (a *Agent) handleManageTool(payload []byte) (map[string]interface{}, string) {
	var p struct {
		Tool    string `json:"tool"`
		Action  string `json:"action"`
		Version string `json:"version"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return nil, fmt.Sprintf("invalid tool management payload: %v", err)
	}
	if p.Action != "install" && p.Action != "upgrade" && p.Action != "uninstall" {
		return nil, "unsupported tool action"
	}
	if p.Version != "" && !npmVersionRe.MatchString(p.Version) {
		return nil, "invalid version or npm tag"
	}
	if p.Action == "uninstall" && p.Version != "" {
		return nil, "version is not supported for uninstall"
	}

	oldPath, oldVersion := installedTool(p.Tool)
	if p.Tool == "hermes" {
		return a.handleManageHermes(p.Action, oldPath, oldVersion)
	}
	pkg, supported := npmToolPackages[p.Tool]
	if !supported {
		return nil, "unsupported tool"
	}
	result := map[string]interface{}{
		"tool":        p.Tool,
		"action":      p.Action,
		"package":     pkg,
		"old_version": oldVersion,
		"old_path":    oldPath,
	}
	// OpenCode supports several official installation methods. Its own method
	// detector classifies every ~/.local/bin executable as a curl install,
	// including npm's common ~/.local/bin/opencode symlink. Resolve that
	// symlink first: npm installs use npm directly at the symlink's own prefix;
	// all other methods stay with OpenCode's native updater so we do not create
	// a second installation.
	npmPrefix := ""
	if p.Tool == "opencode" && p.Action == "upgrade" && oldPath != "" {
		method := openCodeInstallMethod(oldPath)
		result["install_method"] = method
		if method != "npm" {
			return a.handleUpgradeOpenCode(result, oldPath, oldVersion, p.Version, method)
		}
		npmPrefix = openCodeNpmPrefix(oldPath)
		result["npm_prefix"] = npmPrefix
	}
	npm, err := exec.LookPath("npm")
	if err != nil {
		return result, "npm was not found in the agent PATH; install Node.js/npm first"
	}

	args := []string{}
	if p.Action == "uninstall" {
		args = []string{"uninstall", "--global", pkg}
	} else {
		packageSpec := pkg
		if p.Version != "" {
			packageSpec += "@" + p.Version
		}
		// `npm install --global` also upgrades an existing global package. An
		// explicit OpenCode prefix updates the package behind the detected
		// symlink even when another npm/NVM installation is first on PATH.
		args = []string{"install", "--global"}
		if npmPrefix != "" {
			args = append(args, "--prefix", npmPrefix)
		}
		args = append(args, packageSpec)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, npm, args...)
	output, runErr := cmd.CombinedOutput()
	if ctx.Err() == context.DeadlineExceeded {
		return result, "npm command timed out after 10 minutes"
	}
	if runErr != nil {
		// Do not return npm output: npm configuration/output can contain a
		// private registry URL or token. The task error still identifies action.
		return result, fmt.Sprintf("npm %s failed: %v", p.Action, runErr)
	}

	path, version := installedTool(p.Tool)
	result["installed"] = path != ""
	result["path"] = path
	result["new_version"] = version
	result["output_bytes"] = len(output)
	if p.Action == "uninstall" && path != "" {
		result["note"] = "npm removed its global package, but a command with this name remains on PATH"
	}
	if p.Action != "uninstall" {
		if path == "" {
			return result, fmt.Sprintf("npm %s completed, but %s was not found on the agent PATH", p.Action, p.Tool)
		}
		if requested, ok := canonicalSemver(p.Version); ok {
			actual, actualOK := canonicalSemver(version)
			if !actualOK || actual != requested {
				return result, fmt.Sprintf("npm %s completed, but %s reports version %q instead of %q", p.Action, p.Tool, version, p.Version)
			}
		}
	}
	return result, ""
}

func (a *Agent) handleUpgradeOpenCode(result map[string]interface{}, path, oldVersion, target, method string) (map[string]interface{}, string) {
	args := []string{"upgrade"}
	if target != "" {
		args = append(args, target)
	}
	if method != "" {
		args = append(args, "--method", method)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, args...)
	output, runErr := cmd.CombinedOutput()
	result["method"] = "opencode upgrade"
	result["output_bytes"] = len(output)
	if ctx.Err() == context.DeadlineExceeded {
		return result, "OpenCode upgrade timed out after 10 minutes"
	}
	if runErr != nil {
		// OpenCode output can include package-manager configuration. Keep the
		// task result redacted and expose only the process error.
		return result, fmt.Sprintf("OpenCode upgrade failed: %v", runErr)
	}

	newPath, newVersion := installedTool("opencode")
	result["installed"] = newPath != ""
	result["path"] = newPath
	result["new_version"] = newVersion
	if newPath == "" {
		return result, "OpenCode upgrade completed, but opencode was no longer found on the agent PATH"
	}
	// OpenCode's upgrade command currently catches some package-manager
	// failures and can still exit zero. Verify the requested version instead
	// of reporting a false success to the console.
	if requested, ok := canonicalSemver(target); ok {
		actual, actualOK := canonicalSemver(newVersion)
		if !actualOK || actual != requested {
			return result, fmt.Sprintf("OpenCode upgrade did not reach %q; command still reports %q (was %q)", target, newVersion, oldVersion)
		}
	}
	return result, ""
}

func (a *Agent) handleManageHermes(action, oldPath, oldVersion string) (map[string]interface{}, string) {
	result := map[string]interface{}{
		"tool":        "hermes",
		"action":      action,
		"package":     "NousResearch/hermes-agent",
		"old_version": oldVersion,
		"old_path":    oldPath,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()
	var cmd *exec.Cmd
	if action == "install" {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://hermes-agent.nousresearch.com/install.sh", nil)
		if err != nil {
			return result, fmt.Sprintf("build Hermes installer request: %v", err)
		}
		response, err := (&http.Client{Timeout: 30 * time.Second}).Do(request)
		if err != nil {
			return result, fmt.Sprintf("download Hermes installer: %v", err)
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			return result, fmt.Sprintf("download Hermes installer: HTTP %d", response.StatusCode)
		}
		script, err := io.ReadAll(io.LimitReader(response.Body, 2*1024*1024+1))
		if err != nil || len(script) > 2*1024*1024 {
			return result, "download Hermes installer: invalid or oversized response"
		}
		tmp, err := os.CreateTemp(a.dir, "hermes-install-*.sh")
		if err != nil {
			return result, fmt.Sprintf("create Hermes installer: %v", err)
		}
		tmpPath := tmp.Name()
		defer os.Remove(tmpPath)
		if _, err = tmp.Write(script); err != nil {
			tmp.Close()
			return result, fmt.Sprintf("write Hermes installer: %v", err)
		}
		if err = tmp.Close(); err != nil {
			return result, fmt.Sprintf("close Hermes installer: %v", err)
		}
		cmd = exec.CommandContext(ctx, "bash", tmpPath, "--skip-setup", "--non-interactive")
	} else {
		if oldPath == "" {
			return result, "Hermes is not installed"
		}
		args := []string{"update", "--yes"}
		if action == "uninstall" {
			// Default Hermes uninstall removes the CLI but intentionally retains
			// ~/.hermes configuration/data; `--full` is never used here.
			args = []string{"uninstall", "--yes"}
		}
		cmd = exec.CommandContext(ctx, oldPath, args...)
	}
	output, runErr := cmd.CombinedOutput()
	if ctx.Err() == context.DeadlineExceeded {
		return result, "Hermes command timed out after 20 minutes"
	}
	if runErr != nil {
		return result, fmt.Sprintf("Hermes %s failed: %v", action, runErr)
	}
	path, version := installedTool("hermes")
	result["installed"] = path != ""
	result["path"] = path
	result["new_version"] = version
	result["output_bytes"] = len(output)
	return result, ""
}

func (a *Agent) handleUpgradeTool(payload []byte) (map[string]interface{}, string) {
	// Compatibility for a task sent by a pre-tool-management console.
	var p struct {
		Tool    string `json:"tool"`
		Version string `json:"version"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return nil, fmt.Sprintf("invalid upgrade payload: %v", err)
	}
	managed, errMsg := json.Marshal(map[string]string{"tool": p.Tool, "action": "upgrade", "version": p.Version})
	if errMsg != nil {
		return nil, fmt.Sprintf("build upgrade payload: %v", errMsg)
	}
	return a.handleManageTool(managed)
}

// --- helpers ---

func detectTools() []map[string]interface{} {
	var tools []map[string]interface{}
	for _, t := range []string{"codex", "claude", "gemini", "opencode", "pi", "hermes"} {
		path, version := installedTool(t)
		tools = append(tools, map[string]interface{}{
			"name": t, "installed": path != "", "version": version, "path": path,
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
	for k := range m {
		keys = append(keys, k)
	}
	return keys
}
func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}
func formatForTool(tool string) string {
	if tool == "codex" {
		return "toml"
	}
	if tool == "hermes" {
		return "yaml"
	}
	return "json"
}
func fingerprint(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])[:12]
}
