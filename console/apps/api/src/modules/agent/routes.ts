import type { FastifyInstance } from "fastify"
import crypto from "node:crypto"
import { db } from "../../core/db"
import { encrypt, decrypt, hashToken, b64url, sha256Hex } from "../../core/crypto"
import { AGENT_ACTIONS } from "../../core/constants"
import { audit } from "../../core/audit"
import { currentRequestId } from "../../core/context"
import { authFromRequest } from "../../middleware/auth"
import { consumeWsTicket } from "../auth/routes"
import type { AuthUser } from "../../core/constants"
import { generateConfig, mergeOpenCodeConfig, withOpenAiV1 } from "../../core/config"
import path from "node:path"
import fs from "node:fs"
import { LINUX_INSTALL_SH } from "./installSh"

export const onlineAgents = new Map<string, { ws: any; lastHeartbeat: number }>()
const browserSockets = new Set<any>()

function isWebSocketLike(value: any): boolean {
  return Boolean(value && typeof value.on === "function" && typeof value.send === "function" && typeof value.close === "function")
}

function resolveWebSocketArgs(first: any, second: any): { socket: any; req: any } {
  if (isWebSocketLike(first)) return { socket: first, req: second }
  return { socket: second, req: first }
}

export function broadcastEvent(channel: string, payload: unknown) {
  const msg = JSON.stringify({ type: "event", channel, payload })
  for (const socket of browserSockets) {
    if (socket.readyState !== 1) continue
    if (!socket.subscriptions?.has(channel)) continue
    try { socket.send(msg) } catch {}
  }
}

export function handleHeartbeat(serverId: string, body: { status?: string; host?: string; tools?: any[]; version?: string; protocol_version?: number }) {
  const now = Date.now()
  // ponytail (BUG-05, 2.0 hard cutover): protocol MUST be 2. Heartbeat is
  // the first message every online cycle; refusing here catches any legacy
  // agent that snuck through the WS/REST auth (which itself refuses missing
  // Authorization but doesn't know about the protocol yet).
  const proto = typeof body.protocol_version === "number" ? body.protocol_version : 0
  if (proto !== 2) throw new Error("agent protocol 2 required")

  if (body.version) {
    db.prepare("UPDATE servers SET status=?, host=COALESCE(?,host), last_seen=?, agent_version=?, agent_protocol_version=? WHERE id=?").run(
      body.status ? String(body.status) : "online",
      body.host ? String(body.host) : null,
      now,
      String(body.version),
      proto,
      serverId
    )
  } else {
    db.prepare("UPDATE servers SET status=?, host=COALESCE(?,host), last_seen=?, agent_protocol_version=? WHERE id=?").run(
      body.status ? String(body.status) : "online",
      body.host ? String(body.host) : null,
      now,
      proto,
      serverId
    )
  }
  for (const tool of body.tools || []) {
    const toolName = String(tool.name || "").trim()
    if (!toolName) continue
    db.prepare(
      `INSERT INTO tools(server_id,name,installed,version,path,detected_at)
       VALUES(?,?,?,?,?,?)
       ON CONFLICT(server_id,name) DO UPDATE SET installed=excluded.installed,version=excluded.version,path=excluded.path,detected_at=excluded.detected_at`
    ).run(serverId, toolName, tool.installed === false || tool.installed === 0 ? 0 : 1, tool.version || null, tool.path || null, now)
  }
  broadcastEvent("servers:status", { server_id: serverId, status: body.status || "online", last_seen: now })
}

export function handleTaskResult(serverId: string, taskId: string, nonce: string, body: { ok?: boolean; result?: any; error?: string }): { ok: boolean; code?: string } {
  // ponytail (BUG-05, protocol 2): nonce is mandatory. SELECT+UPDATE both
  // filter on status='running' AND nonce=?, so a stale claim's late result
  // can't complete a task that was reaped and re-dispatched under a new
  // nonce. 2.0 hard cutover — no back-compat path for missing nonce.
  if (!nonce) return { ok: false, code: "nonce_required" }
  const task = db.prepare("SELECT * FROM agent_tasks WHERE id=? AND server_id=? AND status='running' AND nonce=?").get(taskId, serverId, nonce) as any
  if (!task) return { ok: false, code: "stale_task_lease" }
  const now = Date.now()
  const ok = body.ok !== false
  const rawResult = body.result || null

  // ponytail (BUG-01): scrub write_config.content BEFORE it is persisted to
  // result_json. Old agents may still return the full generated config in
  // result.content; we accept it for the sha256 fingerprint but never
  // materialize it into DB storage. Reads are handled below (encrypted into
  // configs.encrypted_content, plaintext replaced with a placeholder).
  const persistedResult: Record<string, unknown> = rawResult && typeof rawResult === "object" ? { ...rawResult } : {}
  let readPlaintext: string | null = null
  let readSha256: string | null = null
  if (ok && rawResult && typeof rawResult === "object") {
    if (task.action === "write_config") {
      if (typeof rawResult.content === "string") {
        persistedResult.content_sha256 = persistedResult.content_sha256 || sha256Hex(rawResult.content)
      }
      delete persistedResult.content
    } else if (task.action === "read_config" || task.action === "restore_config_backup") {
      if (typeof rawResult.content === "string") {
        const plaintext: string = rawResult.content
        readPlaintext = plaintext
        readSha256 = sha256Hex(plaintext)
        persistedResult.content_sha256 = readSha256
      }
      delete persistedResult.content
    }
  }

  const res = db
    .prepare("UPDATE agent_tasks SET status=?, result_json=?, error=?, finished_at=? WHERE id=? AND status='running' AND nonce=?")
    .run(
      ok ? "done" : "failed",
      rawResult ? JSON.stringify(persistedResult) : null,
      ok ? null : String(body.error || "task failed"),
      now,
      task.id,
      nonce
    )
  if (res.changes === 0) return { ok: false, code: "stale_task_lease" }   // 已终态/被回收——不插 configs
  if (ok && ["read_config", "restore_config_backup"].includes(task.action) && readPlaintext !== null) {
    const payload = JSON.parse(task.payload_json || "{}")
    const tool = String(payload.tool || "codex")
    const latest = db.prepare("SELECT MAX(version) AS v FROM configs WHERE server_id=? AND tool=?").get(serverId, tool) as any
    // ponytail (BUG-01): plaintext of user CLI configs may contain secrets
    // (opencode.json has apiKey inline). We store the encrypted body plus a
    // sha256 fingerprint; the content column keeps a stable placeholder so
    // legacy readers see it's redacted, not empty.
    const { encryptedValue, iv } = encrypt(readPlaintext)
    db.prepare(
      "INSERT INTO configs(server_id,tool,format,content,version,source,updated_by,updated_at,encrypted_content,encrypted_content_iv,content_sha256) VALUES(?,?,?,?,?,?,?,?,?,?,?)"
    ).run(
      serverId,
      tool,
      rawResult.format || payload.format || "text",
      "[ENCRYPTED]",
      Number(latest?.v || 0) + 1,
      task.action === "restore_config_backup" ? "agent_restore" : "agent_read",
      task.created_by || null,
      now,
      encryptedValue,
      iv,
      readSha256
    )
  }
  if (ok && task.action === "detect_tools" && Array.isArray(rawResult?.tools)) {
    for (const tool of rawResult.tools) {
      const toolName = String(tool.name || "").trim()
      if (!toolName) continue
      db.prepare(
        `INSERT INTO tools(server_id,name,installed,version,path,detected_at)
         VALUES(?,?,?,?,?,?)
         ON CONFLICT(server_id,name) DO UPDATE SET installed=excluded.installed,version=excluded.version,path=excluded.path,detected_at=excluded.detected_at`
      ).run(serverId, toolName, tool.installed === false || tool.installed === 0 ? 0 : 1, tool.version || null, tool.path || null, now)
    }
  }
  if (ok && task.action === "upgrade_tool" && rawResult) {
    const payload = JSON.parse(task.payload_json || "{}")
    const tool = String(payload.tool || "codex")
    if (rawResult.new_version) {
      db.prepare("UPDATE tools SET version=?, detected_at=? WHERE server_id=? AND name=?").run(
        String(rawResult.new_version).slice(0, 120), now, serverId, tool
      )
    }
  }
  if (ok && task.action === "upgrade_agent") {
    const v = rawResult?.new_version ? String(rawResult.new_version).slice(0, 120) : null
    if (v) {
      db.prepare("UPDATE servers SET agent_version=?, last_seen=? WHERE id=?").run(v, now, serverId)
    }
  }
  broadcastEvent(`server:${serverId}:tasks`, { task_id: taskId, status: ok ? "done" : "failed" })
  broadcastBatchProgressForTask(taskId)
  // ponytail (BUG-05): terminating a running task frees up the per-server
  // dispatch slot. Drain one more pending row so we honour "one running task
  // per server" without waiting for the next external event.
  dispatchNextTask(serverId)
  return { ok: true }
}

// ponytail (BUG-05): serialize dispatch. Console keeps at most one running
// task per server, so an Agent's single-worker queue (see agent.go
// cmdQueue) never has to fight over ordering. If a task is already
// running we skip; the completion path in handleTaskResult / reaper /
// WS reconnect all call dispatchNextTask again.
export function dispatchNextTask(serverId: string) {
  const running = db.prepare("SELECT id FROM agent_tasks WHERE server_id=? AND status='running' LIMIT 1").get(serverId)
  if (running) return
  const next = db
    .prepare("SELECT id, action, payload_json, encrypted_payload, encrypted_payload_iv FROM agent_tasks WHERE server_id=? AND status='pending' ORDER BY created_at LIMIT 1")
    .get(serverId) as any
  if (!next) return
  pushTaskToAgent(serverId, next)
}

export function renewTaskLease(serverId: string, taskId: string, nonce: string): { ok: boolean; expires_at?: number; code?: string } {
  if (!nonce) return { ok: false, code: "nonce_required" }
  const expiresAt = Date.now() + 2 * 60 * 1000
  const res = db
    .prepare("UPDATE agent_tasks SET expires_at=? WHERE id=? AND server_id=? AND status='running' AND nonce=?")
    .run(expiresAt, taskId, serverId, nonce)
  if (res.changes === 0) return { ok: false, code: "stale_task_lease" }
  return { ok: true, expires_at: expiresAt }
}

export function broadcastBatchProgressForTask(taskId: string) {
  // ponytail (BUG-04): rollback lives in a separate column now. Fetch both
  // progress arrays; running batches read progress_json, rolling_back reads
  // rollback_progress_json. Never coalesce empty progress into rolled_back.
  const batches = db.prepare("SELECT id,progress_json,rollback_progress_json,status FROM batch_jobs WHERE status IN ('running','rolling_back')").all() as any[]
  for (const job of batches) {
    const activeJson = job.status === "rolling_back" ? job.rollback_progress_json : job.progress_json
    let progress: any[]
    try { progress = JSON.parse(activeJson || "[]") } catch { continue }
    if (!progress.some((p) => p.task_id === taskId)) continue
    const updated = progress.map((p) => {
      if (!p.task_id) return p
      const t = db.prepare("SELECT status,error FROM agent_tasks WHERE id=?").get(p.task_id) as any
      return { ...p, state: t?.status || p.state, error: t?.error }
    })
    // ponytail (BUG-04): explicit non-empty guard.
    const allDone = updated.length > 0 && updated.every((p) => p.state === "done" || p.state === "failed" || p.state === "skipped")
    if (allDone && (job.status === "running" || job.status === "rolling_back")) {
      const allOk = updated.every((p) => p.state === "done")
      const nextStatus = job.status === "rolling_back" ? (allOk ? "rolled_back" : "partial_rollback") : allOk ? "done" : "partial"
      db.prepare("UPDATE batch_jobs SET status=?, finished_at=? WHERE id=?").run(nextStatus, Date.now(), job.id)
    }
    broadcastEvent(`batch:${job.id}`, {
      batch_id: job.id,
      state: allDone
        ? job.status === "rolling_back"
          ? updated.every((p) => p.state === "done") ? "rolled_back" : "partial_rollback"
          : updated.every((p) => p.state === "done") ? "done" : "partial"
        : job.status,
      progress: updated,
    })
  }
}

function materializeTaskPayload(action: string, payloadJson: string, encryptedPayload: string | null, encryptedPayloadIv: string | null) {
  // ponytail (BUG-01): sensitive rows keep only a redacted marker in
  // payload_json ({tool,source,redacted:true}). Real payload lives in
  // encrypted_payload/encrypted_payload_iv and is decrypted here on push/claim.
  // Encrypted_manual: admin-provided config content that has no provider ref;
  // provider_refs: {tool, source:'provider_refs', entries:[{provider_id, key_id,
  // model_id, primary?}]} — we generate the final config on demand so plaintext
  // never lands in agent_tasks.payload_json / result_json / audit_log.
  if (encryptedPayload && encryptedPayloadIv) {
    const decrypted = decrypt(encryptedPayload, encryptedPayloadIv)
    if (!decrypted) throw new Error("decrypt failed for sensitive task payload")
    const inner = JSON.parse(decrypted)
    return materializeInnerPayload(action, inner)
  }

  const payload = JSON.parse(payloadJson || "{}")
  return materializeInnerPayload(action, payload)
}

function materializeInnerPayload(action: string, payload: any): any {
  if (action === "remove_credential") {
    const tool = String(payload.tool || "").trim()
    const providerId = payload.provider_id ? String(payload.provider_id).trim() : null
    const keyId = payload.key_id ? String(payload.key_id).trim() : null
    const envKeys: string[] = []
    if (tool === "claude") envKeys.push("ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL")
    else if (tool === "codex") envKeys.push("OPENAI_API_KEY", "OPENAI_BASE_URL")
    else if (tool === "gemini") envKeys.push("GEMINI_API_KEY", "GOOGLE_GEMINI_BASE_URL")
    return { tool, provider_id: providerId, key_id: keyId, env_keys_to_remove: envKeys }
  }

  if (action === "write_config" && payload && payload.source === "provider_refs") {
    return materializeProviderRefs(payload)
  }

  if (action === "set_credential") {
    const tool = String(payload.tool || "").trim()
    const providerId = String(payload.provider_id || "").trim()
    const keyId = String(payload.key_id || "").trim()
    if (!["codex", "claude", "gemini", "opencode"].includes(tool)) throw new Error("unsupported tool for credential delivery")
    if (!providerId || !keyId) throw new Error("provider_id and key_id are required")

    const key = db
      .prepare(`SELECT k.encrypted_value, k.iv, k.api_format, k.group_name, p.base_url, p.name AS provider_name
                FROM provider_keys k JOIN providers p ON p.id=k.provider_id
                WHERE k.id=? AND k.provider_id=? AND k.enabled=1`)
      .get(keyId, providerId) as any
    if (!key) throw new Error("key not found")
    if (!key.encrypted_value) throw new Error("oauth key has no secret")

    const secret = decrypt(key.encrypted_value, key.iv)
    if (!secret) throw new Error("decrypt failed")

    const baseUrl = String(key.base_url || "").replace(/\/+$/, "")
    const credentials: Record<string, string> = {}
    if (tool === "claude") {
      credentials["ANTHROPIC_AUTH_TOKEN"] = secret
      credentials["ANTHROPIC_BASE_URL"] = baseUrl
    } else if (tool === "codex") {
      // ponytail: codex key goes to ~/.codex/auth.json (agent writes it).
      // No OPENAI_BASE_URL env var - base_url is in config.toml. Env-free.
      credentials["OPENAI_API_KEY"] = secret
    } else if (tool === "gemini") {
      credentials["GEMINI_API_KEY"] = secret
      credentials["GOOGLE_GEMINI_BASE_URL"] = baseUrl
    } else if (tool === "opencode") {
      // ponytail: opencode reads ~/.config/opencode/opencode.json, NOT env vars.
      // Credentials travel via write_config (opencode.json has apiKey in
      // provider.options). set_credential env exports were useless. No-op here.
    }
    return { tool, credentials }
  }

  return payload
}

function materializeProviderRefs(payload: any): any {
  const tool = String(payload.tool || "").trim()
  if (!["codex", "claude", "gemini", "opencode"].includes(tool)) throw new Error("unsupported tool for provider_refs")
  const entries: Array<{ provider_id: string; key_id: string; model_id: string; primary?: boolean }> = Array.isArray(payload.entries) ? payload.entries : []
  if (entries.length === 0) throw new Error("provider_refs entries are required")

  const resolved = entries.map((e) => {
    const providerId = String(e.provider_id || "").trim()
    const keyId = String(e.key_id || "").trim()
    const modelId = String(e.model_id || "").trim()
    if (!providerId || !keyId || !modelId) throw new Error("provider_refs entry missing provider_id/key_id/model_id")
    const key = db
      .prepare(`SELECT k.encrypted_value, k.iv, k.api_format, k.auth_type, k.raw_config_json, k.group_name,
                p.base_url, p.name AS provider_name
                FROM provider_keys k JOIN providers p ON p.id=k.provider_id
                WHERE k.id=? AND k.provider_id=? AND k.enabled=1`)
      .get(keyId, providerId) as any
    if (!key) throw new Error(`key ${keyId} not found`)
    if (key.auth_type !== "apikey" || !key.encrypted_value) throw new Error("oauth key has no secret")
    const secret = decrypt(key.encrypted_value, key.iv)
    if (!secret) throw new Error("decrypt failed")
    const models = (db.prepare("SELECT model_id FROM models WHERE provider_id=? AND enabled=1 ORDER BY model_id").all(providerId) as any[]).map((r) => r.model_id)
    return { entry: e, key, secret, models, modelId, providerId, keyId }
  })

  if (tool === "opencode" && resolved.length > 1) {
    const sorted = [...resolved].sort((a, b) => (b.entry.primary ? 1 : 0) - (a.entry.primary ? 1 : 0))
    const built = sorted.map((r) => {
      const baseUrl = String(r.key.base_url || "").replace(/\/+$/, "")
      const providerLabel = r.key.provider_name || "provider"
      const groupLabel = r.key.group_name ? `_${r.key.group_name}` : ""
      const derivedId = `${providerLabel}${groupLabel}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "provider"
      return {
        providerId: derivedId,
        providerLabel,
        openAiBaseUrl: withOpenAiV1(baseUrl),
        apiKey: r.secret,
        model: r.modelId,
        models: r.models,
        apiFormat: r.key.api_format,
      }
    })
    const merged = mergeOpenCodeConfig(built)
    return { tool, format: "json", content: JSON.stringify(merged, null, 2) }
  }

  const single = resolved[0]
  const generated = generateConfig(tool, {
    base_url: single.key.base_url || "",
    api_key: single.secret,
    model: single.modelId,
    models: single.models,
    api_format: single.key.api_format,
    raw_config_json: single.key.raw_config_json,
    provider_name: single.key.provider_name,
    group_name: single.key.group_name,
  })
  return { tool, format: generated.format, content: generated.content }
}

function pushTaskToAgent(serverId: string, task: { id: string; action: string; payload_json: string; encrypted_payload: string | null; encrypted_payload_iv: string | null }): boolean {
  const agent = onlineAgents.get(serverId)
  if (!agent || agent.ws.readyState !== 1) return false
  // ponytail (BUG-05): serial dispatch guard. If another task is already
  // running on this server we must not claim a second one — the Agent's
  // single-worker queue would still execute both, but the ordering guarantee
  // and the "one running per server" invariant would silently break. The
  // caller (dispatchNextTask) already checks, but re-check here for callers
  // that don't (WS backlog flush, batch execute code path).
  const running = db.prepare("SELECT id FROM agent_tasks WHERE server_id=? AND status='running' LIMIT 1").get(serverId)
  if (running) return false
  let payload: any
  try {
    payload = materializeTaskPayload(task.action, task.payload_json, task.encrypted_payload, task.encrypted_payload_iv)
  } catch (e: any) {
    db.prepare("UPDATE agent_tasks SET status='failed', error=?, finished_at=? WHERE id=?").run(e?.message || String(e), Date.now(), task.id)
    broadcastEvent(`server:${serverId}:tasks`, { task_id: task.id, status: "failed" })
    return false
  }
  const nonce = crypto.randomUUID()
  const expiresAt = Date.now() + 5 * 60 * 1000
  const claimed = db
    .prepare("UPDATE agent_tasks SET status='running', claimed_at=?, nonce=?, expires_at=?, attempt_count=attempt_count+1 WHERE id=? AND status='pending'")
    .run(Date.now(), nonce, expiresAt, task.id)
  if (!claimed.changes) return false
  try {
    agent.ws.send(JSON.stringify({
      type: "cmd",
      id: task.id,
      action: task.action,
      nonce,
      expires_at: expiresAt,
      ts: Date.now(),
      payload,
    }))
    return true
  } catch {
    db.prepare("UPDATE agent_tasks SET status='pending', claimed_at=NULL, nonce=NULL, expires_at=NULL WHERE id=? AND status='running'").run(task.id)
    onlineAgents.delete(serverId)
    return false
  }
}

// ponytail (BUG-04, BUG-09): expose insert+dispatch as separate steps so
// callers can build a batch of tasks inside a SQLite transaction and only
// hand them to the Agent once the transaction has committed. The legacy
// createAgentTask wraps both for single-task call sites (unchanged behavior).
export function insertAgentTask(
  serverId: string,
  userId: string,
  action: string,
  payload: unknown,
  opts?: { sensitivePayload?: unknown; auditMeta?: Record<string, unknown> }
): { id: string; payload_json: string; encrypted_payload: string | null; encrypted_payload_iv: string | null } {
  if (!(AGENT_ACTIONS as readonly string[]).includes(action)) {
    throw new Error(`unknown agent action: ${action}`)
  }
  const id = crypto.randomUUID()
  const payloadJson = JSON.stringify(payload)
  const requestId = currentRequestId()

  let encryptedPayload: string | null = null
  let encryptedPayloadIv: string | null = null
  if (opts?.sensitivePayload) {
    const enc = encrypt(JSON.stringify(opts.sensitivePayload))
    encryptedPayload = enc.encryptedValue
    encryptedPayloadIv = enc.iv
  }

  db.prepare(
    "INSERT INTO agent_tasks(id,server_id,action,payload_json,status,created_by,created_at,request_id,encrypted_payload,encrypted_payload_iv) VALUES(?,?,?,?,?,?,?,?,?,?)"
  ).run(id, serverId, action, payloadJson, "pending", userId, Date.now(), requestId, encryptedPayload, encryptedPayloadIv)

  const auditAfter: Record<string, unknown> = {
    server_id: serverId,
    action,
    sensitive: Boolean(opts?.sensitivePayload),
    ...(opts?.auditMeta || {}),
  }
  audit(userId, "agent_task.create", `agent_task:${id}`, null, auditAfter)

  return { id, payload_json: payloadJson, encrypted_payload: encryptedPayload, encrypted_payload_iv: encryptedPayloadIv }
}

export function dispatchAgentTask(taskId: string): boolean {
  const row = db.prepare("SELECT id, server_id, action, payload_json, encrypted_payload, encrypted_payload_iv FROM agent_tasks WHERE id=? AND status='pending'").get(taskId) as any
  if (!row) return false
  // Respect per-server single-task invariant (BUG-05).
  const running = db.prepare("SELECT id FROM agent_tasks WHERE server_id=? AND status='running' LIMIT 1").get(row.server_id)
  if (running) return false
  return pushTaskToAgent(row.server_id, row)
}

export function createAgentTask(
  serverId: string,
  userId: string,
  action: string,
  payload: unknown,
  opts?: { sensitivePayload?: unknown; auditMeta?: Record<string, unknown> }
) {
  const inserted = insertAgentTask(serverId, userId, action, payload, opts)
  const pushed = dispatchAgentTask(inserted.id)
  return { id: inserted.id, action, payload_json: inserted.payload_json, status: pushed ? "running" : "pending" }
}

function agentServerFromRequest(req: any): { id: string } | null {
  const auth = String(req.headers.authorization || "")
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : ""
  return token ? (db.prepare("SELECT id FROM servers WHERE agent_token_hash=?").get(hashToken(token)) as any) : null
}

export function registerAgentRoutes(app: FastifyInstance) {
  app.post<{ Body: { name?: string; tags?: string[]; expires_minutes?: number; mode?: string; target_server_id?: string } }>(
    "/api/agent/enroll-tokens",
    async (req) => {
      const user = (req as any).auth as AuthUser
      const mode = String(req.body?.mode || "new").trim()
      if (mode !== "new" && mode !== "replace") throw new Error("mode must be 'new' or 'replace'")
      let targetServerId: string | null = null
      if (mode === "replace") {
        targetServerId = String(req.body?.target_server_id || "").trim()
        if (!targetServerId) throw new Error("target_server_id is required for replace mode")
        const target = db.prepare("SELECT id FROM servers WHERE id=?").get(targetServerId)
        if (!target) throw new Error("target server not found")
      }
      const token = b64url(crypto.randomBytes(32))
      const id = crypto.randomUUID()
      const now = Date.now()
      const expiresAt = now + Math.max(1, Math.min(Number(req.body?.expires_minutes || 15), 1440)) * 60 * 1000
      const tags = Array.isArray(req.body?.tags) ? req.body.tags.map(String) : []
      db.prepare(
        `INSERT INTO agent_enroll_tokens(id,token_hash,name,tags,expires_at,created_by,created_at,target_server_id,enroll_mode)
         VALUES(?,?,?,?,?,?,?,?,?)`
      ).run(id, hashToken(token), req.body?.name ? String(req.body.name).trim() : null, JSON.stringify(tags), expiresAt, user.id, now, targetServerId, mode)
      audit(user.id, "agent.enroll_token.create", `agent_enroll_token:${id}`, null, { name: req.body?.name || null, expires_at: expiresAt, mode, target_server_id: targetServerId })
      return { token, expires_at: expiresAt, mode, target_server_id: targetServerId }
    }
  )

  app.get("/agent/uninstall.sh", async (_req, reply) => {
    return reply.type("text/x-shellscript").send(`#!/bin/sh
# AI Console Agent uninstaller for Linux/macOS
# Removes both Go agent and old shell agent.
set -eu

DIR="$HOME/.ai-console-agent"

echo "Stopping services..."

# Go agent: systemd user service
if [ "\$(uname -s)" = "Linux" ] && command -v systemctl >/dev/null 2>&1; then
  systemctl --user stop ai-console-agent 2>/dev/null || true
  systemctl --user disable ai-console-agent 2>/dev/null || true
  rm -f "$HOME/.config/systemd/user/ai-console-agent.service"
  systemctl --user daemon-reload 2>/dev/null || true
  echo "  systemd service removed"
fi

# Go agent: macOS launchd
if [ "\$(uname -s)" = "Darwin" ] && command -v launchctl >/dev/null 2>&1; then
  launchctl unload "$HOME/Library/LaunchAgents/com.ai-console.agent.plist" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/com.ai-console.agent.plist"
  echo "  launchd service removed"
fi

# Old shell agent: crontab
if command -v crontab >/dev/null 2>&1; then
  (crontab -l 2>/dev/null | grep -v '.ai-console-agent/heartbeat.sh') | crontab - || true
  echo "  crontab entry removed"
fi

# Remove agent directory (bin, env, heartbeat.sh, creds, etc.)
if [ -d "\$DIR" ]; then
  rm -rf "\$DIR"
  echo "  agent directory removed: \$DIR"
fi

echo ""
echo "Agent uninstalled successfully."
echo "Your CLI tools (codex/claude/gemini/opencode) and their configs are NOT touched."
`)
  })

  app.get("/agent/install.sh", async (_req, reply) => {
    return reply.type("text/x-shellscript").send(LINUX_INSTALL_SH)
  })

  const readAgentManifest = () => {
    const manifestPath = path.resolve(new URL("../../../../../agent-dist", import.meta.url).pathname, "manifest.json")
    return JSON.parse(fs.readFileSync(manifestPath, "utf8"))
  }

  app.get("/agent/manifest.json", async (_req, reply) => {
    try {
      return reply.send(readAgentManifest())
    } catch {
      return reply.code(404).send({ error: "agent manifest not found" })
    }
  })

  app.get("/api/agent/manifest", async (_req, reply) => {
    try {
      return reply.send(readAgentManifest())
    } catch {
      return reply.code(404).send({ error: "agent manifest not found" })
    }
  })

  app.get<{ Params: { goos: string; goarch: string } }>(
    "/agent/binary/:goos/:goarch",
    async (req, reply) => {
      const { goos, goarch } = req.params
      if (!["linux", "darwin"].includes(goos) || !["amd64", "arm64"].includes(goarch)) {
        return reply.code(400).send({ error: "unsupported platform" })
      }
      const assetName = `ai-agent-${goos}-${goarch}`
      const binaryPath = path.resolve(
        new URL("../../../../../agent-dist", import.meta.url).pathname,
        assetName
      )
      try {
        const data = fs.readFileSync(binaryPath)
        return reply.type("application/octet-stream").send(data)
      } catch (e: any) {
        if (e.code === "ENOENT") {
          return reply.code(404).send({ error: `binary ${assetName} not found` })
        }
        return reply.code(500).send({ error: e.message })
      }
    }
  )

  app.post<{
    Body: {
      token?: string
      hostname?: string
      os?: string
      arch?: string
      host?: string
      version?: string
      protocol_version?: number
      agent_instance_id?: string
      tools?: Array<{ name?: string; installed?: boolean | number; version?: string | null; path?: string | null }>
    }
  }>("/agent/enroll", async (req, reply) => {
    const token = String(req.body?.token || "").trim()
    if (!token) return reply.code(400).send({ error: "token is required" })
    const row = db.prepare("SELECT * FROM agent_enroll_tokens WHERE token_hash=?").get(hashToken(token)) as any
    if (!row || row.used_at || row.expires_at < Date.now()) return reply.code(401).send({ error: "invalid enroll token" })

    // ponytail (BUG-05, 2.0): protocol 2 gate. Refuse to create/update any DB
    // row when the Agent is not on protocol 2 or is missing an instance ID.
    // 426 ("Upgrade Required") is the right shape for "your client must be
    // newer to talk to this server".
    const proto = typeof req.body?.protocol_version === "number" ? req.body.protocol_version : 0
    if (proto !== 2) return reply.code(426).send({ error: "agent protocol 2 required" })
    const instanceId = String(req.body?.agent_instance_id || "").trim()
    if (!instanceId) return reply.code(400).send({ error: "agent_instance_id is required" })

    const agentToken = b64url(crypto.randomBytes(32))
    const now = Date.now()
    const os = req.body?.os ? String(req.body.os) : null
    const host = req.body?.host ? String(req.body.host) : req.body?.hostname ? String(req.body.hostname) : null
    const agentVersion = req.body?.version ? String(req.body.version) : null
    const enrollMode = String(row.enroll_mode || "new")
    const targetServerId = row.target_server_id ? String(row.target_server_id) : null
    const tokenName = row.name ? String(row.name).trim() : ""

    if (enrollMode === "replace") {
      // ponytail (BUG-08): admin-issued replace token — bound to a specific
      // server. Requires the target row to exist; instance_id may differ
      // (reinstall generates a fresh UUID). UNIQUE conflict on instance_id
      // is a 409 (not 500), so operators get a clear error when they picked
      // the wrong replace token.
      if (!targetServerId) return reply.code(400).send({ error: "replace token has no target_server_id" })
      const target = db.prepare("SELECT id, name FROM servers WHERE id=?").get(targetServerId) as any
      if (!target) return reply.code(404).send({ error: "target server not found" })
      const conflict = db.prepare("SELECT id FROM servers WHERE agent_instance_id=? AND id != ?").get(instanceId, targetServerId) as any
      if (conflict) return reply.code(409).send({ error: "agent_instance_id_conflict" })
      const name = String(tokenName || target.name || req.body?.hostname || "unnamed-server").trim()
      db.exec("BEGIN")
      try {
        db.prepare("UPDATE servers SET name=?, os=?, arch=?, host=?, agent_token_hash=?, status='online', last_seen=?, agent_version=?, agent_instance_id=?, agent_protocol_version=? WHERE id=?").run(
          name,
          os,
          req.body?.arch ? String(req.body.arch) : null,
          host,
          hashToken(agentToken),
          now,
          agentVersion,
          instanceId,
          2,
          targetServerId
        )
        for (const tool of req.body?.tools || []) {
          const toolName = String(tool.name || "").trim()
          if (!toolName) continue
          db.prepare(
            `INSERT INTO tools(server_id,name,installed,version,path,detected_at)
             VALUES(?,?,?,?,?,?)
             ON CONFLICT(server_id,name) DO UPDATE SET installed=excluded.installed,version=excluded.version,path=excluded.path,detected_at=excluded.detected_at`
          ).run(targetServerId, toolName, tool.installed === false || tool.installed === 0 ? 0 : 1, tool.version || null, tool.path || null, now)
        }
        db.prepare("UPDATE agent_enroll_tokens SET used_at=? WHERE id=?").run(now, row.id)
        audit(row.created_by || null, "agent.enroll_replace", `server:${targetServerId}`, null, { name, instance_id: instanceId })
        db.exec("COMMIT")
      } catch (e: any) {
        db.exec("ROLLBACK")
        if (String(e?.message || "").includes("UNIQUE") && String(e.message).includes("agent_instance_id")) {
          return reply.code(409).send({ error: "agent_instance_id_conflict" })
        }
        throw e
      }
      // ponytail (BUG-08): close any already-authenticated WS on the target
      // server so the pre-replace agent socket cannot keep receiving tasks.
      const stale = onlineAgents.get(targetServerId)
      if (stale) {
        try { stale.ws.close(4401, "replaced by new enrollment") } catch {}
        onlineAgents.delete(targetServerId)
      }
      return { server_id: targetServerId, agent_token: agentToken }
    }

    // enroll_mode='new': always insert a fresh row. Never reuse a server row
    // by hostname/os fuzz — BUG-08 root cause.
    const conflict = db.prepare("SELECT id FROM servers WHERE agent_instance_id=?").get(instanceId) as any
    if (conflict) return reply.code(409).send({ error: "agent_instance_id_conflict" })
    const serverId = crypto.randomUUID()
    const name = String(tokenName || req.body?.hostname || "unnamed-server").trim()
    db.exec("BEGIN")
    try {
      db.prepare(
        "INSERT INTO servers(id,name,os,arch,host,agent_token_hash,status,last_seen,tags,agent_version,agent_instance_id,agent_protocol_version,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)"
      ).run(
        serverId,
        name,
        os,
        req.body?.arch ? String(req.body.arch) : null,
        host,
        hashToken(agentToken),
        "online",
        now,
        row.tags || "[]",
        agentVersion,
        instanceId,
        2,
        now
      )
      for (const tool of req.body?.tools || []) {
        const toolName = String(tool.name || "").trim()
        if (!toolName) continue
        db.prepare(
          `INSERT INTO tools(server_id,name,installed,version,path,detected_at)
           VALUES(?,?,?,?,?,?)
           ON CONFLICT(server_id,name) DO UPDATE SET installed=excluded.installed,version=excluded.version,path=excluded.path,detected_at=excluded.detected_at`
        ).run(serverId, toolName, tool.installed === false || tool.installed === 0 ? 0 : 1, tool.version || null, tool.path || null, now)
      }
      db.prepare("UPDATE agent_enroll_tokens SET used_at=? WHERE id=?").run(now, row.id)
      audit(row.created_by || null, "agent.enroll", `server:${serverId}`, null, { name, instance_id: instanceId })
      db.exec("COMMIT")
    } catch (e: any) {
      db.exec("ROLLBACK")
      if (String(e?.message || "").includes("UNIQUE") && String(e.message).includes("agent_instance_id")) {
        return reply.code(409).send({ error: "agent_instance_id_conflict" })
      }
      throw e
    }
    return { server_id: serverId, agent_token: agentToken }
  })

  app.post<{
    Body: {
      status?: string
      host?: string
      tools?: Array<{ name?: string; installed?: boolean | number; version?: string | null; path?: string | null }>
      version?: string
      protocol_version?: number
    }
  }>("/agent/heartbeat", async (req, reply) => {
    const server = agentServerFromRequest(req)
    if (!server) return reply.code(401).send({ error: "unauthorized" })
    try {
      handleHeartbeat(server.id, {
        status: req.body?.status ? String(req.body.status) : undefined,
        host: req.body?.host ? String(req.body.host) : undefined,
        tools: req.body?.tools,
        version: req.body?.version ? String(req.body.version) : undefined,
        protocol_version: typeof req.body?.protocol_version === "number" ? req.body.protocol_version : undefined,
      })
    } catch (e: any) {
      return reply.code(426).send({ error: e?.message || "agent protocol 2 required" })
    }
    return { ok: true, ts: Date.now() }
  })

  app.get("/agent/tasks", async (req, reply) => {
    const server = agentServerFromRequest(req)
    if (!server) return reply.code(401).send({ error: "unauthorized" })
    // ponytail (BUG-05): if there's already a running task, this poll must
    // not claim another one — Console serializes dispatch per server. Also
    // block if the last heartbeat / enroll didn't report protocol 2.
    const meta = db.prepare("SELECT agent_protocol_version FROM servers WHERE id=?").get(server.id) as any
    if (!meta || meta.agent_protocol_version !== 2) return reply.code(426).send({ error: "agent protocol 2 required" })
    const already = db.prepare("SELECT id FROM agent_tasks WHERE server_id=? AND status='running' LIMIT 1").get(server.id)
    if (already) return { task: null }

    const task = db
      .prepare("SELECT id,action,payload_json,encrypted_payload,encrypted_payload_iv FROM agent_tasks WHERE server_id=? AND status='pending' ORDER BY created_at LIMIT 1")
      .get(server.id) as any
    if (!task) return { task: null }
    // ponytail (bug 5): REST 认领也要写 nonce + expires_at，否则 reaper 的
    // `WHERE expires_at < ?` 匹配不到 NULL，REST 认领的任务永远卡 running。
    const claimNow = Date.now()
    const nonce = crypto.randomUUID()
    const expiresAt = claimNow + 5 * 60 * 1000
    const claimed = db
      .prepare("UPDATE agent_tasks SET status='running', claimed_at=?, nonce=?, expires_at=?, attempt_count=attempt_count+1 WHERE id=? AND status='pending'")
      .run(claimNow, nonce, expiresAt, task.id)
    if (!claimed.changes) return { task: null }
    try {
      return {
        task: {
          id: task.id,
          action: task.action,
          nonce,
          expires_at: expiresAt,
          payload: materializeTaskPayload(task.action, task.payload_json, task.encrypted_payload, task.encrypted_payload_iv),
        },
      }
    } catch (e: any) {
      db.prepare("UPDATE agent_tasks SET status='failed', error=?, finished_at=? WHERE id=?").run(e?.message || String(e), Date.now(), task.id)
      return { task: null }
    }
  })

  app.post<{ Params: { taskId: string }; Body: { nonce?: string; ok?: boolean; result?: any; error?: string } }>(
    "/agent/tasks/:taskId/result",
    async (req, reply) => {
      const server = agentServerFromRequest(req)
      if (!server) return reply.code(401).send({ error: "unauthorized" })
      // ponytail (BUG-05): 2.0 hard cutover — nonce is mandatory.
      const nonce = String(req.body?.nonce || "").trim()
      const outcome = handleTaskResult(server.id, req.params.taskId, nonce, req.body || {})
      if (!outcome.ok) {
        if (outcome.code === "stale_task_lease") return reply.code(409).send({ error: outcome.code })
        return reply.code(400).send({ error: outcome.code || "task result rejected" })
      }
      return { ok: true }
    }
  )

  app.post<{ Params: { taskId: string }; Body: { nonce?: string } }>(
    "/agent/tasks/:taskId/lease",
    async (req, reply) => {
      const server = agentServerFromRequest(req)
      if (!server) return reply.code(401).send({ error: "unauthorized" })
      const nonce = String(req.body?.nonce || "").trim()
      const out = renewTaskLease(server.id, req.params.taskId, nonce)
      if (!out.ok) {
        if (out.code === "stale_task_lease") return reply.code(409).send({ error: out.code })
        return reply.code(400).send({ error: out.code || "lease renewal rejected" })
      }
      return { ok: true, expires_at: out.expires_at }
    }
  )

  app.get("/agent/ws", { websocket: true } as any, (first: any, second: any) => {
    const { socket, req } = resolveWebSocketArgs(first, second)
    if (!isWebSocketLike(socket) || !req) {
      app.log.warn(
        {
          firstCtor: first?.constructor?.name,
          secondCtor: second?.constructor?.name,
          firstKeys: first ? Object.keys(first) : null,
          secondKeys: second ? Object.keys(second) : null,
        },
        "invalid /agent/ws websocket handler args"
      )
      return
    }

    // ponytail (BUG-05, 2.0): Agent WS auth via Authorization header only.
    // Legacy `?token=` query auth leaked the long-lived agent token into
    // reverse-proxy access logs. Agents in 2.0 must send the header (see
    // agent.go connectWS + Dialer{HTTPHeader}). No back-compat URL fallback.
    const authHeader = String(req.headers?.authorization || "")
    const bearer = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : ""
    if (!bearer) return socket.close(4001, "missing agent token")
    const server = db.prepare("SELECT id, agent_protocol_version FROM servers WHERE agent_token_hash=?").get(hashToken(bearer)) as any
    if (!server) return socket.close(4001, "invalid token")
    if (server.agent_protocol_version !== 2) return socket.close(4426, "agent protocol 2 required")

    const serverId = server.id
    onlineAgents.set(serverId, { ws: socket, lastHeartbeat: Date.now() })

    // Flush backlog created while agent was offline / WS was half-dead.
    // ponytail (BUG-05): dispatchNextTask enforces the per-server single-task
    // invariant; a WS reconnect must not push the whole pending queue in one
    // burst.
    dispatchNextTask(serverId)

    socket.on("message", (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.type === "heartbeat") {
          onlineAgents.set(serverId, { ws: socket, lastHeartbeat: Date.now() })
          try {
            handleHeartbeat(serverId, {
              status: msg.payload?.status,
              host: msg.payload?.host,
              tools: msg.payload?.tools,
              version: msg.payload?.version,
              protocol_version: typeof msg.payload?.protocol_version === "number" ? msg.payload.protocol_version : undefined,
            })
          } catch (e: any) {
            // ponytail (BUG-05): protocol mismatch on heartbeat = kill this
            // connection; agent must upgrade. 4426 mirrors HTTP 426.
            socket.close(4426, e?.message || "agent protocol 2 required")
            return
          }
          socket.send(JSON.stringify({ type: "ack", id: msg.id }))
        } else if (msg.type === "cmd_result") {
          // ponytail (BUG-05): nonce required at top level of the message.
          const nonce = String(msg.nonce || "")
          const outcome = handleTaskResult(serverId, msg.id, nonce, {
            ok: msg.status !== "err",
            result: msg.payload?.result,
            error: msg.payload?.error,
          })
          if (!outcome.ok) {
            socket.send(JSON.stringify({ type: "cmd_result_rejected", id: msg.id, error: outcome.code || "rejected" }))
            return
          }
          socket.send(JSON.stringify({ type: "ack", id: msg.id }))
        } else if (msg.type === "cmd_lease") {
          const out = renewTaskLease(serverId, String(msg.id || ""), String(msg.nonce || ""))
          socket.send(JSON.stringify({ type: "cmd_lease_ack", id: msg.id, ok: out.ok, code: out.code, expires_at: out.expires_at }))
        }
      } catch (e) {
        app.log.warn(`ws message parse error from server ${serverId}: ${(e as Error).message}`)
      }
    })

    socket.on("close", () => {
      // ponytail: only tear down if this socket is still the current one.
      // A reconnect may have already replaced the map entry; an old socket's
      // close firing would otherwise delete the fresh entry and mark online
      // server offline (reconnect race -> "quickly offline").
      const cur = onlineAgents.get(serverId)
      if (cur?.ws === socket) {
        onlineAgents.delete(serverId)
        db.prepare("UPDATE servers SET status='offline' WHERE id=?").run(serverId)
      }
    })

    socket.on("error", () => {
      const cur = onlineAgents.get(serverId)
      if (cur?.ws === socket) onlineAgents.delete(serverId)
    })
  })

  app.get("/api/ws", { websocket: true } as any, (first: any, second: any) => {
    const { socket, req } = resolveWebSocketArgs(first, second)
    if (!isWebSocketLike(socket) || !req) {
      app.log.warn(
        {
          firstCtor: first?.constructor?.name,
          secondCtor: second?.constructor?.name,
          firstKeys: first ? Object.keys(first) : null,
          secondKeys: second ? Object.keys(second) : null,
        },
        "invalid /api/ws websocket handler args"
      )
      return
    }

    // ponytail (bug 21): 优先用单次 30s 票据（?ticket=），不让 15 分钟 access JWT
    // 进 WS URL/访问日志。保留 ?token= 旧分支作灰度（旧 bundle 仍可连）。
    const ticket = String(req.query?.ticket || "")
    const token = String(req.query?.token || "")
    const user: AuthUser | null = ticket
      ? consumeWsTicket(ticket)
      : token
        ? authFromRequest({ headers: { authorization: `Bearer ${token}` } })
        : null
    if (!user) return socket.close(4001, "unauthorized")

    socket.subscriptions = new Set<string>()
    browserSockets.add(socket)

    socket.on("message", (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.type === "subscribe" && msg.channel) {
          socket.subscriptions.add(msg.channel)
        } else if (msg.type === "unsubscribe" && msg.channel) {
          socket.subscriptions.delete(msg.channel)
        }
      } catch {}
    })

    socket.on("close", () => browserSockets.delete(socket))
    socket.on("error", () => browserSockets.delete(socket))
  })
}
