import type { FastifyInstance } from "fastify"
import { db } from "../../core/db"
import { audit } from "../../core/audit"
import type { AuthUser } from "../../core/constants"

export function registerImportJobsRoutes(app: FastifyInstance) {
  app.get("/api/import-jobs", async (req) => {
    const q = req.query as any
    const limit = Math.min(Number(q?.limit || 50), 200)
    const offset = Math.max(0, Number(q?.offset || 0))
    const rows = db.prepare(
      "SELECT id, source_type, source_path, status, counts_json, started_by, started_at, finished_at FROM import_jobs ORDER BY started_at DESC LIMIT ? OFFSET ?"
    ).all(limit, offset) as any[]
    return rows.map(parseJob)
  })

  app.get<{ Params: { id: string } }>("/api/import-jobs/:id", async (req, reply) => {
    const row = db.prepare(
      "SELECT id, source_type, source_path, status, counts_json, started_by, started_at, finished_at FROM import_jobs WHERE id=?"
    ).get(req.params.id) as any
    if (!row) return reply.code(404).send({ error: "import job not found" })
    return parseJob(row)
  })

  app.post<{ Params: { id: string } }>("/api/import-jobs/:id/rollback", async (req, reply) => {
    const user = (req as any).auth as AuthUser
    const row = db.prepare(
      "SELECT id, status, counts_json FROM import_jobs WHERE id=?"
    ).get(req.params.id) as any
    if (!row) return reply.code(404).send({ error: "import job not found" })
    if (row.status === "rolled_back") return reply.code(400).send({ error: "already rolled back" })

    let stored: any = {}
    try { stored = JSON.parse(row.counts_json || "{}") } catch { stored = {} }

    const ids = stored.created || {}
    const cleaned = { providers: 0, keys: 0, models: 0, endpoints: 0, pricing: 0 }

    db.exec("BEGIN")
    try {
      if (Array.isArray(ids.provider_ids)) {
        for (const pid of ids.provider_ids) {
          db.prepare("DELETE FROM models WHERE provider_id=?").run(pid)
          db.prepare("DELETE FROM provider_endpoints WHERE provider_id=?").run(pid)
          db.prepare("DELETE FROM provider_keys WHERE provider_id=?").run(pid)
          const r = db.prepare("DELETE FROM providers WHERE id=?").run(pid)
          cleaned.providers += Number(r.changes)
        }
      }
      if (Array.isArray(ids.key_ids)) {
        for (const kid of ids.key_ids) {
          const r = db.prepare("DELETE FROM provider_keys WHERE id=?").run(kid)
          cleaned.keys += Number(r.changes)
        }
      }
      if (Array.isArray(ids.model_ids)) {
        for (const mid of ids.model_ids) {
          const r = db.prepare("DELETE FROM models WHERE id=?").run(mid)
          cleaned.models += Number(r.changes)
        }
      }
      if (Array.isArray(ids.endpoint_ids)) {
        for (const eid of ids.endpoint_ids) {
          const r = db.prepare("DELETE FROM provider_endpoints WHERE id=?").run(eid)
          cleaned.endpoints += Number(r.changes)
        }
      }
      if (ids.pricing_count) {
        cleaned.pricing = ids.pricing_count
      }

      db.prepare("UPDATE import_jobs SET status='rolled_back', finished_at=? WHERE id=?").run(Date.now(), row.id)
      db.exec("COMMIT")
      audit(user.id, "import_job.rollback", `import_job:${row.id}`, stored, cleaned)
      return { ok: true, cleaned }
    } catch (e) {
      db.exec("ROLLBACK")
      throw e
    }
  })
}

function parseJob(row: any) {
  if (!row) return row
  let counts: any = null
  try { counts = row.counts_json ? JSON.parse(row.counts_json) : null } catch { counts = null }
  return {
    id: row.id,
    source_type: row.source_type,
    source_path: row.source_path,
    status: row.status,
    counts: counts,
    started_by: row.started_by,
    started_at: row.started_at,
    finished_at: row.finished_at,
  }
}
