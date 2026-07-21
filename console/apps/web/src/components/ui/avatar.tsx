import * as React from "react"
import { cn } from "@/lib/utils"

function Avatar({ children, className }: { children?: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "relative flex h-9 w-9 shrink-0 overflow-hidden rounded-full bg-muted items-center justify-center text-sm font-medium text-muted-foreground",
        className
      )}
    >
      {children}
    </div>
  )
}

export { Avatar }
