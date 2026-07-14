import type { FastifyInstance } from "fastify"
import crypto from "node:crypto"
import { verifyJwt } from "../core/crypto"
import { requestContext } from "../core/context"
import type { AuthUser } from "../core/constants"

export function authFromRequest(req: any): AuthUser | null {
  const auth = String(req.headers.authorization || "")
  if (!auth.toLowerCase().startsWith("bearer ")) return null
  return verifyJwt(auth.slice(7).trim())
}

export function registerHooks(app: FastifyInstance) {
  app.addHook("onRequest", async (req, reply) => {
    requestContext.enterWith({ requestId: String(req.id || crypto.randomUUID()) })

    reply.header("access-control-allow-origin", "*")
    reply.header("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")
    reply.header("access-control-allow-headers", "content-type,authorization")
    if (req.method === "OPTIONS") return reply.code(204).send()

    const url = req.url.split("?")[0]
    const isPublic = url === "/api/health" || url.startsWith("/api/auth/") || url === "/api/ws"
    if (!url.startsWith("/api/") || isPublic) return
    const user = authFromRequest(req)
    if (!user) return reply.code(401).send({ error: "unauthorized" })
    ;(req as any).auth = user

    const roleOrder = ["viewer", "operator", "admin"] as const
    const adminOnly = [
      "/api/providers/import/", "/api/agent/enroll-tokens",
    ]
    const operatorPlus = [
      "/api/providers", "/api/servers/", "/api/batch/",
    ]
    const path = url.endsWith("/") ? url.slice(0, -1) : url
    const isAdminOnly = adminOnly.some((p) => path.startsWith(p)) && req.method !== "GET"
    const isOperatorPlus = operatorPlus.some((p) => path.startsWith(p)) && !["GET", "OPTIONS"].includes(req.method)
    if (isAdminOnly && roleOrder.indexOf(user.role) < roleOrder.indexOf("admin")) {
      return reply.code(403).send({ error: "admin role required" })
    }
    if (isOperatorPlus && roleOrder.indexOf(user.role) < roleOrder.indexOf("operator")) {
      return reply.code(403).send({ error: "operator or admin role required" })
    }
  })
}
