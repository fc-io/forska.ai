# Simple Compare Conflict Resolution Import/Export Checklist

## Decision

Build a small conflict-resolution transfer flow instead of a full comparison-project transfer package.

The target user already has the article/project data. The missing portable data is only the saved conflict-resolution decisions and enough article identifiers to map those decisions onto another comparison project.

## Product Shape

- [ ] Keep the existing comparison CSV `Export data` flow unchanged.
- [ ] Add a separate `Export resolutions` flow for saved conflict-resolution decisions.
- [ ] Add a target-specific `Import resolutions` flow with analyze-before-commit.
- [ ] Use one versioned JSON file, not a project-transfer zip package.
- [ ] Do not export or import projects, prompts, models, judgments, reviews, assets, queues, marts, or comparison serving rows.
- [ ] Do not create missing articles during import. The target comparison project must already contain matching articles.
- [ ] Restrict V1 import to summary-mode conflict resolutions because `answer_value` is portable across projects.
- [ ] Export prompt-mode rows only for audit if needed, and skip them on V1 import with a clear unsupported-mode reason.
- [ ] Do not overwrite existing target conflict-resolution rows by default. Report them as skipped unless an explicit replace option is added later.

## Exported Article Identity

Export these fields for every saved conflict-resolution row when available:

- [ ] `app.article.id` as `sourceArticleRowId`, for same-database provenance only.
- [ ] `app.article.article_id` as `externalArticleId`.
- [ ] `app.article.article_title` as `title`.
- [ ] `app.article.doi` and canonical DOI rows from `app.article_identifier`.
- [ ] `app.article.pubmed_id` and canonical PMID rows from `app.article_identifier`.
- [ ] `app.article.arxiv_id` and canonical arXiv rows from `app.article_identifier`.
- [ ] `app.article.biorxiv_id`.
- [ ] `app.article.medrxiv_id`.
- [ ] `app.article.url`, for audit and exact fallback only.
- [ ] Every `app.article_identifier` row for the article, including unknown or future `kind` values.

Do not match on title alone. Title is only an audit field and a tie-breaker with `externalArticleId`.

## JSON Artifact Contract

- [ ] Add a small versioned export shape.

```ts
type CompareConflictResolutionExportV1 = {
  format: 'forska.compareConflictResolutions'
  version: 1
  exportedAt: string
  source: {
    comparisonProjectId: string
    comparisonProjectName: string
    humanJudgmentMode: 'summary' | 'prompt'
    allowConflictResolution: boolean
  }
  rows: CompareConflictResolutionExportRowV1[]
}

type CompareConflictResolutionExportRowV1 = {
  sourceResolutionId: string
  article: {
    sourceArticleRowId: string
    externalArticleId: string | null
    title: string | null
    doi: string | null
    pubmedId: string | null
    arxivId: string | null
    biorxivId: string | null
    medrxivId: string | null
    url: string | null
    identifiers: Array<{
      kind: string
      value: string
      normalizedValue: string
      source: string | null
    }>
  }
  resolution: {
    mode: 'summary' | 'prompt'
    value: string
    label: string
  }
}
```

- [ ] Treat `sourceArticleRowId` as provenance only. Portable imports must not depend on it.
- [ ] Treat `externalArticleId` as `app.article.article_id`.
- [ ] Include canonical identifier rows even when legacy article columns are populated.
- [ ] Include legacy article columns even when canonical identifier rows are populated.
- [ ] Validate the artifact with ArkType at import boundaries.

## Server Export Checklist

- [ ] Add `POST /api/comparison-projects/:id/conflict-resolutions/export`.
- [ ] Validate that the comparison project exists.
- [ ] Export all saved conflict-resolution rows for the selected comparison project.
- [ ] Do not use current table filters or pagination for this export.
- [ ] Join `app.comparison_project_conflict_resolution` to `app.article`.
- [ ] Join or aggregate all `app.article_identifier` rows for each exported article.
- [ ] Include source comparison project name, mode, and conflict-resolution setting.
- [ ] Build resolution labels from the current comparison project's conflict-resolution options when possible.
- [ ] Return `application/json` with `Content-Disposition` filename `<comparison-name>_conflict_resolutions_YYYY-MM-DD.json`.
- [ ] Keep this endpoint separate from `POST /api/comparison-projects/:id/export`.

## Server Analyze Checklist

- [ ] Add `POST /api/comparison-projects/:id/conflict-resolutions/import/analyze`.
- [ ] Accept the parsed JSON artifact in the request body.
- [ ] Do not add a server-side upload session in V1.
- [ ] Validate that the target comparison project exists.
- [ ] Validate that the target comparison project has conflict resolution enabled.
- [ ] Validate that the target comparison project is summary mode for V1 imports.
- [ ] Skip prompt-mode artifact rows with `skippedUnsupportedMode`.
- [ ] Adapt file-backed rows into the existing conflict-resolution import source-row shape where possible.
- [ ] Reuse `getComparisonProjectConflictResolutionImportPlan` for dedupe, unsafe-row reporting, target conflict eligibility, and summary answer validation.
- [ ] Extend matching to use canonical identifiers beyond DOI where possible.
- [ ] Restrict target article matches to the target comparison project's article scope.
- [ ] Detect target articles that already have saved resolutions and report them as `skippedExisting`.
- [ ] Return a preview with exact rows that will be imported and exact rows that will be skipped.

## Analyze Response Contract

- [ ] Return a stable preview contract for the import page.

```ts
type CompareConflictResolutionImportPreviewV1 = {
  source: {
    comparisonProjectId: string
    comparisonProjectName: string
    exportedAt: string
  }
  summary: {
    scanned: number
    matched: number
    importable: number
    deduped: number
    skipped: number
    skippedExisting: number
    skippedUnsupportedMode: number
    skippedNoUsableKey: number
    skippedNoTargetMatch: number
    skippedNotConflicting: number
    skippedAmbiguousTarget: number
    skippedConflicting: number
    skippedInvalidValue: number
  }
  importableRows: CompareConflictResolutionImportPreviewRowV1[]
  skippedRows: CompareConflictResolutionImportSkippedRowV1[]
  warnings: CompareConflictResolutionImportWarningV1[]
}
```

- [ ] Include enough row detail for the UI to explain every decision.
- [ ] For importable rows, include source title, source IDs, target title, target IDs, selected resolution, match kind, and match key.
- [ ] For skipped rows, include source title, source IDs, attempted target when known, selected resolution, skip reason, match kind, and match key.

## Server Commit Checklist

- [ ] Add `POST /api/comparison-projects/:id/conflict-resolutions/import/commit`.
- [ ] Accept the same parsed JSON artifact in the request body.
- [ ] Re-run analysis during commit instead of trusting the client preview.
- [ ] Wrap commit in one transaction.
- [ ] Insert only still-safe candidates into `app.comparison_project_conflict_resolution`.
- [ ] For summary-mode imports, insert `prompt_id = NULL` and `answer_value = <target option value>`.
- [ ] Do not overwrite existing target rows by default.
- [ ] Return the same summary shape as analyze, plus `inserted`.

## Matching Checklist

- [ ] Use exact, normalized, scope-limited matching only.
- [ ] Normalize DOI the same way export and import already do: trim, lowercase, remove DOI URL and `doi:` prefixes.
- [ ] Match normalized DOI first.
- [ ] Match exact canonical identifier pairs next: `kind + normalizedValue` from `app.article_identifier`.
- [ ] Match exact legacy stable IDs next: `article_id`, `pubmed_id`, `arxiv_id`, `biorxiv_id`, and `medrxiv_id`.
- [ ] Use normalized `externalArticleId + title` as the final fallback.
- [ ] Never use title alone.
- [ ] Use URL only as an exact audit/fallback signal after URL normalization is explicitly defined.
- [ ] Import when all usable keys identify the same target article.
- [ ] Import when a stronger key is unique and weaker keys are missing.
- [ ] Skip and warn when non-empty keys point to different target articles.
- [ ] Skip and warn when a key matches multiple target articles and no tie-breaker selects exactly one.
- [ ] Deduplicate duplicate source rows that resolve to the same target article with the same value.
- [ ] Skip and warn when duplicate source rows resolve to the same target article with different values.

## UI Placement Checklist

- [ ] Add `Export resolutions` on the comparison project detail page: `src/app/routes/+compare-judgments/+$id/+index.tsx`.
- [ ] Place `Export resolutions` near the existing `Export data` action.
- [ ] Add `Import resolutions` next to `Export resolutions` on the comparison project detail page.
- [ ] Show `Import resolutions` only when `allowConflictResolution` is enabled.
- [ ] If disabled, show copy explaining that the target comparison project must allow conflict resolution.
- [ ] Link `Import resolutions` to `/compare-judgments/:id/import-resolutions`.
- [ ] Implement the page at `src/app/routes/+compare-judgments/+$id/+import-resolutions.tsx`.
- [ ] Add a secondary `Export resolutions` action on each comparison project card in `src/components/main/comparisonProjectsGrid.tsx` after the detail-page flow works.
- [ ] Do not put import on the grid in V1. Import needs a target comparison project context and preview.
- [ ] Optionally add file import to `src/app/routes/+compare-judgments/+create-from-project.tsx` after the detail-page import is stable.

## Import Page Checklist

- [ ] Page title: `Import conflict resolutions`.
- [ ] Show target comparison project name.
- [ ] Explain that the import only adds saved conflict-resolution decisions to articles already present in this comparison project.
- [ ] Step 1: choose or drop a `.json` conflict-resolution export file.
- [ ] Parse the JSON file client-side and show a clear invalid-file error if parsing fails.
- [ ] Step 2: click `Analyze import`.
- [ ] Call `POST /api/comparison-projects/:id/conflict-resolutions/import/analyze`.
- [ ] Show summary counts before commit.
- [ ] Show a table of rows that will be imported.
- [ ] Show a table of rows that will not be imported.
- [ ] Show warnings for ambiguous, conflicting, invalid-value, unsupported-mode, no-match, no-key, not-conflicting, and existing-resolution rows.
- [ ] Disable `Commit import` until analyze succeeds and at least one row is importable.
- [ ] Step 3: click `Commit import`.
- [ ] Call `POST /api/comparison-projects/:id/conflict-resolutions/import/commit` with the same parsed artifact.
- [ ] After commit, show inserted and skipped counts.
- [ ] Link back to `/compare-judgments/:id`.
- [ ] Refresh or invalidate comparison judgment queries so imported resolutions appear in the table.

## Client Wiring Checklist

- [ ] Add service methods and types in `src/services/comparisonProjectsService.ts`.
- [ ] Add a small export action that downloads the JSON artifact.
- [ ] Add the target-specific import page.
- [ ] Use TanStack Query and Eden/client helpers consistently with nearby comparison project code.
- [ ] Keep browser and desktop flows working by using existing API URL and download/upload helpers.

## Tests

- [ ] Export includes source comparison metadata, article legacy identifiers, canonical identifiers, title, and resolution value.
- [ ] Export includes multiple canonical identifier rows for one article.
- [ ] Analyze imports a row matched by normalized DOI.
- [ ] Analyze imports a row matched by PMID.
- [ ] Analyze imports a row matched by arXiv ID.
- [ ] Analyze imports a row matched by external article ID plus normalized title when no stronger key exists.
- [ ] Analyze skips title-only rows.
- [ ] Analyze skips ambiguous target matches with warnings.
- [ ] Analyze skips rows whose identifiers point to different target articles.
- [ ] Analyze skips invalid summary answer values with warnings.
- [ ] Analyze skips non-conflicting target articles.
- [ ] Analyze reports existing target resolutions as `skippedExisting`.
- [ ] Commit writes only safe rows and does not overwrite existing target resolutions by default.
- [ ] Commit re-runs analysis and skips rows that became unsafe after preview.
- [ ] Prompt-mode artifact rows are skipped with `skippedUnsupportedMode` in V1.
- [ ] Import page shows analyze counts, importable rows, skipped rows, and warnings before commit.
- [ ] Import page disables commit until analyze succeeds and at least one row is importable.

## Quality Gates

- [ ] `bun test src/server/routes/comparisonProjectsRoutes/comparisonProjectConflictResolutionImport.test.ts`
- [ ] `bun test <new compare conflict-resolution file-transfer test>`
- [ ] `bun test src/server/routes/ComparisonProjectsRoutes.rollback.test.ts`
- [ ] `bun test <new compare detail import/export UI test>`
- [ ] `bun run lint`
- [ ] `bun run build`
- [ ] Run `bun run desktop:build` if upload/download wiring, runtime paths, or API URL helpers change.
- [ ] Browser verify exporting resolutions from one comparison project, importing them into another comparison project, reviewing warnings, committing, and seeing imported resolutions in the comparison table.

## Non-Goals

- Do not build a full comparison-project transfer package in V1.
- Do not export judgments, human decisions, project setup, models, prompts, or article full text.
- Do not import articles or create projects.
- Do not use title-only fuzzy matching.
- Do not silently overwrite target conflict resolutions.
- Do not add prompt-mode conflict-resolution import until there is a deterministic prompt mapping requirement.
