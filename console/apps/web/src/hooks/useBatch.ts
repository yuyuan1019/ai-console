import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect } from "react"
import { api } from "@/lib/api"
import { subscribe } from "@/lib/ws"

export function usePreviewConfig() {
  return useMutation({
    mutationFn: (input: { tool: string; provider_id: string; key_id: string; model_id: string }) => api.previewConfig(input),
  })
}

export function useBatchExecute() {
  return useMutation({
    mutationFn: (input: { tool: string; server_ids: string[]; provider_id: string; key_id: string; model_id: string }) =>
      api.batchExecute(input),
  })
}

export function useBatchStatus(id: string | null) {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: ["batch", id],
    queryFn: () => api.batchStatus(id!),
    enabled: !!id,
    refetchInterval: 10000, // WS 离线时降级为 10s 轮询
  })
  useEffect(() => {
    if (!id) return
    return subscribe(`batch:${id}`, () => {
      void queryClient.invalidateQueries({ queryKey: ["batch", id] })
    })
  }, [id, queryClient])
  return query
}

export function useBatchRollback() {
  return useMutation({
    mutationFn: (id: string) => api.batchRollback(id),
  })
}
