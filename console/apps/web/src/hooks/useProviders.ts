import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { useEffect } from "react"
import { api } from "@/lib/api"
import { subscribe } from "@/lib/ws"
import type { CreateProviderInput, CreateProviderKeyInput, UpdateProviderInput, UpdateProviderKeyInput } from "@/lib/api"

export function useProviders() {
  return useQuery({ queryKey: ["providers"], queryFn: api.providers })
}

export function useImportJobs() {
  return useQuery({ queryKey: ["import-jobs"], queryFn: api.importJobs })
}

export function useProvider(id: string | undefined, keyId?: string) {
  const queryClient = useQueryClient()
  useEffect(() => {
    if (!id) return
    return subscribe(`provider:${id}:keys`, () => {
      void queryClient.invalidateQueries({ queryKey: ["provider", id] })
      void queryClient.invalidateQueries({ queryKey: ["providers"] })
    })
  }, [id, queryClient])
  return useQuery({
    queryKey: ["provider", id, keyId],
    queryFn: () => api.provider(id!, keyId),
    enabled: !!id,
  })
}

export function useModels() {
  return useQuery({ queryKey: ["models"], queryFn: api.models })
}

export function usePing() {
  return useMutation({
    mutationFn: ({ providerId, keyId, modelId }: { providerId: string; keyId: string; modelId?: string }) =>
      api.ping(providerId, keyId, modelId),
  })
}

export function useRefreshModels(providerId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (keyId: string) => api.refreshModels(providerId!, keyId),
    onSuccess: () => {
      void queryClient.removeQueries({ queryKey: ["provider", providerId] })
      void queryClient.invalidateQueries({ queryKey: ["provider", providerId] })
      void queryClient.invalidateQueries({ queryKey: ["models"] })
      void queryClient.invalidateQueries({ queryKey: ["providers"] })
    },
  })
}

export function useCreateProvider() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateProviderInput) => api.createProvider(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["providers"] })
    },
  })
}

export function useImportAccountCredential(providerId?: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { serverId: string; tool: "codex" | "claude"; label: string; providerId?: string }) => {
      const targetProviderId = input.providerId || providerId
      if (!targetProviderId) throw new Error("provider id is required")
      return api.importAccountCredential(input.serverId, { tool: input.tool, provider_id: targetProviderId, label: input.label })
    },
    onSuccess: (_result, input) => {
      const targetProviderId = input.providerId || providerId
      void queryClient.invalidateQueries({ queryKey: ["provider", targetProviderId] })
      void queryClient.invalidateQueries({ queryKey: ["providers"] })
    },
  })
}

/** 快捷添加：一步创建 provider + key（用于预设常用供应商，填个 API key 就能用） */
export function useQuickAddProvider() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      name: string
      base_url: string
      models_endpoint: string
      preset: string
      family: string
      api_format: string | null
      api_key: string
      label: string
    }) => {
      const provider = await api.createProvider({
        name: input.name,
        base_url: input.base_url || null,
        models_endpoint: input.models_endpoint,
        preset: input.preset,
        enabled: true,
      })
      await api.createProviderKey(provider.id, {
        label: input.label,
        api_key: input.api_key,
        family: input.family,
        api_format: input.api_format,
      })
      return provider
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["providers"] })
      void queryClient.invalidateQueries({ queryKey: ["models"] })
    },
  })
}

export function useImportCcSwitch() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: unknown) => api.importCcSwitch(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["providers"] })
      void queryClient.invalidateQueries({ queryKey: ["models"] })
      void queryClient.invalidateQueries({ queryKey: ["import-jobs"] })
    },
  })
}

export function useRollbackImport() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.rollbackImport(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["providers"] })
      void queryClient.invalidateQueries({ queryKey: ["models"] })
      void queryClient.invalidateQueries({ queryKey: ["import-jobs"] })
    },
  })
}

export function useUpdateProvider(id: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: UpdateProviderInput) => api.updateProvider(id!, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["providers"] })
      void queryClient.invalidateQueries({ queryKey: ["provider", id] })
    },
  })
}

export function useDeleteProvider() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.deleteProvider(id),
    onSuccess: (_data, id) => {
      void queryClient.invalidateQueries({ queryKey: ["providers"] })
      void queryClient.removeQueries({ queryKey: ["provider", id] })
      void queryClient.invalidateQueries({ queryKey: ["models"] })
    },
  })
}

export function useCreateProviderKey(providerId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateProviderKeyInput) => api.createProviderKey(providerId!, input),
    onSuccess: () => {
      void queryClient.removeQueries({ queryKey: ["provider", providerId] })
      void queryClient.invalidateQueries({ queryKey: ["providers"] })
      void queryClient.invalidateQueries({ queryKey: ["provider", providerId] })
    },
  })
}

export function useDisableProviderKey(providerId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (keyId: string) => api.disableProviderKey(providerId!, keyId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["providers"] })
      void queryClient.invalidateQueries({ queryKey: ["provider", providerId] })
    },
  })
}

export function useUpdateProviderKey(providerId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ keyId, input }: { keyId: string; input: UpdateProviderKeyInput }) =>
      api.updateProviderKey(providerId!, keyId, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["providers"] })
      void queryClient.invalidateQueries({ queryKey: ["provider", providerId] })
    },
  })
}
