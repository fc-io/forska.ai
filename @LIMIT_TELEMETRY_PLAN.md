# Limit Telemetry Plan

## Goal

Persist provider-limit adherence telemetry for judgment jobs and show the last 3 days on the job detail page.

## Decisions

- Sample every 30 seconds from a dedicated server-side maintenance cron, independent of whether the job detail page is open.
- Store one sample per active `(job_id, provider_key, sampled_at)` cadence slot; avoid page-view-biased history.
- Delete telemetry immediately when the owning judgment job is deleted.
- Keep automatic time retention at 3 days for all remaining jobs.
- Chart utilization with average, minimum, and maximum values per bucket.
- Support aligned range presets: last whole 5 minutes, last whole 15 minutes, last whole 1 hour, last whole 24 hours, and last whole 3 days.

## Bucket Ranges

- `5m`: 30 second buckets over the last complete 5 minute window.
- `15m`: 30 second buckets over the last complete 15 minute window.
- `1h`: 1 minute buckets over the last complete hour.
- `24h`: 15 minute buckets over the last complete 24 hour window.
- `3d`: 1 hour buckets over the last complete 72 hour window.
- Align range start/end and bucket start/end times server-side so refreshes do not produce partial leading/trailing buckets.
- Use an exclusive `rangeEnd` and inclusive `rangeStart`, with `rangeEnd` floored to the preset bucket size.

## Todo

- [ ] Add DuckDB migration for `app.judgment_job_provider_telemetry_sample`.
- [ ] Store sampled provider telemetry for running active jobs every 30 seconds from a dedicated maintenance cron sampler.
- [ ] Delete samples immediately when a judgment job is deleted via `deleteJudgmentJobSafelyTx`.
- [ ] Default retention to 3 days and prune older samples during `judgmentsJobsCleanupStale`.
- [ ] Add a service for inserting, pruning, and querying telemetry samples.
- [ ] Add an API endpoint for job telemetry history with bucketed rows for charts and range presets.
- [ ] Add shared helpers for adherence state, utilization, and bottleneck summary.
- [ ] Add a job detail UI section showing utilization history over the selected range.
- [ ] Keep the current snapshot info box for live state.
- [ ] Add targeted server/helper/route tests.
- [ ] Add browser coverage for the job detail telemetry chart.

## Sampling Source

- Reuse the same provider telemetry assembly used by the live job detail snapshot, but run it from cron/maintenance code instead of the route handler.
- Extract shared route/sampler input building from `/api/judgmentsjobs/:id` so live snapshots and persisted samples cannot drift.
- The sampler must include running active jobs even when no client is polling the admin UI.
- The sampler should no-op if the current server role cannot access the judgment read model or should not run maintenance loops.
- Samples should be deduplicated by cadence slot so overlapping cron invocations cannot double-write the same `(job_id, provider_key, sampled_at)` row.
- Store `sampled_at` as the normalized 30 second cadence-slot start; use `created_at` for insertion time.

## Stored Fields

- `id`, `created_at`
- `job_id`, `project_id`, `provider_key`, `sampled_at`
- `provider_limit`, `normal_request_capacity`, `target_request_live_calls`
- `provider_leased_physical_calls`, `provider_leased_live_requests`, `provider_leased_probe_calls`
- `provider_available_request_leases`, `provider_request_fill_pct`
- `provider_limit_version`, `provider_allocation_version`, `provider_probe_occupancy_version`
- `bottleneck`, `bottleneck_subreason`, `bottleneck_source`
- `fresh_worker_count`, `stale_worker_count`, `unavailable_worker_count`, `aggregate_completeness`
- Optional compact `snapshot_json` for debugging only; exclude large nested allocation snapshots and verbose endpoint failure details by default.

## Schema And Indexes

- Primary key: `id`.
- Unique key: `(job_id, provider_key, sampled_at)`.
- Query index: `(job_id, provider_key, sampled_at)` for chart history; add `(job_id, sampled_at)` only if the endpoint supports unfiltered provider history.
- Retention index: `(sampled_at)` for pruning.
- Delete samples before deleting the job row in the same transaction/path as judgment job deletion.

## API Shape

- Endpoint input: `jobId`, optional `providerKey`, and `range` in `5m | 15m | 1h | 24h | 3d`; when `providerKey` is omitted, default to the current job provider key instead of aggregating unrelated provider keys.
- Endpoint output: `rangeStart`, `rangeEnd`, `bucketSizeSeconds`, `providerKey`, and ordered bucket rows with `bucketStart`, `bucketEnd`, `sampleCount`, `avgUtilization`, `minUtilization`, `maxUtilization`, and deterministic dominant/latest bottleneck summary.
- Utilization is based on request fill against normal request capacity, using `provider_request_fill_pct` when available and recomputing from leases/capacity when needed.
- Treat utilization as `null` when normal request capacity is zero; bucket average/min/max should ignore null utilization and return null when no sample in the bucket has usable utilization.
- Choose the dominant bottleneck by highest sample count in the bucket, breaking ties by latest sample, and take source/subreason from the selected latest sample for that bottleneck.
- Return empty buckets for the requested aligned range so the UI can render stable charts.

## Quality Gates

- [ ] `bun run db:mig`
- [ ] `bun test src/server/cron/judgmentsJobs/judgmentProviderTelemetryHistoryService.test.ts`
- [ ] `bun test src/server/routes/JudgmentsJobsRoutes.test.ts`
- [ ] `bun test src/app/routes/+admin/+jobs/jobsPageShared.test.ts`
- [ ] Browser verification for the admin job detail telemetry chart
- [ ] `bun run lint`
- [ ] `bun run build`
- [ ] `bun run desktop:build`
