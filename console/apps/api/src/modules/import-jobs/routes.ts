import type { FastifyInstance } from "fastify"
import { db } from "../../core/db"
import { audit } from "../../core/audit"
import type { AuthUser } from "../../core/constants"

export function registerImportJobsRoutes(app: FastifyInstance) {
  app.get("/api/import-jobs", async (req) => {
    const q = req.query as any
    const limit = Math.min(Math.max(1, parseInt(String(q?.limit ?? "50"), 10) || 50), 200)
    const offset = Math.max(0, parseInt(String(q?.offset ?? "0"), 10) || 0)
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
    const cleaned: { providers: number; keys: number; models: number; endpoints: number; pricing: number; pricing_restored: number } =
      { providers: 0, keys: 0, models: 0, endpoints: 0, pricing: 0, pricing_restored: 0 }

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
      // ponytail: 原逻辑只把 pricing_count 当数字记一笔、从不 DELETE，谎报已清理（bug 19）。
      // 改为按导入时记录的 pricing_model_ids 真删，并尽力恢复被 INSERT OR REPLACE 覆盖的旧行。
      // 旧 job 的 counts_json 无 pricing_model_ids → 跳过、报 pricing=0（诚实）。
      let pricingDeleted = 0
      if (Array.isArray(ids.pricing_model_ids) && ids.pricing_model_ids.length) {
        const placeholders = ids.pricing_model_ids.map(() => "?").join(",")
        pricingDeleted = Number(
          db.prepare(`DELETE FROM model_pricing WHERE model_id IN (${placeholders})`).run(...ids.pricing_model_ids).changes
        )
      }
      if (Array.isArray(ids.pricing_overwritten) && ids.pricing_overwritten.length) {
        const restoreStmt = db.prepare(
          `INSERT OR REPLACE INTO model_pricing(model_id,display_name,input_cost_per_million,output_cost_per_million,cache_read_cost_per_million,cache_creation_cost_per_million)
           VALUES(?,?,?,?,?,?)`
        )
        for (const p of ids.pricing_overwritten) {
          restoreStmt.run(
            p.model_id, p.display_name, p.input_cost_per_million, p.output_cost_per_million,
            p.cache_read_cost_per_million || "0", p.cache_creation_cost_per_million || "0"
          )
          cleaned.pricing_restored++
        }
      }
      cleaned.pricing = pricingDeleted - cleaned.pricing_restored

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
