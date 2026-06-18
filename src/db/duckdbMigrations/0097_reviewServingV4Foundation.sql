CREATE TABLE IF NOT EXISTS app.import_run_article_delta (
  delta_id VARCHAR PRIMARY KEY,
  change_kind VARCHAR NOT NULL,
  source_table VARCHAR NOT NULL,
  source_row_id VARCHAR NOT NULL,
  source_operation VARCHAR NOT NULL,
  source_partition VARCHAR NOT NULL,
  source_high_water_mark BIGINT NOT NULL,
  source_updated_at TIMESTAMPTZ,
  idempotency_key VARCHAR NOT NULL UNIQUE,
  payload_version INTEGER NOT NULL,
  import_run_id VARCHAR,
  import_route_id VARCHAR,
  article_id VARCHAR,
  source_record_key VARCHAR,
  source_record_hash VARCHAR,
  selected_rank_key VARCHAR,
  publication_year INTEGER,
  tombstone BOOLEAN NOT NULL DEFAULT FALSE,
  payload_json JSON,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  reconciled_at TIMESTAMPTZ,
  CHECK (length(trim(delta_id)) > 0),
  CHECK (length(trim(change_kind)) > 0),
  CHECK (length(trim(source_table)) > 0),
  CHECK (length(trim(source_row_id)) > 0),
  CHECK (length(trim(source_operation)) > 0),
  CHECK (length(trim(source_partition)) > 0),
  CHECK (source_high_water_mark >= 0),
  CHECK (length(trim(idempotency_key)) > 0),
  CHECK (payload_version >= 1)
);

CREATE TABLE IF NOT EXISTS app.review_change_delta (
  delta_id VARCHAR PRIMARY KEY,
  change_kind VARCHAR NOT NULL,
  source_table VARCHAR NOT NULL,
  source_row_id VARCHAR NOT NULL,
  source_operation VARCHAR NOT NULL,
  source_partition VARCHAR NOT NULL,
  source_high_water_mark BIGINT NOT NULL,
  source_updated_at TIMESTAMPTZ,
  idempotency_key VARCHAR NOT NULL UNIQUE,
  payload_version INTEGER NOT NULL,
  project_id VARCHAR,
  article_id VARCHAR,
  prompt_id VARCHAR,
  model_id VARCHAR,
  use_title BOOLEAN,
  use_abstract BOOLEAN,
  use_fulltext BOOLEAN,
  use_fulltext_no_images BOOLEAN,
  judgment_id VARCHAR,
  human_judgment_key VARCHAR,
  config_field_set VARCHAR,
  tombstone BOOLEAN NOT NULL DEFAULT FALSE,
  payload_json JSON,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  reconciled_at TIMESTAMPTZ,
  CHECK (length(trim(delta_id)) > 0),
  CHECK (length(trim(change_kind)) > 0),
  CHECK (length(trim(source_table)) > 0),
  CHECK (length(trim(source_row_id)) > 0),
  CHECK (length(trim(source_operation)) > 0),
  CHECK (length(trim(source_partition)) > 0),
  CHECK (source_high_water_mark >= 0),
  CHECK (length(trim(idempotency_key)) > 0),
  CHECK (payload_version >= 1)
);

CREATE TABLE IF NOT EXISTS app.review_source_change_outbox (
  outbox_id VARCHAR PRIMARY KEY,
  source_table VARCHAR NOT NULL,
  source_row_id VARCHAR NOT NULL,
  source_operation VARCHAR NOT NULL,
  source_partition VARCHAR NOT NULL,
  source_high_water_mark BIGINT NOT NULL,
  source_updated_at TIMESTAMPTZ,
  idempotency_key VARCHAR NOT NULL UNIQUE,
  payload_version INTEGER NOT NULL,
  recovery_payload_json JSON,
  status VARCHAR NOT NULL DEFAULT 'pending',
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error VARCHAR,
  lease_owner VARCHAR,
  lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  reconciled_at TIMESTAMPTZ,
  quarantined_at TIMESTAMPTZ,
  CHECK (length(trim(outbox_id)) > 0),
  CHECK (length(trim(source_table)) > 0),
  CHECK (length(trim(source_row_id)) > 0),
  CHECK (length(trim(source_operation)) > 0),
  CHECK (length(trim(source_partition)) > 0),
  CHECK (source_high_water_mark >= 0),
  CHECK (length(trim(idempotency_key)) > 0),
  CHECK (payload_version >= 1),
  CHECK (retry_count >= 0)
);

CREATE TABLE IF NOT EXISTS app.review_delta_reconciliation_cursor (
  source_partition VARCHAR PRIMARY KEY,
  source_high_water_mark BIGINT NOT NULL DEFAULT 0,
  last_reconciled_delta_id VARCHAR,
  status VARCHAR NOT NULL DEFAULT 'ready',
  lease_owner VARCHAR,
  lease_expires_at TIMESTAMPTZ,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error VARCHAR,
  quarantined_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  CHECK (length(trim(source_partition)) > 0),
  CHECK (source_high_water_mark >= 0),
  CHECK (retry_count >= 0)
);

CREATE TABLE IF NOT EXISTS app.review_import_article_hot_field (
  import_route_id VARCHAR NOT NULL,
  article_id VARCHAR NOT NULL,
  source_record_key VARCHAR NOT NULL,
  source_record_hash VARCHAR,
  source_kind VARCHAR,
  selected_rank_key VARCHAR,
  selected_rank_numeric DOUBLE,
  publication_year INTEGER,
  article_title VARCHAR,
  journal_title VARCHAR,
  external_id VARCHAR,
  duplicate_key VARCHAR,
  duplicate_flag BOOLEAN,
  conflict_flag BOOLEAN,
  filter_bucket_key VARCHAR,
  filter_bucket_value VARCHAR,
  source_updated_at TIMESTAMPTZ,
  tombstone BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(import_route_id, article_id, source_record_key),
  CHECK (length(trim(import_route_id)) > 0),
  CHECK (length(trim(article_id)) > 0),
  CHECK (length(trim(source_record_key)) > 0)
);

CREATE TABLE IF NOT EXISTS app.review_serving_dirty_work (
  dirty_work_id VARCHAR PRIMARY KEY,
  project_id VARCHAR,
  scope_kind VARCHAR NOT NULL,
  scope_id VARCHAR NOT NULL,
  article_id VARCHAR,
  projection_key VARCHAR,
  dirty_kind VARCHAR NOT NULL,
  source_partition VARCHAR NOT NULL,
  first_source_high_water_mark BIGINT NOT NULL,
  latest_source_high_water_mark BIGINT NOT NULL,
  latest_delta_id VARCHAR,
  dirty_range_start VARCHAR,
  dirty_range_end VARCHAR,
  status VARCHAR NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  CHECK (length(trim(dirty_work_id)) > 0),
  CHECK (length(trim(scope_kind)) > 0),
  CHECK (length(trim(scope_id)) > 0),
  CHECK (length(trim(dirty_kind)) > 0),
  CHECK (length(trim(source_partition)) > 0),
  CHECK (first_source_high_water_mark >= 0),
  CHECK (latest_source_high_water_mark >= first_source_high_water_mark)
);

CREATE TABLE IF NOT EXISTS app.review_serving_dirty_work_ack (
  dirty_ack_id VARCHAR PRIMARY KEY,
  dirty_work_id VARCHAR,
  projection_component VARCHAR NOT NULL,
  projection_identity VARCHAR NOT NULL,
  source_partition VARCHAR NOT NULL,
  completed_source_high_water_mark BIGINT NOT NULL,
  dirty_range_start VARCHAR,
  dirty_range_end VARCHAR,
  status VARCHAR NOT NULL DEFAULT 'completed',
  completed_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  CHECK (length(trim(dirty_ack_id)) > 0),
  CHECK (length(trim(projection_component)) > 0),
  CHECK (length(trim(projection_identity)) > 0),
  CHECK (length(trim(source_partition)) > 0),
  CHECK (completed_source_high_water_mark >= 0)
);

CREATE TABLE IF NOT EXISTS app.review_project_import_delta_cursor (
  project_id VARCHAR NOT NULL,
  import_route_id VARCHAR NOT NULL,
  source_delta_high_water BIGINT NOT NULL DEFAULT 0,
  cursor_json JSON,
  status VARCHAR NOT NULL DEFAULT 'ready',
  lease_owner VARCHAR,
  lease_expires_at TIMESTAMPTZ,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error VARCHAR,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(project_id, import_route_id),
  CHECK (length(trim(project_id)) > 0),
  CHECK (length(trim(import_route_id)) > 0),
  CHECK (source_delta_high_water >= 0),
  CHECK (retry_count >= 0)
);

CREATE TABLE IF NOT EXISTS app.review_serving_projector_watermark (
  watermark_id VARCHAR PRIMARY KEY,
  projector_name VARCHAR NOT NULL,
  project_id VARCHAR,
  import_route_id VARCHAR,
  projection_component VARCHAR NOT NULL,
  source_partition VARCHAR NOT NULL,
  source_high_water_mark BIGINT NOT NULL DEFAULT 0,
  base_generation BIGINT NOT NULL DEFAULT 0,
  patch_watermark BIGINT NOT NULL DEFAULT 0,
  snapshot_id VARCHAR,
  status VARCHAR NOT NULL DEFAULT 'ready',
  lease_owner VARCHAR,
  lease_expires_at TIMESTAMPTZ,
  cursor_json JSON,
  last_error VARCHAR,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  CHECK (length(trim(watermark_id)) > 0),
  CHECK (length(trim(projector_name)) > 0),
  CHECK (length(trim(projection_component)) > 0),
  CHECK (length(trim(source_partition)) > 0),
  CHECK (source_high_water_mark >= 0),
  CHECK (base_generation >= 0),
  CHECK (patch_watermark >= 0)
);

CREATE TABLE IF NOT EXISTS app.review_projection_identity_manifest (
  manifest_id VARCHAR PRIMARY KEY,
  project_id VARCHAR,
  projection_component VARCHAR NOT NULL,
  projection_identity VARCHAR NOT NULL,
  base_generation BIGINT NOT NULL DEFAULT 0,
  patch_watermark BIGINT NOT NULL DEFAULT 0,
  patch_range_start BIGINT,
  patch_range_end BIGINT,
  input_watermark BIGINT NOT NULL DEFAULT 0,
  input_watermarks_json JSON NOT NULL DEFAULT '{}',
  input_digest VARCHAR,
  definition_version VARCHAR NOT NULL,
  review_config_hash VARCHAR,
  prompt_config_hash VARCHAR,
  status VARCHAR NOT NULL DEFAULT 'candidate',
  invalidation_reason VARCHAR,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  UNIQUE(project_id, projection_component, projection_identity),
  CHECK (length(trim(manifest_id)) > 0),
  CHECK (length(trim(projection_component)) > 0),
  CHECK (length(trim(projection_identity)) > 0),
  CHECK (base_generation >= 0),
  CHECK (patch_watermark >= 0),
  CHECK (input_watermark >= 0),
  CHECK (length(trim(definition_version)) > 0)
);

CREATE TABLE IF NOT EXISTS app.review_rebuild_chunk_manifest (
  chunk_id VARCHAR PRIMARY KEY,
  project_id VARCHAR,
  projection_component VARCHAR NOT NULL,
  projection_identity VARCHAR NOT NULL,
  input_digest VARCHAR,
  input_watermark BIGINT NOT NULL DEFAULT 0,
  chunk_start_key VARCHAR NOT NULL,
  chunk_end_key VARCHAR NOT NULL,
  output_base_generation BIGINT NOT NULL DEFAULT 0,
  status VARCHAR NOT NULL DEFAULT 'pending',
  checksum VARCHAR,
  lease_owner VARCHAR,
  lease_expires_at TIMESTAMPTZ,
  last_error VARCHAR,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  CHECK (length(trim(chunk_id)) > 0),
  CHECK (length(trim(projection_component)) > 0),
  CHECK (length(trim(projection_identity)) > 0),
  CHECK (input_watermark >= 0),
  CHECK (length(trim(chunk_start_key)) > 0),
  CHECK (length(trim(chunk_end_key)) > 0),
  CHECK (output_base_generation >= 0)
);

CREATE TABLE IF NOT EXISTS app.review_selected_import_snapshot (
  selected_import_snapshot_id VARCHAR PRIMARY KEY,
  project_id VARCHAR NOT NULL,
  project_scope_identity VARCHAR NOT NULL,
  source_delta_high_water BIGINT NOT NULL DEFAULT 0,
  cursor_json JSON,
  status VARCHAR NOT NULL DEFAULT 'candidate',
  owner VARCHAR,
  lease_owner VARCHAR,
  lease_expires_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  last_error VARCHAR,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  CHECK (length(trim(selected_import_snapshot_id)) > 0),
  CHECK (length(trim(project_id)) > 0),
  CHECK (length(trim(project_scope_identity)) > 0),
  CHECK (source_delta_high_water >= 0)
);

CREATE TABLE IF NOT EXISTS app.review_selected_article_import_v4 (
  project_id VARCHAR NOT NULL,
  project_scope_identity VARCHAR NOT NULL,
  selected_import_snapshot_id VARCHAR NOT NULL,
  article_id VARCHAR NOT NULL,
  import_route_id VARCHAR,
  source_record_key VARCHAR,
  selected_rank_key VARCHAR,
  selected_rank_numeric DOUBLE,
  publication_year INTEGER,
  article_title VARCHAR,
  journal_title VARCHAR,
  external_id VARCHAR,
  duplicate_flag BOOLEAN,
  conflict_flag BOOLEAN,
  tombstone BOOLEAN NOT NULL DEFAULT FALSE,
  selected_import_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(project_id, project_scope_identity, selected_import_snapshot_id, article_id)
);

CREATE TABLE IF NOT EXISTS app.review_serving_snapshot_manifest (
  project_id VARCHAR NOT NULL,
  snapshot_id VARCHAR NOT NULL,
  snapshot_status VARCHAR NOT NULL DEFAULT 'candidate',
  review_config_hash VARCHAR,
  composed_identity_json JSON NOT NULL,
  component_state_json JSON NOT NULL,
  required_components_json JSON NOT NULL,
  optional_components_json JSON NOT NULL,
  source_watermarks_json JSON NOT NULL,
  validation_result_json JSON,
  selected_import_snapshot_id VARCHAR,
  last_known_good_snapshot_id VARCHAR,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  activated_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  last_error VARCHAR,
  PRIMARY KEY(project_id, snapshot_id),
  CHECK (length(trim(project_id)) > 0),
  CHECK (length(trim(snapshot_id)) > 0),
  CHECK (length(trim(snapshot_status)) > 0)
);

CREATE TABLE IF NOT EXISTS app.review_serving_snapshot_pin (
  pin_id VARCHAR PRIMARY KEY,
  project_id VARCHAR NOT NULL,
  snapshot_id VARCHAR NOT NULL,
  composed_identity_json JSON NOT NULL,
  owner_kind VARCHAR NOT NULL,
  owner_id VARCHAR NOT NULL,
  ref_count INTEGER NOT NULL DEFAULT 1,
  expires_at TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  CHECK (length(trim(pin_id)) > 0),
  CHECK (length(trim(project_id)) > 0),
  CHECK (length(trim(snapshot_id)) > 0),
  CHECK (length(trim(owner_kind)) > 0),
  CHECK (length(trim(owner_id)) > 0),
  CHECK (ref_count >= 0)
);

CREATE TABLE IF NOT EXISTS app.review_write_overlay (
  overlay_id VARCHAR PRIMARY KEY,
  project_id VARCHAR NOT NULL,
  review_config_hash VARCHAR,
  article_id VARCHAR NOT NULL,
  prompt_id VARCHAR,
  judgment_id VARCHAR,
  human_judgment_key VARCHAR,
  overlay_kind VARCHAR NOT NULL,
  read_surface VARCHAR NOT NULL,
  overlay_value_json JSON NOT NULL,
  source_partition VARCHAR NOT NULL,
  source_high_water_mark BIGINT NOT NULL,
  reconcile_status VARCHAR NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  expires_at TIMESTAMPTZ NOT NULL,
  reconciled_at TIMESTAMPTZ,
  CHECK (length(trim(overlay_id)) > 0),
  CHECK (length(trim(project_id)) > 0),
  CHECK (length(trim(article_id)) > 0),
  CHECK (length(trim(overlay_kind)) > 0),
  CHECK (length(trim(read_surface)) > 0),
  CHECK (length(trim(source_partition)) > 0),
  CHECK (source_high_water_mark >= 0)
);

CREATE TABLE IF NOT EXISTS app.review_bulk_operation_job (
  job_id VARCHAR PRIMARY KEY,
  job_kind VARCHAR NOT NULL,
  project_id VARCHAR NOT NULL,
  snapshot_id VARCHAR,
  snapshot_pin_id VARCHAR,
  latest_snapshot_semantics BOOLEAN NOT NULL DEFAULT FALSE,
  review_config_hash VARCHAR,
  composed_identity_json JSON,
  filter_signature VARCHAR NOT NULL,
  criteria_json JSON NOT NULL,
  cursor_json JSON,
  batch_size INTEGER NOT NULL,
  status VARCHAR NOT NULL DEFAULT 'pending',
  result_manifest_json JSON,
  processed_count BIGINT NOT NULL DEFAULT 0,
  total_estimate BIGINT,
  cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error VARCHAR,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  completed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  CHECK (length(trim(job_id)) > 0),
  CHECK (length(trim(job_kind)) > 0),
  CHECK (length(trim(project_id)) > 0),
  CHECK (length(trim(filter_signature)) > 0),
  CHECK (batch_size > 0),
  CHECK (processed_count >= 0),
  CHECK (retry_count >= 0)
);

CREATE TABLE IF NOT EXISTS app.review_search_job (
  job_id VARCHAR PRIMARY KEY,
  project_id VARCHAR NOT NULL,
  search_identity VARCHAR,
  project_scope_identity VARCHAR,
  review_config_hash VARCHAR,
  snapshot_id VARCHAR,
  snapshot_pin_id VARCHAR,
  latest_snapshot_semantics BOOLEAN NOT NULL DEFAULT FALSE,
  search_mode VARCHAR NOT NULL,
  search_text VARCHAR NOT NULL,
  filter_signature VARCHAR NOT NULL,
  cursor_json JSON,
  status VARCHAR NOT NULL DEFAULT 'pending',
  result_count BIGINT,
  result_count_availability VARCHAR NOT NULL DEFAULT 'unavailable',
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error VARCHAR,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  completed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  CHECK (length(trim(job_id)) > 0),
  CHECK (length(trim(project_id)) > 0),
  CHECK (length(trim(search_mode)) > 0),
  CHECK (length(trim(search_text)) > 0),
  CHECK (length(trim(filter_signature)) > 0),
  CHECK (retry_count >= 0)
);

CREATE TABLE IF NOT EXISTS app.review_serving_retention_mark (
  retention_scope VARCHAR PRIMARY KEY,
  cutoff_snapshot_id VARCHAR,
  cutoff_base_generation BIGINT NOT NULL DEFAULT 0,
  cutoff_patch_watermark BIGINT NOT NULL DEFAULT 0,
  cleanup_cursor_json JSON,
  last_cleaned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  CHECK (length(trim(retention_scope)) > 0),
  CHECK (cutoff_base_generation >= 0),
  CHECK (cutoff_patch_watermark >= 0)
);

CREATE TABLE IF NOT EXISTS mart.review_title_search_serving_v4 (
  project_id VARCHAR NOT NULL,
  search_identity VARCHAR NOT NULL,
  project_scope_identity VARCHAR NOT NULL,
  snapshot_id VARCHAR NOT NULL,
  token VARCHAR NOT NULL,
  article_id VARCHAR NOT NULL,
  title_prefix VARCHAR,
  activity_sort_at TIMESTAMPTZ,
  search_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(project_id, search_identity, project_scope_identity, snapshot_id, token, article_id)
);

CREATE TABLE IF NOT EXISTS mart.review_article_serving_v4 (
  project_id VARCHAR NOT NULL,
  review_config_hash VARCHAR NOT NULL,
  snapshot_id VARCHAR NOT NULL,
  base_generation BIGINT NOT NULL,
  patch_watermark BIGINT NOT NULL,
  display_identity VARCHAR NOT NULL,
  project_scope_identity VARCHAR NOT NULL,
  selected_import_identity VARCHAR NOT NULL,
  llm_status_identity VARCHAR NOT NULL,
  human_status_identity VARCHAR NOT NULL,
  posting_identity VARCHAR NOT NULL,
  summary_identity VARCHAR NOT NULL,
  payload_identity VARCHAR NOT NULL,
  list_mode_key VARCHAR NOT NULL,
  article_id VARCHAR NOT NULL,
  sort_key TIMESTAMPTZ NOT NULL,
  activity_sort_at TIMESTAMPTZ NOT NULL,
  article_title VARCHAR NOT NULL,
  article_external_id VARCHAR,
  journal_title VARCHAR,
  url VARCHAR,
  full_text_pdf VARCHAR,
  selected_import_route_id VARCHAR,
  selected_rank_key VARCHAR,
  publication_year INTEGER,
  duplicate_flag BOOLEAN NOT NULL DEFAULT FALSE,
  conflict_flag BOOLEAN NOT NULL DEFAULT FALSE,
  llm_status_key VARCHAR,
  human_status_key VARCHAR,
  llm_judged_prompt_count INTEGER NOT NULL DEFAULT 0,
  enabled_prompt_count INTEGER NOT NULL DEFAULT 0,
  human_answered_prompt_count INTEGER NOT NULL DEFAULT 0,
  review_opened BOOLEAN NOT NULL DEFAULT FALSE,
  review_sections_completed INTEGER NOT NULL DEFAULT 0,
  serving_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(project_id, review_config_hash, snapshot_id, list_mode_key, article_id),
  CHECK (base_generation >= 0),
  CHECK (patch_watermark >= 0)
);

CREATE TABLE IF NOT EXISTS mart.review_article_display_patch_v4 (
  project_id VARCHAR NOT NULL,
  display_identity VARCHAR NOT NULL,
  base_generation BIGINT NOT NULL,
  patch_watermark BIGINT NOT NULL,
  article_id VARCHAR NOT NULL,
  sort_key TIMESTAMPTZ,
  article_title VARCHAR,
  article_external_id VARCHAR,
  journal_title VARCHAR,
  url VARCHAR,
  publication_year INTEGER,
  tombstone BOOLEAN NOT NULL DEFAULT FALSE,
  patch_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(project_id, display_identity, base_generation, patch_watermark, article_id),
  CHECK (base_generation >= 0),
  CHECK (patch_watermark >= 0)
);

CREATE TABLE IF NOT EXISTS mart.review_selected_import_patch_v4 (
  project_id VARCHAR NOT NULL,
  project_scope_identity VARCHAR NOT NULL,
  selected_import_snapshot_id VARCHAR NOT NULL,
  patch_watermark BIGINT NOT NULL,
  article_id VARCHAR NOT NULL,
  import_route_id VARCHAR,
  selected_rank_key VARCHAR,
  selected_rank_numeric DOUBLE,
  publication_year INTEGER,
  duplicate_flag BOOLEAN,
  conflict_flag BOOLEAN,
  tombstone BOOLEAN NOT NULL DEFAULT FALSE,
  patch_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(project_id, project_scope_identity, selected_import_snapshot_id, patch_watermark, article_id),
  CHECK (patch_watermark >= 0)
);

CREATE TABLE IF NOT EXISTS mart.review_llm_status_patch_v4 (
  project_id VARCHAR NOT NULL,
  review_config_hash VARCHAR NOT NULL,
  prompt_config_hash VARCHAR NOT NULL,
  base_generation BIGINT NOT NULL,
  patch_watermark BIGINT NOT NULL,
  list_mode_key VARCHAR NOT NULL,
  article_id VARCHAR NOT NULL,
  prompt_id VARCHAR NOT NULL,
  llm_status_key VARCHAR,
  answered_original VARCHAR,
  answered_original_as_array VARCHAR[],
  latest_llm_created_at TIMESTAMPTZ,
  tombstone BOOLEAN NOT NULL DEFAULT FALSE,
  patch_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(project_id, review_config_hash, prompt_config_hash, base_generation, patch_watermark, list_mode_key, article_id, prompt_id),
  CHECK (base_generation >= 0),
  CHECK (patch_watermark >= 0)
);

CREATE TABLE IF NOT EXISTS mart.review_human_status_patch_v4 (
  project_id VARCHAR NOT NULL,
  prompt_config_hash VARCHAR NOT NULL,
  base_generation BIGINT NOT NULL,
  patch_watermark BIGINT NOT NULL,
  list_mode_key VARCHAR NOT NULL,
  article_id VARCHAR NOT NULL,
  prompt_id VARCHAR NOT NULL,
  human_status_key VARCHAR,
  human_answered_value VARCHAR,
  latest_human_updated_at TIMESTAMPTZ,
  tombstone BOOLEAN NOT NULL DEFAULT FALSE,
  patch_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(project_id, prompt_config_hash, base_generation, patch_watermark, list_mode_key, article_id, prompt_id),
  CHECK (base_generation >= 0),
  CHECK (patch_watermark >= 0)
);

CREATE TABLE IF NOT EXISTS mart.review_queue_patch_v4 (
  project_id VARCHAR NOT NULL,
  queue_identity VARCHAR NOT NULL,
  base_generation BIGINT NOT NULL,
  patch_watermark BIGINT NOT NULL,
  queue_kind VARCHAR NOT NULL,
  priority_bucket INTEGER NOT NULL,
  sort_key TIMESTAMPTZ NOT NULL,
  article_id VARCHAR NOT NULL,
  tombstone BOOLEAN NOT NULL DEFAULT FALSE,
  patch_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(project_id, queue_identity, base_generation, patch_watermark, queue_kind, priority_bucket, sort_key, article_id),
  CHECK (base_generation >= 0),
  CHECK (patch_watermark >= 0)
);

CREATE TABLE IF NOT EXISTS mart.review_article_filter_posting_patch_v4 (
  project_id VARCHAR NOT NULL,
  posting_identity VARCHAR NOT NULL,
  base_generation BIGINT NOT NULL,
  patch_watermark BIGINT NOT NULL,
  filter_kind VARCHAR NOT NULL,
  filter_value VARCHAR NOT NULL,
  list_mode_key VARCHAR NOT NULL,
  sort_key TIMESTAMPTZ NOT NULL,
  article_id VARCHAR NOT NULL,
  tombstone BOOLEAN NOT NULL DEFAULT FALSE,
  patch_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(project_id, posting_identity, base_generation, patch_watermark, filter_kind, filter_value, list_mode_key, article_id),
  CHECK (base_generation >= 0),
  CHECK (patch_watermark >= 0)
);

CREATE TABLE IF NOT EXISTS mart.review_article_filter_posting_serving_v4 (
  project_id VARCHAR NOT NULL,
  review_config_hash VARCHAR NOT NULL,
  snapshot_id VARCHAR NOT NULL,
  posting_identity VARCHAR NOT NULL,
  filter_kind VARCHAR NOT NULL,
  filter_value VARCHAR NOT NULL,
  list_mode_key VARCHAR NOT NULL,
  sort_key TIMESTAMPTZ NOT NULL,
  article_id VARCHAR NOT NULL,
  posting_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(project_id, review_config_hash, snapshot_id, filter_kind, filter_value, list_mode_key, article_id)
);

CREATE TABLE IF NOT EXISTS mart.review_filter_posting_stats_v4 (
  project_id VARCHAR NOT NULL,
  review_config_hash VARCHAR NOT NULL,
  snapshot_id VARCHAR NOT NULL,
  posting_identity VARCHAR NOT NULL,
  filter_kind VARCHAR NOT NULL,
  filter_value VARCHAR NOT NULL,
  list_mode_key VARCHAR NOT NULL,
  cardinality BIGINT NOT NULL,
  selectivity DOUBLE,
  stats_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(project_id, review_config_hash, snapshot_id, filter_kind, filter_value, list_mode_key),
  CHECK (cardinality >= 0)
);

CREATE TABLE IF NOT EXISTS mart.review_article_serving_payload_v4 (
  project_id VARCHAR NOT NULL,
  display_identity VARCHAR NOT NULL,
  payload_identity VARCHAR NOT NULL,
  snapshot_id VARCHAR NOT NULL,
  article_id VARCHAR NOT NULL,
  article_created_at TIMESTAMPTZ,
  source_metadata JSON,
  abstract_text VARCHAR,
  full_text_preview VARCHAR,
  payload_bytes BIGINT NOT NULL DEFAULT 0,
  payload_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(project_id, display_identity, payload_identity, snapshot_id, article_id),
  CHECK (payload_bytes >= 0)
);

CREATE TABLE IF NOT EXISTS mart.review_article_judgment_detail_serving_v4 (
  project_id VARCHAR NOT NULL,
  review_config_hash VARCHAR NOT NULL,
  snapshot_id VARCHAR NOT NULL,
  list_mode_key VARCHAR NOT NULL,
  payload_kind VARCHAR NOT NULL DEFAULT 'llm',
  article_id VARCHAR NOT NULL,
  prompt_id VARCHAR NOT NULL,
  prompt_order INTEGER,
  judgment_id VARCHAR,
  model_id VARCHAR,
  answered_original VARCHAR,
  answered_original_as_array VARCHAR[],
  judgment_payload_json JSON,
  placeholder_kind VARCHAR,
  detail_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(project_id, review_config_hash, snapshot_id, list_mode_key, payload_kind, article_id, prompt_id)
);

CREATE TABLE IF NOT EXISTS mart.review_article_summary_contribution_v4 (
  project_id VARCHAR NOT NULL,
  review_config_hash VARCHAR NOT NULL,
  snapshot_id VARCHAR NOT NULL,
  article_id VARCHAR NOT NULL,
  component_kind VARCHAR NOT NULL,
  summary_definition_version VARCHAR NOT NULL,
  contribution_key VARCHAR NOT NULL,
  contribution_value BIGINT NOT NULL,
  contribution_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(project_id, review_config_hash, snapshot_id, article_id, component_kind, summary_definition_version, contribution_key)
);

CREATE TABLE IF NOT EXISTS mart.review_article_count_serving_v4 (
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
  stale_reason VARCHAR,
  count_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(project_id, review_config_hash, snapshot_id, list_mode_key, count_kind, summary_definition_version, filter_key)
);

CREATE TABLE IF NOT EXISTS mart.review_filter_facet_serving_v4 (
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
  availability VARCHAR NOT NULL DEFAULT 'ready',
  facet_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(project_id, review_config_hash, snapshot_id, summary_identity, facet_kind, facet_key, facet_value, summary_definition_version)
);

CREATE TABLE IF NOT EXISTS mart.review_filter_option_serving_v4 (
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
  option_payload_json JSON,
  count_value BIGINT,
  option_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(project_id, review_config_hash, snapshot_id, search_identity, filter_option_identity, filter_kind, facet_key, option_value_key)
);

CREATE TABLE IF NOT EXISTS mart.review_unassessed_queue_serving_v4 (
  project_id VARCHAR NOT NULL,
  review_config_hash VARCHAR NOT NULL,
  snapshot_id VARCHAR NOT NULL,
  queue_identity VARCHAR NOT NULL,
  queue_kind VARCHAR NOT NULL,
  priority_bucket INTEGER NOT NULL,
  activity_sort_at TIMESTAMPTZ NOT NULL,
  article_id VARCHAR NOT NULL,
  prompt_id VARCHAR,
  queue_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(project_id, review_config_hash, snapshot_id, queue_kind, priority_bucket, activity_sort_at, article_id, prompt_id, queue_identity)
);

CREATE INDEX IF NOT EXISTS idx_import_run_article_delta_route_watermark
ON app.import_run_article_delta(import_route_id, source_high_water_mark, delta_id);

CREATE INDEX IF NOT EXISTS idx_import_run_article_delta_article
ON app.import_run_article_delta(article_id, delta_id);

CREATE INDEX IF NOT EXISTS idx_import_run_article_delta_source_watermark
ON app.import_run_article_delta(source_partition, source_high_water_mark);

CREATE INDEX IF NOT EXISTS idx_review_change_delta_project_watermark
ON app.review_change_delta(project_id, source_high_water_mark, delta_id);

CREATE INDEX IF NOT EXISTS idx_review_change_delta_article
ON app.review_change_delta(article_id, delta_id);

CREATE INDEX IF NOT EXISTS idx_review_change_delta_source_watermark
ON app.review_change_delta(source_partition, source_high_water_mark);

CREATE INDEX IF NOT EXISTS idx_review_source_change_outbox_status
ON app.review_source_change_outbox(status, source_partition, source_high_water_mark);

CREATE INDEX IF NOT EXISTS idx_review_import_article_hot_field_rank
ON app.review_import_article_hot_field(import_route_id, selected_rank_key, article_id);

CREATE INDEX IF NOT EXISTS idx_review_import_article_hot_field_article
ON app.review_import_article_hot_field(article_id, import_route_id);

CREATE INDEX IF NOT EXISTS idx_review_serving_dirty_work_lookup
ON app.review_serving_dirty_work(project_id, dirty_kind, latest_source_high_water_mark);

CREATE INDEX IF NOT EXISTS idx_review_serving_dirty_work_ack_component
ON app.review_serving_dirty_work_ack(projection_component, projection_identity, source_partition, completed_source_high_water_mark);

CREATE INDEX IF NOT EXISTS idx_review_project_import_delta_cursor_route
ON app.review_project_import_delta_cursor(import_route_id, source_delta_high_water);

CREATE INDEX IF NOT EXISTS idx_review_serving_projector_watermark_lookup
ON app.review_serving_projector_watermark(projector_name, project_id, projection_component, source_high_water_mark);

CREATE INDEX IF NOT EXISTS idx_review_projection_identity_manifest_component
ON app.review_projection_identity_manifest(project_id, projection_component, status, base_generation, patch_watermark);

CREATE INDEX IF NOT EXISTS idx_review_rebuild_chunk_manifest_status
ON app.review_rebuild_chunk_manifest(project_id, projection_component, projection_identity, status, chunk_start_key);

CREATE INDEX IF NOT EXISTS idx_review_selected_import_snapshot_active
ON app.review_selected_import_snapshot(project_id, project_scope_identity, status, source_delta_high_water);

CREATE INDEX IF NOT EXISTS idx_review_selected_article_import_v4_order
ON app.review_selected_article_import_v4(project_id, project_scope_identity, selected_import_snapshot_id, selected_rank_key, article_id);

CREATE INDEX IF NOT EXISTS idx_review_serving_snapshot_manifest_status
ON app.review_serving_snapshot_manifest(project_id, snapshot_status, review_config_hash, updated_at);

CREATE INDEX IF NOT EXISTS idx_review_serving_snapshot_pin_active
ON app.review_serving_snapshot_pin(project_id, snapshot_id, expires_at, released_at);

CREATE INDEX IF NOT EXISTS idx_review_write_overlay_article
ON app.review_write_overlay(project_id, article_id, review_config_hash, expires_at);

CREATE INDEX IF NOT EXISTS idx_review_bulk_operation_job_status
ON app.review_bulk_operation_job(project_id, status, updated_at);

CREATE INDEX IF NOT EXISTS idx_review_search_job_status
ON app.review_search_job(project_id, status, updated_at);

CREATE INDEX IF NOT EXISTS idx_review_title_search_serving_v4_token
ON mart.review_title_search_serving_v4(project_id, search_identity, project_scope_identity, snapshot_id, token, article_id);

CREATE INDEX IF NOT EXISTS idx_review_article_serving_v4_order
ON mart.review_article_serving_v4(project_id, review_config_hash, snapshot_id, list_mode_key, sort_key, article_id);

CREATE INDEX IF NOT EXISTS idx_review_article_serving_v4_publication_year
ON mart.review_article_serving_v4(project_id, review_config_hash, snapshot_id, list_mode_key, publication_year, sort_key, article_id);

CREATE INDEX IF NOT EXISTS idx_review_article_display_patch_v4_lookup
ON mart.review_article_display_patch_v4(project_id, display_identity, base_generation, patch_watermark, sort_key, article_id);

CREATE INDEX IF NOT EXISTS idx_review_selected_import_patch_v4_lookup
ON mart.review_selected_import_patch_v4(project_id, project_scope_identity, selected_import_snapshot_id, patch_watermark, selected_rank_key, article_id);

CREATE INDEX IF NOT EXISTS idx_review_llm_status_patch_v4_lookup
ON mart.review_llm_status_patch_v4(project_id, review_config_hash, prompt_config_hash, base_generation, patch_watermark, list_mode_key, article_id);

CREATE INDEX IF NOT EXISTS idx_review_human_status_patch_v4_lookup
ON mart.review_human_status_patch_v4(project_id, prompt_config_hash, base_generation, patch_watermark, list_mode_key, article_id);

CREATE INDEX IF NOT EXISTS idx_review_queue_patch_v4_order
ON mart.review_queue_patch_v4(project_id, queue_identity, base_generation, patch_watermark, queue_kind, priority_bucket, sort_key, article_id);

CREATE INDEX IF NOT EXISTS idx_review_article_filter_posting_patch_v4_lookup
ON mart.review_article_filter_posting_patch_v4(project_id, posting_identity, base_generation, patch_watermark, filter_kind, filter_value, list_mode_key, sort_key, article_id);

CREATE INDEX IF NOT EXISTS idx_review_article_filter_posting_serving_v4_lookup
ON mart.review_article_filter_posting_serving_v4(project_id, review_config_hash, snapshot_id, filter_kind, filter_value, list_mode_key, sort_key, article_id);

CREATE INDEX IF NOT EXISTS idx_review_filter_posting_stats_v4_lookup
ON mart.review_filter_posting_stats_v4(project_id, review_config_hash, snapshot_id, filter_kind, filter_value, list_mode_key);

CREATE INDEX IF NOT EXISTS idx_review_article_serving_payload_v4_lookup
ON mart.review_article_serving_payload_v4(project_id, snapshot_id, article_id);

CREATE INDEX IF NOT EXISTS idx_review_article_serving_payload_v4_preview_order
ON mart.review_article_serving_payload_v4(project_id, snapshot_id, article_created_at, article_id);

CREATE INDEX IF NOT EXISTS idx_review_article_judgment_detail_serving_v4_article
ON mart.review_article_judgment_detail_serving_v4(project_id, review_config_hash, snapshot_id, article_id, payload_kind, prompt_order);

CREATE INDEX IF NOT EXISTS idx_review_article_summary_contribution_v4_lookup
ON mart.review_article_summary_contribution_v4(project_id, review_config_hash, snapshot_id, component_kind, summary_definition_version, contribution_key);

CREATE INDEX IF NOT EXISTS idx_review_article_count_serving_v4_lookup
ON mart.review_article_count_serving_v4(project_id, review_config_hash, snapshot_id, list_mode_key, count_kind, filter_key);

CREATE INDEX IF NOT EXISTS idx_review_filter_facet_serving_v4_lookup
ON mart.review_filter_facet_serving_v4(project_id, review_config_hash, snapshot_id, summary_identity, facet_kind, facet_key, facet_value);

CREATE INDEX IF NOT EXISTS idx_review_filter_option_serving_v4_lookup
ON mart.review_filter_option_serving_v4(project_id, review_config_hash, snapshot_id, search_identity, filter_kind, facet_key, option_value_key);

CREATE INDEX IF NOT EXISTS idx_review_unassessed_queue_serving_v4_order
ON mart.review_unassessed_queue_serving_v4(project_id, review_config_hash, snapshot_id, queue_kind, priority_bucket, activity_sort_at, article_id);
