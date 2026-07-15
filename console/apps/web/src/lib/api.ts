const BASE = "/api"

let accessToken: string | null = localStorage.getItem("ai_console_access_token")

export function setAccessToken(token: string | null) {
  accessToken = token
  if (token) localStorage.setItem("ai_console_access_token", token)
  else localStorage.removeItem("ai_console_access_token")
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method || "GET").toUpperCase()
  const hasBody = method !== "GET" && method !== "HEAD" && method !== "DELETE"
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      ...(hasBody ? { "content-type": "application/json" } : {}),
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...(init?.headers || {}),
    },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`${res.status} ${text}`)
  }
  return res.json() as Promise<T>
}

export interface AuthUser {
  id: string
  username: string
  role: "admin" | "operator" | "viewer"
}

export interface AuthResponse {
  accessToken: string
  user: AuthUser
}

export interface ProviderListItem {
  id: string
  name: string
  base_url: string | null
  preset: string | null
  enabled: number
  key_count: number
  model_count: number
  families: string[]
}

export interface ProviderKey {
  id: string
  label: string
  group_name: string | null
  family: string
  api_format: string | null
  auth_type: string
  enabled: number
  default_model_id: string | null
}

export interface ProviderModel {
  id: string
  key_id: string | null
  model_id: string
  family: string | null
  display_name: string | null
  context_window: number | null
  enabled: number
}

export interface ProviderDetail {
  id: string
  name: string
  base_url: string | null
  models_endpoint: string | null
  preset: string | null
  enabled: number
  keys: ProviderKey[]
  models: ProviderModel[]
  endpoints: { id: number; url: string }[]
}

export interface ModelProvider {
  provider_id: string
  provider_name: string
}

export interface ModelItem {
  model_id: string
  family: string | null
  display_name: string | null
  context_window: number | null
  providers: ModelProvider[]
}

export interface ServerTool {
  name: string
  installed: number
  version: string | null
  path: string | null
  detected_at: number | null
}

export interface ServerItem {
  id: string
  name: string
  os: string | null
  arch: string | null
  host: string | null
  status: "online" | "offline" | "warning" | string
  last_seen: number | null
  tags: string[]
  group_id: string | null
  agent_version: string | null
  created_at: number
  tools: string[]
}

export interface ServerDetail extends Omit<ServerItem, "tools"> {
  tools: ServerTool[]
}

export interface AgentTask {
  id: string
  action: string
  payload_json: string
  status: "pending" | "running" | "done" | "failed" | string
  result_json: string | null
  error: string | null
  created_at: number
  claimed_at: number | null
  finished_at: number | null
}

export interface EnrollTokenResult {
  token: string
  expires_at: number
}

export interface AgentManifest {
  version: string
  binaries: Record<string, { sha256: string; size: number }>
}

export interface PingResult {
  ok: boolean
  latency_ms?: number
  model?: string
  status?: number
  error?: string
}

export interface RefreshModelsResult {
  ok: boolean
  created: number
  updated: number
  removed?: number
  total: number
}

export interface CreateProviderInput {
  name: string
  base_url?: string | null
  models_endpoint?: string | null
  preset?: string | null
  enabled?: boolean
}

export interface ImportProvidersResult {
  ok: boolean
  counts: Record<string, number>
  warnings?: string[]
  skipped?: Array<{ reason: string; name?: string }>
  skipped_count?: number
}

export interface ImportJobItem {
  id: string
  source_type: string
  source_path: string | null
  status: string
  counts: Record<string, any> | null
  started_by: string | null
  started_at: number
  finished_at: number | null
}

export interface ImportJobRollback {
  ok: boolean
  cleaned: Record<string, number>
}

export interface CreateProviderKeyInput {
  label: string
  api_key: string
  family: string
  group_name?: string | null
  api_format?: string | null
}

export type UpdateProviderInput = CreateProviderInput

export interface UpdateProviderKeyInput {
  label: string
  group_name?: string | null
  family: string
  api_format?: string | null
  enabled?: boolean
  api_key?: string
  default_model_id?: string | null
}

export interface KeyModelEntry {
  provider_id: string
  key_id: string
  model_id: string
  primary?: boolean
}

export interface ConfigPreview {
  tool: string
  model: string
  content: string
  format: string
}

export interface BatchProgressItem {
  server_id: string
  server_name: string
  task_id: string
  state: string
  error?: string | null
}

export interface BatchJob {
  id: string
  tool: string
  status: string
  progress: BatchProgressItem[]
  started_at: number
  finished_at: number | null
}

export interface AuditEntry {
  id: number
  actor: string | null
  action: string | null
  target: string | null
  before_json: string | null
  after_json: string | null
  ts: number
  request_id: string | null
  actor_name: string | null
}

export const api = {
  login: (username: string, password: string) =>
    request<AuthResponse>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  me: () => request<AuthResponse | { user: AuthUser }>("/auth/me"),
  refresh: () => request<AuthResponse>("/auth/refresh", { method: "POST", body: JSON.stringify({}) }),
  logout: () => request<{ ok: true }>("/auth/logout", { method: "POST", body: JSON.stringify({}) }),
  servers: () => request<ServerItem[]>("/servers"),
  server: (id: string) => request<ServerDetail>(`/servers/${id}`),
  updateServer: (id: string, input: { name: string }) =>
    request<{ ok: true; id: string; name: string }>(`/servers/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  deleteServer: (id: string) => request<{ ok: true }>(`/servers/${id}`, { method: "DELETE" }),
  serverTasks: (id: string) => request<AgentTask[]>(`/servers/${id}/tasks`),
  readServerConfig: (id: string, tool: string) =>
    request<AgentTask>(`/servers/${id}/configs/read`, {
      method: "POST",
      body: JSON.stringify({ tool }),
    }),
  writeServerConfig: (id: string, input: { tool: string; format: string; content: string }) =>
    request<AgentTask>(`/servers/${id}/configs/write`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  listConfigBackups: (id: string, tool: string) =>
    request<AgentTask>(`/servers/${id}/configs/backups`, {
      method: "POST",
      body: JSON.stringify({ tool }),
    }),
  restoreConfigBackup: (id: string, input: { tool: string; backup: string }) =>
    request<AgentTask>(`/servers/${id}/configs/restore`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  createEnrollToken: (input: { name?: string; tags?: string[]; expires_minutes?: number }) =>
    request<EnrollTokenResult>("/agent/enroll-tokens", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  providers: () => request<ProviderListItem[]>("/providers"),
  importCcSwitch: (input: unknown) =>
    request<ImportProvidersResult>("/providers/import/ccswitch", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  importJobs: () => request<ImportJobItem[]>("/import-jobs"),
  importJob: (id: string) => request<ImportJobItem>(`/import-jobs/${id}`),
  rollbackImport: (id: string) =>
    request<ImportJobRollback>(`/import-jobs/${id}/rollback`, {
      method: "POST",
    }),
  createProvider: (input: CreateProviderInput) =>
    request<ProviderListItem>("/providers", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  provider: (id: string) => request<ProviderDetail>(`/providers/${id}`),
  updateProvider: (id: string, input: UpdateProviderInput) =>
    request<ProviderDetail>(`/providers/${id}`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  deleteProvider: (id: string) => request<{ ok: true }>(`/providers/${id}`, { method: "DELETE" }),
  createProviderKey: (providerId: string, input: CreateProviderKeyInput) =>
    request<ProviderKey>(`/providers/${providerId}/keys`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  disableProviderKey: (providerId: string, keyId: string) =>
    request<{ ok: true }>(`/providers/${providerId}/keys/${keyId}`, { method: "DELETE" }),
  updateProviderKey: (providerId: string, keyId: string, input: UpdateProviderKeyInput) =>
    request<ProviderKey>(`/providers/${providerId}/keys/${keyId}`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  refreshModels: (providerId: string, keyId: string) =>
    request<RefreshModelsResult>(`/providers/${providerId}/keys/${keyId}/models/refresh`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
  models: () => request<ModelItem[]>("/models"),
  ping: (providerId: string, keyId: string, modelId?: string) =>
    request<PingResult>(`/providers/${providerId}/keys/${keyId}/ping`, {
      method: "POST",
      body: JSON.stringify(modelId ? { model_id: modelId } : {}),
    }),
  previewConfig: (input: { tool: string; provider_id: string; key_id: string; model_id: string } | { tool: string; keys: KeyModelEntry[] }) =>
    request<ConfigPreview>("/batch/preview", { method: "POST", body: JSON.stringify(input) }),
  batchExecute: (input: { tool: string; server_ids: string[]; provider_id: string; key_id: string; model_id: string } | { tool: string; server_ids: string[]; keys: KeyModelEntry[] }) =>
    request<{ id: string }>("/batch/execute", { method: "POST", body: JSON.stringify(input) }),
  batchStatus: (id: string) => request<BatchJob>(`/batch/${id}`),
  batchRollback: (id: string) => request<{ ok: true }>(`/batch/${id}/rollback`, { method: "POST", body: JSON.stringify({}) }),
  audit: (params?: { action?: string; actor?: string; limit?: number; offset?: number; start?: number; end?: number; request_id?: string }) => {
    const q = new URLSearchParams()
    if (params?.action) q.set("action", params.action)
    if (params?.actor) q.set("actor", params.actor)
    if (params?.limit) q.set("limit", String(params.limit))
    if (params?.offset) q.set("offset", String(params.offset))
    if (params?.start) q.set("start", String(params.start))
    if (params?.end) q.set("end", String(params.end))
    if (params?.request_id) q.set("request_id", params.request_id)
    const qs = q.toString()
    return request<AuditEntry[]>(`/audit${qs ? `?${qs}` : ""}`)
  },
  auditCount: (params?: { action?: string; actor?: string; start?: number; end?: number; request_id?: string }) => {
    const q = new URLSearchParams()
    if (params?.action) q.set("action", params.action)
    if (params?.actor) q.set("actor", params.actor)
    if (params?.start) q.set("start", String(params.start))
    if (params?.end) q.set("end", String(params.end))
    if (params?.request_id) q.set("request_id", params.request_id)
    const qs = q.toString()
    return request<{ total: number }>(`/audit/count${qs ? `?${qs}` : ""}`)
  },
  detectTools: (id: string, tool?: string | null) =>
    request<AgentTask>(`/servers/${id}/tools/detect`, { method: "POST", body: JSON.stringify({ tool }) }),
  agentManifest: () => request<AgentManifest>("/agent/manifest"),
  setCredential: (id: string, input: { tool: string; provider_id: string; key_id: string }) =>
    request<AgentTask>(`/servers/${id}/credentials/set`, { method: "POST", body: JSON.stringify(input) }),
  removeCredential: (id: string, input: { tool: string; provider_id?: string; key_id?: string }) =>
    request<AgentTask>(`/servers/${id}/credentials/remove`, { method: "POST", body: JSON.stringify(input) }),
  upgradeAgent: (id: string) => request<AgentTask>(`/servers/${id}/agent/upgrade`, { method: "POST", body: JSON.stringify({}) }),
  upgradeTool: (id: string, input: { tool: string; version?: string }) =>
    request<AgentTask>(`/servers/${id}/tools/upgrade`, { method: "POST", body: JSON.stringify(input) }),
  changePassword: (oldPassword: string, newPassword: string) =>
    request<{ ok: boolean }>("/auth/change-password", { method: "POST", body: JSON.stringify({ old_password: oldPassword, new_password: newPassword }) }),
}
