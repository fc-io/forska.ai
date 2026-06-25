# OOM Errors

Record every out-of-memory issue and fix here.

Entry format:

## YYYY-MM-DD - Area

- Error: Short log excerpt.
- Context: Affected job, query, route, command, or runtime path.
- Cause: Short explanation of why memory was exhausted.
- Fix: Short explanation of the code, query, config, or operational change.
- Verification: Command, test, or runtime check used to verify the fix.

## 2026-06-25 - Network Smoke OOM Cutover Gate

- Error: `Large rebuild failed` browser/API/server output could pass network smoke without being treated as an OOM cutover regression.
- Context: Phase 5C current-DB browser smoke, `POST /api/projectsreviewswarnings`, route load diagnostics, and captured Playwright server logs.
- Cause: The smoke gate needed real-first then synthetic-second documentation, explicit skipped-route classifications, and broader `Large rebuild failed` detection across page, API, console, and server output.
- Fix: Added Phase 5C/master smoke gates, classified skipped routes, added current-DB warning probes for discovered projects, and fail the smoke pass on `Large rebuild failed` in warning responses, page HTML, document/fetch/XHR responses, console/page errors, or runtime logs.
- Verification: `bunx playwright test tests/e2e/networkSmoke.spec.ts -g "network smoke route inventory stays explicit"`, `bun test src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.test.ts`, `bun run lint`, `bun run test:network-smoke`, and `bun run test:network-smoke:synthetic`.

## 2026-06-25 - Network Smoke Warning Failure Variants

- Error: Failed review-warning states from `POST /api/projectsreviewswarnings` could pass current-DB network smoke unless they rendered the exact `Large rebuild failed` text.
- Context: Phase 5C current-DB browser smoke and route-loaded warning responses for review pages.
- Cause: The smoke gate checked HTTP errors and one failure string but did not parse warning payloads for failed status variants or failed-count diagnostics.
- Fix: Current-DB warning probes and route-loaded warning responses now fail on any `failed` warning status value or positive `failedCount` in the warning payload.
- Verification: `bunx playwright test tests/e2e/networkSmoke.spec.ts -g "network smoke route inventory stays explicit"` and `bun run test:network-smoke:synthetic`.

## 2026-06-25 - Network Smoke OOM Cutover Follow-Up

- Error: `Out of Memory Error: failed to pin block` class from legacy DuckDB review-serving maintenance and network-smoke cutover regressions.
- Context: Phase 5C network-smoke regression gate, V4 rebuild chunks, missing-snapshot projector wakeups, and selected-import display patches.
- Cause: Terminal failed chunks could leave rebuild requests admitted/running forever, validation failures could leave partial mart output behind, rebuild admission failures could strand dirty claims until lease expiry, and selected-import display updates needed patch coverage.
- Fix: Terminal chunk failures now fail the owning rebuild request, failed output validation rolls back chunk writes before marking the chunk failed, failed missing-snapshot rebuild admission fails claimed dirty work, and selected-import patch tests cover title/external ID/source URL freshness.
- Verification: Focused review-serving projector, worker, chunk manifest, and display payload tests.

## 2026-06-24 - Phase 5B Review Thread Follow-Up

- Error: Review found V4 warning state could stay failed after superseded terminal request chunks, dirty recovery could enqueue duplicate full-project V4 rebuilds, and rebuild admission estimates ignored list-mode fan-out.
- Context: `projectsRoutesGetReviewsWarnings`, `recoverDirtyRefreshClaims`, and `reviewServingV4RebuildRequestService`.
- Cause: Diagnostics counted terminal chunks project-wide, stale legacy categories queued separate request IDs for the same project, and row budgets used one row per component/article or judgment instead of display/status/payload list-mode expansion.
- Fix: Terminal rebuild chunk diagnostics now apply only to the latest request, stale legacy recovery coalesces projects into one V4 request before releasing rows, and V4 estimates multiply article, prompt, and payload rows by component-specific fan-out.
- Verification: Focused Bun tests for warnings, diagnostics, recovery, and V4 rebuild request admission; targeted ESLint on touched files.

## 2026-06-24 - Phase 5B V4 Rebuild Request Review Fixes

- Error: Review found V4 rebuild requests admitted project-scale work with `estimatedInputRows` based only on component count, default chunks with synthetic identities and sentinel article bounds, and failed chunks without retry backoff.
- Context: `app.review_rebuild_request`, `app.review_rebuild_chunk_manifest`, V4 review-serving rebuild request scripts, and the projector chunk worker.
- Cause: Request-created chunks did not inherit active/candidate projection identities or real article ranges, request IDs did not include live data watermarks, budget admission underestimated scoped articles/prompts/judgments, and failed chunks could be reclaimed without cooldown.
- Fix: Default chunks now use existing snapshot/manifest identities and project article bounds, request estimates and source watermarks come from project data, diagnostics surface blocked chunks, chunk claim/retry metadata is qualified and bounded, and the legacy dirty-refresh fallback requires the large-rebuild ack.
- Verification: Focused Bun tests for the touched request, chunk manifest, diagnostics, V4 request service, and static guard paths.

## 2026-06-23 - Legacy Judgment Fact Large Rebuild

- Error: DuckDB OOM during the staged background `judgment_fact` large rebuild; the failing shape built `temp_project_judgment_fact_article` from a large inline `VALUES (...)` article list before deleting and reinserting `mart.judgment_fact` rows from raw `app.judgment`.
- Context: Legacy project mart large-rebuild maintenance path still available after normal review reads moved toward V4 serving contracts.
- Cause: The legacy phase was chunked by article count but not by prompt density, judgment rows, payload bytes, temp risk, retry behavior, or V4 manifest ownership, so a background rebuild could still scan, hash, delete, and reinsert project-scale fact state under the shared DuckDB cap.
- Fix: Phase 5B plan now requires retiring or V4-rewiring legacy refresh/rebuild, dirty-refresh, repair/recovery, warning/admin, startup/heartbeat, package-script, and adjacent browser fallback paths; it also adds V4 rebuild request admission, component-specific chunk budgets, retry cooldown/split/quarantine behavior, durable OOM telemetry, and Phase 6 adversarial OOM proof gates.
- Verification: Five Codex review passes integrated into `DUCK_CQRS_PLAN_PHASE_5B.md`, `DUCK_OOM_FIX_PLAN.md`, and `DUCK_CQRS_PLAN_PHASE_6.md`; implementation and runtime verification remain Phase 5B/Phase 6 work.

## 2026-06-23 - Phase 5B V4 Rebuild Request Admission

- Error: Legacy rebuild and repair requests could still create or resume article-count chunks that only discovered dense judgment/payload/temp risk after DuckDB execution began.
- Context: Phase 5B request layer above `app.review_rebuild_chunk_manifest`.
- Cause: Chunk manifests existed, but there was no durable request-level admission record carrying requested components, identities, retry policy, estimates, budget diagnostics, or over-budget state before chunks became claimable.
- Fix: Added `app.review_rebuild_request`, request-owned chunk manifest fields, request admission, budget/diagnostic fields, retry-after/over-budget metadata, and claim gating so request-owned chunks are claimable only after the parent request is admitted.
- Verification: `bun test src/server/reviewServing/reviewServingSchema.test.ts src/server/reviewServing/reviewServingChunkManifestRepository.test.ts src/server/reviewServing/reviewServingRebuildRequestRepository.test.ts`.

## 2026-06-23 - Phase 5B Operator Request Cutover

- Error: Normal operator scripts named around large rebuild and `judgment_fact` repair still requested legacy `project_mart_large_rebuild_state` work.
- Context: `scripts/requestProjectLargeRebuild.ts`, `scripts/requestReviewServingLargeRebuild.ts`, and `scripts/requestJudgmentFactRepair.ts`.
- Cause: The scripts called `getDuckdbMartMaintenanceService().requestProjectLargeRebuild*`, preserving the old seven-phase mart rebuild chain as a normal recovery path.
- Fix: Rewired the scripts through `reviewServingV4RebuildRequestService.ts` so they create admitted `app.review_rebuild_request` rows and request-owned chunk manifests; `requestJudgmentFactRepair` now requires explicit project selection and no longer scans `mart.judgment_fact` by default.
- Verification: `bun test scripts/requestReviewServingLargeRebuild.test.ts scripts/requestProjectLargeRebuild.test.ts scripts/requestJudgmentFactRepair.test.ts`; focused ESLint on the touched scripts, tests, and V4 request service.

## 2026-06-23 - Phase 5B Startup And Legacy Worker Cutover

- Error: Normal maintenance startup and package scripts could still mount legacy refresh and seven-phase large-rebuild workers after V4 rebuild request admission existed.
- Context: `src/server/utils/startBackgroundWork.ts`, `package.json`, `scripts/runLargeRebuildWorkerOnce.ts`, and `scripts/runLargeRebuildWorkerCycles.ts`.
- Cause: The startup path gated on legacy mart-refresh drain eligibility and then started legacy refresh/large-rebuild heartbeats; package commands exposed unguarded legacy large-rebuild worker entrypoints.
- Fix: Removed legacy refresh/large-rebuild heartbeat startup from normal maintenance work, kept the V4 projector heartbeat as the normal rebuild executor, renamed package commands to explicit `legacy-admin-*`, and required `--legacy-admin-ack=legacy-large-rebuild` for direct legacy worker execution.
- Verification: `bun test src/server/utils/startBackgroundWork.test.ts scripts/rebuild2PackageCommands.test.ts scripts/runLargeRebuildWorkerOnce.test.ts scripts/runLargeRebuildWorkerCycles.test.ts`; focused ESLint on the touched startup, package-script, legacy-admin, and recovery compatibility tests.

## 2026-06-23 - Phase 5B Recovery And Warning Side Effects

- Error: Recovery and warning/status paths could still resume or schedule legacy refresh and large-rebuild work as a side effect of inspection.
- Context: `scripts/recoverDirtyRefreshClaims.ts` and `src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.ts`.
- Cause: `recoverDirtyRefreshClaims --recover` shelled into legacy refresh and large-rebuild workers; review-warning reads scanned `mart.judgment_fact`, marked dirty repair state for missing facts, and bootstrapped missing serving rows through legacy large rebuild requests.
- Fix: Recovery now enqueues V4 `app.review_rebuild_request` rows and leaves stale legacy claims as diagnostics; review-warning reads no longer scan `mart.judgment_fact` or schedule legacy dirty/large-rebuild repair, reporting stale V4 state instead.
- Verification: `bun test scripts/projectMartRefreshRecovery.test.ts src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.test.ts`; focused ESLint on the touched recovery script and warning route/tests.

## 2026-06-23 - Phase 5B Legacy Admin Guards

- Error: Direct legacy dirty-refresh worker scripts could still be run without an explicit acknowledgement, and the Phase 5B cutover decisions had no focused regression guard.
- Context: `scripts/runProjectMartRefreshWorker*.ts`, `scripts/runLargeRebuildWorker*.ts`, startup, package scripts, warning route, and dirty recovery script.
- Cause: Startup and package cutover reduced normal exposure, but direct script execution and future edits could reintroduce legacy refresh/rebuild OOM paths without a static test failing.
- Fix: Added `legacy-dirty-refresh` acknowledgement checks to direct dirty-refresh worker scripts and added Phase 5B static guards covering startup, warning side effects, V4 recovery, package command exposure, and required legacy-admin acknowledgements.
- Verification: `bun test src/server/reviewServing/reviewServingPhase5BStaticGuards.test.ts scripts/projectMartRefreshRecovery.test.ts`; focused ESLint on the touched scripts and static guard test.

## 2026-06-23 - Review Serving Projector Chunk Claim

- Error: `DuckDB workload budget exceeded for reviewServing.projector.worker: temp spill 11206656 bytes is not allowed` from the rebuild chunk claim query.
- Context: `reviewServingProjectorWorker` calling `getNextClaimableReviewServingRebuildChunk` against `app.review_rebuild_chunk_manifest`.
- Cause: The claim path sorted all claimable rebuild chunk manifest rows by `updated_at`, `input_watermark`, `chunk_start_key`, and `chunk_id` before `LIMIT 1`, spilling temp data under the no-spill projector workload budget.
- Fix: Replaced the full-row `ORDER BY ... LIMIT 1` with aggregate tie-break CTEs that select the next `chunk_id` via `MIN(...)`, then fetch only that manifest row while keeping temp spill disallowed.
- Verification: `bun test src/server/reviewServing/reviewServingChunkManifestRepository.test.ts src/server/workers/reviewServingProjectorWorker.test.ts src/server/utils/reviewServingProjectorWorkerHeartbeat.test.ts`; `bun run lint`; in-memory DuckDB parser/runtime check for `getNextClaimableReviewServingRebuildChunk`.

## 2026-06-20 - Desktop DuckDB Runtime Memory Default

- Error: Desktop backend could start without an explicit DuckDB cap, leaving laptop/default runtimes exposed to the same `failed to pin block` class of DuckDB OOM under review-serving overlap workloads.
- Context: Phase 5 Part 2 desktop backend startup through `getDesktopRuntimeConfig` and shared review-serving projector, job, search, cleanup, and route runtime paths.
- Cause: Browser/server profiles already had low-memory DuckDB worker behavior, but desktop startup did not provide a bounded default `DUCKDB_MEMORY_LIMIT` when the operator had not set an override.
- Fix: Desktop backend now defaults `DUCKDB_MEMORY_LIMIT` to `6400MiB` while preserving explicit operator overrides; the existing DuckDB service maps limits at or below `6400MiB` to reduced concurrency and serialized work.
- Verification: `bun test src/desktop/getDesktopRuntimeConfig.test.ts src/server/reviewServing/reviewServingDesktopInterruptionEvidence.test.ts`; `bun run desktop:build`; Phase 5 closure audit targeted gates on 2026-06-20.

## 2026-06-13 - Review Serving V4 Foundation

- Error: `Out of Memory Error: failed to pin block of size 256.0 KiB (6.2 GiB/6.2 GiB used)` from foreground review reads under import/materialization overlap.
- Context: Phase 1 foundation for review rows, counts, facets, queues, search, bulk/export/PDF jobs, and DuckDB foreground workload admission.
- Cause: Normal review reads still lacked durable serving-only schema and generic runtime budget hooks needed to prevent project-scale raw scans from reaching DuckDB.
- Fix: Added empty `_v4` serving/control schema plus optional DuckDB workload contexts with row/byte/temp/elapsed budget enforcement and metrics.
- Verification: `bun test src/server/reviewServing/*.test.ts src/server/utils/duckdbServiceWorkloadContext.test.ts`; `bun test src/server/utils/duckdbService*.test.ts`; isolated temp migration through `0097_reviewServingV4Foundation.sql`.

## 2026-06-13 - Articles Reviews Serving Read

- Error: `Out of Memory Error: failed to pin block of size 256.0 KiB (6.2 GiB/6.2 GiB used)` from `POST /api/articlesreviews`.
- Context: Articles reviews request for project `e43a0bbb-703e-4701-a223-7488c5b40cd0`, with DuckDB query beginning `WITH selected_scoped_article_import AS`.
- Cause: Foreground review reads ranked selected import rows across the whole project while serving rows or returned article IDs were already enough to bound the work.
- Fix: Serving review reads no longer join selected imports for counts, list page selected-import ranking is scoped to `page_rows`, judgment hydration ranks selected imports only for returned article IDs, and raw no-metadata-filter review reads skip selected-import ranking.
- Verification: `bun test src/services/olap/duckdbOlap.test.ts`; `bun run lint`.

## 2026-06-12 - Comparison Serving Rollups

- Error: `Out of Memory Error: failed to allocate data of size 1.0 MiB (6.2 GiB/6.2 GiB used)` from `INSERT INTO mart.comparison_article_serving`.
- Context: Comparison serving rebuild `rollups` phase after staging `81,525` comparison cells and before inserting article rows.
- Cause: The article rollup insert still processed large 1,000-article batches and used several `COUNT(DISTINCT ...)` aggregates over staged cells in one DuckDB statement.
- Fix: Reduced article rollup batches to 100 articles and rewrote the article-serving rollup aggregates to use ordinary counts, sums, and min/max/boolean checks instead of distinct-count hash aggregates.
- Verification: `bun test src/server/services/comparisonProjectServingRollupBuilder.test.ts`; `bun test src/server/services/comparisonProjectServingRebuildService.test.ts`; scoped ESLint.

## 2026-06-12 - Judgment Queue Refill

- Error: `Out of Memory Error: failed to pin block of size 256.0 KiB (6.2 GiB/6.2 GiB used)` from `[cron] runAddToQueue`.
- Context: Raw summary-mode judgment queue refill query over `dirty_scope_candidate` and `app.judgment_human_summary`.
- Cause: The refill path sorted a broad summary-priority candidate bucket by article activity before applying the small queue limit.
- Fix: Queue-only raw summary scans now stage bounded `summary_article_candidate` IDs and order by article ID before joining dirty/scope article tables.
- Verification: `bun test src/services/olap/duckdbOlap.test.ts`; `bun test src/server/cron/judgmentsJobs/judgmentsJobsAddToQueue.test.ts`; scoped ESLint.
