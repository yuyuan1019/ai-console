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
import { registerAgentRoutes, broadcastBatchProgressForTask, dispatchNextTask } from "./modules/agent/routes"
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

// ponytail (bug 5/4): task reaper. pushTaskToAgent (WS) 与 GET /agent/tasks (REST)
// 认领时都写 expires_at=now+5min，但之前全仓库无人读 expires_at——agent 崩溃/被 kill
// 或 upgrade_agent 自重启(os.Exit) 后任务永远 running，WS 重连 flush 与 GET /agent/tasks
// 都只 SELECT status='pending'，跳过它。这里每 30s：(a) 把过期 running 回收到 pending
// 让重连/轮询重新领取；(b) attempt_count>=3 的直接判 failed（BUG-05：avoid infinite
// retry after agent crash-loops on the same task）；(c) 把长期 pending 且目标离线
// >10min 的判 failed 让 batch_jobs 能 finalize（bug 4）。每触及一个 task_id
// 广播一次，让 WS 侧 batch 状态机也跑起来；被空出的 server slot 也调 dispatchNextTask。
setInterval(() => {
  const now = Date.now()
  const offlineCutoff = now - 10 * 60_000
  // ponytail (BUG-05): first, promote attempt_count>=3 stale claims to failed
  // WITHOUT bouncing them back to pending. Otherwise a task the agent can
  // never complete would spin forever.
  const failedByAttempts = db
    .prepare(
      `UPDATE agent_tasks
          SET status='failed', error='task lease expired after 3 attempts', finished_at=?
        WHERE status='running' AND expires_at IS NOT NULL AND expires_at < ?
          AND attempt_count >= 3`
    )
    .run(now, now)
  const requeued = db
    .prepare(
      `UPDATE agent_tasks
          SET status='pending', claimed_at=NULL, nonce=NULL, expires_at=NULL
        WHERE status='running' AND expires_at IS NOT NULL AND expires_at < ?
          AND attempt_count < 3`
    )
    .run(now)
  const failed = db
    .prepare(
      `UPDATE agent_tasks
          SET status='failed', error='target agent offline > 10min', finished_at=?
        WHERE status='pending' AND created_at < ?
          AND server_id IN (SELECT id FROM servers WHERE status='offline' AND (last_seen IS NULL OR last_seen < ?))`
    )
    .run(now, offlineCutoff, offlineCutoff)
  if (failedByAttempts.changes || requeued.changes || failed.changes) {
    for (const job of db.prepare("SELECT progress_json FROM batch_jobs WHERE status IN ('running','rolling_back')").all() as any[]) {
      let entries: any[] = []
      try { entries = JSON.parse(job.progress_json || "[]") } catch {}
      for (const e of entries) if (e.task_id) broadcastBatchProgressForTask(e.task_id)
    }
    // ponytail (BUG-05): reaping frees per-server dispatch slots. Poke every
    // affected server so the next pending task moves without waiting for a
    // heartbeat.
    const servers = db
      .prepare("SELECT DISTINCT server_id FROM agent_tasks WHERE status='pending'")
      .all() as Array<{ server_id: string }>
    for (const s of servers) dispatchNextTask(s.server_id)
  }
}, 30_000)

// SPA fallback
app.get("/*", async (req, reply) => {
  if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "not found" })
  const pathname = decodeURIComponent(req.url.split("?")[0] || "/")
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "")
  const filePath = path.resolve(WEB_DIST_PATH, rel)
  // ponytail: 用 path.relative 做规范围栏检查。WEB_DIST_PATH 结尾是 'dist' 无分隔符，
  // 裸 startsWith 会让 /%2e%2e/dist.bak/... 解码后通过前缀检查，泄漏同级 dist.bak/
  // dist.old/ dist2 里的旧构建（bug 12）。
  const relToDist = path.relative(WEB_DIST_PATH, filePath)
  const within = relToDist !== "" && !relToDist.startsWith("..") && !path.isAbsolute(relToDist)
  const target = within && fs.existsSync(filePath) ? filePath : path.join(WEB_DIST_PATH, "index.html")
  const ext = path.extname(target)
  const type = ext === ".html" ? "text/html" : ext === ".js" ? "text/javascript" : ext === ".css" ? "text/css" : "application/octet-stream"
  return reply.type(type).send(fs.createReadStream(target))
})

const PORT = Number(process.env.PORT || 3000)
app.listen({ port: PORT, host: "0.0.0.0" }).then(() => {
  app.log.info(`api ready on :${PORT} (db=${process.env.DB_PATH || "default"})`)
})
