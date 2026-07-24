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
