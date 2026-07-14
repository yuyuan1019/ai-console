-- 003_password_algo.sql — 用户表加密码算法标识列（hash version，用于登录时自动升级）
ALTER TABLE users ADD COLUMN password_algo TEXT NOT NULL DEFAULT 'scrypt';
