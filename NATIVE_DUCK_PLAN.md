# Native DuckDB plan

this plan is old. see @DUCKDB2_PLAN.md instead
## Goal

- [ ] Run the app on one native DuckDB database only.
- [ ] No SQLite runtime. No legacy analytics runtime. No Postgres runtime after import.
- [ ] Make the Bun server the only writer.
- [ ] Optimize for OLAP speed first; schema may be DuckDB-native and analytics-shaped.
- [ ] Import existing data once from the still-available Postgres DB into the final DuckDB shape.

## Target shape

- [ ] Keep canonical app tables in DuckDB: `user`, `models`, `data_source`, `import_route`, `prompts`, `projects`, `project_prompt`, `articles`, scope/link tables, `judgments_human`, `reviews`, and required job/status tables.
- [ ] Stop serving hot review pages from only normalized transactional tables.
- [ ] Add native DuckDB analytics tables/materializations for hot paths:
  - `judgment_fact`
  - `project_scope_article`
  - `review_article_rollup`
  - optional `prompt_answer_fact` if filters still need it
- [ ] Refresh derived DuckDB tables inside server-owned write workflows or via explicit rebuild commands.

## Step 0 - Freeze contract

- [x] Server-only writer contract: future writes go through one server-owned DB service boundary.
- [x] Native DuckDB contract: hot queries target native DuckDB tables/materializations, not attached SQLite compatibility paths.
- [x] Import contract: Postgres stays read-only and temporary, only for migration.
- [x] ID contract: preserve existing ids and foreign-key meaning where practical.
- [x] Simplicity contract: prefer canonical tables + explicit refresh/rebuild over hidden dual-write behavior.

## Step 1 - Runtime and DB layer

- [x] Add one persistent DuckDB connection/service scaffold for the Bun server.
- [x] Add DuckDB-native bootstrap/helpers/migration scaffolding; live app cutover stays later.
- [x] Create one DB service boundary that owns connection lifecycle and maintenance entry points.
- [x] Keep one local DuckDB file path with env override; no repo-relative default.
- [x] Add operational settings: memory limit, temp directory, checkpoint/maintenance commands.

## Step 2 - Schema redesign

- [x] Rewrite the schema for DuckDB-native types and constraints instead of SQLite compatibility.
- [x] Separate canonical mutable tables from analytics tables/materializations.
- [x] Flatten hot review fields into facts/rollups instead of recomputing them with large joins at read time.
- [x] Revisit JSON/list columns to use DuckDB-native `LIST`/`STRUCT`/`JSON` where it helps analytics.
- [x] Revisit ordering/index strategy for DuckDB; do not blindly port SQLite/Postgres indexes.

## Step 3 - Writer architecture

- [ ] Make the Bun server the only mutation entry point.
- [ ] Refactor agents/importers/cron jobs to call server-owned services/commands instead of writing directly.
- [ ] Reclassify standalone scripts as read-only, import-only, or server-command clients.
- [ ] Ensure writes update canonical tables first, then refresh affected marts/rollups in the same server-owned workflow.
- [ ] Add explicit rebuild commands so correctness does not depend on hidden side effects.

## Step 4 - Import from Postgres

- [x] Audit the old Postgres schema from current code and old commits where needed.
- [x] Map Postgres tables into final DuckDB canonical tables and native marts.
- [x] Build a one-shot importer that preserves ids and relationships.
- [ ] Import core app data first: user config, projects, prompts, models, articles, scope links, judgments, human review data, essential jobs.
- [ ] Rebuild DuckDB-native marts after import instead of importing stale derived tables.
- [x] Emit an import report for dropped, merged, or rewritten fields.

## Step 5 - Query cutover

- [ ] Rewrite review list/count/filter/unassessed/both/human flows to read native DuckDB marts/facts only.
- [ ] Rewrite comparison flows and article-id selection to use the same native tables.
- [ ] Remove the current SQLite-attached DuckDB OLAP layer.
- [x] Remove remaining legacy analytics-shaped assumptions after DuckDB pages pass locally.
- [ ] Re-check large-project latency before moving on.

## Step 6 - Server and API cleanup

- [ ] Rename remaining legacy SQLite/analytics terminology in code and API responses; main OLAP runtime file renames are in progress.
- [ ] Remove helpers that assume SQLite SQL, WAL, `json_each`, or sqlite catalog access.
- [ ] Remove direct DB writes that bypass the new DB service boundary.
- [ ] Keep only maintenance/debug endpoints that still fit the DuckDB-native model.

## Step 7 - Validation

- [ ] Validate single-writer behavior under imports, cron jobs, judging, human review, and admin edits.
- [ ] Validate review/count/filter latency on large imported datasets.
- [ ] Validate crash recovery and full mart rebuild from canonical tables.
- [ ] Run lint, tests, build, and focused end-to-end review flows.

## Step 8 - Final cleanup

- [ ] Remove SQLite runtime code, legacy analytics code, and Postgres runtime code.
- [ ] Keep the Postgres importer only as long as needed for migration/support.
- [ ] Update docs/env/examples to describe the DuckDB-only architecture.
- [ ] Final verify: one DuckDB file, one server writer, native fast review queries.
