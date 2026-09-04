# PDF Conflict-Resolution Import Plan

Status: implemented in PRs #396 and #400-#405. Keep this document as the design record and regression checklist for future changes.

Known follow-ups:

- PDF import is intentionally limited to summary-mode comparison projects; prompt-mode import should either be implemented explicitly or remain rejected at analyze/commit time.
- Existing PDFs use the current summary answer values (`yes`, `no`, `maybe`) and prompt IDs as radio values. If future resolution options allow spaces, punctuation, slashes, or non-ASCII values, add an option-value metadata map instead of using raw PDF radio names as semantic values.
- PDF article metadata currently includes project/article IDs, title, external article ID, current resolution, and conflict state. Cross-project matching would be more reliable if the export also embedded DOI/PMID/arXiv identifiers from the same identity source used by JSON conflict-resolution export.

## Goal

Let reviewers fill conflict-resolution radio boxes in Forska.ai comparison export PDFs, then import those completed PDFs back into Forska.ai with a safe preview/commit flow.

The importer should reuse the existing conflict-resolution import machinery instead of creating a separate data path. PDF import should parse filled AcroForm fields into the same transfer-artifact model used by JSON conflict-resolution export/import.

## Current State

The comparison PDF export already writes real AcroForm radio groups for conflict resolution. The field naming convention is:

```text
comparison.<comparisonProjectId>.article.<canonicalArticleId>.resolution
```

The existing JSON conflict-resolution import/export path already has most of the hard parts:

- portable artifact schema
- source metadata
- article identity matching
- import preview
- commit
- skipped/imported/overwrite-style reporting
- validation of target project mode and allowed resolution values

Relevant code:

- `src/server/routes/ComparisonProjectsRoutes.ts`
- `src/server/utils/simplePdf.ts`
- `src/server/routes/comparisonProjectsRoutes/comparisonProjectConflictResolutionFileTransfer.ts`
- `src/server/routes/comparisonProjectsRoutes/comparisonProjectConflictResolutionImport.ts`
- `src/app/routes/+compare-judgments/+$id/+import-resolutions.tsx`
- `src/app/routes/+compare-judgments/+$id/+import-resolutions/compareProjectImportResolutionsHelpers.ts`

## Implemented Export Shape

PDF export includes a front page before article pages and a prompt-overview page immediately after it.

The front page should contain:

- title: `Forska.ai conflict resolutions review`
- short explanation of Forska.ai comparison review PDFs
- intended offline review/import use case
- project name and comparison project ID
- export filters and export time
- row count
- GitHub link: `https://github.com/fc-io/forska.ai`
- visible fillable reviewer name field labeled `Your name:`: `forska.reviewer.displayName`
- brief explanations of conflict resolution, summary judgment, and LLM assessment
- a prompt overview page listing the study prompts used for the review

The front page should use exactly three font-size levels: title, section heading, and body text. Project metadata, help copy, field labels, and the GitHub link should all use the body size instead of introducing extra small print styles.

The reviewer ID should not be stored in the PDF. Import should create a new internal reviewer instance ID when committing the PDF, so two reviewers with the same display name remain separate without exposing or asking users to preserve an ID in the file.

PDF export should also embed hidden machine-readable fields:

- `forska.import.format`
- `forska.import.comparisonProject`
- `comparison.<project>.article.<article>.metadata`

The implementation embeds project/article metadata using hidden AcroForm text fields with base64url-encoded JSON values. Longer term, a document-level metadata object or attachment can replace this if needed, but hidden fields are easy to inspect and parse with the existing custom PDF writer.

## Import Design

### Parser

The implemented importer uses a server-side PDF form parser. PDFs are not parsed in the browser.

Parser responsibilities:

- read AcroForm text fields and radio groups
- extract `forska.*` metadata fields
- extract filled `comparison.*.article.*.resolution` radio values
- ignore `/Off`
- ignore the explicit PDF `Not set` radio sentinel so it never resets an existing resolution
- reject malformed field names
- reject unknown resolution values before commit
- report if the PDF has no AcroForm, no resolution fields, or appears flattened/printed

The parser should return a normalized intermediate object:

```ts
type ParsedPdfConflictResolutionImport = {
  source: {
    comparisonProjectId: string | null
    comparisonProjectName: string | null
    exportedAt: string | null
    formatVersion: number | null
  }
  reviewer: {displayName: string | null}
  rows: Array<{
    fieldName: string
    sourceArticleRowId: string | null
    canonicalArticleId: string | null
    externalArticleId: string | null
    title: string | null
    identifiers: Array<{
      kind: 'doi' | 'pmid' | 'arxiv'
      normalizedValue: string
      source: string
      sourceIdentifierId: string
      isPrimary: boolean
    }>
    resolutionValue: string
  }>
  warnings: string[]
}
```

### Adapter

Convert the parser output into `ComparisonProjectConflictResolutionTransferArtifactV1`.

For new PDFs with hidden row metadata:

- preserve canonical article ID as `sourceArticleRowId`
- preserve title/external ID
- preserve identifiers when available
- set `resolution.mode` from project metadata or infer summary mode if needed
- set `resolution.value` from the filled radio value

For old PDFs without hidden metadata:

- support same-project import only
- derive source article ID from the radio field name
- leave identifiers empty
- warn that cross-project matching is unavailable

### Analyze/Commit

PDF import reuses the same internal import analyzer/committer as JSON import.

- `/api/comparison-projects/:id/conflict-resolutions/import/analyze`
- `/api/comparison-projects/:id/conflict-resolutions/import/commit`

PDF-specific upload endpoints keep content-type behavior explicit:

- `POST /api/comparison-projects/:id/conflict-resolutions/import/pdf/analyze`
- `POST /api/comparison-projects/:id/conflict-resolutions/import/pdf/commit`

The response shape should stay compatible with the existing import results UI.

## Overwrite Handling

Imports must never silently overwrite existing conflict resolutions.

Analyze should classify each matched row:

- `insert`: no existing target resolution
- `overwrite`: existing target resolution differs
- `same-value`: existing target resolution is already the same
- `invalid-option`: PDF value is not allowed in the target project
- `not-conflict`: target article is not currently eligible when import mode is `conflicting-only`
- `ambiguous-match`
- `no-match`
- `duplicate-source-row`

The UI should show overwrite counts and examples before commit.

Commit should require an explicit overwrite policy:

```ts
type PdfConflictResolutionOverwriteMode = 'skip-existing' | 'overwrite-different'
```

Default should be `skip-existing`. `overwrite-different` should be an intentional user choice in the import screen.

When overwriting:

- record the reviewer display name from the PDF front page
- create a reviewer user ID during import; do not trust or require any reviewer ID from the PDF
- preserve enough information in the result summary to audit what changed
- schedule the existing deferred comparison-project checkpoint behavior

## UI Work

The existing import page supports PDF and JSON imports:

- accepts `.json` and `.pdf`
- detects file type by extension and MIME, then validates server-side
- keeps JSON import behavior unchanged
- uploads PDF files to the PDF analyze endpoint instead of reading them client-side as JSON
- shows the reviewer name parsed from the PDF, or `Unnamed reviewer` when blank
- shows overwrite controls only when analyze finds overwrite candidates
- shows clear errors for flattened PDFs or PDFs without filled resolution fields

## Test Plan

### Unit Tests

- `SimplePdfDocument` creates visible text fields.
- `SimplePdfDocument` creates hidden text fields included in `/AcroForm /Fields`.
- Existing radio group structure remains stable.
- PDF metadata values are base64url JSON and parse back correctly.

### Parser Tests

- Reads reviewer display name and does not read reviewer IDs from the PDF.
- Reads selected radio values.
- Ignores `/Off`.
- Rejects invalid field names.
- Handles escaped PDF strings.
- Handles base64url hidden metadata.
- Reports no-form/no-resolution/flattened-PDF errors.
- Supports old PDFs with only radio fields for same-project import.

### Server Tests

- Export PDF, fill synthetic radio values, analyze import, and get the expected preview.
- Commit same-project filled PDF and assert inserted rows.
- Commit with existing same-value rows and assert skip/same-value behavior.
- Analyze existing different-value rows and require explicit overwrite mode before changing them.
- Commit with `overwrite-different` and assert rows change.
- Reject invalid resolution values.
- Reject project/mode mismatch cleanly.
- Verify imported reviewer display name and import-generated reviewer ID are persisted.

### UI Tests

- `.json` import still works.
- `.pdf` upload calls PDF analyze path.
- PDF preview shows reviewer identity.
- Overwrite candidates enable an explicit overwrite choice.
- Commit button is disabled until analyze succeeds.
- Flattened/invalid PDF errors are shown.

### Real-World Test

Run against the local dev stack with a real generated export:

1. Start from a current DB with a comparison project that allows conflict resolution.
2. Export a PDF with conflicts.
3. Fill at least three radio groups in a normal PDF viewer:
   - one `yes`
   - one `no`
   - one `maybe`
4. Enter a reviewer name on the front page.
5. Import the filled PDF.
6. Confirm preview counts and reviewer identity.
7. Commit with default `skip-existing`.
8. Refresh Compare Project Judgments and verify the rows show the imported resolutions.
9. Re-import the same PDF and verify it reports same-value/skipped rows rather than duplicate writes.
10. Change one existing row in the app, re-import the PDF, and verify overwrite candidates are previewed without changing data unless `overwrite-different` is selected.

## Rollout Sequence

Completed:

1. Land PDF export front page and metadata.
2. Add PDF parser and artifact adapter behind tests.
3. Add server PDF analyze/commit endpoints.
4. Add UI upload/preview/overwrite controls.
5. Add explicit PDF `Not set` handling.
6. Remove exported reviewer IDs and generate reviewer IDs during import commit.
7. Add the prompt overview page after the front page.
8. Run local unit/server/UI/build gates and real-stack smoke tests.
9. Rebase-merge after GitHub topology passed on Ubuntu, macOS, and Windows.
