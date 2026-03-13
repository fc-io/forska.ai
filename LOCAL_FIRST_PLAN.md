# Local-first plan

## Goal

- [ ] App DB: SQLite via `bun:sqlite` + `drizzle-orm/bun-sqlite`.
- [ ] Default SQLite path lives outside repo/worktree/Dropbox in shared OS app-data dir.
- [ ] Default shared SQLite path: macOS `~/Library/Application Support/Forska/forska.sqlite`; Linux `${XDG_DATA_HOME:-~/.local/share}/forska/forska.sqlite`; Windows `%LOCALAPPDATA%\\Forska\\forska.sqlite`.
- [ ] Analytics: DuckDB only; query final SQLite shape; no ClickHouse at runtime.
- [ ] No Better Auth. Single local `user` row only; no sessions, no roles, no owner/ownerId.
- [ ] Move user/app config now in `.env.local` into SQLite `user`; keep env for secrets + external/runtime values only.
- [ ] Keep `SQLITE_PATH` override for bootstrap/runtime; no hardcoded repo-relative DB path.
- [ ] Store user-chosen non-bootstrap custom filesystem paths on SQLite `user` config.
- [ ] No bridge. No dual-write. No shadow Postgres. No shadow ClickHouse.
- [ ] Keep old Docker/Postgres/ClickHouse stack runnable on same machine until final step; Docker/deploy breakage last.

## Step 0 - Freeze contract

- [x] Keep Drizzle; switch app runtime/dialect to Bun SQLite.
- [x] SQLite types: ids=`text`; timestamps=`integer` unix ms; booleans=`integer`; enums=`text`; json/arrays=`text` JSON.
- [x] `fullTextSource` contract: manual iff `user_upload`; fetched iff non-null and != `user_upload`.
- [x] Server/client contract drops `ownerId`, `userId`, `sessionId`, `reviewerId`, `assessedBy`.
- [x] Config contract: SQLite `user` table is source of truth for local user config; `.env.local` is not.
- [ ] SQLite path contract: compatible worktrees may share one DB file only by pointing to same path; schema-divergent worktrees use separate `SQLITE_PATH`.
- [ ] Bootstrap path contract: DB path resolved before DB open; keep it runtime/env, not inside SQLite `user`.
- [ ] Human/review single-user contract: no per-user rows at runtime; importer resolves collisions deterministically and reports them.
- [x] Token-use contract: no session lookup; client/server writes app/job-scoped rows only.
- [x] Keep existing Docker env/compose/build files untouched until final cleanup.

## Step 1A - DB core (`src/server/utils/**`, `drizzle*.ts`, env)

- [x] Add Bun SQLite connection helper; set `journal_mode=WAL`, `foreign_keys=ON`, `synchronous=NORMAL`, `busy_timeout`.
- [x] Add `SQLITE_PATH`; local-first code reads it; keep `DATABASE_URL` for old stack until final cleanup.
- [ ] Replace repo-relative SQLite fallback with cross-platform OS app-data default path resolver.
- [ ] Create parent dir cross-platform; no macOS-only or slash-only path assumptions.
- [x] Local-first path reads user config from SQLite `user`; env keeps secrets + external/runtime values only.
- [x] Switch app DB wiring from `drizzle-orm/node-postgres` to `drizzle-orm/bun-sqlite`.
- [x] Use separate SQLite Drizzle migration lineage/meta; do not reuse current Postgres journal.
- [x] Stop merging `auth-schema.ts` into DB bootstrap.

## Step 1B - Schema rewrite (`src/db/schema.ts`, `auth-schema.ts`, migrations)

- [x] Rewrite `pgTable`/`pgEnum`/`pgView` to SQLite schema.
- [x] Rewrite `user` into single-user config table; move `.env.local` user/app config into columns here.
- [x] Drop tables: `session`, `account`, `verification`, `datasource_access`, `model_access`.
- [x] Drop columns: `models.ownerId`, `dataSource.ownerId`, `projects.ownerId`, `comparisonProject.ownerId`, `prompts.ownerId`.
- [x] Drop columns: `articles.importedBy`, `articles.fullTextPdfUploadedBy`, `tokenUse.userId`, `tokenUse.sessionId`, `reviews.reviewerId`, `judgmentAssessments.assessedBy`.
- [x] `judgmentsHuman`: drop user dimension; unique key `(projectId, articleId, promptId)`.
- [x] `reviews`: drop reviewer dimension; unique key `(projectId, articleId)` if table stays.
- [x] `judgmentAssessments`: if table stays, single-user shape only.
- [x] Collapse job pause status: `paused_by_admin` + `paused_by_user` -> `paused`.
- [x] Store arrays/json as JSON text: `articles.articleAuthors`, `articles.fullTextAssets`, `articles.originalData`, `models.workerUrls`, `comparisonProject.modelIds`, `judgmentsJobs.error`, `judgments.answeredOriginalAsArray`, `judgments.quotes`, `tokenUse.failedRequestsDetails`, `llmStatus.*Seconds`.
- [x] Day 1 SQLite indexes: no optional secondary indexes. Keep only PKs + required uniques: `articles.articleId`, `importRoute.route`, `datasourceRouteLink(dataSourceId, importRouteId)`, `projectRouteLink(projectId, importRouteId)`, `articleRouteLink(articleId, importRouteId)`, `comparisonProjectRouteLink(comparisonProjectId, importRouteId)`, `projectPrompts(projectId, promptId)`, `comparisonProjectPrompt(comparisonProjectId, promptId)`, `projectArticles(projectId, articleId)`, `prompts.contentHash`, `judgmentsJobsPrompts(articleId, promptId, jobId)`, judgment dedupe unique on `(articleId, promptId, modelId, useTitle, useAbstract, useFulltext, useFulltextNoImages)` for non-deleted rows, `judgmentsHuman(projectId, articleId, promptId)`, `reviews(projectId, articleId)`, `judgmentAssessments(judgmentId)`.
- [ ] Deferred SQLite parity indexes: current PG `articles_*`, `import_route.active`, non-unique `datasource_route_link_*`, non-unique `project_route_link_*`, non-unique `article_route_link_*`, `comparison_project_*`, non-unique `comparison_project_route_link_*`, non-unique `project_prompts_*`, non-unique `comparison_project_prompt_*`, non-unique `judgments_*`, non-unique `judgments_human_*`, non-unique `project_articles_*`, `token_use_*`, `llm_status_*`, `nvidia_smi_*`.
- [ ] Never port PG-only auth/owner/access indexes: `*_owner_idx`, `datasource_access_*`, `model_access_*`, `session_token_unique`, `user_email_unique`.
- [ ] Replace/drop Postgres-only views, triggers, hash functions, GIN/partial indexes.

## Step 1C - Auth removal (`src/auth.ts`, `src/app/lib/**`, `src/services/**`, `src/server/routes/**`)

- [x] Delete Better Auth server/client code.
- [x] Delete `authGuard`; stop deriving `session`/`sessionUserId`; load single local `user` config row explicitly.
- [x] Delete login/signout/session fetch flows and root-route redirects.
- [x] Delete auth `UsersRoutes`; keep only local user-config CRUD if needed.
- [ ] Remove Better Auth deps/scripts/seeds at final cleanup, not before.

## Step 1D - Server contract cleanup (`src/server/routes/**`, `src/server/services/**`)

- [x] Remove auth/owner/user joins, filters, guards, route params, body fields.
- [x] Remove user-scoped create/update logic; server fills no owner fields.
- [x] Replace server reads of user config from env with reads from single SQLite `user` row.
- [x] Rewrite human-assessment/review flows to single-user shape; delete both-user flows.
- [x] Rewrite token routes and agent token logging to no-session contract.
- [ ] Replace Postgres-only SQL/operators/functions with SQLite-safe equivalents.

## Step 1E - Client cleanup (`src/app/**`, `src/components/**`)

- [x] Remove session queries, auth client use, login UI, signout UI, user menu.
- [x] Remove owner/user fields from forms, mutations, filters, tables.
- [x] Remove uploader-name UI; show manual/fetched state from `fullTextSource`.
- [x] Remove admin-vs-user wording that no longer means anything.
- [ ] Remove ClickHouse/admin sync UI only after local-first replacement exists or page is intentionally dropped.

## Step 2A - App DB port (`src/server/**`, `src/db/**`)

- [x] Port all routes/services to SQLite Drizzle types and SQLite timestamp/json semantics.
- [x] Replace raw PG array logic, casts, `ILIKE`, `ANY`, `date_bin`, `date_trunc`, trigger assumptions, view assumptions.
- [x] Rewrite judgment-job cursor/storage away from ClickHouse-shaped cursor fields.
- [x] Verify prompt hash/immutability behavior in app code or SQLite-safe DB logic.

## Step 2B - DuckDB cutover (`src/services/olap/**`)

- [x] Add DuckDB query runner.
- [x] Query final SQLite DB directly from DuckDB; no replicated analytics store.
- [x] Port analytics queries: reviews list/count/filters, unassessed list/count, article id selection, remaining comparison flows.
- [ ] Keep ClickHouse code/env/routes untouched until DuckDB pages pass locally.
- [ ] Remove ClickHouse codepaths in final cleanup, not before.

## Step 2C - One-shot migration + local-first validation (`scripts/**`, docs)

- [x] Add one-shot importer: current Postgres -> final SQLite schema.
- [x] Import current Postgres app data into SQLite final shape: `articles`, `judgments`, `projects`, `projectArticles`, `projectPrompts`, `prompts`, `models`, `dataSource`, `comparisonProject`, related link tables, reviews/human-assessment data, and job/token tables that still matter locally.
- [x] Preserve ids and foreign-key relationships during import so existing project/article/judgment references still work after cutover.
- [x] Add one-shot config bootstrap: current `.env.local` user/app config -> SQLite `user` row.
- [x] Import into final shape only; no compatibility columns, no runtime bridge.
- [x] Importer resolves single-user collisions deterministically and emits a report.
- [x] Import lean by default: no optional secondary indexes during import; add deferred parity indexes only after real need/profiling.
- [ ] After import, move SQLite DB from worktree/repo temp path to shared OS app-data path outside Dropbox; print final path.
- [ ] Document how other compatible worktrees point to same shared DB; schema-divergent worktrees use separate `SQLITE_PATH`.
- [ ] Validate: empty SQLite boot, import snapshot, import articles, upload PDF, run job, review judgments, analytics pages.
- [x] Run `bun run lint`, `bun test`, `bun run build`.

## Step 2D - Script port (`scripts/**`, legacy DB tooling)

- [ ] Audit old DB scripts and classify them: SQLite-ready, Postgres-only legacy, needs rewrite, or safe to delete at final cleanup.
- [ ] Convert the scripts we still need in local-first mode to SQLite/`SQLITE_PATH` instead of Postgres/`DATABASE_URL`.
- [ ] Update script internals to use Bun SQLite or SQLite-safe Drizzle codepaths; remove `pg` client assumptions where the script is meant to survive cutover.
- [ ] Keep explicitly old-stack scripts available for the old Docker/Postgres stack until final cleanup, but label them clearly as legacy.
- [ ] Add at least one importer/support script path for moving old Postgres data into SQLite without runtime dual-write.

## Step 3 - Local-first cutover

- [ ] Start app locally on SQLite + DuckDB only.
- [ ] Keep old Docker/Postgres/ClickHouse stack runnable on same machine during this step.
- [ ] Validate shared-path workflow: two compatible worktrees on one machine, one shared SQLite file.
- [ ] Validate override workflow: custom `SQLITE_PATH` still works.
- [ ] Validate path bootstrap/docs for macOS, Linux, Windows.
- [ ] Verify local-first branch works end-to-end before touching Docker/deploy files.

## Step 4 - Old stack cleanup (last; Docker/deploy breakage allowed)

- [ ] Remove old deps/codepaths: Postgres, ClickHouse, Better Auth.
- [ ] Update `docker-compose.yml`, `Dockerfile*`, docker build scripts, GHCR/apptainer docs, env examples.
- [ ] Remove old server routes/admin pages/scripts/docs for ClickHouse/Postgres/Better Auth.
- [ ] Update docs to local-first setup only, incl. per-OS default SQLite path + override instructions.
- [ ] Final verify after cleanup: local-first app still boots and old-stack-specific files are gone.
