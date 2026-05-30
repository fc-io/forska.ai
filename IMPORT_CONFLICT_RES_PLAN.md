# Import Conflict Resolutions Plan

## Goal

Add a bottom section to the Create Compare Project page for importing existing conflict resolutions from other compare projects while creating a new source-project-backed compare project.

The import should match resolved articles by external article ID and title, or by DOI when available. If duplicate or conflicting matches are found, the request should fail before creating the new compare project.

## Scope

- Page: `src/app/routes/+compare-judgments/+create-from-project.tsx`
- Client API wrapper: `src/services/comparisonProjectsService.ts`
- Server route: `src/server/routes/ComparisonProjectsRoutes.ts`
- Likely helper: `src/server/routes/comparisonProjectsRoutes/comparisonProjectConflictResolutionImport.ts`
- Existing storage: `app.comparison_project_conflict_resolution`

No database migration should be required because imported resolutions can be stored in the existing table after the new compare project is created inside the same transaction.

## User Flow

1. User selects a primary source project and enables Summary mode.
2. User enables Allow conflict resolution.
3. A bottom section appears: Import Conflict Resolutions.
4. The section lists eligible compare projects with saved conflict resolutions.
5. User selects one or more source compare projects.
6. On submit, the server validates the import against the new project configuration.
7. If any duplicate, ambiguous, or conflicting source resolution is found, the server returns an error and does not create the new compare project.
8. If validation passes, the server creates the new compare project and imports the matched conflict resolutions in the same transaction.

## Matching Rules

Use these matching keys:

- DOI, when both source and target articles have a normalized DOI.
- External article ID plus normalized title, when DOI is unavailable or absent.

Normalization:

- DOI: trim, lowercase, remove URL prefixes such as `https://doi.org/` and `doi:` if needed.
- External article ID: trim and lowercase.
- Title: trim, lowercase, collapse internal whitespace.

Validation rules:

- A source resolution must match exactly one target article.
- Multiple source resolutions must not map to the same target article unless they have the same normalized resolution value.
- If multiple source compare projects resolve the same target article differently, fail the whole request.
- If multiple target articles share a matching key, fail the whole request with a duplicate warning.
- If multiple source resolved articles share a matching key, fail the whole request with a duplicate warning.
- Invalid resolution values for the target compare project should fail the request rather than silently skip.

Skipped rows should be limited to clear non-errors:

- Source article has no usable DOI and no usable external ID plus title key.
- Source article has no corresponding target article.
- Target article is not conflicting in the new compare project scope.

## Performance Design

Conflict resolutions are expected to be much fewer than articles, so drive the import from conflict-resolution rows, not from all articles.

1. Query selected source conflict-resolution rows and join to `app.article` for only those resolved articles.
2. Build the small set of source match keys in memory.
3. Query target candidate articles by constrained predicates derived from those source keys:
   - `LOWER(TRIM(doi)) IN (...)` for DOI keys.
   - External article IDs in the selected set plus title checks for ID-title keys.
4. Restrict target candidate articles to the new compare project scope using existing source-project/import-route scoping logic.
5. Build target key maps in memory and detect duplicates before creating anything permanent.
6. Validate conflict status only for matched target article IDs, using existing comparison row helpers in batches instead of materializing all compare-project articles.
7. Insert imported resolutions with one batched `INSERT INTO ... SELECT` or batched values inside the same transaction that creates the compare project.

This keeps the largest operation bounded by the number of selected source conflict resolutions plus the number of matched target candidates, not by total article count.

## API Changes

Add a source-list endpoint:

- `GET /api/comparison-projects/conflict-resolution-import-sources`

Return only non-archived compare projects with at least one conflict resolution:

- `id`
- `name`
- `description`
- `createdAt`
- `humanJudgmentMode`
- `resolutionCount`
- `matchedByDoiCandidateCount` if cheap, otherwise omit
- `matchedByIdTitleCandidateCount` if cheap, otherwise omit

Extend create-from-project request:

```ts
type CreateComparisonProjectFromProjectInput = {
  name: string
  description?: string | null
  compareWithHumans?: boolean
  allowConflictResolution?: boolean
  humanJudgmentMode?: HumanJudgmentMode
  summarySourceProjectId?: string | null
  sourceProjectId: string
  sourceProjectIds?: string[]
  conflictResolutionImportSourceComparisonProjectIds?: string[]
}
```

Server behavior:

- If import IDs are provided but Summary mode or Allow conflict resolution is not enabled, return `400`.
- Validate selected source compare projects exist, are not archived, and have conflict resolutions.
- Run duplicate and conflict validation before inserting the new compare project.
- Create the compare project and imported rows in one transaction.
- Return the created project plus import summary.

## Transaction Strategy

Use one DuckDB transaction for the final create/import operation.

Recommended sequence:

1. Build the would-be comparison project config from selected source projects.
2. Prevalidate selected import source compare projects and source resolution rows.
3. Precompute target scope inputs from the would-be config.
4. Query target article candidates from the small source key set.
5. Detect duplicate source keys, duplicate target keys, and conflicting source resolutions.
6. Create the compare project record.
7. Validate matched target rows are conflict-resolution eligible against the newly created project scope.
8. Insert imported conflict resolutions.
9. Mark serving stale and queue rebuild after commit.

If any validation fails through step 7, throw and roll back the transaction. The new compare project must not exist.

## UI Details

Place the section after Additional Projects to Compare With and before the submit buttons.

States:

- Hidden until a primary project is selected.
- Disabled with explanatory text unless Summary mode and Allow conflict resolution are enabled.
- Loading state while eligible import sources load.
- Empty state when no compare projects have conflict resolutions.
- Checkbox list of eligible source compare projects with resolution counts.
- Warning text: duplicate or conflicting matches will stop creation so imported resolutions stay unambiguous.

Copy:

- Title: `Import Conflict Resolutions`
- Description: `Copy article-level conflict resolutions from existing compare projects. Matches use DOI when available, otherwise article ID and title.`
- Warning: `If duplicate or conflicting matches are found, creation stops and no compare project is created.`

## Error Messages

Use specific server errors so the UI can show actionable warnings:

- `Conflict resolution import requires summary mode with conflict resolution enabled.`
- `Duplicate source conflict resolution matches were found for DOI ...`
- `Duplicate target article matches were found for DOI ...`
- `Duplicate source conflict resolution matches were found for article ID and title ...`
- `Duplicate target article matches were found for article ID and title ...`
- `Conflicting imported conflict resolution values were found for article ...`
- `Imported conflict resolution value is not valid for the target compare project: ...`

The first implementation can return one combined message. A later enhancement can return structured diagnostics for a preview table.

## Tests

Add targeted tests for the import helper:

- Imports by DOI when DOI is present.
- Imports by external article ID plus title when DOI is absent.
- DOI match wins when ID-title would not match.
- Fails before creation on duplicate source DOI keys.
- Fails before creation on duplicate target DOI keys.
- Fails before creation on duplicate source ID-title keys.
- Fails before creation on duplicate target ID-title keys.
- Fails before creation on conflicting source resolution values for the same target article.
- Fails before creation when a source resolution value is invalid for the target summary options.
- Skips source resolutions with no usable match key.
- Skips source resolutions with no target match.
- Skips matched target articles that are not conflict-resolution eligible.

Add route tests for `/api/comparison-projects/from-project`:

- Creates project and imports valid resolutions in one successful request.
- Returns `400` and leaves no comparison project row when duplicate validation fails.
- Rejects import IDs when conflict resolution is disabled.

## Quality Gates

- `bun test src/server/routes/comparisonProjectsRoutes/comparisonProjectConflictResolutionImport.test.ts`
- `bun test src/server/routes/ComparisonProjectsRoutes.rollback.test.ts`
- `bun run lint`
- Web flow: run `bun run dev:server` and `bun run dev:app`, then create a compare project with and without selected import sources.
- Desktop consideration: this touches shared app/API behavior; run `bun run desktop:build` if the UI or route wiring changes beyond server-only helpers.
