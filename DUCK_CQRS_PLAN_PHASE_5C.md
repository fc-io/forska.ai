# DuckDB CQRS Plan Phase 5C - Final Legacy Maintenance Retirement

Master coordinator: [DUCK_OOM_FIX_PLAN.md](./DUCK_OOM_FIX_PLAN.md)

## Objective

Finish the remaining Phase 5B legacy-retirement work. Phase 5C is the final implementation cutover before Phase 6 physical evidence.

After Phase 5C, no normal browser, desktop, startup, heartbeat, warning, health, recovery, admin run-control, package-script, dirty-refresh, repair, rebuild, or operator path may rebuild review-serving freshness by writing or scheduling legacy V3 mart state.

Phase 6 may start only after this phase proves that legacy normal rebuild is disabled and V4 requests/chunks/projectors own normal review-serving freshness.

## Carry-Forward From Phase 5B

Phase 5B completed these prerequisites:

- Durable `app.review_rebuild_request` state and request-owned chunk metadata exist.
- Normal large-rebuild and judgment-repair request scripts create V4 rebuild requests.
- Normal startup no longer starts legacy refresh or large-rebuild heartbeats.
- Normal package commands no longer expose legacy large-rebuild workers without explicit legacy-admin acknowledgement.
- `recoverDirtyRefreshClaims --recover` creates V4 requests instead of shelling into legacy workers.
- Review-warning reads no longer scan `mart.judgment_fact` or schedule legacy repair as a side effect.
- Focused static guards cover those decisions.

## Cut Line

Phase 5C is complete only when legacy V3 mart refresh/rebuild code can no longer drive normal review-serving freshness or rebuild completion for browser or desktop flows.

Allowed after the cut line:

- V4 projectors write `mart.review_*_v4` and promote snapshots through V4 manifests.
- Operator commands enqueue V4 dirty work, V4 rebuild chunks, V4 projector retries, or explicit V4 repairs.
- Legacy V3 tables remain only as explicitly named admin/debug/compatibility data until deletion is safe.
- Admin/debug SQL may inspect legacy state only when route-classified, guarded, capped, read-only unless V4-rewired, and excluded from normal product freshness decisions.

Not allowed after the cut line:

- Normal large rebuild phases named `project_scope_article`, `judgment_fact`, `prompt_answer_fact`, `review_answer_dictionary`, `review_article_filter_member`, `review_article_rollup`, or `review_article_serving` as production serving rebuild work.
- Normal refresh or repair commands that treat `mart.judgment_fact` repair as the route to current review-serving state.
- Background maintenance that runs global raw fact/mart deletes, inserts, windows, raw counts, selected-import CTEs, JSON extraction, unbounded `IN`/`VALUES`/`UNION ALL` materialization, or full-output ordered checksum aggregation for normal review-serving freshness.
- Any hidden fallback where a failed V4 snapshot, missing snapshot, or stale V4 projection triggers legacy raw/mart rebuild for normal browser or desktop review flow.
- Startup, heartbeat, package-script, warning, health, recovery, or admin run controls that schedule old `project_mart_large_rebuild_state` or `project_mart_refresh_state` work for normal product freshness.

## Known Remaining Legacy Evidence

The current branch still has these legacy surfaces to retire, block, or classify:

| Surface                       | Evidence                                                                                                                                                                                                            | Required Outcome                                                                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Large rebuild runner/executor | `projectMartLargeRebuildRunner.ts` still executes the seven legacy phases, and `projectMartLargeRebuildExecutor.ts` still contains `temp_project_judgment_fact_article` and `getProjectJudgmentFactBatchInsertSql`. | No normal path can claim or run those phases. Either delete/quarantine the code or require explicit legacy-admin execution with tests proving no normal caller. |
| Dirty refresh worker          | `projectMartRefreshWorker.ts` still calls legacy `refreshDirtyProjectArticleBatch` and can request `project_scope_article` rebuild setup.                                                                           | Normal dirty work becomes V4 dirty intake, component acknowledgements, projector wakeups, and manifest-based completion.                                        |
| Mart maintenance service      | `getDuckdbMartMaintenanceService.ts` still exposes V3 refresh/rebuild methods and direct legacy mart writes.                                                                                                        | Retire direct production writes; keep only bounded admin/debug helpers or wrappers that enqueue V4 work.                                                        |
| Admin run controls            | `AdminInvestigateRoutes.ts` still mounts legacy large-rebuild run/pause/resume controls, and the admin page still exposes them.                                                                                     | Remove, block, or V4-rewire run controls. Legacy status is read-only, capped, and admin/debug-only.                                                             |
| Progress UI                   | `reviewsIndexingProgress` and warning copy still show legacy phase names and counters.                                                                                                                              | Normal UI reports V4 snapshot/chunk/projector readiness and does not render legacy phase names outside admin/debug diagnostics.                                 |
| Health/admin status           | Health/admin paths still need side-effect-free V4 diagnostics coverage.                                                                                                                                             | Status reads report V4 state only; remediation is explicit V4 action.                                                                                           |
| Legacy state                  | Existing `project_mart_refresh_state`, `project_mart_large_rebuild_state`, and V3 mart rows can still exist.                                                                                                        | Migrate, freeze, mark retired, delete, or retain as admin/debug compatibility so no normal claim path resumes them.                                             |
| Guard coverage                | Phase 5B guards are focused and do not cover broad SQL shape, producer inventory, admin controls, or runtime legacy blocking.                                                                                       | Add broader static and runtime guards with allowlists for admin/debug-only reads.                                                                               |

## Workstreams

| Status | Theme                                          | Implement First                                                                                                                                                                                  | Done When                                                                                                                                                                |
| ------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [ ]    | Legacy path audit and classification           | Inventory every caller that writes or depends on legacy review marts, including scripts, workers, routes, warnings, tests, admin tools, adjacent browser fallbacks, and admin investigate reads. | Each caller is classified as `retire`, `rewire-to-v4`, or `admin-debug-only`, with a test or static guard proving the classification.                                    |
| [~]    | V4 rebuild request completion                  | Finish automatic refresh entrypoints and projector wakeups on top of Phase 5B request/chunk foundations.                                                                                         | Normal refresh, repair, and rebuild entrypoints create V4 requests/chunks/dirty work and wake the projector without legacy phase rows.                                   |
| [ ]    | Legacy large rebuild cutover                   | Replace or block `projectMartLargeRebuild*` normal execution.                                                                                                                                    | No normal code path can run `temp_project_judgment_fact_article`, `getProjectJudgmentFactBatchInsertSql`, or the seven legacy phases as production serving rebuild work. |
| [~]    | Dirty refresh cutover                          | Route dirty article/project refresh through delta intake, dirty-work coalescing, component acknowledgements, and V4 projector wakeups.                                                           | `projectMartRefreshWorker` no longer calls legacy mart refresh methods or requests `project_scope_article` rebuilds for normal freshness.                                |
| [~]    | Repair and recovery command cutover            | Finish quarantine/unquarantine and admin repair controls after Phase 5B script/recovery rewires.                                                                                                 | Recovery with `--recover` and remediation actions enqueue V4 retries only; legacy state is read-only or blocked unless explicitly acknowledged as admin/debug.           |
| [ ]    | Progress, warning, and health cutover          | Make UI and warning/health APIs read V4 snapshot, chunk, dirty-work, and projector diagnostics.                                                                                                  | Browser and desktop show failed/stale/indexing/unavailable V4 states and never imply a legacy rebuild is the normal freshness source.                                    |
| [~]    | Warning, health, and admin side-effect removal | Extend Phase 5B warning side-effect removal to health/admin status paths and explicit V4 operator actions.                                                                                       | GET/status routes are side-effect free; remediation is explicit, V4-only, and tested.                                                                                    |
| [ ]    | Admin/debug route hardening                    | Remove, block, or V4-rewire legacy run/pause/resume controls.                                                                                                                                    | Legacy status reads are capped, labeled admin/debug, read-only unless V4-rewired, and excluded from normal product flows.                                                |
| [ ]    | Adversarial OOM taxonomy and recovery          | Add pass/fail behavior for checkpoint, append/import, V4 chunk/projector, dirty-work intake, cross-project, retry-thrash, and offline-repair OOMs.                                               | Each OOM class has admission, cooldown/split/quarantine, telemetry, and Phase 6 proof requirements.                                                                      |
| [ ]    | Legacy state cleanup                           | Freeze, migrate, delete, or explicitly retain obsolete legacy state and phase rows after caller cutover.                                                                                         | No active refresh state is stranded, no last-known-good V4 snapshot is lost, and no normal claim path can resume legacy work.                                            |
| [~]    | Static and runtime guards                      | Extend Phase 5B focused guards to SQL shape, producer inventory, admin controls, dirty-refresh workers, and runtime legacy blocks.                                                               | Tests fail on normal legacy SQL shape, broad raw maintenance in normal paths, and unclassified DuckDB work.                                                              |
| [ ]    | Release evidence handoff                       | Update Phase 6 evidence scope and scripts around the Phase 5C cut line.                                                                                                                          | Physical release evidence runs with legacy normal rebuild disabled and V4 projector/chunk paths enabled.                                                                 |

## Required Fixes

| #   | Fix                                                       | What It Does Now                                                                           | What It Should Do                                                                                                                                            | Why It Helps                                                               |
| --- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| 1   | Stop scheduling legacy review-serving large rebuilds      | Some normal or admin-adjacent paths can still reach old project mart large rebuild phases. | Request V4 rebuild jobs/chunks for required components and snapshots.                                                                                        | Removes the unsafe `judgment_fact` path from normal rebuilds.              |
| 2   | Replace `judgment_fact` refresh with component projection | The old phase deletes and reinserts global judgment facts by article batch.                | V4 `judgmentInputContent`, `llmStatus`, `payload`, `summary`, `posting`, and `queue` components recompute only affected scoped outputs.                      | Prevents global fact scans and parallel truth models.                      |
| 3   | Budget rebuild chunks by rows, bytes, and temp risk       | Legacy chunks are sized mostly by article count.                                           | Chunk manifests record estimated input rows, output rows, payload bytes, temp budget, prompt density, and fanout; oversized chunks split before execution.   | An article batch with many judgments cannot exceed the memory envelope.    |
| 4   | Use projector workload admission for rebuild work         | Legacy background SQL uses background DuckDB access but not V4 projector contracts.        | V4 rebuild chunks run under `reviewProjector` workload context with temp-spill policy, queue pressure, and wake budgets.                                     | Makes background rebuilds obey serving-projector safety rules.             |
| 5   | Remove global delete/reinsert semantics                   | Legacy phases rewrite broad mart state per batch or per project.                           | Projector writes are idempotent, component-scoped, base/patch keyed, and manifest-promoted.                                                                  | Avoids large hash/delete memory spikes and makes retries safe.             |
| 6   | Make refresh completion manifest-based                    | Legacy refresh completion can depend on old phase state and dirty ACKs.                    | Completion depends on required V4 component watermarks, successful chunk manifests, and active or last-known-good snapshot state.                            | Failed rebuilds preserve stale serving data instead of forcing raw repair. |
| 7   | Preserve benchmark-critical judgment settings             | Legacy repair can rebuild facts without explicit route/component identity.                 | V4 work carries `modelId`, content flags, prompt identities, `reviewConfigHash`, `snapshotId`, and component identity in manifests, cursors, jobs, and logs. | Prevents silent profile drift and wrong judgment reuse.                    |
| 8   | Coalesce dirty work by component                          | Legacy dirty refresh can reprocess whole article chains because another phase lags.        | Dirty acknowledgements are component high-water rows or compact ranges.                                                                                      | A slow optional component does not make current required components rerun. |
| 9   | Delete or freeze V3 marts after cutover                   | Old tables remain available and easy to call accidentally.                                 | Drop them, move them to explicit legacy/admin compatibility, or block normal callers by static/runtime tests.                                                | Prevents hidden fallback and parallel writer drift.                        |
| 10  | Budget append/import and checkpoint paths                 | Append lanes and checkpoints can still hit DuckDB memory or WAL/temp pressure.             | Split by row count, parameter count, payload bytes, lane pressure, WAL/temp/RSS state, and checkpoint context.                                               | Covers OOMs outside review-list and rebuild SQL.                           |

## V4 Rebuild Request And Chunk Contract

Normal large rebuild, repair, and refresh requests create durable V4 work through `app.review_rebuild_request` above chunk manifests. Request admission happens before chunks become claimable and estimates scope rows, prompt count, judgment density, selected-import multiplicity, payload/full-text bytes, posting/filter fanout, summary/facet/option cardinality, snapshot count, expected output rows, expected output bytes, and temp risk.

Missing or excessive estimates park the request as `blocked_over_budget` with diagnostics. They do not run the projector to discover the OOM by spilling or allocating.

Normal requests and chunks carry these fields:

- Request ID, `project_id`, reason, priority, owner/lease, request status, retry count, retry-after, OOM category, and last error.
- Optional project subset or filter signature.
- `requested_components`, using only known projection component names.
- Required identity inputs: `snapshot_id`, `review_config_hash`, component `projection_identity`, `base_generation`, and `patch_watermark` where relevant.
- Source watermarks for import deltas, review-change deltas, project-scope state, prompt/config changes, and selected-import snapshots.
- Chunk key range, parent chunk ID, split depth, single `snapshot_id` or explicit `snapshot_count`, output base generation, input digest, expected output count or bounded checksum when available, status, owner, lease, retry count, retry-after, OOM category, and last error.
- Estimated, maximum, and observed input rows, output rows, output bytes, payload bytes, prompt count, temp bytes, duration, and over-budget reason.
- Workload class and budgets: maximum input rows, output rows, result bytes, payload bytes, statement/transaction bytes, temp spill policy, timeout, wake duration, retry schedule, and queue priority.
- Completion rule: required component chunks complete, manifests validate, snapshot promotion succeeds, and dirty work is acknowledged per component.

The request contract must not store raw all-article ID arrays or make a single `VALUES (...)` list the durable representation of a rebuild batch.

Chunk admission and recovery rules:

- Chunk admission checks current DuckDB memory limit, active projector count, import pressure, append queue pressure, temp-directory free space, configured concurrency, and request/chunk budgets before claim.
- Rebuild workload contexts include project ID, request ID, chunk ID, component, snapshot/base generation, max result rows, max result bytes, max temp bytes, and timeout. `allowsTempSpill: false` is a backstop, not the only budget.
- Chunks are single-snapshot by default. Multi-snapshot chunks include an explicit `snapshot_count` multiplier and still fit row/byte/temp budgets.
- Component fanout drives chunk boundaries: display/payload uses article count plus payload/full-text bytes; LLM work uses article by prompt by judgment density; human work distinguishes prompt-mode and summary-mode rows; posting/queue work budgets filter memberships and posting rows; summary and filter-option work are separate components keyed by summary key, facet/filter kind, value bucket, or prompt bucket.
- Selected-import rebuilds avoid project-wide candidate selection, anti-join winner selection, and global `ORDER BY LIMIT` per batch. They use bounded article/import-route/rank-key ranges or precomputed winner state.
- Full-output validation cannot use unbounded ordered `string_agg` or equivalent project-wide checksums. Digests are computed during writes or per chunk shard under the same predicates and budgets as the rebuild query.
- Projectors do not return or write unbounded TypeScript arrays in one transaction. Record count, serialized bytes, SQL statement size, and transaction size are capped and split before writing when output exceeds budget.
- Temp spill, result/output overflow, timeout, checksum spill, or writer-size overflow marks the chunk/request with diagnostics and either splits or parks it. The same oversized shape is not retried indefinitely.
- Failed or parked chunks leave the previous serving snapshot active and expose request/chunk diagnostics. Snapshot promotion depends on every required chunk completing within budget.

## Adversarial OOM Classes

| OOM Class                | Trigger                                                                                                                                             | Required Behavior                                                                                                                                                  | Static Or Unit Gate                                                                                                         | Runtime Evidence                                                                                                  | Phase 6 Proof                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Legacy rebuild SQL       | Old `project_scope_article`, `judgment_fact`, dictionary, rollup, filter-member, serving, or detail phases try to run.                              | Block normal execution, classify as legacy admin/debug or V4-rewire, and preserve last-known-good V4 snapshot.                                                     | Symbol and SQL guards fail on legacy phase runners and table writes outside allowlisted migrations/tests/admin-debug reads. | Event records blocked legacy path, caller, project, and requested action.                                         | Physical run proves no legacy phase rows are claimed and no legacy SQL executes.                |
| V4 chunk/projector       | Chunk estimate, selected-import winner work, dense judgments, payloads, postings, filter options, validation, or writer transaction exceeds budget. | Park, split, or quarantine before retry; no partial promotion.                                                                                                     | Chunk admission and projector tests cover over-budget, split, retry-after, and stale-owner cases.                           | Request/chunk diagnostics include estimates, actuals, temp/RSS, retry count, split depth, and over-budget reason. | Release run includes dense prompt, payload, selected-import, posting, and filter-option slices. |
| Checkpoint/WAL           | `CHECKPOINT`, shutdown checkpoint, or maintenance checkpoint runs during heavy writer/temp pressure.                                                | Use workload context, drain or block conflicting heavy work, record WAL/temp/RSS, and avoid checkpoint retry loops after OOM.                                      | Checkpoint tests simulate heavy background state and failed checkpoint without corrupting owner state.                      | Event records checkpoint context, WAL size, temp bytes, memory limit, owner state, and fallback decision.         | Phase 6 captures checkpoint during/after import and rebuild.                                    |
| Append/import            | Judgment append, import append, or delta intake builds large `VALUES`, parameter, JSON, or payload batches.                                         | Split by row count, parameter count, payload bytes, lane pressure, and project fanout before DuckDB execution.                                                     | Append/import admission tests reject or split over-budget batches.                                                          | Append metrics include lane depth, row/param/payload bytes, temp/RSS, and project fanout.                         | Release run includes append/import bursts with large payloads.                                  |
| Dirty-work and recovery  | Dirty refresh, stale-claim recovery, quarantine/unquarantine, or repair commands resume old workers.                                                | Enqueue V4 dirty work/chunk retries only; legacy recovery is read-only or blocked unless explicitly acknowledged as admin/debug.                                   | Recovery tests prove `--recover` does not shell into legacy workers or schedule V3 phases.                                  | Recovery event records converted/blocked stale work and V4 request IDs.                                           | Phase 6 proves recovery from failed/interrupted work without legacy rebuild.                    |
| Cross-project/no-context | One bad project or unclassified global query causes repeated OOM or monopolizes maintenance queues.                                                 | Require workload class plus project/component/chunk identity or explicit capped global-admin class; cool down only affected work and preserve fairness.            | Fairness tests prove one project cannot starve projector, append, or maintenance queues.                                    | OOM event records project identity or explicit global class, queue depth, cooldown, and breaker state.            | Release run includes cross-project dirty/rebuild bursts.                                        |
| Retry thrash             | Same failed shape is immediately retried after OOM/temp spill/timeout.                                                                              | Persist retry-after, max attempts, OOM category, split/quarantine state, and terminal operator-visible state.                                                      | Retry tests prove repeated OOM cannot hot-loop.                                                                             | Events show retry-after and terminal split/quarantine decision.                                                   | Phase 6 includes repeated failed chunk simulation.                                              |
| Offline repair           | Fatal DuckDB, WAL, checkpoint, or invalidated runtime requires offline remediation.                                                                 | Close owner, inspect/quarantine failed chunks/outbox/cursors, preserve last-known-good snapshots, produce bounded repair plan, and resume without legacy fallback. | Offline repair tests prove plan generation and blocked legacy actions.                                                      | Repair bundle records owner state, failed chunks, pinned snapshots, and resume decision.                          | Phase 6 includes failed/invalidated runtime recovery evidence.                                  |

## Guardrails

- Static tests fail if normal refresh/rebuild code contains `temp_project_judgment_fact_article`, `temp_dirty_judgment_fact_article`, `getProjectJudgmentFactBatchInsertSql`, legacy phase labels, or legacy runner symbols such as `runProjectMartLargeRebuildCycle`, `runProjectMartLargeRebuildCycles`, `startProjectMartLargeRebuildHeartbeat`, `getScopedArticleImportSelectionCteSql`, `requestProjectLargeRebuild*`, or `getDuckdbMartMaintenanceService().refresh*` as executable normal work.
- Static SQL-shape tests fail if normal maintenance SQL writes legacy V3 review marts, uses `CREATE TEMP TABLE ... AS SELECT ... FROM (VALUES ...)` or `UNION ALL` literal article batches for large article sets, or runs broad raw `DELETE`/`INSERT` facts outside V4 projector tests.
- Static and runtime guards for V4 rebuild/projector SQL flag unbounded `ORDER BY ... LIMIT`, `ROW_NUMBER`, `COUNT(DISTINCT)`, ordered `string_agg`, anti-joins, `CREATE TEMP`, large `VALUES` lists, and scans lacking the chunk predicate unless explicitly budgeted and allowlisted.
- Package-script tests fail unless every `db:duck:*large-rebuild*`, `*dirty-refresh*`, and `*judgment-fact-repair*` command is V4-rewired or renamed as explicit legacy admin/debug with an acknowledgement flag.
- Worker tests prove `projectMartRefreshWorker` enqueues V4 dirty work or rebuild chunks for oversized and normal refreshes; normal workers may not call `hasActiveProjectReviewServingGeneration`, `refreshDirtyProjectArticleBatch`, or request `project_scope_article` rebuilds after cutover.
- CLI tests prove repair and large-rebuild commands enqueue V4 work and do not schedule legacy `project_mart_large_rebuild_state` phases for normal projects.
- Warning, health, and admin route tests prove failed V4 snapshots surface `stale`, `indexing`, `unavailable`, or `failed` states without scanning legacy facts or kicking off legacy dirty/large rebuild repair.
- Admin route tests prove legacy run/pause/resume controls are removed, V4-rewired, or blocked; legacy status reads remain capped and admin/debug-only.
- Desktop and owner-handoff tests prove the same cutover applies under the desktop backend and low-memory profile, including stale-owner chunk output, snapshot promotion, and dirty-work completion.
- Runtime diagnostics include route/job key, workload class, project ID, snapshot ID, component, projection identity, chunk ID, input/output row counts, byte estimates, temp-spill state, retry count, retry-after, memory limit, DuckDB threads, temp directory bytes, WAL/checkpoint size, append lane depth, queue depth, fallback decision, and whether a path is V4, legacy-admin, or blocked.
- Any admin/debug-only legacy path must require explicit route classification, capped result size, bounded query shape, and test evidence that no normal product route or background freshness loop calls it.
- Any OOM fix implementation in this phase must add an `OOM_ERRORS.md` entry in the same change.

## Migration Sequence

1. Add a static inventory test that lists every remaining caller of legacy mart refresh and large rebuild functions.
2. Classify every caller as `retire`, `rewire-to-v4`, or `admin-debug-only`.
3. Rewire automatic oversized-refresh and missing-generation paths to create V4 work instead of old `project_mart_large_rebuild_state` work.
4. Rewire dirty refresh worker execution to V4 dirty work, projector wakeups, component acknowledgements, and manifest completion.
5. Remove, block, or V4-rewire admin large-rebuild run/pause/resume controls.
6. Freeze or migrate existing active/failed/idle legacy refresh and large-rebuild rows into V4 requests or `legacy_retired`/superseded state so old claims cannot resume.
7. Move progress and warning/health reads to V4 diagnostics while showing old large-rebuild rows only as legacy/admin diagnostic state.
8. Disable legacy large-rebuild scheduling for normal browser and desktop flows.
9. Delete or quarantine old phase execution code once V4 cutover tests and parity evidence pass.
10. Clean obsolete state with migrations or bounded maintenance scripts after no active writer references it.
11. Update Phase 6 physical evidence inputs so the release run starts with legacy normal rebuild disabled and V4 projector rebuild enabled.

## Browser And Desktop Rules

- Browser and desktop use the same V4 rebuild, dirty-work, diagnostics, and snapshot readiness paths.
- Desktop low-memory mode reduces chunk sizes and wake budgets before raising DuckDB memory or thread count.
- Desktop restart, sleep, or owner handoff resumes V4 chunks through leases and manifests, not an old seven-phase rebuild from `judgment_fact`.
- Repo-native Phase 5C tests simulate lease expiry/restart for V4 chunks, dirty work, bulk/export/PDF, search, and cleanup. They assert last-known-good remains readable and no legacy phase is scheduled. Phase 6 owns the physical OS sleep/process-kill proof.
- UI copy describes component/chunk/snapshot progress, not legacy phase progress, once normal flows are cut over.
- Normal review pages do not render legacy phase names such as `judgment_fact`, `prompt_answer_fact`, phase counters, or old large-rebuild labels except inside clearly marked admin/debug diagnostics.

## JavaScript And TypeScript Rule

Use `effect` for new non-trivial async and server orchestration in V4 rebuild requesting, chunk creation, repair/recovery command rewrites, and worker retry logic. Prefer `Effect.gen` for sequencing, `Layer`/`Context` for services, `Effect.acquireRelease`/`Scope` for leases and owned resources, and `Schedule` for retry/backoff. Keep pure transforms and small local handlers as plain functions.

## Quality Gates

- [ ] Legacy path audit lists all callers of `projectMartLargeRebuild*`, `getDuckdbMartMaintenanceService` refresh/rebuild methods, judgment fact repair, dirty refresh recovery, warning/progress APIs, startup heartbeats, package scripts, admin run controls, adjacent browser fallbacks, and admin investigate legacy mart reads.
- [ ] Each legacy caller is classified as `retire`, `rewire-to-v4`, or `admin-debug-only` with test evidence.
- [ ] Normal refresh completion is based on V4 component watermarks, manifests, and active or last-known-good snapshot state.
- [ ] No normal browser or desktop flow can execute the legacy `judgment_fact`, `project_scope_article`, `prompt_answer_fact`, `review_answer_dictionary`, `review_article_filter_member`, `review_article_rollup`, `review_article_serving`, or `review_article_serving_detail` phase chain.
- [ ] Static SQL-shape tests fail on `temp_project_judgment_fact_article`, broad legacy review-mart writes, unbounded inline `VALUES`/`UNION ALL` article batches, raw fact aggregation, selected-import CTE fallback, JSON sort/extraction, ordered checksum aggregation, and raw total counts in normal refresh/rebuild paths.
- [ ] Symbol guards fail on normal callers of legacy refresh/rebuild methods, legacy phase runners, scoped-import CTE helpers, startup heartbeats, package scripts, and old admin run controls unless explicitly allowlisted.
- [ ] V4 rebuild chunks are budgeted by rows, bytes, expected temp use, wake time, prompt/judgment density, payload size, posting/filter fanout, summary/filter option cardinality, snapshot count, timeout, and retry policy.
- [ ] Append/import batches and checkpoint operations have explicit OOM admission, telemetry, and no retry-loop behavior.
- [ ] Chunk manifests can skip completed unchanged chunks after crash, restart, sleep, and repeated operator commands.
- [ ] V4 rebuild failures preserve the last-known-good snapshot and surface failed/stale/indexing/unavailable diagnostics without raw fallback.
- [ ] Existing active/failed/idle legacy refresh and large-rebuild rows are migrated, frozen, or marked retired so no normal claim path can resume them.
- [ ] Warning and health route tests prove failed, missing, stale, and candidate V4 snapshots are reported without legacy fact scans, dirty repair, or large-rebuild scheduling side effects.
- [ ] Warning/progress UI and APIs report V4 snapshot/chunk/projector diagnostics for browser and desktop, and normal review UI does not render legacy phase names or old phase counters.
- [ ] Admin/debug-only legacy inspection routes are route-classified, capped, guarded, read-only unless V4-rewired, and excluded from normal product flows.
- [ ] Browser network smoke runs real/current DB first with `bun run test:network-smoke`, then synthetic temporary DB second with `bun run test:network-smoke:synthetic`.
- [ ] Current-DB network smoke remains no-seed, probes `POST /api/projectsreviewswarnings` for discovered project IDs, and fails on any failed warning state or any page, API response, console error, or server output containing `Large rebuild failed`.
- [ ] Any current-DB skipped route is classified as missing-data, admin/debug-only, or unsafe pending Phase 5C rewiring; no normal browser route is skipped only because it queues legacy V3 repair, dirty refresh, or large-rebuild work on load.
- [ ] V4 owner-handoff tests prove stale owners cannot complete chunk output, snapshot promotion, or dirty-work acknowledgement after lease transfer.
- [ ] Cross-project OOM/fairness tests prove one failing project cannot monopolize projector, append, checkpoint, or maintenance queues.
- [ ] Offline repair tests prove fatal DuckDB/WAL/checkpoint states produce a bounded repair plan, preserve last-known-good snapshots, and do not trigger legacy rebuild fallback.
- [ ] Durable OOM/workload telemetry is emitted for legacy blocks, V4 chunks, checkpoint, append/import, retry-thrash, cross-project, and offline-repair cases.
- [ ] Obsolete legacy state is deleted, quarantined, or explicitly retained as admin/debug compatibility after no normal caller remains.
- [ ] `bun test src/server/services/projectMartLargeRebuildRunner.test.ts`
- [ ] `bun test src/server/services/projectMartLargeRebuildExecutor.test.ts`
- [ ] `bun test src/server/workers/projectMartRefreshWorker.test.ts`
- [ ] `bun test src/server/reviewServing`
- [ ] `bun test scripts/requestReviewServingAllProjectsRebuild.test.ts scripts/requestProjectLargeRebuild.test.ts scripts/requestJudgmentFactRepair.test.ts`
- [ ] `bun run lint`
- [ ] If schema or obsolete-state cleanup is added, `bun run db:mig`
- [ ] If shared browser/desktop runtime behavior changes, `bun run desktop:build`
- [ ] Add an `OOM_ERRORS.md` entry in the same change as any OOM fix implementation.
