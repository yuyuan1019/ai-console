-- Migration 019: agent protocol version 2 hard cutover
-- Refs: BUGFIXES-2026-07-18.md BUG-05
-- IMPLEMENTATION-PLAN.md §6 提交 2 / 提交 7

-- ponytail: this migration performs the 2.0 cutover for the servers table:
--   - servers.agent_instance_id becomes NOT NULL + UNIQUE (upgraded from 018's
--     nullable + partial index)
--   - servers.agent_protocol_version added as NOT NULL with a hard CHECK=2 and
--     NO default value. Enroll must explicitly write 2; the schema refuses to
--     let a stale writer or default sneak protocol 1 into the table.
--
-- SQLite cannot ALTER a table to add NOT NULL/CHECK on an existing populated
-- table. Deploy Step 3 clears the servers table; this migration additionally
-- guards that clearing has actually happened before the rebuild:
--   * a TEMP guard table with CHECK(row_count=0) fails the transaction if
--     servers is non-empty, aborting the migration cleanly instead of
--     silently rebuilding into a shape that hides protocol-1 rows.
--   * we drop-and-recreate servers rather than the 12-step SQLite ALTER dance
--     because the table is empty and no data must be preserved.
--
-- Post-migration, /agent/enroll must:
--   * write agent_instance_id explicitly (never null)
--   * write agent_protocol_version=2 explicitly (schema has no default)

CREATE TEMP TABLE migration_019_servers_empty_guard (
  row_count INTEGER NOT NULL CHECK (row_count = 0)
);
INSERT INTO migration_019_servers_empty_guard SELECT COUNT(*) FROM servers;
DROP TABLE migration_019_servers_empty_guard;

-- The partial UNIQUE index from 018 references servers.agent_instance_id; drop
-- explicitly so the follow-up UNIQUE constraint on the rebuilt table has no
-- ghost index.
DROP INDEX IF EXISTS idx_servers_agent_instance_id;

DROP TABLE servers;
CREATE TABLE servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  os TEXT,
  arch TEXT,
  host TEXT,
  agent_token_hash TEXT,
  status TEXT NOT NULL DEFAULT 'offline',
  last_seen INTEGER,
  tags TEXT NOT NULL DEFAULT '[]',
  group_id TEXT,
  agent_version TEXT,
  agent_instance_id TEXT NOT NULL UNIQUE,
  agent_protocol_version INTEGER NOT NULL CHECK (agent_protocol_version = 2),
  created_at INTEGER NOT NULL
);
