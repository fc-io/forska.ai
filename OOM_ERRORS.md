# OOM Errors

Record every out-of-memory issue and fix here.

Entry format:

## YYYY-MM-DD - Area

- Error: Short log excerpt.
- Context: Affected job, query, route, command, or runtime path.
- Cause: Short explanation of why memory was exhausted.
- Fix: Short explanation of the code, query, config, or operational change.
- Verification: Command, test, or runtime check used to verify the fix.

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
