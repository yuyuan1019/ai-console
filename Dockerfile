# ponytail (BUG-06, IMPLEMENTATION-PLAN §6 提交 10): multi-stage build.
#
# Stage 1 (agent-builder) compiles the four agent binaries from source
# (linux/darwin × amd64/arm64) and writes manifest.json. Stage 2 (runtime)
# is the Node image that serves the API + SPA and hosts the agent-dist
# directory for /agent/manifest.json + /agent/binary/:goos/:goarch.
#
# Why not just `COPY console/agent-dist` from the host:
#   * The host directory may carry stale v0.3.4 binaries (this is exactly
#     what we are trying to escape).
#   * Reproducibility: anyone running `docker build` with the same source
#     revision must get the same agent version embedded in the image.
#
# Build context must include both agent/ and console/. Build from repo root:
#   docker build -t ai-console:v2.0.0 --build-arg AGENT_VERSION=v2.0.0 .

# ===== Stage 1: Go builder =====
FROM golang:1.23-bookworm AS agent-builder

# build-dist.sh uses python3 to compute sha256 + write manifest.json, and
# git for version fallback (we pass AGENT_VERSION explicitly so git is
# optional, but install it anyway to keep build-dist.sh happy on dirty trees).
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src

# Cache module layer separately from source.
COPY agent/go.mod agent/go.sum ./agent/
RUN cd agent && go mod download

# Source tree (cmd/ai-agent + internal/agent + build-dist.sh).
COPY agent/ ./agent/

ARG AGENT_VERSION=v2.0.0
ENV AGENT_VERSION=${AGENT_VERSION}

# build-dist.sh resolves ROOT to its parent dir (/src) and writes to
# /src/console/agent-dist. It also runs go vet and the host-platform
# `--version` stamp check; in a linux/amd64 container that verifies
# ai-agent-linux-amd64, the other three platforms are cross-compiled only.
RUN cd agent && bash build-dist.sh "${AGENT_VERSION}"

# Sanity: fail the build if manifest doesn't carry the requested version.
RUN test "$(python3 -c 'import json;print(json.load(open("/src/console/agent-dist/manifest.json"))["version"])')" = "${AGENT_VERSION}"

# ===== Stage 2: Node runtime =====
FROM node:24-bookworm-slim

ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    CI=true

WORKDIR /app/console

COPY console/apps/api/package*.json apps/api/
RUN cd apps/api && npm ci

COPY console/apps/web/package*.json apps/web/
RUN cd apps/web && npm ci

COPY console/db db
COPY console/apps apps

# ponytail (BUG-06): pull agent-dist from stage 1 instead of COPYing the
# host directory. This guarantees the image ships the version that was
# built from this source tree, not whatever was lying around on the
# developer's machine.
COPY --from=agent-builder /src/console/agent-dist agent-dist

RUN cd apps/web && npm run build

RUN mkdir -p data

ENV DB_PATH=/app/console/data/ai-console.db \
    PORT=3000

EXPOSE 3000

CMD ["npm", "--prefix", "apps/api", "run", "start"]
