CREATE TEMP TABLE judgment_job_storage_health_judgment_job_backup AS
SELECT * FROM app.judgment_job;

CREATE TEMP TABLE judgment_job_storage_health_token_use_backup AS
SELECT * FROM app.token_use;

DROP TABLE app.token_use;
DROP TABLE app.judgment_job;

CREATE TABLE app.judgment_job (
  id VARCHAR PRIMARY KEY,
  project_id VARCHAR NOT NULL REFERENCES app.project(id),
  status VARCHAR NOT NULL,
  error JSON,
  storage_state VARCHAR NOT NULL DEFAULT 'active',
  quarantined_at TIMESTAMPTZ,
  quarantine_reason VARCHAR,
  last_import_started_at TIMESTAMPTZ,
  last_import_completed_at TIMESTAMPTZ,
  last_import_error_at TIMESTAMPTZ,
  last_import_error VARCHAR,
  last_import_exit_code INTEGER,
  import_failure_count INTEGER NOT NULL DEFAULT 0,
  pause_requested_at TIMESTAMPTZ,
  send_to_llm_batch_size INTEGER NOT NULL DEFAULT 5,
  send_to_llm_interval INTEGER NOT NULL DEFAULT 15,
  cursor_last_created_at TIMESTAMPTZ,
  cursor_last_article_id VARCHAR,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
);

INSERT INTO app.judgment_job (
  id,
  project_id,
  status,
  error,
  storage_state,
  quarantined_at,
  quarantine_reason,
  last_import_started_at,
  last_import_completed_at,
  last_import_error_at,
  last_import_error,
  last_import_exit_code,
  import_failure_count,
  pause_requested_at,
  send_to_llm_batch_size,
  send_to_llm_interval,
  cursor_last_created_at,
  cursor_last_article_id,
  created_at,
  updated_at
)
SELECT
  id,
  project_id,
  status,
  error,
  'active' AS storage_state,
  NULL AS quarantined_at,
  NULL AS quarantine_reason,
  NULL AS last_import_started_at,
  NULL AS last_import_completed_at,
  NULL AS last_import_error_at,
  NULL AS last_import_error,
  NULL AS last_import_exit_code,
  0 AS import_failure_count,
  NULL AS pause_requested_at,
  send_to_llm_batch_size,
  send_to_llm_interval,
  cursor_last_created_at,
  cursor_last_article_id,
  created_at,
  updated_at
FROM judgment_job_storage_health_judgment_job_backup;

CREATE TABLE app.token_use (
  id VARCHAR PRIMARY KEY,
  judgment_job_id VARCHAR REFERENCES app.judgment_job(id),
  requests INTEGER NOT NULL,
  total_prompt_tokens BIGINT NOT NULL,
  total_completion_tokens BIGINT NOT NULL,
  total_tokens BIGINT NOT NULL,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  duration BIGINT,
  gpu_nnodes INTEGER,
  gpu_gpus_per_node INTEGER,
  gpu_total_gpus INTEGER,
  tp_size INTEGER,
  dp_size INTEGER,
  gpu_shape VARCHAR,
  sglang_max_running_requests INTEGER,
  sglang_model VARCHAR,
  successful_requests INTEGER,
  failed_requests INTEGER,
  has_failed_requests BOOLEAN,
  failed_requests_details JSON,
  total_success_prompt_tokens BIGINT,
  total_success_completion_tokens BIGINT,
  total_success_tokens BIGINT,
  total_failed_prompt_tokens BIGINT,
  total_failed_completion_tokens BIGINT,
  total_failed_tokens BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
);

INSERT INTO app.token_use
SELECT * FROM judgment_job_storage_health_token_use_backup;
