# PMC_PLAN - Import Route Display Names

Goal

- Keep persisted/imported route strings unchanged (e.g. `/api/datasources/import/pubmed`).
- Change UI to display `import_route.name` (fallback: route string if name missing).

Non-negotiable

- Keep `route` as the only identifier in code + payloads; names are display only.

Inventory: user-facing places currently showing raw route text

- `src/components/main/projectDetails/projectDetailsInformation.tsx` (Import Routes list)
- `src/app/routes/+projects/+create.tsx` (Import Routes checkbox labels)
- `src/app/routes/+projects/+$id/+edit.tsx` (Import Routes checkbox labels)
- `src/app/routes/+admin/+datasources/+index.tsx` (Route field + `Unknown import route: ...` alert)
- `src/app/routes/+admin/+datasources/+archived/+index.tsx` (Route field)
- `src/app/routes/+admin/+datasources/+create.tsx` (Import Route placeholder lists routes)
- `src/app/routes/+admin/+datasources/+$id/+edit.tsx` (Import Route input value)
- `src/app/routes/+admin/+diagnose-unassessed/+index.tsx` (Scope > Import Routes join)
- `src/components/main/unassessedArticles.tsx` (By import route list)
- `src/app/routes/+admin/+import-route-stats/+index.tsx` (route shown as primary header; name is secondary)
- `src/app/routes/+admin/+import-route-stats/+$year/+index.tsx` (Import Route column)

API sources feeding those displays (route-only today)

- `src/server/routes/ImportRoutes.ts` `GET /api/importroutes` returns `{data: string[]}`
- `src/server/routes/ProjectsRoutes.ts` returns project `importRoutes: string[]`
- `src/server/routes/DataSourcesRoutes.ts` returns datasource `importRoute: string | null`
- `src/server/routes/ArticlesRoutes.ts` `GET /api/articles/stats` returns `byImportRoute: {importRoute, count}[]`
- `src/server/routes/AdminInvestigateRoutes.ts` `GET /api/admin/diagnose-unassessed` returns `scope.importRoutes: string[]`
- `src/server/routes/AdminImportRouteStatsRoutes.ts` already returns `importRouteName` for totals, but year-articles list is route-only

Gotchas / bug risks

- Never overwrite `importRoute`/`importRoutes` values with display names; many branches compare exact route strings (ex: datasource `New Import` dispatch)
- `import_route.name` can be `NULL`/blank or equal to route (current inserts often default `name=route`); UI must handle fallback
- Auth: `GET /api/importroutes` is admin-guarded; keep it that way. Non-admin pages must get display names via user-scoped endpoints (ex: project details includes `importRouteNamesByRoute`)
- Inactive routes: `/api/importroutes` filters `active=true`; existing projects/datasources may reference inactive routes -> mapping must include them or UI falls back to raw route
- Datasource `importRoute` is free-text (not FK); may not exist in `import_route` table -> expected fallbacks
- Duplicate names across routes: keep route visible somewhere (secondary mono, tooltip, `copy route` action) to avoid ambiguity/support debugging

Checklist (no route-string changes; display only)

- [ ] DB: decide display labels for each route in `import_route.name` (ex: set `/api/datasources/import/pubmed` name to `Europe PMC (MED)` or `europe-pmc-med`)
- [ ] DB: populate/backfill `import_route.name` for existing rows (one-time SQL/script; no `route` updates)
- [ ] API: add a stable route->name mapping for clients
  - Recommended: extend `GET /api/importroutes` to also return `nameByRoute: Record<string, string | null>` while keeping `data: string[]` intact
  - Include inactive route names needed for existing entities (or provide a separate `names for these routes` endpoint)
  - Non-admin pages: prefer returning names from the same endpoint that returns the routes (ex: project details response includes `importRouteNamesByRoute` for its `importRoutes`)
- [ ] Client: add a tiny formatter helper `getImportRouteDisplay(route, nameByRoute)` (fallback `route`, handle null/empty)
- [ ] Update UI displays to use name:
  - [ ] `src/components/main/projectDetails/projectDetailsInformation.tsx`
  - [ ] `src/app/routes/+projects/+create.tsx`
  - [ ] `src/app/routes/+projects/+$id/+edit.tsx`
  - [ ] `src/app/routes/+admin/+datasources/+index.tsx`
  - [ ] `src/app/routes/+admin/+datasources/+archived/+index.tsx`
  - [ ] `src/app/routes/+admin/+datasources/+create.tsx`
  - [ ] `src/app/routes/+admin/+datasources/+$id/+edit.tsx`
  - [ ] `src/app/routes/+admin/+diagnose-unassessed/+index.tsx`
  - [ ] `src/components/main/unassessedArticles.tsx`
  - [ ] `src/app/routes/+admin/+import-route-stats/+index.tsx`
  - [ ] `src/app/routes/+admin/+import-route-stats/+$year/+index.tsx`
- [ ] Forms still store routes: keep submitted values as route strings; only the label changes (optionally show route as secondary/tooltip)
- [ ] Quick regression: create/edit project keeps sending `importRoutes: string[]`; datasource import still calls the same `/api/datasources/import/*` endpoints
