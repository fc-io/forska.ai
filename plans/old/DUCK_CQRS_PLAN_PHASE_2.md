# DuckDB CQRS Plan Phase 2 - Write-Side Deltas, Hot Fields, And Overlays

Master coordinator: [DUCK_OOM_FIX_PLAN.md](./DUCK_OOM_FIX_PLAN.md)

## Objective

Instrument write paths so source mutations create compact durable deltas, import writers pre-extract hot fields, and reviewer actions have a small immediate feedback path before projections catch up.

## Cut Line

Instrument write paths to append compact delta/outbox rows, extract hot import fields, and create small reviewer-action overlays.

Phase 2 must not populate serving projections, promote snapshots, wake project-scale selected-import fanout synchronously, or switch product routes.

A Phase 2 write path may return success only after the source write and its local delta/outbox entry are durable in the same transaction, or after a durable reconciliation path can prove the missing delta will be recovered before any dependent watermark advances.

## Workstreams

| Status | Theme | Implement First | Done When |
|---|---|---|---|
| [x] | Write-side deltas | Add `reviewServingDeltaLedger` append APIs, source high-water/idempotency helpers, and update import, article content/display, LLM judgment, human judgment, prompt/config, and project-scope writers to append compact deltas transactionally with change kinds from the invalidation registry. Pre-extract hot import fields into `app.review_import_article_hot_field`. Add durable outbox/reconciliation only for source writes that cannot append the delta in the same transaction. | 2026-06-20 audit: implemented with evidence in `src/server/reviewServing/reviewServingDeltaLedger.ts`, `src/server/reviewServing/reviewServingDeltaReconciliation.ts`, `src/server/reviewServing/reviewImportHotFieldService.ts`, write integrations listed in the audit section below, and passing focused tests. |
| [x] | Read-your-write state | Add optimistic/overlay state for reviewer actions that need immediate feedback before projection catches up. | 2026-06-20 audit: implemented with `src/server/reviewServing/reviewWriteOverlayService.ts`, prompt submit integration in `src/server/routes/HumanAssessmentRoutes/humanAssessmentRoutesPostSubmit.ts`, and overlay scope/reconcile tests listed below. |

## Delta Envelope

Every row in `app.import_run_article_delta` and `app.review_change_delta` has common fields independent of `change_kind`: `delta_id`, `change_kind`, `source_table`, `source_row_id`, `source_operation`, `source_partition`, `source_high_water_mark`, `source_updated_at`, `idempotency_key`, `payload_version`, compact typed key columns, optional `payload_json`, `created_at`, and `reconciled_at`.

The invalidation registry `requiredKeys` are change-specific payload keys. The envelope fields are required for every delta and are tested separately.

`source_high_water_mark` is monotonic within `source_partition`. Projectors and dirty-work conversion cannot advance a consumer watermark past an unreconciled source high-water mark.

## High-Water And Idempotency Rule

- Phase 2 must add one shared allocator used by every delta/outbox writer. The allocator increments `app.review_delta_reconciliation_cursor.source_high_water_mark` for the `source_partition` inside the same DuckDB transaction as the source write and delta/outbox append.
- The cursor value is the highest allocated source mark for that partition. Reconciliation and projector consumers decide safety from durable delta/outbox rows: no dependent watermark may advance to mark `N` while an outbox or malformed delta at or below `N` is pending, retryable, or quarantined without an explicit terminal operator decision.
- If the source write cannot append a delta in the same transaction, it must still create a durable `app.review_source_change_outbox` row with the allocated high-water mark before returning success, or the write path must be excluded from Phase 2 with a failing/skip-listed test.
- `idempotency_key` is deterministic from stable source mutation identity and compact typed keys. It must not include random IDs, attempt IDs, timestamps from the current process, or the allocated high-water mark.
- Duplicate append attempts with the same `idempotency_key` must be no-ops that return the existing delta/outbox identity and must not allocate a second effective mutation.
- `delta_id` and outbox IDs may be generated IDs, but they are not used for dedupe semantics.

## Source Ownership Rules

- Article/import-route membership writes emit `importRoute.article.added`, `importRoute.article.removed`, or `importRoute.article.rankFields.updated` and do not resolve affected projects in the write transaction.
- Direct project membership writes emit `projectScope.article.added` or `projectScope.article.removed` because the affected project is already the source row owner.
- Article content/display writes may emit multiple deltas in one transaction: `article.display.updated`, `article.searchText.updated`, and/or `article.judgmentInput.updated`, depending on which derived input identities changed.
- `article.judgmentInput.updated` must dirty every dependent component whose data can be stale after title/abstract/fulltext changes, including judgment input content, affected LLM status, queue, posting, summary, and payload rows that back prompt preview or detail text.
- LLM judgment writes emit `judgment.llm.created`, `judgment.llm.updated`, or `judgment.llm.deleted` with model ID, prompt ID, content flags, judgment ID, and source high-water state from the persisted source row.
- LLM judgment deltas must preserve benchmark-critical model/content settings and must not silently retry or reinterpret failed requests.
- Human review writes emit `judgment.human.updated`. Prompt-mode human updates include the prompt key; summary-mode human updates are valid without `promptId` and must still dirty human status, posting, and summary projections.
- If human deletes or hard tombstones are introduced later, add a new `change_kind` and registry rule before wiring that write path.
- Prompt edits emit `prompt.config.updated` for the affected prompt identity, including prompt text, answer schema, thresholding, prompt order, and other prompt-output-affecting settings.
- Project model/content/prompt membership changes emit `project.reviewConfig.updated` and do not mark article/display/search/payload identities dirty unless those inputs actually changed. Review config identity changes include model execution identity, content flags, prompt membership/order, and human review mode when those settings affect route semantics.
- Import-route writes must not synthesize `projectScope.article.*` deltas synchronously.
- Only persist `affected_project_id` in an import-write transaction if route-to-project fanout is measured and bounded.

## Implementation Hook Points

Phase 2 should instrument central write services first. Route handlers that bypass these services must either call the same delta helper or be documented with a targeted test as out of Phase 2 scope.

- Import/source-record deltas start in `src/server/services/articleImportStoreService.ts`: `storeImportedArticlesInTx`, `storeImportedArticlesWithTx`, `syncImportedArticlesWithTx`, `upsertArticleImportRouteCurrentLinks`, `upsertArticleImportRouteSourceRecords`, and `clearStaleImportRouteLinks`.
- Import callers such as `structuredFileImportService.ts`, `covidenceImportService.ts`, and the data-source import routes should not get separate delta logic unless they bypass `articleImportStoreService.ts`.
- Article display/search/judgment-input changes start with canonical article writes in `articleImportStoreService.ts` and `articleCanonicalMatcher.ts`, then cover full-text/PDF/admin update paths in `pdfFetchJobs.ts`, `fullTextConversionJobs.ts`, `ensureFullText.ts`, `ArticleAdminRoutes.ts`, and `ArticlesRoutes.ts`.
- LLM judgment deltas start in `src/server/cron/judgmentsJobs/judgmentsJobsMarkDirtyWork.ts` at `commitJudgmentSqliteOutboxImportDirtyWork` and `insertJudgments`. Direct or bulk paths such as `storeSinglePromptJudgment.ts`, `judgeStoreJudgment.ts`, prompt/admin delete paths, and `projectTransferCommitWriter.ts` must route through the ledger helper or have explicit reconciliation coverage.
- Human judgment deltas start in `HumanAssessmentRoutes/humanAssessmentRoutesPostSubmit.ts`, then cover pending human rows, Covidence seeded judgments, prompt merge/delete paths, summary-mode human judgments, and project-transfer human judgment imports.
- Prompt and review-config deltas start in `ProjectsRoutes.ts` around `upsertProjectPromptTx`, `softDeleteProjectPromptLlmJudgmentsTx`, project import-route edits, and project create/edit/clone transactions. `PromptsRoutes.ts`, `immutablePromptService.ts`, and `covidenceImportService.ts` must use the same helper for prompt identity changes.
- Project-scope deltas start in `insertArticlesIntoProject.ts`, `ProjectArticlesRoutes.ts`, `ProjectsAddArticlesRoutes.ts`, `SubprojectsRoutes.ts`, project import-route membership edits, and `projectTransferCommitWriter.ts` bulk membership writes.

## Hot-Field Extraction Rule

Import writers pre-extract only compact typed fields needed by selected-import ranking, display, filters, postings, and contribution keys into `app.review_import_article_hot_field`.

Raw source JSON, large metadata, and audit payloads remain in existing source/audit tables.

Projectors read the hot-field table or compact delta keys. Foreground routes do not extract JSON.

If a source record lacks a hot field, store a typed null/unavailable value rather than requiring projectors or foreground reads to parse raw JSON.

## Overlay Rule

`app.review_write_overlay` is only for immediate reviewer feedback on row/detail actions.

It stores the affected project, optional review config hash, article, prompt/judgment key, overlay kind, small typed value, source high-water mark, `created_at`, `expires_at`, and reconcile status.

It does not make counts, facets, queues, search, bulk selection, PDF, or export overlay-aware unless that route contract explicitly opts in.

## JavaScript And TypeScript Rule

Use the `effect` library for non-trivial JavaScript/TypeScript async and server flow in Phase 2 write integrations, reconciliation, hot-field extraction, and overlay services. Prefer `Effect.gen` for sequencing, `Layer`/`Context` for service wiring, `Effect.acquireRelease`/`Scope` for resource lifetime, and `Schedule` for retries, polling, and backoff. Keep pure transforms and very small handlers as plain functions.

## Required Artifacts

- `src/server/reviewServing/reviewServingDeltaLedger.ts`
- `src/server/reviewServing/reviewServingDeltaReconciliation.ts`
- `src/server/reviewServing/reviewImportHotFieldService.ts`
- Source high-water and idempotency helpers inside `reviewServingDeltaLedger.ts` or a sibling used only by the ledger/reconciliation services
- Write-path integrations for import/source records, article display/search/judgment-input changes, LLM judgments, human judgments, prompt/config changes, and project-scope changes
- Overlay repository/service for reviewer actions
- Static hook-inventory tests plus targeted tests for atomic writes, idempotency, tombstones, source ownership, hot fields, reconciliation, and overlay scope

## 2026-06-20 Audit Status

Status: Phase 2 is implemented after one scoped fix from this audit.

Findings and fixes:

- Fixed duplicate import rank-field deltas during sync cleanup/update. `src/server/services/articleImportStoreService.ts` now emits current-link `importRoute.article.rankFields.updated` deltas only for source-record key changes, because source-record hash refreshes already emit the compact source-record rank delta. It also avoids duplicate stale source-record tombstones when the current-link removal already covers the same source record.
- Added direct LLM delta helper coverage in `src/server/reviewServing/llmJudgmentReviewServingDeltaService.test.ts`; previous evidence was only indirect through `src/server/cron/judgmentsJobs/judgmentsJobsMarkDirtyWork.test.ts`.
- No Phase 2 blocker remains for later phases. The implementation keeps product routes on existing read contracts and does not populate serving projections, promote snapshots, or synchronously fan out selected-import state from import writes.

Evidence:

- Schema/envelope tables: `src/db/duckdbMigrations/0097_reviewServingV4Foundation.sql` creates `app.import_run_article_delta`, `app.review_change_delta`, `app.review_source_change_outbox`, `app.review_delta_reconciliation_cursor`, `app.review_import_article_hot_field`, and `app.review_write_overlay`; `src/db/duckdbMigrations/0102_reviewWriteOverlayReadSurface.sql` adds overlay read-surface scope.
- Ledger/high-water/idempotency/outbox: `src/server/reviewServing/reviewServingDeltaLedger.ts`; tests in `src/server/reviewServing/reviewServingDeltaLedger.test.ts` and `src/server/reviewServing/reviewServingDeltaReconciliation.test.ts` cover common envelope fields, deterministic idempotency, duplicate no-op behavior, monotonic high-water allocation, tombstones, outbox conversion/quarantine, and watermark barriers.
- Import deltas and hot fields: `src/server/services/articleImportStoreService.ts` wires `storeImportedArticlesInTx`, `storeImportedArticlesWithTx`, `syncImportedArticlesWithTx`, `upsertArticleImportRouteCurrentLinks`, `upsertArticleImportRouteSourceRecords`, and `clearStaleImportRouteLinks`; `src/server/reviewServing/reviewImportHotFieldService.ts` extracts compact typed hot fields. Evidence tests: `src/server/services/articleImportStoreService.test.ts`, `src/server/reviewServing/reviewImportHotFieldService.test.ts`, `src/server/reviewServing/reviewImportDeltaDirtyIntakeService.test.ts`, `src/server/reviewServing/reviewServingSelectedImportProjector.test.ts`, and `src/server/reviewServing/reviewServingSelectedImportPatchProjector.test.ts`.
- Article content/display/search/judgment-input deltas: `src/server/reviewServing/articleReviewServingDeltaService.ts` and integrations in `articleImportStoreService.ts`, `articleCanonicalMatcher.ts`, `pdfFetchJobs.ts`, `fullTextConversionJobs.ts`, `ensureFullText.ts`, `ArticleAdminRoutes.ts`, and `ArticlesRoutes.ts`; evidence in `src/server/reviewServing/articleReviewServingDeltaService.test.ts` and `src/server/reviewServing/reviewServingHookInventory.test.ts`.
- LLM judgment deltas: `src/server/reviewServing/llmJudgmentReviewServingDeltaService.ts` and integrations in `judgmentsJobsMarkDirtyWork.ts`, `judgeStoreJudgment.ts`, `PromptsRoutes.ts`, `ProjectsRoutes.ts`, and `projectTransferCommitWriter.ts`; evidence in `src/server/reviewServing/llmJudgmentReviewServingDeltaService.test.ts` and `src/server/cron/judgmentsJobs/judgmentsJobsMarkDirtyWork.test.ts`.
- Human judgment deltas and overlays: `src/server/reviewServing/humanJudgmentReviewServingDeltaService.ts`, `src/server/reviewServing/reviewWriteOverlayService.ts`, and `src/server/routes/HumanAssessmentRoutes/humanAssessmentRoutesPostSubmit.ts`; evidence in `src/server/reviewServing/humanJudgmentReviewServingDeltaService.test.ts`, `src/server/reviewServing/reviewWriteOverlayService.test.ts`, and `src/server/routes/HumanAssessmentRoutes/humanAssessmentRoutesPostSubmit.test.ts`.
- Prompt/review-config/project-scope deltas: `src/server/reviewServing/reviewConfigReviewServingDeltaService.ts`, `src/server/reviewServing/projectScopeReviewServingDeltaService.ts`, `ProjectsRoutes.ts`, `PromptsRoutes.ts`, `insertArticlesIntoProject.ts`, `SubprojectsRoutes.ts`, `covidenceImportService.ts`, and `projectTransferCommitWriter.ts`; evidence in `src/server/reviewServing/reviewConfigReviewServingDeltaService.test.ts`, `src/server/reviewServing/projectScopeReviewServingDeltaService.test.ts`, and `src/server/reviewServing/reviewServingHookInventory.test.ts`.
- Invalidation registry coverage: `src/server/reviewServing/reviewServingInvalidationRegistry.ts` and `src/server/reviewServing/reviewServingInvalidationRegistry.test.ts` prove every emitted delta kind has first affected component, downstream dependents, affected keys, and update mode.
- Overlay scope: `src/server/reviewServing/reviewWriteOverlayService.test.ts` proves row/detail eligibility, TTL/reconcile status, and that counts, facets, queues, search, bulk, PDF, and export are not silently overlay-aware.

Verification run:

- [x] `/Users/fredrik/.bun/bin/bun test src/server/reviewServing` - passed, 467 tests.
- [x] `/Users/fredrik/.bun/bin/bun test src/server/services/articleImportStoreService.test.ts` - passed, 14 tests.
- [x] `/Users/fredrik/.bun/bin/bun test src/server/cron/judgmentsJobs/judgmentsJobsMarkDirtyWork.test.ts` - passed, 3 tests.
- [x] `/Users/fredrik/.bun/bin/bun test src/server/routes/HumanAssessmentRoutes/humanAssessmentRoutesPostSubmit.test.ts` - passed, 3 tests.
- [x] `/Users/fredrik/.bun/bin/bun test src/server/reviewServing/llmJudgmentReviewServingDeltaService.test.ts` - passed, 1 test.
- [x] `git diff --check` - passed.
- [x] `/Users/fredrik/.bun/bin/bun x eslint src/server/services/articleImportStoreService.ts src/server/reviewServing/llmJudgmentReviewServingDeltaService.test.ts` - passed.
- [ ] `/Users/fredrik/.bun/bin/bun run lint` - failed on unrelated pre-existing lint errors in `src/server/reviewServing/reviewServingAdjacentRouteSurfaces.ts`, `src/server/reviewServing/reviewServingBenchmark.test.ts`, `src/server/reviewServing/reviewServingBenchmark.ts`, `src/server/routes/ArticlesRoutes.test.ts`, `src/server/routes/HumanAssessmentRoutes/humanAssessmentRoutesPostInit.test.ts`, `src/server/routes/HumanAssessmentRoutes/humanAssessmentRoutesPostInit.ts`, and `src/server/routes/routeSurfaceInventory.ts`; not fixed because they are outside Phase 2 audit changes.

## Quality Gates

- [x] `bun test src/server/reviewServing`
- [x] Targeted tests for import delta ledger writes with the common delta envelope, deterministic idempotency keys, tombstones, and no affected-project fanout
- [x] Targeted tests proving source high-water allocation is monotonic per `source_partition`, happens in the source-write transaction, and duplicate idempotency keys do not create a second effective mutation
- [x] Targeted tests proving idempotency keys are derived from stable source mutation identity and do not include random IDs, process-time timestamps, attempt IDs, or allocated high-water marks
- [x] Targeted tests for import hot-field extraction into `app.review_import_article_hot_field`, proving projectors do not need raw JSON for selected-import ranking, display, filters, postings, or contribution keys
- [x] Targeted tests for review change delta writes from article display/search/judgment-input changes, LLM judgments, human judgments, prompt/config changes, and project-scope changes
- [x] Static hook-inventory tests prove the listed central write hook points either call the review-serving ledger/outbox helper or are explicitly documented as out of Phase 2 scope
- [x] Targeted tests proving one source mutation that affects multiple identities emits every required delta in the same transaction, for example title changes that affect display, search, and judgment-input content
- [x] Targeted tests proving source writes and delta/outbox writes are atomic or reconciled before watermarks advance
- [x] Targeted tests proving outbox reconciliation converts, retries, or quarantines missing/malformed deltas and prevents dependent watermark advancement while unreconciled source high-water marks exist
- [x] Targeted tests proving LLM judgment deltas preserve persisted model ID and content flags without retrying, downgrading, or reinterpreting benchmark-critical settings
- [x] Targeted tests proving model execution identity, prompt order, and human review mode changes advance the correct prompt/review config identities without rebuilding unrelated article/import/title/search state
- [x] Targeted tests proving summary-mode human updates do not require `promptId` and still dirty human status, posting, and summary components
- [x] Targeted tests proving judgment-input changes dirty payload-backed detail/preview rows and dependent LLM/count/queue state where the changed content participates in judging
- [x] Targeted tests proving projection identity changes invalidate only dependent components, and review config changes do not rebuild config-independent article/import/title/payload/search state
- [x] Targeted tests proving display, search, judgment-input-content, project-scope, prompt config, and review config identities advance independently
- [x] Targeted tests proving one prompt config change does not rebuild unchanged prompt outputs, summaries, queues, or facets
- [x] Targeted tests proving every emitted delta kind has an invalidation registry entry with first affected component, downstream dependents, affected keys, and update mode
- [x] Targeted tests for delta semantics, tombstones, and replay after deletes/removals
- [x] Targeted tests for read-your-write overlay or optimistic reconciliation behavior, including TTL/reconcile status and route-scoped overlay eligibility
- [x] Targeted tests proving counts, facets, queues, and bulk jobs do not silently include overlay state unless declared by the route contract
- [ ] `bun run lint` - failed on unrelated pre-existing lint errors; changed-file ESLint passed.
