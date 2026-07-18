import type { FastifyInstance } from "fastify"
import crypto from "node:crypto"
import { db } from "../../core/db"
import { decrypt } from "../../core/crypto"
import { generateConfig, mergeOpenCodeConfig, withOpenAiV1 } from "../../core/config"
import { audit } from "../../core/audit"
import { insertAgentTask, dispatchAgentTask, broadcastEvent } from "../agent/routes"
import type { AuthUser } from "../../core/constants"

export function registerBatchRoutes(app: FastifyInstance) {
  app.post<{ Body: { tool?: string; provider_id?: string; key_id?: string; model_id?: string; keys?: Array<{ provider_id?: string; key_id?: string; model_id?: string; primary?: boolean }> } }>(
    "/api/batch/preview",
    async (req, reply) => {
      const tool = String(req.body?.tool || "").trim()
      if (!["codex", "claude", "gemini", "opencode"].includes(tool)) return reply.code(400).send({ error: "invalid tool" })

      const keyEntries: Array<{ providerId: string; keyId: string; modelId: string; primary?: boolean }> = []
      if (Array.isArray(req.body?.keys) && req.body!.keys.length > 0 && tool === "opencode") {
        for (const k of req.body!.keys) {
          const pid = String(k?.provider_id || "").trim()
          const kid = String(k?.key_id || "").trim()
          const mid = String(k?.model_id || "").trim()
          if (!pid || !kid || !mid) return reply.code(400).send({ error: "each key entry requires provider_id, key_id, model_id" })
          keyEntries.push({ providerId: pid, keyId: kid, modelId: mid, primary: Boolean(k?.primary) })
        }
      } else {
        const providerId = String(req.body?.provider_id || "").trim()
        const keyId = String(req.body?.key_id || "").trim()
        const modelId = String(req.body?.model_id || "").trim()
        if (!providerId || !keyId || !modelId) return reply.code(400).send({ error: "provider_id, key_id, model_id are required" })
        keyEntries.push({ providerId, keyId, modelId })
      }

      if (tool === "opencode" && keyEntries.length > 1) {
        const sorted = [...keyEntries].sort((a, b) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0))
        const entries: Array<{ providerId: string; providerLabel: string; openAiBaseUrl: string; apiKey: string; model: string; models?: string[]; apiFormat?: string | null }> = []
        for (const ke of sorted) {
          const key = db
            .prepare(`SELECT k.encrypted_value, k.iv, k.api_format, k.auth_type, k.group_name, p.base_url, p.name AS provider_name
                       FROM provider_keys k JOIN providers p ON p.id=k.provider_id
                       WHERE k.id=? AND k.provider_id=? AND k.enabled=1`)
            .get(ke.keyId, ke.providerId) as any
          if (!key) return reply.code(404).send({ error: `key ${ke.keyId} not found` })
          if (key.auth_type !== "apikey" || !key.encrypted_value) return reply.code(400).send({ error: "oauth key has no secret" })
          const secret = decrypt(key.encrypted_value, key.iv)
          if (!secret) return reply.code(400).send({ error: "decrypt failed" })
          const baseUrl = String(key.base_url || "").replace(/\/+$/, "")
          const providerLabel = key.provider_name || "provider"
          const groupLabel = key.group_name ? `_${key.group_name}` : ""
          const providerId = `${providerLabel}${groupLabel}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "provider"
          const allModels = (db.prepare("SELECT model_id FROM models WHERE provider_id=? AND enabled=1 ORDER BY model_id").all(ke.providerId) as any[]).map(r => r.model_id)
          entries.push({
            providerId, providerLabel,
            openAiBaseUrl: withOpenAiV1(baseUrl),
            apiKey: secret,
            model: ke.modelId,
            models: allModels,
            apiFormat: key.api_format,
          })
        }
        const merged = mergeOpenCodeConfig(entries)
        return { tool, model: merged.model, content: JSON.stringify(merged, null, 2), format: "json" }
      }

      const ke = keyEntries[0]
      const providerId = ke.providerId
      const keyId = ke.keyId
      const modelId = ke.modelId

      const key = db
        .prepare(`SELECT k.encrypted_value, k.iv, k.api_format, k.auth_type, k.raw_config_json, k.group_name,
                  p.base_url, p.name AS provider_name
           FROM provider_keys k JOIN providers p ON p.id=k.provider_id
           WHERE k.id=? AND k.provider_id=? AND k.enabled=1`)
        .get(keyId, providerId) as any
      if (!key) return reply.code(404).send({ error: "key not found" })
      if (key.auth_type !== "apikey" || !key.encrypted_value) return reply.code(400).send({ error: "oauth key has no secret" })

      const secret = decrypt(key.encrypted_value, key.iv)
      if (!secret) return reply.code(400).send({ error: "decrypt failed" })

      const allModels = (db.prepare("SELECT model_id FROM models WHERE provider_id=? AND enabled=1 ORDER BY model_id").all(providerId) as any[]).map(r => r.model_id)

      const result = generateConfig(tool, {
        base_url: key.base_url || "",
        api_key: secret,
        model: modelId,
        models: allModels,
        api_format: key.api_format,
        raw_config_json: key.raw_config_json,
        provider_name: key.provider_name,
        group_name: key.group_name,
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
      keys?: Array<{ provider_id?: string; key_id?: string; model_id?: string; primary?: boolean }>
    }
  }>("/api/batch/execute", async (req, reply) => {
    const user = (req as any).auth as AuthUser
    const tool = String(req.body?.tool || "").trim()
    const serverIds = Array.isArray(req.body?.server_ids) ? req.body!.server_ids!.map(String) : []
    if (!["codex", "claude", "gemini", "opencode"].includes(tool)) return reply.code(400).send({ error: "invalid tool" })
    if (serverIds.length === 0) return reply.code(400).send({ error: "server_ids required" })

    const keyEntries: Array<{ providerId: string; keyId: string; modelId: string; primary?: boolean }> = []
    if (Array.isArray(req.body?.keys) && req.body!.keys.length > 0 && tool === "opencode") {
      for (const k of req.body!.keys) {
        const pid = String(k?.provider_id || "").trim()
        const kid = String(k?.key_id || "").trim()
        const mid = String(k?.model_id || "").trim()
        if (!pid || !kid || !mid) return reply.code(400).send({ error: "each key entry requires provider_id, key_id, model_id" })
        keyEntries.push({ providerId: pid, keyId: kid, modelId: mid, primary: Boolean(k?.primary) })
      }
    } else {
      const providerId = String(req.body?.provider_id || "").trim()
      const keyId = String(req.body?.key_id || "").trim()
      const modelId = String(req.body?.model_id || "").trim()
      if (!providerId || !keyId || !modelId) return reply.code(400).send({ error: "provider_id, key_id and model_id are required" })
      keyEntries.push({ providerId, keyId, modelId })
    }

    // ponytail (BUG-01): execute must NOT generate config here. Preview already
    // ran a full generateConfig for the UI; execute only stores provider refs
    // in each agent_task's encrypted_payload. Materialization happens on push/
    // claim inside materializeTaskPayload so plaintext never lands in DB.
    // Still validate that every ref resolves to an enabled apikey (so the
    // execute API fails fast on obviously-broken references without leaking
    // secrets); we don't decrypt or generate anything here.
    for (const ke of keyEntries) {
      const meta = db
        .prepare(`SELECT k.auth_type, k.encrypted_value
                  FROM provider_keys k
                  WHERE k.id=? AND k.provider_id=? AND k.enabled=1`)
        .get(ke.keyId, ke.providerId) as any
      if (!meta) return reply.code(404).send({ error: `key ${ke.keyId} not found` })
      if (meta.auth_type !== "apikey" || !meta.encrypted_value) return reply.code(400).send({ error: "oauth key has no secret" })
    }
    const sourceRef = keyEntries.map((ke) => `${ke.providerId}/${ke.keyId}/${ke.modelId}`).join(",")

    const batchId = crypto.randomUUID()
    const now = Date.now()
    const progress: any[] = []
    // ponytail (BUG-04, BUG-09): insert every write_config in the same
    // transaction as batch_jobs. Only after COMMIT do we dispatch to the
    // agents. Old code called createAgentTask inside BEGIN, which pushed
    // over WS before the row was committed; if COMMIT then rolled back the
    // agent had already executed a remote write with no record on our side.
    const insertedIds: string[] = []
    db.exec("BEGIN")
    try {
      for (const sid of serverIds) {
        const server = db.prepare("SELECT name FROM servers WHERE id=?").get(sid) as any
        if (!server) continue
        const providerRefs = {
          tool,
          source: "provider_refs" as const,
          entries: keyEntries.map((ke) => ({
            provider_id: ke.providerId,
            key_id: ke.keyId,
            model_id: ke.modelId,
            primary: ke.primary,
          })),
        }
        const safePlaceholder = { tool, source: "provider_refs", redacted: true }
        const task = insertAgentTask(sid, user.id, "write_config", safePlaceholder, {
          sensitivePayload: providerRefs,
          auditMeta: {
            tool,
            provider_ids: keyEntries.map((k) => k.providerId),
            key_ids: keyEntries.map((k) => k.keyId),
            model_ids: keyEntries.map((k) => k.modelId),
          },
        })
        insertedIds.push(task.id)
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
    // Post-commit dispatch, one at a time (per-server serializer).
    for (const id of insertedIds) dispatchAgentTask(id)
    broadcastEvent(`batch:${batchId}`, { batch_id: batchId, state: "running", progress })
    return { id: batchId }
  })

  app.get<{ Params: { id: string } }>("/api/batch/:id", async (req, reply) => {
    const job = db.prepare("SELECT * FROM batch_jobs WHERE id=?").get(req.params.id) as any
    if (!job) return reply.code(404).send({ error: "not found" })
    // ponytail (BUG-04): status decides which progress table drives the UI.
    // rolling_back reads rollback_progress_json (restore tasks), everything
    // else reads progress_json (original write tasks).
    const activeJson = job.status === "rolling_back" ? job.rollback_progress_json : job.progress_json
    const progress = JSON.parse(activeJson || "[]") as any[]
    const updated = progress.map((p) => {
      const task = db.prepare("SELECT status,error FROM agent_tasks WHERE id=?").get(p.task_id) as any
      return { ...p, state: task?.status || p.state, error: task?.error }
    })
    // ponytail (BUG-04): empty progress array must not resolve to done. That's
    // how a batch with zero servers or a rollback that produced zero restore
    // tasks used to end up green — every([]) === true. Explicit length guard.
    const allDone = updated.length > 0 && updated.every((p) => p.state === "done" || p.state === "failed")
    if (allDone && (job.status === "running" || job.status === "rolling_back")) {
      const allOk = updated.every((p) => p.state === "done")
      const nextStatus = job.status === "rolling_back" ? (allOk ? "rolled_back" : "partial_rollback") : allOk ? "done" : "partial"
      db.prepare("UPDATE batch_jobs SET status=?, finished_at=? WHERE id=?").run(nextStatus, Date.now(), req.params.id)
    }
    return {
      id: job.id,
      tool: job.tool,
      status: allDone
        ? job.status === "rolling_back"
          ? updated.every((p) => p.state === "done") ? "rolled_back" : "partial_rollback"
          : updated.every((p) => p.state === "done") ? "done" : "partial"
        : job.status,
      progress: updated,
      started_at: job.started_at,
      finished_at: allDone ? Date.now() : null,
    }
  })

  app.post<{ Params: { id: string } }>("/api/batch/:id/rollback", async (req, reply) => {
    const user = (req as any).auth as AuthUser
    const job = db.prepare("SELECT * FROM batch_jobs WHERE id=?").get(req.params.id) as any
    if (!job) return reply.code(404).send({ error: "not found" })

    // ponytail (BUG-04): CAS status transition. Only done/partial can begin
    // rollback. If we're already rolling back, return 202 with the current
    // progress instead of creating a second batch of restore tasks. Any
    // other status is a 409 with an explicit code so the UI can toast it.
    if (job.status === "rolling_back") {
      return reply.code(202).send({ ok: false, code: "rollback_in_progress", rollback_progress: JSON.parse(job.rollback_progress_json || "[]") })
    }
    if (job.status === "rolled_back" || job.status === "partial_rollback" || job.status === "rollback_failed") {
      return reply.code(409).send({ error: "already_rolled_back" })
    }
    if (job.status !== "done" && job.status !== "partial") {
      return reply.code(409).send({ error: "batch_not_finished" })
    }

    const progress = JSON.parse(job.progress_json || "[]") as any[]
    const now = Date.now()

    // ponytail (BUG-04): whole rollback plan is prepared inside a single
    // transaction: CAS status → validate every entry → insert restore tasks
    // → write rollback_progress_json. Dispatch happens after COMMIT so a
    // partial failure doesn't leak agent-side execution.
    const insertedIds: string[] = []
    const rollbackProgress: any[] = []
    db.exec("BEGIN")
    try {
      const cas = db
        .prepare("UPDATE batch_jobs SET status='rolling_back', rollback_started_at=?, finished_at=NULL WHERE id=? AND status IN ('done','partial')")
        .run(now, req.params.id)
      if (cas.changes === 0) {
        db.exec("ROLLBACK")
        return reply.code(409).send({ error: "batch_not_finished" })
      }

      for (const p of progress) {
        const task = db.prepare("SELECT status,result_json FROM agent_tasks WHERE id=?").get(p.task_id) as any
        if (task?.status !== "done") {
          // Not a done write — cancel still-pending writes so a WS backlog
          // flush doesn't push the very write we're trying to roll back.
          // Running writes are left alone (no WS recall).
          if (task?.status === "pending") {
            db.prepare(
              "UPDATE agent_tasks SET status='failed', error='cancelled by batch rollback', finished_at=? WHERE id=? AND status='pending'"
            ).run(Date.now(), p.task_id)
            broadcastEvent(`server:${p.server_id}:tasks`, { task_id: p.task_id, status: "failed" })
          }
          rollbackProgress.push({ server_id: p.server_id, server_name: p.server_name, task_id: null, state: "skipped", error: "original write did not complete", backup: null })
          continue
        }
        // ponytail (BUG-04): backup must be an exact, in-batch backup name.
        // Never fall back to "mtime latest" — a rollback that restored some
        // other tool's backup would silently overwrite live config.
        let backupName = ""
        try {
          if (task?.result_json) backupName = String(JSON.parse(task.result_json).backup ?? "")
        } catch {}
        if (!backupName) {
          rollbackProgress.push({ server_id: p.server_id, server_name: p.server_name, task_id: null, state: "failed", error: "no precise backup name recorded", backup: null })
          continue
        }
        const restore = insertAgentTask(p.server_id, user.id, "restore_config_backup", { tool: job.tool, backup: backupName }, {
          auditMeta: { tool: job.tool, backup: backupName, batch_id: req.params.id },
        })
        insertedIds.push(restore.id)
        rollbackProgress.push({ server_id: p.server_id, server_name: p.server_name, task_id: restore.id, state: "pending", error: null, backup: backupName })
      }

      db.prepare("UPDATE batch_jobs SET rollback_progress_json=? WHERE id=?").run(JSON.stringify(rollbackProgress), req.params.id)
      audit(user.id, "batch.rollback", `batch:${req.params.id}`, null, { count: rollbackProgress.length, restore_tasks: insertedIds.length })
      db.exec("COMMIT")
    } catch (e) {
      db.exec("ROLLBACK")
      throw e
    }

    // ponytail (BUG-04): if the rollback produced zero restore tasks, don't
    // leave the batch dangling in rolling_back with an empty progress array.
    // Mark partial_rollback directly (every([]) would otherwise coerce to
    // rolled_back on the next GET, hiding the failure).
    if (insertedIds.length === 0) {
      db.prepare("UPDATE batch_jobs SET status='partial_rollback', finished_at=? WHERE id=?").run(Date.now(), req.params.id)
      broadcastEvent(`batch:${req.params.id}`, { batch_id: req.params.id, state: "partial_rollback", progress: rollbackProgress })
      return { ok: true, rollback_count: 0, state: "partial_rollback" }
    }

    for (const id of insertedIds) dispatchAgentTask(id)
    broadcastEvent(`batch:${req.params.id}`, { batch_id: req.params.id, state: "rolling_back", progress: rollbackProgress })
    return { ok: true, rollback_count: insertedIds.length }
  })
}
