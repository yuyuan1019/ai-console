import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom"
import type { ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { AppShell } from "@/components/layout/AppShell"
import { LoginPage } from "@/pages/LoginPage"
import { DashboardPage } from "@/pages/DashboardPage"
import { ServersPage } from "@/pages/ServersPage"
import { ServerDetailPage } from "@/pages/ServerDetailPage"
import { ProvidersPage } from "@/pages/ProvidersPage"
import { ProviderDetailPage } from "@/pages/ProviderDetailPage"
import { ModelsPage } from "@/pages/ModelsPage"
import { AuditPage } from "@/pages/AuditPage"
import { BatchPage } from "@/pages/BatchPage"
import { SettingsPage } from "@/pages/SettingsPage"
import { AuthProvider, useAuth } from "@/lib/auth"

const queryClient = new QueryClient()

function WithShell({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, isLoading } = useAuth()
  if (isLoading) return <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">加载中...</div>
  if (!user) return <Navigate to="/login" replace />
  return <>{children}</>
}

function PublicLogin() {
  const { user, isLoading } = useAuth()
  if (isLoading) return <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">加载中...</div>
  if (user) return <Navigate to="/" replace />
  return <LoginPage />
}

function ProtectedShell({ children }: { children: ReactNode }) {
  return (
    <RequireAuth>
      <WithShell>{children}</WithShell>
    </RequireAuth>
  )
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<PublicLogin />} />
            <Route path="/" element={<ProtectedShell><DashboardPage /></ProtectedShell>} />
            <Route path="/servers" element={<ProtectedShell><ServersPage /></ProtectedShell>} />
            <Route path="/servers/:id" element={<ProtectedShell><ServerDetailPage /></ProtectedShell>} />
            <Route path="/providers" element={<ProtectedShell><ProvidersPage /></ProtectedShell>} />
            <Route path="/providers/:id" element={<ProtectedShell><ProviderDetailPage /></ProtectedShell>} />
            <Route path="/models" element={<ProtectedShell><ModelsPage /></ProtectedShell>} />
            <Route path="/batch" element={<ProtectedShell><BatchPage /></ProtectedShell>} />
            <Route path="/audit" element={<ProtectedShell><AuditPage /></ProtectedShell>} />
            <Route path="/settings" element={<ProtectedShell><SettingsPage /></ProtectedShell>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  )
}
