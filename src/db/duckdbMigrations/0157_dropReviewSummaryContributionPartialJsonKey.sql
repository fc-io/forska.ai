DROP TABLE IF EXISTS mart.review_article_summary_contribution_rebuild_partial_v4_key_repair;

CREATE TABLE mart.review_article_summary_contribution_rebuild_partial_v4_key_repair (
  request_id VARCHAR NOT NULL,
  chunk_id VARCHAR NOT NULL,
  project_id VARCHAR NOT NULL,
  review_config_hash VARCHAR NOT NULL,
  snapshot_id VARCHAR NOT NULL,
  article_id VARCHAR NOT NULL,
  component_kind VARCHAR NOT NULL,
  summary_definition_version VARCHAR NOT NULL,
  summary_kind VARCHAR NOT NULL,
  summary_identity VARCHAR NOT NULL,
  list_mode_key VARCHAR NOT NULL DEFAULT 'global',
  count_kind VARCHAR,
  filter_key VARCHAR,
  facet_kind VARCHAR,
  facet_key VARCHAR,
  facet_value VARCHAR,
  contribution_value BIGINT NOT NULL,
  contribution_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
);

INSERT INTO mart.review_article_summary_contribution_rebuild_partial_v4_key_repair
SELECT
  request_id,
  chunk_id,
  project_id,
  review_config_hash,
  snapshot_id,
  article_id,
  component_kind,
  summary_definition_version,
  json_extract_string(contribution_key, '$.summaryKind') AS summary_kind,
  json_extract_string(contribution_key, '$.summaryIdentity') AS summary_identity,
  COALESCE(json_extract_string(contribution_key, '$.listModeKey'), 'global') AS list_mode_key,
  json_extract_string(contribution_key, '$.countKind') AS count_kind,
  json_extract_string(contribution_key, '$.filterKey') AS filter_key,
  json_extract_string(contribution_key, '$.facetKind') AS facet_kind,
  json_extract_string(contribution_key, '$.facetKey') AS facet_key,
  json_extract_string(contribution_key, '$.facetValue') AS facet_value,
  SUM(contribution_value) AS contribution_value,
  MAX(contribution_updated_at) AS contribution_updated_at
FROM mart.review_article_summary_contribution_rebuild_partial_v4
WHERE json_extract_string(contribution_key, '$.summaryKind') IS NOT NULL
  AND json_extract_string(contribution_key, '$.summaryIdentity') IS NOT NULL
GROUP BY
  request_id,
  chunk_id,
  project_id,
  review_config_hash,
  snapshot_id,
  article_id,
  component_kind,
  summary_definition_version,
  json_extract_string(contribution_key, '$.summaryKind'),
  json_extract_string(contribution_key, '$.summaryIdentity'),
  COALESCE(json_extract_string(contribution_key, '$.listModeKey'), 'global'),
  json_extract_string(contribution_key, '$.countKind'),
  json_extract_string(contribution_key, '$.filterKey'),
  json_extract_string(contribution_key, '$.facetKind'),
  json_extract_string(contribution_key, '$.facetKey'),
  json_extract_string(contribution_key, '$.facetValue');

DROP TABLE mart.review_article_summary_contribution_rebuild_partial_v4;

ALTER TABLE mart.review_article_summary_contribution_rebuild_partial_v4_key_repair RENAME TO review_article_summary_contribution_rebuild_partial_v4;

CREATE UNIQUE INDEX IF NOT EXISTS idx_review_article_summary_contribution_rebuild_partial_v4_unique
ON mart.review_article_summary_contribution_rebuild_partial_v4(
  request_id,
  chunk_id,
  project_id,
  review_config_hash,
  snapshot_id,
  article_id,
  component_kind,
  summary_definition_version,
  summary_kind,
  summary_identity,
  COALESCE(list_mode_key, 'global'),
  COALESCE(count_kind, ''),
  COALESCE(filter_key, ''),
  COALESCE(facet_kind, ''),
  COALESCE(facet_key, ''),
  COALESCE(facet_value, '')
);

CREATE INDEX IF NOT EXISTS idx_review_article_summary_contribution_rebuild_partial_v4_publish
ON mart.review_article_summary_contribution_rebuild_partial_v4(request_id, project_id, review_config_hash, snapshot_id);

DROP TABLE IF EXISTS mart.review_article_summary_contribution_rebuild_partial_v4_key_repair;
