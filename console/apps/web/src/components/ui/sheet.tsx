import * as React from "react"
import { cn } from "@/lib/utils"

function Sheet({
  open,
  onOpenChange,
  side = "right",
  children,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  side?: "right" | "bottom"
  children: React.ReactNode
}) {
  React.useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden"
      return () => {
        document.body.style.overflow = ""
      }
    }
  }, [open])

  if (!open) return null
  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/50 animate-in fade-in" onClick={() => onOpenChange(false)} />
      <div
        className={cn(
          "absolute bg-background shadow-xl",
          side === "right" && "right-0 top-0 h-full w-3/4 max-w-xs p-6",
          side === "bottom" && "bottom-0 left-0 right-0 max-h-[80vh] overflow-auto rounded-t-2xl p-6"
        )}
      >
        {children}
      </div>
    </div>
  )
}

export { Sheet }
