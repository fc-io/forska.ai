# DuckDB CQRS Plan Phase 3 - Projectors, Selected Import, And Serving Projections

Master coordinator: [DUCK_OOM_FIX_PLAN.md](./DUCK_OOM_FIX_PLAN.md)

## Objective

Build the bounded projector pipeline that consumes Phase 2 deltas and produces completed logical snapshots from component-scoped projection state.

## Cut Line

Build projectors and serving writers behind internal wiring only. Product review routes still do not switch to the new serving reader in Phase 3.

The serving projector service becomes the single normal write boundary for V4 `mart.review_*_v4` rows and V4 active-snapshot promotion. Legacy V3 writers may continue only for not-yet-migrated normal routes until Phase 4 removes those route paths.

## Current Baseline

- Phase 2 is treated as complete input for this phase: delta ledgers, source high-water allocation, outbox reconciliation, import hot fields, read-your-write overlays, the invalidation registry, and read contract definitions are available.
- The V4 schema foundation already exists in `src/db/duckdbMigrations/0097_reviewServingV4Foundation.sql`, including delta tables, dirty-work tables, projector watermarks, projection manifests, chunk manifests, selected-import snapshots, V4 serving tables, snapshot pins, jobs, overlays, and retention marks.
- Phase 3 should implement services and projectors on that schema. Add schema only for a proven route payload or projector invariant that cannot be represented by the existing foundation.
- Phase 3 artifacts are not yet implemented: dirty-work conversion/coalescing, component acknowledgements, manifest repositories, snapshot pins, chunk repositories, contribution diffs, selected-import projector, V4 serving writers, projector worker, diagnostics, and retention cleanup remain to do.
- Phase 3 ends when internal V4 snapshots can be built, patched, promoted, failed, replayed, pinned, and cleaned up safely. Product route migration and removal of legacy read paths remain Phase 4 work.

## Implementation Review - 2026-06-18

Verdict: Phase 3 is not fully implemented. A large portion of the foundation exists, but several Phase 3 completion requirements remain open or only test/injection wired.

| Status | Finding | Evidence | Required Follow-Up |
|---|---|---|---|
| Partial | Required service and repository files mostly exist. | `src/server/reviewServing` contains dirty work, contribution, chunk manifest, manifest, snapshot pin, selected-import, writer, projector service, retention, component projector modules, and `src/server/workers/reviewServingProjectorWorker.ts`. | Keep existing tests green, but do not treat file presence as Phase 3 completion. |
| Open | The base selected-import snapshot projector is not wired into the default projector worker. | `reviewServingSelectedImportProjector.ts` exposes `projectReviewServingSelectedImportBatch`, but production references are limited to tests/coverage inventory; the worker imports and runs `reviewServingSelectedImportPatchProjector.ts` only. | Wire bounded base selected-import snapshot creation/resume/completion into the projector flow, or explicitly re-scope it before Phase 4 route cutover. |
| Open | The serving projector worker exists but is not started by production runtime wiring. | Searches for `runReviewServingProjectorWorker` only find the worker module and its tests. | Add runtime scheduling/ownership wiring, or document the intended operator entry point and gate Phase 4 on it. |
| Open | Rebuild chunks, compaction, and cleanup are only partially default-wired. | The worker default `rebuildChunkService.getNextChunk` returns `null`, `runClaimedChunk` is a no-op success, and `getCleanupTargets` returns `[]`; repositories/services exist but discovery/execution is injection-only. | Add real chunk discovery/execution, patch-budget compaction scheduling, and retention target discovery for normal projector operation. |
| Open | Diagnostics and some route-required projection coverage are incomplete as projector outputs. | Read contracts and tests mention warning/health, prompt badges, detail/list payloads, options, and queue states, but there is no standalone diagnostics projector and badge contribution handling is only vocabulary/test coverage, not a normal projector path. | Close or explicitly re-scope diagnostics, badge, queue contribution, and route-required payload projection coverage before claiming Phase 3 complete. |
| Open | The Phase 3 Effect rule is not broadly implemented. | Most projector, writer, worker, manifest, lease, and cleanup code uses plain async functions; `effect` usage appears mainly in hot-field/benchmark code. | Either migrate non-trivial server/projector flows to `Effect` or update the plan if the rule is intentionally relaxed. |
| Complete For Cut Line | Product review routes remain off V4 serving readers. | Route inventory/tests keep incomplete routes unmounted and assert product route handlers do not read V4 serving tables. | This matches the Phase 3 cut line; route migration remains Phase 4 work. |

### Cross-Phase Disposition

| Gap Type | Phase 4 Coverage | Phase 5 Coverage | Disposition |
|---|---|---|---|
| Projector internals, selected-import base projection, worker scheduling, chunk execution, compaction, and cleanup | Phase 4 assumes these are ready enough to feed serving readers; it does not replace them. | Phase 5 fails final cutover if these are incomplete. | Close in Phase 3 or as an explicit Phase 3 prerequisite before any Phase 4 route mount. |
| Serving reader, route migration, durable bulk/search/PDF/export jobs, and parity validation | Phase 4 owns these. | Phase 5 verifies deletion and release gates after Phase 4. | Implement in Phase 4 after Phase 3 projector gaps are closed or explicitly scoped unavailable. |
| Route response completeness for count, option, detail, warning, preview, badges, and article-set hydration | Phase 4 owns route-reader parity, but missing projector output is a Phase 3 blocker for any mounted route that needs it. | Phase 5 verifies no partial route coverage is claimed as complete. | Split by layer: projection output belongs to Phase 3; reader/route parity belongs to Phase 4. |
| Final raw fallback deletion, desktop/interruption hardening, and 10M benchmark release gate | Phase 4 prepares migrated routes/jobs. | Phase 5 owns final hardening and release gate. | Do not defer Phase 3 projector gaps to Phase 5; Phase 5 should only verify them. |

## Remaining Implementation Order

| Status | Slice | Build | Exit Gate |
|---|---|---|---|
| [ ] | Projector foundation | Repositories/services for dirty work, component acknowledgements, leases, source-watermark checks, projection manifests, active/failed snapshot manifests, snapshot pins, and retention marks. | Tests prove bounded leases, no watermark advancement past unreconciled source marks, idempotent ack/write behavior, active/last-known-good preservation, and pin-aware cleanup. |
| [ ] | Delta-to-dirty intake | Convert `app.import_run_article_delta` and `app.review_change_delta` rows into coalesced component dirty work using the invalidation registry. Resolve import-route affected projects in bounded projector work, not in write transactions. | Tests prove repeated changes collapse, malformed/missing required keys quarantine or fail the work without advancing watermarks, import fanout is bounded, and optional component lag does not force required components to reprocess. |
| [ ] | Selected-import projector | Project snapshot-scoped selected import from project scope plus `app.review_import_article_hot_field`, with tombstone handling and checkpoint/resume state. | Tests prove selected-import rows and patches are built by bounded batches, promoted atomically, and internal V4 selected-import logic never depends on the runtime `selected_scoped_article_import` CTE. |
| [ ] | Component projectors and single writer | Build V4 component projectors for display, payload, judgment input status, LLM/human status, queues, postings, posting stats, summaries, badges, counts/facets/options, judgment details, list judgment payloads, prompt preview inputs, search/token-prefix state, and warning diagnostics. | Tests prove the single writer owns all `mart.review_*_v4` writes, routine changes are component-narrow, contribution diffs update summaries without full aggregation, and route-required components share one logical snapshot. |
| [ ] | Snapshot promotion and failure recovery | Compose component identities into candidate manifests, validate required/optional component states, promote active snapshots atomically, preserve last-known-good snapshots, and expose failed/indexing/unavailable diagnostics. | Tests prove active promotion is atomic, failed candidates do not affect normal readers, optional search/count state does not block unrelated activation, and snapshot cursors/pins cannot mix component states. |
| [ ] | Worker, chunks, compaction, and cleanup | Add `reviewServingProjectorWorker`, deterministic rebuild/compaction chunk manifests, patch budget checks, major-base compaction, wake budgets, retry/backoff, sleep/restart resume, and retention cleanup. | Tests prove bounded wake duration, chunk resume/skip from maintained digests, patch compaction thresholds, crash/retry/replay safety, and cleanup skips active, last-known-good, and pinned state. |

## Workstreams

| Status | Theme | Implement First | Done When |
|---|---|---|---|
| [ ] | Projector core | Build component-scoped projector dependency graph, delta-to-dirty conversion, coalesced dirty-work service, compacted component acknowledgements, leases, watermarks, idempotent replay, wake budgets, single serving-writer boundary, major base/minor patch snapshot model, contribution diff service, incrementally digested rebuild chunk manifests, failure state, snapshot pins, and retention cleanup primitives. | Projector tests prove crash/retry/replay safety, bounded batch size, dirty-work coalescing, component ack skip behavior, wake release, no watermark advancement past unreconciled source marks, single-writer ownership, contribution diffs, component-narrow patches, patch compaction thresholds, chunk resume/skip behavior without source-row hash scans, pin-aware cleanup, and failed snapshots preserving last-known-good data. |
| [ ] | Selected-import projection | Replace runtime `selected_scoped_article_import` ranking with snapshot-scoped selected-import projection built from project scope plus hot import fields. | Selected import rows are projected by bounded batches, promoted atomically, and internal V4 selected-import serving logic never uses `selected_scoped_article_import`. Phase 4 route gates remove the remaining product-route CTE usage. |
| [ ] | Serving projections | Write compacted base rows, component-narrow patch rows, payload rows, human/both/unassessed status, badges, contribution rows, count/facet rows, filter-option rows, prompt judgment-detail rows, list judgment payload rows, article-set hydration support, filter postings, posting stats, queue rows, warning/health diagnostic state, and search projection or async search state from completed dependency inputs. | Manifest checks prove all route-required components and watermarks match one logical snapshot before promotion. Optional search/count components expose availability states and do not block unrelated route activation. Routine changes update only affected component fields, contributions, postings, option rows, detail rows, list payload rows, diagnostic rows, and chunk digests. |

## Snapshot And Generation Rules

- A serving snapshot is a logical read contract that points to compact physical state.
- `base_generation` is a compacted, sorted physical base for one component and identity.
- `patch_watermark` advances for routine updates without changing the base generation.
- A minor snapshot promotes only after patches, affected counts, overlays, and required watermarks are transactionally consistent.
- A candidate snapshot that exceeds patch read budgets must compact into a new major base before activation.
- Ordinary interactive cursors may be invalidated when the active snapshot changes.
- Durable jobs that need repeatable results pin the snapshot instead of relying on long-lived interactive cursors.
- Cleanup deletes old base generations, patches, payloads, counts, facets, and search state only when no active manifest, last-known-good manifest, or snapshot pin references them.

## Projector Intake Rules

- Projectors consume `app.import_run_article_delta` and `app.review_change_delta` as the source of truth and use Phase 2 reconciliation state to decide source high-water safety.
- No projector watermark may advance past a pending, retryable, malformed, or quarantined outbox/delta at or below the candidate source high-water mark unless there is an explicit terminal operator state.
- Delta-to-dirty conversion uses the invalidation registry for first affected component, downstream dependents, required keys, and update mode.
- Deltas with missing required typed keys, unsupported payload versions, or incompatible change kinds fail or quarantine the dirty-work item before any component output is written.
- Import-route deltas resolve affected projects in bounded projector batches from route/project membership state. They do not rely on affected-project fanout stored by write transactions.
- Dirty work coalesces by project, projection component, projection identity, article or scope key, source partition, and high-water range.
- Component acknowledgements advance independently so optional or slow components do not force already-current required components to rerun.

## Serving Writer Rules

- A single Phase 3 writer service owns normal writes to `mart.review_*_v4`, `app.review_selected_article_import_v4`, `app.review_projection_identity_manifest`, `app.review_serving_projector_watermark`, and V4 active-snapshot promotion.
- Legacy V3 services may continue serving not-yet-migrated routes, but they must not write or promote V4 review-serving state except through the Phase 3 writer boundary.
- Writer transactions update component rows, contribution rows, summary rows, postings, payload rows, watermarks, acknowledgements, and manifest state together for the component being promoted.
- Writer inputs are typed projection records from projectors. They must not parse raw import JSON, run `selected_scoped_article_import`, aggregate raw judgments at request time, or compute project-wide windows.
- Replays use stable snapshot, base generation, patch watermark, projection identity, article, prompt, filter, and contribution keys so repeated writes are idempotent.

## Projector Dependency Rules

- Projector wakes start at the first affected component declared by the invalidation registry.
- LLM judgment updates start at judgment-status/contribution components, then update dependent counts, badges, queues, and postings.
- LLM judgment updates do not run selected-import or display projectors.
- Article display-only updates start at display/payload/posting components.
- Article display-only updates do not run judgment-status or prompt summary projectors.
- Search-token updates start at search projection and search stats only.
- Prompt config changes start at that prompt's config identity and dependent prompt summaries.
- Prompt config changes do not rebuild unchanged prompt outputs.

## Incremental Summary Rules

- Counts, facets, badges, queues, and posting statistics update from contribution diffs.
- Store previous per-article contribution rows for each named count/facet/badge/posting definition that is updated incrementally.
- Apply `-old +new` deltas to summary tables in one transaction with updated contribution rows and projector watermark.
- If contribution state is missing, corrupted, or from an incompatible definition version, enqueue bounded repair instead of falling back to full foreground aggregation.
- Posting cardinality stats update from the same contribution diff path and let readers choose the most selective bounded posting without scanning.

## Route Completeness Rules

- Filter posting rows are article-candidate access paths, not filter-option route responses. Filter-option projections must produce the complete option/min-max payload expected by the current UI and preserve active search/filter scope.
- Filtered list route projections must support the two-step serving path: posting/search candidate selection followed by article-set hydration for the page's rows and list judgment payloads.
- Detail route projections must include prompt-level judgment details, human prompt/summary payloads, explanations, quotes, assessments, placeholder judgments, payload references, badges, and current detail extras before `/api/projectsreview` can migrate.
- List route projections must preserve current row metadata, article timestamps, LLM judgment arrays, human prompt/summary arrays, both-mode LLM and human payloads, and prompt badges before list routes can migrate.
- Warning/health projections or repositories must expose snapshot state together with maintenance lease state, queued/in-flight refresh counts, large-rebuild progress, and quarantine diagnostics before `/api/projectsreviewswarnings` can migrate.
- Standalone count route projections must cover the same search/filter scope as the current count panel or return explicit unavailable/async state.
- Prompt-preview payload projection preserves current first-article ordering by `article_created_at ASC NULLS LAST, article_id ASC` and includes the prompt/config identity needed for prompt text, model execution context, content flags, and prompt order, or the route remains unmounted.
- Count/facet/option projections persist list mode, summary identity, facet kind, filter/search scope, and option value keys so list modes, human/review facets, and old summary versions cannot mix.

## Chunked Rebuild Rules

- Long rebuilds and compactions split into deterministic chunks.
- Chunk manifests are keyed by project, component, projection identity, input watermark/digest, chunk key range, output `base_generation`, status, and error.
- Workers claim chunks independently, write output, validate chunk-level counts/checksums, and mark chunks complete transactionally.
- On crash, sleep, or restart, workers skip completed chunks whose input watermark/hash still matches.
- Input digests come from upstream dirty tokens, contribution digests, posting stats, and per-chunk high-water rows maintained during normal projection.
- A rebuild worker must not scan source rows only to decide whether a completed chunk can be skipped.

## JavaScript And TypeScript Rule

Use the `effect` library for non-trivial JavaScript/TypeScript async and server flow in Phase 3 projectors, writers, workers, manifests, leases, and cleanup. Prefer `Effect.gen` for sequencing, `Layer`/`Context` for service wiring, `Effect.acquireRelease`/`Scope` for resource lifetime, and `Schedule` for retries, polling, and backoff. Keep pure transforms and very small handlers as plain functions.

## Required Artifacts

- `src/server/reviewServing/reviewServingDirtyWorkService.ts`
- `src/server/reviewServing/reviewServingContributionService.ts`
- `src/server/reviewServing/reviewServingChunkManifestRepository.ts`
- `src/server/reviewServing/reviewServingManifestRepository.ts`
- `src/server/reviewServing/reviewServingSnapshotPinRepository.ts`
- `src/server/reviewServing/reviewServingProjectorWriter.ts`
- `src/server/reviewServing/reviewServingProjectorService.ts`
- `src/server/workers/reviewServingProjectorWorker.ts`
- `src/server/reviewServing/reviewServingSelectedImportProjector.ts`
- Component projector modules for display, payload, LLM/human status, queue, posting, summary/count/facet/option, detail/list judgment payload, search, and diagnostics
- `src/server/reviewServing/reviewServingRetentionService.ts`

## Quality Gates

- [ ] `bun test src/server/reviewServing`
- [ ] `bun test src/server/services/projectMartDirtyMaterializationService.test.ts`
- [ ] `bun test src/server/workers/projectMartRefreshWorker.test.ts`
- [ ] `bun test src/server/services/projectMartLargeRebuildExecutor.test.ts`
- [ ] Targeted tests proving projector consumers do not advance watermarks past pending, retryable, malformed, or quarantined source high-water marks
- [ ] Targeted tests for coalesced dirty-work creation, repeated-change collapse, component acknowledgements, retention, and compaction after consumer watermarks advance
- [ ] Targeted tests proving dirty-work acknowledgements compact into component high-water rows or compressed ranges
- [ ] Targeted tests for route/project delta projector fanout and cursor behavior
- [ ] Targeted tests for projector dependency order, watermarks, and idempotent replay
- [ ] Targeted tests proving only the review serving projector boundary writes V4 `mart.review_*_v4` rows and promotes V4 active snapshots
- [ ] Targeted tests for major base generation, append-first large imports, bounded patch promotion, patch merge-cost budgets, patch compaction thresholds, and pin-aware cleanup
- [ ] Targeted tests proving judgment-only, display-only, search-only, and selected-import-only changes write component-narrow patches instead of row-wide patches
- [ ] Targeted tests for chunk manifests proving rebuilds and compactions skip unchanged completed chunks, resume failed chunks, and use incrementally maintained input digests instead of source-row scans
- [ ] Targeted tests for selected import projector snapshot/checkpoint behavior
- [ ] Targeted tests proving internal V4 selected-import projection does not use `selected_scoped_article_import`
- [ ] Targeted tests for atomic review serving snapshot manifest promotion and failed-snapshot recovery
- [ ] Targeted tests for required versus optional manifest components and route-specific availability states
- [ ] Targeted tests for count/facet serving projections
- [ ] Targeted tests for count/facet serving projections proving list-mode, summary identity, date-range, search-scope, and human summary-answer behavior
- [ ] Targeted tests for filter-option projections proving complete option/min-max payloads, option value keys, and active search/filter scope
- [ ] Targeted tests for article-set row hydration after posting/search selection, including stable list-mode and article-ID tie-break ordering
- [ ] Targeted tests for judgment-detail and list judgment payload projections proving LLM/human payload kind separation, prompt-overlap row counts, explanations, quotes, assessments, placeholders, and payload references are present
- [ ] Targeted tests for warning/health diagnostics proving maintenance, rebuild, dirty-work, and quarantine states are represented
- [ ] Targeted tests for old/new contribution diffs for counts, facets, badges, queues, posting stats, deletes, answer changes, and membership removals
- [ ] Targeted tests for unsupported count/facet combinations returning nullable or unavailable states
- [ ] `bun run lint`
