import { DatabaseSync } from "node:sqlite"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export function inferFamily(modelId: string, fallback: string | null): string {
  const id = modelId.toLowerCase()
  if (id.includes("claude")) return "claude"
  if (id.includes("gemini")) return "gemini"
  if (/\b(gpt|o1|o3|o4|codex)\b/.test(id) || id.includes("gpt-")) return "codex"
  return fallback || "unknown"
}

export function normUrl(value: string | null | undefined): string {
  return String(value || "").replace(/\/+$/, "").replace(/\/v1$/i, "").toLowerCase()
}

export function withOpenAiV1(value: string | null | undefined): string {
  const base = String(value || "").trim().replace(/\/+$/, "")
  if (!base) return ""
  return /\/v1$/i.test(base) ? base : `${base}/v1`
}

export function safeJson(value: unknown): any {
  if (!value || typeof value !== "string") return {}
  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
}

export function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return ""
}

export function familyFromApp(app: string): string {
  const value = app.toLowerCase()
  if (value.includes("claude")) return "claude"
  if (value.includes("codex")) return "codex"
  if (value.includes("gemini")) return "gemini"
  return "other"
}

export function ccswitchSqlToJson(sql: string): any {
  const tmp = new DatabaseSync(":memory:")
  try {
    tmp.exec(sql)
    return extractCcSwitch(tmp, "ccswitch-sql")
  } catch (e: any) {
    const msg = e?.message || String(e)
    if (msg.includes("providers") && msg.includes("table")) throw e
    throw new Error(`cannot parse cc-switch SQL dump: ${msg}`)
  } finally {
    tmp.close()
  }
}

export function ccswitchDbToJson(data: Uint8Array): any {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-console-ccswitch-"))
  const file = path.join(dir, "ccswitch.db")
  let tmp: DatabaseSync | null = null
  try {
    fs.writeFileSync(file, data)
    const stat = fs.statSync(file)
    if (stat.size < 64) throw new Error("cc-switch .db file is too small to be a valid SQLite database")
    const header = data.slice(0, 16).reduce((s, b) => s + String.fromCharCode(b), "")
    if (header !== "SQLite format 3\u0000") throw new Error("not a valid SQLite database file — expected 'SQLite format 3' header, got " + JSON.stringify(header).slice(0, 20))
    tmp = new DatabaseSync(file)
    return extractCcSwitch(tmp, "ccswitch-db")
  } catch (e: any) {
    const msg = e?.message || String(e)
    if (msg.includes("not a valid SQLite") || msg.includes("too small") || msg.includes("header")) throw e
    if (msg.includes("providers") && msg.includes("table")) throw e
    throw new Error(`cannot open cc-switch .db: ${msg}`)
  } finally {
    tmp?.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

export function extractCcSwitch(tmp: DatabaseSync, source: string): any {
  const hasTable = (name: string) => !!tmp.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name)
  const requiredTables = ["providers"]
  const optionalTables = ["provider_endpoints", "model_pricing"]
  const warnings: string[] = []

  for (const table of requiredTables) {
    if (!hasTable(table)) {
      throw new Error(`cc-switch ${source} has no "${table}" table${source === "ccswitch-db" ? " — is this a valid CC Switch database?" : " — check the SQL dump content"}`)
    }
  }
  for (const table of optionalTables) {
    if (!hasTable(table)) {
      warnings.push(`table "${table}" not found in ${source}; related data will be empty`)
    }
  }

  const providers = new Map<string, any>()
  const rawPresets: any[] = []
  const skipped: Array<{ reason: string; name?: string }> = []
  const providerRows = tmp.prepare("SELECT * FROM providers").all() as any[]
  const endpointRows = hasTable("provider_endpoints") ? (tmp.prepare("SELECT * FROM provider_endpoints").all() as any[]) : []

  for (const row of providerRows) {
    let settings: any = {}
    let meta: any = {}
    try {
      settings = safeJson(row.settings_config)
    } catch {
      warnings.push(`failed to parse settings_config for row ${row.id || row.name || "unknown"}`)
      settings = {}
    }
    try {
      meta = safeJson(row.meta)
    } catch {
      warnings.push(`failed to parse meta for row ${row.id || row.name || "unknown"}`)
      meta = {}
    }
    const env = settings.env || {}
    const auth = settings.auth || {}
    const config = typeof settings.config === "string" ? settings.config : ""
    const configBase = config.match(/base_url\s*=\s*["']([^"']+)["']/i)?.[1]
    const configModel = config.match(/model\s*=\s*["']([^"']+)["']/i)?.[1]
    const baseUrl = firstString(
      row.base_url,
      env.ANTHROPIC_BASE_URL,
      env.OPENAI_BASE_URL,
      env.GEMINI_BASE_URL,
      env.GOOGLE_BASE_URL,
      configBase
    )
    if (!baseUrl) {
      skipped.push({ reason: "missing base_url in row", name: row.name || "unknown" })
      continue
    }
    const family = familyFromApp(String(row.app_type || row.app || ""))
    const apiKey = firstString(
      env.ANTHROPIC_AUTH_TOKEN,
      env.ANTHROPIC_API_KEY,
      env.OPENAI_API_KEY,
      env.GEMINI_API_KEY,
      env.GOOGLE_API_KEY,
      auth.OPENAI_API_KEY,
      auth.ANTHROPIC_API_KEY,
      auth.GEMINI_API_KEY
    )
    const models = [
      env.ANTHROPIC_MODEL,
      env.OPENAI_MODEL,
      env.GEMINI_MODEL,
      configModel,
      ...(Array.isArray(meta.claudeDesktopModelRoutes) ? meta.claudeDesktopModelRoutes : []),
    ].filter((m) => typeof m === "string" && m.trim())
    const key = normUrl(baseUrl)
    if (!providers.has(key)) {
      providers.set(key, { name: row.name || baseUrl, base_url: baseUrl, family, models: [] })
    }
    const provider = providers.get(key)
    for (const model of models) if (!provider.models.includes(model)) provider.models.push(model)
    rawPresets.push({
      name: row.name || "Imported Key",
      base_url: baseUrl,
      api_key: apiKey || null,
      family,
      api_format: meta.apiFormat || null,
      raw_settings_config: settings,
      endpoints: endpointRows.filter((e) => e.provider_id === row.id || e.provider_uuid === row.id).map((e) => e.url).filter(Boolean),
    })
  }

  if (rawPresets.length === 0 && providerRows.length > 0) {
    warnings.push("all provider rows were skipped — check base_url extraction from settings_config")
  }

  const pricing = hasTable("model_pricing") ? tmp.prepare("SELECT * FROM model_pricing").all() : []
  return {
    source,
    providers: [...providers.values()],
    raw_presets: rawPresets,
    model_pricing: pricing,
    warnings: warnings.length > 0 ? warnings : undefined,
    skipped: skipped.length > 0 ? skipped : undefined,
  }
}

export function generateConfig(tool: string, opts: {
  base_url: string
  api_key: string
  model: string
  api_format?: string | null
  raw_config_json?: string | null
  provider_name?: string | null
  group_name?: string | null
}): { content: string; format: string } {
  const baseUrl = opts.base_url.replace(/\/+$/, "")
  const openAiBaseUrl = withOpenAiV1(baseUrl)
  const apiKey = opts.api_key
  const model = opts.model
  const providerLabel = opts.provider_name || "provider"
  const groupLabel = opts.group_name ? `_${opts.group_name}` : ""
  const rawId = `${providerLabel}${groupLabel}`
  const providerId = rawId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "provider"
  let raw: any = null
  if (opts.raw_config_json) {
    try { raw = JSON.parse(opts.raw_config_json) } catch { raw = null }
  }

  if (tool === "claude") {
    const env: Record<string, string> = raw?.env ? { ...raw.env } : {}
    env["ANTHROPIC_BASE_URL"] = baseUrl
    env["ANTHROPIC_AUTH_TOKEN"] = apiKey
    env["ANTHROPIC_MODEL"] = model
    const settings: any = { ...raw }
    settings.env = env
    return { content: JSON.stringify(settings, null, 2), format: "json" }
  }

  if (tool === "codex") {
    // ponytail: codex config.toml has no api_key field. Embed the key as
    // experimental_bearer_token so codex is self-contained WITHOUT writing
    // OPENAI_API_KEY/OPENAI_BASE_URL env vars (which leak into opencode).
    const bearer = apiKey.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
    if (raw?.config && typeof raw.config === "string") {
      let toml = raw.config
      toml = toml.replace(/model\s*=\s*["'][^"']*["']/i, `model = "${model}"`)
      const baseUrlMatch = toml.match(/base_url\s*=\s*["']([^"']+)["']/i)
      if (baseUrlMatch) {
        toml = toml.replace(/base_url\s*=\s*["'][^"']*["']/i, `base_url = "${openAiBaseUrl}"`)
      }
      if (/experimental_bearer_token\s*=/i.test(toml)) {
        toml = toml.replace(/experimental_bearer_token\s*=\s*["'][^"']*["']/i, `experimental_bearer_token = "${bearer}"`)
      } else {
        const mpIdMatch = toml.match(/model_provider\s*=\s*["']([^"']+)["']/i)
        const mpId = mpIdMatch ? mpIdMatch[1] : null
        const headerRe = mpId ? new RegExp(`(\\[model_providers\\.${mpId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\][^\\n]*)`, "i") : null
        if (headerRe && headerRe.test(toml)) {
          toml = toml.replace(headerRe, `$1\nexperimental_bearer_token = "${bearer}"`)
        } else {
          toml += `\n\n[model_providers.${providerId}]\nname = "${providerLabel}"\nbase_url = "${openAiBaseUrl}"\nexperimental_bearer_token = "${bearer}"`
        }
      }
      return { content: toml, format: "toml" }
    }
    const toml = [
      `model = "${model}"`,
      `model_provider = "${providerId}"`,
      ``,
      `[model_providers.${providerId}]`,
      `name = "${providerLabel}"`,
      `base_url = "${openAiBaseUrl}"`,
      `experimental_bearer_token = "${bearer}"`,
    ].join("\n")
    return { content: toml, format: "toml" }
  }

  if (tool === "gemini") {
    const settings: any = raw ? { ...raw } : {}
    settings.selectedAuthType = "GEMINI_API_KEY"
    if (!settings.env) settings.env = {}
    settings.env["GEMINI_API_KEY"] = apiKey
    settings.env["GOOGLE_GEMINI_BASE_URL"] = baseUrl
    return { content: JSON.stringify(settings, null, 2), format: "json" }
  }

  if (tool === "opencode") {
    const config = buildOpenCodeConfig({ providerId, providerLabel, openAiBaseUrl, apiKey, model, apiFormat: opts.api_format, raw })
    return { content: JSON.stringify(config, null, 2), format: "json" }
  }

  return { content: JSON.stringify({ base_url: baseUrl, api_key: apiKey, model }, null, 2), format: "json" }
}

export function buildOpenCodeConfig(entry: {
  providerId: string
  providerLabel: string
  openAiBaseUrl: string
  apiKey: string
  model: string
  apiFormat?: string | null
  raw?: any
}): any {
  const api = entry.apiFormat === "anthropic" ? "anthropic" : "openai"
  const config: any = entry.raw ? { ...entry.raw } : {}
  if (!config.provider) config.provider = {}
  config.provider[entry.providerId] = {
    api,
    options: { baseURL: entry.openAiBaseUrl, apiKey: entry.apiKey },
    models: { [entry.model]: {} },
  }
  config.model = `${entry.providerId}/${entry.model}`
  return config
}

export function mergeOpenCodeConfig(entries: {
  providerId: string
  providerLabel: string
  openAiBaseUrl: string
  apiKey: string
  model: string
  apiFormat?: string | null
}[]): any {
  const config: any = { provider: {} }
  for (const entry of entries) {
    const single = buildOpenCodeConfig(entry)
    Object.assign(config.provider, single.provider)
  }
  const first = entries[0]
  config.model = first ? `${first.providerId}/${first.model}` : ""
  return config
}
