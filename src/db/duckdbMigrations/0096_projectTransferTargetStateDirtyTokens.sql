CREATE TABLE IF NOT EXISTS app.project_transfer_target_state_dirty_token (
  surface VARCHAR PRIMARY KEY,
  dirty_token BIGINT NOT NULL DEFAULT 0,
  last_reason VARCHAR,
  last_advanced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  CHECK (length(trim(surface)) > 0),
  CHECK (dirty_token >= 0),
  CHECK (last_reason IS NULL OR length(trim(last_reason)) > 0)
);

CREATE TABLE IF NOT EXISTS app.project_transfer_target_state_unknown_token (
  id VARCHAR PRIMARY KEY,
  dirty_token BIGINT NOT NULL DEFAULT 0,
  last_reason VARCHAR,
  last_advanced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  CHECK (id = 'global'),
  CHECK (dirty_token >= 0),
  CHECK (last_reason IS NULL OR length(trim(last_reason)) > 0)
);

CREATE TABLE IF NOT EXISTS app.project_transfer_target_state_coverage (
  id VARCHAR PRIMARY KEY,
  coverage_code_version VARCHAR NOT NULL,
  covered_surfaces_json JSON NOT NULL,
  dependency_fingerprint_algorithm VARCHAR NOT NULL,
  dependency_fingerprint_code_version VARCHAR NOT NULL,
  initialized_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (id = 'current'),
  CHECK (length(trim(coverage_code_version)) > 0),
  CHECK (length(trim(dependency_fingerprint_algorithm)) > 0),
  CHECK (length(trim(dependency_fingerprint_code_version)) > 0)
);

INSERT INTO app.project_transfer_target_state_unknown_token (id)
VALUES ('global')
ON CONFLICT(id) DO NOTHING;
