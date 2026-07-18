#!/bin/sh
# AI Console Agent installer for Linux/macOS.
#
# Usage:
#   ./install.sh --token=<enroll_token> --server=https://console.example.com
#   TOKEN=... SERVER=https://console sh -c "$(curl -fsSL https://console/agent/install.sh)"
#
# ponytail (BUG-07): install.sh now performs the same verification the
# self-upgrade path does inside the running binary:
#   * SERVER must be HTTPS (bypass only with --allow-insecure, primarily for
#     localhost dev)
#   * SHA-256 of the downloaded binary is compared against the value in
#     /agent/manifest.json
#   * a locally-provided BINARY_URL requires a matching BINARY_SHA256; we
#     never trust "download this URL blindly" without an out-of-band hash
#   * sha256sum or shasum -a 256 must be available; refusing to install if
#     neither is present is safer than skipping the check
set -eu

TOKEN="${TOKEN:-}"
SERVER="${SERVER:-}"
BINARY_URL="${BINARY_URL:-}"
BINARY_SHA256="${BINARY_SHA256:-}"
ALLOW_INSECURE=0

for arg in "$@"; do
  case $arg in
    --token=*) TOKEN="${arg#--token=}" ;;
    --server=*) SERVER="${arg#--server=}" ;;
    --binary-url=*) BINARY_URL="${arg#--binary-url=}" ;;
    --binary-sha256=*) BINARY_SHA256="${arg#--binary-sha256=}" ;;
    --allow-insecure) ALLOW_INSECURE=1 ;;
  esac
done

if [ -z "$TOKEN" ] || [ -z "$SERVER" ]; then
  echo "Error: TOKEN/SERVER env or --token and --server are required" >&2
  echo "Usage: $0 --token=<enroll_token> --server=https://console.example.com" >&2
  exit 1
fi

# Refuse plain HTTP unless the operator explicitly asked for it. HTTP means
# the enroll token, binary and heartbeats travel in the clear; a MITM can
# swap the binary for anything.
case "$SERVER" in
  https://*) : ;;
  http://*)
    if [ "$ALLOW_INSECURE" != "1" ]; then
      echo "Error: SERVER must be HTTPS. Pass --allow-insecure if this is truly a lab/localhost console." >&2
      exit 1
    fi
    ;;
  *)
    echo "Error: SERVER must start with http:// or https://" >&2
    exit 1
    ;;
esac

# Pick the sha256 tool once and record the invocation prefix so both branches
# below (server manifest, custom binary-url) can share the same check. Refuse
# to run without one — we won't silently skip integrity verification.
if command -v sha256sum >/dev/null 2>&1; then
  SHA256_CMD="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  SHA256_CMD="shasum -a 256"
else
  echo "Error: neither sha256sum nor 'shasum -a 256' is available. Install one before continuing." >&2
  exit 1
fi

# Custom BINARY_URL must be paired with BINARY_SHA256. Without the pair the
# installer would have to trust an arbitrary URL, defeating the point of the
# whole verification.
if [ -n "$BINARY_URL" ] && [ -z "$BINARY_SHA256" ]; then
  echo "Error: BINARY_URL requires BINARY_SHA256 (integrity verification)." >&2
  exit 1
fi

DIR="$HOME/.ai-console-agent"
mkdir -p "$DIR"
chmod 700 "$DIR"
BINDIR="$DIR/bin"
mkdir -p "$BINDIR"
chmod 700 "$BINDIR"
BINARY="$BINDIR/ai-agent"

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case "$ARCH" in
  x86_64|amd64) ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *)
    echo "Error: unsupported architecture: $ARCH" >&2
    exit 1
    ;;
esac

verify_sha256() {
  # $1 = file, $2 = expected hex
  local got
  got=$($SHA256_CMD "$1" | awk '{print $1}')
  if [ "$got" != "$2" ]; then
    echo "Error: sha256 mismatch for $1: got $got, expected $2" >&2
    return 1
  fi
}

if [ -n "$BINARY_URL" ]; then
  echo "Downloading agent binary from $BINARY_URL ..."
  curl -fsSL -o "$BINARY" "$BINARY_URL"
  verify_sha256 "$BINARY" "$BINARY_SHA256" || { rm -f "$BINARY"; exit 1; }
elif command -v ai-agent >/dev/null 2>&1; then
  # ponytail (BUG-07): PATH-installed ai-agent is trusted only when the
  # operator explicitly chose --allow-insecure. Otherwise the manifest fetch
  # below is the sole source of truth.
  if [ "$ALLOW_INSECURE" = "1" ]; then
    echo "Using existing ai-agent from PATH (--allow-insecure)"
    cp "$(command -v ai-agent)" "$BINARY"
  fi
fi

if [ ! -f "$BINARY" ]; then
  MANIFEST_URL="${SERVER%/}/agent/manifest.json"
  BINARY_URL="${SERVER%/}/agent/binary/${OS}/${ARCH}"
  echo "Fetching manifest from $MANIFEST_URL ..."
  MANIFEST_TMP="$(mktemp)"
  trap 'rm -f "$MANIFEST_TMP" "$BINARY.tmp"' EXIT
  curl -fsSL -o "$MANIFEST_TMP" "$MANIFEST_URL"
  # Extract the sha256 for our platform without pulling in jq.
  EXPECTED_SHA=$(sed -n "s/.*\"${OS}-${ARCH}\":[[:space:]]*{[^}]*\"sha256\":[[:space:]]*\"\([0-9a-f]\+\)\".*/\1/p" "$MANIFEST_TMP" | head -n1)
  if [ -z "$EXPECTED_SHA" ]; then
    # Fallback: platform block may have keys in a different order.
    EXPECTED_SHA=$(python3 -c "import json,sys; m=json.load(open('$MANIFEST_TMP')); print(m['binaries']['${OS}-${ARCH}']['sha256'])" 2>/dev/null || true)
  fi
  if [ -z "$EXPECTED_SHA" ]; then
    echo "Error: manifest has no sha256 for ${OS}-${ARCH}" >&2
    exit 1
  fi
  echo "Downloading agent binary from $BINARY_URL ..."
  curl -fsSL -o "$BINARY.tmp" "$BINARY_URL"
  verify_sha256 "$BINARY.tmp" "$EXPECTED_SHA" || { rm -f "$BINARY.tmp"; exit 1; }
  mv "$BINARY.tmp" "$BINARY"
fi

chmod 700 "$BINARY"

echo "Enrolling agent..."
"$BINARY" --enroll-only --token="$TOKEN" --server="$SERVER"

if [ "$OS" = "linux" ] && command -v systemctl >/dev/null 2>&1; then
  UNIT_FILE="$HOME/.config/systemd/user/ai-console-agent.service"
  mkdir -p "$(dirname "$UNIT_FILE")"
  cat > "$UNIT_FILE" <<EOF
[Unit]
Description=AI Console Agent
After=network.target

[Service]
ExecStart=$BINARY
Restart=always
RestartSec=10
Environment=HOME=$HOME
Environment=PATH=$PATH

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable ai-console-agent
  systemctl --user start ai-console-agent
  loginctl enable-linger "$USER" 2>/dev/null || true
  echo "Installed as systemd user service (linger enabled). Check: systemctl --user status ai-console-agent"

elif [ "$OS" = "darwin" ] && command -v launchctl >/dev/null 2>&1; then
  PLIST="$HOME/Library/LaunchAgents/com.ai-console.agent.plist"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.ai-console.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BINARY</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key>
  <dict><key>HOME</key><string>$HOME</string></dict>
</dict>
</plist>
EOF
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  echo "Installed as launchd service. Check: launchctl list | grep ai-console"
else
  echo "No service manager detected. Run manually: $BINARY"
fi

for rcfile in "$HOME/.bashrc" "$HOME/.zshrc"; do
  if [ -f "$rcfile" ] && ! grep -q ".ai-console-agent/creds" "$rcfile" 2>/dev/null; then
    cat >> "$rcfile" <<'RCEOF'

# AI Console: auto-load credentials for CLI tools
for f in "$HOME"/.ai-console-agent/creds/*.sh; do
  [ -f "$f" ] && . "$f"
done
RCEOF
    echo "  added credential loading to $(basename "$rcfile")"
  fi
done

echo "Done. Agent installed to $BINARY"
