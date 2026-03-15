# DuckDB optimization ideas

Goal: reduce review/query latency on large projects without spending time optimizing admin-only paths.

## Current state

- review endpoints work end-to-end on native DuckDB marts
- large-project review endpoints are still roughly 20s+
- admin-path performance is explicitly out of scope unless it blocks correctness

## Likely bottlenecks

- `mart.review_article_rollup` is still very large and project scans are expensive
- `mart.prompt_answer_fact` is huge and filter queries still touch a lot of rows
- some request paths still do extra hydration work after the main OLAP query
- marts are optimized for correctness/coverage more than project-local pruning

## Highest-value ideas

- [ ] Add smaller project-scoped marts for the hottest review pages instead of scanning shared global marts.
- [ ] Add a project-level reviewed/unassessed summary mart so count endpoints avoid full per-request aggregation.
- [ ] Add precomputed filter facets/counts per project+prompt so `/api/articlesreviewsfilters` stops scanning `mart.prompt_answer_fact`.
- [ ] Store per-project prompt completion state in a dedicated mart keyed by `(project_id, article_id)` for faster `llm` / `both` / `unassessed` decisions.

## Physical layout ideas

- [ ] Rebuild hot marts ordered by `project_id` plus the main sort column (`article_created_at` or activity timestamp) to improve pruning.
- [ ] Split very large marts by concern instead of one wide shared table when a query only needs one subset.
- [ ] Revisit indexes only after profiling; favor layout and smaller marts first.

## Query-shape ideas

- [ ] Push article hydration fields needed by review pages directly into the hot mart path when that removes extra joins/lookups.
- [ ] Avoid reading full judgment detail rows until after the page of article ids is fixed.
- [ ] Precompute answer-normalization/facet rows once; avoid repeating per-request parsing or `EXISTS` checks over massive tables.

## Refresh strategy

- [ ] Keep incremental refresh for normal writes.
- [ ] Keep chunked full rebuilds only for import, repair, and schema changes.
- [ ] If new smaller marts are added, refresh them from the same queue so writes stay single-owner and explicit.

## Suggested order

- [ ] Profile the slowest live endpoint and confirm which mart dominates time.
- [ ] Build a project-scoped summary mart for reviews/count/unassessed first.
- [ ] Build precomputed filter facets second.
- [ ] Re-measure before changing any lower-value admin or background paths.
