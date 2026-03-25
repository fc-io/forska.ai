UPDATE app.model
SET provider_connection_id = COALESCE(provider_connection_id, id)
WHERE provider_connection_id IS NULL;

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
  COALESCE(m.provider_connection_id, m.id),
  COALESCE(NULLIF(LOWER(TRIM(m.provider)), ''), 'unknown'),
  COALESCE(NULLIF(TRIM(COALESCE(m.display_name, m.name)), ''), COALESCE(NULLIF(TRIM(COALESCE(m.remote_model_id, m.model_name)), ''), COALESCE(m.provider_connection_id, m.id))),
  TRUE,
  CASE
    WHEN COALESCE(NULLIF(LOWER(TRIM(m.provider)), ''), 'unknown') = 'codex' THEN 'codex-cli'
    WHEN NULLIF(TRIM(m.api_key_variable), '') IS NOT NULL THEN 'api-key'
    WHEN NULLIF(TRIM(m.base_url), '') IS NOT NULL THEN 'none'
    ELSE NULL
  END,
  m.base_url,
  CASE
    WHEN m.worker_urls IS NULL OR ARRAY_LENGTH(m.worker_urls) = 0 THEN NULL
    ELSE json_object('manualWorkerUrls', m.worker_urls, 'workerUrlMode', 'manual')
  END,
  CASE
    WHEN NULLIF(TRIM(m.api_key_variable), '') IS NOT NULL THEN 'env:' || TRIM(m.api_key_variable)
    ELSE NULL
  END
FROM app.model m
LEFT JOIN app.provider_connection pc ON pc.id = COALESCE(m.provider_connection_id, m.id)
WHERE pc.id IS NULL;

CREATE TABLE app.provider_connection_fk_validation (
  id VARCHAR PRIMARY KEY,
  provider_connection_id VARCHAR NOT NULL REFERENCES app.provider_connection(id)
);

INSERT INTO app.provider_connection_fk_validation (id, provider_connection_id)
SELECT id, provider_connection_id
FROM app.model;

DROP TABLE app.provider_connection_fk_validation;
