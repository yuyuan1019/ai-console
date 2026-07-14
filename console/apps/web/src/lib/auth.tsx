import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
import { api, setAccessToken, type AuthUser } from "@/lib/api"
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
