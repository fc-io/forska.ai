# `/api/articlesreviews` optimization plan

Goal: make `/api/articlesreviews` fast enough for large projects, both unfiltered and filtered, and measure every optimization attempt with the same live benchmark before and after the change.

## Contract

- Keep response shape, ordering, paging, and error behavior unchanged.
- Optimize `/api/articlesreviews` first; other endpoints matter only if they block this path.
- Record benchmark results in this file before and after every optimization attempt.

## UI direction

- Replace page-number pagination for `/api/articlesreviews` with cursor-first browsing.
- Remove `Go to page N` from the reviews list UX.
- Prefer `Load more` as the primary interaction instead of numbered paging.
- `Previous` / `Next` can remain only as a compatibility bridge while the UI moves to `Load more`, but the target end-state is cursor + append, not random page jumps.

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
- Deep-page baseline before cursor/serving-mart changes:
  - benchmark command: `bun --env-file=.env.local scripts/benchmarkArticlesReviews.ts --page=1000 --iterations=1 --warmup-runs=0`
  - unfiltered page 1000: `16215ms`
  - filtered page 1000: `38331ms`

## Current request path

- Request enters `src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviews.ts`.
- Route calls `queryArticlesReviewsFromOlap(...)`, which lands in `src/services/olap/duckdbOlap.ts`.
- `getProjectOlapScope(projectId)` loads:
  - enabled prompts
  - project review config
  - import-route links
- If `modelId` exists, the hot path is:
  - serving-v2 path when the project has the newer serving marts:
    - candidate selection from `mart.review_article_candidate`
    - display hydration from `mart.review_article_display`
    - filtered candidate intersection through `app.review_answer_dictionary` + `mart.review_article_filter_posting`
    - cursor navigation for normal browsing; compatibility `LIMIT/OFFSET` fallback still exists if callers insist on direct page-number jumps
    - page judgment rows from `mart.review_article_judgment_detail`
  - fallback path for projects without serving-mart rows:
    - `getDuckdbReviewedPageRowsFromRollup(...)`
    - query `mart.review_article_rollup` joined to `app.article`
    - apply project/date/search predicates
    - apply optional prompt filters through `EXISTS` against `mart.prompt_answer_fact`
    - `ORDER BY article_created_at DESC NULLS LAST, article_id ASC`
    - `LIMIT/OFFSET`
- After page article ids are fixed:
  - serving-v2 path fetches judgment detail from `mart.review_article_judgment_detail`
  - route no longer runs `getReviewHydrationRows(articleIds)` for serving-mart-backed responses

## Schema architecture verdict

- The current marts are good correctness/coverage marts, but they are not ideal serving marts for `/api/articlesreviews`.
- The biggest structural issue is that the hot endpoint reads from shared global marts that are reused for many purposes.
- For `/api/articlesreviews`, the best architecture is to split marts into:
  - correctness marts used as rebuild/intermediate sources
  - serving marts shaped specifically for this endpoint
- In other words: stop trying to make one giant shared rollup solve page selection, filtering, counting, hydration, and judgment rendering at once.
- Long-term, true cursor paging is required for the hot path; the unfiltered path now supports cursors, but direct page jumps still use the compatibility `OFFSET` fallback.

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
- Current implementation is a compatibility shim. The newer serving-v2 path mostly supersedes it with `candidate` + `display` marts.
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
- Current implementation is a slim project/article/prompt/answer serving mart with numeric cast support.

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
- Current implementation is active for `/api/articlesreviews`.

### 3b. `mart.review_article_judgment_payload`

- One row per `(project_id, judgment_id)`.
- Purpose: hold large/rarely-needed payload columns separately when the UI can lazy-load them.
- Candidate columns:
  - `project_id`
  - `judgment_id`
  - `explanation`
  - `quotes`
  - optional future large payload fields
- Goal:
  - keep the hot page-render path narrow
  - fetch the heavy payload only when the user expands/details a row
- Current implementation exists and is populated; the list path no longer needs explanation/quotes.

### 6. `mart.review_article_candidate`

- One row per `(project_id, article_id)`.
- Purpose: the narrowest possible article-id candidate set for page selection.
- Candidate columns:
  - `project_id`
  - `article_id`
  - `article_created_at`
  - `article_updated_at`
  - `has_all_llm_judgments`
  - `enabled_prompt_count`
  - `llm_judged_prompt_count`
- Goal:
  - let page selection touch the smallest possible serving table
- Current implementation is active for `/api/articlesreviews` when serving-v2 rows exist.

### 7. `mart.review_article_display`

- One row per `(project_id, article_id)`.
- Purpose: display-only fields for the chosen page ids.
- Candidate columns:
  - `project_id`
  - `article_id`
  - `article_title`
  - `journal_title`
  - `article_external_id`
  - `url`
  - `full_text_pdf`
  - `full_text_fetched_at`
  - `full_text_conversion_status`
- Goal:
  - split display fields away from candidate selection fields
- Current implementation is active for `/api/articlesreviews` when serving-v2 rows exist.

### 8. `mart.review_article_filter_posting`

- One row per `(project_id, prompt_id, answer_key)`.
- Purpose: compressed posting-list or bitset structure for filtered candidate intersection.
- Candidate columns:
  - `project_id`
  - `prompt_id`
  - `answer_key`
  - `article_seq_list` or compressed bitmap payload
  - `article_count`
- Goal:
  - intersect small precomputed sets instead of scanning row-per-answer structures
- Current implementation stores project-local posting lists keyed by `(project_id, prompt_id, answer_id)` and is active for serving-v2 filtered queries.

### 9. `app.project_article_ordinal`

- One row per `(project_id, article_id)` with a dense `article_seq`.
- Purpose: stable per-project integer ordinals so serving marts and posting lists do not rely on UUID strings.
- Candidate columns:
  - `project_id`
  - `article_id`
  - `article_seq`
- Goal:
  - make bitset/posting-list structures practical and compact
- Current implementation is active and feeds the filtered posting lists.

### 10. `app.review_answer_dictionary`

- One row per `(project_id, prompt_id, answer_id)`.
- Purpose: replace repeated answer strings in serving/filter marts with compact ids.
- Candidate columns:
  - `project_id`
  - `prompt_id`
  - `answer_id`
  - `answer_value`
- Goal:
  - reduce width in filtered serving structures
  - make posting-list keys compact
- Current implementation is active and feeds the filtered posting lists.

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

- [x] Build `mart.review_article_page` as the dedicated unfiltered serving mart.
- [x] Build `mart.review_article_filter_row` as the first filtered serving mart.
- [x] Build `mart.review_article_judgment_detail` so judgment rendering happens only after page selection.
- [x] Move all route hydration fields needed by `/api/articlesreviews` into serving-mart-backed queries so the route stops doing the second hydration query.
- [ ] Change `/api/articlesreviews` to a strict two-stage plan:
  - stage 1: candidate article ids from serving marts
  - stage 2: fetch only judgment detail for those page ids

### Strong candidates after that

- [ ] Add a project-local first-page mart or cache for the common unfiltered page-1 case.
- [x] Finish the cursor cutover in callers so normal review browsing stops depending on direct page-number `OFFSET` jumps.
- [x] If `mart.review_article_filter_row` is still too large, add a second-level precomputed posting-list/bucket structure per `(project_id, prompt_id, answer_value)`.
- [ ] Add a project-local filtered-result cache keyed by normalized prompt-filter payload plus date/search window if the UI repeats the same requests often.
- [ ] Split `mart.review_article_page` into a narrower `candidate` mart and a separate `display` mart if candidate selection is still reading too much data.
- [x] Move large judgment payload fields (`explanation`, `quotes`) into a lazy-loaded `mart.review_article_judgment_payload` if page rendering still reads more than it needs.
- [x] Introduce per-project article ordinals and answer dictionaries if UUID/string-heavy marts remain too wide.
- [x] Replace row-per-answer filter marts with project-local posting-list/bitset structures when filtered query cost stops being dominated by simple row scans.

## Obvious cons / tradeoffs

- [ ] More marts means more write amplification and more refresh orchestration.
- [ ] Narrower marts plus payload splitting reduce hot-path cost, but add more codepaths and more opportunities for stale/partial refresh bugs.
- [ ] Lazy-loading judgment payloads improves list performance, but adds extra UI/API round-trips and slightly more complex row-expansion behavior.
- [ ] Project-local ordinals are powerful, but they add another mapping table that must stay stable across rebuilds and refreshes.
- [ ] Answer dictionaries save space, but introduce translation layers and migration complexity.
- [ ] Posting lists / bitsets can be extremely fast for filtered queries, but are substantially harder to build, debug, and refresh incrementally than row-based marts.
- [ ] Full cursor-only UX is faster, but loses easy direct page-number jumps unless the UI is redesigned around sequential navigation.

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

### Change 1 - slim `mart.review_article_page` for unfiltered candidate selection

- Scope:
  - added a slim unfiltered serving mart
  - switched unfiltered `/api/articlesreviews` and unfiltered count to use it when rows exist
  - added optional cursor support for the unfiltered path
  - kept filtered `/api/articlesreviews` on the old shared-mart path for now
- Notes:
  - because disk space is extremely tight, the slim serving mart was only rebuilt for the benchmark project so far
  - the code falls back to the older path if a project has no rows in `mart.review_article_page`
  - the slim mart only stores ordering/completeness/title data; hydration still comes from the existing article query
- Benchmark command:

```bash
bun --env-file=.env.local scripts/benchmarkArticlesReviews.ts --mode=unfiltered --iterations=3 --warmup-runs=2
bun --env-file=.env.local scripts/benchmarkArticlesReviews.ts --mode=unfiltered --page=1000 --iterations=1 --warmup-runs=0
```

- Results after change:
  - unfiltered page 1 average after warmup: `384ms`
  - unfiltered page 1 min/max after warmup: `381ms` / `386ms`
  - unfiltered page 1000 via page-number fallback: `22354ms`
- Comparison to baseline:
  - unfiltered page 1 improved from `19132ms` to `384ms`
  - direct page-number deep paging is still slow because it still falls back to `OFFSET`
- Interpretation:
  - the unfiltered hot path was dominated by the shared rollup scan, not by judgment-detail fetches
  - a slim serving mart gives an immediate order-of-magnitude improvement even before filtered-path work
  - filtered `/api/articlesreviews` is still the next bottleneck and still needs its own serving mart
  - the next real win for unfiltered deep pages is to finish the cursor cutover in callers so they stop using page-number fallback

### Change 2 - filtered serving mart plus cursor-driven caller flow for unfiltered navigation

- Scope:
  - added `mart.review_article_filter_row`
  - switched filtered `/api/articlesreviews` to use `mart.review_article_page` + `mart.review_article_filter_row` when rows exist
  - updated the reviews table caller flow to use cursor-driven next/previous navigation for unfiltered pages and hide direct page jumps there
  - added benchmark support for sequential cursor navigation via `--cursor-steps`
- Benchmark command:

```bash
bun run bench:articlesreviews
bun --env-file=.env.local scripts/benchmarkArticlesReviews.ts --mode=unfiltered --cursor-steps=5 --iterations=1 --warmup-runs=0
```

- Results after change:
  - unfiltered page 1 average: `399ms`
  - unfiltered page 1 min/max: `387ms` / `410ms`
  - filtered page 1 average: `590ms`
  - filtered page 1 min/max: `577ms` / `604ms`
  - sequential unfiltered cursor navigation over 5 requests: `880ms` average per request
- Comparison to earlier measurements:
  - unfiltered page 1 stayed in the sub-second range after the filtered-mart work
  - filtered page 1 improved from `39016ms` to `590ms`
  - sequential cursor navigation is now consistently sub-second per request, unlike deep page-number fallback
- Interpretation:
  - filtered prompt-answer intersection was the second major bottleneck, and the slim filter-row mart removes most of that cost
  - cursor navigation gives the intended deep-page behavior for unfiltered browsing without relying on large `OFFSET` scans
  - direct page-number deep jumps are still a compatibility fallback and remain expensive until fully removed from callers

### Change 3 - project-scoped judgment detail mart for page rendering

- Scope:
  - added `mart.review_article_judgment_detail`
  - switched serving-mart-backed `/api/articlesreviews` requests to fetch page judgment detail from the project-scoped detail mart instead of the broader global judgment fact mart
- Benchmark command:

```bash
bun --env-file=.env.local scripts/benchmarkArticlesReviews.ts --mode=unfiltered --iterations=3 --warmup-runs=2
bun --env-file=.env.local scripts/benchmarkArticlesReviews.ts --mode=filtered --iterations=2 --warmup-runs=1
bun --env-file=.env.local scripts/benchmarkArticlesReviews.ts --mode=unfiltered --cursor-steps=5 --iterations=1 --warmup-runs=0
```

- Results after change:
  - unfiltered page 1 average: `752ms`
  - unfiltered page 1 min/max: `515ms` / `983ms`
  - filtered page 1 average: `1011ms`
  - filtered page 1 min/max: `996ms` / `1027ms`
  - sequential unfiltered cursor navigation over 5 requests: `560ms` average per request
- Comparison to earlier measurements:
  - unfiltered page 1 is still far faster than baseline, but this run was slower than Change 2's warmed page-1 run
  - filtered page 1 is still far faster than baseline, but this run was slower than Change 2's filtered run
  - sequential cursor navigation improved from `880ms` to `560ms` average per request
- Interpretation:
  - the judgment-detail mart helps the repeated cursor-navigation path more than the single page-1 path
  - there is visible benchmark variance between runs, so the next changes should be measured multiple times before drawing hard conclusions
  - the remaining largest structural gap is still the heavy fallback/compatibility behavior around page-number paging and route hydration

### Change 4 - remove the extra route hydration query for serving-mart-backed reviews

- Scope:
  - changed the serving-mart page query to join `app.article` only for the already paged rows
  - `/api/articlesreviews` now skips `getReviewHydrationRows(...)` when the OLAP layer already returns the needed article fields
  - added a route test that verifies the hydration query is skipped when article fields are already present
- Benchmark command:

```bash
bun run bench:articlesreviews
bun --env-file=.env.local scripts/benchmarkArticlesReviews.ts --mode=unfiltered --cursor-steps=5 --iterations=1 --warmup-runs=0
```

- Results after change:
  - unfiltered page 1 average: `542ms`
  - filtered page 1 average: `951ms`
  - sequential unfiltered cursor navigation over 5 requests: `689ms` average per request
- Comparison to earlier measurements:
  - unfiltered page 1 stayed comfortably sub-second
  - filtered page 1 stayed around the 1-second mark
  - sequential cursor navigation remained sub-second but did not improve versus the prior run
- Interpretation:
  - removing the extra hydration query simplifies the serving path and removes one round-trip/query step
  - the remaining performance ceiling is now much more about serving-mart shape and request-pattern variance than about route hydration

### Change 5 - serving-v2 split marts plus posting-list filter path

- Scope:
  - added `app.project_article_ordinal`
  - added `app.review_answer_dictionary`
  - added `mart.review_article_candidate`
  - added `mart.review_article_display`
  - added `mart.review_article_filter_posting`
  - added `mart.review_article_judgment_payload`
  - switched `/api/articlesreviews` to use the new serving-v2 path when those rows exist
  - serving-v2 filtered queries now resolve answer ids from the dictionary and intersect posting lists instead of scanning row-per-answer filter rows
- Benchmark command:

```bash
bun run bench:articlesreviews
bun --env-file=.env.local scripts/benchmarkArticlesReviews.ts --mode=unfiltered --cursor-steps=5 --iterations=1 --warmup-runs=0
```

- Results after change:
  - unfiltered page 1 average: `315ms`
  - unfiltered page 1 min/max: `313ms` / `316ms`
  - filtered page 1 average: `520ms`
  - filtered page 1 min/max: `497ms` / `543ms`
  - sequential unfiltered cursor navigation over 5 requests: `421ms` average per request
- Comparison to earlier measurements:
  - unfiltered page 1 improved from `542ms` to `315ms`
  - filtered page 1 improved from `951ms` to `520ms`
  - sequential cursor navigation improved from `689ms` to `421ms`
- Interpretation:
  - splitting candidate/display concerns and using project-local posting lists gave another strong step down in latency
  - the posting-list approach is now clearly better than the row-per-answer filtered mart for the benchmark project
  - the remaining likely gains are now more incremental unless we add first-page caches or a filtered-result cache

## Suggested order

- [ ] Build the dedicated unfiltered hot-path mart first.
- [ ] Re-run `bun run bench:articlesreviews` and log results here.
- [x] Finish the cursor-only client flow for the unfiltered path and benchmark sequential cursor navigation.
- [x] Build the dedicated filtered-answer mart second.
- [x] Re-run the same benchmark and log results here.
- [x] Build the dedicated judgment-detail mart third.
- [x] Re-run the same benchmark and log results here.
- [x] Remove the extra hydration query if still meaningful.
- [x] Re-run the same benchmark and log results here.
- [x] Build project-local ordinals, answer dictionaries, candidate/display marts, posting lists, and payload mart.
- [x] Re-run the same benchmark and log results here.
