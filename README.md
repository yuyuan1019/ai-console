# AI Console

统一管理多台服务器上 AI 编码工具（Codex CLI、Claude Code、Gemini CLI、OpenCode、Pi）配置与凭据的中心化 Web 控制台。

A centralized web control panel for managing AI coding CLI tools (Codex CLI, Claude Code, Gemini CLI, OpenCode, Pi) across multiple remote Linux/macOS servers.

---

## 做什么的 / What It Does

团队里每个人、每台开发机上都有 Codex / Claude / Gemini / OpenCode / Pi 这些 AI 编码工具，每台机器的配置和 API Key 各不一样。如果要换一个模型、切一个中转站、或者批量更新一批机器的 Key，就得一台一台 SSH 上去改配置。

AI Console 解决的就是这个问题：一台控制台 + 每台开发机一个轻量 Agent → Web 界面统一管理所有机器上这些工具的配置、凭据和模型配置下发。

Every developer and every machine in a team runs AI coding tools like Codex, Claude, Gemini, OpenCode, or Pi — each with its own config and API keys. Changing a model, switching a relay, or rotating keys means SSH-ing into each machine one by one.

AI Console solves this: deploy one console + install a lightweight agent on each dev machine → manage all CLI tool configs, credentials, and model configuration rollout from a single web dashboard. No SSH required.

## 核心能力 / Features

| 中文 | English |
|---|---|
| 配置读写与回滚 | Remotely read/write CLI configs with auto-backup and rollback |
| 凭据安全下发 | Push API keys to target machines (AES-256-GCM encrypted) |
| 供应商与模型管理 | Centralize API providers, keys, and model catalogs |
| 批量操作 | Apply config changes to multiple servers with dry-run preview |
| CLI 生命周期管理 | Remotely detect, install, upgrade, and uninstall supported CLI tools |
| Codex / Claude 订阅登录 | Import an existing account login from one managed machine and securely deploy it to others |
| OpenCode / Pi 多渠道下发 | Deploy multiple provider keys into one opencode.json or pi models.json for easy switching |
| 供应商默认模型 | Set a default model per provider, auto-selected in config generation |
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
            Gemini/OpenCode/  Gemini/OpenCode/  Gemini/OpenCode/
            Pi                Pi                Pi
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

### 升级已有部署 / Upgrade an existing deployment

控制台、Web 前端和 Agent 安装包都构建在 Docker 镜像中，因此拉取代码后必须重新构建镜像，不能只重启旧容器：

```bash
git pull
docker compose up -d --build
```

镜像更新完成后，在服务器详情页先将目标机器的 Agent 升级到“最新”，再升级机器上的 CLI 工具。OpenCode 多安装方式升级支持需要 Agent `v2.0.5` 或更高版本。

The console, web app, and Agent binaries are baked into the Docker image. Rebuild the image after pulling changes, then upgrade managed Agents from the server detail page before managing CLI versions. Multi-method OpenCode upgrades require Agent `v2.0.5` or newer.

## 支持的工具 / Supported CLI Tools

| 工具 / Tool | 配置文件 / Config | 凭据 / Credential |
|---|---|---|
| Codex CLI | `~/.codex/config.toml` | API Key：`~/.codex/auth.json`；订阅登录：完整 `auth.json` |
| Claude Code | `~/.claude/settings.json` | API Key 环境配置；订阅登录：`~/.claude/.credentials.json` |
| Gemini CLI | `~/.gemini/settings.json` | `GEMINI_API_KEY` / `GOOGLE_API_KEY` |
| OpenCode | `~/.config/opencode/opencode.json` | provider `apiKey` / `baseURL` |
| Pi | `~/.pi/agent/models.json` | provider `apiKey` / `baseURL` (inline in config) |
| Hermes Agent | `~/.hermes/config.yaml` | provider `api_key` (inline in config) |

## Agent 支持的操作 / Agent Actions

| 操作 / Action | 说明 / Description |
|---|---|
| `read_config` | 读取配置 / Read config file |
| `read_account_credential` | 从已登录机器导入 Codex/Claude 订阅凭据 / Import an existing subscription login |
| `write_config` | 写入配置（写前备份）/ Write config (backs up first) |
| `list_config_backups` | 列出备份 / List backup files |
| `restore_config_backup` | 恢复备份 / Restore from backup |
| `detect_tools` | 探测已装 CLI 工具及版本 / Probe installed tools |
| `set_credential` | 下发 API Key 到凭据文件 / Push API key |
| `remove_credential` | 清除凭据及配置 / Remove credential |
| `run_test` | 发送测试 prompt 验证连通性 / Test connectivity |
| `manage_tool` | 安装、升级或卸载 CLI 工具 / Install, upgrade, or uninstall a CLI tool |
| `upgrade_tool` | 旧控制台升级任务的兼容入口 / Legacy upgrade-task compatibility |
| `upgrade_agent` | 拉取最新 Agent 并重启 / Self-upgrade agent |

### CLI 安装与升级策略 / CLI Lifecycle Strategy

- Codex、Claude、Gemini 和 Pi 使用固定白名单中的 npm 包执行全局安装、升级和卸载；任务不能指定任意包名。
- OpenCode 的 npm 安装通过解析命令软链接识别，并使用 npm 原位升级；curl、pnpm、bun、brew、choco 或 scoop 安装交给 `opencode upgrade <version> --method <方式>`，避免 `~/.local/bin/opencode` 的 npm 软链接被 OpenCode 误判为 curl 安装。
- Hermes 使用官方安装脚本以及 `hermes update/uninstall` 命令，不使用同名的非官方 npm 包。
- 安装或升级结束后，Agent 会重新执行 `<tool> --version`。实际版本与目标版本不一致时任务失败，不会在控制台中误报成功。

Codex, Claude, Gemini, and Pi use allowlisted npm packages. OpenCode delegates upgrades to its native updater so the original installation method is preserved. Hermes uses its official lifecycle commands. Every install or upgrade is verified against the version reported by the resulting executable.

### 订阅账户登录 / Subscription Account Login

1. 先在一台已接入的来源机器上正常执行 `codex login` 或 `claude auth login`。
2. 进入供应商详情，在“添加新 Key / 凭据组”中选择“Codex 订阅登录”或“Claude 订阅登录”，再选择来源服务器。
3. Agent 读取 `~/.codex/auth.json` 或 `~/.claude/.credentials.json`（macOS Claude 也支持 Login Keychain），通过 TLS/WebSocket 返回控制台。
4. 控制台只保存 AES-256-GCM 密文；任务结果和审计日志仅记录指纹，不保存 access/refresh token。
5. 在单机“凭据下发”或批量下发页面选择该订阅凭据。目标文件写入权限为 `0600`，覆盖前会创建 `0600` 备份。

订阅凭据不会走 API Ping、模型拉取或 Base URL 配置，也不接受账号密码。导入与下发需要来源和目标机器的 Agent 均为 `v2.0.6` 或更高版本。多个机器共用一个订阅刷新令牌可能受 OpenAI/Anthropic 的会话策略与服务条款限制，请仅用于你有权管理的账户和机器。

First sign in normally on one managed source machine, then import its credential from the provider detail page. The console encrypts the complete login document and can deploy it to other managed machines without storing tokens in task or audit plaintext.

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
