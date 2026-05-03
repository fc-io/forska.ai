CREATE TABLE IF NOT EXISTS app.judgment_job_sqlite_outbox_import (
  job_id VARCHAR NOT NULL,
  outbox_seq BIGINT NOT NULL,
  queue_prompt_id VARCHAR NOT NULL,
  judgment_id VARCHAR,
  article_id VARCHAR,
  prompt_id VARCHAR,
  model_id VARCHAR,
  project_id VARCHAR,
  import_status VARCHAR NOT NULL,
  error_message VARCHAR,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY (job_id, outbox_seq),
  CHECK (import_status IN ('imported', 'discarded'))
);

CREATE INDEX IF NOT EXISTS idx_app_judgment_job_sqlite_outbox_import_job_status
ON app.judgment_job_sqlite_outbox_import(job_id, import_status, imported_at);
