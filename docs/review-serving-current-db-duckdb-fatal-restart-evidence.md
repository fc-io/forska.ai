# Review Serving Current-DB DuckDB Fatal Restart Evidence

This note preserves the operator evidence for the current-DB DuckDB fatal
restart reproduced on branch
`fix/review-serving-current-db-duckdb-restart-20260724`.

## Baseline Evidence

The preserved baseline run is:

```text
.tmp/current-db-restart-fix/baseline-test-dev-server-current-db.log
```

That run executed `bun run test:dev-server:current-db` against the primary
current DB and failed with exit code 1. The precise failing statement came from
`reviewServing.projector.worker` while updating
`app.review_rebuild_request`:

```text
Constraint Error: Duplicate key "request_id: requestless-bootstrap:1ebc7aa3adee6a115c5a0f68" violates unique constraint.
```

Immediately after the constraint error, DuckDB marked indexed-table repair and
restarted the embedded runtime:

```text
[duckdb] restarting embedded runtime after fatal invalidation Constraint Error: Duplicate key "request_id: requestless-bootstrap:1ebc7aa3adee6a115c5a0f68" violates unique constraint.
```

The same log also records the startup recovery artifacts that were generated:

```text
startup-preflight-active-table.json
2026-07-24T03-59-19.043Z.27e4d61e-61f0-4f73-9a89-475714a525aa.pre-repair.duckdb
2026-07-24T03-59-19.043Z.27e4d61e-61f0-4f73-9a89-475714a525aa.recovery.json
```

This is more specific than the earlier forbidden fatal-runtime-restart failure:
the worker attempted to create or adopt a duplicate requestless bootstrap
request id, the duplicate-key error invalidated the embedded DuckDB runtime,
and the recovery path repaired indexed tables on restart.

## Evidence Preservation

Before any recovery or rerun, preserve:

1. The failing `test:dev-server:current-db` log.
2. The DuckDB startup-recovery marker and generated recovery manifest.
3. Any `.pre-repair.duckdb` backup and WAL present at the time of failure.
4. Runtime JSONL logs for the API and maintenance owner, especially entries
   around `reviewServing.projector.worker`.

Do not delete the current DB, WAL, startup-recovery directory, or projector
markers merely to make the stack boot. If files must be moved out of the active
runtime path, stop the stack first and move them to timestamped evidence paths.

## Expected Fix Proof

The runtime fix must prove all of the following:

1. The focused worker tests cover duplicate requestless bootstrap admission or
   adoption without violating the `app.review_rebuild_request` request-id
   uniqueness constraint.
2. `bun run test:dev-server:current-db` completes without forbidden DuckDB fatal
   runtime restart logs.
3. `bun run test:network-smoke:current-db` completes both current-DB phases and
   shows live review-serving progress.
4. Any remaining recovery artifacts are explained, preserved, or cleared only
   after the passing current-DB gate proves the owner and projector are healthy.

## Fix Verification

Two intermediate fixes were intentionally preserved as negative evidence:

```text
.tmp/current-db-restart-fix/fixed-test-dev-server-current-db.log
.tmp/current-db-restart-fix/no-request-row-mutation-test-dev-server-current-db.log
```

The first attempted an `INSERT ... ON CONFLICT(request_id) DO UPDATE` adoption
path and still hit the duplicate request id. The second removed request-row
mutation but kept an indexed equality lookup in `WHERE NOT EXISTS`; on the
current DB, that lookup missed the existing deterministic request row before
DuckDB rejected the insert as a duplicate.

The final fix keeps existing request rows untouched, links requestless chunks to
the deterministic request id, and changes the insert-if-missing guard to use a
full-scan-safe request-id predicate:

```sql
(existing_request.request_id || '') = <request_id>
```

The verified passing logs are:

```text
.tmp/current-db-restart-fix/full-scan-existence-test-dev-server-current-db.log
.tmp/current-db-restart-fix/full-scan-existence-test-network-smoke-current-db.log
```

Verification completed:

```bash
bun test src/server/workers/reviewServingProjectorWorker.test.ts src/server/reviewServing/reviewServingV4RebuildRequestService.test.ts src/server/reviewServing/reviewServingRebuildRequestRepository.test.ts src/server/reviewServing/reviewServingChunkManifestRepository.test.ts
bun test src/server/utils/duckdbServiceReload.test.ts
git diff --check
bun run test:dev-server:current-db
bun run test:network-smoke:current-db
```

The final `test:dev-server:current-db` run passed with no forbidden DuckDB fatal
runtime restart output. The complete `test:network-smoke:current-db` gate also
passed both phases: the read-only audited route smoke and the mutation-enabled
current-DB dev-server smoke.

## Follow-Up Current-DB Rebuild Hardening

PR #164 (`Harden review rebuild current-db recovery`) followed the same current
DB workload after the duplicate requestless-bootstrap fix and found additional
indexed-table mutation hazards:

1. Empty retry-policy aggregation let failed rebuild chunks strand themselves
   instead of falling back to the configured max attempts.
2. Summary finalization, judgment-input rebuilds, queue rebuilds, and display
   payload rebuilds still used scoped delete/update shapes on indexed DuckDB
   tables.
3. Superseded requestless-bootstrap cleanup updated
   `app.review_rebuild_request`, then terminal failure finalization updated the
   same request table again.
4. The warning route counted a superseded `requestless_bootstrap_rebuild`
   request as the active terminal failure even when readable serving rows were
   present.

The fix keeps requestless-bootstrap request rows as evidence, links or
quarantines chunks instead of mutating request rows, excludes terminal
requestless-bootstrap bookkeeping from live failure diagnostics, and changes the
remaining rebuild write paths to avoid indexed scoped deletes.

Preserved runtime recovery manifests for this follow-up include:

```text
~/Library/Application Support/Forska/runtime/primary/forska.duckdb.startup-recovery/2026-07-24T15-28-28.646Z.ad464fbf-37c4-48fe-a435-d8e0957904af.recovery.json
~/Library/Application Support/Forska/runtime/primary/forska.duckdb.startup-recovery/2026-07-24T15-31-07.705Z.9367de5a-6ba5-4029-a240-674fb2229dfa.recovery.json
~/Library/Application Support/Forska/runtime/primary/forska.duckdb.startup-recovery/2026-07-24T15-33-40.097Z.a45bcd3f-a561-4c39-b86a-d199d17d0e3c.recovery.json
~/Library/Application Support/Forska/runtime/primary/forska.duckdb.startup-recovery/2026-07-24T15-37-37.755Z.c3ac22e8-9e33-4a14-b6b6-bad11e1d2d53.recovery.json
```

The verified passing commands for PR #164 were:

```bash
bun test src/server/workers/reviewServingProjectorWorker.test.ts src/server/reviewServing/reviewServingRebuildRequestRepository.test.ts src/server/reviewServing/reviewServingV4RebuildRequestService.test.ts src/server/reviewServing/reviewServingChunkManifestRepository.test.ts src/server/reviewServing/reviewServingDisplayPayloadProjector.test.ts src/server/reviewServing/reviewServingSummaryProjector.test.ts src/server/reviewServing/reviewServingJudgmentPayloadProjector.test.ts src/server/reviewServing/reviewServingDiagnosticsRepository.test.ts src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.test.ts
bun test src/server/utils/duckdbServiceReload.test.ts
bun test src/server/reviewServing/reviewServingRouteParityEvidence.test.ts src/server/reviewServing/reviewServingRouteParityCoverage.test.ts
bun run bench:review-serving-release-gate
git diff --check
bun run test:dev-server:current-db
bun run test:network-smoke:current-db:readonly
bun run test:network-smoke:current-db
```

## Operator Recovery Rules

1. Preserve evidence first; recovery without logs, manifests, and backup paths
   is not sufficient.
2. Stop the split dev stack before copying or moving DuckDB files, WAL files, or
   startup-recovery artifacts.
3. Prefer a restart that lets the documented startup recovery path run and
   records its manifest. Do not silently remove WAL or indexed-table evidence.
4. After recovery, verify API readiness, maintenance-owner readiness, and
   review-serving progress on the current DB workload.
5. If a rerun reports another DuckDB crash, owner failure, fatal restart,
   recovery pause, or stalled review-serving progress, keep the recovery marker
   and report the gate as blocked rather than clearing evidence.
