import type { FastifyInstance } from "fastify"
import { db } from "../../core/db"

function buildWhere(q: any): { where: string; params: any[] } {
  const clauses: string[] = ["1=1"]
  const params: any[] = []

  const action = q?.action ? String(q.action).trim() : ""
  if (action) {
    clauses.push("a.action LIKE ?")
    params.push(`%${action}%`)
  }

  const actor = q?.actor ? String(q.actor).trim() : ""
  if (actor) {
    clauses.push("(a.actor = ? OR u.username = ?)")
    params.push(actor, actor)
  }

  const rid = q?.request_id ? String(q.request_id).trim() : ""
  if (rid) {
    clauses.push("a.request_id = ?")
    params.push(rid)
  }

  const start = Number(q?.start)
  if (!Number.isNaN(start) && start > 0) {
    clauses.push("a.ts >= ?")
    params.push(start)
  }

  const end = Number(q?.end)
  if (!Number.isNaN(end) && end > 0) {
    clauses.push("a.ts <= ?")
    params.push(end)
  }

  return { where: clauses.join(" AND "), params }
}

export function registerAuditRoutes(app: FastifyInstance) {
  app.get("/api/audit", async (req) => {
    const q = req.query as any
    const limit = Math.min(Number(q?.limit || 100), 500)
    const offset = Math.max(0, Number(q?.offset || 0))
    const { where, params } = buildWhere(q)

    const sql = `SELECT a.id,a.action,a.target,before_json,after_json,a.ts,a.request_id,
                        a.actor,
                        COALESCE(u.username, a.actor) AS actor_name
                 FROM audit_log a
                 LEFT JOIN users u ON u.id = a.actor
                 WHERE ${where}
                 ORDER BY a.ts DESC LIMIT ? OFFSET ?`

    return db.prepare(sql).all(...params, limit, offset) as any[]
  })

  app.get("/api/audit/count", async (req) => {
    const q = req.query as any
    const { where, params } = buildWhere(q)
    const row = db.prepare(`SELECT COUNT(*) AS c FROM audit_log a LEFT JOIN users u ON u.id = a.actor WHERE ${where}`).get(...params) as any
    return { total: Number(row?.c || 0) }
  })
}
