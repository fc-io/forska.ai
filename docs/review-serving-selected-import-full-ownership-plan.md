# Review-Serving Selected-Import Full Ownership Plan

## Purpose

Track the remaining selected-import work after the PR #319 main-branch fixes.

The current durable slice removes the hot `ON CONFLICT DO NOTHING` write mode,
keeps duplicate assertions and uniqueness as a backstop, fixes snapshot-target
semantics, and normalizes requestless rebuild chunk targets. This plan is for
the larger point where the new marts approach fully owns selected-import data
and the old mutable table is no longer a coordination surface.

## Decision

Keep the current anti-join insert plus unique backstop as the interim model.
Do not drop selected-import indexes or unique guards until selected-import has a
published mart-owned read model, route parity proof, duplicate proof, and
current-DB progress evidence.

## Remaining Improvements

### 1. Move selected-import writes to append/staging plus compaction

Build a selected-import staging model where rebuild chunks append deterministic
candidate/range rows and a bounded compaction step selects the current winner per
project/article/snapshot generation.

Acceptance criteria:

- Range rebuilds no longer delete from `app.review_selected_article_import_v4`
  as the main replacement mechanism.
- Candidate source rows are idempotent by chunk/range identity.
- Duplicate current winners are detected before publication, not masked by a
  conflict clause.
- Compaction is bounded by project, generation, snapshot/component identity, and
  article range.
- Failed compaction leaves the previous active snapshot readable.

Likely touchpoints:

- `src/server/reviewServing/reviewServingSelectedImportProjector.ts`
- `src/server/reviewServing/reviewServingProjectorWriter.ts`
- `src/server/workers/reviewServingProjectorWorker.ts`
- new or adjusted DuckDB migrations for selected-import staging/compaction marts

### 2. Make the mart component the only selected-import serving contract

Route readers and downstream projectors should consume the published
selected-import mart/component state, not the mutable `app.review_selected_article_import_v4`
table as a de facto source of truth.

Acceptance criteria:

- Display, posting, filter/count, queue, and payload rebuilds resolve selected
  import through a manifest/component generation boundary.
- Consumers do not need fallback reads from legacy selected-import rows.
- Route parity proves selected-import-backed pages, filters, counts, and queues
  match current behavior.
- Benchmarks prove the new reads stay bounded without reintroducing broad ART
  index dependence on mutable hot tables.

Likely touchpoints:

- selected-import consumers under `src/server/reviewServing/`
- route parity evidence and benchmark fixtures
- snapshot composition/promotion in `reviewServingProjectorWriter.ts`
- retention and diagnostics that report selected-import component health

### 3. Retire the legacy mutable table and its compatibility guards

After staging, compaction, and mart-owned consumers are proven, remove the old
selected-import mutable serving table as a long-term write/read dependency.

Acceptance criteria:

- `app.review_selected_article_import_v4` is no longer written by runtime
  projectors.
- Its unique/index backstop can be dropped because publication validation proves
  there is only one current selected row per logical key.
- Retention cleans obsolete selected-import staging/legacy rows only after no
  active, last-known-good, pinned, pending, running, retryable, or diagnostic
  work needs them.
- Current-DB evidence shows no duplicate selected-import logical keys before and
  after migration.
- Rollback is git/schema-version based; no permanent competing old/new runtime
  paths remain.

Likely touchpoints:

- DuckDB migrations retiring legacy selected-import table/indexes
- `src/server/reviewServing/reviewServingRetentionService.ts`
- selected-import diagnostics and physical evidence scripts
- `TESTS.md` if new focused gates are introduced

## Required Evidence

- Focused selected-import projector and writer tests.
- Full `src/server/workers/reviewServingProjectorWorker.test.ts`.
- Route parity coverage/evidence/runner tests for selected-import-backed routes.
- `bun run bench:review-serving-release-gate`.
- `bun run test:dev-server:current-db`.
- `bun run test:network-smoke:current-db` or an equivalent current-DB progress
  gate with API and DuckDB-owner readiness, before/after progress counters, and
  no DuckDB/index/WAL/checkpoint/OOM fatal logs.
- Current-DB duplicate-key assertion for the old and new selected-import
  contracts before legacy removal.

## Non-Goals

- Do not drop selected-import unique/index protection as a standalone fix.
- Do not keep permanent dual selected-import ownership paths.
- Do not use DuckDB startup repair as the architecture for selected-import
  correctness.
- Do not broaden this into unrelated review-serving table/index cleanup.
