# Request Attempt Closeout Plan

## Context

Covidence project creation failed because the judgment cleanup cron used the shared
DuckDB runtime to search historical `app.token_use.request_attempts_json` JSON.
The Covidence route does not depend on token-use data, but both paths share the
same embedded DuckDB process and memory limit.

The current mitigation limits lookup input to active provider request leases, but
the cleanup path can still scan `app.token_use` with `contains(CAST(...))`
predicates. That is not a durable fix. The steady-state cleanup cron must stop
looking up request-attempt closeout evidence from JSON blobs.

## Goal

Make request-attempt closeout lookup keyed and bounded so background judgment
cleanup cannot OOM DuckDB or block unrelated foreground API routes.

## Success Criteria

- `judgmentsJobsCleanupStale.ts` releases request leases from keyed closeout rows
  and SQLite closeout proofs, not from `app.token_use` JSON scans.
- Token-use persistence writes a compact relational closeout projection in the
  same DuckDB runtime whenever `request_attempts_json` contains durable terminal
  evidence.
- Token-use persistence and closeout projection writes are atomic, or failed
  projection writes are recoverable by the bounded rebuild before cleanup relies
  on the projection only.
- Existing durable token-use evidence is handled by a clear bounded rebuild or
  cutover, not by a permanent cleanup-time fallback.
- The projection is rebuildable from raw durable evidence, so raw
  `app.token_use.request_attempts_json` remains the audit source.
- No provider/model/thinking/runtime settings are retried, downgraded, or mutated
  to make cleanup succeed.

## Proposed Design

Add a relational DuckDB projection for durable terminal request-attempt evidence:

```sql
CREATE TABLE app.request_attempt_closeout (
  request_attempt_id VARCHAR NOT NULL,
  provider_key VARCHAR NOT NULL,
  closeout_kind VARCHAR NOT NULL,
  durable_closeout_kind VARCHAR NOT NULL,
  durable_closeout_id VARCHAR,
  durable_closeout_ref_json JSON,
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY (request_attempt_id, provider_key),
  CHECK (length(trim(request_attempt_id)) > 0),
  CHECK (length(trim(provider_key)) > 0),
  CHECK (length(trim(closeout_kind)) > 0),
  CHECK (length(trim(durable_closeout_kind)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_app_request_attempt_closeout_provider_request
ON app.request_attempt_closeout(provider_key, request_attempt_id);
```

Keep `app.token_use.request_attempts_json` as raw durable evidence. Use
`app.request_attempt_closeout` as the compact lookup table.

The projection helper should use the same durable-terminal predicate as
`getDurableTerminalRequestAttemptCloseoutProofs(...)`. Extend that helper or add
a sibling helper so closeout rows include `closeoutKind`, `durableCloseoutRef`,
and `finishedAt` or `updatedAt` as `closed_at` when present.

Conflict behavior:

- Keep one projection row per `(request_attempt_id, provider_key)` because cleanup
  only needs to know that a provider request attempt has durable terminal
  evidence.
- Treat source fields as diagnostic metadata. Prefer the earliest durable
  terminal evidence by `closed_at`, then `created_at`, then stable source id.
- On conflict, keep existing non-null diagnostic fields unless the incoming row
  has an earlier deterministic closeout timestamp. Always refresh `updated_at`.
- The bounded rebuild must apply the same ordering and conflict rule so rebuilds
  are deterministic.

## Implementation Steps

1. Add `src/db/duckdbMigrations/0071_requestAttemptCloseout.sql` for
   `app.request_attempt_closeout`.
2. Add a small request-attempt closeout projection service that:
   - parses request attempts with the existing manifest helpers,
   - extracts only durable terminal closeouts,
   - upserts by `(request_attempt_id, provider_key)`,
   - no-ops for missing or non-terminal request attempts.
3. Wire projection writes into `tokenUseQueryService.insertTokenUse(...)` and
   `insertTokenUseOnce(...)` inside the same DuckDB transaction as the
   `app.token_use` insert whenever possible. On idempotent replay, still ensure
   the projection exists from the canonical stored `requestAttemptsJson`.
4. Wire projection writes into legacy token-use evidence repair when it updates
   `app.token_use.request_attempts_json`.
5. Add a bounded rebuild maintenance script or service method that rebuilds
   `app.request_attempt_closeout` from `app.token_use` in small ordered batches
   of `id`, `request_attempts_json`, and timestamps. Parse request attempts in
   TypeScript rather than DuckDB JSON/text predicates. This is the cutover path
   for existing rows.
   - In maintenance mode, truncate and rebuild in batches while token-use writers
     are stopped.
   - Outside maintenance mode, rebuild into a staging table and atomically swap
     or copy into the live projection after the staging table is complete.
6. Update `judgmentsJobsCleanupStale.ts` so DuckDB closeout lookup joins active
   `app.provider_admission_lease` request leases to
   `app.request_attempt_closeout` on `(provider_key, request_attempt_id)`.
7. Delete the cleanup-time token-use JSON fallback and related helpers from
   `judgmentsJobsCleanupStale.ts`.
8. Add tests for projection insert idempotency, token-use replay repair, bounded
   rebuild, cleanup release from closeout rows, and absence of token-use JSON
   lookup in cleanup.
9. Add the shared DuckDB runtime safety note to `AGENTS.md` so future background
   work avoids unbounded JSON or historical-table scans.

## Cutover

Do not keep a permanent runtime compatibility path in the cleanup cron. Treat
`app.request_attempt_closeout` as rebuildable intermediate state.

Recommended cutover:

1. Deploy the migration and projection writer while cleanup still has the
   existing bounded token-use fallback.
2. Run the bounded rebuild once in maintenance mode, or run a staging-table
   rebuild and atomically publish the completed projection.
3. Verify new token-use writes create projection rows after the rebuild.
4. Deploy the cleanup change that reads only the projection table and SQLite
   closeout proofs.
5. If the rebuild is intentionally skipped in a development database, clear or
   rebuild obsolete active request leases explicitly instead of adding a
   cleanup-time `app.token_use` JSON fallback.

If the writer cannot be deployed before the rebuild, keep judgment/token-use
writers stopped for the whole migration, rebuild, and cleanup cutover window so
no token-use rows are written without projection rows.

## Shared DuckDB Runtime Safety

Add this subsection under `## Database` in `AGENTS.md`:

```md
### Shared DuckDB Runtime Safety

- Treat foreground API routes, cron jobs, queues, marts, and maintenance tasks as sharing one constrained DuckDB runtime.
- Do not add unbounded scans over JSON, text, or historical tables in background jobs.
- Scope background work by active rows, project, dirty token, cursor, batch limit, or explicit time window.
- If data will later be looked up by key, persist that key relationally instead of only inside JSON.
- Prefer compact lookup/projection tables for queue, lease, lifecycle, and mart maintenance state.
- Keep cron ticks bounded with a max batch/work budget and make partial progress safe.
- Treat raising `DUCKDB_MEMORY_LIMIT` as an emergency mitigation, not the root fix.
- For changes that can run alongside imports or UI requests, consider shared DuckDB memory impact and call out the foreground and background flows checked.
```

## Quality Gates

- `bun run db:mig` passes after adding the migration.
- `bun test src/server/services/requestAttemptCloseoutService.test.ts` passes.
- `bun test src/server/services/tokenUseQueryService.test.ts` passes.
- `bun test src/server/cron/judgmentsJobs/judgmentsJobsCleanupStale.test.ts`
  passes.
- `bun test src/server/cron/judgmentsJobs/judgmentLegacyEvidenceRepair.test.ts`
  passes.
- `bun test src/server/cron/judgmentsJobs/judgmentRequestAttemptLifecycle.test.ts`
  passes if manifest helper types or extraction behavior changes.
- `bun test src/server/services/covidenceImportService.test.ts` passes.
- `bun test src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostCovidenceCreate.test.ts src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostCovidence.test.ts`
  passes.
- `bun run lint` passes, or unrelated pre-existing lint failures are explicitly
  listed.
- Web verification: with cleanup enabled and a seeded durable closeout, the
  Covidence create/import flow succeeds and server output shows no DuckDB OOM.
- Desktop verification: run `bun run desktop:build` if the implementation is
  being prepared for a desktop-shipped branch; otherwise record why it was
  skipped and note that desktop uses the same migration and server cleanup path.
