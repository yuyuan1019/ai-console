import Fastify from "fastify"
import websocket from "@fastify/websocket"
import rateLimit from "@fastify/rate-limit"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { productionCheck, runMigrations, WEB_DIST_PATH } from "./core/db"
import { db } from "./core/db"
import { registerHooks } from "./middleware/auth"
import { registerAuthRoutes } from "./modules/auth/routes"
import { registerAgentRoutes } from "./modules/agent/routes"
import { registerProvidersRoutes } from "./modules/providers/routes"
import { registerServersRoutes } from "./modules/servers/routes"
import { registerBatchRoutes } from "./modules/batch/routes"
import { registerAuditRoutes } from "./modules/audit/routes"
import { registerImportJobsRoutes } from "./modules/import-jobs/routes"
import { hashPassword } from "./core/crypto"
import { audit } from "./core/audit"
import { TARGET_PASSWORD_ALGO } from "./core/constants"

const app = Fastify({
  logger: true,
  bodyLimit: 50 * 1024 * 1024,
  genReqId: () => crypto.randomUUID(),
})
await app.register(websocket)
await app.register(rateLimit, {
  global: false,
  max: 0,
})

productionCheck(app.log)
runMigrations(app.log)

// ensure bootstrap admin
const count = (db.prepare("SELECT COUNT(*) AS c FROM users").get() as any).c as number
if (count === 0) {
  const username = process.env.BOOTSTRAP_ADMIN_USER || "admin"
  const password = process.env.BOOTSTRAP_ADMIN_PASS || "admin"
  const now = Date.now()
  db.prepare("INSERT INTO users(id,username,password_hash,password_algo,role,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(
    crypto.randomUUID(),
    username,
    hashPassword(password),
    TARGET_PASSWORD_ALGO,
    "admin",
    now,
    now
  )
  audit("system", "auth.bootstrap_admin", `user:${username}`)
  app.log.warn(`created bootstrap admin user "${username}"`)
}

registerHooks(app)
registerAuthRoutes(app)
registerAgentRoutes(app)
registerProvidersRoutes(app)
registerServersRoutes(app)
registerBatchRoutes(app)
registerAuditRoutes(app)
registerImportJobsRoutes(app)

app.get("/api/health", () => ({ ok: true, ts: Date.now() }))

// ponytail: sweep zombie agents. An agent that crashes or loses network
// without a clean WS close never fires the close handler, so the DB would
// keep reporting it "online" forever. last_seen is updated by every
// heartbeat, so stale == dead. 120s tolerance > 25s agent heartbeat interval.
setInterval(() => {
  const cutoff = Date.now() - 120_000
  db.prepare("UPDATE servers SET status='offline' WHERE status='online' AND last_seen < ?").run(cutoff)
}, 30_000)

// SPA fallback
app.get("/*", async (req, reply) => {
  if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "not found" })
  const pathname = decodeURIComponent(req.url.split("?")[0] || "/")
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "")
  const filePath = path.resolve(WEB_DIST_PATH, rel)
  const target = filePath.startsWith(WEB_DIST_PATH) && fs.existsSync(filePath) ? filePath : path.join(WEB_DIST_PATH, "index.html")
  const ext = path.extname(target)
  const type = ext === ".html" ? "text/html" : ext === ".js" ? "text/javascript" : ext === ".css" ? "text/css" : "application/octet-stream"
  return reply.type(type).send(fs.createReadStream(target))
})

const PORT = Number(process.env.PORT || 3000)
app.listen({ port: PORT, host: "0.0.0.0" }).then(() => {
  app.log.info(`api ready on :${PORT} (db=${process.env.DB_PATH || "default"})`)
})
