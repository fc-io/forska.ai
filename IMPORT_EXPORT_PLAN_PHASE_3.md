# Project Import/Export Plan Phase 3

## Scope

- Build import upload, analyze, dependency resolution, duplicate/overlap review, and import wizard planning after Phases 1 and 2 exist.
- Source orchestrator: [IMPORT_EXPORT_PLAN.md](./IMPORT_EXPORT_PLAN.md).
- External prerequisites: Phase 1 foundation and Phase 2 package contracts/export payloads are complete.
- Do not implement final commit writes in this phase.

## Ralph Conversion Metadata

- `name`: `Project Transfer Analyze And Resolve`
- `branchName`: `ralph/project-transfer-analyze-resolve`
- `description`: `Implement upload/analyze sessions, package validation, conservative remapping analysis, provider/model resolution, duplicate detection, and the import wizard through plan review.`
- Convert only `Ralph User Stories` into `userStories[]`.

## Ralph User Stories

### US-001: Add import session upload and analyze endpoints

Description: As a user, I need to upload a package and start analysis through durable server-side sessions without buffering large packages in memory.

dependsOn: []

Acceptance criteria:

- Add `POST /api/projects/import/sessions`, `PUT /api/projects/import/:sessionId/upload`, `POST /api/projects/import/:sessionId/analyze`, `GET /api/projects/import/:sessionId`, and `DELETE /api/projects/import/:sessionId` handlers using Phase 1 session state.
- Upload only stages bytes; analyze owns zip, manifest, checksum, extraction, and plan creation.
- Cancellation handles allowed states and rejects terminal or committing states safely.
- Large analyze work can run as a background session job with progress polling.

Quality gates:

- `bun test src/server/routes/projectTransferRoutes.test.ts` passes.
- `bun test src/server/routes/ApiProxyRoutes.test.ts` passes.
- `bun test src/server/routes/ApiProxyRoutes.retry.test.ts` passes.
- `bun run build` passes.
- `bun run lint` passes for touched `src` files.

### US-002: Add package analyze parser and validation plan

Description: As an implementer, I need analyze-time parsing and validation to reject malformed packages and expose package-contract blockers before any final table writes.

dependsOn: ["US-001"]

Acceptance criteria:

- Validate supported schema version, manifest, payload checksums, asset manifest references, path safety, project settings, and payload row shapes.
- Extract only into session temp storage and freeze an analysis artifact with `planRevision`.
- Expose package counts, warnings, package-contract conflict counts, and `canCommit` state.
- Fatal schema, checksum, zip, and path-safety failures abort before plan creation.

Quality gates:

- `bun test src/server/services/projectTransfer/projectTransferAnalyze.test.ts` passes.
- `bun test src/server/services/projectTransfer/projectTransferManifest.test.ts` passes.
- `bun test src/server/services/projectTransfer/projectTransferPaths.test.ts` passes.
- `bun run lint` passes for touched `src` files.

### US-003: Add conservative article, prompt, route, and overlap analysis

Description: As a user, I need import analyze to show what will be reused, created, linked, omitted, or blocked before dependency resolution or commit.

dependsOn: ["US-002"]

Acceptance criteria:

- Implement exact stable-identifier article matching and conflicts for `article_id`, DOI, PubMed id, arXiv id, medRxiv id, and bioRxiv id.
- Detect project-prompt canonical remap collisions.
- Analyze route-link and article-route side effects, omitted route links, unsafe article-route writes, and route-scope fallback snapshot links.
- Validate reused article date-scope and existing-project date expansion risks.
- Expose overlap summary fields from the orchestrator contract.

Quality gates:

- `bun test src/server/services/projectTransfer/projectTransferAnalyze.test.ts` passes.
- `bun test src/server/services/projectTransfer/projectTransferDuplicateDetection.test.ts` passes.
- `bun run lint` passes for touched `src` files.

### US-004: Add provider and model dependency resolution service

Description: As a user, I need safe provider/model mapping during import so required models are resolved only to enabled, selectable, identity-equivalent target rows.

dependsOn: ["US-002"]

Acceptance criteria:

- Implement provider auto-match by safe fingerprint only when exactly one enabled connection matches.
- Support choosing existing visible connections and creating new connections with sanitized prefill through normal provider endpoints.
- Implement non-Codex model materialization through mapped provider-connection model routes, not generic `ensureSelectableModelId`.
- Verify returned database models are enabled, selectable, unique, and identity-equivalent for imported judgments.
- Existing provider connections are not edited in the import wizard.

Quality gates:

- `bun test src/server/services/projectTransfer/projectTransferDependencyResolution.test.ts` passes.
- `bun test src/server/providers/providerModelRepository.test.ts` passes.
- `bun run build` passes.
- `bun run lint` passes for touched `src` files.

### US-005: Add Codex and virtual model resolution handling

Description: As a user, I need Codex and virtual Anthropic model dependencies to resolve through the correct provider-specific flows without confusing UI ids with database ids.

dependsOn: ["US-004"]

Acceptance criteria:

- Use `POST /api/models/ensure` only for Codex import materialization.
- Treat Codex and Anthropic selectable ids from `GET /api/models` as virtual UI ids until verified database model ids exist.
- Block final import while required Codex-backed models are unresolved.
- Keep non-equivalent substitute models available only for future project settings when no imported judgment references that source model.

Quality gates:

- `bun test src/server/services/projectTransfer/projectTransferDependencyResolution.test.ts` passes.
- `bun test src/server/routes/providerProjectFlow.e2e.test.ts` passes if shared provider setup flow changes.
- `bun run build` passes.
- `bun run lint` passes for touched `src` files.

### US-006: Add judgment and human/review fidelity validation during analyze

Description: As an implementer, I need analyze to validate imported judgments and human/review state after remapping so commit cannot silently preserve decisions against different content.

dependsOn: ["US-003", "US-004"]

Acceptance criteria:

- Recompute `judgmentInputSignature` after article, prompt, provider, model, and asset path remapping.
- Recompute `humanReviewInputSignature` for human judgments, human summaries, and review rows after remapping.
- Detect equivalent physical-key judgment reuse, non-equivalent physical-key conflicts, review-visible natural-key conflicts, and reused-judgment assessment conflicts.
- Block mismatched judgment or human/review signatures and expose counts in the plan.

Quality gates:

- `bun test src/server/services/projectTransfer/projectTransferAnalyze.test.ts` passes.
- `bun test src/server/services/projectTransfer/projectTransferDependencyResolution.test.ts` passes.
- `bun run lint` passes for touched `src` files.

### US-007: Add import wizard through plan review

Description: As a user, I need a layout-first import wizard to upload a package, review warnings, resolve dependencies, and inspect the import plan before commit exists.

dependsOn: ["US-001", "US-003", "US-004", "US-006"]

Acceptance criteria:

- Add `/projects/import` route and regenerate route tree through the app build pipeline.
- Add `Import Project` on `/projects` immediately left of `Create Covidence Project`.
- Wizard supports upload progress, package review, dependency resolution, plan review, stale `planRevision` handling, and blockers.
- Wizard uses Eden/TanStack Query for normal calls and local `fetch` only for streaming upload or direct download needs.

Quality gates:

- `bunx vitest run src/app/routes/+projects/-+import.vitest.tsx` passes.
- `bunx vitest run src/app/routes/+projects/-+index.vitest.tsx` passes.
- `bun run build` passes.
- `bun run desktop:build` passes.
- `bun run lint` passes for touched `src` files.
