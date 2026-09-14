DROP TABLE IF EXISTS app.judgment_job_provider_telemetry_sample_noindex_repair_0233;

CREATE TABLE app.judgment_job_provider_telemetry_sample_noindex_repair_0233 (
  id VARCHAR NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  job_id VARCHAR NOT NULL,
  project_id VARCHAR NOT NULL,
  provider_key VARCHAR NOT NULL,
  sampled_at TIMESTAMPTZ NOT NULL,
  provider_limit INTEGER NOT NULL,
  effective_provider_limit INTEGER NOT NULL,
  normal_request_capacity INTEGER NOT NULL,
  target_request_live_calls INTEGER NOT NULL,
  unallocated_target_live_calls INTEGER NOT NULL,
  provider_available_request_leases INTEGER NOT NULL,
  provider_leased_live_requests INTEGER NOT NULL,
  provider_leased_physical_calls INTEGER NOT NULL,
  provider_leased_probe_calls INTEGER NOT NULL,
  provider_request_fill_pct DOUBLE,
  provider_limit_version VARCHAR NOT NULL,
  provider_probe_occupancy_version VARCHAR NOT NULL,
  provider_allocation_version VARCHAR NOT NULL,
  bottleneck VARCHAR,
  bottleneck_source VARCHAR,
  bottleneck_subreason VARCHAR,
  fresh_worker_count INTEGER NOT NULL,
  stale_worker_count INTEGER NOT NULL,
  unavailable_worker_count INTEGER NOT NULL,
  aggregate_completeness VARCHAR NOT NULL,
  snapshot_json JSON,
  CHECK (length(trim(id)) > 0),
  CHECK (length(trim(job_id)) > 0),
  CHECK (length(trim(project_id)) > 0),
  CHECK (length(trim(provider_key)) > 0),
  CHECK (provider_limit >= 0),
  CHECK (effective_provider_limit >= 0),
  CHECK (normal_request_capacity >= 0),
  CHECK (target_request_live_calls >= 0),
  CHECK (unallocated_target_live_calls >= 0),
  CHECK (provider_available_request_leases >= 0),
  CHECK (provider_leased_live_requests >= 0),
  CHECK (provider_leased_physical_calls >= 0),
  CHECK (provider_leased_probe_calls >= 0),
  CHECK (provider_request_fill_pct IS NULL OR provider_request_fill_pct >= 0),
  CHECK (fresh_worker_count >= 0),
  CHECK (stale_worker_count >= 0),
  CHECK (unavailable_worker_count >= 0),
  CHECK (aggregate_completeness IN ('complete', 'partial', 'unavailable'))
);

INSERT INTO app.judgment_job_provider_telemetry_sample_noindex_repair_0233 BY NAME
SELECT
  id,
  created_at,
  job_id,
  project_id,
  provider_key,
  sampled_at,
  provider_limit,
  effective_provider_limit,
  normal_request_capacity,
  target_request_live_calls,
  unallocated_target_live_calls,
  provider_available_request_leases,
  provider_leased_live_requests,
  provider_leased_physical_calls,
  provider_leased_probe_calls,
  provider_request_fill_pct,
  provider_limit_version,
  provider_probe_occupancy_version,
  provider_allocation_version,
  bottleneck,
  bottleneck_source,
  bottleneck_subreason,
  fresh_worker_count,
  stale_worker_count,
  unavailable_worker_count,
  aggregate_completeness,
  snapshot_json
FROM (
  SELECT
    *,
    ROW_NUMBER() OVER (
      PARTITION BY job_id, provider_key, sampled_at
      ORDER BY created_at ASC, id ASC
    ) AS repair_row_number
  FROM app.judgment_job_provider_telemetry_sample
)
WHERE repair_row_number = 1;

DROP INDEX IF EXISTS app.idx_app_judgment_job_provider_telemetry_sample_sampled_at;
DROP INDEX IF EXISTS idx_app_judgment_job_provider_telemetry_sample_sampled_at;

DROP TABLE app.judgment_job_provider_telemetry_sample;

ALTER TABLE app.judgment_job_provider_telemetry_sample_noindex_repair_0233
RENAME TO judgment_job_provider_telemetry_sample;
