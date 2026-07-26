---
name: dev-workflow
description: AI Console 项目的开发收尾流程。当一项开发任务或 bug 修复完成、代码改动已就绪、准备提交时使用：先在本机用 docker compose 重建镜像并验证接口（/api/health、登录、受保护 GET）与页面（SPA 根路径），全部通过后再用规范的中文 commit 信息提交并 push 到 origin/main。涵盖健康检查、SPA、登录与受保护接口的一键验证脚本，以及提交信息规范与失败排查。
---

# 开发流程：验证 → 提交 → 推送

本 skill 是 AI Console 的**开发收尾流程**：开发或修复完成后，先在本机 docker 验证接口与页面，通过后才提交并推送。

> 触发时机：一项开发任务或 bug 修复**已经写完代码**、准备进入「提交」阶段时。
> 不要在还没改动代码、或改动中途调用本流程。

## 0. 前置条件

- 当前工作目录在 AI Console 仓库内（脚本会 `git rev-parse --show-toplevel` 定位仓库根）。
- 本机 docker 可用：`docker version` 与 `docker compose version` 都能成功。
  - **如果本机不能跑 docker**（无 docker 守护进程、远程开发机无权限等），跳过第 1 步的 docker 验证，仅做「TypeScript 类型检查」+「人工 review 改动」，然后直接进入第 2 步提交。务必在提交信息里注明「未做 docker 验证」。
- 宿主端口 `15150` 可用（容器 `:3000` → 宿主 `:15150`）。如被占用，可设环境变量 `AI_CONSOLE_PORT` 覆盖。

## 1. 自动验证（一键脚本）

跑本 skill 目录下的验证脚本（**它就是 docker 验证的核心**）：

```bash
./scripts/verify.sh
```

脚本依次做 5 件事，任一步失败即非零退出并提示原因：

| 步骤 | 做什么 | 通过判据 |
|---|---|---|
| 1 | `docker compose up -d --build` | 容器重建成功。**必须 `--build`**——该镜像把 API 源码 + 构建好的 SPA + Go 编译的 agent 三样都烤进去了，`restart`/`stop && start` 只会复用旧镜像、拿不到新代码。 |
| 2 | 轮询 `http://localhost:15150/api/health`（≤120s） | 返回 `{"ok":true,...}` |
| 3 | `GET http://localhost:15150/` | HTTP 200 + `text/html`（确认 SPA 构建成功并被服务） |
| 4 | `POST /api/auth/login`（admin / .env 的 `BOOTSTRAP_ADMIN_PASS`）；**若 401 自动调 `reset-admin.sh` 把 DB 里 admin 密码同步成 .env 值后重试一次** | 返回 `accessToken` |
| 5 | 带 JWT 冒烟 3 个受保护 GET：`/api/providers`、`/api/servers`、`/api/agent/manifest` | 均 200 |

脚本密码从仓库根的 `.env` 读 `BOOTSTRAP_ADMIN_PASS`，缺省回退 `admin`（dev wide-open）。可用 `AI_CONSOLE_PORT` 覆盖端口、`BOOTSTRAP_ADMIN_USER` 覆盖用户名。

#### admin 密码漂移与 `reset-admin.sh`

`bootstrap admin` 只在 `users` 表为空时用**当时**的 `BOOTSTRAP_ADMIN_PASS` 建一次，之后改 `.env` 不会同步已存在的用户。数据库又挂在 `ai-console-data` volume 里持久化，所以本地 DB 的 admin 密码常与当前 `.env` 漂移，登录 401。

`verify.sh` 第 4 步检测到 401 会**自动**调用 `scripts/reset-admin.sh`：在容器内用 node 内置 scrypt（参数与 `core/crypto.ts` 的 `hashPassword` 逐字对齐）把 `users.username=admin` 的 `password_hash` 改成 `.env` 的值，并清零失败计数/解锁，然后重试登录。设 `VERIFY_SKIP_RESET=1` 可禁用自动重置。

也可单独手动跑：

```bash
./scripts/reset-admin.sh
```

（仅在容器运行时可用；本地开发验证环境改写 admin 密码是安全的。）

### 脚本之外：针对性验证

5 步冒烟只覆盖「服务起来、能登录、核心 GET 通」。**本次改动涉及的接口/页面，应额外针对性验证**，举几个常见场景：

- **改了供应商预设 / config 生成逻辑** → 登录后 `POST /api/providers/import/...` 或直接在后台「供应商」页新增对应预设，确认 `base_url`、`models_endpoint` 正确；必要时下发到一台测试 agent 看 `write_config`/`set_credential` 结果。
- **改了 agent 任务** → 先确认 `GET /api/agent/manifest` 的 `version` 与 `agent/VERSION` 一致；让一台在线 agent 升级验证。
- **改了前端页面** → 浏览器打开 `http://localhost:15150/`（admin 登录），人工核对改动点是否生效；纯接口改动可跳过。
- **改了 DB schema** → 必须确认有对应的新 `console/db/migrations/NNN_*.sql` **且** 更新了 `console/db/schema.sql`，否则 fallback 路径会与迁移路径分叉。

针对性验证若需要构造请求体，参考 `console/apps/api/src/modules/*/routes.ts` 里对应路由的 schema。

## 1b. TypeScript 类型检查（轻量，docker 之外也建议做）

即使跑了 docker 脚本，也建议在提交前补一次类型检查（构建镜像时 `tsc` 会跑，但单独跑能更快定位类型错误）：

```bash
( cd console/apps/api && node_modules/.bin/tsc --noEmit ) || npm --prefix console/apps/api install && ( cd console/apps/api && node_modules/.bin/tsc --noEmit )
( cd console/apps/web && node_modules/.bin/tsc --noEmit ) || npm --prefix console/apps/web install && ( cd console/apps/web && node_modules/.bin/tsc --noEmit )
```

`tsconfig` 开了 `noUnusedLocals` / `noUnusedParameters` / `verbatimModuleSyntax`——未用变量、忘写 `import type` 都会让 `tsc` 失败，进而 `vite build` 失败、镜像构建失败。

## 2. 提交并推送

验证全部通过后，按项目规范提交。

### Commit 信息规范

格式：`<type>(<scope>): <中文简述>` + 空行 + 可选正文。

- **type**：`feat`（新功能）/ `fix`（修 bug）/ `refactor`（重构）/ `perf`（性能）/ `docs`（文档）/ `chore`（构建/杂务）/ `test`。AI Console 目前无测试套件，慎用 `test`。
- **scope**（可选）：受影响的模块，如 `provider`、`agent`、`config`、`web`、`db`、`auth`、`crypto`。
- **简述**：中文，说清「做了什么」，祈使语气。
- **正文**：说清「为什么 / 影响 / 注意事项」。涉及破坏性变更、数据库迁移、版本号变更（`agent/VERSION`）、与构建产物联动的提交，正文里务必写明。

示例（参考近期提交）：

```
fix(provider): 智谱 GLM 切到编程套餐端点，withOpenAiV1 不再给版本段补 /v1

- 智谱 GLM 预设 baseUrl: /api/paas/v4 → /api/coding/paas/v4
- withOpenAiV1 识别规则 /\/v1$/i → /\/v\d+$/i，避免 /v4 被补成 /v4/v1
```

### 提交命令

```bash
git add -A                              # 或精确 git add <具体文件>
git commit -F - <<'EOF'
<type>(<scope>): <简述>

<正文，逐条用 - 开头>
EOF
git push origin main
```

### 联动提醒（提交前自检）

- **改了 agent 代码**：`agent/VERSION` 和重建后的 `console/agent-dist/`（4 个二进制 + `manifest.json`）必须在**同一个 commit**，否则直接 tsx 部署的「最新」manifest 会与 VERSION 漂移。
- **改了 DB schema**：新迁移 `NNN_*.sql` 与 `schema.sql` 快照一起提交。
- **只改了文档**：无需 docker 验证，直接提交即可。

## 3. 验证失败排查

| 现象 | 排查 |
|---|---|
| 脚本第 1 步构建失败 | `docker compose build` 看完整日志；常见是 `tsc` 类型错误或 Go 编译失败（CN 需 `GOPROXY=https://goproxy.cn,direct`）。 |
| `/api/health` 一直不就绪 | `docker compose logs --tail=100`。`productionCheck` 在 `NODE_ENV=production` 且用默认 `MASTER_KEY`/`JWT_SECRET`/`admin` 密码时会 `process.exit(1)`——本机验证通常 `NODE_ENV` 未设（走 warn 不退出），若设了 production 又没配强密钥就会 fatal。 |
| 登录 401 | `verify.sh` 会自动跑 `reset-admin.sh` 同步密码；若重置后仍 401，看 `.env` 的 `BOOTSTRAP_ADMIN_PASS` 是否含被 shell/docker 吞掉的字符（`#` 等）。 |
| 受保护接口 401/403 | JWT 过期（15min）或角色不足——RBAC 按 URL 前缀+方法判定，非 admin 对部分写接口 403 是正常的；验证脚本只用 GET，不应出现。 |
| SPA 返回 200 但页面白屏 | `docker compose exec ai-console ls /app/console/apps/web/dist` 确认产物存在；多半是前端运行时报错，看浏览器控制台。 |

## 附：端口与端点速查

- 宿主入口：`http://localhost:15150/`（容器 `:3000`）
- 健康检查：`GET /api/health`（无需认证）
- 登录：`POST /api/auth/login` body `{username,password}` → `{accessToken,user}`
- 管理后台：浏览器开 `http://localhost:15150/`，用 admin + `.env` 的 `BOOTSTRAP_ADMIN_PASS` 登录
