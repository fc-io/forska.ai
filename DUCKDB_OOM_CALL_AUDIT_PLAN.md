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
- **Single V4 writer**: **partially current.** Normal V4 projector worker/service
  code is concentrated in `src/server/workers/reviewServingProjectorWorker.ts`
  and `src/server/reviewServing/reviewServingProjectorService.ts`; broad proof
  that legacy mart maintenance cannot bypass this boundary remains planned.
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
  still planned for deletion.** `duckdbOlap.ts` remains legacy; tests in
  `src/server/reviewServing/reviewServingSql.test.ts` keep imports away from
  normal review and judgment-job foreground paths. Shrinking and deleting the
  allowlist remains planned.
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
- [ ] `ApiProxyRoutes` is proven to run before product route handlers in API
      role. Current code order is correct in `serverMain.ts` (`apiProxyRoutes`
      before `publicProductApiRoutes`), but no explicit proxy-order test was
      found, so this remains planned proof.
- [x] API role without an owner returns `DuckDB owner proxy target unavailable`
      for owner-dependent project routes instead of opening DuckDB locally.
      Current owner-routed/source-access enforcement: `ApiProxyRoutes.ts`
      returns the error, and `ApiProxyRoutes.test.ts` covers an API server without
      an owner returning `502` for `/api/users`.
- [ ] Low-level foreground DuckDB execution rejects missing workload context
      outside explicit owner/background/admin/test scopes. Planned
      owner/background-writer enforcement: `duckdbService.ts` records budgets
      when a `DuckdbWorkloadContext` is provided, but `withDuckdbWorkloadContext`
      still executes directly when context is `undefined`.
- [ ] Static guards fail when route handlers import generic DuckDB services,
      `duckdbOlap`, `duckdbRunner`, `readOnlyDuckdbService`, or `@duckdb/node-api`
      without an allowlist entry. Partially current quarantined-legacy/residual
      enforcement: `reviewServingSql.test.ts` guards normal review/job files,
      and `getAppQueryService.test.ts` guards audited read-only modules; a broad
      route-handler import guard remains planned.
- [ ] Static guards fail when normal foreground SQL contains
      `selected_scoped_article_import`, `ROW_NUMBER(`, raw `app.article` or
      `app.judgment` scans, unbounded `GROUP BY`, `OFFSET`, or JSON
      sort/extraction. Partially current V4-style enforcement:
      `reviewServingSql.test.ts` and route-service tests guard V4 serving SQL;
      broad normal foreground SQL enforcement remains planned.
- [ ] `test:network-smoke:current-db` and `test:dev-server:current-db` fail on
      API-role DuckDB ownership, owner heartbeat errors, fatal DuckDB restarts,
      worker loop failures, and unqueueable/stalled V4 states. Partially current
      runtime/admin evidence: scripts exist in `package.json`, forbidden runtime
      patterns are checked in `tests/e2e/networkSmoke.spec.ts` and
      `scripts/runWithRuntimeProfile.test.ts`, but complete unqueueable/stalled
      V4 proof still needs more evidence.

## Runtime And Routing Checklist

| Status | Area                            | Files                                                                                                                                                                                                                     | Classification                                                  | Required handling                                                                                                                                                                                                                                                                                                 |
| ------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [ ]    | API owner proxy                 | `src/server/routes/ApiProxyRoutes.ts`, `src/server/routes/apiRouteClassification.ts`, `src/server/routes/routeSurfaceInventory.ts`                                                                                        | Owner-routed source access                                      | Partially current: API-role proxying, fail-closed unknown/owner-dependent classification, and inventory exhaustiveness are implemented/test-covered. Planned: explicit proxy-order test; current evidence is code order in `serverMain.ts`, not a dedicated test.                                                 |
| [ ]    | Runtime role and owner registry | `src/server/utils/serverRuntimeRole.ts`, `src/server/utils/duckdbOwnerConnections.ts`, `src/server/utils/duckdbOwnerConnectionHeartbeat.ts`, `src/server/utils/duckdbOwnerLease.ts`, `src/server/utils/runtimeCutover.ts` | Owner/background writer                                         | Partially current: owner election, heartbeat, cutover compatibility, and failover registry code/tests exist. Planned: assertions that API role cannot acquire owner-only foreground project reads through lower-level DB paths.                                                                                   |
| [ ]    | Low-level DuckDB service        | `src/server/utils/duckdbService.ts`, `src/server/services/appDatabaseService.ts`                                                                                                                                          | Owner/background writer                                         | Partially current: workload metrics, budgets, and `DuckdbWorkloadContext` are implemented/tested in `duckdbServiceWorkloadContext.test.ts`. Planned: reject missing context and API-role unclassified execution before connection acquisition.                                                                    |
| [x]    | Read-only DB services           | `src/server/services/readOnlyDuckdbService.ts`, `src/server/services/appReadOnlyDatabaseService.ts`, `src/server/services/getAppReadOnlyQueryService.ts`                                                                  | Residual allowlist / admin-debug-tool / owner-background writer | Current: `readOnlyDuckdbService.ts` rejects write-capable SQL, disables live API read-only access when an owner proxy is configured, and uses shared read-only runtime options; `getAppQueryService.test.ts` and `readOnlyDuckdbServiceWorkloadContext.test.ts` cover read-only behavior and workload forwarding. |
| [ ]    | App query wrapper               | `src/server/services/getAppQueryService.ts`, `src/server/services/appQueryServiceCore.ts`                                                                                                                                 | Owner-routed source access / residual allowlist                 | Partially current: source metadata reads are owner-routed by API proxying, and audited review residuals are listed in `reviewServingResidualReadAllowlist.ts`. Planned: finish V4 detail/payload migration and complete residual caps/migration targets.                                                          |
| [x]    | Legacy OLAP runner              | `src/services/olap/duckdbRunner.ts`                                                                                                                                                                                       | Quarantined legacy                                              | Current quarantine: `duckdbRunner.ts` forwards default-path queries through `appDatabaseService` with optional workload context, and `reviewServingSql.test.ts` prevents `duckdbOlap` imports in normal review and judgment-job foreground paths. Deletion remains planned in legacy checklist rows.              |
| [x]    | Direct node-api use             | `@duckdb/node-api` imports, `DuckDBInstance.create` call sites                                                                                                                                                            | Admin/debug/tool allowlist / test-only                          | Current: production direct use is concentrated in shared runtime helpers (`duckdbService.ts`, `readOnlyDuckdbService.ts`, `backgroundServerStack.ts`); admin snapshot script `scripts/dbQuerySnapshot.ts` uses `getReadOnlyDuckdbRuntimeOptions()`, and direct fixture usage is test-only.                        |

## Product Route Checklist

| Status | Area                                       | Files                                                                                                                                                                                                              | Classification                                      | Required handling                                                                                                                                                     |
| ------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [ ]    | LLM review list/count                      | `src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviews.ts`, `src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsCount.ts`                                                                | V4 product read                                     | Route through owner in API role. Use `reviewServingReader`/V4 contracts only; delete matching raw `duckdbOlap` fallback once parity is proven.                        |
| [ ]    | Both-mode review list                      | `src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsBoth.ts`                                                                                                                                         | V4 product read                                     | Use serving-only both-mode rows/counts. No in-memory LLM/human intersection or raw fallback.                                                                          |
| [ ]    | Human review list/filter                   | `src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsHuman.ts`, `src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsHumanFilters.ts`                                                    | V4 product read                                     | Use human V4 rows, human facets/options, keyset cursors, and named counts. No raw `app.judgment_human*` candidate materialization in foreground routes.               |
| [ ]    | Filter/facet routes                        | `src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsFilters.ts`, `src/services/olap/articlesReviewsFiltersOlap.ts`                                                                                   | V4 product read                                     | Use precomputed V4 facets/filter options and availability states. No foreground raw `GROUP BY` over judgments, prompt facts, or selected import CTEs.                 |
| [ ]    | Unassessed review routes                   | `src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsUnassessed.ts`, `src/services/olap/unassessedArticlesOlap.ts`                                                                                    | V4 product read                                     | Use `mart.review_unassessed_queue_serving_v4` or equivalent V4 queue service. No raw fallback windows.                                                                |
| [ ]    | Review health/warnings                     | `src/server/routes/projectsRoutes/projectsRoutesGetReviewsHealth.ts`, `src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.ts`                                                                       | V4 product read plus residual allowlist             | Read manifests, rebuild requests, chunk state, queue state, and diagnostics cheaply. Any source/mart inspections must be residual-allowlisted or async maintenance.   |
| [ ]    | Prompt preview                             | `src/server/routes/projectsRoutes/projectsRoutesGetPromptPreview.ts`                                                                                                                                               | Residual foreground read allowlist                  | Keep owner-routed. Move project-scale sampling to V4 serving/search state or allowlist bounded source reads with caps.                                                |
| [ ]    | Review detail/hydration                    | `src/server/routes/projectsRoutes/projectsRoutesPostArticleReviewDetails.ts`, `src/server/routes/ArticlesRoutes.ts` detail paths                                                                                   | V4 product read plus residual allowlist             | Use keyed V4 detail/payload reads and small overlays. Avoid list-route payload hydration and raw selected-import CTE recreation.                                      |
| [ ]    | Project list/access/config                 | `src/server/routes/ProjectsRoutes.ts`, `src/server/routes/projectsRoutes/projectAccessGuard.ts`                                                                                                                    | Owner-routed source access                          | API role must proxy/fail closed. Owner may read source project metadata. Do not let API-role project access open DuckDB locally.                                      |
| [ ]    | Project article membership                 | `src/server/routes/ProjectArticlesRoutes.ts`                                                                                                                                                                       | Owner-routed source access                          | Owner-side source writes/reads are allowed. Bulk/list-like selection must move to V4 jobs when project-scale.                                                         |
| [ ]    | Add-to-project by filter/IDs               | `src/server/routes/ProjectsAddArticlesRoutes.ts`, `src/services/olap/selectArticleIdsOlap.ts`                                                                                                                      | V4 durable job                                      | Replace all-ID arrays with `reviewBulkOperationService` jobs, snapshot pins, filter signatures, and keyset batches.                                                   |
| [ ]    | Project export                             | `src/server/routes/ProjectExportRoutes.ts`, `src/server/services/projectTransfer/projectTransferExport*.ts`                                                                                                        | V4 durable job / owner-routed source access         | Export jobs must use serving/job cursors and payload budgets. No request-path raw scans, `OFFSET`, or full prompt-filter in-memory passes.                            |
| [ ]    | PDF fetch                                  | `src/server/routes/ArticlesRoutes.ts`, `src/server/services/pdfFetchJobs.ts`                                                                                                                                       | V4 durable job                                      | Use bounded selection jobs/snapshot pins. PDF fetch receives batches, never all matching IDs from a foreground request.                                               |
| [ ]    | Judgment jobs API reads                    | `src/server/routes/JudgmentsJobsRoutes.ts`, `src/server/routes/judgmentsJobsRoutesApiReadModel.test.ts`                                                                                                            | V4 product/job read plus owner-routed source access | Running job/progress APIs may read owner-side state. Unassessed queue/count/article reads must use V4 queue state or fail/stale, not local API-role read-only DuckDB. |
| [ ]    | Comparison projects                        | `src/server/routes/ComparisonProjectsRoutes.ts`, `src/server/routes/comparisonProjectsRoutes/*`, `src/server/services/comparisonProjectServing*.ts`                                                                | Owner-routed source access / serving migration      | Keep owner-dependent. Classify comparison serving reads and migrate product-scale reads to bounded serving tables/jobs before broad API-role guards.                  |
| [ ]    | Data sources and imports                   | `src/server/routes/DataSourcesRoutes.ts`, `src/server/routes/DataSourcesImportRoutes/*`, `src/server/services/dataSourceQueryService.ts`, `src/server/services/covidenceImportService.ts`                          | Owner-routed source access / owner writer           | Owner-side metadata and import writes are allowed. Append deltas/hot fields transactionally and avoid synchronous project fanout.                                     |
| [ ]    | Prompts/subprojects/models/providers       | `src/server/routes/PromptsRoutes.ts`, `src/server/routes/SubprojectsRoutes.ts`, `src/server/routes/ModelsRoutes.ts`, `src/server/routes/ProviderModelsRoutes.ts`, `src/server/routes/ProviderConnectionsRoutes.ts` | Owner-routed source access                          | Source metadata reads/writes stay owner-routed. Any project-scale effect must enqueue V4 dirty/rebuild work instead of foreground scans.                              |
| [ ]    | Human assessment routes                    | `src/server/routes/HumanAssessmentRoutes/*`                                                                                                                                                                        | Owner-routed source access / V4 delta source        | Owner-side human judgment writes should append deltas/dirty work. Product reads should consume V4 freshness/overlay state when exposed to review UI.                  |
| [ ]    | Tokens/request attempts/provider telemetry | `src/server/routes/tokensRoutes/*`, `src/server/services/tokenUseQueryService.ts`, `src/server/services/requestAttemptCloseoutService.ts`, `src/server/services/judgmentProviderTelemetryHistoryService.ts`        | Owner-routed source access / admin-job read         | Keep owner-routed or admin classified. Add workload contexts and avoid project-review raw scans in product paths.                                                     |

## V4 Serving And Projector Checklist

| Status | Area                               | Files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Classification                       | Required handling                                                                                                                             |
| ------ | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| [ ]    | Contracts and admission            | `src/server/reviewServing/reviewServingContracts.ts`, `reviewServingReadContracts.ts`, `reviewServingAdmission.ts`, `reviewServingCursor.ts`                                                                                                                                                                                                                                                                                                                                                             | V4 product read                      | This is the foreground admission source. Every migrated route needs a contract, budgets, cursor shape, count/search state, and test coverage. |
| [ ]    | V4 reader/route services           | `src/server/reviewServing/reviewServingReader.ts`, `reviewServingLlmReviewRouteService.ts`, `reviewServingFilterRouteService.ts`, `reviewServingHumanBothUnassessedRouteService.ts`, `reviewSearchService.ts`                                                                                                                                                                                                                                                                                            | V4 product read                      | Normal review/list/filter/search/queue routes call these modules. They must return readiness states and never choose raw fallback.            |
| [ ]    | SQL builders and guards            | `src/server/reviewServing/reviewServingSql*.ts`, `reviewServingSql.test.ts`, `reviewServingResidualReadAllowlist.test.ts`                                                                                                                                                                                                                                                                                                                                                                                | V4 product read / residual allowlist | Foreground SQL must be serving-only and guard forbidden tokens. Residual source reads need explicit entries.                                  |
| [ ]    | Manifest and snapshot pins         | `reviewServingManifestRepository.ts`, `reviewServingSnapshotPromotionService.ts`, `reviewServingSnapshotPinRepository.ts`, `reviewServingRetentionService.ts`                                                                                                                                                                                                                                                                                                                                            | V4 product read / single V4 writer   | Manifests gate active snapshots. Pins protect durable jobs and cursors. Promotion must be atomic and owner-side.                              |
| [ ]    | Dirty/delta intake                 | `reviewChangeDeltaDirtyIntakeService.ts`, `reviewImportDeltaDirtyIntakeService.ts`, `reviewServingDirtyWorkService.ts`                                                                                                                                                                                                                                                                                                                                                                                   | Owner/background writer              | Source writes append/coalesce deltas and dirty work. Batches must be bounded and idempotent.                                                  |
| [ ]    | Projector service and writer       | `reviewServingProjectorService.ts`, `reviewServingProjectorWriter.ts`, `src/server/workers/reviewServingProjectorWorker.ts`                                                                                                                                                                                                                                                                                                                                                                              | Single V4 writer                     | This is the only normal V4 serving writer/promotion boundary. Existing mart services may schedule but must not bypass it.                     |
| [ ]    | Projection components              | `reviewServingSelectedImportProjector.ts`, `reviewServingSelectedImportPatchProjector.ts`, `reviewServingProjectScopeProjector.ts`, `reviewServingDisplayPayloadProjector.ts`, `reviewServingJudgmentPayloadProjector.ts`, `reviewServingLlmStatusProjector.ts`, `reviewServingHumanStatusProjector.ts`, `reviewServingFilterPostingProjector.ts`, `reviewServingFilterOptionProjector.ts`, `reviewServingSummaryProjector.ts`, `reviewServingQueueProjector.ts`, `reviewServingTitleSearchProjector.ts` | Single V4 writer                     | Component projectors own bounded V4 rows and summaries. They must use component-scoped identities, watermarks, and idempotent writes.         |
| [ ]    | Rebuild/chunk/request repositories | `reviewServingRebuildRequestRepository.ts`, `reviewServingV4RebuildRequestService.ts`, `reviewServingChunkManifestRepository.ts`                                                                                                                                                                                                                                                                                                                                                                         | Owner/background writer              | Rebuild requests and chunk manifests are maintenance/admission state, not product-read SQL. Keep bounded, resumable, and classified.          |
| [ ]    | Bulk/search/job services           | `reviewBulkOperationService.ts`, `reviewBulkOperationWorker.ts`, `reviewServingJudgmentJobQueueService.ts`                                                                                                                                                                                                                                                                                                                                                                                               | V4 durable job / owner-background    | Store criteria, filter signatures, identities, snapshot IDs, and progress. Process keyset batches; do not materialize all IDs.                |
| [ ]    | Benchmark/parity/diagnostics       | `reviewServingRouteParityRunner.ts`, `reviewServingBenchmark.ts`, `reviewServingDiagnosticsRepository.ts`, `reviewServingDesktopInterruptionEvidence.ts`                                                                                                                                                                                                                                                                                                                                                 | Verification/admin                   | Keep as evidence/admin surfaces. They may inspect V4 state but should not become product fallback.                                            |

## Legacy OLAP Retirement Checklist

| Status | Files                                             | Classification     | Required handling                                                                                                       |
| ------ | ------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| [ ]    | `src/services/olap/duckdbOlap.ts`                 | Quarantined legacy | Keep only for explicitly allowlisted legacy/admin callers. Delete raw fallback branches route-by-route after V4 parity. |
| [ ]    | `src/services/olap/articlesReviewsOlap.ts`        | Quarantined legacy | Replace callers with `reviewServingReader`; then delete wrapper.                                                        |
| [ ]    | `src/services/olap/articlesReviewsBothOlap.ts`    | Quarantined legacy | Replace both-mode callers with V4 both service; then delete wrapper.                                                    |
| [ ]    | `src/services/olap/articlesReviewsFiltersOlap.ts` | Quarantined legacy | Replace filter/facet callers with V4 filter service; then delete wrapper.                                               |
| [ ]    | `src/services/olap/unassessedArticlesOlap.ts`     | Quarantined legacy | Replace job and review callers with V4 unassessed queue service; then delete wrapper.                                   |
| [ ]    | `src/services/olap/selectArticleIdsOlap.ts`       | Quarantined legacy | Replace select-all/add-to-project callers with durable V4 bulk jobs; then delete wrapper.                               |

## Background, Cron, Import, And Maintenance Checklist

| Status | Area                                    | Files                                                                                                                                                                                                                               | Classification                                       | Required handling                                                                                                                                                 |
| ------ | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [ ]    | Judgment cron and LLM processing        | `src/server/cron/judgmentsJobs.ts`, `src/server/cron/judgmentsJobs/*`, `src/agent/judge/*`                                                                                                                                          | Owner/background writer                              | Keep background-only. Writes must append deltas/outbox state and use workload contexts. Queue selection should use V4 queue/projection state where product-scale. |
| [ ]    | Full text jobs                          | `src/server/cron/fullTextJobs.ts`, `src/server/cron/fullTextConversionJobs.ts`, `src/server/utils/ensureFullText.ts`                                                                                                                | Owner/background writer                              | Keep bounded/background. Append dirty work for affected display/search/judgment-input components.                                                                 |
| [ ]    | Provider admission/telemetry            | `src/server/cron/judgmentsJobs/providerAdmissionLease.ts`, `src/server/cron/judgmentsJobs/judgmentDispatchTelemetry.ts`, provider repositories                                                                                      | Owner/background writer                              | Owner-side source state. Add workload contexts and keep API reads owner-routed.                                                                                   |
| [ ]    | Import/store workflows                  | `src/server/services/articleImportStoreService.ts`, `articleCanonicalMatcher.ts`, `covidenceImportService.ts`, `src/agent/*Workflow/*StoreEntries.ts`, `structuredFileImport*`, `pubmed/europePmc/fhir` import paths                | Owner/background writer                              | Append compact import/source-record deltas transactionally, pre-extract hot fields, and avoid synchronous project fanout.                                         |
| [ ]    | Dirty materialization                   | `projectMartDirtyMaterializationService.ts`, `projectMartDirtyRefreshStateService.ts`, `projectMartDirtyRefreshQuarantineBarrier.ts`                                                                                                | Owner/background writer                              | Consume coalesced dirty work and V4 projector output. Maintain bounded batches and avoid broad rediscovery.                                                       |
| [ ]    | Mart refresh worker                     | `src/server/workers/projectMartRefreshWorker.ts`, `getDuckdbMartMaintenanceService.ts`                                                                                                                                              | Owner/background writer                              | May schedule/wake work, but must not directly write/promote V4 review-serving rows after V4 cutover.                                                              |
| [ ]    | Large rebuild services                  | `projectMartLargeRebuildExecutor.ts`, `projectMartLargeRebuildRunner.ts`, `projectMartLargeRebuildCyclesService.ts`, `projectMartLargeRebuildStateService.ts`, `projectMartLargeRebuildProgressService.ts`                          | Owner/background writer                              | Become schedulers/backfill drivers for V4 projector service, using chunk manifests, input hashes, skip/resume, and bounded phases.                                |
| [ ]    | Comparison serving builders             | `comparisonProjectServingGenerationService.ts`, `comparisonProjectServingRebuildService.ts`, `comparisonProjectServingRollupBuilder.ts`, `comparisonProjectServingCellBuilder.ts`, `comparisonProjectServingInvalidationService.ts` | Owner/background writer / serving migration          | Keep owner-side and classify workload. Product comparison reads need their own serving/admission contracts.                                                       |
| [ ]    | Project transfer                        | `src/server/services/projectTransfer/*`, `src/server/routes/projectTransferRoutes.ts`                                                                                                                                               | Owner-routed source access / owner-background writer | Sensitive owner-dependent flows. Use batched source writes/jobs and dirty tokens; no API-role direct DuckDB.                                                      |
| [ ]    | Archived cleanup and maintenance leases | `archivedProjectCleanupService.ts`, `maintenanceWorkLeaseService.ts`, cleanup/recovery scripts                                                                                                                                      | Owner/background writer                              | Owner-guarded maintenance with workload contexts and bounded batches.                                                                                             |
| [ ]    | Migrations and DB schema                | `src/db/migrateDuckdb.ts`, `src/db/duckdbMigrations/*`                                                                                                                                                                              | Maintenance/migration                                | Owner/offline migration path. Not V4 product reads. Must not run concurrently as API-role foreground work.                                                        |
| [ ]    | Operator scripts                        | `scripts/*.ts` that call DB services, `dbBackup.ts`, `dbQuerySnapshot.ts`, `duckdbCheckpoint.ts`, recovery/rebuild/request scripts                                                                                                  | Admin/debug/tool allowlist                           | Use `withDuckdbMaintenanceAccess` or snapshot read-only helpers, shared memory/temp options, and maintenance workload contexts.                                   |

## Admin And Diagnostic Checklist

| Status | Area                        | Files                                                                              | Classification             | Required handling                                                                                                                          |
| ------ | --------------------------- | ---------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| [ ]    | Admin investigation         | `src/server/routes/AdminInvestigateRoutes.ts`                                      | Admin/debug/tool allowlist | May inspect DB directly on owner or through explicit read-only diagnostics. Keep isolated from normal product routes and workload-classed. |
| [ ]    | DuckDB owner diagnostics    | `DuckdbOwnerConnectionsRoutes.ts`, `runtimeReadyRoutes.ts`, owner connection pages | Admin/debug/tool allowlist | Diagnostics may read owner registry/runtime state. They should not become product data fallbacks.                                          |
| [ ]    | DuckDB Studio/snapshot      | `DuckdbStudioRoutes.ts`, `scripts/dbStudio.ts`, `scripts/dbQuerySnapshot.ts`       | Admin/debug/tool allowlist | Use snapshots/read-only mode, shared memory/temp settings, and explicit operator intent.                                                   |
| [ ]    | Ownerless readable backends | `ownerlessReadableBackends.ts`, read-only validation tests                         | Admin/diagnostic allowlist | Ownerless read-only mode is diagnostic/fallback metadata only, not normal product project access.                                          |

## Client/UI Checklist

| Status | Area                         | Files                                                      | Classification  | Required handling                                                                                                         |
| ------ | ---------------------------- | ---------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------- |
| [ ]    | Review UI freshness/warnings | `src/components/main/reviews/*`, `reviewsWarningsQuery.ts` | Client over API | No direct DuckDB. UI should consume server readiness/search/count/job states and stop inferring health from missing rows. |
| [ ]    | Admin UI                     | `src/app/routes/+admin/*`, `src/components/Navigation.tsx` | Client over API | No direct DuckDB. Admin pages call explicit diagnostics routes only.                                                      |

## First Implementation PRs

- [ ] **PR 1: docs and route gate**
  - Update `DUCK_OOM_FIX_PLAN.md` to reference this checklist.
  - Add/extend route inventory exhaustiveness tests.
  - Add proxy-order integration tests for API role.
  - Add owner-unavailable tests for representative project routes.
- [ ] **PR 2: static and runtime guardrails**
  - Add static guard for route-facing DuckDB imports.
  - Add static guard for `duckdbOlap` quarantine.
  - Add low-level missing-workload-context rejection for normal foreground work,
    initially behind a test/runtime switch if needed.
- [ ] **PR 3: residual read allowlist**
  - Create or update `reviewServingResidualReadAllowlist.ts`.
  - Register every non-V4 review health/warning/detail/prompt-preview read with
    purpose, cap, workload class, and migration target.
- [ ] **PR 4+: route-by-route V4 migration**
  - Move one product surface at a time to V4 services/jobs.
  - Delete or hard-disable the matching raw fallback in the same PR.
  - Add SQL-shape tests and route parity tests for each migrated surface.
- [ ] **Final evidence PR**
  - Current-DB smoke proves API role proxies/fails closed and owner serves V4.
  - Synthetic and physical release evidence prove no foreground raw fallback,
    no temp spill, and bounded rows/result bytes.

## Audit Commands

Use these to keep this file current:

```bash
git fetch origin main --prune
git status --short --branch
rg -l "DuckDB|duckdb|runDuckdb|DuckDBInstance|@duckdb/node-api|duckdbOlap|readOnlyDuckdb|appReadOnlyDatabase|appDatabaseService|getAppDatabaseService|getAppQueryService" src scripts TESTS.md DUCK*.md package.json
rg -n "runDuckdbJsonQuery|runDuckdbStatement|DuckDBInstance|@duckdb/node-api|duckdbOlap|readOnlyDuckdbService|appReadOnlyDatabaseService|appDatabaseService|getAppDatabaseService|getAppQueryService|duckdbRunner" src --glob '!**/*.test.ts' --glob '!**/*.vitest.tsx'
bun test src/server/routes/apiRouteClassification.test.ts src/server/routes/routeSurfaceInventory.test.ts src/server/routes/publicRouteSurfaceGate.test.ts
bun run test:network-smoke:current-db
bun run test:dev-server:current-db
```
