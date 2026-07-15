import { useMemo, useState, useEffect } from "react"
import { useParams, Link, useNavigate } from "react-router-dom"
import { ArrowLeft, Loader2, Plus, Minus, Trash2, Key, Search, Copy, Check, PackageOpen, Pencil } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useAgentManifest, useDeleteServer, useListConfigBackups, useReadServerConfig, useRestoreConfigBackup, useServer, useServerTasks, useWriteServerConfig, useDetectTools, useSetCredential, useRemoveCredential, useUpgradeAgent, useUpdateServer } from "@/hooks/useServers"
import { useProviders, useProvider } from "@/hooks/useProviders"

function formatTs(value: number | null) {
  return value ? new Date(value).toLocaleString() : "从未"
}

type DiffLine = { type: "same" | "added" | "removed"; line: string }

function diffLines(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split(/\r?\n/)
  const newLines = newText.split(/\r?\n/)
  const m = oldLines.length
  const n = newLines.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = oldLines[i - 1] === newLines[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1])

  const result: DiffLine[] = []
  let i = m, j = n
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.push({ type: "same", line: oldLines[i - 1] })
      i--; j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.push({ type: "added", line: newLines[j - 1] })
      j--
    } else {
      result.push({ type: "removed", line: oldLines[i - 1] })
      i--
    }
  }
  return result.reverse()
}

function DiffView({ diff }: { diff: DiffLine[] }) {
  if (!diff.length) return <p className="text-xs text-muted-foreground">无变更。</p>
  return (
    <div className="max-h-72 overflow-auto rounded-md border border-border bg-background">
      <pre className="p-2 text-xs leading-5 font-mono">
        {diff.map((d, i) => (
          <div
            key={i}
            className={d.type === "added" ? "bg-emerald-900/30 text-emerald-300" : d.type === "removed" ? "bg-red-900/30 text-red-300" : "text-muted-foreground"}
          >
            <span className="mr-3 inline-block w-5 select-none text-right text-muted-foreground">
              {d.type === "added" ? "+" : d.type === "removed" ? "-" : " "}
            </span>
            {d.line}
          </div>
        ))}
      </pre>
    </div>
  )
}

export function ServerDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { data: server, isLoading } = useServer(id)
  const { data: agentManifest } = useAgentManifest()
  const { data: tasks = [] } = useServerTasks(id)
  const readConfig = useReadServerConfig(id)
  const writeConfig = useWriteServerConfig(id)
  const listBackups = useListConfigBackups(id)
  const restoreBackup = useRestoreConfigBackup(id)
  const deleteServer = useDeleteServer()
  const updateServer = useUpdateServer()
  const detectTools = useDetectTools(id)
  const setCredential = useSetCredential(id)
  const removeCredential = useRemoveCredential(id)
  const upgradeAgent = useUpgradeAgent(id)
  const [tool, setTool] = useState("codex")
  const [content, setContent] = useState("")
  const [credProviderId, setCredProviderId] = useState("")
  const [credKeyId, setCredKeyId] = useState("")
  const { data: providers = [] } = useProviders()
  const { data: credProviderDetail } = useProvider(credProviderId || undefined)
  const [showUninstall, setShowUninstall] = useState(false)
  const [uninstallCopied, setUninstallCopied] = useState(false)
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState("")
  const [nameError, setNameError] = useState<string | null>(null)
  const [loadedTool, setLoadedTool] = useState(tool)
  const [activeTab, setActiveTab] = useState("overview")

  const latestReadContent = useMemo(() =>
    tasks
      .filter((t) => t.action === "read_config" && t.status === "done" && JSON.parse(t.payload_json || "{}").tool === tool && t.result_json)
      .map((t) => JSON.parse(t.result_json || "{}").content as string | undefined)[0] || ""
  , [tasks, tool])

  useEffect(() => {
    setContent(latestReadContent || "")
    setLoadedTool(tool)
  }, [latestReadContent, tool])

  const latestBackups = useMemo(() =>
    tasks
      .filter((t) => t.action === "list_config_backups" && t.status === "done" && JSON.parse(t.payload_json || "{}").tool === tool && t.result_json)
      .map((t) => JSON.parse(t.result_json || "{}").backups as string[] | undefined)[0] || []
  , [tasks, tool])

  const diff = useMemo(() =>
    latestReadContent && content ? diffLines(latestReadContent, content) : []
  , [latestReadContent, content])

  const diffStats = useMemo(() => {
    if (!diff.length) return null
    const added = diff.filter((d) => d.type === "added").length
    const removed = diff.filter((d) => d.type === "removed").length
    return { added, removed, same: diff.length - added - removed, hasChanges: added > 0 || removed > 0 }
  }, [diff])

  const canWrite = loadedTool === tool && content.trim() && (!latestReadContent || latestReadContent !== content)
  const latestAgentVersion = agentManifest?.version || null
  const agentNeedsUpgrade = !server?.agent_version || server.agent_version === "dev" || (latestAgentVersion ? server.agent_version !== latestAgentVersion : false)

  const uninstallCommand = `sh -c "$(curl -fsSL '${location.origin}/agent/uninstall.sh')"`

  async function copyUninstall() {
    await navigator.clipboard.writeText(uninstallCommand)
    setUninstallCopied(true)
    window.setTimeout(() => setUninstallCopied(false), 1500)
  }

  const credProviders = providers.filter((p) => {
    if (tool === "codex") return p.families.includes("codex")
    if (tool === "claude") return p.families.includes("claude")
    if (tool === "gemini") return p.families.includes("gemini")
    if (tool === "opencode") return true
    return false
  })
  const credKeys = (credProviderDetail?.keys || []).filter((k) => k.enabled === 1)
  const credKeyPreview = useMemo((): Record<string, string> => {
    const k = credKeys.find((x) => x.id === credKeyId)
    if (!k) return {}
    const baseUrl = (credProviderDetail?.base_url || "").replace(/\/+$/, "")
    if (tool === "claude") {
      return { ANTHROPIC_AUTH_TOKEN: "sk-***", ANTHROPIC_BASE_URL: baseUrl }
    }
    if (tool === "codex") return {}
    if (tool === "gemini") return { GEMINI_API_KEY: "sk-***", GOOGLE_GEMINI_BASE_URL: baseUrl }
    if (tool === "opencode") return {}
    return {}
  }, [tool, credKeyId, credKeys, credProviderDetail])

  function handleWrite() {
    if (!id || !canWrite) return
    const stats = diffStats
    const msg = stats?.hasChanges
      ? `写入 ${tool} 配置到 ${server?.name}？将新增 ${stats.added} 行，删除 ${stats.removed} 行。agent 会先在目标机器本地备份原文件。`
      : `写入 ${tool} 配置到 ${server?.name}？agent 会先在目标机器本地备份原文件。`
    if (confirm(msg)) {
      writeConfig.mutate({ tool, format: tool === "codex" ? "toml" : "json", content })
    }
  }

  if (isLoading) return <p className="text-muted-foreground">加载中…</p>
  if (!server) {
    return (
      <div className="space-y-4">
        <p className="text-muted-foreground">未找到该服务器</p>
        <Link to="/servers">
          <Button variant="outline" size="sm">
            <ArrowLeft className="mr-1 h-4 w-4" /> 返回列表
          </Button>
        </Link>
      </div>
    )
  }
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link to="/servers">
          <Button size="icon" variant="ghost" className="h-9 w-9">
            <ArrowLeft className="h-5 w-5" />
          </Button>
        </Link>
        <div className="min-w-0 flex-1">
          {editingName ? (
            <div className="flex flex-wrap items-center gap-2">
              <Input
                className="h-9 max-w-xs text-base font-semibold"
                value={nameDraft}
                autoFocus
                disabled={updateServer.isPending}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault()
                    const name = nameDraft.trim()
                    if (!name || !id) return
                    setNameError(null)
                    updateServer.mutate(
                      { id, name },
                      {
                        onSuccess: () => setEditingName(false),
                        onError: (err) => setNameError(String(err)),
                      }
                    )
                  }
                  if (e.key === "Escape") {
                    setEditingName(false)
                    setNameError(null)
                  }
                }}
              />
              <Button
                size="sm"
                disabled={updateServer.isPending || !nameDraft.trim()}
                onClick={() => {
                  const name = nameDraft.trim()
                  if (!name || !id) return
                  setNameError(null)
                  updateServer.mutate(
                    { id, name },
                    {
                      onSuccess: () => setEditingName(false),
                      onError: (err) => setNameError(String(err)),
                    }
                  )
                }}
              >
                {updateServer.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "保存"}
              </Button>
              <Button size="sm" variant="ghost" disabled={updateServer.isPending} onClick={() => { setEditingName(false); setNameError(null) }}>
                取消
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <h1 className="truncate text-2xl font-bold tracking-tight">{server.name}</h1>
              <Button
                size="icon"
                variant="ghost"
                className="h-8 w-8 shrink-0"
                title="修改名称"
                onClick={() => {
                  setNameDraft(server.name)
                  setNameError(null)
                  setEditingName(true)
                }}
              >
                <Pencil className="h-4 w-4" />
              </Button>
            </div>
          )}
          {nameError && <p className="text-xs text-destructive">{nameError}</p>}
          <p className="text-sm text-muted-foreground">
            {server.os || "unknown"} · {server.host || "—"}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto shrink-0 text-destructive"
          disabled={deleteServer.isPending}
          onClick={() => {
            if (!id) return
            if (confirm(`删除服务器「${server.name}」？这只会删除控制台记录，不会停止目标机器上的 agent。`)) {
              deleteServer.mutate(id, { onSuccess: () => navigate("/servers") })
            }
          }}
        >
          <Trash2 className="mr-1 h-4 w-4" /> 删除
        </Button>
      </div>
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="w-full justify-start overflow-x-auto">
          <TabsTrigger value="overview">概览</TabsTrigger>
          <TabsTrigger value="configs">配置</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">概览</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex gap-2">状态：<span className="font-medium">{server.status}</span></div>
              <div className="flex gap-2">最后心跳：<span className="font-medium">{formatTs(server.last_seen)}</span></div>
              <div className="flex gap-2">架构：<span className="font-medium">{server.arch || "—"}</span></div>
              <div className="flex items-center gap-2">
                Agent版本：
                <span className="font-medium">{server.agent_version || "未知"}</span>
                {!agentNeedsUpgrade && (
                  <Badge variant="outline" className="text-xs">当前</Badge>
                )}
                {agentNeedsUpgrade && (
                  <Badge variant="destructive" className="text-xs">{server.agent_version ? "可升级" : "需升级"}</Badge>
                )}
                {latestAgentVersion && <span className="text-xs text-muted-foreground">最新 {latestAgentVersion}</span>}
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  disabled={upgradeAgent.isPending}
                  onClick={() => {
                    if (confirm(`升级 ${server.name} 上的 agent？会从本控制台下载最新二进制并自动重启服务。`)) {
                      upgradeAgent.mutate(undefined, { onSuccess: () => setActiveTab("configs") })
                    }
                  }}
                >
                  {upgradeAgent.isPending ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <PackageOpen className="mr-1 h-3 w-3" />}
                  升级 Agent
                </Button>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-1.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  已装工具：
                  {server.tools.filter((t) => t.installed).map((t) => (
                    <Badge key={t.name} variant="secondary" className="capitalize">{t.name}</Badge>
                  ))}
                  {!server.tools.some((t) => t.installed) && <span className="text-muted-foreground">—</span>}
                </div>
                <Button size="sm" variant="outline" disabled={detectTools.isPending} onClick={() => detectTools.mutate(null)}>
                  {detectTools.isPending ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Search className="mr-1 h-3 w-3" />}
                  重新探测
                </Button>
              </div>
              <div className="space-y-1 pt-2">
                {server.tools.map((t) => (
                  <div key={t.name} className="flex items-center justify-between rounded-md border border-border p-2 text-xs">
                    <div>
                      <div className="font-medium capitalize">{t.name} {t.installed ? "" : "（未安装）"}</div>
                      <div className="text-muted-foreground">version: {t.version || "—"} · path: {t.path || "—"}</div>
                    </div>
                  </div>
                ))}
              </div>
              <div className="rounded-md border border-border p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="font-medium">凭据下发</div>
                <div className="flex items-center gap-2">
                  {tool !== "codex" && tool !== "opencode" && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={setCredential.isPending || !credProviderId || !credKeyId}
                    onClick={() => setCredential.mutate({ tool, provider_id: credProviderId, key_id: credKeyId })}
                  >
                    {setCredential.isPending ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Key className="mr-1 h-3 w-3" />}
                    下发凭据
                  </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive"
                    disabled={removeCredential.isPending}
                    onClick={() => {
                      if (confirm(`从 ${server.name} 卸载 ${tool} 的 key？会删除 agent 上的凭据文件和已写入工具配置中的 key。`)) {
                        removeCredential.mutate({ tool, provider_id: credProviderId || undefined, key_id: credKeyId || undefined })
                      }
                    }}
                  >
                    {removeCredential.isPending ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Trash2 className="mr-1 h-3 w-3" />}
                    卸载 Key
                  </Button>
                </div>
              </div>
                <div className="flex items-center gap-2">
                  <label className="text-xs text-muted-foreground w-16">工具</label>
                  <select
                    value={tool}
                    onChange={(e) => { setTool(e.target.value); setCredProviderId(""); setCredKeyId("") }}
                    className="h-8 w-32 rounded border border-input bg-background px-2 text-xs"
                  >
                    <option value="codex">codex</option>
                    <option value="claude">claude</option>
                    <option value="gemini">gemini</option>
                    <option value="opencode">opencode</option>
                  </select>
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-xs text-muted-foreground w-16">供应商</label>
                  <select
                    value={credProviderId}
                    onChange={(e) => { setCredProviderId(e.target.value); setCredKeyId("") }}
                    className="h-8 flex-1 rounded border border-input bg-background px-2 text-xs"
                  >
                    <option value="">选择供应商…</option>
                    {credProviders.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-xs text-muted-foreground w-16">Key</label>
                  <select
                    value={credKeyId}
                    onChange={(e) => setCredKeyId(e.target.value)}
                    className="h-8 flex-1 rounded border border-input bg-background px-2 text-xs"
                    disabled={!credProviderDetail}
                  >
                    <option value="">选择 Key…</option>
                    {credKeys.map((k) => <option key={k.id} value={k.id}>{k.label} ({k.family})</option>)}
                  </select>
                </div>
                {Object.keys(credKeyPreview).length > 0 && (
                  <div className="rounded bg-muted/50 p-2 text-xs">
                    <div className="mb-1 text-[10px] font-medium text-muted-foreground">即将写入</div>
                    {Object.entries(credKeyPreview).map(([k, v]) => (
                      <div key={k} className="font-mono">{k} = <span className="text-muted-foreground">{v}</span></div>
                    ))}
                  </div>
                )}
              </div>
              <div className="rounded-md border border-border p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 font-medium">
                    <PackageOpen className="h-3.5 w-3.5 text-muted-foreground" /> 卸载 Agent
                  </div>
                  <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setShowUninstall((v) => !v)}>
                    {showUninstall ? "收起" : "展开"}
                  </Button>
                </div>
                {showUninstall && (
                  <>
                    <p className="text-xs text-muted-foreground">
                      在目标机器上执行以下命令，会同时清除 Go agent 和旧 shell agent 的所有残留（systemd/launchd/crontab/agent 目录）。
                      <strong className="text-foreground">不会删除</strong>你的 CLI 工具本身和它们的配置文件。
                    </p>
                    <div className="overflow-hidden rounded-md border bg-muted/40">
                      <div className="flex items-center justify-between border-b px-3 py-2">
                        <span className="text-xs text-muted-foreground">
                          终端中粘贴运行
                        </span>
                        <Button type="button" size="sm" variant="ghost" className="h-7 px-2" onClick={copyUninstall}>
                          {uninstallCopied ? <Check className="mr-1 h-3.5 w-3.5" /> : <Copy className="mr-1 h-3.5 w-3.5" />}
                          {uninstallCopied ? "已复制" : "复制"}
                        </Button>
                      </div>
                      <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all p-3 text-xs leading-relaxed"><code>{uninstallCommand}</code></pre>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      卸载后，上面的「删除」按钮可清除控制台中的服务器记录。两个操作互相独立。
                    </p>
                  </>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="configs">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">配置工具</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <select value={tool} onChange={(e) => { setTool(e.target.value); setContent(""); setLoadedTool(e.target.value) }} className="h-10 rounded-md border border-input bg-background px-3 text-sm">
                  <option value="codex">codex</option>
                  <option value="claude">claude</option>
                  <option value="gemini">gemini</option>
                  <option value="opencode">opencode</option>
                </select>
                <Button disabled={readConfig.isPending} onClick={() => readConfig.mutate(tool)}>
                  {readConfig.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  读取配置
                </Button>
                <Button
                  variant="outline"
                  disabled={writeConfig.isPending || !canWrite}
                  onClick={handleWrite}
                >
                  {writeConfig.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  写入配置
                </Button>
                <Button variant="outline" disabled={listBackups.isPending} onClick={() => listBackups.mutate(tool)}>
                  {listBackups.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  列出备份
                </Button>
                <span className="text-xs text-muted-foreground">agent 每分钟轮询任务，结果会自动刷新。</span>
              </div>

              {latestBackups.length > 0 && (
                <div className="space-y-2 rounded-md border border-border p-3">
                  <div className="text-sm font-medium">可回滚备份</div>
                  <div className="flex flex-wrap gap-2">
                    {latestBackups.map((backup) => (
                      <Button
                        key={backup}
                        size="sm"
                        variant="outline"
                        disabled={restoreBackup.isPending}
                        onClick={() => {
                          if (confirm(`恢复备份 ${backup}？当前配置会先再次备份。`)) restoreBackup.mutate({ tool, backup })
                        }}
                      >
                        恢复 {backup}
                      </Button>
                    ))}
                  </div>
                </div>
              )}

              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="点击「读取配置」自动载入，或直接粘贴配置内容。"
                className="min-h-[400px] w-full resize-y rounded-md border border-input bg-background p-3 font-mono text-xs"
              />

              {diffStats && (
                <div className="space-y-2 rounded-md border border-border p-3">
                  <div className="flex flex-wrap items-center gap-3 text-sm">
                    <span className="font-medium">变更预览</span>
                    {diffStats.hasChanges ? (
                      <>
                        <span className="flex items-center gap-1 text-emerald-500"><Plus className="h-3.5 w-3.5" /> {diffStats.added}</span>
                        <span className="flex items-center gap-1 text-red-500"><Minus className="h-3.5 w-3.5" /> {diffStats.removed}</span>
                        <span className="text-muted-foreground">{diffStats.same} 行未变</span>
                      </>
                    ) : (
                      <span className="text-muted-foreground">无变更，当前内容与最近读取的配置完全一致。</span>
                    )}
                  </div>
                  {diffStats.hasChanges && <DiffView diff={diff} />}
                </div>
              )}

              <div className="space-y-2">
                {tasks.length === 0 && <p className="text-sm text-muted-foreground">暂无任务</p>}
                {tasks.map((task) => {
                  const payload = JSON.parse(task.payload_json || "{}")
                  const result = task.result_json ? JSON.parse(task.result_json) : null
                  return (
                    <div key={task.id} className="rounded-md border border-border p-3 text-sm">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="font-medium">{task.action} · {payload.tool || "—"}</div>
                        <Badge variant={task.status === "done" ? "secondary" : task.status === "failed" ? "destructive" : "outline"}>{task.status}</Badge>
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">创建：{formatTs(task.created_at)} · 完成：{formatTs(task.finished_at)}</div>
                      {task.error && <p className="mt-2 text-sm text-destructive">{task.error}</p>}
                      {result?.content && (
                        <div>
                          <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs"><code>{result.content}</code></pre>
                        </div>
                      )}
                      {result?.backups && (
                        <div className="mt-2 space-y-1">
                          <div className="text-xs font-medium">备份列表</div>
                          {result.backups.map((b: string) => (
                            <div key={b} className="rounded-md bg-muted px-2 py-0.5 font-mono text-xs">{b}</div>
                          ))}
                        </div>
                      )}
                      {result?.tools && (
                        <div className="mt-2 space-y-1">
                          <div className="text-xs font-medium">探测结果</div>
                          {result.tools.map((t: any) => (
                            <div key={t.name} className="rounded-md bg-muted px-2 py-0.5 text-xs">
                              <span className="font-medium capitalize">{t.name}</span>: {t.installed ? (t.version || "已安装") : "未安装"} {t.path ? `(${t.path})` : ""}
                            </div>
                          ))}
                        </div>
                      )}
                      {result?.path && result?.keys && (
                        <div className="mt-2 text-xs text-muted-foreground">
                          凭据已写入 <code className="rounded bg-muted px-1 text-xs">{result.path}</code>{' '}
                          {result.format ? (
                            <Badge variant="secondary" className="text-xs ml-0.5">{result.format}</Badge>
                          ) : null}
                          （{result.keys.join(", ")}）
                        </div>
                      )}
                      {task.action === "remove_credential" && result && (
                        <div className="mt-2 text-xs text-muted-foreground">
                          <div>已删除凭据文件：</div>
                          {(result.removed || []).length === 0 && (result.extra || []).length === 0 && (
                            <span className="text-muted-foreground">没有需要清理的文件</span>
                          )}
                          <ul className="mt-1 space-y-0.5">
                            {(result.removed || []).map((p: string) => (
                              <li key={p}><code className="rounded bg-muted px-1 text-xs">{p}</code></li>
                            ))}
                            {(result.extra || []).map((p: string) => (
                              <li key={p}><code className="rounded bg-muted px-1 text-xs">{p}</code> <span className="text-[10px]">(配置)</span></li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {task.action === "upgrade_agent" && result && (
                        <div className="mt-2 text-xs text-muted-foreground">
                          Agent 升级：{result.old_version || "—"} → {result.new_version || "—"}
                          <div className="mt-0.5">路径：<code className="rounded bg-muted px-1 text-xs">{result.path}</code></div>
                          {result.backup && <div>备份：<code className="rounded bg-muted px-1 text-xs">{result.backup}</code></div>}
                          {result.restart && <div>重启：{result.restart}</div>}
                        </div>
                      )}
                      {result?.exit_code != null && (
                        <div className="mt-2 space-y-1">
                          <div className="text-xs">
                            <Badge variant={result.exit_code === 0 ? "secondary" : "destructive"} className="text-xs">
                              exit={result.exit_code} {result.duration_ms ? `(${result.duration_ms}ms)` : ""}
                            </Badge>
                          </div>
                          {result.stdout && (
                            <details>
                              <summary className="cursor-pointer text-xs text-muted-foreground">stdout</summary>
                              <pre className="mt-1 max-h-32 overflow-auto rounded bg-muted p-2 text-xs"><code>{result.stdout}</code></pre>
                            </details>
                          )}
                          {result.stderr && (
                            <details>
                              <summary className="cursor-pointer text-xs text-destructive">stderr</summary>
                              <pre className="mt-1 max-h-32 overflow-auto rounded bg-muted p-2 text-xs"><code>{result.stderr}</code></pre>
                            </details>
                          )}
                        </div>
                      )}
                      {result?.old_version && (
                        <div className="mt-2 text-xs text-muted-foreground">
                          升级：<code className="rounded bg-muted px-1 text-xs">{result.old_version}</code> → <code className="rounded bg-muted px-1 text-xs">{result.new_version || "—"}</code>
                        </div>
                      )}
                      {result?.new_version && !result?.old_version && (
                        <div className="mt-2 text-xs text-muted-foreground">
                          升级完成：<code className="rounded bg-muted px-1 text-xs">{result.new_version}</code>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
