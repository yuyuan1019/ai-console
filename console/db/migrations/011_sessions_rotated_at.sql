-- 011_sessions_rotated_at.sql — sessions 表：记录 refresh-token 最近一次轮换时间
-- 用途：rotateSession() 据此容忍并发同 cookie 轮换——竞争落败方看到 hash 不匹配
-- 但 rotated_at<30s，视为「刚被本会话轮换」而抑制误判 replay-撤销，避免把合法
-- 用户登出（bug 9）。
ALTER TABLE sessions ADD COLUMN rotated_at INTEGER;
