# Review Serving Warning Status Split Plan

## Goal

Make project-review warnings describe the user-visible review page state correctly while still preserving maintenance failure evidence for debugging.

The current warning route can show `status: failed` / `progressState: failed` when the active review-serving snapshot is readable and all visible review tabs are correct, because old terminal rebuild chunks are folded into the same status as actionable live indexing failure. That makes the UI report a broken review page when the useful serving surface is ready.

## Principles

- Serving readiness and maintenance health are separate concepts.
- A preserved historical failure is diagnostic evidence, not automatically a user-facing failure.
- User-facing failure means actionable failure: serving is unavailable/stale, live work is blocked, or terminal work is preventing current serving readiness.
- Diagnostics should remain visible in the API response so operators can investigate old failed/quarantined rebuild evidence.
- Article-facing coverage remains the product progress language; chunk counts stay diagnostics.

## API Shape

Keep the existing `indexing.status` and `indexing.progressState` fields for compatibility, but derive them from actionable serving/indexing state instead of raw historical terminal evidence.

Add a nested diagnostic summary under `indexing.maintenance`:

```ts
{
  status: 'idle' | 'processing' | 'blocked' | 'failed',
  hasHistoricalFailures: boolean,
  hasActionableFailures: boolean,
  terminalRebuildChunkCount: number,
  terminalDirtyWorkCount: number,
  terminalQuarantineCount: number
}
```

The existing `indexing.serving.diagnostics` remains the detailed operator payload.

## Status Semantics

`indexing.status`:

- `ready`: active/LKG serving is usable, no live refresh work is pending/running, and no actionable failure blocks current serving.
- `refreshing`: serving may be usable or missing, and live claimable/running refresh work exists.
- `blocked`: serving is unavailable or live work exists but cannot progress because the projector is paused, mutation work is disabled, DuckDB exclusive work is active, or an invalid candidate requires operator intervention.
- `failed`: serving is unavailable/stale, or live pending/running work exists, and terminal/quarantine evidence blocks current progress.
- `stale`: serving is missing/stale and no live work is currently claimable.
- `not-needed`: the project has no enabled review prompts or no scoped articles.

Historical terminal rebuild chunks behind a usable active snapshot with no pending/running/claimable work must not make `indexing.status` or `indexing.progressState` failed.

`indexing.progressState`:

- `completed` for `ready` and `not-needed`.
- `processing` when refresh work is running or recently progressing.
- `queued` when claimable refresh work exists.
- `blocked` for blocked actionable work.
- `failed` only for actionable failure.
- `stalled` when work is expected but not currently progressing.

## Maintenance Semantics

`indexing.maintenance.status`:

- `processing`: live refresh work is pending/running/claimable.
- `blocked`: live work exists but cannot be claimed because of pause, disabled mutations, exclusive DuckDB work, blocked candidate, or quarantine barrier.
- `failed`: actionable terminal/quarantine evidence blocks serving readiness or live work.
- `idle`: no live refresh work.

`hasHistoricalFailures` is true when any terminal dirty work, terminal rebuild chunks, terminal-quarantined rebuild chunks, or quarantined outbox rows are present, even if they do not affect the user-facing serving status.

`hasActionableFailures` is true only when the same evidence affects current serving readiness or current live work.

## UI Semantics

The normal project-review banner should follow `indexing.status` and `indexing.progressState`, so a readable/usable review page does not show a failed indexing banner solely because old evidence exists.

The UI may later expose `indexing.maintenance.hasHistoricalFailures` in an admin/debug surface. Do not show historical rebuild chunk counts in the normal review banner.

## Regression Tests

Add focused route tests for:

- active readable serving + old terminal/quarantined rebuild chunks + no live work => `status: ready`, `progressState: completed`, `maintenance.hasHistoricalFailures: true`, `maintenance.hasActionableFailures: false`.
- missing/unusable serving + terminal rebuild chunks => `status: failed`, `progressState: failed`, actionable maintenance failure true.
- readable serving + pending/claimable enrichment work => `status: refreshing`, not failed, diagnostics retained.
- readable serving + quarantine barrier blocking live work => user-facing failure/blocked behavior remains actionable.

Extend the current-DB warning gate so complete readable review-page/detail coverage cannot report user-facing failed status solely because of historical terminal rebuild evidence.

## Implementation Steps

1. Introduce small helper functions in `projectsRoutesGetReviewsWarnings.ts` to classify serving readiness, live work, historical maintenance evidence, and actionable failures.
2. Add `indexing.maintenance` to the warning response.
3. Update `getReviewsIndexingStatus` call sites so historical terminal work only drives user-facing failure when actionable.
4. Update route tests for the split semantics.
5. Update UI typings/tests if the generated/handwritten response type requires the new `maintenance` field.
6. Add or extend a current-DB warning parity/check command.
7. Verify focused route/component tests, lint, `git diff --check`, current-DB tab parity, current-DB warning parity, and the dev-server current-DB gate.
