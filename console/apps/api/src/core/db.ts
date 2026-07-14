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

export function productionCheck(log: FastifyInstance["log"]) {
  if (process.env.NODE_ENV !== "production") return
  const check = (name: string, actual: string | undefined, forbidden: string, placeholders: string[] = []) => {
    if (!actual || actual === forbidden || placeholders.includes(actual)) {
      log.fatal(`FATAL: ${name} must be set in production and must not be the default`)
      process.exit(1)
    }
  }
  check("MASTER_KEY", process.env.MASTER_KEY, "ai-console-dev-master-key-change-me", ["change-me-to-a-random-64-char-string"])
  const derivedJwtSecret = createHash("sha256").update((process.env.MASTER_KEY || "") + ":jwt").digest("hex")
  check("JWT_SECRET", process.env.JWT_SECRET, derivedJwtSecret, ["change-me-to-another-random-64-char-string"])
  check("BOOTSTRAP_ADMIN_PASS", process.env.BOOTSTRAP_ADMIN_PASS, "admin")
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

  if (applied.size === 0) {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'"
      )
      .all() as { name: string }[]

    if (tables.length > 0) {
      const baselineVersion = files[0].replace(".sql", "")
      db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)").run(baselineVersion, Date.now())
      applied.add(baselineVersion)
      log.info(`detected existing schema (${tables.length} tables), marked ${baselineVersion} as applied (baseline)`)
    }
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
      throw new Error(`migration ${version} failed: ${(e as Error).message}`)
    }
  }
}
