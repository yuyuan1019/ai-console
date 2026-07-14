import { create } from "zustand"

type Theme = "dark" | "light"

interface ThemeState {
  theme: Theme
  toggle: () => void
  setTheme: (t: Theme) => void
}

const apply = (t: Theme) => {
  if (typeof document !== "undefined") {
    document.documentElement.classList.toggle("dark", t === "dark")
  }
}

export const useTheme = create<ThemeState>((set, get) => ({
  theme: "dark",
  toggle: () => {
    const next = get().theme === "dark" ? "light" : "dark"
    apply(next)
    set({ theme: next })
  },
  setTheme: (t) => {
    apply(t)
    set({ theme: t })
  },
}))

// init dark on load
if (typeof document !== "undefined") {
  document.documentElement.classList.add("dark")
}
