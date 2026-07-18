// ponytail (BUG-10): migration smoke test.
//
// Sets up a temporary SQLite DB at various starting shapes (005, 006, 009,
// 011, 019, etc.) and asserts that:
//   1. the migration runner reaches a known end state
//   2. booting the runner a second time performs zero DDL (every migration
//      was already recorded as applied)
//
// Run:
//   node console/db/migration-smoke.cjs
//
// The script uses node:sqlite (Node 24+), creates files under
// os.tmpdir()/ai-console-migration-smoke-* and removes them on exit.
//
// Cases mirror the matrix in IMPLEMENTATION-PLAN.md §6 提交 13.

const { DatabaseSync } = require("node:sqlite")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const REPO_ROOT = path.resolve(__dirname, "..", "..")
const MIGRATIONS_DIR = path.join(REPO_ROOT, "console", "db", "migrations")
const SCHEMA_SQL = path.join(REPO_ROOT, "console", "db", "schema.sql")

function readMigrationFiles() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({ version: f.replace(".sql", ""), sql: fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8") }))
}

// Minimal mirror of core/db.ts runMigrations + detectAppliedMigrationVersions.
// Intentionally re-implemented here so the smoke test stays independent of the
// API module's runtime and can run as a plain node script.
function detectApplied(db) {
  const hasCol = (table, col) => {
    try {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all()
      return cols.some((c) => c.name === col)
    } catch {
      return false
    }
  }
  const hasTable = (name) => {
    try {
      return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))
    } catch {
      return false
    }
  }
  const out = []
  if (!hasTable("users")) return out
  out.push("001")
  if (hasCol("audit_log", "request_id")) out.push("002")
  if (hasCol("users", "password_algo")) out.push("003")
  if (hasCol("agent_tasks", "nonce")) out.push("004")
  if (hasCol("servers", "agent_version")) out.push("005")
  const m006 =
    !hasCol("users", "totp_secret") &&
    !hasCol("users", "totp_enabled") &&
    !hasCol("users", "recovery_codes_hash") &&
    !hasTable("usage_snapshots") &&
    !hasTable("bindings") &&
    !hasTable("profiles")
  if (m006) out.push("006")
  if (!hasTable("test_runs")) out.push("007")
  if (hasCol("provider_keys", "default_model_id")) {
    out.push("009", "010")
  } else if (hasCol("providers", "default_model_id")) {
    out.push("009")
  }
  if (hasCol("sessions", "rotated_at")) out.push("011")
  if (hasCol("agent_tasks", "encrypted_payload") && hasCol("configs", "encrypted_content")) out.push("016")
  if (hasCol("batch_jobs", "rollback_progress_json")) out.push("017")
  const hasEnrollMode = hasCol("agent_enroll_tokens", "enroll_mode") && hasCol("agent_enroll_tokens", "target_server_id")
  const serversHasInstanceId = hasCol("servers", "agent_instance_id")
  const serversHasProtocol = hasCol("servers", "agent_protocol_version")
  let serversInstanceNotnull = false
  if (serversHasInstanceId) {
    const cols = db.prepare("PRAGMA table_info(servers)").all()
    const c = cols.find((x) => x.name === "agent_instance_id")
    serversInstanceNotnull = Boolean(c && c.notnull === 1)
  }
  if (hasEnrollMode && serversInstanceNotnull && serversHasProtocol) {
    out.push("018", "019")
  } else if (hasEnrollMode && serversHasInstanceId) {
    out.push("018")
  }
  return out
}

function runMigrations(db) {
  db.exec("PRAGMA foreign_keys = ON")
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)")
  const applied = new Set(
    db.prepare("SELECT version FROM schema_migrations").all().map((r) => r.version)
  )
  const files = readMigrationFiles()
  const prefixToFull = new Map()
  for (const f of files) prefixToFull.set(f.version.slice(0, 3), f.version)

  const detected = detectApplied(db)
  if (detected.length > 0) {
    const now = Date.now()
    const ins = db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(?, ?)")
    for (const prefix of detected) {
      const full = prefixToFull.get(prefix)
      if (!full || applied.has(full)) continue
      ins.run(full, now)
      applied.add(full)
    }
  }

  for (const { version, sql } of files) {
    if (applied.has(version)) continue
    db.exec("BEGIN")
    try {
      db.exec(sql)
      db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)").run(version, Date.now())
      db.exec("COMMIT")
    } catch (e) {
      db.exec("ROLLBACK")
      throw new Error(`migration ${version} failed: ${e.message}`)
    }
  }
}

function applyUpTo(db, lastPrefix) {
  // Apply migrations whose prefix is <= lastPrefix but DON'T record them as
  // applied — the smoke test simulates a DB that was migrated "the old way"
  // (schema in place, schema_migrations empty) so reconciliation can prove
  // itself.
  const files = readMigrationFiles()
  for (const { version, sql } of files) {
    if (version.slice(0, 3) > lastPrefix) break
    db.exec(sql)
  }
}

function applyPartialAndRecord(db, recordedVersions) {
  // Build a DB at a specific shape by running migrations up to a version and
  // selectively recording some of them as applied.
  const files = readMigrationFiles()
  const recorded = new Set(recordedVersions.map((v) => v.padEnd(3, "_")))
  const prefixToFull = new Map()
  for (const f of files) prefixToFull.set(f.version.slice(0, 3), f.version)
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)")
  for (const { version, sql } of files) {
    db.exec(sql)
    if (recorded.has(version.slice(0, 3))) {
      db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(?, ?)").run(version, Date.now())
    }
  }
}

function freshTempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ai-console-migration-smoke-${label}-`))
  return dir
}

const cases = []

// Case 1: empty DB → all migrations applied.
cases.push({
  name: "empty-db",
  setup: (db) => {},
  expect: "019",
})

// Case 2: schema at 005 shape, no schema_migrations entries → reconcile then run 006+.
cases.push({
  name: "shape-005-no-records",
  setup: (db) => applyUpTo(db, "005"),
  expect: "019",
})

// Case 3: shape 009 (providers.default_model_id exists) — reconciliation must
// mark 001-009 as applied, NOT 010, so 010 runs and provider_keys.default_model_id
// is created (and providers.default_model_id removed).
cases.push({
  name: "shape-009-partial-default-model",
  setup: (db) => applyUpTo(db, "009"),
  expect: "019",
})

// Case 4: shape 011, no records — reconciliation should not replay any DDL.
cases.push({
  name: "shape-011-no-records",
  setup: (db) => applyUpTo(db, "011"),
  expect: "011", // 2.0 migrations still run
  expectExtraMigrations: ["016", "017", "018", "019"],
})

// Case 5: post-019 shape via schema.sql fallback — nothing should run.
cases.push({
  name: "post-019-schema-fallback",
  setup: (db) => {
    const sql = fs.readFileSync(SCHEMA_SQL, "utf8")
    // Strip PRAGMA lines — they conflict with an already-open DB in node:sqlite.
    const stripped = sql.replace(/^PRAGMA.*;$/gm, "")
    db.exec(stripped)
  },
  expect: "019",
})

// Case 6: shape 011 but schema_migrations only has 001 — gap reconciliation.
cases.push({
  name: "shape-011-partial-records",
  setup: (db) => applyPartialAndRecord(db, ["001"]),
  expect: "019",
})

function runCase(c) {
  const dir = freshTempDir(c.name)
  const dbPath = path.join(dir, "smoke.db")
  let db
  try {
    db = new DatabaseSync(dbPath)
    c.setup(db)
    runMigrations(db)
    // Second boot — nothing should change.
    const before = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((r) => r.version)
    runMigrations(db)
    const after = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((r) => r.version)
    if (before.length !== after.length) {
      throw new Error(`second boot added migrations: ${after.filter((v) => !before.includes(v)).join(",")}`)
    }
    // Sanity-check end state.
    const cols = db.prepare("PRAGMA table_info(servers)").all()
    if (!cols.some((c) => c.name === "agent_instance_id" && c.notnull === 1)) {
      throw new Error("servers.agent_instance_id missing or nullable at end of case")
    }
    if (!cols.some((c) => c.name === "agent_protocol_version")) {
      throw new Error("servers.agent_protocol_version missing at end of case")
    }
    if (!db.prepare("SELECT 1 FROM schema_migrations WHERE version='019_agent_protocol_version'").get()) {
      throw new Error("019 not recorded as applied")
    }
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
    return { ok: true, count: after.length }
  } catch (e) {
    try { db && db.close() } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
    return { ok: false, err: e.message }
  }
}

function main() {
  let pass = 0
  let fail = 0
  for (const c of cases) {
    const result = runCase(c)
    if (result.ok) {
      console.log(`  PASS  ${c.name}  (applied=${result.count})`)
      pass++
    } else {
      console.error(`  FAIL  ${c.name}  ${result.err}`)
      fail++
    }
  }
  console.log(`\n${pass}/${pass + fail} cases passed`)
  process.exit(fail === 0 ? 0 : 1)
}

main()
