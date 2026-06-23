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
`mart.project_scope_article`, `mart.judgment_fact`, `mart.prompt_answer_fact`,
`app.review_answer_dictionary`, `mart.review_article_rollup`,
`mart.review_article_filter_member`, `mart.review_article_serving`,
`mart.review_article_serving_detail`, or legacy serving generation state as the
production review-serving path.

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
maintenance for normal review-serving state. Phase 5B must also close adjacent OOM
classes that can arrive through the same maintenance surface: checkpoint OOM,
append/import payload OOM, V4 chunk retry thrash, cross-project OOM bursts,
operator recovery scripts, and warning/admin side effects that secretly schedule
legacy work.

## Five-Pass Codex Review Integration - 2026-06-23

Five independent Codex review passes were folded into this revision:

- Legacy inventory: expanded the retired normal-write set to include
  `mart.project_scope_article`, `app.review_answer_dictionary`, startup
  heartbeats, dirty-state producers, adjacent browser fallbacks, and admin run
  controls.
- V4 rebuild budgets: added a durable rebuild-request layer, request admission,
  component-specific chunk budgets, selected-import constraints, bounded
  validation, writer-side caps, and non-thrashing over-budget behavior.
- Operator and recovery paths: made package scripts, recovery commands, dirty
  refresh completion, existing legacy state, warning side effects, and admin
  remediation explicit cutover gates.
- Browser/desktop resilience: added repo-native lease/restart/owner-handoff gates
  before the physical desktop proof in Phase 6, and blocked normal UI from
  presenting legacy phase progress after cutover.
- Adversarial OOM coverage: added checkpoint, append/import, V4 chunk,
  retry-thrash, cross-project, offline-repair, durable telemetry, and Phase 6
  proof requirements so the phase handles more than the observed
  `judgment_fact` OOM.

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

- Normal large rebuild phases named `project_scope_article`, `judgment_fact`,
  `prompt_answer_fact`, `review_answer_dictionary`,
  `review_article_filter_member`, `review_article_rollup`, or
  `review_article_serving` as production serving rebuild work.
- Normal refresh or repair commands that treat `mart.judgment_fact` repair as the
  route to current review-serving state.
- Background maintenance that uses article-count chunks while still running
  global raw fact/mart deletes, inserts, windows, raw counts, selected-import CTEs,
  JSON extraction, unbounded `IN`/`VALUES`/`UNION ALL` materialization, or
  full-output ordered checksum aggregation.
- Any hidden fallback where a failed V4 snapshot, missing snapshot, or stale V4
  projection triggers legacy raw/mart rebuild for normal browser or desktop review
  flow.
- Startup, heartbeat, package-script, warning, health, recovery, or admin run
  controls that schedule old `project_mart_large_rebuild_state` or
  `project_mart_refresh_state` work for normal product freshness.

## Current Legacy Risk Inventory

| Area | Current Files | Required Direction |
|---|---|---|
| Large rebuild executor | `src/server/services/projectMartLargeRebuildExecutor.ts` | Stop writing production review-serving state through legacy mart phases. Convert to V4 rebuild chunk creation, V4 projector wakeups, and V4 manifest diagnostics. |
| Large rebuild runner/cycles/state | `projectMartLargeRebuildRunner.ts`, `projectMartLargeRebuildCyclesService.ts`, `projectMartLargeRebuildStateService.ts` | Replace phase machine with V4 rebuild-job/chunk orchestration or retire it for normal flows. Preserve operator progress through V4 manifests and chunk state. |
| Startup and heartbeats | `startBackgroundWork.ts`, `projectMartLargeRebuildHeartbeat.ts`, `projectMartRefreshWorkerHeartbeat.ts`, large-rebuild tuning and metrics helpers | Normal browser/desktop startup must start V4 projector, dirty-work, and diagnostics loops only. Legacy heartbeat/cycle runners may remain only as explicitly blocked or admin-debug tools. |
| Dirty refresh worker | `src/server/workers/projectMartRefreshWorker.ts` | Queue V4 dirty work or V4 rebuild chunks. Do not call legacy mart refresh as the path to review-serving freshness. |
| Dirty-state producers | Callers of `markProjectsDirtyAtomically`, `markArticleProjectsDirtyAtomically`, `requestLargeRebuild`, and `requestProjectLargeRebuild*` | Classify every producer as V4 dirty producer, admin/debug-only, or obsolete. Normal routes and services must not enqueue old refresh or large-rebuild rows. |
| Mart maintenance service | `src/server/services/getDuckdbMartMaintenanceService.ts` | Retire direct production writes to legacy review marts. Keep only bounded admin/debug helpers or wrappers that enqueue V4 work. |
| Repair commands | `scripts/requestJudgmentFactRepair.ts`, `scripts/requestProjectLargeRebuild.ts`, `scripts/requestReviewServingLargeRebuild.ts` | Rename or rewire commands so repairs request V4 projector rebuilds, component repairs, or snapshot rebuild chunks. Do not request legacy `judgment_fact` repair for normal serving. |
| Operator package scripts | `package.json`, `scripts/runLargeRebuildWorkerOnce.ts`, `scripts/runLargeRebuildWorkerCycles.ts`, `scripts/runProjectMartRefreshWorkerOnce*.ts` | Rewire to V4 or rename to explicit `legacy-admin-*` commands behind an acknowledgement flag. Normal package commands must not start legacy rebuild/repair workers. |
| Recovery commands | `scripts/recoverDirtyRefreshClaims.ts`, `scripts/inspectDirtyRefreshRisk.ts`, `scripts/quarantineDirtyRefreshArticle.ts`, `scripts/unquarantineDirtyRefreshArticle.ts` | Report V4 dirty work, rebuild chunks, snapshot state, and projector failures. Recovery with `--recover` may enqueue V4 retries only; legacy state may be shown only as retired/admin diagnostics. |
| Warning, health, and progress routes | `projectsRoutesGetReviewsWarnings.ts`, health routes, `reviewsProjectWarnings.tsx`, `reviewsIndexingProgress.tsx` | Show V4 readiness, stale/indexing/unavailable/failed state, component progress, chunk failures, and last-known-good snapshots. GET/POST warning paths must not scan legacy facts or schedule dirty/large rebuild repair as a side effect. |
| Adjacent browser fallbacks | Prompt preview, human-assessment init, and other routes that can read `mart.project_scope_article` or old fact tables when V4 misses | Replace with V4 diagnostics/unavailable state or explicit bounded admin/debug reads. Normal browser routes may not use legacy scope/fact/V3 tables as fallback. |
| Admin investigate routes and run controls | `AdminInvestigateRoutes.ts` and tests, project-mart large-rebuild admin pages | Legacy status can remain read-only, capped, and labeled admin/debug. Run/pause/resume/remediate actions must be removed, blocked, or V4-rewired. |
| Old V3 marts | `mart.project_scope_article`, `mart.judgment_fact`, `mart.prompt_answer_fact`, `app.review_answer_dictionary`, `mart.review_article_rollup`, `mart.review_article_filter_member`, `mart.review_article_serving`, `mart.review_article_serving_detail`, legacy serving generation state | Delete, archive, or mark as legacy after all callers are cut over. If retained, tests must prove they cannot drive normal review freshness or mounted product routes. |

## Workstreams

| Status | Theme | Implement First | Done When |
|---|---|---|---|
| [ ] | Legacy path audit and classification | Inventory every caller that writes or depends on legacy review marts, including scripts, workers, routes, warnings, tests, and admin tools. | Each caller is classified as `retire`, `rewire-to-v4`, or `admin-debug-only`, with a test or static guard proving the classification. |
| [~] | V4 rebuild request API | Add a durable V4 rebuild request path above chunk manifests that creates projection manifests, chunk manifests, and projector wakeups by project/component/review config. | Parts 1-2 added `app.review_rebuild_request`, request admission, request-owned chunk fields, retry/over-budget metadata, claim gating, a shared V4 rebuild request service, and operator request script rewrites. Remaining: automatic refresh entrypoints and projector wakeups. |
| [ ] | Legacy large rebuild cutover | Replace `projectMartLargeRebuild*` normal execution with V4 rebuild chunk orchestration or retire it from normal scheduling. | No normal code path can run `temp_project_judgment_fact_article`, `getProjectJudgmentFactBatchInsertSql`, or the seven legacy phases as production serving rebuild work. |
| [~] | Dirty refresh cutover | Route dirty article/project refresh through delta intake, dirty-work coalescing, component acknowledgements, and V4 projector wakeups. | Parts 3 and 5 removed the dirty refresh worker from normal startup and require explicit legacy-admin acknowledgement for direct dirty-refresh worker scripts. Remaining: full producer-level V4 dirty intake and legacy-state retirement. |
| [~] | Repair and recovery command cutover | Rewire CLI scripts and admin repair controls to enqueue V4 component rebuilds or projector retries. | Parts 2 and 4 rewired rebuild/repair request scripts and `recoverDirtyRefreshClaims --recover` to enqueue V4 rebuild requests, while leaving stale legacy state read-only in recovery. Remaining: quarantine commands and admin controls. |
| [x] | Startup, heartbeat, and package-script cutover | Remove legacy rebuild heartbeats and normal package commands from browser/desktop maintenance startup. | Part 3 removed legacy refresh/large-rebuild heartbeat startup, starts the V4 projector heartbeat from maintenance startup, renamed normal large-rebuild worker package scripts to `legacy-admin-*`, and requires `--legacy-admin-ack=legacy-large-rebuild` for direct legacy worker execution. |
| [ ] | Progress and warning cutover | Make UI and warning APIs read V4 snapshot, chunk, dirty-work, and projector diagnostics. | Browser and desktop show failed/stale/indexing/unavailable V4 states and never imply a legacy rebuild is the normal freshness source. |
| [~] | Warning, health, and admin side-effect removal | Make warning/health/admin status reads report state only and move remediation into explicit V4 actions. | Part 4 made review-warning reads stop scanning `mart.judgment_fact`, stop marking dirty repair state, and stop bootstrapping large rebuilds. Remaining: health/admin status paths and explicit V4 operator actions. |
| [ ] | Adversarial OOM taxonomy and recovery | Add pass/fail behavior for checkpoint, append/import, V4 chunk/projector, dirty-work intake, cross-project, retry-thrash, and offline-repair OOMs. | Each OOM class has admission, cooldown/split/quarantine, telemetry, and Phase 6 proof requirements. |
| [ ] | Legacy state cleanup | After caller cutover, delete or freeze obsolete legacy state and phase rows. | No active refresh state is stranded, no last-known-good V4 snapshot is lost, and cleanup is pin-aware. |
| [~] | Static and runtime guards | Add tests that fail on legacy SQL shape, broad raw maintenance in normal paths, and unclassified DuckDB work. | Part 5 added focused Phase 5B static guards for startup, warning side effects, recovery, package commands, and legacy-admin acknowledgements. Remaining: broader SQL-shape and producer inventory guards. |
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
| 11 | Admit rebuild requests before chunks are claimable | Rebuild scope and density can be discovered only after DuckDB begins heavy work. | Estimate scope rows, prompt count, judgment density, selected-import multiplicity, payload bytes, posting fanout, summary/facet cardinality, snapshot count, and output bytes before claim. | Oversized work parks as `blocked_over_budget` before spilling or allocating. |
| 12 | Split chunks by fanout, not article count alone | A small article range can still contain dense judgments, payloads, postings, or filter options. | Budget display/payload, LLM, human, posting, queue, summary, filter-option, and selected-import components with their own row/byte/temp shapes. | Prevents article-count chunks from hiding high-memory component work. |
| 13 | Make over-budget retries non-thrashing | Failed chunks can be retried in the same unsafe shape. | Persist retry count, retry-after, OOM category, split depth, parent chunk, and terminal quarantine/park state. | Repeated OOM cools, splits, or parks work instead of hot-looping. |
| 14 | Budget append/import and checkpoint paths | Append lanes and checkpoints can still hit DuckDB memory or WAL/temp pressure. | Split by row count, parameter count, payload bytes, lane pressure, WAL/temp/RSS state, and checkpoint context. | Covers OOMs outside review-list and rebuild SQL. |
| 15 | Make warning/admin reads side-effect free | Warning/admin status reads can detect legacy drift and schedule repair. | Status reads report V4 diagnostics only; remediation requires explicit V4 operator action. | Avoids a read path triggering OOM-prone rebuild work. |

## V4 Rebuild Request Contract

A normal large rebuild, repair, or refresh request should create durable V4 work
through a `review_rebuild_request` API/table above chunk manifests. The request
owns request ID, project, reason, requested components, source watermarks,
review/config identities, candidate/base generation, priority, lease, status,
retry policy, admission result, and diagnostics.

Request admission happens before chunks become claimable. Admission estimates
scope rows, prompt count, judgment density, selected-import route multiplicity,
payload/full-text bytes, posting/filter fanout, summary/facet/option cardinality,
snapshot count, expected output rows, expected output bytes, and temp risk. Missing
or excessive estimates park the request as `blocked_over_budget` with diagnostics;
they do not run the projector to discover the OOM by spilling or allocating.

A normal request and its chunks carry these fields:

- Request ID, `project_id`, reason, priority, owner/lease, request status, retry
  count, retry-after, OOM category, and last error.
- Optional project subset or filter signature.
- `requested_components`, using only known projection component names.
- Required identity inputs: `snapshot_id`, `review_config_hash`, component
  `projection_identity`, `base_generation`, and `patch_watermark` where relevant.
- Source watermarks for import deltas, review-change deltas, project-scope state,
  prompt/config changes, and selected-import snapshots.
- Chunk key range, parent chunk ID, split depth, single `snapshot_id` or explicit
  `snapshot_count`, output base generation, input digest, expected output count or
  bounded checksum when available, status, owner, lease, retry count,
  retry-after, OOM category, and last error.
- Estimated, maximum, and observed input rows, output rows, output bytes, payload
  bytes, prompt count, temp bytes, duration, and over-budget reason.
- Workload class and budgets: maximum input rows, output rows, result bytes,
  payload bytes, statement/transaction bytes, temp spill policy, timeout, wake
  duration, retry schedule, and queue priority.
- Completion rule: required component chunks complete, manifests validate, snapshot
  promotion succeeds, and dirty work is acknowledged per component.

The request contract must not store raw all-article ID arrays or make a single
`VALUES (...)` list the durable representation of a rebuild batch.

## Chunk Admission And OOM Recovery

- Chunk admission must check the current DuckDB memory limit, active projector
  count, import pressure, append queue pressure, temp-directory free space,
  configured concurrency, and request/chunk budgets before claim.
- Rebuild workload contexts include project ID, request ID, chunk ID, component,
  snapshot/base generation, max result rows, max result bytes, max temp bytes, and
  timeout. `allowsTempSpill: false` is a backstop, not the only budget.
- Chunks are single-snapshot by default. Multi-snapshot chunks must include an
  explicit `snapshot_count` multiplier and still fit row/byte/temp budgets.
- Component fanout drives chunk boundaries: display/payload uses article count plus
  payload/full-text bytes; LLM work uses article by prompt by judgment density;
  human work distinguishes prompt-mode and summary-mode rows; posting/queue work
  budgets filter memberships and posting rows; summary and filter-option work are
  separate components keyed by summary key, facet/filter kind, value bucket, or
  prompt bucket.
- Selected-import rebuilds must avoid project-wide candidate selection,
  anti-join winner selection, and global `ORDER BY LIMIT` per batch. They use
  bounded article/import-route/rank-key ranges or precomputed winner state.
- Full-output validation cannot use unbounded ordered `string_agg` or equivalent
  project-wide checksums. Digests are computed during writes or per chunk shard
  under the same predicates and budgets as the rebuild query.
- Projectors must not return or write unbounded TypeScript arrays in one
  transaction. Cap record count, serialized bytes, SQL statement size, and
  transaction size; split before writing when output exceeds budget.
- Temp spill, result/output overflow, timeout, checksum spill, or writer-size
  overflow marks the chunk/request with diagnostics and either splits or parks it.
  The same oversized shape is not retried indefinitely.
- Failed or parked chunks leave the previous serving snapshot active and expose
  request/chunk diagnostics. Snapshot promotion depends on every required chunk
  completing within budget.

## Adversarial OOM Classes

| OOM Class | Trigger | Required Behavior | Static Or Unit Gate | Runtime Evidence | Phase 6 Proof |
|---|---|---|---|---|---|
| Legacy rebuild SQL | Old `project_scope_article`, `judgment_fact`, dictionary, rollup, filter-member, serving, or detail phases try to run. | Block normal execution, classify as legacy admin/debug or V4-rewire, and preserve last-known-good V4 snapshot. | Symbol and SQL guards fail on legacy phase runners and table writes outside allowlisted migrations/tests/admin-debug reads. | Event records blocked legacy path, caller, project, and requested action. | Physical run proves no legacy phase rows are claimed and no legacy SQL executes. |
| V4 chunk/projector | Chunk estimate, selected-import winner work, dense judgments, payloads, postings, filter options, validation, or writer transaction exceeds budget. | Park, split, or quarantine before retry; no partial promotion. | Chunk admission and projector tests cover over-budget, split, retry-after, and stale-owner cases. | Request/chunk diagnostics include estimates, actuals, temp/RSS, retry count, split depth, and over-budget reason. | Release run includes dense prompt, payload, selected-import, posting, and filter-option slices. |
| Checkpoint/WAL | `CHECKPOINT`, shutdown checkpoint, or maintenance checkpoint runs during heavy writer/temp pressure. | Use workload context, drain or block conflicting heavy work, record WAL/temp/RSS, and avoid checkpoint retry loops after OOM. | Checkpoint tests simulate heavy background state and failed checkpoint without corrupting owner state. | Event records checkpoint context, WAL size, temp bytes, memory limit, owner state, and fallback decision. | Phase 6 captures checkpoint during/after import and rebuild. |
| Append/import | Judgment append, import append, or delta intake builds large `VALUES`, parameter, JSON, or payload batches. | Split by row count, parameter count, payload bytes, lane pressure, and project fanout before DuckDB execution. | Append/import admission tests reject or split over-budget batches. | Append metrics include lane depth, row/param/payload bytes, temp/RSS, and project fanout. | Release run includes append/import bursts with large payloads. |
| Dirty-work and recovery | Dirty refresh, stale-claim recovery, quarantine/unquarantine, or repair commands resume old workers. | Enqueue V4 dirty work/chunk retries only; legacy recovery is read-only or blocked unless explicitly acknowledged as admin/debug. | Recovery tests prove `--recover` does not shell into legacy workers or schedule V3 phases. | Recovery event records converted/blocked stale work and V4 request IDs. | Phase 6 proves recovery from failed/interrupted work without legacy rebuild. |
| Cross-project/no-context | One bad project or unclassified global query causes repeated OOM or monopolizes maintenance queues. | Require workload class plus project/component/chunk identity or explicit capped global-admin class; cool down only affected work and preserve fairness. | Fairness tests prove one project cannot starve projector, append, or maintenance queues. | OOM event records project identity or explicit global class, queue depth, cooldown, and breaker state. | Release run includes cross-project dirty/rebuild bursts. |
| Retry thrash | Same failed shape is immediately retried after OOM/temp spill/timeout. | Persist retry-after, max attempts, OOM category, split/quarantine state, and terminal operator-visible state. | Retry tests prove repeated OOM cannot hot-loop. | Events show retry-after and terminal split/quarantine decision. | Phase 6 includes repeated failed chunk simulation. |
| Offline repair | Fatal DuckDB, WAL, checkpoint, or invalidated runtime requires offline remediation. | Close owner, inspect/quarantine failed chunks/outbox/cursors, preserve last-known-good snapshots, produce bounded repair plan, and resume without legacy fallback. | Offline repair tests prove plan generation and blocked legacy actions. | Repair bundle records owner state, failed chunks, pinned snapshots, and resume decision. | Phase 6 includes failed/invalidated runtime recovery evidence. |

## Guardrails For This Path And Paths Like It

- Static tests fail if normal refresh/rebuild code contains
  `temp_project_judgment_fact_article`, `temp_dirty_judgment_fact_article`,
  `getProjectJudgmentFactBatchInsertSql`, legacy phase labels, or legacy runner
  symbols such as `runProjectMartLargeRebuildCycle`,
  `runProjectMartLargeRebuildCycles`, `startProjectMartLargeRebuildHeartbeat`,
  `getScopedArticleImportSelectionCteSql`, `requestProjectLargeRebuild*`, or
  `getDuckdbMartMaintenanceService().refresh*` as executable normal work.
- Static SQL-shape tests fail if normal maintenance SQL writes legacy V3 review
  marts, uses `CREATE TEMP TABLE ... AS SELECT ... FROM (VALUES ...)` or
  `UNION ALL` literal article batches for large article sets, or runs broad raw
  `DELETE`/`INSERT` facts outside V4 projector tests.
- Static and runtime guards for V4 rebuild/projector SQL flag unbounded
  `ORDER BY ... LIMIT`, `ROW_NUMBER`, `COUNT(DISTINCT)`, ordered `string_agg`,
  anti-joins, `CREATE TEMP`, large `VALUES` lists, and scans lacking the chunk
  predicate unless the path is explicitly budgeted and allowlisted.
- Package-script tests fail unless every `db:duck:*large-rebuild*`,
  `*dirty-refresh*`, and `*judgment-fact-repair*` command is V4-rewired or
  renamed as explicit legacy admin/debug with an acknowledgement flag.
- Worker tests prove `projectMartRefreshWorker` enqueues V4 dirty work or rebuild
  chunks for oversized and normal refreshes; normal workers may not call
  `hasActiveProjectReviewServingGeneration`, `refreshDirtyProjectArticleBatch`, or
  request `project_scope_article` rebuilds after cutover.
- CLI tests prove repair and large-rebuild commands enqueue V4 work and do not
  schedule legacy `project_mart_large_rebuild_state` phases for normal projects.
- Warning route tests prove failed V4 snapshots surface `stale`, `indexing`,
  `unavailable`, or `failed` states without scanning legacy facts or kicking off
  legacy dirty/large rebuild repair.
- Admin route tests prove legacy run/pause/resume controls are removed, V4-rewired,
  or blocked; legacy status reads remain capped and admin/debug-only.
- Desktop and owner-handoff tests prove the same cutover applies under the desktop
  backend and low-memory profile, including stale-owner chunk output, snapshot
  promotion, and dirty-work completion.
- Runtime diagnostics include route/job key, workload class, project ID, snapshot
  ID, component, projection identity, chunk ID, input/output row counts, byte
  estimates, temp-spill state, retry count, retry-after, memory limit, DuckDB
  threads, temp directory bytes, WAL/checkpoint size, append lane depth, queue
  depth, fallback decision, and whether a path is V4, legacy-admin, or blocked.
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
4. Add request/chunk admission, retry-after, split/quarantine, and telemetry fields
   before V4 work becomes claimable.
5. Rewire the automatic oversized-refresh path to create V4 work instead of old
   `project_mart_large_rebuild_state` work.
6. Rewire judgment fact repair and dirty refresh recovery commands to V4 component
   repair or projector retry commands.
7. Cut normal startup, heartbeats, package scripts, admin run controls, and stale
   recovery away from legacy workers.
8. Freeze or migrate existing active/failed/idle legacy refresh and large-rebuild
   rows into V4 requests or `legacy_retired`/superseded state so old claims cannot
   resume.
9. Move progress and warning reads to V4 diagnostics while showing old large
   rebuild rows only as legacy/admin diagnostic state.
10. Disable legacy large rebuild scheduling for normal browser and desktop flows.
11. Delete or quarantine old phase execution code once V4 cutover tests and parity
   evidence pass.
12. Clean obsolete state with migrations or bounded maintenance scripts after no
   active writer references it.
13. Run Phase 6 physical evidence with legacy normal rebuild disabled and V4
    projector rebuild enabled.

## Browser And Desktop Rules

- Browser and desktop use the same V4 rebuild, dirty-work, diagnostics, and
  snapshot readiness paths.
- Desktop low-memory mode must reduce chunk sizes and wake budgets before raising
  DuckDB memory or thread count.
- Desktop restart, sleep, or owner handoff must resume V4 chunks through leases and
  manifests, not restart an old seven-phase rebuild from `judgment_fact`.
- Repo-native Phase 5B tests simulate lease expiry/restart for V4 chunks, dirty
  work, bulk/export/PDF, search, and cleanup. They assert last-known-good remains
  readable and no legacy phase is scheduled. Phase 6 owns the physical OS
  sleep/process-kill proof.
- UI copy should describe component/chunk/snapshot progress, not legacy phase
  progress, once normal flows are cut over.
- Normal review pages must not render legacy phase names such as `judgment_fact`,
  `prompt_answer_fact`, phase counters, or old large-rebuild labels except inside
  clearly marked admin/debug diagnostics.

## Implementation Progress - 2026-06-23

### Part 1 - V4 Rebuild Request Foundation

- Status: completed and committed as the first manageable implementation slice.
- Added `0107_reviewServingRebuildRequest.sql` with durable
  `app.review_rebuild_request` state above chunk manifests.
- Extended `app.review_rebuild_chunk_manifest` with `request_id`, retry-after,
  retry count, OOM category, over-budget reason, split/parent/snapshot fields,
  row/byte/prompt/temp budget fields, workload class, admission state, and
  diagnostics JSON.
- Added `reviewServingRebuildRequestRepository.ts` so rebuild/repair/refresh
  callers can create component-scoped V4 requests and chunk manifests without
  using legacy phase rows.
- Updated chunk claim logic so request-owned chunks are claimable only when the
  parent request is admitted and not cooling down; over-budget chunks are parked
  before execution.
- Added focused schema, request, and chunk tests for request admission and
  over-budget parking.
- Verification: `bun test src/server/reviewServing/reviewServingSchema.test.ts
  src/server/reviewServing/reviewServingChunkManifestRepository.test.ts
  src/server/reviewServing/reviewServingRebuildRequestRepository.test.ts`.

### Part 2 - Operator Request Script Cutover

- Status: completed and committed as the second implementation slice.
- Added `reviewServingV4RebuildRequestService.ts` with default full rebuild and
  judgment-repair component sets plus conservative request/chunk budgets.
- Rewired `scripts/requestProjectLargeRebuild.ts` and
  `scripts/requestReviewServingLargeRebuild.ts` to create V4 rebuild requests
  instead of writing `app.project_mart_large_rebuild_state`.
- Rewired `scripts/requestJudgmentFactRepair.ts` so normal repair requires an
  explicit project selection and enqueues judgment-related V4 components instead
  of scanning or repairing `mart.judgment_fact`.
- Updated CLI tests to assert admitted `app.review_rebuild_request` rows and zero
  legacy `project_mart_large_rebuild_state` request rows.
- Verification: `bun test scripts/requestReviewServingLargeRebuild.test.ts
  scripts/requestProjectLargeRebuild.test.ts
  scripts/requestJudgmentFactRepair.test.ts`; focused ESLint on the touched
  scripts, tests, and V4 request service.

### Part 3 - Startup And Package Script Cutover

- Status: completed as the third implementation slice.
- Removed normal maintenance startup imports and calls for
  `startProjectMartRefreshWorkerHeartbeat`,
  `startProjectMartLargeRebuildHeartbeat`, and the legacy mart-refresh drain gate.
- Maintenance startup now starts shared closeout/bulk work and the V4
  `startReviewServingProjectorWorkerHeartbeat` path without mounting legacy
  refresh or seven-phase large-rebuild cycles.
- Renamed normal package scripts for legacy large-rebuild workers to
  `db:duck:legacy-admin-run-large-rebuild-worker-once` and
  `db:duck:legacy-admin-run-large-rebuild-worker-cycles`, each carrying
  `--legacy-admin-ack=legacy-large-rebuild`.
- Added a reusable legacy-admin acknowledgement helper and made direct legacy
  large-rebuild worker CLIs fail with structured JSON unless the acknowledgement
  is passed.
- Verification: `bun test src/server/utils/startBackgroundWork.test.ts
  scripts/rebuild2PackageCommands.test.ts scripts/runLargeRebuildWorkerOnce.test.ts
  scripts/runLargeRebuildWorkerCycles.test.ts`; focused ESLint on the touched
  startup, package-script, legacy-admin, and recovery compatibility tests.

### Part 4 - Recovery And Warning Side-Effect Cutover

- Status: completed as the fourth implementation slice.
- Rewired `scripts/recoverDirtyRefreshClaims.ts --recover` so stale dirty
  materialization, dirty refresh, and large-rebuild claims create V4
  `app.review_rebuild_request` rows instead of shelling into legacy refresh or
  large-rebuild worker scripts.
- Recovery now leaves legacy stale claim rows as diagnostic state and returns the
  created V4 request IDs in structured output.
- Removed the review-warning route's legacy `mart.judgment_fact` missing-row scan
  and `missingVisibleJudgmentFacts` dirty-state enqueue side effect.
- Removed warning-route bootstrap of missing serving rows through
  `requestProjectLargeRebuildIfNoLargeRebuild`; warnings now report stale V4
  state instead of scheduling old large-rebuild work.
- Verification: `bun test scripts/projectMartRefreshRecovery.test.ts
  src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.test.ts`;
  focused ESLint on the touched recovery script and warning route/tests.

### Part 5 - Legacy Admin Acknowledgements And Static Guards

- Status: completed as the fifth implementation slice.
- Added `legacy-dirty-refresh` acknowledgement requirements to the direct legacy
  dirty-refresh worker scripts:
  `runProjectMartRefreshWorker.ts`, `runProjectMartRefreshWorkerOnce.ts`, and
  `runProjectMartRefreshWorkerOnceIsolated.ts`.
- Added `reviewServingPhase5BStaticGuards.test.ts` to lock in the Phase 5B cutover
  decisions for startup, warning side effects, recovery, package commands, and
  legacy-admin acknowledgement coverage.
- Extended recovery CLI compatibility tests so direct isolated dirty-refresh
  execution proves the new acknowledgement block.
- Verification: `bun test
  src/server/reviewServing/reviewServingPhase5BStaticGuards.test.ts
  scripts/projectMartRefreshRecovery.test.ts`; focused ESLint on the touched
  scripts and static guard test.

## JavaScript And TypeScript Rule

Use `effect` for new non-trivial async and server orchestration in V4 rebuild
requesting, chunk creation, repair/recovery command rewrites, and worker retry
logic. Prefer `Effect.gen` for sequencing, `Layer`/`Context` for services,
`Effect.acquireRelease`/`Scope` for leases and owned resources, and `Schedule` for
retry/backoff. Keep pure transforms and small local handlers as plain functions.

## Quality Gates

- [ ] Legacy path audit lists all callers of `projectMartLargeRebuild*`,
  `getDuckdbMartMaintenanceService` refresh/rebuild methods, judgment fact repair,
  dirty refresh recovery, warning/progress APIs, startup heartbeats, package
  scripts, admin run controls, adjacent browser fallbacks, and admin investigate
  legacy mart reads.
- [ ] Each legacy caller is classified as `retire`, `rewire-to-v4`, or
  `admin-debug-only` with test evidence.
- [x] Normal rebuild and repair requests create V4 component rebuild requests,
  dirty work, or chunk manifests rather than legacy phase rows.
- [x] V4 rebuild requests have durable request IDs, status, retry policy, admission
  estimates, over-budget state, diagnostics, and request-to-chunk linkage.
- [~] Normal refresh completion is based on V4 component watermarks, manifests,
  and active or last-known-good snapshot state.
- [ ] No normal browser or desktop flow can execute the legacy `judgment_fact`,
  `project_scope_article`, `prompt_answer_fact`, `review_answer_dictionary`,
  `review_article_filter_member`, `review_article_rollup`,
  `review_article_serving`, or `review_article_serving_detail` phase chain.
- [~] Static SQL-shape tests fail on `temp_project_judgment_fact_article`, broad
  legacy review-mart writes, unbounded inline `VALUES`/`UNION ALL` article
  batches, raw fact aggregation, selected-import CTE fallback, JSON
  sort/extraction, ordered checksum aggregation, and raw total counts in normal
  refresh/rebuild paths. Focused Phase 5B guard coverage exists; broader
  SQL-shape inventory remains.
- [~] Symbol guards fail on normal callers of legacy refresh/rebuild methods,
  legacy phase runners, scoped-import CTE helpers, startup heartbeats, package
  scripts, and old admin run controls unless explicitly allowlisted. Startup,
  package, warning, recovery, and worker-ack guards exist; broader producer/admin
  coverage remains.
- [ ] V4 rebuild chunks are budgeted by rows, bytes, expected temp use, wake time,
  prompt/judgment density, payload size, posting/filter fanout, summary/filter
  option cardinality, snapshot count, timeout, and retry policy.
- [x] Over-budget V4 chunks split, park, or quarantine with retry-after diagnostics;
  repeated OOM cannot hot-loop in the same shape.
- [ ] Append/import batches and checkpoint operations have explicit OOM admission,
  telemetry, and no retry-loop behavior.
- [ ] Chunk manifests can skip completed unchanged chunks after crash, restart,
  sleep, and repeated operator commands.
- [ ] V4 rebuild failures preserve the last known-good snapshot and surface
  failed/stale/indexing/unavailable diagnostics without raw fallback.
- [x] Repair and recovery CLI tests prove V4 work is queued and legacy normal
  rebuilds are not scheduled.
- [ ] Existing active/failed/idle legacy refresh and large-rebuild rows are migrated,
  frozen, or marked retired so no normal claim path can resume them.
- [x] Startup and heartbeat tests prove production/browser/desktop maintenance
  startup cannot mount legacy rebuild cycles after cutover.
- [x] Package-script static tests prove normal operator entrypoints are V4-rewired
  or explicitly legacy-admin with acknowledgement.
- [~] Warning and health route tests prove failed, missing, stale, and candidate V4
  snapshots are reported without legacy fact scans, dirty repair, or large-rebuild
  scheduling side effects. Review-warning route tests cover this; health/admin
  routes remain.
- [ ] Warning/progress UI and APIs report V4 snapshot/chunk/projector diagnostics
  for browser and desktop, and normal review UI does not render legacy phase names
  or old phase counters.
- [ ] Admin/debug-only legacy inspection routes are route-classified, capped,
  guarded, read-only unless V4-rewired, and excluded from normal product flows.
- [ ] V4 owner-handoff tests prove stale owners cannot complete chunk output,
  snapshot promotion, or dirty-work acknowledgement after lease transfer.
- [ ] Cross-project OOM/fairness tests prove one failing project cannot monopolize
  projector, append, checkpoint, or maintenance queues.
- [ ] Offline repair tests prove fatal DuckDB/WAL/checkpoint states produce a bounded
  repair plan, preserve last-known-good snapshots, and do not trigger legacy
  rebuild fallback.
- [ ] Durable OOM/workload telemetry is emitted for legacy blocks, V4 chunks,
  checkpoint, append/import, retry-thrash, cross-project, and offline-repair cases.
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
