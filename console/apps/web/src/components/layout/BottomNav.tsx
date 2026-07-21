import { useState } from "react"
import { NavLink } from "react-router-dom"
import {
  LayoutDashboard,
  Server,
  Globe,
  MoreHorizontal,
  Boxes,
  Zap,
  ScrollText,
  Settings,
} from "lucide-react"
import { Sheet } from "@/components/ui/sheet"
import { cn } from "@/lib/utils"

const main = [
  { to: "/", icon: LayoutDashboard, label: "仪表盘" },
  { to: "/servers", icon: Server, label: "服务器" },
  { to: "/providers", icon: Globe, label: "供应商" },
  { to: "/batch", icon: Zap, label: "批量" },
]

const more = [
  { to: "/models", icon: Boxes, label: "模型库" },
  { to: "/audit", icon: ScrollText, label: "审计" },
  { to: "/settings", icon: Settings, label: "设置" },
]

export function BottomNav() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <nav className="fixed bottom-0 left-0 right-0 z-40 flex h-16 items-center justify-around border-t bg-background/95 backdrop-blur md:hidden">
        {main.map((l) => (
          <NavLink
            key={l.to}
            to={l.to}
            end={l.to === "/"}
            className={({ isActive }) =>
              cn(
                "flex min-h-[44px] min-w-[44px] flex-col items-center justify-center gap-0.5 text-xs",
                isActive ? "text-primary" : "text-muted-foreground"
              )
            }
          >
            <l.icon className="h-5 w-5" />
            <span>{l.label}</span>
          </NavLink>
        ))}
        <button
          onClick={() => setOpen(true)}
          className="flex min-h-[44px] min-w-[44px] flex-col items-center justify-center gap-0.5 text-xs text-muted-foreground"
        >
          <MoreHorizontal className="h-5 w-5" />
          <span>更多</span>
        </button>
      </nav>
      <Sheet open={open} onOpenChange={setOpen}>
        <div className="mb-4 text-lg font-semibold">更多</div>
        <div className="flex flex-col gap-1">
          {more.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              onClick={() => setOpen(false)}
              className={({ isActive }) =>
                cn(
                  "flex min-h-[44px] items-center gap-3 rounded-md px-3 py-3 text-sm font-medium",
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
        </div>
      </Sheet>
    </>
  )
}
