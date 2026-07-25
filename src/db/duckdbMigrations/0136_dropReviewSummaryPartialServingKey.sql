DROP TABLE IF EXISTS mart.review_article_summary_rebuild_partial_v4_without_serving_key;

CREATE TABLE mart.review_article_summary_rebuild_partial_v4_without_serving_key (
  request_id VARCHAR NOT NULL,
  chunk_id VARCHAR NOT NULL,
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
  partial_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
);

INSERT INTO mart.review_article_summary_rebuild_partial_v4_without_serving_key (
  request_id,
  chunk_id,
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
  partial_updated_at
)
SELECT
  request_id,
  chunk_id,
  project_id,
  review_config_hash,
  snapshot_id,
  summary_kind,
  summary_identity,
  MAX(list_mode_key) AS list_mode_key,
  MAX(count_kind) AS count_kind,
  MAX(summary_definition_version) AS summary_definition_version,
  MAX(filter_key) AS filter_key,
  MAX(facet_kind) AS facet_kind,
  MAX(facet_key) AS facet_key,
  MAX(facet_value) AS facet_value,
  MAX(prompt_id) AS prompt_id,
  MAX(answer_id) AS answer_id,
  MAX(answer_value) AS answer_value,
  CASE
    WHEN COUNT(*) FILTER (WHERE availability != 'ready') > 0
      THEN MAX(CASE WHEN availability != 'ready' THEN availability ELSE NULL END)
    ELSE 'ready'
  END AS availability,
  MAX(stale_reason) AS stale_reason,
  CASE
    WHEN COUNT(*) FILTER (WHERE availability != 'ready') > 0 THEN NULL
    ELSE SUM(COALESCE(count_value, 0))
  END AS count_value,
  MAX(partial_updated_at) AS partial_updated_at
FROM mart.review_article_summary_rebuild_partial_v4
GROUP BY
  request_id,
  chunk_id,
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
  COALESCE(facet_value, '');

DROP TABLE mart.review_article_summary_rebuild_partial_v4;

ALTER TABLE mart.review_article_summary_rebuild_partial_v4_without_serving_key
RENAME TO review_article_summary_rebuild_partial_v4;

CREATE UNIQUE INDEX IF NOT EXISTS idx_review_article_summary_rebuild_partial_v4_unique
ON mart.review_article_summary_rebuild_partial_v4(
  request_id,
  chunk_id,
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

CREATE INDEX IF NOT EXISTS idx_review_article_summary_rebuild_partial_v4_reduce
ON mart.review_article_summary_rebuild_partial_v4(request_id, project_id, review_config_hash, snapshot_id, summary_kind);
