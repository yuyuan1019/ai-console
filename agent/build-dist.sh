#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:-v0.2.3}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/console/agent-dist"
mkdir -p "$OUT"

cd "$ROOT/agent"
for os in linux darwin; do
  for arch in amd64 arm64; do
    name="ai-agent-$os-$arch"
    echo "building $name ($VERSION)"
    GOOS="$os" GOARCH="$arch" CGO_ENABLED=0 go build \
      -ldflags "-s -w -X main.version=$VERSION" \
      -o "$OUT/$name" ./cmd/ai-agent/
  done
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
