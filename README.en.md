# AI Console

[中文](README.md) | [English](README.en.md)

A centralized web console + lightweight outbound agent for managing AI coding CLI tools (Codex CLI, Claude Code, Gemini CLI, OpenCode, Pi, Hermes) configs, credentials, and model rollout across multiple Linux/macOS machines — no SSH required.

## Features

| Feature | Description |
|---|---|
| Config read/write & rollback | Remotely read/write CLI configs with auto-backup and rollback |
| Secure credential delivery | API keys encrypted at rest with AES-256-GCM |
| Provider & model management | Centralize API providers, keys, and model catalogs |
| Batch operations | Multi-server rollout with dry-run preview and rollback |
| CLI lifecycle management | Remote detect / install / upgrade / uninstall of CLI tools |
| Subscription account login | Import a Codex/Claude subscription login from one machine and deploy it to others |
| OpenCode / Pi multi-channel delivery | Merge multiple provider keys into one opencode.json / pi models.json |
| Audit trail | Full audit log with request ID correlation |

## Quick Start

```bash
git clone https://github.com/yuyuan1019/ai-console.git
cd ai-console
docker compose up -d --build
```

- Open `http://your-server-ip:15150` and log in with `admin` / `admin` (LAN testing only. Before exposing to the internet, set strong random `BOOTSTRAP_ADMIN_PASS` / `MASTER_KEY` / `JWT_SECRET` in `.env` and enable `NODE_ENV=production`).
- Data persists in the Docker volume `ai-console-data` (`/app/console/data/` inside the container); rebuilding the container keeps your data.

Install the agent on a dev machine (log in → **Servers** → generate an enroll token):

```bash
TOKEN='<Token>' SERVER='https://your-console.example.com' \
  sh -c "$(curl -fsSL 'https://your-console.example.com/agent/install.sh')"
```

The agent registers as a systemd (Linux) / launchd (macOS) service with auto-reconnect. Uninstall:

```bash
sh -c "$(curl -fsSL 'https://your-console.example.com/agent/uninstall.sh')"
```

Upgrading: `git pull && docker compose up -d --build` (a rebuild is required; restarting the old container changes nothing). After the image is rebuilt, upgrade each agent to "latest" from the server detail page before managing CLI tool versions. Multi-method OpenCode upgrades require agent ≥ `v2.0.5`.

## Supported Tools

| Tool | Config | Credential |
|---|---|---|
| Codex CLI | `~/.codex/config.toml` | `~/.codex/auth.json`; subscription: full `auth.json` |
| Claude Code | `~/.claude/settings.json` | `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL`; subscription: `~/.claude/.credentials.json` |
| Gemini CLI | `~/.gemini/settings.json` | `GEMINI_API_KEY` / `GOOGLE_GEMINI_BASE_URL` |
| OpenCode | `~/.config/opencode/opencode.json` | provider `apiKey` / `baseURL` |
| Pi | `~/.pi/agent/models.json` | provider `apiKey` / `baseURL` (inline) |
| Hermes | `~/.hermes/config.yaml` | provider `api_key` (inline) |

Codex, Claude, Gemini, and Pi use allowlisted npm packages for install/upgrade; OpenCode uses npm or its native `opencode upgrade` depending on the actual install method; Hermes uses the official installer and `hermes update/uninstall`. After any install or upgrade the agent verifies the reported version with `<tool> --version`.

Codex / Claude subscription login: run `codex login` / `claude auth login` on one managed source machine, then import it from the **Providers** page. Credentials are stored as AES-256-GCM ciphertext, never in plaintext in tasks or audit logs, and written with `0600` permissions. Requires agent ≥ `v2.0.6` on both source and target machines.

## Local Development

```bash
cd console/apps/api && npm install && npm run dev   # API on :3000 (tsx, no compile step)
cd console/apps/web && npm install && npm run dev   # Vite dev server, proxies /api and /agent to :3000
cd console/apps/web && npm run build                # tsc + vite build → dist/
cd agent && bash build-dist.sh                      # cross-compile linux/darwin × amd64/arm64 (Go ≥ 1.23)
```

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js + TypeScript + Fastify 5 |
| Frontend | React 19 + Vite + Tailwind CSS + shadcn/ui |
| Database | SQLite (WAL, migration-managed) |
| Agent | Go + `gorilla/websocket`, single binary |
| Encryption / Auth | AES-256-GCM / scrypt + JWT (15 min) + httpOnly refresh cookie (7 d) |

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `BOOTSTRAP_ADMIN_PASS` | First run | Initial admin password |
| `BOOTSTRAP_ADMIN_USER` | No | Initial admin username (default `admin`) |
| `MASTER_KEY` | Production | Encryption master key for API keys |
| `JWT_SECRET` | Production | JWT signing secret |
| `NODE_ENV` | Production | Set to `production` to enforce security checks |
| `PORT` | No | API port (default `3000`; Docker maps host `15150`) |
| `DB_PATH` | No | SQLite path (default `console/data/ai-console.db`) |
| `GITHUB_TOKEN` | Optional | GitHub token for private-repo agent binary proxy |

See `.env` for details.

## Docs

- Tool config & credential specs: [doc/tools/](doc/tools/) (codex / claude / gemini / hermes / opencode / pi)
- Repo structure & development guide (shared by AI assistants and developers): [AGENTS.md](AGENTS.md)

## License

MIT — see [LICENSE](./LICENSE)
