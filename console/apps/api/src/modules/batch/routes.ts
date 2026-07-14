import type { FastifyInstance } from "fastify"
import crypto from "node:crypto"
import { db } from "../../core/db"
import { decrypt } from "../../core/crypto"
import { generateConfig } from "../../core/config"
import { audit } from "../../core/audit"
import { createAgentTask, broadcastEvent } from "../agent/routes"
import type { AuthUser } from "../../core/constants"

export function registerBatchRoutes(app: FastifyInstance) {
  app.post<{ Body: { tool?: string; provider_id?: string; key_id?: string; model_id?: string } }>(
    "/api/batch/preview",
    async (req, reply) => {
      const tool = String(req.body?.tool || "").trim()
      const providerId = String(req.body?.provider_id || "").trim()
      const keyId = String(req.body?.key_id || "").trim()
      const modelId = String(req.body?.model_id || "").trim()
      if (!["codex", "claude", "gemini", "opencode"].includes(tool)) return reply.code(400).send({ error: "invalid tool" })
      if (!providerId || !keyId || !modelId) return reply.code(400).send({ error: "provider_id, key_id, model_id are required" })

      const key = db
        .prepare(`SELECT k.encrypted_value, k.iv, k.api_format, k.auth_type, k.raw_config_json,
                  p.base_url, p.name AS provider_name
           FROM provider_keys k JOIN providers p ON p.id=k.provider_id
           WHERE k.id=? AND k.provider_id=? AND k.enabled=1`)
        .get(keyId, providerId) as any
      if (!key) return reply.code(404).send({ error: "key not found" })
      if (key.auth_type !== "apikey" || !key.encrypted_value) return reply.code(400).send({ error: "oauth key has no secret" })

      const secret = decrypt(key.encrypted_value, key.iv)
      if (!secret) return reply.code(400).send({ error: "decrypt failed" })

      const result = generateConfig(tool, {
        base_url: key.base_url || "",
        api_key: secret,
        model: modelId,
        api_format: key.api_format,
        raw_config_json: key.raw_config_json,
        provider_name: key.provider_name,
      })
      return { tool, model: modelId, content: result.content, format: result.format }
    }
  )

  app.post<{
    Body: {
      tool?: string
      server_ids?: string[]
      provider_id?: string
      key_id?: string
      model_id?: string
    }
  }>("/api/batch/execute", async (req, reply) => {
    const user = (req as any).auth as AuthUser
    const tool = String(req.body?.tool || "").trim()
    const serverIds = Array.isArray(req.body?.server_ids) ? req.body!.server_ids!.map(String) : []
    if (!["codex", "claude", "gemini", "opencode"].includes(tool)) return reply.code(400).send({ error: "invalid tool" })
    if (serverIds.length === 0) return reply.code(400).send({ error: "server_ids required" })

    const providerId = String(req.body?.provider_id || "").trim()
    const keyId = String(req.body?.key_id || "").trim()
    const modelId = String(req.body?.model_id || "").trim()
    if (!providerId || !keyId || !modelId) return reply.code(400).send({ error: "provider_id, key_id and model_id are required" })

    const key = db
      .prepare(`SELECT k.encrypted_value, k.iv, k.api_format, k.raw_config_json, p.base_url, p.name AS provider_name
                FROM provider_keys k JOIN providers p ON p.id=k.provider_id
                WHERE k.id=? AND k.provider_id=? AND k.enabled=1`)
      .get(keyId, providerId) as any
    if (!key) return reply.code(404).send({ error: "key not found" })
    const secret = decrypt(key.encrypted_value, key.iv)
    if (!secret) return reply.code(400).send({ error: "decrypt failed" })
    const generated = generateConfig(tool, {
      base_url: key.base_url || "", api_key: secret, model: modelId,
      api_format: key.api_format, raw_config_json: key.raw_config_json,
      provider_name: key.provider_name,
    })
    const content = generated.content
    const format = generated.format
    const sourceRef = `${providerId}/${keyId}/${modelId}`

    const batchId = crypto.randomUUID()
    const now = Date.now()
    const progress: any[] = []
    db.exec("BEGIN")
    try {
      for (const sid of serverIds) {
        const server = db.prepare("SELECT name FROM servers WHERE id=?").get(sid) as any
        if (!server) continue
        const task = createAgentTask(sid, user.id, "write_config", { tool, format, content })
        progress.push({ server_id: sid, server_name: server.name, task_id: task.id, state: "pending" })
      }
      db.prepare(
        "INSERT INTO batch_jobs(id,tool,source_type,source_ref,targets_json,status,progress_json,started_by,started_at) VALUES(?,?,?,?,?,?,?,?,?)"
      ).run(batchId, tool, "ad_hoc", sourceRef, JSON.stringify(serverIds), "running", JSON.stringify(progress), user.id, now)
      audit(user.id, "batch.execute", `batch:${batchId}`, null, { tool, server_count: progress.length })
      db.exec("COMMIT")
    } catch (e) {
      db.exec("ROLLBACK")
      throw e
    }
    broadcastEvent(`batch:${batchId}`, { batch_id: batchId, state: "running", progress })
    return { id: batchId }
  })

  app.get<{ Params: { id: string } }>("/api/batch/:id", async (req, reply) => {
    const job = db.prepare("SELECT * FROM batch_jobs WHERE id=?").get(req.params.id) as any
    if (!job) return reply.code(404).send({ error: "not found" })
    const progress = JSON.parse(job.progress_json || "[]") as any[]
    const updated = progress.map((p) => {
      const task = db.prepare("SELECT status,error FROM agent_tasks WHERE id=?").get(p.task_id) as any
      return { ...p, state: task?.status || p.state, error: task?.error }
    })
    const allDone = updated.every((p) => p.state === "done" || p.state === "failed")
    if (allDone && job.status === "running") {
      db.prepare("UPDATE batch_jobs SET status=?, finished_at=? WHERE id=?").run(
        updated.every((p) => p.state === "done") ? "done" : "partial",
        Date.now(),
        req.params.id
      )
    }
    return {
      id: job.id,
      tool: job.tool,
      status: allDone ? (updated.every((p) => p.state === "done") ? "done" : "partial") : job.status,
      progress: updated,
      started_at: job.started_at,
      finished_at: allDone ? Date.now() : null,
    }
  })

  app.post<{ Params: { id: string } }>("/api/batch/:id/rollback", async (req, reply) => {
    const user = (req as any).auth as AuthUser
    const job = db.prepare("SELECT * FROM batch_jobs WHERE id=?").get(req.params.id) as any
    if (!job) return reply.code(404).send({ error: "not found" })
    const progress = JSON.parse(job.progress_json || "[]") as any[]
    const now = Date.now()
    const rollbackProgress: any[] = []
    db.exec("BEGIN")
    try {
      for (const p of progress) {
        const task = db.prepare("SELECT status FROM agent_tasks WHERE id=?").get(p.task_id) as any
        if (task?.status !== "done") continue
        const restoreTask = createAgentTask(p.server_id, user.id, "restore_config_backup", { tool: job.tool, backup: "" })
        rollbackProgress.push({ server_id: p.server_id, server_name: p.server_name, task_id: restoreTask.id, state: "pending" })
      }
      db.prepare("UPDATE batch_jobs SET status='rolled_back', finished_at=? WHERE id=?").run(now, req.params.id)
      audit(user.id, "batch.rollback", `batch:${req.params.id}`, null, { count: rollbackProgress.length })
      db.exec("COMMIT")
    } catch (e) {
      db.exec("ROLLBACK")
      throw e
    }
    broadcastEvent(`batch:${req.params.id}`, { batch_id: req.params.id, state: "rolled_back", progress: rollbackProgress })
    return { ok: true, rollback_count: rollbackProgress.length }
  })
}
