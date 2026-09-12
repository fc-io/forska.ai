DROP TABLE IF EXISTS app.request_attempt_closeout_noindex_repair_0232;

CREATE TABLE app.request_attempt_closeout_noindex_repair_0232 (
  token_use_id VARCHAR NOT NULL,
  token_use_created_at TIMESTAMPTZ NOT NULL,
  request_attempt_id VARCHAR NOT NULL,
  provider_key VARCHAR NOT NULL,
  closeout_kind VARCHAR NOT NULL,
  durable_closeout_kind VARCHAR NOT NULL,
  durable_closeout_id VARCHAR,
  durable_closeout_ref_json JSON NOT NULL,
  closed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  CHECK (length(trim(token_use_id)) > 0),
  CHECK (length(trim(request_attempt_id)) > 0),
  CHECK (length(trim(provider_key)) > 0),
  CHECK (length(trim(closeout_kind)) > 0),
  CHECK (length(trim(durable_closeout_kind)) > 0)
);

INSERT INTO app.request_attempt_closeout_noindex_repair_0232 (
  token_use_id,
  token_use_created_at,
  request_attempt_id,
  provider_key,
  closeout_kind,
  durable_closeout_kind,
  durable_closeout_id,
  durable_closeout_ref_json,
  closed_at,
  created_at,
  updated_at
)
SELECT
  token_use_id,
  token_use_created_at,
  request_attempt_id,
  provider_key,
  closeout_kind,
  durable_closeout_kind,
  durable_closeout_id,
  durable_closeout_ref_json,
  closed_at,
  created_at,
  updated_at
FROM (
  SELECT
    *,
    ROW_NUMBER() OVER (
      PARTITION BY request_attempt_id, provider_key
      ORDER BY
        closed_at ASC,
        token_use_created_at ASC,
        token_use_id ASC,
        updated_at DESC NULLS LAST,
        created_at DESC NULLS LAST
    ) AS repair_row_number
  FROM app.request_attempt_closeout
)
WHERE repair_row_number = 1;

DROP INDEX IF EXISTS app.idx_app_request_attempt_closeout_token_use_id;
DROP INDEX IF EXISTS idx_app_request_attempt_closeout_token_use_id;
DROP INDEX IF EXISTS app.idx_app_request_attempt_closeout_provider_attempt;
DROP INDEX IF EXISTS idx_app_request_attempt_closeout_provider_attempt;

DROP TABLE app.request_attempt_closeout;

ALTER TABLE app.request_attempt_closeout_noindex_repair_0232
RENAME TO request_attempt_closeout;
