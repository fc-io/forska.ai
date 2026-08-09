# Lazy Review-Serving Readiness Plan

Date: 2026-08-01

## Goal

Make review-serving rebuilds prepare the default review experience eagerly, while
building expensive filtered, detail, and secondary-workflow surfaces only when a
read or job asks for them.

For project `9e25a18e-ad15-4d34-b999-608902e6d7a1`
(`cov | GPT 5.5 xhigh | 5`), current posting state is entirely
`promptAnswer` buckets:

- 18,784 scoped articles
- 6 enabled prompts
- 1 active/candidate snapshot
- 16,838 physical posting rows
- about 12.99M article references inside `article_ids` arrays

## Default Eager Path

Keep these ready immediately after rebuild:

- default LLM/Human/Both article lists
- unassessed queue and counts
- base display and selected-import ordering
- exact tab totals needed before filters are applied
- summary/count surfaces that the unfiltered review page needs

Default readiness/API contract:

- The first unfiltered review page load, default LLM/Human/Both tab reads,
  unassessed list/count reads, default tab-total reads, and default summary
  reads must be ready before the rebuild is considered default-ready.
- Those default routes/API calls must read only eager default surfaces.
- They must not trigger or wait on `promptAnswer` postings, detail hydration
  payloads, queue prompt-pair payloads, or prompt-derived facet/filter-option
  lazy work.

Do not eagerly build these optional surfaces unless the UI, API, or job asks for
them:

- `promptAnswer x prompt id x answer x list mode` postings
- judgment input/detail hydration payloads
- queue prompt-pair payload expansion
- prompt-derived summary/facet/filter-option work not needed for the unfiltered
  review page

## Complexity Picture

Previous full all-component estimate for this project:

| Component | Previous row-equivalent estimate |
| --- | ---: |
| Posting | 751,360 |
| Summary | 525,952 |
| Queue | 244,192 |
| LLM status | 225,408 |
| Human status | 262,976 |
| Judgment input content | 262,976 |
| Display | 75,136 |
| Selected import | 75,136 |
| Project scope | 18,784 |
| Search | 18,784 |
| Total | 2,460,704 |

Staged lazy default estimate:

| Scenario | Deferred work | Default estimate | Reduction |
| --- | ---: | ---: | ---: |
| Current eager rebuild | 0 | 2,460,704 | baseline |
| Stage 1: lazy `promptAnswer` postings | 751,360 | 1,709,344 | 30.5% |
| Stage 1 + lazy judgment detail payload | 1,014,336 | 1,446,368 | 41.2% |
| Stage 1 + lazy queue prompt payload | 976,768 | 1,483,936 | 39.7% |
| Stage 1 + lazy prompt-derived summary | 1,202,176 | 1,258,528 | 48.9% |
| Stages 1-3 combined | 1,690,560 | 770,144 | 68.7% |

On-demand filtered read estimate:

| First filtered request | Approximate scan/work shape |
| --- | ---: |
| one prompt, one list mode | `18,784 x 1 x 2` = 37,568 row-equivalents |
| one prompt, `llm` + `both` | `18,784 x 1 x 4` = 75,136 row-equivalents |
| all 6 prompts, `llm` + `both` | `18,784 x 6 x 4` = 450,816 row-equivalents |

So the lazy design mostly changes when we pay the prompt-answer cost. The
default rebuild avoids it; rare filters pay it once and then reuse the cached
bucket.

The combined target leaves roughly 770k row-equivalents eager for default
readiness: project scope, display, selected import, search, default queue
article-rank, basic summary, and status rows. Keep `llmStatus` and
`humanStatus` eager in the early slices because they define the default tabs and
tab totals.

User-visible success metrics:

- Rebuild-to-default-ready time for the current-DB project.
- Cold default review API latency immediately after rebuild, with an empty lazy
  cache.
- First page render after rebuild: default rows/totals/summary render exactly
  and do not wait for optional lazy artifacts.

## Stages

Implementation status, 2026-08-01:

- Stage 0 implemented: first-load filter and action-menu requests are lazy.
- Stage 1 implemented: prompt-answer postings are read-through lazy buckets
  built from eager judgment sources, not deferred detail payload rows.
- Stage 2 implemented: visible-page judgment detail hydration is bounded and
  lazy; default list readiness does not require full payload manifests.
- Stage 3 implemented as a default-readiness slice: prompt-derived summary
  fanout is removed from default rebuild admission, prompt-derived facet rows
  are not published as precise ready counts during default rebuild, and filter
  options ignore unavailable lazy facet buckets.

Follow-up, 2026-08-09:

- See `docs/review-serving-payload-nonblocking-plan.md` for the narrower
  payload-specific cutover plan. The old Stage 2 work made visible-page
  hydration lazy/bounded, but further work is still needed to make `payload`
  explicitly secondary across rebuild request requirements, candidate promotion,
  filtered-count identity, and detail/export/PDF pending-state behavior.

### Stage 0: First-Load Choreography Audit

Audit and adjust the frontend/API first-load path so the initial unfiltered page
load asks only for default eager surfaces. Any prompt-answer filter, detail
hydration, queue prompt-pair payload, or prompt-derived facet request must be
deferred until the user or job actually enters that workflow.

### Stage 1: Lazy Prompt-Answer Postings

Defer `promptAnswer` inverted-index buckets until a filtered read asks for them.
This is the cleanest first slice because the current posting table for this
project is entirely `promptAnswer`.

Default win: about 751k row-equivalents, 30.5%.

### Stage 2: Lazy Detail And Queue Payloads

Defer data needed for detail hydration and secondary queue workflows:

- judgment input/detail payloads used after row selection
- queue prompt-pair payload expansion used for job preview/launch paths

Default win after Stage 1: another 263k to 488k row-equivalents, depending on
whether detail, queue payload, or both are deferred.

### Stage 3: Lazy Prompt-Derived Summary/Facet Work

Keep basic unfiltered summary/count readiness eager, but defer prompt-answer
summary/facet/filter-option work until the matching filtered view asks for it.

Default win after Stage 1: another about 451k row-equivalents.

This is the highest-risk lazy slice because filtered counts and facets must not
look precise while their lazy inputs are missing or stale.

## Implementation Checklist

### Stage 0: First-Load Choreography Audit

- [ ] Audit the frontend/API initial unfiltered page-load sequence and list the
      default eager surfaces it calls.
- [ ] Change the first-load sequence so it does not request filtered
      prompt-answer data, detail hydration, queue prompt-pair payloads, or
      prompt-derived facets before the user/job enters those workflows.

### Stage 1: Prompt-Answer Postings

- [ ] Define a posting readiness state for `promptAnswer` buckets, keyed by
      project, review config, snapshot, list mode, prompt id, and answer.
- [ ] Define the stable canonical eager source used to build lazy
      `promptAnswer` buckets, or complete the status/detail source split before
      Stage 2 makes detail payloads lazy.
- [ ] Change full/rebuild admission so `posting` does not eagerly request all
      `promptAnswer` buckets for default review readiness.
- [ ] Keep non-filtered review routes independent of prompt-answer postings.
- [ ] Add a filtered-read fallback: if a needed posting bucket is missing or
      stale, compute the article IDs from the canonical eager source.
- [ ] Cache the computed bucket after the first filtered read, either
      synchronously when bounded or via queued background work.
- [ ] Make invalidation bucket-level: a changed prompt answer invalidates only
      that prompt/answer/list-mode bucket family.
- [ ] Surface stale/async state for filtered counts if a bucket is missing and
      the fallback cannot cheaply compute an exact count.
- [ ] Add cleanup/retention for lazy buckets under the same snapshot protection
      rules as current postings.
- [ ] Add diagnostics showing eager skipped buckets, lazy cache misses, lazy
      builds, stale bucket invalidations, and fallback query counts.
- [ ] Recalculate rebuild estimates so lazy prompt-answer posting is not counted
      as default eager work.

### Stage 2: Detail And Queue Payloads

- [ ] Split default row readiness from judgment detail hydration readiness.
- [ ] Ensure default review rows can render without prebuilt judgment detail
      payloads.
- [ ] Add bounded post-selection detail hydration for the visible page of
      articles.
- [ ] Split unassessed queue article-rank readiness from prompt-pair payload
      expansion.
- [ ] Build queue prompt payloads on preview/launch demand, then cache or attach
      them to the relevant job workflow.
- [ ] Add diagnostics for lazy detail hydration and lazy queue payload misses.

### Stage 3: Prompt-Derived Summary/Facet Work

- [ ] Separate basic unfiltered summary/count readiness from prompt-filtered
      summary/facet readiness.
- [ ] Add lazy readiness keys for prompt-derived summary/facet/filter-option
      buckets.
- [ ] Make filtered summary/count responses exact via fallback, or explicitly
      `async`/stale until lazy work completes.
- [ ] Invalidate only affected prompt-derived summary/facet buckets on prompt
      answer changes.
- [ ] Keep snapshot-protected retention for lazy summary/facet artifacts.

## Tests

### Stage 1: Prompt-Answer Postings

- [ ] Unit: rebuild request estimates exclude lazy `promptAnswer` posting work
      from default full-project readiness.
- [ ] Unit: unfiltered LLM/Human/Both/Unassessed routes do not require
      `mart.review_article_filter_posting_serving_v4` rows.
- [ ] Unit: filtered prompt-answer reads use existing posting buckets when
      fresh.
- [ ] Unit: filtered prompt-answer reads fall back to the canonical eager
      source when the bucket is missing.
- [ ] Unit: fallback-read path enqueues or writes exactly the requested lazy
      bucket, not every prompt-answer bucket.
- [ ] Unit: prompt answer changes invalidate only matching prompt/list-mode
      buckets.
- [ ] Unit: stale/missing lazy bucket count responses are exact when fallback is
      exact, otherwise marked async/stale rather than silently wrong.
- [ ] DuckDB regression: current compact `article_ids` posting shape remains
      readable after a lazy bucket is built.
- [ ] DuckDB regression: segmented posting rows for one lazy bucket do not
      overlap incorrectly and route intersection still returns the expected
      article set.
- [ ] Route parity: prompt-answer filtered count/list results match the current
      eager-posting behavior.

### Stage 2: Detail And Queue Payloads

- [ ] Unit: default review row routes hydrate only visible-page detail fields.
- [ ] Unit: missing judgment detail payload does not block default article-list
      readiness.
- [ ] Unit: detail hydration fallback returns the same visible row data as eager
      payload hydration.
- [ ] Unit: unassessed queue default list/count reads use article-rank readiness
      without prompt-pair payloads.
- [ ] Unit: judgment-job preview/launch builds or fetches only the required
      prompt-pair payloads.
- [ ] Route parity: visible review rows and job preview rows match eager payload
      behavior.

### Stage 3: Prompt-Derived Summary/Facet Work

- [ ] Unit: unfiltered tab totals and basic summary remain eager and exact.
- [ ] Unit: prompt-filtered counts/facets use fresh lazy buckets when present.
- [ ] Unit: missing prompt-filtered summary/facet buckets fall back exactly or
      return an async/stale availability state.
- [ ] Unit: prompt answer changes invalidate only affected summary/facet keys.
- [ ] Route parity: prompt-filtered counts and facets match eager behavior once
      the lazy bucket is built.

### Shared Gates

- [ ] Performance smoke: default rebuild for the current-DB project meets the
      rebuild-to-default-ready target with no eager optional lazy surfaces
      written for default readiness.
- [ ] Performance smoke: cold default review API reads after rebuild meet the
      latency target with an empty lazy cache.
- [ ] Performance smoke: first page render after rebuild shows exact default
      rows/totals/summary and does not wait on optional lazy artifacts.
- [ ] Concurrency/backpressure: simultaneous first filtered requests for the
      same readiness key coalesce into one lazy build.
- [ ] Concurrency/backpressure: lazy builds do not stampede
      DuckDB/maintenance and do not block unrelated default review reads.
- [ ] Current-DB smoke: rebuild or invalidate the target project, load the
      default review page with an empty lazy cache, verify exact default data
      without optional lazy artifacts, then request one filtered prompt-answer
      bucket and verify only that bucket is built.
- [ ] Live gate before PR/merge: API and maintenance owner ready, then verify
      review-serving progress counters move on the current workload.

## Main Risks

- First use of a rare prompt-answer filter can be slower.
- First detail-heavy view or queue preview can move work from rebuild time to
  user/job time.
- Filtered counts must not look ready if the lazy bucket is stale and fallback
  cannot answer exactly.
- Bucket-level invalidation must include review config, snapshot, prompt id,
  answer, and list mode, or stale filters can leak.
- Rebuild readiness semantics must separate default review readiness from
  optional lazy filter readiness.
- Summary/facet laziness is risky unless exactness and async/stale availability
  states are explicit.

## Recommended Slice

This plan has been implemented as one PR-sized slice across Stage 0 through the
bounded Stage 3 default-readiness change. Further follow-up should focus on
measuring cold first filtered requests and adding stronger lazy-build
coalescing/backpressure if foreground cache misses become noisy.
