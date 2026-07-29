# Review-Serving Selected-Import Full Ownership Plan

## Purpose

Track selected-import ownership hardening after the PR #336 compatibility-view
slice.

The current durable state writes selected-import rows through deterministic
staging plus bounded publication into
`mart.review_selected_article_import_current_v4`. The old
`app.review_selected_article_import_v4` surface is a read-only compatibility
view for diagnostics and older tooling, not a runtime coordination table.
This plan tracks the evidence and cleanup needed before that temporary
compatibility surface can be retired.

## Decision

Keep the current/staging mart boundary as the selected-import ownership model.
Keep the compatibility-view absence guard separate from the current/staging
guard inventory. Do not retire the compatibility view or remaining legacy
schema compatibility until selected-import has route parity proof, duplicate
proof, and current-DB progress evidence.

## Remaining Improvements

### 0. Establish a published mart ownership boundary

Status: implemented in the follow-up after PR #320.

Selected-import rebuild and dirty writes now publish first to
`mart.review_selected_article_import_current_v4`. The legacy
`app.review_selected_article_import_v4` compatibility surface is now a read-only
view over the published mart, so it no longer has independent physical rows or
runtime write/delete paths.

Completed evidence:

- Migration backfills the published mart deterministically when legacy rows
  contain duplicate logical keys (`0217_selectedImportPublishedMart.sql`).
- Range, batch, and dirty writes assert duplicate published keys before
  publication.
- Compatibility reads follow the published mart through a view instead of a
  refreshed physical mirror (`0219_selectedImportCompatibilityView.sql`).
- Startup probes check and repair the published mart only; compatibility follows
  it through the view.
- Current-DB selected-import rebuild progress completes with mart/view parity.

### 1. Move selected-import writes to append/staging plus compaction

Status: implemented in follow-up slices.

Implemented follow-up slices:

- `mart.review_selected_article_import_staging_v4` now exists as the replay
  staging surface with deterministic row identity, source watermark/partition,
  publish scope, and publish timestamp columns.
- Article-range rebuild publication now stages deterministic winner rows before
  publishing bounded current rows into
  `mart.review_selected_article_import_current_v4`, then marks staging rows as
  published.
- Cursor/batch selected-import projection now writes deterministic staging
  records and publishes/updates the current mart from staging.
- Dirty selected-import projection now writes deterministic dirty staging rows,
  publishes/updates only the dirty article IDs into the current mart, marks
  staging rows as published.
- Compatibility view conversion removed the remaining physical
  `app.review_selected_article_import_v4` runtime write/delete paths.
- Remaining startup, retention, and rebuild-reset maintenance mutations against
  `mart.review_selected_article_import_current_v4` are centralized behind the
  selected-import maintenance helper instead of flowing through generic writer
  escape hatches.

The selected-import staging model appends deterministic candidate/range rows and
uses bounded publication to select the current winner per
project/article/snapshot generation.

Completed acceptance criteria:

- Range rebuilds no longer delete from `app.review_selected_article_import_v4`
  as the main replacement mechanism.
- Candidate source rows are idempotent by chunk/range identity.
- Duplicate current winners are detected before publication, not masked by a
  conflict clause.
- Compaction is bounded by project, generation, snapshot/component identity, and
  article range.
- Failed compaction leaves the previous active snapshot readable.

Implemented touchpoints:

- `src/server/reviewServing/reviewServingSelectedImportProjector.ts`
- `src/server/reviewServing/reviewServingProjectorWriter.ts`
- `src/server/workers/reviewServingProjectorWorker.ts`
- DuckDB migrations for selected-import staging/compaction marts

### 2. Make the mart component the only selected-import serving contract

Status: implemented for runtime serving/projector readers.

Route readers and downstream projectors consume the published selected-import
mart/component state, not the compatibility
`app.review_selected_article_import_v4` view as a de facto source of truth.

Completed acceptance criteria:

- Display, posting, filter/count, queue, and payload rebuilds resolve selected
  import through a manifest/component generation boundary.
- Consumers do not need fallback reads from legacy selected-import rows.
- Route parity proves selected-import-backed pages, filters, counts, and queues
  match current behavior.
- Benchmarks prove the new reads stay bounded without reintroducing broad ART
  index dependence on mutable hot tables.

Implemented touchpoints:

- selected-import consumers under `src/server/reviewServing/`
- route parity evidence and benchmark fixtures
- snapshot composition/promotion in `reviewServingProjectorWriter.ts`
- retention and diagnostics that report selected-import component health

### 3. Retire the legacy mutable table and compatibility surface

Status: implemented as a compatibility-view slice; keep the view only as a
temporary compatibility surface for diagnostics and older tooling.

After staging, compaction, and mart-owned consumers were proven, the old
selected-import mutable serving table was removed as a long-term write/read
dependency. The remaining future work is only retiring the compatibility view
and historical schema remnants once older tooling no longer needs the view name.

Completed and remaining acceptance criteria:

- `app.review_selected_article_import_v4` is no longer written by runtime
  projectors and is represented as a view over
  `mart.review_selected_article_import_current_v4`.
- Former unique/index backstops are replaced by publication validation that
  proves there is only one current selected row per logical key.
- Retention cleans obsolete selected-import staging/legacy rows only after no
  active, last-known-good, pinned, pending, running, retryable, or diagnostic
  work needs them.
- Current-DB evidence shows no duplicate selected-import logical keys and no
  unpublished staging backlog.
- Rollback is git/schema-version based; no permanent competing old/new runtime
  paths remain.

Remaining touchpoints:

- DuckDB migrations retiring the legacy selected-import compatibility surface
  and any obsolete table/index remnants
- `src/server/reviewServing/reviewServingRetentionService.ts`
- selected-import diagnostics and physical evidence scripts
- `TESTS.md` if new focused gates are introduced

## Current Evidence Map

- Static guard inventory:
  `src/server/reviewServing/reviewServingPhase3Integration.test.ts`.
- Compatibility-view absence guard:
  `src/server/reviewServing/reviewServingPhase3Integration.test.ts`.
- Runtime write guards:
  `src/server/reviewServing/reviewServingProjectorWriter.test.ts`.
- Published/current and compatibility-view schema:
  `src/server/reviewServing/reviewServingSchema.test.ts`.
- Range and batch staged publication:
  `src/server/reviewServing/reviewServingSelectedImportProjector.test.ts`.
- Dirty staged publication:
  `src/server/reviewServing/reviewServingSelectedImportDirtyProjector.test.ts`.
- Current/staging physical evidence:
  `scripts/inspectReviewServingPhysicalEvidence.ts` and
  `scripts/operatorScriptDuckdbAccess.test.ts`.

## Required Evidence

- Focused selected-import projector and writer tests.
- Full `src/server/workers/reviewServingProjectorWorker.test.ts`.
- Route parity coverage/evidence/runner tests for selected-import-backed routes.
- `bun run bench:review-serving-release-gate`.
- `bun run test:dev-server:current-db`.
- `bun run test:network-smoke:current-db` or an equivalent current-DB progress
  gate with API and DuckDB-owner readiness, before/after progress counters, and
  no DuckDB/index/WAL/checkpoint/OOM fatal logs.
- Current-DB duplicate-key assertion for the current/staging selected-import
  contract, plus the separate compatibility-view absence guard before legacy
  compatibility removal.

## Non-Goals

- Do not drop selected-import unique/index protection as a standalone fix.
- Do not keep permanent dual selected-import ownership paths.
- Do not use DuckDB startup repair as the architecture for selected-import
  correctness.
- Do not broaden this into unrelated review-serving table/index cleanup.
