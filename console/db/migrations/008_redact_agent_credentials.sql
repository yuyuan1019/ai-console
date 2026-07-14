-- Redact plaintext credentials that older set_credential tasks stored before
-- payload materialization moved to dispatch time.
UPDATE agent_tasks
SET payload_json = json_object(
  'tool', json_extract(payload_json, '$.tool'),
  'provider_id', json_extract(payload_json, '$.provider_id'),
  'key_id', json_extract(payload_json, '$.key_id'),
  'redacted', 1
)
WHERE action = 'set_credential'
  AND payload_json LIKE '%credentials%';

UPDATE audit_log
SET after_json = json_object(
  'action', 'set_credential',
  'redacted', 1
)
WHERE action = 'agent_task.create'
  AND after_json LIKE '%set_credential%'
  AND after_json LIKE '%credentials%';
