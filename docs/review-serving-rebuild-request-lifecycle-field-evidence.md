# Review-Serving Rebuild Request Lifecycle Field Evidence

## Scope

This note records read-only current-DB evidence for the nullable lifecycle fields
on `app.review_rebuild_request`:

- `retry_after`
- `oom_category`
- `over_budget_reason`
- `lease_owner`
- `lease_expires_at`

It is evidence only. It does not authorize schema slimming, column removal,
writer changes, retention broadening, or cleanup.

## Current-DB Evidence

Generated with:

```bash
bun run db:duck:inspect-review-serving-physical-evidence -- --format=markdown --output=.tmp/evidence/review-serving-rebuild-request-lifecycle-evidence.md
```

The current report shows:

- 58 global `app.review_rebuild_request` rows.
- 16 rows for the default inspected current project.
- `retry_after`, `lease_owner`, and `lease_expires_at` are null across all 58
  global rows.
- `oom_category` and `over_budget_reason` each have 5 non-null global rows,
  even though they are null for the default inspected project.
- The inspected project contains 11 failed `missingReviewServingSnapshot`
  requests, 4 failed `requestless_bootstrap_rebuild` requests, and 1 admitted
  `missingReviewServingSnapshot` request, with zero rows carrying any of the
  lifecycle fields.

## Disposition

The global non-null OOM/over-budget rows prove this is not a pure null-column
cleanup candidate. The null lease/retry fields are also not dead-state proof:
they represent admission, retry, lease, and operator recovery semantics that
can appear under failure or overload conditions.

Keep these fields protected until a separate lifecycle replacement or removal
proposal proves all of the following:

1. Retry, OOM, over-budget, and lease behavior is either still required or has a
   tested replacement.
2. Warning and operator diagnostics stay useful for failed, blocked, retryable,
   and requestless-bootstrap rebuild requests.
3. Route parity, benchmark checks, DuckDB lifecycle tests, and live current-DB
   progress gates pass after any runtime or schema change.
