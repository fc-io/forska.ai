# Review-Serving Storage And Performance

This is the current compact plan for review-serving storage, selected-import
ownership, post-import readiness, and performance measurement. It replaces the
large July 2026 storage-shape audit artifacts and the older DuckDB/rebuild phase
plans.

## Current Direction

Review-serving should keep exact, bounded product reads while reducing hot
storage width and rebuild cost.

The durable design direction is:

1. Keep authoritative product truth in `app.*` source tables.
2. Keep hot marts only for values needed before `LIMIT`: candidate selection,
   keyset order, selective filters, queue/status membership, and exact named
   counts.
3. Move larger detail fields and infrequently used payload into keyed payload
   tables or post-selection hydration.
4. Use manifests and watermarks to publish complete component generations.
5. Keep retention bounded and snapshot-protected.
6. Prefer one coherent migration slice over permanent old/new dual paths.

## Storage Decision Rule

A field belongs in a hot review-serving mart only when at least one of these is
true:

- it is required to select candidate article IDs before applying `LIMIT`
- it is required for keyset ordering or cursor correctness
- it is required for a synchronous selective filter or queue access path
- it is a product-critical exact count/facet that must be instant
- it is manifest/control state required for replay, recovery, or publication

Everything else should be source truth, keyed payload, bounded post-selection
derivation, cold evidence, or deletion candidate.

## Evidence Snapshot From July 2026

The old physical evidence was collected from a read-only current-DB snapshot for
project `7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac`. It showed the main hot surfaces:

- selected import: `app.review_selected_article_import_v4`
- snapshot/control: `app.review_selected_import_snapshot`,
  `app.review_projection_identity_manifest`,
  `app.review_serving_snapshot_manifest`,
  `app.review_rebuild_request`, `app.review_rebuild_chunk_manifest`
- serving rows: `mart.review_article_serving_v4`
- postings: `mart.review_article_filter_posting_serving_v4`
- details/payload-adjacent rows:
  `mart.review_article_judgment_detail_serving_v4`
- exact counts/facets: `mart.review_article_count_serving_v4`,
  `mart.review_filter_option_serving_v4`

That evidence was generated before later migrations retired several empty patch
tables. Regenerate physical evidence before making new table-level decisions.

Command:

```bash
bun run db:duck:inspect-review-serving-physical-evidence -- --format=markdown --output=.tmp/evidence/review-serving-current-db-physical.md
```

## Completed Storage Slices

Recent completed slices established these constraints:

- route parity and benchmark contract tests exist for review-serving routes
- current-DB smoke/progress gate is the live safety gate for storage work
- retired patch and summary-contribution rows have bounded retention cleanup
- summary contribution ledgers are recoverable and no longer needed as hot
  serving state once serving tables are rebuilt
- selected-import display-copy suppression reduced duplicate display payload
  writing
- judgment payload consumers were audited so payload movement can be bounded by
  actual readers

## Selected-Import Ownership

Selected-import state should be owned by the selected-import projector and its
manifest, not duplicated into every downstream serving shape.

Keep selected-import data hot when it drives:

- project/article membership
- import-route current winner selection
- rank/order/cursor behavior
- synchronous route/filter membership
- rebuild component watermarks

Move or avoid duplicate storage for display and detail fields that can be
hydrated after article IDs are selected.

Future selected-import work should prove:

- the consumer list for any moved field
- exact route parity before and after
- current-DB progress with no fatal restart, OOM, or temp-spill regression
- cleanup of obsolete columns/tables in the same coherent migration slice

## Post-Import Mart Creation

Project-transfer import now requests or boosts the existing
`missingReviewServingSnapshot` rebuild after a successful import commit and
during stale committing-session recovery. The next performance target is reducing
time from import commit to review-page-ready serving marts.

Primary metric:

```text
import commit completed_at -> first active review-serving snapshot with all
review-page-critical components ready
```

Secondary metrics:

- commit completion to rebuild request admission
- admission to first user-visible review-list readiness
- per-component rows/sec and wall time for project scope, selected import,
  display, LLM status, human status, queue, search, payload, posting, and summary
- idle gaps between commit, delta intake, admission, chunk execution,
  finalization, and snapshot promotion
- owner responsiveness, RSS, and temp-spill behavior during the build

Use:

```bash
bun run db:duck:inspect-review-serving-rebuild-timings -- --project-id=<project-id>
bun run db:duck:inspect-review-serving-project-state -- --project-id=<project-id> --limit=50
bun run test:network-smoke:current-db
```

## Benchmark Boundary

`bun run bench:review-serving-smoke` and
`bun run bench:review-serving-release-gate` are synthetic/contract gates unless
a separate physical report is generated. Do not treat them as proof of live
current-DB performance by themselves.

Storage/performance PRs touching review-serving maintenance, DuckDB lifecycle,
worker scheduling, rebuild queues, or progress reporting must also prove live
current-DB progress as described in `TESTS.md` and the workspace Forska gate.

## Future Work

Provider throughput:

- remove prompt-preparation and scheduler bottlenecks that keep active LLM calls
  below the saved provider limit
- add diagnostics for prep wait, runtime resolution, dispatch idleness, endpoint
  cooldown, shared-connection allocation, and Codex transport concurrency
- preserve stale-row recovery, drain behavior, request-runtime caps, and provider
  health semantics

System prompt provenance:

- store immutable system-prompt sets in DuckDB
- link projects and judgments to a system-prompt-set identity
- include system-prompt identity and resolved text in execution snapshots
- treat system-prompt changes as judgment-affecting for reuse and reruns
- avoid silent fallback to hard-coded prompt constants after cutover

Both are product/runtime work, not part of the current review-serving storage
cleanup unless explicitly pulled into a new implementation slice.
