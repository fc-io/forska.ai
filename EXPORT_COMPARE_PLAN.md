# Export Compare Project Plan

## Goal And Theme

- Make comparison projects first-class transferable artifacts, not incidental project CSV exports.
- Reuse the existing project-transfer package, session, download, upload, analyze, dependency-resolution, and commit flow wherever possible.
- Preserve enough referenced project/article/judgment state to import a usable comparison project on another Forska instance.
- Treat this as a clean transfer-schema cutover; do not add legacy package compatibility shims.
- Support importing multiple projects in one transfer package because a comparison project can depend on several source projects.
- Prefer over-exporting referenced state to under-exporting; importing too much can be deduped, but missing required state makes the comparison import a no-op or blocker.
- Keep derived comparison serving and mart tables out of the package; rebuild them after import.
- Keep the existing `Export data` CSV flow separate from the new `Export Compare Project` package flow.

## Current State

- Normal project package export is implemented by `POST /api/projects/:id/export-project` in `src/server/routes/projectTransferRoutes.ts`.
- Project package assembly lives under `src/server/services/projectTransfer/`, especially `projectTransferExport.ts`, `projectTransferExportPackage.ts`, `projectTransferAnalyze.ts`, and `projectTransferCommitWriter.ts`.
- The import page is `/projects/import` and renders `src/app/routes/+projects/importWizard/importProjectWizard.tsx`.
- Project export UI uses `src/components/main/projectsGrid/projectTransferExportAction.tsx`.
- Comparison CSV export already exists as `POST /api/comparison-projects/:id/export` and includes conflict handling when conflict resolution is enabled.
- Comparison-project transfer payloads do not exist yet.
- Saved conflict resolutions are stored in `app.comparison_project_conflict_resolution` and belong to `app.comparison_project`, not `app.project`.

## Product Decisions

- Add a dedicated `Export Compare Project` action for transfer packages.
- Keep `Export data` as CSV and do not overload it with package transfer behavior.
- Add an `Import Compare Project` button on the compare projects page header in `src/app/routes/+compare-judgments/+index.tsx`.
- Add a route `/compare-judgments/import` that reuses the existing import wizard component and import endpoints.
- Keep `/projects/import` working for normal project packages.
- Allow one package to create or map multiple projects before creating or mapping the comparison project.
- Normal project exports should become a one-project instance of the same multi-project transfer schema.
- The import wizard should detect package type and show compare-project wording when the package is a comparison package.
- Export the full comparison-project scope, not the currently filtered table view.
- Export referenced source projects broadly when exact minimum scope is expensive or risky; correctness is more important than package size in v1.
- Rebuild comparison serving after import instead of exporting serving rows.

## Transfer Schema Direction

- Move the transfer manifest to a package-kind-aware schema with `packageKind: 'project' | 'comparisonProject'`.
- Do not preserve old package parsing behavior; update exporter and importer together.
- Replace the single-project assumption with a plural project payload model.
- A normal project package should contain one project in the plural project payload.
- A comparison-project package should contain the selected comparison project plus all referenced projects needed to render it.
- Payload key sets may differ by package kind, but the analyzer should validate the keys required for the declared package kind.
- Package fingerprints should include package kind and all project/comparison payloads so duplicate detection is deterministic.
- The import plan should describe every project create/reuse decision before the comparison project create/reuse decision.

## Package Contents

- `app.comparison_project` for the selected comparison project.
- `app.comparison_project_prompt` rows for the selected comparison project.
- `app.comparison_project_import_route` rows for the selected comparison project.
- `app.comparison_project_source_project` rows for the selected comparison project.
- `app.comparison_project_conflict_resolution` rows for the selected comparison project.
- Referenced source projects, including the summary source project when present.
- Articles in the comparison scope, with identifiers and import-route provenance.
- It is acceptable for v1 to include every article from referenced source projects if exact scope extraction risks omitting needed rows.
- Prompts used by the comparison project and referenced conflict-resolution prompt values.
- Models and provider dependencies needed by the comparison columns.
- Judgments, human judgments, human judgment summaries, assessments, and reviews needed to render the comparison.
- Judgment export must respect the comparison project's model IDs, prompts, source-project/import-route membership, content settings, and `deleted_at IS NULL` semantics.
- Full-text/runtime assets only through the existing project-transfer asset handling.
- Exclude comparison serving tables, project marts, queues, caches, logs, and other derived state.

## Implementation Checklist

- Add package-kind-specific payload keys to `src/server/services/projectTransfer/projectTransferSchemas.ts`.
- Add multi-project and compare-package payload types and contract checks to `projectTransferPayloadSchemas.ts`.
- Add `packageKind: 'project' | 'comparisonProject'` manifest metadata and update exporter/importer together without legacy compatibility.
- Convert normal project export/import to the plural project payload model with exactly one project.
- Add comparison-project payload fixtures and manifest tests.
- Extract reusable project-transfer export helpers so comparison export can reuse article, prompt, project, judgment, model, provider, and asset payload assembly.
- Build a comparison export context from `app.comparison_project` and its link tables.
- Resolve comparison article scope from base tables using the same source-project/import-route/content settings used by the comparison project; do not depend on comparison serving rows for export membership.
- Prefer including all referenced source-project rows over omitting rows that may be needed by the comparison.
- Add conflict-resolution payload assembly with stable provenance and signatures for article and prompt remapping.
- Add `POST /api/comparison-projects/:id/export-project` using the same inline-vs-background behavior as project export.
- Reuse the project-transfer session repository for queued comparison exports.
- Reuse the existing package download route when possible; otherwise generalize it without duplicating storage code.
- Add a client export action component by extracting shared logic from `ProjectTransferExportAction` and parameterizing the request path and labels.
- Add `Export Compare Project` on comparison project cards in `src/components/main/comparisonProjectsGrid.tsx`.
- Add `Export Compare Project` on the comparison project detail page in `src/app/routes/+compare-judgments/+$id/+index.tsx`.
- Add `Import Compare Project` button on `src/app/routes/+compare-judgments/+index.tsx`.
- Add `/compare-judgments/import` as a thin route that reuses the existing import wizard.
- Update import wizard copy so it can say `Import Project` or `Import Compare Project` based on package analysis.
- Extend package analysis to detect comparison-project packages and summarize compare payload counts.
- Extend target analysis to map multiple source projects, articles, prompts, models, import routes, and provider dependencies for comparison packages.
- Add duplicate detection for comparison projects using name plus payload fingerprint or comparison signature.
- Add import-plan rows for each project creation/reuse decision, comparison project creation/reuse, and conflict-resolution insertion.
- Add commit writer support for comparison packages in one transaction after referenced projects/articles/prompts/models are resolved.
- Remap `comparison_project_id`, `article_id`, `prompt_id`, source project IDs, import route IDs, and model IDs during commit.
- Record conflict-resolution import counts for imported rows, skipped unresolved articles, skipped invalid prompt/value rows, and conflicting existing target rows.
- Skip unresolved conflict-resolution rows with warnings; block only when there is no usable comparison project, no source projects can be created or mapped, or required prompt/model dependencies are unresolved.
- Queue comparison serving rebuild after successful import.
- Return completion metadata that includes `packageKind`, created/mapped project IDs, and `comparisonProjectId` when present.
- Add route inventory entries for new compare export/import aliases.
- Keep browser and desktop flows working by using existing API URL helpers and project-transfer temp/runtime paths.

## Reuse Targets

- Reuse `projectTransferExportPackage.ts` for session lifecycle, inline/background thresholding, zipping, metadata, checksums, and package fingerprints.
- Reuse `projectTransferExport.ts` payload builders after extracting single-project assumptions into multi-project source-scope helpers.
- Reuse `projectTransferAnalyze.ts` for zip extraction, manifest validation, payload checksums, package counts, and warning collection.
- Reuse `projectTransferAnalyzeTarget.ts` for article, prompt, model, provider, route, and duplicate matching.
- Reuse `projectTransferCommit.ts` and `projectTransferCommitWriter.ts` transaction, recovery, rollback, and history patterns.
- Reuse `projectTransferExportAction.tsx` download/polling behavior through a shared transfer-export action component.
- Reuse `ImportProjectWizard` rather than creating a second importer.

## Import Behavior

- The same uploaded package flow should handle project packages and comparison-project packages.
- Analysis should show package type, comparison project name, referenced project count, article count, judgment count, and conflict-resolution count.
- Dependency resolution should keep the existing model/provider flow.
- If referenced source projects already exist, import should map to them instead of duplicating them when signatures match.
- If referenced source projects are missing, import should create them using the existing project-transfer commit path generalized for multiple projects.
- If articles already exist, import should use current identifier/canonical matching rules.
- If conflict-resolution values disagree with existing target comparison rows, the plan should report a clear warning or blocker before commit based on whether the target comparison project can still be used safely.
- If the package contains extra projects, articles, judgments, or assets beyond the comparison scope, import should dedupe or ignore the extras without failing.
- If the package lacks required comparison dependencies, commit should no-op the unusable comparison import and surface blockers instead of creating a broken comparison project.
- After commit, navigate to the imported comparison project detail page.

## Tests

- Add payload contract tests for new comparison payload keys.
- Add manifest/fingerprint tests for comparison packages.
- Add export tests proving comparison packages include source projects, articles, judgments, and conflict resolutions.
- Add route tests for `POST /api/comparison-projects/:id/export-project` inline and queued responses.
- Add analyze tests for valid comparison packages, missing dependencies, duplicates, and conflicting target resolutions.
- Add commit tests for successful comparison import, remapped conflict resolutions, skipped unresolved conflict rows, and serving rebuild queueing.
- Add rollback tests proving partial comparison imports do not leave orphaned comparison rows.
- Add UI tests for the compare page `Import Compare Project` button and `Export Compare Project` action.
- Add import wizard tests for package-type-specific copy and navigation.

## Quality Gates

- `bun test src/server/services/projectTransfer/projectTransferPayloadSchemas.test.ts`
- `bun test src/server/services/projectTransfer/projectTransferManifest.test.ts`
- `bun test src/server/services/projectTransfer/projectTransferExport.test.ts`
- `bun test src/server/services/projectTransfer/projectTransferAnalyze.test.ts`
- `bun test src/server/services/projectTransfer/projectTransferCommit.test.ts`
- `bun test src/server/routes/projectTransferRoutes.test.ts`
- `bun test src/server/routes/ComparisonProjectsRoutes.rollback.test.ts`
- `bun test src/app/routes/+projects/-+import.vitest.tsx`
- Add and run a compare-project route/UI test for the import/export buttons.
- `bun run lint`
- `bun run build`
- Run `bun run desktop:build` if transfer temp paths, asset paths, runtime paths, or API URL wiring change.
- Browser verify exporting a compare project, importing it through the import page, opening the imported comparison, and seeing saved conflict resolutions intact.

## Non-Goals

- Do not replace the existing comparison CSV export.
- Do not export comparison serving/mart tables.
- Do not add a separate zip format outside project-transfer.
- Do not silently drop benchmark-critical model/provider settings.
- Do not import conflict resolutions without validating article and prompt remapping.
