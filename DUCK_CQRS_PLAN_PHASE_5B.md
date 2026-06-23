# DuckDB CQRS Plan Phase 5B - Legacy Rebuild And Maintenance Cutover

Master coordinator: [DUCK_OOM_FIX_PLAN.md](./DUCK_OOM_FIX_PLAN.md)

## Objective

Close the gap exposed by the 2026-06-23 `judgment_fact` large rebuild OOM: legacy
mart refresh and large-rebuild maintenance paths still run old global mart SQL even
though normal review reads have moved toward V4 serving contracts.

Phase 5B converts those remaining maintenance paths into schedulers, backfill
drivers, or admin/debug-only utilities behind the V4 review-serving projector
stack. After this phase, no normal refresh, repair, rebuild, recovery, warning, or
operator command may rebuild review-serving state by writing legacy
`mart.judgment_fact`, `mart.prompt_answer_fact`, `mart.review_article_rollup`,
`mart.review_article_filter_member`, `mart.review_article_serving`, or
`mart.review_article_serving_detail` as the production review-serving path.

## Why This Phase Exists

The large-rebuild OOM occurred in the staged background `judgment_fact` phase, not
in a foreground mounted review route. The failing statement created
`temp_project_judgment_fact_article` from a large inline `VALUES (...)` article
list, then continued through a transaction that deletes and reinserts global
`mart.judgment_fact` rows from raw `app.judgment`.

That path is chunked by article count, but it is still not aligned with the CQRS
plan because it can scan, hash, delete, and reinsert project-scale judgment/fact
state under the shared DuckDB memory cap. It also preserves a parallel writer
chain outside the V4 component projector and manifest promotion rules.

The same risk applies to any path that says it is a refresh, rebuild, repair,
recovery, warning, health, or admin operation but still performs broad raw mart
maintenance for normal review-serving state.

## Cut Line

Phase 5B is complete only when legacy V3 mart refresh/rebuild code can no longer
drive normal review-serving freshness or rebuild completion for browser or desktop
flows.

Allowed after the cut line:

- V4 projectors write `mart.review_*_v4` and promote snapshots through V4
  manifests.
- Legacy V3 tables remain only as explicitly named admin/debug/compatibility data
  until deletion is safe.
- Operator commands may enqueue V4 dirty work, V4 rebuild chunks, or V4 repair
  jobs.
- Admin/debug SQL may inspect legacy tables if it is route-classified, guarded,
  capped, and excluded from normal product freshness decisions.

Not allowed after the cut line:

- Normal large rebuild phases named `judgment_fact`, `prompt_answer_fact`,
  `review_answer_dictionary`, `review_article_filter_member`,
  `review_article_rollup`, or `review_article_serving` as production serving
  rebuild work.
- Normal refresh or repair commands that treat `mart.judgment_fact` repair as the
  route to current review-serving state.
- Background maintenance that uses article-count chunks while still running
  global raw fact/mart deletes, inserts, windows, raw counts, selected-import CTEs,
  JSON extraction, or unbounded `IN`/`VALUES` materialization.
- Any hidden fallback where a failed V4 snapshot, missing snapshot, or stale V4
  projection triggers legacy raw/mart rebuild for normal browser or desktop review
  flow.

## Current Legacy Risk Inventory

| Area | Current Files | Required Direction |
|---|---|---|
| Large rebuild executor | `src/server/services/projectMartLargeRebuildExecutor.ts` | Stop writing production review-serving state through legacy mart phases. Convert to V4 rebuild chunk creation, V4 projector wakeups, and V4 manifest diagnostics. |
| Large rebuild runner/cycles/state | `projectMartLargeRebuildRunner.ts`, `projectMartLargeRebuildCyclesService.ts`, `projectMartLargeRebuildStateService.ts` | Replace phase machine with V4 rebuild-job/chunk orchestration or retire it for normal flows. Preserve operator progress through V4 manifests and chunk state. |
| Dirty refresh worker | `src/server/workers/projectMartRefreshWorker.ts` | Queue V4 dirty work or V4 rebuild chunks. Do not call legacy mart refresh as the path to review-serving freshness. |
| Mart maintenance service | `src/server/services/getDuckdbMartMaintenanceService.ts` | Retire direct production writes to legacy review marts. Keep only bounded admin/debug helpers or wrappers that enqueue V4 work. |
| Repair commands | `scripts/requestJudgmentFactRepair.ts`, `scripts/requestProjectLargeRebuild.ts`, `scripts/requestReviewServingLargeRebuild.ts` | Rename or rewire commands so repairs request V4 projector rebuilds, component repairs, or snapshot rebuild chunks. Do not request legacy `judgment_fact` repair for normal serving. |
| Recovery commands | `scripts/recoverDirtyRefreshClaims.ts`, `scripts/inspectDirtyRefreshRisk.ts`, `scripts/quarantineDirtyRefreshArticle.ts`, `scripts/unquarantineDirtyRefreshArticle.ts` | Report V4 dirty work, rebuild chunks, snapshot state, and projector failures. Legacy state may be shown only as retired/admin diagnostics. |
| Warnings and progress UI | `reviewsProjectWarnings.tsx`, `reviewsIndexingProgress.tsx`, warning routes | Show V4 readiness, stale/indexing/unavailable/failed state, component progress, chunk failures, and last-known-good snapshots. Do not make legacy phase state drive normal readiness. |
| Admin investigate routes | `AdminInvestigateRoutes.ts` and tests | Classify any legacy mart inspection as admin/debug-only and cap output. Normal remediation should enqueue V4 work. |
| Old V3 marts | `mart.judgment_fact`, `mart.prompt_answer_fact`, `mart.review_article_rollup`, `mart.review_article_filter_member`, `mart.review_article_serving`, `mart.review_article_serving_detail` | Delete, archive, or mark as legacy after all callers are cut over. If retained, tests must prove they cannot drive normal review freshness or mounted product routes. |

## Workstreams

| Status | Theme | Implement First | Done When |
|---|---|---|---|
| [ ] | Legacy path audit and classification | Inventory every caller that writes or depends on legacy review marts, including scripts, workers, routes, warnings, tests, and admin tools. | Each caller is classified as `retire`, `rewire-to-v4`, or `admin-debug-only`, with a test or static guard proving the classification. |
| [ ] | V4 rebuild request API | Add a durable V4 rebuild request path that creates projection manifests, chunk manifests, and projector wakeups by project/component/review config. | Operator and automatic refresh requests can ask for component-scoped V4 rebuilds without touching legacy mart phases. |
| [ ] | Legacy large rebuild cutover | Replace `projectMartLargeRebuild*` normal execution with V4 rebuild chunk orchestration or retire it from normal scheduling. | No normal code path can run `temp_project_judgment_fact_article`, `getProjectJudgmentFactBatchInsertSql`, or the seven legacy phases as production serving rebuild work. |
| [ ] | Dirty refresh cutover | Route dirty article/project refresh through delta intake, dirty-work coalescing, component acknowledgements, and V4 projector wakeups. | Dirty project refresh completion is based on V4 watermarks/manifests, not legacy mart refresh completion. |
| [ ] | Repair and recovery command cutover | Rewire CLI scripts and admin repair controls to enqueue V4 component rebuilds or projector retries. | Commands previously named around project large rebuild or judgment fact repair either become V4 commands or are marked obsolete with tests preventing normal use. |
| [ ] | Progress and warning cutover | Make UI and warning APIs read V4 snapshot, chunk, dirty-work, and projector diagnostics. | Browser and desktop show failed/stale/indexing/unavailable V4 states and never imply a legacy rebuild is the normal freshness source. |
| [ ] | Legacy state cleanup | After caller cutover, delete or freeze obsolete legacy state and phase rows. | No active refresh state is stranded, no last-known-good V4 snapshot is lost, and cleanup is pin-aware. |
| [ ] | Static and runtime guards | Add tests that fail on legacy SQL shape, broad raw maintenance in normal paths, and unclassified DuckDB work. | CI catches reintroduction of legacy mart writers, unbounded temp tables, inline article `VALUES` batches, raw fact aggregation, and raw fallback in normal flows. |
| [ ] | Release evidence handoff | Update Phase 6 evidence scope to include legacy-path retirement proof. | Physical release evidence runs with legacy rebuild disabled for normal flows and V4 projector/chunk paths enabled. |

## Required Long-Term Fixes

| # | Fix | What It Does Now | What It Should Do | Why It Helps |
|---|---|---|---|---|
| 1 | Stop scheduling legacy review-serving large rebuilds | `requestReviewServingLargeRebuild` requests old project mart large rebuild phases. | Request V4 rebuild jobs/chunks for the required components and snapshots. | Removes the unsafe `judgment_fact` path from normal rebuilds. |
| 2 | Replace `judgment_fact` refresh with component projection | The old phase deletes and reinserts global judgment facts by article batch. | V4 `judgmentInputContent`, `llmStatus`, `payload`, `summary`, `posting`, and `queue` components recompute only affected scoped outputs. | Prevents global fact scans and parallel truth models. |
| 3 | Budget rebuild chunks by rows, bytes, and temp risk | Legacy chunks are sized mostly by article count. | Chunk manifests record estimated input rows, output rows, payload bytes, and temp budget; oversized chunks split before execution. | An article batch with many judgments cannot exceed the memory envelope. |
| 4 | Use projector workload admission for rebuild work | Legacy background SQL uses background DuckDB access but not V4 projector contracts. | V4 rebuild chunks run under `reviewProjector` workload context with temp-spill policy, queue pressure, and wake budgets. | Makes background rebuilds obey the same safety model as serving projectors. |
| 5 | Remove global delete/reinsert semantics | Legacy phases rewrite broad mart state per batch or per project. | Projector writes are idempotent, component-scoped, base/patch keyed, and manifest-promoted. | Avoids large hash/delete memory spikes and makes retries safe. |
| 6 | Make refresh completion manifest-based | Legacy refresh completion can depend on old phase state and dirty ACKs. | Completion depends on required V4 component watermarks, successful chunk manifests, and active or last-known-good snapshot state. | Failed rebuilds preserve stale serving data instead of forcing raw repair. |
| 7 | Preserve benchmark-critical judgment settings | Legacy repair can rebuild facts without explicit route/component identity. | V4 work carries `modelId`, content flags, prompt identities, `reviewConfigHash`, `snapshotId`, and component identity in manifests, cursors, jobs, and logs. | Prevents silent profile drift and wrong judgment reuse. |
| 8 | Coalesce dirty work by component | Legacy dirty refresh can reprocess whole article chains because another phase lags. | Dirty acknowledgements are component high-water rows or compact ranges. | A slow optional component does not make current required components rerun. |
| 9 | Keep selected-import work scoped to import/scope deltas | Legacy serving rebuild can rerun selected-import logic as part of broad phases. | Selected-import projection runs only from import/scope dirty work and provides selected IDs/rank fields to dependent components. | Judgment-only updates do not redo import ranking. |
| 10 | Delete or freeze V3 marts after cutover | Old tables remain available and easy to call accidentally. | Drop them, move them to explicit legacy/admin compatibility, or block normal callers by static tests. | Prevents hidden fallback and parallel writer drift. |

## V4 Rebuild Request Contract

A normal large rebuild, repair, or refresh request should create durable V4 work
with these fields:

- `project_id` and optional project subset or filter signature.
- `requested_components`, using only known projection component names.
- Required identity inputs: `snapshot_id`, `review_config_hash`, component
  `projection_identity`, `base_generation`, and `patch_watermark` where relevant.
- Source watermarks for import deltas, review-change deltas, project-scope state,
  prompt/config changes, and selected-import snapshots.
- Chunk key range, chunk row/byte estimate, output base generation, input digest,
  expected output count or checksum when available, status, owner, lease, retry
  count, and last error.
- Workload class and budgets: maximum input rows, output rows, payload bytes,
  temp spill policy, wake duration, retry schedule, and queue priority.
- Completion rule: required component chunks complete, manifests validate, snapshot
  promotion succeeds, and dirty work is acknowledged per component.

The request contract must not store raw all-article ID arrays or make a single
`VALUES (...)` list the durable representation of a rebuild batch.

## Guardrails For This Path And Paths Like It

- Static tests fail if normal refresh/rebuild code contains
  `temp_project_judgment_fact_article`, `temp_dirty_judgment_fact_article`,
  `getProjectJudgmentFactBatchInsertSql`, or old phase labels as executable normal
  work.
- Static SQL-shape tests fail if normal maintenance SQL writes legacy V3 review
  marts, uses `CREATE TEMP TABLE ... AS SELECT ... FROM (VALUES ...)` for large
  article sets, or runs broad raw `DELETE`/`INSERT` facts outside V4 projector
  tests.
- Worker tests prove `projectMartRefreshWorker` enqueues V4 dirty work or rebuild
  chunks for oversized and normal refreshes.
- CLI tests prove repair and large-rebuild commands enqueue V4 work and do not
  schedule legacy `project_mart_large_rebuild_state` phases for normal projects.
- Warning route tests prove failed V4 snapshots surface `stale`, `indexing`,
  `unavailable`, or `failed` states without kicking off legacy raw fallback.
- Desktop tests prove the same cutover applies under the desktop backend and low
  memory profile.
- Runtime diagnostics include route/job key, workload class, project ID, snapshot
  ID, component, projection identity, chunk ID, input/output row counts, byte
  estimates, temp-spill state, and whether a path is V4, legacy-admin, or blocked.
- Any admin/debug-only legacy path must require an explicit route classification,
  capped result size, bounded query shape, and test evidence that no normal product
  route or background freshness loop calls it.
- Any OOM fix implementation in this phase must add an `OOM_ERRORS.md` entry in
  the same change.

## Migration Sequence

1. Add static inventory tests that list every caller of legacy mart refresh and
   large rebuild functions.
2. Add V4 rebuild request and chunk creation APIs without deleting old code.
3. Rewire `requestReviewServingLargeRebuild` to create V4 rebuild requests for one
   selected project behind a feature guard or test-only path.
4. Rewire the automatic oversized-refresh path to create V4 work instead of old
   `project_mart_large_rebuild_state` work.
5. Rewire judgment fact repair and dirty refresh recovery commands to V4 component
   repair or projector retry commands.
6. Move progress and warning reads to V4 diagnostics while showing old large
   rebuild rows only as legacy/admin diagnostic state.
7. Disable legacy large rebuild scheduling for normal browser and desktop flows.
8. Delete or quarantine old phase execution code once V4 cutover tests and parity
   evidence pass.
9. Clean obsolete state with migrations or bounded maintenance scripts after no
   active writer references it.
10. Run Phase 6 physical evidence with legacy normal rebuild disabled and V4
    projector rebuild enabled.

## Browser And Desktop Rules

- Browser and desktop use the same V4 rebuild, dirty-work, diagnostics, and
  snapshot readiness paths.
- Desktop low-memory mode must reduce chunk sizes and wake budgets before raising
  DuckDB memory or thread count.
- Desktop restart, sleep, or owner handoff must resume V4 chunks through leases and
  manifests, not restart an old seven-phase rebuild from `judgment_fact`.
- UI copy should describe component/chunk/snapshot progress, not legacy phase
  progress, once normal flows are cut over.

## JavaScript And TypeScript Rule

Use `effect` for new non-trivial async and server orchestration in V4 rebuild
requesting, chunk creation, repair/recovery command rewrites, and worker retry
logic. Prefer `Effect.gen` for sequencing, `Layer`/`Context` for services,
`Effect.acquireRelease`/`Scope` for leases and owned resources, and `Schedule` for
retry/backoff. Keep pure transforms and small local handlers as plain functions.

## Quality Gates

- [ ] Legacy path audit lists all callers of `projectMartLargeRebuild*`,
  `getDuckdbMartMaintenanceService` refresh/rebuild methods, judgment fact repair,
  dirty refresh recovery, warning/progress APIs, and admin investigate legacy mart
  reads.
- [ ] Each legacy caller is classified as `retire`, `rewire-to-v4`, or
  `admin-debug-only` with test evidence.
- [ ] Normal rebuild and repair requests create V4 component rebuild requests,
  dirty work, or chunk manifests rather than legacy phase rows.
- [ ] Normal refresh completion is based on V4 component watermarks, manifests,
  and active or last-known-good snapshot state.
- [ ] No normal browser or desktop flow can execute the legacy `judgment_fact`,
  `prompt_answer_fact`, `review_answer_dictionary`,
  `review_article_filter_member`, `review_article_rollup`, or
  `review_article_serving` phase chain.
- [ ] Static SQL-shape tests fail on `temp_project_judgment_fact_article`, broad
  legacy review-mart writes, unbounded inline `VALUES` article batches, raw fact
  aggregation, selected-import CTE fallback, JSON sort/extraction, and raw total
  counts in normal refresh/rebuild paths.
- [ ] V4 rebuild chunks are budgeted by rows, bytes, expected temp use, wake time,
  and retry policy.
- [ ] Chunk manifests can skip completed unchanged chunks after crash, restart,
  sleep, and repeated operator commands.
- [ ] V4 rebuild failures preserve the last known-good snapshot and surface
  failed/stale/indexing/unavailable diagnostics without raw fallback.
- [ ] Repair and recovery CLI tests prove V4 work is queued and legacy normal
  rebuilds are not scheduled.
- [ ] Warning/progress UI and APIs report V4 snapshot/chunk/projector diagnostics
  for browser and desktop.
- [ ] Admin/debug-only legacy inspection routes are route-classified, capped,
  guarded, and excluded from normal product flows.
- [ ] Obsolete legacy state is deleted, quarantined, or explicitly retained as
  admin/debug compatibility after no normal caller remains.
- [ ] `bun test src/server/services/projectMartLargeRebuildRunner.test.ts`
- [ ] `bun test src/server/services/projectMartLargeRebuildExecutor.test.ts`
- [ ] `bun test src/server/workers/projectMartRefreshWorker.test.ts`
- [ ] `bun test src/server/reviewServing`
- [ ] `bun test scripts/requestReviewServingLargeRebuild.test.ts scripts/requestProjectLargeRebuild.test.ts scripts/requestJudgmentFactRepair.test.ts`
- [ ] `bun run lint`
- [ ] If schema or obsolete-state cleanup is added, `bun run db:mig`
- [ ] If shared browser/desktop runtime behavior changes, `bun run desktop:build`
- [ ] Add an `OOM_ERRORS.md` entry in the same change as any OOM fix
  implementation.
