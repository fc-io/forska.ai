CREATE TABLE IF NOT EXISTS app.rebuild2_cutover_fence (
  id VARCHAR PRIMARY KEY,
  owner_token VARCHAR NOT NULL,
  status VARCHAR NOT NULL,
  phase VARCHAR NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  completed_at TIMESTAMPTZ,
  lease_expires_at TIMESTAMPTZ NOT NULL,
  last_error VARCHAR,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  CHECK (id = 'rebuild2'),
  CHECK (status IN ('running', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_app_rebuild2_cutover_fence_status
ON app.rebuild2_cutover_fence(status, lease_expires_at);
