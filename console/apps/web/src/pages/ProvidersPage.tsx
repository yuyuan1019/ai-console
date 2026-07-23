import { useMemo, useState, type FormEvent } from "react"
import { Link } from "react-router-dom"
import { ChevronRight, ExternalLink, Key, Loader2, Plus, Trash2, Upload, X, AlertTriangle, CheckCircle, RotateCcw, History, Zap } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useCreateProvider, useDeleteProvider, useImportAccountCredential, useImportCcSwitch, useImportJobs, useProviders, useQuickAddProvider, useRollbackImport } from "@/hooks/useProviders"
import { useServers, useServerTasks } from "@/hooks/useServers"
import { PROVIDER_PRESETS } from "@/lib/providerPresets"
import type { ImportJobItem } from "@/lib/api"

type LoginImportState = {
  taskId: string
  serverId: string
  providerId: string
  providerName: string
  tool: "codex" | "claude"
  label: string
}

const TABS: { key: string; label: string; color: string }[] = [
  { key: "all", label: "全部", color: "" },
  { key: "claude", label: "Claude", color: "text-amber-500" },
  { key: "codex", label: "Codex", color: "text-emerald-500" },
  { key: "gemini", label: "Gemini", color: "text-blue-500" },
  { key: "other", label: "其他", color: "text-slate-500" },
]

function providerFamilies(p: { families: string[] }): string[] {
  return p.families.length ? p.families : ["none"]
}

export function ProvidersPage() {
  const { data, isLoading } = useProviders()
  const createProvider = useCreateProvider()
  const quickAdd = useQuickAddProvider()
  const importAccountCredential = useImportAccountCredential()
  const deleteProvider = useDeleteProvider()
  const { data: servers = [] } = useServers()
  const importCcSwitch = useImportCcSwitch()
  const importJobs = useImportJobs()
  const rollbackImport = useRollbackImport()
  const [tab, setTab] = useState<string>("all")
  const [showAdd, setShowAdd] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [name, setName] = useState("")
  const [baseUrl, setBaseUrl] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [label, setLabel] = useState("")
  const [selectedPresetKey, setSelectedPresetKey] = useState<string | null>(null)
  const [credentialMode, setCredentialMode] = useState<"apikey" | "subscription">("apikey")
  const [sourceServerId, setSourceServerId] = useState("")
  const [loginImport, setLoginImport] = useState<LoginImportState | null>(null)
  const { data: loginImportTasks = [] } = useServerTasks(loginImport?.serverId)
  const [error, setError] = useState("")
  const [importMsg, setImportMsg] = useState("")
  const [importWarnings, setImportWarnings] = useState<string[]>([])
  const [importSkipped, setImportSkipped] = useState<Array<{ reason: string; name?: string }>>([])
  const [importSkippedCount, setImportSkippedCount] = useState(0)

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: data?.length ?? 0 }
    for (const t of TABS) {
      if (t.key === "all") continue
      c[t.key] = data?.filter((p) => providerFamilies(p).includes(t.key)).length ?? 0
    }
    return c
  }, [data])

  const filtered = useMemo(() => {
    if (!data) return []
    if (tab === "all") return data
    return data.filter((p) => providerFamilies(p).includes(tab))
  }, [data, tab])

  const selectedPreset = useMemo(
    () => PROVIDER_PRESETS.find((p) => p.key === selectedPresetKey) ?? null,
    [selectedPresetKey]
  )
  const supportsSubscription = selectedPreset?.key === "openai" || selectedPreset?.key === "anthropic"
  const subscriptionTool: "codex" | "claude" = selectedPreset?.key === "anthropic" ? "claude" : "codex"
  const loginImportTask = loginImportTasks.find((task) => task.id === loginImport?.taskId)
  const pending = createProvider.isPending || quickAdd.isPending || importAccountCredential.isPending

  function resetAddForm() {
    setName("")
    setBaseUrl("")
    setApiKey("")
    setLabel("")
    setSourceServerId("")
    setCredentialMode("apikey")
    setSelectedPresetKey(null)
    setShowAdd(false)
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault()
    setError("")
    // 未选预设时退回 codex/openai-compat 默认；选了预设则用预设的 family/apiFormat/modelsEndpoint
    const fam = selectedPreset?.family ?? "codex"
    const apiFmt = selectedPreset?.apiFormat ?? null
    const modelsEp = selectedPreset?.modelsEndpoint ?? "/v1/models"
    const presetKey = selectedPreset?.key ?? "custom"
    try {
      if (supportsSubscription && credentialMode === "subscription") {
        if (!sourceServerId) throw new Error("请选择已经完成账户登录的来源服务器")
        const provider = await createProvider.mutateAsync({
          name,
          base_url: baseUrl || null,
          models_endpoint: modelsEp,
          preset: presetKey,
          enabled: true,
        })
        const credentialLabel = label.trim() || (subscriptionTool === "codex" ? "Codex 订阅登录" : "Claude 订阅登录")
        const task = await importAccountCredential.mutateAsync({
          serverId: sourceServerId,
          providerId: provider.id,
          tool: subscriptionTool,
          label: credentialLabel,
        })
        setLoginImport({
          taskId: task.id,
          serverId: sourceServerId,
          providerId: provider.id,
          providerName: provider.name,
          tool: subscriptionTool,
          label: credentialLabel,
        })
      } else if (apiKey.trim()) {
        // 填了 key：一步创建 provider + 加密保存 key（预设常用场景）
        await quickAdd.mutateAsync({
          name,
          base_url: baseUrl,
          models_endpoint: modelsEp,
          preset: presetKey,
          family: fam,
          api_format: apiFmt,
          api_key: apiKey.trim(),
          label: label.trim() || "默认",
        })
      } else {
        // 没填 key：仅建供应商（原行为）
        await createProvider.mutateAsync({
          name,
          base_url: baseUrl || null,
          models_endpoint: modelsEp,
          preset: presetKey,
          enabled: true,
        })
      }
      resetAddForm()
    } catch (err) {
      setError(err instanceof Error ? err.message : "新增失败")
    }
  }

  async function retryLoginImport() {
    if (!loginImport) return
    setError("")
    try {
      const task = await importAccountCredential.mutateAsync({
        serverId: loginImport.serverId,
        providerId: loginImport.providerId,
        tool: loginImport.tool,
        label: loginImport.label,
      })
      setLoginImport({ ...loginImport, taskId: task.id })
    } catch (err) {
      setError(err instanceof Error ? err.message : "重新读取登录信息失败")
    }
  }

  async function onDelete(id: string, providerName: string) {
    if (!confirm(`删除「${providerName}」？关联 key/模型/endpoint 也会删除。`)) return
    setError("")
    try {
      await deleteProvider.mutateAsync(id)
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除失败")
    }
  }

  async function onImport(file: File | undefined) {
    if (!file) return
    setImportMsg("")
    setImportWarnings([])
    setImportSkipped([])
    setImportSkippedCount(0)
    setError("")
    try {
      const name = file.name.toLowerCase()
      const payload = name.endsWith(".db")
        ? { filename: file.name, content_base64: bytesToBase64(new Uint8Array(await file.arrayBuffer())) }
        : name.endsWith(".sql")
          ? { filename: file.name, content: await file.text() }
          : JSON.parse(await file.text())
      const r = await importCcSwitch.mutateAsync(payload)
      const parts = [`${r.counts.providers} 供应商`, `${r.counts.keys} key`, `${r.counts.models} 模型`]
      if (r.counts.oauth) parts.push(`${r.counts.oauth} OAuth`)
      if (r.counts.endpoints) parts.push(`${r.counts.endpoints} 端点`)
      if (r.counts.pricing) parts.push(`${r.counts.pricing} 定价`)
      setImportMsg(`导入完成：${parts.join("，")}`)
      if (r.skipped && r.skipped.length > 0) {
        setImportSkipped(r.skipped)
        setImportSkippedCount(r.skipped_count ?? r.skipped.length)
      }
      if (r.warnings && r.warnings.length > 0) {
        setImportWarnings(r.warnings)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "导入失败")
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">供应商</h1>
          <p className="text-sm text-muted-foreground">{isLoading ? "加载中…" : `${data?.length ?? 0} 个供应商`}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setShowAdd((v) => !v)}>
            <Plus className="mr-1 h-4 w-4" /> 新增
          </Button>
          <label className="inline-flex h-8 cursor-pointer items-center rounded-md border border-input bg-background px-3 text-sm font-medium hover:bg-accent">
            {importCcSwitch.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Upload className="mr-1 h-4 w-4" />}
            导入
            <input type="file" accept="application/json,.json,.sql,.db" className="hidden" disabled={importCcSwitch.isPending} onChange={(e) => void onImport(e.target.files?.[0])} />
          </label>
        </div>
      </div>

      {showAdd && (
        <div className="space-y-3 rounded-lg border border-border bg-card p-4">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">新增供应商</span>
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setShowAdd(false)}><X className="h-4 w-4" /></Button>
          </div>

          <div className="space-y-2">
            <div className="text-xs font-medium text-muted-foreground">1. 选择供应商</div>
            <div className="grid gap-2 sm:grid-cols-2">
              {PROVIDER_PRESETS.filter((preset) => preset.key === "openai" || preset.key === "anthropic").map((preset) => (
                <button
                  key={preset.key}
                  type="button"
                  onClick={() => {
                    setSelectedPresetKey(preset.key)
                    setName(preset.name)
                    setBaseUrl(preset.baseUrl)
                    setCredentialMode("apikey")
                    setSourceServerId("")
                    setApiKey("")
                  }}
                  className={`rounded-lg border p-3 text-left transition-colors ${selectedPresetKey === preset.key ? "border-primary bg-primary/10" : "border-border bg-background hover:bg-accent"}`}
                >
                  <div className="font-medium">{preset.name}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">{preset.key === "openai" ? "API Key 或 Codex 订阅账户" : "API Key 或 Claude 订阅账户"}</div>
                </button>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-1.5 pt-1">
              <span className="text-xs text-muted-foreground">其他 API 供应商</span>
              <button
                type="button"
                onClick={() => { setSelectedPresetKey(null); setCredentialMode("apikey"); setSourceServerId("") }}
                className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] transition-colors ${selectedPresetKey === null ? "border-primary bg-primary/10 text-primary" : "border-border bg-background hover:bg-accent"}`}
              >
                自定义
              </button>
            </div>
            {(["国外", "国内"] as const).map((region) => (
              <div key={region} className="flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-[11px] text-muted-foreground/70">{region}</span>
                {PROVIDER_PRESETS.filter((preset) => preset.region === region && preset.key !== "openai" && preset.key !== "anthropic").map((preset) => (
                  <button
                    key={preset.key}
                    type="button"
                    title={preset.description}
                    onClick={() => {
                      setSelectedPresetKey(preset.key)
                      setBaseUrl(preset.baseUrl)
                      setName(preset.name)
                      setCredentialMode("apikey")
                      setSourceServerId("")
                    }}
                    className={`inline-flex items-center rounded-md border px-2 py-1 text-xs transition-colors ${selectedPresetKey === preset.key ? "border-primary bg-primary/10 text-primary" : "border-border bg-background hover:bg-accent"}`}
                  >
                    {preset.name}
                  </button>
                ))}
              </div>
            ))}
          </div>

          {selectedPreset && (
            <div className="flex items-center gap-2 rounded-md bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground">
              <Zap className="h-3.5 w-3.5 shrink-0 text-amber-500" />
              <span className="truncate">{selectedPreset.description}</span>
              <a href={selectedPreset.docsUrl} target="_blank" rel="noreferrer" className="ml-auto inline-flex shrink-0 items-center gap-0.5 text-primary hover:underline">
                {credentialMode === "subscription" ? "账户登录说明" : "申请 Key"} <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          )}

          {supportsSubscription && (
            <div className="space-y-2 rounded-md border border-border p-3">
              <div className="text-xs font-medium text-muted-foreground">2. 选择认证方式</div>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => setCredentialMode("apikey")} className={`rounded-md border px-3 py-1.5 text-xs ${credentialMode === "apikey" ? "border-primary bg-primary/10 text-primary" : "border-border"}`}>API Key</button>
                <button type="button" onClick={() => { setCredentialMode("subscription"); setApiKey("") }} className={`rounded-md border px-3 py-1.5 text-xs ${credentialMode === "subscription" ? "border-primary bg-primary/10 text-primary" : "border-border"}`}>
                  {selectedPreset?.key === "openai" ? "Codex 订阅登录" : "Claude 订阅登录"}
                </button>
              </div>
            </div>
          )}

          <form className="space-y-3" onSubmit={onCreate}>
            <div className="flex flex-wrap items-center gap-2">
              <Input className="w-44" placeholder="名称" value={name} onChange={(e) => setName(e.target.value)} disabled={pending} required />
              <Input className="min-w-56 flex-1" placeholder="Base URL" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} disabled={pending || credentialMode === "subscription"} />
              {credentialMode === "subscription" && supportsSubscription ? (
                <select value={sourceServerId} onChange={(e) => setSourceServerId(e.target.value)} className="h-10 min-w-64 flex-1 rounded-md border border-input bg-background px-3 text-sm" disabled={pending} required>
                  <option value="">选择当前已登录的服务器…</option>
                  {servers.filter((server) => server.status === "online").map((server) => <option key={server.id} value={server.id}>{server.name} (Agent {server.agent_version || "未知"})</option>)}
                </select>
              ) : (
                <Input
                  className="min-w-56 flex-1"
                  type="text"
                  placeholder={selectedPreset ? "API Key" : "API Key（可选，留空仅建供应商）"}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  disabled={pending}
                  required={Boolean(selectedPreset)}
                />
              )}
              <Input className="w-40" placeholder="凭据标签（可选）" value={label} onChange={(e) => setLabel(e.target.value)} disabled={pending} />
              <Button type="submit" size="sm" disabled={pending || (credentialMode === "subscription" && !sourceServerId)}>
                {pending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Plus className="mr-1 h-4 w-4" />}
                {credentialMode === "subscription" && supportsSubscription ? "读取登录并保存" : apiKey.trim() ? "添加并保存 Key" : "添加"}
              </Button>
            </div>
            {credentialMode === "subscription" && supportsSubscription && (
              <div className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                系统会先读取来源服务器上的登录信息。请预先运行 <code>{subscriptionTool === "codex" ? "codex login" : "claude auth login"}</code>；如果尚未登录，保存后的任务会明确提示登录并可重新读取。
              </div>
            )}
          </form>
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
      {loginImport && (
        <div className={`rounded-md border p-3 ${loginImportTask?.status === "done" ? "border-emerald-200 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950" : loginImportTask?.status === "failed" ? "border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950" : "border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-950"}`}>
          {loginImportTask?.status === "done" ? (
            <div className="flex flex-wrap items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400">
              <CheckCircle className="h-4 w-4" />
              <span>{loginImport.providerName} 的订阅登录已加密保存，可以下发到其他机器。</span>
              <Link to={`/providers/${loginImport.providerId}`} className="font-medium underline">查看凭据</Link>
            </div>
          ) : loginImportTask?.status === "failed" ? (
            <div className="space-y-2 text-sm text-red-700 dark:text-red-400">
              <div className="flex items-center gap-1.5"><AlertTriangle className="h-4 w-4" />未读取到有效登录信息：{loginImportTask.error || "读取失败"}</div>
              <div className="text-xs">请确认来源服务器 Agent 已升级到 v2.0.6，并运行 <code>{loginImport.tool === "codex" ? "codex login" : "claude auth login"}</code>，完成后点击重新读取。</div>
              <Button size="sm" variant="outline" disabled={importAccountCredential.isPending} onClick={() => void retryLoginImport()}>
                {importAccountCredential.isPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="mr-1 h-3.5 w-3.5" />}重新读取
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 text-sm text-blue-700 dark:text-blue-400">
              <Loader2 className="h-4 w-4 animate-spin" />正在从来源服务器读取并验证订阅登录信息…
            </div>
          )}
        </div>
      )}
      {importMsg && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 dark:border-emerald-800 dark:bg-emerald-950">
          <div className="flex items-center gap-1.5 text-sm font-medium text-emerald-700 dark:text-emerald-400">
            <CheckCircle className="h-4 w-4" /> {importMsg}
          </div>
        </div>
      )}
      {importWarnings.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950">
          <div className="flex items-center gap-1.5 text-sm font-medium text-amber-700 dark:text-amber-400">
            <AlertTriangle className="h-4 w-4" /> {importWarnings.length} 个警告
          </div>
          <ul className="mt-2 space-y-1 text-xs text-amber-600 dark:text-amber-500">
            {importWarnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}
      {importSkipped.length > 0 && (
        <div className="rounded-md border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-900">
          <div className="text-sm font-medium">跳过 {importSkippedCount} 条记录</div>
          <ul className="mt-2 max-h-32 overflow-auto space-y-1 text-xs text-muted-foreground">
            {importSkipped.slice(0, 20).map((s, i) => (
              <li key={i}>{s.reason} {s.name ? `(${s.name})` : ""}</li>
            ))}
            {importSkipped.length > 20 && <li className="text-muted-foreground">…及 {importSkipped.length - 20} 条</li>}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setShowHistory((v) => !v)}
        >
          <History className="mr-1 h-4 w-4" />
          导入历史 {importJobs.data ? `(${importJobs.data.length})` : ""}
        </Button>
      </div>

      {showHistory && (
        <div className="rounded-lg border border-border bg-card p-4 space-y-3">
          {importJobs.isLoading && <p className="text-sm text-muted-foreground">加载中…</p>}
          {importJobs.data?.length === 0 && <p className="text-sm text-muted-foreground">暂无导入记录</p>}
          {importJobs.data?.map((job) => (
            <ImportJobRow key={job.id} job={job} rollbackPending={!!rollbackImport.isPending} onRollback={(id) => {
              if (!confirm(`回滚导入「${job.source_path || job.id}」？将删除此次导入创建的供应商、key、模型和端点。`)) return
              rollbackImport.mutate(id)
            }} />
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-1 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`relative px-3 py-2 text-sm font-medium transition-colors ${tab === t.key ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            <span className={t.color ?? ""}>{t.label}</span>
            <span className="ml-1 text-xs text-muted-foreground">{counts[t.key] ?? 0}</span>
            {tab === t.key && <span className="absolute inset-x-0 -bottom-px h-0.5 bg-primary" />}
          </button>
        ))}
      </div>

      {filtered.length === 0 && !isLoading && (
        <p className="py-8 text-center text-sm text-muted-foreground">该分类下暂无供应商</p>
      )}

      <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
        {filtered.map((p) => (
          <div key={p.id} className="group flex items-center gap-3 bg-card px-4 py-3 transition-colors hover:bg-accent/50">
            <Link to={`/providers/${p.id}`} className="flex min-w-0 flex-1 items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{p.name}</span>
                  {p.families.map((f) => (
                    <Badge key={f} variant="outline" className="shrink-0 text-[10px] capitalize">{f}</Badge>
                  ))}
                </div>
                <p className="truncate text-xs text-muted-foreground">{p.base_url || "未设置 Base URL"}</p>
              </div>
              <div className="flex shrink-0 items-center gap-4 text-xs text-muted-foreground">
                <span className="flex items-center gap-1"><Key className="h-3 w-3" />{p.key_count}</span>
                <span>{p.model_count} 模型</span>
              </div>
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </Link>
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
              disabled={deleteProvider.isPending}
              onClick={() => void onDelete(p.id, p.name)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>
    </div>
  )
}

function ImportJobRow({ job, onRollback, rollbackPending }: { job: ImportJobItem; onRollback: (id: string) => void; rollbackPending: boolean }) {
  const counts = job.counts || ({} as any)
  const providerCount = counts.providers ?? 0
  const keyCount = counts.keys ?? 0
  const modelCount = counts.models ?? 0
  const endpointCount = counts.endpoints ?? 0
  const pricingCount = counts.pricing ?? 0
  const oauthCount = counts.oauth ?? 0
  const createdSummaries: string[] = []
  if (providerCount) createdSummaries.push(`${providerCount} 供应商`)
  if (keyCount) createdSummaries.push(`${keyCount} key`)
  if (oauthCount) createdSummaries.push(`${oauthCount} OAuth`)
  if (modelCount) createdSummaries.push(`${modelCount} 模型`)
  if (endpointCount) createdSummaries.push(`${endpointCount} 端点`)
  if (pricingCount) createdSummaries.push(`${pricingCount} 定价`)
  const parts = createdSummaries.length > 0 ? createdSummaries.join("，") : "无数据"

  const isRolledBack = job.status === "rolled_back"

  return (
    <div className="flex items-start justify-between rounded border border-border bg-muted/30 p-3 text-sm">
      <div className="min-w-0 space-y-1">
        <div className="flex items-center gap-2">
          <span className="font-medium truncate">{job.source_path || job.source_type || "—"}</span>
          <Badge variant={isRolledBack ? "destructive" : "secondary"} className="text-xs">
            {isRolledBack ? "已回滚" : job.status}
          </Badge>
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          <span>{parts}</span>
          <span className="text-muted-foreground/60">{formatTs(job.started_at)}</span>
        </div>
      </div>
      {!isRolledBack && (
        <Button
          size="sm"
          variant="ghost"
          className="ml-2 h-7 shrink-0 text-destructive"
          disabled={rollbackPending}
          onClick={() => onRollback(job.id)}
        >
          <RotateCcw className="mr-1 h-3 w-3" /> 回滚
        </Button>
      )}
    </div>
  )
}

function formatTs(ts: number) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}
