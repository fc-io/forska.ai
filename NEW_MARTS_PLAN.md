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
- [ ] Benchmark on giant projects.
- [ ] Remove old dense ordinal/posting path.
