# DuckDB Archive Error Plan

## Goal

Stop the archived-project refresh from poisoning DuckDB with:

- `Invalid Input Error: Failed to delete all rows from index`
- `database has been invalidated because of a previous fatal error`

and do not consider the work finished until the server stack has been started and its output has been read long enough to confirm the error no longer appears.

## Scope

- Primary issue: DuckDB failure while purging archived project mart rows, currently seen in `mart.review_article_serving`.
- Secondary noise: `runtime-unreachable` from SGLang. This is a separate runtime availability problem and should not block fixing the DuckDB archive failure.

## Plan

### 1. Reproduce the failing delete outside the running server

- Write a small script that targets the exact failing project/table/row pattern from the logs.
- Use the current local DuckDB file and confirm whether a direct delete on `mart.review_article_serving` still fails for the archived project.
- Log the exact statement shape and the exact row identifiers involved so the failure is reproducible without waiting for the background queue.

### 2. Verify the real failure mode

- Confirm whether the failure is caused by:
  - a primary-key/index corruption bug in DuckDB for in-place deletes, or
  - our transaction/retry logic making recovery worse after the first fatal error.
- Specifically test these operations against `mart.review_article_serving`:
  - single-row `DELETE`
  - `DELETE` by project only
  - table rewrite via `CREATE TABLE ... AS SELECT ... WHERE project_id != ...`

### 3. Replace in-place purge with table rewrite if delete remains unsafe

- If even single-row deletes fail, stop trying to delete archived rows from `mart.review_article_serving` in place.
- Implement a safer rewrite strategy for affected mart tables:
  - create a replacement table containing rows for all other projects
  - recreate the required primary key and indexes
  - swap the replacement table into place
- Keep this isolated to archive purge paths so normal refresh behavior does not change unnecessarily.

### 4. Harden fatal-error handling

- Update the mart-refresh background transaction flow so a fatal DuckDB invalidation does not produce misleading follow-on rollback errors like `TransactionContext Error: cannot rollback`.
- After a fatal invalidation:
  - stop the current background transaction flow immediately
  - restart the embedded DuckDB runtime once
  - avoid attempting rollback on an already-invalidated connection

### 5. Add regression coverage

- Add a focused regression for the exact archive failure scenario using the same shape as the logged failing row.
- Add a regression proving that a fatal invalidation during mart purge does not leave the queue permanently failing on retry.
- Add a regression for the final remediation path chosen in step 3.

### 6. Recover the local environment

- Clear or repair any already-poisoned queued archive task that keeps retriggering the failure.
- If needed, add a one-off repair script to:
  - inspect queued project refreshes
  - purge the failing archived project safely
  - confirm `app.mart_refresh_queue` no longer contains the broken retry loop

### 7. Start the server and read the output before calling it done

- Start the full local server stack with:

```bash
bun run start:server
```

- Read the live output directly from the started process.
- Do not stop at "server started"; wait long enough for the background mart refresh drain to run.
- Confirm the output does **not** contain any of these strings:
  - `Failed to delete all rows from index`
  - `database has been invalidated because of a previous fatal error`
  - `periodic queue drain failed`
  - `failed to process refresh queue`
- If needed, trigger the archived-project refresh manually and continue reading the output until that specific refresh completes without the DuckDB error.

### 8. Done criteria

The work is only done when all of the following are true:

- The archive purge path completes without the DuckDB delete/index failure.
- The refresh queue drains without repeated fatal invalidation logs.
- The server has been started locally.
- The server output has been read after startup and after refresh processing.
- No new occurrences of the DuckDB fatal invalidation appear in that output.

## Notes

- The `runtime-unreachable` SGLang message should be tracked separately unless it blocks the archive test scenario.
- If table rewrite is required, prefer rebuilding only the affected mart tables instead of broader database surgery.
