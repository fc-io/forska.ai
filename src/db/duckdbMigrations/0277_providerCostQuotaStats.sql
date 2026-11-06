/*
  Provider cost and quota observability.

  app.token_use gains the provider-reported token breakdown and the call identity. All seven columns are
  nullable with no default: NULL means the provider did not report the value (or the row predates this
  migration), never zero. cache_creation_input_tokens and cache_read_input_tokens are parts of
  total_prompt_tokens and thinking_tokens is part of total_completion_tokens. No secondary index is added:
  DuckDB does not use ART indexes for range scans, and the hourly cost query reads these narrow columns by
  zone map over finished_at.

  app.provider_token_weight holds list-price ratios relative to the same model's uncached input price, so a
  cost-weighted token is an input-token equivalent of that model and comparable within one model only.
  Matching rule for a token_use row (provider_kind, model_name) in the hour H:
    1. only rows with the same provider_kind and effective_from at or before H are candidates
    2. an exact model_name = model_name_pattern match wins over a LIKE match
    3. among LIKE matches the longest pattern wins
    4. among equal candidates the latest effective_from wins
  A row with no candidate gets cost NULL, never a guessed number.

  Seeds, verified 2026-11-06 against the published list prices:
    claude-opus-5-5   input 4, 5m cache write 5, cache read 0.20, output 20 USD per MTok
    other claude-opus  cache write 1.25x, cache read 0.1x, output 5x input
    gpt-6-astra       input 10, cache write 12.5, cached input 1, output 50 USD per MTok
  Thinking and reasoning tokens are billed as output tokens.

  app.provider_quota_reading stores one row per limit kind per subscription quota poll. It has no index:
  readings are appended in observed_at order, so zone maps prune time-window reads.
*/

ALTER TABLE app.token_use ADD COLUMN IF NOT EXISTS cache_creation_input_tokens BIGINT;
ALTER TABLE app.token_use ADD COLUMN IF NOT EXISTS cache_read_input_tokens BIGINT;
ALTER TABLE app.token_use ADD COLUMN IF NOT EXISTS thinking_tokens BIGINT;
ALTER TABLE app.token_use ADD COLUMN IF NOT EXISTS model_id VARCHAR;
ALTER TABLE app.token_use ADD COLUMN IF NOT EXISTS provider_kind VARCHAR;
ALTER TABLE app.token_use ADD COLUMN IF NOT EXISTS provider_connection_id VARCHAR;
ALTER TABLE app.token_use ADD COLUMN IF NOT EXISTS model_name VARCHAR;

CREATE TABLE IF NOT EXISTS app.provider_token_weight (
  provider_kind VARCHAR NOT NULL,
  model_name_pattern VARCHAR NOT NULL,
  input_weight DOUBLE NOT NULL,
  cache_creation_weight DOUBLE NOT NULL,
  cache_read_weight DOUBLE NOT NULL,
  output_weight DOUBLE NOT NULL,
  thinking_weight DOUBLE NOT NULL,
  effective_from TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY (provider_kind, model_name_pattern, effective_from),
  CHECK (length(trim(provider_kind)) > 0),
  CHECK (length(trim(model_name_pattern)) > 0),
  CHECK (input_weight >= 0),
  CHECK (cache_creation_weight >= 0),
  CHECK (cache_read_weight >= 0),
  CHECK (output_weight >= 0),
  CHECK (thinking_weight >= 0)
);

INSERT INTO app.provider_token_weight (
  provider_kind,
  model_name_pattern,
  input_weight,
  cache_creation_weight,
  cache_read_weight,
  output_weight,
  thinking_weight,
  effective_from
)
VALUES
  ('claude-code', 'claude-opus-5-5', 1, 1.25, 0.05, 5, 5, TIMESTAMPTZ '2026-01-01 00:00:00+00'),
  ('anthropic', 'claude-opus-5-5', 1, 1.25, 0.05, 5, 5, TIMESTAMPTZ '2026-01-01 00:00:00+00'),
  ('claude-code', 'claude-opus-%', 1, 1.25, 0.1, 5, 5, TIMESTAMPTZ '2026-01-01 00:00:00+00'),
  ('anthropic', 'claude-opus-%', 1, 1.25, 0.1, 5, 5, TIMESTAMPTZ '2026-01-01 00:00:00+00'),
  ('codex', 'gpt-6-astra', 1, 1.25, 0.1, 5, 5, TIMESTAMPTZ '2026-01-01 00:00:00+00'),
  ('openai', 'gpt-6-astra', 1, 1.25, 0.1, 5, 5, TIMESTAMPTZ '2026-01-01 00:00:00+00')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS app.provider_quota_reading (
  provider_connection_id VARCHAR NOT NULL,
  provider_kind VARCHAR NOT NULL,
  limit_kind VARCHAR NOT NULL,
  utilization_percent DOUBLE NOT NULL,
  resets_at TIMESTAMPTZ,
  is_active BOOLEAN,
  scope_json JSON,
  raw_json JSON NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
);
