# Toggle Partial Plan

## Scope

- Goal: change the `Assessed by LLM` default from `complete + partial` to `complete` only, and add radio buttons under the date range inputs for `Complete`, `Both`, and `Only Partial`.
- No DuckDB migration or app DB schema change is needed.
- No mart schema change is needed. The existing serving mart already exposes `has_all_llm_judgments` and `llm_judged_prompt_count`.

## Exact Files To Touch

### Client

- `src/app/routes/+projects/+$id/+reviews-llm/+index.tsx`
  - Pass the new LLM status filter through the route's existing URL-backed filter state and into the LLM table container.
- `src/components/main/reviews/reviewsFilterControls.tsx`
  - Add an optional LLM-only radio group under the start/end date inputs.
  - Keep the control hidden for `reviews-both` and `reviews-unassessed`, which also use this shared component.
- `src/components/main/reviews/reviewsArticlesTable/reviewsArticlesTableContainer.tsx`
  - Reset selection/cursors when the new status filter changes.
  - Pass the status filter into the list query, count query, and bulk-action filter payload.
- `src/components/main/projects/projectsArticlesReviewsQuery.ts`
  - Add the new filter to the query key and request body for `/api/articlesreviews`.
- `src/components/main/projects/projectsArticlesReviewsCountQuery.ts`
  - Add the new filter to the query key and request body for `/api/articlesreviewscount`.
- `src/components/main/reviews/reviewsPaginationControls.tsx`
  - Extend `buildAddAllFilterBody` typing so `Add to sub-project` and `Download PDFs for selected` preserve the chosen LLM status filter.
- `src/utils/useUrlFilters.ts`
  - Add URL-backed state for the LLM status filter.
  - Default it to `complete` for the LLM reviews page.
  - Persist it in the query string so refresh/share/back-nav keeps the selected radio option.

### Server / OLAP

- `src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviews.ts`
  - Accept and forward the new request field to OLAP.
- `src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsCount.ts`
  - Accept and forward the new request field to OLAP count queries.
- `src/server/routes/ArticlesRoutes.ts`
  - Accept the new field on `/api/articles/pdf-fetch-by-filter` and forward it to article ID selection.
- `src/server/routes/ProjectsAddArticlesRoutes.ts`
  - Accept the new field on `/api/projects/add_articles_by_filter` and forward it to article ID selection.
- `src/services/olap/olapTypes.ts`
  - Add a shared type for the LLM completeness filter and thread it through review query/count/select-IDs params.
- `src/services/olap/duckdbOlap.ts`
  - Apply the new filter on both serving-mart and raw fallback paths.
  - `complete`: require all project prompts judged.
  - `both`: keep current behavior, any LLM judgment.
  - `partial`: require at least one LLM judgment and not all prompts judged.
  - Update `selectArticleIdsByFilterDuckdb` so bulk add/PDF actions match the visible list.

### Tests

- `src/services/olap/duckdbOlap.test.ts`
  - Add/adjust cases for `complete`, `both`, and `partial` on both serving and raw paths.
  - Verify the generated query predicates stay aligned across data paths.
- `src/server/routes/projectsRoutes/projectsRoutesOlapParity.test.ts`
  - Verify the reviews and count routes forward the new request field.

## Implementation Notes

- Recommended URL param: `llmStatus=complete|both|partial`.
- Recommended default behavior:
  - LLM reviews route defaults to `complete` when the param is absent.
  - Other review tabs ignore the param and keep current behavior.
- Recommended UI labels:
  - `Complete`
  - `Both`
  - `Only Partial`
- Recommended placement: directly below the start/end date row inside `src/components/main/reviews/reviewsFilterControls.tsx`.
- Recommended server approach: do not filter only in the browser, because counts, pagination, `Add to sub-project`, and PDF bulk actions all depend on server-side selection.

## Step Plan

1. Add a shared `llmStatus` filter type and thread it through client query helpers, route handlers, OLAP params, and article-ID selection helpers.
2. Update DuckDB review selection/count logic so `complete`, `both`, and `partial` work the same on serving-mart and raw fallback paths.
3. Add the LLM-only radio group to the shared review filter UI and wire it to URL state with a default of `complete` on the LLM reviews route.
4. Update bulk-action payloads so `Add to sub-project` and `Download PDFs for selected` use the same LLM completeness filter as the visible table.
5. Add targeted parity and OLAP tests for the new filter modes.

## Quality Gates

- `bun test src/services/olap/duckdbOlap.test.ts`
- `bun test src/server/routes/projectsRoutes/projectsRoutesOlapParity.test.ts`
- `bun run build`

## Notes From Inspection

- Existing completion state already exists in the API response as `isFullyJudged` and in the mart as `has_all_llm_judgments`.
- The main risk is not the table display; it is keeping list results, counts, pagination, and bulk actions consistent.
- No obvious mart rebuild or DB migration work is required for this feature.
