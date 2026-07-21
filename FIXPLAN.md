# FIXPLAN — BUGFIXES.md 剩余 27 条的具体修复方案

> 复核：2026-07-18 对**当前代码**的 8 路并行 verifier + 1 路对抗式 critic（均已读真实代码，494k tokens / 129 次工具调用）。
> 结论：**27 条全部经复核仍存在**。BUGFIXES.md 的行号是旧快照——本方案的行号已按当前代码校准，**以函数/符号名为准**。
> 本方案在 BUGFIXES.md 基础上做了若干**关键修正**（每条标 ⚠️ ，文末「critic 修正汇总」集中列出）。高危 3 条已在工作树修复，不在本方案范围。

## 0. 总览

### 0.1 验证结果

| ID | 区域 | 当前位置（函数） | 迁移 | 依赖 |
|---|---|---|---|---|
| 1 | batch 回滚 | `batch/routes.ts` rollback 循环 | — | 2,3,4,5,6 |
| 2 | batch 回滚 | `batch/routes.ts:258` + `agent/routes.ts` broadcast | — | 1,3,4,5,6 |
| 3 | batch 回滚 | `batch/routes.ts:253` skip | — | 2 |
| 4 | batch 回滚 | `batch/routes.ts:225` + `agent/routes.ts:136` allDone | — | = bug5 reaper |
| 5 | 任务生命周期 | `server.ts` 缺 reaper；`agent/routes.ts` pushTaskToAgent/GET tasks | — | 6,4 |
| 6 | 任务生命周期 | `agent/routes.ts` handleTaskResult L65-94 | — | 5 |
| 7 | 配置生成 | `core/config.ts` generateConfig codex raw 分支 | — | — |
| 8 | 配置生成 | `core/config.ts` mergeOpenCodeConfig L308-326 | — | — |
| 9 | 认证启动 | `auth/routes.ts` rotateSession L48-74 | **011** | 11 |
| 10 | 认证启动 | `core/db.ts` productionCheck L17-29 | — | — |
| 11 | 认证启动 | `core/db.ts` runMigrations adopt-legacy L57-70 | — | 9 |
| 12 | 认证启动 | `server.ts` SPA fallback L76-85 | — | — |
| 13 | Go agent | `agent.go` credFile L438 | — | 26 |
| 14 | Go agent | `agent.go` handleSetCred L471 | — | — |
| 15 | Go agent | `agent.go` wsWriteText L400-404 | — | — |
| 16 | Go agent | `agent.go` handleWriteConfig L574 + handleRestoreBackup L662 | — | 24 |
| 17 | Go agent | `agent.go` handleUpgradeTool L734-742 | — | — |
| 18 | DB/数据 | `console/db/verify.cjs` L5-6 | — | — |
| 19 | DB/数据 | `providers/routes.ts:98,175-190` + `import-jobs/routes.ts:68` | — | — |
| 20 | 前端 | `lib/auth.tsx` AuthProvider L18-41 | — | — |
| 21 | 前端 | `lib/ws.ts:20` + `agent/routes.ts:585` | — | — |
| 22 | 前端 | `App.tsx:17` + `ServerDetailPage.tsx` | — | — |
| 23 | 低危 | `audit/routes.ts:44` + `import-jobs/routes.ts:9` | — | — |
| 24 | 低危 | `agent.go` backupFilePath L584-589 | — | 16 |
| 25 | 低危 | `agent.go` handleCmdWS L372-376 | — | — |
| 26 | 低危 | `agent.go` handleRemoveCred L518-523 | — | 13 |

### 0.2 与 BUGFIXES.md 的关键差异（必读）

critic 复核后发现 BUGFIXES.md 原文有以下需修正/补充，**实现时以本节为准**：

1. **回滚组实为 1+2+3+4+5+6 原子落地**，不是 1-4。bug 4 的 reaper 就是 bug 5 的 reaper；bug 6 的状态守卫是 bug 1 读 `result_json.backup` 的前提。落地顺序：5 → 6 → 1/2/3/4。
2. **bug 5 reaper 必须同时给 REST 认领路径补 `expires_at`**。`GET /agent/tasks`（`agent/routes.ts:476`）只写 `claimed_at` 不写 `expires_at`（NULL），reaper 的 `WHERE expires_at < ?` 匹配不到 NULL → REST 认领的任务永远不被回收。必须同批改。
3. **bug 6 不得校验 nonce**。BUGFIXES 写「可选：校验 nonce」——若开启，所有 REST 认领（nonce 为 NULL）的结果都会被拒。只用 `WHERE status='running'` 的 CAS 即可。
4. **bug 2 需要三处联动，不只一处**：导出 `broadcastBatchProgressForTask` + 其 SELECT 加 `'rolling_back'`（`agent/routes.ts:127`）+ 其 finalize 门槛放开（`agent/routes.ts:137`）；**且 `GET /api/batch/:id`（`batch/routes.ts:226`）自己的 allDone 块也要同步放开**，否则只有 10s 轮询兜底。
5. **bug 9 的 `BEGIN IMMEDIATE` 是死代码**。node:sqlite 同步 + Node 单线程，rotateSession 内无 await，天然串行。真正起作用的是 `rotated_at` + 30s 宽限窗。事务保留无害但别误以为它防 DoS。
6. **bug 11 必须与 bug 9 同批或更早**。给一个旧 schema.sql-fallback 库先加 011 再修 adopt-legacy，会在 002（duplicate column）boot-loop。bug 11 是纯代码改 db.ts，不新增迁移。
7. **⚠️ bug 21 ws-ticket 端点路径是个安全陷阱**。`/api/auth/*` 在 `middleware/auth.ts:23` 是**公开例外**（不走全局 JWT 钩子）。若把 `POST /api/auth/ws-ticket` 放在这里又只靠全局钩子，则**任何人可匿名领票**。必须二选一：(a) 放到 `/api/ws-ticket`（全局钩子会 JWT 校验）；或 (b) 留在 `/api/auth/ws-ticket` 但**在 handler 内显式调 `authFromRequest(req)`**（仿 `/api/auth/me`）。本方案采用 (b) 并显式标注。
8. **bug 16 行号漂移**：`handleRestoreBackup` 的备份写入当前在 **L662**（BUGFIXES 写 L653）。按符号定位，勿按行号。
9. **bug 8 原文在配置区域被漏报**（verifier 只回了 bug 7）。已补全，见 §2.7。
10. **bug 1 残留窗口**：bug 6 保证每个任务行只落一次 result，但不保证 agent 端只执行一次。若 reaper 在 agent 已写 V1（备份了 V0）但其 result 未落地时回收任务，重执行会备份 V1 而非 V0，回滚会还原 V1。5min expires_at + 在线服务器豁免使其罕见，记录在案，不需代码改动。

---

## 1. 迁移与 DB 形状（最先做）

### 1.1 新迁移 `011_sessions_rotated_at.sql`（bug 9 依赖）

**新文件** `console/db/migrations/011_sessions_rotated_at.sql`：
```sql
-- 011_sessions_rotated_at.sql
-- 记录 refresh-token 最近一次轮换时间。rotateSession() 据此容忍并发同 cookie
-- 轮换：竞争落败方看到 hash 不匹配但 rotated_at<30s，抑制误判 replay-撤销，
-- 避免把合法用户登出。
ALTER TABLE sessions ADD COLUMN rotated_at INTEGER;
```

**同步改** `console/db/schema.sql` 的 sessions 表（CLAUDE.md「新 schema 需 NNN + schema.sql 双改」），加为最后一列：
```sql
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash TEXT NOT NULL,
  user_agent TEXT, ip TEXT,
  last_active_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  rotated_at INTEGER          -- NEW
);
```

### 1.2 `core/db.ts` adopt-legacy 修复（bug 11，纯代码，与 1.1 同批）

**问题**：`runMigrations` 的「领养已有库」分支（`schema_migrations` 空 + 有表）只标 `001_baseline` applied，然后重放 002+；而 `schema.sql` fallback 产出的是 post-010 库 → 重放 `002 ALTER audit_log ADD request_id` → `duplicate column` → ROLLBACK+throw → `server.ts:34` 同步调用处抛出 → 进程退出 → boot-loop。

**修复**：用列存在性探测真实版本，把所有已反映的迁移标记为 applied（INSERT OR IGNORE）。
```ts
// console/apps/api/src/core/db.ts —— 替换 adopt-legacy 块（L57-70 附近）
function detectAppliedMigrationVersions(): string[] {
  const hasCol = (table: string, col: string): boolean => {
    try {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
      return cols.some((c) => c.name === col)
    } catch { return false }
  }
  const out: string[] = ["001"]
  if (!hasCol("audit_log", "request_id")) return out
  out.push("002")
  if (!hasCol("users", "password_algo")) return out
  out.push("003")
  if (!hasCol("agent_tasks", "nonce")) return out
  out.push("004")
  if (!hasCol("servers", "agent_version")) return out
  out.push("005")
  // 006(DROP totp)/007(DROP test_runs)/008(data-only)：无正向可探测的新增列，
  // schema.sql fallback 库必为 post-010，必已含这些，按存在推断。
  out.push("006", "007", "008")
  // 009(在 providers 上加后删 default_model_id)/010(落在 provider_keys)：
  // provider_keys.default_model_id 存在 ⇒ 009 与 010 都已应用。
  if (hasCol("provider_keys", "default_model_id")) out.push("009", "010")
  // 011(sessions.rotated_at) 必须探测，否则清空 schema_migrations 的 post-011
  // 库会被误判到 010，重放 011 → duplicate column: rotated_at → boot-loop。
  if (hasCol("sessions", "rotated_at")) out.push("011")
  return out
}
// ...在 `if (applied.size === 0) { ... if (tables.length > 0) { ... } }` 里：
      const prefixes = detectAppliedMigrationVersions()
      // 关键：detect 返回数字前缀（"001"），但 schema_migrations 与下方 for-loop
      // 用完整文件名（"001_baseline"），必须按前缀映射回完整版本，否则 applied
      // 不命中、照样重放 001/002 → duplicate column（验证阶段实测踩到）。
      const prefixToFull = new Map<string, string>()
      for (const f of files) { const v = f.replace(".sql", ""); prefixToFull.set(v.slice(0, 3), v) }
      const now = Date.now()
      const ins = db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(?, ?)")
      for (const prefix of prefixes) {
        const full = prefixToFull.get(prefix)
        if (!full) continue
        ins.run(full, now); applied.add(full)
      }
      log.info(`detected existing schema (${tables.length} tables) at migration ${high}, marked ${marked} applied`)
```
**注意**：此修复**只防新 boot-loop**，不修复已经在 002 boot-loop 的库（那种库 `schema_migrations` 里已有 `001` 但卡住）——已坏库仍需手动补 `schema_migrations` 或清库。验证阶段实测确认：清空 schema_migrations 的 post-011 库，重启后正确识别到 `011_sessions_rotated_at`、零重放、正常启动。

---

## 2. 叶子后端修复（互不依赖，可并行）

### 2.1 bug 7 — codex TOML raw 分支不设顶层 `model_provider`

**位置**：`core/config.ts` generateConfig codex `raw?.config` 分支（`if (/requires_openai_auth\s*=/i.test(toml))` 的 else）。
**问题**：fallback 追加 `[model_providers.<providerId>] ... base_url=... requires_openai_auth=true`，但从不写/改顶层 `model_provider` → codex 用内置 provider，自定义 base_url 与 `~/.codex/auth.json` 的 key 都失效。对比 no-raw 分支显式写了 `model_provider`。
```ts
// 在追加 fallback 段落之后补：
    toml += `\n\n[model_providers.${providerId}]\nname = "${providerLabel}"\nbase_url = "${openAiBaseUrl}"\nwire_api = "responses"\nrequires_openai_auth = true`
    // ponytail: 追加的段只有顶层 model_provider 指向它才生效，否则 codex 用内置
    // provider，base_url 失效、key 打到错误端点。对齐 no-raw 分支。
    if (mpIdMatch) {
      toml = toml.replace(/^[ \t]*model_provider[ \t]*=[ \t]*["'][^"']*["']/m, `model_provider = "${providerId}"`)
    } else {
      toml = `model_provider = "${providerId}"\n` + toml
    }
```
**注意**：不动 codex key 拆分不变式——config.toml 仍不含 key / experimental_bearer_token。

### 2.2 bug 10 — productionCheck 只在 `NODE_ENV==="production"` 精确匹配时跑

**位置**：`core/db.ts` productionCheck L17-29。`if (process.env.NODE_ENV !== "production") return` 让 undefined/staging/development 跳过全部检查。
```ts
// console/apps/api/src/core/db.ts —— 替换 productionCheck
export function productionCheck(log: FastifyInstance["log"]) {
  const nodeEnv = process.env.NODE_ENV
  const isProd = nodeEnv === "production"
  const isDev = nodeEnv === "development"
  const derivedJwtSecret = createHash("sha256").update((process.env.MASTER_KEY || "") + ":jwt").digest("hex")
  const defaults: [string, string | undefined, string, string[]][] = [
    ["MASTER_KEY", process.env.MASTER_KEY, "ai-console-dev-master-key-change-me", ["change-me-to-a-random-64-char-string"]],
    ["JWT_SECRET", process.env.JWT_SECRET, derivedJwtSecret, ["change-me-to-another-random-64-char-string"]],
    ["BOOTSTRAP_ADMIN_PASS", process.env.BOOTSTRAP_ADMIN_PASS, "admin", []],
  ]
  const isDefault = (a: string | undefined, f: string, ph: string[]) => !a || a === f || ph.includes(a)
  for (const [name, actual, forbidden, placeholders] of defaults) {
    if (!isDefault(actual, forbidden, placeholders)) continue
    if (isProd) { log.fatal(`FATAL: ${name} must be set in production and must not be the default`); process.exit(1) }
    else if (!isDev) log.warn(`${name} is using a default/dev value — set a strong unique value before exposing (NODE_ENV=${nodeEnv || "unset"})`)
  }
}
```
**注意**：`development` 仍静默 wide-open（保留 CLAUDE.md 不变式）；`production` 仍硬退出；只对 undefined/staging/typo 加 warn。

### 2.3 bug 12 — SPA fallback startsWith 无分隔符边界

**位置**：`server.ts` SPA fallback L76-85（脆弱行 L81）。`/%2e%2e/dist.bak/...` 解码后 `filePath = .../web/dist.bak/...` 通过 `startsWith(.../web/dist)` → 泄漏同级 `dist.bak`/`dist.old`/`dist2`。
```ts
// 用 path.relative 做规范的路径围栏检查（跨平台）
const relToDist = path.relative(WEB_DIST_PATH, filePath)
const within = relToDist !== "" && !relToDist.startsWith("..") && !path.isAbsolute(relToDist)
const target = within && fs.existsSync(filePath) ? filePath : path.join(WEB_DIST_PATH, "index.html")
```

### 2.4 bug 23 — 非数字 limit/offset → NaN → 500

**位置**：`audit/routes.ts:44`、`import-jobs/routes.ts:9`。
```ts
// audit/routes.ts
const limit = Math.min(Math.max(1, parseInt(String(q?.limit ?? "100"), 10) || 100), 500)
const offset = Math.max(0, parseInt(String(q?.offset ?? "0"), 10) || 0)
// import-jobs/routes.ts（上限 200，默认 50）
const limit = Math.min(Math.max(1, parseInt(String(q?.limit ?? "50"), 10) || 50), 200)
const offset = Math.max(0, parseInt(String(q?.offset ?? "0"), 10) || 0)
```

### 2.5 bug 18 — verify.cjs 硬编码路径 + readOnly

**位置**：`console/db/verify.cjs:5-6`。路径缺 `MyProject`，`readOnly:true` 使文件缺失时直接抛。
```js
// console/db/verify.cjs —— 替换顶部 1-6 行
const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');                       // NEW
const KEY = crypto.createHash('sha256').update(process.env.MASTER_KEY || 'ai-console-dev-master-key-change-me').digest();
const dbPath   = path.join(__dirname, '..', 'data', 'ai-console.db');
const seedPath = path.join(__dirname, '..', '..', 'seed', 'cc-switch-import.json');
if (!fs.existsSync(dbPath))   { console.error(`DB not found: ${dbPath}\n  Run \`node console/db/seed.cjs\` first.`); process.exit(1) }
if (!fs.existsSync(seedPath)) { console.error(`Seed JSON not found: ${seedPath}\n  (seed/ gitignored — obtain separately.)`); process.exit(1) }
const db   = new DatabaseSync(dbPath);              // 去掉 readOnly
const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
```

### 2.6 bug 19 — import 回滚不删 model_pricing 且谎报已清理

**位置**：导入侧 `providers/routes.ts:98,175-190`；回滚侧 `import-jobs/routes.ts:68-70`。
```ts
// providers/routes.ts —— 扩展 createdIds（:98）
const createdIds = {
  provider_ids: [] as string[], key_ids: [] as string[], model_ids: [] as string[], endpoint_ids: [] as number[],
  pricing_count: 0,
  pricing_model_ids: [] as string[],                       // NEW：本次写入的 model_id
  pricing_overwritten: [] as any[],                        // NEW：被 INSERT OR REPLACE 覆盖的旧行快照
}
// :175-190 写入循环：首次触及某 model_id 时先快照原值
const seenPricingModelIds = new Set<string>()
for (const m of input.model_pricing || []) {
  if (!m?.model_id) continue
  const mid = String(m.model_id)
  if (!seenPricingModelIds.has(mid)) {
    seenPricingModelIds.add(mid)
    const prev = db.prepare("SELECT model_id,display_name,input_cost_per_million,output_cost_per_million,cache_read_cost_per_million,cache_creation_cost_per_million FROM model_pricing WHERE model_id=?").get(mid) as any
    if (prev) createdIds.pricing_overwritten.push(prev)
  }
  db.prepare(`INSERT OR REPLACE INTO model_pricing(model_id,display_name,input_cost_per_million,output_cost_per_million,cache_read_cost_per_million,cache_creation_cost_per_million) VALUES(?,?,?,?,?,?)`)
    .run(mid, String(m.display_name||m.model_id), String(m.input_cost_per_million||"0"), String(m.output_cost_per_million||"0"), String(m.cache_read_cost_per_million||"0"), String(m.cache_creation_cost_per_million||"0"))
  createdIds.pricing_model_ids.push(mid)
  counts.pricing++
}
createdIds.pricing_count = counts.pricing

// import-jobs/routes.ts —— :37 加宽 cleaned 类型；:68-70 真删 + 尽力恢复
const cleaned: { providers:number; keys:number; models:number; endpoints:number; pricing:number; pricing_restored:number } =
  { providers:0, keys:0, models:0, endpoints:0, pricing:0, pricing_restored:0 }
// ...
let pricingDeleted = 0
if (Array.isArray(ids.pricing_model_ids) && ids.pricing_model_ids.length) {
  const ph = ids.pricing_model_ids.map(()=>"?").join(",")
  pricingDeleted = Number(db.prepare(`DELETE FROM model_pricing WHERE model_id IN (${ph})`).run(...ids.pricing_model_ids).changes)
}
if (Array.isArray(ids.pricing_overwritten) && ids.pricing_overwritten.length) {
  const restore = db.prepare(`INSERT OR REPLACE INTO model_pricing(model_id,display_name,input_cost_per_million,output_cost_per_million,cache_read_cost_per_million,cache_creation_cost_per_million) VALUES(?,?,?,?,?,?)`)
  for (const p of ids.pricing_overwritten) {
    restore.run(p.model_id, p.display_name, p.input_cost_per_million, p.output_cost_per_million, p.cache_read_cost_per_million||"0", p.cache_creation_cost_per_million||"0")
    cleaned.pricing_restored++
  }
}
cleaned.pricing = pricingDeleted - cleaned.pricing_restored   // 诚实净值
```
**注意**：旧 job 的 counts_json 无 `pricing_model_ids` → 回滚跳过 DELETE、报 `pricing=0`（诚实，不再是谎报的 N）。无需迁移（counts_json 是自由 TEXT JSON）。

### 2.7 bug 8 — mergeOpenCodeConfig providerId 冲突：覆盖凭据且 config.model 指向错误 provider

**位置**：`core/config.ts` mergeOpenCodeConfig L308-326（已复核当前代码）。
**问题**：`Object.assign(config.provider, single.provider)` 按 providerId 覆盖；两个 entry 派生出相同 providerId（同名同 group）时，第二个的 apiKey/baseURL/models 覆盖第一个，但 `config.model = first.providerId/first.model` 不变 → 默认模型解析到第二个 provider 的凭据，第一个凭据静默丢失。providerId 由 `provider_name+group_name` 派生（非 DB UUID）。
```ts
// console/apps/api/src/core/config.ts —— mergeOpenCodeConfig
export function mergeOpenCodeConfig(entries: { providerId:string; providerLabel:string; openAiBaseUrl:string; apiKey:string; model:string; models?:string[]; apiFormat?:string|null }[]): any {
  const config: any = { provider: {} }
  const seen = new Set<string>()
  for (const entry of entries) {
    // bug 8: providerId 派生自 provider_name+group_name（非 DB UUID），同名同组
    // 必撞；Object.assign 会用第二个覆盖第一个的凭据，而 config.model 仍指向
    // 第一个 providerId。去重加后缀，让两者都存活。
    let pid = entry.providerId
    let n = 2
    while (seen.has(pid)) pid = `${entry.providerId}-${n++}`
    seen.add(pid)
    const single = buildOpenCodeConfig({ ...entry, providerId: pid })
    Object.assign(config.provider, single.provider)
  }
  const first = entries[0]
  config.model = first ? `${first.providerId}/${first.model}` : ""   // first 总是未加后缀的存活者
  if (!config.$schema) config.$schema = "https://opencode.ai/config.json"
  if (!config.agent) config.agent = { build: { options: { store: false } }, plan: { options: { store: false } } }
  return config
}
```
**注意**：`first`（entries[0]）总是先处理、占未加后缀的名，故 `config.model` 指向存活 provider，正确。建议 UI 侧（选 key 阶段）额外禁止同名同 group 多选，避免用户困惑——非阻塞，代码去重已保证不丢数据。

---

## 3. 会话轮换（bug 9，依赖步骤 1）

**位置**：`auth/routes.ts` rotateSession L48-74。
**修复**：用 `rotated_at` + 30s 宽限窗容忍并发同 cookie 轮换；rotate 时写 `rotated_at=now`。（`BEGIN IMMEDIATE` 可保留但单线程 Node 下是 no-op，见 §0.2-5。）
```ts
// auth/routes.ts —— 替换 rotateSession
function rotateSession(refreshToken: string, reply: any): { accessToken: string; user: AuthUser } | null {
  const [sessionId, secret] = refreshToken.split(".")
  if (!sessionId || !secret) return null
  const row = db.prepare(
    `SELECT s.id AS session_id, s.refresh_token_hash, s.revoked_at, s.rotated_at,
            u.id, u.username, u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=?`
  ).get(sessionId) as any
  if (!row || row.revoked_at) return null
  if (row.refresh_token_hash !== hashToken(secret)) {
    // 容忍「刚被本 session 的并发请求轮换」（<30s）：视为已轮换，不撤销
    if (row.rotated_at && Date.now() - row.rotated_at < 30_000) return null
    db.prepare("UPDATE sessions SET revoked_at=? WHERE id=?").run(Date.now(), sessionId)
    audit(row.id, "auth.replay_detected", `session:${sessionId}`)
    return null
  }
  const nextSecret = b64url(crypto.randomBytes(32))
  db.prepare("UPDATE sessions SET refresh_token_hash=?, rotated_at=?, last_active_at=? WHERE id=?")
    .run(hashToken(nextSecret), Date.now(), Date.now(), sessionId)
  setRefreshCookie(reply, `${sessionId}.${nextSecret}`, Date.now() + REFRESH_TTL_MS)
  return { accessToken: signJwt({ id: row.id, username: row.username, role: row.role as Role }), user: { id: row.id, username: row.username, role: row.role as Role } }
}
```

---

## 4. Agent 任务生命周期（bug 5 + bug 6，必须同批）

### 4.1 bug 5 — 任务卡 running 永不恢复；reaper；expires_at 写了从不读

**位置**：reaper 加在 `server.ts`（紧邻现有 30s 僵尸-agent 扫描 L66-73，勿改后者）；`agent/routes.ts` GET `/agent/tasks` 补 expires_at。
**修复**：
```ts
// server.ts —— 现有 sweeper 之后新增（同一个 30s tick 或独立 setInterval 均可）
// ponytail: reap stuck agent_tasks。pushTaskToAgent(WS) 与 GET /agent/tasks(REST)
// 认领时写 expires_at=now+5min（REST 路径需在 4.1b 补齐），但之前无人读 → agent
// 崩溃/被 kill/upgrade_agent 自重启(os.Exit) 后任务永远 running。回收过期 running
// 回 pending 让重连/轮询重新领取；长期 pending 且目标离线 → 判失败，让 batch 能
// finalize（bug 4）。每触及一个 task_id 广播一次，让 WS 侧 batch 状态机也跑起来。
setInterval(() => {
  const now = Date.now()
  const offlineCutoff = now - 10 * 60_000
  const requeued = db.prepare(
    `UPDATE agent_tasks SET status='pending', claimed_at=NULL, nonce=NULL, expires_at=NULL, attempt_count=attempt_count+1
     WHERE status='running' AND expires_at IS NOT NULL AND expires_at < ?`
  ).run(now)
  const failed = db.prepare(
    `UPDATE agent_tasks SET status='failed', error='target agent offline >10min', finished_at=?
     WHERE status='pending' AND created_at < ?
       AND server_id IN (SELECT id FROM servers WHERE status='offline' AND (last_seen IS NULL OR last_seen < ?))`
  ).run(now, offlineCutoff, offlineCutoff)
  if (requeued.changes || failed.changes) {
    for (const job of db.prepare("SELECT progress_json FROM batch_jobs WHERE status IN ('running','rolling_back')").all() as any[]) {
      let entries: any[] = []
      try { entries = JSON.parse(job.progress_json || "[]") } catch {}
      for (const e of entries) if (e.task_id) broadcastBatchProgressForTask(e.task_id)
    }
  }
}, 30_000)
```
**4.1b** ⚠️ REST 认领路径必须同批补 `expires_at`（否则 NULL 永不回收）：
```ts
// agent/routes.ts GET /agent/tasks 认领处（原 L476）
const claimNow = Date.now()
const claimed = db.prepare(
  "UPDATE agent_tasks SET status='running', claimed_at=?, nonce=?, expires_at=? WHERE id=? AND status='pending'"
).run(claimNow, crypto.randomUUID(), claimNow + 5*60*1000, task.id)
```
**4.1c** 导出 `broadcastBatchProgressForTask`（`agent/routes.ts:126` 把 `function` 改 `export function`），供 reaper 调用。

### 4.2 bug 6 — handleTaskResult 不校验状态/nonce，可重放

**位置**：`agent/routes.ts` handleTaskResult L65-94。
**修复**：SELECT/UPDATE 都加 `status='running'` 做 CAS；`changes===0` 即拒绝，**不插 configs**。⚠️ **不校验 nonce**（见 §0.2-3）。
```ts
const task = db.prepare("SELECT * FROM agent_tasks WHERE id=? AND server_id=? AND status='running'").get(taskId, serverId) as any
if (!task) return false
// ...
const res = db.prepare("UPDATE agent_tasks SET status=?, result_json=?, error=?, finished_at=? WHERE id=? AND status='running'")
  .run(ok ? "done" : "failed", result ? JSON.stringify(result) : null, ok ? null : String(body.error||"task failed"), now, task.id)
if (res.changes === 0) return false   // 已终态/被回收 —— 不插 configs
// 后续 configs INSERT / broadcast 逻辑不变
```
**注意**：REST 调用方（`/agent/tasks/:id/result`）已把 `false→404`，重放现在也走 404，正确。

---

## 5. 回滚组（bug 1+2+3+4，在步骤 4 之后，实为 1-6 原子）

> ⚠️ 必须在 §4 落地后再做。bug 4 由 §4.1 的 reaper 满足（单一实现，勿写两个）。

### 5.1 bug 1 — 回滚用本次写入产生的备份名（非 mtime 最新）

```ts
// batch/routes.ts rollback 循环，createAgentTask 之前
let backupName = ""
try {
  const writeTask = db.prepare("SELECT result_json FROM agent_tasks WHERE id=?").get(p.task_id) as any
  if (writeTask?.result_json) backupName = String(JSON.parse(writeTask.result_json).backup ?? "")
} catch {}
const restoreTask = createAgentTask(p.server_id, user.id, "restore_config_backup", { tool: job.tool, backup: backupName })
```

### 5.2 bug 3 — 回滚取消 pending 的 write_config

```ts
// batch/routes.ts rollback 循环（原 `if (task?.status !== "done") continue`）
const task = db.prepare("SELECT status FROM agent_tasks WHERE id=?").get(p.task_id) as any
if (task?.status !== "done") {
  if (task?.status === "pending") {
    db.prepare("UPDATE agent_tasks SET status='failed', error='cancelled by batch rollback', finished_at=? WHERE id=? AND status='pending'")
      .run(Date.now(), p.task_id)
    broadcastEvent(`server:${p.server_id}:tasks`, { task_id: p.task_id, status: "failed" })
  }
  continue   // running 的在途任务由 reaper 解决
}
```

### 5.3 bug 2 — 引入 `rolling_back` 中间态，持久化 restore task_id，按 restore 结果判终态

**(a)** rollback 路由不立即标 `rolled_back`：
```ts
// batch/routes.ts POST /api/batch/:id/rollback
db.prepare("UPDATE batch_jobs SET status='rolling_back', progress_json=?, finished_at=NULL WHERE id=?")
  .run(JSON.stringify(rollbackProgress), req.params.id)
```
**(b)** `GET /api/batch/:id`（`batch/routes.ts:226`）的 allDone 块放开 `rolling_back`：
```ts
if (allDone && (job.status === "running" || job.status === "rolling_back")) {
  const allOk = updated.every((p) => p.state === "done")
  const nextStatus = job.status === "rolling_back" ? (allOk ? "rolled_back" : "partial_rollback") : (allOk ? "done" : "partial")
  db.prepare("UPDATE batch_jobs SET status=?, finished_at=? WHERE id=?").run(nextStatus, Date.now(), req.params.id)
}
```
**(c)** `agent/routes.ts` `broadcastBatchProgressForTask` 两处联动：
```ts
// SELECT（原 L127）
const batches = db.prepare("SELECT id,progress_json,status FROM batch_jobs WHERE status IN ('running','rolling_back')").all() as any[]
// finalize 门槛（原 L137）—— 与 (b) 同款 nextStatus 逻辑
if (allDone && (job.status === "running" || job.status === "rolling_back")) { /* 同 (b) */ }
```
**注意**：新状态串 `rolling_back`/`partial_rollback` 是 TEXT（`schema.sql:119` 无 CHECK），无需迁移；前端 `ProvidersPage.tsx:270` 已特判 `rolled_back`，建议加 `rolling_back`/`partial_rollback` 的展示分支（前端任务）。

---

## 6. Go agent（独立于 console）

### 6.1 bug 13 + bug 26（一组）— credFile tool 白名单 + 删 os.Unsetenv 谎报

```go
// agent.go —— credFile 附近加白名单（与 toolConfigPath switch 一致）
var validTools = map[string]bool{"codex": true, "claude": true, "gemini": true, "opencode": true}
func validTool(tool string) bool { return validTools[tool] }

// handleSetCred / handleRemoveCred：json.Unmarshal 之后、任何 credFile 调用之前
if !validTool(p.Tool) { return nil, "unsupported tool" }

// handleRemoveCred 尾部（L517-523）：删 os.Unsetenv 循环 + env_keys_cleared
// 凭据在 creds/*.sh 由用户交互 shell source，daemon 从不持有；Unsetenv 是空操作。
result["removed"] = removed
result["cred_files_removed"] = len(removed)
return result, ""
```

### 6.2 bug 14 — set_credential key 命令注入

```go
// imports 加 "regexp"
var envKeyRe = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
// handleSetCred 非 codex 循环（L470-472）
for k, v := range p.Credentials {
    if !envKeyRe.MatchString(k) { return nil, "invalid credential key: " + k }
    lines = append(lines, fmt.Sprintf("export %s='%s'", k, shellEscape(v)))
}
```

### 6.3 bug 15 — wsWriteText 无写超时

```go
// agent.go wsWriteText（L400-404），保留 a.mu（ponytail：gorilla 单写者）
func (a *Agent) wsWriteText(conn *websocket.Conn, b []byte) error {
    a.mu.Lock()
    defer a.mu.Unlock()
    _ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
    return conn.WriteMessage(websocket.TextMessage, b)
}
```

### 6.4 bug 16 + bug 24（同批）— 备份写失败中止 + 备份名加毫秒/去 collision

```go
// backupFilePath（L584-589）—— 毫秒 + collision 后缀
func backupFilePath(path string) string {
    dir := filepath.Dir(path)
    base := filepath.Base(path)
    ts := time.Now().Format("20060102_150405.000")
    candidate := filepath.Join(dir, fmt.Sprintf(".%s.bak.%s", base, ts))
    if _, err := os.Stat(candidate); err != nil { return candidate }
    for i := 2; ; i++ {
        next := filepath.Join(dir, fmt.Sprintf(".%s.bak.%s.%d", base, ts, i))
        if _, err := os.Stat(next); err != nil { return next }
    }
}
// handleWriteConfig（L574）与 handleRestoreBackup（L662 ⚠️ 不是 L653）的备份写检查错误
if berr := os.WriteFile(backupPath, existing, 0644); berr != nil {
    return nil, fmt.Sprintf("backup %s: %v", backupPath, berr)
}
```
**注意**：mode 保持 0644（CLAUDE.md 记录的 world-readable 备份行为，勿改）。

### 6.5 bug 17 — handleUpgradeTool 诚实返回

```go
// agent.go handleUpgradeTool（L734-742）
out, _ := exec.Command(p.Tool, "--version").CombinedOutput()
return map[string]interface{}{"tool": p.Tool, "old_version": firstLine(string(out))}, "upgrade_tool not implemented"
```

### 6.6 bug 25 — handleCmdWS 校验 Expires

```go
// agent.go handleCmdWS（L372-376）
if cmd.Expires > 0 && time.Now().UnixMilli() > cmd.Expires {
    a.sendResult(conn, cmd, false, nil, "command expired")
    return
}
result, errStr := a.handleCmd(cmd.Action, cmd.Payload)
a.sendResult(conn, cmd, errStr == "", result, errStr)
```
**注意**：仅 WS 路径；REST（restTask 无 Expires 字段）由服务端 reaper/状态守卫负责。`cmd.Expires==0` 视为无 deadline（向后兼容）。

---

## 7. 前端（最后，互不依赖）

### 7.1 bug 20 — 刷新即起 WS（不耦合 me）

**位置**：`lib/auth.tsx` AuthProvider L18-41。
```tsx
import { api, getAccessToken, setAccessToken, type AuthUser } from "@/lib/api"
// useEffect 内：
const tok = getAccessToken()
if (tok) initWS(tok)          // 先起 WS，不耦合 me()
api.me().then((res) => {
  if (!active) return
  if ("accessToken" in res) { setAccessToken(res.accessToken); initWS(res.accessToken) }
  setUser(res.user)
}).catch(() => { if (!active) return; closeWS(); setAccessToken(null); setUser(null) })
.finally(() => { if (active) setIsLoading(false) })
```
**注意**：依赖已修的 401 拦截器 + ws.ts 4001-onclose refresh；catch 里加 `closeWS()` 防 stale token 重连循环。

### 7.2 bug 22 — 全局 mutation onError（toast）

**新文件** `console/apps/web/src/lib/toast.tsx`（zustand，项目已有依赖）：见仓库内实现（`useToastStore` + `toastError` + `Toaster` 组件，5s 自动消失，红底错误样式）。
```tsx
// App.tsx
import { Toaster, toastError } from "@/lib/toast"
const queryClient = new QueryClient({
  defaultOptions: { mutations: { onError: (e: unknown) => toastError(`操作失败：${e instanceof Error ? e.message : String(e)}`) } },
})
// JSX 内 QueryClientProvider 下加 <Toaster />
```
全局 onError 即可消除所有 mutation 静默失败；ServerDetailPage 的 `setCredential`/`removeCredential`/`writeConfig` 不必逐个加回调（可选防御性加）。

### 7.3 bug 21 — WS token 改一次性 ticket（最大改动，保留 ?token= 灰度）

⚠️ **端点路径陷阱**（见 §0.2-7）：`/api/auth/ws-ticket` 在公开例外区，**handler 内必须显式 `authFromRequest(req)`**。

```ts
// 1) auth/routes.ts —— 发票/消费（导出），handler 内显式鉴权
const wsTickets = new Map<string, { userId: string; expiresAt: number }>()
export function issueWsTicket(userId: string) {
  const ticket = b64url(crypto.randomBytes(32))
  wsTickets.set(ticket, { userId, expiresAt: Date.now() + 30_000 })
  return { ticket, expires_in: 30 }
}
export function consumeWsTicket(ticket: string): AuthUser | null {
  const e = wsTickets.get(ticket); if (!e) return null
  wsTickets.delete(ticket)                 // single-use：先删再判过期
  if (e.expiresAt < Date.now()) return null
  const row = db.prepare("SELECT id,username,role FROM users WHERE id=?").get(e.userId) as any
  return row ? { id: row.id, username: row.username, role: row.role as Role } : null
}
app.post("/api/auth/ws-ticket", async (req, reply) => {
  const user = authFromRequest(req)        // ⚠️ 必须显式调，全局钩子不覆盖 /api/auth/*
  if (!user) return reply.code(401).send({ error: "unauthorized" })
  return issueWsTicket(user.id)
})

// 2) agent/routes.ts /api/ws —— 优先 ticket，保留 ?token= 灰度
const ticket = String(req.query?.ticket || "")
const token = String(req.query?.token || "")
const user = ticket ? consumeWsTicket(ticket)
  : token ? authFromRequest({ headers: { authorization: `Bearer ${token}` } }) : null
if (!user) return socket.close(4001, "unauthorized")

// 3) lib/api.ts 加 wsTicket()
wsTicket: () => request<{ ticket: string; expires_in: number }>("/auth/ws-ticket", { method: "POST", body: JSON.stringify({}) }),

// 4) lib/ws.ts initWS 改 async：先 fetchWsTicket（single-flight）再连 ?ticket=...
ws = new WebSocket(`${proto}//${location.host}/api/ws?ticket=${encodeURIComponent(ticket)}`)
```
**注意**：`initWS` 变 async，所有调用方 fire-and-forget 即可；onclose 4001 → refresh → 重连路径不变。ticket Map 不跨重启（重启后重连自动重领票）。过渡期保留 `?token=` 分支直到所有浏览器拿到新 bundle。

---

## 附 A：critic 修正汇总（实现时以本节覆盖 BUGFIXES.md 原文）

见 §0.2 的 10 条。要点：回滚组=1-6 原子；reaper 须补 REST expires_at；bug 6 不校验 nonce；bug 2 三处联动 + GET batch 放开；bug 9 BEGIN IMMEDIATE 是死代码、rotated_at 才是关键；bug 11 与 bug 9 同批；bug 21 端点路径陷阱；bug 16 行号 L662；bug 8 已补全；bug 1 残留窗口记录在案。

## 附 B：迁移总览

- **唯一新迁移**：`console/db/migrations/011_sessions_rotated_at.sql`（bug 9），+ `schema.sql` sessions 表加 `rotated_at INTEGER`。
- bug 11 / bug 4 reaper / bug 2 新状态值 均**无 DDL**（纯代码 / 复用既有列）。
- seed.cjs 通过 `fs.readdirSync` 自动发现迁移（seed.cjs:42-49），011 无需改 seed。

## 附 C：实现顺序（落地批次）

1. **批次 A（DB 形状）**：§1.1 迁移 011 + schema.sql；§1.2 bug 11（同批，防 boot-loop）。
2. **批次 B（叶子后端）**：§2.1-2.7（bug 7,10,12,23,18,19,8，互不依赖，可并行）。
3. **批次 C（认证）**：§3 bug 9（依赖批次 A）。
4. **批次 D（任务生命周期）**：§4 bug 5+6（同批，含 REST expires_at、导出 broadcast、不校验 nonce）。
5. **批次 E（回滚组）**：§5 bug 1+2+3+4（批次 D 之后；bug 4 由 D 的 reaper 满足）。
6. **批次 F（Go agent）**：§6（独立于 console，可并行）。
7. **批次 G（前端）**：§7（最后；bug 20、22 可先行，bug 21 最大、保留 ?token= 灰度）。

## 附 D：验证清单（改完手动验）

- TS：`cd console/apps/web && npx tsc --noEmit`；`cd console/apps/api && npx tsc --noEmit`（无 compile 步，tsx 直跑）。
- Go：`cd agent && go build ./... && go vet ./...`（注意 CLAUDE.md：agent 是 library，无 main，`build-dist.sh` 仍坏——本方案不改 agent 构建）。
- 迁移：删测试库后启动 API，确认 001-011 顺序应用、`schema_migrations` 全绿；再启动一次确认幂等（不重放）。
- 关键流：viewer 点「下发凭据」→ toast 报 403（bug 22）；刷新页面（JWT 仍有效）→ WS 立即连上（bug 20）；回滚一个含离线目标的批次 → `rolling_back` → 目标超 10min → `partial_rollback`（bug 1/2/3/4）；并发双 tab 刷新 → 不互踢（bug 9）；codex raw TOML 下发 → 顶层 `model_provider` 指向自定义段（bug 7）。
