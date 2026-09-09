DROP TABLE IF EXISTS app.judgment_job_noindex_repair_0229;

CREATE TABLE app.judgment_job_noindex_repair_0229 (
  id VARCHAR NOT NULL,
  project_id VARCHAR NOT NULL,
  status VARCHAR NOT NULL,
  "error" JSON,
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

INSERT INTO app.judgment_job_noindex_repair_0229 BY NAME
SELECT *
FROM app.judgment_job
QUALIFY ROW_NUMBER() OVER (
  PARTITION BY id
  ORDER BY
    CASE
      WHEN storage_state = 'active' AND status IN ('running', 'ready') THEN 0
      WHEN storage_state = 'draining' THEN 1
      WHEN storage_state = 'active' THEN 2
      WHEN storage_state = 'quarantined' THEN 3
      ELSE 4
    END ASC,
    updated_at DESC NULLS LAST,
    last_import_completed_at DESC NULLS LAST,
    last_import_started_at DESC NULLS LAST,
    created_at DESC NULLS LAST,
    id DESC
) = 1;

DROP INDEX IF EXISTS app.idx_app_judgment_job_status_storage_project;
DROP INDEX IF EXISTS idx_app_judgment_job_status_storage_project;
DROP INDEX IF EXISTS app.idx_app_judgment_job_storage_status_updated;
DROP INDEX IF EXISTS idx_app_judgment_job_storage_status_updated;
DROP INDEX IF EXISTS app.idx_app_judgment_job_quarantine_recovery;
DROP INDEX IF EXISTS idx_app_judgment_job_quarantine_recovery;

DROP TABLE app.judgment_job;

ALTER TABLE app.judgment_job_noindex_repair_0229
RENAME TO judgment_job;

DROP TABLE IF EXISTS app.comparison_project_serving_generation_noindex_repair_0229;

CREATE TABLE app.comparison_project_serving_generation_noindex_repair_0229 (
  comparison_project_id VARCHAR NOT NULL,
  active_generation BIGINT NOT NULL,
  generation_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  serving_status VARCHAR DEFAULT 'missing',
  serving_generation BIGINT,
  serving_started_at TIMESTAMPTZ,
  serving_completed_at TIMESTAMPTZ,
  serving_failed_at TIMESTAMPTZ,
  serving_error VARCHAR,
  serving_phase VARCHAR,
  serving_phase_started_at TIMESTAMPTZ,
  serving_last_progressed_at TIMESTAMPTZ,
  serving_staged_article_count BIGINT DEFAULT 0,
  serving_staged_cell_count BIGINT DEFAULT 0,
  serving_staged_filter_member_count BIGINT DEFAULT 0,
  serving_staged_filter_stats_count BIGINT DEFAULT 0,
  serving_total_article_count BIGINT,
  serving_total_cell_count BIGINT
);

INSERT INTO app.comparison_project_serving_generation_noindex_repair_0229 BY NAME
SELECT *
FROM app.comparison_project_serving_generation
QUALIFY ROW_NUMBER() OVER (
  PARTITION BY comparison_project_id
  ORDER BY
    generation_updated_at DESC NULLS LAST,
    active_generation DESC,
    comparison_project_id ASC
) = 1;

DROP INDEX IF EXISTS app.idx_app_comparison_project_serving_generation_active;
DROP INDEX IF EXISTS idx_app_comparison_project_serving_generation_active;

DROP TABLE app.comparison_project_serving_generation;

ALTER TABLE app.comparison_project_serving_generation_noindex_repair_0229
RENAME TO comparison_project_serving_generation;
