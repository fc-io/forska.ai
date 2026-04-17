# Project Import/Export Plan

## Goal

- Let one Forska user export a project and another Forska user import it as a new project without breaking project, article, prompt, model, provider, and judgment relationships.
- Keep the existing CSV-style `Export data` flow untouched and add a separate full-fidelity `Export Project` flow.
- Make import a guided review flow so the receiving user can inspect the package and resolve missing providers or models before any project rows are written.
- Keep the normal browser flow and the desktop flow working with the same API contract.

## Product Decisions

- Add an `Export Project` button in `src/components/main/ProjectsGrid.tsx` immediately next to the existing `Export data` button.
- Add an `Import Project` button in `src/app/routes/+projects/+index.tsx` immediately to the left of `Create Covidence Project`.
- Keep `Export data` mapped to the current `/projects/$id/export` CSV page.
- Make `Import Project` open a dedicated wizard route at `/projects/import` because the import flow needs multiple review and setup steps.
- Make `Export Project` a direct package download from the grid unless implementation complexity forces a small intermediate page.

## Package Shape

- Export one zip file, for example `my-project-2026-04-17.forska-project.zip`.
- Put a versioned manifest at the root so imports can validate compatibility before any write starts.
- Store the package as plain JSON or NDJSON plus file assets so it is inspectable and diffable.

### Suggested Contents

- `manifest.json`
- `project.json`
- `providers.json`
- `models.json`
- `prompts.json`
- `articles.ndjson`
- `judgments.ndjson`
- `judgmentAssessments.ndjson`
- `humanJudgments.ndjson`
- `humanJudgmentSummaries.ndjson`
- `reviews.ndjson`
- `assets/` for any exported local article files that must be rewritten on import

### Manifest Fields

- `schemaVersion`
- `exportedAt`
- `sourceAppVersion`
- `packageFingerprint` as a stable hash over manifest core and payload checksums, excluding volatile timestamps, so re-exports of the same logical package can warn on duplicate re-import
- `project` summary with source id, name, counts, human judgment mode, and current model reference
- `warnings` for omitted secrets, omitted deleted judgments, local-only config, and unresolved runtime-specific data
- `payloads` with row counts, checksums, and byte sizes for each payload file

## Exported Data Scope

### Include

- Project settings from `app.project`, including name, description, date bounds, content toggles, and `human_judgment_mode`.
- Prompt definitions and project prompt links from `app.prompt` and `app.project_prompt`, including order, enabled state, archive state, and criteria fields.
- Project route scope from `app.project_import_route` and referenced `app.import_route` rows.
- Project article links from `app.project_article`.
- Referenced article rows from `app.article` and `app.article_import_route`, including article identity fields (`article_id`, DOI, PubMed id, arXiv id, medRxiv id, bioRxiv id), citation metadata, title, summary, authors, article version, article timestamps, URL, publication status, `original_data`, `source_metadata`, `full_text`, `full_text_html`, `full_text_pdf`, `full_text_source`, `full_text_original_format`, `full_text_fetched_at`, `full_text_assets`, and `full_text_char_count`.
- All active project judgments from `app.judgment` where `deleted_at IS NULL`.
- Linked judgment assessments from `app.judgment_assessment` for exported judgments.
- Project human judgments from `app.judgment_human`.
- Project summary human judgments from `app.judgment_human_summary`.
- Project review state from `app.review`.
- All provider and model descriptors needed by the project row and by imported judgments, not just the project's current `model_id`.

### Do Not Include

- API keys, secret refs, auth tokens, device login state, or any provider secret store values.
- Local Codex login status and local Codex binary paths like `codexBin`.
- Runtime-detection cache, worker health, endpoint health, logs, temp files, or machine-local status snapshots.
- `app.judgment_job`, `app.token_use`, `app.llm_status`, `app.nvidia_smi`, or any job-runtime artifacts.
- `app.project_mart_refresh_state`, `app.project_mart_refresh_article_state`, `app.project_mart_large_rebuild_state`, or any `mart.*` tables.
- Soft-deleted judgments in v1; deleted rows stay out of the package.

## Provider And Model Export Rules

- Export provider connections as sanitized dependency descriptors, not as trusted live credentials.
- Include safe fields such as `providerKind`, `label`, `authMode`, `baseURL`, `maxInflightRequests`, and reviewable config values.
- Treat machine-local values such as manual worker URLs as hints that the importer must confirm or edit, not as silent defaults.
- Export models with enough identity to re-link judgments correctly: `remoteModelId`, `displayName`, `variant`, provider kind, connection reference, and metadata.
- Export the full dependency set for all model ids referenced by the project and its judgments.
- Reuse the existing provider setup flows during import instead of inventing a separate import-only credential path.
- Use the normal provider endpoints for dependency setup where possible, especially `/api/provider-auth/:providerKind/*`, `/api/provider-connections`, and `/api/models/ensure`.

### Codex Special Handling

- Export Codex model descriptors, but never export Codex login state, Codex secrets, or local `codex` executable paths.
- During import, show Codex dependencies as `setup required` until the receiving user confirms or creates the local Codex connection.
- Reuse the existing singleton Codex connection behavior and `POST /api/models/ensure` flow to materialize imported Codex models on the target machine.
- Block final import while any required Codex-backed model is unresolved.

## Identity And Mapping Rules

- Never trust exported database ids as target ids.
- Keep exported ids as `sourceId` values in the package and build explicit old-to-new maps during import.
- Import always creates a new `app.project` row in v1; do not overwrite an existing project.
- Rebuild all project-scoped foreign keys from the mapping tables inside one import transaction.

### Duplicate And Overlap Strategy

- Import never merges into an existing project in v1; each successful import creates a new project.
- During analyze, compute or validate the package fingerprint and compare it with previously completed imports recorded by the app.
- If the fingerprint matches a prior import exactly, show a non-blocking `already imported on this machine` warning with the prior imported project name, id, and timestamp.
- If the package is not an exact duplicate but overlaps existing data, show an overlap summary instead of a duplicate warning: reused article count, new article count, omitted route-link count, and any judgment conflicts.
- Exact package duplicates stay allowed because users may intentionally create parallel copies, but the warning must appear before final confirmation.

### Mapping Strategy

- `project`: always create a new target id.
- `prompt`: always create detached prompt rows, similar to the existing clone flow in `src/server/routes/ProjectsRoutes.ts`, so imported prompts stay self-contained and `origin_project_id` can point at the new imported project.
- `import_route`: match by `route`; if a route is missing on the target, show it in preview and require the user to accept omitting that route link or cancel the import.
- `article`: match only on exact stable identifiers in priority order: `article_id`, normalized DOI, normalized PubMed id, normalized arXiv id, normalized medRxiv id, and normalized bioRxiv id. If no exact match exists, create a new article. If multiple candidates or conflicting exact identifiers appear, stop and require manual review instead of heuristic auto-linking.
- `project_article`: always create a new link row for the imported project, even when the article row is reused, and set `imported_from_project_id` to `NULL` in v1 because the source project does not exist on the target.
- `provider_connection`: match by provider kind plus safe connection fingerprint; otherwise let the user choose an existing connection or create a new sanitized one.
- `model`: match by mapped provider connection plus `remote_model_id` and `variant`; otherwise create it during import after the user resolves the provider step.

### Source Project Provenance Fields

- `project_prompt.origin_project_id`: set to the new imported project id so imported detached prompts remain self-contained and keep the same local semantics as cloned prompts.
- `project_article.imported_from_project_id`: leave `NULL` in v1 and keep source-project provenance only in the manifest, import session summary, and post-import warnings.

## Article And Asset Rules

- Preserve enough article content for imported judgments and review screens to stay meaningful.
- If an article references local file-backed content such as PDFs or extracted assets, export the actual files into `assets/` and not just the stored path string.
- On import, validate asset paths before extraction, reject absolute paths and `..` traversal, write files into the target runtime storage location, and rewrite stored paths to the new location.
- If an article match already exists on the target, merge non-destructively: fill missing target fields, do not erase richer target data, and still link the article to the imported project.
- Title, year, author, and source-metadata heuristics may help the review UI explain likely matches, but they must not silently auto-link an article in v1.

## Judgment Integrity Rules

- Export and import only active judgments where `deleted_at IS NULL` in v1.
- Import judgments only after article, prompt, and model mappings are fully resolved.
- Rewrite every judgment foreign key to target ids before insert.
- Detect judgment identity collisions before commit because `app.judgment` is unique by article, prompt, model, and content toggles rather than by project. In v1, reuse an existing target judgment only when the stored payload matches exactly; otherwise block the import and show a conflict.
- Preserve answer payloads, explanation, quotes, chunking strategy, and timestamps where safe.
- Rewrite `project_id` to the new imported project id.
- Rewrite `snapshot_project_id` to the new imported project id so the imported project's review and mart queries continue to work.
- Preserve `snapshot_project_model_name` from the imported payload, but prefer the resolved target model label when a safe replacement is available.
- Re-link `app.judgment_assessment`, `app.judgment_human`, `app.judgment_human_summary`, and `app.review` through the new project, prompt, article, and judgment ids.

## Import UX

- Do not write the project into the main tables until the final confirmation step.
- Use a server-side import session so large uploads, preview state, and asset extraction do not live only in browser memory.
- Store staged uploads in an app temp/runtime path, not under the repo root.
- Stream the uploaded `.forska-project.zip` directly to temp storage instead of buffering the whole file in browser or server memory.
- Give each import session a TTL, package size cap, extracted asset size cap, and cleanup on commit, cancel, expiry, and best-effort startup recovery.
- Validate zip members before extraction and reject duplicate normalized paths, checksum mismatches, absolute paths, and `..` traversal.
- For very large packages, run extraction, checksum validation, and analyze work as a server-side background job tied to the import session; the UI polls progress instead of waiting on one long request.
- Keep a small-package fast path so modest imports can still analyze inline without extra job orchestration.

### Import Steps

1. Upload package.
   - Stream the `.forska-project.zip` upload into runtime temp storage.
   - Validate zip structure and `manifest.json`.
   - Create an import session and extract payload files into temp storage.
   - If the package crosses the configured threshold, continue extraction and analyze asynchronously and show progress until the session is ready.
2. Review package.
    - Show project name, source app version, counts for prompts, articles, judgments, human judgments, reviews, providers, and models.
    - Show explicit warnings for fields that were intentionally not exported.
    - Show exact-duplicate import warnings when the package fingerprint matches a prior completed import on this machine.
3. Resolve providers and models.
    - Auto-match what can be matched safely.
    - Show missing or ambiguous provider connections.
    - Let the user map to an existing connection, create a sanitized new connection, or launch Codex setup where needed.
    - Let the user create missing models from the resolved provider connection.
4. Review import plan.
    - Show which articles will be reused versus newly created.
    - Show which import routes will be linked versus omitted.
    - Show the final model mapping for the project and all imported judgments.
    - Show overlap counts and any prior-import warning again before confirmation.
5. Confirm import.
    - Run one transaction that creates the project, prompts, links, articles, judgments, human judgments, reviews, and assessments.
    - For large imports, let the server own the long-running commit work and expose session progress while the transactional write is in flight.
    - Mark the new project dirty and queue mart refresh after the transaction succeeds.
6. Finish.
   - Navigate to the new project.
   - Show post-import warnings, such as omitted route links or provider connections that still need credential setup.

## Server Design

- Keep the current CSV export logic in `src/server/routes/ProjectExportRoutes.ts` unchanged.
- Add a dedicated project-transfer route module, for example `src/server/routes/ProjectTransferRoutes.ts`, so package export and package import do not bloat the CSV export file.
- Add a service layer under something like `src/server/services/projectTransfer/` for package assembly, session parsing, mapping, and commit logic.
- Validate incoming import payloads with ArkType at the route boundary.
- Reuse the existing provider connection and provider auth services during dependency resolution instead of duplicating credential setup logic inside project import.
- Anchor staged uploads, extracted assets, and rewritten file paths to the runtime-writable root so browser mode and desktop mode share the same contract.
- Support threshold-based execution modes: inline for small packages, background session jobs for large export assembly and large import analyze work.
- Record completed imports in a small transfer-history store with package fingerprint, source project summary, imported project id, imported at, and counts so analyze can warn on exact duplicate packages later.
- Keep the final commit transactional and fail-fast when any required model mapping is unresolved.

### Suggested API Surface

- `POST /api/projects/:id/export-project`
  - inline file response for small packages
  - `202 Accepted` plus export session metadata for large packages
- `GET /api/projects/export/:exportId`
- `GET /api/projects/export/:exportId/download`
- `POST /api/projects/import/analyze`
- `GET /api/projects/import/:sessionId`
- `POST /api/projects/import/:sessionId/resolve-dependencies`
- `POST /api/projects/import/:sessionId/commit`
- `DELETE /api/projects/import/:sessionId`

## UI Files To Touch

- `src/components/main/ProjectsGrid.tsx`
- `src/app/routes/+projects/+index.tsx`
- new `src/app/routes/+projects/+import.tsx`
- likely new client helpers near `src/app/routes/+admin/+models/providerConnectionsClient.ts`
- possibly a small shared provider-model resolution component reused from `src/app/routes/+projects/+create.tsx`
- update route tests in `src/app/routes/+projects/-+index.vitest.tsx`

## Phase Checklist

### Phase 1 - Contract And Schemas

- [ ] Lock the manifest schema, payload file list, and explicit exported field set, including article fields and omission warnings.
- [ ] Define import-session state, source-to-target id maps, unresolved dependency statuses, and judgment-collision reporting.
- [ ] Pick the zip implementation and lock checksum, package fingerprint, path-normalization, and size-limit rules before writing route handlers.
- [ ] Define the thresholds that switch export/analyze work from inline requests to background session jobs.

#### Quality Gates

- [ ] Add and run `bun test src/server/services/projectTransfer/projectTransferManifest.test.ts`

### Phase 2 - Export Assembly

- [ ] Build server-side package export assembly with manifest generation, JSON/NDJSON payload writers, active-judgment filtering, package fingerprinting, and sanitized provider/model export.
- [ ] Collect local article assets, copy them into `assets/`, and record the metadata needed for safe import-time path rewriting.
- [ ] Add `POST /api/projects/:id/export-project`, support inline download for small packages, and add a background export session path for large packages.
- [ ] Wire the new `Export Project` action in `src/components/main/ProjectsGrid.tsx`, including a `preparing download` state when the export runs asynchronously.

#### Quality Gates

- [ ] Add and run `bun test src/server/routes/ProjectTransferRoutes.test.ts`
- [ ] Add and run `bun test src/server/services/projectTransfer/projectTransferExport.test.ts`

### Phase 3 - Analyze And Resolve Dependencies

- [ ] Build upload/analyze session endpoints, staged extraction, TTL cleanup, preview summaries, unresolved-warning reporting, and background progress for large packages.
- [ ] Implement provider connection auto-match, existing-connection selection, managed-provider auth handoff, and Codex `POST /api/models/ensure` materialization.
- [ ] Implement conservative article matching, route-link omission review, and conflict detection before commit.
- [ ] Implement exact duplicate-package detection from package fingerprint plus overlap summaries for partial matches.
- [ ] Build the `/projects/import` wizard for upload, package review, dependency resolution, and final plan review.

#### Quality Gates

- [ ] Add and run `bun test src/server/services/projectTransfer/projectTransferAnalyze.test.ts`
- [ ] Add and run `bun test src/server/services/projectTransfer/projectTransferDependencyResolution.test.ts`
- [ ] Add and run `bun test src/server/services/projectTransfer/projectTransferDuplicateDetection.test.ts`
- [ ] Add and run `bun test src/app/routes/+projects/-+import.vitest.tsx`

### Phase 4 - Commit And Post-Import Behavior

- [ ] Implement the final transaction that creates the new project, detached prompts, article links, judgments, human judgments, summaries, reviews, and assessments with remapped ids.
- [ ] Set `project_prompt.origin_project_id` to the new imported project id and keep `project_article.imported_from_project_id` null in v1.
- [ ] Mark the new project dirty, queue mart refresh, navigate to the imported project, and surface post-import warnings for omitted links or unfinished provider setup.

#### Quality Gates

- [ ] Add and run `bun test src/server/services/projectTransfer/projectTransferCommit.test.ts`
- [ ] `bun test src/server/routes/providerProjectFlow.e2e.test.ts`
- [ ] `bun test src/app/routes/+projects/-+index.vitest.tsx`

### Phase 5 - Browser And Desktop Verification

- [ ] Verify the browser flow for direct download on small exports, background `preparing download` behavior on large exports, upload, dependency resolution, commit, and post-import review screens.
- [ ] Verify the desktop flow for package download, runtime-writable asset extraction, upload, duplicate warnings, and navigation to the imported project.
- [ ] Run the repo-native build and lint checks for touched layers without fixing unrelated issues.

#### Quality Gates

- [ ] `bun run build`
- [ ] `bun run lint`
- [ ] `bun run desktop:build`

## Risks And Decisions To Lock Early

- Article matching stays exact-identifier-only in v1; heuristics can explain likely matches in review but cannot silently auto-link.
- Judgment collision handling must be locked early because `app.judgment` uniqueness is global by article, prompt, model, and content settings rather than by project.
- Imported detached prompts should point `origin_project_id` at the new imported project, and imported project-article links should leave `imported_from_project_id` null.
- Local provider URLs and worker URLs are transferable only as review hints, not as trustworthy defaults.
- Missing import routes need a clear product rule: block, omit with warning, or map manually.
- Large project packages need tuned thresholds for switching from inline requests to background jobs so the small-package UX stays fast without risking timeouts or memory spikes.
- Package fingerprint semantics must stay stable across equivalent re-exports while still distinguishing meaningful content changes.
- Asset rewrite logic must work in browser mode and desktop mode without writing into repo-root paths.

## Done Criteria

- A user can export a project from the projects grid with a new `Export Project` action.
- A receiving user can start import from a new `Import Project` action on the projects index page.
- The import wizard shows a clear review step before any write.
- Very large package export and analyze flows switch to server-side progress-aware jobs instead of buffering everything into one request.
- Missing providers and models can be resolved during import, including Codex-specific setup.
- API keys, Codex login state, and other secrets are never exported.
- Exact duplicate package imports warn before confirmation, and overlapping imports show clear reuse-versus-create counts.
- Imported prompts, articles, judgments, human judgments, reviews, and assessments all point to correct target ids after import.
- The imported project renders correctly in review flows after mart refresh.
- The browser flow still works, and the shared desktop flow still works.

## Quality Gates

- `bun test src/server/routes/ProjectsRoutes.test.ts`
- Add and run `bun test src/server/routes/ProjectTransferRoutes.test.ts`
- Add and run `bun test src/server/services/projectTransfer/projectTransferManifest.test.ts`
- Add and run `bun test src/server/services/projectTransfer/projectTransferExport.test.ts`
- Add and run `bun test src/server/services/projectTransfer/projectTransferAnalyze.test.ts`
- Add and run `bun test src/server/services/projectTransfer/projectTransferDependencyResolution.test.ts`
- Add and run `bun test src/server/services/projectTransfer/projectTransferDuplicateDetection.test.ts`
- Add and run `bun test src/server/services/projectTransfer/projectTransferCommit.test.ts`
- `bun test src/server/routes/providerProjectFlow.e2e.test.ts`
- `bun test src/app/routes/+projects/-+index.vitest.tsx`
- Add and run `bun test src/app/routes/+projects/-+import.vitest.tsx`
- `bun run build`
- `bun run lint`
- `bun run desktop:build`
- Browser verify: export a project package, import it through `/projects/import`, and confirm the imported project shows the expected prompts, articles, judgments, and reviews.
- Desktop verify: export and import the same package in the desktop build and confirm file picking, upload, and post-import project navigation work.

## Commands Run For This Plan

- No shell commands. This plan is based on repo file inspection and route/schema review.
