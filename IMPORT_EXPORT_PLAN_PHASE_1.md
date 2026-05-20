# Project Import/Export Plan Phase 1

## Scope

- Build the project-transfer foundation: database session/history state, route shell and route ordering, streaming upload proxying, zip/path helpers, manifest/fingerprint contracts, payload field contracts, transfer contract schemas, execution thresholds/resource gates, session recovery, and runtime asset route hardening.
- Source orchestrator: [IMPORT_EXPORT_PLAN.md](./IMPORT_EXPORT_PLAN.md).
- Do not implement export assembly, import analyze, commit, or UI wizard flows in this phase except placeholder route contracts needed for route ordering tests.
- Current repo anchor points: route composition is in `src/server/serverMain.ts#getProductApiRoutes()`, owner proxying is in `src/server/routes/ApiProxyRoutes.ts`, route classification is in `src/server/routes/apiRouteClassification.ts`, runtime asset serving is in `src/server/routes/RuntimeAssetsRoutes.ts`, and provider/model setup routes are composed through `modelsRoutes` in `src/server/routes/ModelsRoutes.ts`.

## Ralph Conversion Metadata

- `name`: `Project Transfer Foundation`
- `branchName`: `ralph/project-transfer-foundation`
- `description`: `Add the safe project-transfer foundation: schema, route ordering, session/history repositories, upload proxying, zip/path safety, manifest and payload contracts, execution gates, recovery, and runtime asset hardening.`
- Convert only `Ralph User Stories` into `userStories[]`.
- For each story, combine `Acceptance criteria` with the relevant requirements and commands from `Phase 1 Checklist` into `acceptanceCriteria[]`.
- Use `dependsOn` as the implementation order; heading order is not guaranteed to be topological.

## Ralph User Stories

### US-001: Add project-transfer session and history schema

Description: As an implementer, I need durable project-transfer session and history tables so later import/export work can rely on atomic state transitions and idempotent completion recovery.

dependsOn: []

Acceptance criteria:

- Add the next unused DuckDB migration for `app.project_transfer_session` with durable state, plan revision, ownership, heartbeat, progress, completion, error, and expiry fields.
- Add the same migration coverage for `app.project_transfer_history` with completed-import invariants needed for duplicate warnings and same-session commit retry recovery.
- Lock required `app.project_transfer_session` columns: `id`, `direction`, `state`, `plan_revision`, nullable `package_fingerprint`, nullable `commit_id`, nullable `owner_token`, nullable `heartbeat_at`, `expires_at`, nullable `progress_json`, nullable `plan_summary_json`, nullable `completion_payload_json`, nullable `error_json`, `created_at`, and `updated_at`.
- Lock required `app.project_transfer_history` columns: `id`, `direction`, nullable `session_id`, nullable `commit_id`, `package_fingerprint`, `schema_version`, nullable `source_project_id`, `source_project_name`, nullable `target_project_id`, nullable `target_project_name`, `payload_counts_json`, nullable `completion_payload_json`, and `created_at`.
- Do not add live foreign keys from project-transfer tables to mutable app entities such as `app.project`, `app.model`, `app.provider_connection`, `app.article`, or `app.prompt`; recent and earlier cleanup migrations intentionally leave several project/model/provider parent-child relationships unenforced, so transfer rows must store snapshot/provenance ids and enforce import/export invariants in repositories.
- Add DB-level or repository-enforced invariants for direction values, session states, completed-import fields, duplicate warning lookup, non-null session-id completion lookup, and stale-session recovery lookup.
- Because `project_transfer_history.session_id` is nullable, enforce same-session import completion uniqueness for non-null session ids at the repository layer.
- Update `src/db/schemaTypes.ts` with `ProjectTransferSessionRecord`, `ProjectTransferHistoryRecord`, a missing `ReviewRecord`, `JudgmentRecord.deleteGeneration`, `JudgmentRecord.confidenceOriginal` as a non-null/defaulted package-write value, and nullable `JudgmentHumanRecord.projectId`.

### US-002: Add project-transfer session and history repositories

Description: As an implementer, I need repository helpers for project-transfer sessions and history so route handlers and background jobs can mutate transfer state safely without trusting filesystem artifacts.

dependsOn: ["US-001"]

Acceptance criteria:

- Add `src/server/services/projectTransfer/projectTransferSessionRepository.ts`.
- Add `src/server/services/projectTransfer/projectTransferHistoryRepository.ts`.
- Add `src/server/services/projectTransfer/projectTransferSession.ts` for session states, progress payloads, session response shapes, and temp-layout metadata.
- Add repository helpers for session compare-and-set state transitions over expected state, plan revision, and owner token; plan revision updates; owner-token heartbeats; completion payload persistence; duplicate-history lookup by package fingerprint; and import-session completion lookup by session id.
- Add tests for stale revision rejection, single-flight commit claiming, owner-token mismatch rejection, monotonic progress updates, completed import history invariants, duplicate-warning lookup by package fingerprint, and same-session completion lookup by session id instead of package fingerprint.

### US-003: Add transfer route shell and route-shadowing tests

Description: As an implementer, I need a mounted project-transfer route shell so transfer endpoints have stable ordering and cannot be shadowed by existing project id routes.

dependsOn: ["US-001", "US-010"]

Acceptance criteria:

- Add `src/server/routes/projectTransferRoutes.ts` with placeholder contract-safe handlers for the planned transfer endpoints: `POST /api/projects/:id/export-project`, `GET /api/projects/export/:exportId`, `GET /api/projects/export/:exportId/download`, `POST /api/projects/import/sessions`, `PUT /api/projects/import/:sessionId/upload`, `POST /api/projects/import/:sessionId/analyze`, `GET /api/projects/import/:sessionId`, `POST /api/projects/import/:sessionId/resolve-dependencies`, `POST /api/projects/import/:sessionId/commit`, and `DELETE /api/projects/import/:sessionId`.
- Placeholder handlers validate route params and bodies where applicable, use the shared contract helpers from `US-010` for response shapes, and do not assemble exports, analyze uploads, commit imports, write final app tables, or implement UI wizard behavior.
- Extract or expose a side-effect-free product route composition helper, then mount `projectTransferRoutes` before `projectsRoutes`, `projectExportRoutes`, and other `/api/projects/:id...` modules everywhere product routes are mounted.
- Add route-shadowing and route-classification/proxy tests for every transfer route plus the existing CSV `POST /api/projects/:id/export`, covering normal `/api/...` and `duckdbOwnerPrivateApiPrefix` (`/__duckdb-owner-rpc`) paths.

### US-004: Add streaming upload owner-proxy foundation

Description: As an implementer, I need project-transfer uploads to stream through the DuckDB-owner proxy without buffering or unsafe retry behavior.

dependsOn: ["US-003"]

Acceptance criteria:

- Add an allowlisted streaming owner-proxy branch for `PUT /api/projects/import/:sessionId/upload` inside `src/server/routes/ApiProxyRoutes.ts` before generic body buffering can run.
- Add owner-proxy regression coverage for streaming upload and export-package download behavior.

### US-005: Add project-transfer path-safety helpers

Description: As an implementer, I need shared project-transfer path validators so zip extraction, asset promotion, and runtime serving reject unsafe paths consistently.

dependsOn: []

Acceptance criteria:

- Add `src/server/services/projectTransfer/projectTransferPaths.ts`.
- Add archive-member and runtime-asset validators that apply the checklist path rules.
- Add tests for the checklist path rules, including valid paths and unsafe-path rejection.

### US-006: Add project-transfer zip wrapper

Description: As an implementer, I need a zip wrapper around `@zip.js/zip.js` so package read/write behavior is tested before route handlers depend on it.

dependsOn: ["US-005"]

Acceptance criteria:

- Add `@zip.js/zip.js` with Bun and include `package.json` and `bun.lock` changes.
- Add `src/server/services/projectTransfer/projectTransferZip.ts`.
- Add a project-transfer zip wrapper that applies the checklist zip rules.
- Add tests for the checklist zip rules.

### US-007: Add manifest, warning, and fingerprint contracts

Description: As an implementer, I need manifest validators and fingerprint helpers so package integrity and duplicate-detection semantics are locked before export and import handlers exist.

dependsOn: ["US-005"]

Acceptance criteria:

- Add `src/server/services/projectTransfer/projectTransferSchemas.ts`.
- Add `src/server/services/projectTransfer/projectTransferManifest.ts`.
- Add `src/server/services/projectTransfer/projectTransferFingerprint.ts`.
- Add ArkType validators and fingerprint helpers that apply the checklist manifest/fingerprint rules.
- Add tests for schema-version rejection, fingerprint stability, and fingerprint sensitivity.

### US-008: Add transfer session recovery and cleanup foundation

Description: As an implementer, I need writer-owned transfer session recovery and cleanup so abandoned sessions and promoted assets are handled safely after crashes or TTL expiry.

dependsOn: ["US-002", "US-005"]

Acceptance criteria:

- Add `src/server/services/projectTransfer/projectTransferSessionRecovery.ts`.
- Add active-writer-only startup/TTL recovery that applies the checklist recovery rules.
- Add cleanup and recovery tests for the checklist recovery rules.

### US-009: Harden runtime asset route path validation

Description: As an implementer, I need `/api/runtime-asset` to use the same path-safety guarantees so imported article assets cannot be served through unsafe persisted paths.

dependsOn: ["US-005"]

Acceptance criteria:

- Reuse the project-transfer runtime asset validator before runtime file resolution.
- Add route classification and route tests for the checklist runtime-asset rules.

### US-010: Add transfer contract schemas and execution gates

Description: As an implementer, I need shared project-transfer contracts for session responses, plan summaries, cancellation, thresholds, and resource gates so later export/import handlers cannot invent incompatible behavior.

dependsOn: ["US-001", "US-002", "US-005", "US-007"]

Acceptance criteria:

- Add `src/server/services/projectTransfer/projectTransferContracts.ts` or equivalent for session responses, cancellation rules, upload/session shapes, dependency statuses, overlap summaries, conflict counts, asset-promotion metadata, thresholds, resource gates, and runtime event fields.
- Lock contract behavior plus the checklist threshold/resource rules.
- Add tests for threshold/resource rules, dependency-status validation, and `ready_to_commit` conflict-count requirements.

### US-011: Lock payload and identifier contracts

Description: As an implementer, I need package payload schemas, identifier normalization helpers, and omission/redaction contract fixtures so later export assembly and import analysis use the same field names and matching semantics.

dependsOn: ["US-005", "US-007"]

Acceptance criteria:

- Add `src/server/services/projectTransfer/projectTransferPayloadSchemas.ts` or equivalent validators/helpers for every manifest-declared payload.
- Lock payload shape, fixtures, provenance, warning, omission/redaction, and identifier contracts without implementing export assembly.
- Reuse `src/utils/articleIdentifierNormalization.ts`; add project-transfer wrappers only if a narrower package comparison shape is needed.
- Add tests for payload shape, project settings, warnings, identifier boundaries, provider/model edge cases, and required signature fields.

## Phase 1 Checklist

- Migration uses the next numeric prefix after the highest migration at completion time. At this review that is `0084` after `0083_providerModelNaturalKey.sql`.
- Transfer tables store provenance ids without live app-entity foreign keys, include recovery/history lookup indexes, enforce same-session import completion uniqueness, and require completed import rows to have non-null `completion_payload_json`, `session_id`, `commit_id`, `target_project_id`, and `target_project_name`.
- Duplicate warnings use `direction = 'import'` plus package fingerprint; commit retry and crash recovery use `direction = 'import'` plus session id.
- Import states are `awaiting_upload`, `uploading`, `queued`, `extracting`, `analyzing`, `awaiting_resolution`, `ready_to_commit`, `committing`, `completed`, `failed`, `cancelled`, and `expired`; export states are `queued`, `assembling`, `packaging`, `ready`, `failed`, and `expired`.
- Import artifacts are `upload.zip`, `manifest.json`, `extracted/`, `analysis.json`, `plan.json`, `promotionManifest.json`, `completion.json`, and `progress.json`; export artifacts are `build/`, `manifest.json`, `package.zip`, `completion.json`, and `progress.json`.
- Product route composition is side-effect-free for tests, mounts transfer routes before generic project routes, and keeps all transfer endpoints owner-proxied or explicitly fail-closed.
- Upload proxy stays on normal `/api/*`, has no writer-direct/follower-local bypass, streams without buffering or retrying non-replayable bodies, fails no-owner uploads before consuming the body, and keeps export download streaming-safe.
- Path rules reject traversal, absolute paths, raw backslashes, normalization changes, length excess, and duplicate/colliding paths; package roots are allowlisted and runtime assets stay under `assets/**`.
- Runtime path helpers keep untrusted package/temp/promotion paths under `resolveRuntimeWritablePath()` and use `resolveRuntimeFilePath()` only after persisted runtime asset paths are validated.
- Zip rules require `manifest.json` at root, enforce allowed payload paths, reject symlinks and normalized duplicates, support ZIP64 or fixtures, and treat streamed counters/checksums as authoritative over advisory sizes.
- Manifest/fingerprint rules use ArkType, canonical JSON, deterministic NDJSON ordering, SHA-256 checksums, and logical duplicate fingerprints that exclude volatile or provenance-only fields.
- Thresholds: export inline at package `<= 128 MB` and assets `<= 64 MB`; import analyze inline at zip `<= 128 MB` and uncompressed payload-plus-assets `<= 512 MB`; commit background at `>= 25,000` articles, `>= 250,000` judgments, or `>= 2 GB` extracted assets.
- Resource gates cover writable temp roots, 10% disk headroom, archive member/inode budgets, path and file-size limits, NDJSON line size, JSON depth/member count, streaming parse requirements, and decompression ratio or expanded-byte budgets.
- Contract rules cover progress fields, monotonic totals, stale `planRevision`, writer-only cancellation/cleanup states, dependency statuses, overlap/conflict counts, and concrete conflict counts before `ready_to_commit`.
- Recovery runs only on the active writer after migration, batch-limits stale scans, atomically transitions sessions before cleanup, checks transfer history before promoted-asset deletion, and deletes only temp files for completed sessions.
- Runtime asset serving validates persisted `assets/**` paths before `resolveRuntimeFilePath()`, rejects unsafe paths before filesystem access, and keeps `/api/runtime-asset` owner-proxied through route-classification coverage.
- Payload rules use camelCase package keys, package-specific serializers/fixtures, project-setting validation, warning/omission codes, signature/provenance fields, and source ids as provenance only.
- Identifier comparison uses shared DOI, PubMed/PMID, arXiv, medRxiv, and bioRxiv helpers for analyze, duplicate summaries, overlap summaries, and commit; bioRxiv/medRxiv remain accepted as DOI strong identifiers under the current contract.
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
- `bun test src/app/utils/getRuntimeAssetUrl.test.ts` if browser or desktop runtime asset URL contracts change
- `bun test src/server/routes/apiRouteClassification.test.ts`
- `bun run lint`
- `bun run build`
- `bun run desktop:build`
