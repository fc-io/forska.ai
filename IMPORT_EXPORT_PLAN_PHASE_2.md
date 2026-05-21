# Project Import/Export Plan Phase 2

## Scope

- Build full-fidelity package export on top of the Phase 1 foundations that already exist.
- Source orchestrator: [IMPORT_EXPORT_PLAN.md](./IMPORT_EXPORT_PLAN.md).
- External prerequisite: the Phase 1 project-transfer route shell, manifest contracts, zip/path helpers, payload schema contracts, identifier helpers, execution gates, route ordering, streaming owner-proxy branch, runtime-asset path validation, recovery, and session/history foundation are available.
- Current repo anchor points: product API route composition is in `src/server/routes/productApiRoutes.ts#getProductApiRoutes()`, placeholder transfer endpoints are in `src/server/routes/projectTransferRoutes.ts`, route owner-proxy classification is in `src/server/routes/apiRouteClassification.ts`, streaming proxying is in `src/server/routes/ApiProxyRoutes.ts`, export/import temp layouts are in `src/server/services/projectTransfer/projectTransferSession.ts`, and shared project-transfer contracts are under `src/server/services/projectTransfer/`.
- Phase 2 should extend the Phase 1 project-transfer files instead of creating parallel manifest, payload, fingerprint, path, zip, session, or contract implementations.
- Do not build import analyze, import commit, or the full import wizard in this phase.

## Ralph Conversion Metadata

- `name`: `Project Transfer Export Assembly`
- `branchName`: `ralph/project-transfer-export`
- `description`: `Implement full-fidelity project package export on the Phase 1 project-transfer foundation, including scoped app-table reads, signatures, redaction, assets, export routes, export session metadata, and export actions.`
- Convert only `Ralph User Stories` into `userStories[]`.
- Use `dependsOn` as the implementation order; heading order is not guaranteed to be topological.
- For each story, combine `Acceptance criteria` with the relevant commands from `Quality gates` and the final `Phase 2 Checklist` into `acceptanceCriteria[]`.

## Ralph User Stories

### US-001: Add export app-table query contract

Description: As an implementer, I need project-transfer-specific export queries so active and archived projects can be packaged without reusing CSV or active-only review helpers.

dependsOn: []

Acceptance criteria:

- Add project-transfer export query helpers for project settings, prompts, project prompt links, import routes, project route links, articles, article route links, project article links, judgments, assessments, human judgments, human summaries, reviews, provider descriptors, and model descriptors.
- Export scope uses project date bounds and current review semantics directly from app tables, including archived source projects and `NULL article_created_at` date-bound behavior from the orchestrator.
- Query helpers do not reuse CSV export routes, review-detail helpers, mart tables, or active-only access guards such as `assertProjectIsActive`.
- Query tests cover archived package export, inactive source routes contributing to scope, date-bounded route and curated article scope, disabled prompt-mode human judgment rows that current review detail exposes, summary-mode human/review rows, answered active judgment filtering, active visible-key judgment duplicate ambiguity, and missing provider/model rows that must not be silently inner-join-dropped.

Quality gates:

- `bun test src/server/services/projectTransfer/projectTransferExport.test.ts` passes.
- `bun test src/services/olap/duckdbOlap.test.ts` passes if the queue/date-scope parity patch is touched.
- `bun test src/server/routes/projectsRoutes/projectsRoutesPostArticleReviewDetails.test.ts` passes if review-detail date-scope or human-prompt scope semantics are changed.
- `bun run lint` passes for touched `src` files.

### US-002: Add input signature helpers for exported durable state

Description: As an implementer, I need versioned signature helpers so exported judgments and human/review rows can be validated after target remapping.

dependsOn: ["US-001"]

Acceptance criteria:

- Add versioned `judgmentInputSignature` helper covering provider, model, prompt, article, content toggles, full-text processing, quote-validation, and chunking inputs from the orchestrator contract.
- Add versioned `humanReviewInputSignature` helper for prompt-mode human judgments, summary-mode human judgments, and review rows.
- Place signature helpers with the export package code or existing payload schema code; do not add a second package-schema layer that bypasses `projectTransferPayloadSchemas.ts`.
- Keep source and target database ids out of signatures, matching the existing `projectTransferPayloadSchemas.ts` signature contract.
- Omit chunked-mode judgments without durable final-prompt/evidence proof and emit structured fidelity warnings.
- Tests cover signature stability, source-to-target database id remapping exclusion, chunked omission, `currentReviewRows` provenance, and mismatch omission.

Quality gates:

- `bun test src/server/services/projectTransfer/projectTransferExport.test.ts` passes.
- `bun run lint` passes for touched `src` files.

### US-003: Add package redaction and omission serializers

Description: As an implementer, I need package-boundary redaction to remove secrets and local paths without changing benchmark or review decisions silently.

dependsOn: ["US-001"]

Acceptance criteria:

- Add `src/server/services/projectTransfer/projectTransferRedaction.ts` for package-boundary redaction serializers covering project fields, prompt fields, article fields, provider fields, model metadata/config, URLs, full-text-derived fields, and free-form JSON/string fields.
- Extend the existing Phase 1 manifest/payload warning, redaction, omission, and severity contracts when new export warnings are needed, including `fidelity` and `blocking` severities from the orchestrator contract; do not emit one-off warning shapes outside the manifest/payload contracts.
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
- Write `assetManifest.json` with package path, checksum, byte size, and explicit `references[]` for `fullTextPdf`, `fullTextAssets`, and embedded `fullTextHtml` asset URLs.
- Extend `ProjectTransferAssetPayloadRecord` to include the asset reference metadata required by the orchestrator before export assembly writes `assetManifest.json`.
- Missing, unreadable, symlinked, outside-root, and checksum-changing assets either fail export or omit and rewrite affected fields before manifest finalization.
- Export never writes manifest asset references for files that were not copied and checksummed.

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
- Use existing Phase 1 payload keys and paths from `projectTransferSchemas.ts`; every manifest-declared payload is present even when empty.
- Support inline small package creation and background export session artifact creation using Phase 1 session foundations, `projectTransferExportArtifacts`, and `getProjectTransferExportTempLayout()`.
- Use the Phase 1 thresholds in `projectTransferExecutionThresholds`: inline when package `<= 128 MB` and assets `<= 64 MB`; otherwise create an export session.
- Persist export session state/progress through `projectTransferSessionRepository.ts`, including `queued -> assembling -> packaging -> ready` transitions, failure, expiration, package fingerprint, and downloadable artifact metadata.
- Treat export `ready` as the downloadable state, not as import-style `completed`; extend the session response or completion payload contract only as needed for export package metadata such as filename, byte length, checksum, and download path.
- Do not write export rows to `project_transfer_history` unless Phase 2 adds explicit tested export-history invariants; the existing history helpers are primarily for completed import duplicate warnings and same-session commit recovery.
- Extend `ProjectTransferRuntimeEventType` only if export-specific events are needed beyond the existing `export_assembly` and `export_package` progress phases.
- Emit structured runtime events or progress records for progress, omitted assets, redaction warnings, checksum failures, and package finalization.

Quality gates:

- `bun test src/server/services/projectTransfer/projectTransferExport.test.ts` passes.
- `bun test src/server/services/projectTransfer/projectTransferManifest.test.ts` passes.
- `bun test src/server/services/projectTransfer/projectTransferFingerprint.test.ts` passes.
- `bun test src/server/services/projectTransfer/projectTransferSessionRepository.test.ts` passes if export session mutations are changed.
- `bun run build` passes.
- `bun run lint` passes for touched `src` files.

### US-006: Add export routes and streaming download behavior

Description: As an implementer, I need package export API endpoints that preserve CSV export behavior and stream package downloads safely through the owner proxy.

dependsOn: ["US-005"]

Acceptance criteria:

- Replace the Phase 1 placeholder handlers in `projectTransferRoutes.ts` for `POST /api/projects/:id/export-project`, `GET /api/projects/export/:exportId`, and `GET /api/projects/export/:exportId/download`.
- Add `POST /api/projects/:id/export-project` for active and archived source projects without `assertProjectIsActive`.
- Add large export session polling and download endpoints under `/api/projects/export/:exportId`, returning the existing `{data, error}` response shape for JSON polling endpoints.
- Existing CSV `POST /api/projects/:id/export` still resolves to the CSV export flow.
- Large export downloads stream through the owner proxy without materializing package bytes on follower servers.
- Download rejects non-ready, expired, failed, missing, or wrong-direction sessions before filesystem access.
- Download sets package filename and content headers from export metadata, not from untrusted request input.
- Keep import placeholder endpoints returning contract-safe `501` responses; import analyze/commit behavior remains out of scope.

Quality gates:

- `bun test src/server/routes/projectTransferRoutes.test.ts` passes.
- `bun test src/server/routes/ApiProxyRoutes.test.ts` passes.
- `bun test src/server/routes/ApiProxyRoutes.retry.test.ts` passes if proxy retry/download behavior changes.
- `bun test src/server/routes/ProjectsRoutes.test.ts` passes if shared project routing or active/archive access behavior changes.
- `bun run build` passes.
- `bun run lint` passes for touched `src` files.

### US-007: Add export actions to active and archived project lists

Description: As a user, I want `Export Project` actions for active and archived projects so I can download or prepare a full-fidelity transfer package without changing CSV export behavior.

dependsOn: ["US-006"]

Acceptance criteria:

- Rename `src/components/main/ProjectsGrid.tsx` to `src/components/main/projectsGrid.tsx` with a Git-safe temporary filename step and update imports/mocks.
- Add `Export Project` next to `Export data` for active projects and preserve CSV `Export data` behavior.
- Add `Export Project` for archived projects without exposing CSV export for archived rows.
- Use Eden/RPC and `useQuery` from `@tanstack/solid-query` for client API calls; use direct download navigation or `fetch` only where package download bytes require it.
- Support inline downloads and large export-session polling with a preparing-download state that does not block the projects route shell.
- Verify both browser/web and desktop runtime behavior for the download URL and route path.

Quality gates:

- `bunx vitest run src/app/routes/+projects/-+index.vitest.tsx` passes after import/mocking updates.
- Add or update UI tests for the renamed active projects grid and archived projects table export actions.
- `bunx vitest run src/components/main/projectsGrid.vitest.tsx` passes after the active grid test is added.
- `bunx vitest run src/app/routes/+projects/+archived/archivedProjectsTable.vitest.tsx` passes after the archived-table test is added.
- `bun run build` passes.
- `bun run desktop:build` passes.
- `bun run lint` passes for touched `src` files.

## Phase 2 Checklist

- Do not change the existing CSV `Export data` route or active-project CSV semantics.
- Do not implement import analyze, import dependency resolution, import commit, or the import wizard in this phase.
- Reuse existing Phase 1 contracts under `src/server/services/projectTransfer/`; extend them only where export assembly exposes a missing locked field or warning code.
- All package payload filenames, formats, checksums, row counts, and empty-payload behavior match `projectTransferSchemas.ts` and `projectTransferPayloadSchemas.ts`.
- Export package fingerprints use `getProjectTransferLogicalPackageFingerprint()` and exclude volatile/session/provenance-only ids consistently with Phase 1.
- Export routes replace only export placeholder handlers; import placeholder handlers remain contract-safe and route-shadowing tests stay green.
- Background export sessions use the Phase 1 export state set and temp layout: `queued`, `assembling`, `packaging`, `ready`, `failed`, `expired`; `tmp/project-transfer/export/:sessionId/build`, `manifest.json`, `package.zip`, `completion.json`, and `progress.json`.
- Export `ready` means downloadable; do not introduce an export `completed` state unless Phase 1 state contracts and tests are intentionally updated.
- Export package metadata includes enough information for polling and download headers without trusting request input: filename, byte length, SHA-256 checksum, package fingerprint, and expiry.
- Large package download is owner-proxied and streaming-safe; followers do not materialize package bytes.
- Browser and desktop flows use the same API/download contract.
- `bun test src/server/services/projectTransfer/projectTransferExport.test.ts`
- `bun test src/server/services/projectTransfer/projectTransferRedaction.test.ts`
- `bun test src/server/services/projectTransfer/projectTransferManifest.test.ts`
- `bun test src/server/services/projectTransfer/projectTransferFingerprint.test.ts`
- `bun test src/server/services/projectTransfer/projectTransferPaths.test.ts`
- `bun test src/server/services/projectTransfer/projectTransferPayloadSchemas.test.ts`
- `bun test src/server/services/projectTransfer/projectTransferSessionRepository.test.ts` if export session repository behavior changes
- `bun test src/server/routes/projectTransferRoutes.test.ts`
- `bun test src/server/routes/ApiProxyRoutes.test.ts`
- `bun test src/server/routes/ApiProxyRoutes.retry.test.ts` if proxy retry/download behavior changes
- `bun test src/server/routes/ProjectsRoutes.test.ts` if shared project routing or active/archive access behavior changes
- `bun test src/services/olap/duckdbOlap.test.ts` if queue/date-scope parity is touched
- `bunx vitest run src/app/routes/+projects/-+index.vitest.tsx`
- `bunx vitest run src/components/main/projectsGrid.vitest.tsx`
- `bunx vitest run src/app/routes/+projects/+archived/archivedProjectsTable.vitest.tsx`
- `bun run lint`
- `bun run build`
- `bun run desktop:build`
