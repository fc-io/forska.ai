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
- `project` summary with source id, name, counts, and current model reference
- `warnings` for omitted secrets, local-only config, and unresolved runtime-specific data
- checksums or file sizes for each payload file

## Exported Data Scope

### Include

- Project settings from `app.project`, including name, description, date bounds, content toggles, and `human_judgment_mode`.
- Prompt definitions and project prompt links from `app.prompt` and `app.project_prompt`, including order, enabled state, archive state, and criteria fields.
- Project route scope from `app.project_import_route` and referenced `app.import_route` rows.
- Project article links from `app.project_article`.
- Referenced article rows from `app.article` and `app.article_import_route`, including source metadata and any review-relevant full text fields.
- All project judgments from `app.judgment`.
- Linked judgment assessments from `app.judgment_assessment`.
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

## Provider And Model Export Rules

- Export provider connections as sanitized dependency descriptors, not as trusted live credentials.
- Include safe fields such as `providerKind`, `label`, `authMode`, `baseURL`, `maxInflightRequests`, and reviewable config values.
- Treat machine-local values such as manual worker URLs as hints that the importer must confirm or edit, not as silent defaults.
- Export models with enough identity to re-link judgments correctly: `remoteModelId`, `displayName`, `variant`, provider kind, connection reference, and metadata.
- Export the full dependency set for all model ids referenced by the project and its judgments.

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

### Mapping Strategy

- `project`: always create a new target id.
- `prompt`: always create detached prompt rows, similar to the existing clone flow in `src/server/routes/ProjectsRoutes.ts`, so imported prompts stay self-contained.
- `import_route`: match by `route`; if a route is missing on the target, show it in preview and require the user to accept omitting that route link or cancel the import.
- `article`: prefer matching by stable article identity such as `article_id`; if that is missing or does not match, fall back to DOI, PubMed id, arXiv id, or source metadata heuristics, then create a new article only when no safe match exists.
- `project_article`: always create a new link row for the imported project, even when the article row is reused.
- `provider_connection`: match by provider kind plus safe connection fingerprint; otherwise let the user choose an existing connection or create a new sanitized one.
- `model`: match by mapped provider connection plus `remote_model_id` and `variant`; otherwise create it during import after the user resolves the provider step.

## Article And Asset Rules

- Preserve enough article content for imported judgments and review screens to stay meaningful.
- If an article references local file-backed content such as PDFs or extracted assets, export the actual files into `assets/` and not just the stored path string.
- On import, write those files into the target runtime storage location and rewrite stored paths to the new location.
- If an article match already exists on the target, merge non-destructively: fill missing target fields, do not erase richer target data, and still link the article to the imported project.

## Judgment Integrity Rules

- Import judgments only after article, prompt, and model mappings are fully resolved.
- Rewrite every judgment foreign key to target ids before insert.
- Preserve answer payloads, explanation, quotes, chunking strategy, and timestamps where safe.
- Rewrite `project_id` to the new imported project id.
- Rewrite `snapshot_project_id` to the new imported project id so the imported project's review and mart queries continue to work.
- Preserve `snapshot_project_model_name` from the imported payload, but prefer the resolved target model label when a safe replacement is available.
- Re-link `app.judgment_assessment`, `app.judgment_human`, `app.judgment_human_summary`, and `app.review` through the new project, prompt, article, and judgment ids.

## Import UX

- Do not write the project into the main tables until the final confirmation step.
- Use a server-side import session so large uploads, preview state, and asset extraction do not live only in browser memory.
- Store staged uploads in an app temp/runtime path, not under the repo root.

### Import Steps

1. Upload package.
   - Validate zip structure and `manifest.json`.
   - Create an import session and extract payload files into temp storage.
2. Review package.
   - Show project name, source app version, counts for prompts, articles, judgments, human judgments, reviews, providers, and models.
   - Show explicit warnings for fields that were intentionally not exported.
3. Resolve providers and models.
   - Auto-match what can be matched safely.
   - Show missing or ambiguous provider connections.
   - Let the user map to an existing connection, create a sanitized new connection, or launch Codex setup where needed.
   - Let the user create missing models from the resolved provider connection.
4. Review import plan.
   - Show which articles will be reused versus newly created.
   - Show which import routes will be linked versus omitted.
   - Show the final model mapping for the project and all imported judgments.
5. Confirm import.
   - Run one transaction that creates the project, prompts, links, articles, judgments, human judgments, reviews, and assessments.
   - Mark the new project dirty and queue mart refresh after the transaction succeeds.
6. Finish.
   - Navigate to the new project.
   - Show post-import warnings, such as omitted route links or provider connections that still need credential setup.

## Server Design

- Keep the current CSV export logic in `src/server/routes/ProjectExportRoutes.ts` unchanged.
- Add a dedicated project-transfer route module, for example `src/server/routes/ProjectTransferRoutes.ts`, so package export and package import do not bloat the CSV export file.
- Add a service layer under something like `src/server/services/projectTransfer/` for package assembly, session parsing, mapping, and commit logic.
- Validate incoming import payloads with ArkType at the route boundary.
- Keep the final commit transactional and fail-fast when any required model mapping is unresolved.

### Suggested API Surface

- `POST /api/projects/:id/export-project`
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

## Implementation Order

1. Define the export manifest schema and package format.
2. Build server-side project export assembly, including asset collection and sanitized dependency export.
3. Build import session parsing and preview generation.
4. Build provider and model resolution logic, including Codex-specific setup handling.
5. Build the final import transaction with id remapping for project, prompt, article, judgment, and review data.
6. Add the projects-page buttons and the `/projects/import` wizard UI.
7. Add browser and desktop verification for upload, download, and post-import project behavior.

## Risks And Decisions To Lock Early

- Article matching rules must be conservative enough to avoid linking imported judgments to the wrong existing article.
- Local provider URLs and worker URLs are transferable only as review hints, not as trustworthy defaults.
- Missing import routes need a clear product rule: block, omit with warning, or map manually.
- Large project packages may need streaming zip generation and staged extraction to avoid memory spikes.
- Asset rewrite logic must work in browser mode and desktop mode without writing into repo-root paths.

## Done Criteria

- A user can export a project from the projects grid with a new `Export Project` action.
- A receiving user can start import from a new `Import Project` action on the projects index page.
- The import wizard shows a clear review step before any write.
- Missing providers and models can be resolved during import, including Codex-specific setup.
- API keys, Codex login state, and other secrets are never exported.
- Imported prompts, articles, judgments, human judgments, reviews, and assessments all point to correct target ids after import.
- The imported project renders correctly in review flows after mart refresh.
- The browser flow still works, and the shared desktop flow still works.

## Quality Gates

- `bun test src/server/routes/ProjectsRoutes.test.ts`
- Add and run `bun test src/server/routes/ProjectTransferRoutes.test.ts`
- `bun test src/server/routes/providerProjectFlow.e2e.test.ts`
- `bun test src/app/routes/+projects/-+index.vitest.tsx`
- Add and run `bun test src/app/routes/+projects/-+import.vitest.tsx`
- `bun run build`
- `bun run lint`
- `bun run desktop:build`
- Browser verify: export a project package, import it through `/projects/import`, and confirm the imported project shows the expected prompts, articles, judgments, and reviews.
- Desktop verify: export and import the same package in the desktop build and confirm file picking, upload, and post-import project navigation work.

## Commands Run For This Plan

- None. This plan is based on repo inspection only.
