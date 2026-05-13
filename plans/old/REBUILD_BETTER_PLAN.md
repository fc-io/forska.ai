# Rebuild Better Plan

## Implemented

### Incremental Dirty Refresh

- [x] Dirty-state schema exists for project refresh state, per-article dirty state, and article quarantine state.
- [x] Dirty article claims read claim-sized DB-side batches with `LIMIT batchSize + 1` instead of loading every dirty article before processing.
- [x] Large-scope dirty article churn stays on the dirty batch path when an active serving generation exists instead of routing to a full refresh solely because scope is large.
- [x] `refreshJudgmentFactsForProjectClaim` and article judgment refresh delete and reinsert `mart.judgment_fact` by dirty `article_id`, preserving unrelated articles and removing deleted or stale judgments for those articles.
- [x] `refreshProjectArticleMartsBatch(projectId, articleIds)` is the dirty-article mart refresh path.
- [x] Dirty article batches refresh `mart.project_scope_article` before downstream fact and serving work.
- [x] Dirty article batches delete and reinsert affected `project_id + article_id` rows in `mart.prompt_answer_fact`.
- [x] Dirty article batches append missing `app.review_answer_dictionary` values without renumbering existing answers.
- [x] Dirty article batches delete and reinsert affected `project_id + article_id` rows in `mart.review_article_rollup`.
- [x] Dirty article batches delete and reinsert affected active-generation rows in `mart.review_article_serving`, `mart.review_article_serving_detail`, and `mart.review_article_filter_member`.
- [x] Added and removed scope articles are handled for article IDs present in a dirty batch by refreshing `mart.project_scope_article` first and then deleting and reinserting downstream project/article rows.
- [x] Processed dirty article rows are completed per batch instead of waiting for the whole claim to finish before state cleanup.
- [x] Dirty articles without an active serving generation queue bounded initial setup or large rebuild work instead of falling back to `refreshProject(projectId)` from the per-article path.
- [x] Quarantined articles are durable, excluded from normal dirty claim batches, and surfaced by review warnings.

### Large Rebuild Path

- [x] Obsolete `mart.review_article_filter_row` maintenance was removed from schema, refresh code, and tests.
- [x] Large rebuild scope setup is a first-class `project_scope_article` phase with its own durable cursor.
- [x] `ProjectMartLargeRebuildPhase`, phase order, read models, admin/job/warnings progress code, and tests include the first-class scope phase.
- [x] Large rebuild materializes `mart.project_scope_article` in bounded batches before fact phases rely on frozen scope rows.
- [x] Later large rebuild phases and progress estimates read from frozen `mart.project_scope_article` after scope setup completes.
- [x] Large rebuild state stores one fixed `target_generation`, initialized from `active_generation + 1` before staging writes.
- [x] The runner carries the stored `target_generation` unchanged across phase transitions and uses it for staging writes and promotion.
- [x] Promotion sets `active_generation` to the stored `target_generation` only.
- [x] Large rebuild judgment fact work deletes and reinserts facts by frozen scoped article batches instead of deleting global `mart.judgment_fact` rows by `project_id`.
- [x] Large rebuild dictionary maintenance is bounded and append-only for missing answers; it does not reset or renumber answer IDs.
- [x] Heavy large rebuild reads and writes run on the background DuckDB queue.
- [x] Large rebuild serving finalization is a short promotion transaction.
- [x] Old-generation cleanup is separate bounded maintenance and can lag behind promotion.
- [x] Large rebuild admin and heartbeat runners have cycle-count, status stop conditions, and wall-clock wake budgets.
- [x] Large rebuild runtime diagnostics include committed row counts, rows/sec, last committed cursor, DuckDB queue wait, process RSS, and temp spill metrics.

### Queue, Cleanup, And Review Warnings

- [x] `queueProjectRefresh` and project refresh helper paths now write dirty state and/or queue large rebuild state instead of adding `project` rows to `app.mart_refresh_queue`.
- [x] Prompt and import-route project refresh helpers mark project dirty state directly instead of writing project queue rows.
- [x] Archived-project mart cleanup has a bounded batch API and an idle maintenance runner path behind old-generation cleanup.
- [x] Review warnings expose dirty counts, last processed/progress timestamps, blocking and consumer status, large rebuild progress, runtime diagnostics, and quarantined article subsets.

### Tests Added So Far

- [x] Dirty article batch tests cover one article, exact batch-sized work, multi-batch work, and large-scope bounded claim reads.
- [x] Worker tests cover large-scope dirty article routing through the dirty batch path.
- [x] Tests cover `refreshProjectArticleMartsBatch` keeping prompt-answer facts, rollups, active serving rows, details, and filter members in sync for dirty article sets.
- [x] Tests cover large rebuild scope phase progress, stored target generation, shared/global judgment fact preservation, append-only dictionary IDs, promotion without inline cleanup, bounded old-generation cleanup, and runtime diagnostics.
- [x] Tests cover project queue migration so `queueProjectRefresh` writes dirty/rebuild state without project queue rows.

## Remaining Work

Moved to `REBUILD_2_PLAN.md`.
