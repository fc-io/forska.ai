# Mart Compare Plan

## Status

Superseded by `plans/old/BETER_PERFORMANCE_FOR_COMPARE_PLAN.md` and the implemented generation-based comparison serving marts: `app.comparison_project_serving_generation`, `mart.comparison_article_serving`, `mart.comparison_cell_serving`, `mart.comparison_filter_member`, and `mart.comparison_filter_stats`.

The sparse `mart.human_answer_fact` idea was not implemented. Keep the current comparison-serving architecture as the Compare Judgments read path. Revisit sparse human facts only if human answers need a shared upstream normalization layer or compare rebuild input cost becomes a measured bottleneck.

## Goal

Make Compare Judgments use shared mart-backed answer facts without expanding every comparison-project article/prompt/source-project cell up front.

## Direction

Use a hybrid shared fact model:

- Keep LLM facts broad because LLM judgments are high-volume and reused across Project Reviews, Compare, filters, and counts.
- Keep human facts sparse because human judgments usually cover far fewer articles than the project scope.
- Derive Compare Judgments rows by joining scoped articles to shared LLM facts plus sparse human facts.
- Keep Project Reviews serving marts as UI-specific denormalized tables derived from the same facts.

## Proposed Layers

- Improve or formalize shared LLM answer facts from `mart.judgment_fact` / `mart.prompt_answer_fact`.
- Add a sparse `mart.human_answer_fact` for answered human prompt and summary judgments.
- Keep `mart.review_article_serving` for Project Reviews only.
- Let Compare query shared facts directly first.
- Add a thin comparison-specific serving cache only if direct shared-fact queries are too slow.

## Avoid

- Do not reuse `mart.review_article_serving` as the primary Compare Judgments source.
- Do not materialize a full comparison matrix for every article, prompt, source project, and reviewer kind unless performance data shows it is needed.
- Do not silently fall back to raw source rows without surfacing freshness behavior.

## Implementation Steps

1. Document current Compare Judgments source-table queries and required row/cell semantics.
2. Define shared LLM and sparse human fact shapes.
3. Add `mart.human_answer_fact` DuckDB migration and refresh logic.
4. Add parity tests comparing raw Compare output to shared-fact Compare output.
5. Switch Compare LLM cells to shared facts while keeping human cells raw or fact-backed behind parity tests.
6. Switch human cells to sparse human facts once refresh and parity coverage are stable.
7. Measure query performance and add a thin compare serving cache only if needed.

## Quality Gates

- `bun test src/server/routes/comparisonProjectsRoutes/comparisonProjectJudgmentRows.test.ts`
- `bun test src/server/services/getDuckdbMartRefreshService.test.ts`
- `bun test src/server/services/projectMartLargeRebuildExecutor.test.ts`
- `bun run db:mig`
- `bun run lint`

## Browser And Desktop

Compare Judgments is shared app/server behavior. Verify the browser flow with the comparison table filters and row counts. If shared API wiring or runtime paths change, also verify the desktop path with `bun run desktop:build`.
