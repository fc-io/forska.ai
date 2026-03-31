# Judgment Reliability Plan

## Goal

- Make judgment execution crash-contained, durable, observable, and repairable.
- Ensure one bad SQLite job DB cannot crash the worker or block unrelated jobs.
- Make pause, resume, complete, delete, and archive flows deterministic.
- Expose job storage health clearly in the UI so operators can see risk before it becomes an incident.

## Why Now

- A paused job with retained SQLite outbox state was able to trigger a Bun native panic during background import.
- The current fix contains the issue by excluding non-running jobs from background import.
- That containment is necessary, but it is not the final design for a critical workflow.

## Main Problems To Solve

- In-process SQLite import can crash the entire worker.
- Job run state and local storage health are not modeled separately.
- Pausing a job clears active queue state, but it does not guarantee that local outbox state is drained first.
- Cleanup is opportunistic, so paused or completed jobs can keep large SQLite and WAL files for too long.
- The UI shows job run state, but not local storage health, outbox age, WAL size, or quarantine status.
- Files on disk can outlive the job state that should govern them.

## Core Decisions

- `app.judgment_job` remains the source of truth for which jobs background automation may touch.
- Add a separate persisted storage-health model instead of overloading the existing job `status` field.
- Background outbox import should only touch jobs whose storage state is explicitly importable.
- SQLite outbox import must run in an isolated subprocess per job so native crashes are contained.
- Repeated import or preflight failures should quarantine the job instead of retrying forever.
- Pause should become `pause and drain`, not `pause and leave local state behind`.
- Operators should get both inline visibility and a dedicated health surface.

## State Model

- Keep existing job `status` focused on product intent and scheduling.
- Add a new persisted `storageState` on `app.judgment_job`.
- Recommended values:
  - `missing`: no local SQLite job DB exists yet
  - `active`: local SQLite state exists and can accept/import judgments
  - `draining`: no new work should be created; importer and retention cleanup are finishing the local state
  - `drained`: local SQLite state is fully exported, acked, pruned, and safe to delete
  - `quarantined`: automation is blocked until explicit repair or operator action

- Add persisted job-health metadata on `app.judgment_job`:
  - `quarantinedAt`
  - `quarantineReason`
  - `lastImportStartedAt`
  - `lastImportCompletedAt`
  - `lastImportErrorAt`
  - `lastImportError`
  - `lastImportExitCode`
  - `importFailureCount`
  - `pauseRequestedAt`

- Keep derived counters live rather than denormalizing everything into the table:
  - SQLite file bytes
  - WAL bytes
  - outbox row count
  - oldest unexported outbox age
  - claimed outbox row count
  - queue prompt counts
  - last ack seq and retained row count

## Worker Design

### 1. Preflight

- On worker startup, enumerate only jobs from `app.judgment_job` that are eligible for local processing.
- For each eligible job, run a lightweight isolated preflight:
  - open SQLite DB
  - verify required tables and columns
  - verify small read queries on queue and outbox tables
  - capture file size and WAL size
- If preflight fails, mark the job `quarantined` and continue with other jobs.

### 2. Isolated Outbox Import

- Move SQLite outbox import into a subprocess per job.
- Parent worker responsibilities:
  - select eligible jobs
  - launch isolated import command with timeout and structured output
  - record success or failure metadata
  - quarantine after configurable failure threshold or native exit code
- Child importer responsibilities:
  - claim one outbox batch for a single job
  - validate FK and duplicate constraints
  - append to DuckDB
  - queue mart refreshes
  - ack SQLite outbox claim
  - emit structured result and exit cleanly

- Native crash containment rule:
  - if the child exits non-zero or with native crash code, only that job is affected
  - the parent worker must survive and continue other jobs

### 3. Pause And Drain

- Change pause flow to:
  1. set job `status = 'paused'`
  2. set `storageState = 'draining'`
  3. stop new prompt claims and LLM sends for that job
  4. continue isolated outbox import until no exportable rows remain
  5. wait for project refresh ack visibility barrier
  6. prune retained SQLite rows
  7. checkpoint WAL and close the SQLite DB
  8. set `storageState = 'drained'`

- If any step fails:
  - do not silently call the job safely paused
  - mark `storageState = 'quarantined'`
  - preserve the failure reason in metadata

### 4. Resume And Start

- Starting a paused job should require a successful preflight first.
- If `storageState = 'quarantined'`, block resume and surface repair guidance.
- If `storageState = 'draining'`, either:
  - finish the drain first, or
  - require an explicit operator override

- Prefer the simpler rule first:
  - `quarantined` and `draining` jobs cannot resume until cleared

### 5. Cleanup

- Keep periodic cleanup, but make it a backstop, not the primary lifecycle mechanism.
- Cleanup should:
  - reap stale outbox claims
  - prune visibility-acked retained rows
  - checkpoint drained SQLite DBs
  - delete drained job DBs deterministically
- Background cleanup should never scan the filesystem as the primary source of truth for active work.

## Repair And Recovery

- Add a first-class repair path for one job at a time.
- Required repair actions:
  - inspect job storage health
  - run isolated preflight
  - run isolated import once
  - reap stale claims
  - checkpoint WAL
  - prune retained rows
  - mark quarantined or clear quarantine
  - delete local SQLite files only after the job is proven drained

- Add both:
  - an admin route/action surface for operators
  - a CLI/script entrypoint for local and emergency repair

- Keep a fallback escape hatch for pathological SQLite cases:
  - allow repair tooling to use the system `sqlite3` CLI for diagnostics, checkpoint, and export if Bun-native SQLite remains unstable in edge cases

## API Surface

- Add summary endpoint for aggregate job health:
  - `GET /api/judgmentsjobs-health`
- Add per-job health endpoint:
  - `GET /api/judgmentsjobs/:id/health`
- Add repair/mutation endpoints:
  - `POST /api/judgmentsjobs/:id/drain`
  - `POST /api/judgmentsjobs/:id/preflight`
  - `POST /api/judgmentsjobs/:id/checkpoint`
  - `POST /api/judgmentsjobs/:id/quarantine`
  - `POST /api/judgmentsjobs/:id/unquarantine`
  - `POST /api/judgmentsjobs/:id/repair`

- Keep response payloads small and operational:
  - storage state
  - import health metadata
  - live SQLite counters
  - recommended next action

## UI Decision

- Use both inline visibility and a dedicated health page.

### Inline UI

- Extend `/admin/jobs` with:
  - a health summary strip above the table
  - counts for `draining`, `quarantined`, `retained outbox`, and `stale import`
  - a `Health` column per job with concise badges such as `Healthy`, `Draining`, `Quarantined`, `Retained Outbox`, `Large WAL`
  - direct links to job detail or health views for non-healthy jobs

- Extend `/admin/jobs/$id` with a `Local Storage Health` card showing:
  - storage state
  - SQLite file size
  - WAL size
  - outbox row count
  - oldest unexported age
  - claimed outbox count
  - last import success and failure
  - failure count and last exit code
  - quarantine reason
  - repair actions

- Keep inline health compact and operator-friendly.
- The job detail page is the right place for per-job diagnosis because that page already carries queue, token, runtime, and action context.

### Dedicated UI

- Add `/admin/jobs/health` as an operations page focused only on reliability and repair.
- This page should show:
  - non-healthy jobs first
  - filters for `draining`, `quarantined`, `retained outbox`, `large WAL`, and `stale import`
  - oldest-risk-first sorting
  - aggregate counts and oldest age at top
  - batch-safe actions only where they are truly safe

- Why both:
  - inline surfaces make problems visible during normal job management
  - a dedicated page prevents the main jobs table from becoming an operator cockpit overloaded with repair controls

## Observability

- Add structured logs for:
  - subprocess launch
  - subprocess exit code
  - quarantine transitions
  - drain completion
  - resume preflight failures
  - delete blocked by retained local state

- Add metrics or snapshot counters for:
  - import success count
  - import failure count
  - quarantined job count
  - retained outbox rows
  - oldest outbox age
  - total SQLite bytes and WAL bytes

- Add warning surfaces where jobs are already surfaced today.

## Implementation Order

1. Schema and model layer.
   - Add `storageState` and import/quarantine metadata to `app.judgment_job`.
   - Thread fields through server route payloads and job service types.
2. Background scope hardening.
   - Keep DB-backed job selection only.
   - Permit background import only for `running` and `draining` jobs.
3. Isolated importer.
   - Add single-job subprocess import path.
   - Capture structured success and failure metadata.
   - Quarantine on crash or repeated failure.
4. Pause/resume lifecycle.
   - Change pause into `pause and drain`.
   - Block resume for `draining` or `quarantined` jobs.
5. Health endpoints.
   - Add aggregate and per-job health payloads with live SQLite counters.
6. UI inline surfaces.
   - Add health summary and badges to `/admin/jobs`.
   - Add `Local Storage Health` card and repair actions to `/admin/jobs/$id`.
7. Dedicated health page.
   - Add `/admin/jobs/health` with filtering, prioritization, and operator actions.
8. Repair tooling.
   - Add admin repair actions and matching CLI/script entrypoint.
9. Cleanup hardening.
   - Add explicit checkpoint and deletion on drained jobs.
   - Ensure paused/completed jobs do not accumulate large retained local state indefinitely.
10. Pathological fallback.

- Add CLI fallback using system `sqlite3` where isolated Bun-native import still cannot safely recover a job.

## Not Now

- Replacing SQLite as the local judgment buffer entirely.
- Reworking the whole judgment pipeline onto another runtime before crash containment is in place.
- Building a general-purpose admin console beyond job reliability needs.

## Done Criteria

- One bad job can no longer crash the worker.
- Paused jobs do not keep growing local outbox state after pause is acknowledged.
- Background automation only touches DB-authorized jobs in importable storage states.
- Quarantined jobs are visible and excluded from automatic processing.
- Operators can inspect and repair a single job without shell-only debugging.
- `/admin/jobs` surfaces job health inline.
- `/admin/jobs/$id` shows local storage health and repair actions.
- `/admin/jobs/health` exists and prioritizes risky jobs.
- Drained jobs are checkpointed and deleted deterministically.
- Existing delete flow remains safe and explicit.

## Quality Gates

- `bun run db:mig`
- `bun test src/server/routes/JudgmentsJobsRoutes.test.ts`
- `bun test src/server/cron/judgmentsJobs/judgmentJobSqliteService.test.ts`
- `bun test src/server/cron/judgmentsJobs/judgmentJobSqliteOutboxImport.test.ts`
- `bun test src/server/cron/judgmentsJobs/judgmentsJobsAddToQueue.test.ts`
- `bun test src/server/cron/judgmentsJobs/requeueAbandonedSentPrompts.test.ts`
- `bun run build`
- `bun run lint`
- Browser verify `/admin/jobs`: health summary renders, non-healthy jobs are easy to spot, and links to details and health page work.
- Browser verify `/admin/jobs/$id`: storage-health card shows live state, quarantine or drain actions update the UI correctly, and resume is blocked when it should be.
- Browser verify `/admin/jobs/health`: filters work, risky jobs sort first, and repair actions produce visible state transitions.
- Local server verify: start the worker with a mix of healthy, paused, draining, and quarantined jobs and confirm the worker stays alive, healthy jobs continue processing, and broken jobs are isolated instead of crashing the process.
