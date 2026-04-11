# Judge Human First Plan

## Goal

- For future top-ups only, make `judgmentsJobsAddToQueue` prefer `(articleId, promptId)` pairs that already have answered human rows in `app.judgment_human`.
- Make that preference visible in actual SQLite ready-claim order for newly inserted rows, not just in the array passed into `addReadyPrompts`.
- Do not reshuffle rows already queued in local SQLite.
- Keep existing scan cursor semantics.

## Core Decision

- Implement priority at the add-to-queue boundary, not in OLAP selection.
- Add deterministic intra-batch ordering in the local SQLite ready queue so insertion order survives through `claimReadyPrompts`.
- Use `app.judgment_human.is_answered = TRUE` as the priority signal for this change.
- Do not require a non-empty `answer` in this first pass. This is human-touched priority, not answer-content priority.
- Ignore `app.judgment_assessment` for this change. It is tied to an existing LLM `judgment_id`, not directly to queueable `(articleId, promptId)` pairs.
- Stable-partition the overscanned prompt entries just before `addReadyPrompts`, so the current scan order remains the tiebreaker inside each bucket.

## Why Here

- `judgmentsJobsAddToQueue` already fetches more prompt pairs than it can insert, then trims with `addReadyPrompts(..., readyDeficit)`.
- That makes it the smallest place to decide which future pairs get into `queue_prompt` first.
- The only extra prerequisite is making the local SQLite queue preserve insertion order deterministically within a batch.
- This avoids OLAP ordering changes, app-schema changes, and scan-cursor changes.

## Scope Now

- Server only.
- Files likely touched:
  - `src/server/cron/judgmentsJobs/judgmentsJobsAddToQueue.ts`
  - `src/server/cron/judgmentsJobs/judgmentsJobsAddToQueue.test.ts`
  - `src/server/cron/judgmentsJobs/judgmentJobSqliteService.ts`
  - `src/server/cron/judgmentsJobs/judgmentJobSqliteService.test.ts`
  - `src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM/getAndUpdateReadyPrompts.test.ts`
  - `src/server/cron/judgmentsJobs/requeueAbandonedSentPrompts.test.ts`
- Touched layers: server.

## Implementation Order

1. Make local SQLite ready ordering deterministic in `judgmentJobSqliteService.ts`.
   - Add an explicit monotonic enqueue-order column for `queue_prompt`, for example `ready_insert_seq`, instead of relying on equal `created_at` timestamps plus random UUID tie-breaking.
   - Assign that value once on initial ready insertion and do not rewrite it during claim, requeue, judgment success, or any other status transition.
   - Add an in-place schema upgrade path for existing job DBs, similar to the existing `job_scan_state` and `judgment_outbox` upgrades.
   - Backfill existing `queue_prompt` rows in current `(created_at, id)` order so already queued rows keep their effective FIFO order.
   - Change `claimReadyPrompts` to order by the explicit enqueue-order column.
   - Keep requeued stale sent rows on their original enqueue-order value when they return to `ready`.
   - Update required schema validation plus any SQLite health or preflight sampling that still assumes `(created_at, id)` ordering.
   - Add or update the supporting SQLite index used by ready claims.
2. Add an answered-human lookup helper in `judgmentsJobsAddToQueue.ts`.
   - Input: fetched and filtered prompt entries plus `projectId`.
   - Query `app.judgment_human` in batches using the same pair-CTE pattern already used by `filterAlreadyJudged`.
   - Match only `project_id = job.projectId` and `is_answered = TRUE`.
3. Add a stable prioritization step before SQLite insertion.
   - Keep current `filterAlreadyJudged` behavior.
   - Split entries into `humanFirst` and `rest`.
   - Preserve original order within both groups.
   - Pass `[...humanFirst, ...rest]` to `addReadyPrompts`.
4. Add minimal observability.
   - When non-zero, log how many entries in the fetched window were human-first candidates.
   - Log how many of those candidates were actually inserted into `ready` after `readyDeficit` trimming and `INSERT OR IGNORE` dedupe.
5. Add tests.
   - New SQLite service test: a fresh job DB preserves insertion order through `claimReadyPrompts`.
   - New SQLite service test: requeueing stale sent rows back to `ready` does not rewrite their enqueue-order value.
   - New SQLite service test: upgrading a legacy `queue_prompt` schema backfills the enqueue-order column without losing rows and preserves existing effective FIFO order.
   - New SQLite preflight test: isolated preflight upgrades the legacy `queue_prompt` schema before readonly validation.
   - New top-up test: prove the end-to-end path `judgmentsJobsAddToQueue -> SQLite addReadyPrompts -> claimReadyPrompts` with `readyDeficit` smaller than the fetched window and with a human-answered pair appearing later than non-human pairs in the original scan order.
   - New top-up test: multiple promoted human pairs preserve their original relative order.
   - New top-up test: unanswered `judgment_human` rows do not get priority.
   - New top-up test: answered human rows from a different project do not get priority.
   - New top-up test: pairs already judged in `app.judgment` are still filtered out even if they also have answered human rows.
   - New top-up test: locally judged SQLite rows are still filtered out before insertion even if they would otherwise be human-first.
   - New top-up test: rows already in `status = 'ready'` still claim ahead of newly inserted human-first rows.
   - Update or add a `getAndUpdateReadyPrompts` test so it asserts returned prompt order instead of sorting the result and masking queue-order regressions.
   - New requeue test: stale sent rows that are moved back to `ready` preserve their original queue position relative to newer rows.

## Not Now

- No app DuckDB schema changes.
- No changes to OLAP candidate ordering.
- No changes to scan cursor semantics.
- No reshuffling of rows already in `status = 'ready'`.
- No changes to `claimReadyPrompts` policy beyond replacing non-deterministic tie-breaking with explicit FIFO order.
- No priority based on `app.judgment_assessment`.

## Behavior Notes

- This is window-local priority, not a full project-wide reorder of the scan.
- That is intentional for the first pass:
  - it keeps the existing scan cursor untouched
  - it avoids accidental skips or duplicate scan complexity
  - it still makes the next top-up batches favor human-touched pairs
- Priority only affects which rows are inserted next and the relative order of newly inserted rows from the same top-up batch.

## Done Criteria

- Future queue top-ups insert and claim human-answered `(articleId, promptId)` pairs before non-human pairs from the same fetched window.
- Existing ready rows keep their current order.
- Requeued stale sent rows keep their prior queue position when they return to `ready`.
- Intra-batch ready ordering is deterministic and no longer depends on UUID or tied timestamps.
- Legacy SQLite job DBs upgrade in place without losing queue rows or changing the effective order of existing ready rows.
- Unanswered human seed rows do not get priority.
- Cross-project human rows do not affect prioritization.
- Existing already-judged and locally-judged filtering still pass.

## Quality Gates

- `bun test src/server/cron/judgmentsJobs/judgmentJobSqliteService.test.ts`
- `bun test src/server/cron/judgmentsJobs/judgmentsJobsAddToQueue.test.ts`
- `bun test src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM/getAndUpdateReadyPrompts.test.ts`
- `bun test src/server/cron/judgmentsJobs/requeueAbandonedSentPrompts.test.ts`
- `bun run lint`
