import { DatabaseSync } from "node:sqlite"
import crypto from "node:crypto"
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
  models?: string[]
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
  // ponytail: 纯非 ASCII 名（如中文「深度求索」）slug 化后为空，原兜底 "provider" 会让
  // 所有中文名供应商在 opencode.json / pi models.json 里撞成同一个 key（bug 8 的变体）。
  // 改为用名字的稳定短哈希：同输入→同输出（保留「按 name+group 派生」的设计，重导入仍稳定），
  // 不同中文名得到不同 id；mergeOpenCode/mergePi 的去重仍兑底极端哈希碰撞。ASCII 名保持原可读 slug。
  const slug = rawId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
  const providerId = slug || `p-${crypto.createHash("sha256").update(rawId).digest("hex").slice(0, 8)}`
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
    // ponytail: codex config.toml holds no key. The provider uses
    // requires_openai_auth=true so codex reads the key from ~/.codex/auth.json
    // (written by set_credential). Env-free - no OPENAI_API_KEY env var that
    // would leak into opencode.
    if (raw?.config && typeof raw.config === "string") {
      let toml = raw.config
      toml = toml.replace(/model\s*=\s*["'][^"']*["']/i, `model = "${model}"`)
      const baseUrlMatch = toml.match(/base_url\s*=\s*["']([^"']+)["']/i)
      if (baseUrlMatch) {
        toml = toml.replace(/base_url\s*=\s*["'][^"']*["']/i, `base_url = "${openAiBaseUrl}"`)
      }
      // drop stale bearer_token from older deploys
      toml = toml.replace(/experimental_bearer_token\s*=\s*["'][^"']*["']\n?/i, "")
      if (/requires_openai_auth\s*=/i.test(toml)) {
        toml = toml.replace(/requires_openai_auth\s*=\s*(true|false)/i, `requires_openai_auth = true`)
      } else {
        const mpIdMatch = toml.match(/model_provider\s*=\s*["']([^"']+)["']/i)
        const mpId = mpIdMatch ? mpIdMatch[1] : null
        const headerRe = mpId ? new RegExp(`(\\[model_providers\\.${mpId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\][^\\n]*)`, "i") : null
        if (headerRe && headerRe.test(toml)) {
          toml = toml.replace(headerRe, `$1\nrequires_openai_auth = true`)
        } else {
          toml += `\n\n[model_providers.${providerId}]\nname = "${providerLabel}"\nbase_url = "${openAiBaseUrl}"\nwire_api = "responses"\nrequires_openai_auth = true`
          // ponytail: 追加的 [model_providers.<providerId>] 段只有顶层 model_provider
          // 指向它才生效——否则 codex 仍用内置 provider，自定义 base_url 失效、
          // ~/.codex/auth.json 的 key 打到错误端点（bug 7）。对齐下方 no-raw 分支。
          if (mpIdMatch) {
            toml = toml.replace(/^[ \t]*model_provider[ \t]*=[ \t]*["'][^"']*["']/m, `model_provider = "${providerId}"`)
          } else {
            toml = `model_provider = "${providerId}"\n` + toml
          }
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
      `wire_api = "responses"`,
      `requires_openai_auth = true`,
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
    const config = buildOpenCodeConfig({ providerId, providerLabel, openAiBaseUrl, apiKey, model, models: opts.models, apiFormat: opts.api_format, raw })
    return { content: JSON.stringify(config, null, 2), format: "json" }
  }

  if (tool === "pi") {
    // ponytail: pi 读 ~/.pi/agent/models.json。provider+apiKey+models 全部内联，
    // 与 opencode 同构（单 JSON 文件，无独立凭据文件）。pi 通过 /model 交互选择
    // 模型，故 models.json 没有顶层默认 model 字段（区别于 opencode 的 config.model）。
    const config = buildPiConfig({ providerId, providerLabel, baseUrl, apiKey, model, models: opts.models, apiFormat: opts.api_format, raw })
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
  models?: string[]
  apiFormat?: string | null
  raw?: any
}): any {
  const api = entry.apiFormat === "anthropic" ? "anthropic" : "openai"
  const config: any = entry.raw ? { ...entry.raw } : {}
  if (!config.provider) config.provider = {}
  const modelList = entry.models && entry.models.length > 0 ? entry.models : [entry.model]
  const models: Record<string, any> = {}
  for (const m of modelList) models[m] = {}
  config.provider[entry.providerId] = {
    api,
    options: { baseURL: entry.openAiBaseUrl, apiKey: entry.apiKey },
    models,
  }
  config.model = `${entry.providerId}/${entry.model}`
  if (!config.$schema) config.$schema = "https://opencode.ai/config.json"
  if (!config.agent) config.agent = { build: { options: { store: false } }, plan: { options: { store: false } } }
  return config
}

export function mergeOpenCodeConfig(entries: {
  providerId: string
  providerLabel: string
  openAiBaseUrl: string
  apiKey: string
  model: string
  models?: string[]
  apiFormat?: string | null
}[]): any {
  const config: any = { provider: {} }
  const seen = new Set<string>()
  for (const entry of entries) {
    // ponytail: providerId 派生自 provider_name+group_name（非 DB UUID），同名同组
    // 必撞；Object.assign 会用第二个覆盖第一个的凭据，而 config.model 仍指向第一个
    // providerId → 默认模型解析到第二个凭据、第一个凭据静默丢失（bug 8）。去重加后缀。
    let pid = entry.providerId
    let n = 2
    while (seen.has(pid)) pid = `${entry.providerId}-${n++}`
    seen.add(pid)
    const single = buildOpenCodeConfig({ ...entry, providerId: pid })
    Object.assign(config.provider, single.provider)
  }
  const first = entries[0]
  config.model = first ? `${first.providerId}/${first.model}` : ""
  if (!config.$schema) config.$schema = "https://opencode.ai/config.json"
  if (!config.agent) config.agent = { build: { options: { store: false } }, plan: { options: { store: false } } }
  return config
}

// ponytail: 把 provider_keys.api_format（openai_responses|anthropic|gemini|""）映射到
// pi models.json 的 api 字段。pi 支持 openai-completions / openai-responses /
// anthropic-messages / google-generative-ai 四种；默认走 openai-completions（pi 文档
// 标注为“most compatible”，最适合中转/代理类供应商）。
export function piApiType(apiFormat?: string | null): string {
  switch (String(apiFormat || "").trim()) {
    case "anthropic":
      return "anthropic-messages"
    case "gemini":
      return "google-generative-ai"
    case "openai_responses":
      return "openai-responses"
    default:
      return "openai-completions"
  }
}

export function buildPiConfig(entry: {
  providerId: string
  providerLabel: string
  baseUrl: string
  apiKey: string
  model: string
  models?: string[]
  apiFormat?: string | null
  raw?: any
}): any {
  const api = piApiType(entry.apiFormat)
  // ponytail: 对齐本仓库 codex/claude/gemini 的 baseUrl 约定。pi 文档示例：
  // openai-completions 的 baseUrl 含 /v1（客户端不再拼），anthropic-messages /
  // google-generative-ai 的 baseUrl 不含 /v1（客户端自己拼 /v1/messages、
  // /v1beta/...）。若绕一用 withOpenAiV1，anthropic provider 会变成 .../v1，
  // pi 再拼出 .../v1/v1/messages 双 /v1。
  const usesOpenAiV1 = api === "openai-completions" || api === "openai-responses"
  const finalBaseUrl = usesOpenAiV1 ? withOpenAiV1(entry.baseUrl) : entry.baseUrl
  const config: any = entry.raw && typeof entry.raw === "object" ? { ...entry.raw } : {}
  if (!config.providers) config.providers = {}
  const modelList = entry.models && entry.models.length > 0 ? entry.models : [entry.model]
  const models = modelList.map((id) => ({ id, name: id }))
  config.providers[entry.providerId] = {
    baseUrl: finalBaseUrl,
    api,
    apiKey: entry.apiKey,
    models,
  }
  // ponytail: pi 没有 opencode 那样的顶层 config.model——pi 启动后用 /model 在所有
  // 已配置 provider 的模型里交互选择。这里不设默认，避免误导。
  return config
}

export function mergePiConfig(entries: {
  providerId: string
  providerLabel: string
  baseUrl: string
  apiKey: string
  model: string
  models?: string[]
  apiFormat?: string | null
}[]): any {
  const config: any = { providers: {} }
  const seen = new Set<string>()
  for (const entry of entries) {
    // ponytail: 同 mergeOpenCodeConfig——providerId 派生自 name+group，同名同组会在
    // providers 对象里互相覆盖、静默丢凭据。去重加后缀。
    let pid = entry.providerId
    let n = 2
    while (seen.has(pid)) pid = `${entry.providerId}-${n++}`
    seen.add(pid)
    const single = buildPiConfig({ ...entry, providerId: pid })
    Object.assign(config.providers, single.providers)
  }
  return config
}
