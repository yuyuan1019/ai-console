-- 005: Add agent_version column to servers table
ALTER TABLE servers ADD COLUMN agent_version TEXT;
