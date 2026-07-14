-- 001_baseline.sql — 初始 schema（从 schema.sql 提取，PRAGMA 由 runner 统一设置）
-- 注意：schema_migrations 表由 migration runner 创建，不在此文件内。

-- ===== 认证 =====
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',        -- admin|operator|viewer
  totp_secret TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  recovery_codes_hash TEXT,
  failed_login_count INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash TEXT NOT NULL,
  user_agent TEXT, ip TEXT,
  last_active_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

-- ===== 服务器与配置 =====
CREATE TABLE IF NOT EXISTS server_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT);
CREATE TABLE IF NOT EXISTS servers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, os TEXT, arch TEXT, host TEXT,
  agent_token_hash TEXT, status TEXT NOT NULL DEFAULT 'offline',
  last_seen INTEGER, tags TEXT NOT NULL DEFAULT '[]', group_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_enroll_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  name TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tools (
  server_id TEXT NOT NULL, name TEXT NOT NULL,
  installed INTEGER NOT NULL DEFAULT 0, version TEXT, path TEXT, detected_at INTEGER,
  PRIMARY KEY (server_id, name)
);
CREATE TABLE IF NOT EXISTS agent_tasks (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  action TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  result_json TEXT,
  error TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  claimed_at INTEGER,
  finished_at INTEGER
);
CREATE TABLE IF NOT EXISTS configs (
  server_id TEXT NOT NULL, tool TEXT NOT NULL, format TEXT NOT NULL,
  content TEXT NOT NULL, version INTEGER NOT NULL, source TEXT NOT NULL,  -- manual|binding|batch
  updated_by TEXT, updated_at INTEGER NOT NULL,
  PRIMARY KEY (server_id, tool, version)
);

-- ===== 供应商与模型管理 =====
CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT,
  models_endpoint TEXT DEFAULT '/v1/models',
  usage_probe_json TEXT,                       -- {type:http|script, ...}
  preset TEXT,                                 -- one-api|openai|anthropic|custom|ccswitch
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS provider_keys (
  id TEXT PRIMARY KEY, provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  label TEXT NOT NULL, group_name TEXT, family TEXT NOT NULL,  -- claude|codex|gemini|mixed|other
  encrypted_value TEXT,                        -- AES-256-GCM base64(ciphertext+tag); NULL for oauth
  iv TEXT,
  api_format TEXT,                             -- openai_responses|anthropic|gemini
  auth_type TEXT NOT NULL DEFAULT 'apikey',    -- apikey|oauth
  raw_config_json TEXT,                        -- 原始 settings_config, 供精确还原下发
  enabled INTEGER NOT NULL DEFAULT 1,
  last_models_refresh INTEGER, last_usage_refresh INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS provider_endpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  url TEXT NOT NULL, added_at INTEGER
);
CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY, provider_id TEXT, key_id TEXT,
  model_id TEXT NOT NULL, family TEXT,
  display_name TEXT, context_window INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1, fetched_at INTEGER
);
CREATE TABLE IF NOT EXISTS bindings (
  id TEXT PRIMARY KEY, server_id TEXT, tool TEXT NOT NULL,
  provider_id TEXT, key_id TEXT, model_id TEXT,
  label TEXT, active INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, last_activated_at INTEGER
);
CREATE TABLE IF NOT EXISTS usage_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id TEXT NOT NULL, ts INTEGER NOT NULL,
  balance REAL, used REAL, total REAL, raw_json TEXT
);
CREATE TABLE IF NOT EXISTS import_jobs (
  id TEXT PRIMARY KEY, source_type TEXT NOT NULL, source_path TEXT,
  status TEXT NOT NULL, counts_json TEXT,
  started_by TEXT, started_at INTEGER NOT NULL, finished_at INTEGER
);

-- ===== 批量与测试 =====
CREATE TABLE IF NOT EXISTS batch_jobs (
  id TEXT PRIMARY KEY, tool TEXT NOT NULL, source_type TEXT, source_ref TEXT,
  targets_json TEXT, status TEXT NOT NULL, progress_json TEXT,
  started_by TEXT, started_at INTEGER NOT NULL, finished_at INTEGER
);
CREATE TABLE IF NOT EXISTS test_runs (
  id TEXT PRIMARY KEY, server_id TEXT, tool TEXT NOT NULL, status TEXT NOT NULL,
  exit_code INTEGER, stdout TEXT, stderr TEXT, duration_ms INTEGER,
  started_by TEXT, started_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT, action TEXT, target TEXT,
  before_json TEXT, after_json TEXT, ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, tool TEXT, format TEXT, content TEXT,
  created_at INTEGER NOT NULL
);

-- ===== 定价(从 CC Switch 导入) =====
CREATE TABLE IF NOT EXISTS model_pricing (
  model_id TEXT PRIMARY KEY, display_name TEXT NOT NULL,
  input_cost_per_million TEXT NOT NULL, output_cost_per_million TEXT NOT NULL,
  cache_read_cost_per_million TEXT NOT NULL DEFAULT '0',
  cache_creation_cost_per_million TEXT NOT NULL DEFAULT '0'
);

CREATE INDEX IF NOT EXISTS idx_provider_keys_provider ON provider_keys(provider_id);
CREATE INDEX IF NOT EXISTS idx_models_provider ON models(provider_id);
CREATE INDEX IF NOT EXISTS idx_bindings_server_tool ON bindings(server_id, tool);
CREATE INDEX IF NOT EXISTS idx_usage_snapshots_key ON usage_snapshots(key_id, ts);
