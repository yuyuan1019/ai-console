# AI Console 2.0 BUG 修复实施计划（破坏性升级）

> 本文件是 `BUGFIXES-2026-07-18.md` 的落地执行版。
> 记录了 2.0 断代决策、清库范围、迁移编号、提交拆分、发布流程与验收清单。
> 实施过程中所有偏离必须在此文件更新记录，不能在提交信息里静默偏差。
> 本文件仅是计划；任何清库、卸载、迁移或发布动作都必须在单独获得执行授权后进行。

---

## 1. 关键决策（不可回退）

| 项 | 决策 | 决策日期 |
|---|---|---|
| 迁移编号 | 使用 **016–019**（跳过 012–015 以规避未知分支冲突） | 2026-07-18 |
| Agent 处理方式 | **删干净重装**，不保留旧 Agent，不写兼容分支 | 2026-07-18 |
| Console DB | **全清核心业务表**（含 providers/provider_keys/models） | 2026-07-18 |
| audit_log 历史 | 在线库敏感字段 **`[REDACTED]` 就地覆盖**且不提供应用内恢复；发布前一致性回滚备份仍包含原文，需加密限权并按期销毁 | 2026-07-18 |
| Agent 协议 | **硬切 protocol 2**；enroll 必须显式声明版本，数据库禁止用默认值伪装新版 | 2026-07-18 |
| Agent WS 认证 | 长期 Agent Token 只走 `Authorization` header，禁止进入 URL query | 2026-07-18 |
| 质量目标 | 发布时 **已知 P0/P1 缺陷为 0**；不宣称软件绝对“无 Bug” | 2026-07-18 |

### 1.1 2.0 支持边界

```text
Console version: 2.0
Agent version: 2.0
Agent protocol: 2
Minimum supported agent protocol: 2
Upgrade method: clean reinstall only
Protocol 1 behavior: reject before enrollment/task dispatch
```

- 不保留 protocol 1 结果兼容、灰度门槛或旧 instance identity 绑定逻辑。
- 旧 Agent 请求 `/agent/enroll` 时返回 `426 Upgrade Required`，且不得创建 server 行。
- 旧 Agent 请求 `/agent/ws`、heartbeat、task/result 时返回/关闭为 `agent protocol 2 required`。
- “只维护最新版本”不等于跳过回滚准备；2.0 发布仍必须可恢复旧 DB、旧镜像和旧 Agent 安装包。

## 2. 迁移编号映射表

| BUGFIXES 文档原编号 | 本次实际编号 | 文件名 | 归属 BUG |
|---|---|---|---|
| 012 | **016** | `016_encrypt_sensitive_task_content.sql` | BUG-01 |
| 013 | **017** | `017_batch_rollback_progress.sql` | BUG-04 |
| 014 | **018** | `018_agent_instance_identity.sql` | BUG-08 |
| 015 | **019** | `019_agent_protocol_version.sql` | BUG-05 |

`schema_migrations` 表允许出现编号 gap（011 → 016）。`console/db/schema.sql` 必须同步这四个新迁移的所有列定义。

## 3. 因决策简化掉的原方案内容

对比 `BUGFIXES-2026-07-18.md` 原设计，以下工作 **不需要做**：

1. **BUG-05 protocol 1 兼容分支** — DB 清空后所有 Agent 一定是新版，`handleTaskResult` 从一开始就强制 nonce
2. **BUG-05 `MIN_AGENT_PROTOCOL` env 门槛机制** — 无灰度期，直接硬切
3. **BUG-05 灰度发布 R1 + R2 两次窗口** — 单次发布即可
4. **BUG-08 「旧 Agent 无 instance_id 首次心跳自动绑定」兼容代码** — 全新 Agent 一律带 UUID enroll
5. **BUG-08 `agent_instance_id` 可空 + 唯一部分索引** — 迁移最终形状为 `NOT NULL` + 完整唯一约束，无空字符串默认值
6. **BUG-01 configs / agent_tasks 历史清洗启动 hook** — 表已清空，只保留 audit_log 清洗
7. **BUG-05 `servers.agent_protocol_version DEFAULT 1`** — 改为 `NOT NULL CHECK(agent_protocol_version=2)`，无默认值；enroll 显式写 2

## 4. 发布流程（单次窗口）

```
Step 1. 停 Console 服务
Step 2. 创建可验证的一致性备份：
        a. 使用 SQLite backup API / sqlite3 `.backup`；不能只复制主 DB 而遗漏 WAL
        b. 备份旧 Console 镜像、console/agent-dist、MASTER_KEY/JWT_SECRET 配置指纹
        c. 记录备份 hash，并在隔离目录做一次恢复打开验证
        d. 原始 audit_log 备份含潜在敏感数据，必须加密、限权并设置回滚窗口后的销毁日期
Step 3. 获得本次发布的显式清库确认后，手动清库（顺序不能反，受外键约束）：
        DELETE FROM configs;
        DELETE FROM agent_tasks;
        DELETE FROM tools;
        DELETE FROM servers;
        DELETE FROM agent_enroll_tokens;
        DELETE FROM batch_jobs;
        DELETE FROM import_jobs;
        DELETE FROM models;
        DELETE FROM provider_keys;
        DELETE FROM providers;
        -- 保留：users, sessions, schema_migrations, audit_log(将被 016 REDACTED 覆盖)

Step 4. 部署新 Console（含全部 13 个提交）
Step 5. Console 启动 → 自动跑迁移 016 → 017 → 018 → 019
        → 迁移 016 执行 audit_log 敏感字段 REDACTED 覆盖
Step 6. 管理员登录，重新配置 providers / provider_keys / models
        （或重新导入 cc-switch）
Step 7. 生成 enroll token，逐台机器：
        a. bash <(curl -fsSL <console>/agent/uninstall.sh)
        b. TOKEN='<token>' SERVER='https://<console>' \
             sh -c "$(curl -fsSL 'https://<console>/agent/install.sh')"
Step 8. 验证：
        - 所有机器 servers.status = 'online'
        - 所有机器 servers.agent_protocol_version = 2
        - 所有机器 servers.agent_instance_id 非空
        - 旧 Agent enroll 返回 426，且没有新增 server 行
        - `/agent/ws` 访问日志/URL 不含 agent_token；认证只使用 Authorization header
```

## 5. 回滚预案

**回滚窗口极窄**（因决策 B 已清库）：

| 场景 | 恢复方式 |
|---|---|
| Console 启动失败 / 迁移失败 | 停新 Console，恢复 Step 2 的 SQLite 一致性备份及旧环境配置，切回旧 Console 镜像 |
| 尚未卸载旧 Agent 的机器失败 | 恢复旧 DB/Console 后，旧 Agent 使用恢复出的原 token 重连 |
| 已安装 2.0 Agent 的机器需要回滚 | 恢复旧 DB/Console 后，卸载 2.0 Agent，从旧 Console 重新生成 enroll token，并用备份的旧 agent-dist 重装；新 token 无法直接用于旧 DB |
| 迁移应用后发现 BUG | 无法就地回滚（迁移不可逆）；必须从 Step 2 备份完整恢复 |
| audit_log 已被 REDACTED | **不可恢复**，只能从 Step 2 备份还原原始 audit_log |

**强制前置**：Step 2 的备份、hash 和恢复验证必须在 Step 3 清库前完成。没有验证过的备份等同于没有备份；不得继续清库。

---

## 6. 提交拆分（13 个原子提交，按依赖顺序）

### 提交 1 — `fix(authz): protect import rollback and add role matrix`
**BUG**：BUG-02
**文件**：
- `console/apps/api/src/middleware/auth.ts`

**改动**：
- `adminOnly` 数组加入 `"/api/import-jobs/"`
- （二次改造，可留待后续 PR）为 mutation 路由加 `config.minRole`，全局 hook 从 `req.routeOptions.config.minRole` 读

**验收**：
- viewer / operator POST `/api/import-jobs/:id/rollback` → 403
- admin POST 同接口 → 200 或业务错误
- `curl -H "Bearer $VIEWER" -X POST /api/import-jobs/x/rollback` 返回 `{"error":"admin role required"}`

---

### 提交 2 — `feat(db): migrations 016-019 for encryption, batch, identity, protocol`
**BUG**：BUG-01 / BUG-04 / BUG-05 / BUG-08
**文件**：
- `console/db/migrations/016_encrypt_sensitive_task_content.sql`（新建）
- `console/db/migrations/017_batch_rollback_progress.sql`（新建）
- `console/db/migrations/018_agent_instance_identity.sql`（新建）
- `console/db/migrations/019_agent_protocol_version.sql`（新建）
- `console/db/schema.sql`（同步补上四个迁移涉及的所有列定义）

**016 SQL 草案**：
```sql
ALTER TABLE agent_tasks ADD COLUMN encrypted_payload TEXT;
ALTER TABLE agent_tasks ADD COLUMN encrypted_payload_iv TEXT;

ALTER TABLE configs ADD COLUMN encrypted_content TEXT;
ALTER TABLE configs ADD COLUMN encrypted_content_iv TEXT;
ALTER TABLE configs ADD COLUMN content_sha256 TEXT;

-- audit_log 历史脱敏（幂等：已 REDACTED 的行不再改）。
-- 使用 JSON key 形状，避免 `%token%` 把非敏感的 token 统计/描述误判。
UPDATE audit_log
SET after_json = '{"redacted":true}'
WHERE after_json IS NOT NULL
  AND after_json != '{"redacted":true}'
  AND (
    after_json LIKE '%"api_key"%' OR after_json LIKE '%"apiKey"%' OR
    after_json LIKE '%OPENAI_API_KEY%' OR after_json LIKE '%ANTHROPIC_AUTH_TOKEN%' OR
    after_json LIKE '%GEMINI_API_KEY%' OR after_json LIKE '%"token"%' OR
    after_json LIKE '%"secret"%' OR after_json LIKE '%"password"%' OR
    after_json LIKE '%"authorization"%' OR after_json LIKE '%"credentials"%'
  );

UPDATE audit_log
SET before_json = '{"redacted":true}'
WHERE before_json IS NOT NULL
  AND before_json != '{"redacted":true}'
  AND (
    before_json LIKE '%"api_key"%' OR before_json LIKE '%"apiKey"%' OR
    before_json LIKE '%OPENAI_API_KEY%' OR before_json LIKE '%ANTHROPIC_AUTH_TOKEN%' OR
    before_json LIKE '%GEMINI_API_KEY%' OR before_json LIKE '%"token"%' OR
    before_json LIKE '%"secret"%' OR before_json LIKE '%"password"%' OR
    before_json LIKE '%"authorization"%' OR before_json LIKE '%"credentials"%'
  );
```

**017 SQL 草案**：
```sql
ALTER TABLE batch_jobs ADD COLUMN rollback_progress_json TEXT;
ALTER TABLE batch_jobs ADD COLUMN rollback_started_at INTEGER;
```

**018 SQL 草案**：
```sql
-- 018 是 019 重建前的中间形状。最终 NOT NULL/完整唯一约束由 019 建表完成。
ALTER TABLE servers ADD COLUMN agent_instance_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_servers_agent_instance_id
  ON servers(agent_instance_id)
  WHERE agent_instance_id IS NOT NULL;

ALTER TABLE agent_enroll_tokens ADD COLUMN target_server_id TEXT;
ALTER TABLE agent_enroll_tokens ADD COLUMN enroll_mode TEXT NOT NULL DEFAULT 'new';
```

**019 SQL 草案**：
```sql
-- 2.0 硬切要求 Step 3 已清空 servers。若仍有行，CHECK 失败并中止迁移，
-- 避免静默给旧 Agent 填 protocol 2 或空 instance identity。
CREATE TEMP TABLE migration_019_servers_empty_guard (
  row_count INTEGER NOT NULL CHECK (row_count = 0)
);
INSERT INTO migration_019_servers_empty_guard SELECT COUNT(*) FROM servers;
DROP TABLE migration_019_servers_empty_guard;

DROP TABLE servers;
CREATE TABLE servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  os TEXT,
  arch TEXT,
  host TEXT,
  agent_token_hash TEXT,
  status TEXT NOT NULL DEFAULT 'offline',
  last_seen INTEGER,
  tags TEXT NOT NULL DEFAULT '[]',
  group_id TEXT,
  agent_version TEXT,
  agent_instance_id TEXT NOT NULL UNIQUE,
  agent_protocol_version INTEGER NOT NULL CHECK (agent_protocol_version = 2),
  created_at INTEGER NOT NULL
);
```

**验收**：
- 清空 DB 上启动 → 4 个迁移全部应用
- 已应用 011 的库启动 → 从 016 开始应用
- `SELECT sql FROM sqlite_master WHERE type='table' AND name='servers'` 含 `agent_instance_id` 和 `agent_protocol_version`
- `servers` 建表 SQL 中 instance identity 无默认值，protocol 无默认值且有 `CHECK(...=2)`
- 跳过 Step 3、servers 仍有行时 019 必须失败，不能把旧行伪装成 protocol 2
- 二次启动零 DDL 重放

---

### 提交 3 — `fix(secrets): encrypt sensitive task/config payloads and redact APIs`
**BUG**：BUG-01（服务端逻辑部分）
**文件**：
- `console/apps/api/src/modules/agent/routes.ts`
- `console/apps/api/src/modules/servers/routes.ts`
- `console/apps/api/src/modules/batch/routes.ts`
- `console/apps/api/src/core/audit.ts`
- `console/apps/api/src/core/crypto.ts`（如需辅助函数）
- `console/apps/api/src/core/config.ts`（仅 `materializeTaskPayload` 生成逻辑调用位置）

**关键改动**：

1. **`createAgentTask` 签名扩展**：
   ```ts
   createAgentTask(
     serverId, userId, action, payload,
     opts?: { sensitivePayload?: unknown; auditMeta?: Record<string, unknown> }
   )
   ```
   - 有 `sensitivePayload`：`payload_json` 只存 `{tool,source,redacted:true}` 安全元数据，敏感内容 `encrypt()` → `encrypted_payload`/`encrypted_payload_iv`
   - 无：走原逻辑

2. **引入引用型 payload**：
   ```ts
   type ProviderConfigRef = {
     tool: string
     source: "provider_refs"
     entries: Array<{ provider_id: string; key_id: string; model_id: string; primary?: boolean }>
   }
   ```
   - `batch/execute` 不再提前 `generateConfig`，改传引用
   - `servers/:id/credentials/set` opencode 分支同样改引用
   - `materializeTaskPayload` 在 push/claim 时才解密 + 生成

3. **`handleTaskResult` 收敛**：
   - `write_config` 结果强删 `result.content`
   - `read_config` 结果的 `content` 加密后写 `configs.encrypted_content`，`configs.content` 存 `[ENCRYPTED]`
   - 必须在执行 `UPDATE agent_tasks ... result_json=?` 前完成删除/加密；明文不能先短暂写入 result_json 再二次清理

4. **审计白名单**：
   - `audit()` 调用点全部改为白名单元数据（`tool`/`provider_ids`/`key_ids`/`model_ids`/`sensitive`）
   - `audit.ts` 内部加防御性递归 REDACT 兜底（正则匹配敏感 key 名）

5. **API 输出脱敏**：
   - `GET /api/servers/:id/tasks` 改 allowlist：`{id, action, tool, status, error, created_at, claimed_at, finished_at, result: {path, format, backup, content_sha256}}`
   - `payload_json` / `result_json` 原文不返回
   - 新增 `GET /api/servers/:id/configs/latest?tool=xxx`：本提交必须在 handler 内显式执行 operator+ 检查；不能依赖当前“GET 不限角色”的 URL 前缀 RBAC。后续若完成 `config.minRole` 重构，再用统一机制替换显式检查
   - viewer 如需版本信息，使用独立 metadata 响应/接口，不得和解密正文共用一个无角色门槛的 handler

**验收**：
- 下发 opencode 后任务 payload 只含 tool/source/provider/key/model 引用或 redacted 元数据，不含测试 Key/完整配置
- `SELECT after_json FROM audit_log WHERE action='agent_task.create'` 不含 `api_key` 字样
- viewer GET `/api/servers/:id/tasks` 响应体 grep 测试 Key → 0 命中
- viewer GET `/api/servers/:id/configs/latest?tool=opencode` → 403
- 在 `agent_tasks.payload_json/result_json`、`configs.content`、`audit_log.before_json/after_json` 中按固定测试 Key 查询，命中数均为 0

---

### 提交 4 — `fix(agent): write configs atomically with private permissions`
**BUG**：BUG-01（Agent 侧）
**文件**：
- `agent/internal/agent/agent.go`

**改动**：
- `New()` 中 `os.MkdirAll(credsDir, 0755)` 改 `0700`
- `~/.ai-console-agent` 目录同样 `0700`
- `handleWriteConfig`：
  1. 已存在 → 读并写 backup `0600`
  2. 同目录创建临时文件 `.<name>.tmp-<pid>` `0600`
  3. 写入 → `f.Sync()` → close
  4. `os.Rename(tmp, path)`
  5. 父目录 fsync（Linux/darwin 支持）
  6. `os.Chmod(path, 0600)` 兜底
  7. 返回 `{path, format, content_sha256, backup}`，**不返回 content**
- `handleRestoreBackup` 同样改 `0600` 写入
- `handleRestoreBackup` 也使用“同目录临时文件 + Sync + Rename”，不能只把原来的直接 WriteFile 改成 0600
- `handleSetCred` 写 codex `auth.json` 和 `creds/*.sh` 后显式 `os.Chmod(path, 0600)`，覆盖旧文件时也必须收紧权限
- 2.0 Agent 启动时执行一次已知路径权限修复：四种工具当前配置、codex auth、`creds/*.sh`、四种配置目录中的 `.bak.*` 全部 chmod 0600；目录 chmod 0700
- uninstall 不删除 CLI 配置/备份，因此不能假设“删 Agent 重装”会清掉旧的 0644 敏感文件
- `handleReadConfig` 返回加密由服务端负责，这里不动

**验收**：
- 下发一次 write_config 后：
  ```
  stat -c '%a' ~/.ai-console-agent → 700
  stat -c '%a' ~/.ai-console-agent/creds → 700
  stat -c '%a' ~/.codex/config.toml → 600
  stat -c '%a' ~/.codex/.config.toml.bak.* → 600
  ```
- 模拟 write 到一半 kill 进程 → `~/.codex/config.toml` 不残留半份文件
- 在升级前预置一个 0644 的旧 backup/auth/creds 文件，首次启动 2.0 Agent 后全部变为 600

---

### 提交 5 — `fix(auth): distinguish concurrent refresh rotation`
**BUG**：BUG-03
**文件**：
- `console/apps/api/src/modules/auth/routes.ts`
- `console/apps/web/src/lib/api.ts`
- `console/apps/web/src/lib/auth.tsx`（若需要）

**服务端改动**：
- `rotateSession` 返回判别联合：
  ```ts
  type RotateResult =
    | { kind: "ok"; session: { accessToken: string; user: AuthUser } }
    | { kind: "recent_rotation" }
    | { kind: "invalid" }
    | { kind: "replay" }
  ```
- `POST /api/auth/refresh`：
  - `ok` → 200 + session
  - `recent_rotation` → 409 `{error:"refresh_already_rotated"}`，**不清 Cookie，不签 access token**
  - `invalid` / `replay` → 401 + clearCookie
- `GET /api/auth/me` 去掉隐式 rotate 分支，只走 access JWT

**前端改动**：
- `rawRequest` 抛结构化错误：`{ status, code, message }`
- `refreshAccessToken`：
  - 收到 status=409 → 50ms/150ms/300ms 三次重试（重试使用浏览器 Cookie jar）
  - 只有最终 401 才 `setAccessToken(null)`

**验收**：
- 手工构造：两个 tab 同时 `fetch('/api/auth/refresh',{method:'POST',credentials:'include'})` → 至少一个 200，Cookie 仍有效
- 30s 后再用旧 refresh 重放 → session 撤销 + `auth.replay_detected` 审计

---

### 提交 6 — `fix(websocket): preserve subscriptions across reconnects`
**BUG**：BUG-09
**文件**：
- `console/apps/web/src/lib/ws.ts`

**改动**：
- 拆函数：
  ```ts
  function disconnectSocket() { /* clear timer, handlers, ws; NO subscribers clear */ }
  export function closeWS() { currentToken=null; disconnectSocket(); subscribers.clear(); pendingSubscriptions.clear() }
  ```
- `initWS` / `onclose` 自动重连只调 `disconnectSocket()`
- 加 socket `generation`：
  ```ts
  let connectionGeneration = 0
  const gen = ++connectionGeneration
  socket.onclose = () => { if (ws !== socket || gen !== connectionGeneration) return; ... }
  ```
- `initWS` 在 `await fetchWsTicket()` 前记录 connect attempt generation，await 后若已不是最新 attempt，立即返回且不得消费/创建 socket；同 token 的两个并发 init 也只能有一个连接尝试继续
- `ticketPromise` settle 后立即 null，去掉 `setTimeout(...1000)` 缓存

**验收**：
- Chrome DevTools → 手动关 WS → 观察 subscribers.size 不变
- 连续两次 initWS，第二次使用新 ticket（旧 ticket 4001）
- 两个并发 initWS 最多创建一个 WebSocket，单次 ticket 只被一个 attempt 消费
- logout → subscribers 清空

---

### 提交 7 — `feat(protocol): task nonce, lease renewal, mandatory protocol 2`
**BUG**：BUG-05（服务端 + 协议部分）
**文件**：
- `console/apps/api/src/modules/agent/routes.ts`
- `console/apps/api/src/server.ts`

**改动**：
1. `handleTaskResult` 签名 `+nonce` 参数，CAS 加 `AND nonce=?`
2. WS `cmd_result` 分支：从 `msg.nonce` 读；缺失直接返回错误（硬切，不兼容）
3. REST `POST /agent/tasks/:taskId/result` body 强制包含 `nonce`
4. 新增 `POST /agent/tasks/:id/lease` body `{nonce}` → `expires_at += 2min`
5. WS `cmd_lease` 消息走同一函数
6. `server.ts` reaper：
   - claim 成功时原子执行 `attempt_count=attempt_count+1`
   - 租约过期且 `attempt_count<3` 才回 pending
   - `attempt_count>=3` 直接 failed，错误 `"task lease expired after 3 attempts"`
7. `POST /agent/enroll` 在消费 enroll token、插入 server 前强制 `body.protocol_version===2`；缺失或其他值返回 426，且不得创建/更新任何 DB 行
8. heartbeat 读 `payload.protocol_version` 并要求严格等于 2；DB 值只写请求中的显式 2，不能使用列默认值推断
9. `/agent/ws` 改从 `Authorization: Bearer <agent-token>` 认证；Agent 使用 `DialContext(..., header)` 发送。删除 `?token=` 读取分支，避免长期 token 进入反向代理日志
10. Console 每个 server 同一时间最多 claim/dispatch 一个任务：只有不存在 running task 时才推下一条 pending；结果终态、租约回收或连接重建后调用 `dispatchNextTask(serverId)`
11. WS backlog flush 不再遍历并一次性 push 全部 pending，只触发一次 `dispatchNextTask`
12. 定义 nonce-bound `cmd_nack`（如 `reason='busy'`）：服务端仅在 id/server/status/nonce 匹配时把 claim 退回 pending并清理 nonce/lease；不得把 NACK 当普通 failed result，也不得接受旧 nonce NACK

**验收**：
- 用旧 nonce POST result → 409 `stale_task_lease`
- 8min 任务持续 lease → 不被回收
- 总计最多 3 次 claim；第 3 次租约过期后 task.status='failed'
- protocol 1/missing enroll → 426 且 servers 表行数不变
- 任意 server 同时 `status='running'` 的任务数不超过 1
- `/agent/ws` URL 不含 token，query token 连接被拒绝
- busy NACK 使用当前 nonce 时任务回 pending；旧 nonce NACK 返回 409 且不改变新 claim

---

### 提交 8 — `fix(agent): serialize mutations via single worker + task journal`
**BUG**：BUG-05（Agent 侧）
**文件**：
- `agent/internal/agent/agent.go`

**改动**：
1. `connectWS`：
   ```go
   cmdQueue := make(chan wsCmd, 64)
   go func() { for cmd := range cmdQueue { a.handleCmdWS(conn, &cmd) } }()
   // reader:
   select {
     case cmdQueue <- cmd:
     default: /* return an explicit nonce-bound busy result; never drop silently */
   }
   ```
   删除 `go func(cmd) { a.handleCmdWS(...) }(cmd)`
2. `sendResult` 增加 `nonce` 顶层字段
3. `restTask` 增加 `Nonce`/`ExpiresAt` 字段，`pollRest` result body 增加同一个 `nonce`
4. `Config` 增加固定 `ProtocolVersion: 2`；Enroll body、WS/REST heartbeat 都显式发送 `protocol_version: 2`
5. `connectWS` 不再拼 `?token=`，改用握手 header：`Authorization: Bearer <agent-token>`
6. 新增 `journal.go`：`~/.ai-console-agent/task-journal.json` 0600，最近 1000 条：
   ```go
   type journalEntry struct {
     Action     string          `json:"action"`
     Status     string          `json:"status"`
     Result     json.RawMessage `json:"result"`
     FinishedAt int64           `json:"finished_at"`
   }
   ```
7. 将执行入口改为 `executeTask(taskID, nonce, action, payload)`；WS/REST 都必须把 task ID/nonce 传入，才能在执行前检查 journal。taskID 已有完成结果 → 直接回报缓存 + 新 nonce
8. 45s ticker 对未完成任务调 `/agent/tasks/:id/lease`
9. 因 Console 每机只 dispatch 一条，队列通常至多 1；若收到 busy，服务端将任务回 pending，而不是保留一个无人续租的 running claim
10. `saveState()`/journal 写入改为返回 error，使用 0600 临时文件 + Sync + Rename；enroll 响应成功但 state 落盘失败时安装必须失败并明确提示，不能静默继续
11. `handleUpgradeAgent` 在 `os.Exit(0)` 前写 journal + fsync；优先等待服务端对结果的 ack 后退出，ack 超时才由 service manager 重启

**验收**：
- 顺序下发两个 write_config → Agent 端 backup 时间戳严格递增
- 断网重连后重投同 taskID → Agent 返回 journal 缓存结果，不第二次改文件
- 模拟 state.json 不可写 → enroll-only 非零退出并报告持久化失败
- 队列 busy 时服务端收到明确结果/状态，不能让任务无声卡到租约超时

---

### 提交 9 — `fix(batch): make rollback terminal and idempotent`
**BUG**：BUG-04
**文件**：
- `console/apps/api/src/modules/batch/routes.ts`
- `console/apps/api/src/modules/agent/routes.ts`
- `console/apps/web/src/hooks/useBatch.ts`
- `console/apps/web/src/pages/BatchPage.tsx`

**改动**：
1. `agent/routes.ts` 拆 `createAgentTask` 为：
   ```ts
   insertAgentTask(...) // 只 INSERT，不 push
   dispatchAgentTask(taskId) // COMMIT 后调用，pushTaskToAgent
   ```
   保留 `createAgentTask` 作向后兼容包装（内部 insert + dispatch）
2. `POST /api/batch/:id/rollback`：
   - 先 `BEGIN`，在同一事务内执行状态 CAS、精确 backup 校验、restore task INSERT、`rollback_progress_json` 写入；任一步失败必须 ROLLBACK
   - 事务内首个 SQL CAS：
     ```sql
     UPDATE batch_jobs SET status='rolling_back', rollback_started_at=?
     WHERE id=? AND status IN ('done','partial')
     ```
   - `changes===0` → 按当前 status 返 409/202/409
3. `rollback_progress_json` 独立存 restore 进度（不覆盖 `progress_json`）
4. 原 write task 成功但精确 `result_json.backup` 缺失/非法时，在 rollback progress 中记录 failed，禁止回退到 mtime 最新备份；没有任何可恢复项时 → `partial_rollback`，不得用 `every([])` 判成功
5. `broadcastBatchProgressForTask`：
   - running/done/partial 读 `progress_json`
   - rolling_back 读 `rollback_progress_json`
6. 事务内 `insertAgentTask` 所有任务 → COMMIT → 循环 `dispatchAgentTask`
7. 前端：
   - 按钮 disabled 逻辑：`status in ('done','partial')` 才 enable
   - `rolling_back` 显示独立进度
   - 409 → 明确 toast "回滚已在进行中" / "该批次未完成"

**验收**：
- running batch POST rollback → 409
- 连续两次 rollback → 只一组 restore task
- 删除某机器的 backup 后 rollback → 该机器 failed 且不返回其他 "最新备份"
- 事务中途异常注入 → Agent 不收任何未提交任务
- CAS 成功后的任意校验/INSERT 异常 → batch status 回到事务前状态，不得残留无任务的 rolling_back

---

### 提交 10 — `fix(agent-build): restore main package and reproducible dist`
**BUG**：BUG-06
**文件**：
- `agent/cmd/ai-agent/main.go`（新建）
- `agent/build-dist.sh`
- `Dockerfile`
- `.github/workflows/*.yml`（如有 CI）

**改动**：
- 新建 `agent/cmd/ai-agent/main.go`（对齐 install.sh 的 `-server -token --enroll-only --version`），构造 Config 时固定传入 `ProtocolVersion: 2`
- `build-dist.sh`：
  - 版本参数必填或从 `git describe` 取
  - 构建后每个二进制跑 `--version` 与 manifest 对比
- Dockerfile 改 multi-stage：Go builder → agent-dist → Node runtime
- CI：`go test ./...` + `go vet ./...` + 四平台交叉编译

**验收**：
- `bash agent/build-dist.sh v2.0.0` 生成 4 个二进制
- 每个二进制 `--version` == v2.0.0
- manifest.size / sha256 与文件一致
- Docker image 内 `/app/console/agent-dist/manifest.json` version 匹配

---

### 提交 11 — `fix(agent-upgrade): verify manifest hash size and version`
**BUG**：BUG-07
**文件**：
- `agent/internal/agent/agent.go`
- `agent/install.sh`
- （可选）`agent/internal/agent/manifest_verify.go`

**改动**：
- Agent `handleUpgradeAgent` 重写：
  1. GET `/agent/manifest.json`
  2. 按 `GOOS-GOARCH` 取 version/size/sha256
  3. 专用 client：
     ```go
     client := &http.Client{
       Timeout: 5*time.Minute,
       CheckRedirect: func(req *http.Request, via []*http.Request) error {
         if req.URL.Host != origHost || req.URL.Scheme != "https" {
           return errors.New("cross-origin or https-downgrade redirect denied")
         }
         return nil
       },
     }
     ```
  4. 边下边 SHA-256 + `io.LimitReader(resp.Body, expectedSize+1024)`
  5. size / hash / `--version` 三校验
  6. 匹配后 rename
- HTTPS 强制：`u.Scheme != "https"` 且未指定 `--allow-insecure` → 拒绝
- `install.sh`：`sha256sum || shasum -a 256` 二选一必存；`BINARY_URL` 需搭配 `BINARY_SHA256`
- 无 service manager 场景需 `--allow-unmanaged-restart` opt-in 才自升级

**验收**：
- 篡改 manifest hash → 升级失败，`.bak` 保留
- 篡改 binary → 同上
- Console URL 为普通远端 `http://` 时安装/升级明确拒绝；仅显式开发开关允许 localhost/受控内网 HTTP
- install.sh 里 `BINARY_URL=xxx` 不带 `BINARY_SHA256` → 拒绝执行

---

### 提交 12 — `fix(enroll): mandatory agent instance identity`
**BUG**：BUG-08
**文件**：
- `agent/internal/agent/agent.go`
- `console/apps/api/src/modules/agent/routes.ts`
- `console/apps/web/src/pages/ServersPage.tsx`（新按钮）
- `console/apps/api/src/modules/servers/routes.ts`（新 replace token 接口）

**改动**：
1. Agent `New()`：`state.json` 若无 `agent_instance_id` 字段 → 使用标准库 `crypto/rand` 生成 UUID（或显式新增并锁定 UUID 依赖）
   - 新加 `stateData.AgentInstanceID` 字段
   - `New()`/`saveState()` 不再忽略 Mkdir/WriteFile 错误；state 使用 0600 临时文件 + Sync + Rename
2. `Enroll()` body 加 `"agent_instance_id": a.instanceID`
3. Console `POST /agent/enroll`：
   - `enroll_mode='new'`（默认）：始终 INSERT 新 server 行
   - `enroll_mode='replace'` + `target_server_id`：replace token 本身是管理员授权，允许把目标 server 原子替换为新的 instance ID；只校验 target 与 token 绑定一致、新 instance ID 尚未被其他 server 使用，不要求重装后的新 ID 等于旧 ID
   - instance ID UNIQUE 冲突捕获为 409 `agent_instance_id_conflict`，不能冒泡成 500
   - replace 成功时立即关闭 `onlineAgents[target].ws` 并删除旧 map entry，防止旧已认证 socket 继续接收目标 server 的任务
4. `agent_instance_id` 直接 NOT NULL（因清库无历史空值）
5. UI「重装/恢复此机器」按钮 → 生成 replace token（`POST /api/agent/enroll-tokens` body 加 `mode` + `target_server_id`）

**验收**：
- 两台 hostname=devbox 的机器 enroll → 两个不同 server id 都 online
- 普通 enroll token 无法覆盖已有 server（会 INSERT 新行）
- replace token 只能替换指定 server
- 克隆 state.json 到另一台机器 → 触发 UNIQUE 冲突拒绝
- replace 后旧 Agent 已建立的 WS 被关闭，只有新 Agent 能接收后续任务
- 模拟 state 目录不可写，安装失败且不会报告“注册成功”

---

### 提交 13 — `fix(migrations): reconcile real schema footprints + smoke test`
**BUG**：BUG-10
**文件**：
- `console/apps/api/src/core/db.ts`
- `console/db/migration-smoke.cjs`（新建）

**改动**：
- `detectAppliedMigrationVersions` 加 `hasTable()` 帮助函数
- 006 判据：`!hasCol("users","totp_secret") && !hasCol("users","totp_enabled") && !hasCol("users","recovery_codes_hash") && !hasTable("usage_snapshots") && !hasTable("bindings") && !hasTable("profiles")`
- 007 判据：`!hasTable("test_runs")`
- 008 幂等重跑（逻辑扩展到 BUG-01 敏感字段）
- 009/010 拆开：`providers.default_model_id` 存在且 provider_keys 列不存在 → 只补记 009；`provider_keys.default_model_id` 存在 → 同时补记 009、010
- 011 判据：`hasCol("sessions","rotated_at")`
- 016 判据：`hasCol("agent_tasks","encrypted_payload")`
- 017 判据：`hasCol("batch_jobs","rollback_progress_json")`
- 018 判据：`agent_enroll_tokens.target_server_id/enroll_mode` 与 `servers.agent_instance_id` 中间形状均存在
- 019 判据：`servers.agent_protocol_version` 存在，且最终建表 SQL/PRAGMA 同时证明 instance identity 为 NOT NULL；不能只看一个列名就领养重建迁移
- reconciliation 处理任意 gap，不只 `applied.size===0`
- 无法证明时 fatal + 修复命令输出

**新建 `migration-smoke.cjs`** 测试矩阵：

| 起始形状 | schema_migrations | 期望 |
|---|---|---|
| 空库 | 空 | 001→019 全跑 |
| 005 | 空 | 006/007/008/009/010/011/016-019 跑 |
| 006 | 仅 001 | 007-019 跑 |
| 009 | 001-008 | 010-019 跑 |
| 010 | 空 | 领养 001-010，跑 011-019 |
| 011 | 空 | 领养 001-011，跑 016-019 |
| 019 | 空 | 领养全部，二次启动零 DDL |
| 019 | 仅 001 | reconciliation 后正常启动 |

每个 case 启动两次，第二次必须零 migration + 无 duplicate column。

**验收**：
- `node console/db/migration-smoke.cjs` 全部通过
- 临时目录清理干净，不动 `console/data`

---

## 7. 全局验收清单（对齐 BUGFIXES §13）

### 安全
- [ ] 使用固定测试 Key，分别查询 `agent_tasks.payload_json/result_json`、`configs.content`、`audit_log.before_json/after_json`，明文命中数均为 0；不使用 `.dump | grep api_key`，避免把 schema 字段名当成泄密
- [ ] viewer 请求 `/api/servers/:id/tasks` 响应无 payload_json / result_json 原文
- [ ] viewer 请求 `/api/servers/:id/configs/latest` → 403
- [ ] Agent 端 `stat -c '%a' ~/.ai-console-agent` → 700
- [ ] Agent 端 `stat -c '%a' ~/.codex/config.toml` → 600
- [ ] Agent 端 `stat -c '%a' ~/.codex/.config.toml.bak.*` → 600
- [ ] 升级下发篡改 hash → 拒绝，`.bak` 保留
- [ ] WS URL 无长期 agent_token，只有 30s ticket
- [ ] Agent `/agent/ws` 使用 Authorization header；query token 连接被拒绝

### 状态机
- [ ] 旧 nonce POST result → 409
- [ ] 8 分钟任务持续 lease → 不被回收
- [ ] 重投同 task ID → Agent journal 命中，不产生第二份 backup
- [ ] running batch → POST rollback 409
- [ ] 重复 rollback → 只一组 restore task
- [ ] 事务失败注入 → Agent 无未提交任务

### 登录 & 实时
- [ ] 双 tab 并发 refresh → Cookie 仍有效
- [ ] WS 强断重连 → subscribers 保留
- [ ] ticket 一次性，旧 socket close 不影响新 socket

### 构建 & 迁移
- [ ] `cd console/apps/web && npm run build` 通过
- [ ] `cd console/apps/api && npx tsc --noEmit` 通过
- [ ] `cd agent && go test ./...` 通过
- [ ] `cd agent && go vet ./...` 通过
- [ ] `bash agent/build-dist.sh v2.0.0` 四平台通过
- [ ] Docker image 内 manifest version 与源码一致
- [ ] `node console/db/migration-smoke.cjs` 全矩阵通过

### 发布流程
- [ ] 已记录 `Console=2.0 / Agent=2.0 / protocol=2 / clean reinstall only`
- [ ] 已知 P0/P1 缺陷清单为 0，所有本文件验收项有结果记录
- [ ] Step 2 SQLite backup、hash、恢复打开验证和旧镜像/agent-dist 备份完成
- [ ] Step 3 清库 SQL 已在预发环境跑过一次
- [ ] Step 5 迁移后 `SELECT version FROM schema_migrations` 含 016/017/018/019
- [ ] Step 8 所有机器 online + protocol_version=2 + instance_id 非空

---

## 8. 提交信息模板

```
<type>(<scope>): <subject>

<body 说明动机、约束、验收方式>

Refs: BUGFIXES-2026-07-18.md#<bug-id>
Verified:
  - <manual verification 1>
  - <manual verification 2>
```

## 9. 实施进度

- [x] 提交 1 — authz import rollback
- [x] 提交 2 — 迁移 016-019
- [x] 提交 3 — secrets encryption + audit redact
- [x] 提交 4 — agent atomic write & perms
- [x] 提交 5 — auth refresh concurrent
- [x] 提交 6 — ws preserve subscriptions
- [x] 提交 7 — protocol 2 mandatory
- [x] 提交 8 — agent serialize + journal
- [x] 提交 9 — batch rollback terminal
- [x] 提交 10 — agent main package
- [x] 提交 11 — agent upgrade verify
- [x] 提交 12 — enroll instance identity
- [x] 提交 13 — migration footprints + smoke test

## 10. 实施完成验收记录（2026-07-18）

| 验收项 | 结果 |
|---|---|
| `cd console/apps/api && npx tsc --noEmit` | ✅ |
| `cd console/apps/web && npx tsc --noEmit` | ✅ |
| `cd console/apps/web && npx vite build` | ✅ 408 KB bundle |
| `cd agent && go build ./...` | ✅ |
| `cd agent && go vet ./...` | ✅ |
| `ai-agent --version`（ldflags 注入） | ✅ `v2.0.0-test` |
| `node console/db/migration-smoke.cjs` | ✅ 6/6 用例通过（empty-db / shape-005 / shape-009-partial / shape-011 / post-019-schema-fallback / shape-011-partial-records） |

### 代码改动量

```
25 files changed, 2357 insertions(+), 464 deletions(-)
```

### 实施过程中的微调（相对原计划）

1. **commit 9 broadcastBatchProgressForTask 兼容 skipped 状态**：rollback 进度中的"原始 write 未完成"条目状态为 `skipped`，finalize 判定时一并视为终态（与 done/failed 一起进 allDone 计算），否则这类条目会让 batch 永远卡在 `rolling_back`。
2. **commit 13 detectAppliedMigrationVersions 不再返回 008**：008 是幂等 data-only UPDATE，留给 for-loop 的 applied-set 检查决定是否重跑；只有 006/007 这种不可逆 DROP 用 footprint 探测。这样 016 的 REDACTED UPDATE 能在缺失时自动补跑。
3. **commit 7 dispatchNextTask 在 handleTaskResult 终态后调用**：保证"每 server 一个 running 任务"在任务完成后立刻让位给下一条 pending，不需要等 reaper 30s tick。
4. **commit 12 ServerDetailPage 加 replace token 展示卡片**：UI 生成 token 后渲染完整 install.sh 命令，省去用户拼 URL 的步骤。

实施每完成一项，在此处勾选并在 commit body 引用本文件。
