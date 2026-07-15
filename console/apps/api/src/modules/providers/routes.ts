import type { FastifyInstance } from "fastify"
import crypto from "node:crypto"
import { db } from "../../core/db"
import { encrypt, decrypt } from "../../core/crypto"
import { inferFamily, normUrl, ccswitchSqlToJson, ccswitchDbToJson } from "../../core/config"
import { audit } from "../../core/audit"
import type { AuthUser } from "../../core/constants"

export function registerProvidersRoutes(app: FastifyInstance) {
  app.get("/api/providers", () => {
    return db
      .prepare(
        `SELECT p.id, p.name, p.base_url, p.preset, p.enabled,
                (SELECT COUNT(*) FROM provider_keys k WHERE k.provider_id=p.id AND k.enabled=1) AS key_count,
                (SELECT COUNT(*) FROM models m WHERE m.provider_id=p.id) AS model_count,
                (SELECT GROUP_CONCAT(DISTINCT k.family) FROM provider_keys k WHERE k.provider_id=p.id AND k.enabled=1) AS families_csv
         FROM providers p ORDER BY p.name`
      )
      .all()
      .map((row: any) => {
        const { families_csv, ...rest } = row
        return { ...rest, families: families_csv ? families_csv.split(",") : [] }
      })
  })

  app.post<{
    Body: {
      name?: string
      base_url?: string | null
      models_endpoint?: string | null
      preset?: string | null
      enabled?: boolean | number
    }
  }>("/api/providers", async (req, reply) => {
    const user = (req as any).auth as AuthUser
    const name = String(req.body?.name || "").trim()
    const baseUrl = req.body?.base_url ? String(req.body.base_url).trim().replace(/\/+$/, "") : null
    const modelsEndpoint = String(req.body?.models_endpoint || "/v1/models").trim() || "/v1/models"
    const preset = req.body?.preset ? String(req.body.preset).trim() : "custom"
    const enabled = req.body?.enabled === false || req.body?.enabled === 0 ? 0 : 1

    if (!name) return reply.code(400).send({ error: "name is required" })
    if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
      return reply.code(400).send({ error: "base_url must start with http:// or https://" })
    }
    if (!modelsEndpoint.startsWith("/")) {
      return reply.code(400).send({ error: "models_endpoint must start with /" })
    }

    const id = crypto.randomUUID()
    db.prepare(
      `INSERT INTO providers(id,name,base_url,models_endpoint,preset,enabled,created_at)
       VALUES(?,?,?,?,?,?,?)`
    ).run(id, name, baseUrl, modelsEndpoint, preset, enabled, Date.now())
    audit(user.id, "provider.create", `provider:${id}`, null, { name, base_url: baseUrl, preset, enabled })

    const provider = db
      .prepare(
        `SELECT p.id, p.name, p.base_url, p.preset, p.enabled,
                 0 AS key_count,
                 0 AS model_count
         FROM providers p WHERE p.id=?`
      )
      .get(id)
    return reply.code(201).send(provider)
  })

  app.post<{ Body: any }>("/api/providers/import/ccswitch", async (req, reply) => {
    const user = (req as any).auth as AuthUser
    const body: any = req.body || {}
    let input: any
    try {
      input = typeof body.content_base64 === "string"
        ? ccswitchDbToJson(Buffer.from(body.content_base64, "base64"))
        : typeof body.content === "string"
          ? ccswitchSqlToJson(body.content)
          : body
    } catch (e: any) {
      const msg = e?.message || String(e)
      const status = msg.includes("not a valid SQLite") || msg.includes("header") ? 400
        : msg.includes("too small") ? 400
        : msg.includes("table") ? 400
        : msg.includes("parse") || msg.includes("SQL") ? 400
        : 500
      return reply.code(status).send({ error: msg })
    }
    if (!Array.isArray(input.providers) || !Array.isArray(input.raw_presets)) {
      return reply.code(400).send({ error: "invalid cc-switch json: providers/raw_presets are required" })
    }

    const now = Date.now()
    const providerByNorm = new Map<string, string>()
    for (const row of db.prepare("SELECT id,base_url FROM providers").all() as any[]) {
      providerByNorm.set(normUrl(row.base_url), row.id)
    }

    const counts = { providers: 0, keys: 0, oauth: 0, models: 0, endpoints: 0, pricing: 0 }
    const createdIds = { provider_ids: [] as string[], key_ids: [] as string[], model_ids: [] as string[], endpoint_ids: [] as number[], pricing_count: 0 }
    db.exec("BEGIN")
    try {
      for (const p of input.providers) {
        const baseUrl = p?.base_url ? String(p.base_url).replace(/\/+$/, "") : null
        const key = normUrl(baseUrl)
        if (!key) continue
        let providerId = providerByNorm.get(key)
        if (!providerId) {
          providerId = crypto.randomUUID()
          db.prepare(
            `INSERT INTO providers(id,name,base_url,models_endpoint,preset,enabled,created_at)
             VALUES(?,?,?,'/v1/models','ccswitch',1,?)`
          ).run(providerId, String(p.name || baseUrl), baseUrl, now)
          providerByNorm.set(key, providerId)
          createdIds.provider_ids.push(providerId)
          counts.providers++
        }
        for (const modelId of p.models || []) {
          const model = String(modelId || "").trim()
          if (!model) continue
          const exists = db.prepare("SELECT id FROM models WHERE provider_id=? AND key_id IS NULL AND model_id=?").get(providerId, model)
          if (exists) continue
          const newModelId = crypto.randomUUID()
          db.prepare("INSERT INTO models(id,provider_id,key_id,model_id,family,enabled,fetched_at) VALUES(?,?,NULL,?,?,1,?)").run(
            newModelId,
            providerId,
            model,
            p.family || inferFamily(model, null),
            now
          )
          createdIds.model_ids.push(newModelId)
          counts.models++
        }
      }

      for (const r of input.raw_presets) {
        const providerId = providerByNorm.get(normUrl(r?.base_url))
        if (!providerId) continue
        const apiKey = r?.api_key ? String(r.api_key) : ""
        const label = String(r?.name || "Imported Key")
        const existingKeys = db.prepare("SELECT encrypted_value,iv,label FROM provider_keys WHERE provider_id=?").all(providerId) as any[]
        const duplicate = existingKeys.some((k) => (apiKey ? decrypt(k.encrypted_value, k.iv) === apiKey : k.label === label))
        if (!duplicate) {
          const keyId = crypto.randomUUID()
          const enc = apiKey ? encrypt(apiKey) : null
          db.prepare(
            `INSERT INTO provider_keys(id,provider_id,label,group_name,family,encrypted_value,iv,api_format,auth_type,raw_config_json,enabled,created_at)
             VALUES(?,?,?,?,?,?,?,?,?,?,1,?)`
          ).run(
            keyId,
            providerId,
            label,
            null,
            r?.family || "mixed",
            enc?.encryptedValue || null,
            enc?.iv || null,
            r?.api_format || null,
            apiKey ? "apikey" : "oauth",
            r?.raw_settings_config ? JSON.stringify(r.raw_settings_config) : null,
            now
          )
          createdIds.key_ids.push(keyId)
          if (apiKey) counts.keys++
          else counts.oauth++
        }
        for (const url of r?.endpoints || []) {
          const endpoint = String(url || "").trim()
          if (!endpoint) continue
          const exists = db.prepare("SELECT id FROM provider_endpoints WHERE provider_id=? AND url=?").get(providerId, endpoint)
          if (exists) continue
          const inserted = db.prepare("INSERT INTO provider_endpoints(provider_id,url,added_at) VALUES(?,?,?)").run(providerId, endpoint, now)
          createdIds.endpoint_ids.push(Number(inserted.lastInsertRowid))
          counts.endpoints++
        }
      }

      for (const m of input.model_pricing || []) {
        if (!m?.model_id) continue
        db.prepare(
          `INSERT OR REPLACE INTO model_pricing(model_id,display_name,input_cost_per_million,output_cost_per_million,cache_read_cost_per_million,cache_creation_cost_per_million)
           VALUES(?,?,?,?,?,?)`
        ).run(
          String(m.model_id),
          String(m.display_name || m.model_id),
          String(m.input_cost_per_million || "0"),
          String(m.output_cost_per_million || "0"),
          String(m.cache_read_cost_per_million || "0"),
          String(m.cache_creation_cost_per_million || "0")
        )
        counts.pricing++
      }
      createdIds.pricing_count = counts.pricing

      const jobId = crypto.randomUUID()
      const fullCounts = { ...counts, created: createdIds }
      db.prepare(
        "INSERT INTO import_jobs(id,source_type,source_path,status,counts_json,started_by,started_at,finished_at) VALUES(?,?,?,?,?,?,?,?)"
      ).run(jobId, input.source || "ccswitch-json", body.filename || input.source || null, "done", JSON.stringify(fullCounts), user.id, now, Date.now())
      audit(user.id, "providers.import_ccswitch", `import_job:${jobId}`, null, counts)
      db.exec("COMMIT")
      return {
        ok: true,
        counts,
        job_id: jobId,
        warnings: input.warnings as string[] | undefined,
        skipped: input.skipped as Array<{ reason: string; name?: string }> | undefined,
        skipped_count: input.skipped ? (input.skipped as any[]).length : 0,
      }
    } catch (e) {
      db.exec("ROLLBACK")
      throw e
    }
  })

  app.put<{
    Params: { id: string }
    Body: {
      name?: string
      base_url?: string | null
      models_endpoint?: string | null
      preset?: string | null
      enabled?: boolean | number
    }
  }>("/api/providers/:id", async (req, reply) => {
    const user = (req as any).auth as AuthUser
    const before = db
      .prepare("SELECT id,name,base_url,models_endpoint,preset,enabled FROM providers WHERE id=?")
      .get(req.params.id)
    if (!before) return reply.code(404).send({ error: "not found" })

    const name = String(req.body?.name || "").trim()
    const baseUrl = req.body?.base_url ? String(req.body.base_url).trim().replace(/\/+$/, "") : null
    const modelsEndpoint = String(req.body?.models_endpoint || "/v1/models").trim() || "/v1/models"
    const preset = req.body?.preset ? String(req.body.preset).trim() : "custom"
    const enabled = req.body?.enabled === false || req.body?.enabled === 0 ? 0 : 1
    if (!name) return reply.code(400).send({ error: "name is required" })
    if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
      return reply.code(400).send({ error: "base_url must start with http:// or https://" })
    }
    if (!modelsEndpoint.startsWith("/")) {
      return reply.code(400).send({ error: "models_endpoint must start with /" })
    }

    db.prepare("UPDATE providers SET name=?, base_url=?, models_endpoint=?, preset=?, enabled=? WHERE id=?").run(
      name,
      baseUrl,
      modelsEndpoint,
      preset,
      enabled,
      req.params.id
    )
    const after = db
      .prepare("SELECT id,name,base_url,models_endpoint,preset,enabled FROM providers WHERE id=?")
      .get(req.params.id)
    audit(user.id, "provider.update", `provider:${req.params.id}`, before, after)
    return after
  })

  app.get<{ Params: { id: string } }>("/api/providers/:id", async (req, reply) => {
    const p = db
      .prepare(
        "SELECT id,name,base_url,models_endpoint,preset,enabled FROM providers WHERE id=?"
      )
      .get(req.params.id) as any
    if (!p) return reply.code(404).send({ error: "not found" })
    const keys = db
      .prepare(
        "SELECT id,label,group_name,family,api_format,auth_type,enabled,default_model_id FROM provider_keys WHERE provider_id=? AND enabled=1 ORDER BY label"
      )
      .all(req.params.id)
    const models = db
      .prepare(
        "SELECT id,key_id,model_id,family,display_name,context_window,enabled FROM models WHERE provider_id=? AND enabled=1 ORDER BY model_id"
      )
      .all(req.params.id)
    const endpoints = db
      .prepare("SELECT id,url FROM provider_endpoints WHERE provider_id=? ORDER BY id")
      .all(req.params.id)
    return { ...p, keys, models, endpoints }
  })

  app.post<{
    Params: { id: string }
    Body: {
      label?: string
      api_key?: string
      family?: string
      group_name?: string | null
      api_format?: string | null
    }
  }>("/api/providers/:id/keys", async (req, reply) => {
    const user = (req as any).auth as AuthUser
    const provider = db.prepare("SELECT id FROM providers WHERE id=?").get(req.params.id)
    if (!provider) return reply.code(404).send({ error: "provider not found" })

    const label = String(req.body?.label || "").trim()
    const apiKey = String(req.body?.api_key || "").trim()
    const family = String(req.body?.family || "mixed").trim() || "mixed"
    const groupName = req.body?.group_name ? String(req.body.group_name).trim() : null
    const apiFormat = req.body?.api_format ? String(req.body.api_format).trim() : null
    if (!label) return reply.code(400).send({ error: "label is required" })
    if (!apiKey) return reply.code(400).send({ error: "api_key is required" })

    const id = crypto.randomUUID()
    const encrypted = encrypt(apiKey)
    db.exec("BEGIN")
    try {
      db.prepare(
        `INSERT INTO provider_keys(id,provider_id,label,group_name,family,encrypted_value,iv,api_format,auth_type,enabled,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        id,
        req.params.id,
        label,
        groupName,
        family,
        encrypted.encryptedValue,
        encrypted.iv,
        apiFormat,
        "apikey",
        1,
        Date.now()
      )
      audit(user.id, "provider_key.create", `provider_key:${id}`, null, {
        provider_id: req.params.id,
        label,
        family,
        api_format: apiFormat,
        key_fingerprint: crypto.createHash("sha256").update(apiKey).digest("hex").slice(0, 12),
      })
      db.exec("COMMIT")
    } catch (e) {
      db.exec("ROLLBACK")
      throw e
    }
    const key = db
      .prepare("SELECT id,label,family,api_format,auth_type,enabled FROM provider_keys WHERE id=?")
      .get(id)
    return reply.code(201).send(key)
  })

  app.put<{
    Params: { id: string; keyId: string }
    Body: {
      label?: string
      family?: string
      group_name?: string | null
      api_format?: string | null
      enabled?: boolean | number
      api_key?: string
      default_model_id?: string | null
    }
  }>("/api/providers/:id/keys/:keyId", async (req, reply) => {
    const user = (req as any).auth as AuthUser
    const before = db
      .prepare("SELECT id,provider_id,label,group_name,family,api_format,auth_type,enabled,default_model_id FROM provider_keys WHERE id=? AND provider_id=?")
      .get(req.params.keyId, req.params.id) as any
    if (!before) return reply.code(404).send({ error: "key not found" })

    const label = String(req.body?.label || "").trim()
    const family = String(req.body?.family || "mixed").trim() || "mixed"
    const groupName = req.body?.group_name ? String(req.body.group_name).trim() : null
    const apiFormat = req.body?.api_format ? String(req.body.api_format).trim() : null
    const enabled = req.body?.enabled === false || req.body?.enabled === 0 ? 0 : 1
    const apiKey = req.body?.api_key ? String(req.body.api_key).trim() : ""
    const defaultModelId = req.body?.default_model_id !== undefined ? (req.body.default_model_id ? String(req.body.default_model_id).trim() : null) : undefined

    if (!label) return reply.code(400).send({ error: "label is required" })

    db.exec("BEGIN")
    try {
      if (apiKey) {
        const encrypted = encrypt(apiKey)
        const extraCols = defaultModelId !== undefined ? ", default_model_id=?" : ""
        const extraVals = defaultModelId !== undefined ? [defaultModelId] : []
        db.prepare(
          `UPDATE provider_keys SET label=?, group_name=?, family=?, api_format=?, enabled=?, encrypted_value=?, iv=?, auth_type='apikey'${extraCols} WHERE id=? AND provider_id=?`
        ).run(label, groupName, family, apiFormat, enabled, encrypted.encryptedValue, encrypted.iv, ...extraVals, req.params.keyId, req.params.id)
      } else {
        if (defaultModelId !== undefined) {
          db.prepare(
            "UPDATE provider_keys SET label=?, group_name=?, family=?, api_format=?, enabled=?, default_model_id=? WHERE id=? AND provider_id=?"
          ).run(label, groupName, family, apiFormat, enabled, defaultModelId, req.params.keyId, req.params.id)
        } else {
          db.prepare(
            "UPDATE provider_keys SET label=?, group_name=?, family=?, api_format=?, enabled=? WHERE id=? AND provider_id=?"
          ).run(label, groupName, family, apiFormat, enabled, req.params.keyId, req.params.id)
        }
      }
      db.exec("COMMIT")
    } catch (e) {
      db.exec("ROLLBACK")
      throw e
    }

    const after = db
      .prepare("SELECT id,label,group_name,family,api_format,auth_type,enabled,default_model_id FROM provider_keys WHERE id=?")
      .get(req.params.keyId)
    audit(user.id, "provider_key.update", `provider_key:${req.params.keyId}`, before, {
      ...after as any,
      key_updated: !!apiKey
    })
    return after
  })

  app.delete<{ Params: { id: string; keyId: string } }>("/api/providers/:id/keys/:keyId", async (req, reply) => {
    const user = (req as any).auth as AuthUser
    const before = db
      .prepare("SELECT id,provider_id,label,family,api_format,auth_type,enabled FROM provider_keys WHERE id=? AND provider_id=?")
      .get(req.params.keyId, req.params.id)
    if (!before) return reply.code(404).send({ error: "key not found" })

    db.prepare("UPDATE provider_keys SET enabled=0 WHERE id=? AND provider_id=?").run(req.params.keyId, req.params.id)
    audit(user.id, "provider_key.disable", `provider_key:${req.params.keyId}`, before, { enabled: 0 })
    return { ok: true }
  })

  app.post<{ Params: { id: string; keyId: string } }>(
    "/api/providers/:id/keys/:keyId/models/refresh",
    async (req, reply) => {
      const user = (req as any).auth as AuthUser
      const key = db
        .prepare(
          `SELECT k.id, k.encrypted_value, k.iv, k.api_format, k.auth_type, k.family,
                  p.base_url, p.models_endpoint
           FROM provider_keys k JOIN providers p ON p.id=k.provider_id
           WHERE k.id=? AND k.provider_id=? AND k.enabled=1`
        )
        .get(req.params.keyId, req.params.id) as any
      if (!key) return reply.code(404).send({ error: "key not found" })
      if (!key.base_url) return reply.code(400).send({ error: "provider base_url is required" })
      if (key.auth_type !== "apikey" || !key.encrypted_value) {
        return reply.code(400).send({ error: "oauth key cannot refresh models" })
      }

      const secret = decrypt(key.encrypted_value, key.iv)
      if (!secret) return reply.code(400).send({ error: "failed to decrypt api key" })

      const base = String(key.base_url).replace(/\/+$/g, "")
      const endpoint = String(key.models_endpoint || "/v1/models")
      const url = `${base}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`
      const headers: Record<string, string> = {
        "user-agent": "ai-console",
        "authorization": `Bearer ${secret}`,
      }

      app.log.info({ msg: "refresh models", url, key_label: key.id, api_format: key.api_format })
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) })
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        app.log.error({ msg: "refresh models failed", url, status: res.status, body: text.slice(0, 200) })
        return reply.code(502).send({ error: text.slice(0, 300) || `models endpoint returned ${res.status}` })
      }

      const raw = (await res.json()) as any
      const items = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw?.models) ? raw.models : []
      if (!items.length) return reply.code(502).send({ error: "models response has no data[]" })

      const now = Date.now()
      let created = 0
      let updated = 0
      let removed = 0
      db.exec("BEGIN")
      try {
        for (const item of items) {
          const modelId = String(item?.id || item?.model || item?.name || "").trim()
          if (!modelId) continue
          const family = inferFamily(modelId, key.family)
          const displayName = item?.display_name ? String(item.display_name) : null
          const contextWindow = Number(item?.context_window || item?.context_length || item?.max_context_tokens || 0) || null
          const existing = db
            .prepare("SELECT id FROM models WHERE provider_id=? AND key_id=? AND model_id=?")
            .get(req.params.id, req.params.keyId, modelId) as any
          if (existing) {
            db.prepare(
              "UPDATE models SET family=?, display_name=?, context_window=?, enabled=1, fetched_at=? WHERE id=?"
            ).run(family, displayName, contextWindow, now, existing.id)
            updated++
          } else {
            db.prepare(
              `INSERT INTO models(id,provider_id,key_id,model_id,family,display_name,context_window,enabled,fetched_at)
               VALUES(?,?,?,?,?,?,?,?,?)`
            ).run(crypto.randomUUID(), req.params.id, req.params.keyId, modelId, family, displayName, contextWindow, 1, now)
            created++
          }
        }
        removed = (db.prepare(
          "UPDATE models SET enabled=0 WHERE provider_id=? AND key_id=? AND enabled=1 AND fetched_at != ?"
        ).run(req.params.id, req.params.keyId, now) as any).changes
        db.prepare("UPDATE provider_keys SET last_models_refresh=? WHERE id=?").run(now, req.params.keyId)
        audit(user.id, "provider_key.refresh_models", `provider_key:${req.params.keyId}`, null, {
          provider_id: req.params.id,
          created,
          updated,
          removed,
        })
        db.exec("COMMIT")
      } catch (e) {
        db.exec("ROLLBACK")
        throw e
      }
      return { ok: true, created, updated, removed: removed || 0, total: created + updated }
    }
  )

  app.delete<{ Params: { id: string } }>("/api/providers/:id", async (req, reply) => {
    const user = (req as any).auth as AuthUser
    const before = db.prepare("SELECT id,name,base_url,preset,enabled FROM providers WHERE id=?").get(req.params.id)
    if (!before) return reply.code(404).send({ error: "not found" })

    const counts = {
      models: (db.prepare("SELECT COUNT(*) AS c FROM models WHERE provider_id=?").get(req.params.id) as any).c as number,
      endpoints: (db.prepare("SELECT COUNT(*) AS c FROM provider_endpoints WHERE provider_id=?").get(req.params.id) as any).c as number,
      keys: (db.prepare("SELECT COUNT(*) AS c FROM provider_keys WHERE provider_id=?").get(req.params.id) as any).c as number,
    }

    db.exec("BEGIN")
    try {
      db.prepare("DELETE FROM models WHERE provider_id=?").run(req.params.id)
      db.prepare("DELETE FROM provider_endpoints WHERE provider_id=?").run(req.params.id)
      db.prepare("DELETE FROM provider_keys WHERE provider_id=?").run(req.params.id)
      db.prepare("DELETE FROM providers WHERE id=?").run(req.params.id)
      audit(user.id, "provider.delete", `provider:${req.params.id}`, before, counts)
      db.exec("COMMIT")
    } catch (e) {
      db.exec("ROLLBACK")
      throw e
    }
    return { ok: true }
  })

  app.get("/api/models", () => {
    const rows = db
      .prepare(
        `SELECT m.model_id, m.family, m.display_name, m.context_window,
                p.name AS provider_name, p.id AS provider_id
         FROM models m JOIN providers p ON p.id=m.provider_id
         WHERE m.enabled=1
         ORDER BY m.family, m.model_id, p.name`
      )
      .all() as any[]
    const map = new Map<string, any>()
    for (const row of rows) {
      const key = row.model_id
      if (!map.has(key)) {
        map.set(key, {
          model_id: row.model_id,
          family: row.family,
          display_name: row.display_name,
          context_window: row.context_window,
          providers: [],
        })
      }
      const entry = map.get(key)
      if (!entry.providers.some((p: any) => p.provider_id === row.provider_id)) {
        entry.providers.push({ provider_id: row.provider_id, provider_name: row.provider_name })
      }
    }
    return [...map.values()]
  })

  app.post<{ Params: { id: string; keyId: string }; Body: { model_id?: string } }>(
    "/api/providers/:id/keys/:keyId/ping",
    async (req, reply) => {
      const key = db
        .prepare(
          `SELECT k.encrypted_value, k.iv, k.api_format, k.auth_type,
                  p.base_url, p.models_endpoint
           FROM provider_keys k JOIN providers p ON p.id=k.provider_id
           WHERE k.id=? AND k.provider_id=?`
        )
        .get(req.params.keyId, req.params.id) as any
      if (!key) return reply.code(404).send({ error: "key not found" })
      if (key.auth_type !== "apikey" || !key.encrypted_value)
        return { ok: false, error: "oauth key - cannot ping" }

      const secret = decrypt(key.encrypted_value, key.iv)
      if (!secret) return { ok: false, error: "decrypt failed (MASTER_KEY mismatch?)" }

      const requestedModel = req.body?.model_id ? String(req.body.model_id).trim() : ""
      let m = requestedModel
        ? (db
            .prepare("SELECT model_id FROM models WHERE provider_id=? AND (key_id=? OR key_id IS NULL) AND model_id=? AND enabled=1")
            .get(req.params.id, req.params.keyId, requestedModel) as any)
        : (db
            .prepare("SELECT model_id FROM models WHERE provider_id=? AND enabled=1 LIMIT 1")
            .get(req.params.id) as any)
      if (requestedModel && !m) return reply.code(404).send({ error: "model not found for this key" })

      let autoFetched = false
      if (!m) {
        const base = String(key.base_url || "").replace(/\/+$/g, "")
        const endpoint = String(key.models_endpoint || "/v1/models")
        const modelUrl = `${base}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`
        const modelHeaders: Record<string, string> = {
          "user-agent": "ai-console",
          "authorization": `Bearer ${secret}`,
        }
        app.log.info({ msg: "ping auto-fetch models", url: modelUrl })
        const modelRes = await fetch(modelUrl, { headers: modelHeaders, signal: AbortSignal.timeout(15000) })
        if (!modelRes.ok) {
          const t = await modelRes.text().catch(() => "")
          app.log.error({ msg: "ping auto-fetch failed", url: modelUrl, status: modelRes.status, body: t.slice(0, 200) })
          return { ok: false, error: `no model available, auto-fetch failed: ${modelRes.status} ${t.slice(0, 100)}` }
        }
        const raw = (await modelRes.json()) as any
        const items = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw?.models) ? raw.models : []
        if (!items.length) return { ok: false, error: "no models available from this provider" }
        const now = Date.now()
        db.exec("BEGIN")
        try {
          for (const item of items) {
            const modelId = String(item?.id || item?.model || item?.name || "").trim()
            if (!modelId) continue
            const existing = db.prepare("SELECT id FROM models WHERE provider_id=? AND key_id=? AND model_id=?").get(req.params.id, req.params.keyId, modelId)
            if (existing) {
              db.prepare("UPDATE models SET enabled=1, fetched_at=? WHERE id=?").run(now, (existing as any).id)
            } else {
              db.prepare("INSERT INTO models(id,provider_id,key_id,model_id,family,enabled,fetched_at) VALUES(?,?,NULL,?,?,1,?)").run(
                crypto.randomUUID(), req.params.id, modelId, inferFamily(modelId, key.family), now
              )
            }
          }
          db.exec("COMMIT")
        } catch (e) {
          db.exec("ROLLBACK")
          throw e
        }
        m = { model_id: String(items[0]?.id || items[0]?.model || items[0]?.name || "").replace(/\s*\[.*$/, "").trim() }
        autoFetched = true
      }
      const model = m?.model_id ? String(m.model_id).replace(/\s*\[.*$/, "").trim() : null
      if (!model) return { ok: false, error: "no model available" }

      const base = String(key.base_url || "").replace(/\/+(v1\/?)?$/i, "")
      const isAnthropic = key.api_format === "anthropic"
      const url = isAnthropic ? `${base}/v1/messages` : `${base}/v1/chat/completions`
      const body = { model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "user-agent": isAnthropic ? "claude-cli/1.0.60 (external, cli)" : "openai/codex",
      }
      if (isAnthropic) {
        headers["x-api-key"] = secret
        headers["anthropic-version"] = "2023-06-01"
        headers["anthropic-beta"] = "oauth-2025-04-20"
        headers["x-app"] = "cli"
      } else {
        headers["authorization"] = `Bearer ${secret}`
      }

      const t0 = Date.now()
      app.log.info({ msg: "ping", url, model, is_anthropic: isAnthropic })
      try {
        const res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15000),
        })
        const latency = Date.now() - t0
        if (res.ok) return { ok: true, latency_ms: latency, model, status: res.status, auto_fetched: autoFetched }
        const text = await res.text().catch(() => "")
        app.log.error({ msg: "ping failed", url, model, status: res.status, body: text.slice(0, 200) })
        return { ok: false, latency_ms: latency, status: res.status, error: text.slice(0, 300) }
      } catch (e: any) {
        app.log.error({ msg: "ping error", url, model, error: e?.message })
        return { ok: false, latency_ms: Date.now() - t0, error: e?.message || String(e) }
      }
    }
  )
}
