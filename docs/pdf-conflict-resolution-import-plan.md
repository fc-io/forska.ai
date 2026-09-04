# PDF Conflict-Resolution Import Plan

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

## Export Work Already Started

PDF export should include a front page before article pages.

The front page should contain:

- short explanation of Forska.ai comparison review PDFs
- intended offline review/import use case
- project name and comparison project ID
- export filters and export time
- row count
- GitHub link: `https://github.com/fc-io/forska.ai`
- visible fillable reviewer name field: `forska.reviewer.displayName`
- visible fillable reviewer ID field: `forska.reviewer.instanceId`

The reviewer ID should be generated into the PDF at export time. The user can leave it as-is. This lets two reviewers with the same display name remain separate during import. If the same filled PDF is imported again, the ID also gives the importer a stable reviewer identity for overwrite/duplicate handling.

PDF export should also embed hidden machine-readable fields:

- `forska.import.format`
- `forska.import.comparisonProject`
- `forska.reviewer.instance`
- `comparison.<project>.article.<article>.metadata`

The first implementation can embed project/article metadata using hidden AcroForm text fields with base64url-encoded JSON values. Longer term, a document-level metadata object or attachment can replace this if needed, but hidden fields are easy to inspect and parse with the existing custom PDF writer.

## Import Design

### Parser

Add a server-side PDF form parser. Do not parse PDFs in the browser.

Parser responsibilities:

- read AcroForm text fields and radio groups
- extract `forska.*` metadata fields
- extract filled `comparison.*.article.*.resolution` radio values
- ignore `/Off`
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
  reviewer: {
    displayName: string | null
    instanceId: string | null
  }
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

Reuse existing endpoints where possible:

- `/api/comparison-projects/:id/conflict-resolutions/import/analyze`
- `/api/comparison-projects/:id/conflict-resolutions/import/commit`

Two possible endpoint shapes:

1. Extend existing endpoints to accept both JSON and multipart PDF.
2. Add PDF-specific upload endpoints that parse to an artifact and then call the same internal analyze/commit helpers.

Recommended first slice: add PDF-specific analyze/commit upload endpoints to keep content-type behavior explicit:

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
- record or create a reviewer user ID derived from the PDF reviewer instance ID
- preserve enough information in the result summary to audit what changed
- schedule the existing deferred comparison-project checkpoint behavior

## UI Work

Update the existing import page:

- accept `.json` and `.pdf`
- detect file type by extension and MIME, then validate server-side
- keep JSON import behavior unchanged
- for PDF, upload to analyze endpoint instead of reading client-side JSON
- show reviewer name/ID parsed from PDF
- show warning if reviewer name is blank
- show overwrite mode control only when analyze finds overwrite candidates
- show clear errors for flattened PDFs or PDFs without filled resolution fields

## Test Plan

### Unit Tests

- `SimplePdfDocument` creates visible text fields.
- `SimplePdfDocument` creates hidden text fields included in `/AcroForm /Fields`.
- Existing radio group structure remains stable.
- PDF metadata values are base64url JSON and parse back correctly.

### Parser Tests

- Reads reviewer display name and reviewer instance ID.
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
- Verify imported reviewer display name and generated/stable reviewer ID are persisted.

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

1. Land PDF export front page and metadata.
2. Add PDF parser and artifact adapter behind tests.
3. Add server PDF analyze/commit endpoints.
4. Add UI upload/preview/overwrite controls.
5. Run local unit/server/UI/build gates.
6. Run the real-world PDF export/fill/import test.
7. Open PR and require GitHub topology on Ubuntu, macOS, and Windows.

