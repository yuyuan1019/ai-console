-- Migration 017: batch rollback progress
-- Refs: BUGFIXES-2026-07-18.md BUG-04
-- IMPLEMENTATION-PLAN.md §6 提交 2 / 提交 9

-- ponytail: keep progress_json as the immutable record of the original write
-- pass; store restore-task progress separately so rollback never overwrites
-- the history needed to decide which servers actually got written.
ALTER TABLE batch_jobs ADD COLUMN rollback_progress_json TEXT;
ALTER TABLE batch_jobs ADD COLUMN rollback_started_at INTEGER;
