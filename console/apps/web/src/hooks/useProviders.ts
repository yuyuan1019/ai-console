import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "@/lib/api"
import type { CreateProviderInput, CreateProviderKeyInput, UpdateProviderInput, UpdateProviderKeyInput } from "@/lib/api"

export function useProviders() {
  return useQuery({ queryKey: ["providers"], queryFn: api.providers })
}

export function useImportJobs() {
  return useQuery({ queryKey: ["import-jobs"], queryFn: api.importJobs })
}

export function useProvider(id: string | undefined) {
  return useQuery({
    queryKey: ["provider", id],
    queryFn: () => api.provider(id!),
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
