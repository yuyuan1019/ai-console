import { AsyncLocalStorage } from "node:async_hooks"

export interface RequestContext {
  requestId: string
}

export const requestContext = new AsyncLocalStorage<RequestContext>()

export function currentRequestId(): string | null {
  return requestContext.getStore()?.requestId ?? null
}
