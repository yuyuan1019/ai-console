-- 009 added default_model_id to providers, now move it to provider_keys (per-key)
ALTER TABLE providers DROP COLUMN default_model_id;
ALTER TABLE provider_keys ADD COLUMN default_model_id TEXT;
