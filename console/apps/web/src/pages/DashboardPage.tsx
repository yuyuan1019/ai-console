import { ScrollText, Server, Key, Layers, type LucideIcon } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useProviders } from "@/hooks/useProviders"
import { useServers } from "@/hooks/useServers"
import { useQuery } from "@tanstack/react-query"
import { api } from "@/lib/api"

function StatCard({ title, value, icon: Icon, trend }: { title: string; value: string | number; icon: LucideIcon; trend?: string }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        {trend && <p className="mt-1 text-xs text-muted-foreground">{trend}</p>}
      </CardContent>
    </Card>
  )
}

export function DashboardPage() {
  const { data: servers, isLoading: loadingServers } = useServers()
  const online = (servers || []).filter((s) => s.status === "online").length
  const serverCount = servers?.length
  const { data: providers } = useProviders()
  const totalKeys = (providers || []).reduce((n, p) => n + p.key_count, 0)
  const totalModels = (providers || []).reduce((n, p) => n + p.model_count, 0)
  const { data: auditCount } = useQuery({
    queryKey: ["audit-count-dashboard"],
    queryFn: () => api.auditCount({}),
    retry: false,
  })
  const auditTotal = auditCount?.total ?? "-"
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">仪表盘</h1>
        <p className="text-sm text-muted-foreground">集群与供应商概览</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="在线服务器" value={loadingServers ? "…" : `${online}/${serverCount ?? 0}`} icon={Server} trend="agent 心跳" />
        <StatCard title="供应商" value={providers?.length ?? "-"} icon={Layers} trend={`${totalKeys} 把 key · ${totalModels} 模型`} />
        <StatCard title="Provider Keys" value={totalKeys} icon={Key} trend="已导入" />
        <StatCard title="操作审计" value={auditTotal} icon={ScrollText} trend="已记录操作" />
      </div>
    </div>
  )
}
