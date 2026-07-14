# AI Console

统一管理多台服务器上 AI 编码工具（Codex CLI、Claude Code、Gemini CLI、OpenCode）配置与凭据的中心化 Web 控制台。

A centralized web control panel for managing AI coding CLI tools (Codex CLI, Claude Code, Gemini CLI, OpenCode) across multiple remote Linux/macOS servers.

---

## 做什么的 / What It Does

团队里每个人、每台开发机上都有 Codex / Claude / Gemini / OpenCode 这些 AI 编码工具，每台机器的配置和 API Key 各不一样。如果要换一个模型、切一个中转站、或者批量更新一批机器的 Key，就得一台一台 SSH 上去改配置。

AI Console 解决的就是这个问题：一台控制台 + 每台开发机一个轻量 Agent → Web 界面统一管理所有机器上这些工具的配置、凭据和模型配置下发。

Every developer and every machine in a team runs AI coding tools like Codex, Claude, Gemini, or OpenCode — each with its own config and API keys. Changing a model, switching a relay, or rotating keys means SSH-ing into each machine one by one.

AI Console solves this: deploy one console + install a lightweight agent on each dev machine → manage all CLI tool configs, credentials, and model configuration rollout from a single web dashboard. No SSH required.

## 核心能力 / Features

| 中文 | English |
|---|---|
| 配置读写与回滚 | Remotely read/write CLI configs with auto-backup and rollback |
| 凭据安全下发 | Push API keys to target machines (AES-256-GCM encrypted) |
| 供应商与模型管理 | Centralize API providers, keys, and model catalogs |
| 批量操作 | Apply config changes to multiple servers with dry-run preview |
| 操作审计 | Full audit trail with request ID correlation |

## 架构 / Architecture

```
浏览器 / Browser ─── HTTPS ─── 控制台 / Console (Node.js + SQLite)
                                    │
                     ┌──────────────┼──────────────┐
                     │              │              │
                 WebSocket      WebSocket      WebSocket
                     │              │              │
                Agent@开发机1   Agent@开发机2   Agent@macOS
                     │              │              │
            Codex/Claude/     Codex/Claude/     Codex/Claude/
            Gemini/OpenCode   Gemini/OpenCode   Gemini/OpenCode
```

- **控制台 / Console**：Node.js + TypeScript + Fastify，React SPA 前端，SQLite 数据库
- **Agent**：Go 编译的单文件守护进程，WebSocket 主动外连 + REST 降级
- **无需 SSH** — Agent 主动连接控制台，无需开放被管机入站端口 / Agent connects outbound, no inbound ports needed on managed machines

## 快速部署 / Quick Start

### 1. 拉代码 / Clone

```bash
git clone https://github.com/your-org/ai-console.git
cd ai-console
```

### 2. 启动 / Start

```bash
docker compose up -d
```

访问 `http://你的服务器IP:15150`，用 `admin` / `admin` 登录。

Open `http://your-server-ip:15150` and log in with `admin` / `admin`.

> **:warning: 默认密码仅用于内网测试。部署到公网前，请修改 `.env` 中 `BOOTSTRAP_ADMIN_PASS`，并取消 `NODE_ENV`、`MASTER_KEY`、`JWT_SECRET` 的注释设为强随机值。**
> :warning: **Default credentials are for LAN testing only. Before exposing to the internet, change `BOOTSTRAP_ADMIN_PASS` in `.env` and uncomment `NODE_ENV` / `MASTER_KEY` / `JWT_SECRET` with strong random values.**

### 3. 给开发机安装 Agent / Install agent on managed machines

登录控制台 → **服务器管理** → 生成接入 Token。在目标开发机上执行 / Log in → **Servers** → generate an enroll token, then run:

```bash
TOKEN='<Token>' SERVER='https://你的控制台地址' \
  sh -c "$(curl -fsSL 'https://你的控制台地址/agent/install.sh')"
```

Agent 自动注册为 systemd (Linux) 或 launchd (macOS) 服务，进程常驻、断线自动重连。
Installs as a systemd (Linux) or launchd (macOS) service with auto-reconnect.

## 支持的工具 / Supported CLI Tools

| 工具 / Tool | 配置文件 / Config | 凭据 / Credential |
|---|---|---|
| Codex CLI | `~/.codex/config.toml` | `OPENAI_API_KEY` / `OPENAI_BASE_URL` |
| Claude Code | `~/.claude/settings.json` | `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` |
| Gemini CLI | `~/.gemini/settings.json` | `GEMINI_API_KEY` / `GOOGLE_API_KEY` |
| OpenCode | `~/.config/opencode/opencode.json` | provider `apiKey` / `baseURL` |

## Agent 支持的操作 / Agent Actions

| 操作 / Action | 说明 / Description |
|---|---|
| `read_config` | 读取配置 / Read config file |
| `write_config` | 写入配置（写前备份）/ Write config (backs up first) |
| `list_config_backups` | 列出备份 / List backup files |
| `restore_config_backup` | 恢复备份 / Restore from backup |
| `detect_tools` | 探测已装 CLI 工具及版本 / Probe installed tools |
| `set_credential` | 下发 API Key 到凭据文件 / Push API key |
| `remove_credential` | 清除凭据及配置 / Remove credential |
| `run_test` | 发送测试 prompt 验证连通性 / Test connectivity |
| `upgrade_tool` | 升级 CLI 工具 / Upgrade CLI tool |
| `upgrade_agent` | 拉取最新 Agent 并重启 / Self-upgrade agent |

## 技术栈 / Tech Stack

| 层 / Layer | 选型 / Technology |
|---|---|
| 后端 / Backend | Node.js + TypeScript + Fastify 5 |
| 前端 / Frontend | React 19 + Vite + Tailwind CSS + shadcn/ui |
| 数据库 / Database | SQLite (WAL mode, migration-managed) |
| Agent | Go, `gorilla/websocket`, single binary |
| 加密 / Encryption | AES-256-GCM (API keys at rest) |
| 认证 / Auth | scrypt 密码哈希, JWT (15min) + httpOnly refresh cookie (7d) |

## 环境变量 / Environment Variables

| 变量 / Variable | 必填 / Required | 说明 / Description |
|---|---|---|
| `BOOTSTRAP_ADMIN_PASS` | 首次启动 / First run | 初始管理员密码 / Initial admin password |
| `BOOTSTRAP_ADMIN_USER` | 否 / No | 初始用户名，默认 `admin` |
| `MASTER_KEY` | 生产环境 / Production | API Key 加密主密钥 / Encryption master key |
| `JWT_SECRET` | 生产环境 / Production | JWT 签名密钥 / Signing secret |
| `NODE_ENV` | 生产环境设为 `production` | 开启安全校验，强制自定义密钥 |
| `GITHUB_TOKEN` | 可选 / Optional | 私有仓库 Agent 代理 / Private repo agent proxy |

详见 `.env` / See `.env`

## License

MIT — 详见 / See [LICENSE](./LICENSE)
