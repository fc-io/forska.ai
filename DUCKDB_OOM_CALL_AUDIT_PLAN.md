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
- [x] **A16.** Complete the review health/warnings migration by separating V4
  readiness/manifest diagnostics from legacy mart, owner, dirty-materializer,
  and maintenance state, then register any remaining diagnostics-only source
  reads with caps. Current proof: `projectsRoutesGetReviewsWarnings.ts` no
  longer imports or queries legacy mart refresh/materialization/large-rebuild,
  owner, queue, or maintenance-lease diagnostics; legacy-only route tests are
  retired, V4 warning tests cover product readiness, and
  `reviewServingPhase5BStaticGuards.test.ts` blocks reintroducing those legacy
  calls. Remaining bounded source probes are prompt/article scope reads listed
  in `reviewServingResidualReadAllowlist.ts`.
- [x] **A17.** Complete prompt preview by replacing the
  `mart.project_scope_article`/`app.project_article` fallback and bounded
  article hydration with mandatory V4 prompt-preview/detail serving reads that
  fail closed when serving state is unavailable.
- [x] **A18.** Complete review detail/hydration by moving judgment, prompt,
  article, assessment, and import-source detail reads to keyed V4/detail
  contracts or capped residual source reads with migration targets. Current
  cleanup moves normal project review detail article, judgment, assessment, and
  prompt/model display hydration to keyed V4 detail contracts and fails
  unavailable when V4 detail state is missing; the remaining project config
  behavior read is capped residual metadata in `reviewServingResidualReadAllowlist.ts`.
  The separate `/api/articles/:id` detail/history endpoint is classified as a
  sensitive global source-article detail surface outside normal review detail
  fallback in `reviewServingAdjacentRouteSurfaces.ts` and `routeSurfaceInventory.ts`.
- [x] **A19.** Move project article membership listing away from owner-side
  `COUNT(*)`, `app.project_article`/`app.article` joins, and `OFFSET` toward V4
  job/keyset state. Current proof: `GET /api/projects/:id/articles` reads page
  membership from `mart.project_scope_article`, hydrates titles from bounded V4
  serving rows, returns keyset `nextCursor`/`hasMore`, keeps legacy totals as
  `null`, rejects deep pages without cursors, and the curated-articles UI now
  uses cursor pagination without import-origin provenance.
- [x] **A20.** Finish project export by making download expansion/CSV generation
  consume bounded job output and serving/detail contracts instead of broad
  owner-side `app.article`, `app.judgment`, and `app.prompt` reads. Current
  proof: completed CSV downloads consume persisted job-result article batches,
  hydrate article/judgment rows from V4 serving tables, and derive selected
  prompt labels/type/content from V4 judgment payload metadata instead of
  `app.prompt`. The separate prompt-only export endpoint and project-transfer
  export services remain under their own route/service audit scopes, including
  A43 for project transfer.
- [~] **A21.** Migrate comparison project reads to complete bounded serving
  contracts/admission and keep source writes owner-routed.
- [x] **A22.** Audit data-source/import create routes for atomic delta/hot-field
      append, workload context, and absence of synchronous project fanout across
      structured-file, Covidence, PubMed, Europe PMC, and FHIR paths.
- [x] **A23.** Prove prompt/subproject/model/provider changes enqueue V4
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
      prompt-preview, warning/health, comparison, and
      human-assessment contracts before marking those product rows migrated.
      Partial evidence is current in `reviewServingReadContracts.test.ts`,
      `reviewServingAdmission.test.ts`, `reviewServingRouteParityEvidence.test.ts`,
      `ProjectExportRoutes.test.ts`, and `reviewServingAdjacentRouteSurfaces.test.ts`.
      Remaining blockers: warning/health still documents residual source reads;
      comparison has no separate V4 admission/contract registry; do not mark
      those rows migrated yet.

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
  detail/prompt/diagnostic/comparison route no longer needs them. Partial:
  `duckdbOlap.ts` remains because raw fallback coverage still exists in
  `duckdbOlap.test.ts` and the diagnostic and comparison route rows
  above still list residual blockers; prompt preview, normal project review
  detail, global article-detail history, project article membership, and normal
  CSV export no longer contribute raw-fallback blockers.
- [x] **A35.** Add a final OLAP retirement guard that fails on new production
      imports of deleted legacy OLAP wrappers or `duckdbOlap` outside explicit
      admin/test fixtures.

### Background, Cron, Import, And Maintenance

- [x] **A36.** Keep judgment cron/LLM processing on V4 queue/projection reads and
      delta/outbox dirty writes.
- [x] **A37.** Audit full-text fetch/conversion jobs for bounded running-job and
      project scans, workload contexts, and delta append on every
      `app.article.full_text_pdf` update path.
- [x] **A38.** Prove provider admission, provider repositories, and dispatch
      telemetry reads are owner/background scoped with workload contexts and no
      product-review raw scans.
- [x] **A39.** Complete import/store workflow audit for agent workflows,
      structured-file imports, PubMed, Europe PMC, FHIR, Covidence, hot-field
      extraction, delta append, and no synchronous affected-project fanout.
- [ ] **A40.** Retire dirty materialization and mart refresh as legacy serving
      writers so they either feed V4 dirty/projector state or become deletion-only
      maintenance. b861de02 was only a temporary quarantine guard: legacy dirty
      materialization and mart refresh remained background-bounded and forbidden
      from writing V4 snapshot/projector state, but not retired. Current A40
      retirement pivot: admin large-rebuild run/pause/resume/note endpoints now
      return explicit retired responses instead of invoking the legacy runner or
      state mutators, the normal admin jobs UI no longer links to the legacy
      run-control page, and the stale `/admin/project-mart-large-rebuild` client
      route was removed. Current A16/A50 cleanup also removed legacy mart
      refresh, dirty-materialization, large-rebuild, owner, and queue diagnostics
      from the product review warnings route/UI, and A18 removed review detail
      mart-freshness diagnostics. Current A40 producer cleanup removes the live
      dirty-refresh dependency on `project_mart_dirty_materialization_state`:
      whole-project dirty marks now expand directly into bounded
      `project_mart_refresh_article_state` rows for current project scope plus
      existing legacy scope rows, while the dirty-materialization service remains
      only explicit/backlog cleanup coverage. Current A40 script cleanup removes
      the direct `runProjectMartRefreshWorker.ts` and
      `runProjectMartRefreshWorkerOnce.ts` CLI entry points; only the isolated
      recovery script remains and it routes oversized/full-refresh work into V4
      rebuild requests. A40 remains partial because
      `getDuckdbMartMaintenanceService.ts`, `projectMartRefreshWorker.ts`, and
      large-rebuild workers still retain legacy serving writer paths.
- [ ] **A41.** Convert large rebuild services into V4 chunk-manifest/backfill
      drivers or retire them once V4 rebuild requests cover their purpose.
      Current A41 cleanup removes the standalone legacy large-rebuild worker
      scripts and package entry points, and rewires the isolated dirty-refresh
      script's oversized/full-refresh branch to request a V4 review-serving
      rebuild instead of staging `project_mart_large_rebuild_state` or running a
      legacy large-rebuild fallback. It also deletes the unused mart-refresh and
      large-rebuild heartbeat loop modules now that startup is cut over to the V4
      projector worker. A41 remains partial because the internal large-rebuild
      executor/state services still exist for legacy backlog maintenance and
      must either be deleted after the backlog path disappears or replaced with
      V4 projector chunk-manifest workers.
- [x] **A42.** Finish comparison serving builder migration in tandem with
      comparison route contracts so reads and writers share bounded serving
      identities. Current A42 cleanup adds comparison serving article identity
      columns plus `mart.comparison_article_identifier_serving`, cleans that
      serving identity table with serving generations, and rewires
      conflict-resolution export to read article identity/identifier data from
      active comparison serving state instead of joining `app.article` and
      `app.article_identifier`.
- [x] **A43.** Audit project-transfer import/export for batching, workload
      context, owner routing, dirty-token-only fanout, and bounded artifact
      cleanup. Current A43 cleanup removes the commit writer's legacy
      `projectMartDirtyRefreshStateService` fanout: project-transfer commits now
      rely on V4 article, project-scope, review-config, judgment, and import-run
      deltas instead of writing `project_mart_refresh_state` or
      `project_mart_refresh_article_state` rows. It also adds explicit
      project-transfer workload contexts to export queries/transactions, import
      analyze operation-table work, import commit transactions, and the direct
      route source-project lookup, while retaining owner-dependent route
      classification and artifact cleanup tests.
- [x] **A44.** Complete archived cleanup, maintenance lease, recovery, and script
      allowlist proof for workload contexts, memory caps, and batched legacy/source
      cleanup. `archivedProjectCleanupService.ts` and
      `maintenanceWorkLeaseService.ts` now use explicit maintenance workload
      contexts for owner DB calls; the bounded cleanup CLI remains behind
      `withDuckdbMaintenanceAccess`. Evidence:
      `maintenanceCleanupDuckdbAccess.test.ts` and
      `archivedProjectCleanupService.test.ts`.
- [x] **A45.** Keep DuckDB migrations under `withDuckdbMaintenanceAccess`,
      maintenance workload context, transaction/non-transaction tests, and
      checkpoint behavior.
- [x] **A46.** Add a repo-wide operator-script allowlist/proof for DB-touching
      scripts, including explicit memory/runtime options for snapshot, backup,
      checkpoint, recovery, rebuild, and request scripts. Package-exposed DB
      scripts are now classified in `operatorScriptDuckdbAccess.test.ts`:
      snapshot/backup/studio commands stay snapshot/read-only; checkpoint,
      recovery, rebuild-request, quarantine, and backfill commands run through
      maintenance access with workload contexts; legacy worker package entry
      points stay absent.

### Admin And Diagnostics

- [x] **A47.** Keep admin investigation, owner diagnostics, DuckDB Studio/snapshot,
      and ownerless readable backend routes classified as admin/diagnostic rather
      than product fallback.
- [x] **A48.** Remove or rewire admin UI/API controls for legacy project-mart large
      rebuild, dirty refresh, and mart maintenance once V4 replacements exist.
      Current cleanup retires the remaining
      `/api/admin/project-mart-dirty-materialization-requeue` mutation response
      instead of calling `projectMartDirtyMaterializationService`, alongside the
      already-retired large-rebuild run/pause/resume/note controls, removed the
      stale admin client page/link, and removed retired large-rebuild heartbeat
      tuning from settings/admin diagnostics.
- [x] **A49.** Add explicit proof that every admin page/API is diagnostics-only,
      owner-routed maintenance, V4-rewired control, or remove-before-release.
      Evidence: `routeSurfaceInventory.test.ts` now checks every `/api/admin/*`
      route is classified as diagnostics, maintenance, or sensitive-local with a
      release/sensitivity decision, and checks admin/settings client pages only
      call inventoried admin APIs with no server DB imports or retired legacy
      mart controls.

### Client/UI

- [x] **A50.** Keep review UI article queries gated on V4 warning/readiness data
  and keep stale/unavailable browser copy covered by tests. Current cleanup
  removes legacy large-rebuild, dirty-materialization, and quarantine diagnostic
  rendering from the normal review warning banner and adds UI coverage that
  legacy fields do not change product warning copy. A51 now removes
  warning-query failure as article-load permission, and A52 wires the review
  detail/full-text pages to render explicit V4 unavailable states instead of
  treating unavailable detail payloads as article data.
- [x] **A51.** Change review UI warning-query failure handling so failure does not
      grant permission to load article rows through product APIs. The normal,
      both, human, and unassessed review table containers now enable article
      queries only when `indexing.serving.readable === true`; failures keep the
      warning error visible but do not permit product article API reads.
      Evidence: `reviewsArticleQueryGating.test.ts`.
- [x] **A52.** Update review UI to consume final health/warning/detail readiness
      states after A16-A18, including browser and desktop behavior. Evidence:
      `reviewDetailReadiness.test.ts`, `reviewsArticleQueryGating.test.ts`, and
      `reviewsProjectWarnings.vitest.tsx`.
- [x] **A53.** Rewire admin UI away from legacy mart large-rebuild controls and
      prove the known legacy controls are retired or removed. Current static and
      route tests prove the legacy large-rebuild page/link is gone, that
      dirty-materialization/large-rebuild mutation routes return retired
      responses, and that settings/admin diagnostics no longer expose retired
      large-rebuild heartbeat tuning. A49 remains open for full every-admin-route
      classification.

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
| [x]    | Review health/warnings                     | `src/server/routes/projectsRoutes/projectsRoutesGetReviewsHealth.ts`, `src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.ts`                                                                       | V4 product read plus residual allowlist                 | V4/residual    | Reader        | Complete      | false                       | Complete for A16 scope: API role proxies/fails closed, and owner-side routes read V4 diagnostics/manifest state with `readReviewServingRows`, `getReviewServingDiagnostics`, and `requestReviewServingV4Rebuild`. The warnings product route no longer imports or queries legacy mart refresh/materialization/large-rebuild status, owner registry state, queue runtime metrics, or maintenance leases; `reviewServingPhase5BStaticGuards.test.ts` proves those calls stay out. Remaining source reads are bounded prompt count and article-scope probes registered in `reviewServingResidualReadAllowlist.ts`. Legacy mart/large-rebuild state remains observable through admin diagnostics such as `AdminInvestigateRoutes.ts`, not product warning paths.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| [x]    | Prompt preview                             | `src/server/routes/projectsRoutes/projectsRoutesGetPromptPreview.ts`                                                                                                                                               | V4 product read plus owner-routed metadata              | Yes           | Reader        | Yes           | false                       | Current: API role proxies/fails closed; owner-side reads the sample article from `review.prompt.preview`, hydrates display/detail text from keyed `review.detail.row`/payload serving state, and returns unavailable when serving state is missing instead of falling back to `mart.project_scope_article`, `app.project_article`, or `getFullArticlesByIds`. Remaining project/prompt/model reads are single-row owner-side metadata needed to render the prompt. Evidence: `ProjectsRoutes.test.ts` covers ready V4 preview and fail-closed rebuild behavior; `duckdbRouteGuardrails.test.ts` blocks reintroducing legacy sample-article and source-hydration fallback strings.                                                                                                                                                                                                                                                                                                                                                                                              |
| [x]    | Review detail/hydration                    | `src/server/routes/projectsRoutes/projectsRoutesPostArticleReviewDetails.ts`; `src/server/routes/ArticlesRoutes.ts` global article detail classified separately                                                                                   | V4 product read plus residual allowlist                 | V4/residual       | Reader        | Complete       | false | Complete for A18 scope: API role proxies/fails closed. Normal project review detail hydrates the article row, article payload, LLM judgment details, human judgment details, assessment annotations, prompt display metadata, and model display metadata from keyed V4 detail contracts and returns an explicit unavailable payload when V4 detail state is missing; tests prove it does not call legacy article hydration, app judgment fallback, mart-freshness, Covidence source-record, assessment, prompt metadata, model metadata, or snapshot-project fallback reads. Remaining residual read in `projectsRoutesPostArticleReviewDetails.ts` is the bounded project config behavior read for content flags and human summary mode. The separate `ArticlesRoutes.ts` `/api/articles/:id` detail/history endpoint is preserved for global article pages, classified as sensitive source-article detail outside normal review detail fallback, and guarded by `reviewServingAdjacentRouteSurfaces.test.ts`.                                                                                                                                                                                                                                                                                                                |
| [x]    | Project list/access/config                 | `src/server/routes/ProjectsRoutes.ts`, `src/server/routes/projectsRoutes/projectAccessGuard.ts`                                                                                                                    | Owner-routed source access                              | Partial       | Reader/writer | Partial       | false                       | Current: API role routes are owner-dependent in `routeSurfaceInventory.ts`; `projectAccessGuard.ts` uses owner private API access when `canCurrentServerOwnDuckdb()` is false and local `app.project` only on owner-capable runtimes. Owner-side config writes append review-serving deltas in `ProjectsRoutes.ts` via `append*ReviewServingDeltas`/`append*ReviewConfigReviewServingDelta`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| [x]    | Project article membership                 | `src/server/routes/ProjectArticlesRoutes.ts`, `src/components/main/projectDetails/projectDetailsCuratedArticles.tsx`                                                                                               | V4/keyset read plus owner/background writer             | Yes           | Reader/writer | Complete      | false                       | Complete for A19 scope: API role proxies/fails closed, owner-side add/delete writes remain source mutations and deletion appends project-scope deltas/dirty work. `GET /api/projects/:id/articles` reads page membership from durable `mart.project_scope_article` state with keyset cursors, caps `limit` at 100, returns `nextCursor`/`hasMore`, no longer computes owner-side `COUNT(*)`, and rejects legacy deep `page > 1` requests without a cursor. Per-page title hydration now reads bounded `mart.review_article_serving_v4` rows for the current page articles instead of `app.article`; import-origin provenance is removed from the normal UI path and compatibility response fields are returned as `null` rather than hydrating `app.project_article`/`app.project`. Legacy `totalCount`/`totalPages` remain `null` by design for the keyset contract.                                                                                                                                                                                                                                                                          |
| [x]    | Add-to-project by filter/IDs               | `src/server/routes/ProjectsAddArticlesRoutes.ts`                                                                                                                                                                  | V4 durable job plus owner-routed source access          | Yes           | Durable job   | Yes           | false                       | Current: API role is owner-dependent; by-filter and by-IDs routes create `review.bulk.selection` jobs with `createReviewBulkOperationJob`, `reviewConfigHash`, filter criteria, search mode, and latest snapshot semantics. `ProjectsAddArticlesRoutes.test.ts` proves by-IDs is a durable job and does not call `insertArticlesIntoProject`; the deleted `selectArticleIdsOlap.ts` wrapper cannot be reintroduced as a production import because `duckdbRouteGuardrails.test.ts` guards retired OLAP imports.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| [x]    | Project export                             | `src/server/routes/ProjectExportRoutes.ts`, `src/server/services/projectTransfer/projectTransferExport*.ts`                                                                                                        | V4 durable job / separate project-transfer audit        | V4/residual    | Reader/job    | Complete      | false                       | Complete for A20 scope: API role proxies/fails closed, export creation creates `review.export.selection` jobs with manifest checks, keyset snapshot cursor, batch size, and payload budget; completed CSV downloads consume persisted job-result article batches, hydrate bounded chunks from `mart.review_article_serving_v4`, `mart.review_article_serving_payload_v4`, and `mart.review_article_judgment_detail_serving_v4`, and derive selected prompt labels/type/content from V4 judgment payload metadata instead of `app.prompt`, with no download-path `app.article`, `app.judgment`, `app.prompt`, or `OFFSET` scans. The separate `/export-prompts` prompt-only endpoint and project-transfer export services remain separate route/service audit scopes, including A43 for project transfer; author parity remains tied to serving payload coverage rather than source fallback. |
| [x]    | PDF fetch                                  | `src/server/routes/ArticlesRoutes.ts`, `src/server/services/pdfFetchJobs.ts`                                                                                                                                       | V4 durable job plus owner/background writer             | Yes           | Durable job   | Yes           | false                       | Current: API role is owner-dependent/sensitive; `/api/articles/pdf-fetch-bulk`, `/pdf-fetch-by-filter`, and `/pdf-fetch-by-project` create `review.pdf.selection` jobs via `createReviewBulkOperationJob`. `ArticlesRoutes.test.ts` covers durable request identities, and `pdfFetchJobs.ts` processes explicit article-id batches then appends article review-serving deltas after source updates.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| [x]    | Judgment jobs API reads                    | `src/server/routes/JudgmentsJobsRoutes.ts`, `src/server/routes/judgmentsJobsRoutesApiReadModel.test.ts`                                                                                                            | V4 product/job read plus owner-routed source access     | Yes           | Reader/job    | Yes           | false                       | Current: public job routes are owner-dependent in `routeSurfaceInventory.ts`, while ownerless health endpoints are diagnostics-only. Unassessed queue/count reads import `getJudgmentJobUnassessedArticlesFromServing`/`getJudgmentJobUnassessedCountFromServing`; `judgmentsJobsRoutesApiReadModel.test.ts` proves API-role list can use stale health projection instead of local owner DuckDB.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| [~]    | Comparison projects                        | `src/server/routes/ComparisonProjectsRoutes.ts`, `src/server/routes/comparisonProjectsRoutes/*`, `src/server/services/comparisonProjectServing*.ts`                                                                | Owner-routed source access / serving migration          | Partial       | Reader/writer | Partial       | false                       | Partial: API role proxies/fails closed through `routeSurfaceInventory.ts`, comparison serving services exist, normal judgment page/count/stats/export reads use active-generation serving helpers, count now fails closed without an active generation, conflict-resolution export fails closed without an active comparison serving generation, and A42 rewired conflict-resolution export to read article identity plus canonical identifiers from active comparison serving tables (`mart.comparison_article_serving` and `mart.comparison_article_identifier_serving`) instead of joining `app.article`/`app.article_identifier`. `ComparisonProjectsRoutes.servingContract.test.ts` guards bounded serving reads plus owner-routed source writes/rebuild cleanup. Not complete: the route surface remains a broad owner-side source/serving mix with direct source metadata/detail reads and no separate comparison serving admission/contract registry.                                                                                                                                                                                                                                                                                                                                                                  |
| [x]    | Data sources and imports                   | `src/server/routes/DataSourcesRoutes.ts`, `src/server/routes/DataSourcesImportRoutes/*`, `src/server/services/dataSourceQueryService.ts`, `src/server/services/covidenceImportService.ts`                          | Owner-routed source access / owner writer               | Partial       | Reader/writer | Partial       | false                       | Current: API role proxies/fails closed; `DataSourcesRoutes.ts` is owner-routed source metadata, and import create routes use transactions. `articleImportStoreService.ts` appends article/import-route review-serving deltas and import hot fields, Covidence appends project-scope/config/human deltas, and `importAndMetadataFanoutGuard.test.ts` plus route tests prove structured-file, Covidence, PubMed, Europe PMC, and FHIR import entrypoints do not call synchronous affected-project fanout after source writes. Workload-context default-on enforcement remains tracked by A7/A11.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| [x]    | Prompts/subprojects/models/providers       | `src/server/routes/PromptsRoutes.ts`, `src/server/routes/SubprojectsRoutes.ts`, `src/server/routes/ModelsRoutes.ts`, `src/server/routes/ProviderModelsRoutes.ts`, `src/server/routes/ProviderConnectionsRoutes.ts` | Owner-routed source access                              | Complete      | Reader/writer | Complete      | false                       | Complete: API role proxies/fails closed for these source-metadata routes via `routeSurfaceInventory.ts`; prompt merge and subproject create append review-serving config/scope deltas; provider model create/update/sync and provider connection create/update/archive/delete now append `project.reviewConfig.updated` deltas with `modelExecutionIdentity` for projects scoped by changed model/provider connection keys before delete/archive removes lookup state. `reviewConfigReviewServingDeltaService.test.ts` proves the scoped project lookups avoid `app.article`/`app.judgment`, and `importAndMetadataFanoutGuard.test.ts` blocks V4 rebuild/snapshot/mart writes in foreground route/repository changes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
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
| [~]    | `src/services/olap/duckdbOlap.ts`                 | Quarantined legacy | No            | Reader     | No            | true - need further changes | Current handling is quarantined legacy plus deletion planned, not retired. Evidence: normal review/job foreground imports are guarded by `src/server/reviewServing/reviewServingSql.test.ts`, and `duckdbRouteGuardrails.test.ts` blocks new production imports. Leave partial because `src/services/olap/duckdbOlap.test.ts` still covers raw fallback branches and the product detail, diagnostic, export, and comparison rows still list residual blockers. |
| [x]    | Deleted `src/services/olap/articlesReviewsOlap.ts`        | Quarantined legacy | N/A           | Reader     | N/A           | true - deleted              | Deleted after V4 product read replacement. Evidence: no production callers of `queryArticlesReviewsFromOlap` or `countArticlesReviewsFromOlap` remained, `src/server/reviewServing/reviewServingLlmReviewRouteService.test.ts` asserts the list/count routes do not import it, and `duckdbRouteGuardrails.test.ts` blocks reintroduced production imports.                                     |
| [x]    | Deleted `src/services/olap/articlesReviewsBothOlap.ts`    | Quarantined legacy | N/A           | Reader     | N/A           | true - deleted              | Deleted after V4 product read replacement. Evidence: no production caller of `queryArticlesReviewsBothFromOlap` remained, `src/server/reviewServing/reviewServingHumanBothUnassessedRouteService.test.ts` asserts the both-mode route does not import it, and `duckdbRouteGuardrails.test.ts` blocks reintroduced production imports.                                                                                      |
| [x]    | Deleted `src/services/olap/articlesReviewsFiltersOlap.ts` | Quarantined legacy | N/A           | Reader     | N/A           | true - deleted              | Deleted after V4 product read replacement. Evidence: no production callers of `getDatabaseBasedFiltersFromOlap` or `getNumericFiltersFromOlap` remained, `src/server/reviewServing/reviewServingFilterRouteService.test.ts` asserts filter routes do not import it, and `duckdbRouteGuardrails.test.ts` blocks reintroduced production imports.                                                |
| [x]    | Deleted `src/services/olap/unassessedArticlesOlap.ts`     | Quarantined legacy | N/A           | Reader     | N/A           | true - deleted              | Deleted after V4 product/job read replacement. Evidence: no production callers of its `*FromOlap` exports remained, `src/server/reviewServing/reviewServingSql.test.ts` asserts judgment job routes/cron use serving queue helpers instead, `reviewServingHumanBothUnassessedRouteService.test.ts` guards the review route, and `duckdbRouteGuardrails.test.ts` blocks reintroduced production imports.                          |
| [x]    | Deleted `src/services/olap/selectArticleIdsOlap.ts`       | Quarantined legacy | N/A           | Reader/job | N/A           | true - deleted              | Deleted after V4 durable job replacement. Evidence: no production caller of `selectArticleIdsByFilterOlap` remained, `src/server/routes/ProjectsAddArticlesRoutes.test.ts` covers durable bulk-operation job creation for add-by-filter/IDs, `src/server/reviewServing/reviewServingReadContracts.test.ts` forbids mounted migrated route imports, and `duckdbRouteGuardrails.test.ts` blocks reintroduced production imports. |

## Background, Cron, Import, And Maintenance Checklist

| Status | Area                                    | Files                                                                                                                                                                                                                               | Classification                                          | V4 compatible | R/W           | Uses new CQRS | Legacy                      | Required handling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------ | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------- | ------------- | ------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [x]    | Judgment cron and LLM processing        | `src/server/cron/judgmentsJobs.ts`, `src/server/cron/judgmentsJobs/*`, `src/agent/judge/*`                                                                                                                                          | Owner/background writer plus V4 queue/projection state  | Yes           | Reader/writer | Yes           | false                       | Current: judgment queue selection uses V4 queue/projection state in `judgmentsJobsCronGetPrompts.ts` via `getJudgmentJobUnassessedPairsFromServing`, with bounded metadata workload contexts. Judgment writes append V4 deltas/outbox/dirty state in `judgmentsJobsMarkDirtyWork.ts` and `judgeStoreJudgment.ts`; tests cover serving queue use, dirty fanout, SQLite outbox import, and atomic dirty rollback.                                                                                                                                                |
| [x]    | Full text jobs                          | `src/server/cron/fullTextJobs.ts`, `src/server/cron/fullTextConversionJobs.ts`, `src/server/utils/ensureFullText.ts`                                                                                                                | Owner/background writer                                 | Yes           | Reader/writer | Yes           | false                       | Current: owner/maintenance loops gate the cron paths; full-text fetch/conversion selectors use bounded running-job/project-route/article scans with background workload contexts; `fullTextJobs.ts` appends article review-serving deltas when writing `app.article.full_text_pdf`; conversion writes in `fullTextConversionJobs.ts` and `ensureFullText.ts` use background workload contexts and append deltas. Evidence: `fullTextJobDuckdbAccess.test.ts` covers bounded selector limits, workload keys, and full-text/PDF update delta hooks; `pdfFetchJobs.test.ts` covers durable PDF fetch workload context and delta append hooks.                                                               |
| [x]    | Provider admission/telemetry            | `src/server/cron/judgmentsJobs/providerAdmissionLease.ts`, `src/server/cron/judgmentsJobs/judgmentDispatchTelemetry.ts`, provider repositories                                                                                      | Owner/background writer                                 | Complete      | Reader/writer | Complete      | false                       | Complete: provider admission leases are owner-aware and use background provider-admission workload contexts for durable telemetry, provider-key reconciliation, and owner-side acquire/heartbeat/release/expire/reconcile transactions; telemetry aggregates owner/judge runtime state in `judgmentDispatchTelemetry.ts` without direct DuckDB access. Provider connection/model repository and route reads carry owner provider-repository workload contexts, and provider model/connection write paths now append scoped `project.reviewConfig.updated` deltas for model execution identity before delete/archive removes lookup state. Evidence: `providerTelemetryDuckdbAccess.test.ts` guards workload-context markers, owner/internal route classification, and absence of product-review raw scan shapes; A23 commit 97e77996 added `reviewConfigReviewServingDeltaService.test.ts` coverage for provider model/connection scoped project lookups without `app.article`/`app.judgment`, plus `importAndMetadataFanoutGuard.test.ts` guards provider mutation delta hooks and blocks foreground V4 rebuild/snapshot/mart writes. |
| [x]    | Import/store workflows                  | `src/server/services/articleImportStoreService.ts`, `articleCanonicalMatcher.ts`, `covidenceImportService.ts`, `src/agent/*Workflow/*StoreEntries.ts`, `structuredFileImport*`, `pubmed/europePmc/fhir` import paths                | Owner/background writer plus V4 queue/projection state  | Yes           | Writer        | Yes           | false                       | Current: `articleImportStoreService.ts` chunks canonical matching/import-store writes, appends import-run deltas, pre-extracts hot fields, tombstones stale delta/hot-field state for sync removals, and appends source-metadata article deltas. Structured-file and Covidence foreground transactions now carry the shared import-store workload context; standalone agent imports use `storeImportedArticles`, and the FHIR agent direct existence/import-route calls carry that workload context. `covidenceImportService.ts` appends project-scope/config/human deltas. Evidence: `importAndMetadataFanoutGuard.test.ts` covers structured-file, PubMed, Europe PMC, FHIR, arXiv, bioRxiv, medRxiv, Covidence, workload-context markers, delta/hot-field hooks including stale-link removal, and absence of synchronous affected-project/V4 rebuild/project-scale mart fanout from import/store entrypoints. |
| [ ]    | Dirty materialization                   | `projectMartDirtyMaterializationService.ts`, `projectMartDirtyRefreshStateService.ts`, `projectMartDirtyRefreshQuarantineBarrier.ts`                                                                                                | Owner/background writer plus V4 queue/projection state  | Partial       | Writer        | Partial       | true - need further changes | Partial: dirty tokens, article/project input temp tables, leases, quarantine barriers, and bounded claims exist in `projectMartDirtyRefreshStateService.ts`, with coverage in `projectMartDirtyRefreshStateService.test.ts`, `projectMartDirtyMaterializationService.test.ts`, and `projectMartDirtyRefreshQuarantineBarrier.test.ts`. A40 guard coverage in `projectMartRefreshWorker.test.ts` proves dirty materialization/refresh state remains background bounded and does not write V4 snapshot/projector state. Current A40 producer cleanup removes the normal live dependency: whole-project dirty marks now write bounded `project_mart_refresh_article_state` rows directly, including existing legacy `mart.project_scope_article` membership, while `projectMartDirtyMaterializationService.ts` is exercised only by explicit/backlog materialization tests. Current A40 script cleanup deletes the direct `runProjectMartRefreshWorker.ts` and `runProjectMartRefreshWorkerOnce.ts` CLI entry points; only the isolated recovery CLI remains and it routes oversized/full-refresh work into V4 rebuild requests. Not checked because the service still exists as a legacy cleanup path and has not been deleted after all consumers are gone. |
| [ ]    | Mart refresh worker                     | `src/server/workers/projectMartRefreshWorker.ts`, `getDuckdbMartMaintenanceService.ts`                                                                                                                                              | Owner/background writer                                 | Partial       | Writer        | Partial       | true - need further changes | Partial: worker cycles claim bounded dirty article batches and call background maintenance services; `projectMartRefreshWorker.test.ts` and `getDuckdbMartMaintenanceService.test.ts` cover batch/lease behavior. A40 guard coverage in `projectMartRefreshWorker.test.ts` proves this legacy path is background-only/bounded and does not write V4 snapshot/projector state. Current A40 tests keep legacy mart evidence direct: maintenance tests assert `mart.review_article_serving*` state directly instead of routing through V4-only product review-detail hydration, and the unused `projectMartRefreshWorkerHeartbeat.ts` loop module is deleted. Not checked because `getDuckdbMartMaintenanceService.ts` still writes legacy `mart.review_article_serving*`/rollup structures and uses scoped import selection, so this is not only a scheduler/waker or deletion-only maintenance after V4 cutover.                                                                                     |
| [ ]    | Large rebuild services                  | `projectMartLargeRebuildExecutor.ts`, `projectMartLargeRebuildRunner.ts`, `projectMartLargeRebuildCyclesService.ts`, `projectMartLargeRebuildStateService.ts`, `projectMartLargeRebuildProgressService.ts`                          | Owner/background writer                                 | Partial       | Writer        | Partial       | true - need further changes | Partial: large rebuild executor uses `queryJsonBackground`/`runBackground`, keyset cursors, leases, generation cleanup batches, and tests cover runner/state/cycles/progress. Current A40 retirement pivot removes the admin API dependency that could run, pause, resume, or annotate legacy large rebuilds by returning explicit retired responses from those endpoints, and removes the stale admin client page that exposed those controls. Current A41 cleanup removes `scripts/runLargeRebuildWorkerOnce.ts`, `scripts/runLargeRebuildWorkerCycles.ts`, and their package commands/tests; the isolated dirty-refresh script now turns oversized/full-refresh claims into V4 `review_rebuild_request` rows instead of staging or running legacy large rebuilds, and the unused `projectMartLargeRebuildHeartbeat.ts` loop module is deleted. Not checked because `projectMartLargeRebuildExecutor.ts` still rebuilds legacy mart/serving tables directly and remains for legacy backlog maintenance until the remaining internal callers are removed or replaced with V4 projector chunks.                                                                                     |
| [~]    | Comparison serving builders             | `comparisonProjectServingGenerationService.ts`, `comparisonProjectServingRebuildService.ts`, `comparisonProjectServingRollupBuilder.ts`, `comparisonProjectServingCellBuilder.ts`, `comparisonProjectServingInvalidationService.ts` | Owner/background writer / serving migration             | Partial       | Writer        | Partial       | false                       | Partial serving migration with A42 progress: comparison builders use background DB methods, generation promotion state, and now materialize article identity fields plus `mart.comparison_article_identifier_serving` so route export readers can share bounded serving identities. Generation cleanup deletes the identifier serving table alongside article/cell/filter tables, and rollup tests prove scoped external IDs, DOI/PMID fields, and identifier rows are projected. Not checked because comparison serving still lacks a dedicated V4-style admission/contract registry and broader workload-context proof across all comparison route/source surfaces.                                                                                           |
| [x]    | Project transfer                        | `src/server/services/projectTransfer/*`, `src/server/routes/projectTransferRoutes.ts`                                                                                                                                               | Owner-routed source access plus owner/background writer | Yes           | Reader/writer | Yes           | false                       | Current owner-routed/CQRS-compatible project-transfer workflow. Route surface is owner-dependent/source-access; export queries and transactions, import analyze operation-table transactions, import commit transactions, and direct source-project route lookups now carry explicit project-transfer workload contexts. Commit writer appends V4 article, project-scope, review-config, judgment, and import-run deltas without calling `projectMartDirtyRefreshStateService` or writing legacy dirty-refresh rows. Evidence: `projectTransferCommit.test.ts` asserts project-transfer commits leave `project_mart_refresh_state`, `project_mart_refresh_article_state`, and `project_mart_dirty_materialization_state` empty while producing V4 delta rows; `projectTransferCommitWriterV4DeltaGuard.test.ts` guards against reintroducing legacy dirty fanout; `projectTransferDuckdbAccess.test.ts` covers workload-context and owner-routing guard markers; `projectTransferRoutes.test.ts` covers temp artifact cleanup/cancellation and owner-route composition. |
| [x]    | Archived cleanup and maintenance leases | `archivedProjectCleanupService.ts`, `maintenanceWorkLeaseService.ts`, cleanup/recovery scripts                                                                                                                                      | Owner/background writer                                 | N/A           | Writer        | N/A           | false                       | Current maintenance cleanup path: `archivedProjectCleanupService.ts` has phase-specific batch limits for mart, runtime, source, tombstone, and final-delete phases and now passes `getMaintenanceDuckdbWorkloadContext('archivedProjectCleanup')` to its direct owner DB queries, statements, and transactions. `maintenanceWorkLeaseService.ts` now passes `getMaintenanceDuckdbWorkloadContext('maintenanceWorkLease')` to claim/progress/complete/fail/clear/list/recovery DB calls. `runArchivedProjectBoundedCleanup.ts` stays behind `withDuckdbMaintenanceAccess`. Evidence: `maintenanceCleanupDuckdbAccess.test.ts` guards workload markers/counts; `archivedProjectCleanupService.test.ts` covers bounded deletion behavior. This is not a product V4 read path, but it is now explicit owner/maintenance work rather than unclassified foreground DuckDB access. |
| [x]    | Migrations and DB schema                | `src/db/migrateDuckdb.ts`, `src/db/duckdbMigrations/*`                                                                                                                                                                              | Maintenance/migration                                   | N/A           | Maintenance   | N/A           | false                       | Current maintenance/migration path: `migrateDuckdb.ts` runs with `withDuckdbMaintenanceAccess`, `getMaintenanceDuckdbWorkloadContext('migrateDuckdb')`, migration transactions/non-transaction allowlist, and checkpoint; `migrateDuckdb.test.ts` covers migration application and rollback/non-transaction behavior. This is explicitly not a V4 product-read path.                                                                                                                                                                                           |
| [x]    | Operator scripts                        | `scripts/*.ts` that call DB services, `dbBackup.ts`, `dbQuerySnapshot.ts`, `duckdbCheckpoint.ts`, recovery/rebuild/request scripts                                                                                                  | Admin/debug/tool allowlist                              | N/A           | Admin/tool    | N/A           | false                       | Current package-exposed DB script surface is allowlisted in `operatorScriptDuckdbAccess.test.ts`. Snapshot tools (`dbBackup.ts`, `dbQuerySnapshot.ts`, `dbStudio.ts`) use `createDuckdbSnapshotForCli`; snapshot query/studio are read-only. Maintenance commands for checkpoint, dirty-refresh diagnostics/recovery/quarantine, V4 rebuild/repair requests, rebuild2 cutover, archived cleanup, and source/PPR backfills use `withDuckdbMaintenanceAccess` and explicit maintenance workload contexts where they issue owner DB work. Package commands no longer expose legacy mart refresh or legacy large-rebuild workers. Remaining direct script files outside the package command surface are test/debug internals, not supported operator entry points. |

## Admin And Diagnostic Checklist

| Status | Area                        | Files                                                                              | Classification                                         | V4 compatible | R/W               | Uses new CQRS | Legacy | Required handling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------ | --------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------- | ----------------- | ------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [x]    | Admin investigation         | `src/server/routes/AdminInvestigateRoutes.ts`                                      | Admin/debug/tool allowlist and owner diagnostics       | N/A           | Admin/tool        | N/A           | false  | Implemented today as explicit `/api/admin/*` maintenance/settings diagnostics and retired legacy rebuild controls. Evidence: `src/server/routes/routeSurfaceInventory.ts` classifies admin routes as `maintenance-debug-api`, `sensitive-local-api`, or ownerless settings diagnostics; `routeSurfaceInventory.test.ts` proves mounted-route inventory and owner-proxy classification coverage; `AdminInvestigateRoutes.test.ts` covers maintenance and worker runtime diagnostics plus retired legacy large-rebuild mutation endpoints.                                                 |
| [x]    | DuckDB owner diagnostics    | `DuckdbOwnerConnectionsRoutes.ts`, `runtimeReadyRoutes.ts`, owner connection pages | Owner diagnostics and ownerless diagnostic fallback    | N/A           | Admin/control     | N/A           | false  | Implemented today as explicit owner/runtime diagnostics and heartbeat control, not product data fallback. Evidence: `src/server/routes/DuckdbOwnerConnectionsRoutes.ts` exposes owner connection overview/heartbeat; `runtimeReadyRoutes.ts` exposes readiness/runtime state; `routeSurfaceInventory.ts` classifies these as `duckdb-owner-diagnostics`, `local-bootstrap`, or ownerless/settings diagnostics; `DuckdbOwnerConnectionsRoutes.test.ts` and `runtimeReadyRoutes.test.ts` cover route behavior. |
| [x]    | DuckDB Studio/snapshot      | `DuckdbStudioRoutes.ts`, `scripts/dbStudio.ts`, `scripts/dbQuerySnapshot.ts`       | Admin/debug/tool allowlist and read-only snapshot      | N/A           | Admin reader      | N/A           | false  | Implemented today as explicit operator snapshot tooling. Evidence: `DuckdbStudioRoutes.ts` requires DuckDB owner role before creating snapshots; `scripts/dbStudio.ts` opens the snapshot with `duckdb -readonly -ui`; `scripts/dbQuerySnapshot.ts` creates a CLI snapshot and opens it with `getReadOnlyDuckdbRuntimeOptions()`; `DuckdbStudioRoutes.test.ts` verifies a readable snapshot.                                                                                                                 |
| [x]    | Ownerless readable backends | `ownerlessReadableBackends.ts`, read-only validation tests                         | Ownerless diagnostic fallback and test-only validation | N/A           | Diagnostic reader | N/A           | false  | Implemented today for declared bootstrap/diagnostic routes only. Evidence: `src/server/utils/ownerlessReadableBackends.ts` declares only runtime ready/state, owner connections, heartbeat, worker runtime diagnostics, and judgment dispatch diagnostics with `routeKind` `bootstrap` or `diagnostics`; `ownerlessReadableBackends.test.ts` verifies owner roles skip live read-only validation, API read-only validation releases locks, and API owner-proxy falls back to ownerless control state.        |

## Client/UI Checklist

| Status | Area                         | Files                                                      | Classification                                 | V4 compatible | R/W                  | Uses new CQRS | Legacy                      | Required handling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------ | ---------------------------- | ---------------------------------------------------------- | ---------------------------------------------- | ------------- | -------------------- | ------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [x]    | Review UI freshness/warnings | `src/components/main/reviews/*`, `reviewsWarningsQuery.ts`; `src/app/routes/+projects/+$id/+reviews-llm/+$articleId/*` | Client-over-API plus V4/readiness-consuming UI | Yes           | Client reader        | Yes           | false                       | Implemented for the normal review UI. No direct DuckDB/client `@duckdb` imports were found in `src/components/main/reviews/*`; `reviewsWarningsQuery.ts` calls `apiClient.api.projectsreviewswarnings.post`, and list containers gate article queries on `warningsQuery.data?.indexing.serving.readable` before calling `articlesreviews*` API query helpers. `routeSurfaceInventory.ts` classifies the review UI API routes as owner-dependent, and `reviewsProjectWarnings.vitest.tsx` covers stale/unavailable browser copy plus ignoring legacy large-rebuild, dirty-materialization, and quarantine fields in product warning copy. A51 removes warning-query failure as a fallback permission to load normal/both/human/unassessed article rows; `reviewsArticleQueryGating.test.ts` guards that all review article table containers require V4 serving readability. A52 adds explicit V4 unavailable-state handling in the review detail and full-text pages so unavailable detail payloads render readiness copy instead of article/detail components. |
| [x]    | Admin UI                     | `src/app/routes/+admin/*`, `src/components/Navigation.tsx`; `src/app/routes/+settings/+index.tsx` | Client-over-API admin diagnostics UI / planned | N/A           | Client reader/writer | N/A           | false                       | Implemented for the audited admin/client surface. No direct DuckDB/client `@duckdb` imports were found in `src/app/routes/+admin/*` or `Navigation.tsx`; admin pages and navigation call Eden/API helpers such as `apiClient.api.admin['duckdb-append-metrics']`, `fetchDuckdbOwnerConnections`, and `fetchLlmStatus`. Current A40/A48/A53 retirement pivot removes the normal admin jobs link to `/admin/project-mart-large-rebuild`, keeps backend large-rebuild status diagnostics, returns retired responses from the legacy large-rebuild run/pause/resume/note endpoints, retires `/api/admin/project-mart-dirty-materialization-requeue` instead of calling `projectMartDirtyMaterializationService`, removes the stale admin client route plus smoke target, and removes retired large-rebuild heartbeat tuning from settings/admin diagnostics. Evidence: `AdminInvestigateRoutes.test.ts` covers retired mutation responses and absence of heartbeat tuning diagnostics; `reviewServingPhase5BStaticGuards.test.ts` guards against reintroducing the admin link, legacy mutation service calls, or settings heartbeat tuning; `routeSurfaceInventory.test.ts` proves every `/api/admin/*` route is classified as diagnostics, maintenance, or sensitive-local with release/sensitivity notes and that admin/settings clients only call inventoried admin APIs without server DB imports or retired legacy controls. |

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
