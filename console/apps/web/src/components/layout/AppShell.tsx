import * as React from "react"
import { TopNav } from "./TopNav"
import { Sidebar } from "./Sidebar"
import { BottomNav } from "./BottomNav"

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <TopNav />
      <div className="flex">
        <Sidebar />
        <main className="min-h-[calc(100vh-3.5rem)] flex-1 pb-20 md:pb-6 lg:pl-64">
          <div className="mx-auto max-w-7xl p-4 md:p-6">{children}</div>
        </main>
      </div>
      <BottomNav />
    </div>
  )
}
