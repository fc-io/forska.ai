CREATE TEMP TABLE drop_token_use_fk_backup AS
SELECT * FROM app.token_use;

DROP TABLE app.token_use;

CREATE TABLE app.token_use (
  id VARCHAR PRIMARY KEY,
  judgment_job_id VARCHAR,
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
SELECT * FROM drop_token_use_fk_backup;

DROP TABLE drop_token_use_fk_backup;
