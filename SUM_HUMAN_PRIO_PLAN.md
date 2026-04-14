# Summary Human Priority Plan

## Goal

- For future queue top-ups only, make `judgmentsJobsAddToQueue` prioritize fetched prompt rows for articles that already have a non-empty row in `app.judgment_human_summary` when the project is in `humanJudgmentMode = 'summary'`.
- Keep the existing prompt-mode human-first behavior unchanged.
- Make that priority visible in actual SQLite ready-claim order for newly inserted rows, not just in the array passed into `addReadyPrompts`.
- Keep existing scan cursor semantics and do not reshuffle rows already queued in local SQLite.

## Core Decision

- Keep priority at the add-to-queue boundary, not in OLAP candidate ordering.
- Reuse the current stable partition approach from the prompt-mode human-first change.
- Make the priority signal mode-aware:
  - Treat `NULL` `humanJudgmentMode` as `'prompt'` to preserve existing behavior.
  - prompt mode: `app.judgment_human.is_answered = TRUE` on the exact `(article_id, prompt_id)` pair
  - summary mode: non-empty `app.judgment_human_summary.answer` on `(project_id, article_id)`, prioritizing all fetched prompt rows for that article within the fetched window
- Use summary answer presence, not `origin`, as the signal.
- Ignore `app.judgment_assessment` for this change.

## Why Here

- `judgmentsJobsAddToQueue` already fetches more prompt pairs than it can insert and then trims with `addReadyPrompts(..., readyDeficit)`.
- That keeps the change small and avoids touching OLAP ordering, mart refresh logic, and scan cursor behavior.
- Summary-mode human completeness already means "has a non-empty summary answer" in the review flows, so queue priority should use the same signal.

## Scope Now

- Server only.
- Files likely touched:
  - `src/server/cron/judgmentsJobs/judgmentsJobsAddToQueue.ts`
  - `src/server/cron/judgmentsJobs/judgmentsJobsAddToQueue.test.ts`
- Touched layers: server, tests.

## Implementation Order

1. Extend job config lookup in `judgmentsJobsAddToQueue.ts`.
   - Include `humanJudgmentMode` alongside the existing model and content settings.
   - Branch the human-priority lookup off `humanJudgmentMode ?? 'prompt'` instead of assuming prompt-level human rows.
2. Add a summary-mode priority helper.
   - Input: fetched, post-filter prompt entries plus `projectId`.
   - Query `app.judgment_human_summary` in batches of `article_id` values.
   - Match only `project_id = job.projectId`.
   - Treat only non-empty answers as priority candidates: `NULLIF(TRIM(COALESCE(answer, '')), '') IS NOT NULL`.
   - Return the matching article ids so every fetched prompt row for those articles can be prioritized within the fetched window.
3. Apply stable prioritization before SQLite insertion.
   - Keep the current prompt-mode pair-level priority behavior.
   - In summary mode, partition fetched rows into `summaryHumanFirst` and `rest` by article id.
   - Preserve original order within both groups.
   - Continue passing the reordered rows into `addReadyPrompts` so existing SQLite FIFO behavior remains the tiebreaker for newly inserted rows.
4. Keep existing guards and filtering intact.
   - `filterAlreadyJudged` must still remove rows with matching LLM judgments before any priority step.
   - Local SQLite judged filtering must still run before insertion.
   - Existing ready rows must still claim before newly inserted rows.
5. Add focused tests.
   - Prompt-mode tests continue to pass unchanged.
   - New top-up test: an article with an answered human summary appearing later in the fetched window is claimed first when the ready deficit is smaller than the window.
   - New top-up test: all fetched prompt rows for an article with an answered human summary move to the front of the fetched candidate list, not just one prompt.
   - New top-up test: `NULL` or blank summary answers do not get priority.
   - New top-up test: summary rows from another project do not affect prioritization.
   - New top-up test: already-judged and locally-judged rows are still filtered out even if the article has an answered human summary.
   - New top-up test: multiple promoted summary-backed articles preserve their original relative order.

## Not Now

- No OLAP candidate ordering changes.
- No DuckDB mart or app schema changes.
- No full project-wide reorder beyond the fetched top-up window.
- No ranking by human answer recency.
- No special weighting by summary answer value (`yes`, `no`, `maybe`).
- No reshuffling of rows already in `status = 'ready'`.

## Behavior Notes

- This remains window-local priority, not a global reprioritization of the whole project.
- In summary mode, the signal is article-level, but the queue remains prompt-level, so prioritizing an article with an answered human summary moves each of its fetched missing prompt rows to the front of that window before the existing `readyDeficit` cap is applied.
- Partially LLM-judged articles with an answered human summary stay eligible; only the still-missing prompt rows are queued and prioritized within the fetched window.
- This change complements the existing summary-mode review semantics where human completeness is based on summary-answer presence.

## Done Criteria

- For summary-mode projects, future queue top-ups insert and claim fetched prompt rows for articles with answered human summaries before non-summary rows from the same fetched window, subject to the existing `readyDeficit` cap.
- Prompt-mode projects keep the current pair-level human-first behavior.
- Blank or `NULL` summary rows do not affect priority.
- Cross-project summary rows do not affect priority.
- Existing already-judged and locally-judged filtering still pass.
- Existing ready rows keep their current order.

## Touched Layers

- server
- tests

## Quality Gates

- `bun test src/server/cron/judgmentsJobs/judgmentsJobsAddToQueue.test.ts`
- `bun test src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM/getAndUpdateReadyPrompts.test.ts`
- `bun run lint`
