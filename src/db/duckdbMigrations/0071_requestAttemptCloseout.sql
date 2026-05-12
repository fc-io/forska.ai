CREATE TABLE IF NOT EXISTS app.request_attempt_closeout (
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
  PRIMARY KEY (request_attempt_id, provider_key),
  CHECK (length(trim(token_use_id)) > 0),
  CHECK (length(trim(request_attempt_id)) > 0),
  CHECK (length(trim(provider_key)) > 0),
  CHECK (length(trim(closeout_kind)) > 0),
  CHECK (length(trim(durable_closeout_kind)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_app_request_attempt_closeout_token_use_id
ON app.request_attempt_closeout(token_use_id);
