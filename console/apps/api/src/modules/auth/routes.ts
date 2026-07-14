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

function rotateSession(refreshToken: string, reply: any): { accessToken: string; user: AuthUser } | null {
  const [sessionId, secret] = refreshToken.split(".")
  if (!sessionId || !secret) return null
  const row = db
    .prepare(
      `SELECT s.id AS session_id, s.refresh_token_hash, s.revoked_at,
              u.id, u.username, u.role
       FROM sessions s JOIN users u ON u.id=s.user_id
       WHERE s.id=?`
    )
    .get(sessionId) as any
  if (!row || row.revoked_at) return null
  if (row.refresh_token_hash !== hashToken(secret)) {
    db.prepare("UPDATE sessions SET revoked_at=? WHERE id=?").run(Date.now(), sessionId)
    audit(row.id, "auth.replay_detected", `session:${sessionId}`)
    return null
  }
  const nextSecret = b64url(crypto.randomBytes(32))
  db.prepare("UPDATE sessions SET refresh_token_hash=?, last_active_at=? WHERE id=?").run(
    hashToken(nextSecret),
    Date.now(),
    sessionId
  )
  setRefreshCookie(reply, `${sessionId}.${nextSecret}`, Date.now() + REFRESH_TTL_MS)
  const user = { id: row.id, username: row.username, role: row.role as Role }
  return { accessToken: signJwt(user), user }
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
    const session = token ? rotateSession(token, reply) : null
    if (!session) {
      clearRefreshCookie(reply)
      return reply.code(401).send({ error: "unauthorized" })
    }
    return session
  })

  app.get("/api/auth/me", async (req, reply) => {
    const user = authFromRequest(req)
    if (user) return { user }
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME]
    const session = token ? rotateSession(token, reply) : null
    if (!session) return reply.code(401).send({ error: "unauthorized" })
    return session
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
