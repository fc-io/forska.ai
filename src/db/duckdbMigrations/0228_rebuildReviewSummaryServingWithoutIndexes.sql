DROP TABLE IF EXISTS mart.review_article_count_serving_v4_noindex_repair_0228;

CREATE TABLE mart.review_article_count_serving_v4_noindex_repair_0228 (
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

INSERT INTO mart.review_article_count_serving_v4_noindex_repair_0228 BY NAME
SELECT * FROM mart.review_article_count_serving_v4;

DROP TABLE mart.review_article_count_serving_v4;

ALTER TABLE mart.review_article_count_serving_v4_noindex_repair_0228
RENAME TO review_article_count_serving_v4;

DROP TABLE IF EXISTS mart.review_filter_facet_serving_v4_noindex_repair_0228;

CREATE TABLE mart.review_filter_facet_serving_v4_noindex_repair_0228 (
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

INSERT INTO mart.review_filter_facet_serving_v4_noindex_repair_0228 BY NAME
SELECT * FROM mart.review_filter_facet_serving_v4;

DROP TABLE mart.review_filter_facet_serving_v4;

ALTER TABLE mart.review_filter_facet_serving_v4_noindex_repair_0228
RENAME TO review_filter_facet_serving_v4;
