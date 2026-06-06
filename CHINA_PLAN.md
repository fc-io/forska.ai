# Chinese Article Comparison Plan

| # | Area | Plan |
|---|---|---|
| 1 | Category definition | Split articles into `chinese` and `non_chinese`. Treat an article as `chinese` when metadata language fields indicate Chinese or title/abstract contains CJK Han characters. |
| 2 | Storage | Add the derived category to `mart.comparison_article_serving` during comparison serving rebuilds. |
| 3 | Performance | Keep calculations server-side in DuckDB. Aggregate by `comparison_id` and category; never send article-level rows to the browser for stats. |
| 4 | Stats API | Extend comparison stats to return category breakdowns beside the existing all-articles stats. |
| 5 | UI | Add a compact Chinese vs Non-Chinese section on the compare projects stats card. |
| 6 | Metrics | Prioritize resolved-truth metrics: sensitivity, specificity, accuracy, precision, NPV, F1, balanced accuracy, prevalence, TP, FP, TN, FN. |
| 7 | Fallback | If no adjudicated truth exists, show agreement stats by category: overlap, conflicts, true conflicts, Cohen's kappa, sensitivity, specificity. |
| 8 | Rebuild | Add a DuckDB migration and mark comparison serving generations stale so categories are regenerated. |
| 9 | Verification | Add targeted tests for category detection, aggregate denominators, null metrics, and UI rendering. |

## Checklist

- [ ] Confirm whether “Chinese” means article language/script, not author country or institution country.
- [ ] Add a derived article category expression/helper for `chinese` vs `non_chinese`.
- [ ] Add the category column to `mart.comparison_article_serving` migration/schema.
- [ ] Populate the category in `comparisonProjectServingRollupBuilder.ts`.
- [ ] Join category data into `comparisonProjectStats.ts` aggregate SQL.
- [ ] Return category breakdowns from `/api/comparison-projects/:id/stats`.
- [ ] Update client types in `comparisonProjectsService.ts`.
- [ ] Render Chinese vs Non-Chinese stats in `comparisonProjectStatsCard.tsx`.
- [ ] Add server tests for metadata language, CJK title/abstract, and non-Chinese cases.
- [ ] Add stats tests for independent category denominators and null metric handling.
- [ ] Run `bun run db:mig`.
- [ ] Run targeted `bun test` for serving rollups and comparison stats.
- [ ] Run `bun run lint`.
- [ ] Run `bun run build`.
- [ ] Browser-check the compare projects page.
- [ ] Run `bun run desktop:build` if the shared route is included in desktop.
