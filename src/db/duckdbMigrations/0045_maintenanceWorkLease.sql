CREATE TABLE IF NOT EXISTS app.maintenance_work_lease (
  id VARCHAR PRIMARY KEY,
  work_kind VARCHAR NOT NULL,
  scope_kind VARCHAR NOT NULL,
  project_id VARCHAR,
  article_id VARCHAR,
  queue_id VARCHAR,
  judgment_job_id VARCHAR,
  required_consumer_role VARCHAR NOT NULL,
  consumer_id VARCHAR,
  last_started_at TIMESTAMPTZ,
  last_progressed_at TIMESTAMPTZ,
  lease_expires_at TIMESTAMPTZ,
  fresh_until_at TIMESTAMPTZ,
  retry_after_at TIMESTAMPTZ,
  recovery_mode VARCHAR NOT NULL DEFAULT 'none',
  recovery_context JSON,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  CHECK (scope_kind IN ('article', 'job', 'project', 'queue'))
);

CREATE INDEX IF NOT EXISTS idx_app_maintenance_work_lease_fresh_project
ON app.maintenance_work_lease(project_id, completed_at, fresh_until_at);

CREATE INDEX IF NOT EXISTS idx_app_maintenance_work_lease_fresh_article
ON app.maintenance_work_lease(article_id, completed_at, fresh_until_at);

CREATE INDEX IF NOT EXISTS idx_app_maintenance_work_lease_recovery
ON app.maintenance_work_lease(project_id, recovery_mode, retry_after_at, completed_at);
