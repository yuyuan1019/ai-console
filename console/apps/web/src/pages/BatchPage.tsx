import { useState } from "react"
import { CheckCircle2, ChevronRight, Loader2, Rocket, RotateCcw, XCircle, Eye, X, Plus } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useServers } from "@/hooks/useServers"
import { useProviders, useProvider } from "@/hooks/useProviders"
import { usePreviewConfig, useBatchExecute, useBatchStatus, useBatchRollback } from "@/hooks/useBatch"
import type { ConfigPreview, KeyModelEntry } from "@/lib/api"
import { cn } from "@/lib/utils"

const TOOLS = [
  { key: "codex", label: "Codex", desc: "OpenAI Codex CLI" },
  { key: "claude", label: "Claude Code", desc: "Anthropic Claude" },
  { key: "gemini", label: "Gemini", desc: "Google Gemini CLI" },
  { key: "opencode", label: "OpenCode", desc: "OpenCode editor · 支持多渠道" },
]

export function BatchPage() {
  const [step, setStep] = useState(1)
  const [tool, setTool] = useState("")
  const [providerId, setProviderId] = useState("")
  const [keyId, setKeyId] = useState("")
  const [modelId, setModelId] = useState("")
  const [selectedKeys, setSelectedKeys] = useState<KeyModelEntry[]>([])
  const [preview, setPreview] = useState<ConfigPreview | null>(null)
  const [selectedServers, setSelectedServers] = useState<Set<string>>(new Set())
  const [batchId, setBatchId] = useState<string | null>(null)

  const { data: servers = [] } = useServers()
  const { data: providers = [] } = useProviders()
  const { data: providerDetail } = useProvider(providerId || undefined)
  const previewMut = usePreviewConfig()
  const executeMut = useBatchExecute()
  const { data: batchStatus } = useBatchStatus(batchId)
  const rollbackMut = useBatchRollback()

  const eligibleServers = servers.filter((s) => s.status === "online" && (tool === "opencode" ? s.tools.some((t) => t === "opencode" || t === "codex") : s.tools.includes(tool)))

  function generatePreview() {
    setPreview(null)
    if (tool === "opencode" && selectedKeys.length > 0) {
      previewMut.mutate({ tool, keys: selectedKeys }, { onSuccess: setPreview, onError: (e) => alert(String(e)) })
    } else if (providerId && keyId && modelId) {
      previewMut.mutate({ tool, provider_id: providerId, key_id: keyId, model_id: modelId }, { onSuccess: setPreview, onError: (e) => alert(String(e)) })
    }
  }

  function toggleServer(id: string) {
    setSelectedServers((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function doExecute() {
    if (!confirm(`确认下发 ${tool} 配置到 ${selectedServers.size} 台机器？每台机器会先备份当前配置。`)) return
    const onSuccess = (r: { id: string }) => { setBatchId(r.id); setStep(4) }
    const onError = (e: Error) => alert(String(e))
    if (tool === "opencode" && selectedKeys.length > 0) {
      executeMut.mutate(
        { tool, server_ids: [...selectedServers], keys: selectedKeys },
        { onSuccess, onError }
      )
    } else {
      executeMut.mutate(
        { tool, server_ids: [...selectedServers], provider_id: providerId, key_id: keyId, model_id: modelId },
        { onSuccess, onError }
      )
    }
  }

  function doRollback() {
    if (!batchId) return
    if (!confirm("回滚所有成功写入的机器到写入前配置？")) return
    rollbackMut.mutate(batchId, {
      onSuccess: () => alert("回滚任务已创建，agent 将在下次心跳时执行。"),
      onError: (err: any) => {
        // ponytail (BUG-04): server returns explicit codes for the two race
        // states — batch_not_finished (running) and already_rolled_back — so
        // users get a clear signal instead of a generic "Request failed".
        const msg = String(err?.message || "")
        if (msg.includes("batch_not_finished")) alert("批次还在执行中，请等待完成后再回滚。")
        else if (msg.includes("already_rolled_back")) alert("该批次已回滚过。")
        else if (msg.includes("rollback_in_progress")) alert("回滚已在进行中。")
        else alert("回滚失败：" + msg)
      },
    })
  }

  const canPreview = (tool === "opencode" && selectedKeys.length > 0) || (!!providerId && !!keyId && !!modelId)

  function addKeyEntry() {
    if (!providerId || !keyId || !modelId) return
    if (selectedKeys.some((k) => k.key_id === keyId)) return
    const entry: KeyModelEntry = { provider_id: providerId, key_id: keyId, model_id: modelId, primary: selectedKeys.length === 0 }
    setSelectedKeys([...selectedKeys, entry])
    setKeyId("")
    setModelId("")
  }
  function removeKeyEntry(keyId: string) {
    const next = selectedKeys.filter((k) => k.key_id !== keyId)
    if (next.length > 0 && !next.some((k) => k.primary)) next[0] = { ...next[0], primary: true }
    setSelectedKeys(next)
  }
  function setPrimaryKey(keyId: string) {
    setSelectedKeys(selectedKeys.map((k) => ({ ...k, primary: k.key_id === keyId })))
  }

  const availableProviderKeys = providerDetail?.keys.filter((k) => k.enabled === 1 && !selectedKeys.some((sk) => sk.key_id === k.id)) || []
  const multiKey = tool === "opencode" && selectedKeys.length > 0
  // ponytail (BUG-04): only enable rollback when the write pass is genuinely
  // terminal (done/partial). rolling_back/rolled_back/partial_rollback all
  // mean rollback is already unavailable; the server would 409/202 anyway,
  // but the UI should not offer the button in the first place.
  const canRollback = batchStatus?.status === "done" || batchStatus?.status === "partial"
  const allDone = batchStatus?.progress?.length ? batchStatus.progress.every((p) => p.state === "done" || p.state === "failed" || p.state === "skipped") : false

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">批量操作</h1>
        <p className="text-sm text-muted-foreground">一键将配置同步到多台机器</p>
      </div>

      <div className="flex items-center gap-2 text-sm">
        {["选择工具", "选择配置", "选择机器", "执行"].map((label, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className={cn("flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium", step > i + 1 ? "bg-primary text-primary-foreground" : step === i + 1 ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>
              {step > i + 1 ? "✓" : i + 1}
            </span>
            <span className={step === i + 1 ? "font-medium" : "text-muted-foreground"}>{label}</span>
            {i < 3 && <ChevronRight className="h-4 w-4 text-muted-foreground" />}
          </div>
        ))}
      </div>

      {step === 1 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {TOOLS.map((t) => (
            <button
              key={t.key}
              onClick={() => { setTool(t.key); setStep(2); setPreview(null); setProviderId(""); setKeyId(""); setModelId(""); setSelectedKeys([]) }}
              className="rounded-lg border border-border bg-card p-4 text-left transition-colors hover:border-primary/50 hover:bg-accent/50"
            >
              <div className="text-base font-semibold">{t.label}</div>
              <div className="mt-1 text-xs text-muted-foreground">{t.desc}</div>
            </button>
          ))}
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          {!multiKey && (
            <div className="grid gap-3 md:grid-cols-3 max-w-2xl">
              <div className="space-y-1">
                <span className="text-xs font-medium text-muted-foreground">供应商</span>
                <select value={providerId} onChange={(e) => { setProviderId(e.target.value); setKeyId(""); setModelId(""); setPreview(null) }} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
                  <option value="">选择供应商…</option>
                  {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <div className="space-y-1">
                <span className="text-xs font-medium text-muted-foreground">Key</span>
                <select value={keyId} onChange={(e) => { setKeyId(e.target.value); setPreview(null) }} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" disabled={!providerDetail}>
                  <option value="">选择 Key…</option>
                  {(providerDetail?.keys || []).filter((k) => k.enabled === 1).map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
                </select>
              </div>
              <div className="space-y-1">
                <span className="text-xs font-medium text-muted-foreground">模型</span>
                <select value={modelId} onChange={(e) => { setModelId(e.target.value); setPreview(null) }} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" disabled={!providerDetail}>
                  <option value="">选择模型…</option>
                  {providerDetail?.models.map((m) => <option key={m.id} value={m.model_id}>{m.model_id}</option>)}
                </select>
              </div>
            </div>
          )}

          {tool === "opencode" && !multiKey && (
            <Button size="sm" variant="outline" disabled={!providerId || !keyId || !modelId} onClick={() => { addKeyEntry(); setProviderId(""); setKeyId(""); setModelId(""); setPreview(null) }}>
              <Plus className="mr-1 h-3.5 w-3.5" /> 添加为渠道
            </Button>
          )}

          {tool === "opencode" && multiKey && (
            <div className="space-y-3 max-w-2xl">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">已选渠道 ({selectedKeys.length})</span>
                <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => { setSelectedKeys([]); setPreview(null) }}>清空</Button>
              </div>
              {selectedKeys.map((entry) => {
                const p = providers.find((x) => x.id === entry.provider_id)
                const k = providerDetail?.keys.find((x) => x.id === entry.key_id) || (p ? undefined : undefined)
                const label = k?.label || entry.key_id
                return (
                  <div key={entry.key_id} className="flex items-center gap-3 rounded-lg border border-border bg-card p-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="font-medium">{p?.name || entry.provider_id}</span>
                        <span className="text-muted-foreground">/ {label}</span>
                        <Badge variant="secondary" className="text-[10px]">{entry.model_id}</Badge>
                        {entry.primary && <Badge className="text-[10px] bg-amber-900/30 text-amber-400 border-amber-700/30">优先模型</Badge>}
                      </div>
                    </div>
                    <Button size="sm" variant={entry.primary ? "secondary" : "outline"} className="h-7 text-xs" disabled={entry.primary} onClick={() => { setPrimaryKey(entry.key_id); setPreview(null) }}>
                      {entry.primary ? "主" : "设为优先"}
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7 text-xs text-destructive" onClick={() => { removeKeyEntry(entry.key_id); setPreview(null) }}>
                      <X className="mr-1 h-3 w-3" /> 移除
                    </Button>
                  </div>
                )
              })}
              {availableProviderKeys.length > 0 && (
                <div className="rounded-lg border border-dashed border-border p-3 space-y-2">
                  <span className="text-xs font-medium text-muted-foreground">添加更多渠道</span>
                  <div className="flex flex-wrap gap-2 items-end">
                    <select value={providerId} onChange={(e) => { setProviderId(e.target.value); setKeyId(""); setModelId(""); setPreview(null) }} className="h-9 w-36 rounded-md border border-input bg-background px-2 text-xs">
                      <option value="">供应商</option>
                      {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                    <select value={keyId} onChange={(e) => { setKeyId(e.target.value); setPreview(null) }} className="h-9 w-40 rounded-md border border-input bg-background px-2 text-xs" disabled={!availableProviderKeys.length && !providerDetail}>
                      <option value="">Key</option>
                      {availableProviderKeys.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
                    </select>
                    <select value={modelId} onChange={(e) => setModelId(e.target.value)} className="h-9 w-48 rounded-md border border-input bg-background px-2 text-xs" disabled={!providerDetail}>
                      <option value="">模型</option>
                      {providerDetail?.models.map((m) => <option key={m.id} value={m.model_id}>{m.model_id}</option>)}
                    </select>
                    <Button size="sm" variant="outline" disabled={!providerId || !keyId || !modelId} onClick={() => { addKeyEntry(); setProviderId(""); setKeyId(""); setModelId(""); setPreview(null) }}>
                      <Plus className="mr-1 h-3.5 w-3.5" /> 添加
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" disabled={!canPreview || previewMut.isPending} onClick={generatePreview}>
              {previewMut.isPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Eye className="mr-1 h-3.5 w-3.5" />}
              预览配置
            </Button>
            {tool && <Button size="sm" disabled={!preview} onClick={() => setStep(3)}>下一步 <ChevronRight className="ml-1 h-3.5 w-3.5" /></Button>}
            <Button size="sm" variant="ghost" onClick={() => setStep(1)}>返回</Button>
          </div>

          {preview && (
            <div className="max-w-2xl space-y-2">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="outline">{preview.format}</Badge>
                <span>model: {preview.model}</span>
              </div>
              <pre className="max-h-64 overflow-auto rounded-lg border border-border bg-muted/50 p-3 text-xs"><code>{preview.content}</code></pre>
            </div>
          )}
        </div>
      )}

      {step === 3 && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">选中 {selectedServers.size} 台，在线且已装 {tool} 的机器共 {eligibleServers.length} 台</span>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => { setSelectedServers(new Set(eligibleServers.map((s) => s.id))) }}>全选在线</Button>
              <Button size="sm" variant="ghost" onClick={() => setSelectedServers(new Set())}>清空</Button>
            </div>
          </div>
          {eligibleServers.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">没有在线且安装了 {tool} 的机器</p>
          ) : (
            <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
              {eligibleServers.map((s) => (
                <label key={s.id} className="flex cursor-pointer items-center gap-3 bg-card px-4 py-2.5 hover:bg-accent/50">
                  <input type="checkbox" checked={selectedServers.has(s.id)} onChange={() => toggleServer(s.id)} className="h-4 w-4" />
                  <div className="min-w-0 flex-1">
                    <span className="text-sm font-medium">{s.name}</span>
                    <span className="ml-2 text-xs text-muted-foreground">{s.os} · {s.host}</span>
                  </div>
                  <span className={cn("h-2 w-2 rounded-full", s.status === "online" ? "bg-emerald-500" : "bg-red-500")} />
                </label>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <Button size="sm" disabled={selectedServers.size === 0} onClick={() => setStep(4)}>
              <Rocket className="mr-1 h-3.5 w-3.5" /> 下一步
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setStep(2)}>返回</Button>
          </div>
        </div>
      )}

      {step === 4 && (
        <div className="space-y-4">
          {!batchId ? (
            <div className="space-y-4">
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm">
                <p className="font-medium">确认下发</p>
                <p className="mt-1 text-muted-foreground">
                  工具: <span className="font-medium">{tool}</span> · 目标: <span className="font-medium">{selectedServers.size}</span> 台机器
                </p>
                <p className="mt-1 text-xs text-muted-foreground">每台机器写入前会自动备份当前配置文件。</p>
              </div>
              <div className="flex gap-2">
                <Button onClick={doExecute} disabled={executeMut.isPending}>
                  {executeMut.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Rocket className="mr-1 h-4 w-4" />}
                  确认执行
                </Button>
                <Button variant="ghost" onClick={() => setStep(3)}>返回</Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">执行进度</span>
                  {batchStatus && (
                    <Badge variant={batchStatus.status === "done" ? "secondary" : batchStatus.status === "partial" ? "destructive" : "outline"}>
                      {batchStatus.status}
                    </Badge>
                  )}
                </div>
                {allDone && canRollback && (
                  <Button size="sm" variant="outline" onClick={doRollback} disabled={rollbackMut.isPending}>
                    {rollbackMut.isPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="mr-1 h-3.5 w-3.5" />}
                    全部回滚
                  </Button>
                )}
              </div>
              <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
                {batchStatus?.progress.map((p) => (
                  <div key={p.task_id} className="flex items-center gap-3 bg-card px-4 py-2.5 text-sm">
                    <div className="min-w-0 flex-1">
                      <span className="font-medium">{p.server_name}</span>
                    </div>
                    {p.state === "done" ? (
                      <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400"><CheckCircle2 className="h-3.5 w-3.5" /> 完成</span>
                    ) : p.state === "failed" ? (
                      <span className="flex items-center gap-1 text-xs text-red-600 dark:text-red-400"><XCircle className="h-3.5 w-3.5" /> 失败</span>
                    ) : p.state === "running" ? (
                      <span className="flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400"><Loader2 className="h-3.5 w-3.5 animate-spin" /> 执行中</span>
                    ) : (
                      <span className="text-xs text-muted-foreground">等待中…</span>
                    )}
                  </div>
                ))}
              </div>
              {allDone && (
                <p className="text-xs text-muted-foreground">
                  所有任务已完成。如需恢复写入前配置，点击"全部回滚"。agent 每分钟轮询，回滚将在下次心跳时执行。
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
