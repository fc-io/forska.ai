# Project Import/Export Plan Phase 1

## Scope

- Build the project-transfer foundation: database session/history state, route shell and route ordering, streaming upload proxying, zip/path helpers, manifest/fingerprint contracts, payload field contracts, transfer contract schemas, execution thresholds/resource gates, session recovery, and runtime asset route hardening.
- Source orchestrator: [IMPORT_EXPORT_PLAN.md](./IMPORT_EXPORT_PLAN.md).
- Do not implement export assembly, import analyze, commit, or UI wizard flows in this phase except placeholder route contracts needed for route ordering tests.
- Current repo anchor points: route composition is in `src/server/serverMain.ts#getProductApiRoutes()`, owner proxying is in `src/server/routes/ApiProxyRoutes.ts`, route classification is in `src/server/routes/apiRouteClassification.ts`, and runtime asset serving is in `src/server/routes/RuntimeAssetsRoutes.ts`.

## Ralph Conversion Metadata

- `name`: `Project Transfer Foundation`
- `branchName`: `ralph/project-transfer-foundation`
- `description`: `Add the safe project-transfer foundation: schema, route ordering, session/history repositories, upload proxying, zip/path safety, manifest and payload contracts, execution gates, recovery, and runtime asset hardening.`
- Convert only `Ralph User Stories` into `userStories[]`.
- For each story, combine `Acceptance criteria` and `Quality gates` into `acceptanceCriteria[]`.
- Use `dependsOn` as the implementation order; heading order is not guaranteed to be topological.

## Ralph User Stories

### US-001: Add project-transfer session and history schema

Description: As an implementer, I need durable project-transfer session and history tables so later import/export work can rely on atomic state transitions and idempotent completion recovery.

dependsOn: []

Acceptance criteria:

- Add the next unused DuckDB migration for `app.project_transfer_session` with durable state, plan revision, ownership, heartbeat, progress, completion, error, and expiry fields. Use the next numeric prefix after the current highest migration prefix at implementation time, not merely an unused duplicate prefix; at plan time the next prefix is `0080` after `0079_articleCanonicalMatchQuarantine.sql`, but this must be re-checked before Phase 1 finishes.
- Add the same migration coverage for `app.project_transfer_history` with completed-import invariants needed for duplicate warnings and same-session commit retry recovery.
- Lock required `app.project_transfer_session` columns: `id`, `direction`, `state`, `plan_revision`, nullable `package_fingerprint`, nullable `commit_id`, nullable `owner_token`, nullable `heartbeat_at`, `expires_at`, nullable `progress_json`, nullable `plan_summary_json`, nullable `completion_payload_json`, nullable `error_json`, `created_at`, and `updated_at`.
- Lock required `app.project_transfer_history` columns: `id`, `direction`, nullable `session_id`, nullable `commit_id`, `package_fingerprint`, `schema_version`, nullable `source_project_id`, `source_project_name`, nullable `target_project_id`, nullable `target_project_name`, `payload_counts_json`, nullable `completion_payload_json`, and `created_at`.
- Add DB-level or repository-enforced invariants for direction values, known import/export session states, non-null completed-import history fields, a unique or effectively unique completed-import lookup by `(direction, session_id)`, and an index on `(direction, package_fingerprint)` for duplicate warnings.
- Because `project_transfer_history.session_id` is nullable, enforce same-session import completion uniqueness for non-null session ids at the repository layer even if DuckDB null uniqueness semantics cannot express it cleanly.
- Update `src/db/schemaTypes.ts` with `ProjectTransferSessionRecord`, `ProjectTransferHistoryRecord`, a missing `ReviewRecord`, `JudgmentRecord.deleteGeneration`, and nullable `JudgmentHumanRecord.projectId`.

Quality gates:

- `bun run db:mig` passes.
- `bun run lint` passes for touched `src` files.

### US-002: Add project-transfer session and history repositories

Description: As an implementer, I need repository helpers for project-transfer sessions and history so route handlers and background jobs can mutate transfer state safely without trusting filesystem artifacts.

dependsOn: ["US-001"]

Acceptance criteria:

- Add `src/server/services/projectTransfer/projectTransferSessionRepository.ts`.
- Add `src/server/services/projectTransfer/projectTransferHistoryRepository.ts`.
- Add `src/server/services/projectTransfer/projectTransferSession.ts` for session states, progress payloads, session response shapes, and temp-layout metadata.
- Add repository helpers for session compare-and-set state transitions over expected state, plan revision, and owner token; plan revision updates; owner-token heartbeats; completion payload persistence; duplicate-history lookup by package fingerprint; and import-session completion lookup by session id.
- Add tests for stale revision rejection, single-flight commit claiming, owner-token mismatch rejection, monotonic progress updates, completed import history invariants, duplicate-warning lookup by package fingerprint, and same-session completion lookup by session id instead of package fingerprint.

Quality gates:

- `bun test src/server/services/projectTransfer/projectTransferSessionRepository.test.ts` passes.
- `bun test src/server/services/projectTransfer/projectTransferHistoryRepository.test.ts` passes.
- `bun run lint` passes for touched `src` files.

### US-003: Add transfer route shell and route-shadowing tests

Description: As an implementer, I need a mounted project-transfer route shell so transfer endpoints have stable ordering and cannot be shadowed by existing project id routes.

dependsOn: ["US-001", "US-010"]

Acceptance criteria:

- Add `src/server/routes/projectTransferRoutes.ts` with placeholder contract-safe handlers for the planned transfer endpoints: `POST /api/projects/:id/export-project`, `GET /api/projects/export/:exportId`, `GET /api/projects/export/:exportId/download`, `POST /api/projects/import/sessions`, `PUT /api/projects/import/:sessionId/upload`, `POST /api/projects/import/:sessionId/analyze`, `GET /api/projects/import/:sessionId`, `POST /api/projects/import/:sessionId/resolve-dependencies`, `POST /api/projects/import/:sessionId/commit`, and `DELETE /api/projects/import/:sessionId`.
- Placeholder handlers validate route params and bodies where applicable, use the shared contract helpers from `US-010` for response shapes, and do not assemble exports, analyze uploads, commit imports, write final app tables, or implement UI wizard behavior.
- Import and mount `projectTransferRoutes` in `src/server/serverMain.ts#getProductApiRoutes()` before `projectsRoutes`, `projectExportRoutes`, and any other `/api/projects/:id...` route module so the same route ordering is present on public app, public product API, and DuckDB-owner private API paths.
- Add route-shadowing tests for every project-transfer route plus the existing CSV `POST /api/projects/:id/export` route, using the same composition order as `getProductApiRoutes()` and covering both normal `/api/...` and `duckdbOwnerPrivateApiPrefix` (`/__duckdb-owner-rpc`) mounted routes.

Quality gates:

- `bun test src/server/routes/projectTransferRoutes.test.ts` passes.
- `bun test src/server/routes/apiRouteClassification.test.ts` passes if transfer route classification changes.
- `bun run build` passes if route contract typing changes.
- `bun run lint` passes for touched `src` files.

### US-004: Add streaming upload owner-proxy foundation

Description: As an implementer, I need project-transfer uploads to stream through the DuckDB-owner proxy without buffering or unsafe retry behavior.

dependsOn: ["US-003"]

Acceptance criteria:

- Add an allowlisted streaming owner-proxy branch for `PUT /api/projects/import/:sessionId/upload` inside `src/server/routes/ApiProxyRoutes.ts` before any generic proxy helper can call `request.clone().arrayBuffer()` or otherwise consume a non-GET/non-HEAD body.
- Keep project-transfer upload routes on the normal owner-proxied `/api/*` path; do not add a writer-direct or follower-local upload bypass.
- No-owner upload requests fail closed before consuming the body, with regression coverage proving the request body was not read.
- The upload branch bypasses the buffered `DuckdbOwnerProxyRequestTemplate`, forwards the original stream body once to `/__duckdb-owner-rpc/api/projects/import/:sessionId/upload`, and does not retry after forwarding starts, even though generic small `PUT` API requests may keep the existing buffered retry behavior.

Quality gates:

- `bun test src/server/routes/ApiProxyRoutes.test.ts` passes.
- `bun test src/server/routes/ApiProxyRoutes.retry.test.ts` passes.
- `bun run build` passes.
- `bun run desktop:build` passes.
- `bun run lint` passes for touched `src` files.

### US-005: Add project-transfer path-safety helpers

Description: As an implementer, I need shared project-transfer path validators so zip extraction, asset promotion, and runtime serving reject unsafe paths consistently.

dependsOn: []

Acceptance criteria:

- Add `src/server/services/projectTransfer/projectTransferPaths.ts`.
- Add project-transfer archive-member and runtime-asset path validators that reject absolute paths, raw backslashes, backslash traversal, `..`, NUL bytes, overlong segments, overlong normalized paths, normalized-path changes, duplicate normalized paths, unsafe Unicode/case collisions, and paths outside allowed roots.
- Lock the allowed package root payload path list plus `assets/**`, and reject archive members outside that allowlist before extraction.
- Add runtime asset validators that accept valid runtime-relative `assets/...` paths and reject paths that only appear to start with `assets/` but normalize outside that subtree.
- Add tests for valid package payload paths, valid `assets/...` runtime paths, traversal attempts, symlink or non-regular-file attempts where applicable, payload allowlist rejection, overlong path rejection, and collision handling.

Quality gates:

- `bun test src/server/services/projectTransfer/projectTransferPaths.test.ts` passes.
- `bun run lint` passes for touched `src` files.

### US-006: Add project-transfer zip wrapper

Description: As an implementer, I need a zip wrapper around `@zip.js/zip.js` so package read/write behavior is tested before route handlers depend on it.

dependsOn: ["US-005"]

Acceptance criteria:

- Add `@zip.js/zip.js` with Bun and include `package.json` and `bun.lock` changes.
- Add `src/server/services/projectTransfer/projectTransferZip.ts`.
- Add a project-transfer zip wrapper for streaming package creation and extraction with checksum verification, ZIP64 coverage or deterministic fixture support, manifest-root enforcement, allowed payload path enforcement, and authoritative streamed compressed/uncompressed byte counters.
- Treat manifest-declared sizes and zip directory sizes as untrusted advisory values; wrapper tests must prove streamed counters and checksums are the enforcement source.
- Add tests for duplicate normalized paths, checksum mismatch, symlink rejection, manifest-root enforcement, ZIP64 fixture handling, advisory zip-size mismatch handling, and streamed byte counters.

Quality gates:

- `bun test src/server/services/projectTransfer/projectTransferZip.test.ts` passes.
- `bun test src/server/services/projectTransfer/projectTransferPaths.test.ts` passes.
- `bun run build` passes.
- `bun run lint` passes for touched `src` files.

### US-007: Add manifest, warning, and fingerprint contracts

Description: As an implementer, I need manifest validators and fingerprint helpers so package integrity and duplicate-detection semantics are locked before export and import handlers exist.

dependsOn: ["US-005"]

Acceptance criteria:

- Add `src/server/services/projectTransfer/projectTransferSchemas.ts`.
- Add `src/server/services/projectTransfer/projectTransferManifest.ts`.
- Add `src/server/services/projectTransfer/projectTransferFingerprint.ts`.
- Add ArkType validators for the locked manifest root payload list, payload declarations, warning shape, asset manifest references, asset summaries, supported schema-version policy, and package project settings validation.
- Add package fingerprint helpers that separate exact payload checksums from logical duplicate-detection inputs and exclude volatile fields such as `exportedAt`, `sourceAppVersion`, byte sizes, temp or session ids, provenance-only source timestamps, remapping-only source database ids, and non-input acquisition timestamps when content is unchanged.
- Add tests for unsupported schema-version rejection before extraction or writes, fingerprint stability across volatile provenance fields, and fingerprint sensitivity to logical content, warning codes, stable warning locations, payload counts, and asset checksums.

Quality gates:

- `bun test src/server/services/projectTransfer/projectTransferManifest.test.ts` passes.
- `bun test src/server/services/projectTransfer/projectTransferFingerprint.test.ts` passes.
- `bun run lint` passes for touched `src` files.

### US-008: Add transfer session recovery and cleanup foundation

Description: As an implementer, I need writer-owned transfer session recovery and cleanup so abandoned sessions and promoted assets are handled safely after crashes or TTL expiry.

dependsOn: ["US-002", "US-005"]

Acceptance criteria:

- Add `src/server/services/projectTransfer/projectTransferSessionRecovery.ts`.
- Add startup/TTL recovery helpers that run only on the active DuckDB writer, atomically transition stale non-terminal sessions before deleting files, respect owner-token heartbeat staleness, and consult transfer history by import session id before deleting promoted assets.
- Successful completed-session cleanup removes only temp upload/extraction files; promoted final `assets/...` files are never deleted when a completed transfer-history row exists.
- Add cleanup tests for abandoned upload/extraction folders, stale non-terminal sessions, completed-session recovery from history when `completion.json` is missing, promotion-manifest orphan decisions, and failure paths after asset promotion but before database completion.

Quality gates:

- `bun test src/server/services/projectTransfer/projectTransferSessionRecovery.test.ts` passes.
- `bun test src/server/services/projectTransfer/projectTransferSessionRepository.test.ts` passes.
- `bun run lint` passes for touched `src` files.

### US-009: Harden runtime asset route path validation

Description: As an implementer, I need `/api/runtime-asset` to use the same path-safety guarantees so imported article assets cannot be served through unsafe persisted paths.

dependsOn: ["US-005"]

Acceptance criteria:

- Update `/api/runtime-asset` path handling so valid `assets/...` paths still serve while absolute paths, raw backslashes, traversal, and normalized-path changes are rejected before runtime path resolution.
- Reuse the project-transfer runtime asset path validator before calling `resolveRuntimeFilePath()`, so `assets/...` prefixes that normalize outside the asset subtree are rejected before filesystem access and route safety does not rely on `resolveRuntimeFilePath()` containment behavior.
- Keep `/api/runtime-asset` owner-proxied by explicitly covering its route classification behavior: either leave it intentionally `unclassified` and fail-closed without a DuckDB owner, or classify it as `owner-dependent` with equivalent proxy semantics.
- Add focused route tests for valid assets and rejected unsafe paths.

Quality gates:

- `bun test src/server/routes/RuntimeAssetsRoutes.test.ts` passes.
- `bun test src/server/routes/apiRouteClassification.test.ts` passes if classifier coverage is added or changed for `/api/runtime-asset`.
- `bun test src/app/utils/getRuntimeAssetUrl.test.ts` passes if browser or desktop runtime asset URL contracts change.
- `bun run build` passes.
- `bun run desktop:build` passes.
- `bun run lint` passes for touched `src` files.

### US-010: Add transfer contract schemas and execution gates

Description: As an implementer, I need shared project-transfer contracts for session responses, plan summaries, cancellation, thresholds, and resource gates so later export/import handlers cannot invent incompatible behavior.

dependsOn: ["US-001", "US-002", "US-005", "US-007"]

Acceptance criteria:

- Add `src/server/services/projectTransfer/projectTransferContracts.ts` or equivalent contract module for session response shapes, cancellation-state rules, overlap summary fields, unresolved dependency status shapes, asset-promotion plan metadata, and blocking conflict count fields used by later analyze and commit phases.
- Session response contracts expose `phase`, `status`, `planRevision`, `percent`, `bytesProcessed`, `bytesTotal`, `rowCountProcessed`, `rowCountTotal`, `warningCount`, `startedAt`, `updatedAt`, and `expiresAt`, with nullable totals while unknown and monotonic progress once totals are known.
- Cancellation contracts explicitly allow cleanup transitions from `awaiting_upload`, `uploading`, `queued`, `extracting`, `analyzing`, `awaiting_resolution`, and `ready_to_commit`; reject `committing`, `completed`, `failed`, `cancelled`, and `expired` unless the request is an idempotent repeat; and require writer-only ownership for state mutation and temp cleanup.
- Overlap summary contracts include `reusedArticleCount`, `newArticleCount`, `reusedArticleUpdateCount`, `reusedArticleFieldFillCount`, `reusedArticleAssetPromotionCount`, `reusedJudgmentCount`, `dirtiedExistingProjectCount`, `omittedRouteLinkCount`, `omittedArticleRouteLinkCount`, `routeArticleSnapshotLinkCount`, `duplicateImportMatchCount`, `packageContractConflictCount`, `articleConflictCount`, `projectPromptConflictCount`, `judgmentConflictCount`, `humanReviewFidelityConflictCount`, `storedSignatureJudgmentCount`, `snapshotVerifiedJudgmentCount`, `currentReviewRowsSignatureJudgmentCount`, `storedSignatureHumanReviewCount`, and `currentReviewRowsSignatureHumanReviewCount`.
- Lock execution-mode thresholds: inline export at estimated package bytes `<= 128 MB` and estimated asset bytes `<= 64 MB`; background export above either threshold; inline import analyze at uploaded zip bytes `<= 128 MB` and preflight uncompressed payload-plus-asset bytes `<= 512 MB`; background import analyze above either threshold or when streamed verified bytes exceed the inline threshold; background commit at `>= 25,000` articles, `>= 250,000` judgments, or `>= 2 GB` extracted assets.
- Add resource and parser safety gates for writable runtime temp roots, disk-space budgets with 10% headroom, archive member count or inode availability, maximum normalized path and segment lengths, maximum manifest and payload file sizes, maximum NDJSON line size, maximum JSON depth and object member count, streaming parse requirements for large payloads, and expanded-byte or decompression-ratio budgets.
- Treat thresholds as inline-vs-background switches and resource gates as machine-resource safety checks, not product-level hard package-size caps.
- Add tests for exact threshold boundaries, background handoff selection, resource-gate failure messages, parser-budget failures, and `ready_to_commit` contract validation requiring concrete conflict counts after provider/model dependencies are resolved.

Quality gates:

- `bun test src/server/services/projectTransfer/projectTransferContracts.test.ts` passes.
- `bun run build` passes.
- `bun run desktop:build` passes.
- `bun run lint` passes for touched `src` files.

### US-011: Lock payload and identifier contracts

Description: As an implementer, I need package payload schemas, identifier normalization helpers, and omission/redaction contract fixtures so later export assembly and import analysis use the same field names and matching semantics.

dependsOn: ["US-005", "US-007"]

Acceptance criteria:

- Add `src/server/services/projectTransfer/projectTransferPayloadSchemas.ts` or equivalent module with ArkType validators or schema helpers for every manifest-declared payload: `project.json`, `providerConnections.json`, `models.json`, `prompts.json`, `projectPrompts.json`, `importRoutes.json`, `projectImportRoutes.json`, `articles.ndjson`, `articleImportRoutes.ndjson`, `projectArticles.ndjson`, `judgments.ndjson`, `judgmentAssessments.ndjson`, `humanJudgments.ndjson`, `humanJudgmentSummaries.ndjson`, `reviews.ndjson`, and `assetManifest.json`.
- Lock package field names to camelCase JSON keys and add tests that reject raw snake_case DB keys for package fields where the contract requires names such as `sourceModelId`, `articleId`, `originalData`, `sourceMetadata`, `fullTextPdf`, and `deleteGeneration`.
- Define package-specific payload row types and serializers where shared row types are absent or intentionally not package-shaped, especially `reviews.ndjson` and article fields whose internal names use acronym casing such as `fullTextPDF`.
- Define project settings validation helpers for package contracts: reject `dateFrom > dateTo`, reject both `useFulltext` and `useFulltextNoImages` as true, normalize `humanJudgmentMode = null` to `prompt`, and reject unsupported human judgment modes.
- Define payload contract fixtures for the exported data scopes without implementing export assembly: current date-bounded article scope inputs, answered active current-review judgment fields and filters, judgment assessment links, answered prompt-mode human judgments, non-empty summary-mode human judgments, review row fields, provider/model descriptors, prompt definitions, project prompt links, route links, article route links, and project article links.
- Define package-boundary omission/redaction contract fixtures and warning codes for secret-like keys, credentials, token-like URL query data, URL fragments, signed URLs, source-machine absolute paths, local-only runtime paths, conversion-runtime fields, job-runtime rows, unanswered LLM judgments, soft-deleted judgments, pending human workflow rows, and redaction that would change benchmark or review decision meaning.
- Reuse `src/utils/articleIdentifierNormalization.ts` for DOI, PubMed/PMID, arXiv, medRxiv, bioRxiv, and trusted URL normalization. Add project-transfer comparison wrappers only if the package contracts need a narrower return shape; do not duplicate existing normalization logic.
- Treat bioRxiv and medRxiv package inputs as DOI strong identifiers under the current `ArticleIdentifierKind` contract unless a later schema migration explicitly expands identifier kinds. Keep PMCID metadata-only unless a later phase adds a matching rule for it.
- Add tests that schema validation accepts minimal valid empty payloads, rejects unimportable required-field rewrites, rejects forbidden raw DB keys, rejects internal acronym casing such as `fullTextPDF` in favor of package `fullTextPdf`, verifies date/toggle/human-mode validation, verifies warning shape stability, and verifies identifier normalization boundary cases through the existing shared normalizers.

Quality gates:

- `bun test src/server/services/projectTransfer/projectTransferPayloadSchemas.test.ts` passes.
- `bun test src/utils/articleIdentifierNormalization.test.ts` passes.
- `bun test src/server/services/projectTransfer/projectTransferIdentifierNormalization.test.ts` passes if project-transfer comparison wrappers are added.
- `bun run lint` passes for touched `src` files.

## Phase 1 Completion Gates

- Verify the project-transfer migration filename uses the next numeric prefix after the highest migration present at completion time, and adjust the filename if another migration landed after the plan was written.
- `bun run db:mig`
- `bun test src/server/services/projectTransfer/projectTransferSessionRepository.test.ts`
- `bun test src/server/services/projectTransfer/projectTransferHistoryRepository.test.ts`
- `bun test src/server/routes/projectTransferRoutes.test.ts`
- `bun test src/server/routes/ApiProxyRoutes.test.ts`
- `bun test src/server/routes/ApiProxyRoutes.retry.test.ts`
- `bun test src/server/services/projectTransfer/projectTransferPaths.test.ts`
- `bun test src/server/services/projectTransfer/projectTransferZip.test.ts`
- `bun test src/server/services/projectTransfer/projectTransferManifest.test.ts`
- `bun test src/server/services/projectTransfer/projectTransferFingerprint.test.ts`
- `bun test src/server/services/projectTransfer/projectTransferContracts.test.ts`
- `bun test src/server/services/projectTransfer/projectTransferPayloadSchemas.test.ts`
- `bun test src/utils/articleIdentifierNormalization.test.ts`
- `bun test src/server/services/projectTransfer/projectTransferIdentifierNormalization.test.ts` if project-transfer comparison wrappers are added
- `bun test src/server/services/projectTransfer/projectTransferSessionRecovery.test.ts`
- `bun test src/server/routes/RuntimeAssetsRoutes.test.ts`
- `bun test src/server/routes/apiRouteClassification.test.ts` if transfer or runtime asset route classification coverage is added or changed
- `bun run lint`
- `bun run build`
- `bun run desktop:build`
