# DuckDB vs ClickHouse (PeerDB replacement) plan

## Goal

- See if DuckDB (+ Postgres extension) can hit ClickHouse-level perf for current analytics queries.
- Keep scope tight: reproduce existing CH queries, run CH+Duck in parallel, log numbers.

## Baseline (what we compare)

- Query sources (current): `src/services/clickhouse/articlesReviewsClickHouse.ts`, `src/services/clickhouse/articlesReviewsFiltersClickHouse.ts`, `src/services/clickhouse/unassessedArticlesClickHouse.ts`, `src/services/clickhouse/selectArticleIdsClickHouse.ts`.
- Existing benchmark example: `scripts/benchmarkCuratedArticles.ts`.

## DuckDB setup (minimal ops)

- Install DuckDB CLI (pick one):
  - Host: `brew install duckdb`
  - Docker: run `duckdb` image + bind-mount workspace
- Use DuckDB Postgres extension:
  - `INSTALL postgres; LOAD postgres;`
  - Attach PG via `DATABASE_URL` from `.env.local` (no new secrets)

## DuckDB data model (match CH to reduce rewrite)

- Create DuckDB view/table shaped like CH `forska.judgments` (derived table in `scripts/clickhouse-setup.sql`).
- Prefer 2 modes (both, same query suite):
  - `duck_scan`: query attached PG tables directly (zero sync; tests the "no PeerDB" pitch)
  - `duck_local`: one-time `CREATE TABLE AS SELECT ...` into a `.duckdb` file (fairer engine vs engine; less network noise)

## Query porting (CH -> DuckDB)

- Start with 3 core queries (highest value):
  - Articles list page query (group-by + having-all-prompts) from `src/services/clickhouse/articlesReviewsClickHouse.ts`
  - Count variant from `src/services/clickhouse/articlesReviewsClickHouse.ts`
  - Filter values query (`answeredOriginal` + array answers) from `src/services/clickhouse/articlesReviewsFiltersClickHouse.ts`
- Then add: numeric filters, unassessed counts/lists, selectArticleIds.

### Dialect map (cheatsheet)

- `sumIf(1, cond)` -> `SUM(CASE WHEN cond THEN 1 ELSE 0 END)`
- `toInt64OrNull(x)` -> `try_cast(x AS BIGINT)`
- `groupArray(x)` -> `list(x)`
- `arrayJoin(list)` -> `UNNEST(list)`
- `hasAny(list, [a,b])` -> `EXISTS (SELECT 1 FROM UNNEST(list) v WHERE v IN (a,b))`
- `any(x)` / `max(x)` -> `any_value(x)` / `max(x)`
- `toDateTime64('..',3)` -> `CAST('..' AS TIMESTAMP)` (treat all times UTC)

## Parallel benchmark harness (logging + correctness)

- Add a bench runner (Bun) that executes the same case on CH + Duck concurrently:
  - `Promise.all([runClickHouse(case), runDuckDb(case)])`
  - warmup + N measured runs; optional multi-pair concurrency for throughput
- Log per-run JSONL to `benchmarks/duckdb-vs-clickhouse/<ts>.jsonl`:
  - `{case, engine, mode, iter, ms, rows, ok, err, startedAt, gitSha}`
- Correctness checks (cheap):
  - row-count + stable sample (first K ids) per query
  - optional full checksum for small resultsets

## Perf instrumentation (optional but useful)

- DuckDB: `PRAGMA enable_profiling='json'` + per-run profiling output file.
- ClickHouse: capture `query_id`, and optionally pull stats from `system.query_log`.

## Runbook (local)

- Ensure services up: Postgres + ClickHouse (+ PeerDB only if you need fresh CH mirror).
- Run bench: `bun --env-file=.env.local scripts/<duck_vs_ch_runner>.ts`
- Produce summary table (p50/p95) from JSONL: `bun scripts/<summarize>.ts`.

## Decision rules

- "Good enough" target (tune later): p95 Duck <= 2x p95 CH for the 3 core queries; correctness == match.
- If `duck_scan` loses but `duck_local` wins: decide if local materialization cadence is acceptable (hourly/daily).

## Risks / gotchas

- `duck_scan` may bottleneck on PG IO/network; measure separately (scan vs aggregate).
- Arrays/jsonb differences: normalize `answered_original_as_array`, `quotes` early in Duck view.
- Running CH+Duck in parallel adds resource contention; keep a `--sequential` mode for "clean" numbers.
