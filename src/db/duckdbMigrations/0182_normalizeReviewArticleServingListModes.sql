DROP TABLE IF EXISTS mart.review_article_serving_base_v4;
DROP TABLE IF EXISTS mart.review_article_serving_list_mode_state_v4;

CREATE TABLE mart.review_article_serving_base_v4 (
  project_id VARCHAR NOT NULL,
  review_config_hash VARCHAR NOT NULL,
  snapshot_id VARCHAR NOT NULL,
  base_generation BIGINT NOT NULL,
  patch_watermark BIGINT NOT NULL,
  article_id VARCHAR NOT NULL,
  article_created_at TIMESTAMPTZ,
  sort_key TIMESTAMPTZ NOT NULL,
  activity_sort_at TIMESTAMPTZ NOT NULL,
  CHECK (base_generation >= 0),
  CHECK (patch_watermark >= 0)
);

CREATE TABLE mart.review_article_serving_list_mode_state_v4 (
  project_id VARCHAR NOT NULL,
  review_config_hash VARCHAR NOT NULL,
  snapshot_id VARCHAR NOT NULL,
  article_id VARCHAR NOT NULL,
  list_mode_keys VARCHAR[] NOT NULL,
  llm_patch_watermark BIGINT,
  human_patch_watermark BIGINT,
  both_patch_watermark BIGINT,
  unassessed_patch_watermark BIGINT,
  duplicate_flag BOOLEAN NOT NULL DEFAULT FALSE,
  conflict_flag BOOLEAN NOT NULL DEFAULT FALSE,
  llm_status VARCHAR,
  human_status VARCHAR,
  llm_has_judgment BOOLEAN NOT NULL DEFAULT FALSE,
  CHECK (llm_patch_watermark IS NULL OR llm_patch_watermark >= 0),
  CHECK (human_patch_watermark IS NULL OR human_patch_watermark >= 0),
  CHECK (both_patch_watermark IS NULL OR both_patch_watermark >= 0),
  CHECK (unassessed_patch_watermark IS NULL OR unassessed_patch_watermark >= 0)
);

INSERT INTO mart.review_article_serving_base_v4
SELECT
  project_id,
  review_config_hash,
  snapshot_id,
  MIN(base_generation) AS base_generation,
  MAX(patch_watermark) AS patch_watermark,
  article_id,
  MIN(article_created_at) AS article_created_at,
  MIN(sort_key) AS sort_key,
  MIN(activity_sort_at) AS activity_sort_at
FROM mart.review_article_serving_v4
GROUP BY
  project_id,
  review_config_hash,
  snapshot_id,
  article_id;

INSERT INTO mart.review_article_serving_list_mode_state_v4
SELECT
  serving.project_id,
  serving.review_config_hash,
  serving.snapshot_id,
  serving.article_id,
  list_sort(list_distinct(list(serving.list_mode_key))) AS list_mode_keys,
  MAX(CASE WHEN serving.list_mode_key = 'llm' THEN serving.patch_watermark ELSE NULL END) AS llm_patch_watermark,
  MAX(CASE WHEN serving.list_mode_key = 'human' THEN serving.patch_watermark ELSE NULL END) AS human_patch_watermark,
  MAX(CASE WHEN serving.list_mode_key = 'both' THEN serving.patch_watermark ELSE NULL END) AS both_patch_watermark,
  MAX(CASE WHEN serving.list_mode_key = 'unassessed' THEN serving.patch_watermark ELSE NULL END) AS unassessed_patch_watermark,
  COALESCE(BOOL_OR(COALESCE(filter_state.duplicate_flag, FALSE)), FALSE) AS duplicate_flag,
  COALESCE(BOOL_OR(COALESCE(filter_state.conflict_flag, FALSE)), FALSE) AS conflict_flag,
  MAX(filter_state.llm_status) AS llm_status,
  MAX(filter_state.human_status) AS human_status,
  COALESCE(BOOL_OR(detail.payload_kind = 'llm' AND detail.is_answered IS TRUE AND detail.placeholder_kind IS NULL), FALSE) AS llm_has_judgment
FROM mart.review_article_serving_v4 serving
LEFT JOIN mart.review_article_filter_state_serving_v4 filter_state
  ON filter_state.project_id = serving.project_id
 AND filter_state.review_config_hash = serving.review_config_hash
 AND filter_state.snapshot_id = serving.snapshot_id
 AND filter_state.list_mode_key = serving.list_mode_key
 AND filter_state.article_id = serving.article_id
LEFT JOIN mart.review_article_judgment_detail_serving_v4 detail
  ON detail.project_id = serving.project_id
 AND detail.review_config_hash = serving.review_config_hash
 AND detail.snapshot_id = serving.snapshot_id
 AND detail.article_id = serving.article_id
 AND detail.payload_kind = 'llm'
GROUP BY
  serving.project_id,
  serving.review_config_hash,
  serving.snapshot_id,
  serving.article_id;

DROP INDEX IF EXISTS mart.idx_review_article_serving_v4_order;
DROP INDEX IF EXISTS idx_review_article_serving_v4_order;
DROP INDEX IF EXISTS mart.idx_review_article_serving_v4_repaired_pk;
DROP INDEX IF EXISTS idx_review_article_serving_v4_repaired_pk;
DROP TABLE mart.review_article_serving_v4;

CREATE UNIQUE INDEX IF NOT EXISTS idx_review_article_serving_base_v4_pk
ON mart.review_article_serving_base_v4(project_id, review_config_hash, snapshot_id, article_id);

CREATE INDEX IF NOT EXISTS idx_review_article_serving_base_v4_order
ON mart.review_article_serving_base_v4(project_id, review_config_hash, snapshot_id, sort_key, article_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_review_article_serving_list_mode_state_v4_pk
ON mart.review_article_serving_list_mode_state_v4(project_id, review_config_hash, snapshot_id, article_id);

CREATE VIEW mart.review_article_serving_v4 AS
SELECT
  base.project_id,
  base.review_config_hash,
  base.snapshot_id,
  base.base_generation,
  CASE list_mode.list_mode_key
    WHEN 'llm' THEN state.llm_patch_watermark
    WHEN 'human' THEN state.human_patch_watermark
    WHEN 'both' THEN state.both_patch_watermark
    WHEN 'unassessed' THEN state.unassessed_patch_watermark
    ELSE NULL
  END AS patch_watermark,
  list_mode.list_mode_key,
  base.article_id,
  base.article_created_at,
  base.sort_key,
  base.activity_sort_at,
  state.duplicate_flag,
  state.conflict_flag,
  state.llm_status,
  state.human_status
FROM mart.review_article_serving_base_v4 base
INNER JOIN mart.review_article_serving_list_mode_state_v4 state
  ON state.project_id = base.project_id
 AND state.review_config_hash = base.review_config_hash
 AND state.snapshot_id = base.snapshot_id
 AND state.article_id = base.article_id
CROSS JOIN unnest(state.list_mode_keys) AS list_mode(list_mode_key);

DROP INDEX IF EXISTS mart.idx_review_article_filter_state_serving_v4_lookup;
DROP INDEX IF EXISTS idx_review_article_filter_state_serving_v4_lookup;
DROP INDEX IF EXISTS mart.idx_review_article_filter_state_serving_v4_pk;
DROP INDEX IF EXISTS idx_review_article_filter_state_serving_v4_pk;
DROP TABLE IF EXISTS mart.review_article_filter_state_serving_v4;
