import type { FastifyInstance } from "fastify"
import { db } from "../../core/db"
import { audit } from "../../core/audit"
import { createAgentTask } from "../agent/routes"
import type { AuthUser } from "../../core/constants"

function serverTools(serverId: string) {
  return db
    .prepare("SELECT name,installed,version,path,detected_at FROM tools WHERE server_id=? ORDER BY name")
    .all(serverId)
}

export function registerServersRoutes(app: FastifyInstance) {
  app.get("/api/servers", () => {
    return db
      .prepare("SELECT id,name,os,arch,host,status,last_seen,tags,group_id,agent_version,created_at FROM servers ORDER BY name")
      .all()
      .map((row: any) => ({
        ...row,
        tags: JSON.parse(row.tags || "[]"),
        tools: serverTools(row.id).filter((t: any) => t.installed).map((t: any) => t.name),
      }))
  })

  app.get<{ Params: { id: string } }>("/api/servers/:id", async (req, reply) => {
    const server = db
      .prepare("SELECT id,name,os,arch,host,status,last_seen,tags,group_id,agent_version,created_at FROM servers WHERE id=?")
      .get(req.params.id) as any
    if (!server) return reply.code(404).send({ error: "not found" })
    return { ...server, tags: JSON.parse(server.tags || "[]"), tools: serverTools(req.params.id) }
  })

  app.patch<{ Params: { id: string }; Body: { name?: string } }>("/api/servers/:id", async (req, reply) => {
    const user = (req as any).auth as AuthUser
    const before = db.prepare("SELECT id,name FROM servers WHERE id=?").get(req.params.id) as any
    if (!before) return reply.code(404).send({ error: "not found" })
    const name = String(req.body?.name || "").trim()
    if (!name) return reply.code(400).send({ error: "name is required" })
    if (name.length > 128) return reply.code(400).send({ error: "name too long" })
    db.prepare("UPDATE servers SET name=? WHERE id=?").run(name, req.params.id)
    audit(user.id, "server.rename", `server:${req.params.id}`, { name: before.name }, { name })
    return { ok: true, id: req.params.id, name }
  })

  app.delete<{ Params: { id: string } }>("/api/servers/:id", async (req, reply) => {
    const user = (req as any).auth as AuthUser
    const before = db.prepare("SELECT id,name,os,host,status,last_seen FROM servers WHERE id=?").get(req.params.id)
    if (!before) return reply.code(404).send({ error: "not found" })
    const counts = {
      tools: (db.prepare("SELECT COUNT(*) AS c FROM tools WHERE server_id=?").get(req.params.id) as any).c as number,
      configs: (db.prepare("SELECT COUNT(*) AS c FROM configs WHERE server_id=?").get(req.params.id) as any).c as number,
      tasks: (db.prepare("SELECT COUNT(*) AS c FROM agent_tasks WHERE server_id=?").get(req.params.id) as any).c as number,
    }
    db.exec("BEGIN")
    try {
      db.prepare("DELETE FROM tools WHERE server_id=?").run(req.params.id)
      db.prepare("DELETE FROM configs WHERE server_id=?").run(req.params.id)
      db.prepare("DELETE FROM agent_tasks WHERE server_id=?").run(req.params.id)
      db.prepare("DELETE FROM servers WHERE id=?").run(req.params.id)
      audit(user.id, "server.delete", `server:${req.params.id}`, before, counts)
      db.exec("COMMIT")
    } catch (e) {
      db.exec("ROLLBACK")
      throw e
    }
    return { ok: true }
  })

  app.get<{ Params: { id: string } }>("/api/servers/:id/tasks", async (req, reply) => {
    const exists = db.prepare("SELECT id FROM servers WHERE id=?").get(req.params.id)
    if (!exists) return reply.code(404).send({ error: "not found" })
    return db
      .prepare("SELECT id,action,payload_json,status,result_json,error,created_at,claimed_at,finished_at FROM agent_tasks WHERE server_id=? ORDER BY created_at DESC LIMIT 20")
      .all(req.params.id)
  })

  app.post<{ Params: { id: string }; Body: { tool?: string } }>("/api/servers/:id/configs/read", async (req, reply) => {
    const user = (req as any).auth as AuthUser
    const server = db.prepare("SELECT id FROM servers WHERE id=?").get(req.params.id)
    if (!server) return reply.code(404).send({ error: "not found" })
    const tool = String(req.body?.tool || "codex").trim()
    if (!["codex", "claude", "gemini", "opencode"].includes(tool)) return reply.code(400).send({ error: "unsupported tool" })
    return reply.code(201).send(createAgentTask(req.params.id, user.id, "read_config", { tool }))
  })

  app.post<{ Params: { id: string }; Body: { tool?: string; format?: string; content?: string } }>(
    "/api/servers/:id/configs/write",
    async (req, reply) => {
      const user = (req as any).auth as AuthUser
      const server = db.prepare("SELECT id FROM servers WHERE id=?").get(req.params.id)
      if (!server) return reply.code(404).send({ error: "not found" })
      const tool = String(req.body?.tool || "codex").trim()
      const format = String(req.body?.format || "text").trim()
      const content = String(req.body?.content || "")
      if (!["codex", "claude", "gemini", "opencode"].includes(tool)) return reply.code(400).send({ error: "unsupported tool" })
      if (!content.trim()) return reply.code(400).send({ error: "content is required" })
      return reply.code(201).send(createAgentTask(req.params.id, user.id, "write_config", { tool, format, content }))
    }
  )

  app.post<{ Params: { id: string }; Body: { tool?: string } }>("/api/servers/:id/configs/backups", async (req, reply) => {
    const user = (req as any).auth as AuthUser
    const server = db.prepare("SELECT id FROM servers WHERE id=?").get(req.params.id)
    if (!server) return reply.code(404).send({ error: "not found" })
    const tool = String(req.body?.tool || "codex").trim()
    if (!["codex", "claude", "gemini", "opencode"].includes(tool)) return reply.code(400).send({ error: "unsupported tool" })
    return reply.code(201).send(createAgentTask(req.params.id, user.id, "list_config_backups", { tool }))
  })

  app.post<{ Params: { id: string }; Body: { tool?: string; backup?: string } }>(
    "/api/servers/:id/configs/restore",
    async (req, reply) => {
      const user = (req as any).auth as AuthUser
      const server = db.prepare("SELECT id FROM servers WHERE id=?").get(req.params.id)
      if (!server) return reply.code(404).send({ error: "not found" })
      const tool = String(req.body?.tool || "codex").trim()
      const backup = String(req.body?.backup || "").trim()
      if (!["codex", "claude", "gemini", "opencode"].includes(tool)) return reply.code(400).send({ error: "unsupported tool" })
      if (!backup) return reply.code(400).send({ error: "backup is required" })
      return reply.code(201).send(createAgentTask(req.params.id, user.id, "restore_config_backup", { tool, backup }))
    }
  )

  app.post<{ Params: { id: string }; Body: { tool?: string } }>("/api/servers/:id/tools/detect", async (req, reply) => {
    const user = (req as any).auth as AuthUser
    const server = db.prepare("SELECT id FROM servers WHERE id=?").get(req.params.id)
    if (!server) return reply.code(404).send({ error: "not found" })
    const tool = req.body?.tool ? String(req.body.tool).trim() : null
    return reply.code(201).send(createAgentTask(req.params.id, user.id, "detect_tools", { tool }))
  })

  app.post<{ Params: { id: string }; Body: { tool?: string; provider_id?: string; key_id?: string } }>(
    "/api/servers/:id/credentials/set",
    async (req, reply) => {
      const user = (req as any).auth as AuthUser
      const server = db.prepare("SELECT id FROM servers WHERE id=?").get(req.params.id)
      if (!server) return reply.code(404).send({ error: "not found" })
      const tool = String(req.body?.tool || "").trim()
      const providerId = String(req.body?.provider_id || "").trim()
      const keyId = String(req.body?.key_id || "").trim()
      if (!["codex", "claude", "gemini", "opencode"].includes(tool)) return reply.code(400).send({ error: "unsupported tool for credential delivery" })
      if (!providerId || !keyId) return reply.code(400).send({ error: "provider_id and key_id are required" })

      const key = db
        .prepare("SELECT id FROM provider_keys WHERE id=? AND provider_id=? AND enabled=1")
        .get(keyId, providerId) as any
      if (!key) return reply.code(404).send({ error: "key not found" })

      return reply.code(201).send(createAgentTask(req.params.id, user.id, "set_credential", { tool, provider_id: providerId, key_id: keyId }))
    }
  )

  app.post<{ Params: { id: string }; Body: { tool?: string; version?: string } }>(
    "/api/servers/:id/tools/upgrade",
    async (req, reply) => {
      const user = (req as any).auth as AuthUser
      const server = db.prepare("SELECT id FROM servers WHERE id=?").get(req.params.id)
      if (!server) return reply.code(404).send({ error: "not found" })
      const tool = String(req.body?.tool || "codex").trim()
      const version = req.body?.version ? String(req.body.version).trim() : undefined
      if (!["codex", "claude", "gemini", "opencode"].includes(tool)) return reply.code(400).send({ error: "unsupported tool" })
      return reply.code(201).send(createAgentTask(req.params.id, user.id, "upgrade_tool", { tool, version }))
    }
  )

  app.post<{ Params: { id: string }; Body: { tool?: string; provider_id?: string; key_id?: string } }>(
    "/api/servers/:id/credentials/remove",
    async (req, reply) => {
      const user = (req as any).auth as AuthUser
      const server = db.prepare("SELECT id FROM servers WHERE id=?").get(req.params.id)
      if (!server) return reply.code(404).send({ error: "not found" })
      const tool = String(req.body?.tool || "").trim()
      const providerId = req.body?.provider_id ? String(req.body.provider_id).trim() : null
      const keyId = req.body?.key_id ? String(req.body.key_id).trim() : null
      if (!["codex", "claude", "gemini", "opencode"].includes(tool)) return reply.code(400).send({ error: "unsupported tool for credential removal" })
      return reply.code(201).send(createAgentTask(req.params.id, user.id, "remove_credential", { tool, provider_id: providerId, key_id: keyId }))
    }
  )

  app.post<{ Params: { id: string } }>(
    "/api/servers/:id/agent/upgrade",
    async (req, reply) => {
      const user = (req as any).auth as AuthUser
      const server = db.prepare("SELECT id FROM servers WHERE id=?").get(req.params.id)
      if (!server) return reply.code(404).send({ error: "not found" })
      return reply.code(201).send(createAgentTask(req.params.id, user.id, "upgrade_agent", {}))
    }
  )
}
