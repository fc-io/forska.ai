# Layout First Plan

Target

- fastest possible layout: header + section containers first
- data later: async fill / update; keep UI interactive; no full-page spinner for slow APIs

Parents' creed (Ryan Carniato x Tanner Linsley)

- [ ] Solid: fine-grain; never read async data unguarded; shell first
- [ ] TanStack: explicit queries; stable keys; suspense scoped; cache used intentionally

Global checklist (apply everywhere)

- [ ] never let queries suspend root `<Outlet />` (no “one big `<Suspense>`” around app content)
- [ ] per query: either local `<Suspense fallback=...>` wraps FIRST read OR set `suspense: false` + explicit loading UI
- [ ] no `<Suspense>` without `fallback`
- [ ] client network only via TanStack (`useQuery`/`createMutation`/`useMutation`); raw `fetch` only inside mutationFn when streaming/upload forces it
- [ ] if touching file: CLAUDE pass (`type` not `interface`; avoid `try/catch/throw`; no new comments)

Core roots / globals

- [ ] `src/app/index.tsx`: set QueryClient default `suspense: false` (recommended) + opt-in suspense per section; keep retry/refetch sane
- [ ] `src/app/router.tsx`: add route transition pending UI if needed (keep previous layout; avoid blank)
- [ ] `src/app/routes/+__root.tsx`: split Suspense so nav shell + Outlet don’t blank; `session` query `suspense:false`; remove `throw` in signOut

Shared components (high blast radius)

- [ ] `src/components/Navigation.tsx`: admin metrics query `suspense:false` + placeholders; CLAUDE: `type` not `interface`
- [ ] `src/components/login.tsx`: remove `throw` control-flow; keep errors as values
- [ ] `src/components/TokenUsageTimeline.tsx`: keep stats non-suspending; chart shell always renders; consider code-split chart bundle

Client raw fetch (convert to TanStack + Eden)

- [ ] `src/app/routes/+admin/+diagnose-unassessed/+index.tsx`: replace direct `fetch` + `try/catch/finally` with TanStack query/mutation via `apiClient`
- [ ] `src/app/routes/+admin/+unexpected-answers/+all-prompts/+index.tsx`: replace direct `fetch` with `apiClient`; add Suspense fallback
- [ ] `src/app/routes/+admin/+unexpected-answers/+all-prompts/+$promptId/+index.tsx`: replace direct `fetch` with `apiClient` (query + delete mutation)
- [ ] `src/app/routes/+admin/+unexpected-answers/+$projectId/+$promptId/+index.tsx`: replace direct `fetch` with `apiClient` (query + delete mutation)
- [ ] `src/app/routes/+projects/+$id/+export.tsx`: keep streaming if needed, but move `fetch` into TanStack mutationFn; avoid `try/catch/throw` if feasible
- [ ] `src/components/main/articles/articleAdminSection.tsx`: move upload `fetch` into TanStack mutationFn using Eden if possible; remove block comment; `type` not `interface`

Routes (layout-first audit: header outside Suspense; section-level fallbacks; no route-level query reads)

- [ ] `src/app/routes/+index.tsx`
- [ ] `src/app/routes/+login/+index.tsx`
- [ ] `src/app/routes/+settings/+index.tsx`

- [ ] `src/app/routes/+projects/+index.tsx`
- [ ] `src/app/routes/+projects/+archived/+index.tsx`
- [ ] `src/app/routes/+projects/+create.tsx`
- [ ] `src/app/routes/+projects/+create-subproject.tsx`
- [ ] `src/app/routes/+projects/+$id/+index.tsx`
- [ ] `src/app/routes/+projects/+$id/+edit.tsx`
- [ ] `src/app/routes/+projects/+$id/+export.tsx`
- [ ] `src/app/routes/+projects/+$id/+humanAssessment.tsx`
- [ ] `src/app/routes/+projects/+$id/+reviews/+index.tsx`
- [ ] `src/app/routes/+projects/+$id/+reviews/+$articleId/+index.tsx`
- [ ] `src/app/routes/+projects/+$id/+reviews-unassessed/+index.tsx`
- [ ] `src/app/routes/+projects/+$id/+reviews-human/+index.tsx`
- [ ] `src/app/routes/+projects/+$id/+reviews-both/+index.tsx`
- [ ] `src/app/routes/+projects/+$id/+reviews-llm/+index.tsx`
- [ ] `src/app/routes/+projects/+$id/+reviews-llm/+$articleId/+index.tsx`
- [ ] `src/app/routes/+projects/+$id/+reviews-llm/+$articleId/+fulltext.tsx`

- [ ] `src/app/routes/+articles/+index.tsx`
- [ ] `src/app/routes/+articles/+$id/+index.tsx`
- [ ] `src/app/routes/+articles/+$id/+fulltext.tsx`

- [ ] `src/app/routes/+prompts/+index.tsx`
- [ ] `src/app/routes/+prompts/+archived/+index.tsx`

- [ ] `src/app/routes/+admin/+jobs/+index.tsx`
- [ ] `src/app/routes/+admin/+jobs/+$id/+index.tsx`
- [ ] `src/app/routes/+admin/+jobs/+$id/+unassessed_articles.tsx`

- [ ] `src/app/routes/+admin/+users/+index.tsx`
- [ ] `src/app/routes/+admin/+assessments/+index.tsx`
- [ ] `src/app/routes/+admin/+datasources/+index.tsx`
- [ ] `src/app/routes/+admin/+datasources/+create.tsx`
- [ ] `src/app/routes/+admin/+datasources/+archived/+index.tsx`
- [ ] `src/app/routes/+admin/+datasources/+$id/+edit.tsx`

- [ ] `src/app/routes/+admin/+latest-articles/+index.tsx`
- [ ] `src/app/routes/+admin/+failed_requests/+index.tsx`
- [ ] `src/app/routes/+admin/+failed_requests/+$id/+index.tsx`

- [ ] `src/app/routes/+admin/+gpu/+index.tsx`
- [ ] `src/app/routes/+admin/+llm/+index.tsx`
- [ ] `src/app/routes/+admin/+setup_stats/+index.tsx`

- [ ] `src/app/routes/+admin/+sync-stats/+index.tsx` (ensure every `<Suspense>` has fallback; keep cards isolated)
- [ ] `src/app/routes/+admin/+clickhouse-sync/+index.tsx`
- [ ] `src/app/routes/+admin/+clickhouse-sync/+articles/+index.tsx`

- [ ] `src/app/routes/+admin/+import-route-stats/+index.tsx`
- [ ] `src/app/routes/+admin/+import-route-stats/+$year/+index.tsx`
- [ ] `src/app/routes/+admin/+import-route-stats/+$year/+$id/+index.tsx`
- [ ] `src/app/routes/+admin/+import-route-stats/+$year/+$id/+fulltext.tsx`

- [ ] `src/app/routes/+admin/+pdf-conversions/+index.tsx`
- [ ] `src/app/routes/+admin/+pdf-reset/+index.tsx`

- [ ] `src/app/routes/+admin/+unexpected-answers/+index.tsx`
- [ ] `src/app/routes/+admin/+unexpected-answers/+$projectId/+index.tsx`
- [ ] `src/app/routes/+admin/+unexpected-answers/+all-prompts/+index.tsx`
- [ ] `src/app/routes/+admin/+unexpected-answers/+all-prompts/+$promptId/+index.tsx`
- [ ] `src/app/routes/+admin/+unexpected-answers/+$projectId/+$promptId/+index.tsx`

- [ ] `src/app/routes/+admin/+diagnose-unassessed/+index.tsx`
- [ ] `src/app/routes/+admin/+prompts/+deduplicate.tsx`
- [ ] `src/app/routes/+admin/+aa-models/+index.tsx`

Verification (per route)

- [ ] devtools: Slow 3G + reload; confirm route header/containers paint before any API returns
- [ ] confirm slow API only blocks its own section fallback
- [ ] grep: no client `fetch(` except agreed streaming/upload cases (still inside TanStack mutationFn)
