#!/usr/bin/env bash
# ponytail (BUG-06): build-dist.sh is the sole source of truth for producing
# the four platform binaries that ship in console/agent-dist/. The Console
# API serves these to onboarding hosts via /agent/binary/:goos/:goarch and
# self-upgrades via /agent/manifest.json.
#
# Contract:
#   * every binary must report the exact version string that ends up in
#     manifest.json (Console self-upgrade checks --version against manifest.
#     version)
#   * manifest.json size/sha256 must match the on-disk bytes exactly
#     (agent verifies both before rename-swap during upgrade — BUG-07)
#   * fails on the first mismatch — never publish a partial dist
#
# Version resolution (in order):
#   1. explicit "$1" arg
#   2. AGENT_VERSION env var
#   3. `git describe --tags` in the agent repo
#   4. hard fail (do not default to a stale/hard-coded version — BUG-06)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

resolve_version() {
  if [ "${1:-}" != "" ]; then
    echo "$1"
    return
  fi
  if [ "${AGENT_VERSION:-}" != "" ]; then
    echo "$AGENT_VERSION"
    return
  fi
  # ponytail: VERSION file is the canonical source — a one-line bump committed
  # to the repo. Docker builds (Dockerfile) and `git pull && build` both pick
  # it up with no --build-arg / env / git-tags needed. Kept below the explicit
  # arg/env so CI/one-offs can still override.
  local vf="$(dirname "${BASH_SOURCE[0]}")/VERSION"
  if [ -f "$vf" ]; then
    local v; v="$(tr -d '[:space:]' < "$vf")"
    if [ -n "$v" ]; then
      echo "$v"
      return
    fi
  fi
  if command -v git >/dev/null 2>&1 && git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
    local d
    if d="$(git -C "$ROOT" describe --tags --dirty --always 2>/dev/null)"; then
      echo "$d"
      return
    fi
  fi
  echo "error: version is required — set agent/VERSION, pass \"$0 vX.Y.Z\", or set AGENT_VERSION" >&2
  exit 1
}

VERSION="$(resolve_version "${1:-}")"
OUT="$ROOT/console/agent-dist"
mkdir -p "$OUT"

# ponytail (BUG-06): only vet/build once for the host to catch obvious
# mistakes before we spend time cross-compiling four platforms.
cd "$ROOT/agent"
go vet ./...

# Cross-compile the four supported platforms.
for os in linux darwin; do
  for arch in amd64 arm64; do
    name="ai-agent-$os-$arch"
    echo "building $name ($VERSION)"
    GOOS="$os" GOARCH="$arch" CGO_ENABLED=0 go build \
      -trimpath \
      -ldflags "-s -w -X main.version=$VERSION" \
      -o "$OUT/$name" ./cmd/ai-agent/
  done
done

# ponytail (BUG-06): version stamp verification. Only run for platforms whose
# binaries can execute on this host (typical build box is linux/amd64 or
# darwin/arm64). If we can't natively exec a binary we skip it here — the
# CI matrix should exercise other platforms separately. For platforms we can
# run, --version MUST equal $VERSION.
host_os="$(uname -s | tr '[:upper:]' '[:lower:]')"
host_arch_raw="$(uname -m)"
case "$host_arch_raw" in
  x86_64|amd64) host_arch="amd64" ;;
  aarch64|arm64) host_arch="arm64" ;;
  *) host_arch="$host_arch_raw" ;;
esac
for platform in linux-amd64 linux-arm64 darwin-amd64 darwin-arm64; do
  bin="$OUT/ai-agent-$platform"
  case "$platform" in
    "$host_os-$host_arch")
      got="$("$bin" --version 2>/dev/null || true)"
      if [ "$got" != "$VERSION" ]; then
        echo "error: $bin --version reported '$got', expected '$VERSION'" >&2
        exit 1
      fi
      ;;
  esac
done

python3 - "$OUT" "$VERSION" <<'PY'
import hashlib, json, os, pathlib, sys
out = pathlib.Path(sys.argv[1])
version = sys.argv[2]
binaries = {}
for path in sorted(out.glob("ai-agent-*")):
    data = path.read_bytes()
    platform = path.name.removeprefix("ai-agent-")
    binaries[platform] = {"sha256": hashlib.sha256(data).hexdigest(), "size": len(data)}
(out / "manifest.json").write_text(json.dumps({"version": version, "binaries": binaries}, indent=2) + "\n")
PY

echo "wrote $OUT/manifest.json for version $VERSION"
