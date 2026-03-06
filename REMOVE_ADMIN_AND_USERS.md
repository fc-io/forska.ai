# Remove admin role + users

## Step 1: Docs + goals (local-first)

- [ ] Sweep docs: `README.md`, `CLAUDE.md`, `AGENTS.md`, `docs/**`, `*PLAN*.md`
- [ ] Remove admin goal/wording; stop treating `/admin/*` as privileged area
- [ ] State new target: standalone local app; single-user; local-first storage; hosted/multi-tenant not a goal
- [ ] Align roadmaps: `SQLITE_PLAN.md` + `DUCK_PLAN.md` reinforce local-first (SQLite app DB, DuckDB analytics)

## Step 2: Admin-free (keep Better Auth + multi-user)

- [ ] Remove Better Auth admin plugin: `src/auth.ts` (drop `admin()`), `src/app/lib/auth-client.ts` (drop `adminClient()`)
- [ ] Remove role field usage everywhere (no `session.user.role`, no `'admin'` string checks)
- [ ] Auth guard: delete `requireAdminAuth` + all 403/"Administrator" paths; keep only "signed in" guard (`src/server/utils/authGuard.ts`)
- [ ] Server routes: replace `.use(requireAdminAuth())` -> `.use(requireUserAuth())`:
  - `src/server/routes/ArticlesRoutes.ts`
  - `src/server/routes/ArticleAdminRoutes.ts` (also delete inline role check)
  - `src/server/routes/JudgmentsJobsRoutes.ts`
  - `src/server/routes/TokensRoutes.ts`
  - `src/server/routes/AdminSyncStatsRoutes.ts`
  - `src/server/routes/AdminImportRouteStatsRoutes.ts`
  - `src/server/routes/AdminClickhouseHealthRoutes.ts`
  - `src/server/routes/DataSourcesRoutes.ts`
  - `src/server/routes/DataSourcesImportRoutes.ts`
  - `src/server/routes/ModelsRoutes.ts` (gpu-info subrouter)
  - `src/server/routes/ProjectsRoutes.ts` (projects-without-jobs subrouter)
  - `src/server/routes/ImportRoutes.ts` ("importroutes" admin endpoint)
  - `src/server/routes/PromptsRoutes.ts` (promptsAdminRoutes + `userRole === 'admin'` bypass)
  - `src/server/routes/JudgmentsRoutes.ts`
  - `src/server/routes/UsersRoutes.ts` (list users endpoint)
  - `src/server/routes/LlmStatusRoutes.ts`
  - `src/server/routes/NvidiaSmiRoutes.ts`
  - `src/server/routes/AaModelsRoutes.ts`
  - `src/server/routes/HumanAssessmentRoutes.ts` + `src/server/routes/HumanAssessmentRoutes/*`
- [ ] Client: remove all `isAdmin()` gates + "Administrator access required" UI blocks
  - `src/components/Navigation.tsx` (no admin-only menu; rename label)
  - `src/app/routes/+admin/**` (accessible to all signed-in)
  - `src/app/routes/+admin/+users/+index.tsx` (remove role UI; remove "make admin" actions)
  - `src/app/routes/+projects/**` + `src/app/routes/+articles/**` (admin-only sections show for all)
  - `src/components/main/articles/articleAdminSection.tsx` (rename / stop calling "admin" endpoints if renamed)
- [ ] Decide: keep URL `/admin/*` + `/api/admin/*` (but public) vs rename to `/tools/*` + `/api/tools/*` (recommended: rename)
- [ ] Optional cleanup: remove/rename user-facing strings/enums containing "admin" (eg `paused_by_admin`, labels)
- [ ] Verify: `bun run lint`, `bun test`, manual smoke (login, open all former admin pages, run one job, edit prompts)

## Step 3: Single-user local app (no Better Auth, no users)

- [ ] Security posture: local-only server bind (default) vs shared token (if exposing beyond localhost)
- [ ] Remove Better Auth fully:
  - deps + scripts: `better-auth`, `@better-auth/cli`, `@better-auth-kit/seed`, `db:ba-*`, `db:seed-auth`
  - server: delete `src/auth.ts`, `src/utils/auth.ts`, delete `src/server/routes/AuthRoutes.ts`, delete auth cookie/session parsing in `src/server/utils/authGuard.ts`
  - client: delete `src/app/lib/auth-client.ts`, delete `src/services/fetchSession.ts`, delete login flow (`src/components/login.tsx`, redirect/signout logic in `src/app/routes/+__root.tsx`), remove password/settings flows that call auth
  - scripts/seed: delete/replace `scripts/resetPassword.ts`, remove Better Auth seeding (`src/seed.ts`, `src/seedAuth.ts`)
- [ ] Env: remove `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` from `src/server/utils/env.ts` (+ docs)
- [ ] DB: remove auth tables + all FK references (or keep columns as plain `text` without FK)
  - tables to remove: `user`, `session`, `account`, `verification` (`auth-schema.ts`)
  - schema touchpoints: `src/db/schema.ts`, `src/server/utils/getDatabase.ts`, `drizzle.config.ts`, `drizzle.alvis2.config.ts`, `src/seedAuth.ts`
  - columns to decide (drop vs keep-as-text): `*.ownerId`, `articles.importedBy`, `articles.fullTextPdfUploadedBy`, `judgmentsHuman.user`, `tokenUse.userId`, `tokenUse.sessionId`, `reviews.reviewerId`, `judgmentAssessments.assessedBy`, access tables (`datasource_access`, `model_access`)
- [ ] Server: remove all `sessionUserId` requirements + owner scoping; stop `leftJoin(user, ...)` in routes (eg `src/server/routes/DataSourcesRoutes.ts`)
- [ ] Client: remove any UI showing user id/owner id; create flows stop requiring `ownerId` in request bodies (or server fills default)
- [ ] Migration path: existing DB -> single-user (data keep rules, one-time backfill, drop FKs/tables)
- [ ] Verify: cold start on empty DB; upgrade from existing DB; `bun run lint`, `bun test`

## Related

- `SQLITE_PLAN.md` (if combining step 2 with SQLite + Drizzle removal)
- `DUCK_PLAN.md`
