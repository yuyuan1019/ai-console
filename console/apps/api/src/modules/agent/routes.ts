import type { FastifyInstance } from "fastify"
import crypto from "node:crypto"
import { db } from "../../core/db"
import { encrypt, decrypt, hashToken, b64url } from "../../core/crypto"
import { AGENT_ACTIONS } from "../../core/constants"
import { audit } from "../../core/audit"
import { currentRequestId } from "../../core/context"
import { authFromRequest } from "../../middleware/auth"
import type { AuthUser } from "../../core/constants"
import path from "node:path"
import fs from "node:fs"
import { withOpenAiV1 } from "../../core/config"
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

export function handleHeartbeat(serverId: string, body: { status?: string; host?: string; tools?: any[]; version?: string }) {
  const now = Date.now()
  if (body.version) {
    db.prepare("UPDATE servers SET status=?, host=COALESCE(?,host), last_seen=?, agent_version=? WHERE id=?").run(
      body.status ? String(body.status) : "online",
      body.host ? String(body.host) : null,
      now,
      String(body.version),
      serverId
    )
  } else {
    db.prepare("UPDATE servers SET status=?, host=COALESCE(?,host), last_seen=? WHERE id=?").run(
      body.status ? String(body.status) : "online",
      body.host ? String(body.host) : null,
      now,
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

export function handleTaskResult(serverId: string, taskId: string, body: { ok?: boolean; result?: any; error?: string }): boolean {
  const task = db.prepare("SELECT * FROM agent_tasks WHERE id=? AND server_id=?").get(taskId, serverId) as any
  if (!task) return false
  const now = Date.now()
  const ok = body.ok !== false
  const result = body.result || null
  db.prepare("UPDATE agent_tasks SET status=?, result_json=?, error=?, finished_at=? WHERE id=?").run(
    ok ? "done" : "failed",
    result ? JSON.stringify(result) : null,
    ok ? null : String(body.error || "task failed"),
    now,
    task.id
  )
  if (ok && ["read_config", "write_config", "restore_config_backup"].includes(task.action) && result?.content) {
    const payload = JSON.parse(task.payload_json || "{}")
    const tool = String(payload.tool || "codex")
    const latest = db.prepare("SELECT MAX(version) AS v FROM configs WHERE server_id=? AND tool=?").get(serverId, tool) as any
    db.prepare(
      "INSERT INTO configs(server_id,tool,format,content,version,source,updated_by,updated_at) VALUES(?,?,?,?,?,?,?,?)"
    ).run(
      serverId,
      tool,
      result.format || payload.format || "text",
      String(result.content),
      Number(latest?.v || 0) + 1,
      task.action === "write_config" ? "agent_write" : task.action === "restore_config_backup" ? "agent_restore" : "agent_read",
      task.created_by || null,
      now
    )
  }
  if (ok && task.action === "detect_tools" && Array.isArray(result?.tools)) {
    for (const tool of result.tools) {
      const toolName = String(tool.name || "").trim()
      if (!toolName) continue
      db.prepare(
        `INSERT INTO tools(server_id,name,installed,version,path,detected_at)
         VALUES(?,?,?,?,?,?)
         ON CONFLICT(server_id,name) DO UPDATE SET installed=excluded.installed,version=excluded.version,path=excluded.path,detected_at=excluded.detected_at`
      ).run(serverId, toolName, tool.installed === false || tool.installed === 0 ? 0 : 1, tool.version || null, tool.path || null, now)
    }
  }
  if (ok && task.action === "upgrade_tool" && result) {
    const payload = JSON.parse(task.payload_json || "{}")
    const tool = String(payload.tool || "codex")
    if (result.new_version) {
      db.prepare("UPDATE tools SET version=?, detected_at=? WHERE server_id=? AND name=?").run(
        String(result.new_version).slice(0, 120), now, serverId, tool
      )
    }
  }
  if (ok && task.action === "upgrade_agent") {
    const v = result?.new_version ? String(result.new_version).slice(0, 120) : null
    if (v) {
      db.prepare("UPDATE servers SET agent_version=?, last_seen=? WHERE id=?").run(v, now, serverId)
    }
  }
  broadcastEvent(`server:${serverId}:tasks`, { task_id: taskId, status: ok ? "done" : "failed" })
  broadcastBatchProgressForTask(taskId)
  return true
}

function broadcastBatchProgressForTask(taskId: string) {
  const batches = db.prepare("SELECT id,progress_json,status FROM batch_jobs WHERE status IN ('running','rolled_back')").all() as any[]
  for (const job of batches) {
    let progress: any[]
    try { progress = JSON.parse(job.progress_json || "[]") } catch { continue }
    if (!progress.some((p) => p.task_id === taskId)) continue
    const updated = progress.map((p) => {
      const t = db.prepare("SELECT status,error FROM agent_tasks WHERE id=?").get(p.task_id) as any
      return { ...p, state: t?.status || p.state, error: t?.error }
    })
    const allDone = updated.every((p) => p.state === "done" || p.state === "failed")
    if (allDone && job.status === "running") {
      db.prepare("UPDATE batch_jobs SET status=?, finished_at=? WHERE id=?").run(
        updated.every((p) => p.state === "done") ? "done" : "partial",
        Date.now(),
        job.id
      )
    }
    broadcastEvent(`batch:${job.id}`, {
      batch_id: job.id,
      state: allDone ? (updated.every((p) => p.state === "done") ? "done" : "partial") : job.status,
      progress: updated,
    })
  }
}

function materializeTaskPayload(action: string, payloadJson: string) {
  const payload = JSON.parse(payloadJson || "{}")

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

  if (action !== "set_credential") return payload

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
    credentials["OPENAI_API_KEY"] = secret
    credentials["OPENAI_BASE_URL"] = withOpenAiV1(baseUrl)
  } else if (tool === "gemini") {
    credentials["GEMINI_API_KEY"] = secret
    credentials["GOOGLE_GEMINI_BASE_URL"] = baseUrl
  } else if (tool === "opencode") {
    const apiFormat = key.api_format === "anthropic" ? "anthropic" : "openai"
    const models = (db.prepare("SELECT model_id FROM models WHERE provider_id=? AND key_id=?").all(providerId, keyId) as any[])
      .map((m) => String(m.model_id))
    const providerLabel = String(key.provider_name || "").trim()
    const groupLabel = key.group_name ? `_${String(key.group_name).trim()}` : ""
    const providerSid = `${providerLabel}${groupLabel}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "provider"
    credentials["apiKey"] = secret
    credentials["baseURL"] = withOpenAiV1(baseUrl)
    credentials["api_format"] = apiFormat
    credentials["provider_name"] = providerLabel
    credentials["group_name"] = String(key.group_name || "").trim()
    credentials["provider_id"] = providerSid
    credentials["models"] = JSON.stringify(models)
  }
  return { tool, credentials }
}

function pushTaskToAgent(serverId: string, task: { id: string; action: string; payload_json: string }): boolean {
  const agent = onlineAgents.get(serverId)
  if (!agent || agent.ws.readyState !== 1) return false
  let payload: any
  try {
    payload = materializeTaskPayload(task.action, task.payload_json)
  } catch (e: any) {
    db.prepare("UPDATE agent_tasks SET status='failed', error=?, finished_at=? WHERE id=?").run(e?.message || String(e), Date.now(), task.id)
    broadcastEvent(`server:${serverId}:tasks`, { task_id: task.id, status: "failed" })
    return false
  }
  const nonce = crypto.randomUUID()
  const expiresAt = Date.now() + 5 * 60 * 1000
  const claimed = db
    .prepare("UPDATE agent_tasks SET status='running', claimed_at=?, nonce=?, expires_at=? WHERE id=? AND status='pending'")
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

export function createAgentTask(serverId: string, userId: string, action: string, payload: unknown) {
  if (!(AGENT_ACTIONS as readonly string[]).includes(action)) {
    throw new Error(`unknown agent action: ${action}`)
  }
  const id = crypto.randomUUID()
  const payloadJson = JSON.stringify(payload)
  const requestId = currentRequestId()
  db.prepare(
    "INSERT INTO agent_tasks(id,server_id,action,payload_json,status,created_by,created_at,request_id) VALUES(?,?,?,?,?,?,?,?)"
  ).run(id, serverId, action, payloadJson, "pending", userId, Date.now(), requestId)
  audit(userId, "agent_task.create", `agent_task:${id}`, null, { server_id: serverId, action, ...(payload as any) })
  const pushed = pushTaskToAgent(serverId, { id, action, payload_json: payloadJson })
  return { id, action, payload_json: payloadJson, status: pushed ? "running" : "pending" }
}

function agentServerFromRequest(req: any): { id: string } | null {
  const auth = String(req.headers.authorization || "")
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : ""
  return token ? (db.prepare("SELECT id FROM servers WHERE agent_token_hash=?").get(hashToken(token)) as any) : null
}

export function registerAgentRoutes(app: FastifyInstance) {
  app.post<{ Body: { name?: string; tags?: string[]; expires_minutes?: number } }>(
    "/api/agent/enroll-tokens",
    async (req) => {
      const user = (req as any).auth as AuthUser
      const token = b64url(crypto.randomBytes(32))
      const id = crypto.randomUUID()
      const now = Date.now()
      const expiresAt = now + Math.max(1, Math.min(Number(req.body?.expires_minutes || 15), 1440)) * 60 * 1000
      const tags = Array.isArray(req.body?.tags) ? req.body.tags.map(String) : []
      db.prepare(
        `INSERT INTO agent_enroll_tokens(id,token_hash,name,tags,expires_at,created_by,created_at)
         VALUES(?,?,?,?,?,?,?)`
      ).run(id, hashToken(token), req.body?.name ? String(req.body.name).trim() : null, JSON.stringify(tags), expiresAt, user.id, now)
      audit(user.id, "agent.enroll_token.create", `agent_enroll_token:${id}`, null, { name: req.body?.name || null, expires_at: expiresAt })
      return { token, expires_at: expiresAt }
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
      tools?: Array<{ name?: string; installed?: boolean | number; version?: string | null; path?: string | null }>
    }
  }>("/agent/enroll", async (req, reply) => {
    const token = String(req.body?.token || "").trim()
    if (!token) return reply.code(400).send({ error: "token is required" })
    const row = db.prepare("SELECT * FROM agent_enroll_tokens WHERE token_hash=?").get(hashToken(token)) as any
    if (!row || row.used_at || row.expires_at < Date.now()) return reply.code(401).send({ error: "invalid enroll token" })

    const agentToken = b64url(crypto.randomBytes(32))
    const now = Date.now()
    const os = req.body?.os ? String(req.body.os) : null
    const host = req.body?.host ? String(req.body.host) : req.body?.hostname ? String(req.body.hostname) : null
    const agentVersion = req.body?.version ? String(req.body.version) : null
    const existing = host
      ? (db.prepare("SELECT id, name FROM servers WHERE host=? AND COALESCE(os,'')=COALESCE(?, '') ORDER BY last_seen DESC LIMIT 1").get(host, os) as any)
      : null
    const serverId = existing?.id || crypto.randomUUID()
    const tokenName = row.name ? String(row.name).trim() : ""
    const name = String(tokenName || (existing ? existing.name : "") || req.body?.hostname || "unnamed-server").trim()
    db.exec("BEGIN")
    try {
      if (existing) {
        db.prepare("UPDATE servers SET name=?, os=?, arch=?, host=?, agent_token_hash=?, status='online', last_seen=?, tags=?, agent_version=? WHERE id=?").run(
          name,
          os,
          req.body?.arch ? String(req.body.arch) : null,
          host,
          hashToken(agentToken),
          now,
          row.tags || "[]",
          agentVersion,
          serverId
        )
      } else {
        db.prepare(
          "INSERT INTO servers(id,name,os,arch,host,agent_token_hash,status,last_seen,tags,agent_version,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)"
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
          now
        )
      }
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
      audit(row.created_by || null, "agent.enroll", `server:${serverId}`, null, { name, reused: Boolean(existing) })
      db.exec("COMMIT")
    } catch (e) {
      db.exec("ROLLBACK")
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
    }
  }>("/agent/heartbeat", async (req, reply) => {
    const server = agentServerFromRequest(req)
    if (!server) return reply.code(401).send({ error: "unauthorized" })
    handleHeartbeat(server.id, {
      status: req.body?.status ? String(req.body.status) : undefined,
      host: req.body?.host ? String(req.body.host) : undefined,
      tools: req.body?.tools,
      version: req.body?.version ? String(req.body.version) : undefined,
    })
    return { ok: true, ts: Date.now() }
  })

  app.get("/agent/tasks", async (req, reply) => {
    const server = agentServerFromRequest(req)
    if (!server) return reply.code(401).send({ error: "unauthorized" })
    const task = db
      .prepare("SELECT id,action,payload_json FROM agent_tasks WHERE server_id=? AND status='pending' ORDER BY created_at LIMIT 1")
      .get(server.id) as any
    if (!task) return { task: null }
    const claimed = db.prepare("UPDATE agent_tasks SET status='running', claimed_at=? WHERE id=? AND status='pending'").run(Date.now(), task.id)
    if (!claimed.changes) return { task: null }
    try {
      return { task: { id: task.id, action: task.action, payload: materializeTaskPayload(task.action, task.payload_json) } }
    } catch (e: any) {
      db.prepare("UPDATE agent_tasks SET status='failed', error=?, finished_at=? WHERE id=?").run(e?.message || String(e), Date.now(), task.id)
      return { task: null }
    }
  })

  app.post<{ Params: { taskId: string }; Body: { ok?: boolean; result?: any; error?: string } }>(
    "/agent/tasks/:taskId/result",
    async (req, reply) => {
      const server = agentServerFromRequest(req)
      if (!server) return reply.code(401).send({ error: "unauthorized" })
      const found = handleTaskResult(server.id, req.params.taskId, req.body || {})
      if (!found) return reply.code(404).send({ error: "task not found" })
      return { ok: true }
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

    const token = String(req.query?.token || "")
    if (!token) return socket.close(4001, "missing token")
    const server = db.prepare("SELECT id FROM servers WHERE agent_token_hash=?").get(hashToken(token)) as any
    if (!server) return socket.close(4001, "invalid token")

    const serverId = server.id
    onlineAgents.set(serverId, { ws: socket, lastHeartbeat: Date.now() })
    handleHeartbeat(serverId, { status: "online" })

    // Flush backlog created while agent was offline / WS was half-dead.
    const pending = db
      .prepare("SELECT id, action, payload_json FROM agent_tasks WHERE server_id=? AND status='pending' ORDER BY created_at")
      .all(serverId) as Array<{ id: string; action: string; payload_json: string }>
    for (const task of pending) pushTaskToAgent(serverId, task)

    socket.on("message", (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.type === "heartbeat") {
          onlineAgents.set(serverId, { ws: socket, lastHeartbeat: Date.now() })
          handleHeartbeat(serverId, {
            status: msg.payload?.status,
            host: msg.payload?.host,
            tools: msg.payload?.tools,
            version: msg.payload?.version,
          })
          socket.send(JSON.stringify({ type: "ack", id: msg.id }))
        } else if (msg.type === "cmd_result") {
          handleTaskResult(serverId, msg.id, {
            ok: msg.status !== "err",
            result: msg.payload?.result,
            error: msg.payload?.error,
          })
          socket.send(JSON.stringify({ type: "ack", id: msg.id }))
        }
      } catch (e) {
        app.log.warn(`ws message parse error from server ${serverId}: ${(e as Error).message}`)
      }
    })

    socket.on("close", () => {
      onlineAgents.delete(serverId)
      db.prepare("UPDATE servers SET status='offline' WHERE id=?").run(serverId)
    })

    socket.on("error", () => {
      onlineAgents.delete(serverId)
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

    const token = String(req.query?.token || "")
    const user = token ? authFromRequest({ headers: { authorization: `Bearer ${token}` } }) : null
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
