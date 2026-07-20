# Deduplicate Compare Conflict Resolution Import Plan

## Goal

Reuse saved conflict-resolution decisions when creating a new compare project, while handling simple duplicates automatically and skipping only the unresolved conflicting imports.

Creation should continue when import conflicts are found. Conflicting resolutions should not be imported, and the response/UI should show warnings with the compare projects, article titles, article IDs, and resolution answers involved.

## Scope

- Server import helper: `src/server/routes/comparisonProjectsRoutes/comparisonProjectConflictResolutionImport.ts`
- Create route: `src/server/routes/ComparisonProjectsRoutes.ts`
- Client service types: `src/services/comparisonProjectsService.ts`
- Create page UI: `src/app/routes/+compare-judgments/+create-from-project.tsx`
- Existing table: `app.comparison_project_conflict_resolution`

No database migration should be required. Imported resolutions still write to the existing conflict-resolution table.

## Current Behavior

- Duplicate source keys can stop creation.
- Ambiguous target matches can stop creation.
- Conflicting imported values can stop creation.
- Values outside the target summary options can stop creation.
- When creation stops, no compare project is created.

## Target Behavior

- Identical duplicate decisions are deduped and imported once.
- Conflicting decisions are skipped, not imported.
- Creation succeeds when conflicts are limited to importable resolution rows.
- The create response includes warnings for skipped conflicts.
- The UI shows warnings in a post-create confirmation panel when warnings exist, and otherwise preserves the current successful navigation.
- Configuration errors still fail creation before import starts.

Configuration errors that should still fail creation:

- Import source IDs are provided while Summary mode is disabled.
- Import source IDs are provided while Compare with humans is disabled.
- Allow conflict resolution is disabled.
- Selected import source compare project does not exist.
- Selected import source compare project is archived.
- Selected import source compare project does not allow conflict resolution.
- Selected import source compare project is not summary mode.
- Selected import source compare project has no saved resolutions.

## Matching Rules

Use the existing keys:

- DOI when both source and target have a normalized DOI.
- External article ID plus normalized title when DOI is unavailable or does not resolve to a unique target.

Normalization remains:

- DOI: trim, lowercase, remove `https://doi.org/`, `https://dx.doi.org/`, and `doi:` prefixes.
- External article ID: trim and lowercase.
- Title: trim, lowercase, collapse internal whitespace.
- Resolution answer: trim. Case-insensitive answer matching may be added only when exactly one target option matches after normalization.

Additional matching constraints:

- Target ambiguity is evaluated against conflict-resolution eligible target articles. Ineligible target matches should only contribute to `skippedNotConflicting` when no eligible target can be chosen.
- Do not use ID/title to override a unique DOI match.
- When the source has DOI keys, do not use ID/title to match a target article that has a different DOI. ID/title may only choose within ambiguous DOI matches or match a target article with no DOI.
- If case-insensitive answer matching is added, store the canonical target option value, not the source casing.

## Conflict Policy

| # | Scenario | Behavior |
|---|---|---|
| 1 | Duplicate source keys with the same normalized resolution value | Deduplicate and import once. |
| 2 | Duplicate source keys with different normalized resolution values | Skip that target resolution and warn. |
| 3 | Multiple source compare projects resolve the same target article with the same value | Deduplicate and import once. |
| 4 | Multiple source compare projects resolve the same target article with different values | Skip that target resolution and warn. |
| 5 | Source DOI matches multiple eligible target articles, and ID/title uniquely picks one of those DOI-matched articles | Import using the ID/title tie-breaker. |
| 6 | Source DOI matches multiple eligible target articles with no unique tie-breaker | Skip that source resolution and warn. |
| 7 | Duplicate eligible target DOI or ID/title points to multiple eligible target articles | Skip that source resolution and warn. |
| 8 | DOI and ID/title point to different unique target articles | Prefer DOI when it is unique; otherwise skip the different-DOI ID/title match unless ID/title is selecting within ambiguous DOI matches. |
| 9 | Source row has no usable DOI and no usable external ID plus title | Skip without warning. |
| 10 | Source row has no target match | Skip without warning. |
| 11 | Target article is not conflict-resolution eligible in the new compare project | Skip without warning. |
| 12 | Imported value is outside the target summary options | Skip that source resolution and warn. |

## Warning Data

Each warning should be structured enough for the UI to render an actionable list.

```ts
type ConflictResolutionImportWarning = {
  code:
    | 'conflicting-resolution-values'
    | 'ambiguous-target-match'
    | 'invalid-target-resolution-value'
  message: string
  sourceRows: Array<{
    comparisonProjectId: string
    comparisonProjectName: string
    sourceResolutionId: string
    sourceArticleId: string
    sourceExternalArticleId: string | null
    sourceArticleTitle: string | null
    resolutionValue: string
    matchKind: 'doi' | 'id-title'
    matchKey: string | null
  }>
  targetArticles: Array<{
    targetArticleId: string
    targetExternalArticleId: string | null
    targetArticleTitle: string | null
  }>
}
```

Warning payloads and UI rendering should include:

- Compare project name.
- Compare project ID.
- Source article title.
- Source article ID.
- Target article title when known.
- Target article ID when known.
- Resolution answer.
- Match key and match kind when useful.

`message` should stay a concise reason string. The structured warning fields should carry the detailed project, article, match, and answer data.

## Import Summary

Extend the import summary returned from create-from-project.

```ts
type ConflictResolutionImportSummary = {
  scanned: number
  matched: number
  imported: number
  deduped: number
  skipped: number
  skippedAmbiguousTarget: number
  skippedConflicting: number
  skippedNoUsableKey: number
  skippedNoTargetMatch: number
  skippedNotConflicting: number
  skippedInvalidValue: number
  warnings: ConflictResolutionImportWarning[]
}
```

`imported` should count rows inserted into `app.comparison_project_conflict_resolution`, not source rows scanned. `deduped` should count matching source rows that agreed with another imported row but did not create an additional insert.

Count definitions:

- `scanned`: selected source conflict-resolution rows.
- `imported`: target rows inserted.
- `deduped`: valid, eligible, matched source rows that agreed with an inserted target row but did not create another insert.
- `skipped`: all source rows that were neither inserted nor deduped.
- `matched`: source rows that resolved to at least one target article before final skip/import handling.
- `skippedAmbiguousTarget`: source rows skipped because no unique eligible target article could be chosen.
- `skippedConflicting`: valid, eligible, matched source rows skipped because their target article group had conflicting normalized resolution values.
- `skippedInvalidValue`: source rows skipped because their answer does not map to a target summary option.
- `skippedNoUsableKey`, `skippedNoTargetMatch`, and `skippedNotConflicting`: non-warning skips.

The sum of `imported + deduped + skipped` should equal `scanned`. `skipped` should equal the sum of all skipped detail fields.

## Server Plan

1. Extend source-row SQL to include source compare project metadata.

Return at least:

- `sourceComparisonProjectId`
- `sourceComparisonProjectName`
- `sourceResolutionId`
- `sourceArticleId`
- `sourceExternalArticleId`
- `sourceArticleTitle`
- `resolutionValue`
- DOI keys

2. Extend target article rows with target title and external article ID.

The DOI target query should no longer return `NULL` for title or external article ID. Return enough data from both DOI and ID/title target queries to show warnings without extra queries, and merge target rows by article ID without losing title, external article ID, DOI, or eligibility data.

3. Change the import planner output.

Return:

- `candidates` for safe imports.
- `warnings` for skipped import conflicts.
- `skippedRows` for all skipped source rows, including warning-backed skips.
- `skipCounts` split by reason.

4. Validate matched source values before target conflict grouping.

For each uniquely matched, eligible source row:

- If the source value maps to exactly one target summary option, keep the canonical target option value for import/grouping.
- If the source value is not valid for the target summary options, create an `invalid-target-resolution-value` warning and skip that source row.

5. Replace fatal duplicate handling with grouping by resolved target article.

For each target article group after ambiguous and invalid rows have been removed:

- If all normalized values agree, create one candidate.
- If values differ, create a `conflicting-resolution-values` warning and do not create a candidate.

6. Handle ambiguous target matches as skipped warnings.

For each source row:

- If DOI produces multiple eligible target articles and ID/title picks exactly one of those articles, use the tie-breaker.
- If no unique eligible target can be chosen, create an `ambiguous-target-match` warning and skip the source row.

7. Handle duplicate source and target keys as skipped warnings, not fatal errors.

Duplicate source keys with the same normalized value should dedupe through the target group. Duplicate source keys with different normalized values should become `conflicting-resolution-values`. Duplicate eligible target keys that cannot be resolved to one eligible article should become `ambiguous-target-match`.

8. Keep project creation transactional.

The compare project and safe imported rows should still be created in one transaction. Warning-only import conflicts should not throw. True configuration errors should still throw before insert or roll back the transaction.

9. Return the extended summary.

The route should return `{data, conflictResolutionImportSummary}` when import sources were selected, including warnings even when zero rows were imported.

10. Update the client service return contract.

`createComparisonProjectFromProject` currently unwraps only top-level `data`, which would discard `conflictResolutionImportSummary`. Add a typed return value that preserves both the created compare project and the optional summary/warnings for the UI.

## UI Plan

1. Update the create-page copy.

Replace the current hard-stop warning with copy like:

`Matching duplicate decisions are imported once. Conflicting or ambiguous decisions are skipped and reported after creation.`

2. Show import warnings.

After create succeeds with warnings, show a warning panel that lists:

- Compare project name and ID.
- Article title and ID.
- Resolution answer.
- Reason the row was skipped.

3. Preserve successful navigation behavior deliberately.

The current flow navigates to `/compare-judgments` and the app does not appear to have an existing toast or route-state warning pattern. Use the smallest local pattern: when creation succeeds with warnings, keep the user on the create page and render a post-create warning/confirmation panel with links to the created compare project and the compare-project list. When creation succeeds without warnings, keep the existing immediate navigation behavior.

4. Keep existing server validation errors on the form.

Configuration failures should still show as blocking errors on the create page.

## Tests

Add or update helper tests for:

- Duplicate source DOI keys with same value dedupe and import once.
- Duplicate source ID/title keys with same value dedupe and import once.
- Duplicate source keys with different values skip with warning.
- Multiple source compare projects resolving the same target with same value dedupe and import once.
- Multiple source compare projects resolving the same target with different values skip with warning.
- Ambiguous DOI target resolved by ID/title tie-breaker imports.
- Ambiguous DOI target without tie-breaker skips with warning.
- Duplicate eligible target key skips with warning.
- Invalid source value skips with warning.
- No usable key, no target match, and not-conflicting target still skip without warning.

Add or update route tests for:

- Create succeeds when one imported resolution conflicts and is skipped.
- Safe resolutions are still inserted when other selected resolutions warn.
- Response includes warning compare project names, compare project IDs, article titles, article IDs, and answers.
- Response summary counts include `deduped`, `skippedAmbiguousTarget`, `skippedConflicting`, and `skippedInvalidValue`.
- Configuration errors still return `400` and leave no compare project row.

Add or update UI tests for:

- Create page sends selected import source IDs.
- Warning copy explains skipped conflicts.
- Server import warnings render with project/article/value details.
- Successful creation with warnings stays on the create page and shows the confirmation/warning panel.
- Successful creation without warnings still navigates to `/compare-judgments`.
- Blocking validation errors still remain on the form.

## Quality Gates

- `bun test src/server/routes/comparisonProjectsRoutes/comparisonProjectConflictResolutionImport.test.ts`
- `bun test src/server/routes/ComparisonProjectsRoutes.rollback.test.ts`
- `bun test src/app/routes/+compare-judgments/-+create-from-project.vitest.tsx`
- `bun run build`
- `bun run lint`
- Browser flow: run `bun run dev:server` and `bun run dev:app`, then create a compare project with selected import sources that include both deduped and conflicting resolutions.
- Desktop consideration: this touches shared app/API create behavior. Run `bun run desktop:build` when implementing the UI route or shared service type changes.
