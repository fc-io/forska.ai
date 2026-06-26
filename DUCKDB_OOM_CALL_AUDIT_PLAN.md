# DuckDB OOM Call-Site Audit Plan

Created: 2026-06-26
Base audited: `origin/main` at `ed5ec3c55035edd3f43f62c4452df8ca100e9e18`

## Audit Result

Initial audit result: not every DuckDB call was fully aligned with
`DUCK_OOM_FIX_PLAN.md`.

The V4 review-serving route layer has the right shape: mounted review route
inventory, serving read contracts, admission contexts, SQL-shape guards, and
route tests protect the normal LLM/human/both/unassessed/filter/count/detail/job
surfaces from old OLAP/raw paths.

The remaining risk is around calls outside that narrow seam: rebuild request
SQL, legacy OLAP job/cron paths, auxiliary mounted-route metadata reads, direct
read-only tools, and optional workload contexts on generic database services.

## Implementation Status

Addressed in branch `fix/duckdb-oom-plan-compliance`:

- Reclassified rebuild/admission/job-serving SQL so the serving SQL guard is
  green again without weakening forbidden raw-query patterns.
- Moved judgment-job unassessed count/article/pair reads to the V4 serving queue
  and removed the foreground job imports of legacy OLAP unassessed helpers.
- Added static guards for residual mounted-route reads, generic foreground
  DuckDB access, and legacy `duckdbOlap` import quarantine.
- Centralized read-only DuckDB runtime options and reused them in snapshot and
  background read-only helpers.
- Added shared maintenance workload contexts for the cited maintenance/migration
  scripts.

Post-implementation quality gates run:

- `bun test src/server/reviewServing/reviewServingSql.test.ts src/server/reviewServing/reviewServingReadContracts.test.ts src/server/reviewServing/reviewServingAdmission.test.ts src/server/cron/judgmentsJobs/judgmentsJobsAddToQueue.test.ts src/server/routes/judgmentsJobsRoutesApiReadModel.test.ts`
  -> 129 pass, 0 fail.
- `bun run lint` -> pass.
- `bunx prettier --check` on touched files -> pass.
- `bun -e` import check for changed service/script modules -> pass.
- `bunx tsc --noEmit` still fails on pre-existing repo type errors outside this
  change, including existing `JudgmentsJobsRoutes` test/route typing issues.

## Findings

### 1. Serving SQL Guard Fails On Current Main

Command:

```bash
bun test src/server/reviewServing/reviewServingReadContracts.test.ts src/server/reviewServing/reviewServingAdmission.test.ts src/server/reviewServing/reviewServingSql.test.ts
```

Result: 98 pass, 1 fail.

Failing test:

```text
reviewServing read source files are statically guarded without scanning projector or legacy route SQL
```

Current violations:

```text
reviewServingV4RebuildRequestService.ts: raw article table scan
reviewServingV4RebuildRequestService.ts: raw judgment table scan
reviewServingV4RebuildRequestService.ts: json extraction
reviewServingV4RebuildRequestService.ts: foreground aggregation
reviewServingRebuildRequestRepository.ts: raw article table scan
reviewServingChunkManifestRepository.ts: json extraction
```

Relevant files:

- `src/server/reviewServing/reviewServingSql.test.ts`
- `src/server/reviewServing/reviewServingV4RebuildRequestService.ts`
- `src/server/reviewServing/reviewServingRebuildRequestRepository.ts`
- `src/server/reviewServing/reviewServingChunkManifestRepository.ts`

Interpretation: either these rebuild-request files need to be reclassified as
maintenance/admission code and explicitly excluded with tests proving they are
not product-read SQL, or the SQL needs to move behind bounded maintenance
contracts. Leaving the guard red weakens the static evidence claimed by the OOM
plan.

### 2. Generic DuckDB Services Still Allow Unclassified Foreground Calls

`getAppDatabaseService().queryJson`, `.run`, `.transaction`,
`getApiReadOnlyAppDatabaseService().queryJson`, and
`getJudgeWorkerReadOnlyAppDatabaseService().queryJson` all accept optional
`DuckdbWorkloadContext`. Missing context is still legal.

Relevant files:

- `src/server/services/appDatabaseService.ts`
- `src/server/services/appReadOnlyDatabaseService.ts`
- `src/server/services/readOnlyDuckdbService.ts`
- `src/server/utils/duckdbService.ts`

This means the generic runtime records budgets when callers pass a context, but
it does not enforce the plan rule that normal foreground DuckDB work must be
registered before execution.

### 3. Legacy OLAP Raw Fallback Still Feeds Job And Cron Paths

The mounted review routes no longer import the old OLAP wrappers, but judgment
job API/cron code still does.

Relevant files:

- `src/server/cron/judgmentsJobs/judgmentsJobsCronGetPrompts.ts`
- `src/server/routes/JudgmentsJobsRoutes.ts`
- `src/services/olap/duckdbOlap.ts`
- `src/server/services/scopedArticleReadAdapter.ts`

Examples:

- `judgmentsJobsCronGetPrompts` calls `getUnassessedPairsFromOlap` and still has
  `preferRawFallback`.
- `JudgmentsJobsRoutes` calls `getUnassessedCountFromOlap` and
  `getUnassessedArticlesFromOlap`.
- `duckdbOlap.ts` still contains raw fallback branches, `OFFSET` pagination,
  `COUNT(*)` over legacy serving tables, and paths through
  `selected_scoped_article_import`.
- `scopedArticleReadAdapter.ts` still builds the selected import CTE using
  `ROW_NUMBER()` and JSON extraction.

These may be admin/job surfaces rather than the normal review list UI, but
`DUCK_OOM_FIX_PLAN.md` explicitly calls out `JudgmentsJobsRoutes` and
unassessed/queue job paths as needing V4 serving queue contracts without raw
fallback windows.

### 4. Mounted Review Auxiliary Routes Still Run Direct App/Mart Queries

Several mounted review-adjacent routes correctly use `readReviewServingRows` for
the main product state, but still run direct app/mart queries for scope,
config, detail, warning, or prompt-preview metadata.

Relevant files:

- `src/server/routes/projectsRoutes/projectsRoutesGetReviewsHealth.ts`
- `src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.ts`
- `src/server/routes/projectsRoutes/projectsRoutesGetPromptPreview.ts`
- `src/server/routes/projectsRoutes/projectsRoutesPostArticleReviewDetails.ts`

Some of these are probably acceptable auxiliary metadata/diagnostic reads, but
the plan says the residual app-table reads need an allowlist or new serving
contracts before broad guards can prove compliance. Today they are not
systematically registered or budgeted as foreground contracts.

### 5. Direct Read-Only DuckDB Helpers Miss The Shared Memory/Temp Options

The primary DuckDB service and `readOnlyDuckdbService` set `memory_limit`. The
older direct read-only helpers do not.

Relevant files:

- `scripts/dbQuerySnapshot.ts`
- `src/server/utils/backgroundServerStack.ts`

Both call `DuckDBInstance.create(..., {access_mode: 'READ_ONLY'})` without a
memory cap or temp-directory policy. `db:query:snapshot` queries a snapshot, not
the live database, but the repo instructions and OOM plan still expect direct
DuckDB/manual tools to run with explicit memory caps.

### 6. Script/Maintenance Calls Are Owner-Guarded But Mostly Unclassified

Most maintenance scripts correctly use `withDuckdbMaintenanceAccess`, which
avoids racing the live owner. Many then call `getAppDatabaseService()` without
workload context, so they do not consistently emit route/job keys, workload
classes, temp-spill intent, or budgets.

Relevant examples:

- `scripts/backfillArticleSourceMetadata.ts`
- `scripts/rebuild2Cutover.ts`
- `scripts/recoverDirtyRefreshClaims.ts`
- `src/db/migrateDuckdb.ts`

This is less urgent than foreground product paths, but it is still part of the
plan's low-level DuckDB classification/diagnostics goal.

## Recommended Fix Plan

| # | Fix | What It Does Now | What It Should Do | Why It Helps |
|---|---|---|---|---|
| 1 | Restore serving SQL guard to green | Static guard fails on rebuild-request files. | Classify those files as maintenance/admission with explicit allowlist tests, or move forbidden SQL behind bounded maintenance contracts. | Re-establishes a failing guard for accidental raw serving SQL. |
| 2 | Add a foreground DB call inventory guard | Generic `queryJson`/`run` can be used in routes without workload context. | Add tests scanning mounted product routes for direct `getAppDatabaseService()` and require either `reviewServingReader`, durable job services, or an explicit residual-read allowlist. | Makes unregistered foreground work visible before execution. |
| 3 | Rewire judgment job unassessed reads to V4 queue contracts | Job/cron paths still call OLAP with raw fallback. | Replace `getUnassessedPairsFromOlap`, `getUnassessedCountFromOlap`, and `getUnassessedArticlesFromOlap` in job paths with `review_unassessed_queue_serving_v4`/`reviewServingReader` contracts or async unavailable/stale states. | Removes the remaining plan-named raw fallback queue path. |
| 4 | Decide residual metadata read policy | Health/warnings/detail/prompt-preview still issue direct app/mart reads. | Create `reviewServingResidualReadAllowlist.ts` or new `review.metadata.*` contracts with workload contexts and tests for each allowed query. | Distinguishes safe small metadata reads from raw fallback. |
| 5 | Require workload context for normal foreground calls | Runtime budgets are optional. | Add a route/runtime mode that rejects missing `DuckdbWorkloadContext` outside explicit background, migration, maintenance, or test scopes. | Turns the plan's admission rule into enforcement, not convention. |
| 6 | Add shared read-only DuckDB runtime helper | Snapshot/manual helpers open read-only DuckDB without memory/temp options. | Reuse a helper that sets `access_mode`, `memory_limit`, `temp_directory`, `preserve_insertion_order`, and `threads` consistently. | Prevents manual/snapshot reads from bypassing OOM settings. |
| 7 | Classify maintenance/script workloads | Owner-guarded scripts run, but often without workload diagnostics. | Add `getMaintenanceDuckdbWorkloadContext(taskName)` and pass it through migration/backfill/recovery scripts. | Improves OOM logs and makes maintenance overlap easier to debug. |
| 8 | Add an OLAP retirement guard | `duckdbOlap.ts` still exists and can be imported. | Add a static guard that only allowlists explicitly classified legacy/admin imports, then shrink the allowlist as job paths move to V4. | Prevents old raw fallback helpers from re-entering product flows. |

## Suggested Implementation Order

1. Fix the currently failing guard test first. Do not merge more DuckDB work
   while `reviewServingSql.test.ts` is red.
2. Add the residual-read allowlist and mounted-route DB-call inventory. This
   gives a stable audit surface before rewiring every caller.
3. Rewire the judgment job unassessed queue/count/preview paths away from OLAP.
4. Add strict missing-workload-context rejection for normal foreground route
   execution, initially behind a test/runtime flag if needed.
5. Update direct read-only helpers and maintenance workload contexts.
6. Retire or quarantine remaining OLAP wrappers once job/admin users are
   explicitly migrated or allowlisted.

## Quality Gates

- `bun test src/server/reviewServing/reviewServingSql.test.ts`
- `bun test src/server/reviewServing/reviewServingReadContracts.test.ts`
- `bun test src/server/reviewServing/reviewServingAdmission.test.ts`
- Focused tests for any rewired judgment job queue/count paths.
- `bun run lint`
- `bun run test:network-smoke:current-db`
- A new static guard proving mounted product routes cannot call generic DuckDB
  services without `reviewServingReader`, a durable job service, or an explicit
  residual-read allowlist.
- A new static guard proving `duckdbOlap.ts` wrappers are not imported by normal
  product review routes or judgment job foreground paths after rewiring.
