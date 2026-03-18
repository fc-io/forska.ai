CREATE SCHEMA IF NOT EXISTS app;
CREATE SCHEMA IF NOT EXISTS mart;

CREATE TABLE IF NOT EXISTS app.user_config (
  id VARCHAR PRIMARY KEY,
  name VARCHAR NOT NULL,
  email VARCHAR NOT NULL,
  role VARCHAR,
  openalex_mailto VARCHAR,
  unpaywall_email VARCHAR,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
);

CREATE TABLE IF NOT EXISTS app.model (
  id VARCHAR PRIMARY KEY,
  name VARCHAR NOT NULL,
  provider VARCHAR,
  base_url VARCHAR,
  model_name VARCHAR,
  version VARCHAR,
  api_key_variable VARCHAR,
  worker_urls VARCHAR[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
);

CREATE TABLE IF NOT EXISTS app.data_source (
  id VARCHAR PRIMARY KEY,
  title VARCHAR NOT NULL,
  description VARCHAR,
  import_route VARCHAR,
  cursor VARCHAR,
  last_import_at TIMESTAMPTZ,
  items_after_last_import BIGINT,
  date_from TIMESTAMPTZ,
  date_to TIMESTAMPTZ,
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
);

CREATE TABLE IF NOT EXISTS app.import_route (
  id VARCHAR PRIMARY KEY,
  route VARCHAR NOT NULL,
  name VARCHAR,
  description VARCHAR,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  UNIQUE(route)
);

CREATE TABLE IF NOT EXISTS app.data_source_import_route (
  id VARCHAR PRIMARY KEY,
  data_source_id VARCHAR NOT NULL REFERENCES app.data_source(id),
  import_route_id VARCHAR NOT NULL REFERENCES app.import_route(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  UNIQUE(data_source_id, import_route_id)
);

CREATE TABLE IF NOT EXISTS app.prompt (
  id VARCHAR PRIMARY KEY,
  original_text VARCHAR NOT NULL,
  transformed_text VARCHAR,
  prompt_heading VARCHAR,
  type VARCHAR,
  content_hash VARCHAR,
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  UNIQUE(content_hash)
);

CREATE TABLE IF NOT EXISTS app.project (
  id VARCHAR PRIMARY KEY,
  name VARCHAR NOT NULL,
  description VARCHAR,
  engine VARCHAR,
  model_id VARCHAR NOT NULL REFERENCES app.model(id),
  use_title BOOLEAN NOT NULL DEFAULT TRUE,
  use_abstract BOOLEAN NOT NULL DEFAULT TRUE,
  use_fulltext BOOLEAN NOT NULL DEFAULT FALSE,
  use_fulltext_no_images BOOLEAN NOT NULL DEFAULT FALSE,
  date_from TIMESTAMPTZ,
  date_to TIMESTAMPTZ,
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
);

CREATE TABLE IF NOT EXISTS app.project_prompt (
  id VARCHAR PRIMARY KEY,
  project_id VARCHAR NOT NULL REFERENCES app.project(id),
  prompt_id VARCHAR NOT NULL REFERENCES app.prompt(id),
  prompt_order INTEGER,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  origin_project_id VARCHAR REFERENCES app.project(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  UNIQUE(project_id, prompt_id)
);

CREATE TABLE IF NOT EXISTS app.project_import_route (
  id VARCHAR PRIMARY KEY,
  project_id VARCHAR NOT NULL REFERENCES app.project(id),
  import_route_id VARCHAR NOT NULL REFERENCES app.import_route(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  UNIQUE(project_id, import_route_id)
);

CREATE TABLE IF NOT EXISTS app.article (
  id VARCHAR PRIMARY KEY,
  article_id VARCHAR,
  article_title VARCHAR NOT NULL,
  article_summary VARCHAR,
  article_authors VARCHAR[],
  article_version INTEGER,
  article_created_at TIMESTAMPTZ,
  article_updated_at TIMESTAMPTZ,
  arxiv_id VARCHAR,
  openalex_id VARCHAR,
  biorxiv_id VARCHAR,
  medrxiv_id VARCHAR,
  doi VARCHAR,
  pubmed_id VARCHAR,
  url VARCHAR,
  full_text VARCHAR,
  full_text_html VARCHAR,
  full_text_pdf VARCHAR,
  full_text_source VARCHAR,
  full_text_original_format VARCHAR,
  full_text_fetched_at TIMESTAMPTZ,
  full_text_assets JSON,
  full_text_conversion_status VARCHAR,
  full_text_conversion_error VARCHAR,
  full_text_conversion_attempts INTEGER,
  full_text_char_count BIGINT,
  content_hash VARCHAR,
  import_route VARCHAR,
  original_data JSON,
  publication_status VARCHAR,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  UNIQUE(article_id)
);

CREATE TABLE IF NOT EXISTS app.article_import_route (
  id VARCHAR PRIMARY KEY,
  article_id VARCHAR NOT NULL REFERENCES app.article(id),
  import_route_id VARCHAR NOT NULL REFERENCES app.import_route(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  UNIQUE(article_id, import_route_id)
);

CREATE TABLE IF NOT EXISTS app.project_article (
  id VARCHAR PRIMARY KEY,
  project_id VARCHAR NOT NULL REFERENCES app.project(id),
  article_id VARCHAR NOT NULL REFERENCES app.article(id),
  imported_from_project_id VARCHAR REFERENCES app.project(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  UNIQUE(project_id, article_id)
);

CREATE TABLE IF NOT EXISTS app.comparison_project (
  id VARCHAR PRIMARY KEY,
  name VARCHAR NOT NULL,
  description VARCHAR,
  model_ids VARCHAR[],
  compare_with_humans BOOLEAN NOT NULL DEFAULT FALSE,
  use_title BOOLEAN NOT NULL DEFAULT TRUE,
  use_abstract BOOLEAN NOT NULL DEFAULT TRUE,
  use_fulltext BOOLEAN NOT NULL DEFAULT FALSE,
  use_fulltext_no_images BOOLEAN NOT NULL DEFAULT FALSE,
  date_from TIMESTAMPTZ,
  date_to TIMESTAMPTZ,
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
);

CREATE TABLE IF NOT EXISTS app.comparison_project_prompt (
  id VARCHAR PRIMARY KEY,
  comparison_project_id VARCHAR NOT NULL REFERENCES app.comparison_project(id),
  prompt_id VARCHAR NOT NULL REFERENCES app.prompt(id),
  prompt_order INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  UNIQUE(comparison_project_id, prompt_id)
);

CREATE TABLE IF NOT EXISTS app.comparison_project_import_route (
  id VARCHAR PRIMARY KEY,
  comparison_project_id VARCHAR NOT NULL REFERENCES app.comparison_project(id),
  import_route_id VARCHAR NOT NULL REFERENCES app.import_route(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  UNIQUE(comparison_project_id, import_route_id)
);

CREATE TABLE IF NOT EXISTS app.judgment_job (
  id VARCHAR PRIMARY KEY,
  project_id VARCHAR NOT NULL REFERENCES app.project(id),
  status VARCHAR NOT NULL,
  error JSON,
  send_to_llm_batch_size INTEGER NOT NULL DEFAULT 5,
  send_to_llm_interval INTEGER NOT NULL DEFAULT 15,
  cursor_last_created_at TIMESTAMPTZ,
  cursor_last_article_id VARCHAR,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
);

CREATE TABLE IF NOT EXISTS app.judgment_job_prompt (
  id VARCHAR PRIMARY KEY,
  job_id VARCHAR NOT NULL REFERENCES app.judgment_job(id),
  article_id VARCHAR NOT NULL REFERENCES app.article(id),
  prompt_id VARCHAR NOT NULL REFERENCES app.prompt(id),
  server_id VARCHAR,
  sent_at TIMESTAMPTZ,
  judged_at TIMESTAMPTZ,
  status VARCHAR NOT NULL DEFAULT 'ready',
  skip_reason VARCHAR,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  UNIQUE(article_id, prompt_id, job_id)
);

CREATE TABLE IF NOT EXISTS app.judgment (
  id VARCHAR PRIMARY KEY,
  article_id VARCHAR NOT NULL REFERENCES app.article(id),
  prompt_id VARCHAR NOT NULL REFERENCES app.prompt(id),
  model_id VARCHAR NOT NULL REFERENCES app.model(id),
  project_id VARCHAR REFERENCES app.project(id),
  snapshot_project_id VARCHAR,
  snapshot_project_model_name VARCHAR,
  use_title BOOLEAN NOT NULL DEFAULT TRUE,
  use_abstract BOOLEAN NOT NULL DEFAULT TRUE,
  use_fulltext BOOLEAN NOT NULL DEFAULT FALSE,
  use_fulltext_no_images BOOLEAN NOT NULL DEFAULT FALSE,
  chunking_strategy VARCHAR,
  is_answered BOOLEAN NOT NULL DEFAULT FALSE,
  answered_original VARCHAR,
  answered_original_as_array VARCHAR[],
  confidence_original INTEGER NOT NULL DEFAULT 50,
  explanation VARCHAR,
  quotes JSON,
  delete_generation BIGINT NOT NULL DEFAULT 0,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  UNIQUE(article_id, prompt_id, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images, delete_generation)
);

CREATE TABLE IF NOT EXISTS app.judgment_human (
  id VARCHAR PRIMARY KEY,
  project_id VARCHAR NOT NULL REFERENCES app.project(id),
  article_id VARCHAR NOT NULL REFERENCES app.article(id),
  prompt_id VARCHAR NOT NULL REFERENCES app.prompt(id),
  is_answered BOOLEAN NOT NULL DEFAULT FALSE,
  answer VARCHAR,
  comment VARCHAR,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  UNIQUE(project_id, article_id, prompt_id)
);

CREATE TABLE IF NOT EXISTS app.review (
  id VARCHAR PRIMARY KEY,
  project_id VARCHAR NOT NULL REFERENCES app.project(id),
  article_id VARCHAR NOT NULL REFERENCES app.article(id),
  opened BOOLEAN NOT NULL DEFAULT FALSE,
  reviewed_title BOOLEAN NOT NULL DEFAULT FALSE,
  reviewed_title_comment VARCHAR,
  reviewed_abstract BOOLEAN NOT NULL DEFAULT FALSE,
  reviewed_abstract_comment VARCHAR,
  reviewed_intro BOOLEAN NOT NULL DEFAULT FALSE,
  reviewed_intro_comment VARCHAR,
  reviewed_method BOOLEAN NOT NULL DEFAULT FALSE,
  reviewed_method_comment VARCHAR,
  reviewed_results BOOLEAN NOT NULL DEFAULT FALSE,
  reviewed_results_comment VARCHAR,
  reviewed_discussion BOOLEAN NOT NULL DEFAULT FALSE,
  reviewed_discussion_comment VARCHAR,
  reviewed_conclusion BOOLEAN NOT NULL DEFAULT FALSE,
  reviewed_conclusion_comment VARCHAR,
  reviewed_appendix BOOLEAN NOT NULL DEFAULT FALSE,
  reviewed_appendix_comment VARCHAR,
  reviewed_other BOOLEAN NOT NULL DEFAULT FALSE,
  reviewed_other_comment VARCHAR,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  UNIQUE(project_id, article_id)
);

CREATE TABLE IF NOT EXISTS app.token_use (
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

CREATE TABLE IF NOT EXISTS app.judgment_assessment (
  id VARCHAR PRIMARY KEY,
  judgment_id VARCHAR NOT NULL REFERENCES app.judgment(id),
  assessment_is_correct BOOLEAN NOT NULL,
  assessment_comment VARCHAR,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  UNIQUE(judgment_id)
);

CREATE TABLE IF NOT EXISTS app.llm_status (
  id VARCHAR PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  engine VARCHAR NOT NULL,
  instance_id VARCHAR NOT NULL,
  model_name VARCHAR NOT NULL,
  engine_version VARCHAR,
  gpu_type VARCHAR,
  gpu_count INTEGER,
  poll_ms BIGINT NOT NULL DEFAULT 2000,
  prompt_tokens_total BIGINT NOT NULL DEFAULT 0,
  generation_tokens_total BIGINT NOT NULL DEFAULT 0,
  num_requests_total BIGINT,
  cached_tokens_total BIGINT,
  num_retractions_count BIGINT,
  num_queue_reqs BIGINT NOT NULL DEFAULT 0,
  num_running_reqs BIGINT NOT NULL DEFAULT 0,
  num_grammar_queue_reqs BIGINT,
  num_running_reqs_offline_batch BIGINT,
  num_prefill_prealloc_queue_reqs BIGINT,
  num_prefill_inflight_queue_reqs BIGINT,
  num_decode_prealloc_queue_reqs BIGINT,
  num_decode_transfer_queue_reqs BIGINT,
  gen_throughput DOUBLE,
  token_usage DOUBLE,
  utilization DOUBLE,
  cache_hit_rate DOUBLE,
  spec_accept_rate DOUBLE,
  spec_accept_length DOUBLE,
  is_cuda_graph BOOLEAN,
  swa_token_usage DOUBLE,
  mamba_usage DOUBLE,
  pending_prealloc_token_usage DOUBLE,
  kv_transfer_speed_gb_s DOUBLE,
  kv_transfer_latency_ms DOUBLE,
  kv_transfer_bootstrap_ms DOUBLE,
  kv_transfer_alloc_ms DOUBLE,
  prefill_tps DOUBLE,
  gen_tps DOUBLE,
  rps DOUBLE,
  target_gen_tps DOUBLE,
  target_prefill_tps DOUBLE,
  in_flight BIGINT,
  max_in_flight BIGINT,
  last_action VARCHAR,
  time_to_first_token_seconds JSON,
  e2e_request_latency_seconds JSON,
  inter_token_latency_seconds JSON,
  per_stage_req_latency_seconds JSON,
  queue_time_seconds JSON
);

CREATE TABLE IF NOT EXISTS app.nvidia_smi (
  id VARCHAR PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  instance_id VARCHAR NOT NULL,
  gpu_index INTEGER NOT NULL,
  gpu_uuid VARCHAR,
  gpu_name VARCHAR,
  temperature_gpu INTEGER,
  utilization_gpu INTEGER,
  utilization_memory INTEGER,
  memory_total_mib BIGINT,
  memory_used_mib BIGINT,
  power_draw_watts DOUBLE,
  power_limit_watts DOUBLE,
  fan_speed INTEGER,
  pstate VARCHAR
);

CREATE TABLE IF NOT EXISTS mart.project_scope_article (
  project_id VARCHAR NOT NULL,
  article_id VARCHAR NOT NULL,
  in_curated_scope BOOLEAN NOT NULL,
  in_route_scope BOOLEAN NOT NULL,
  matched_import_route_ids VARCHAR[],
  article_title VARCHAR NOT NULL,
  article_created_at TIMESTAMPTZ,
  article_updated_at TIMESTAMPTZ,
  article_import_route VARCHAR,
  article_publication_status VARCHAR,
  source_updated_at TIMESTAMPTZ,
  PRIMARY KEY(project_id, article_id)
);

CREATE TABLE IF NOT EXISTS mart.judgment_fact (
  judgment_id VARCHAR PRIMARY KEY,
  article_id VARCHAR NOT NULL,
  prompt_id VARCHAR NOT NULL,
  model_id VARCHAR NOT NULL,
  project_id VARCHAR,
  snapshot_project_id VARCHAR,
  snapshot_project_model_name VARCHAR,
  use_title BOOLEAN NOT NULL,
  use_abstract BOOLEAN NOT NULL,
  use_fulltext BOOLEAN NOT NULL,
  use_fulltext_no_images BOOLEAN NOT NULL,
  chunking_strategy VARCHAR,
  is_answered BOOLEAN NOT NULL,
  answered_original VARCHAR,
  answered_original_as_array VARCHAR[],
  normalized_answers VARCHAR[],
  confidence_original INTEGER,
  explanation VARCHAR,
  quotes JSON,
  article_title VARCHAR NOT NULL,
  article_created_at TIMESTAMPTZ,
  article_updated_at TIMESTAMPTZ,
  article_import_route VARCHAR,
  article_publication_status VARCHAR,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS mart.prompt_answer_fact (
  project_id VARCHAR NOT NULL,
  article_id VARCHAR NOT NULL,
  prompt_id VARCHAR NOT NULL,
  judgment_id VARCHAR NOT NULL,
  model_id VARCHAR NOT NULL,
  answer_value VARCHAR NOT NULL,
  answered_original VARCHAR,
  article_title VARCHAR NOT NULL,
  article_created_at TIMESTAMPTZ,
  article_updated_at TIMESTAMPTZ,
  judgment_created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(project_id, judgment_id, answer_value)
);

CREATE TABLE IF NOT EXISTS mart.review_article_rollup (
  project_id VARCHAR NOT NULL,
  article_id VARCHAR NOT NULL,
  article_title VARCHAR NOT NULL,
  article_created_at TIMESTAMPTZ,
  article_updated_at TIMESTAMPTZ,
  article_import_route VARCHAR,
  article_publication_status VARCHAR,
  matched_import_route_ids VARCHAR[],
  enabled_prompt_count INTEGER NOT NULL,
  llm_judged_prompt_count INTEGER NOT NULL,
  human_answered_prompt_count INTEGER NOT NULL,
  llm_judged_prompt_ids VARCHAR[],
  human_answered_prompt_ids VARCHAR[],
  has_all_llm_judgments BOOLEAN NOT NULL,
  has_all_human_answers BOOLEAN NOT NULL,
  in_curated_scope BOOLEAN NOT NULL,
  in_route_scope BOOLEAN NOT NULL,
  review_opened BOOLEAN NOT NULL,
  review_sections_completed INTEGER NOT NULL,
  latest_llm_created_at TIMESTAMPTZ,
  latest_human_updated_at TIMESTAMPTZ,
  latest_review_updated_at TIMESTAMPTZ,
  rollup_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(project_id, article_id)
);

CREATE INDEX IF NOT EXISTS idx_app_article_article_id ON app.article(article_id);
CREATE INDEX IF NOT EXISTS idx_app_project_prompt_project_id ON app.project_prompt(project_id, prompt_id);
CREATE INDEX IF NOT EXISTS idx_app_project_import_route_project_id ON app.project_import_route(project_id, import_route_id);
CREATE INDEX IF NOT EXISTS idx_app_article_import_route_import_route_id ON app.article_import_route(import_route_id, article_id);
CREATE INDEX IF NOT EXISTS idx_app_project_article_project_id ON app.project_article(project_id, article_id);
CREATE INDEX IF NOT EXISTS idx_app_judgment_lookup ON app.judgment(article_id, prompt_id, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images, delete_generation);
CREATE INDEX IF NOT EXISTS idx_app_judgment_human_lookup ON app.judgment_human(project_id, article_id, prompt_id);
CREATE INDEX IF NOT EXISTS idx_mart_project_scope_article_project_id ON mart.project_scope_article(project_id, article_created_at, article_id);
CREATE INDEX IF NOT EXISTS idx_mart_judgment_fact_lookup ON mart.judgment_fact(article_id, prompt_id, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images);
CREATE INDEX IF NOT EXISTS idx_mart_prompt_answer_fact_lookup ON mart.prompt_answer_fact(project_id, prompt_id, answer_value, article_id);
CREATE INDEX IF NOT EXISTS idx_mart_review_article_rollup_project_id ON mart.review_article_rollup(project_id, has_all_llm_judgments, article_created_at, article_id);
