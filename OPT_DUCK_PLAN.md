# `/api/articlesreviews` optimization plan

Goal: make `/api/articlesreviews` fast enough for large projects, both unfiltered and filtered, and measure every optimization attempt with the same live benchmark before and after the change.

## Contract

- Keep response shape, ordering, paging, and error behavior unchanged.
- Optimize `/api/articlesreviews` first; other endpoints matter only if they block this path.
- Record benchmark results in this file before and after every optimization attempt.

## Existing test coverage

- Route-level coverage exists in `src/server/routes/projectsRoutes/projectsRoutesOlapParity.test.ts`.
- The route now has explicit tests for:
  - unfiltered request param forwarding to OLAP
  - filtered request param forwarding to OLAP
  - hydration fallback behavior
- OLAP-level parity coverage exists in `src/services/olap/duckdbOlap.test.ts`.

## Live benchmark harness

- Command:

```bash
bun run bench:articlesreviews
```

- Script:
  - `scripts/benchmarkArticlesReviews.ts`
- What it measures:
  - unfiltered `/api/articlesreviews`
  - filtered `/api/articlesreviews` with one real prompt filter auto-discovered from `/api/articlesreviewsfilters`
- Defaults:
  - project: `1f234646-34d6-458f-b455-1f6a1dca68e1`
  - page: `1`
  - limit: `10`
  - warmup runs: `1`
  - measured runs: `2`
- Override examples:

```bash
bun --env-file=.env.local scripts/benchmarkArticlesReviews.ts --iterations=3 --warmup-runs=1
bun --env-file=.env.local scripts/benchmarkArticlesReviews.ts --project-id=<id> --limit=10
bun --env-file=.env.local scripts/benchmarkArticlesReviews.ts --filter-prompt-id=<promptId> --filter-answer=<value>
```

## Baseline before new `/api/articlesreviews` optimizations

- Environment:
  - local server on `http://localhost:3004`
  - benchmark command: `bun run bench:articlesreviews`
- Filter chosen by the script:
  - prompt id: `a2d19b1f-20f5-439c-86b2-ea93776bc8fd`
  - prompt name: `healthcare`
  - answer: `yes`
- Results:
  - unfiltered average: `19132ms`
  - unfiltered min/max: `17488ms` / `20775ms`
  - filtered average: `39016ms`
  - filtered min/max: `38555ms` / `39477ms`

## Current request path

- Request enters `src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviews.ts`.
- Route calls `queryArticlesReviewsFromOlap(...)`, which lands in `src/services/olap/duckdbOlap.ts`.
- `getProjectOlapScope(projectId)` loads:
  - enabled prompts
  - project review config
  - import-route links
- If `modelId` exists, the hot path is:
  - `getDuckdbReviewedPageRowsFromRollup(...)`
  - query `mart.review_article_rollup` joined to `app.article`
  - apply project/date/search predicates
  - apply optional prompt filters through `EXISTS` against `mart.prompt_answer_fact`
  - `ORDER BY article_created_at DESC NULLS LAST, article_id ASC`
  - `LIMIT/OFFSET`
- After page article ids are fixed:
  - `getLlmJudgmentRowsFromMart(...)` fetches judgment detail from `mart.judgment_fact`
  - route runs `getReviewHydrationRows(articleIds)` for article hydration fields

## Schema architecture verdict

- The current marts are good correctness/coverage marts, but they are not ideal serving marts for `/api/articlesreviews`.
- The biggest structural issue is that the hot endpoint reads from shared global marts that are reused for many purposes.
- For `/api/articlesreviews`, the best architecture is to split marts into:
  - correctness marts used as rebuild/intermediate sources
  - serving marts shaped specifically for this endpoint
- In other words: stop trying to make one giant shared rollup solve page selection, filtering, counting, hydration, and judgment rendering at once.
- Long-term, true cursor paging is likely required for the hot path; `OFFSET` paging is acceptable for parity but scales poorly once users move past the first pages.

## Recommended serving-schema direction

- Treat `/api/articlesreviews` as its own serving workload.
- Duplicate data aggressively if it removes joins/scans on the hot path.
- Prefer project-scoped denormalization over shared global rollups for page-serving queries.
- Keep arrays/JSON out of the first-stage candidate-selection path whenever possible.
- Keep the first-stage query about article ids only; fetch detail second.

## Best materialized views / materialized tables for this endpoint

### 1. `mart.review_article_page`

- One row per `(project_id, article_id)`.
- Purpose: unfiltered page selection and unfiltered count.
- This should become the main source for unfiltered `/api/articlesreviews`.
- Suggested columns:
  - `project_id`
  - `article_id`
  - `article_created_at`
  - `article_updated_at`
  - `sort_created_key`
  - `sort_activity_key`
  - `article_title`
  - `journal_title`
  - `article_external_id`
  - `url`
  - `full_text_pdf`
  - `full_text_fetched_at`
  - `full_text_conversion_status`
  - `has_all_llm_judgments`
  - `llm_judged_prompt_count`
  - `enabled_prompt_count`
- Ordering target:
  - physically rebuild ordered by `project_id, article_created_at DESC, article_id ASC`

### 2. `mart.review_article_filter_row`

- One row per `(project_id, article_id, prompt_id, answer_value)`.
- Purpose: filtered candidate intersection for `/api/articlesreviews`.
- This should replace expensive `EXISTS` checks against the current broad prompt-answer mart.
- Suggested columns:
  - `project_id`
  - `article_id`
  - `prompt_id`
  - `answer_value`
  - `numeric_answer_value`
  - `article_created_at`
  - maybe `sort_created_key`
- Ordering target:
  - physically rebuild ordered by `project_id, prompt_id, answer_value, article_id`

### 3. `mart.review_article_judgment_detail`

- One row per `(project_id, article_id, prompt_id)`.
- Purpose: render the judgment payload for the page after candidate article ids are chosen.
- This keeps judgment rendering separate from page selection.
- Suggested columns:
  - `project_id`
  - `article_id`
  - `prompt_id`
  - `prompt_order`
  - `judgment_id`
  - `answered_original`
  - `answered_original_as_array`
  - `explanation`
  - `quotes`
  - `created_at`
  - `model_id`

### 4. `mart.review_article_filter_facet`

- One row per `(project_id, prompt_id, answer_value)`.
- Purpose: fast `/api/articlesreviewsfilters` and potentially filtered-count shortcuts.
- Suggested columns:
  - `project_id`
  - `prompt_id`
  - `answer_value`
  - `article_count`
  - `numeric_min`
  - `numeric_max`
- This is not the main page-serving mart, but it removes adjacent pressure from the filter UI.

### 5. `mart.review_article_page_cache` (optional)

- Materialized first-page or top-N cache per hot project.
- Purpose: if most real traffic is recent/unfiltered page 1.
- This is optional and should only come after the main serving marts exist.

## Why it is slow now

- `mart.review_article_rollup` is huge and shared across all projects.
- `mart.prompt_answer_fact` is also huge, and filtered requests probe it repeatedly.
- Filtered requests are much slower than unfiltered requests, which points to prompt-filter intersection work as a major cost center.
- The count/filter stage still scans large project slices before page-size reduction helps.
- The route still performs a second hydration query after the OLAP query.
- The current schema mixes candidate selection and judgment detail retrieval, so the first query still touches more data than it needs.
- Current mart sizes on this dataset:
  - `mart.review_article_rollup`: ~`139M` rows
  - `mart.prompt_answer_fact`: ~`126M` rows
  - `mart.judgment_fact`: ~`15.9M` rows

## Most likely slow spots when a project has millions of judged articles

- Unfiltered path:
  - scanning a very large `project_id` slice from `mart.review_article_rollup`
  - sorting that slice by `article_created_at DESC NULLS LAST, article_id ASC`
  - deep `OFFSET` if paging moves beyond page 1
- Filtered path:
  - everything above
  - plus repeated `EXISTS` checks into `mart.prompt_answer_fact`
  - plus large answer-set intersections before the final page is chosen
- Post-page work:
  - fetching `mart.judgment_fact` rows for the chosen page
  - extra hydration query in the route

## Optimization options

### Highest priority

- [ ] Build `mart.review_article_page` as the dedicated unfiltered serving mart.
- [ ] Build `mart.review_article_filter_row` as the dedicated filtered serving mart.
- [ ] Build `mart.review_article_judgment_detail` so judgment rendering happens only after page selection.
- [ ] Move all route hydration fields needed by `/api/articlesreviews` into `mart.review_article_page` so the route stops doing the second hydration query.
- [ ] Change `/api/articlesreviews` to a strict two-stage plan:
  - stage 1: candidate article ids from serving marts
  - stage 2: fetch only judgment detail for those page ids

### Strong candidates after that

- [ ] Add a project-local first-page mart or cache for the common unfiltered page-1 case.
- [ ] Replace `OFFSET` paging with a stable cursor for the hottest views; if external parity blocks immediate contract change, use the serving marts first and keep cursor paging as the target end-state.
- [ ] If `mart.review_article_filter_row` is still too large, add a second-level precomputed posting-list/bucket structure per `(project_id, prompt_id, answer_value)`.
- [ ] Add a project-local filtered-result cache keyed by normalized prompt-filter payload plus date/search window if the UI repeats the same requests often.

### Physical layout ideas

- [ ] Rebuild `mart.review_article_page` ordered by `project_id, article_created_at DESC, article_id`.
- [ ] Rebuild `mart.review_article_filter_row` ordered by `project_id, prompt_id, answer_value, article_id`.
- [ ] Rebuild `mart.review_article_judgment_detail` ordered by `project_id, article_id, prompt_order`.
- [ ] Split hot review-page marts from broader correctness marts so the hot path does not read unnecessary columns.
- [ ] Revisit index choices only after profiling the smaller dedicated marts.

## Measurement log

- [ ] Baseline recorded above before new `/api/articlesreviews`-specific optimizations.
- [ ] After each optimization attempt, append:
  - change name
  - benchmark command
  - unfiltered avg/min/max
  - filtered avg/min/max
  - quick interpretation

## Suggested order

- [ ] Build the dedicated unfiltered hot-path mart first.
- [ ] Re-run `bun run bench:articlesreviews` and log results here.
- [ ] Build the dedicated filtered-answer mart second.
- [ ] Re-run the same benchmark and log results here.
- [ ] Build the dedicated judgment-detail mart third.
- [ ] Re-run the same benchmark and log results here.
- [ ] Remove the extra hydration query if still meaningful.
- [ ] Re-run the same benchmark and log results here.
