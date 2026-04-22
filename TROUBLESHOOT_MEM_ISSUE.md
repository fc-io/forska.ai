# DuckDB OOM Troubleshooting

## Summary

The stacked worker on macOS was crashing because embedded DuckDB was hitting the background writer memory cap at checkpoint time and invalidating the runtime.

Initial symptom pattern:

- `Failed to create checkpoint: Out of Memory Error`
- `database has been invalidated because of a previous fatal error`
- repeated worker-side cron failures after the first fatal write

The worker was running with:

- `SERVER_ROLE=worker`
- `DUCKDB_MEMORY_LIMIT=6400MiB`

That cap matched the observed failure point in logs (`6.2 GiB/6.2 GiB used`).

## What Was Actually Failing

The OOM was not a single bug. Several different worker paths were independently too heavy for the `6400MiB` profile.

### 1. Checkpoint invalidation

DuckDB would OOM during checkpoint, then invalidate the embedded handle. After that, unrelated reads and writes failed until restart.

### 2. Startup/background maintenance work

The low-memory worker was still trying to run background work that was too expensive for the capped profile.

Concrete paths found during investigation:

- `clearArchivedProjectRefreshStates()`
- `clearArchivedLargeRebuildStates()`
- project mart refresh worker claim/refresh loops
- project mart large rebuild heartbeat

These were enough to poison the writer before normal judgment work stabilized.

### 3. Overly aggressive queue-fill scans

`runAddToQueue` delegated to OLAP scans that could still expand small top-ups into large candidate windows.

Concrete issue found:

- a tiny prompt top-up could still trigger a minimum candidate scan of `2000` articles

### 4. Large-rebuild auto-tuning mismatch

Large rebuild tuning used host-memory heuristics instead of the split worker's actual `DUCKDB_MEMORY_LIMIT`, so the worker could choose an oversized rebuild profile even while capped at `6400MiB`.

### 5. Broad startup discovery queries

Several worker startup paths were scanning larger DuckDB tables just to rediscover local SQLite-owned work.

Concrete paths reduced during investigation:

- `app.judgment_job` rediscovery queries
- refresh-ack lookup paths joining through `app.project_mart_refresh_state`

### 6. Token accounting writes

After the worker became stable enough to issue live LLM requests, the next fatal path was:

- `INSERT INTO app.token_use`

This write was already best-effort in behavior, but it was still able to trigger checkpoint OOM and invalidate DuckDB.

## Important Debugging Improvement Added

DuckDB errors now include a statement preview in `src/server/utils/duckdbService.ts`, so future OOMs name the failing statement directly.

This was the key change that exposed:

- refresh-state bookkeeping queries
- provider/model lookups
- `INSERT INTO app.token_use`

## Code Changes Made

### DuckDB runtime tuning

File: `src/server/utils/duckdbService.ts`

Applied on startup:

- `preserve_insertion_order=false`
- `threads=1` for the `<= 6400MiB` profile
- serialize main/background/append DuckDB work on low-memory workers
- expose effective settings in diagnostics
- include SQL statement previews in normalized errors

## Large rebuild tuning fix

File: `src/server/utils/projectMartLargeRebuildTuning.ts`

- automatic tuning now falls back to the worker's `process.env.DUCKDB_MEMORY_LIMIT` when no stored override exists

Effect on `6400MiB` worker:

- avoids incorrectly selecting high-memory rebuild profiles based on host RAM

## Mart worker safety changes

Files:

- `src/server/workers/projectMartRefreshWorker.ts`
- `src/server/services/projectMartLargeRebuildRunner.ts`
- `src/server/utils/martRefreshDrainHeartbeat.ts`

Changes:

- stop running archived cleanup deletes in every live cycle
- route oversized full refreshes to large rebuild earlier
- skip mart refresh and large rebuild heartbeats entirely on the `6400MiB` worker profile

Rationale:

- these loops were proven to trigger OOM independently on the low-memory writer

## Queue-fill scan reduction

File: `src/services/olap/duckdbOlap.ts`

Changed:

- minimum candidate-article scan floor reduced from `2000` to `100`

Rationale:

- avoids huge scans when only a small prompt top-up is needed

## Judgment job startup query narrowing

Files:

- `src/server/cron/judgmentsJobs/judgmentsJobsGetRunningJobs.ts`
- `src/server/cron/judgmentsJobs/judgmentJobSqliteBackgroundImport.ts`
- `src/server/cron/judgmentsJobs/judgmentJobSqliteOutboxImport.ts`
- `src/server/cron/judgmentsJobs/judgmentJobSqliteService.ts`

Changes:

- prefer local SQLite job IDs first
- replace broader set scans with narrower point-lookup or tracked-subset queries where possible
- split refresh-ack logic into project-specific lookups rather than broader joins

## Low-memory judgments cron mode

Files:

- `src/server/cron/judgmentsJobs.ts`
- `src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM.ts`

On `<= 6400MiB` worker:

- `sendToLLM` skips the extra runtime-model DB re-filter
- `importJudgmentsCron` is disabled

Rationale:

- import and the extra provider/model lookup pass were still heavy enough to destabilize the low-memory worker

## Token-use persistence bypass

File: `src/agent/judge/judgeStoreTokenUse.ts`

On `SERVER_ROLE=worker|writer` with `DUCKDB_MEMORY_LIMIT <= 6400MiB`:

- skip local `app.token_use` persistence
- still call `markJudgmentRequestsPersisted(...)`

Rationale:

- `INSERT INTO app.token_use` was the final confirmed checkpoint-OOM write
- token-use analytics are lower priority than worker stability on this capped profile

## Current Tradeoffs On The `6400MiB` Worker

These are intentional stability tradeoffs for the capped writer profile:

- mart refresh heartbeat disabled
- large rebuild heartbeat disabled
- import cron disabled
- token-use persistence disabled
- send-to-LLM does less DB-side refiltering

Operational consequence:

- the low-memory worker can keep judging
- but stale local SQLite outbox state will not automatically self-heal through the disabled import cron
- that stale import state may require a manual `repair` or `drain` action, or a higher-memory writer/import path

## Additional Recovery Finding

After stabilizing the live worker, a retained SQLite backlog was tested with the built-in live job repair route.

Concrete result:

- `POST /api/judgmentsjobs/:id/repair` stopped safely with a real DuckDB OOM while trying to append imported judgments back into DuckDB
- failing statement context named an `INSERT INTO app.judgment ...` append query

Implication:

- low-memory live repair is not sufficient for every retained-backlog case
- the `6400MiB` worker can stay alive for active judging, but may still be unable to import retained SQLite backlog into DuckDB

Practical consequence:

- if a job is alive but stuck with `recommendedNextAction = retry_stale_import`, the safer recovery path is an offline repair or a higher-memory writer/import path, not repeated live repair attempts on the capped worker

## Confirmed Recovery Workflow For A Stalled Job

One real job (`f3965462-4585-4fdc-bbfd-dee02cf52bb3`) was recovered end-to-end during this investigation.

Observed stuck state before recovery:

- worker lease was healthy
- job status stayed `running`
- `ready=0`, `running=0`, `claimed=0`
- local SQLite scan state kept re-exhausting
- health reported `recommendedNextAction = retry_stale_import`
- retained local state included unexported outbox rows and orphaned judged queue rows

### What Did Not Work

- waiting on the live `6400MiB` worker
- live `POST /api/judgmentsjobs/:id/repair`

Live repair failed with a real append OOM while importing SQLite backlog back into DuckDB.

### What Did Work

1. Stop the live stacked server so DuckDB maintenance has exclusive access.
2. Run offline repair with a higher memory limit, e.g. `DUCKDB_MEMORY_LIMIT=20GB`.
3. Repeat offline repair if the first pass only partially imports the backlog.
4. If stale import metadata remains after the backlog reaches zero, run one offline background-import cycle so `last_import_completed_at` is refreshed.
5. Run offline repair again to requeue orphaned judged rows.
6. Restart the stacked server and verify prompt activity resumes.

Important observation:

- offline repair imported the retained outbox backlog in multiple passes (`100` rows, then `67` rows)
- a follow-up offline import cycle refreshed stale `last_import_*` metadata
- a later offline repair pass successfully requeued `174` orphaned judged rows

After restart, the job resumed normal activity:

- `ready > 0`
- `running > 0`
- `claimed > 0`
- `attempts` increased again
- `judged` increased again

### Practical Rule

For a capped `6400MiB` worker:

- use the live worker for judging stability
- do not rely on it for large retained-backlog import recovery
- use offline repair with a larger memory limit for retained SQLite backlog and stale-import recovery

## Verification Performed

Representative commands run during this investigation:

- `bun test src/server/utils/duckdbServiceMemoryLimit.test.ts`
- `bun test src/server/utils/duckdbServiceErrorNormalization.test.ts src/server/utils/duckdbServiceMemoryLimit.test.ts`
- `bun test src/server/utils/projectMartLargeRebuildHeartbeat.test.ts`
- `bun test src/server/workers/projectMartRefreshWorker.test.ts src/server/services/projectMartLargeRebuildRunner.test.ts`
- `bun test src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM.test.ts src/server/cron/judgmentsJobs/judgmentJobSqliteOutboxImport.test.ts src/server/utils/startBackgroundWork.test.ts`
- `bun test src/agent/judge/judgeStoreTokenUse.test.ts`
- targeted `bun x eslint ...` on all touched files
- real runtime probes with `bun scripts/runWithRuntimeProfile.ts --profile primary --mode stacked-server`

## Final State Reached

After the final low-memory changes:

- the worker started successfully
- live Anthropic requests were issued
- no further DuckDB OOM invalidation was observed during the final runtime probe

Remaining failures after that point were provider-side Anthropic refusals, not DuckDB OOM.

## If The OOM Reappears

Check these first:

1. Confirm the worker is still running with `DUCKDB_MEMORY_LIMIT=6400MiB` and the updated code.
2. Check whether a new DuckDB error includes `duckdb ... query:` statement context.
3. Confirm the failure is not from a path intentionally disabled in low-memory mode being re-enabled.
4. If a job is stalled with retained SQLite outbox rows, treat that as a repair/import recovery issue, not as proof that the OOM fix regressed.

## Practical Recovery Guidance

For a low-memory worker that is alive but stalled with:

- retained outbox rows
- stale import metadata
- `recommendedNextAction = retry_stale_import`

do not assume waiting will resolve it.

Because import is disabled on the `6400MiB` worker profile, the safer recovery path is to use an explicit repair/drain flow or a higher-memory writer/import path.

If live `repair` itself fails with an append OOM during `INSERT INTO app.judgment`, move to offline repair with the stack stopped and a higher DuckDB memory limit.
