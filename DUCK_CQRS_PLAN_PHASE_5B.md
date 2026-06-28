# DuckDB CQRS Plan Phase 5B - V4 Rebuild Request Foundation And Startup Cutover

Master coordinator: [DUCK_OOM_FIX_PLAN.md](./DUCK_OOM_FIX_PLAN.md)

## Objective

Phase 5B was added after the 2026-06-23 `judgment_fact` large-rebuild OOM exposed that legacy mart refresh and maintenance paths still existed beside V4 serving contracts.

This phase completed the first bounded implementation slices: durable V4 rebuild requests, operator request script rewrites, startup/package-script cutover, recovery command rewiring, warning-route side-effect removal, and focused static guards.

The remaining legacy-retirement work is moved to [Phase 5C](./DUCK_CQRS_PLAN_PHASE_5C.md). Phase 5B is no longer the final cut line for legacy maintenance retirement.

## Cut Line

Phase 5B is complete when normal startup and normal operator request entrypoints no longer start legacy refresh or seven-phase large-rebuild workers, and normal rebuild/repair scripts create V4 rebuild requests instead of legacy phase rows.

Phase 5B does not claim that every legacy mart refresh/rebuild implementation is removed or fully guarded. That is Phase 5C scope.

## Completed Workstreams

| Status | Theme                             | Evidence                                                                                                                                                                                                  |
| ------ | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [x]    | V4 rebuild request API foundation | Added durable `app.review_rebuild_request`, request-owned chunk fields, request admission, retry/over-budget metadata, claim gating, repository tests, and shared V4 request service.                     |
| [x]    | Operator request script cutover   | Rewired `requestProjectLargeRebuild`, `requestReviewServingAllProjectsRebuild`, and `requestJudgmentFactRepair` to create V4 rebuild requests rather than legacy `project_mart_large_rebuild_state` rows. |
| [x]    | Startup and heartbeat cutover     | Removed normal maintenance startup calls for legacy refresh and large-rebuild heartbeats; startup now starts the V4 projector heartbeat.                                                                  |
| [x]    | Package-script cutover            | Normal large-rebuild worker package scripts were renamed to explicit `legacy-admin-*` commands with `--legacy-admin-ack=legacy-large-rebuild`.                                                            |
| [x]    | Recovery command first cutover    | `recoverDirtyRefreshClaims --recover` now creates V4 rebuild requests rather than shelling into legacy refresh or large-rebuild worker scripts.                                                           |
| [x]    | Warning side-effect removal       | Review-warning reads no longer scan `mart.judgment_fact`, enqueue missing visible judgment fact repair, or bootstrap legacy large rebuilds.                                                               |
| [x]    | Focused static guards             | Added `reviewServingPhase5BStaticGuards.test.ts` for startup, warning side effects, recovery, package commands, and legacy-admin acknowledgement coverage.                                                |

## Phase 5C Handoff

Phase 5C owns the unfinished items that were originally listed in Phase 5B but were not implemented in Parts 1-5.

| Moved Item                                   | Phase 5C Direction                                                                                                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Legacy path audit and classification         | Inventory every remaining caller and classify as `retire`, `rewire-to-v4`, or `admin-debug-only` with guard evidence.                                                           |
| Legacy large rebuild executor/runner cutover | Retire or block normal execution of `projectMartLargeRebuild*`, `temp_project_judgment_fact_article`, `getProjectJudgmentFactBatchInsertSql`, and the seven legacy phase chain. |
| Dirty refresh cutover                        | Route producer-level dirty refresh through V4 dirty work, component acknowledgements, projector wakeups, and manifest completion.                                               |
| Admin controls                               | Remove, block, or V4-rewire legacy admin run/pause/resume controls; keep legacy status read-only, capped, and admin/debug-only.                                                 |
| Progress and warning UI                      | Replace normal UI legacy phase/counter copy with V4 snapshot, chunk, projector, stale/indexing/unavailable, and last-known-good diagnostics.                                    |
| Health/admin side effects                    | Make health/admin status reads side-effect free and move remediation into explicit V4 actions.                                                                                  |
| Legacy state cleanup                         | Freeze, migrate, delete, or explicitly retain old refresh, large-rebuild, and V3 mart state so normal claim paths cannot resume it.                                             |
| Broader guards                               | Add SQL-shape, producer inventory, admin-control, dirty-refresh, and runtime guards beyond the focused Phase 5B static test.                                                    |
| Adversarial OOM closure                      | Add checkpoint, append/import, V4 chunk, cross-project, retry-thrash, offline-repair, and telemetry gates before Phase 6 physical evidence.                                     |
| Phase 6 handoff                              | Update release evidence so the physical run starts with Phase 5C complete, legacy normal rebuild disabled, and V4 projector/chunk paths enabled.                                |

## Implementation Progress - 2026-06-23

### Part 1 - V4 Rebuild Request Foundation

- Status: completed and committed as the first manageable implementation slice.
- Added `0107_reviewServingRebuildRequest.sql` with durable `app.review_rebuild_request` state above chunk manifests.
- Extended `app.review_rebuild_chunk_manifest` with request ownership, retry-after, retry count, OOM category, over-budget reason, split/parent/snapshot fields, row/byte/prompt/temp budget fields, workload class, admission state, and diagnostics JSON.
- Added `reviewServingRebuildRequestRepository.ts` so rebuild/repair/refresh callers can create component-scoped V4 requests and chunk manifests without using legacy phase rows.
- Updated chunk claim logic so request-owned chunks are claimable only when the parent request is admitted and not cooling down; over-budget chunks are parked before execution.
- Verification: `bun test src/server/reviewServing/reviewServingSchema.test.ts src/server/reviewServing/reviewServingChunkManifestRepository.test.ts src/server/reviewServing/reviewServingRebuildRequestRepository.test.ts`.

### Part 2 - Operator Request Script Cutover

- Status: completed and committed as the second implementation slice.
- Added `reviewServingV4RebuildRequestService.ts` with default full rebuild and judgment-repair component sets plus conservative request/chunk budgets.
- Rewired `scripts/requestProjectLargeRebuild.ts` and `scripts/requestReviewServingAllProjectsRebuild.ts` to create V4 rebuild requests instead of writing `app.project_mart_large_rebuild_state`.
- Rewired `scripts/requestJudgmentFactRepair.ts` so normal repair requires explicit project selection and enqueues judgment-related V4 components instead of scanning or repairing `mart.judgment_fact`.
- Verification: `bun test scripts/requestReviewServingAllProjectsRebuild.test.ts scripts/requestProjectLargeRebuild.test.ts scripts/requestJudgmentFactRepair.test.ts` plus focused ESLint on touched files.

### Part 3 - Startup And Package Script Cutover

- Status: completed as the third implementation slice.
- Removed normal maintenance startup imports and calls for `startProjectMartRefreshWorkerHeartbeat`, `startProjectMartLargeRebuildHeartbeat`, and the legacy mart-refresh drain gate.
- Maintenance startup now starts shared closeout/bulk work and the V4 `startReviewServingProjectorWorkerHeartbeat` path without mounting legacy refresh or seven-phase large-rebuild cycles.
- Renamed normal package scripts for legacy large-rebuild workers to `db:duck:legacy-admin-run-large-rebuild-worker-once` and `db:duck:legacy-admin-run-large-rebuild-worker-cycles`, each carrying `--legacy-admin-ack=legacy-large-rebuild`.
- Verification: `bun test src/server/utils/startBackgroundWork.test.ts scripts/rebuild2PackageCommands.test.ts scripts/runLargeRebuildWorkerOnce.test.ts scripts/runLargeRebuildWorkerCycles.test.ts` plus focused ESLint on touched files.

### Part 4 - Recovery And Warning Side-Effect Cutover

- Status: completed as the fourth implementation slice.
- Rewired `scripts/recoverDirtyRefreshClaims.ts --recover` so stale dirty materialization, dirty refresh, and large-rebuild claims create V4 `app.review_rebuild_request` rows instead of shelling into legacy refresh or large-rebuild worker scripts.
- Recovery now leaves legacy stale claim rows as diagnostic state and returns the created V4 request IDs in structured output.
- Removed review-warning route legacy `mart.judgment_fact` missing-row scans, dirty-state repair enqueueing, and missing-serving-row large-rebuild bootstrap side effects.
- Verification: `bun test scripts/projectMartRefreshRecovery.test.ts src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.test.ts` plus focused ESLint on touched files.

### Part 5 - Legacy Admin Acknowledgements And Static Guards

- Status: completed as the fifth implementation slice.
- Added `legacy-dirty-refresh` acknowledgement requirements to direct legacy dirty-refresh worker scripts: `runProjectMartRefreshWorker.ts`, `runProjectMartRefreshWorkerOnce.ts`, and `runProjectMartRefreshWorkerOnceIsolated.ts`.
- Added `reviewServingPhase5BStaticGuards.test.ts` to lock in Phase 5B startup, warning side-effect, recovery, package-command, and legacy-admin acknowledgement coverage.
- Extended recovery CLI compatibility tests so direct isolated dirty-refresh execution proves the new acknowledgement block.
- Verification: `bun test src/server/reviewServing/reviewServingPhase5BStaticGuards.test.ts scripts/projectMartRefreshRecovery.test.ts` plus focused ESLint on touched files.

## JavaScript And TypeScript Rule

Use `effect` for new non-trivial async and server orchestration in V4 rebuild requesting, chunk creation, repair/recovery command rewrites, and worker retry logic. Prefer `Effect.gen` for sequencing, `Layer`/`Context` for services, `Effect.acquireRelease`/`Scope` for leases and owned resources, and `Schedule` for retry/backoff. Keep pure transforms and small local handlers as plain functions.

## Quality Gates

- [x] V4 rebuild requests have durable request IDs, status, retry policy, admission estimates, over-budget state, diagnostics, and request-to-chunk linkage.
- [x] Normal rebuild and repair request scripts create V4 component rebuild requests or chunk manifests rather than legacy phase rows.
- [x] Repair CLI tests prove V4 work is queued and legacy normal rebuild rows are not scheduled by the rewired scripts.
- [x] Recovery CLI tests prove stale recovery creates V4 work and does not shell into legacy workers.
- [x] Review-warning route tests prove the warning read does not scan `mart.judgment_fact`, enqueue dirty repair, or bootstrap legacy large rebuilds.
- [x] Startup and heartbeat tests prove production/browser/desktop maintenance startup cannot mount legacy refresh or large-rebuild cycles.
- [x] Package-script static tests prove normal operator entrypoints are V4-rewired or explicitly legacy-admin with acknowledgement.
- [x] Legacy dirty-refresh and large-rebuild worker scripts require explicit legacy-admin acknowledgement for direct execution.
- [x] Focused static guard coverage exists for startup, warning side effects, recovery, package commands, and legacy-admin acknowledgements.
- [x] `bun test src/server/reviewServing/reviewServingSchema.test.ts src/server/reviewServing/reviewServingChunkManifestRepository.test.ts src/server/reviewServing/reviewServingRebuildRequestRepository.test.ts`
- [x] `bun test scripts/requestReviewServingAllProjectsRebuild.test.ts scripts/requestProjectLargeRebuild.test.ts scripts/requestJudgmentFactRepair.test.ts`
- [x] `bun test src/server/utils/startBackgroundWork.test.ts scripts/rebuild2PackageCommands.test.ts scripts/runLargeRebuildWorkerOnce.test.ts scripts/runLargeRebuildWorkerCycles.test.ts`
- [x] `bun test scripts/projectMartRefreshRecovery.test.ts src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.test.ts`
- [x] `bun test src/server/reviewServing/reviewServingPhase5BStaticGuards.test.ts scripts/projectMartRefreshRecovery.test.ts`
- [x] No Phase 5B OOM fix implementation required a new `OOM_ERRORS.md` entry beyond existing OOM records.
