# Review Rebuild Tail And Summary Batch Plan

## Scope

Implement the next two review-serving rebuild fixes after the low-memory burst-cap fix:

1. Tail-state correctness diagnostics for stale leases and invalid candidate snapshots.
2. Bounded summary chunk batching.

The goal is to finish rebuilds reliably and reduce summary-phase scheduler overhead without weakening the DuckDB memory guardrails that kept the owner alive.

## Option 1 - Tail-State Correctness

### Problem

Near the end of a large rebuild, the route can show a candidate snapshot as invalid while only a small number of chunks remain running or claimable. Today that is too opaque: operators can see "invalid candidate" but not whether the candidate is missing a required component, has an invalid required/optional manifest state, or is blocked on selected-import completion.

Expired rebuild leases are claimable by the worker, so their presence alone is not a blocker. The real tail risk is a candidate that stays invalid after pending/in-flight work drains.

### Implementation

- Keep expired running rebuild chunks counted as claimable/pending work.
- Add compact invalid-candidate reason counts to review-serving diagnostics:
  - selected import incomplete/missing
  - missing required component
  - invalid required component state
  - invalid optional component state
- Preserve existing route semantics: only treat invalid candidates as blocked when no pending/in-flight rebuild work remains.

### Acceptance Criteria

- Warnings/progress diagnostics explain invalid candidate reason counts.
- Expired leases still contribute to claimable/pending progress rather than terminal failure.
- Existing missing-snapshot repair behavior is unchanged.

## Option 2 - Summary Chunk Batching

### Problem

Live timing showed summary chunks averaging roughly 180-220 ms, with high throughput once the run cap was fixed. The next avoidable overhead is that `summary` was explicitly excluded from compatible chunk batching, even though adjacent request chunks are safe to stage as per-chunk summary partials.

### Implementation

- Allow request-associated summary chunks into foreground compatible batching.
- Add a bounded summary batch writer that:
  - claims only compatible chunks for the same request/project/snapshot/projection identity/base generation
  - writes each chunk's partial summary rows under one batch heartbeat window
  - preserves per-chunk partial identity through `request_id` + `chunk_id`
  - finalizes the request once per batch through the existing finalization de-dupe
- Keep requestless summary adoption single-chunk so request adoption stays simple and deterministic.
- Keep RSS cap and native-heavy cleanup behavior.

### Acceptance Criteria

- Summary request chunks can complete more than one chunk per bounded batch.
- Summary partial tables still contain per-chunk output keyed by each chunk id.
- Request finalization/reduction still runs only after all request chunks are complete.
- Owner/API/judge readiness stays green under the live gate.

## Quality Gates

```bash
bun test src/server/reviewServing/reviewServingDiagnosticsRepository.test.ts
bun test src/server/workers/reviewServingProjectorWorker.test.ts -t "summary"
bun test src/server/workers/reviewServingProjectorWorker.test.ts
bun run lint
```

Live gate before reporting done:

- 3001/3002/3003 readiness true.
- Rebuild counters move or requests reach ready.
- failed/blocked/quarantined counts stay clean.
- maintenance log has no fresh DuckDB OOM/fatal/high-RSS loop.
