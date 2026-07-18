import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
import { api, getAccessToken, setAccessToken, type AuthUser } from "@/lib/api"
import { initWS, closeWS } from "@/lib/ws"

interface AuthContextValue {
  user: AuthUser | null
  isLoading: boolean
  login: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    let active = true
    // ponytail (bug 20): /auth/me 在 JWT 仍有效时只返回 {user}（无 accessToken），
    // 若把 initWS 耦合在 me() 返回的 accessToken 上，15 分钟内每次刷新都不起 WS，
    // 只剩 10s 轮询兜底。改为挂载即用 localStorage 里的 token 起 WS，me() 并行跑。
    // 依赖已修的 401 拦截器 + ws.ts 4001-onclose refresh 路径保持 token 新鲜。
    const tok = getAccessToken()
    if (tok) initWS(tok)
    api
      .me()
      .then((res) => {
        if (!active) return
        if ("accessToken" in res) {
          setAccessToken(res.accessToken)
          initWS(res.accessToken)
        }
        setUser(res.user)
      })
      .catch(() => {
        if (!active) return
        closeWS()
        setAccessToken(null)
        setUser(null)
      })
      .finally(() => {
        if (active) setIsLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isLoading,
      login: async (username, password) => {
        const res = await api.login(username, password)
        const authRes = res as { accessToken: string; user: AuthUser }
        setAccessToken(authRes.accessToken)
        initWS(authRes.accessToken)
        setUser(authRes.user)
      },
      logout: async () => {
        try {
          await api.logout()
        } finally {
          closeWS()
          setAccessToken(null)
          setUser(null)
        }
      },
    }),
    [user, isLoading]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider")
  return ctx
}
