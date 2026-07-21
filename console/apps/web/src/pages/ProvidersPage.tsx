import { useMemo, useState, type FormEvent } from "react"
import { Link } from "react-router-dom"
import { ChevronRight, Key, Loader2, Plus, Trash2, Upload, X, AlertTriangle, CheckCircle, RotateCcw, History } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useCreateProvider, useDeleteProvider, useImportCcSwitch, useImportJobs, useProviders, useRollbackImport } from "@/hooks/useProviders"
import type { ImportJobItem } from "@/lib/api"

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
  const deleteProvider = useDeleteProvider()
  const importCcSwitch = useImportCcSwitch()
  const importJobs = useImportJobs()
  const rollbackImport = useRollbackImport()
  const [tab, setTab] = useState<string>("all")
  const [showAdd, setShowAdd] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [name, setName] = useState("")
  const [baseUrl, setBaseUrl] = useState("")
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

  async function onCreate(e: FormEvent) {
    e.preventDefault()
    setError("")
    try {
      await createProvider.mutateAsync({ name, base_url: baseUrl || null, models_endpoint: "/v1/models", preset: "custom", enabled: true })
      setName("")
      setBaseUrl("")
      setShowAdd(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : "新增失败")
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
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-sm font-medium">新增供应商</span>
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setShowAdd(false)}><X className="h-4 w-4" /></Button>
          </div>
          <form className="flex flex-wrap gap-2" onSubmit={onCreate}>
            <Input className="w-40" placeholder="名称" value={name} onChange={(e) => setName(e.target.value)} disabled={createProvider.isPending} required />
            <Input className="min-w-48 flex-1" placeholder="Base URL" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} disabled={createProvider.isPending} />
            <Button type="submit" size="sm" disabled={createProvider.isPending}>
              {createProvider.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Plus className="mr-1 h-4 w-4" />}
              添加
            </Button>
          </form>
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
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
