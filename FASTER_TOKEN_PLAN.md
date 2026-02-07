# Faster Token Plan

Context:

- Jobs page slowdown is dominated by large `token_use` scans (global totals + timeline percentile stats).
- `token_use` is large, so repeated 30s polling amplifies DB load.
- Option 1 is now implemented to decouple fast timeline buckets from expensive stats.

## Option 1 — Split fast timeline from expensive stats (implemented)

- [x] Keep `/api/tokens/timeline` and `/api/tokens/timelineAllJobs` focused on bucket data only.
- [x] Move highest/p90 stats to `/api/tokens/timelineStats` and `/api/tokens/timelineAllJobsStats`.
- [x] Fetch stats separately in UI so timeline renders without waiting for percentile scans.
- [x] Add 5-minute in-memory cache for stats queries (keyed by interval + scope).

## Option 2 — Precompute global totals

- [ ] Add a tiny aggregate table for global token totals.
- [ ] Update aggregate on write, or refresh every N seconds via cron.
- [ ] Point `/api/judgmentsjobs-total-token-usage` to aggregate table.
- [ ] Keep a fallback full recompute job for drift correction.

## Option 3 — Rollups for analytics queries

- [ ] Add minute/hour/day rollup tables for `token_use`.
- [ ] Read timeline + percentile stats from rollups, not raw events.
- [ ] Backfill rollups once, then maintain incrementally.
- [ ] Set retention windows per rollup granularity.

## Option 4 — Reduce polling pressure

- [ ] Increase polling interval on heavy endpoints.
- [ ] Pause/refetch less when tab is hidden.
- [ ] Poll stats less often than timeline buckets.
- [ ] Keep manual refresh for admins.

## Option 5 — Index + planner tuning

- [ ] Evaluate BRIN on `token_use.created_at` for large time-window scans.
- [ ] Evaluate extra btree for dominant predicates if still needed after rollups.
- [ ] Check autovacuum/analyze cadence for `token_use`.
- [ ] Re-run `EXPLAIN (ANALYZE, BUFFERS)` after each index/tuning change.

## Option 6 — Postgres timeseries plugins/extensions

- [ ] Evaluate TimescaleDB (hypertables + continuous aggregates + compression).
- [ ] Evaluate `pg_partman` for monthly partition management.
- [ ] Compare extension path vs native PG partitioning complexity/cost.
- [ ] Decide based on ops overhead, hosted DB support, and migration risk.

## Option 7 — Token analytics in ClickHouse

- [ ] Evaluate writing token events to ClickHouse (dual write or CDC).
- [ ] Move heavy analytics reads (timeline/percentile/global sums) to ClickHouse.
- [ ] Keep PG as transactional source of truth.
- [ ] Define reconciliation checks between PG and CH.

## Option 8 — Separate table for tokens older than 30 days

- [ ] Create hot/cold storage plan (`token_use_recent` + `token_use_archive`) or partition by age.
- [ ] Keep jobs-page queries on hot data by default.
- [ ] Add archival job + verification checksums/count checks.
- [ ] Add fallback query path when older ranges are explicitly requested.
