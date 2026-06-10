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
- For each story, combine `Acceptance criteria` with that story's `Quality gates`. Use the final `Phase 2 Checklist` as cross-story context instead of copying every checklist command into every story.

## Ralph User Stories

### US-001: Add export app-table query contract

Description: As an implementer, I need project-transfer-specific export queries so active and archived projects can be packaged without reusing CSV or active-only review helpers.

dependsOn: []

Acceptance criteria:

- Add project-transfer export query helpers for project settings, prompts, project prompt links, import routes, project route links, articles, article route links, project article links, judgments, judgment assessments, human judgments, human judgment summaries, reviews, provider connections, and models, matching the exact existing payload key spellings including `judgmentAssessments`, `humanJudgments`, `humanJudgmentSummaries`, `providerConnections`, and `models`.
- Model export preserves nullable `remoteModelId` rows by carrying fallback identity fields such as `modelName`, `name`, `displayName`, `variant`, and `version`; do not silently omit required project or judgment models only because the current Phase 1 model payload validator requires non-empty `remoteModelId`.
- Article export queries and serializers include the locked camelCase article payload field set from the orchestrator, including `originalData`, `sourceMetadata`, selected full-text fields, `fullTextPdf`, `fullTextHtml`, `fullTextAssets`, portable content timestamps, legacy route/source fields, and source provenance fields needed for import review.
- Judgment export queries and serializers include the locked camelCase judgment payload field set from the orchestrator, including `answeredOriginal`, `answeredOriginalAsArray`, `confidenceOriginal`, `explanation`, `quotes`, `chunkingStrategy`, `deleteGeneration`, `snapshotProjectModelName`, timestamps, remappable source references, and linked assessment remapping fields.
- Export scope uses project date bounds and current review semantics directly from app tables, including archived source projects and `NULL article_created_at` date-bound behavior from the orchestrator.
- Before assembly, validate source project settings and fail export clearly without writing a package when date bounds are invalid (`date_from > date_to`) or mutually exclusive full-text toggles (`use_fulltext` and `use_fulltext_no_images`) are both enabled.
- Query helpers do not reuse CSV export routes, review-detail helpers, mart tables, or active-only access guards such as `assertProjectIsActive`.
- Before writing `judgments.ndjson`, scan all active source judgments matching project scope and judgment configuration before answered-only filtering; if multiple rows share the review-visible natural key excluding `deleteGeneration`, omit affected judgments and dependents with fidelity warnings or fail export before manifest finalization.
- Query tests cover archived package export, inactive source routes contributing to scope, date-bounded route and curated article scope, locked article and judgment field serialization, disabled prompt-mode human judgment rows that current review detail exposes, summary-mode human/review rows, answered active judgment filtering, active visible-key judgment duplicate ambiguity, missing provider/model rows that must not be silently inner-join-dropped, and nullable `remoteModelId` model descriptors.

Quality gates:

- Add or update `src/server/services/projectTransfer/projectTransferExport.test.ts`, then `bun test src/server/services/projectTransfer/projectTransferExport.test.ts` passes.
- `bun test src/services/olap/duckdbOlap.test.ts` passes if the queue/date-scope parity patch is touched.
- `bun test src/server/routes/projectsRoutes/projectsRoutesPostArticleReviewDetails.test.ts` passes if review-detail date-scope or human-prompt scope semantics are changed.
- `bun run lint` passes for touched `src` files.

### US-002: Add input signature helpers for exported durable state

Description: As an implementer, I need versioned signature helpers so exported judgments and human/review rows can be validated after target remapping.

dependsOn: ["US-001"]

Acceptance criteria:

- Add versioned `judgmentInputSignature` helper covering provider, model, prompt, article, content toggles, full-text processing, quote-validation, and chunking inputs from the orchestrator contract, including benchmark-critical provider transport family, request adapter/output schema, system-prompt family/content digest, invocation temperature, retry contract, model thinking/options, prompt-token budget/context limit, reserved completion-token constant, and chunk evidence/final-prompt digests when present.
- Add versioned `humanReviewInputSignature` helper for prompt-mode human judgments, summary-mode human judgments, and review rows, including the certified prompt/article fields and PDF/HTML/asset reference digests that the human review UI can display.
- Add explicit payload fields named `judgmentInputSignature`, `judgmentInputSignatureProvenance`, `humanReviewInputSignature`, and `humanReviewInputSignatureProvenance` where the orchestrator requires them; do not rely only on the current generic `signature` and `provenance` fields for exported durable state.
- Place signature helpers with the export package code or existing payload schema code; do not add a second package-schema layer that bypasses `projectTransferPayloadSchemas.ts`.
- Keep source and target database ids out of signatures, matching the existing `projectTransferPayloadSchemas.ts` signature contract.
- Omit chunked-mode judgments without durable final-prompt/evidence proof and emit structured fidelity warnings.
- Tests cover signature stability, benchmark-critical setting sensitivity, source-to-target database id remapping exclusion, chunked omission, `currentReviewRows` provenance, and mismatch omission.

Quality gates:

- Add or update `src/server/services/projectTransfer/projectTransferExport.test.ts`, then `bun test src/server/services/projectTransfer/projectTransferExport.test.ts` passes.
- `bun test src/server/services/projectTransfer/projectTransferPayloadSchemas.test.ts` passes if signature fields are added to the payload contract.
- `bun run lint` passes for touched `src` files.

### US-003: Add package redaction and omission serializers

Description: As an implementer, I need package-boundary redaction to remove secrets and local paths without changing benchmark or review decisions silently.

dependsOn: ["US-001"]

Acceptance criteria:

- Add `src/server/services/projectTransfer/projectTransferRedaction.ts` for package-boundary redaction serializers covering project fields, prompt fields, article fields, human judgment comments, human judgment summary fields, review fields, judgment assessment comments, provider fields, model metadata/config, URLs, full-text-derived fields, and free-form JSON/string fields.
- Extend the manifest warning contract and add or align the payload warning contract to the shared orchestrator warning shape: `code`, `severity` (`info`, `warning`, `fidelity`, or `blocking`), `scope`, `action`, `message`, optional `payload`, optional `jsonPointer`, optional `sourceRef`, and optional safe `details`; do not emit one-off warning shapes outside the manifest/payload contracts.
- Migrate or serialize `ProjectTransferPayloadOmission` and `ProjectTransferPayloadRedaction` through the same warning shape before writing final packages. If the separate `omissions` or `redactions` arrays remain in code, treat them as internal assembly annotations only, not as additional package warning contracts.
- Required package fields remain importable through safe placeholders, parent-row failure, or parent-row omission with warnings.
- Decision fields that would change meaning, including LLM answers/quotes, human answers, summary answers, assessment correctness, and reviewed-section state, are omitted with dependent rows and structured fidelity warnings rather than sanitized in place.

Quality gates:

- Add `src/server/services/projectTransfer/projectTransferRedaction.test.ts` covering the new `projectTransferRedaction.ts` serializers, then `bun test src/server/services/projectTransfer/projectTransferRedaction.test.ts` passes.
- Add or update `src/server/services/projectTransfer/projectTransferExport.test.ts`, then `bun test src/server/services/projectTransfer/projectTransferExport.test.ts` passes.
- `bun test src/server/services/projectTransfer/projectTransferManifest.test.ts` passes if manifest warning contracts are changed.
- `bun test src/server/services/projectTransfer/projectTransferPayloadSchemas.test.ts` passes if payload warning, redaction, or omission contracts are changed.
- `bun run lint` passes for touched `src` files.

### US-004: Add export asset collection and asset manifest writer

Description: As an implementer, I need export-time asset copying and manifesting so imported packages never reference source-machine files or uncopied runtime assets.

dependsOn: ["US-001", "US-003"]

Acceptance criteria:

- Copy eligible runtime-relative `assets/...` files into package `assets/` after path validation and checksum verification.
- Write `assetManifest.json` with the orchestrator top-level `entries[]` contract, not the current Phase 1 generic payload-record envelope or `assets[]` payload shape, with package path, checksum, byte size, and explicit `references[]` for `fullTextPdf`, `fullTextAssets`, and embedded `fullTextHtml` asset URLs. Each reference includes payload file, safe source row id or provenance ref, JSON pointer or field path, and reference kind.
- Canonicalize eligible embedded `fullTextHtml` runtime asset references to packaged `assets/...` paths before checksums and fingerprinting, and omit or fail any source-origin `/api/runtime-asset` URL, absolute URL, temp path, or local path that cannot be safely mapped to a copied package asset.
- Extend or rename the current `ProjectTransferAssetManifestPayload` / `ProjectTransferAssetPayloadRecord` contract to include the asset reference metadata required by the orchestrator before export assembly writes `assetManifest.json`; final packages must not emit both `assets[]` and `entries[]`, nor generic `signature`/`provenance` envelope fields, unless the orchestrator contract is explicitly changed.
- Missing, unreadable, symlinked, outside-root, and checksum-changing assets either fail export or omit and rewrite affected fields before manifest finalization.
- Export never writes manifest asset references for files that were not copied and checksummed.

Quality gates:

- Add or update `src/server/services/projectTransfer/projectTransferExport.test.ts`, then `bun test src/server/services/projectTransfer/projectTransferExport.test.ts` passes.
- `bun test src/server/services/projectTransfer/projectTransferPayloadSchemas.test.ts` passes if asset payload contracts are changed.
- `bun test src/server/services/projectTransfer/projectTransferPaths.test.ts` passes.
- `bun run lint` passes for touched `src` files.

### US-005: Add export assembly service and package finalization

Description: As an implementer, I need a server export assembly service that writes deterministic payloads, manifest checksums, and package fingerprints from one source snapshot.

dependsOn: ["US-001", "US-002", "US-003", "US-004"]

Acceptance criteria:

- Assemble package payloads from one consistent DuckDB read transaction or equivalent snapshot.
- Implement export assembly and background orchestration with `Effect.gen` and explicit acquire/release cleanup for temp build/package artifacts; keep pure serialization transforms as plain functions.
- Write canonical JSON and deterministic NDJSON payloads, exact payload checksums, asset summary, warnings, and stable package fingerprint.
- Use existing Phase 1 payload keys and paths from `projectTransferSchemas.ts`; every `projectTransferPayloadKeys` entry is declared in `manifest.payloads` and every corresponding payload file is written, even when empty.
- Align JSON collection payload shapes with the orchestrator package contract before export assembly writes files: `providerConnections.json`, `models.json`, `prompts.json`, `projectPrompts.json`, `importRoutes.json`, and `projectImportRoutes.json` are top-level JSON arrays, not the current Phase 1 generic `{records, signature, provenance}` collection envelope.
- Align the Phase 1 manifest contract with the orchestrator package names before writing export packages: use `exportedAt` and `sourceAppVersion` in the package manifest instead of the current `generatedAt` and nested `source.appVersion` shape, add the orchestrator-required `project` summary with source id, name, counts, human judgment mode, and current model reference, and update manifest/fingerprint tests for the renamed non-fingerprint metadata fields.
- Update project and model payload contracts for orchestrator fidelity before package assembly: serialize `humanJudgmentMode` as `prompt` or `summary` only by normalizing source `NULL` to `prompt`, and allow model descriptors with `remoteModelId: null` only when the fallback identity fields needed for import resolution are present.
- Support inline small package creation and background export session artifact creation using Phase 1 session foundations, `projectTransferExportArtifacts`, and `getProjectTransferExportTempLayout()`; never return server-local temp or package artifact paths in API responses, completion payloads, runtime events, or client logs.
- Use the Phase 1 thresholds in `projectTransferExecutionThresholds`: inline when package `<= 128 MB` and assets `<= 64 MB`; otherwise create an export session.
- Persist export session state/progress through `projectTransferSessionRepository.ts`, including `queued -> assembling -> packaging -> ready` transitions, failure, expiration, package fingerprint, and downloadable artifact metadata.
- Export session creation, background export assembly, state transitions, and artifact finalization must execute on the active DuckDB writer through the existing owner-proxied `/api/*` path; do not run mutating export work follower-local.
- Export background work must atomically claim and verify `ownerToken` plus expected state for `queued -> assembling -> packaging -> ready/failed` transitions; only the owning writer may update progress, finalize artifacts, or mark readiness.
- Do not use the current `transitionProjectTransferSessionState()` owner-claim path for export jobs until it no longer rewrites public `expires_at` as a short owner lease; add an export-safe claim/heartbeat helper or patch the repository so owner leases are derived from `heartbeat_at` or a dedicated lease field while client-visible `expiresAt` remains package download expiry.
- Export session/progress responses expose or explicitly map to the orchestrator progress contract: `phase`, `status`, `planRevision`, `percent`, `bytesProcessed`, `bytesTotal`, `rowCountProcessed`, `rowCountTotal`, `warningCount`, `startedAt`, `updatedAt`, and `expiresAt`.
- Treat export `ready` as the downloadable state, not as import-style `completed`.
- Keep export `ready` non-terminal under the Phase 1 state contract; the export remains downloadable only until `expiresAt`, after which recovery/TTL cleanup may transition it to `expired` and delete temp package artifacts.
- Separate public export/package expiry from owner heartbeat lease semantics before implementing background export. The current heartbeat helper mutates `expires_at` as a writer lease, so export jobs must either use an export-safe lease field/helper or avoid that helper; `expiresAt` returned to clients must remain the package download expiry and must not be extended by worker heartbeats.
- Add recovery behavior for stale `queued`, `assembling`, and `packaging` export sessions based on a bounded queued-session age when no owner is present and stale `heartbeatAt`/`ownerToken` when a worker has claimed the session, including transition to a safe failed or expired state and cleanup of temp build/package artifacts. Do not use public package `expiresAt` as the worker lease, do not leave crashed background exports stuck until public package TTL, and do not delete ready package artifacts before their public expiry.
- Persist export readiness metadata through an export-specific payload, not the current import-only completion shape. If that payload is stored in `completion_payload_json` or exposed through `ProjectTransferSessionResponse.completion`, first change `ProjectTransferCompletionPayload` into a direction-aware union so import completion keeps `status: 'completed'` while export readiness uses an export-specific status such as `ready` plus filename, byte length, SHA-256 checksum, package fingerprint, public `downloadUrl`, and expiry; do not overload import-only fields like `projectId`, `projectName`, or `importWarnings` for export packages.
- If `ProjectTransferSessionResponse.completion` is widened for export metadata, update `parseProjectTransferCompletionPayload()`, `toProjectTransferSessionResponse()`, and their tests so import completion recovery still accepts only import `status: 'completed'` payloads where required.
- Do not use `persistProjectTransferSessionCompletion()` for export readiness because it is an import-completion helper that enforces `status: 'completed'` and transitions to import `completed`; add and test an export-specific repository helper, for example `persistProjectTransferSessionExportReady()`, that compare-and-sets `packaging -> ready` and persists export readiness metadata.
- Export package metadata includes filename, byte length, SHA-256 checksum, package fingerprint, public `downloadUrl`, and expiry. Any internal package artifact path stays server-only, is derived from `getProjectTransferExportTempLayout()`, and is never returned to the client.
- Do not write export rows to `project_transfer_history` unless Phase 2 adds explicit tested export-history invariants; the existing history helpers are primarily for completed import duplicate warnings and same-session commit recovery.
- Use the existing `export_assembly` and `export_package` `ProjectTransferProgressPhase` values for export progress, and extend `ProjectTransferRuntimeEventType` with a tested export progress event type such as `export_progress` because the current runtime event set has import/upload/commit progress events but no export progress event.
- Emit structured file-only runtime events plus persisted progress records for export progress, omitted assets, redaction warnings, checksum failures, and package finalization. Export runtime events include session id, phase, percent, byte counts, row counts, status, and timestamp fields covered by `projectTransferContracts.test.ts`.

Quality gates:

- Add or update `src/server/services/projectTransfer/projectTransferExport.test.ts`, then `bun test src/server/services/projectTransfer/projectTransferExport.test.ts` passes.
- `bun test src/server/services/projectTransfer/projectTransferManifest.test.ts` passes.
- `bun test src/server/services/projectTransfer/projectTransferFingerprint.test.ts` passes.
- `bun test src/server/services/projectTransfer/projectTransferPayloadSchemas.test.ts` passes if project, model, asset manifest, warning, redaction, or omission payload contracts are changed.
- `bun test src/server/services/projectTransfer/projectTransferZip.test.ts` passes if package zip finalization helpers are touched.
- `bun test src/server/services/projectTransfer/projectTransferContracts.test.ts` passes if session response, completion payload, runtime event, or threshold contracts are changed.
- `bun test src/server/services/projectTransfer/projectTransferSessionRepository.test.ts` passes if export session mutations are changed.
- `bun test src/server/services/projectTransfer/projectTransferSessionRecovery.test.ts` passes if export `ready` expiry, TTL cleanup, or startup recovery behavior is changed.
- `bun run db:mig` passes if export-safe lease/expiry separation changes session schema or typed DB records.
- `bun run build` passes.
- `bun run lint` passes for touched `src` files.

### US-006: Add export routes and streaming download behavior

Description: As an implementer, I need package export API endpoints that preserve CSV export behavior and stream package downloads safely through the owner proxy.

dependsOn: ["US-005"]

Acceptance criteria:

- Replace the Phase 1 placeholder handlers in `projectTransferRoutes.ts` for `POST /api/projects/:id/export-project`, `GET /api/projects/export/:exportId`, and `GET /api/projects/export/:exportId/download`.
- Add `POST /api/projects/:id/export-project` for active and archived source projects without `assertProjectIsActive`; reject missing projects and projects pending permanent deletion (`deletePendingAt` set) before assembly starts.
- `POST /api/projects/:id/export-project` returns either `200 application/zip` for inline exports or `202 application/json` using the Phase 1 `ProjectTransferApiResponse` wrapper with `data: {exportId, status, filename, downloadUrl, expiresAt}` for large exports, with no partial ZIP/package bytes in the `202` response body; route and client code must test both response paths.
- Inline `200 application/zip` export responses and ready download `200 application/zip` responses set `Content-Disposition`, package filename, SHA-256 checksum, and package fingerprint headers from server-generated export metadata.
- Add large export session polling under `GET /api/projects/export/:exportId` using the existing `ProjectTransferApiResponse` wrapper for JSON responses.
- Polling rejects missing, expired, failed, wrong-direction, and ready-but-past-`expiresAt` sessions with non-2xx `ProjectTransferApiResponse` errors; non-ready export sessions return current state/progress metadata, and ready sessions return export metadata including filename, byte length, checksum, package fingerprint, `downloadUrl`, and `expiresAt`.
- Existing CSV `POST /api/projects/:id/export` still resolves to the CSV export flow.
- Large export downloads stream through the owner proxy without materializing package bytes on follower servers.
- Download checks session state before filesystem access. Ready sessions return the ZIP; non-ready export sessions return session-state JSON through the `ProjectTransferApiResponse` wrapper; expired, failed, missing, or wrong-direction sessions return a non-2xx `ProjectTransferApiResponse` error without touching package artifacts.
- Download rejects sessions whose `expiresAt` has passed even if cleanup has not yet removed temp artifacts.
- Download sets package filename and content headers from export metadata, not from untrusted request input.
- Update `projectTransferRoutes.test.ts` so implemented export endpoints assert export behavior while import endpoints continue to assert contract-safe `501` placeholders.
- Keep import session, upload, analyze, dependency-resolution, commit, delete, and wizard behavior out of scope; import route handlers continue returning contract-safe `501` placeholders in Phase 2.

Quality gates:

- Update `src/server/routes/projectTransferRoutes.test.ts` for implemented export endpoints and retained import `501` placeholders, then `bun test src/server/routes/projectTransferRoutes.test.ts` passes.
- `bun test src/server/routes/ProjectExportRoutes.test.ts` passes if the CSV export route or CSV validation shape is touched.
- `bun test src/server/routes/apiRouteClassification.test.ts` passes if project-transfer route specs, polling/download paths, or owner-proxy classification behavior are touched.
- `bun test src/server/routes/ApiProxyRoutes.test.ts` passes for route classification and owner-proxy coverage.
- Add or update `src/server/routes/ApiProxyRoutes.retry.test.ts` with large export download owner-proxy streaming coverage, then `bun test src/server/routes/ApiProxyRoutes.retry.test.ts` passes.
- `bun test src/server/routes/ProjectsRoutes.test.ts` passes if shared project routing or active/archive access behavior changes.
- `bun run build` passes.
- `bun run lint` passes for touched `src` files.

### US-007: Add export actions to active and archived project lists

Description: As a user, I want `Export Project` actions for active and archived projects so I can download or prepare a full-fidelity transfer package without changing CSV export behavior.

dependsOn: ["US-006"]

Acceptance criteria:

- Rename `src/components/main/ProjectsGrid.tsx` to `src/components/main/projectsGrid.tsx` with a Git-safe temporary filename step, then update imports and mocks including `src/app/routes/+projects/+index.tsx` and `src/app/routes/+projects/-+index.vitest.tsx`.
- Add `Export Project` next to `Export data` for active projects and preserve CSV `Export data` behavior.
- Add `Export Project` for archived projects without exposing CSV export for archived rows.
- Use Eden/RPC plus `useQuery`/mutations from `@tanstack/solid-query` for JSON polling and session metadata. Use local `fetch` through `getApiRequestUrl` for `POST /api/projects/:id/export-project` because it can return either JSON session metadata or package bytes. Use `getApiRequestUrl` plus browser/desktop-safe download navigation, or local `fetch` only when response handling requires it, for `GET /api/projects/export/:exportId/download`; keep binary package responses out of Eden/RPC and out of the existing CSV Blob/download helper.
- Support inline downloads and large export-session polling with a preparing-download state that does not block the projects route shell.
- Put shared full-fidelity export action state, polling, response parsing, filename/header handling, and download helpers in a small sibling helper/component used by both the active grid and archived table when the logic becomes non-trivial; do not duplicate that state in `projectsGrid.tsx` and `archivedProjectsTable.tsx` or further bloat those already-large components.
- Verify both browser/web and desktop runtime behavior for the download URL and route path.

Quality gates:

- Update `src/app/routes/+projects/-+index.vitest.tsx` to mock/import `../../../components/main/projectsGrid` after the case-only rename, then `bunx vitest run src/app/routes/+projects/-+index.vitest.tsx` passes.
- Add `src/components/main/projectsGrid.vitest.tsx` for the renamed active projects grid export action, then `bunx vitest run src/components/main/projectsGrid.vitest.tsx` passes.
- Add `src/app/routes/+projects/+archived/archivedProjectsTable.vitest.tsx` for the archived projects table export action, then `bunx vitest run src/app/routes/+projects/+archived/archivedProjectsTable.vitest.tsx` passes.
- `bun test src/app/utils/getApiRequestUrl.test.ts` passes if shared API/download URL helpers are changed.
- `bun run build` passes.
- `bun run desktop:build` passes.
- `bun run lint` passes for touched `src` files.

## Phase 2 Checklist

- Do not change the existing CSV `Export data` route or active-project CSV semantics.
- Do not implement import analyze, import dependency resolution, import commit, or the import wizard in this phase.
- Reuse existing Phase 1 contracts under `src/server/services/projectTransfer/`; extend them only where export assembly exposes a missing locked field or warning code.
- All package payload filenames, formats, checksums, row counts, and empty-payload behavior match `projectTransferSchemas.ts` and `projectTransferPayloadSchemas.ts`.
- Before export packages are written, align Phase 1 schema placeholders with the orchestrator package contract for manifest metadata (`exportedAt`, `sourceAppVersion`, and `project` summary), top-level JSON array collection payloads, asset manifest entries (`entries[]` with `references[]`), explicit durable-state signature/provenance fields, project `humanJudgmentMode` normalization (`NULL -> prompt`), nullable model `remoteModelId` fallback identity, and the shared warning shape.
- Export package fingerprints use `getProjectTransferLogicalPackageFingerprint()` and exclude volatile/session/provenance-only ids consistently with Phase 1.
- Export routes replace only export placeholder handlers; import placeholder handlers remain contract-safe and route-shadowing tests stay green.
- Background export sessions use the Phase 1 export state set and temp layout: `queued`, `assembling`, `packaging`, `ready`, `failed`, `expired`; `tmp/project-transfer/export/:sessionId/build`, `manifest.json`, `package.zip`, `completion.json`, and `progress.json`.
- Export `ready` means downloadable; do not introduce an export `completed` state unless Phase 1 state contracts and tests are intentionally updated.
- Export `ready` is not terminal in `isProjectTransferTerminalState()`; expired ready exports are cleaned up by TTL/recovery rather than preserved indefinitely.
- Public export package expiry must stay separate from writer owner heartbeat leases; worker heartbeats must not extend the client-visible download expiry.
- Recovery must handle stale export sessions (`queued`, `assembling`, `packaging`) through bounded queued-session age when no owner is present and owner-token/heartbeat checks after claim, and clean temp artifacts without using public package expiry as a worker lease or deleting ready package artifacts before public expiry.
- Export package metadata includes enough information for polling and download headers without trusting request input: filename, byte length, SHA-256 checksum, package fingerprint, public `downloadUrl`, and expiry. Internal artifact paths are server-only.
- Polling and download routes must both reject ready sessions whose public `expiresAt` has passed, even when recovery has not yet moved the session to `expired` or deleted package artifacts.
- Export readiness metadata uses an export-specific payload. If `ProjectTransferCompletionPayload` is extended for that metadata, it becomes a direction-aware union and import completion tests must continue proving import idempotency and recovery semantics.
- Export readiness must not call `persistProjectTransferSessionCompletion()`; import completion and export readiness remain separate repository semantics.
- Large package download is owner-proxied and streaming-safe; followers do not materialize package bytes.
- Browser and desktop flows use the same API/download contract.
- Add or update `src/server/services/projectTransfer/projectTransferExport.test.ts`, then run `bun test src/server/services/projectTransfer/projectTransferExport.test.ts`
- Add `src/server/services/projectTransfer/projectTransferRedaction.test.ts`, then run `bun test src/server/services/projectTransfer/projectTransferRedaction.test.ts`
- `bun test src/server/services/projectTransfer/projectTransferManifest.test.ts`
- `bun test src/server/services/projectTransfer/projectTransferFingerprint.test.ts`
- `bun test src/server/services/projectTransfer/projectTransferZip.test.ts` if package zip finalization helpers are touched
- `bun test src/server/services/projectTransfer/projectTransferContracts.test.ts` if session response, completion payload, runtime event, or threshold contracts are changed
- `bun test src/server/services/projectTransfer/projectTransferPaths.test.ts`
- `bun test src/server/services/projectTransfer/projectTransferPayloadSchemas.test.ts`
- `bun test src/server/services/projectTransfer/projectTransferSessionRepository.test.ts` if export session repository behavior changes
- `bun test src/server/services/projectTransfer/projectTransferSessionRecovery.test.ts` if export `ready` expiry, TTL cleanup, or startup recovery behavior is touched
- `bun run db:mig` if export-safe lease/expiry separation changes session schema or typed DB records
- Update `src/server/routes/projectTransferRoutes.test.ts` for implemented export endpoints and retained import `501` placeholders, then run `bun test src/server/routes/projectTransferRoutes.test.ts`
- `bun test src/server/routes/ProjectExportRoutes.test.ts` if the CSV export route or CSV validation shape is touched
- `bun test src/server/routes/apiRouteClassification.test.ts` if project-transfer route specs, polling/download paths, or owner-proxy classification behavior are touched
- `bun test src/server/routes/ApiProxyRoutes.test.ts` for route classification and owner-proxy coverage
- Add or update `src/server/routes/ApiProxyRoutes.retry.test.ts` with large export download owner-proxy streaming coverage, then run `bun test src/server/routes/ApiProxyRoutes.retry.test.ts`
- `bun test src/server/routes/ProjectsRoutes.test.ts` if shared project routing or active/archive access behavior changes
- `bun test src/services/olap/duckdbOlap.test.ts` if queue/date-scope parity is touched
- Update `src/app/routes/+projects/-+index.vitest.tsx` for the renamed `projectsGrid` import/mock, then run `bunx vitest run src/app/routes/+projects/-+index.vitest.tsx`
- Add `src/components/main/projectsGrid.vitest.tsx`, then run `bunx vitest run src/components/main/projectsGrid.vitest.tsx`
- Add `src/app/routes/+projects/+archived/archivedProjectsTable.vitest.tsx`, then run `bunx vitest run src/app/routes/+projects/+archived/archivedProjectsTable.vitest.tsx`
- `bun test src/app/utils/getApiRequestUrl.test.ts` if shared API/download URL helpers are touched
- `bun run lint`
- `bun run build`
- `bun run desktop:build`
