package agent

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestOpenCodeInstallMethodResolvesNpmLocalBinSymlink(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, ".local", "lib", "node_modules", "opencode-ai", "bin", "opencode.exe")
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte("binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, ".local", "bin", "opencode")
	if err := os.MkdirAll(filepath.Dir(link), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}

	if got := openCodeInstallMethod(link); got != "npm" {
		t.Fatalf("openCodeInstallMethod() = %q, want npm", got)
	}
	if got := openCodeNpmPrefix(link); got != filepath.Join(root, ".local") {
		t.Fatalf("openCodeNpmPrefix() = %q, want %q", got, filepath.Join(root, ".local"))
	}
}

func TestOpenCodeInstallMethodStandaloneLocalBinIsCurl(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".local", "bin", "opencode")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("binary"), 0o755); err != nil {
		t.Fatal(err)
	}

	if got := openCodeInstallMethod(path); got != "curl" {
		t.Fatalf("openCodeInstallMethod() = %q, want curl", got)
	}
}

func TestValidateAccountCredential(t *testing.T) {
	tests := []struct {
		name    string
		tool    string
		content string
		wantErr bool
	}{
		{"codex account", "codex", `{"auth_mode":"chatgpt","tokens":{"access_token":"access","refresh_token":"refresh"}}`, false},
		{"codex api key only", "codex", `{"OPENAI_API_KEY":"key"}`, true},
		{"claude subscription", "claude", `{"claudeAiOauth":{"accessToken":"access","refreshToken":"refresh","expiresAt":1}}`, false},
		{"claude missing refresh", "claude", `{"claudeAiOauth":{"accessToken":"access"}}`, true},
		{"unsupported tool", "gemini", `{}`, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateAccountCredential(tt.tool, []byte(tt.content))
			if (err != nil) != tt.wantErr {
				t.Fatalf("validateAccountCredential() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func TestSubscriptionCredentialDeliveryWritesNativeFile(t *testing.T) {
	tests := []struct {
		tool           string
		credentialType string
		content        string
		relativePath   string
	}{
		{"codex", "codex_subscription", `{"auth_mode":"chatgpt","tokens":{"access_token":"access","refresh_token":"refresh"}}`, filepath.Join(".codex", "auth.json")},
		{"claude", "claude_subscription", `{"claudeAiOauth":{"accessToken":"access","refreshToken":"refresh"}}`, filepath.Join(".claude", ".credentials.json")},
	}
	for _, tt := range tests {
		t.Run(tt.tool, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("HOME", home)
			a := &Agent{credsDir: filepath.Join(home, ".ai-console-agent", "creds")}
			payload, err := json.Marshal(setCredPayload{Tool: tt.tool, CredentialType: tt.credentialType, CredentialJSON: tt.content})
			if err != nil {
				t.Fatal(err)
			}
			_, errText := a.handleSetCred(payload)
			if errText != "" {
				t.Fatal(errText)
			}
			path := filepath.Join(home, tt.relativePath)
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if string(data) != tt.content {
				t.Fatalf("written credential changed: %s", data)
			}
			info, err := os.Stat(path)
			if err != nil {
				t.Fatal(err)
			}
			if info.Mode().Perm() != 0o600 {
				t.Fatalf("credential mode = %04o, want 0600", info.Mode().Perm())
			}
		})
	}
}

func TestOpenCodeInstallMethodPackageManagers(t *testing.T) {
	tests := []struct {
		path string
		want string
	}{
		{"/home/dev/.local/share/pnpm/global/5/node_modules/opencode-ai/bin/opencode", "pnpm"},
		{"/home/dev/.bun/install/global/node_modules/opencode-ai/bin/opencode", "bun"},
		{"/home/dev/.opencode/bin/opencode", "curl"},
		{"/opt/homebrew/bin/opencode", "brew"},
	}
	for _, tt := range tests {
		t.Run(tt.want+tt.path, func(t *testing.T) {
			if got := openCodeInstallMethod(tt.path); got != tt.want {
				t.Fatalf("openCodeInstallMethod(%q) = %q, want %q", tt.path, got, tt.want)
			}
		})
	}
}
