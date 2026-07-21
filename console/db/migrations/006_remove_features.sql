-- 006_remove_features.sql
-- 移除 TOTP(二步验证) / 活跃会话UI / 预设绑定(+模板) / 用量 相关 schema
-- 注：sessions 表保留（refresh token 轮换所需），仅移除其列表/撤销 UI。
-- 注：configs.source 的 'binding' 值与 batch_jobs.source_type 的 'profile' 值为历史自由文本，不做数据迁移。

-- ===== TOTP(二步验证) =====
ALTER TABLE users DROP COLUMN totp_secret;
ALTER TABLE users DROP COLUMN totp_enabled;
ALTER TABLE users DROP COLUMN recovery_codes_hash;

-- ===== 用量 =====
DROP TABLE IF EXISTS usage_snapshots;
ALTER TABLE providers DROP COLUMN usage_probe_json;
ALTER TABLE provider_keys DROP COLUMN last_usage_refresh;

-- ===== 预设 / 绑定 + 模板 =====
DROP TABLE IF EXISTS bindings;
DROP TABLE IF EXISTS profiles;

-- 显式清理索引（DROP TABLE 已级联，此处仅为保险）
DROP INDEX IF EXISTS idx_bindings_server_tool;
DROP INDEX IF EXISTS idx_usage_snapshots_key;
