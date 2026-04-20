# Better Human Priority Plan

## Goal

- Move summary-mode human priority earlier so articles with a non-empty row in `app.judgment_human_summary` actually enter the fetched LLM queue window before non-summary articles.
- Keep prompt-mode behavior unchanged.
- Keep existing SQLite FIFO behavior for already queued `ready` rows; this plan only fixes pre-queue selection.

## Why Current Behavior Still Fails

- `getUnassessedPairsFromDuckdb` expands candidate articles into prompt rows and truncates them with `slice(0, numberOfPromptsToGet)` in `src/services/olap/duckdbOlap.ts`.
- `judgmentsJobsAddToQueue` only prioritizes after that slice, so later summary-backed articles can be missing from the returned window entirely.
- A simple post-fetch reorder in OLAP would also be unsafe because the unassessed-pair cursor currently only tracks `(lastDate, lastArticleId)` and would skip displaced articles.

## Core Decision

- Make summary priority part of the unassessed-pair selection contract, not only a post-fetch reorder.
- In summary mode, order candidate articles by:
  1. answered human summary first,
  2. then existing activity order,
  3. then `article_id` as the final tiebreaker.
- Use a dedicated `UnassessedPairsCursor` instead of widening the generic review pagination cursor, so queue scanning can evolve without coupling unrelated article-list pagination paths.
- Extend the unassessed-pair cursor so it tracks the same ordering tuple and does not skip articles when the priority bucket changes between windows.
- Keep the existing summary-mode partition in `judgmentsJobsAddToQueue` as a secondary guard for already-fetched rows.

## Implementation Order

1. Extend the unassessed-pair cursor contract.
   - Introduce `UnassessedPairsCursor` in `src/services/olap/olapTypes.ts` instead of reusing the generic `PaginationCursor` type used by review-page flows.
   - Treat missing `priorityBucket` as `0` so existing callers and saved scan state can resume safely.
   - Add shared helpers that compare `(priorityBucket DESC, activity DESC, article_id DESC)` consistently in both `ORDER BY` and cursor `WHERE` clauses.
   - Persist the extra cursor field in local job SQLite scan state so in-progress jobs resume safely after restart.
2. Add summary priority metadata to candidate selection.
   - Serving path: derive `priorityBucket` from `mart.review_article_serving` for summary-mode projects, using the existing summary completeness signal already exposed there.
   - Raw fallback path: derive `priorityBucket` from non-empty rows in `app.judgment_human_summary` for the current project, reusing `NULLIF(TRIM(COALESCE(answer, '')), '') IS NOT NULL`.
   - Prompt mode keeps `priorityBucket = 0` for every article.
3. Use the priority-aware order before prompt-row truncation.
   - Update both unassessed candidate paths to order by `priorityBucket DESC`, then the current activity ordering, then `article_id DESC`.
   - Keep the existing `candidateArticles -> promptEntries -> slice(numberOfPromptsToGet)` shape, but make the returned window summary-first in summary mode.
   - Do not change prompt ordering inside a selected article.
4. Make next-cursor calculation follow the new ordering.
   - Base `nextCursor` on the last article whose prompt rows actually contribute to the returned window, including its `priorityBucket`.
   - Preserve raw/serving parity so the same project can progress through either path without reordering surprises.
5. Keep add-to-queue behavior as a safety net.
   - Leave the existing summary-mode stable partition in `src/server/cron/judgmentsJobs/judgmentsJobsAddToQueue.ts` so already-fetched rows still prefer summary-backed articles after app and SQLite filtering.
   - Do not clear or reshuffle already queued SQLite `ready` rows in this plan.
6. Add focused regression coverage.
   - New `duckdbOlap` serving-path test: a later summary-backed article enters the returned prompt window ahead of a fresher non-summary article.
   - New raw fallback parity test: same project, same inputs, same summary-first prompt order.
   - New cursor test: after a summary-first first window, the displaced non-summary article still appears on the next call instead of being skipped.
   - New edge-case tests: blank or `NULL` summary answers do not promote, other-project summary rows do not promote, and prompt-mode behavior remains unchanged.
   - Keep the existing `judgmentsJobsAddToQueue` summary-priority tests passing.

## Not Now

- No SQLite queue reset when a new human summary answer arrives.
- No reshuffle of existing `ready` rows.
- No prompt-mode priority redesign.
- No ranking by summary answer recency or answer value.

## Schema Impact

- No app DB schema change is required.
- No mart schema change is required if this plan reuses the existing summary-human rollup fields already present on `mart.review_article_serving`.
- A local judgment-job SQLite schema change is expected so the persisted scan cursor can store the priority bucket safely.

## Pros

- Fixes the actual failure point by moving priority before the prompt-row slice.
- Reuses existing app and mart data instead of introducing new product-level schema.
- Keeps prompt-mode behavior unchanged.
- Keeps existing SQLite `ready` FIFO semantics intact.
- Preserves the add-to-queue partition as a second layer of protection.

## Cons

- Cursor logic becomes more complex and easier to get subtly wrong.
- Requires a local SQLite migration for persisted job scan state.
- Does not retroactively reorder already queued backlog.
- Does not guarantee global summary-first behavior across multiple jobs.

## Long-Term Considerations

- Mart freshness: the serving path may lag newly entered human summary answers until the project mart refresh catches up, while raw fallback can observe app-table truth sooner.
- Mid-run updates: a human summary added after a job has already built backlog will only affect future scans in this plan, not immediately jump ahead of older `ready` rows.
- Fairness: if many summary-backed articles exist, non-summary articles can wait much longer; that is acceptable only if product intent is truly summary-first.
- Prompt fan-out: because the signal is article-level and the queue is prompt-level, one promoted article can contribute many prompt rows; later we may want a per-article cap or round-robin expansion if that becomes too lopsided.
- Observability: add logs for priority-bucket candidate counts, returned prompt rows, and next-cursor bucket values so production behavior is debuggable.
- Backward compatibility: existing job SQLite files need a safe default path where missing stored priority values behave like `0`.

## Done Criteria

- Summary-mode unassessed pair selection returns prompt rows for answered-summary articles before non-summary articles from the same project, even when the summary-backed articles would previously have fallen beyond the prompt-row slice.
- Cursor progression does not skip displaced non-summary articles.
- Prompt-mode behavior stays unchanged.
- Blank or `NULL` and cross-project summary rows do not affect priority.
- Existing add-to-queue and claim-order protections continue to pass.

## Touched Layers

- server
- local SQLite job storage
- tests

## Quality Gates

- `bun test src/services/olap/duckdbOlap.test.ts`
- `bun test src/server/cron/judgmentsJobs/judgmentsJobsAddToQueue.test.ts`
- `bun run lint`
