import type { FastifyInstance } from "fastify"
import crypto from "node:crypto"
import { db } from "../../core/db"
import { hashPassword, verifyPassword, signJwt, b64url, hashToken } from "../../core/crypto"
import { COOKIE_NAME, REFRESH_TTL_MS, TARGET_PASSWORD_ALGO } from "../../core/constants"
import { audit } from "../../core/audit"
import { authFromRequest } from "../../middleware/auth"
import type { AuthUser, Role } from "../../core/constants"

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {}
  for (const part of (header || "").split(";")) {
    const idx = part.indexOf("=")
    if (idx === -1) continue
    const key = part.slice(0, idx).trim()
    const value = part.slice(idx + 1).trim()
    if (key) cookies[key] = decodeURIComponent(value)
  }
  return cookies
}

function setRefreshCookie(reply: any, value: string, expiresAt: number) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : ""
  reply.header(
    "set-cookie",
    `${COOKIE_NAME}=${encodeURIComponent(value)}; Path=/api/auth; HttpOnly; SameSite=Strict${secure}; Expires=${new Date(expiresAt).toUTCString()}`
  )
}

function clearRefreshCookie(reply: any) {
  reply.header(
    "set-cookie",
    `${COOKIE_NAME}=; Path=/api/auth; HttpOnly; SameSite=Strict; Expires=Thu, 01 Jan 1970 00:00:00 GMT`
  )
}

// ponytail (bug 21): 单次有效 WS 票据。30s 有效，consume 时即删。即便票据泄漏进
// WS 握手的访问日志，也已消费；即便未消费也仅 30s 失效——严格优于把 15 分钟的
// access JWT 放进 URL query（?token=）。
const wsTickets = new Map<string, { userId: string; expiresAt: number }>()
let wsTicketCleanupStarted = false

export function issueWsTicket(userId: string): { ticket: string; expires_in: number } {
  if (!wsTicketCleanupStarted) {
    wsTicketCleanupStarted = true
    const handle = setInterval(() => {
      const now = Date.now()
      for (const [k, v] of wsTickets) if (v.expiresAt < now) wsTickets.delete(k)
    }, 60_000)
    if (typeof handle.unref === "function") handle.unref()
  }
  const ticket = b64url(crypto.randomBytes(32))
  wsTickets.set(ticket, { userId, expiresAt: Date.now() + 30_000 })
  return { ticket, expires_in: 30 }
}

export function consumeWsTicket(ticket: string): AuthUser | null {
  const entry = wsTickets.get(ticket)
  if (!entry) return null
  wsTickets.delete(ticket) // single-use：必须先删再判过期
  if (entry.expiresAt < Date.now()) return null
  const row = db.prepare("SELECT id, username, role FROM users WHERE id=?").get(entry.userId) as any
  if (!row) return null
  return { id: row.id, username: row.username, role: row.role as Role }
}

function createSession(user: AuthUser, req: any, reply: any): { accessToken: string; user: AuthUser } {
  const sessionId = crypto.randomUUID()
  const secret = b64url(crypto.randomBytes(32))
  const now = Date.now()
  db.prepare(
    "INSERT INTO sessions(id,user_id,refresh_token_hash,user_agent,ip,last_active_at,created_at) VALUES(?,?,?,?,?,?,?)"
  ).run(sessionId, user.id, hashToken(secret), req.headers["user-agent"] || null, req.ip || null, now, now)
  setRefreshCookie(reply, `${sessionId}.${secret}`, now + REFRESH_TTL_MS)
  return { accessToken: signJwt(user), user }
}

// ponytail (BUG-03): rotateSession used to return `null` for three distinct
// situations — invalid, replay, and "another concurrent request already
// rotated this same session very recently". The /refresh handler couldn't
// tell them apart and cleared the refresh cookie in all three cases, so two
// tabs racing each other on the same access-expired page would both end up
// logged out. Switch to a discriminated union so the handler can distinguish
// recoverable races from real invalidation.
type RotateResult =
  | { kind: "ok"; session: { accessToken: string; user: AuthUser } }
  | { kind: "recent_rotation" }
  | { kind: "invalid" }
  | { kind: "replay" }

function rotateSession(refreshToken: string, reply: any): RotateResult {
  const [sessionId, secret] = refreshToken.split(".")
  if (!sessionId || !secret) return { kind: "invalid" }
  const row = db
    .prepare(
      `SELECT s.id AS session_id, s.refresh_token_hash, s.revoked_at, s.rotated_at,
              u.id, u.username, u.role
       FROM sessions s JOIN users u ON u.id=s.user_id
       WHERE s.id=?`
    )
    .get(sessionId) as any
  if (!row || row.revoked_at) return { kind: "invalid" }
  if (row.refresh_token_hash !== hashToken(secret)) {
    // ponytail (BUG-03): concurrent refresh — the loser sees the winner's new
    // hash and would otherwise be treated as a replay. If the session was
    // rotated within the last 30s, treat as a recent-rotation race: do NOT
    // revoke, do NOT clear cookie, do NOT sign a new access token here (the
    // caller must retry so it picks up the winner's cookie).
    if (row.rotated_at && Date.now() - row.rotated_at < 30_000) return { kind: "recent_rotation" }
    db.prepare("UPDATE sessions SET revoked_at=? WHERE id=?").run(Date.now(), sessionId)
    audit(row.id, "auth.replay_detected", `session:${sessionId}`)
    return { kind: "replay" }
  }
  const nextSecret = b64url(crypto.randomBytes(32))
  db.prepare("UPDATE sessions SET refresh_token_hash=?, rotated_at=?, last_active_at=? WHERE id=?").run(
    hashToken(nextSecret),
    Date.now(),
    Date.now(),
    sessionId
  )
  setRefreshCookie(reply, `${sessionId}.${nextSecret}`, Date.now() + REFRESH_TTL_MS)
  const user = { id: row.id, username: row.username, role: row.role as Role }
  return { kind: "ok", session: { accessToken: signJwt(user), user } }
}

export function registerAuthRoutes(app: FastifyInstance) {
  app.post<{ Body: { username?: string; password?: string } }>(
    "/api/auth/login",
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: "15 minutes",
          keyGenerator: (req: any) => `${req.ip}|${String(req.body?.username || "").trim()}`,
          errorResponseBuilder: () => ({ statusCode: 429, error: "Too Many Requests", message: "too many login attempts, try again later" }),
        },
      },
    },
    async (req, reply) => {
      const username = String(req.body?.username || "").trim()
      const password = String(req.body?.password || "")
      if (!username || !password) return reply.code(400).send({ error: "username and password are required" })

      const row = db.prepare("SELECT * FROM users WHERE username=?").get(username) as any
      if (!row) {
        audit(null, "auth.login_failed", `user:${username}`)
        return reply.code(401).send({ error: "invalid credentials" })
      }
      if (row.locked_until && row.locked_until > Date.now()) {
        audit(row.id, "auth.login_locked", `user:${username}`)
        return reply.code(423).send({ error: "account locked" })
      }
      if (!verifyPassword(password, row.password_hash)) {
        const failed = Number(row.failed_login_count || 0) + 1
        const lockedUntil = failed >= 5 ? Date.now() + 5 * 60 * 1000 : null
        db.prepare("UPDATE users SET failed_login_count=?, locked_until=?, updated_at=? WHERE id=?").run(
          failed,
          lockedUntil,
          Date.now(),
          row.id
        )
        audit(row.id, "auth.login_failed", `user:${username}`, null, { failed })
        return reply.code(401).send({ error: "invalid credentials" })
      }

      db.prepare("UPDATE users SET failed_login_count=0, locked_until=NULL, updated_at=? WHERE id=?").run(Date.now(), row.id)

      if (row.password_algo !== TARGET_PASSWORD_ALGO) {
        db.prepare("UPDATE users SET password_hash=?, password_algo=?, updated_at=? WHERE id=?").run(
          hashPassword(password),
          TARGET_PASSWORD_ALGO,
          Date.now(),
          row.id
        )
        audit(row.id, "auth.password_rehash", `user:${username}`, null, { from: row.password_algo || "unknown", to: TARGET_PASSWORD_ALGO })
      }

      const user = { id: row.id, username: row.username, role: row.role as Role }
      const session = createSession(user, req, reply)
      audit(user.id, "auth.login", `user:${username}`)
      return session
    }
  )

  app.post<{ Body: { old_password?: string; new_password?: string } }>("/api/auth/change-password", async (req, reply) => {
    const user = authFromRequest(req)
    if (!user) return reply.code(401).send({ error: "unauthorized" })
    const oldPwd = String(req.body?.old_password || "")
    const newPwd = String(req.body?.new_password || "")
    if (!oldPwd || !newPwd) return reply.code(400).send({ error: "old_password and new_password are required" })
    if (newPwd.length < 8) return reply.code(400).send({ error: "password must be at least 8 characters" })
    const dbUser = db.prepare("SELECT password_hash FROM users WHERE id=?").get(user.id) as any
    if (!verifyPassword(oldPwd, dbUser.password_hash)) return reply.code(401).send({ error: "invalid old password" })
    db.prepare("UPDATE users SET password_hash=?, password_algo=?, updated_at=? WHERE id=?").run(hashPassword(newPwd), TARGET_PASSWORD_ALGO, Date.now(), user.id)
    const currentSessionId = parseCookies(req.headers.cookie)[COOKIE_NAME]?.split(".")[0] || ""
    db.prepare("UPDATE sessions SET revoked_at=? WHERE user_id=? AND id!=? AND revoked_at IS NULL").run(Date.now(), user.id, currentSessionId)
    audit(user.id, "auth.change_password", `user:${user.username}`)
    return { ok: true }
  })

  app.post("/api/auth/refresh", async (req, reply) => {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME]
    if (!token) {
      clearRefreshCookie(reply)
      return reply.code(401).send({ error: "unauthorized" })
    }
    const result = rotateSession(token, reply)
    if (result.kind === "ok") return result.session
    if (result.kind === "recent_rotation") {
      // ponytail (BUG-03): do NOT clear cookie, do NOT sign a new access
      // token. The winning request has already written a fresh cookie; the
      // client must retry so its next request uses that cookie. Signing a
      // new access token here would let a stolen old refresh token continue
      // minting access tokens during the 30s grace window.
      return reply.code(409).send({ error: "refresh_already_rotated" })
    }
    // invalid / replay
    clearRefreshCookie(reply)
    return reply.code(401).send({ error: "unauthorized" })
  })

  app.get("/api/auth/me", async (req, reply) => {
    // ponytail (BUG-03): /auth/me used to implicitly rotate the refresh
    // cookie when access JWT was missing/expired. That caused a GET to have
    // side effects and made it impossible for the client's single-flight
    // refresh to cover both /me and /ws-ticket during expiry. Now /me only
    // trusts the access JWT; the client must call /refresh explicitly.
    const user = authFromRequest(req)
    if (!user) return reply.code(401).send({ error: "unauthorized" })
    return { user }
  })

  app.post("/api/auth/ws-ticket", async (req, reply) => {
    // ponytail (bug 21): /api/auth/* 在 middleware/auth.ts 是公开例外（不走全局 JWT
    // 钩子），所以这里必须显式 authFromRequest——否则任何人都能匿名领票连 WS。
    const user = authFromRequest(req)
    if (!user) return reply.code(401).send({ error: "unauthorized" })
    return issueWsTicket(user.id)
  })

  app.post("/api/auth/logout", async (req, reply) => {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME]
    const [sessionId] = token?.split(".") || []
    if (sessionId) db.prepare("UPDATE sessions SET revoked_at=? WHERE id=?").run(Date.now(), sessionId)
    clearRefreshCookie(reply)
    const user = authFromRequest(req)
    audit(user?.id || null, "auth.logout", "session")
    return { ok: true }
  })
}
