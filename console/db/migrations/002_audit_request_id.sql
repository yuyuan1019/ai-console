-- 002_audit_request_id.sql — 审计日志加 request_id 字段（用于追踪请求链路）
ALTER TABLE audit_log ADD COLUMN request_id TEXT;
