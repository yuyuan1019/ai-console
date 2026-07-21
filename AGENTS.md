# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## What this is

A centralized web console + per-machine agent for managing AI coding CLI tools (Codex CLI, Codex, Gemini CLI, OpenCode, Pi) across many remote Linux/macOS dev machines — configs, credentials, and model rollout from one dashboard, no SSH. Bilingual repo (Chinese UI, English code).

## Commands

There is **no test runner, no lint script, and no monorepo workspace** anywhere in this repo. `console/package.json` is an empty `{}` — install per-app with npm (lockfile is `package-lock.json`, not pnpm/yarn). Do not assume `npm test` / `npm run lint` exist. Config-generation and crypto logic is untested — verify changes by hand.

```bash
# Console API (Fastify, runs TypeScript directly via tsx — no compile step). Listens on :3000.
cd console/apps/api && npm install && npm run dev     # tsx watch src/server.ts
cd console/apps/api && npm start                       # tsx src/server.ts (production-style)

# Console web (Vite + React 19). Dev server proxies /api and /agent → http://localhost:3000.
cd console/apps/web && npm install && npm run dev      # vite
cd console/apps/web && npm run build                   # tsc && vite build → dist/ (served by API SPA fallback)

# Full stack (builds web, runs API, serves SPA on host port 15150 → container 3000)
docker compose up -d

# Agent binaries (cross-compile linux/darwin amd64/arm64 → console/agent-dist/ + manifest.json)
cd agent && bash build-dist.sh [version]   # NOTE: currently fails — see "Agent build is broken" below

# DB seed/verify (manual, no npm script). Both are fragile — see gotchas.
node console/db/seed.cjs        # wipes + rebuilds console/data/ai-console.db; needs seed/cc-switch-import.json (not in repo)
node console/db/verify.cjs      # decrypt round-trip check; hardcoded absolute paths, will fail as-is
```

Migrations run automatically on every API boot (`runMigrations` in `core/db.ts`, called from `server.ts:34`).

## Architecture

### Two processes, outbound-only agent

```
Browser ──HTTPS──▶ Console (Node Fastify API + React SPA, SQLite)
                       │
            WebSocket  │  (agent connects OUTBOUND — no inbound port needed on managed machines)
                       ▼
                 Agent (Go daemon) ── writes ──▶ ~/.codex, ~/.Codex, ~/.gemini, ~/.config/opencode, ~/.pi/agent
```

- **Console** (`console/`): Node 24 + TypeScript + Fastify 5 (ESM), React 19 SPA, SQLite (`node:sqlite` `DatabaseSync`, WAL). One process serves both the JSON API and the built SPA (static fallback in `server.ts`).
- **Agent** (`agent/`): Go single-binary daemon using `gorilla/websocket`. Connects outbound to the console over WebSocket (`/agent/ws`), with HTTP long-poll fallback (`GET /agent/tasks`). Installs as a systemd (Linux) / launchd (macOS) user service.

### Repo layout

- `console/apps/api/src/` — Fastify API. `server.ts` bootstrap; `core/` shared infra; `middleware/auth.ts` the single auth gate; `modules/<name>/routes.ts` one file per route group.
- `console/apps/web/src/` — React SPA. `lib/api.ts` the only API client; `lib/ws.ts` browser WS client; `hooks/use*.ts` react-query hooks; `pages/` route components.
- `console/db/` — `schema.sql` (reference snapshot + fallback) + `migrations/NNN_*.sql` (10 so far) + `seed.cjs`/`verify.cjs`.
- `console/config/<tool>/` — per-tool config/credential **spec markdown + samples** (human source of truth for delivery).
- `console/agent-dist/` — compiled agent binaries + `manifest.json`, served by the API for install and self-upgrade.
- `agent/internal/agent/agent.go` — the entire agent as one ~800-line file.

### Console API boot & routing

`server.ts` uses **top-level await** (ESM). On boot: `productionCheck` → `runMigrations` → create bootstrap admin if `users` empty → `registerHooks(app)` → register 7 route modules. Each `register*Routes(app)` is called **directly on the root app with no prefix** — every route bakes its own absolute path. Two path namespaces:

- `/api/*` — browser-facing, JWT-gated by the global `onRequest` hook (exceptions: `/api/health`, `/api/auth/*`, `/api/ws`).
- `/agent/*` — agent-facing, authenticated by the agent's own long-lived `agent_token` (hash lookup), NOT by the JWT hook. (`/api/agent/manifest` and `/api/agent/enroll-tokens` sit under `/api/` and are JWT/admin-gated.)

RBAC is by **URL prefix + HTTP method** in `middleware/auth.ts`, not route metadata: `viewer` = read-only GETs; `operator+` required for non-GET on `/api/providers`, `/api/servers/`, `/api/batch/`; `admin`-only for non-GET on `/api/providers/import/` and `/api/agent/enroll-tokens`. Adding a protected `/api/` route outside these lists is auth-required but not role-gated beyond "any authenticated user".

### AgentTask — the universal async primitive

Every mutating remote operation (read/write config, set/remove credential, detect tools, upgrade agent/tool) creates an `agent_tasks` row (status `pending`) via `createAgentTask` in `modules/agent/routes.ts`. The console pushes it to the agent over WS (`{type:'cmd'}`) or the agent claims it by polling `GET /agent/tasks` (atomic `pending`→`running` with a nonce + 5-min expiry). Results return via WS `{type:'cmd_result'}` or `POST /agent/tasks/:id/result`. **Secrets are never stored in `payload_json`** — `materializeTaskPayload` decrypts the provider key on demand at push/claim time, so the DB holds only `provider_id`/`key_id` references.

`server.ts` runs a 30s zombie-sweeper: any server with `last_seen` older than 120s (agent heartbeats every 25s) is flipped to `offline`.

### Config & credential delivery — the central concept

This spans four files; changing delivery means touching all of them:

| File | Role |
|---|---|
| `core/config.ts` | `generateConfig(tool,…)` / `buildOpenCodeConfig` / `mergeOpenCodeConfig` / `withOpenAiV1` — server-side config-string generation. (Misnamed: also holds cc-switch import parsers, not app config.) |
| `modules/servers/routes.ts`, `modules/batch/routes.ts` | Delivery entrypoints (single-server `/api/servers/:id/credentials/set`; batch `/api/batch/{preview,execute}`). |
| `modules/agent/routes.ts` | `materializeTaskPayload` — per-tool credential env-key maps; opencode no-op. |
| `agent/internal/agent/agent.go` | On-host executor: `toolConfigPath()`, `handleSetCred`, `handleWriteConfig`, backup/restore. |

Two delivery channels, chosen per tool:

- **`set_credential`** writes a credential file the CLI sources. Codex → `~/.codex/auth.json` (`{"OPENAI_API_KEY":…}`). Codex/gemini → `~/.ai-console-agent/creds/<tool>.sh` (shell exports), sourced from `.bashrc`/`.zshrc` via a loop the agent appends (`ensureCredSourcing`).
- **`write_config`** writes the tool's native config file (generated by `generateConfig`). Codex → `~/.codex/config.toml` (TOML); Codex/gemini/opencode → JSON.

Per-tool reality:

| Tool | Native config (write_config) | Credential (set_credential) |
|---|---|---|
| codex | `~/.codex/config.toml` (TOML, `requires_openai_auth=true`, key NOT in toml) | `~/.codex/auth.json` `{OPENAI_API_KEY}` |
| Codex | `~/.Codex/settings.json` | `creds/Codex.sh` (`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`) |
| gemini | `~/.gemini/settings.json` | `creds/gemini.sh` (`GEMINI_API_KEY`, `GOOGLE_GEMINI_BASE_URL`) |
| opencode | `~/.config/opencode/opencode.json` | **none — set_credential is an intentional no-op** |
| pi | `~/.pi/agent/models.json` | **none — apiKey is inlined in models.json; set_credential is a no-op** |

**opencode is special-cased at every layer** and is the subject of the most recent commits. It accepts all providers (no family filter), supports multi-channel delivery (batch with >1 key merges N providers into one `opencode.json` via `mergeOpenCodeConfig`, with `config.model` set to the primary entry's `${providerId}/${model}`), previews a config-file path instead of env vars, and labels its button "下发配置" vs "下发凭据". Delivering opencode actually dispatches a `write_config` task — older code that sent `set_credential` for opencode silently delivered nothing (fixed in commits `e679877`/`cb50059`/`2373c38`). Treat opencode paths as recently-churned.

**pi is also special-cased.** It is `@earendil-works/pi-coding-agent`, configured via `~/.pi/agent/models.json`. Like opencode, the API key is inlined in the JSON config, so `set_credential` is a no-op and delivery is always a `write_config` task. Differences from opencode:
- The provider container key is `providers` (plural), not `provider`.
- There is no top-level default model; pi uses `/model` interactive selection after startup, so all enabled models for a provider are written to the `models` array.
- The `api` field supports four pi-specific protocol values: `openai-completions`, `openai-responses`, `anthropic-messages`, `google-generative-ai`, mapped from the provider key's `api_format`.
- The `baseUrl` is normalized with `withOpenAiV1` (trailing `/v1`).
- Scrub on remove overwrites `models.json` with `{ "providers": {} }`.
Full pi field documentation lives in the pi package's `docs/models.md` and `docs/custom-provider.md`; the `console/config/pi/pi配置方法.md` spec describes the AI Console delivery subset.

The `console/config/<tool>/*.md` spec files are the human source of truth but are a **simplified description**, not the literal implementation — e.g. they say env vars go in `~/.bashrc`, but the agent actually writes `creds/<tool>.sh` and sources it; the opencode sample shows rich per-model objects, but `buildOpenCodeConfig` writes each model as `{}`.

### Crypto & auth

`core/crypto.ts`: AES-256-GCM (12-byte IV, 16-byte auth tag appended, both base64) for provider keys at rest; HS256 JWT; scrypt password hashes (format `scrypt$N$r$p$saltB64$hashB64`). `core/constants.ts` derives `KEY = sha256(MASTER_KEY)` once at module load. JWT access token 15 min; refresh token 7 d in httpOnly cookie (`ai_console_refresh`). Login rate-limited 5/15min per `ip|username`; 5 fails locks 5 min. `decrypt()` swallows errors and returns `null` — callers must handle null or get silent null keys.

### Database

SQLite via `node:sqlite` `DatabaseSync` (synchronous, no pool). `WAL` + `foreign_keys=ON` set every boot. Migrations are plain `NNN_*.sql` files in `console/db/migrations/`, applied in lexical order, tracked in `schema_migrations(version PK, applied_at)`, each wrapped in `BEGIN/COMMIT` (rollback+throw on error). **Migrations are NOT individually idempotent** (ALTER ADD/DROP COLUMN) — they rely entirely on the applied-set guard; never delete rows from `schema_migrations`. Baseline heuristic: if `schema_migrations` is empty but non-system tables exist, it marks `001_baseline` applied without running it (legacy-DB upgrade path). `schema.sql` is both the reference snapshot and the fallback when the migrations dir is missing/empty — **a new schema change requires BOTH a new `NNN_*.sql` AND an update to `schema.sql`**, or the fallback diverges. `008` is a data migration (redacts old plaintext creds from `agent_tasks.payload_json` and `audit_log.after_json`).

### Web frontend

React 19 + Vite + Tailwind 3 + shadcn-style UI (`components/ui/*`). State is split: server data via `@tanstack/react-query` (hooks in `src/hooks/*`), local UI via `useState` in pages, and the **only** zustand store is `lib/theme.ts` (not persisted — reload always returns to dark). `lib/api.ts` is a hand-rolled `fetch` wrapper (not axios), base hardcoded to `/api`, access token in `localStorage` (`ai_console_access_token`) sent as `Bearer`, `credentials:'include'` for the refresh cookie. `lib/ws.ts` connects to `/api/ws?token=…` (browsers can't set WS headers) with 1s→1.5x backoff capped 30s; hooks `subscribe(channel, cb)` where `cb` invalidates react-query keys. **Every WS-backed query also sets `refetchInterval:10000` as a polling fallback.** Channels: `servers:status`, `server:<id>:tasks`, `batch:<id>`. Query keys are stable tuples (e.g. `['server', id, 'tasks']`).

`tsconfig` enforces `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax` — use `import type` for types or `tsc` (which runs before `vite build`) fails. `@/*` aliases to `src/*`. `lib/mockData.ts` is vestigial dead code — nothing imports it.

## Critical gotchas

- **Agent build is broken as-is.** `agent/internal/agent/agent.go` is `package agent` (a library) — there is no `main` package, no `func main()`, and no `agent/cmd/ai-agent/` directory that `build-dist.sh:16` builds. `build-dist.sh` and `install.sh`'s `--enroll-only` flag / `-X main.version` ldflag reference a missing `cmd/ai-agent/main.go`. The agent cannot be compiled or run until that main package is added. `go build ./...` from `agent/` compiles the library only and produces no binary.
- **`MASTER_KEY` rotation is destructive.** `KEY = sha256(MASTER_KEY)`; changing it after data is encrypted makes all existing `provider_keys.encrypted_value` undecryptable (decrypt returns null). There is no re-encryption migration.
- **`productionCheck` hard-exits** (`process.exit(1)`) when `NODE_ENV=production` if `MASTER_KEY` is the default, if `JWT_SECRET` is the derived default, or if `BOOTSTRAP_ADMIN_PASS==='admin'`. In dev the box boots wide-open with `admin`/`admin`.
- **Rate limiting is effectively off** — `@fastify/rate-limit` is registered with `global:false, max:0`; nothing throttles login/enroll unless a route explicitly opts in.
- **`providerId` is derived from `provider_name + group_name`** (lowercased, non-alphanumerics → `-`), not the DB provider UUID. Two providers with the same name+group collide and overwrite each other in `opencode.json`.
- **Codex key/base_url split is deliberate:** the key lives ONLY in `~/.codex/auth.json`; `config.toml` has `requires_openai_auth=true` and must NOT contain the key or `experimental_bearer_token` (`generateConfig` strips a stale one). There is intentionally no `OPENAI_BASE_URL` env var for codex — base_url stays in `config.toml` so it doesn't leak into other tools.
- **`withOpenAiV1(url)`** strips trailing slashes + trailing `/v1`, then re-appends `/v1`. Applied to codex `base_url` and opencode `baseURL`; Codex/gemini `base_url` use the plain stripped form (no `/v1`).
- **`seed.cjs`/`verify.cjs` are fragile:** `seed.cjs` needs `seed/cc-switch-import.json` (not in repo, gitignored) or it throws ENOENT; `verify.cjs` hardcodes `D:/dev/ai-console/...` paths that don't match this checkout.
- **Config files are written `0644`, backups `0644`** (not `0600`) — backups are world-readable. Only `state.json` and `creds/*.sh` are `0600`.
- **`handleUpgradeTool` in the agent is a stub** — it runs `<tool> --version` and echoes the requested version back; it does NOT actually upgrade tools.
- **`handleUpgradeAgent` self-exits via `os.Exit(0)`** and relies on systemd `Restart=always` / launchd `KeepAlive` to restart. Running the agent manually (no service manager) means a self-upgrade kills it with no restart.
- **`// ponytail:` comments mark non-obvious invariants** throughout the codebase (e.g. `pollRest` is deliberately a single round, not a loop; WS write mutex because gorilla allows one concurrent writer; WS close-handler cur-socket check to avoid clobber on reconnect). Treat `ponytail:` as load-bearing — don't "fix" them without understanding the race they guard.
