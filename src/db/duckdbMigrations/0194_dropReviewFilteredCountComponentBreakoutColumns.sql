DROP INDEX IF EXISTS mart.idx_review_filtered_count_serving_v4_repaired_pk;
DROP INDEX IF EXISTS idx_review_filtered_count_serving_v4_repaired_pk;
DROP INDEX IF EXISTS mart.idx_review_filtered_count_serving_v4_lookup;
DROP INDEX IF EXISTS idx_review_filtered_count_serving_v4_lookup;
DROP TABLE IF EXISTS mart.review_filtered_count_serving_v4_repair;

CREATE TABLE mart.review_filtered_count_serving_v4_repair (
  project_id VARCHAR NOT NULL,
  review_config_hash VARCHAR NOT NULL,
  snapshot_id VARCHAR NOT NULL,
  list_mode_key VARCHAR NOT NULL,
  filter_signature VARCHAR NOT NULL,
  component_identity VARCHAR NOT NULL,
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

INSERT INTO mart.review_filtered_count_serving_v4_repair (
  project_id,
  review_config_hash,
  snapshot_id,
  list_mode_key,
  filter_signature,
  component_identity,
  count_value,
  count_updated_at
)
SELECT
  project_id,
  review_config_hash,
  snapshot_id,
  list_mode_key,
  filter_signature,
  component_identity,
  count_value,
  count_updated_at
FROM mart.review_filtered_count_serving_v4;

DROP TABLE mart.review_filtered_count_serving_v4;

ALTER TABLE mart.review_filtered_count_serving_v4_repair RENAME TO review_filtered_count_serving_v4;

CREATE UNIQUE INDEX IF NOT EXISTS idx_review_filtered_count_serving_v4_repaired_pk
ON mart.review_filtered_count_serving_v4(
  project_id,
  review_config_hash,
  snapshot_id,
  list_mode_key,
  filter_signature,
  component_identity
);
