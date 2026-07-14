import crypto from "node:crypto"

export const PASS = process.env.MASTER_KEY || "ai-console-dev-master-key-change-me"
export const KEY = crypto.createHash("sha256").update(PASS).digest()
export const JWT_SECRET = process.env.JWT_SECRET || crypto.createHash("sha256").update(`${PASS}:jwt`).digest("hex")
export const ACCESS_TTL_MS = 15 * 60 * 1000
export const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const COOKIE_NAME = "ai_console_refresh"
export const TARGET_PASSWORD_ALGO = "scrypt"

export const AGENT_ACTIONS = ["read_config", "write_config", "list_config_backups", "restore_config_backup", "detect_tools", "set_credential", "remove_credential", "upgrade_agent", "run_test", "upgrade_tool"] as const

export type Role = "admin" | "operator" | "viewer"

export interface AuthUser {
  id: string
  username: string
  role: Role
}

export interface JwtPayload extends AuthUser {
  exp: number
}
