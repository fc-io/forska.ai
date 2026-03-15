# DuckDB2 plan

Goal: remove the legacy analytics path only after DuckDB matches the old contract, then finish DuckDB-only cleanup so no SQLite runtime or auth requirement remains.

## Rules

- [ ] Match the old analytics contract first. No cleanup/behavior changes in same pass.
- [ ] Add parity tests before deleting legacy analytics codepaths.
- [ ] Keep response shape, ordering, paging, error behavior identical.
- [ ] Keep scope/filter/group/having/order/pagination in DuckDB SQL where the old analytics path did SQL-first work.

## `src/services/olap/duckdbOlap.ts`

- [x] Reviews/count parity: fix `modelId: null`, empty `totalCount`/`totalPages`, prompt-order ties, error contract.
- [x] Filters parity: fix answer parsing parity, numeric parsing parity, empty/error contract.
- [x] Both parity: fix page echo, null-date ordering, curated `>1000` behavior, missing-article fallback.
- [x] Unassessed parity: fix param usage, zero-judgment behavior, missing-model behavior, cursor semantics.
- [x] Selection parity: fix `llm`/`human`/`both` filter semantics, ordering, `modelId: null` behavior.
- [x] Pushdown: remove JS-heavy materialization/filter/pagination where the old analytics path did SQL-first work.

## Tests

- [x] Add `src/services/olap/duckdbOlap.test.ts` with parity fixtures for reviews, count, filters, both, unassessed, selection.
- [x] Add route regressions for old analytics-backed behavior still visible at API layer.
- [x] Delete legacy analytics-only tests after cutover.

## Active Legacy Runtime Blockers

- [x] Do not spend time optimizing admin-only paths beyond correctness; keep performance work focused on review/import/runtime paths users hit often.
- [x] `src/server/routes/SubprojectsRoutes.ts`: remove direct legacy fast-path after OLAP parity covers prompt-filter selection.
- [x] `src/server/routes/AdminImportRouteStatsRoutes.ts`: rewrite from SQLite/DuckDB or delete with `src/app/routes/+admin/+import-route-stats/**`.
- [x] `src/server/routes/AdminInvestigateRoutes.ts`: delete or redesign with `src/app/routes/+admin/+diagnose-unassessed/+index.tsx`; stop old diff payload.
- [x] `src/server/routes/AdminClickhouseHealthRoutes.ts`: delete unless a DuckDB health route is still wanted.
- [x] `src/app/routes/+admin/+legacy-sync/**`: delete; regenerate `src/app/routeTree.gen.ts`.

## Final removal

- [x] Delete the legacy analytics service layer.
- [x] Remove the old analytics toggle from env/runtime wrappers.
- [x] Remove old analytics deps from `package.json` and lockfile.
- [x] Remove old analytics infra/docs: `docker-compose.yml`, legacy analytics scripts/config, and old analytics plans/docs.
- [x] Delete legacy analytics-only tests after all callers are migrated.

## DuckDB-only runtime cleanup

- [x] Replace `src/server/utils/getDatabase.ts` SQLite runtime (`bun:sqlite`, `drizzle-orm/bun-sqlite`) with the native DuckDB app DB service boundary.
- [x] Remove the temporary `getDatabase` compatibility bridge and its test shim once runtime callers are gone.
- [x] Remove SQLite attach usage from `src/services/olap/duckdbRunner.ts`; query one native DuckDB database only.
- [x] Rewrite remaining `src/services/olap/duckdbOlap.ts` fallbacks that still read via `getDatabase()`/Drizzle to use native DuckDB tables or marts directly.
- [x] Replace/remove old SQLite predicate helpers and callers with DuckDB-safe helpers; remove `json_each`/`json_array`/SQLite-specific SQL assumptions.
- [x] Port remaining `getDatabase()` callers in routes/services/cron/jobs to DuckDB-backed access; runtime routes/cron/agent callers are off the bridge now.
- [x] Rename SQLite-era OLAP/runtime helper files to DuckDB/neutral names (`duckdbOlap`, removed old predicate helper file).
- [x] Remove `SQLITE_PATH` and other SQLite runtime config from `src/server/utils/env.ts`, `package.json`, and operational docs.

## Mart freshness

- [x] Add a queue-backed incremental mart refresh service for canonical writes; keep chunked full rebuilds as the repair/bootstrap path.
- [x] Hook key judgment, human-assessment, project-scope, and prompt-admin write paths into the mart refresh queue.

## Auth removal

- [x] Decide the no-auth runtime contract: single local actor/system actor, no login/session requirement, and a replacement for any current user-derived audit fields.
- [x] Inventory current no-auth bridge/runtime callers: `src/auth.ts`, `src/server/utils/getLocalUser.ts`, `src/server/routes/UsersRoutes.ts`, `src/server/routes/HumanAssessmentRoutes/humanAssessmentRoutesGetOverview.ts`, `src/server/routes/projectsRoutes/projectsRoutesPostArticleReviewDetails.ts`, `src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostOpenalex.ts`.
- [x] Inventory remaining Better Auth/schema/tooling leftovers: `auth-schema.ts`, `src/seedAuth.ts`, `src/seed.ts`, `scripts/resetPassword.ts`, `drizzle.alvis2.config.ts`, `src/server/utils/env.ts`, `package.json`, `docs/README_RUN_REMOTE.md`, `docs/README_SBATCH.md`.
- [x] Remove Better Auth middleware/routes/session checks from server code and replace current user/session lookups with the chosen no-auth actor model.
- [ ] Remove auth-gated UI flows, redirects, and user-management screens that only exist for login/session management; settings now reads the system actor/env only.
- [x] Remove Better Auth tables/migrations/scripts/env vars after runtime code no longer depends on them.
- [x] Remove Better Auth deps from `package.json` and lockfile, then re-check review/import/admin write flows under the no-auth model.
