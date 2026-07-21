import { Construction } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"

function Placeholder({ title, milestone }: { title: string; milestone: string }) {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
      <Card>
        <CardContent className="flex flex-col items-center justify-center gap-2 py-16 text-center">
          <Construction className="h-10 w-10 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">该模块将在 <span className="font-medium text-foreground">{milestone}</span> 实现</p>
        </CardContent>
      </Card>
    </div>
  )
}

export function BatchPage() {
  return <Placeholder title="批量操作" milestone="M6 (dry-run / 并行 / 回滚)" />
}
export function AuditPage() {
  return <Placeholder title="审计日志" milestone="M6" />
}
export function SettingsPage() {
  return <Placeholder title="设置" milestone="M6 (2FA / 会话 / 用户)" />
}
