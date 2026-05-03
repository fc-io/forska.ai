CREATE TABLE IF NOT EXISTS app.provider_admission_lease (
  provider_key VARCHAR NOT NULL,
  lease_kind VARCHAR NOT NULL,
  lease_identity VARCHAR PRIMARY KEY,
  request_attempt_id VARCHAR,
  endpoint_availability_key VARCHAR,
  probe_attempt_id VARCHAR,
  holder_token VARCHAR NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL,
  heartbeat_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  CHECK (length(trim(provider_key)) > 0),
  CHECK (lease_kind IN ('request', 'probe')),
  CHECK (length(trim(lease_identity)) > 0),
  CHECK (length(trim(holder_token)) > 0),
  CHECK (acquired_at <= heartbeat_at),
  CHECK (heartbeat_at < expires_at),
  CHECK (
    (
      lease_kind = 'request'
      AND request_attempt_id IS NOT NULL
      AND length(trim(request_attempt_id)) > 0
      AND endpoint_availability_key IS NULL
      AND probe_attempt_id IS NULL
      AND lease_identity = 'request:' || request_attempt_id
    )
    OR (
      lease_kind = 'probe'
      AND request_attempt_id IS NULL
      AND endpoint_availability_key IS NOT NULL
      AND length(trim(endpoint_availability_key)) > 0
      AND probe_attempt_id IS NOT NULL
      AND length(trim(probe_attempt_id)) > 0
      AND lease_identity = 'probe:' || endpoint_availability_key || ':' || probe_attempt_id
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_app_provider_admission_lease_expiry
ON app.provider_admission_lease(provider_key, expires_at);
