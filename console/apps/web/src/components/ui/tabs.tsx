import * as React from "react"
import { cn } from "@/lib/utils"

interface TabsContextValue {
  value: string
  setValue: (v: string) => void
}
const TabsContext = React.createContext<TabsContextValue>({ value: "", setValue: () => {} })

function Tabs({
  value,
  defaultValue,
  onValueChange,
  children,
  className,
}: {
  value?: string
  defaultValue?: string
  onValueChange?: (v: string) => void
  children: React.ReactNode
  className?: string
}) {
  const [internal, setInternal] = React.useState(defaultValue ?? "")
  const active = value ?? internal
  const setValue = (v: string) => {
    onValueChange?.(v)
    if (!value) setInternal(v)
  }
  return (
    <TabsContext.Provider value={{ value: active, setValue }}>
      <div className={className}>{children}</div>
    </TabsContext.Provider>
  )
}

function TabsList({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("inline-flex h-10 items-center gap-1 rounded-lg bg-muted p-1 text-muted-foreground", className)}>
      {children}
    </div>
  )
}

function TabsTrigger({ value, children, className }: { value: string; children: React.ReactNode; className?: string }) {
  const ctx = React.useContext(TabsContext)
  const active = ctx.value === value
  return (
    <button
      type="button"
      onClick={() => ctx.setValue(value)}
      className={cn(
        "inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
        active ? "bg-background text-foreground shadow-sm" : "hover:text-foreground",
        className
      )}
    >
      {children}
    </button>
  )
}

function TabsContent({ value, children, className }: { value: string; children: React.ReactNode; className?: string }) {
  const ctx = React.useContext(TabsContext)
  if (ctx.value !== value) return null
  return (
    <div className={cn("mt-4 ring-offset-background focus-visible:outline-none", className)}>{children}</div>
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent }
