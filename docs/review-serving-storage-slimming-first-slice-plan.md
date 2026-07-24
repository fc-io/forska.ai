# Review-Serving Storage Slimming First Slice Plan

## Decision

The safest first implementation slice is bounded retention cleanup for terminal
review-serving rebuild artifacts, not broad table deletion or schema slimming.

After the evidence unblocker and the current-DB DuckDB fatal-restart fix are
green, extend the existing retention path so it can delete only rows that are no
longer needed by active, pinned, last-known-good, pending, running, retryable, or
diagnostic rebuild work. Start with the largest proven storage pressure from the
physical evidence:

- `mart.review_article_summary_contribution_rebuild_partial_v4`
- `mart.review_article_summary_rebuild_partial_v4`
- `app.review_rebuild_chunk_manifest`

This slice has low rollback risk because it can be feature-gated or disabled,
can run in small batches, and does not change route read contracts, DuckDB
schema, or source-of-truth data.

## Non-Goals

- Do not drop tables, columns, indexes, migrations, or historical schema files.
- Do not delete `app.review_rebuild_request` rows in this first slice.
- Do not slim active serving marts such as `mart.review_article_serving_v4`,
  judgment detail, title search, filter postings, counts, facets, or options.
- Do not rewrite projector ownership, route readers, route parity fixtures, or
  benchmark-critical model/provider settings.
- Do not change browser, desktop, or shared app UI behavior.
- Do not repair or remove current-DB/WAL/recovery artifacts as part of storage
  slimming.

## Deletion Guardrails

- Delete only from explicit allowlisted tables named in this plan.
- Require project scoping and a bounded batch size for every delete.
- Protect any row linked to an active or last-known-good snapshot.
- Protect any row linked to an active snapshot pin.
- Protect any row linked to pending, running, retryable, blocked, quarantined,
  failed-with-diagnostics, or newest request work.
- Protect the newest terminal request per project/config/component/snapshot until
  a newer successful snapshot is active and route parity evidence is preserved.
- Advance cleanup cursors in `app.review_serving_retention_mark`; no unbounded
  table scans in the worker loop.
- Preserve before/after row-count evidence from a read-only snapshot before any
  current-DB cleanup run.
- Treat zero eligible rows as a valid safe outcome, not a reason to broaden the
  predicate.

## Required Evidence Before Touching Storage

1. Current-DB fix proof from
   `docs/review-serving-current-db-duckdb-fatal-restart-evidence.md` remains
   true: `bun run test:dev-server:current-db` passes without forbidden DuckDB
   fatal runtime restart output.
2. `bun run test:network-smoke:current-db` passes and shows live
   review-serving progress.
3. Route parity and benchmark contract remain green:
   `bun test src/server/reviewServing/reviewServingRouteParityCoverage.test.ts src/server/reviewServing/reviewServingRouteParityEvidence.test.ts src/server/reviewServing/reviewServingRouteParityRunner.test.ts`
   and `bun run bench:review-serving-release-gate`.
4. Fresh physical evidence is captured with
   `bun run db:duck:inspect-review-serving-physical-evidence -- --format=markdown --output=.tmp/evidence/review-serving-current-db-physical-before-slimming.md`.
5. A project-state snapshot is captured with
   `bun run db:duck:inspect-review-serving-project-state -- --project-id=7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac --limit=50`.

## Likely Future Implementation Touchpoints

- `src/server/reviewServing/reviewServingRetentionService.ts`: add explicit
  cleanup specs for eligible terminal rebuild partial and chunk-manifest rows.
- `src/server/reviewServing/reviewServingRetentionService.test.ts`: prove the
  allowlist, protected predicates, cursor advancement, and bounded deletes.
- `src/server/workers/reviewServingProjectorWorker.ts`: keep cleanup in the
  existing retention phase; avoid a new unbounded maintenance loop.
- `src/server/workers/reviewServingProjectorWorker.test.ts`: verify worker
  scheduling remains bounded and cleanup can be skipped safely.
- `src/server/reviewServing/reviewServingChunkManifestRepository.ts` and tests:
  inspect only if eligibility needs repository helpers; avoid broad behavior
  changes.
- `scripts/inspectReviewServingPhysicalEvidence.ts`: inspect only if before/after
  evidence needs an explicit eligible-row section.
- `src/server/utils/duckdbService.ts` and `src/server/utils/duckdbServiceReload.test.ts`:
  inspect only if startup recovery has table-specific assumptions for chunk
  manifests.

## Implementation Plan

1. Add an eligibility query in retention cleanup for summary contribution
   partial rows whose `request_id`/`chunk_id` belongs to completed terminal
   rebuild work that is no longer active, pinned, last-known-good, retryable, or
   the newest diagnostic trail.
2. Add the same guarded cleanup for summary rebuild partial rows.
3. Add guarded cleanup for `app.review_rebuild_chunk_manifest` rows only after
   dependent partial rows are gone for the same chunk/request.
4. Reuse the existing retention cursor and batch-size model so each worker pass
   touches at most one cleanup spec and one bounded batch.
5. Emit compact cleanup diagnostics: table, project id, review config hash,
   batch size, deleted row count if cheaply available, and retention scope.
6. Add unit tests around every protected state and every allowlisted table.
7. Run the route parity/current-DB gates before and after a small current-DB
   cleanup pass; compare before/after evidence instead of relying on tests only.

## Rollback And Recovery Rules

- The runtime rollback is disabling the new cleanup target discovery or setting
  its batch size to zero; no schema rollback should be required.
- If cleanup deletes too much in a local/current-DB run, stop the stack and
  preserve logs, before/after evidence, DuckDB recovery artifacts, and snapshots
  before restoring from backup.
- If DuckDB reports a crash, fatal restart, recovery pause, WAL/checkpoint
  problem, or stalled progress, do not continue cleanup. Preserve evidence and
  treat the slice as blocked.
- Do not manually delete WAL, startup recovery markers, chunk manifests, or
  partial tables to make gates pass.

## Browser, Desktop, And Shared App Impact

No direct browser or desktop UI flow is expected in this first slice because it
touches server-side intermediate rebuild storage only. The shared app contract
still matters indirectly: route parity, current-DB network smoke, and live
review-serving progress must prove that article review routes continue to return
the same results after cleanup.

## Quality Gates

- `bun test src/server/reviewServing/reviewServingRetentionService.test.ts`
- `bun test src/server/workers/reviewServingProjectorWorker.test.ts src/server/reviewServing/reviewServingChunkManifestRepository.test.ts`
- `bun test src/server/reviewServing/reviewServingRouteParityCoverage.test.ts src/server/reviewServing/reviewServingRouteParityEvidence.test.ts src/server/reviewServing/reviewServingRouteParityRunner.test.ts`
- `bun run bench:review-serving-release-gate`
- `bun run test:dev-server:current-db`
- `bun run test:network-smoke:current-db`
- Fresh before/after physical evidence shows only eligible allowlisted rows were
  removed, with no route parity diff and continued current-DB progress.
