# Compare Project Judgment Stats 2 Plan

## Goal

Add adjudicated truth stats to the Compare Project Judgments page without changing judgment data. Conflict resolution stats must only use articles with a saved conflict resolution answer unless explicitly labeled as a post-resolution fallback view.

## Rules

- Conflict resolution truth means a saved `comparison_project_conflict_resolution.answer_value` only.
- Resolved-only rows include only answers that normalize to `yes`, `maybe`, or `no`.
- Use binary decisions everywhere in this plan: `Include = yes or maybe`, `Exclude = no`.
- For truth metrics, conflict resolution is the reference truth and Human or LLM is the prediction.
- Do not fall back to Human when computing conflict-resolution-as-truth metrics.
- Keep the existing `LLM vs After conflict resolution` fallback behavior only if the row is clearly labeled `post-resolution fallback` in the UI and help text.
- Add new resolved-only stats only when conflict resolution is enabled and the page is in summary mode.

## Main Project Stats Table

Visible row behavior:

| Row | Add or change | Included articles | Metric reference |
| --- | --- | --- | --- |
| `Human vs After conflict resolution (resolved only)` | Add a new row to `Project Stats`. | Articles where Human and saved conflict resolution each have one valid binary decision. | Conflict resolution is truth; Human is prediction. |
| Existing `LLM vs After conflict resolution` rows | Keep the existing fallback behavior, but label it as `post-resolution fallback`. | Existing fallback set: saved conflict resolution when present, otherwise Human. | The reference side is saved conflict resolution when present, otherwise Human fallback. |
| Existing Human vs LLM and LLM vs LLM rows | No behavior change. | Existing overlap logic. | Existing reference rules. |

Implementation changes:

| Done | # | Change | What it adds or changes |
| --- | --- | --- | --- |
| [ ] | 1 | Add the new `Human vs After conflict resolution (resolved only)` row. | Adds one visible main-table row when conflict resolution is enabled and the page is in summary mode. |
| [ ] | 2 | Compute `Cohen's Kappa`, `Sensitivity`, and `Specificity` for the new row. | Uses saved conflict resolution as truth and Human as prediction, so TP/FN/TN/FP are not reversed. |
| [ ] | 3 | Filter the new row to resolved-only binary data. | Excludes rows without saved conflict resolution, rows with non-binary conflict resolution, and rows where Human is missing or non-binary. |
| [ ] | 4 | Define `Overlap` for the new row. | Shows the exact resolved-only denominator used for the new row's counts and rates. |
| [ ] | 5 | Add a server comparison kind such as `human-vs-conflict-resolution`. | Gives the new row its own type so it does not reuse fallback `llm-vs-conflict-resolution` behavior by accident. |
| [ ] | 6 | Update SQL and in-memory helper paths. | Makes production stats and test-helper stats return the same resolved-only result for the new row. |
| [ ] | 7 | Keep the main table columns unchanged. | Adds the new row without adding, removing, or renaming columns: `Comparison`, `Column Info`, `Overlap`, `Conflicts`, `True Conflicts`, `Cohen's Kappa`, `Sensitivity`, `Specificity`. |
| [ ] | 8 | Update UI labels and help text for `After conflict resolution`. | Makes each row say whether it is `resolved only` or `post-resolution fallback`, so users know which denominator and truth source they are seeing. |
| [ ] | 9 | Add targeted tests. | Covers counts, kappa, sensitivity, specificity, missing resolution exclusion, non-binary resolution exclusion, and SQL/helper parity. |

## Additional Project Stats

- [ ] 1. Add an expandable section named `Additional Project Stats` under the current stats table.
- [ ] 2. Add a `Resolved-only truth comparison` subsection that compares Human and each LLM against conflict resolution.
- [ ] 3. Use one row per LLM. Each LLM uses its own denominator: rows where Human, that LLM, and conflict resolution all have a valid binary decision.
- [ ] 4. Show `Resolved count`, `Human correct vs truth`, `Human errors vs truth`, `LLM correct vs truth`, `LLM errors vs truth`, and `Winner`.
- [ ] 5. Show `Both correct`, `Both wrong`, `Human only correct`, `LLM only correct`, and `LLM advantage`.
- [ ] 6. Define `Winner` as `LLM` when `LLM correct vs truth > Human correct vs truth`, `Human` when `Human correct vs truth > LLM correct vs truth`, otherwise `Tie`.
- [ ] 7. Define `LLM advantage` as `LLM only correct - Human only correct`.
- [ ] 8. Put the stats below inside the `Additional Project Stats` expandable section, not in the main table.
- [ ] 9. Add simple labels and short help text beside each metric.
- [ ] 10. Use `N/A` when a denominator is zero.
- [ ] 11. Add tests proving unresolved rows do not affect the head-to-head result.

| Metric | Simple description | Math |
| --- | --- | --- |
| Confusion matrix | Counts how predictions match conflict resolution truth. | `TP = truth Include and prediction Include`; `FN = truth Include and prediction Exclude`; `TN = truth Exclude and prediction Exclude`; `FP = truth Exclude and prediction Include`. |
| Accuracy | Share of resolved rows the rater got right. | `(TP + TN) / N` |
| Balanced accuracy | Accuracy balanced across Include and Exclude truth rows. | `(Sensitivity + Specificity) / 2` |
| Precision | When the rater says Include, how often truth is Include. | `TP / (TP + FP)` |
| NPV | When the rater says Exclude, how often truth is Exclude. | `TN / (TN + FN)` |
| F1 | Single Include-class score balancing precision and sensitivity. | `2 * TP / (2 * TP + FP + FN)` |
| Truth prevalence | How common Include is in resolved truth rows. | `(TP + FN) / N` |
| True correct | Number of resolved rows the rater matched truth. | `TP + TN` |
| True errors | Number of resolved rows the rater missed truth. | `FP + FN` |
| Human only correct | Rows where Human matched truth and LLM did not. | `count(humanCorrect and not llmCorrect)` |
| LLM only correct | Rows where LLM matched truth and Human did not. | `count(llmCorrect and not humanCorrect)` |
| Both correct | Rows where both matched truth. | `count(humanCorrect and llmCorrect)` |
| Both wrong | Rows where neither matched truth. | `count(not humanCorrect and not llmCorrect)` |
| McNemar chi-square | Raw paired-disagreement signal for Human vs LLM difference. | With `b = LLM only correct`, `c = Human only correct`: `chi2 = (abs(b - c) - 1)^2 / (b + c)` when `b + c > 0`; show `N/A` when `b + c = 0`. |

## Shared Metric Math

For a rater compared to conflict resolution truth:

| Metric | Math |
| --- | --- |
| Sensitivity | `TP / (TP + FN)` |
| Specificity | `TN / (TN + FP)` |
| Cohen's Kappa | `(Po - Pe) / (1 - Pe)` |
| Observed agreement | `Po = (TP + TN) / N` |
| Expected agreement | `Pe = ((truthInclude / N) * (raterInclude / N)) + ((truthExclude / N) * (raterExclude / N))` |

Where:

- `TP`: conflict resolution is Include and rater is Include.
- `FN`: conflict resolution is Include and rater is Exclude.
- `TN`: conflict resolution is Exclude and rater is Exclude.
- `FP`: conflict resolution is Exclude and rater is Include.
- `N`: rows where conflict resolution and the rater both have one valid binary decision.

## Quality Gates

- [ ] `bun test src/server/routes/comparisonProjectsRoutes/comparisonProjectStats.test.ts`
- [ ] `bun test src/server/routes/ComparisonProjectsRoutes.rollback.test.ts`
- [ ] `bun run lint`
- [ ] `bun run build`
- [ ] `bun run desktop:build`
