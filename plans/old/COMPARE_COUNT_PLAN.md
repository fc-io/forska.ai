# Compare Project Judgment Stats Plan

## Goal

Add a project stats container to the Compare Project Judgments page. It should sit near the existing project description/details container and summarize conflict counts across available raters.

Start with counts for conflicts and true conflicts. Support summary mode and non-summary mode. Only compute Cohen's kappa in summary mode for now.

## Current Context

- Page: `src/app/routes/+compare-judgments/+$id/+index.tsx`
- Client service: `src/services/comparisonProjectsService.ts`
- API routes: `src/server/routes/ComparisonProjectsRoutes.ts`
- Serving reads: `src/server/routes/comparisonProjectsRoutes/comparisonProjectJudgmentRows.ts`
- Serving rollups: `src/server/services/comparisonProjectServingRollupBuilder.ts`
- Serving marts: `mart.comparison_article_serving`, `mart.comparison_cell_serving`, `mart.comparison_filter_member`, `mart.comparison_filter_stats`

The page already gets metadata and paginated rows from the materialized serving generation. Stats should also read from the active serving generation rather than scanning raw judgments on page load.

## Definitions

- `conflict`: an article where the compared raters both have an answer and those answers differ.
- `trueConflict`: a Covidence-style workflow conflict after normalizing screening answers to include/exclude decisions.
- `overlapCount`: articles where all raters in the comparison have answered.
- `trueConflictOverlapCount`: articles where the compared raters both have answers that can be normalized to include/exclude decisions.
- `cohensKappa`: summary-mode pairwise-only statistic over Covidence-style include/exclude decisions.

## True Conflict Calculation

Use the Covidence title/abstract screening rule: `Maybe` is treated the same as `Yes` for workflow and inter-rater reliability purposes.

Normalize answers before calculating true conflicts:

```ts
type ScreeningDecision = 'include' | 'exclude'

const getScreeningDecision = (answer: string | null): ScreeningDecision | null => {
  const normalizedAnswer = answer?.trim().toLowerCase() ?? ''

  return normalizedAnswer === 'no'
    ? 'exclude'
    : normalizedAnswer === 'yes' || normalizedAnswer === 'maybe'
      ? 'include'
      : null
}
```

Truth table:

| Votes | Normalized decisions | Conflict count | True conflict count |
| --- | --- | ---: | ---: |
| `yes` + `yes` | include + include | 0 | 0 |
| `maybe` + `yes` | include + include | 1 | 0 |
| `maybe` + `maybe` | include + include | 0 | 0 |
| `maybe` + `no` | include + exclude | 1 | 1 |
| `yes` + `no` | include + exclude | 1 | 1 |
| `no` + `no` | exclude + exclude | 0 | 0 |

For summary mode, compare each selected summary rater's `summary` cell.

For non-summary mode, compare prompt-level cells on the same prompt/content scope and count an article once if any compared prompt has an include/exclude disagreement. If a prompt answer cannot be normalized to `yes`, `maybe`, or `no`, exclude that prompt from true-conflict calculations and do not count it in `trueConflictOverlapCount`.

Keep `conflictCount` separate from `trueConflictCount`. `conflictCount` remains a raw answer disagreement count, so `maybe` vs `yes` is a conflict but not a true conflict.

## API Shape

Add a stats endpoint:

```ts
GET /api/comparison-projects/:id/stats
```

Suggested response:

```ts
type ComparisonProjectStats = {
  activeGeneration: number | null
  isServingReady: boolean
  servingStatus: ComparisonProjectServingStatus
  servingUpdatedAt: Date | string | null
  comparisons: ComparisonProjectStatsComparison[]
}

type ComparisonProjectStatsComparison = {
  id: string
  label: string
  kind: 'primary-vs-human' | 'llm-vs-llm' | 'human-vs-llm' | 'all-raters'
  mode: 'summary' | 'prompt'
  raterCount: number
  overlapCount: number
  trueConflictOverlapCount: number
  conflictCount: number
  trueConflictCount: number | null
  cohensKappa: number | null
  raters: Array<{
    columnId: string
    kind: 'llm' | 'human'
    label: string
    modelId: string | null
    sourceProjectId: string | null
  }>
}
```

## Backend Plan

1. Create a focused stats module beside existing comparison route helpers, for example `src/server/routes/comparisonProjectsRoutes/comparisonProjectStats.ts`.
2. Add SQL helpers that read `mart.comparison_cell_serving` joined to `app.comparison_project_serving_generation` for the active generation.
3. Build rater definitions from `ComparisonProjectScope.columns`.
4. Generate comparison groups:
   - Standard group: primary source-project LLM vs human, when human is available.
   - Human-vs-LLM groups: each LLM column vs human, when human is available.
   - LLM-vs-LLM groups: every pair of LLM columns.
   - Defer all-rater aggregate unless the UI needs it immediately.
5. Query per comparison using only relevant column IDs.
6. Count pairwise overlap from articles where both selected columns have non-empty normalized answers.
7. Count conflicts where normalized answers differ.
8. Count true conflicts by normalizing `yes` and `maybe` to `include`, `no` to `exclude`, then counting include/exclude disagreements.
9. Compute summary-mode Cohen's kappa only when there are exactly two raters and both are summary columns.
10. Return `cohensKappa: null` for non-summary mode and multi-rater rows.
11. Add the route in `ComparisonProjectsRoutes.ts` and return empty stats when there are no columns or no active generation.
12. Add reusable true-conflict SQL/helper logic for both stats and the new row filter so counts and filtered rows cannot drift.

## Difference Filters

Rename the existing Human vs LLM filter and add a Human vs LLM true-conflict filter:

```ts
type ComparisonProjectDifferenceFilter =
  | 'all'
  | 'human-vs-llm'
  | 'human-vs-llm-true-conflict'
  | 'llm-vs-llm'
  | 'any-disagreement'
```

Labels:

| Value | Label |
| --- | --- |
| `human-vs-llm` | `Human vs LLM conflict` |
| `human-vs-llm-true-conflict` | `Human vs LLM true conflict` |
| `llm-vs-llm` | `LLM vs LLM differences` |
| `any-disagreement` | `Any disagreement` |

Behavior:

- Keep the existing row filter behavior. The new filter composes with `multiple-answers`, `fully-answered`, and `all`.
- `human-vs-llm` should keep the existing Human vs LLM raw disagreement behavior, but the user-facing label changes from `Human vs LLM differences` to `Human vs LLM conflict`.
- `human-vs-llm-true-conflict` should return only articles where `has_human_vs_llm_true_conflict = TRUE`.
- Make `human-vs-llm-true-conflict` available only when there is at least one human column and one LLM column.
- Add URL support with `differenceFilter=human-vs-llm-true-conflict`.
- Add export support so exported rows match the table filter.

Serving changes:

- Add `has_human_vs_llm_true_conflict BOOLEAN NOT NULL` to `mart.comparison_article_serving`.
- Add `passes_difference_filter_human_vs_llm_true_conflict BOOLEAN NOT NULL` to `mart.comparison_article_serving`.
- Add `human-vs-llm-true-conflict` to the filter values inserted into `mart.comparison_filter_member` and `mart.comparison_filter_stats`.
- Add a DuckDB migration that updates/rebuilds the comparison serving mart schema and marks comparison serving stale so rows are rematerialized.

## Cohen's Kappa Formula

Use summary answers normalized to Covidence-style binary decisions: `yes` and `maybe` become `include`, `no` becomes `exclude`.

```ts
const categories = ['include', 'exclude'] as const
const observedAgreement = matchingPairs / overlapCount
const expectedAgreement = categories.reduce((sum, category) => {
  return sum + (leftCounts[category] / overlapCount) * (rightCounts[category] / overlapCount)
}, 0)
const kappa = expectedAgreement === 1 ? null : (observedAgreement - expectedAgreement) / (1 - expectedAgreement)
```

Return `null` when `overlapCount === 0` or `expectedAgreement === 1`.

## Frontend Plan

1. Add `ComparisonProjectStats` types and `fetchComparisonProjectStats` to `src/services/comparisonProjectsService.ts`.
2. Add a `useQuery` on `CompareProjectJudgmentsPage` with key `['comparison-project-stats', comparisonProjectId()]`.
3. Refetch stats while serving status is `refreshing`, matching the current metadata/page behavior.
4. Render a new white card near the existing details card.
5. Use a compact table or cards with columns:
   - Comparison
   - Overlap
   - Conflicts
   - True conflicts
   - Cohen's kappa, summary mode only
6. Add an inline info callout or tooltip beside `True conflicts`.
7. Rename `Human vs LLM differences` to `Human vs LLM conflict` in the existing difference filter dropdown.
8. Add `Human vs LLM true conflict` to the existing difference filter dropdown when a human-vs-LLM comparison is available.
9. Show loading inline inside the stats card, not as a page-level spinner.
10. Show empty state: `No comparable raters available yet.`
11. Format kappa to 3 decimals and use `N/A` for `null`.

## True Conflict Info Copy

Use this copy in the stats card or as a tooltip/help popover beside the true-conflict label:

```text
True conflicts follow the Covidence title/abstract screening rule: Maybe counts as Yes/include. A true conflict is Include (Yes or Maybe) vs Exclude (No). Yes + Maybe and Maybe + Maybe move forward and are not true conflicts; Maybe + No and Yes + No are true conflicts.
```

## UI Placement

Place the new stats container directly after the current project description/details container and before serving-status banners.

Suggested heading:

```text
Project Stats
```

Suggested summary copy:

```text
Conflicts are counted across articles where the compared raters both answered. True conflicts treat Maybe as Yes/include, matching Covidence title/abstract screening. Cohen's kappa is currently shown for summary-mode pairwise comparisons only.
```

## Tests

1. Add unit tests for stats calculation helpers:
   - no active generation returns empty stats
   - LLM-vs-LLM conflict count
   - human-vs-LLM conflict count
   - summary true conflict counts `yes`/`maybe` vs `no`
   - summary true conflict does not count `yes` vs `maybe`
   - summary kappa uses binary include/exclude decisions with `maybe` counted as include
   - non-summary kappa is `null`
2. Add route test coverage for `/api/comparison-projects/:id/stats`.
3. Add serving/filter tests for `differenceFilter=human-vs-llm-true-conflict`.
4. Add URL-state tests for preserving and normalizing `differenceFilter=human-vs-llm-true-conflict`.
5. Add client/service type coverage only if existing patterns support it; otherwise rely on route/helper tests.

## Quality Gates

- `bun test src/server/routes/comparisonProjectsRoutes/comparisonProjectStats.test.ts`
- `bun test src/app/routes/+compare-judgments/+$id/+index/compareProjectJudgmentsUrlState.test.ts`
- `bun test src/server/routes/ComparisonProjectsRoutes.rollback.test.ts`
- `bun run lint`
- `bun run build`
