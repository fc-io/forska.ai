# DuckDB CQRS Plan Phase 3 - Projectors, Selected Import, And Serving Projections

Master coordinator: [DUCK_OOM_FIX_PLAN.md](./DUCK_OOM_FIX_PLAN.md)

## Objective

Build the bounded projector pipeline that consumes Phase 2 deltas and produces completed logical snapshots from component-scoped projection state.

## Cut Line

Build projectors and serving writers behind internal wiring only. Product review routes still do not switch to the new serving reader in Phase 3.

The serving projector service becomes the single normal write boundary for V4 `mart.review_*_v4` rows and V4 active-snapshot promotion. Legacy V3 writers may continue only for not-yet-migrated normal routes until Phase 4 removes those route paths.

## Workstreams

| Status | Theme | Implement First | Done When |
|---|---|---|---|
| [ ] | Projector core | Build component-scoped projector dependency graph, coalesced dirty-work service, compacted component acknowledgements, leases, watermarks, idempotent replay, wake budgets, single serving-writer boundary, major base/minor patch snapshot model, contribution diff service, incrementally digested rebuild chunk manifests, failure state, snapshot pins, and retention cleanup primitives. | Projector tests prove crash/retry/replay safety, bounded batch size, dirty-work coalescing, component ack skip behavior, wake release, watermark atomicity, single-writer ownership, contribution diffs, component-narrow patches, patch compaction thresholds, chunk resume/skip behavior without source-row hash scans, pin-aware cleanup, and failed snapshots preserving last-known-good data. |
| [ ] | Selected-import projection | Replace runtime `selected_scoped_article_import` ranking with snapshot-scoped selected-import projection. | Selected import rows are projected by bounded batches, promoted atomically, and normal foreground SQL never contains `selected_scoped_article_import` after cutover. |
| [ ] | Serving projections | Write compacted base rows, component-narrow patch rows, payload rows, human/both/unassessed status, badges, contribution rows, count/facet rows, filter-option rows, prompt judgment-detail rows, filter postings, posting stats, queue rows, warning/health diagnostic state, and search projection or async search state from completed dependency inputs. | Manifest checks prove all route-required components and watermarks match one logical snapshot before promotion. Optional search/count components expose availability states and do not block unrelated route activation. Routine changes update only affected component fields, contributions, postings, option rows, detail rows, diagnostic rows, and chunk digests. |

## Snapshot And Generation Rules

- A serving snapshot is a logical read contract that points to compact physical state.
- `base_generation` is a compacted, sorted physical base for one component and identity.
- `patch_watermark` advances for routine updates without changing the base generation.
- A minor snapshot promotes only after patches, affected counts, overlays, and required watermarks are transactionally consistent.
- A candidate snapshot that exceeds patch read budgets must compact into a new major base before activation.
- Ordinary interactive cursors may be invalidated when the active snapshot changes.
- Durable jobs that need repeatable results pin the snapshot instead of relying on long-lived interactive cursors.
- Cleanup deletes old base generations, patches, payloads, counts, facets, and search state only when no active manifest, last-known-good manifest, or snapshot pin references them.

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
- Detail route projections must include prompt-level judgment details, explanations, quotes, assessments, placeholder judgments, payload references, and badges before `/api/projectsreview` can migrate.
- Warning/health projections or repositories must expose snapshot state together with maintenance lease state, queued/in-flight refresh counts, large-rebuild progress, and quarantine diagnostics before `/api/projectsreviewswarnings` can migrate.
- Standalone count route projections must cover the same search/filter scope as the current count panel or return explicit unavailable/async state.
- Prompt-preview payload projection preserves current first-article ordering by `article_created_at ASC NULLS LAST, article_id ASC`.

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
- `src/server/reviewServing/reviewServingProjectorService.ts`
- `src/server/workers/reviewServingProjectorWorker.ts`
- Selected-import projector and serving projection writers
- Retention cleanup primitives

## Quality Gates

- [ ] `bun test src/server/reviewServing`
- [ ] `bun test src/server/services/projectMartDirtyMaterializationService.test.ts`
- [ ] `bun test src/server/workers/projectMartRefreshWorker.test.ts`
- [ ] `bun test src/server/services/projectMartLargeRebuildExecutor.test.ts`
- [ ] Targeted tests for coalesced dirty-work creation, repeated-change collapse, component acknowledgements, retention, and compaction after consumer watermarks advance
- [ ] Targeted tests proving dirty-work acknowledgements compact into component high-water rows or compressed ranges
- [ ] Targeted tests for route/project delta projector fanout and cursor behavior
- [ ] Targeted tests for projector dependency order, watermarks, and idempotent replay
- [ ] Targeted tests proving only the review serving projector boundary writes V4 `mart.review_*_v4` rows and promotes V4 active snapshots
- [ ] Targeted tests for major base generation, append-first large imports, bounded patch promotion, patch merge-cost budgets, patch compaction thresholds, and pin-aware cleanup
- [ ] Targeted tests proving judgment-only, display-only, search-only, and selected-import-only changes write component-narrow patches instead of row-wide patches
- [ ] Targeted tests for chunk manifests proving rebuilds and compactions skip unchanged completed chunks, resume failed chunks, and use incrementally maintained input digests instead of source-row scans
- [ ] Targeted tests for selected import projector snapshot/checkpoint behavior
- [ ] Targeted tests for atomic review serving snapshot manifest promotion and failed-snapshot recovery
- [ ] Targeted tests for required versus optional manifest components and route-specific availability states
- [ ] Targeted tests for count/facet serving projections
- [ ] Targeted tests for filter-option projections proving complete option/min-max payloads and active search/filter scope
- [ ] Targeted tests for judgment-detail serving projections proving explanations, quotes, assessments, placeholders, and payload references are present
- [ ] Targeted tests for warning/health diagnostics proving maintenance, rebuild, dirty-work, and quarantine states are represented
- [ ] Targeted tests for old/new contribution diffs for counts, facets, badges, queues, posting stats, deletes, answer changes, and membership removals
- [ ] Targeted tests for unsupported count/facet combinations returning nullable or unavailable states
- [ ] `bun run lint`
