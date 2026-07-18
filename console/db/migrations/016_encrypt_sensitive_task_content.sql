-- Migration 016: encrypt sensitive task content and redact historical audit
-- Refs: BUGFIXES-2026-07-18.md BUG-01
-- IMPLEMENTATION-PLAN.md §6 提交 2

-- New encrypted columns for future writes. AES-256-GCM ciphertext+tag base64;
-- iv base64. Plaintext-shaped legacy columns (payload_json/result_json,
-- configs.content) still exist for compatibility but sensitive rows write
-- redacted placeholders there.
ALTER TABLE agent_tasks ADD COLUMN encrypted_payload TEXT;
ALTER TABLE agent_tasks ADD COLUMN encrypted_payload_iv TEXT;

ALTER TABLE configs ADD COLUMN encrypted_content TEXT;
ALTER TABLE configs ADD COLUMN encrypted_content_iv TEXT;
ALTER TABLE configs ADD COLUMN content_sha256 TEXT;

-- Historical audit redaction. Idempotent (already-redacted rows skipped).
-- ponytail: use JSON key shape "api_key" (with quotes) instead of bare
-- `%api_key%`, so token-count/usage-stats fields aren't misjudged as secrets.
UPDATE audit_log
SET after_json = '{"redacted":true}'
WHERE after_json IS NOT NULL
  AND after_json != '{"redacted":true}'
  AND (
    after_json LIKE '%"api_key"%' OR after_json LIKE '%"apiKey"%' OR
    after_json LIKE '%OPENAI_API_KEY%' OR after_json LIKE '%ANTHROPIC_AUTH_TOKEN%' OR
    after_json LIKE '%GEMINI_API_KEY%' OR after_json LIKE '%"token"%' OR
    after_json LIKE '%"secret"%' OR after_json LIKE '%"password"%' OR
    after_json LIKE '%"authorization"%' OR after_json LIKE '%"credentials"%'
  );

UPDATE audit_log
SET before_json = '{"redacted":true}'
WHERE before_json IS NOT NULL
  AND before_json != '{"redacted":true}'
  AND (
    before_json LIKE '%"api_key"%' OR before_json LIKE '%"apiKey"%' OR
    before_json LIKE '%OPENAI_API_KEY%' OR before_json LIKE '%ANTHROPIC_AUTH_TOKEN%' OR
    before_json LIKE '%GEMINI_API_KEY%' OR before_json LIKE '%"token"%' OR
    before_json LIKE '%"secret"%' OR before_json LIKE '%"password"%' OR
    before_json LIKE '%"authorization"%' OR before_json LIKE '%"credentials"%'
  );
