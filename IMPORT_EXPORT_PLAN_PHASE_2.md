# Project Import/Export Plan Phase 2

## Scope

- Build full-fidelity package export after Phase 1 foundations exist.
- Source orchestrator: [IMPORT_EXPORT_PLAN.md](./IMPORT_EXPORT_PLAN.md).
- External prerequisite: Phase 1 is complete and the project-transfer route shell, manifest contracts, zip/path helpers, and session/history foundation are available.
- Do not build import analyze, import commit, or the full import wizard in this phase.

## Ralph Conversion Metadata

- `name`: `Project Transfer Export Assembly`
- `branchName`: `ralph/project-transfer-export`
- `description`: `Implement full-fidelity project package export, including scoped app-table reads, signatures, redaction, assets, export routes, and export actions.`
- Convert only `Ralph User Stories` into `userStories[]`.

## Ralph User Stories

### US-001: Add export app-table query contract

Description: As an implementer, I need project-transfer-specific export queries so active and archived projects can be packaged without reusing CSV or active-only review helpers.

dependsOn: []

Acceptance criteria:

- Add project-transfer export query helpers for project settings, prompts, project prompt links, import routes, project route links, articles, article route links, project article links, judgments, assessments, human judgments, human summaries, reviews, provider descriptors, and model descriptors.
- Export scope uses project date bounds and current review semantics directly from app tables, including archived source projects.
- Query tests cover archived package export, inactive source routes contributing to scope, disabled prompt-mode human judgment rows that current review detail exposes, and answered active judgment filtering.

Quality gates:

- `bun test src/server/services/projectTransfer/projectTransferExport.test.ts` passes.
- `bun test src/services/olap/duckdbOlap.test.ts` passes if the queue/date-scope parity patch is touched.
- `bun run lint` passes for touched `src` files.

### US-002: Add input signature helpers for exported durable state

Description: As an implementer, I need versioned signature helpers so exported judgments and human/review rows can be validated after target remapping.

dependsOn: ["US-001"]

Acceptance criteria:

- Add versioned `judgmentInputSignature` helper covering provider, model, prompt, article, content toggles, full-text processing, quote-validation, and chunking inputs from the orchestrator contract.
- Add versioned `humanReviewInputSignature` helper for prompt-mode human judgments, summary-mode human judgments, and review rows.
- Omit chunked-mode judgments without durable final-prompt/evidence proof and emit structured fidelity warnings.
- Tests cover signature stability, source-to-target database id remapping exclusion, chunked omission, `currentReviewRows` provenance, and mismatch omission.

Quality gates:

- `bun test src/server/services/projectTransfer/projectTransferExport.test.ts` passes.
- `bun run lint` passes for touched `src` files.

### US-003: Add package redaction and omission serializers

Description: As an implementer, I need package-boundary redaction to remove secrets and local paths without changing benchmark or review decisions silently.

dependsOn: ["US-001"]

Acceptance criteria:

- Add redaction serializers for project fields, prompt fields, article fields, provider fields, model metadata/config, URLs, full-text-derived fields, and free-form JSON/string fields.
- Required package fields remain importable through safe placeholders, parent-row failure, or parent-row omission with warnings.
- Decision fields that would change meaning are omitted with dependent rows and structured fidelity warnings rather than sanitized in place.

Quality gates:

- `bun test src/server/services/projectTransfer/projectTransferRedaction.test.ts` passes.
- `bun test src/server/services/projectTransfer/projectTransferExport.test.ts` passes.
- `bun run lint` passes for touched `src` files.

### US-004: Add export asset collection and asset manifest writer

Description: As an implementer, I need export-time asset copying and manifesting so imported packages never reference source-machine files or uncopied runtime assets.

dependsOn: ["US-001", "US-003"]

Acceptance criteria:

- Copy eligible runtime-relative `assets/...` files into package `assets/` after path validation and checksum verification.
- Write `assetManifest.json` with package path, checksum, byte size, and explicit references for `fullTextPdf`, `fullTextAssets`, and embedded `fullTextHtml` asset URLs.
- Missing, unreadable, symlinked, outside-root, and checksum-changing assets either fail export or omit and rewrite affected fields before manifest finalization.

Quality gates:

- `bun test src/server/services/projectTransfer/projectTransferExport.test.ts` passes.
- `bun test src/server/services/projectTransfer/projectTransferPaths.test.ts` passes.
- `bun run lint` passes for touched `src` files.

### US-005: Add export assembly service and package finalization

Description: As an implementer, I need a server export assembly service that writes deterministic payloads, manifest checksums, and package fingerprints from one source snapshot.

dependsOn: ["US-001", "US-002", "US-003", "US-004"]

Acceptance criteria:

- Assemble package payloads from one consistent DuckDB read transaction or equivalent snapshot.
- Write canonical JSON and deterministic NDJSON payloads, exact payload checksums, asset summary, warnings, and stable package fingerprint.
- Support inline small package creation and background export session artifact creation using Phase 1 session/history foundations.
- Emit structured runtime events for progress, omitted assets, redaction warnings, checksum failures, and package finalization.

Quality gates:

- `bun test src/server/services/projectTransfer/projectTransferExport.test.ts` passes.
- `bun test src/server/services/projectTransfer/projectTransferManifest.test.ts` passes.
- `bun run build` passes.
- `bun run lint` passes for touched `src` files.

### US-006: Add export routes and streaming download behavior

Description: As an implementer, I need package export API endpoints that preserve CSV export behavior and stream package downloads safely through the owner proxy.

dependsOn: ["US-005"]

Acceptance criteria:

- Add `POST /api/projects/:id/export-project` for active and archived source projects without `assertProjectIsActive`.
- Add large export session polling and download endpoints under `/api/projects/export/:exportId`.
- Existing CSV `POST /api/projects/:id/export` still resolves to the CSV export flow.
- Large export downloads stream through the owner proxy without materializing package bytes on follower servers.

Quality gates:

- `bun test src/server/routes/projectTransferRoutes.test.ts` passes.
- `bun test src/server/routes/ApiProxyRoutes.test.ts` passes.
- `bun test src/server/routes/ProjectsRoutes.test.ts` passes.
- `bun run build` passes.
- `bun run lint` passes for touched `src` files.

### US-007: Add export actions to active and archived project lists

Description: As a user, I want `Export Project` actions for active and archived projects so I can download or prepare a full-fidelity transfer package without changing CSV export behavior.

dependsOn: ["US-006"]

Acceptance criteria:

- Rename `src/components/main/ProjectsGrid.tsx` to `src/components/main/projectsGrid.tsx` with a Git-safe temporary filename step and update imports/mocks.
- Add `Export Project` next to `Export data` for active projects and preserve CSV `Export data` behavior.
- Add `Export Project` for archived projects without exposing CSV export for archived rows.
- Support inline downloads and large export-session polling with a preparing-download state.

Quality gates:

- `bunx vitest run src/components/main/projectsGrid.vitest.tsx` passes.
- `bunx vitest run src/app/routes/+projects/+archived/archivedProjectsTable.vitest.tsx` passes.
- `bun run build` passes.
- `bun run desktop:build` passes.
- `bun run lint` passes for touched `src` files.
