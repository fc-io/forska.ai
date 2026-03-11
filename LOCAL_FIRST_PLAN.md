# Local-first plan

## Goal

- [ ] App DB: SQLite via `bun:sqlite` + `drizzle-orm/bun-sqlite`.
- [ ] Analytics: DuckDB only; query final SQLite shape; no ClickHouse at runtime.
- [ ] No Better Auth. No users. No roles. No owner/ownerId.
- [ ] No bridge. No dual-write. No shadow Postgres. No shadow ClickHouse.
- [ ] Keep old Docker/Postgres/ClickHouse stack runnable on same machine until final step; Docker/deploy breakage last.

## Step 0 - Freeze contract

- [ ] Keep Drizzle; switch app runtime/dialect to Bun SQLite.
- [ ] SQLite types: ids=`text`; timestamps=`integer` unix ms; booleans=`integer`; enums=`text`; json/arrays=`text` JSON.
- [ ] `fullTextSource` contract: manual iff `user_upload`; fetched iff non-null and != `user_upload`.
- [ ] Server/client contract drops `ownerId`, `userId`, `sessionId`, `reviewerId`, `assessedBy`.
- [ ] Human/review single-user contract: no per-user rows at runtime; importer resolves collisions deterministically and reports them.
- [ ] Token-use contract: no session lookup; client/server writes app/job-scoped rows only.
- [ ] Keep existing Docker env/compose/build files untouched until final cleanup.

## Step 1A - DB core (`src/server/utils/**`, `drizzle*.ts`, env)

- [ ] Add Bun SQLite connection helper; set `journal_mode=WAL`, `foreign_keys=ON`, `synchronous=NORMAL`, `busy_timeout`.
- [ ] Add `SQLITE_PATH`; local-first code reads it; keep `DATABASE_URL` for old stack until final cleanup.
- [ ] Switch app DB wiring from `drizzle-orm/node-postgres` to `drizzle-orm/bun-sqlite`.
- [ ] Use separate SQLite Drizzle migration lineage/meta; do not reuse current Postgres journal.
- [ ] Stop merging `auth-schema.ts` into DB bootstrap.

## Step 1B - Schema rewrite (`src/db/schema.ts`, `auth-schema.ts`, migrations)

- [ ] Rewrite `pgTable`/`pgEnum`/`pgView` to SQLite schema.
- [ ] Drop tables: `user`, `session`, `account`, `verification`, `datasource_access`, `model_access`.
- [ ] Drop columns: `models.ownerId`, `dataSource.ownerId`, `projects.ownerId`, `comparisonProject.ownerId`, `prompts.ownerId`.
- [ ] Drop columns: `articles.importedBy`, `articles.fullTextPdfUploadedBy`, `tokenUse.userId`, `tokenUse.sessionId`, `reviews.reviewerId`, `judgmentAssessments.assessedBy`.
- [ ] `judgmentsHuman`: drop user dimension; unique key `(projectId, articleId, promptId)`.
- [ ] `reviews`: drop reviewer dimension; unique key `(projectId, articleId)` if table stays.
- [ ] `judgmentAssessments`: if table stays, single-user shape only.
- [ ] Collapse job pause status: `paused_by_admin` + `paused_by_user` -> `paused`.
- [ ] Store arrays/json as JSON text: `articles.articleAuthors`, `articles.fullTextAssets`, `articles.originalData`, `models.workerUrls`, `comparisonProject.modelIds`, `judgmentsJobs.error`, `judgments.answeredOriginalAsArray`, `judgments.quotes`, `tokenUse.failedRequestsDetails`, `llmStatus.*Seconds`.
- [ ] Rebuild SQLite indexes; keep judgment dedupe on `(articleId, promptId, modelId, useTitle, useAbstract, useFulltext, useFulltextNoImages)` for non-deleted rows.
- [ ] Replace/drop Postgres-only views, triggers, hash functions, GIN/partial indexes.

## Step 1C - Auth removal (`src/auth.ts`, `src/app/lib/**`, `src/services/**`, `src/server/routes/**`)

- [ ] Delete Better Auth server/client code.
- [ ] Delete `authGuard`; stop deriving `session`, `sessionUserId`, local fallback user.
- [ ] Delete login/signout/session fetch flows and root-route redirects.
- [ ] Delete `UsersRoutes`.
- [ ] Remove Better Auth deps/scripts/seeds at final cleanup, not before.

## Step 1D - Server contract cleanup (`src/server/routes/**`, `src/server/services/**`)

- [ ] Remove auth/owner/user joins, filters, guards, route params, body fields.
- [ ] Remove user-scoped create/update logic; server fills no owner fields.
- [ ] Rewrite human-assessment/review flows to single-user shape; delete both-user flows.
- [ ] Rewrite token routes and agent token logging to no-session contract.
- [ ] Replace Postgres-only SQL/operators/functions with SQLite-safe equivalents.

## Step 1E - Client cleanup (`src/app/**`, `src/components/**`)

- [ ] Remove session queries, auth client use, login UI, signout UI, user menu.
- [ ] Remove owner/user fields from forms, mutations, filters, tables.
- [ ] Remove uploader-name UI; show manual/fetched state from `fullTextSource`.
- [ ] Remove admin-vs-user wording that no longer means anything.
- [ ] Remove ClickHouse/admin sync UI only after local-first replacement exists or page is intentionally dropped.

## Step 2A - App DB port (`src/server/**`, `src/db/**`)

- [ ] Port all routes/services to SQLite Drizzle types and SQLite timestamp/json semantics.
- [ ] Replace raw PG array logic, casts, `ILIKE`, `ANY`, `date_bin`, `date_trunc`, trigger assumptions, view assumptions.
- [ ] Rewrite judgment-job cursor/storage away from ClickHouse-shaped cursor fields.
- [ ] Verify prompt hash/immutability behavior in app code or SQLite-safe DB logic.

## Step 2B - DuckDB cutover (`src/services/olap/**`)

- [ ] Add DuckDB query runner.
- [ ] Query final SQLite DB directly from DuckDB; no replicated analytics store.
- [ ] Port analytics queries: reviews list/count/filters, unassessed list/count, article id selection, remaining comparison flows.
- [ ] Keep ClickHouse code/env/routes untouched until DuckDB pages pass locally.
- [ ] Remove ClickHouse codepaths in final cleanup, not before.

## Step 2C - One-shot migration + local-first validation (`scripts/**`, docs)

- [ ] Add one-shot importer: current Postgres -> final SQLite schema.
- [ ] Import into final shape only; no compatibility columns, no runtime bridge.
- [ ] Importer resolves single-user collisions deterministically and emits a report.
- [ ] Validate: empty SQLite boot, import snapshot, import articles, upload PDF, run job, review judgments, analytics pages.
- [ ] Run `bun run lint`, `bun test`, `bun run build`.

## Step 3 - Local-first cutover

- [ ] Start app locally on SQLite + DuckDB only.
- [ ] Keep old Docker/Postgres/ClickHouse stack runnable on same machine during this step.
- [ ] Verify local-first branch works end-to-end before touching Docker/deploy files.

## Step 4 - Old stack cleanup (last; Docker/deploy breakage allowed)

- [ ] Remove old deps/codepaths: Postgres, ClickHouse, Better Auth.
- [ ] Update `docker-compose.yml`, `Dockerfile*`, docker build scripts, GHCR/apptainer docs, env examples.
- [ ] Remove old server routes/admin pages/scripts/docs for ClickHouse/Postgres/Better Auth.
- [ ] Update docs to local-first setup only.
- [ ] Final verify after cleanup: local-first app still boots and old-stack-specific files are gone.
