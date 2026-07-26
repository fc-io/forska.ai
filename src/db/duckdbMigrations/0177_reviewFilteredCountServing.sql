CREATE TABLE IF NOT EXISTS mart.review_filtered_count_serving_v4 (
  project_id VARCHAR NOT NULL,
  review_config_hash VARCHAR NOT NULL,
  snapshot_id VARCHAR NOT NULL,
  list_mode_key VARCHAR NOT NULL,
  filter_signature VARCHAR NOT NULL,
  component_identity VARCHAR NOT NULL,
  project_scope_identity VARCHAR NOT NULL DEFAULT '',
  search_identity VARCHAR NOT NULL DEFAULT '',
  posting_identity VARCHAR NOT NULL DEFAULT '',
  queue_identity VARCHAR NOT NULL DEFAULT '',
  payload_identity VARCHAR NOT NULL DEFAULT '',
  count_value BIGINT NOT NULL,
  count_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  CHECK (length(trim(project_id)) > 0),
  CHECK (length(trim(review_config_hash)) > 0),
  CHECK (length(trim(snapshot_id)) > 0),
  CHECK (length(trim(list_mode_key)) > 0),
  CHECK (length(trim(filter_signature)) > 0),
  CHECK (length(trim(component_identity)) > 0),
  CHECK (count_value >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_review_filtered_count_serving_v4_repaired_pk
ON mart.review_filtered_count_serving_v4(
  project_id,
  review_config_hash,
  snapshot_id,
  list_mode_key,
  filter_signature,
  component_identity
);

CREATE INDEX IF NOT EXISTS idx_review_filtered_count_serving_v4_lookup
ON mart.review_filtered_count_serving_v4(
  project_id,
  review_config_hash,
  snapshot_id,
  list_mode_key,
  filter_signature
);
