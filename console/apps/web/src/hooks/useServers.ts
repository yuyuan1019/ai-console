import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useRef } from "react"
import { api } from "@/lib/api"
import { subscribe } from "@/lib/ws"

export function useServers() {
  const queryClient = useQueryClient()
  useEffect(() => {
    return subscribe("servers:status", () => {
      void queryClient.invalidateQueries({ queryKey: ["servers"] })
    })
  }, [queryClient])
  return useQuery({
    queryKey: ["servers"],
    queryFn: api.servers,
    staleTime: 0,
    refetchInterval: 10000,
    refetchIntervalInBackground: true,
    refetchOnMount: true,
  })
}

export function useServer(id: string | undefined) {
  return useQuery({
    queryKey: ["server", id],
    queryFn: () => api.server(id!),
    enabled: !!id,
  })
}

export function useServerTasks(id: string | undefined) {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: ["server", id, "tasks"],
    queryFn: () => api.serverTasks(id!),
    enabled: !!id,
    refetchInterval: 10000, // WS 离线时降级为 10s 轮询
  })
  useEffect(() => {
    if (!id) return
    return subscribe(`server:${id}:tasks`, () => {
      void queryClient.invalidateQueries({ queryKey: ["server", id, "tasks"] })
      void queryClient.invalidateQueries({ queryKey: ["server", id] })
    })
  }, [id, queryClient])
  return query
}

export function useLatestConfig(id: string | undefined, tool: string) {
  const queryClient = useQueryClient()
  const toolRef = useRef(tool)
  toolRef.current = tool
  const query = useQuery({
    queryKey: ["server", id, "config", tool],
    queryFn: () => api.getLatestConfig(id!, tool),
    enabled: !!id && !!tool,
    refetchInterval: 10000,
  })
  useEffect(() => {
    if (!id) return
    return subscribe(`server:${id}:tasks`, () => {
      void queryClient.invalidateQueries({ queryKey: ["server", id, "config", toolRef.current] })
    })
  }, [id, queryClient])
  return query
}

export function useAgentManifest() {
  return useQuery({
    queryKey: ["agent", "manifest"],
    queryFn: api.agentManifest,
    staleTime: 60_000,
  })
}

export function useCreateEnrollToken() {
  return useMutation({
    mutationFn: (input: { name?: string; tags?: string[]; expires_minutes?: number; mode?: "new" | "replace"; target_server_id?: string }) => api.createEnrollToken(input),
  })
}

export function useUpdateServer() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.updateServer(id, { name }),
    onSuccess: (_data, { id }) => {
      void queryClient.invalidateQueries({ queryKey: ["servers"] })
      void queryClient.invalidateQueries({ queryKey: ["server", id] })
    },
  })
}

export function useDeleteServer() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.deleteServer(id),
    onSuccess: (_data, id) => {
      void queryClient.invalidateQueries({ queryKey: ["servers"] })
      void queryClient.removeQueries({ queryKey: ["server", id] })
    },
  })
}

export function useReadServerConfig(id: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (tool: string) => api.readServerConfig(id!, tool),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["server", id, "tasks"] })
      void queryClient.invalidateQueries({ queryKey: ["server", id, "config"] })
    },
  })
}

export function useWriteServerConfig(id: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { tool: string; format: string; content: string }) => api.writeServerConfig(id!, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["server", id, "tasks"] })
      void queryClient.invalidateQueries({ queryKey: ["server", id, "config"] })
    },
  })
}

export function useListConfigBackups(id: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (tool: string) => api.listConfigBackups(id!, tool),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["server", id, "tasks"] })
    },
  })
}

export function useRestoreConfigBackup(id: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { tool: string; backup: string }) => api.restoreConfigBackup(id!, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["server", id, "tasks"] })
      void queryClient.invalidateQueries({ queryKey: ["server", id, "config"] })
    },
  })
}

export function useDetectTools(id: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (tool?: string | null) => api.detectTools(id!, tool),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["server", id, "tasks"] })
      void queryClient.invalidateQueries({ queryKey: ["server", id] })
    },
  })
}

export function useSetCredential(id: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { tool: string; provider_id: string; key_id: string }) => api.setCredential(id!, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["server", id, "tasks"] })
    },
  })
}

export function useRemoveCredential(id: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { tool: string; provider_id?: string; key_id?: string }) => api.removeCredential(id!, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["server", id, "tasks"] })
    },
  })
}

export function useUpgradeAgent(id: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api.upgradeAgent(id!),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["server", id, "tasks"] })
      void queryClient.invalidateQueries({ queryKey: ["server", id] })
    },
  })
}

export function useManageTool(id: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { tool: string; action: "install" | "upgrade" | "uninstall"; version?: string }) => api.manageTool(id!, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["server", id, "tasks"] })
      void queryClient.invalidateQueries({ queryKey: ["server", id] })
    },
  })
}

// Compatibility export for code outside this page that still needs upgrade-only.
export function useUpgradeTool(id: string | undefined) {
  const manageTool = useManageTool(id)
  return {
    ...manageTool,
    mutate: (input: { tool: string; version?: string }, options?: Parameters<typeof manageTool.mutate>[1]) =>
      manageTool.mutate({ ...input, action: "upgrade" }, options),
  }
}
