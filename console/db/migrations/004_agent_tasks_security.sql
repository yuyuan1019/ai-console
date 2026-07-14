-- 004_agent_tasks_security.sql — agent_tasks 加安全协议字段
-- request_id: 关联控制台请求 ID（审计链路）
-- nonce: 命令下发一次性随机数（防重放）
-- expires_at: 命令过期时间戳（超时自动失效）
-- attempt_count: 重试次数
ALTER TABLE agent_tasks ADD COLUMN request_id TEXT;
ALTER TABLE agent_tasks ADD COLUMN nonce TEXT;
ALTER TABLE agent_tasks ADD COLUMN expires_at INTEGER;
ALTER TABLE agent_tasks ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
