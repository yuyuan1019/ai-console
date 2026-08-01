# AI Console

统一管理多台 Linux/macOS 开发机上 AI 编码 CLI 工具（Codex CLI、Claude Code、Gemini CLI、OpenCode、Pi、Hermes）的配置、凭据与模型下发的中心化 Web 控制台，无需 SSH。

A centralized web console + lightweight outbound agent for managing AI coding CLI configs, credentials, and model rollout across machines — no SSH.

## 功能特性 / Features

| 中文 | English |
|---|---|
| 配置读写与回滚 | Remote config read/write with auto-backup and rollback |
| 凭据安全下发 | Push API keys encrypted with AES-256-GCM |
| 供应商与模型管理 | Centralized providers, keys, and model catalogs |
| 批量操作 | Batch rollout with dry-run preview and rollback |
| CLI 生命周期管理 | Remote detect / install / upgrade / uninstall CLI tools |
| 订阅账户登录 | Import Codex/Claude subscription login and deploy it to other machines |
| OpenCode / Pi 多渠道下发 | Merge multiple provider keys into one opencode.json / pi models.json |
| 操作审计 | Full audit trail with request ID correlation |

## 快速开始 / Quick Start

```bash
git clone https://github.com/yuyuan1019/ai-console.git
cd ai-console
docker compose up -d --build
```

- 访问 `http://你的服务器IP:15150`，默认账号 `admin` / `admin`（仅限内网测试；公网部署前请在 `.env` 设置强随机的 `BOOTSTRAP_ADMIN_PASS` / `MASTER_KEY` / `JWT_SECRET` 并开启 `NODE_ENV=production`）。
- 数据存于 Docker volume `ai-console-data`（容器内 `/app/console/data/`），重建容器不丢数据。

给开发机安装 Agent（登录控制台 → 服务器管理 → 生成接入 Token）：

```bash
TOKEN='<Token>' SERVER='https://你的控制台地址' \
  sh -c "$(curl -fsSL 'https://你的控制台地址/agent/install.sh')"
```

Agent 注册为 systemd (Linux) / launchd (macOS) 服务并自动重连。卸载：

```bash
sh -c "$(curl -fsSL 'https://你的控制台地址/agent/uninstall.sh')"
```

升级部署：`git pull && docker compose up -d --build`（必须重建镜像，重启旧容器不生效）；之后在服务器详情页先升级 Agent 到“最新”，再管理 CLI 工具。OpenCode 多安装方式升级需 Agent ≥ `v2.0.5`。

## 支持的工具 / Supported Tools

| 工具 / Tool | 配置 / Config | 凭据 / Credential |
|---|---|---|
| Codex CLI | `~/.codex/config.toml` | `~/.codex/auth.json`；订阅登录：完整 `auth.json` |
| Claude Code | `~/.claude/settings.json` | `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL`；订阅登录：`~/.claude/.credentials.json` |
| Gemini CLI | `~/.gemini/settings.json` | `GEMINI_API_KEY` / `GOOGLE_GEMINI_BASE_URL` |
| OpenCode | `~/.config/opencode/opencode.json` | provider `apiKey` / `baseURL` |
| Pi | `~/.pi/agent/models.json` | provider `apiKey` / `baseURL`（内联） |
| Hermes | `~/.hermes/config.yaml` | provider `api_key`（内联） |

Codex、Claude、Gemini、Pi 走 npm 白名单安装/升级；OpenCode 按实际安装方式使用 npm 或原生 `opencode upgrade`；Hermes 使用官方安装脚本与 `hermes update/uninstall`。安装/升级后 Agent 会执行 `<tool> --version` 校验实际版本。

Codex / Claude 订阅登录：先在来源机器执行 `codex login` / `claude auth login`，再到“供应商”页导入；凭据以 AES-256-GCM 密文保存，任务与审计不落明文，目标文件权限 `0600`。需要来源/目标 Agent ≥ `v2.0.6`。

## 本地开发 / Local Development

```bash
cd console/apps/api && npm install && npm run dev   # API :3000（tsx 直跑）
cd console/apps/web && npm install && npm run dev   # Vite dev，/api 与 /agent 代理到 :3000
cd console/apps/web && npm run build                # tsc + vite build → dist/
cd agent && bash build-dist.sh                      # 交叉编译 linux/darwin × amd64/arm64（Go ≥ 1.23）
```

## 技术栈 / Tech Stack

| 层 / Layer | 选型 / Technology |
|---|---|
| 后端 / Backend | Node.js + TypeScript + Fastify 5 |
| 前端 / Frontend | React 19 + Vite + Tailwind CSS + shadcn/ui |
| 数据库 / Database | SQLite（WAL，migration 管理） |
| Agent | Go + `gorilla/websocket`，单文件二进制 |
| 加密 / 认证 | AES-256-GCM / scrypt + JWT（15min）+ httpOnly refresh cookie（7d） |

## 环境变量 / Environment Variables

| 变量 / Variable | 必填 / Required | 说明 / Description |
|---|---|---|
| `BOOTSTRAP_ADMIN_PASS` | 首次启动 / First run | 初始管理员密码 / Initial admin password |
| `BOOTSTRAP_ADMIN_USER` | 否 / No | 初始用户名，默认 `admin` |
| `MASTER_KEY` | 生产 / Production | API Key 加密主密钥 / Encryption master key |
| `JWT_SECRET` | 生产 / Production | JWT 签名密钥 / Signing secret |
| `NODE_ENV` | 生产 / Production | 设为 `production` 强制安全校验 |
| `PORT` | 否 / No | API 端口，默认 `3000`（Docker 映射宿主 `15150`） |
| `DB_PATH` | 否 / No | SQLite 路径，默认 `console/data/ai-console.db` |
| `GITHUB_TOKEN` | 可选 / Optional | 私有仓库 Agent 二进制代理 |

详见 `.env` / See `.env`。

## 文档 / Docs

- 工具配置与凭据规格：[doc/tools/](doc/tools/)（codex / claude / gemini / hermes / opencode / pi）
- 仓库结构与开发指引（AI 助手与开发者共用）：[AGENTS.md](AGENTS.md)

## License

MIT — 详见 / See [LICENSE](./LICENSE)
