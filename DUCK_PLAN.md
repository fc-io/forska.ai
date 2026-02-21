# DuckDB vs ClickHouse (PeerDB replacement) plan

## Goal

- See if DuckDB (+ Postgres extension) can hit ClickHouse-level perf for current analytics queries.
- Keep scope tight: reproduce existing CH queries, run CH+Duck in parallel, log numbers.

## Baseline (what we compare)

- Query sources (current): `src/services/clickhouse/articlesReviewsClickHouse.ts`, `src/services/clickhouse/articlesReviewsFiltersClickHouse.ts`, `src/services/clickhouse/unassessedArticlesClickHouse.ts`, `src/services/clickhouse/selectArticleIdsClickHouse.ts`.
- Existing benchmark example: `scripts/benchmarkCuratedArticles.ts`.
- Benchmark on prod-ish scale (seed data too small); log rowcounts for `judgments`/`articles`.
- CH correctness mode: run with and without `FINAL` (see `CH_USE_FINAL` pattern in `scripts/benchmarkCuratedArticles.ts`).

## DuckDB setup (minimal ops)

- All in docker.
- Preferred shape: DuckDB behind HTTP + bench runner hits both DBs via HTTP (same call path as CH).
- Add compose services (profile `bench`):
  - `duckdb-api`: exposes `POST /query` on `18080`; runs DuckDB native API (`@duckdb/node-api`).
  - `bench-runner`: runs bench script; writes JSONL to mounted `benchmarks/duckdb-vs-clickhouse/`.
- Code entrypoints (suggested):
  - `scripts/duckdbApiServer.ts`
  - `scripts/benchDuckDbVsClickhouse.ts`
  - `scripts/benchDuckDbVsClickhouseSummarize.ts`
- `duckdb-api` contract: `{sql, params?}` -> `{rows, msEngine, duckdbVersion}`.
- DuckDB Postgres extension (inside `duckdb-api`):
  - `INSTALL postgres; LOAD postgres;`
  - `ATTACH getenv('DATABASE_URL') AS pg (TYPE postgres);` (`DATABASE_URL` uses host `db`)
- Compose env (example):
  - `duckdb-api`: `DATABASE_URL=postgresql://${DB_USER:-postgres}:${DB_PASS:-postgres}@db:5432/${DB_NAME:-postgres}`, `DUCK_MODE=duck_scan|duck_local`, `DUCK_FILE=/data/bench.duckdb`
  - `bench-runner`: `DUCKDB_API_URL=http://duckdb-api:18080`, `CLICKHOUSE_URL=http://clickhouse:8123`
- If Bun+NAPI fails: run `duckdb-api` on Node (only this container).

## DuckDB data model (match CH to reduce rewrite)

- Create DuckDB view/table shaped like CH `forska.judgments` (derived table in `scripts/clickhouse-setup.sql`).
- Prefer 2 modes (both, same query suite):
  - `duck_scan`: query attached PG tables directly (zero sync; tests the "no PeerDB" pitch)
  - `duck_local`: one-time `CREATE TABLE AS SELECT ...` into a `.duckdb` file (fairer engine vs engine; less network noise)
- Note: `duck_scan` still streams data from PG into DuckDB (PG is the source; DuckDB runs the query). Pushdown may be partial; log rows/bytes read.
- Smoke SQL (fail fast): verify `ATTACH`, `UNNEST`, `array_length`, `try_cast`, `ILIKE` exist.

## Query porting (CH -> DuckDB)

- Start with 3 core queries (highest value):
  - Articles list page query (group-by + having-all-prompts) from `src/services/clickhouse/articlesReviewsClickHouse.ts`
  - Count variant from `src/services/clickhouse/articlesReviewsClickHouse.ts`
  - Filter values query (`answeredOriginal` + array answers) from `src/services/clickhouse/articlesReviewsFiltersClickHouse.ts`
- Then add: numeric filters, unassessed counts/lists, selectArticleIds.

### Dialect map (cheatsheet)

- `sumIf(1, cond)` -> `SUM(CASE WHEN cond THEN 1 ELSE 0 END)`
- `toInt64OrNull(x)` -> `try_cast(x AS BIGINT)`
- `groupArray(x)` -> `array_agg(x)`
- `arrayJoin(list)` -> `UNNEST(list)`
- `hasAny(list, [a,b])` -> `EXISTS (SELECT 1 FROM UNNEST(list) v WHERE v IN (a,b))`
- `any(x)` / `max(x)` -> `any_value(x)` / `max(x)`
- `toDateTime64('..',3)` -> `CAST('..' AS TIMESTAMP)` (treat all times UTC)
- `length(arr)` -> `coalesce(array_length(arr), 0)`
  - if `array_length` missing: use `len(arr)`

## Parallel benchmark harness (logging + correctness)

- Add a bench runner (Bun) that executes the same case on CH + Duck concurrently:
  - `Promise.all([runClickHouse(case), runDuckDb(case)])`
  - warmup + N measured runs; optional multi-pair concurrency for throughput
- Keep per-engine isolation: separate connections; avoid running 2 DuckDB queries on 1 connection at once.
- Log per-run JSONL to `benchmarks/duckdb-vs-clickhouse/run_<unixMs>.jsonl`:
  - `{case, engine, mode, iter, msTotal, msEngine, rows, ok, err, startedAt, gitSha, meta}`
  - `meta`: `{duckdbVersion, chUseFinal, mirrorLagSec}`
- Correctness checks (cheap):
  - row-count + stable sample (first K ids) per query
  - optional full checksum for small resultsets
- Single-writer JSONL (avoid interleaved writes under parallel).

## Perf instrumentation (optional but useful)

- DuckDB: `PRAGMA enable_profiling='json'` + per-run profiling output file.
- ClickHouse: capture `query_id`, and optionally pull stats from `system.query_log`.

## Runbook (local)

- Pin cases: set `BENCH_PROJECT_ID` (or implement auto-pick by curated size).
- Ensure services up: `docker compose up -d db clickhouse` (+ `--profile peerdb ...` only if you need fresh CH mirror).
- Ensure bench services up: `docker compose --profile bench up -d duckdb-api`.
- Run bench: `docker compose --profile bench run --rm bench-runner`.
- Produce summary table (p50/p95) from JSONL: `bun scripts/benchDuckDbVsClickhouseSummarize.ts`.

## Decision rules

- "Good enough" target (tune later): p95 Duck <= 2x p95 CH for the 3 core queries; correctness == match.
- If `duck_scan` loses but `duck_local` wins: decide if local materialization cadence is acceptable (hourly/daily).

## Risks / gotchas

- "Lag" sources:
  - CH mirror can lag PG (PeerDB CDC); correctness diffs can be sync, not SQL.
  - `duck_local` is a snapshot; refresh cadence matters.
- Mirror lag metric: `mirrorLagSec = now() - max(_peerdb_synced_at)` from CH `articles` + `judgments`.
- If `mirrorLagSec` high: still log perf; mark correctness `ok=false` with `err='mirror_lag'` (or skip compare).
- `duck_scan` may bottleneck on PG IO/network; measure separately (scan vs aggregate).
- Pushdown is not guaranteed; worst case DuckDB pulls lots of base rows.
- Arrays/jsonb differences: normalize `answered_original_as_array`, `quotes` early in Duck view.
- Running CH+Duck in parallel adds resource contention; keep a `--sequential` mode for "clean" numbers.
