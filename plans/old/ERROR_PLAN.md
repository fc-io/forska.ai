# DuckDB Archive Error Plan

## Goal

Finish the archived-project refresh work so that it no longer fails in either of these ways:

- `Invalid Input Error: Failed to delete all rows from index`
- `TransactionContext Error: Failed to commit: failed to pin block ... used`

and do not consider the work finished until the server stack has been started and its output has been read long enough to confirm the error no longer appears.

## Current Status

- Earlier work appears to have moved the problem forward: the archive path is no longer primarily blocked on the original in-place delete/index corruption issue.
- The current blocker is now memory pressure during commit in the background mart refresh flow.
- The current follow-on error handling is still noisy and misleading:
  - `rollback failed: TransactionContext Error: cannot rollback - no transaction is active`
- `runtime-unreachable` from SGLang is still separate and should not block fixing the DuckDB archive refresh failure.

## What Seems Done Already

- A direct archive-purge investigation path has been implemented.
- The archive purge path has already been reworked enough to get past the earlier fatal invalidation loop.
- Fatal-restart handling exists, but it now needs to coexist cleanly with commit-time memory failures.

## Remaining Plan

### 1. Lock in the progress already made

- Preserve the current archive-purge fixes and regressions that got the failure past the original delete/index invalidation path.
- Avoid reopening the old `Failed to delete all rows from index` problem while fixing the new commit-memory issue.

### 2. Build a focused repro for the new commit-memory failure

- Reproduce the failure outside the running server stack using the same archived project or an equivalent fixture.
- Identify the exact statement or transaction boundary that triggers:
  - `Failed to commit: failed to pin block`
- Record the table, row volume, and transaction shape involved so the memory failure is reproducible without waiting on periodic queue drain.

### 3. Reduce peak memory usage in the archive refresh path

- Inspect the archive refresh flow for transactions that are still too large to commit within the current DuckDB memory budget.
- Prefer reducing transaction size before only increasing memory limits.
- Specifically evaluate:
  - breaking large archive rebuild or purge work into smaller committed units
  - reducing wide-table rewrite size or commit scope
  - lowering working-set size during rebuild/finalize steps
  - session-level DuckDB tuning only if needed, such as:
    - `SET threads = X`
    - `SET preserve_insertion_order = false`
    - `SET memory_limit = '...GB'`
- If a table-rewrite approach is still required, ensure it is also chunked or otherwise bounded so commit-time memory does not spike again.

### 4. Harden transaction cleanup after commit failure

- Update the background mart refresh transaction flow so a commit-time failure does not produce misleading follow-on noise.
- After a commit failure, do not attempt `ROLLBACK` if no transaction is active.
- Preserve the original memory error as the primary reported failure.
- Only attach follow-on errors when they add real diagnostic value.

### 5. Add regression coverage for the new failure mode

- Add a regression for the commit-memory failure path in the archive refresh flow.
- Add a regression proving the code does not emit a misleading chained error dominated by:
  - `cannot rollback - no transaction is active`
- Add a regression proving the queue can retry cleanly after the chosen memory-safe fix.

### 6. Recover the local environment again if needed

- Clear or repair any queued archive refresh task that is now stuck on the commit-memory failure.
- If needed, add or use a one-off repair path to:
  - inspect `app.mart_refresh_queue`
  - clear the broken retry loop for the archived project under test
  - rerun the refresh after the memory fix is in place

### 7. Start the server and read the output before calling it done

- Start the full local server stack with:

```bash
bun run start:server
```

- Read the live output directly from the started process.
- Do not stop at "server started"; wait long enough for the background mart refresh drain to run.
- Confirm the output does not contain any of these strings during the verification run:
  - `Failed to delete all rows from index`
  - `database has been invalidated because of a previous fatal error`
  - `Failed to commit: failed to pin block`
  - `cannot rollback - no transaction is active`
  - `periodic queue drain failed`
  - `failed to process refresh queue`
- If needed, trigger the archived-project refresh manually and continue reading the output until that specific refresh completes without the DuckDB error.

## Done Criteria

The work is only done when all of the following are true:

- The archive purge path completes without the old delete/index failure.
- The archive refresh path completes without the new commit-memory failure.
- The background mart refresh flow does not emit misleading rollback-after-commit-failure noise.
- The refresh queue drains successfully.
- The server has been started locally.
- The server output has been read after startup and after refresh processing.
- No new occurrences of the DuckDB archive-refresh failure appear in that output.

## Notes

- Treat the SGLang `runtime-unreachable` message as a separate operational issue unless it blocks the specific archive verification flow.
- Prefer solving the memory issue by reducing transaction size and commit scope before relying only on a higher memory limit.
