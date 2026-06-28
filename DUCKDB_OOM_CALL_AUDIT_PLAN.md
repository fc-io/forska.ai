# DuckDB Owner/V4 Call-Site Audit Plan

Created: 2026-06-26
Updated: 2026-06-28
Base audited: `origin/main` at `587da99da5fef29acdf451de95a98ab0ecca287a`

This file turns the `DUCK_OOM_FIX_PLAN.md` serving-index rules into a concrete
call-site checklist. The goal is to make every DuckDB touchpoint fit one of the
allowed paths:

- normal product review/project-serving reads use V4 serving readers, V4 job
  state, or bounded V4 selection jobs;
- API-role public project routes proxy to the DuckDB owner and fail closed when
  no compatible owner exists;
- owner-side source writes, project metadata reads, import writes, projector
  work, and maintenance work are explicitly classified;
- admin/debug/manual tools are allowlisted, isolated, and memory-capped;
- legacy raw OLAP fallback is quarantined until deleted.

The important qualifier is that not literally every DuckDB call becomes a V4
read. V4 is the normal product read path. Source writes, deltas, migrations,
projectors, rebuilds, diagnostics, and maintenance still use DuckDB, but they
must not run as unclassified API-role foreground reads.

The checklist groups runtime call sites by product surface and ownership
boundary. The audit commands at the end are the regeneration source for exact
file discovery.

Table column guide:

- **V4 compatible**: whether the current row is compatible with the V4 serving
  path for normal product reads. `N/A` means the row is not a product read path,
  such as maintenance, admin diagnostics, retired legacy wrappers, or pure
  client-only UI; client rows that gate V4 APIs may still be `Partial`.
- **R/W**: the dominant DuckDB role: reader, writer, reader/writer, durable job,
  routing/control, admin/tool, verification, or client-over-API.
- **Uses new CQRS**: whether the current row uses the new CQRS serving contracts,
  deltas, projectors, snapshot manifests, or durable jobs. Owner routing alone
  is not counted as full CQRS.
- **Legacy**: `false` means the row is not a legacy/deletion-target path; it may
  be V4, owner-routed, admin, maintenance, diagnostics, test-only, or another
  current path. `true - ready to be deleted` means retired legacy wrapper/residue
  where normal production/product callers have moved away and deletion is the
  remaining cleanup. `true - need further changes` means a legacy or
  legacy-backed path is still active, still needed by fallback/tests, or needs
  more migration/hardening before deletion.

## Sequential Remediation Action Items

Implement these in order. The sequence prefers enforcement before migrations,
then product route cutovers and legacy deletion, then background/admin/client
hardening, and finally physical evidence.

### Cross-Cutting Enforcement

- [x] **A1.** Keep `DUCK_OOM_FIX_PLAN.md` linked to this call-site audit so the
      master plan and implementation checklist share one coordination source.
- [x] **A2.** Keep `routeSurfaceInventory.ts` exhaustive for mounted public
      `/api/*` routes and keep unknown public API routes classified as
      fail-closed `unclassified` routes.
- [x] **A3.** Keep representative owner-unavailable coverage for
      owner-dependent API routes returning the owner proxy target unavailable
      error instead of opening DuckDB locally.
- [x] **A4.** Add an explicit API-role proxy-order integration test proving
      `apiProxyRoutes` intercepts owner-dependent product routes before product
      handlers mounted from `getProductApiRoutes()` can execute.
- [x] **A5.** Add a broad route-facing static import guard that fails on
      unallowlisted route-handler imports of generic DuckDB services,
      `duckdbOlap`, `duckdbRunner`, read-only DuckDB services, or
      `@duckdb/node-api`.
- [x] **A6.** Add a broad normal-foreground SQL guard for forbidden raw shapes:
      `selected_scoped_article_import`, `ROW_NUMBER(`, raw `app.article` or
      `app.judgment` scans, unbounded `GROUP BY`, `OFFSET`, and runtime JSON
      sort/extraction.
- [~] **A7.** Tighten low-level DuckDB execution so normal foreground work with
  missing `DuckdbWorkloadContext` is rejected before connection acquisition,
  while explicit owner/background/admin/test scopes remain allowlisted.
- [~] **A8.** Extend smoke gates so `test:network-smoke:current-db` and
  `test:dev-server:current-db` also fail on unqueueable/stalled V4 states,
  not only API-role ownership, heartbeat, fatal restart, and worker-loop
  failures.

### Runtime And Routing

- [x] **A9.** Land the proxy-order test from A4 against the actual
      `serverMain.ts` registration order and keep it focused on API-role behavior.
- [~] **A10.** Add runtime-role assertions proving API role cannot acquire
  owner-only foreground project reads through `duckdbService.ts`,
  `appDatabaseService.ts`, `getAppQueryService.ts`, or read-only wrappers.
- [~] **A11.** Implement the missing-workload-context rejection from A7 with tests
  beside `duckdbServiceWorkloadContext.test.ts`, including allowed
  maintenance/admin/test paths.
- [x] **A12.** Finish residual read classification for `getAppQueryService.ts`
      and `appQueryServiceCore.ts` by giving every remaining product-facing source
      read a purpose, cap, workload class, and migration target.
- [x] **A13.** Keep read-only services blocked for live API read-only access when
      an owner proxy is configured and keep shared read-only runtime options for
      snapshots/tools.
- [x] **A14.** Keep direct production `@duckdb/node-api` access concentrated in
      shared runtime helpers and explicit admin/test-only fixture paths.

### Product Routes

- [x] **A15.** Keep migrated LLM, human, both-mode, unassessed, filter/facet,
      add-to-project, PDF, and judgment-job routes on V4 readers/jobs with raw
      OLAP imports removed or guarded.
- [~] **A16.** Complete the review health/warnings migration by separating V4
  readiness/manifest diagnostics from legacy mart, owner, dirty-materializer,
  and maintenance state, then register any remaining diagnostics-only source
  reads with caps.
- [~] **A17.** Complete prompt preview by replacing the
  `mart.project_scope_article`/`app.project_article` fallback and bounded
  article hydration with a serving contract or explicitly capped diagnostic
  residual path.
- [~] **A18.** Complete review detail/hydration by moving judgment, prompt,
  article, assessment, and import-source detail reads to keyed V4/detail
  contracts or capped residual source reads with migration targets.
- [~] **A19.** Move project article membership listing away from owner-side
  `COUNT(*)`, `app.project_article`/`app.article` joins, and `OFFSET` toward V4
  job/keyset state.
- [~] **A20.** Finish project export by making download expansion/CSV generation
  consume bounded job output and serving/detail contracts instead of broad
  owner-side `app.article`, `app.judgment`, and `app.prompt` reads.
- [~] **A21.** Migrate comparison project reads to complete bounded serving
  contracts/admission and keep source writes owner-routed.
- [x] **A22.** Audit data-source/import create routes for atomic delta/hot-field
      append, workload context, and absence of synchronous project fanout across
      structured-file, Covidence, PubMed, Europe PMC, and FHIR paths.
- [~] **A23.** Prove prompt/subproject/model/provider changes enqueue V4
  dirty/rebuild work instead of owner-side foreground project-scale scans.
- [x] **A24.** Complete human-assessment overview/init migration so product reads
      use serving state/overlays and remaining source reads are bounded.
- [x] **A25.** Prove token, request-attempt, and provider-telemetry services have
      workload contexts and do not run project-review raw scans in normal product
      routes.

### V4 Serving And Projector

- [x] **A26.** Keep V4 contracts, admission, cursors, SQL builders, migrated route
      services, and SQL-shape tests as the product-read baseline.
- [x] **A27.** Keep manifest, snapshot pin, promotion, retention, delta intake,
      dirty work, projector service, projector writer, and component projector
      tests covering single-writer and bounded-work behavior.
- [x] **A28.** Keep rebuild request/chunk manifests, bulk/search/export/PDF job
      services, parity runner, benchmark harness, diagnostics repository, and
      desktop interruption evidence in the V4 evidence set.
- [x] **A29.** Add repo-wide proof that no legacy mart maintenance path can write
      or promote V4 review-serving snapshots outside the V4 projector writer.
- [~] **A30.** Extend admission/diagnostic evidence for unchecked detail,
      prompt-preview, warning/health, export-download, comparison, and
      human-assessment contracts before marking those product rows migrated.
      Partial evidence is current in `reviewServingReadContracts.test.ts`,
      `reviewServingAdmission.test.ts`, `reviewServingRouteParityEvidence.test.ts`,
      `ProjectExportRoutes.test.ts`, and `reviewServingAdjacentRouteSurfaces.test.ts`.
      Remaining blockers: detail, prompt-preview, warning/health, and export still
      document residual source reads or metadata gaps; comparison has no separate
      V4 admission/contract registry; do not mark those rows migrated yet.

### Legacy OLAP Retirement

- [x] **A31.** Keep quarantined `duckdbOlap`/raw fallback static guards for normal
      review and judgment-job foreground paths.
- [x] **A32.** Keep migrated wrapper evidence showing no production callers remain
      for `articlesReviewsOlap.ts`, `articlesReviewsBothOlap.ts`,
      `articlesReviewsFiltersOlap.ts`, `unassessedArticlesOlap.ts`, and
      `selectArticleIdsOlap.ts`.
- [x] **A33.** Delete ready-to-remove OLAP wrapper files and update or remove tests
      that only assert wrapper delegation once the broad route import guard is in
      place.
- [~] **A34.** Retire `duckdbOlap.ts` raw fallback branches after the last product
  detail/prompt/diagnostic/export/comparison route no longer needs them. Partial:
  `duckdbOlap.ts` remains because raw fallback coverage still exists in
  `duckdbOlap.test.ts` and the product detail, prompt-preview, diagnostic,
  export, and comparison route rows above still list residual blockers.
- [x] **A35.** Add a final OLAP retirement guard that fails on new production
      imports of deleted legacy OLAP wrappers or `duckdbOlap` outside explicit
      admin/test fixtures.

### Background, Cron, Import, And Maintenance

- [x] **A36.** Keep judgment cron/LLM processing on V4 queue/projection reads and
      delta/outbox dirty writes.
- [ ] **A37.** Audit full-text fetch/conversion jobs for bounded running-job and
      project scans, workload contexts, and delta append on every
      `app.article.full_text_pdf` update path.
- [ ] **A38.** Prove provider admission, provider repositories, and dispatch
      telemetry reads are owner/background scoped with workload contexts and no
      product-review raw scans.
- [ ] **A39.** Complete import/store workflow audit for agent workflows,
      structured-file imports, PubMed, Europe PMC, FHIR, Covidence, hot-field
      extraction, delta append, and no synchronous affected-project fanout.
- [ ] **A40.** Retire dirty materialization and mart refresh as legacy serving
      writers so they either feed V4 dirty/projector state or become deletion-only
      maintenance.
- [ ] **A41.** Convert large rebuild services into V4 chunk-manifest/backfill
      drivers or retire them once V4 rebuild requests cover their purpose.
- [ ] **A42.** Finish comparison serving builder migration in tandem with
      comparison route contracts so reads and writers share bounded serving
      identities.
- [ ] **A43.** Audit project-transfer import/export for batching, workload
      context, owner routing, dirty-token-only fanout, and bounded artifact
      cleanup.
- [ ] **A44.** Complete archived cleanup, maintenance lease, recovery, and script
      allowlist proof for workload contexts, memory caps, and batched legacy/source
      cleanup.
- [x] **A45.** Keep DuckDB migrations under `withDuckdbMaintenanceAccess`,
      maintenance workload context, transaction/non-transaction tests, and
      checkpoint behavior.
- [ ] **A46.** Add a repo-wide operator-script allowlist/proof for DB-touching
      scripts, including explicit memory/runtime options for snapshot, backup,
      checkpoint, recovery, rebuild, and request scripts.

### Admin And Diagnostics

- [x] **A47.** Keep admin investigation, owner diagnostics, DuckDB Studio/snapshot,
      and ownerless readable backend routes classified as admin/diagnostic rather
      than product fallback.
- [ ] **A48.** Remove or rewire admin UI/API controls for legacy project-mart large
      rebuild, dirty refresh, and mart maintenance once V4 replacements exist.
- [ ] **A49.** Add explicit proof that every admin page/API is diagnostics-only,
      owner-routed maintenance, V4-rewired control, or remove-before-release.

### Client/UI

- [~] **A50.** Keep review UI article queries gated on V4 warning/readiness data
  and keep stale/unavailable browser copy covered by tests.
- [ ] **A51.** Change review UI warning-query failure handling so failure does not
      grant permission to load article rows through product APIs.
- [ ] **A52.** Update review UI to consume final health/warning/detail readiness
      states after A16-A18, including browser and desktop behavior.
- [ ] **A53.** Rewire admin UI away from legacy mart large-rebuild controls and
      prove every admin surface is diagnostic-only or V4-backed.

### Final Evidence And Audit Commands

- [ ] **A54.** Re-run and update the file-discovery, production DuckDB call
      discovery, route inventory/proxy, API owner proxy, V4 static, and smoke
      command groups after each remediation part lands.
- [ ] **A55.** Run final current-DB browser/API smoke proving API role proxies or
      fails closed while the owner serves V4 paths, with no forbidden runtime log
      patterns.
- [ ] **A56.** Produce synthetic and physical release evidence for no foreground
      raw fallback, zero foreground temp spill, bounded rows/result bytes,
      overlap with imports/materialization, and desktop interruption/resume.
- [ ] **A57.** After A54-A56 pass, update this audit checklist statuses and the
      master `DUCK_OOM_FIX_PLAN.md` success criteria/evidence references in the
      same final evidence change.

## Required Handling Classes

- **V4 product read**: **partially current, still planned for full route
  cutover.** Implemented V4-style readers/services exist in
  `src/server/reviewServing/reviewServingReader.ts`, route services, and
  `reviewSearchService.ts`; SQL-shape tests cover serving reads in
  `src/server/reviewServing/reviewServingSql.test.ts`. Full product-route
  removal of raw fallback is still planned for unchecked route rows below.
- **Owner-routed source access**: **current for API-role routing.** Public API
  owner-dependent and unclassified routes proxy through
  `src/server/routes/ApiProxyRoutes.ts`; fail-closed behavior is tested in
  `src/server/routes/ApiProxyRoutes.test.ts` and retry/upload variants in
  `ApiProxyRoutes.retry.test.ts`.
- **Owner/background writer**: **partially current, still planned for complete
  workload proof.** Runtime roles, owner leases, and workload contexts exist in
  `src/server/utils/serverRuntimeRole.ts`, `duckdbOwnerLease.ts`, and
  `duckdbService.ts`; missing workload context is still accepted by low-level
  helpers, so complete enforcement remains planned.
- **Single V4 writer**: **current for V4 projector ownership.** Normal V4 projector worker/service
  code is concentrated in `src/server/workers/reviewServingProjectorWorker.ts`
  and `src/server/reviewServing/reviewServingProjectorService.ts`, while
  `reviewServingProjectorWriter.test.ts` scans legacy mart maintenance files and
  fails on V4 mart, snapshot manifest, projection manifest, selected-import
  snapshot, or projector promotion writes outside the V4 projector boundary.
- **Residual foreground read allowlist**: **current for audited review residuals,
  still planned for repo-wide residual reads.** Review residuals are listed in
  `src/server/reviewServing/reviewServingResidualReadAllowlist.ts` and checked by
  `reviewServingResidualReadAllowlist.test.ts`; full route/query purpose, cap,
  and migration-target coverage is still incomplete.
- **Admin/debug/tool allowlist**: **partially current.** Admin/debug/tool paths
  are classified in `src/server/routes/routeSurfaceInventory.ts`, and snapshot
  tooling uses shared read-only runtime options in `scripts/dbQuerySnapshot.ts`;
  complete allowlist proof for every script/admin direct DuckDB touch remains
  planned.
- **Quarantined legacy**: **current for normal review/job foreground guards,
  still planned for final raw fallback deletion.** `duckdbOlap.ts` remains legacy;
  tests in `src/server/reviewServing/reviewServingSql.test.ts` keep imports away
  from normal review and judgment-job foreground paths, and
  `duckdbRouteGuardrails.test.ts` fails new production imports of deleted OLAP
  wrappers or `duckdbOlap`.
- **Test-only**: **current for direct fixture usage, still planned for broad
  import enforcement.** Direct `@duckdb/node-api` fixture imports appear in test
  files such as `DuckdbStudioRoutes.test.ts` and `duckdbServiceWorkloadContext.test.ts`;
  production scans still need broader static guard coverage.

## Cross-Cutting Enforcement Checklist

- [x] `routeSurfaceInventory.ts` is exhaustive for every public `/api/*` route.
      Current owner-routed/source-access enforcement: `routeSurfaceInventory.test.ts`
      compares mounted routes from `runtimeReadyRoutes`, owner diagnostics,
      telemetry, and `getProductApiRoutes()` against `routeSurfaceRoutes`.
- [x] Unknown public API routes are either impossible or fail closed in API role.
      Current owner-routed/source-access enforcement: `apiRouteClassification.ts`
      classifies unknown `/api/*` routes as `unclassified`, proxies them, and
      makes them fail closed without an owner.
- [x] Every project/review/export/add-articles/job-read route that can touch
      DuckDB is `owner-dependent` unless explicitly classified otherwise.
      Current owner-routed/source-access enforcement: `routeSurfaceInventory.ts`
      marks project, review, export, add-articles, and judgment-job API surfaces
      with `ownerDependentProduct`, `ownerDependentSensitive`, or explicit
      diagnostics/maintenance classifications; exhaustiveness is tested in
      `routeSurfaceInventory.test.ts`.
- [x] `ApiProxyRoutes` is proven to run before product route handlers in API
      role. Current evidence: `duckdbRouteGuardrails.test.ts` checks
      `serverMain.ts` registration order and proves an owner-dependent
      `/api/users` request returns the owner-proxy unavailable response before a
      product handler can execute.
- [x] API role without an owner returns `DuckDB owner proxy target unavailable`
      for owner-dependent project routes instead of opening DuckDB locally.
      Current owner-routed/source-access enforcement: `ApiProxyRoutes.ts`
      returns the error, and `ApiProxyRoutes.test.ts` covers an API server without
      an owner returning `502` for `/api/users`.
- [~] Low-level foreground DuckDB execution rejects missing workload context
  outside explicit owner/background/admin/test scopes. Partial current
  enforcement: when `FORSKA_ENFORCE_DUCKDB_WORKLOAD_CONTEXT=true`,
  `duckdbService.ts` rejects API-role `mainQuery`, `mainStatement`, and
  `transaction` work without `DuckdbWorkloadContext` before connection
  acquisition; `duckdbServiceWorkloadContext.test.ts` covers API rejection and
  owner/background/maintenance allowance. Remaining rollout: enable the guard
  by default after legitimate foreground callers are fully classified, and
  extend wrapper-specific assertions through `appDatabaseService.ts`,
  `getAppQueryService.ts`, and read-only wrappers.
- [x] Static guards fail when route handlers import generic DuckDB services,
      `duckdbOlap`, `duckdbRunner`, `readOnlyDuckdbService`, or `@duckdb/node-api`
      without an allowlist entry. Current evidence:
      `duckdbRouteGuardrails.test.ts` scans route-handler source files and fails
      on new unallowlisted generic DuckDB, read-only DuckDB, `duckdbOlap`,
      `duckdbRunner`, or direct `@duckdb/node-api` imports.
- [x] Static guards fail when normal foreground SQL contains
      `selected_scoped_article_import`, `ROW_NUMBER(`, raw `app.article` or
      `app.judgment` scans, unbounded `GROUP BY`, `OFFSET`, or JSON
      sort/extraction. Current evidence: `duckdbRouteGuardrails.test.ts` scans
      route-handler source files and fails on new unallowlisted raw OOM-prone SQL
      shapes; existing residual/admin/diagnostic route files remain explicit in
      the allowlist.
- [~] `test:network-smoke:current-db` and `test:dev-server:current-db` fail on
  API-role DuckDB ownership, owner heartbeat errors, fatal DuckDB restarts,
  worker loop failures, and unqueueable/stalled V4 states. Partially current
  runtime/admin evidence: scripts exist in `package.json`, forbidden runtime
  patterns are checked in `tests/e2e/networkSmoke.spec.ts` and
  `scripts/runWithRuntimeProfile.test.ts`; `networkSmoke.spec.ts` also fails
  on stalled/stale warning responses except readable stale states and the
  explicit mutation-disabled queued backlog. Remaining evidence: add or prove
  the equivalent unqueueable/stalled V4-state guard in
  `test:dev-server:current-db`.

## Runtime And Routing Checklist

| Status | Area                            | Files                                                                                                                                                                                                                     | Classification                                                  | V4 compatible | R/W           | Uses new CQRS | Legacy                      | Required handling                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------- | ------------- | ------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [x]    | API owner proxy                 | `src/server/routes/ApiProxyRoutes.ts`, `src/server/routes/apiRouteClassification.ts`, `src/server/routes/routeSurfaceInventory.ts`                                                                                        | Owner-routed source access                                      | N/A           | Routing       | N/A           | false                       | Current: API-role proxying, fail-closed unknown/owner-dependent classification, and inventory exhaustiveness are implemented/test-covered. `duckdbRouteGuardrails.test.ts` proves `apiProxyRoutes` is registered before public product routes in `serverMain.ts` and intercepts `/api/users` before the product handler can execute.                                                                                                            |
| [ ]    | Runtime role and owner registry | `src/server/utils/serverRuntimeRole.ts`, `src/server/utils/duckdbOwnerConnections.ts`, `src/server/utils/duckdbOwnerConnectionHeartbeat.ts`, `src/server/utils/duckdbOwnerLease.ts`, `src/server/utils/runtimeCutover.ts` | Owner/background writer                                         | N/A           | Control       | N/A           | false                       | Partially current: owner election, heartbeat, cutover compatibility, and failover registry code/tests exist. Planned: assertions that API role cannot acquire owner-only foreground project reads through lower-level DB paths.                                                                                                                                                                                                                 |
| [~]    | Low-level DuckDB service        | `src/server/utils/duckdbService.ts`, `src/server/services/appDatabaseService.ts`                                                                                                                                          | Owner/background writer                                         | Partial       | Reader/writer | Partial       | false                       | Partial: workload metrics, budgets, and `DuckdbWorkloadContext` are implemented/tested in `duckdbServiceWorkloadContext.test.ts`. With `FORSKA_ENFORCE_DUCKDB_WORKLOAD_CONTEXT=true`, API-role foreground `mainQuery`/`mainStatement`/`transaction` without context is rejected before connection acquisition while owner/background/maintenance scopes remain allowed. Full default-on rollout and wrapper-specific assertions remain planned. |
| [x]    | Read-only DB services           | `src/server/services/readOnlyDuckdbService.ts`, `src/server/services/appReadOnlyDatabaseService.ts`, `src/server/services/getAppReadOnlyQueryService.ts`                                                                  | Residual allowlist / admin-debug-tool / owner-background writer | N/A           | Reader        | N/A           | false                       | Current: `readOnlyDuckdbService.ts` rejects write-capable SQL, disables live API read-only access when an owner proxy is configured, and uses shared read-only runtime options; `getAppQueryService.test.ts` and `readOnlyDuckdbServiceWorkloadContext.test.ts` cover read-only behavior and workload forwarding.                                                                                                                               |
| [x]    | App query wrapper               | `src/server/services/getAppQueryService.ts`, `src/server/services/appQueryServiceCore.ts`                                                                                                                                 | Owner-routed source access / residual allowlist                 | Partial       | Reader        | N/A           | false                       | Current classification: source metadata/detail reads are owner-routed by API proxying, and `reviewServingResidualReadAllowlist.ts` lists each product-facing `appQueryServiceCore.ts` method with purpose, cap, workload class, and migration target. Planned: finish V4 detail/payload migration so residual app-query reads can be removed.                                                                                                   |
| [x]    | Legacy OLAP runner              | `src/services/olap/duckdbRunner.ts`                                                                                                                                                                                       | Quarantined legacy                                              | No            | Reader        | No            | true - need further changes | Current quarantine: `duckdbRunner.ts` forwards default-path queries through `appDatabaseService` with optional workload context, and `reviewServingSql.test.ts` prevents `duckdbOlap` imports in normal review and judgment-job foreground paths. Deletion remains planned in legacy checklist rows.                                                                                                                                            |
| [x]    | Direct node-api use             | `@duckdb/node-api` imports, `DuckDBInstance.create` call sites                                                                                                                                                            | Admin/debug/tool allowlist / test-only                          | N/A           | Admin/test    | N/A           | false                       | Current: production direct use is concentrated in shared runtime helpers (`duckdbService.ts`, `readOnlyDuckdbService.ts`, `backgroundServerStack.ts`); admin snapshot script `scripts/dbQuerySnapshot.ts` uses `getReadOnlyDuckdbRuntimeOptions()`, direct fixture usage is test-only, and `duckdbRouteGuardrails.test.ts` fails on new unallowlisted route-handler `@duckdb/node-api` imports.                                                 |

## Product Route Checklist

| Status | Area                                       | Files                                                                                                                                                                                                              | Classification                                          | V4 compatible | R/W           | Uses new CQRS | Legacy                      | Required handling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- | ------------- | ------------- | ------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [x]    | LLM review list/count                      | `src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviews.ts`, `src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsCount.ts`                                                                | V4 product read plus owner-routed source access         | Yes           | Reader        | Yes           | false                       | Current: API role proxies/fails closed through `routeSurfaceInventory.ts`/`ApiProxyRoutes.ts`, while owner-side handlers assert active project access via `projectAccessGuard.ts` and call `getLlmReviewArticlesFromServing`/`countLlmReviewArticlesFromServing` only. No route import of `articlesReviewsOlap` remains; V4 SQL guards live in `src/server/reviewServing/reviewServingSql.test.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| [x]    | Both-mode review list                      | `src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsBoth.ts`                                                                                                                                         | V4 product read plus owner-routed source access         | Yes           | Reader        | Yes           | false                       | Current: API role is owner-dependent in `routeSurfaceInventory.ts`, and the owner-side route calls `getBothReviewArticlesFromServing` from `reviewServingHumanBothUnassessedRouteService.ts`. No in-memory LLM/human intersection or `articlesReviewsBothOlap` fallback is present in the route.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| [x]    | Human review list/filter                   | `src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsHuman.ts`, `src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsHumanFilters.ts`                                                    | V4 product read plus owner-routed source access         | Yes           | Reader        | Yes           | false                       | Current: API role is owner-dependent. The list route calls `getHumanReviewArticlesFromServing`; the filter route calls `getReviewFiltersFromServing` after owner-side metadata reads through `getAppQueryService().getProjectReviewConfig` and `getProjectPromptRows`. `projectsRoutesGetArticlesReviewsHuman.test.ts` and `reviewServingSql.test.ts` cover the V4 path.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| [x]    | Filter/facet routes                        | `src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsFilters.ts`                                                                                                                                      | V4 product read plus owner-routed source access         | Yes           | Reader        | Yes           | false                       | Current: API role is owner-dependent; the route calls `getReviewFiltersFromServing` and only reads project prompts as owner-side source metadata. The deleted `articlesReviewsFiltersOlap.ts` wrapper cannot be reintroduced as a production import because `duckdbRouteGuardrails.test.ts` guards retired OLAP imports. V4 filter SQL coverage is in `reviewServingSql.test.ts`/route-service tests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| [x]    | Unassessed review routes                   | `src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsUnassessed.ts`                                                                                                                                   | V4 product read plus owner-routed source access         | Yes           | Reader        | Yes           | false                       | Current: API role is owner-dependent; the owner-side route calls `getUnassessedReviewArticlesFromServing` from `reviewServingHumanBothUnassessedRouteService.ts`. The deleted `unassessedArticlesOlap.ts` wrapper cannot be reintroduced as a production import because `duckdbRouteGuardrails.test.ts` guards retired OLAP imports.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| [~]    | Review health/warnings                     | `src/server/routes/projectsRoutes/projectsRoutesGetReviewsHealth.ts`, `src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.ts`                                                                       | V4 product read plus residual allowlist                 | Partial       | Reader        | Partial       | true - need further changes | Partial: API role proxies/fails closed, and owner-side routes read V4 diagnostics/manifest state with `readReviewServingRows`, `getReviewServingDiagnostics`, and `requestReviewServingV4Rebuild`. Residual source reads for prompt count, article-scope probes, legacy mart refresh state, large-rebuild state, owner/maintenance diagnostics, and V4 diagnostics are now classified in `reviewServingResidualReadAllowlist.ts` with purposes, caps, workload classes, and migration targets. Not complete: route code still mixes V4 readiness with legacy mart/maintenance diagnostics instead of separate contracts.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| [~]    | Prompt preview                             | `src/server/routes/projectsRoutes/projectsRoutesGetPromptPreview.ts`                                                                                                                                               | Residual foreground read allowlist                      | Partial       | Reader        | Partial       | true - need further changes | Partial: API role proxies/fails closed and owner-side first tries `readReviewServingRows` with contract `review.prompt.preview`. The `mart.project_scope_article`/`app.project_article` fallback, project/prompt/model metadata reads, and single-article hydration are now explicitly capped diagnostic/detail residuals in `reviewServingResidualReadAllowlist.ts`. Not complete: the fallback and hydration still need replacement by mandatory serving/detail contracts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| [~]    | Review detail/hydration                    | `src/server/routes/projectsRoutes/projectsRoutesPostArticleReviewDetails.ts`, `src/server/routes/ArticlesRoutes.ts` detail paths                                                                                   | V4 product read plus residual allowlist                 | Partial       | Reader        | Partial       | true - need further changes | Partial: API role proxies/fails closed and the project detail route uses `readReviewServingRows` for serving detail rows. Residual article, judgment, prompt, model, mart-freshness, import-source, assessment, and article-detail source reads are now classified in `reviewServingResidualReadAllowlist.ts` with purposes, caps, workload classes, and migration targets. Not complete: these reads still need keyed V4/detail contracts before the residual paths can be removed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| [x]    | Project list/access/config                 | `src/server/routes/ProjectsRoutes.ts`, `src/server/routes/projectsRoutes/projectAccessGuard.ts`                                                                                                                    | Owner-routed source access                              | Partial       | Reader/writer | Partial       | false                       | Current: API role routes are owner-dependent in `routeSurfaceInventory.ts`; `projectAccessGuard.ts` uses owner private API access when `canCurrentServerOwnDuckdb()` is false and local `app.project` only on owner-capable runtimes. Owner-side config writes append review-serving deltas in `ProjectsRoutes.ts` via `append*ReviewServingDeltas`/`append*ReviewConfigReviewServingDelta`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| [~]    | Project article membership                 | `src/server/routes/ProjectArticlesRoutes.ts`                                                                                                                                                                       | Owner-routed source access plus owner/background writer | Partial       | Reader/writer | Partial       | false                       | Partial: API role proxies/fails closed, owner-side add/delete writes are source access and deletion appends project-scope deltas/dirty work. `GET /api/projects/:id/articles` now reads page membership from durable `mart.project_scope_article` state with keyset cursors, caps `limit` at 100, returns `nextCursor`/`hasMore`, no longer computes owner-side `COUNT(*)`, and rejects legacy deep `page > 1` requests without a cursor so normal listing cannot fall back to `OFFSET`. Remaining compatibility work: legacy `totalCount`/`totalPages` are returned as `null`, and article title/import provenance are still bounded per-page source lookups until a dedicated V4 membership/detail contract carries those fields.                                                                                                                                                                                                                                                                                                                                            |
| [x]    | Add-to-project by filter/IDs               | `src/server/routes/ProjectsAddArticlesRoutes.ts`                                                                                                                                                                  | V4 durable job plus owner-routed source access          | Yes           | Durable job   | Yes           | false                       | Current: API role is owner-dependent; by-filter and by-IDs routes create `review.bulk.selection` jobs with `createReviewBulkOperationJob`, `reviewConfigHash`, filter criteria, search mode, and latest snapshot semantics. `ProjectsAddArticlesRoutes.test.ts` proves by-IDs is a durable job and does not call `insertArticlesIntoProject`; the deleted `selectArticleIdsOlap.ts` wrapper cannot be reintroduced as a production import because `duckdbRouteGuardrails.test.ts` guards retired OLAP imports.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| [~]    | Project export                             | `src/server/routes/ProjectExportRoutes.ts`, `src/server/services/projectTransfer/projectTransferExport*.ts`                                                                                                        | V4 durable job / owner-routed source access             | Partial       | Reader/job    | Partial       | false                       | Partial: API role proxies/fails closed, export creation creates `review.export.selection` jobs with manifest checks, keyset snapshot cursor, batch size, and payload budget; completed CSV downloads now consume persisted job-result article batches and hydrate bounded chunks from `mart.review_article_serving_v4`, `mart.review_article_serving_payload_v4`, and `mart.review_article_judgment_detail_serving_v4` using active/pinned snapshot scope, with no download-path `app.article`, `app.judgment`, or `OFFSET` scans. `ProjectExportRoutes.test.ts` covers job creation plus the bounded V4 download shape. Not complete: selected prompt metadata is still a keyed `app.prompt` read, author/full prompt-content parity depends on serving payload coverage, and project-transfer export services remain separately audited under A43.                                                                                                                                                                                                                           |
| [x]    | PDF fetch                                  | `src/server/routes/ArticlesRoutes.ts`, `src/server/services/pdfFetchJobs.ts`                                                                                                                                       | V4 durable job plus owner/background writer             | Yes           | Durable job   | Yes           | false                       | Current: API role is owner-dependent/sensitive; `/api/articles/pdf-fetch-bulk`, `/pdf-fetch-by-filter`, and `/pdf-fetch-by-project` create `review.pdf.selection` jobs via `createReviewBulkOperationJob`. `ArticlesRoutes.test.ts` covers durable request identities, and `pdfFetchJobs.ts` processes explicit article-id batches then appends article review-serving deltas after source updates.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| [x]    | Judgment jobs API reads                    | `src/server/routes/JudgmentsJobsRoutes.ts`, `src/server/routes/judgmentsJobsRoutesApiReadModel.test.ts`                                                                                                            | V4 product/job read plus owner-routed source access     | Yes           | Reader/job    | Yes           | false                       | Current: public job routes are owner-dependent in `routeSurfaceInventory.ts`, while ownerless health endpoints are diagnostics-only. Unassessed queue/count reads import `getJudgmentJobUnassessedArticlesFromServing`/`getJudgmentJobUnassessedCountFromServing`; `judgmentsJobsRoutesApiReadModel.test.ts` proves API-role list can use stale health projection instead of local owner DuckDB.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| [~]    | Comparison projects                        | `src/server/routes/ComparisonProjectsRoutes.ts`, `src/server/routes/comparisonProjectsRoutes/*`, `src/server/services/comparisonProjectServing*.ts`                                                                | Owner-routed source access / serving migration          | Partial       | Reader/writer | Partial       | false                       | Partial: API role proxies/fails closed through `routeSurfaceInventory.ts`, comparison serving services exist, normal judgment page/count/stats/export reads use active-generation serving helpers, count now fails closed without an active generation, and `ComparisonProjectsRoutes.servingContract.test.ts` guards bounded serving reads plus owner-routed source writes/rebuild cleanup. Not complete: the route surface remains a broad owner-side source/serving mix with direct source metadata/detail reads and no separate comparison serving admission/contract registry.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| [x]    | Data sources and imports                   | `src/server/routes/DataSourcesRoutes.ts`, `src/server/routes/DataSourcesImportRoutes/*`, `src/server/services/dataSourceQueryService.ts`, `src/server/services/covidenceImportService.ts`                          | Owner-routed source access / owner writer               | Partial       | Reader/writer | Partial       | false                       | Current: API role proxies/fails closed; `DataSourcesRoutes.ts` is owner-routed source metadata, and import create routes use transactions. `articleImportStoreService.ts` appends article/import-route review-serving deltas and import hot fields, Covidence appends project-scope/config/human deltas, and `importAndMetadataFanoutGuard.test.ts` plus route tests prove structured-file, Covidence, PubMed, Europe PMC, and FHIR import entrypoints do not call synchronous affected-project fanout after source writes. Workload-context default-on enforcement remains tracked by A7/A11.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| [~]    | Prompts/subprojects/models/providers       | `src/server/routes/PromptsRoutes.ts`, `src/server/routes/SubprojectsRoutes.ts`, `src/server/routes/ModelsRoutes.ts`, `src/server/routes/ProviderModelsRoutes.ts`, `src/server/routes/ProviderConnectionsRoutes.ts` | Owner-routed source access                              | Partial       | Reader/writer | Partial       | false                       | Partial: API role proxies/fails closed for these source-metadata routes via `routeSurfaceInventory.ts`; prompt merge and subproject create append review-serving config/scope deltas, provider/model writes advance project-transfer dependency dirty tokens, and `importAndMetadataFanoutGuard.test.ts` blocks V4 rebuild/snapshot/mart writes in foreground route/repository changes. Remaining gap: provider/model changes are not yet proven to enqueue review-serving V4 config dirty/rebuild work for affected projects when execution identity changes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| [x]    | Human assessment routes                    | `src/server/routes/HumanAssessmentRoutes/*`                                                                                                                                                                        | V4 product read plus owner-routed bounded source writes | Yes           | Reader/writer | Yes           | false                       | Current: API role proxies/fails closed. Overview and both-project overview read active project metadata then per-project V4 count contracts (`review.human.count`/`review.both.count`) with active or last-known-good manifests; tests block the prior broad `app.judgment_human`, `app.judgment`, and `app.project_prompt` aggregate shapes. Init selects the next article via `review.queue.unassessed` with `queueKind=human-unreviewed` and hydrates via `review.unassessed.rowsByArticleSet`, with tests proving there is no `mart.project_scope_article` or `app.article` fallback. Submit keeps human-judgment deltas/dirty hooks intact while validation reads are bounded to `LIMIT 2` pending articles and the current article's prompt rows.                                                                                                                                                                                                                                                                                                                        |
| [x]    | Tokens/request attempts/provider telemetry | `src/server/routes/tokensRoutes/*`, `src/server/services/tokenUseQueryService.ts`, `src/server/services/requestAttemptCloseoutService.ts`, `src/server/services/judgmentProviderTelemetryHistoryService.ts`        | Owner-routed source access / admin-job read             | N/A           | Reader/writer | N/A           | false                       | Current: token routes are owner-dependent diagnostics/sensitive in `routeSurfaceInventory.ts`, and handlers go through token/provider telemetry services rather than normal product review routes. `tokenUseQueryService.ts` now passes admin telemetry workload contexts on token inserts, totals/timeline/top-token diagnostics, failed-request list/detail, prompt/model lookups, and caps failed-request list pagination at 100 rows with a bounded offset. `requestAttemptCloseoutService.ts` uses admin telemetry workload contexts for maintenance, online rebuild, startup backfill, and failure recording while keeping token-use scans cursor/high-water/batch bounded. `judgmentProviderTelemetryHistoryService.ts` uses workload contexts for insert/prune/delete/query and scopes bucket history by job, provider, and time range. Evidence: `tokenTelemetryDuckdbAccess.test.ts` guards workload-context markers, bounded query shapes, and absence of project-review raw scan tokens/tables in these services; focused adjacent service/route tests still pass. |

## V4 Serving And Projector Checklist

| Status | Area                               | Files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Classification                       | V4 compatible | R/W               | Uses new CQRS | Legacy | Required handling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------ | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------- | ----------------- | ------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [x]    | Contracts and admission            | `src/server/reviewServing/reviewServingContracts.ts`, `reviewServingReadContracts.ts`, `reviewServingAdmission.ts`, `reviewServingCursor.ts`                                                                                                                                                                                                                                                                                                                                                             | V4 product read                      | Yes           | Reader            | Yes           | false  | Current V4-style foreground admission source. Evidence: `reviewServingReadContracts.test.ts` verifies coverage for hot read keys, mounted route inventory, serving table names, and no raw fallback tables; `reviewServingAdmission.test.ts` rejects unregistered, over-budget, stale, unsupported search/count, and missing identity reads before DuckDB execution; `reviewServingCursor.test.ts` validates cursor/config/snapshot/filter shape.                                                                                                                                                                                                                                                                                                                                                        |
| [x]    | V4 reader/route services           | `src/server/reviewServing/reviewServingReader.ts`, `reviewServingLlmReviewRouteService.ts`, `reviewServingFilterRouteService.ts`, `reviewServingHumanBothUnassessedRouteService.ts`, `reviewSearchService.ts`                                                                                                                                                                                                                                                                                            | V4 product read                      | Yes           | Reader/job        | Yes           | false  | Current V4-style readers and jobs exist for migrated list/filter/human/both/unassessed/search routes: `reviewServingReader.test.ts`, `reviewServingLlmReviewRouteService.test.ts`, `reviewServingFilterRouteService.test.ts`, `reviewServingHumanBothUnassessedRouteService.test.ts`, and `reviewSearchService.test.ts` prove readiness states, token-prefix serving reads, async substring jobs, and no OLAP/raw fallback for those services.                                                                                                                                                                                                                                                                                                                                                           |
| [x]    | SQL builders and guards            | `src/server/reviewServing/reviewServingSql*.ts`, `reviewServingSql.test.ts`, `reviewServingResidualReadAllowlist.test.ts`                                                                                                                                                                                                                                                                                                                                                                                | V4 product read / residual allowlist | Yes           | Reader/guard      | Yes           | false  | Current V4-style product SQL plus explicit residual allowlist. Evidence: `reviewServingSql.test.ts` guards serving SQL shape and forbidden raw fallback tokens; `reviewServingResidualReadAllowlist.ts` records residual foreground source reads with purposes/caps/migration targets, and `reviewServingResidualReadAllowlist.test.ts` verifies the allowlist inventory.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| [x]    | Manifest and snapshot pins         | `reviewServingManifestRepository.ts`, `reviewServingSnapshotPromotionService.ts`, `reviewServingSnapshotPinRepository.ts`, `reviewServingRetentionService.ts`                                                                                                                                                                                                                                                                                                                                            | V4 product read / single V4 writer   | Yes           | Reader/writer     | Yes           | false  | Current V4-style manifest/pin/retention state. Evidence: `reviewServingManifestRepository.test.ts` covers idempotent manifest upsert, failed candidates preserving active/last-known-good, and promotion retirement; `reviewServingSnapshotPromotionService.test.ts` validates required/optional component state and watermarks; `reviewServingSnapshotPinRepository.test.ts` covers idempotent pins, ref counts, release, and cleanup blocking; `reviewServingRetentionService.test.ts` covers bounded cleanup protected by active/last-known-good/pinned snapshots.                                                                                                                                                                                                                                    |
| [x]    | Dirty/delta intake                 | `reviewChangeDeltaDirtyIntakeService.ts`, `reviewImportDeltaDirtyIntakeService.ts`, `reviewServingDirtyWorkService.ts`                                                                                                                                                                                                                                                                                                                                                                                   | Owner/background writer              | Yes           | Writer            | Yes           | false  | Current owner/background writer path. Evidence: `reviewChangeDeltaDirtyIntakeService.test.ts` and `reviewImportDeltaDirtyIntakeService.test.ts` cover delta-to-dirty intake, and `reviewServingDirtyWorkService.test.ts` proves coalescing by project/component identity, bounded claims, source-partition/projection-identity batching, stale lease reclaim, terminal states, and transactional acknowledgements/watermarks.                                                                                                                                                                                                                                                                                                                                                                            |
| [x]    | Projector service and writer       | `reviewServingProjectorService.ts`, `reviewServingProjectorWriter.ts`, `src/server/workers/reviewServingProjectorWorker.ts`                                                                                                                                                                                                                                                                                                                                                                              | Single V4 writer                     | Yes           | Writer            | Yes           | false  | Current single V4 writer/promotion boundary. Evidence: `reviewServingProjectorService.test.ts` covers bounded wakes, dependency-ordered batches, retry/release/failure behavior, queue/import pressure gates, and no raw foreground fallback for unsupported scopes; `reviewServingProjectorWriter.test.ts` proves rows/manifests/acks/watermarks/promotion are written in one transaction, guards that only `reviewServingProjectorWriter.ts` writes V4 mart rows/promotes snapshots, and scans legacy mart maintenance paths so `getDuckdbMartMaintenanceService.ts`, `projectMartDirty*`, `projectMartLargeRebuild*`, and `projectMartRefreshWorker.ts` cannot write V4 review-serving mart rows, V4 snapshot/projection/selected-import manifests, or call projector promotion; `src/server/workers/reviewServingProjectorWorker.test.ts` covers bounded worker cycles and real runner wiring.                                                                                                                                                                                                 |
| [x]    | Projection components              | `reviewServingSelectedImportProjector.ts`, `reviewServingSelectedImportPatchProjector.ts`, `reviewServingProjectScopeProjector.ts`, `reviewServingDisplayPayloadProjector.ts`, `reviewServingJudgmentPayloadProjector.ts`, `reviewServingLlmStatusProjector.ts`, `reviewServingHumanStatusProjector.ts`, `reviewServingFilterPostingProjector.ts`, `reviewServingFilterOptionProjector.ts`, `reviewServingSummaryProjector.ts`, `reviewServingQueueProjector.ts`, `reviewServingTitleSearchProjector.ts` | Single V4 writer                     | Yes           | Writer            | Yes           | false  | Current V4-style component projectors. Evidence: adjacent tests for each named projector cover bounded claimed writes/rebuilds, component-scoped identities, watermarks, tombstones/idempotent patches, and serving-only rows: `reviewServingSelectedImportProjector.test.ts`, `reviewServingSelectedImportPatchProjector.test.ts`, `reviewServingProjectScopeProjector.test.ts`, `reviewServingDisplayPayloadProjector.test.ts`, `reviewServingJudgmentPayloadProjector.test.ts`, `reviewServingLlmStatusProjector.test.ts`, `reviewServingHumanStatusProjector.test.ts`, `reviewServingFilterPostingProjector.test.ts`, `reviewServingFilterOptionProjector.test.ts`, `reviewServingSummaryProjector.test.ts`, `reviewServingQueueProjector.test.ts`, and `reviewServingTitleSearchProjector.test.ts`. |
| [x]    | Rebuild/chunk/request repositories | `reviewServingRebuildRequestRepository.ts`, `reviewServingV4RebuildRequestService.ts`, `reviewServingChunkManifestRepository.ts`                                                                                                                                                                                                                                                                                                                                                                         | Owner/background writer              | Yes           | Writer            | Yes           | false  | Current V4 owner/background maintenance state, not product-read SQL. Evidence: `reviewServingRebuildRequestRepository.test.ts` covers budgeted chunks, re-admission, over-budget parking, real article bounds, and partial chunk rejection; `reviewServingV4RebuildRequestService.test.ts` covers admission estimates, missing-snapshot bootstrap, bounded article chunks, no-op empty projects, reuse rules, watermarks, and fan-out budgets; `reviewServingChunkManifestRepository.test.ts` covers restart resume, leases/heartbeats, retry/backoff, output validation, terminal states, and changed input digests.                                                                                                                                                                                    |
| [x]    | Bulk/search/job services           | `reviewBulkOperationService.ts`, `src/server/workers/reviewBulkOperationWorker.ts`, `reviewServingJudgmentJobQueueService.ts`                                                                                                                                                                                                                                                                                                                                                                            | V4 durable job / owner-background    | Yes           | Reader/writer/job | Yes           | false  | Current V4 durable job plus owner/background processing. Evidence: `reviewBulkOperationService.test.ts` proves PDF/add-by-filter criteria are persisted with pinned/latest snapshot semantics, rejects missing active snapshots, and enforces article-id count/payload caps; `src/server/workers/reviewBulkOperationWorker.test.ts` proves bounded durable keyset progress, add-to-project/PDF/export batch execution, no `OFFSET`, tokenized title search criteria, heartbeats, cancellation, and terminal failure persistence; `reviewServingJudgmentJobQueueService.test.ts` covers queue count/preview/refill scope.                                                                                                                                                                                 |
| [x]    | Benchmark/parity/diagnostics       | `reviewServingRouteParityRunner.ts`, `reviewServingBenchmark.ts`, `reviewServingDiagnosticsRepository.ts`, `reviewServingDesktopInterruptionEvidence.ts`                                                                                                                                                                                                                                                                                                                                                 | Verification/admin                   | N/A           | Verification      | N/A           | false  | Current verification/admin surfaces, not product fallback. Evidence: `reviewServingRouteParityRunner.test.ts` blocks migration on semantic, invariant, SQL-shape, cursor, freshness, latency, response-size, and forbidden foreground DuckDB mismatches; `reviewServingBenchmark.test.ts` documents/requires release-scale identity, memory/temp/row/queue/work counters, no temp spill, and latency/memory gates; `reviewServingDiagnosticsRepository.test.ts` summarizes V4 diagnostic state; `reviewServingDesktopInterruptionEvidence.test.ts` keeps desktop/interruption evidence markers present.                                                                                                                                                                                                  |

## Legacy OLAP Retirement Checklist

| Status | Files                                             | Classification     | V4 compatible | R/W        | Uses new CQRS | Legacy                      | Required handling                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------ | ------------------------------------------------- | ------------------ | ------------- | ---------- | ------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [~]    | `src/services/olap/duckdbOlap.ts`                 | Quarantined legacy | No            | Reader     | No            | true - need further changes | Current handling is quarantined legacy plus deletion planned, not retired. Evidence: normal review/job foreground imports are guarded by `src/server/reviewServing/reviewServingSql.test.ts`, and `duckdbRouteGuardrails.test.ts` blocks new production imports. Leave partial because `src/services/olap/duckdbOlap.test.ts` still covers raw fallback branches and the product detail, prompt-preview, diagnostic, export, and comparison rows still list residual blockers. |
| [x]    | Deleted `src/services/olap/articlesReviewsOlap.ts`        | Quarantined legacy | N/A           | Reader     | N/A           | true - deleted              | Deleted after V4 product read replacement. Evidence: no production callers of `queryArticlesReviewsFromOlap` or `countArticlesReviewsFromOlap` remained, `src/server/reviewServing/reviewServingLlmReviewRouteService.test.ts` asserts the list/count routes do not import it, and `duckdbRouteGuardrails.test.ts` blocks reintroduced production imports.                                     |
| [x]    | Deleted `src/services/olap/articlesReviewsBothOlap.ts`    | Quarantined legacy | N/A           | Reader     | N/A           | true - deleted              | Deleted after V4 product read replacement. Evidence: no production caller of `queryArticlesReviewsBothFromOlap` remained, `src/server/reviewServing/reviewServingHumanBothUnassessedRouteService.test.ts` asserts the both-mode route does not import it, and `duckdbRouteGuardrails.test.ts` blocks reintroduced production imports.                                                                                      |
| [x]    | Deleted `src/services/olap/articlesReviewsFiltersOlap.ts` | Quarantined legacy | N/A           | Reader     | N/A           | true - deleted              | Deleted after V4 product read replacement. Evidence: no production callers of `getDatabaseBasedFiltersFromOlap` or `getNumericFiltersFromOlap` remained, `src/server/reviewServing/reviewServingFilterRouteService.test.ts` asserts filter routes do not import it, and `duckdbRouteGuardrails.test.ts` blocks reintroduced production imports.                                                |
| [x]    | Deleted `src/services/olap/unassessedArticlesOlap.ts`     | Quarantined legacy | N/A           | Reader     | N/A           | true - deleted              | Deleted after V4 product/job read replacement. Evidence: no production callers of its `*FromOlap` exports remained, `src/server/reviewServing/reviewServingSql.test.ts` asserts judgment job routes/cron use serving queue helpers instead, `reviewServingHumanBothUnassessedRouteService.test.ts` guards the review route, and `duckdbRouteGuardrails.test.ts` blocks reintroduced production imports.                          |
| [x]    | Deleted `src/services/olap/selectArticleIdsOlap.ts`       | Quarantined legacy | N/A           | Reader/job | N/A           | true - deleted              | Deleted after V4 durable job replacement. Evidence: no production caller of `selectArticleIdsByFilterOlap` remained, `src/server/routes/ProjectsAddArticlesRoutes.test.ts` covers durable bulk-operation job creation for add-by-filter/IDs, `src/server/reviewServing/reviewServingReadContracts.test.ts` forbids mounted migrated route imports, and `duckdbRouteGuardrails.test.ts` blocks reintroduced production imports. |

## Background, Cron, Import, And Maintenance Checklist

| Status | Area                                    | Files                                                                                                                                                                                                                               | Classification                                          | V4 compatible | R/W           | Uses new CQRS | Legacy                      | Required handling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------ | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------- | ------------- | ------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [x]    | Judgment cron and LLM processing        | `src/server/cron/judgmentsJobs.ts`, `src/server/cron/judgmentsJobs/*`, `src/agent/judge/*`                                                                                                                                          | Owner/background writer plus V4 queue/projection state  | Yes           | Reader/writer | Yes           | false                       | Current: judgment queue selection uses V4 queue/projection state in `judgmentsJobsCronGetPrompts.ts` via `getJudgmentJobUnassessedPairsFromServing`, with bounded metadata workload contexts. Judgment writes append V4 deltas/outbox/dirty state in `judgmentsJobsMarkDirtyWork.ts` and `judgeStoreJudgment.ts`; tests cover serving queue use, dirty fanout, SQLite outbox import, and atomic dirty rollback.                                                                                                                                                |
| [ ]    | Full text jobs                          | `src/server/cron/fullTextJobs.ts`, `src/server/cron/fullTextConversionJobs.ts`, `src/server/utils/ensureFullText.ts`                                                                                                                | Owner/background writer                                 | Partial       | Reader/writer | Partial       | false                       | Partial: owner/maintenance loops gate the cron paths, and successful conversions append article review-serving deltas in `fullTextConversionJobs.ts` and `ensureFullText.ts`. Not checked because `fullTextJobs.ts` and `fullTextConversionJobs.ts` still perform running-job/project source scans plus fallback article scans, `fullTextJobs.ts` can update `app.article.full_text_pdf` without appending deltas, and workload-context/boundedness proof for all full-text reads was not found.                                                               |
| [ ]    | Provider admission/telemetry            | `src/server/cron/judgmentsJobs/providerAdmissionLease.ts`, `src/server/cron/judgmentsJobs/judgmentDispatchTelemetry.ts`, provider repositories                                                                                      | Owner/background writer                                 | Partial       | Reader/writer | Partial       | false                       | Partial: provider admission leases are owner-aware in `providerAdmissionLease.ts` and covered by `providerAdmissionLease.test.ts`/`providerAdmissionLeaseFencing.test.ts`; telemetry aggregates owner/judge runtime state in `judgmentDispatchTelemetry.ts` and related tests. Not checked because provider repository/source reads are not all workload-context proven, and admin/API reads still rely on owner routing.                                                                                                                                      |
| [ ]    | Import/store workflows                  | `src/server/services/articleImportStoreService.ts`, `articleCanonicalMatcher.ts`, `covidenceImportService.ts`, `src/agent/*Workflow/*StoreEntries.ts`, `structuredFileImport*`, `pubmed/europePmc/fhir` import paths                | Owner/background writer plus V4 queue/projection state  | Partial       | Writer        | Partial       | false                       | Partial: `articleImportStoreService.ts` appends import-run deltas, pre-extracts hot fields, and source-metadata article deltas; `covidenceImportService.ts` appends project-scope/config/human deltas; `importAndMetadataFanoutGuard.test.ts` covers structured-file, PubMed, Europe PMC, and FHIR import entrypoints plus agent store paths against synchronous affected-project fanout. Not complete because the full broader import/store workflow audit still needs workload-context proof and agent workflow coverage beyond the A22 product route paths. |
| [ ]    | Dirty materialization                   | `projectMartDirtyMaterializationService.ts`, `projectMartDirtyRefreshStateService.ts`, `projectMartDirtyRefreshQuarantineBarrier.ts`                                                                                                | Owner/background writer plus V4 queue/projection state  | Partial       | Writer        | Partial       | true - need further changes | Partial: dirty tokens, article/project input temp tables, leases, quarantine barriers, and bounded claims exist in `projectMartDirtyRefreshStateService.ts`, with coverage in `projectMartDirtyRefreshStateService.test.ts`, `projectMartDirtyMaterializationService.test.ts`, and `projectMartDirtyRefreshQuarantineBarrier.test.ts`. Not checked because this still serves legacy mart refresh state, not fully V4 projector-only output.                                                                                                                    |
| [ ]    | Mart refresh worker                     | `src/server/workers/projectMartRefreshWorker.ts`, `getDuckdbMartMaintenanceService.ts`                                                                                                                                              | Owner/background writer                                 | Partial       | Writer        | Partial       | true - need further changes | Partial: worker cycles claim bounded dirty article batches and call background maintenance services; `projectMartRefreshWorker.test.ts` and `getDuckdbMartMaintenanceService.test.ts` cover batch/lease behavior. Not checked because `getDuckdbMartMaintenanceService.ts` still writes legacy `mart.review_article_serving*`/rollup structures and uses scoped import selection, so this is not only a scheduler/waker after V4 cutover.                                                                                                                      |
| [ ]    | Large rebuild services                  | `projectMartLargeRebuildExecutor.ts`, `projectMartLargeRebuildRunner.ts`, `projectMartLargeRebuildCyclesService.ts`, `projectMartLargeRebuildStateService.ts`, `projectMartLargeRebuildProgressService.ts`                          | Owner/background writer                                 | Partial       | Writer        | Partial       | true - need further changes | Partial: large rebuild executor uses `queryJsonBackground`/`runBackground`, keyset cursors, leases, generation cleanup batches, and tests cover runner/state/cycles/progress. Not checked because `projectMartLargeRebuildExecutor.ts` still rebuilds legacy mart/serving tables directly and has not become only a V4 projector chunk-manifest/backfill driver.                                                                                                                                                                                               |
| [ ]    | Comparison serving builders             | `comparisonProjectServingGenerationService.ts`, `comparisonProjectServingRebuildService.ts`, `comparisonProjectServingRollupBuilder.ts`, `comparisonProjectServingCellBuilder.ts`, `comparisonProjectServingInvalidationService.ts` | Owner/background writer / serving migration             | Partial       | Writer        | Partial       | false                       | Partial serving migration: comparison builders use background DB methods and generation promotion state, with tests for rebuild/rollup/cell/invalidation services. Not checked because product comparison routes are still classified as owner-routed source access/serving migration above, and comparison reads do not yet have complete V4-style serving/admission contracts or workload-context proof.                                                                                                                                                     |
| [ ]    | Project transfer                        | `src/server/services/projectTransfer/*`, `src/server/routes/projectTransferRoutes.ts`                                                                                                                                               | Owner-routed source access plus owner/background writer | Partial       | Reader/writer | Partial       | false                       | Partial: route surface is owner-dependent/source-access, and commit writer appends import-run hot-field deltas plus project dirty state in `projectTransferCommitWriter.ts`. Not checked because project-transfer import/export remains a broad source-data workflow and the named package was not fully proven batched, workload-contexted, dirty-token-only, and free of API-role direct DuckDB beyond owner routing.                                                                                                                                        |
| [ ]    | Archived cleanup and maintenance leases | `archivedProjectCleanupService.ts`, `maintenanceWorkLeaseService.ts`, cleanup/recovery scripts                                                                                                                                      | Owner/background writer                                 | N/A           | Writer        | N/A           | false                       | Partial: `archivedProjectCleanupService.ts` has phase-specific batch limits and `maintenanceWorkLeaseService.ts` records scoped leases; `runArchivedProjectBoundedCleanup.ts` uses `withDuckdbMaintenanceAccess`. Not checked because all cleanup/recovery scripts were not proven workload-contexted, and archived cleanup still touches broad legacy mart/source tables even though deletion is batched.                                                                                                                                                     |
| [x]    | Migrations and DB schema                | `src/db/migrateDuckdb.ts`, `src/db/duckdbMigrations/*`                                                                                                                                                                              | Maintenance/migration                                   | N/A           | Maintenance   | N/A           | false                       | Current maintenance/migration path: `migrateDuckdb.ts` runs with `withDuckdbMaintenanceAccess`, `getMaintenanceDuckdbWorkloadContext('migrateDuckdb')`, migration transactions/non-transaction allowlist, and checkpoint; `migrateDuckdb.test.ts` covers migration application and rollback/non-transaction behavior. This is explicitly not a V4 product-read path.                                                                                                                                                                                           |
| [ ]    | Operator scripts                        | `scripts/*.ts` that call DB services, `dbBackup.ts`, `dbQuerySnapshot.ts`, `duckdbCheckpoint.ts`, recovery/rebuild/request scripts                                                                                                  | Admin/debug/tool allowlist                              | N/A           | Admin/tool    | N/A           | false                       | Partial: many maintenance scripts use `withDuckdbMaintenanceAccess` (`duckdbCheckpoint.ts`, request/recovery/backfill scripts), `dbQuerySnapshot.ts` uses `createDuckdbSnapshotForCli` plus `getReadOnlyDuckdbRuntimeOptions()`, and `dbBackup.ts` uses owner snapshots. Not checked because a repo-wide script allowlist/proof is incomplete and some script families still need explicit workload-context/memory-option evidence.                                                                                                                            |

## Admin And Diagnostic Checklist

| Status | Area                        | Files                                                                              | Classification                                         | V4 compatible | R/W               | Uses new CQRS | Legacy | Required handling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------ | --------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------- | ----------------- | ------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [x]    | Admin investigation         | `src/server/routes/AdminInvestigateRoutes.ts`                                      | Admin/debug/tool allowlist and owner diagnostics       | N/A           | Admin/tool        | N/A           | false  | Implemented today as explicit `/api/admin/*` maintenance/settings diagnostics and controls. Evidence: `src/server/routes/routeSurfaceInventory.ts` classifies admin routes as `maintenance-debug-api`, `sensitive-local-api`, or ownerless settings diagnostics; `routeSurfaceInventory.test.ts` proves mounted-route inventory and owner-proxy classification coverage; `AdminInvestigateRoutes.test.ts` covers maintenance and worker runtime diagnostics.                                                 |
| [x]    | DuckDB owner diagnostics    | `DuckdbOwnerConnectionsRoutes.ts`, `runtimeReadyRoutes.ts`, owner connection pages | Owner diagnostics and ownerless diagnostic fallback    | N/A           | Admin/control     | N/A           | false  | Implemented today as explicit owner/runtime diagnostics and heartbeat control, not product data fallback. Evidence: `src/server/routes/DuckdbOwnerConnectionsRoutes.ts` exposes owner connection overview/heartbeat; `runtimeReadyRoutes.ts` exposes readiness/runtime state; `routeSurfaceInventory.ts` classifies these as `duckdb-owner-diagnostics`, `local-bootstrap`, or ownerless/settings diagnostics; `DuckdbOwnerConnectionsRoutes.test.ts` and `runtimeReadyRoutes.test.ts` cover route behavior. |
| [x]    | DuckDB Studio/snapshot      | `DuckdbStudioRoutes.ts`, `scripts/dbStudio.ts`, `scripts/dbQuerySnapshot.ts`       | Admin/debug/tool allowlist and read-only snapshot      | N/A           | Admin reader      | N/A           | false  | Implemented today as explicit operator snapshot tooling. Evidence: `DuckdbStudioRoutes.ts` requires DuckDB owner role before creating snapshots; `scripts/dbStudio.ts` opens the snapshot with `duckdb -readonly -ui`; `scripts/dbQuerySnapshot.ts` creates a CLI snapshot and opens it with `getReadOnlyDuckdbRuntimeOptions()`; `DuckdbStudioRoutes.test.ts` verifies a readable snapshot.                                                                                                                 |
| [x]    | Ownerless readable backends | `ownerlessReadableBackends.ts`, read-only validation tests                         | Ownerless diagnostic fallback and test-only validation | N/A           | Diagnostic reader | N/A           | false  | Implemented today for declared bootstrap/diagnostic routes only. Evidence: `src/server/utils/ownerlessReadableBackends.ts` declares only runtime ready/state, owner connections, heartbeat, worker runtime diagnostics, and judgment dispatch diagnostics with `routeKind` `bootstrap` or `diagnostics`; `ownerlessReadableBackends.test.ts` verifies owner roles skip live read-only validation, API read-only validation releases locks, and API owner-proxy falls back to ownerless control state.        |

## Client/UI Checklist

| Status | Area                         | Files                                                      | Classification                                 | V4 compatible | R/W                  | Uses new CQRS | Legacy                      | Required handling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------ | ---------------------------- | ---------------------------------------------------------- | ---------------------------------------------- | ------------- | -------------------- | ------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [ ]    | Review UI freshness/warnings | `src/components/main/reviews/*`, `reviewsWarningsQuery.ts` | Client-over-API plus V4/readiness-consuming UI | Partial       | Client reader        | Partial       | false                       | Partially current, still planned for full proof. Evidence: no direct DuckDB/client `@duckdb` imports were found in `src/components/main/reviews/*`; `reviewsWarningsQuery.ts` calls `apiClient.api.projectsreviewswarnings.post`, and list containers gate article queries on `warningsQuery.data?.indexing.serving.readable` before calling `articlesreviews*` API query helpers. `routeSurfaceInventory.ts` classifies the review UI API routes as owner-dependent, and `reviewsProjectWarnings.vitest.tsx` covers stale/unavailable browser copy. Not checked because `projectsRoutesGetReviewsWarnings.ts` still mixes V4 diagnostics/readiness with legacy large-rebuild, dirty-materialization, owner, and queue diagnostics, and the UI still treats warning-query failure as permission to load article rows.                                                                                                                                   |
| [ ]    | Admin UI                     | `src/app/routes/+admin/*`, `src/components/Navigation.tsx` | Client-over-API admin diagnostics UI / planned | N/A           | Client reader/writer | N/A           | true - need further changes | Partially current, still planned for hardening. Evidence: no direct DuckDB/client `@duckdb` imports were found in `src/app/routes/+admin/*` or `Navigation.tsx`; admin pages and navigation call Eden/API helpers such as `apiClient.api.admin['duckdb-append-metrics']`, `apiClient.api.admin['project-mart-large-rebuild-status']`, `apiClient.api.admin['project-mart-large-rebuild-run']`, `fetchDuckdbOwnerConnections`, and `fetchLlmStatus`. `routeSurfaceInventory.ts` classifies `DuckdbOwnerConnectionsRoutes.ts` as DuckDB-owner diagnostics and `AdminInvestigateRoutes.ts` admin routes as owner-dependent maintenance/settings diagnostics or ownerless worker diagnostics. Not checked because the admin UI still exposes legacy project-mart-large-rebuild run/pause/resume controls through `+admin/+project-mart-large-rebuild/+index.tsx`, and explicit proof that every admin page is diagnostics-only or V4-rewired is incomplete. |

## First Implementation PRs

- [ ] **PR 1: docs and route gate**
  - [x] Update `DUCK_OOM_FIX_PLAN.md` to reference this checklist.
  - [x] Add/extend route inventory exhaustiveness tests.
  - [ ] Add proxy-order integration tests for API role.
  - [x] Add owner-unavailable tests for representative project routes.

  Evidence note: current route inventory/proxy guard work is partly complete.
  `DUCK_OOM_FIX_PLAN.md` points to this audit file; `routeSurfaceInventory.test.ts`
  proves mounted route inventory and classifier coverage; `publicRouteSurfaceGate.test.ts`
  covers public route gating; `ApiProxyRoutes.test.ts` and
  `ApiProxyRoutes.retry.test.ts` prove fail-closed owner-routed source access for
  `/api/users` and project-transfer upload when no owner is available. Planned:
  explicit API-role proxy-order integration proof; current evidence is only the
  `serverMain.ts` registration order.

- [ ] **PR 2: static and runtime guardrails**
  - [ ] Add static guard for route-facing DuckDB imports.
  - [x] Add static guard for `duckdbOlap` quarantine.
  - [ ] Add low-level missing-workload-context rejection for normal foreground work,
        initially behind a test/runtime switch if needed.

  Evidence note: current guardrail work is partial. Quarantined legacy/static V4
  product-read checks exist in `reviewServingSql.test.ts` and
  `reviewServingReadContracts.test.ts`, including `duckdbOlap`, raw fallback SQL,
  `selected_scoped_article_import`, and mounted migrated route import guards;
  `getAppQueryService.test.ts` covers a small audited read-only module set. Planned:
  broad route-facing DuckDB import guard, broad normal foreground SQL guard, and
  low-level runtime guard. `duckdbService.ts` still executes `work()` when the
  workload context is `undefined`.

- [x] **PR 3: residual read allowlist**
  - [x] Create or update `reviewServingResidualReadAllowlist.ts`.
  - [x] Register every non-V4 review health/warning/detail/prompt-preview read with
        purpose, cap, workload class, and migration target.

  Evidence note: current residual allowlist work is complete for the audited
  product-route residuals. `reviewServingResidualReadAllowlist.ts` lists audited
  review residual route files, `ArticlesRoutes.ts` detail residuals, and
  product-facing `appQueryServiceCore.ts` methods with marker, purpose, cap,
  workload class, and migration target. `reviewServingResidualReadAllowlist.test.ts`
  checks marker presence and required metadata fields.

- [ ] **PR 4+: route-by-route V4 migration**
  - [x] Move one product surface at a time to V4 services/jobs.
  - [x] Delete or hard-disable the matching raw fallback in the same PR.
  - [x] Add SQL-shape tests and route parity tests for each migrated surface.

  Evidence note: current V4 product read and durable job migration is real but not
  complete. Migrated LLM, human, both, unassessed, filter/facet, add-to-project,
  PDF, and judgment-job paths use V4 services/jobs with raw fallback imports
  removed or guarded; route-service tests and `reviewServingSql.test.ts` cover SQL
  shape, while `reviewServingRouteParityRunner.test.ts` covers parity-gate behavior.
  Planned: finish unchecked product routes above, including detail/hydration,
  prompt preview, health/warnings, project membership, export download, comparison,
  human assessment, telemetry, and any remaining owner-routed source access.

- [ ] **Final evidence PR**
  - [ ] Current-DB smoke proves API role proxies/fails closed and owner serves V4.
  - [ ] Synthetic and physical release evidence prove no foreground raw fallback,
        no temp spill, and bounded rows/result bytes.

  Evidence note: current smoke evidence is planned/partial. `package.json` defines
  `test:network-smoke:current-db` and `test:dev-server:current-db`;
  `tests/e2e/networkSmoke.spec.ts` and `scripts/runWithRuntimeProfile.test.ts`
  check forbidden runtime patterns for API-role DuckDB ownership, owner heartbeat
  errors, fatal DuckDB restarts, and worker-loop failures. Planned: final current-DB
  owner-routed/V4 smoke proof plus synthetic and physical release evidence for no
  foreground raw fallback, zero temp spill, and bounded rows/result bytes.

## Audit Commands

Use these command groups to keep this file current. Checked groups exist today
and match current repo naming; unchecked groups are still planned proof gaps for
the V4/owner-routing cutover.

- [x] **File discovery.** Refreshes the exact DuckDB-related file set used to
      maintain this checklist across server code, scripts, docs, and package
      scripts.

```bash
git fetch origin main --prune
git status --short --branch
rg -l "DuckDB|duckdb|runDuckdb|DuckDBInstance|@duckdb/node-api|duckdbOlap|readOnlyDuckdb|appReadOnlyDatabase|appDatabaseService|getAppDatabaseService|getAppQueryService" src scripts TESTS.md DUCK*.md package.json
```

- [x] **Production DuckDB call discovery.** Lists non-test production call sites
      that still touch low-level DuckDB services, legacy OLAP wrappers, app query
      helpers, read-only services, or direct `@duckdb/node-api` access so each
      row can stay classified as V4 product read, owner-routed source access,
      owner/background writer, residual allowlist, admin/debug/tool, quarantined
      legacy, or test-only.

```bash
rg -n "runDuckdbJsonQuery|runDuckdbStatement|DuckDBInstance|@duckdb/node-api|duckdbOlap|readOnlyDuckdbService|appReadOnlyDatabaseService|appDatabaseService|getAppDatabaseService|getAppQueryService|duckdbRunner" src --glob '!**/*.test.ts' --glob '!**/*.vitest.tsx'
```

- [x] **Route inventory/proxy gates.** Proves current route classification names
      and mounted public route inventory are present, exhaustive, and aligned
      with API-role owner proxying/fail-closed behavior.

```bash
bun test src/server/routes/apiRouteClassification.test.ts src/server/routes/routeSurfaceInventory.test.ts src/server/routes/publicRouteSurfaceGate.test.ts
```

- [x] **API owner proxy gates.** Proves API-role owner proxy behavior, retry
      behavior, and fail-closed owner-unavailable behavior for owner-dependent
      routes.

```bash
bun test src/server/routes/ApiProxyRoutes.test.ts src/server/routes/ApiProxyRoutes.retry.test.ts
```

- [x] **V4 product-read and owner-routing static gates.** Proves current V4
      serving contracts, admission, SQL-shape guards, residual allowlist markers,
      migrated route-service guards, search ownership, parity harness shape, and
      audited read-only module guard still match the V4/owner-routing
      classification work.

```bash
bun test src/server/reviewServing/reviewServingReadContracts.test.ts src/server/reviewServing/reviewServingAdmission.test.ts src/server/reviewServing/reviewServingSql.test.ts src/server/reviewServing/reviewServingResidualReadAllowlist.test.ts src/server/reviewServing/reviewServingLlmReviewRouteService.test.ts src/server/reviewServing/reviewServingFilterRouteService.test.ts src/server/reviewServing/reviewServingHumanBothUnassessedRouteService.test.ts src/server/reviewServing/reviewSearchService.test.ts src/server/reviewServing/reviewServingSearchOwnership.test.ts src/server/reviewServing/reviewServingRouteParityRunner.test.ts src/server/services/getAppQueryService.test.ts
```

- [x] **Smoke gates.** Current repo scripts exist for current-DB browser/API
      smoke and real dev-server runtime smoke. They check API-role DuckDB
      ownership failures, owner heartbeat errors, fatal DuckDB restarts, worker
      loop failures, forbidden runtime logs, and related current-DB route/runtime
      regressions; they are not final release-scale physical proof.

```bash
bun run test:network-smoke:current-db
bun run test:dev-server:current-db
```

- [ ] **Planned broad route-facing import guard.** Current guards cover migrated
      review/job files and audited read-only modules, but there is no single
      broad static gate that fails every unallowlisted route handler import of
      generic DuckDB services, `duckdbOlap`, `duckdbRunner`, read-only services,
      or `@duckdb/node-api`.
- [ ] **Planned low-level missing-workload-context guard.** Current workload
      tests prove context forwarding and metrics behavior, but low-level DuckDB
      execution still allows `undefined` workload context in explicit paths.
- [x] **OLAP retirement guard.** Current tests quarantine normal review/job
      foreground imports and `duckdbRouteGuardrails.test.ts` fails new production
      imports of deleted OLAP wrappers or `duckdbOlap`. `duckdbOlap.ts` itself
      remains until product residual blockers are removed.
- [ ] **Planned final release-scale smoke proof.** Current smoke gates are
      practical regression gates; Phase 6 still needs true release-scale physical
      proof for no foreground raw fallback, zero foreground temp spill, bounded
      rows/result bytes, and desktop-style overlap/interruption behavior.
