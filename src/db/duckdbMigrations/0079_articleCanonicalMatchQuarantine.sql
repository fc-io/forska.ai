CREATE TABLE IF NOT EXISTS app.article_canonical_match_quarantine (
  id VARCHAR PRIMARY KEY,
  source_kind VARCHAR,
  import_run_id VARCHAR,
  source_record_key VARCHAR,
  source_record_hash VARCHAR,
  requested_article_id VARCHAR,
  winning_article_id VARCHAR,
  kind VARCHAR NOT NULL CHECK (kind IN ('doi', 'pmid', 'arxiv')),
  normalized_value VARCHAR NOT NULL,
  reason VARCHAR NOT NULL,
  metadata JSON,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
);

CREATE INDEX IF NOT EXISTS idx_app_article_canonical_match_quarantine_source
ON app.article_canonical_match_quarantine(source_kind, import_run_id, source_record_key, resolved_at);

CREATE INDEX IF NOT EXISTS idx_app_article_canonical_match_quarantine_identifier
ON app.article_canonical_match_quarantine(kind, normalized_value, resolved_at);
