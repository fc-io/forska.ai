CREATE TABLE IF NOT EXISTS app.provider_connection (
  id VARCHAR PRIMARY KEY,
  provider_kind VARCHAR NOT NULL,
  label VARCHAR NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  auth_mode VARCHAR,
  base_url VARCHAR,
  config_json JSON,
  secret_ref VARCHAR,
  last_checked_at TIMESTAMPTZ,
  last_error VARCHAR,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
);

ALTER TABLE app.model ADD COLUMN IF NOT EXISTS provider_connection_id VARCHAR;
ALTER TABLE app.model ADD COLUMN IF NOT EXISTS remote_model_id VARCHAR;
ALTER TABLE app.model ADD COLUMN IF NOT EXISTS display_name VARCHAR;
ALTER TABLE app.model ADD COLUMN IF NOT EXISTS variant VARCHAR;
ALTER TABLE app.model ADD COLUMN IF NOT EXISTS source VARCHAR;
ALTER TABLE app.model ADD COLUMN IF NOT EXISTS enabled BOOLEAN;
ALTER TABLE app.model ADD COLUMN IF NOT EXISTS metadata_json JSON;

INSERT INTO app.provider_connection (
  id,
  provider_kind,
  label,
  enabled,
  auth_mode,
  base_url,
  config_json,
  secret_ref
)
SELECT
  m.id,
  COALESCE(NULLIF(LOWER(TRIM(m.provider)), ''), 'unknown'),
  COALESCE(NULLIF(TRIM(m.name), ''), COALESCE(NULLIF(TRIM(m.model_name), ''), m.id)),
  TRUE,
  CASE
    WHEN COALESCE(NULLIF(LOWER(TRIM(m.provider)), ''), 'unknown') = 'codex' THEN 'codex-cli'
    WHEN NULLIF(TRIM(m.api_key_variable), '') IS NOT NULL THEN 'env'
    WHEN NULLIF(TRIM(m.base_url), '') IS NOT NULL THEN 'none'
    ELSE NULL
  END,
  m.base_url,
  CASE
    WHEN m.worker_urls IS NULL THEN NULL
    ELSE json_object('workerUrls', m.worker_urls)
  END,
  CASE
    WHEN NULLIF(TRIM(m.api_key_variable), '') IS NOT NULL THEN 'env:' || TRIM(m.api_key_variable)
    ELSE NULL
  END
FROM app.model m
LEFT JOIN app.provider_connection pc ON pc.id = m.id
WHERE pc.id IS NULL;

UPDATE app.model
SET provider_connection_id = COALESCE(provider_connection_id, id),
    remote_model_id = COALESCE(remote_model_id, model_name),
    display_name = COALESCE(display_name, name),
    variant = COALESCE(variant, version),
    source = COALESCE(source, 'manual'),
    enabled = COALESCE(enabled, TRUE);
