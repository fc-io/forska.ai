# Project Import/Export Plan Phase 5

## Scope

- Verify and harden browser and desktop behavior after full export, analyze, and commit flows exist.
- Source orchestrator: [IMPORT_EXPORT_PLAN.md](./IMPORT_EXPORT_PLAN.md).
- External prerequisites: Phases 1 through 4 are complete.
- This phase may add smoke tests, small test fixtures, UI hardening, and documentation fixes discovered by verification.

## Ralph Conversion Metadata

- `name`: `Project Transfer Verification`
- `branchName`: `ralph/project-transfer-verification`
- `description`: `Verify and harden browser and desktop project-transfer flows, including export/download, upload/analyze, dependency resolution, commit, review rendering, and runtime asset display.`
- Convert only `Ralph User Stories` into `userStories[]`.

## Ralph User Stories

### US-001: Verify browser export and import entry flows

Description: As a user, I need the browser projects pages to expose the correct entry points and preserve CSV export behavior while adding full-fidelity transfer actions.

dependsOn: []

Acceptance criteria:

- Browser projects index shows `Import Project` immediately left of `Create Covidence Project`.
- Active project rows expose both CSV `Export data` and package `Export Project` with distinct behavior.
- Archived project rows expose package `Export Project` without CSV `Export data`.
- Small package export downloads directly and large export shows preparing/download progress.

Quality gates:

- `bunx vitest run src/app/routes/+projects/-+index.vitest.tsx` passes.
- `bunx vitest run src/components/main/projectsGrid.vitest.tsx` passes.
- `bunx vitest run src/app/routes/+projects/+archived/archivedProjectsTable.vitest.tsx` passes.
- `bun run build` passes.
- `bun run lint` passes for touched `src` files.

### US-002: Verify browser import wizard and review flow

Description: As a user, I need browser import to reach plan review with clear warnings, dependency blockers, and no final writes before confirmation.

dependsOn: ["US-001"]

Acceptance criteria:

- Browser import wizard creates a session, uploads a small package, analyzes inline, and shows package counts and warnings.
- Large package analyze shows background progress.
- Unresolved provider/model dependencies block final commit.
- Plan review shows article reuse/create counts, route omissions, model mappings, signature provenance, duplicate warnings, overlap summaries, and blockers.

Quality gates:

- `bunx vitest run src/app/routes/+projects/-+import.vitest.tsx` passes.
- `bun test src/server/routes/projectTransferRoutes.test.ts` passes.
- `bun run build` passes.
- `bun run lint` passes for touched `src` files.

### US-003: Verify browser commit and imported review rendering

Description: As a user, I need a completed browser import to navigate to an active project that renders expected review data and promoted runtime assets.

dependsOn: ["US-002"]

Acceptance criteria:

- Commit progress displays for large imports and completed retries return the same imported project.
- Imported project is active regardless of source archived provenance.
- Imported prompts, articles, judgments, reviews, and post-import warnings render correctly after mart refresh.
- Embedded `fullTextHtml` runtime asset references display through runtime-owned URLs without storing temp paths or source-machine URLs.

Quality gates:

- `bun test src/server/services/projectTransfer/projectTransferCommit.test.ts` passes.
- `bun test src/app/utils/decodeAndSanitize.test.ts` or the chosen full-text HTML asset rewrite helper test passes when imported HTML asset references are supported.
- `bun run build` passes.
- `bun run lint` passes for touched `src` files.

### US-004: Verify desktop upload, download, and runtime asset behavior

Description: As a desktop user, I need package download, file picking/upload, imported project navigation, and runtime asset display to work with desktop runtime paths.

dependsOn: ["US-001", "US-002", "US-003"]

Acceptance criteria:

- Desktop package export uses the same API contract and download/navigation behavior as browser flow.
- Desktop import can pick and upload a package through the same session upload path.
- Desktop runtime-writable asset extraction and promotion use paths outside the repo while persisted article fields stay runtime-relative.
- Imported review screens display promoted PDF/HTML assets through `getRuntimeAssetUrl`.

Quality gates:

- `bun run desktop:build` passes.
- `bun run build` passes.
- `bun run lint` passes for touched `src` files.

### US-005: Final full-flow regression and documentation cleanup

Description: As an implementer, I need final regression checks and plan cleanup so the transfer feature is maintainable after all phases land.

dependsOn: ["US-001", "US-002", "US-003", "US-004"]

Acceptance criteria:

- Run or document browser verification for active export, archived export, import, commit, and imported review rendering.
- Run or document desktop verification for export, import, post-import navigation, and embedded asset display.
- Update the orchestrator plan with any implementation-specific decisions discovered during execution.
- Confirm no unrelated lint issues were fixed as part of verification.

Quality gates:

- `bun run build` passes.
- `bun run lint` passes.
- `bun run desktop:build` passes.
