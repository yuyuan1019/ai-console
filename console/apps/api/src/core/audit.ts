import { db } from "./db"
import { currentRequestId } from "./context"

// ponytail (BUG-01): defense-in-depth redactor. Call sites should already pass
// allowlisted metadata; this recursive redactor makes sure that if any caller
// slips a payload that contains keys matching sensitive names, the values
// don't hit audit_log even when the schema-level DB migration 016 only
// touches historical rows. Applied at write time — the columns already store
// JSON strings, so we run over the already-parsed structure.

const SENSITIVE_KEY_PATTERN = /^(api[_-]?key|secret|password|token|authorization|credentials|encrypted[_-]?value|iv|refresh[_-]?token|access[_-]?token|openai[_-]?api[_-]?key|anthropic[_-]?auth[_-]?token|anthropic[_-]?api[_-]?key|gemini[_-]?api[_-]?key|google[_-]?api[_-]?key|google[_-]?gemini[_-]?base[_-]?url|apikey)$/i

const REDACTED = "[REDACTED]"

function redact(input: unknown, depth = 0): unknown {
  if (depth > 6) return REDACTED
  if (input === null || input === undefined) return input
  if (Array.isArray(input)) return input.map((v) => redact(v, depth + 1))
  if (typeof input === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(k)) {
        out[k] = REDACTED
        continue
      }
      out[k] = redact(v, depth + 1)
    }
    return out
  }
  return input
}

export function audit(actor: string | null, action: string, target: string, before: unknown = null, after: unknown = null, requestId?: string) {
  const rid = requestId ?? currentRequestId()
  db.prepare("INSERT INTO audit_log(actor,action,target,before_json,after_json,ts,request_id) VALUES(?,?,?,?,?,?,?)").run(
    actor,
    action,
    target,
    before ? JSON.stringify(redact(before)) : null,
    after ? JSON.stringify(redact(after)) : null,
    Date.now(),
    rid ?? null
  )
}
