import { create } from "zustand"

type ToastVariant = "error" | "info"
interface ToastItem {
  id: number
  message: string
  variant: ToastVariant
}
interface ToastState {
  items: ToastItem[]
  push: (message: string, variant?: ToastVariant) => void
  dismiss: (id: number) => void
}

// ponytail: 极简 zustand store + 固定位置渲染器。项目故意未装 sonner，故自实现。
// 5s 自动消失 + 手动 ✕。nextId 模块级自增（单 SPA 实例）。
let nextId = 1
export const useToastStore = create<ToastState>((set) => ({
  items: [],
  push: (message, variant = "info") => {
    const id = nextId++
    set((s) => ({ items: [...s.items, { id, message, variant }] }))
    setTimeout(() => set((s) => ({ items: s.items.filter((i) => i.id !== id) })), 5000)
  },
  dismiss: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
}))

export function toastError(message: string) {
  useToastStore.getState().push(message, "error")
}

export function Toaster() {
  const items = useToastStore((s) => s.items)
  const dismiss = useToastStore((s) => s.dismiss)
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {items.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto flex max-w-sm items-start gap-2 rounded-md border px-3 py-2 text-sm shadow-lg ${
            t.variant === "error"
              ? "border-red-500/40 bg-red-950/90 text-red-100"
              : "border-border bg-background text-foreground"
          }`}
        >
          <span className="flex-1 whitespace-pre-wrap break-words">{t.message}</span>
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground"
            onClick={() => dismiss(t.id)}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  )
}
