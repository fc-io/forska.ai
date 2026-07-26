CREATE TABLE IF NOT EXISTS mart.review_article_summary_rebuild_accumulator_v4 (
  request_id VARCHAR NOT NULL,
  project_id VARCHAR NOT NULL,
  review_config_hash VARCHAR NOT NULL,
  snapshot_id VARCHAR NOT NULL,
  summary_kind VARCHAR NOT NULL,
  summary_identity VARCHAR NOT NULL,
  list_mode_key VARCHAR,
  count_kind VARCHAR,
  summary_definition_version VARCHAR NOT NULL,
  filter_key VARCHAR,
  facet_kind VARCHAR,
  facet_key VARCHAR,
  facet_value VARCHAR,
  prompt_id VARCHAR,
  answer_id INTEGER,
  answer_value VARCHAR,
  availability VARCHAR NOT NULL DEFAULT 'ready',
  stale_reason VARCHAR,
  count_value BIGINT,
  source_chunk_ids_key VARCHAR NOT NULL,
  accumulator_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
);

INSERT INTO mart.review_article_summary_rebuild_accumulator_v4 (
  request_id,
  project_id,
  review_config_hash,
  snapshot_id,
  summary_kind,
  summary_identity,
  list_mode_key,
  count_kind,
  summary_definition_version,
  filter_key,
  facet_kind,
  facet_key,
  facet_value,
  prompt_id,
  answer_id,
  answer_value,
  availability,
  stale_reason,
  count_value,
  source_chunk_ids_key,
  accumulator_updated_at
)
SELECT
  partial.request_id,
  partial.project_id,
  partial.review_config_hash,
  partial.snapshot_id,
  partial.summary_kind,
  partial.summary_identity,
  ANY_VALUE(partial.list_mode_key) AS list_mode_key,
  ANY_VALUE(partial.count_kind) AS count_kind,
  ANY_VALUE(partial.summary_definition_version) AS summary_definition_version,
  ANY_VALUE(partial.filter_key) AS filter_key,
  ANY_VALUE(partial.facet_kind) AS facet_kind,
  ANY_VALUE(partial.facet_key) AS facet_key,
  ANY_VALUE(partial.facet_value) AS facet_value,
  ANY_VALUE(partial.prompt_id) AS prompt_id,
  ANY_VALUE(partial.answer_id) AS answer_id,
  ANY_VALUE(partial.answer_value) AS answer_value,
  ANY_VALUE(partial.availability) AS availability,
  ANY_VALUE(partial.stale_reason) AS stale_reason,
  CASE WHEN ANY_VALUE(partial.availability) = 'ready' THEN SUM(COALESCE(partial.count_value, 0)) ELSE NULL END AS count_value,
  '\n' || string_agg(DISTINCT partial.chunk_id, '\n' ORDER BY partial.chunk_id) || '\n' AS source_chunk_ids_key,
  max(partial.partial_updated_at) AS accumulator_updated_at
FROM mart.review_article_summary_rebuild_partial_v4 partial
WHERE NOT EXISTS (
  SELECT 1
  FROM mart.review_article_summary_rebuild_accumulator_v4 existing
  WHERE existing.request_id = partial.request_id
    AND existing.project_id = partial.project_id
    AND existing.review_config_hash = partial.review_config_hash
    AND existing.snapshot_id = partial.snapshot_id
    AND existing.summary_kind = partial.summary_kind
    AND existing.summary_identity = partial.summary_identity
    AND COALESCE(existing.list_mode_key, 'global') = COALESCE(partial.list_mode_key, 'global')
    AND COALESCE(existing.count_kind, '') = COALESCE(partial.count_kind, '')
    AND COALESCE(existing.filter_key, '') = COALESCE(partial.filter_key, '')
    AND COALESCE(existing.facet_kind, '') = COALESCE(partial.facet_kind, '')
    AND COALESCE(existing.facet_key, '') = COALESCE(partial.facet_key, '')
    AND COALESCE(existing.facet_value, '') = COALESCE(partial.facet_value, '')
)
GROUP BY
  partial.request_id,
  partial.project_id,
  partial.review_config_hash,
  partial.snapshot_id,
  partial.summary_kind,
  partial.summary_identity,
  COALESCE(partial.list_mode_key, 'global'),
  COALESCE(partial.count_kind, ''),
  COALESCE(partial.filter_key, ''),
  COALESCE(partial.facet_kind, ''),
  COALESCE(partial.facet_key, ''),
  COALESCE(partial.facet_value, '');

CREATE UNIQUE INDEX IF NOT EXISTS idx_review_article_summary_rebuild_accumulator_v4_unique
ON mart.review_article_summary_rebuild_accumulator_v4(
  request_id,
  project_id,
  review_config_hash,
  snapshot_id,
  summary_kind,
  summary_identity,
  COALESCE(list_mode_key, 'global'),
  COALESCE(count_kind, ''),
  COALESCE(filter_key, ''),
  COALESCE(facet_kind, ''),
  COALESCE(facet_key, ''),
  COALESCE(facet_value, '')
);

CREATE INDEX IF NOT EXISTS idx_review_article_summary_rebuild_accumulator_v4_reduce
ON mart.review_article_summary_rebuild_accumulator_v4(request_id, project_id, review_config_hash, snapshot_id, summary_kind);

DROP INDEX IF EXISTS mart.idx_review_article_summary_rebuild_partial_v4_unique;
DROP INDEX IF EXISTS idx_review_article_summary_rebuild_partial_v4_unique;
DROP INDEX IF EXISTS mart.idx_review_article_summary_rebuild_partial_v4_reduce;
DROP INDEX IF EXISTS idx_review_article_summary_rebuild_partial_v4_reduce;
DROP TABLE IF EXISTS mart.review_article_summary_rebuild_partial_v4_without_serving_key;
DROP TABLE IF EXISTS mart.review_article_summary_rebuild_partial_v4;

DROP TABLE IF EXISTS app.review_rebuild_partial_cleanup_authorization_repair;
DROP TABLE IF EXISTS app.review_rebuild_partial_cleanup_authorization;
