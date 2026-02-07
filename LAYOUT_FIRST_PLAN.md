# Layout First Plan

Target

- fastest possible layout: header + section containers first
- data later: async fill / update; keep UI interactive; no full-page spinner for slow APIs

Parents' creed (Ryan Carniato x Tanner Linsley)

- [ ] Solid: fine-grain; never read async data unguarded; shell first
- [ ] TanStack: explicit queries; stable keys; suspense scoped; cache used intentionally

Global checklist (apply everywhere)

- [x] never let queries suspend root `<Outlet />` (no “one big `<Suspense>`” around app content)
- [ ] per query: either local `<Suspense fallback=...>` wraps FIRST read OR set `suspense: false` + explicit loading UI
- [x] no `<Suspense>` without `fallback`
- [x] client network only via TanStack (`useQuery`/`createMutation`/`useMutation`); raw `fetch` only inside mutationFn when streaming/upload forces it
- [ ] if touching file: CLAUDE pass (`type` not `interface`; avoid `try/catch/throw`; no new comments)

Core roots / globals

- [x] `src/app/index.tsx`: set QueryClient default `suspense: false` (recommended) + opt-in suspense per section; keep retry/refetch sane
- [x] `src/app/router.tsx`: add route transition pending UI if needed (keep previous layout; avoid blank)
- [x] `src/app/routes/+__root.tsx`: split Suspense so nav shell + Outlet don’t blank; `session` query `suspense:false`; remove `throw` in signOut

Shared components (high blast radius)

- [x] `src/components/Navigation.tsx`: admin metrics query `suspense:false` + placeholders; CLAUDE: `type` not `interface`
- [x] `src/components/login.tsx`: remove `throw` control-flow; keep errors as values
- [x] `src/components/TokenUsageTimeline.tsx`: keep stats non-suspending; chart shell always renders; consider code-split chart bundle

Client raw fetch (convert to TanStack + Eden)

- [x] `src/app/routes/+admin/+diagnose-unassessed/+index.tsx`: replace direct `fetch` + `try/catch/finally` with TanStack query/mutation via `apiClient`
- [x] `src/app/routes/+admin/+unexpected-answers/+all-prompts/+index.tsx`: replace direct `fetch` with `apiClient`; add Suspense fallback
- [x] `src/app/routes/+admin/+unexpected-answers/+all-prompts/+$promptId/+index.tsx`: replace direct `fetch` with `apiClient` (query + delete mutation)
- [x] `src/app/routes/+admin/+unexpected-answers/+$projectId/+$promptId/+index.tsx`: replace direct `fetch` with `apiClient` (query + delete mutation)
- [x] `src/app/routes/+projects/+$id/+export.tsx`: keep streaming if needed, but move `fetch` into TanStack mutationFn; avoid `try/catch/throw` if feasible
- [x] `src/components/main/articles/articleAdminSection.tsx`: move upload `fetch` into TanStack mutationFn using Eden if possible; remove block comment; `type` not `interface`

Routes (layout-first audit: header outside Suspense; section-level fallbacks; no route-level query reads)

- [x] `src/app/routes/+index.tsx`
- [x] `src/app/routes/+login/+index.tsx`
- [x] `src/app/routes/+settings/+index.tsx`

- [x] `src/app/routes/+projects/+index.tsx`
- [x] `src/app/routes/+projects/+archived/+index.tsx`
- [x] `src/app/routes/+projects/+create.tsx`
- [x] `src/app/routes/+projects/+create-subproject.tsx`
- [x] `src/app/routes/+projects/+$id/+index.tsx`
- [x] `src/app/routes/+projects/+$id/+edit.tsx`
- [x] `src/app/routes/+projects/+$id/+export.tsx`
- [x] `src/app/routes/+projects/+$id/+humanAssessment.tsx`
- [x] `src/app/routes/+projects/+$id/+reviews/+index.tsx`
- [x] `src/app/routes/+projects/+$id/+reviews/+$articleId/+index.tsx`
- [x] `src/app/routes/+projects/+$id/+reviews-unassessed/+index.tsx`
- [x] `src/app/routes/+projects/+$id/+reviews-human/+index.tsx`
- [x] `src/app/routes/+projects/+$id/+reviews-both/+index.tsx`
- [x] `src/app/routes/+projects/+$id/+reviews-llm/+index.tsx`
- [x] `src/app/routes/+projects/+$id/+reviews-llm/+$articleId/+index.tsx`
- [x] `src/app/routes/+projects/+$id/+reviews-llm/+$articleId/+fulltext.tsx`

- [x] `src/app/routes/+articles/+index.tsx`
- [x] `src/app/routes/+articles/+$id/+index.tsx`
- [x] `src/app/routes/+articles/+$id/+fulltext.tsx`

- [x] `src/app/routes/+prompts/+index.tsx`
- [x] `src/app/routes/+prompts/+archived/+index.tsx`

- [x] `src/app/routes/+admin/+jobs/+index.tsx`
- [x] `src/app/routes/+admin/+jobs/+$id/+index.tsx`
- [x] `src/app/routes/+admin/+jobs/+$id/+unassessed_articles.tsx`

- [x] `src/app/routes/+admin/+users/+index.tsx`
- [x] `src/app/routes/+admin/+assessments/+index.tsx`
- [x] `src/app/routes/+admin/+datasources/+index.tsx`
- [x] `src/app/routes/+admin/+datasources/+create.tsx`
- [x] `src/app/routes/+admin/+datasources/+archived/+index.tsx`
- [x] `src/app/routes/+admin/+datasources/+$id/+edit.tsx`

- [x] `src/app/routes/+admin/+latest-articles/+index.tsx`
- [x] `src/app/routes/+admin/+failed_requests/+index.tsx`
- [x] `src/app/routes/+admin/+failed_requests/+$id/+index.tsx`

- [x] `src/app/routes/+admin/+gpu/+index.tsx`
- [x] `src/app/routes/+admin/+llm/+index.tsx`
- [x] `src/app/routes/+admin/+setup_stats/+index.tsx`

- [x] `src/app/routes/+admin/+sync-stats/+index.tsx` (ensure every `<Suspense>` has fallback; keep cards isolated)
- [x] `src/app/routes/+admin/+clickhouse-sync/+index.tsx`
- [x] `src/app/routes/+admin/+clickhouse-sync/+articles/+index.tsx`

- [x] `src/app/routes/+admin/+import-route-stats/+index.tsx`
- [x] `src/app/routes/+admin/+import-route-stats/+$year/+index.tsx`
- [x] `src/app/routes/+admin/+import-route-stats/+$year/+$id/+index.tsx`
- [x] `src/app/routes/+admin/+import-route-stats/+$year/+$id/+fulltext.tsx`

- [x] `src/app/routes/+admin/+pdf-conversions/+index.tsx`
- [x] `src/app/routes/+admin/+pdf-reset/+index.tsx`

- [x] `src/app/routes/+admin/+unexpected-answers/+index.tsx`
- [x] `src/app/routes/+admin/+unexpected-answers/+$projectId/+index.tsx`
- [x] `src/app/routes/+admin/+unexpected-answers/+all-prompts/+index.tsx`
- [x] `src/app/routes/+admin/+unexpected-answers/+all-prompts/+$promptId/+index.tsx`
- [x] `src/app/routes/+admin/+unexpected-answers/+$projectId/+$promptId/+index.tsx`

- [x] `src/app/routes/+admin/+diagnose-unassessed/+index.tsx`
- [x] `src/app/routes/+admin/+prompts/+deduplicate.tsx`
- [x] `src/app/routes/+admin/+aa-models/+index.tsx`

Verification (per route)

- [ ] devtools: Slow 3G + reload; confirm route header/containers paint before any API returns
- [ ] confirm slow API only blocks its own section fallback
- [x] grep: no client `fetch(` except agreed streaming/upload cases (still inside TanStack mutationFn)
