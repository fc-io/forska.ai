# Review Rebuild Work Fan-Out Plan

## Scope

Reduce review-serving rebuild work fan-out overhead without weakening the safety envelope that prevented DuckDB OOMs and unresponsive owner loops in PR #129.

This plan covers the near-term work:

1. Adaptive coalescing of already-small rebuild chunks.
2. Smarter admission-time pre-splitting so broad parent chunks do not explode during execution.

The goal is fewer claim/select/update/finalize cycles per useful unit of work, not simply larger unsafe DuckDB transactions.

## Problem Statement

The rebuild queue currently protects DuckDB by splitting broad component work into small claimable chunks. That is correct for memory safety, retry isolation, and progress tracking. The current live timing from PR #129 shows the balance is wrong for cheap chunks:

- `claimSelectMs` is often a large fraction of total wall time.
- split-recovery bookkeeping can be a second large bucket.
- many child chunks execute cheaply once claimed.
- pending/claimable counts can grow while progress is real, which makes ETA and operator judgment noisy.

So the bug is not "fan-out exists". The bug is that the queue pays full manifest overhead for every tiny bite.

## Non-Goals

- Do not raise runtime chunk sizes globally as the primary fix. The 1024/5000-row experiments made DuckDB unresponsive or OOM-prone on this workload.
- Do not introduce multiple DuckDB writers in this plan.
- Do not remove chunk-level retry safety for memory-risky components.
- Do not change derived serving table semantics.

## Phase 1 - Adaptive Coalescing

### Idea

Keep small chunks as the durable safety unit, but let the worker claim and process a bounded bundle of compatible adjacent chunks when recent timings show those chunks are cheap.

Instead of:

```text
claim chunk A -> execute -> finalize
claim chunk B -> execute -> finalize
claim chunk C -> execute -> finalize
```

Do:

```text
claim bundle A+B+C+...
for each chunk:
  heartbeat if needed
  execute bounded subchunk
  check RSS/time/error budget
finalize completed bundle rows together where safe
```

### Compatibility Rules

A bundle is eligible only when every chunk has the same:

- `request_id`
- `project_id`
- `snapshot_id` / candidate identity
- projection component
- workload class / priority lane
- status and lease eligibility
- component-specific writer shape

Range chunks must also be adjacent or non-overlapping in a deterministic order. Never bundle chunks whose writers can conflict on the same output keys unless the component already has a proven multi-range writer path.

### Adaptive Caps

Start conservatively and make the bundle size data-driven:

- max chunks per bundle, default small such as 8 or 16
- max estimated input rows
- max estimated output rows/bytes when known
- max bundle wall time target, e.g. 1-2 seconds
- max RSS before claim and between subchunks
- max per-subchunk duration before shrinking the next bundle
- component allowlist at first: likely `posting` and selected cheap request chunks after timing proves compatibility

Use the PR #129 timing summaries to choose and adjust:

- if `claimSelect.queryMs / totalMs` is high and `executeMs` is low, increase coalescing within caps
- if RSS climbs, DuckDB errors, or execute duration spikes, shrink back to one chunk

### Implementation Slices

1. Add a repository method to claim a compatible bundle.
   - Preserve the existing single-claim method.
   - The SQL should choose the first normal claimable chunk, then find compatible adjacent peers.
   - Mark all claimed rows with the same lease owner and lease expiry in one transaction.
   - Return deterministic order.

2. Extend the worker execution path.
   - Introduce a `ClaimedReviewServingProjectorWorkerRebuildChunkBundle` shape.
   - Keep current single-chunk code path as `bundle.length === 1`.
   - Execute subchunks serially through the existing DuckDB writer lane.
   - Heartbeat the whole bundle or touched chunk before long work.
   - On subchunk failure, fail that chunk and release or preserve remaining unexecuted chunks according to existing retry semantics.

3. Batch cheap manifest updates.
   - Complete successful chunks together where the repository supports it.
   - Keep validation results per chunk.
   - Preserve per-chunk diagnostics but add a bundle-level timing field for operator logs.

4. Feed bundle decisions from timing.
   - Add bounded rolling stats keyed by component/request/status or reuse emitted timing state if available in-process.
   - Start with static component caps and only increase after a minimum sample count.

5. Add focused tests.
   - Claims only compatible chunks.
   - Does not cross request/component/status/range conflicts.
   - Shrinks or disables bundles after a slow/erroring chunk.
   - Failure in chunk N does not mark chunk N+1 complete.
   - Timing summaries report bundle size and still avoid double-counting child timers.

### Acceptance Criteria

- Live rebuild timing shows fewer claim/select cycles per completed chunk bundle.
- `claimSelect.queryMs` and split bookkeeping become a smaller share of wall time for cheap components.
- No new DuckDB OOM/fatal/high-RSS events on the live gate.
- 3001/3002/3003 stay ready during the rebuild.
- Failed/blocked/quarantined chunks remain zero or explainable in test-induced paths.

## Phase 2 - Smarter Admission-Time Pre-Splitting

### Idea

Stop creating broad parent chunks that predictably split during execution. At rebuild-request admission, use component-specific estimates to create executable child chunks directly.

This makes the work queue honest up front:

- pending does not balloon as much during execution
- ETA is more stable
- split-recovery code becomes an exception path, not the normal path

### Component Policies

Each component should have a planning policy:

- estimate source rows
- estimate expected output fan-out where known
- choose initial range size
- choose max runtime range size
- mark whether adjacent children are eligible for coalescing
- mark whether the component supports SQL-native multi-range writes

Posting/search/summary should not share one generic row limit. Their memory and fan-out shapes differ.

### Implementation Slices

1. Extract a rebuild chunk planning module.
   - Centralize component budgets and fan-out assumptions.
   - Keep current constants as defaults, but make the decision explicit and testable.

2. Use planning at request admission.
   - Default rebuilds, missing-snapshot foreground rebuilds, and broad dirty-work routed rebuilds should all enter through the same planner.
   - Store enough estimate metadata on chunk diagnostics to explain why a range size was chosen.

3. Keep runtime splitting as a safety fallback.
   - Runtime split should primarily handle stale legacy rows, estimate misses, and DuckDB OOM/admission bugs.
   - Add a warning/timing dimension when runtime split happens for a freshly planned request.

4. Add over-split detection.
   - If a request produces too many small chunks for one component, emit a bounded warning with planning metadata.
   - This catches bad estimates before the queue becomes huge.

5. Add focused tests.
   - Search-only requests are judged by max planned child size, not whole-project estimate.
   - Broad posting requests produce direct child chunks under budget.
   - Foreground missing-snapshot requests use the same planner and priority boost.
   - Runtime splitting still works for oversized legacy chunks.

### Acceptance Criteria

- Fresh broad rebuild requests do not show large runtime split-recovery counts under normal estimates.
- Pending counts are close to the planned count shortly after admission.
- Timing logs show `recoverOversizedMs` near zero for freshly admitted planned chunks.
- Operator diagnostics can explain planned chunk size by component.

## Verification Commands

Run focused tests first:

```bash
bun test src/server/reviewServing/reviewServingChunkManifestRepository.test.ts
bun test src/server/reviewServing/reviewServingRebuildRequestRepository.test.ts
bun test src/server/workers/reviewServingProjectorWorker.test.ts -t "rebuild"
```

Then run the project gates used for PR #129:

```bash
bun run lint
```

For changes touching live review-serving maintenance, also run the live progress gate:

- API, maintenance owner, and judge readiness are true.
- Affected project counters move over a short interval.
- `lastProgressedAt` advances or the request reaches ready.
- failed/blocked/quarantined/expired counts stay clean.
- maintenance log has no fresh DuckDB OOM/fatal/high-RSS restart loop.

## Rollout

1. Ship Phase 1 with a conservative component allowlist and small bundle caps.
2. Watch timing logs for claim/select percentage and RSS.
3. Expand allowlist only for components with stable timing and no error signal.
4. Ship Phase 2 planner extraction after coalescing proves the safe bundle envelope.
5. Make runtime split warnings visible enough to catch new estimate misses early.
