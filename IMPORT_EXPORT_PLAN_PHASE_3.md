# Project Import/Export Plan Phase 3

## Scope

- Build import upload, analyze, dependency resolution, duplicate/overlap review, and import wizard planning after Phases 1 and 2 exist.
- Source orchestrator: [IMPORT_EXPORT_PLAN.md](./IMPORT_EXPORT_PLAN.md).
- External prerequisites: Phase 1 foundation and Phase 2 package contracts/export payloads are complete.
- Do not implement final commit writes, final asset promotion, transfer-history completion writes, mart refresh dirty writes, or imported project navigation in this phase.

## Implementation Context

- Status: Ready for implementation. Phase 1 and Phase 2 are implemented.
- Existing export handlers are implemented in `src/server/routes/projectTransferRoutes.ts`; import handlers still replace the Phase 1/2 placeholders in this phase except `POST /api/projects/import/:sessionId/commit`, which remains out of scope until Phase 4.
- Phase 2 export assembly lives in `src/server/services/projectTransfer/projectTransferExportPackage.ts`, `src/server/services/projectTransfer/projectTransferExport.ts`, `src/server/services/projectTransfer/projectTransferExportAssets.ts`, and `src/server/services/projectTransfer/projectTransferRedaction.ts`; import analyze must consume the package contract those services write instead of re-defining it.
- Reuse the implemented Phase 1/2 contracts under `src/server/services/projectTransfer/`; do not add parallel manifest, payload, path, zip, fingerprint, session, or export-package contracts.
- Validate the Phase 2 package shape during analyze: `exportedAt`, `sourceAppVersion`, manifest `project`, `assetSummary`, shared warning shape, top-level JSON array collection payloads, `assetManifest.entries[]` with `references[]`, explicit `judgmentInputSignature` / `judgmentInputSignatureProvenance`, and explicit `humanReviewInputSignature` / `humanReviewInputSignatureProvenance`.
- Phase 1 `ProjectTransferPlanSummary` still has placeholder required overlap/conflict keys (`exactDuplicateImports`, `reusedArticles`, `articleIdentifier`, `dependency`, `humanReview`, `judgment`, `packageContract`, and `projectPrompt`); Phase 3 must either replace them with the final explicit plan-summary count keys or add a tested API mapping layer before exposing import plans.
- Provider/model dependency work should reuse the current provider setup surfaces: `GET /api/provider-connections`, `POST /api/provider-connections`, `POST /api/provider-auth/:providerKind/begin`, `POST /api/provider-auth/:providerKind/finish`, `POST /api/provider-connections/:id/test`, `GET /api/provider-connections/:id/discovered-models`, `POST /api/provider-connections/:id/models`, `POST /api/provider-connections/:id/sync-models`, `GET /api/models/stored`, `GET /api/models`, `GET /api/models/codex/status`, `POST /api/models/codex/login`, and `GET /api/models/codex/login/:jobId`. Do not use `ensureSelectableModelId` or `POST /api/models/ensure` for import materialization except for Codex.
- Keep all mutating import session work on the active DuckDB writer through the existing owner-proxied `/api/*` path unless route classification is deliberately changed and tested.

## Ralph Conversion Metadata

- `name`: `Project Transfer Analyze And Resolve`
- `branchName`: `ralph/project-transfer-analyze-resolve`
- `description`: `Implement upload/analyze sessions, package validation, conservative remapping analysis, provider/model resolution, duplicate detection, and the import wizard through plan review.`
- Convert only `Ralph User Stories` into `userStories[]`.
- Use `dependsOn` as the implementation order; heading order is not guaranteed to be topological.
- For each story, combine `Acceptance criteria` with that story's `Quality gates`.

## Ralph User Stories

### US-001: Add import session, upload, analyze, resolve, and cancel endpoints

Description: As a user, I need to upload a package, analyze it, resolve dependencies, and cancel the session through durable server-side sessions without buffering large packages in memory.

dependsOn: []

Acceptance criteria:

- Replace Phase 1/2 placeholder handlers for `POST /api/projects/import/sessions`, `PUT /api/projects/import/:sessionId/upload`, `POST /api/projects/import/:sessionId/analyze`, `GET /api/projects/import/:sessionId`, and `DELETE /api/projects/import/:sessionId`.
- Keep `POST /api/projects/import/:sessionId/resolve-dependencies` as a validated contract shell until US-004 owns provider/model dependency-resolution behavior.
- Keep `POST /api/projects/import/:sessionId/commit` as a contract-safe placeholder until Phase 4; no final app-table writes happen in Phase 3.
- Create import sessions in `awaiting_upload` with public upload/analyze/session URLs and `expiresAt` in the API response, plus server-only temp layout metadata and durable session rows from the Phase 1 repository. Never return server-local temp artifact paths.
- Replace or narrow the current public `ProjectTransferUploadSession` placeholder shape before implementing session/upload responses: `uploadPath` and any temp layout fields are server-only metadata and must not be present in `ProjectTransferApiResponse.data` payloads.
- Upload uses the Phase 1 streaming owner-proxy path, atomically claims `awaiting_upload -> uploading`, writes only `upload.zip`, persists upload byte/checksum metadata, transitions `uploading -> queued` after a durable write, rejects duplicate bodies for the same session, and does not parse zip, manifest, or payload data.
- Analyze claims queued sessions and owns session state, owner-token, progress, and `planRevision` orchestration; package parsing/validation is owned by US-002, overlap/remap analysis by US-003, provider/model resolution state by US-004/US-005, and fidelity checks by US-006.
- Run small analyze work inline and large analyze work as a background session job using `getProjectTransferImportAnalyzeExecutionMode()` thresholds, durable owner tokens, heartbeats, progress, and runtime events.
- Cancellation handles `awaiting_upload`, `uploading`, `queued`, `extracting`, `analyzing`, `awaiting_resolution`, and `ready_to_commit` with writer-owned state transitions and temp cleanup; `committing`, `completed`, and `failed` are rejected. Repeated `cancelled` or `expired` calls are idempotent only when they match the existing terminal cleanup result, such as the same reason/cleanup intent or an empty repeat request, and must not reacquire ownership or rerun cleanup from stale owner tokens.
- Replace permissive Phase 1/2 placeholder request bodies with ArkType-validated contracts before processing create-session, analyze, resolve-dependencies, and cancel payloads. Keep `commit` validation contract-safe while the handler remains a Phase 4 placeholder.
- Session reads use `ProjectTransferApiResponse` only as the `{data, error}` envelope; the `data` payload exposes progress, plan summary, blockers, warnings, `canCommit`, duplicate-package warnings, and overlap counts through `ProjectTransferSessionResponse.planSummary` and/or an explicit import-plan payload.

Quality gates:

- `bun test src/server/routes/projectTransferRoutes.test.ts` passes.
- `bun test src/server/routes/ApiProxyRoutes.test.ts` passes.
- `bun test src/server/routes/ApiProxyRoutes.test.ts` includes project-transfer upload coverage proving no-owner failures do not consume the request body and large uploads do not fall through to the generic buffered `ArrayBuffer` proxy path.
- `bun test src/server/routes/ApiProxyRoutes.retry.test.ts` passes.
- `bun test src/server/routes/ApiProxyRoutes.retry.test.ts` includes coverage that non-replayable project-transfer upload streams are not retried after partial forwarding to the owner.
- `bun test src/server/routes/apiRouteClassification.test.ts` passes if transfer upload, polling, or import route classification changes.
- `bun test src/server/services/projectTransfer/projectTransferSessionRepository.test.ts` passes if session mutations change.
- `bun test src/server/services/projectTransfer/projectTransferSessionRecovery.test.ts` passes if cancellation or cleanup behavior changes.
- `bun test src/server/services/projectTransfer/projectTransferContracts.test.ts` passes if session response, progress, overlap, conflict, or runtime event contracts change.
- `bun run build` passes.
- `bun run lint` passes for touched `src` files.

### US-002: Add package analyze parser and validation plan

Description: As an implementer, I need analyze-time parsing and validation to reject malformed packages and expose package-contract blockers before any final table writes.

dependsOn: ["US-001"]

Acceptance criteria:

- Validate supported schema version, manifest fields, manifest project summary, payload file list, payload formats, row counts, payload checksums, package fingerprint, asset summary, and shared warning shape from the implemented Phase 2 contract.
- Validate all Phase 2 payload shapes: `project.json`, `providerConnections.json`, `models.json`, `prompts.json`, `projectPrompts.json`, `importRoutes.json`, `projectImportRoutes.json`, `articles.ndjson`, `articleImportRoutes.ndjson`, `projectArticles.ndjson`, `judgments.ndjson`, `judgmentAssessments.ndjson`, `humanJudgments.ndjson`, `humanJudgmentSummaries.ndjson`, `reviews.ndjson`, and `assetManifest.json`.
- Validate top-level JSON array collection payloads and `assetManifest.entries[]` with explicit `references[]`; final packages must not rely on a generic `{records, signature, provenance}` collection envelope.
- Parse small payloads through the implemented `parseProjectTransferPayload()` / `assertProjectTransferPayload()` contracts where practical, including Phase 2 serialization that collapses internal `omissions` and `redactions` annotations into shared `warnings` before package write. For large NDJSON payloads, stream rows and validate against the same record contracts instead of materializing the whole file through `parseProjectTransferPayload()`.
- Validate explicit durable-state fields `judgmentInputSignature`, `judgmentInputSignatureProvenance`, `humanReviewInputSignature`, and `humanReviewInputSignatureProvenance` where applicable.
- Validate asset manifest references, archive path safety, persisted runtime asset path safety, payload row shapes, project settings, date bounds, mutually exclusive full-text toggles, nullable model `remoteModelId` fallback identity fields, and non-null/defaultable judgment confidence semantics.
- Enforce resource gates before and during extraction: writable temp root, disk headroom, archive member and inode budgets, expanded-byte and decompression-ratio budgets, maximum path sizes, maximum file sizes, NDJSON line size, JSON depth/member count, and streaming parser use for large payloads.
- Extract only into session temp storage and freeze `analysis.json` plus `plan.json` artifacts with `planRevision`; filesystem artifacts are cached outputs, not the source of atomic session truth.
- Expose package counts, package warnings, package fingerprint data for later duplicate detection, package-contract conflict counts, `canCommit`, and resolution kinds such as `requires_new_package_or_target_changes` for non-wizard-resolvable blockers.
- Fatal schema, checksum, zip, decompression-budget, and path-safety failures abort before plan creation.

Quality gates:

- Add or extend `src/server/services/projectTransfer/projectTransferAnalyze.test.ts`; `bun test src/server/services/projectTransfer/projectTransferAnalyze.test.ts` passes.
- `bun test src/server/services/projectTransfer/projectTransferManifest.test.ts` passes.
- `bun test src/server/services/projectTransfer/projectTransferPayloadSchemas.test.ts` passes if payload validation contracts change.
- `bun test src/server/services/projectTransfer/projectTransferPaths.test.ts` passes.
- `bun test src/server/services/projectTransfer/projectTransferZip.test.ts` passes if zip extraction helpers change.
- `bun test src/server/services/projectTransfer/projectTransferContracts.test.ts` passes if package contract blockers or overlap/conflict counts change.
- `bun run lint` passes for touched `src` files.

### US-003: Add conservative article, prompt, route, asset-plan, and overlap analysis

Description: As a user, I need import analyze to show what will be reused, created, linked, omitted, updated, or blocked before dependency resolution or commit.

dependsOn: ["US-002"]

Acceptance criteria:

- Implement exact stable-identifier article matching for package `articleId` (source app `article_id`), DOI, PubMed id, arXiv id, medRxiv input, and bioRxiv input using the shared project-transfer normalization helpers; bioRxiv and medRxiv remain DOI-backed strong identifiers under the current contract, not separate comparison-key families.
- Return all exact candidates, matched identifier types, and blocking conflicts when secondary identifiers are ambiguous, identifiers point to different target rows, or distinct exported article rows collapse to the same target article.
- Build a non-destructive reused-article update plan that fills only missing target fields and lists field fills, asset-driven fills, active existing projects that would be dirtied, archived referencing project counts, and date-expansion blockers.
- Validate reused article date-scope for the imported project's copied date bounds and validate reused-article `articleCreatedAt` fills against existing active or archived target projects that already reference the article.
- Freeze an asset-promotion plan after article matching and merge decisions so Phase 4 knows which extracted assets are still needed; do not copy assets to final runtime paths in Phase 3.
- Reject package-derived article fields that still contain temp paths, absolute paths, source-machine paths, source `/api/runtime-asset` URLs, or asset references not declared in `assetManifest.json`.
- Recompute immutable prompt canonical hashes from package prompt fields, plan existing prompt reuse or new prompt creation, preserve project-prompt link metadata in the plan, and detect project-prompt canonical remap collisions.
- Analyze target import-route matching only against active target routes; missing or inactive target routes are omitted with warnings and do not block by themselves.
- Prove proposed project-route links would not expand the imported project beyond the exported article set independent of current date bounds, and also expose date-bounded preview comparisons.
- Prove proposed article-route writes would not expand existing target projects, including archived projects that may later be unarchived; unsafe route writes are omitted and preserved through snapshot project-article links.
- Compute exact duplicate-package warnings from completed import history by package fingerprint without treating duplicates as blockers or idempotency keys.
- Update `ProjectTransferPlanSummary.overlapCounts` to expose the final overlap fields by the end of Phase 3: `reusedArticleCount`, `newArticleCount`, `reusedArticleUpdateCount`, `reusedArticleFieldFillCount`, `reusedArticleAssetPromotionCount`, `reusedJudgmentCount`, `dirtiedExistingProjectCount`, `omittedRouteLinkCount`, `omittedArticleRouteLinkCount`, `routeArticleSnapshotLinkCount`, `duplicateImportMatchCount`, `storedSignatureJudgmentCount`, `snapshotVerifiedJudgmentCount`, `currentReviewRowsSignatureJudgmentCount`, `storedSignatureHumanReviewCount`, and `currentReviewRowsSignatureHumanReviewCount`. US-003 owns the article, route, asset, and duplicate counts; US-006 owns `reusedJudgmentCount` and the judgment/human-review signature provenance counts. Do not expose the Phase 1 placeholder names `exactDuplicateImports` and `reusedArticles` unless they are explicitly documented as mapped aliases.
- Update `ProjectTransferPlanSummary.conflictCounts` to expose the final blocker/conflict fields by the end of Phase 3: `packageContractConflictCount`, `articleConflictCount`, `projectPromptConflictCount`, `judgmentConflictCount`, and `humanReviewFidelityConflictCount`. US-002 owns `packageContractConflictCount`; US-003 owns `articleConflictCount` and `projectPromptConflictCount`; US-006 owns `judgmentConflictCount` and `humanReviewFidelityConflictCount`. Provider/model dependency state stays in `dependencyStatuses` and blocker details unless the contract deliberately adds named, tested non-conflict summary fields. Do not expose the Phase 1 placeholder conflict names unless they are explicitly documented as mapped aliases.

Quality gates:

- Add or extend `src/server/services/projectTransfer/projectTransferAnalyze.test.ts`; `bun test src/server/services/projectTransfer/projectTransferAnalyze.test.ts` passes.
- Add or extend `src/server/services/projectTransfer/projectTransferDuplicateDetection.test.ts`; `bun test src/server/services/projectTransfer/projectTransferDuplicateDetection.test.ts` passes.
- `bun test src/server/services/projectTransfer/projectTransferIdentifierNormalization.test.ts` passes if identifier comparison helpers change.
- `bun test src/server/services/projectTransfer/projectTransferContracts.test.ts` passes if overlap or conflict contract keys change.
- `bun run lint` passes for touched `src` files.

### US-004: Add provider and model dependency resolution service

Description: As a user, I need safe provider/model mapping during import so required models are resolved only to enabled, selectable, identity-equivalent target rows.

dependsOn: ["US-002"]

Acceptance criteria:

- Implement `POST /api/projects/import/:sessionId/resolve-dependencies` behavior on top of the durable import plan, including `planRevision` checks, stale-plan responses, and refreshed session plan summaries.
- Resolve-dependencies requests include the caller's current `planRevision`; stale revisions return the latest session/plan without mutating it.
- Validate resolve-dependencies bodies with ArkType before mutation, including `planRevision`, selected connection ids, created-connection handoffs, model materialization requests, Codex setup state, and any explicit unresolved-state choices. Reject unknown or shape-invalid mutations before reading or updating the plan.
- Dependency-resolution mutations that change a `ready_to_commit` plan must first reopen the session to `awaiting_resolution`, increment `planRevision`, and recompute stale-sensitive blockers.
- Implement provider auto-match by safe fingerprint only when exactly one enabled target connection returned by the normal provider connection list flow matches and required imported models remain selectable on that connection. `listProviderConnections()` filters provider connections whose persisted config has `archived: true`; dependency resolution must also reject archived chosen connections and connections whose `disabledModelIds` hide required mapped models.
- Define provider equivalence using provider kind, registry transport family, portable sanitized fingerprint/effective endpoint identity, runtime mode, and source-signature-relevant config; labels, local URLs, and worker URLs are review hints only.
- Support choosing existing listed/enabled connections and creating new connections with sanitized prefill through normal provider endpoints; provider auth, API key setup, connection test, and discovery remain unresolved until the normal setup flow completes.
- Do not edit existing provider connections in the import wizard; if a future edit path is added, first patch and test by-id read/list/PATCH parity for hidden persisted fields such as `config.archived`, `config.disabledModelIds`, manual worker settings, `secretRef`, and `maxInflightRequests`.
- Implement non-Codex model materialization through mapped provider-connection model routes such as `POST /api/provider-connections/:id/models` or `POST /api/provider-connections/:id/sync-models`, not generic `ensureSelectableModelId`.
- For nullable `remoteModelId` model descriptors, only auto-match an existing enabled/selectable target model when fallback identity fields such as `modelName`, `name`, `displayName`, `variant`, and `version` converge on one row; otherwise leave the model unresolved.
- After materialization, server-side dependency resolution re-queries the mapped provider connection through provider repositories and re-reads stored model state through provider/model repositories or the same state exposed by `GET /api/models/stored`. Wizard UI state must come from the `GET /api/provider-connections` list payload unless a public by-id route is deliberately added with response-parity tests. Verify returned database models are enabled, selectable, unique, connected to a live provider row, not hidden by provider disabled-model config, and identity-equivalent for imported judgments.
- Expose provider/model unresolved state through `ProjectTransferPlanSummary.dependencyStatuses` plus blocker details or deliberately named, tested non-conflict summary fields; do not continue exposing the Phase 1 placeholder `dependency` conflict count as the only unresolved-dependency signal.
- Before import depends on selectable-model validation, ensure shared selectable-model guards such as `assertSelectableProviderModelIds()` require a live provider connection row and respect provider `config.archived` plus `disabledModelIds`; do not let `LEFT JOIN` plus `COALESCE(pc.enabled, TRUE)` make orphaned models selectable.
- If current provider model routes cannot persist prompt-affecting metadata needed by imported judgment signatures, including metadata beyond the current manual route's `options.thinking` support, keep the dependency unresolved until provider discovery or an import-safe writer can prove metadata equivalence.
- Non-equivalent substitute models may be accepted only for the new project's future settings when no imported judgment references that source model.

Quality gates:

- Add or extend `src/server/services/projectTransfer/projectTransferDependencyResolution.test.ts`; `bun test src/server/services/projectTransfer/projectTransferDependencyResolution.test.ts` passes.
- `bun test src/server/providers/providerModelRepository.test.ts` passes.
- `bun test src/server/providers/providerModelRepository.atomic.test.ts` passes if selectable-model guards or disabled-model behavior changes.
- `bun test src/server/services/userConfigQueryService.test.ts` passes if shared selectable-model guard behavior changes.
- `bun test src/server/providers/providerConnectionRepository.atomic.test.ts` passes if provider connection archived/config round-trip behavior changes.
- `bun test src/server/providers/providerDbUtils.test.ts` passes if provider config selectability helpers change.
- `bun test src/server/routes/projectTransferRoutes.test.ts` passes if resolve-dependencies route behavior changes.
- `bun test src/server/routes/ProviderConnectionsRoutes.test.ts` passes if provider list/create/setup behavior changes.
- `bun test src/server/routes/ProviderModelsRoutes.test.ts` passes if provider model materialization behavior changes.
- `bun test src/server/routes/providerProjectFlow.e2e.test.ts` passes if shared provider setup flow changes.
- `bun run build` passes.
- `bun run lint` passes for touched `src` files.

### US-005: Add Codex, Anthropic virtual id, and virtual model resolution handling

Description: As a user, I need Codex and virtual Anthropic model dependencies to resolve through the correct provider-specific flows without confusing UI ids with database ids.

dependsOn: ["US-004"]

Acceptance criteria:

- Use `POST /api/models/ensure` only for Codex import materialization.
- Reuse exact Codex readiness/auth endpoints `GET /api/models/codex/status`, `POST /api/models/codex/login`, and `GET /api/models/codex/login/:jobId` before Codex materialization when the target machine is not ready for the imported Codex dependency.
- Treat Codex and Anthropic selectable ids from `GET /api/models` as virtual UI ids until verified database model ids exist.
- Materialize Anthropic variants through the mapped provider connection, not through the Anthropic branch of `POST /api/models/ensure`.
- Verify Codex materialization by re-reading the resulting database model and provider connection before marking the source model resolved.
- Block final import while required Codex-backed models are unresolved.
- Keep non-equivalent substitute models available only for future project settings when no imported judgment references that source model.

Quality gates:

- Add or extend `src/server/services/projectTransfer/projectTransferDependencyResolution.test.ts`; `bun test src/server/services/projectTransfer/projectTransferDependencyResolution.test.ts` passes.
- `bun test src/server/routes/ModelsRoutes.test.ts` passes if Codex status/login routes or `POST /api/models/ensure` behavior changes; add this test file if it does not exist.
- `bun test src/server/routes/ProviderModelsRoutes.test.ts` passes if provider-connection model materialization behavior changes.
- `bun test src/server/routes/providerProjectFlow.e2e.test.ts` passes if shared provider setup flow changes.
- `bun run build` passes.
- `bun run lint` passes for touched `src` files.

### US-006: Add judgment and human/review fidelity validation during analyze

Description: As an implementer, I need analyze to validate imported judgments and human/review state after remapping so commit cannot silently preserve decisions against different content.

dependsOn: ["US-003", "US-005"]

Acceptance criteria:

- Recompute `judgmentInputSignature` after article, prompt, provider, model, content setting, full-text processing, and asset path remapping.
- Preserve and expose `judgmentInputSignatureProvenance`, including counts for stored, snapshot-verified, and `currentReviewRows` provenance.
- Recompute `humanReviewInputSignature` for human judgments, human summaries, and review rows after article, prompt, and asset remapping.
- Preserve and expose `humanReviewInputSignatureProvenance`, including counts for stored and `currentReviewRows` provenance.
- Populate the judgment and human/review plan-summary fields owned by fidelity validation: `reusedJudgmentCount`, `storedSignatureJudgmentCount`, `snapshotVerifiedJudgmentCount`, `currentReviewRowsSignatureJudgmentCount`, `storedSignatureHumanReviewCount`, `currentReviewRowsSignatureHumanReviewCount`, `judgmentConflictCount`, and `humanReviewFidelityConflictCount`.
- Detect equivalent physical-key judgment reuse, non-equivalent physical-key conflicts, review-visible natural-key conflicts, reused-judgment assessment conflicts, and reused-judgment benchmark field conflicts.
- Treat the wizard-visible judgment conflict status as unresolved/unknown while required model mappings are unresolved. Use one tested contract shape: either widen `judgmentConflictCount` to allow `null` for the orchestrator-compatible unknown state, or expose the unknown state outside `conflictCounts` through a documented mapping such as `judgmentConflictStatus: 'unknown'`. Do not use a negative sentinel or the Phase 1 placeholder `judgment` count for this state; require a concrete non-negative `judgmentConflictCount` before entering `ready_to_commit`.
- Detect human judgment, human summary, review, and assessment package-internal duplicate keys and target conflicts against the final planned insert/reuse sets.
- Validate every unique key the import will later write or reuse in Phase 4 plan terms: non-null article identifiers, project import routes, article import routes, project articles, judgment assessments, human judgments, human summaries, and reviews.
- Block mismatched judgment or human/review signatures and expose conflict counts in the plan; mismatches are fidelity blockers, not warnings.
- Do not classify the plan as `ready_to_commit` until all required provider/model dependencies are resolved and all package, article, prompt, judgment, and human/review blocker counts are zero.

Quality gates:

- Add or extend `src/server/services/projectTransfer/projectTransferAnalyze.test.ts`; `bun test src/server/services/projectTransfer/projectTransferAnalyze.test.ts` passes.
- Add or extend `src/server/services/projectTransfer/projectTransferDependencyResolution.test.ts`; `bun test src/server/services/projectTransfer/projectTransferDependencyResolution.test.ts` passes.
- `bun test src/server/services/projectTransfer/projectTransferContracts.test.ts` passes if conflict counts or plan-summary contracts change.
- `bun run lint` passes for touched `src` files.

### US-007: Add import wizard through plan review

Description: As a user, I need a layout-first import wizard to upload a package, review warnings, resolve dependencies, and inspect the import plan before commit exists.

dependsOn: ["US-001", "US-003", "US-005", "US-006"]

Acceptance criteria:

- Add `/projects/import` route and regenerate route tree through the app build pipeline.
- Add `Import Project` on `/projects` immediately left of `Create Covidence Project`.
- Keep the projects shell layout intact; do not suspend the root `<Outlet />` or the entire projects route.
- Wizard supports upload progress, extraction/analyze progress, package review, duplicate warnings, dependency resolution, plan review, stale `planRevision` handling, cancellation, blockers, and `canCommit` state.
- Wizard exposes the full overlap and conflict summary fields, reused-article update plan, route-link omissions, snapshot project-article links, final provider/model mappings, judgment signature provenance, human/review signature provenance, and resolution kinds for non-wizard-resolvable blockers.
- Wizard uses Eden/TanStack Query for normal session reads and mutations and local `fetch` only for streaming upload or response handling that Eden cannot represent.
- Manual upload calls use `getApiRequestUrl` so browser/dev and desktop resolve the same API origin.
- Dependency setup may select an existing listed/enabled connection, create a new connection with sanitized prefill, complete managed auth, test/discover provider models, run Codex status/login, and materialize provider-mapped models without editing existing provider connections.
- If dependency setup leaves the wizard for standalone provider pages, add a `returnTo` or import-session handoff contract before relying on that flow.
- Final commit UI is disabled or clearly marked unavailable in Phase 3; the route must not call a real commit mutation until Phase 4 implements final writes.

Quality gates:

- Add `src/app/routes/+projects/-+import.vitest.tsx`; `bunx vitest run src/app/routes/+projects/-+import.vitest.tsx` passes.
- `bunx vitest run src/app/routes/+projects/-+index.vitest.tsx` passes.
- `bun test src/app/utils/getApiRequestUrl.test.ts` passes if upload/download URL helpers change.
- `bun run build` passes.
- `bun run desktop:build` passes.
- `bun run lint` passes for touched `src` files.
- Browser smoke verification passes: `/projects` opens `/projects/import`, the wizard shell remains rendered during session/upload/analyze progress, and a small package reaches plan review without final writes.
- Desktop smoke verification passes: the import wizard uses the desktop-safe API origin for file upload/session polling and reaches plan review, with final commit still disabled until Phase 4.
