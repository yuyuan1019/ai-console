import crypto from "node:crypto"
import { KEY, JWT_SECRET, ACCESS_TTL_MS } from "./constants"
import type { AuthUser } from "./constants"

export function decrypt(ev: string | null, iv: string | null): string | null {
  if (!ev || !iv) return null
  try {
    const b = Buffer.from(ev, "base64")
    const tag = b.subarray(-16)
    const ct = b.subarray(0, -16)
    const d = crypto.createDecipheriv("aes-256-gcm", KEY, Buffer.from(iv, "base64"))
    d.setAuthTag(tag)
    return Buffer.concat([d.update(ct), d.final()]).toString("utf8")
  } catch {
    return null
  }
}

export function encrypt(value: string): { encryptedValue: string; iv: string } {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv)
  const ct = Buffer.concat([cipher.update(value, "utf8"), cipher.final()])
  return {
    encryptedValue: Buffer.concat([ct, cipher.getAuthTag()]).toString("base64"),
    iv: iv.toString("base64"),
  }
}

export function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}

export function fromB64url(input: string): Buffer {
  const padded = input.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(input.length / 4) * 4, "=")
  return Buffer.from(padded, "base64")
}

export function signJwt(user: AuthUser): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const payload = b64url(JSON.stringify({ ...user, exp: Date.now() + ACCESS_TTL_MS }))
  const sig = b64url(crypto.createHmac("sha256", JWT_SECRET).update(`${header}.${payload}`).digest())
  return `${header}.${payload}.${sig}`
}

export function verifyJwt(token: string | undefined): AuthUser | null {
  if (!token) return null
  const parts = token.split(".")
  if (parts.length !== 3) return null
  const [header, payload, sig] = parts
  const expected = b64url(crypto.createHmac("sha256", JWT_SECRET).update(`${header}.${payload}`).digest())
  if (sig.length !== expected.length) return null
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null
  try {
    const parsed = JSON.parse(fromB64url(payload).toString("utf8"))
    if (!parsed.id || !parsed.username || !parsed.role || parsed.exp < Date.now()) return null
    return { id: parsed.id, username: parsed.username, role: parsed.role }
  } catch {
    return null
  }
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16)
  const derived = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 })
  return `scrypt$16384$8$1$${salt.toString("base64")}$${derived.toString("base64")}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, n, r, p, salt, hash] = stored.split("$")
  if (scheme !== "scrypt" || !n || !r || !p || !salt || !hash) return false
  const derived = crypto.scryptSync(password, Buffer.from(salt, "base64"), Buffer.from(hash, "base64").length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  })
  return crypto.timingSafeEqual(derived, Buffer.from(hash, "base64"))
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex")
}

export function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex")
}
