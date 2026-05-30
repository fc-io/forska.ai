# Project Import/Export Plan Phase 5

## Scope

- Verify and harden the completed project-transfer feature after Phases 1 through 4 have been implemented.
- Source orchestrator: [IMPORT_EXPORT_PLAN.md](./IMPORT_EXPORT_PLAN.md).
- Implemented prerequisites: Phase 1 foundation, Phase 2 export/package assembly, Phase 3 import upload/analyze/dependency resolution/wizard plan review, and Phase 4 final commit/import completion.
- This phase should not introduce a new transfer contract, package format, route family, session store, or database workflow unless verification finds a concrete bug in the implemented feature.
- This phase may add focused fixtures, regression tests, UI hardening, desktop/browser smoke coverage, and documentation corrections discovered during verification.

## Implementation Context

- Status: Ready for implementation. Phases 1, 2, 3, and 4 are implemented.
- Server route surface is implemented in `src/server/routes/projectTransferRoutes.ts` for export, download, import session, upload, analyze, dependency resolution, commit, polling, and cancellation.
- Export implementation is under `src/server/services/projectTransfer/projectTransferExport.ts`, `src/server/services/projectTransfer/projectTransferExportPackage.ts`, `src/server/services/projectTransfer/projectTransferExportAssets.ts`, and `src/server/services/projectTransfer/projectTransferRedaction.ts`.
- Import analysis and dependency resolution are under `src/server/services/projectTransfer/projectTransferAnalyze.ts`, `src/server/services/projectTransfer/projectTransferAnalyzeTarget.ts`, `src/server/services/projectTransfer/projectTransferDependencyResolution.ts`, `src/server/services/projectTransfer/projectTransferDuplicateDetection.ts`, and `src/server/services/projectTransfer/projectTransferFidelityValidation.ts`.
- Commit implementation is under `src/server/services/projectTransfer/projectTransferCommit.ts`, `src/server/services/projectTransfer/projectTransferCommitWriter.ts`, `src/server/services/projectTransfer/projectTransferCommitRollback.ts`, and `src/server/services/projectTransfer/projectTransferSessionRecovery.ts`.
- Browser entry points are implemented in `src/components/main/projectsGrid.tsx`, `src/app/routes/+projects/+archived/archivedProjectsTable.tsx`, `src/app/routes/+projects/+index.tsx`, and `src/app/routes/+projects/+import.tsx` with the wizard in `src/app/routes/+projects/importWizard/importProjectWizard.tsx`.
- Browser and desktop verification must cover both `getApiRequestUrl` API/download behavior and `getRuntimeAssetUrl` runtime-asset rendering behavior.
- Existing targeted test files now include project-transfer export, analyze, dependency-resolution, fidelity, commit, rollback, recovery, session, history, route, proxy, UI, and runtime-asset tests; Phase 5 should extend those tests instead of adding broad duplicate suites.

## Ralph Conversion Metadata

- `name`: `Project Transfer Verification`
- `branchName`: `ralph/project-transfer-verification`
- `description`: `Verify and harden the completed browser and desktop project-transfer flows, including export/download, upload/analyze, dependency resolution, commit, review rendering, recovery, and runtime asset display.`
- Convert only `Ralph User Stories` into `userStories[]`.
- For each story, combine `Acceptance criteria` with that story's `Quality gates`.
- Treat these stories as verification and hardening work; code changes should be targeted fixes for regressions found by the gates or smoke flows.

## Ralph User Stories

### US-001: Verify browser project entry and export flows

Description: As a user, I need the browser projects pages to expose the correct entry points, preserve CSV export behavior, and reliably download full-fidelity packages.

dependsOn: []

Acceptance criteria:

- Browser projects index shows `Import Project` immediately left of `Create Covidence Project`.
- Active project rows expose both CSV `Export data` and package `Export Project` with distinct behavior and no route collision.
- Archived project rows expose package `Export Project` without CSV `Export data`.
- Small package export returns a direct ZIP download with filename, checksum, and package-fingerprint headers.
- Large package export creates a session, shows preparing/download progress, polls until ready, and downloads through the owner-proxied route without exposing server-local artifact paths.
- Existing CSV `Export data` behavior remains mapped to the CSV flow and is not changed by package export hardening.
- Export errors, expired sessions, and failed sessions render actionable UI without leaving a stuck preparing state.

Quality gates:

- `bunx vitest run src/app/routes/+projects/-+index.vitest.tsx` passes.
- `bunx vitest run src/components/main/projectsGrid.vitest.tsx` passes.
- `bunx vitest run src/app/routes/+projects/+archived/archivedProjectsTable.vitest.tsx` passes.
- `bun test src/server/routes/projectTransferRoutes.test.ts` passes.
- `bun test src/server/services/projectTransfer/projectTransferExport.test.ts` passes.
- `bun test src/server/services/projectTransfer/projectTransferExportPackage.test.ts` passes.
- `bun test src/server/routes/ApiProxyRoutes.retry.test.ts` passes if export download proxy behavior is touched.
- `bun test src/server/routes/apiRouteClassification.test.ts` passes if export route classification is touched.
- `bun run build` passes.
- `bun run lint` passes for touched `src` files.

### US-002: Verify browser import analyze and dependency review

Description: As a user, I need browser import to create a session, upload a package, analyze it, resolve dependencies, and review a frozen plan before final commit.

dependsOn: ["US-001"]

Acceptance criteria:

- Browser import wizard creates a session, uploads a package through the streaming upload path, analyzes inline for small packages, and shows package counts and warnings.
- Large package analyze shows background extraction/analyze progress and can be resumed through session polling.
- Analyze validates the implemented Phase 2 package shape, shared warning contract, checksums, assets, nullable model identity, signatures, and runtime path safety before any commit writes can run.
- Duplicate-package warnings are informational and do not become idempotency keys.
- Unresolved provider/model dependencies block final commit while preserving normal provider setup surfaces, Codex handling, and non-Codex model materialization semantics.
- Plan review shows article reuse/create counts, route omissions, reused-article update plans, model mappings, signature provenance, duplicate warnings, overlap summaries, and concrete blockers.
- Stale `planRevision` responses refresh the visible plan without mutating through an old revision.
- Cancellation and expired-session behavior cleanly leave the wizard without final writes.

Quality gates:

- `bunx vitest run src/app/routes/+projects/-+import.vitest.tsx` passes.
- `bun test src/server/routes/projectTransferRoutes.test.ts` passes.
- `bun test src/server/routes/ApiProxyRoutes.test.ts` passes if upload/session owner-proxy behavior is touched.
- `bun test src/server/routes/ApiProxyRoutes.retry.test.ts` passes if streaming upload retry behavior is touched.
- `bun test src/server/services/projectTransfer/projectTransferAnalyze.test.ts` passes.
- `bun test src/server/services/projectTransfer/projectTransferDependencyResolution.test.ts` passes.
- `bun test src/server/services/projectTransfer/projectTransferDuplicateDetection.test.ts` passes.
- `bun test src/server/services/projectTransfer/projectTransferFidelityValidation.test.ts` passes.
- `bun test src/server/services/projectTransfer/projectTransferContracts.test.ts` passes if plan-summary or progress contracts are touched.
- `bun run build` passes.
- `bun run lint` passes for touched `src` files.

### US-003: Verify browser commit, recovery, and imported review rendering

Description: As a user, I need a completed browser import to commit once, retry idempotently by session, navigate to an active imported project, and render expected review data and promoted runtime assets.

dependsOn: ["US-002"]

Acceptance criteria:

- Commit requires one reviewed plan revision and rejects stale revision, wrong-direction, expired, failed, cancelled, unresolved, and non-ready sessions without promotion or final app-table writes.
- Large imports show background commit progress; a second request while `committing` returns the in-flight session without launching a second worker.
- Completed retries return the same recorded completion for the same import session and do not use package fingerprint as an idempotency key.
- Imported project is active regardless of source archived provenance and navigates through the browser wizard completion state.
- Imported prompts, articles, judgments, assessments, human judgments, summaries, reviews, and post-import warnings render correctly after mart refresh.
- Runtime-promoted PDF, HTML, and embedded `fullTextHtml` asset references display through runtime-owned URLs without storing temp paths, source-machine URLs, or source `/api/runtime-asset` URLs.
- Commit failure or crash recovery preserves completed imports, cleans failed promoted assets, and does not delete completed import assets.

Quality gates:

- `bun test src/server/services/projectTransfer/projectTransferCommit.test.ts` passes.
- `bun test src/server/services/projectTransfer/projectTransferCommitRollback.test.ts` passes.
- `bun test src/server/services/projectTransfer/projectTransferCommitRecovery.test.ts` passes.
- `bun test src/server/services/projectTransfer/projectTransferSessionRecovery.test.ts` passes.
- `bun test src/server/services/projectTransfer/projectTransferHistoryRepository.test.ts` passes.
- `bun test src/server/routes/projectTransferRoutes.test.ts` passes.
- `bunx vitest run src/app/routes/+projects/-+import.vitest.tsx` passes.
- `bunx vitest run src/components/main/reviews/reviewsProjectWarnings.vitest.tsx` passes if post-import warning rendering is touched.
- `bunx vitest run src/components/main/projects/reviews/review/reviewJudgments.vitest.tsx` passes if imported judgment rendering is touched.
- `bun test src/server/routes/RuntimeAssetsRoutes.test.ts` passes if runtime asset serving is touched.
- `bun test src/app/utils/getRuntimeAssetUrl.test.ts` passes if runtime asset URL behavior is touched.
- `bun run build` passes.
- `bun run lint` passes for touched `src` files.

### US-004: Verify desktop export, upload, commit, and runtime assets

Description: As a desktop user, I need package download, file picking/upload, dependency resolution, commit, imported project navigation, and runtime asset display to work with desktop runtime paths through the same contracts as the browser flow.

dependsOn: ["US-001", "US-002", "US-003"]

Acceptance criteria:

- Desktop package export uses the same API contract, session polling, download route, filename handling, and error behavior as the browser flow.
- Desktop import can pick and upload a package through the same `PUT /api/projects/import/:sessionId/upload` path without browser-only URL assumptions.
- Desktop dependency resolution, commit, completed retry, and imported project navigation use the same Eden/TanStack session contract as browser import.
- Desktop runtime-writable extraction and promotion use runtime-owned paths outside the repo while persisted article fields stay runtime-relative under `assets/**`.
- Imported review screens display promoted PDF/HTML assets through `getRuntimeAssetUrl` in desktop and browser builds.
- No browser-only download, navigation, or runtime asset assumption is introduced while hardening desktop behavior.

Quality gates:

- `bun run desktop:build` passes.
- `bun run build` passes.
- `bun test src/app/utils/getApiRequestUrl.test.ts` passes if API/download URL helpers are touched.
- `bun test src/app/utils/getRuntimeAssetUrl.test.ts` passes if runtime asset URL helpers are touched.
- `bunx vitest run src/app/routes/+projects/-+import.vitest.tsx` passes if wizard desktop behavior is touched.
- `bunx vitest run src/components/main/projectsGrid.vitest.tsx` passes if export action behavior is touched.
- `bun run lint` passes for touched `src` files.

### US-005: Final full-flow regression, fixtures, and documentation cleanup

Description: As an implementer, I need final regression checks, focused fixtures, and documentation cleanup so the completed transfer feature remains maintainable.

dependsOn: ["US-001", "US-002", "US-003", "US-004"]

Acceptance criteria:

- Add or update at least one focused transfer fixture or test path that exercises a representative exported package with project settings, provider/model descriptors, prompts, articles, route/link metadata, judgments, human/review rows, and runtime assets where practical.
- Run or document browser verification for active export, archived export, import analyze, dependency resolution, commit, completed retry, imported project navigation, review rendering, and embedded asset display.
- Run or document desktop verification for export, import upload, dependency resolution, commit, post-import navigation, and embedded asset display.
- Update `IMPORT_EXPORT_PLAN.md` or the phase plans only when verification discovers implemented behavior that intentionally differs from the orchestrator contract.
- Confirm no unrelated lint issues were fixed as part of verification.
- Record the commands run and any skipped gates with reasons in the final verification notes.

Quality gates:

- `bun test src/server/services/projectTransfer/projectTransferExport.test.ts` passes.
- `bun test src/server/services/projectTransfer/projectTransferExportPackage.test.ts` passes.
- `bun test src/server/services/projectTransfer/projectTransferAnalyze.test.ts` passes.
- `bun test src/server/services/projectTransfer/projectTransferDependencyResolution.test.ts` passes.
- `bun test src/server/services/projectTransfer/projectTransferFidelityValidation.test.ts` passes.
- `bun test src/server/services/projectTransfer/projectTransferCommit.test.ts` passes.
- `bun test src/server/services/projectTransfer/projectTransferCommitRollback.test.ts` passes.
- `bun test src/server/services/projectTransfer/projectTransferCommitRecovery.test.ts` passes.
- `bun test src/server/services/projectTransfer/projectTransferSessionRecovery.test.ts` passes.
- `bun test src/server/routes/projectTransferRoutes.test.ts` passes.
- `bun test src/server/routes/ApiProxyRoutes.test.ts` passes.
- `bun test src/server/routes/ApiProxyRoutes.retry.test.ts` passes.
- `bun test src/server/routes/apiRouteClassification.test.ts` passes.
- `bun test src/server/routes/RuntimeAssetsRoutes.test.ts` passes.
- `bunx vitest run src/app/routes/+projects/-+index.vitest.tsx` passes.
- `bunx vitest run src/app/routes/+projects/-+import.vitest.tsx` passes.
- `bunx vitest run src/components/main/projectsGrid.vitest.tsx` passes.
- `bunx vitest run src/app/routes/+projects/+archived/archivedProjectsTable.vitest.tsx` passes.
- `bun test src/app/utils/getApiRequestUrl.test.ts` passes.
- `bun test src/app/utils/getRuntimeAssetUrl.test.ts` passes.
- `bun run db:mig` passes if migration or typed DB record behavior changed during verification.
- `bun run build` passes.
- `bun run desktop:build` passes.
- `bun run lint` passes.
