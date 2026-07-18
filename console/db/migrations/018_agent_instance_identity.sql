-- Migration 018: agent instance identity (intermediate shape)
-- Refs: BUGFIXES-2026-07-18.md BUG-08
-- IMPLEMENTATION-PLAN.md §6 提交 2 / 提交 12

-- ponytail: 018 is the ALTER-only intermediate shape. Final NOT NULL/UNIQUE
-- form on servers.agent_instance_id is applied by migration 019, which
-- rebuilds the table (SQLite can't add NOT NULL via ALTER on an existing
-- populated table). Deploy Step 3 must clear servers before 019 runs, and
-- 019 enforces that with an empty-table CHECK.
ALTER TABLE servers ADD COLUMN agent_instance_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_servers_agent_instance_id
  ON servers(agent_instance_id)
  WHERE agent_instance_id IS NOT NULL;

-- Enroll tokens gain per-token target/mode so operators can issue a
-- "replace-this-server" token without letting a normal enroll silently
-- overwrite an existing row.
ALTER TABLE agent_enroll_tokens ADD COLUMN target_server_id TEXT;
ALTER TABLE agent_enroll_tokens ADD COLUMN enroll_mode TEXT NOT NULL DEFAULT 'new';
