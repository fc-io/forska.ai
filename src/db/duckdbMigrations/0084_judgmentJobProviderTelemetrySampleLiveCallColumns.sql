ALTER TABLE app.judgment_job_provider_telemetry_sample
ADD COLUMN IF NOT EXISTS target_request_live_calls INTEGER DEFAULT 0;

ALTER TABLE app.judgment_job_provider_telemetry_sample
ADD COLUMN IF NOT EXISTS unallocated_target_live_calls INTEGER DEFAULT 0;
