# DUCKDB_WRITE_RECOVERY_PLAN

## Scope reviewed

- `src/server/utils/duckdbService.ts`
- `src/server/utils/duckdbOwnerLease.ts`
- `src/server/utils/serverRuntimeRole.ts`
- `src/server/utils/duckdbScriptAccess.ts`
- `src/server/services/getDuckdbMartRefreshService.ts`
- `src/server/routes/ProjectsRoutes.ts`
- `src/server/routes/ComparisonProjectsRoutes.ts`
- `src/server/cron/judgmentsJobs/judgmentJobSqliteOutboxImport.ts`

## What is already good

- Writer ownership is explicit via a lease file and heartbeat.
- Startup already retries some recoverable WAL/open failures.
- Fatal invalidation in the embedded runtime triggers a close-and-restart path.
- Snapshots and checkpoints already exist.
- Mart refresh has rollback/retry coverage for several failure modes.
- Judgment-job ingestion already uses a durable SQLite outbox before DuckDB import.

That is a strong base.
The main remaining problem is not “DuckDB cannot recover”.
It is that some higher-level write flows still rely on temporary state that is only recoverable if the process stays alive long enough to clean it up.

## Main recovery gaps

### 1. Temp-table backup + delete + restore patterns

Examples:

- project model change flow in `ProjectsRoutes.ts`
- comparison-project model-id change flow in `ComparisonProjectsRoutes.ts`

If the process dies in the middle of those flows, temp tables are gone but some permanent rows may already have been deleted.

### 2. Canonical write commit can succeed before mart refresh is queued

Several routes/services currently:

- commit app-table changes
- call `queueProjectRefresh(...)` or `queueJudgmentArticleRefresh(...)` afterwards

If the process dies in between, marts can stay stale indefinitely until some later unrelated refresh happens.

### 3. No durable mutation journal for multi-phase writes

The repo has durable queues for some async work, but not a general “operation ledger” for multi-step canonical writes.

### 4. Recovery is mostly local to each feature

There are good feature-specific tests, but there is not yet one shared startup/invariant pass that says:

- here are incomplete operations
- here are stale queues
- here are mismatched generations
- here is how to resume or repair them

## Plan

### 1. Add a durable write-operation journal

Create an `app.write_operation` table for any mutation that cannot be expressed as one ordinary transaction.

Suggested fields:

- `id`
- `operation_type`
- `entity_type`
- `entity_id`
- `phase`
- `payload_json`
- `started_at`
- `updated_at`
- `completed_at`
- `last_error`
- `attempt_count`

Rules:

- if a write spans multiple transactions, record intent first
- each phase must be restartable or compensatable
- boot-time recovery scans unfinished rows

## 2. Replace TEMP backups with durable backups or shadow-state swaps

If a flow still needs backup/restore semantics, do not rely on TEMP tables.

Prefer one of these:

### Preferred

- immutable revision/config rows
- shadow table + swap/finalize

### If that is not yet possible

- durable backup table keyed by `operation_id`
- explicit cleanup after successful completion
- recovery scanner that can restore or finish pending operations after restart

## 3. Move mart queue writes into the same transaction as canonical mutations

For any mutation that needs mart maintenance:

- write the queue row while still inside the canonical control-lane transaction
- treat queue insertion as part of the commit contract

That gives recovery a durable source of truth for “what must still be rebuilt”.

## 4. Add a boot-time invariant scanner

On startup of the writer process, scan for:

- unfinished `write_operation` rows
- stale mart refresh queue rows older than policy
- generation mismatches in review-serving tables
- leftover durable backup rows
- stale writer lease conditions
- canonical rows with impossible/null-critical relationships

Each invariant should have one of three outcomes:

- auto-repair
- safe quarantine + alert
- fail-fast with a precise operator message

## 5. Extend generation/staging beyond review-serving tables

The current generation-swap approach for review-serving tables is one of the strongest parts of the design.
Use the same idea for more project-level marts so readers stay on last-good data until a full rebuild succeeds.

Good targets:

- `mart.project_scope_article`
- `mart.prompt_answer_fact`
- `mart.review_article_rollup`
- other project-level derived tables that are currently deleted/reinserted directly

## 6. Make mart refresh state more inspectable and recoverable

The mart queue already gives a good base.
Extend it with more recovery metadata:

- `attempt_count`
- `claimed_at`
- `claimed_by`
- `last_error`
- optional `last_completed_step`

That would make it easier to:

- distinguish “queued”, “in progress”, “failed”, and “retryable”
- resume safely after crash
- debug repeated rebuild failures

## 5. Turn checkpoint/snapshot into policy, not only escape hatches

Add a clear policy for when to checkpoint and snapshot:

- before migrations that rebuild/drop tables
- before the heaviest canonical rewrites
- after large append/import bursts if WAL growth crosses a threshold
- after major mart rebuild batches if recovery time would otherwise balloon

Do not rely only on manual operator judgment.

## 6. Add fault-injection recovery tests

Add explicit tests for:

- crash after backing up related rows but before delete
- crash after delete but before restore
- crash after parent update but before restore
- crash during comparison-project multi-step edit
- crash during background mart transaction
- fatal invalidation during append-lane pressure
- stale writer lease takeover during queued refresh work

The goal is to prove restart safety, not just happy-path correctness.

## 7. Keep canonical app tables the source of truth for full rebuilds

When recovery gets complicated, the safest fallback is:

- rebuild marts from canonical app tables
- replay durable queues/outboxes
- restore from snapshots only when canonical tables themselves are at risk

That means canonical write flows must stay simpler and more durable than mart flows.

## 8. Add operator-facing recovery runbooks

Document:

- how to confirm who owns the writer lease
- how to take a snapshot safely
- how to inspect pending write operations
- how to inspect stalled mart queue work
- how to force a clean mart rebuild
- when to use snapshot restore vs queue replay vs invariant repair

## Guardrails

- Do not rely on process-local TEMP state for anything that matters after a crash.
- Do not add broad automatic retries for non-idempotent user writes.
- Prefer restartable phases over “best effort cleanup in catch blocks”.
- Keep marts rebuildable from canonical state.

## Suggested rollout order

1. durable operation journal
2. remove TEMP-backed canonical recovery flows
3. boot-time invariant scanner
4. richer mart queue recovery metadata
5. checkpoint/snapshot policy
6. fault-injection tests and operator runbooks

## Acceptance checks

- killing the writer mid-operation does not silently lose canonical relationships
- startup can identify and explain incomplete multi-step writes
- mart refresh failures are restartable and diagnosable
- snapshots/checkpoints are policy-driven for the highest-risk operations
