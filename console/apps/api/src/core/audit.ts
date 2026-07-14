import { db } from "./db"
import { currentRequestId } from "./context"

export function audit(actor: string | null, action: string, target: string, before: unknown = null, after: unknown = null, requestId?: string) {
  const rid = requestId ?? currentRequestId()
  db.prepare("INSERT INTO audit_log(actor,action,target,before_json,after_json,ts,request_id) VALUES(?,?,?,?,?,?,?)").run(
    actor,
    action,
    target,
    before ? JSON.stringify(before) : null,
    after ? JSON.stringify(after) : null,
    Date.now(),
    rid ?? null
  )
}
