# Local-first plan

## Goal

- [ ] App DB: SQLite via `bun:sqlite` + `drizzle-orm/bun-sqlite`.
- [ ] Analytics: DuckDB only; query final SQLite shape; no ClickHouse.
- [ ] No Better Auth. No users. No roles. No owner/ownerId.
- [ ] No bridge. No dual-write. No shadow Postgres. No shadow ClickHouse.

## Step 0 - Freeze contract

- [ ] Keep Drizzle; switch dialect/runtime from Postgres to Bun SQLite.
- [ ] SQLite types: ids=`text`; timestamps=`integer` unix ms; booleans=`integer`; enums=`text`; json/arrays=`text` JSON.
- [ ] Server/client contract drops `ownerId`, `userId`, `sessionId`, `reviewerId`, `assessedBy`.
- [ ] PDF manual-vs-fetched state comes from `articles.fullTextSource`, not a user FK.

## Step 1A - DB core (`src/server/utils/**`, `drizzle*.ts`, env)

- [ ] Replace `drizzle-orm/node-postgres` with `drizzle-orm/bun-sqlite`.
- [ ] Add Bun SQLite connection helper; set `journal_mode=WAL`, `foreign_keys=ON`, `synchronous=NORMAL`, `busy_timeout`.
- [ ] Replace `DATABASE_URL` with `SQLITE_PATH`.
- [ ] Remove Postgres-only DB config, helpers, scripts, docs.

## Step 1B - Schema rewrite (`src/db/schema.ts`, delete `auth-schema.ts`)

- [ ] Rewrite `pgTable`/`pgEnum`/`pgView` to SQLite schema.
- [ ] Drop tables: `user`, `session`, `account`, `verification`, `datasource_access`, `model_access`.
- [ ] Drop columns: `models.ownerId`, `dataSource.ownerId`, `projects.ownerId`, `comparisonProject.ownerId`, `prompts.ownerId`.
- [ ] Drop columns: `articles.importedBy`, `articles.fullTextPdfUploadedBy`, `tokenUse.userId`, `tokenUse.sessionId`, `reviews.reviewerId`, `judgmentAssessments.assessedBy`.
- [ ] Replace `judgmentsHuman.user` with single-user shape; unique key becomes `(projectId, articleId, promptId)`.
- [ ] Replace per-review user shape; `reviews` keyed by `(projectId, articleId)` only if table stays.
- [ ] Collapse job pause status: `paused_by_admin` + `paused_by_user` -> `paused`.
- [ ] Store arrays/json as JSON text: `articles.articleAuthors`, `articles.fullTextAssets`, `articles.originalData`, `models.workerUrls`, `comparisonProject.modelIds`, `judgmentsJobs.error`, `tokenUse.failedRequestsDetails`.
- [ ] Rebuild all indexes for SQLite; keep judgment dedupe on `(articleId, promptId, modelId, useTitle, useAbstract, useFulltext, useFulltextNoImages)` for non-deleted rows.

## Step 1C - Auth removal (`src/auth.ts`, `src/app/lib/**`, `src/services/**`, `src/server/routes/AuthRoutes.ts`)

- [ ] Delete Better Auth server/client code.
- [ ] Delete `authGuard`; stop deriving `session`, `sessionUserId`, local fallback user.
- [ ] Delete login/signout/session fetch flows.
- [ ] Remove Better Auth deps, scripts, env vars, seeds.

## Step 1D - Server contract cleanup (`src/server/routes/**`, `src/server/services/**`)

- [ ] Remove auth/owner/user joins, filters, guards, route params, body fields.
- [ ] Delete `UsersRoutes`.
- [ ] Remove user-scoped create/update logic; server fills no owner fields.
- [ ] Remove compare-by-user / overview-both-users flows or rewrite to single-user equivalents.

## Step 1E - Client cleanup (`src/app/**`, `src/components/**`)

- [ ] Remove session queries, auth client use, login UI, signout UI, user menu.
- [ ] Remove owner/user fields from forms, mutations, filters, tables.
- [ ] Remove uploader-name UI; show source from article metadata only.
- [ ] Remove admin-vs-user wording that no longer means anything.

## Step 2A - App DB port (`src/server/**`)

- [ ] Port all routes/services to SQLite Drizzle types and SQLite SQL semantics.
- [ ] Replace Postgres-only SQL/operators/defaults with SQLite-safe equivalents.
- [ ] Remove code that depends on auth tables, owner fields, session fields.

## Step 2B - DuckDB cutover (`src/services/olap/**`, delete `src/services/clickhouse/**`)

- [ ] Add DuckDB query runner.
- [ ] Query final SQLite DB directly from DuckDB; no replicated analytics store.
- [ ] Port analytics queries: reviews list/count/filters, unassessed list/count, article id selection, remaining comparison flows.
- [ ] Delete ClickHouse client, schema/bootstrap, sync/rebuild jobs, env vars, docs, containers in same cut.

## Step 2C - One-shot migration + cleanup (`scripts/**`, docs)

- [ ] Add one-shot importer: current Postgres -> final SQLite schema.
- [ ] Import into final shape only; no compatibility columns, no runtime bridge.
- [ ] Delete obsolete Postgres/ClickHouse/Better Auth scripts after cutover path exists.
- [ ] Update docs to local-first setup only.

## Step 3 - Cutover

- [ ] Generate SQLite migrations with Drizzle.
- [ ] Run one-shot import on a DB snapshot.
- [ ] Start app on SQLite + DuckDB only.
- [ ] Remove old deps/codepaths before merge: Postgres, ClickHouse, Better Auth.
- [ ] Verify: cold start empty DB, migrate existing data, import articles, upload PDF, run job, review judgments, analytics pages, `bun run lint`, `bun test`, `bun run build`.
