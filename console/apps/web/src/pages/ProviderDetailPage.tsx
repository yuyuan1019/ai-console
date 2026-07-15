import { useEffect, useState, type FormEvent } from "react"
import { useParams, Link } from "react-router-dom"
import { ArrowLeft, Boxes, Key, Zap, CheckCircle2, XCircle, Loader2, Plus, Trash2, RefreshCw, Pencil, Save, X } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useCreateProviderKey, useDisableProviderKey, useProvider, usePing, useRefreshModels, useUpdateProvider, useUpdateProviderKey } from "@/hooks/useProviders"
import type { PingResult } from "@/lib/api"
import { cn } from "@/lib/utils"

function PingButton({ providerId, keyId, modelId, disabled }: { providerId: string; keyId: string; modelId?: string; disabled?: boolean }) {
  const [result, setResult] = useState<PingResult | null>(null)
  const ping = usePing()
  const run = () => { setResult(null); ping.mutate({ providerId, keyId, modelId }, { onSuccess: setResult, onError: (e) => setResult({ ok: false, error: String(e) }) }) }
  return (
    <div className="flex items-center gap-2">
      <Button size="sm" variant="outline" onClick={run} disabled={disabled || ping.isPending} className="h-8 text-xs">{ping.isPending ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Zap className="mr-1 h-3 w-3" />}测试</Button>
      {result && (<span className={cn("flex items-center gap-1 text-[10px] font-medium", result.ok ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400")}>{result.ok ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}{result.ok ? `${result.latency_ms}ms` : `失败 · ${result.error?.slice(0, 30)}`}</span>)}
    </div>
  )
}

export function ProviderDetailPage() {
  const { id } = useParams()
  const { data, isLoading } = useProvider(id)
  const createKey = useCreateProviderKey(id)
  const disableKey = useDisableProviderKey(id)
  const refreshModels = useRefreshModels(id)
  const updateProvider = useUpdateProvider(id)
  const updateKey = useUpdateProviderKey(id)
  const [providerName, setProviderName] = useState("")
  const [providerBaseUrl, setProviderBaseUrl] = useState("")
  const [providerModelsEndpoint, setProviderModelsEndpoint] = useState("/v1/models")
  const [providerPreset, setProviderPreset] = useState("custom")
  const [providerEnabled, setProviderEnabled] = useState(true)
  const [providerError, setProviderError] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [label, setLabel] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [family, setFamily] = useState("mixed")
  const [apiFormat, setApiFormat] = useState("")
  const [formError, setFormError] = useState<string | null>(null)
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null)
  const [editingKeyId, setEditingKeyId] = useState<string | null>(null)
  const [keyLabel, setKeyLabel] = useState("")
  const [keyGroupName, setKeyGroupName] = useState("")
  const [keyFamily, setKeyFamily] = useState("mixed")
  const [keyApiFormat, setKeyApiFormat] = useState("")
  const [keyApiKey, setKeyApiKey] = useState("")
  const [keyDefaultModel, setKeyDefaultModel] = useState("")
  const [selectedModels, setSelectedModels] = useState<Record<string, string>>({})
  const provider = data

  useEffect(() => {
    if (!provider) return
    setProviderName(provider.name)
    setProviderBaseUrl(provider.base_url || "")
    setProviderModelsEndpoint(provider.models_endpoint || "/v1/models")
    setProviderPreset(provider.preset || "custom")
    setProviderEnabled(Boolean(provider.enabled))
  }, [provider])

  const addKey = (e: FormEvent) => {
    e.preventDefault(); setFormError(null)
    createKey.mutate({ label, api_key: apiKey, family, api_format: apiFormat || null }, { onSuccess: () => { setLabel(""); setApiKey(""); setFamily("mixed"); setApiFormat("") }, onError: (err) => setFormError(String(err)) })
  }
  const saveProvider = (e: FormEvent) => {
    e.preventDefault(); setProviderError(null)
    updateProvider.mutate({ name: providerName, base_url: providerBaseUrl || null, models_endpoint: providerModelsEndpoint, preset: providerPreset, enabled: providerEnabled }, { onSuccess: () => setShowSettings(false), onError: (err) => setProviderError(String(err)) })
  }
  const startEditKey = (k: NonNullable<typeof provider>["keys"][number]) => { setEditingKeyId(k.id); setKeyLabel(k.label); setKeyGroupName(k.group_name || ""); setKeyFamily(k.family); setKeyApiFormat(k.api_format || ""); setKeyApiKey(""); setKeyDefaultModel(k.default_model_id || "") }
  const saveKey = (keyId: string) => { updateKey.mutate({ keyId, input: { label: keyLabel, group_name: keyGroupName || null, family: keyFamily, api_format: keyApiFormat || null, api_key: keyApiKey || undefined, default_model_id: keyDefaultModel || null } }, { onSuccess: () => setEditingKeyId(null) }) }
  const modelsForKey = (keyId: string) => provider?.models.filter((m) => !m.key_id || m.key_id === keyId) || []

  if (isLoading) return <p className="text-muted-foreground">加载中…</p>
  if (!provider) return (<div className="space-y-4"><p className="text-muted-foreground">未找到供应商</p><Link to="/providers"><Button variant="outline" size="sm"><ArrowLeft className="mr-1 h-4 w-4" />返回供应商列表</Button></Link></div>)

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link to="/providers"><Button size="icon" variant="ghost" className="h-9 w-9"><ArrowLeft className="h-5 w-5" /></Button></Link>
        <div className="min-w-0 flex-1"><h1 className="truncate text-xl font-bold tracking-tight">{provider.name}</h1><p className="truncate text-xs text-muted-foreground">{provider.base_url || "未设置 Base URL"}</p></div>
        <Button size="sm" variant="outline" onClick={() => setShowSettings(!showSettings)}>{showSettings ? "收起" : "设置"}</Button>
      </div>
      {showSettings && (
        <Card className="border-primary/20 bg-muted/40">
          <CardContent className="p-4">
            <form className="flex flex-wrap gap-3" onSubmit={saveProvider}>
              <Input className="h-9 w-40 text-xs" value={providerName} onChange={(e) => setProviderName(e.target.value)} placeholder="名称" required />
              <Input className="h-9 min-w-48 flex-1 text-xs" value={providerBaseUrl} onChange={(e) => setProviderBaseUrl(e.target.value)} placeholder="Base URL" />
              <Input className="h-9 w-32 text-xs" value={providerModelsEndpoint} onChange={(e) => setProviderModelsEndpoint(e.target.value)} />
              <Input className="h-9 w-24 text-xs" value={providerPreset} onChange={(e) => setProviderPreset(e.target.value)} />
              <label className="flex h-9 cursor-pointer items-center gap-1 text-xs text-muted-foreground"><input type="checkbox" checked={providerEnabled} onChange={(e) => setProviderEnabled(e.target.checked)} /> 启用</label>
              <Button className="h-9 text-xs" type="submit" disabled={updateProvider.isPending}>{updateProvider.isPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-1 h-3.5 w-3.5" />}保存</Button>
            </form>
            {providerError && <p className="mt-2 text-xs text-destructive">{providerError}</p>}
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue="keys" className="w-full">
        <TabsList className="h-9 bg-muted/60 p-0.5">
          <TabsTrigger className="h-8 text-xs" value="keys"><Key className="mr-1 h-3.5 w-3.5" />凭据 Keys ({provider.keys.length})</TabsTrigger>
          <TabsTrigger className="h-8 text-xs" value="models"><Boxes className="mr-1 h-3.5 w-3.5" />模型库 ({provider.models.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="keys" className="space-y-3 pt-2">
          <Card className="bg-card"><CardContent className="p-4">
            <span className="mb-2 block text-xs font-semibold text-muted-foreground">添加新 Key / 凭据组</span>
            <form className="flex flex-wrap gap-3" onSubmit={addKey}>
              <Input className="h-9 w-40 text-xs" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Key 别名" required />
              <Input className="h-9 w-56 text-xs" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="API Key" autoComplete="off" />
              <select value={family} onChange={(e) => setFamily(e.target.value)} className="h-9 rounded-md border border-input bg-background px-2 text-xs"><option value="mixed">mixed</option><option value="claude">claude</option><option value="codex">codex</option><option value="gemini">gemini</option><option value="other">other</option></select>
              <select value={apiFormat} onChange={(e) => setApiFormat(e.target.value)} className="h-9 rounded-md border border-input bg-background px-2 text-xs"><option value="">默认协议</option><option value="openai_responses">openai</option><option value="anthropic">anthropic</option><option value="gemini">gemini</option></select>
              <Button className="h-9 text-xs" type="submit" disabled={createKey.isPending}>{createKey.isPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Plus className="mr-1 h-3.5 w-3.5" />}添加</Button>
            </form>
            {formError && <p className="mt-2 text-xs text-destructive">{formError}</p>}
          </CardContent></Card>
          {refreshMessage && <div className="rounded-md bg-emerald-950/20 px-3 py-2 text-xs text-emerald-600 dark:text-emerald-400">{refreshMessage}</div>}
          {provider.keys.length === 0 ? <p className="py-8 text-center text-xs text-muted-foreground">暂无可用凭据组</p> : (
            <div className="space-y-2">
              {provider.keys.map((k) => (
                <div key={k.id} className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3 md:flex-row md:items-center md:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {editingKeyId === k.id ? (
                        <div className="grid flex-1 gap-2 md:grid-cols-[1fr_1.5fr_1fr_100px_120px_140px]">
                          <Input className="h-8 text-xs" value={keyLabel} onChange={(e) => setKeyLabel(e.target.value)} placeholder="别名" />
                          <Input className="h-8 text-xs" value={keyApiKey} onChange={(e) => setKeyApiKey(e.target.value)} placeholder="•••••••• (留空不修改)" autoComplete="off" />
                          <Input className="h-8 text-xs" value={keyGroupName} onChange={(e) => setKeyGroupName(e.target.value)} placeholder="分组名" />
                          <select value={keyFamily} onChange={(e) => setKeyFamily(e.target.value)} className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"><option value="mixed">mixed</option><option value="claude">claude</option><option value="codex">codex</option><option value="gemini">gemini</option><option value="other">other</option></select>
                          <select value={keyApiFormat} onChange={(e) => setKeyApiFormat(e.target.value)} className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"><option value="">默认</option><option value="openai_responses">openai</option><option value="anthropic">anthropic</option><option value="gemini">gemini</option></select>
                          <select value={keyDefaultModel} onChange={(e) => setKeyDefaultModel(e.target.value)} className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"><option value="">默认模型</option>{modelsForKey(k.id).map((m) => (<option key={m.id} value={m.model_id}>{m.model_id}</option>))}</select>
                        </div>
                      ) : (<><span className="font-medium text-sm">{k.label}</span>{k.group_name && <span className="text-[11px] text-muted-foreground">({k.group_name})</span>}<Badge variant="secondary" className="text-[10px] capitalize">{k.family}</Badge>{k.api_format && <Badge variant="outline" className="text-[10px]">{k.api_format}</Badge>}{k.auth_type === "oauth" && <Badge variant="outline" className="text-[10px]">OAuth</Badge>}{k.default_model_id && <Badge variant="outline" className="text-[10px] bg-amber-900/20 text-amber-400 border-amber-700/30">默认 {k.default_model_id}</Badge>}</>)}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    {editingKeyId === k.id ? (<><Button size="sm" className="h-8 text-xs" disabled={updateKey.isPending} onClick={() => saveKey(k.id)}>{updateKey.isPending ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Save className="mr-1 h-3 w-3" />}保存</Button><Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => setEditingKeyId(null)}><X className="mr-1 h-3 w-3" />取消</Button></>) : (<>
                      <select value={selectedModels[k.id] || modelsForKey(k.id)[0]?.model_id || ""} onChange={(e) => setSelectedModels((prev) => ({ ...prev, [k.id]: e.target.value }))} className="h-8 max-w-48 rounded-md border border-input bg-background px-2 text-xs">{modelsForKey(k.id).length === 0 ? <option value="">暂无模型</option> : modelsForKey(k.id).map((m) => (<option key={m.id} value={m.model_id}>{m.model_id}</option>))}</select>
                      <PingButton providerId={provider.id} keyId={k.id} modelId={selectedModels[k.id] || modelsForKey(k.id)[0]?.model_id} disabled={modelsForKey(k.id).length === 0} />
                      <Button size="sm" variant="outline" className="h-8 text-xs" disabled={refreshModels.isPending} onClick={() => { setRefreshMessage(null); refreshModels.mutate(k.id, { onSuccess: (r) => setRefreshMessage(`模型刷新完成：已保存 ${r.total} 个模型`), onError: (e) => setRefreshMessage(`模型刷新失败：${String(e)}`) }) }}>{refreshModels.isPending ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <RefreshCw className="mr-1 h-3 w-3" />}拉取模型</Button>
                      <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => startEditKey(k)}><Pencil className="mr-1 h-3 w-3" />编辑</Button>
                      <Button size="sm" variant="ghost" className="h-8 text-xs text-destructive hover:bg-destructive/10" disabled={disableKey.isPending} onClick={() => { if (confirm(`禁用凭据「${k.label}」？`)) disableKey.mutate(k.id) }}><Trash2 className="mr-1 h-3 w-3" />禁用</Button>
                    </>)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="models" className="space-y-2 pt-2">
          {provider.models.length === 0 ? <p className="py-8 text-center text-xs text-muted-foreground">暂无模型。请返回 Keys 列表，点击"拉取模型"。</p> : (
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{provider.models.map((m) => (<div key={m.id} className="flex items-center justify-between rounded-lg border border-border bg-card p-3"><div className="min-w-0"><div className="truncate font-mono text-xs">{m.model_id}</div>{m.display_name && <div className="truncate text-[10px] text-muted-foreground">{m.display_name}</div>}</div>{m.family && <Badge variant="secondary" className="text-[10px] capitalize shrink-0">{m.family}</Badge>}</div>))}</div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
