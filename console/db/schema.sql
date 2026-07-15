-- AI Console schema (SQLite) — 完整参考快照
-- 注意：实际建库走 db/migrations/ 增量 migration 系统（见 server.ts runMigrations）。
-- 本文件作为参考快照和 fallback（migrations 目录不存在时使用）。
-- 新增 schema 变更请同时在 migrations/ 下新增增量 migration 文件，并同步更新本快照。
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- ===== 认证 =====
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  password_algo TEXT NOT NULL DEFAULT 'scrypt',    -- hash version（scrypt|argon2id...）
  role TEXT NOT NULL DEFAULT 'viewer',        -- admin|operator|viewer
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
  agent_version TEXT,
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
  finished_at INTEGER,
  request_id TEXT,                            -- 关联控制台请求 ID（审计链路）
  nonce TEXT,                                 -- 命令下发一次性随机数（防重放）
  expires_at INTEGER,                         -- 命令过期时间戳（超时自动失效）
  attempt_count INTEGER NOT NULL DEFAULT 0    -- 重试次数
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
  preset TEXT,                                 -- one-api|openai|anthropic|custom|ccswitch
  enabled INTEGER NOT NULL DEFAULT 1,
  default_model_id TEXT,
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
  last_models_refresh INTEGER,
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
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT, action TEXT, target TEXT,
  before_json TEXT, after_json TEXT, ts INTEGER NOT NULL,
  request_id TEXT                              -- 追踪请求链路
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
