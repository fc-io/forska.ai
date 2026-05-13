# Request Attempt Closeout Backfill Plan

## Goal

Make legacy `token_use` closeout projection automatic, bounded, and resumable.
The app must work out of the box without user-run maintenance, startup must not
block on historical scans, and stale cleanup must remain projection-only.

## Current Snapshot

| Table | Count |
|---|---:|
| `app.token_use` | `849,395` |
| `app.token_use` rows with `request_attempts_json` | `101,867` |
| `app.request_attempt_closeout` | `0` |
| `app.request_attempt_closeout_backfill_state` | `0` |
| `app.provider_admission_lease` | `0` |

Current `request_attempts_json` text volume is about `135 MB`. This is manageable now, but the design must hold at `10M+` `token_use` rows.

## Fixed Decisions

| Item | Decision |
|---|---|
| Backfill ownership | DuckDB-owning maintenance runtime only |
| Wake interval | Every `30s` |
| Batch size | `1000` `token_use` rows |
| Max work per wake | `5` batches, `5000` rows total |
| Candidate filter | `request_attempts_json IS NOT NULL` |
| Progress | Persist after every batch |
| Startup behavior | Never run full historical backfill synchronously |
| Cleanup behavior | Remains projection-only and never queries `app.token_use` |
| Maintenance script | Optional debugging only, never required for correctness |

## Implementation

### 1. Extend Backfill State

Add a DuckDB migration extending `app.request_attempt_closeout_backfill_state`.

| Column | Purpose |
|---|---|
| `cursor_created_at` | Last processed `token_use.created_at` |
| `cursor_token_use_id` | Last processed `token_use.id` |
| `started_at` | First automatic run timestamp |
| `last_run_at` | Last successful progress timestamp |
| `last_error` | Last failure message |

### 2. Bound The Backfill Query

Change the batch SQL to scan only legacy rows that can produce closeout projections.

```sql
WHERE request_attempts_json IS NOT NULL
  AND <cursor clause>
  AND <high-water clause>
ORDER BY created_at, id
LIMIT 1000
```

### 3. Persist Progress Per Batch

Each successful batch updates the state row before the next batch starts.

| Field | Update |
|---|---|
| `cursor_created_at` | Last row in batch |
| `cursor_token_use_id` | Last row in batch |
| `scanned` | Increment by batch row count |
| `attempted` | Increment attempted closeouts |
| `projected` | Increment projected closeouts |
| `batches` | Increment by `1` |
| `last_run_at` | `current_timestamp` |
| `last_error` | `NULL` |

Set `completed_at` only when a batch returns fewer than `1000` rows before the captured high-water mark.

### 4. Remove Blocking Startup Backfill

Remove this startup call.

```ts
await backfillRequestAttemptCloseoutsOnStartup()
```

Keep this startup reconciliation.

```ts
await reconcileProviderAdmissionLeasesForDurableCloseout()
```

### 5. Add Automatic Background Scheduler

Add a scheduler owned by the DuckDB-writing maintenance runtime.

| Rule | Behavior |
|---|---|
| Runtime | Runs only when current server can own DuckDB |
| Interval | Fires every `30s` |
| Work limit | Processes `5` batches per wake |
| Failure | Records `last_error`, logs once per wake, retries next wake |
| Completion | Stops doing work after `completed_at` is set |

### 6. Preserve Immediate Projection For New Writes

Keep the existing `tokenUseQueryService.ts` behavior that calls `projectRequestAttemptCloseoutsForTokenUse` inside `token_use` insert transactions.

### 7. Keep Cleanup Projection-Only

Keep `judgmentsJobsCleanupStale.ts` using `app.request_attempt_closeout`. Do not add any `app.token_use`, `request_attempts_json`, or JSON text lookup path back to stale cleanup.

## Tests

| Test | Requirement |
|---|---|
| Non-null filter | Backfill ignores rows where `request_attempts_json IS NULL` |
| Cursor persistence | First run stores cursor after each batch |
| Resume | Second run starts after stored cursor |
| Completion | Final run sets `completed_at` |
| Startup | Startup does not run full backfill |
| Cleanup | `judgmentsJobsCleanupStale.ts` does not query `app.token_use` |
| New writes | New `token_use` inserts still project closeouts immediately |

## Quality Gates

- `bun run db:mig`
- `bun test src/server/services/requestAttemptCloseoutService.test.ts`
- `bun test src/server/cron/judgmentsJobs/judgmentsJobsCleanupStale.test.ts`
- `bun run lint`

## Success Criteria

- App startup is not proportional to historical `app.token_use` size.
- Legacy closeout projection completes automatically without user action.
- Backfill progress survives crashes and restarts.
- Per-minute stale cleanup never scans JSON or `app.token_use`.
- New `token_use` rows continue to project closeouts immediately.
