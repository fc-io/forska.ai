-- Per-bucket partial ledger for review-serving summaries. A summary rebuild chunk
-- writes its article range's counts as one bucket; finalization publishes the SUM
-- of a snapshot's buckets, and article dirty work replaces the partials of the
-- buckets it touches and recounts only the affected serving keys. Bucket bounds
-- are kept here because completed summary chunk manifests are pruned (NULL means
-- unbounded). Snapshots
-- published before this table existed have no bucket rows and keep taking a
-- rebuild. No indexes: the hot review-serving tables run without them (0213/0228).

CREATE TABLE IF NOT EXISTS mart.review_article_summary_bucket_v4 (
  project_id VARCHAR NOT NULL,
  review_config_hash VARCHAR NOT NULL,
  snapshot_id VARCHAR NOT NULL,
  bucket_id VARCHAR NOT NULL,
  request_id VARCHAR NOT NULL,
  bucket_start_key VARCHAR,
  bucket_end_key VARCHAR,
  ledger_status VARCHAR NOT NULL,
  bucket_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  CHECK (ledger_status IN ('building', 'published'))
);

CREATE TABLE IF NOT EXISTS mart.review_article_summary_bucket_partial_v4 (
  project_id VARCHAR NOT NULL,
  review_config_hash VARCHAR NOT NULL,
  snapshot_id VARCHAR NOT NULL,
  bucket_id VARCHAR NOT NULL,
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
  availability VARCHAR NOT NULL,
  stale_reason VARCHAR,
  count_value BIGINT,
  partial_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
);
