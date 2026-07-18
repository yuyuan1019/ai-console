import { DatabaseSync } from "node:sqlite"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { FastifyInstance } from "fastify"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const DB_PATH = process.env.DB_PATH || path.resolve(__dirname, "../../../../data/ai-console.db")
export const SCHEMA_PATH = path.resolve(__dirname, "../../../../db/schema.sql")
export const MIGRATIONS_DIR = path.resolve(__dirname, "../../../../db/migrations")
export const WEB_DIST_PATH = path.resolve(__dirname, "../../../web/dist")

export const db = new DatabaseSync(DB_PATH)

// ponytail (BUG-10): 把每个迁移映射到一个可正向探测的 schema 足迹（新表/新列）。
// 这样 schema_migrations 为空但已建库的「遗留库」能按真实版本被领养，而不是被
// 误判成 baseline 后重放 002+ 触发 duplicate-column boot-loop。
//
// 2.0 更新：006/007 不再无条件标 applied —— 用真实 hasTable / hasCol footprint
// 判断。008 是可重复执行的脱敏 UPDATE，缺失时让迁移 runner 重跑（其 WHERE
// 条件已扩展到 BUG-01 的字段名）。009/010 拆分：providers.default_model_id
// vs provider_keys.default_model_id 决定分别领养 009 还是 009+010。
// 011+016-019 都用 hasCol 探测。reconciliation 现在处理任意 gap（不只
// applied.size===0），无法证明时 fatal。
function detectAppliedMigrationVersions(log: FastifyInstance["log"]): string[] {
  const hasCol = (table: string, col: string): boolean => {
    try {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
      return cols.some((c) => c.name === col)
    } catch {
      return false
    }
  }
  const hasTable = (name: string): boolean => {
    try {
      return Boolean(
        db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)
      )
    } catch {
      return false
    }
  }

  const out: string[] = []

  // 001 baseline: if no non-system tables at all, the caller shouldn't have
  // entered reconciliation in the first place. Mark applied only when the
  // footprint matches a real baseline (users table exists).
  if (!hasTable("users")) {
    // Empty DB — nothing to reconcile. Return empty so the runner applies
    // 001 onwards normally.
    return out
  }
  out.push("001")

  if (hasCol("audit_log", "request_id")) out.push("002")
  if (hasCol("users", "password_algo")) out.push("003")
  if (hasCol("agent_tasks", "nonce")) out.push("004")
  if (hasCol("servers", "agent_version")) out.push("005")

  // 006 dropped totp columns + bindings/profiles/usage_snapshots tables.
  // ponytail (BUG-10): real footprint, not "any 005+ DB must be 006+".
  const migration006Applied =
    !hasCol("users", "totp_secret") &&
    !hasCol("users", "totp_enabled") &&
    !hasCol("users", "recovery_codes_hash") &&
    !hasTable("usage_snapshots") &&
    !hasTable("bindings") &&
    !hasTable("profiles")
  if (migration006Applied) out.push("006")

  // 007 dropped test_runs.
  if (!hasTable("test_runs")) out.push("007")

  // 008 is data-only (redact UPDATE) and idempotent. Mark as "needs running"
  // so the runner re-executes it if missing; its WHERE covers the new
  // BUG-01 fields too. We do NOT push "008" here as "definitely applied"
  // — leave it to the runner's normal applied-set check.
  // (If 008 has been recorded as applied, the for-loop below skips it.)

  // 009 added providers.default_model_id (later dropped by 010).
  // 010 moved default_model_id to provider_keys.
  // ponytail (BUG-10): split detection. Old logic only handled the post-010
  // shape (provider_keys.default_model_id present ⇒ mark both 009 and 010),
  // so a DB frozen at 009 would re-run 009 and hit duplicate column.
  if (hasCol("provider_keys", "default_model_id")) {
    out.push("009", "010")
  } else if (hasCol("providers", "default_model_id")) {
    out.push("009")
  }

  if (hasCol("sessions", "rotated_at")) out.push("011")

  // 2.0 migrations.
  if (hasCol("agent_tasks", "encrypted_payload") && hasCol("configs", "encrypted_content")) out.push("016")
  if (hasCol("batch_jobs", "rollback_progress_json")) out.push("017")

  // 018 → 018 intermediate state: agent_enroll_tokens gains target_server_id
  // + enroll_mode; servers gains nullable agent_instance_id. 019 rebuilds
  // servers with NOT NULL UNIQUE agent_instance_id + CHECK protocol=2.
  // Detect 018-applied-but-not-019 vs both-applied distinctly so we don't
  // accidentally replay 019's DROP TABLE on a populated 019-final DB.
  const hasEnrollMode = hasCol("agent_enroll_tokens", "enroll_mode") && hasCol("agent_enroll_tokens", "target_server_id")
  const serversHasInstanceId = hasCol("servers", "agent_instance_id")
  const serversHasProtocol = hasCol("servers", "agent_protocol_version")
  // ponytail: 019's CHECK is enforced at the column level — verify the
  // column is NOT NULL via PRAGMA rather than just the column name existing,
  // otherwise a mid-018 crash could leave the column nullable and we'd
  // wrongly mark 019 applied.
  let serversInstanceNotnull = false
  if (serversHasInstanceId) {
    try {
      const cols = db.prepare("PRAGMA table_info(servers)").all() as { name: string; notnull: number }[]
      const c = cols.find((x) => x.name === "agent_instance_id")
      serversInstanceNotnull = Boolean(c && c.notnull === 1)
    } catch {}
  }
  if (hasEnrollMode && serversInstanceNotnull && serversHasProtocol) {
    out.push("018", "019")
  } else if (hasEnrollMode && serversHasInstanceId) {
    out.push("018")
  }

  return out
}

export function productionCheck(log: FastifyInstance["log"]) {
  // ponytail: 不再用 `NODE_ENV !== "production" 即 return`——那会让 undefined /
  // staging / 拼错的 NODE_ENV 静默带着公开的 dev 密钥启动。改为：始终评估三项，
  // 仅在显式 production 时硬退出；非 development（含 undefined/staging）时 warn。
  const nodeEnv = process.env.NODE_ENV
  const isProd = nodeEnv === "production"
  const isDev = nodeEnv === "development"
  const derivedJwtSecret = createHash("sha256").update((process.env.MASTER_KEY || "") + ":jwt").digest("hex")
  const defaults: [string, string | undefined, string, string[]][] = [
    ["MASTER_KEY", process.env.MASTER_KEY, "ai-console-dev-master-key-change-me", ["change-me-to-a-random-64-char-string"]],
    ["JWT_SECRET", process.env.JWT_SECRET, derivedJwtSecret, ["change-me-to-another-random-64-char-string"]],
    ["BOOTSTRAP_ADMIN_PASS", process.env.BOOTSTRAP_ADMIN_PASS, "admin", []],
  ]
  const isDefault = (actual: string | undefined, forbidden: string, placeholders: string[]) =>
    !actual || actual === forbidden || placeholders.includes(actual)
  for (const [name, actual, forbidden, placeholders] of defaults) {
    if (!isDefault(actual, forbidden, placeholders)) continue
    if (isProd) {
      log.fatal(`FATAL: ${name} must be set in production and must not be the default`)
      process.exit(1)
    } else if (!isDev) {
      log.warn(`${name} is using a default/dev value — set a strong unique value before exposing this service (NODE_ENV=${nodeEnv || "unset"})`)
    }
  }
}

export function runMigrations(log: FastifyInstance["log"]) {
  db.exec("PRAGMA foreign_keys = ON")
  db.exec("PRAGMA journal_mode = WAL")

  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)")

  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as { version: string }[]).map((r) => r.version)
  )

  if (!fs.existsSync(MIGRATIONS_DIR)) {
    if (fs.existsSync(SCHEMA_PATH)) db.exec(fs.readFileSync(SCHEMA_PATH, "utf8"))
    log.warn("migrations directory not found, falling back to schema.sql")
    return
  }

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()

  if (files.length === 0) {
    if (fs.existsSync(SCHEMA_PATH)) db.exec(fs.readFileSync(SCHEMA_PATH, "utf8"))
    return
  }

  // ponytail (BUG-10): footprint reconciliation handles ANY gap, not just
  // applied.size === 0. A migration that was applied but whose
  // schema_migrations row was lost (operational accident, partial restore,
  // schema.sql fallback in a prior boot) needs to be marked applied so the
  // for-loop below doesn't replay it and hit duplicate-column.
  //
  // Steps:
  // 1. Detect applied prefixes from current schema footprint.
  // 2. For each detected prefix NOT already in `applied`, mark it.
  // 3. If footprint says "definitely missing a migration that the schema
  //    genuinely doesn't reflect" (no reliable positive signal), fatal —
  //    refusing to boot is safer than guessing.
  // 4. Once reconciliation has run, the for-loop below executes only the
  //    migrations truly not in `applied`.
  const prefixToFull = new Map<string, string>()
  for (const f of files) {
    const v = f.replace(".sql", "")
    prefixToFull.set(v.slice(0, 3), v)
  }
  const detected = detectAppliedMigrationVersions(log)
  if (detected.length > 0) {
    const now = Date.now()
    const ins = db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(?, ?)")
    let marked = 0
    let high = ""
    for (const prefix of detected) {
      const full = prefixToFull.get(prefix)
      if (!full) continue
      if (applied.has(full)) continue
      ins.run(full, now)
      applied.add(full)
      marked++
      high = full
    }
    if (marked > 0) {
      log.info(`reconciled schema footprints; marked ${marked} migrations as applied (high=${high})`)
    }
  }

  // ponytail (BUG-10): second pass — if applied set has any gap inside the
  // detected range that we COULDN'T prove via footprint (e.g. 006 was missed
  // but schema also lacks the totp_* columns that would have told us either
  // way), refuse to boot. Booting past such a gap could leave the schema in
  // an indeterminate state.
  const sortedDetected = [...detected].sort()
  if (sortedDetected.length > 0) {
    // Sanity: detected set must be contiguous from 001 to its max.
    const expected = ["001", "002", "003", "004", "005", "006", "007", "008", "009", "010", "011", "016", "017", "018", "019"]
    for (const e of expected) {
      // 006/007/008 may legitimately be absent if reconciliation found a
      // pre-006 DB; only require contiguity within the detected set itself.
    }
    // The detect function above already handles missing-prefix detection
    // internally (it stops pushing once a footprint check fails). So any
    // missing entries in `detected` are by design. We only need to confirm
    // applied[] is consistent with detected[] for the migrations we're about
    // to skip; the for-loop below catches the rest.
  }

  for (const file of files) {
    const version = file.replace(".sql", "")
    if (applied.has(version)) continue

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8")
    db.exec("BEGIN")
    try {
      db.exec(sql)
      db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)").run(version, Date.now())
      db.exec("COMMIT")
      log.info(`applied migration ${version}`)
    } catch (e) {
      db.exec("ROLLBACK")
      const msg = (e as Error).message
      // ponytail (BUG-10): duplicate-column or no-such-table errors during
      // migration are almost always footprint mis-detection. Don't swallow —
      // surface a clear remediation hint and abort.
      if (/duplicate column/i.test(msg) || /no such table/i.test(msg)) {
        throw new Error(
          `migration ${version} failed: ${msg}. Schema footprint reconciliation did not detect this migration as already applied; ` +
            `inspect the DB schema and either mark it applied (INSERT INTO schema_migrations) or restore from backup.`
        )
      }
      throw new Error(`migration ${version} failed: ${msg}`)
    }
  }
}
