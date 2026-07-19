import type { FastifyInstance } from "fastify"
import { db } from "../../core/db"
import { decrypt } from "../../core/crypto"
import { audit } from "../../core/audit"
import { createAgentTask } from "../agent/routes"
import type { AuthUser } from "../../core/constants"

function serverTools(serverId: string) {
  return db
    .prepare("SELECT name,installed,version,path,detected_at FROM tools WHERE server_id=? ORDER BY name")
    .all(serverId)
}

// ponytail (BUG-01): tasks endpoint returns strictly-shaped rows. payload_json
// and result_json originally held raw agent payloads/responses that contain
// API keys and generated configs; returning them to viewers or even operators
// leaks secrets and violates the redaction model. This shape is the allowlist:
// stable metadata plus a lean result view. The frontend already keys off these
// same fields (status/error/timestamps), and content lives behind
// `/api/servers/:id/configs/latest` with an explicit role gate.
function serializeTaskForList(row: any) {
  let action = String(row.action || "")
  let tool: string | null = null
  try {
    const p = JSON.parse(row.payload_json || "{}")
    if (typeof p.tool === "string") tool = p.tool
  } catch {}
  let resultView: Record<string, unknown> | null = null
  if (row.result_json) {
    try {
      const r = JSON.parse(row.result_json)
      resultView = {}
      if (typeof r?.path === "string") resultView.path = r.path
      if (typeof r?.format === "string") resultView.format = r.format
      if (typeof r?.backup === "string") resultView.backup = r.backup
      if (typeof r?.content_sha256 === "string") resultView.content_sha256 = r.content_sha256
      if (Array.isArray(r?.tools)) resultView.tool_count = r.tools.length
      if (Array.isArray(r?.backups)) resultView.backup_count = r.backups.length
      if (typeof r?.new_version === "string") resultView.new_version = r.new_version
    } catch {}
  }
  return {
    id: row.id,
    action,
    tool,
    status: row.status,
    error: row.error,
    created_at: row.created_at,
    claimed_at: row.claimed_at,
    finished_at: row.finished_at,
    result: resultView,
  }
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
    // ponytail (BUG-01): raw payload_json/result_json never crosses the API
    // boundary. Serialize via serializeTaskForList so viewers/operators only
    // see structured metadata, not the plaintext body.
    const rows = db
      .prepare("SELECT id,action,payload_json,status,result_json,error,created_at,claimed_at,finished_at FROM agent_tasks WHERE server_id=? ORDER BY created_at DESC LIMIT 20")
      .all(req.params.id) as any[]
    return rows.map(serializeTaskForList)
  })

  // ponytail (BUG-01): explicit operator+ gate lives inside the handler.
  // /api/servers/:id/... currently only enforces operator+ for mutations
  // (see middleware/auth.ts operatorPlus + method != GET check); this GET
  // returns decrypted config content and would otherwise be viewer-readable.
  app.get<{ Params: { id: string }; Querystring: { tool?: string } }>("/api/servers/:id/configs/latest", async (req, reply) => {
    const user = (req as any).auth as AuthUser
    if (!user || (user.role !== "operator" && user.role !== "admin")) {
      return reply.code(403).send({ error: "operator or admin role required" })
    }
    const exists = db.prepare("SELECT id FROM servers WHERE id=?").get(req.params.id)
    if (!exists) return reply.code(404).send({ error: "not found" })
    const tool = String(req.query?.tool || "").trim()
    if (!["codex", "claude", "gemini", "opencode"].includes(tool)) return reply.code(400).send({ error: "unsupported tool" })
    const row = db
      .prepare("SELECT format,version,source,updated_by,updated_at,content,encrypted_content,encrypted_content_iv,content_sha256 FROM configs WHERE server_id=? AND tool=? ORDER BY version DESC LIMIT 1")
      .get(req.params.id, tool) as any
    if (!row) return reply.code(404).send({ error: "no config recorded" })
    let content = ""
    if (row.encrypted_content && row.encrypted_content_iv) {
      const dec = decrypt(row.encrypted_content, row.encrypted_content_iv)
      if (dec === null) return reply.code(500).send({ error: "decrypt failed" })
      content = dec
    } else if (typeof row.content === "string" && row.content !== "[ENCRYPTED]") {
      // legacy plaintext row (pre-016) — return as-is; migration 016 does not
      // rewrite these because the console can no longer trust that the content
      // is safe to display without re-verification.
      content = row.content
    }
    return {
      tool,
      format: row.format,
      version: row.version,
      source: row.source,
      updated_by: row.updated_by,
      updated_at: row.updated_at,
      content_sha256: row.content_sha256,
      content,
    }
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
      // ponytail (BUG-01): manual write may contain a raw API key inside
      // opencode.json / settings.json. Treat as sensitive: payload_json only
      // stores a marker, real content lives in encrypted_payload.
      return reply.code(201).send(createAgentTask(
        req.params.id,
        user.id,
        "write_config",
        { tool, format, source: "encrypted_manual", redacted: true },
        {
          sensitivePayload: { tool, format, content },
          auditMeta: { tool, format, source: "encrypted_manual" },
        }
      ))
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

      // ponytail: 统一下发。所有工具都走 write_config（provider_refs 源），
      // 以前只有 opencode 这么做。materializeTaskPayload 在 dispatch 时按工具
      // 生成原生配置，明文从不落到 payload_json / audit_log / result_json。
      //   - claude/gemini/opencode: 单个 write_config（apikey 已嵌入
      //     settings.json env 块 / opencode.json provider options）。
      //   - codex: write_config（config.toml，按 spec 不含 key）后跟第二个
      //     set_credential 任务写 ~/.codex/auth.json。per-server 单任务不变式
      //     保证两者顺序执行。先校验 model 可用，快速 400。
      const keyDetail = db
        .prepare(`SELECT k.default_model_id FROM provider_keys k
                  WHERE k.id=? AND k.provider_id=? AND k.enabled=1`)
        .get(keyId, providerId) as any
      const modelId = keyDetail?.default_model_id ||
        (db.prepare("SELECT model_id FROM models WHERE provider_id=? AND enabled=1 ORDER BY model_id LIMIT 1").get(providerId) as any)?.model_id
      if (!modelId) return reply.code(400).send({ error: "no model available for this provider" })

      const writeConfigTask = createAgentTask(
        req.params.id,
        user.id,
        "write_config",
        { tool, source: "provider_refs", redacted: true },
        {
          sensitivePayload: {
            tool,
            source: "provider_refs",
            entries: [{ provider_id: providerId, key_id: keyId, model_id: modelId }],
          },
          auditMeta: { tool, provider_ids: [providerId], key_ids: [keyId], model_ids: [modelId] },
        }
      )

      if (tool === "codex") {
        // ponytail: codex 下发拆成 config.toml (write_config，已派发) +
        // ~/.codex/auth.json (set_credential，排队在后)。两者都是 codex 鉴权
        // 必需——少一个 codex 都跑不起来。
        createAgentTask(
          req.params.id,
          user.id,
          "set_credential",
          { tool, source: "provider_refs", redacted: true },
          {
            sensitivePayload: { tool, provider_id: providerId, key_id: keyId },
            auditMeta: { tool, provider_ids: [providerId], key_ids: [keyId] },
          }
        )
      }

      return reply.code(201).send(writeConfigTask)
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

      // ponytail: 卸载需要真正清空配置文件里的 apikey 字段，而不只是删凭据文件。
      //   - codex: config.toml 按 spec 本来就不含 apikey，仅 remove_credential
      //     删 ~/.codex/auth.json 即可。
      //   - claude/gemini: 先 write_config 把 settings.json 覆盖为最小内容
      //     （清空 env 块），再 remove_credential 删遗留 creds/<tool>.sh。
      //   - opencode: 仅 write_config 把 opencode.json 重置为最小内容
      //     （清空 provider 块）。
      // scrubbed 内容无 secret，直接进 payload_json（不走 sensitivePayload）。
      if (tool === "claude" || tool === "gemini") {
        const scrubbed = tool === "claude"
          ? { env: {} }
          : { selectedAuthType: "GEMINI_API_KEY", env: {} }
        const writeTask = createAgentTask(
          req.params.id,
          user.id,
          "write_config",
          { tool, format: "json", content: JSON.stringify(scrubbed) },
          { auditMeta: { tool, action: "scrub_config_on_remove", provider_id: providerId, key_id: keyId } }
        )
        createAgentTask(
          req.params.id,
          user.id,
          "remove_credential",
          { tool, provider_id: providerId, key_id: keyId }
        )
        return reply.code(201).send(writeTask)
      }

      if (tool === "opencode") {
        return reply.code(201).send(createAgentTask(
          req.params.id,
          user.id,
          "write_config",
          { tool, format: "json", content: JSON.stringify({ $schema: "https://opencode.ai/config.json" }) },
          { auditMeta: { tool, action: "scrub_config_on_remove", provider_id: providerId, key_id: keyId } }
        ))
      }

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
