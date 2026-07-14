import { useState } from "react"
import { Link } from "react-router-dom"
import { ArrowRight, Check, Copy, Download, Plus, Trash2 } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useCreateEnrollToken, useDeleteServer, useServers } from "@/hooks/useServers"
import type { ServerItem } from "@/lib/api"
import { cn } from "@/lib/utils"

const CONSOLE_URL = window.location.origin
type InstallOs = "linux" | "macos"

const statusColor: Record<string, string> = {
  online: "bg-emerald-500",
  offline: "bg-red-500",
  warning: "bg-amber-500",
}

const statusLabel: Record<string, string> = {
  online: "在线",
  offline: "离线",
  warning: "告警",
}

function formatLastSeen(value: number | null) {
  if (!value) return "从未"
  const minutes = Math.max(0, Math.floor((Date.now() - value) / 60000))
  if (minutes < 1) return "刚刚"
  if (minutes < 60) return `${minutes} min 前`
  return `${Math.floor(minutes / 60)} h 前`
}

function downloadScript(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function shellScript(token: string) {
  return `#!/bin/sh
set -eu
TOKEN='${token}' SERVER='${CONSOLE_URL}' sh -c "$(curl -fsSL '${CONSOLE_URL}/agent/install.sh')"
`
}

function shellCommand(token: string) {
  return `TOKEN='${token}' SERVER='${CONSOLE_URL}' sh -c "$(curl -fsSL '${CONSOLE_URL}/agent/install.sh')"`
}

function installSnippet(_os: InstallOs, token: string) {
  return shellCommand(token)
}

function installFilename(os: InstallOs) {
  return os === "macos" ? "ai-console-agent-macos.sh" : "ai-console-agent-linux.sh"
}

function installFileContent(_os: InstallOs, token: string) {
  return shellScript(token)
}

export function ServersPage() {
  const { data: servers = [], isLoading } = useServers()
  const createEnrollToken = useCreateEnrollToken()
  const deleteServer = useDeleteServer()
  const [serverName, setServerName] = useState("")
  const [enrollToken, setEnrollToken] = useState<string | null>(null)
  const [installOs, setInstallOs] = useState<InstallOs>("linux")
  const [copied, setCopied] = useState(false)
  const command = enrollToken ? installSnippet(installOs, enrollToken) : ""
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">服务器</h1>
          <p className="text-sm text-muted-foreground">共 {servers.length} 台</p>
        </div>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            createEnrollToken.mutate(
              { name: serverName || undefined, expires_minutes: 15 },
              { onSuccess: (r) => setEnrollToken(r.token) }
            )
          }}
        >
          <input
            value={serverName}
            onChange={(e) => setServerName(e.target.value)}
            placeholder="服务器名"
            className="h-8 w-36 rounded-md border border-input bg-background px-2 text-sm"
          />
          <Button size="sm" disabled={createEnrollToken.isPending}>
            <Plus className="mr-1 h-4 w-4" /> 生成接入脚本
          </Button>
        </form>
      </div>
      {enrollToken && (
        <Card>
          <CardContent className="space-y-3 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-medium">在目标机器执行以下内容：</p>
                <p className="text-xs text-muted-foreground">token 15 分钟内有效，只显示这一次。</p>
              </div>
              <div className="flex rounded-md border border-input p-1">
                {([
                  ["linux", "Linux"],
                  ["macos", "macOS"],
                ] as const).map(([value, label]) => (
                  <Button
                    key={value}
                    type="button"
                    size="sm"
                    variant={installOs === value ? "secondary" : "ghost"}
                    className="h-7 px-2"
                    onClick={() => {
                      setInstallOs(value)
                      setCopied(false)
                    }}
                  >
                    {label}
                  </Button>
                ))}
              </div>
            </div>
            <div className="overflow-hidden rounded-md border bg-muted/40">
              <div className="flex items-center justify-between border-b px-3 py-2">
                <span className="text-xs text-muted-foreground">
                  终端中粘贴运行
                </span>
                <div className="flex gap-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2"
                    onClick={async () => {
                      await navigator.clipboard.writeText(command)
                      setCopied(true)
                      window.setTimeout(() => setCopied(false), 1500)
                    }}
                  >
                    {copied ? <Check className="mr-1 h-3.5 w-3.5" /> : <Copy className="mr-1 h-3.5 w-3.5" />}
                    {copied ? "已复制" : "复制"}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2"
                    onClick={() => downloadScript(installFilename(installOs), installFileContent(installOs, enrollToken))}
                  >
                    <Download className="mr-1 h-3.5 w-3.5" /> 下载
                  </Button>
                </div>
              </div>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all p-3 text-xs leading-relaxed"><code>{command}</code></pre>
            </div>
          </CardContent>
        </Card>
      )}
      {isLoading && <p className="text-sm text-muted-foreground">加载中…</p>}
      {!isLoading && servers.length === 0 && <p className="text-sm text-muted-foreground">暂无服务器，等待 Agent enroll 接入。</p>}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {servers.map((s: ServerItem) => (
          <Card key={s.id}>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">{s.name}</CardTitle>
                <div className="flex items-center gap-1.5">
                  <span className={cn("h-2.5 w-2.5 rounded-full", statusColor[s.status] || "bg-muted")} />
                  <span className="text-xs text-muted-foreground">{statusLabel[s.status] || s.status}</span>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                {s.os || "unknown"} · {s.host || "—"}
              </p>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-1.5">
                {s.tools.map((t) => (
                  <Badge key={t} variant="secondary" className="capitalize">
                    {t}
                  </Badge>
                ))}
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">心跳 {formatLastSeen(s.last_seen)}</span>
                <div className="flex items-center gap-1">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8 text-destructive"
                    disabled={deleteServer.isPending}
                    onClick={() => {
                      if (confirm(`删除服务器「${s.name}」？这只会删除控制台记录，不会停止目标机器上的 agent。`)) deleteServer.mutate(s.id)
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                  <Link to={`/servers/${s.id}`}>
                    <Button size="icon" variant="ghost" className="h-8 w-8">
                      <ArrowRight className="h-4 w-4" />
                    </Button>
                  </Link>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
