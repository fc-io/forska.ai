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

## Status now

- Implemented:
  - `app.project_review_serving_generation`
  - `mart.review_article_serving`
  - `mart.review_article_filter_member`
  - `mart.review_article_serving_detail`
- Full project refresh now writes next-generation serving/filter/detail marts and flips active generation.
- Article-delta refresh now updates serving/filter/detail marts for impacted `(project, article)` rows.
- New marts are now the primary path when present for:
  - llm list/count
  - both list/count
  - unassessed list/count/pairs
  - database/numeric filter options
  - bulk article selection
  - review details
- Old dense read fallbacks still exist in code, but old dense mart rebuild is no longer the primary runtime path.
- Backfill command now exists: `bun run db:duck:backfill-review-serving-v3`
- Warnings now treat `review_article_serving` as the ready signal.
- Generation retention/failure tests now exist.

## Current read paths now

- LLM list/count:
  - `review_article_serving + review_article_filter_member + review_article_serving_detail` primary path
  - then `candidate + filter_posting + judgment_detail`
  - then `review_article_rollup`
  - then raw `app.article + app.judgment`
- Unassessed list/count/pairs:
  - `review_article_serving` primary path
  - `review_article_rollup`
  - then raw `app.article + app.judgment`
- Review details:
  - `review_article_serving_detail`
  - then missing rows from raw `app.judgment`
- Human tab:
  - raw `app.judgment_human`
- Both tab:
  - `review_article_serving + review_article_serving_detail` for model projects
  - then `review_article_rollup`
  - raw path only when project has no model
- Database/numeric filter options:
  - `review_article_filter_member` for model projects
  - then `prompt_answer_fact`
  - raw path only when project has no model
- Bulk article selection by filter:
  - `review_article_serving + review_article_filter_member` for model projects
  - then `review_article_rollup`
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
  - current default: `article_created_at desc, article_id asc`
- Posting storage format.
  - current phase 1: exact row members in `review_article_filter_member`
  - later: compressed bitmap or chunked postings if needed
- Generation granularity.
  - per project
  - per project partition
  - per mart family
- Structural-change rebuild threshold.
- Whether exact counts block first paint or load second.

## Suggested migration path

### Phase 1 - Add new marts beside old

- Status: mostly done

- Add new serving row mart.
- Add new posting mart.
- Add generation tables.
- Backfill from current marts.

### Phase 2 - Incremental writer path

- Status: partial

- Change mart refresh queue/job model to article-delta updates first.
- Write new marts incrementally.
- Keep old marts as fallback.

### Phase 3 - Read-path cutover

- Status: mostly done

- Switch LLM review list to new serving rows + postings.
- Switch counts.
- Switch details.
- Keep old read path behind fallback flag.

### Phase 4 - Structural rebuild path

- Status: partial

- Rework full project rebuild to write new generations only.
- Remove old dense ordinal/posting path.

### Phase 5 - Cleanup

- Status: not started

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
- [x] Choose stable sort key.
- [x] Choose exact posting format.
- [x] Design new mart schemas.
- [ ] Design generation metadata + cutover rules.
- [x] Define article-delta refresh contract.
- [ ] Define structural-change rebuild contract.
- [x] Implement new marts.
- [x] Backfill new marts from current state.
- [x] Switch LLM list read path.
- [x] Switch filter/count read path.
- [x] Switch review detail read path.
- [ ] Add queue/debug visibility for new refresh model.
- [x] Write parity tests for llm/human/both/unassessed against old vs new marts.
- [ ] Write degraded-path tests for no-mart / partial-mart states.
- [x] Write generation cutover tests.
- [ ] Write incremental update tests for article/scope/prompt/model changes.
- [ ] Write posting exactness tests.
- [x] Write bulk-selection/export parity tests.
- [ ] Write large-project perf smoke tests.
- [ ] Benchmark on giant projects.
- [x] Remove old dense ordinal/posting path from runtime rebuilds.

## Still missing

- Human tab is still raw-table based.
- No dedicated automatic/on-startup backfill job yet.
- Structural-change rebuild rules are not fully formalized.
- Generation rollback/cutover/cleanup hardening is not finished.
- Old dense read fallback code still exists.
- Explicit degraded-path behavior is still weaker than it should be.
- Perf smoke/benchmark coverage is still missing.
