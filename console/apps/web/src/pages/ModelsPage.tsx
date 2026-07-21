import { useMemo, useState } from "react"
import { Search } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { useModels } from "@/hooks/useProviders"

const TABS: { key: string; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "claude", label: "Claude" },
  { key: "codex", label: "Codex" },
  { key: "gemini", label: "Gemini" },
  { key: "other", label: "其他" },
]

const FAMILY_COLOR: Record<string, string> = {
  claude: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  codex: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
  gemini: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  other: "bg-slate-100 text-slate-800 dark:bg-slate-900/30 dark:text-slate-300",
}

export function ModelsPage() {
  const { data, isLoading } = useModels()
  const [q, setQ] = useState("")
  const [tab, setTab] = useState("all")

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: data?.length ?? 0 }
    for (const t of TABS) {
      if (t.key === "all") continue
      c[t.key] = data?.filter((m) => (m.family || "other") === t.key).length ?? 0
    }
    return c
  }, [data])

  const filtered = useMemo(() => {
    if (!data) return []
    return data.filter((m) => {
      const fam = m.family || "other"
      const matchTab = tab === "all" || fam === tab
      const matchQ = !q || m.model_id.toLowerCase().includes(q.toLowerCase()) || m.providers.some((p) => p.provider_name.toLowerCase().includes(q.toLowerCase()))
      return matchTab && matchQ
    })
  }, [data, q, tab])

  const grouped = useMemo(() => {
    const g: Record<string, typeof filtered> = {}
    for (const m of filtered) {
      const fam = m.family || "other"
      if (!g[fam]) g[fam] = []
      g[fam].push(m)
    }
    return g
  }, [filtered])

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">模型库</h1>
        <p className="text-sm text-muted-foreground">
          {isLoading ? "加载中…" : `${data?.length ?? 0} 个去重模型，来自多个供应商`}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder="搜索模型名 / 供应商…" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
        </div>
      </div>

      <div className="flex flex-wrap gap-1 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`relative px-3 py-2 text-sm font-medium transition-colors ${tab === t.key ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            {t.label}
            <span className="ml-1 text-xs text-muted-foreground">{counts[t.key] ?? 0}</span>
            {tab === t.key && <span className="absolute inset-x-0 -bottom-px h-0.5 bg-primary" />}
          </button>
        ))}
      </div>

      {filtered.length === 0 && !isLoading && (
        <p className="py-8 text-center text-sm text-muted-foreground">无匹配模型</p>
      )}

      {Object.entries(grouped).map(([family, models]) => (
        <div key={family} className="space-y-2">
          {tab === "all" && (
            <div className="flex items-center gap-2 pt-2">
              <Badge className={FAMILY_COLOR[family] || FAMILY_COLOR.other}>{family}</Badge>
              <span className="text-xs text-muted-foreground">{models.length} 个模型</span>
            </div>
          )}
          <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
            {models.map((m) => (
              <div key={m.model_id} className="flex items-center gap-3 bg-card px-4 py-2.5 transition-colors hover:bg-accent/50">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-sm font-medium">{m.model_id}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                    {m.providers.map((p) => (
                      <span key={p.provider_id} className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{p.provider_name}</span>
                    ))}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {m.providers.length > 1 && (
                    <Badge variant="outline" className="text-[10px]">{m.providers.length} 供应商</Badge>
                  )}
                  {m.context_window ? (
                    <span className="text-[10px] text-muted-foreground">{(m.context_window / 1000).toFixed(0)}K ctx</span>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
