import { LogOut, Moon, Sun, Terminal, User } from "lucide-react"
import { useTheme } from "@/lib/theme"
import { useAuth } from "@/lib/auth"
import { Button } from "@/components/ui/button"
import { Avatar } from "@/components/ui/avatar"

export function TopNav() {
  const { theme, toggle } = useTheme()
  const { user, logout } = useAuth()

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b bg-background/95 px-4 backdrop-blur lg:px-6">
      <div className="flex items-center gap-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Terminal className="h-5 w-5" />
        </div>
        <span className="text-lg font-bold tracking-tight">AI Console</span>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" onClick={toggle} aria-label="切换主题">
          {theme === "dark" ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
        </Button>
        <div className="hidden items-center gap-2 rounded-md border px-2 py-1 md:flex">
          <Avatar className="h-7 w-7">
            <User className="h-4 w-4" />
          </Avatar>
          <div className="leading-tight">
            <div className="text-sm font-medium">{user?.username}</div>
            <div className="text-xs text-muted-foreground">{user?.role}</div>
          </div>
        </div>
        <Button variant="ghost" size="icon" onClick={() => void logout()} aria-label="退出登录">
          <LogOut className="h-5 w-5" />
        </Button>
      </div>
    </header>
  )
}
