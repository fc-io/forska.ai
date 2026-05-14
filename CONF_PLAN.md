# Compare Stats Confidence Interval Plan

## Recommendation

Add confidence intervals to Compare Project Judgments stats where the intervals are interpretable and useful.

## Metrics

| Metric | CI Recommendation | Method | Notes |
| --- | --- | --- | --- |
| Sensitivity | Add 95% CI | Wilson score interval | Good fit because this is a proportion over reference Include rows. |
| Specificity | Add 95% CI | Wilson score interval | Good fit because this is a proportion over reference Exclude rows. |
| Cohen's Kappa | Add 95% CI | Article-level bootstrap | Prefer bootstrap because articles are the natural resampling unit and kappa is less direct than a simple proportion. |
| Conflict counts | Do not add CI initially | N/A | Counts are descriptive. Add rates first if uncertainty is needed. |

## Display

Show the point estimate with the confidence interval in the existing stats table.

Examples:

```text
0.742 (95% CI 0.681-0.795)
83.2% (95% CI 76.4-88.4%)
```

Use `N/A` when the denominator is too small or the metric cannot be computed.

## Minimum Denominators

Use a minimum denominator of 10 binary pairs for displaying sensitivity and specificity confidence intervals.

Use a minimum of 10 binary pairs for Cohen's Kappa bootstrap intervals.

## Implementation Notes

Add denominator fields to the stats aggregate response so the UI can explain or hide intervals consistently.

Compute Wilson intervals for sensitivity and specificity from aggregate counts.

Compute Cohen's Kappa bootstrap intervals from article-level binary decision pairs. If using only compact aggregate rows, add a scoped article-level query only for kappa CI rather than expanding all stats computation.

Keep confidence interval calculation deterministic in tests by using a fixed seed for bootstrap sampling.

## Caveats

Confidence intervals are meaningful when compared articles are treated as a sample from a larger population.

If the comparison contains the full population of interest, the interval should be described as a stability or generalization indicator rather than measurement uncertainty.

Intervals can be wide or unstable when denominators are small, one class dominates, or expected agreement is near 1.

## Quality Gates

Pass `bun test src/server/routes/comparisonProjectsRoutes/comparisonProjectStats.test.ts`.

Pass targeted UI/type lint for changed files with `bunx eslint <changed-files>`.

Pass `bun run build` for the web app.

Pass `bun run desktop:build` because the Compare Project Judgments UI is shared with desktop.
