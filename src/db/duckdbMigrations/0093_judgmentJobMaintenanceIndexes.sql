CREATE INDEX IF NOT EXISTS idx_app_judgment_job_status_storage_project
ON app.judgment_job(status, storage_state, project_id);

CREATE INDEX IF NOT EXISTS idx_app_judgment_job_storage_status_updated
ON app.judgment_job(storage_state, status, updated_at);

CREATE INDEX IF NOT EXISTS idx_app_judgment_job_quarantine_recovery
ON app.judgment_job(storage_state, quarantined_at, updated_at);

CREATE INDEX IF NOT EXISTS idx_app_provider_admission_lease_provider_lease_kind_expiry
ON app.provider_admission_lease(provider_key, lease_kind, expires_at);

CREATE INDEX IF NOT EXISTS idx_app_provider_admission_lease_request
ON app.provider_admission_lease(provider_key, lease_kind, request_attempt_id);

CREATE INDEX IF NOT EXISTS idx_app_request_attempt_closeout_provider_attempt
ON app.request_attempt_closeout(provider_key, request_attempt_id);
