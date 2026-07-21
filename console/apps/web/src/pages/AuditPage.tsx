import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { ChevronDown, ChevronLeft, ChevronRight, ChevronRight as ExpandIcon, Download, Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { api } from "@/lib/api"
import type { AuditEntry } from "@/lib/api"

const PAGE_SIZE = 20

function formatTs(value: number) {
  return new Date(value).toLocaleString()
}

function dateStrToTs(value: string) {
  if (!value) return undefined
  const [y, m, d] = value.split("-").map(Number)
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime()
}

function dateStrToEndTs(value: string) {
  if (!value) return undefined
  const [y, m, d] = value.split("-").map(Number)
  return new Date(y, m - 1, d, 23, 59, 59, 999).getTime()
}

function csvEscape(value: unknown): string {
  const s = String(value ?? "")
  let escaped = s
  if (/[",\n\r]/.test(escaped)) escaped = `"${escaped.replace(/"/g, '""')}"`
  if (/^[=+\-@\t\r]/.test(escaped)) escaped = `'${escaped}`
  return escaped
}

function downloadCsv(items: AuditEntry[]) {
  const header = ["id", "ts", "actor", "action", "target", "request_id", "before_json", "after_json"].map(csvEscape).join(",")
  const rows = items.map((e) =>
    [e.id, new Date(e.ts).toISOString(), e.actor_name || e.actor || "", e.action || "", e.target || "", e.request_id || "", e.before_json || "", e.after_json || ""]
      .map(csvEscape)
      .join(",")
  )
  const csv = "\uFEFF" + [header, ...rows].join("\n")
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = `audit-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

export function AuditPage() {
  const [action, setAction] = useState("")
  const [actor, setActor] = useState("")
  const [startDate, setStartDate] = useState("")
  const [endDate, setEndDate] = useState("")
  const [requestId, setRequestId] = useState("")
  const [page, setPage] = useState(0)
  const [expanded, setExpanded] = useState<Set<number>>(new Set())

  const filters = useMemo(() => ({
    action: action || undefined,
    actor: actor || undefined,
    start: dateStrToTs(startDate),
    end: dateStrToEndTs(endDate),
    request_id: requestId || undefined,
  }), [action, actor, startDate, endDate, requestId])

  const { data = [], isLoading } = useQuery({
    queryKey: ["audit", filters, page],
    queryFn: () => api.audit({ ...filters, limit: PAGE_SIZE, offset: page * PAGE_SIZE }),
  })

  const { data: countData } = useQuery({
    queryKey: ["audit-count", filters],
    queryFn: () => api.auditCount(filters),
  })
  const total = countData?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  function resetPage() { setPage(0) }

  function applyRequestIdFilter(rid: string) {
    setRequestId(rid)
    setAction("")
    setActor("")
    setStartDate("")
    setEndDate("")
    setPage(0)
  }

  function clearAll() {
    setAction("")
    setActor("")
    setStartDate("")
    setEndDate("")
    setRequestId("")
    setPage(0)
  }

  function toggle(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function exportCsv() {
    api.audit({ ...filters, limit: 500 }).then(downloadCsv)
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">审计日志</h1>
          <p className="text-sm text-muted-foreground">
            {isLoading ? "加载中…" : total > 0 ? `共 ${total} 条 · 第 ${page + 1}/${totalPages} 页` : "无匹配记录"}
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={exportCsv}>
          <Download className="mr-1 h-4 w-4" /> 导出 CSV
        </Button>
      </div>

      <div className="flex flex-wrap gap-2 items-end">
        <div className="space-y-0.5">
          <label className="text-[10px] text-muted-foreground block">操作类型</label>
          <Input className="w-44 h-8 text-xs" placeholder="action LIKE" value={action} onChange={(e) => { setAction(e.target.value); resetPage() }} />
        </div>
        <div className="space-y-0.5">
          <label className="text-[10px] text-muted-foreground block">操作人</label>
          <Input className="w-32 h-8 text-xs" placeholder="actor" value={actor} onChange={(e) => { setActor(e.target.value); resetPage() }} />
        </div>
        <div className="space-y-0.5">
          <label className="text-[10px] text-muted-foreground block">开始日</label>
          <input type="date" className="h-8 w-36 rounded border border-input bg-background px-2 text-xs" value={startDate} onChange={(e) => { setStartDate(e.target.value); resetPage() }} />
        </div>
        <div className="space-y-0.5">
          <label className="text-[10px] text-muted-foreground block">结束日</label>
          <input type="date" className="h-8 w-36 rounded border border-input bg-background px-2 text-xs" value={endDate} onChange={(e) => { setEndDate(e.target.value); resetPage() }} />
        </div>
        <Button size="sm" variant="ghost" className="h-8" onClick={clearAll}>清除</Button>
      </div>

      {requestId && (
        <div className="flex items-center gap-2 rounded-md bg-muted px-3 py-1.5 text-xs">
          <Search className="h-3 w-3 text-muted-foreground" />
          <span className="text-muted-foreground">request_id:</span>
          <code className="rounded bg-muted-foreground/20 px-1 font-mono">{requestId}</code>
          <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => { setRequestId(""); setPage(0) }}>清除</Button>
        </div>
      )}

      <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
        {data.map((entry: AuditEntry) => {
          const isOpen = expanded.has(entry.id)
          let before: any = null
          let after: any = null
          try { before = entry.before_json ? JSON.parse(entry.before_json) : null } catch { /* ignore corrupt json */ }
          try { after = entry.after_json ? JSON.parse(entry.after_json) : null } catch { /* ignore corrupt json */ }

          return (
            <div key={entry.id} className="bg-card">
              <button className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-accent/50" onClick={() => toggle(entry.id)}>
                {isOpen ? <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" /> : <ExpandIcon className="h-3 w-3 shrink-0 text-muted-foreground" />}
                <span className="w-40 truncate font-mono font-medium">{entry.action}</span>
                <span className="w-24 truncate text-muted-foreground">{entry.actor_name || entry.actor || "—"}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{entry.target}</span>
                {entry.request_id && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-5 px-1 text-[10px] text-muted-foreground hover:text-foreground"
                    onClick={(e) => { e.stopPropagation(); applyRequestIdFilter(entry.request_id!) }}
                  >
                    <code className="text-[10px]">{entry.request_id.slice(0, 8)}…</code>
                  </Button>
                )}
                <span className="shrink-0 text-[10px] text-muted-foreground">{formatTs(entry.ts)}</span>
              </button>
              {isOpen && (
                <div className="border-t border-border px-3 py-2 text-xs">
                  <div className="mb-1 flex flex-wrap gap-x-4 gap-y-0.5 text-muted-foreground">
                    <span>request_id: <code className="rounded bg-muted px-1 font-mono">{entry.request_id || "—"}</code></span>
                    <span>actor: <code className="rounded bg-muted px-1 font-mono">{entry.actor || "—"}</code></span>
                  </div>
                  {(before || after) && (
                    <div className="grid gap-2 md:grid-cols-2 mt-2">
                      {before && (
                        <div>
                          <div className="mb-1 text-[10px] font-medium text-muted-foreground">before</div>
                          <pre className="max-h-40 overflow-auto rounded bg-muted p-2 text-xs"><code>{JSON.stringify(before, null, 2)}</code></pre>
                        </div>
                      )}
                      {after && (
                        <div>
                          <div className="mb-1 text-[10px] font-medium text-muted-foreground">after</div>
                          <pre className="max-h-40 overflow-auto rounded bg-muted p-2 text-xs"><code>{JSON.stringify(after, null, 2)}</code></pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
        {!isLoading && data.length === 0 && (
          <div className="p-8 text-center text-sm text-muted-foreground">无匹配记录</div>
        )}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <Button size="sm" variant="ghost" disabled={page === 0} onClick={() => setPage(page - 1)}>
            <ChevronLeft className="mr-1 h-3.5 w-3.5" /> 上一页
          </Button>
          <span className="text-xs text-muted-foreground">{page + 1} / {totalPages}</span>
          <Button size="sm" variant="ghost" disabled={page >= totalPages - 1} onClick={() => setPage(page + 1)}>
            下一页 <ChevronRight className="ml-1 h-3.5 w-3.5" />
          </Button>
        </div>
      )}
    </div>
  )
}
