package agent

import (
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
