# New marts plan

## Assumptions

- Review UX must feel fast on very large projects too, incl 10M+ scoped articles.
- Filtering large projects must feel fast.
- First page must feel fast.
- Exact results matter. No approximate filter results.
- Exact counts still matter, but can load after rows if needed.
- Keep marts. We want precomputed serving data, not raw-table scans for normal review UX.
- Do not rebuild whole project marts for ordinary article/judgment changes.
- Update/index only touched project+article state when possible.
- Full rebuild only for structural project changes: prompt set, model, scope rules, import routes, maybe large backfills.
- Refresh work must not block normal DB-backed requests.
- No partial broken read state. Readers should see one consistent generation.
- Giant projects must not starve smaller queued work.

## Current problem

- Current project refresh rewrites whole-project marts.
- Dense serving structures make tiny changes expensive.
- Biggest blockers:
  - `app.project_article_ordinal`
  - `mart.review_article_filter_posting`
  - read path coupled to `article_seq` / `article_seq_list`
- Result: huge projects make queue slow, refresh expensive, request pressure high.

## Current read paths today

- LLM list/count:
  - `candidate + filter_posting + judgment_detail` fast path
  - then `review_article_rollup`
  - then raw `app.article + app.judgment`
- Unassessed list/count/pairs:
  - `review_article_rollup`
  - then raw `app.article + app.judgment`
- Review details:
  - `review_article_judgment_detail`
  - then missing rows from raw `app.judgment`
- Human tab:
  - raw `app.judgment_human`
- Both tab:
  - `review_article_rollup` for model projects
  - raw path only when project has no model
- Database/numeric filter options:
  - `prompt_answer_fact` for model projects
  - raw path only when project has no model
- Bulk article selection by filter:
  - `review_article_rollup` for model projects
  - raw path only when project has no model

## Current fallback today

- Yes:
  - LLM list/count
  - unassessed list/count/pairs
  - review details partial hydration
- No or weak:
  - both tab for normal model projects
  - model-project filter option building
  - bulk article selection/export on model projects
- New marts should keep fast exact reads, but also keep a clear degraded path while backfill/indexing is incomplete.

## Direction

- Target: true incremental serving marts.
- Also add exact bitmap-style postings.
- Also use generation-based cutover.

## Core idea

- Replace dense global `article_seq` serving model with stable per-article serving keys.
- Maintain exact per `(project_id, article_id)` serving rows incrementally.
- Maintain exact per `(project_id, prompt_id, answer)` filter postings incrementally.
- Build changes into next generation; flip active generation atomically.

## New serving shape

### 1. Stable article serving row

- One exact row per `(project_id, article_id)`.
- Holds what current `review_article_rollup` + `review_article_candidate` jointly hold.
- Add stable sort key, not dense ordinal.
- Sort key should support current browse order directly.
- Example: `(article_created_at desc, article_id asc)` or a persisted encoded key.

### 2. Exact prompt-answer postings

- Replace `article_seq_list` arrays.
- Store exact compressed posting sets per `(project_id, prompt_id, answer_id)`.
- Candidate filtering = intersect posting sets, then join to article serving rows.
- Keep exact counts from posting cardinality or from serving rows after intersection.

### 3. Exact judgment/detail mart

- Keep incremental per `(project_id, article_id, prompt_id)` detail mart.
- Hydrate details from this mart, not from rebuild-only project snapshots.

### 4. Generation table / active pointer

- Writes go to next generation.
- Reads use active generation only.
- Cutover = atomic generation flip.
- Old generation cleanup async.

## Write/update flow

### Normal article/judgment change

- Refresh global article judgment fact for touched article.
- Resolve impacted projects.
- For each impacted project:
  - recompute scope state for touched article only
  - recompute per-article serving row only
  - recompute prompt-answer facts only for touched article
  - update affected posting sets only for touched prompts/answers
  - update detail mart only for touched article
- Publish next generation for touched project partition/chunk.

### Structural project change

- Prompts changed
- Model changed
- Content config changed
- Import routes changed
- Curated article membership bulk changed
- These can trigger scoped rebuild by partition or full project rebuild.

## Read flow

- Browse list:
  - get candidate article ids from postings or serving row scan
  - order by stable sort key
  - page by keyset/cursor, not dense ordinal
- Count:
  - exact from posting cardinality or exact count query on serving rows
- Details:
  - hydrate from detail mart
- Warnings/indexing:
  - show queued + processing by project/article delta jobs, not only full rebuild jobs

## Why this is better

- Small article change does small write work.
- Huge projects still have full exact marts.
- Fast filter UX remains possible.
- No dense renumbering after ordinary updates.
- No giant `article_seq_list` rewrites.
- Better fit for 10M+ projects.

## Main design choices to settle

- Stable sort key format.
- Posting storage format.
  - compressed bitmap
  - chunked sorted ids
  - another exact set format
- Generation granularity.
  - per project
  - per project partition
  - per mart family
- Structural-change rebuild threshold.
- Whether exact counts block first paint or load second.

## Suggested migration path

### Phase 1 - Add new marts beside old

- Add new serving row mart.
- Add new posting mart.
- Add generation tables.
- Backfill from current marts.

### Phase 2 - Incremental writer path

- Change mart refresh queue/job model to article-delta updates first.
- Write new marts incrementally.
- Keep old marts as fallback.

### Phase 3 - Read-path cutover

- Switch LLM review list to new serving rows + postings.
- Switch counts.
- Switch details.
- Keep old read path behind fallback flag.

### Phase 4 - Structural rebuild path

- Rework full project rebuild to write new generations only.
- Remove old dense ordinal/posting path.

### Phase 5 - Cleanup

- Delete `project_article_ordinal` if no longer needed.
- Delete old `review_article_candidate` / old posting shape if replaced.
- Remove fallback query paths.

## Risks

- Exact incremental postings are the hardest part.
- Generation flip + cleanup must be correct.
- Query planner behavior on very large posting intersections must be profiled.
- Dual-write migration period adds complexity.

## Test gaps to close

- Add parity tests for every list type:
  - llm
  - human
  - both
  - unassessed
- Add parity tests for every read mode:
  - new marts
  - old marts
  - no marts / degraded fallback
- Add tests for exact parity between old and new results:
  - row ids
  - ordering
  - counts
  - prompt filters
  - date filters
  - search filters
- Add tests for review detail hydration parity:
  - full detail mart present
  - partial detail mart present
  - detail mart absent
- Add tests for bulk selection parity:
  - llm
  - both
  - unassessed
  - export/add-to-project style flows
- Add tests for filter-option parity:
  - database filters
  - numeric filters
  - empty-state behavior while indexing incomplete
- Add tests for incremental writes:
  - article changed
  - article enters scope
  - article leaves scope
  - prompt enabled/disabled
  - model/config change
  - import-route change
- Add tests for generation behavior:
  - readers never see mixed generations
  - cutover atomic
  - rollback to previous generation possible
  - old generation cleanup safe
- Add tests for postings correctness:
  - exact intersections
  - exact counts
  - deletions/tombstones
  - duplicate answers / multi-answer judgments
- Add tests for queue/drain behavior:
  - article delta does not trigger full rebuild unless required
  - giant project does not starve smaller project forever
  - DB-backed requests stay responsive during refresh
- Add one large-project perf smoke test:
  - fast first page
  - fast filtered first page
  - exact count eventually returns

## Todo checklist

- [ ] Freeze assumptions/product rules for large-project review UX.
- [ ] Choose stable sort key.
- [ ] Choose exact posting format.
- [ ] Design new mart schemas.
- [ ] Design generation metadata + cutover rules.
- [ ] Define article-delta refresh contract.
- [ ] Define structural-change rebuild contract.
- [ ] Implement new marts behind feature flag.
- [ ] Backfill new marts from current state.
- [ ] Switch LLM list read path.
- [ ] Switch filter/count read path.
- [ ] Switch review detail read path.
- [ ] Add queue/debug visibility for new refresh model.
- [ ] Write parity tests for llm/human/both/unassessed against old vs new marts.
- [ ] Write degraded-path tests for no-mart / partial-mart states.
- [ ] Write generation cutover tests.
- [ ] Write incremental update tests for article/scope/prompt/model changes.
- [ ] Write posting exactness tests.
- [ ] Write bulk-selection/export parity tests.
- [ ] Write large-project perf smoke tests.
- [ ] Benchmark on giant projects.
- [ ] Remove old dense ordinal/posting path.

## Weak or missing today

- LLM list/count has layered fallback today.
- Unassessed has layered fallback today.
- Review details has partial fallback today.
- Human tab is raw-table based today.
- Both tab lacks a strong degraded path for normal model projects.
- Model-project database/numeric filter options are mart-dependent today.
- Model-project bulk article selection/export is mart-dependent today.
- New marts rollout needs explicit degraded-path behavior, not just happy-path parity.
