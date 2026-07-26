DROP INDEX IF EXISTS mart.idx_review_article_count_serving_v4_lookup;
DROP INDEX IF EXISTS idx_review_article_count_serving_v4_lookup;
DROP INDEX IF EXISTS mart.idx_review_article_count_serving_v4_repaired_pk;
DROP INDEX IF EXISTS idx_review_article_count_serving_v4_repaired_pk;
DROP TABLE IF EXISTS mart.review_article_count_serving_v4_repair;

CREATE TABLE mart.review_article_count_serving_v4_repair (
  project_id VARCHAR NOT NULL,
  review_config_hash VARCHAR NOT NULL,
  snapshot_id VARCHAR NOT NULL,
  summary_identity VARCHAR NOT NULL,
  list_mode_key VARCHAR NOT NULL DEFAULT 'global',
  count_kind VARCHAR NOT NULL,
  summary_definition_version VARCHAR NOT NULL,
  filter_key VARCHAR NOT NULL,
  count_value BIGINT,
  availability VARCHAR NOT NULL DEFAULT 'ready',
  stale_reason VARCHAR
);

INSERT INTO mart.review_article_count_serving_v4_repair BY NAME
SELECT COLUMNS(column_name -> column_name != 'count_updated_at')
FROM mart.review_article_count_serving_v4;

DROP TABLE mart.review_article_count_serving_v4;

ALTER TABLE mart.review_article_count_serving_v4_repair RENAME TO review_article_count_serving_v4;

CREATE UNIQUE INDEX IF NOT EXISTS idx_review_article_count_serving_v4_repaired_pk
ON mart.review_article_count_serving_v4(project_id, review_config_hash, snapshot_id, list_mode_key, count_kind, summary_definition_version, filter_key);

CREATE INDEX IF NOT EXISTS idx_review_article_count_serving_v4_lookup
ON mart.review_article_count_serving_v4(project_id, review_config_hash, snapshot_id, list_mode_key, count_kind, filter_key);

DROP INDEX IF EXISTS mart.idx_review_filter_facet_serving_v4_lookup;
DROP INDEX IF EXISTS idx_review_filter_facet_serving_v4_lookup;
DROP INDEX IF EXISTS mart.idx_review_filter_facet_serving_v4_repaired_pk;
DROP INDEX IF EXISTS idx_review_filter_facet_serving_v4_repaired_pk;
DROP TABLE IF EXISTS mart.review_filter_facet_serving_v4_repair;

CREATE TABLE mart.review_filter_facet_serving_v4_repair (
  project_id VARCHAR NOT NULL,
  review_config_hash VARCHAR NOT NULL,
  snapshot_id VARCHAR NOT NULL,
  summary_identity VARCHAR NOT NULL,
  facet_kind VARCHAR NOT NULL,
  facet_key VARCHAR NOT NULL,
  facet_value VARCHAR NOT NULL,
  prompt_id VARCHAR,
  answer_id INTEGER,
  answer_value VARCHAR,
  summary_definition_version VARCHAR NOT NULL,
  count_value BIGINT,
  availability VARCHAR NOT NULL DEFAULT 'ready'
);

INSERT INTO mart.review_filter_facet_serving_v4_repair BY NAME
SELECT COLUMNS(column_name -> column_name != 'facet_updated_at')
FROM mart.review_filter_facet_serving_v4;

DROP TABLE mart.review_filter_facet_serving_v4;

ALTER TABLE mart.review_filter_facet_serving_v4_repair RENAME TO review_filter_facet_serving_v4;

CREATE UNIQUE INDEX IF NOT EXISTS idx_review_filter_facet_serving_v4_repaired_pk
ON mart.review_filter_facet_serving_v4(project_id, review_config_hash, snapshot_id, summary_identity, facet_kind, facet_key, facet_value, summary_definition_version);

CREATE INDEX IF NOT EXISTS idx_review_filter_facet_serving_v4_lookup
ON mart.review_filter_facet_serving_v4(project_id, review_config_hash, snapshot_id, summary_identity, facet_kind, facet_key, facet_value);

DROP INDEX IF EXISTS mart.idx_review_filter_option_serving_v4_lookup;
DROP INDEX IF EXISTS idx_review_filter_option_serving_v4_lookup;
DROP INDEX IF EXISTS mart.idx_review_filter_option_serving_v4_repaired_pk;
DROP INDEX IF EXISTS idx_review_filter_option_serving_v4_repaired_pk;
DROP TABLE IF EXISTS mart.review_filter_option_serving_v4_repair;

CREATE TABLE mart.review_filter_option_serving_v4_repair (
  project_id VARCHAR NOT NULL,
  review_config_hash VARCHAR NOT NULL,
  snapshot_id VARCHAR NOT NULL,
  search_identity VARCHAR NOT NULL DEFAULT 'none',
  filter_option_identity VARCHAR NOT NULL,
  option_value_key VARCHAR NOT NULL,
  filter_kind VARCHAR NOT NULL,
  facet_key VARCHAR NOT NULL,
  facet_value VARCHAR,
  prompt_id VARCHAR,
  answer_id INTEGER,
  numeric_min DOUBLE,
  numeric_max DOUBLE,
  count_value BIGINT
);

INSERT INTO mart.review_filter_option_serving_v4_repair BY NAME
SELECT COLUMNS(column_name -> column_name != 'option_updated_at')
FROM mart.review_filter_option_serving_v4;

DROP TABLE mart.review_filter_option_serving_v4;

ALTER TABLE mart.review_filter_option_serving_v4_repair RENAME TO review_filter_option_serving_v4;

CREATE UNIQUE INDEX IF NOT EXISTS idx_review_filter_option_serving_v4_repaired_pk
ON mart.review_filter_option_serving_v4(project_id, review_config_hash, snapshot_id, search_identity, filter_option_identity, filter_kind, facet_key, option_value_key);

DROP TABLE IF EXISTS mart.review_article_count_serving_v4_repair;
DROP TABLE IF EXISTS mart.review_filter_facet_serving_v4_repair;
DROP TABLE IF EXISTS mart.review_filter_option_serving_v4_repair;
