import { NavLink } from "react-router-dom"
import {
  LayoutDashboard,
  Server,
  Globe,
  Boxes,
  Zap,
  ScrollText,
  Settings,
} from "lucide-react"
import { cn } from "@/lib/utils"

const links = [
  { to: "/", icon: LayoutDashboard, label: "仪表盘" },
  { to: "/servers", icon: Server, label: "服务器" },
  { to: "/providers", icon: Globe, label: "供应商" },
  { to: "/models", icon: Boxes, label: "模型库" },
  { to: "/batch", icon: Zap, label: "批量" },
  { to: "/audit", icon: ScrollText, label: "审计" },
  { to: "/settings", icon: Settings, label: "设置" },
]

export function Sidebar() {
  return (
    <aside className="fixed left-0 top-14 z-20 hidden h-[calc(100vh-3.5rem)] w-64 border-r bg-background lg:block">
      <nav className="flex h-full flex-col gap-1 p-4">
        {links.map((l) => (
          <NavLink
            key={l.to}
            to={l.to}
            end={l.to === "/"}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors",
                isActive
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              )
            }
          >
            <l.icon className="h-5 w-5" />
            {l.label}
          </NavLink>
        ))}
      </nav>
    </aside>
  )
}
