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
- Use a flat Eden route and TanStack Query on the client; do not add a new chart dependency.

## Bucket Ranges

- `5m`: 30 second buckets over the last complete 5 minute window.
- `15m`: 30 second buckets over the last complete 15 minute window.
- `1h`: 1 minute buckets over the last complete hour.
- `24h`: 15 minute buckets over the last complete 24 hour window.
- `3d`: 1 hour buckets over the last complete 72 hour window.
- Align range start/end and bucket start/end times server-side so refreshes do not produce partial leading/trailing buckets.
- Use an exclusive `rangeEnd` and inclusive `rangeStart`, with `rangeEnd` floored to the preset bucket size.

## Todo

- [ ] Add next DuckDB migration for `app.judgment_job_provider_telemetry_sample`, currently `src/db/duckdbMigrations/0071_judgmentJobProviderTelemetrySample.sql`.
- [ ] Store sampled provider telemetry for running active jobs every 30 seconds from a dedicated maintenance cron sampler.
- [ ] Delete samples immediately when a judgment job is deleted via `deleteJudgmentJobSafelyTx`.
- [ ] Default retention to 3 days and prune older samples during `judgmentsJobsCleanupStale`.
- [ ] Add `src/server/services/judgmentProviderTelemetryHistoryService.ts` for inserting, pruning, and querying telemetry samples.
- [ ] Add an API endpoint for job telemetry history with bucketed rows for charts and range presets.
- [ ] Add shared helpers for adherence state, utilization, and bottleneck summary.
- [ ] Add a job detail UI section showing utilization history over the selected range.
- [ ] Keep the current snapshot info box for live state.
- [ ] Add targeted server/helper/route tests.
- [ ] Add browser coverage for the job detail telemetry chart.

## Sampling Source

- Reuse the same provider telemetry assembly used by the live job detail snapshot, but run it from cron/maintenance code instead of the route handler.
- Extract shared route/sampler input building from `/api/judgmentsjobs/:id`, including endpoint diagnostics enrichment, so live snapshots and persisted samples cannot drift.
- The sampler must include running active jobs even when no client is polling the admin UI.
- Use `judgmentsJobsGetRunningJobs({applyRuntimeMatchFilter: false})` so telemetry records endpoint/runtime-unavailable states instead of filtering them out before sampling.
- The sampler should no-op if the current server role cannot access the judgment read model or should not run maintenance loops.
- Samples should be deduplicated by cadence slot so overlapping cron invocations cannot double-write the same `(job_id, provider_key, sampled_at)` row.
- Use an in-process overlap guard for the `*/30 * * * * *` sampler and still rely on database conflict handling for cross-process overlap.
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
- Insert samples with `ON CONFLICT(job_id, provider_key, sampled_at) DO NOTHING`.
- The unique key covers filtered chart lookup; do not add a duplicate query index unless query profiling shows it is needed.
- Add `(job_id, sampled_at)` only if the endpoint supports unfiltered provider history.
- Retention index: `(sampled_at)` for pruning.
- Add checks for non-empty IDs/provider keys, non-negative capacity/lease counts, and `aggregate_completeness` in `complete | partial | unavailable`.
- Delete samples before deleting the job row in the same transaction/path as judgment job deletion.

## API Shape

- Route: `GET /api/judgmentsjobs-provider-telemetry-history` with query input `jobId`, optional `providerKey`, and `range` in `5m | 15m | 1h | 24h | 3d`.
- When `providerKey` is omitted, default to the current job provider key instead of aggregating unrelated provider keys.
- Endpoint output: `rangeStart`, `rangeEnd`, `bucketSizeSeconds`, `providerKey`, and ordered bucket rows with `bucketStart`, `bucketEnd`, `sampleCount`, `avgUtilization`, `minUtilization`, `maxUtilization`, `adherenceState`, and deterministic dominant/latest bottleneck summary.
- Utilization is based on request fill against normal request capacity, using `provider_request_fill_pct` when available and recomputing from leases/capacity when needed.
- Utilization values are percentages where `100` means full normal request capacity; values may exceed `100` for over-limit samples, averages may be fractional, and min/max use stored or recomputed sample values.
- Treat utilization as `null` when normal request capacity is zero; bucket average/min/max should ignore null utilization and return null when no sample in the bucket has usable utilization.
- Derive sample adherence as `overLimit` when live leases exceed normal capacity or physical calls exceed provider limit, `atLimit` when either limit is exactly full, and `withinLimit` otherwise; empty buckets return `unknown`.
- Derive bucket adherence with worst-state precedence: `overLimit`, `atLimit`, `withinLimit`, `unknown`.
- Choose the dominant bottleneck by highest sample count in the bucket, breaking ties by latest sample, and take source/subreason from the selected latest sample for that bottleneck.
- Return empty buckets for the requested aligned range so the UI can render stable charts.

## Client UI

- Add `fetchJudgmentJobProviderTelemetryHistory` and response types in `src/services/judgmentsJobsService.ts` using Eden, not `fetch`.
- Use `useQuery` from `@tanstack/solid-query` with local loading/error UI inside the telemetry chart panel; do not introduce a full-page spinner or suspend the route.
- Render the history chart near `JobTelemetryPanel` while preserving the existing live Provider Capacity Telemetry snapshot.
- Include range preset controls, an empty-history state, and mobile-safe overflow behavior.
- Update Playwright telemetry fixtures to mock the new history endpoint.

## Quality Gates

- [ ] `bun run db:mig`
- [ ] `bun test src/server/services/judgmentProviderTelemetryHistoryService.test.ts`
- [ ] `bun test src/server/services/judgmentJobDeleteService.test.ts`
- [ ] `bun test src/server/cron/judgmentsJobs.test.ts`
- [ ] `bun test src/server/cron/judgmentsJobs/judgmentsJobsCleanupStale.test.ts`
- [ ] `bun test src/server/routes/JudgmentsJobsRoutes.test.ts`
- [ ] `bun test src/app/routes/+admin/+jobs/jobsPageShared.test.ts`
- [ ] `bun run test:playwright -- tests/e2e/adminJudgmentJobTelemetry.spec.ts`
- [ ] Browser verification for chart range switching, empty history, and mobile overflow on the admin job detail page
- [ ] `bun run lint`
- [ ] `bun run build`
- [ ] `bun run desktop:build`
