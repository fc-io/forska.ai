# Project Import/Export Plan Phase 1

## Scope

- Build the project-transfer foundation: database session/history state, route shell and route ordering, streaming upload proxying, zip/path helpers, manifest/fingerprint contracts, session recovery, and runtime asset route hardening.
- Source orchestrator: [IMPORT_EXPORT_PLAN.md](./IMPORT_EXPORT_PLAN.md).
- Do not implement export assembly, import analyze, commit, or UI wizard flows in this phase except placeholder route contracts needed for route ordering tests.

## Ralph Conversion Metadata

- `name`: `Project Transfer Foundation`
- `branchName`: `ralph/project-transfer-foundation`
- `description`: `Add the safe project-transfer foundation: schema, route ordering, session/history repositories, upload proxying, zip/path safety, manifest contracts, recovery, and runtime asset hardening.`
- Convert only `Ralph User Stories` into `userStories[]`.
- For each story, combine `Acceptance criteria` and `Quality gates` into `acceptanceCriteria[]`.

## Ralph User Stories

### US-001: Add project-transfer session and history schema

Description: As an implementer, I need durable project-transfer session and history tables so later import/export work can rely on atomic state transitions and idempotent completion recovery.

dependsOn: []

Acceptance criteria:

- Add the next unused DuckDB migration for `app.project_transfer_session` with durable state, plan revision, ownership, heartbeat, progress, completion, error, and expiry fields.
- Add the same migration coverage for `app.project_transfer_history` with completed-import invariants needed for duplicate warnings and same-session commit retry recovery.
- Update `src/db/schemaTypes.ts` with project-transfer session and history record types.

Quality gates:

- `bun run db:mig` passes.
- `bun run lint` passes for touched `src` files.

### US-002: Add project-transfer session and history repositories

Description: As an implementer, I need repository helpers for project-transfer sessions and history so route handlers and background jobs can mutate transfer state safely without trusting filesystem artifacts.

dependsOn: ["US-001"]

Acceptance criteria:

- Add `src/server/services/projectTransfer/projectTransferSessionRepository.ts`.
- Add `src/server/services/projectTransfer/projectTransferHistoryRepository.ts`.
- Add repository helpers for session compare-and-set state transitions, plan revision updates, owner-token heartbeats, completion payload persistence, and import-session history lookup.
- Add tests for stale revision rejection, single-flight commit claiming, completed import history invariants, and same-session completion lookup by session id instead of package fingerprint.

Quality gates:

- `bun test src/server/services/projectTransfer/projectTransferSessionRepository.test.ts` passes.
- `bun test src/server/services/projectTransfer/projectTransferHistoryRepository.test.ts` passes.
- `bun run lint` passes for touched `src` files.

### US-003: Add transfer route shell and route-shadowing tests

Description: As an implementer, I need a mounted project-transfer route shell so transfer endpoints have stable ordering and cannot be shadowed by existing project id routes.

dependsOn: ["US-001"]

Acceptance criteria:

- Add `src/server/routes/projectTransferRoutes.ts` with placeholder contract-safe handlers for the planned transfer endpoints.
- Mount `projectTransferRoutes` before `projectsRoutes` and `projectExportRoutes` in `getProductApiRoutes()`.
- Add route-shadowing tests for the project-transfer routes and the existing CSV `POST /api/projects/:id/export` route.

Quality gates:

- `bun test src/server/routes/projectTransferRoutes.test.ts` passes.
- `bun run build` passes if route contract typing changes.
- `bun run lint` passes for touched `src` files.

### US-004: Add streaming upload owner-proxy foundation

Description: As an implementer, I need project-transfer uploads to stream through the DuckDB-owner proxy without buffering or unsafe retry behavior.

dependsOn: ["US-003"]

Acceptance criteria:

- Add an allowlisted streaming owner-proxy branch for `PUT /api/projects/import/:sessionId/upload` before the generic proxy path can call `request.clone().arrayBuffer()`.
- No-owner upload requests fail closed before consuming the body.
- Non-replayable upload streams are not retried after partial forwarding.

Quality gates:

- `bun test src/server/routes/ApiProxyRoutes.test.ts` passes.
- `bun test src/server/routes/ApiProxyRoutes.retry.test.ts` passes.
- `bun run build` passes.
- `bun run lint` passes for touched `src` files.

### US-005: Add project-transfer path-safety helpers

Description: As an implementer, I need shared project-transfer path validators so zip extraction, asset promotion, and runtime serving reject unsafe paths consistently.

dependsOn: []

Acceptance criteria:

- Add `src/server/services/projectTransfer/projectTransferPaths.ts`.
- Add project-transfer archive-member and runtime-asset path validators that reject absolute paths, raw backslashes, backslash traversal, `..`, normalized-path changes, duplicate normalized paths, unsafe Unicode/case collisions, and paths outside allowed roots.
- Add tests for valid package payload paths, valid `assets/...` runtime paths, traversal attempts, symlink attempts where applicable, and collision handling.

Quality gates:

- `bun test src/server/services/projectTransfer/projectTransferPaths.test.ts` passes.
- `bun run lint` passes for touched `src` files.

### US-006: Add project-transfer zip wrapper

Description: As an implementer, I need a zip wrapper around `@zip.js/zip.js` so package read/write behavior is tested before route handlers depend on it.

dependsOn: ["US-005"]

Acceptance criteria:

- Add `@zip.js/zip.js` with Bun and include lockfile changes.
- Add `src/server/services/projectTransfer/projectTransferZip.ts`.
- Add a project-transfer zip wrapper for streaming package creation and extraction with checksum verification and ZIP64 coverage or fixture support.
- Add tests for duplicate normalized paths, checksum mismatch, symlink rejection, manifest-root enforcement, and streamed byte counters.

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
- Add ArkType validators for manifest, payload declarations, warning shape, asset manifest references, and supported schema-version policy.
- Add package fingerprint helpers that separate exact payload checksums from logical duplicate-detection inputs.
- Add tests for fingerprint stability across volatile provenance fields and sensitivity to logical content, warning codes, payload counts, and asset checksums.

Quality gates:

- `bun test src/server/services/projectTransfer/projectTransferManifest.test.ts` passes.
- `bun test src/server/services/projectTransfer/projectTransferFingerprint.test.ts` passes.
- `bun run lint` passes for touched `src` files.

### US-008: Add transfer session recovery and cleanup foundation

Description: As an implementer, I need writer-owned transfer session recovery and cleanup so abandoned sessions and promoted assets are handled safely after crashes or TTL expiry.

dependsOn: ["US-002", "US-005"]

Acceptance criteria:

- Add `src/server/services/projectTransfer/projectTransferSessionRecovery.ts`.
- Add startup/TTL recovery helpers that run only on the active DuckDB writer, respect owner-token heartbeat staleness, and consult transfer history before deleting promoted assets.
- Add cleanup tests for abandoned upload/extraction folders, stale non-terminal sessions, completed-session recovery from history, and promotion-manifest orphan decisions.

Quality gates:

- `bun test src/server/services/projectTransfer/projectTransferSessionRecovery.test.ts` passes.
- `bun test src/server/services/projectTransfer/projectTransferSessionRepository.test.ts` passes.
- `bun run lint` passes for touched `src` files.

### US-009: Harden runtime asset route path validation

Description: As an implementer, I need `/api/runtime-asset` to use the same path-safety guarantees so imported article assets cannot be served through unsafe persisted paths.

dependsOn: ["US-005"]

Acceptance criteria:

- Update `/api/runtime-asset` path handling so valid `assets/...` paths still serve while absolute paths, raw backslashes, traversal, and normalized-path changes are rejected before runtime path resolution.
- Add focused route tests for valid assets and rejected unsafe paths.

Quality gates:

- `bun test src/server/routes/RuntimeAssetsRoutes.test.ts` passes.
- `bun run build` passes.
- `bun run lint` passes for touched `src` files.
