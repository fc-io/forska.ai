# Review-Serving Storage Retention Cleanup Evidence

## Scope

This artifact records verification for the first storage-slimming implementation
slice: bounded retention cleanup for terminal summary rebuild partial artifacts
and eligible summary rebuild chunk manifests.

The change does not drop tables, columns, indexes, migrations, route readers, or
serving marts. Cleanup remains in the existing retention cursor path.

## Implementation Boundary

The new cleanup specs are allowlisted to:

- `mart.review_article_summary_contribution_rebuild_partial_v4`
- `mart.review_article_summary_rebuild_partial_v4`
- `app.review_rebuild_chunk_manifest`

Deletes are project-scoped, batch-limited, and guarded by active snapshot,
last-known-good snapshot, active pin, request status, chunk status, retryable
work, diagnostic trail, and dependent partial-row predicates. Chunk manifests
are only eligible after matching contribution and summary partial rows are gone.

## Evidence Files

Before current-DB gates:

```text
.tmp/evidence/review-serving-current-db-physical-before-retention-cleanup.md
.tmp/evidence/review-serving-project-state-before-retention-cleanup.txt
```

After current-DB gates:

```text
.tmp/evidence/review-serving-current-db-physical-after-retention-cleanup.md
```

Key before/after row counts for the scoped project:

| Table | Before | After |
| --- | ---: | ---: |
| `app.review_rebuild_request` | 15 | 15 |
| `app.review_rebuild_chunk_manifest` | 96312 | 96312 |
| `mart.review_article_summary_rebuild_partial_v4` | 320969 | 320969 |
| `mart.review_article_summary_contribution_rebuild_partial_v4` | 4257474 | 4257474 |

Zero deleted rows is an acceptable outcome for this pass. The cleanup predicates
are intentionally conservative, and the current-DB gate did not expose eligible
terminal rows during the verification window.

## Verification

```bash
bun test src/server/reviewServing/reviewServingRetentionService.test.ts
bun test src/server/workers/reviewServingProjectorWorker.test.ts src/server/reviewServing/reviewServingChunkManifestRepository.test.ts
bun test src/server/reviewServing/reviewServingRouteParityCoverage.test.ts src/server/reviewServing/reviewServingRouteParityEvidence.test.ts src/server/reviewServing/reviewServingRouteParityRunner.test.ts
bun run bench:review-serving-release-gate
bun run db:duck:inspect-review-serving-physical-evidence -- --format=markdown --output=.tmp/evidence/review-serving-current-db-physical-before-retention-cleanup.md
bun run db:duck:inspect-review-serving-project-state -- --project-id=7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac --limit=50
bun run test:dev-server:current-db
bun run test:network-smoke:current-db
bun run db:duck:inspect-review-serving-physical-evidence -- --format=markdown --output=.tmp/evidence/review-serving-current-db-physical-after-retention-cleanup.md
git diff --check
```

All commands passed. One initial physical-evidence attempt overlapped another
maintenance script and was rerun after the first script released DuckDB
maintenance access.
