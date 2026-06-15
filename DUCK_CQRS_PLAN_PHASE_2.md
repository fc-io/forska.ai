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
| [ ] | Write-side deltas | Add `reviewServingDeltaLedger` append APIs and update import, article content/display, LLM judgment, human judgment, prompt/config, and project-scope writers to append compact deltas transactionally with change kinds from the invalidation registry. Pre-extract hot import fields into `app.review_import_article_hot_field`. Add durable outbox/reconciliation only for source writes that cannot append the delta in the same transaction. | Tests prove source writes and deltas/outbox rows commit atomically or reconcile before watermark advancement, common envelope fields are present, idempotency keys prevent duplicate deltas, deletes/removals create tombstones, config changes produce only the narrow identities they affect, import writes do not persist affected-project fanout unless proven bounded, and no write path synchronously fans out selected-import state to every project. |
| [ ] | Read-your-write state | Add optimistic/overlay state for reviewer actions that need immediate feedback before projection catches up. | Reviewer changes have a clear immediate response path, route-specific overlay semantics are documented, and reconciliation tests prove overlays disappear once included in a completed serving snapshot. |

## Delta Envelope

Every row in `app.import_run_article_delta` and `app.review_change_delta` has common fields independent of `change_kind`: `delta_id`, `change_kind`, `source_table`, `source_row_id`, `source_operation`, `source_partition`, `source_high_water_mark`, `source_updated_at`, `idempotency_key`, `payload_version`, compact typed key columns, optional `payload_json`, `created_at`, and `reconciled_at`.

The invalidation registry `requiredKeys` are change-specific payload keys. The envelope fields are required for every delta and are tested separately.

`source_high_water_mark` is monotonic within `source_partition`. Projectors and dirty-work conversion cannot advance a consumer watermark past an unreconciled source high-water mark.

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
- Write-path integrations for import/source records, article display/search/judgment-input changes, LLM judgments, human judgments, prompt/config changes, and project-scope changes
- Overlay repository/service for reviewer actions
- Targeted tests for atomic writes, idempotency, tombstones, source ownership, hot fields, reconciliation, and overlay scope

## Quality Gates

- [ ] `bun test src/server/reviewServing`
- [ ] Targeted tests for import delta ledger writes with the common delta envelope, deterministic idempotency keys, tombstones, and no affected-project fanout
- [ ] Targeted tests for import hot-field extraction into `app.review_import_article_hot_field`, proving projectors do not need raw JSON for selected-import ranking, display, filters, postings, or contribution keys
- [ ] Targeted tests for review change delta writes from article display/search/judgment-input changes, LLM judgments, human judgments, prompt/config changes, and project-scope changes
- [ ] Targeted tests proving one source mutation that affects multiple identities emits every required delta in the same transaction, for example title changes that affect display, search, and judgment-input content
- [ ] Targeted tests proving source writes and delta/outbox writes are atomic or reconciled before watermarks advance
- [ ] Targeted tests proving outbox reconciliation converts, retries, or quarantines missing/malformed deltas and prevents dependent watermark advancement while unreconciled source high-water marks exist
- [ ] Targeted tests proving LLM judgment deltas preserve persisted model ID and content flags without retrying, downgrading, or reinterpreting benchmark-critical settings
- [ ] Targeted tests proving model execution identity, prompt order, and human review mode changes advance the correct prompt/review config identities without rebuilding unrelated article/import/title/search state
- [ ] Targeted tests proving summary-mode human updates do not require `promptId` and still dirty human status, posting, and summary components
- [ ] Targeted tests proving judgment-input changes dirty payload-backed detail/preview rows and dependent LLM/count/queue state where the changed content participates in judging
- [ ] Targeted tests proving projection identity changes invalidate only dependent components, and review config changes do not rebuild config-independent article/import/title/payload/search state
- [ ] Targeted tests proving display, search, judgment-input-content, project-scope, prompt config, and review config identities advance independently
- [ ] Targeted tests proving one prompt config change does not rebuild unchanged prompt outputs, summaries, queues, or facets
- [ ] Targeted tests proving every emitted delta kind has an invalidation registry entry with first affected component, downstream dependents, affected keys, and update mode
- [ ] Targeted tests for delta semantics, tombstones, and replay after deletes/removals
- [ ] Targeted tests for read-your-write overlay or optimistic reconciliation behavior, including TTL/reconcile status and route-scoped overlay eligibility
- [ ] Targeted tests proving counts, facets, queues, and bulk jobs do not silently include overlay state unless declared by the route contract
- [ ] `bun run lint`
