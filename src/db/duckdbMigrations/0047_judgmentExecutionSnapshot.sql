CREATE TABLE IF NOT EXISTS app.judgment_execution_snapshot (
  id VARCHAR PRIMARY KEY,
  job_id VARCHAR NOT NULL,
  project_id VARCHAR NOT NULL,
  queue_record_id VARCHAR NOT NULL,
  claim_id VARCHAR NOT NULL,
  article_id VARCHAR NOT NULL,
  prompt_id VARCHAR NOT NULL,
  model_id VARCHAR NOT NULL,
  use_title BOOLEAN NOT NULL,
  use_abstract BOOLEAN NOT NULL,
  use_fulltext BOOLEAN NOT NULL,
  use_fulltext_no_images BOOLEAN NOT NULL,
  payload_hash VARCHAR NOT NULL,
  payload_json JSON NOT NULL,
  created_by VARCHAR,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  UNIQUE(job_id, queue_record_id, claim_id)
);

CREATE INDEX IF NOT EXISTS idx_app_judgment_execution_snapshot_claim
ON app.judgment_execution_snapshot(job_id, queue_record_id, claim_id);

CREATE INDEX IF NOT EXISTS idx_app_judgment_execution_snapshot_hash
ON app.judgment_execution_snapshot(id, payload_hash);
