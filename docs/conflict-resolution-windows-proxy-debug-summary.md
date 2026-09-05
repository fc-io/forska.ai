# Conflict Resolution Windows Proxy Debug Summary

Status as of 2026-09-04: all fixes below are merged into `main`. The latest merged commit is `7269eb88447e904c666b96851261d65e61ab1294` (`chore(api): log DuckDB owner proxy failures`).

## User-Visible Bug

Windows user could not reliably change comparison-project conflict resolution, especially while reviewing Chinese articles. Browser request:

- `POST /api/comparison-projects/:id/conflict-resolution`
- Response: `502 Bad Gateway`
- Body: `{"data":null,"error":"DuckDB owner proxy target unavailable"}`

Related UI symptoms were also reported:

- Changing a conflict resolution blinked between old and new state.
- After a short delay, visible conflict-resolution selects could all show `yes`.
- Conflict-resolution changes were slow enough to feel broken.

## What Has Been Fixed

### PR #386 - Retain Edited Conflict Rows

PR: https://github.com/fc-io/forska.ai/pull/386

Merged commit: `ede51b6e301363072696a78c5179d9611ba676f8`

Fixed the filtered comparison view so an edited conflict-resolution row stays visible after changing its resolution, even if it no longer matches the active conflict-resolution filter. Page refetch is deferred while the filter is active, and retained rows are cleared when the comparison, page size, or filters change.

Verified with:

- `bun test src/utils/comparisonProjectRetainedJudgmentRows.test.ts`
- touched-file ESLint
- `git diff --check`
- `bunx --bun vite build`
- GitHub topology on Ubuntu, macOS, and Windows

### PR #389 - Tolerate Owner Restarts For Reads

PR: https://github.com/fc-io/forska.ai/pull/389

Merged commit: `8f57e8352a5f3842df5be85428276598852a1c34`

Fixed transient `DuckDB owner proxy target unavailable` errors for owner-backed idempotent reads during maintenance/DuckDB-owner restarts. The API now waits/retries read proxying through restart windows. Generic non-idempotent mutations remained conservative.

Also capped Windows maintenance-worker DuckDB default memory to the stable `6400MiB` profile unless explicitly overridden.

Verified with:

- `bun test src/server/routes/ApiProxyRoutes.retry.test.ts`
- `bun test src/server/routes/ApiProxyRoutes.test.ts src/server/routes/apiRouteClassification.test.ts src/server/routes/runtimeReadyRoutes.test.ts`
- `bun test src/server/routes/ApiProxyRoutes.retry.test.ts src/server/utils/backgroundServerStack.test.ts`
- touched-file ESLint
- `git diff --check`
- `bunx --bun vite build`
- `bun run test:dev-server:current-db`
- GitHub topology on Ubuntu, macOS, and Windows

Note: unrelated broader DuckDB subprocess-focused suites failed locally by exiting spawned `bun -e` helpers with empty stdout before assertions; the focused split-stack current DB smoke passed.

### PR #390 - Remove Select Blink

PR: https://github.com/fc-io/forska.ai/pull/390

Merged commit: `b7864b7c12154a6d3321489e11d4a0c2e612950c`

Fixed the UI blink where the select could briefly revert to the old row value after changing resolution. The page now updates the visible row optimistically before the save/reset request resolves, reverts if the request fails, and no longer forces the select value through a queued microtask.

Verified with:

- `bunx vitest run src/components/main/comparisonProjectJudgmentsTable/comparisonProjectJudgmentsTable.vitest.tsx`
- `bun test src/utils/comparisonProjectRetainedJudgmentRows.test.ts`
- `bun test src/server/routes/ComparisonProjectsRoutes.rollback.test.ts -t "conflict resolution"`
- touched-file ESLint
- `git diff --check`
- `bunx --bun vite build`
- GitHub topology on Ubuntu, macOS, and Windows

### PR #391 - Retry Conflict-Resolution Proxy Mutations

PR: https://github.com/fc-io/forska.ai/pull/391

Merged commit: `bd72589eb7aa9765359fbc1b7b393c27f6a6ef2c`

Made only the comparison-project conflict-resolution save/reset POST routes replay-safe in the API owner proxy. These routes wait for DuckDB owner readiness before first forward and can retry after owner transport failure because they are deterministic:

- save is an upsert to the requested final resolution
- reset is a keyed delete

Generic POST mutations are still not retried.

Verified with:

- `bun test src/server/routes/ApiProxyRoutes.retry.test.ts`
- `bun test src/server/routes/ApiProxyRoutes.test.ts src/server/routes/apiRouteClassification.test.ts`
- `bun test src/server/routes/ComparisonProjectsRoutes.rollback.test.ts -t "conflict resolution"`
- touched-file ESLint
- `git diff --check`
- `bunx --bun vite build`
- GitHub topology on Ubuntu, macOS, and Windows

### PR #392 - Keep Selects Row-Scoped

PR: https://github.com/fc-io/forska.ai/pull/392

Merged commit: `9a8c9719e6189bd79c58a4e3400ac6dbf7b48bc3`

Fixed the UI bug where all visible conflict-resolution selects could eventually show `yes`. The browser now explicitly marks the matching option as selected, and optimistic updates are scoped by `canonicalArticleId` consistently.

Verified with:

- multi-row component regression covering `maybe`, `no`, and unset rows after changing only one row to `yes`
- `bunx vitest run src/components/main/comparisonProjectJudgmentsTable/comparisonProjectJudgmentsTable.vitest.tsx`
- `bun test src/utils/comparisonProjectRetainedJudgmentRows.test.ts`
- touched-file ESLint
- `git diff --check`
- `bunx --bun vite build`
- GitHub topology on Ubuntu, macOS, and Windows

### PR #393 - Harden Conflict-Resolution Saves

PR: https://github.com/fc-io/forska.ai/pull/393

Merged commit: `86dbc466206492798d5ee9a74fa31639c362b13a`

Went deeper on the remaining Windows 502. Fixed these issues:

- Conflict-resolution POSTs now wait for owner URL discovery instead of failing immediately when owner discovery briefly returns `null`.
- Pre-forward waits require actual DuckDB-owner runtime readiness and rediscover moved owners before forwarding.
- Conflict-resolution save/reset no longer block on foreground DuckDB `CHECKPOINT`; they schedule a coalesced deferred checkpoint.
- Conflict-resolution eligibility validation uses the active serving row (`has_conflict`) when available instead of hydrating full judgment rows.
- UI pending state clears after the save/reset itself; stats/metadata/page refreshes happen in the background.

Verified with:

- `bun test src/server/routes/ApiProxyRoutes.retry.test.ts`
- `bun test src/server/routes/ApiProxyRoutes.test.ts src/server/routes/apiRouteClassification.test.ts`
- `bun test src/server/routes/ComparisonProjectsRoutes.rollback.test.ts`
- `bunx vitest run src/components/main/comparisonProjectJudgmentsTable/comparisonProjectJudgmentsTable.vitest.tsx`
- touched-file ESLint
- `git diff --check`
- `bunx --bun vite build`
- `bun run test:dev-server:current-db`
- GitHub topology on Ubuntu, macOS, and Windows

### PR #394 - Discover Owner Lease From API Role

PR: https://github.com/fc-io/forska.ai/pull/394

Merged commit: `285afad15117a888a5a20f54a306181a7813181a`

Fixed a concrete remaining proxy hole: an explicit API-role process with no `SERVER_DUCKDB_OWNER_URL` could fail closed instead of discovering the active maintenance/DuckDB-owner process from the owner lease.

Also fixed:

- conflict-resolution retry-after-drop now waits for full owner readiness before replaying the deterministic POST
- trailing-slash conflict-resolution paths are normalized so they stay on the replay-safe retry path

Verified with:

- `bun test src/server/routes/ApiProxyRoutes.retry.test.ts`
- `bun test src/server/routes/ApiProxyRoutes.test.ts src/server/routes/apiRouteClassification.test.ts`
- `bun test src/server/routes/ComparisonProjectsRoutes.rollback.test.ts -t "conflict resolution"`
- touched-file ESLint
- `git diff --check`
- `bunx --bun vite build`
- `bun run test:dev-server:current-db`
- GitHub topology on Ubuntu, macOS, and Windows

### PR #395 - Add Targeted Diagnostics

PR: https://github.com/fc-io/forska.ai/pull/395

Merged commit: `7269eb88447e904c666b96851261d65e61ab1294`

This PR is intentionally diagnostic. It does not claim a new root-cause fix. It adds rate-limited structured logs around the API DuckDB-owner proxy so the next Windows report should identify the exact failing branch instead of only surfacing the generic browser 502.

It logs these stages:

- no owner URL discovered
- discovered owner URL points back to the API itself
- owner readiness timeout
- first forward transport failure
- retry forward failure
- owner returned a 5xx response, with a bounded owner error body preview

The logs explicitly label conflict-resolution save/reset routes so the failure can be distinguished from generic owner proxy traffic.

Verified with:

- `bun test src/server/routes/ApiProxyRoutes.retry.test.ts`
- `bun test src/server/routes/ApiProxyRoutes.test.ts src/server/routes/apiRouteClassification.test.ts`
- `bun test src/server/routes/ComparisonProjectsRoutes.rollback.test.ts -t "conflict resolution"`
- touched-file ESLint
- `git diff --check`
- `bunx --bun vite build`
- GitHub topology on Ubuntu, macOS, and Windows

Windows initially failed once in the topology provider-admission evidence path with an existing-looking SQLite/provider lease race (`database is locked`, stale completion replay). The failed Windows job was rerun; the rerun passed. PR #395 was then rebase-merged.

## Current Working Theory

There have been multiple real bugs rather than one bug:

- Some were UI state bugs around select rendering, optimistic updates, and filtered retained rows.
- Some were API proxy bugs around owner target discovery, readiness waiting, replay-safe mutation handling, and owner lease discovery.
- Some were performance/lifecycle risks around foreground DuckDB checkpointing on every conflict-resolution click.

After PR #395, if the same browser 502 still appears, the important next step is not another blind retry. The new logs should tell which branch is still failing.

## What To Ask The Windows User To Do Now

1. Update to latest `main`:

   ```bash
   git fetch origin
   git switch main
   git pull --ff-only
   ```

2. Stop any old running Forska processes.

3. Start again:

   ```bash
   bun run dev:start
   ```

4. Reproduce the conflict-resolution change once.

5. Capture the shell logs from around the failed click, especially lines containing:

   - `[api:duckdb-owner-proxy]`
   - `[duckdb-owner]`
   - `[server:stack]`
   - `[judgments]`
   - `conflict-resolution`
   - `owner proxy`
   - `ready`
   - `target unavailable`

6. Also capture the browser Network response for the failing POST:

   - request URL
   - status
   - response body
   - timing if available

## How To Interpret The New Logs

If the log says owner URL discovery failed, then the API cannot see the owner lease or static owner URL. Next checks:

- Does the maintenance worker start?
- Does it write the DuckDB owner lease?
- Is the API looking at the same runtime directory as the maintenance worker?
- Are there stale processes from another checkout/runtime?

If the log says the owner URL points back to the API itself, then runtime role/port configuration is wrong. Next checks:

- API should be on `3001`.
- Maintenance/DuckDB owner should usually be on `3002`.
- `SERVER_DUCKDB_OWNER_URL` must not point at the API port.

If the log says owner readiness timed out, then the owner exists but never reaches `ready=true`. Next checks:

- Earlier owner logs for migration, checkpoint, WAL replay, DuckDB open, or memory errors.
- Whether the owner process exits/restarts during startup.
- Whether Windows antivirus/file locking is touching the runtime DuckDB files.

If the log says first forward failed, then the API had a ready owner URL but the request transport dropped while forwarding. Next checks:

- Did the owner process exit exactly during the POST?
- Did the retry run?
- Did the retry discover a new owner URL?

If the log says retry forward failed, then the owner either dies repeatedly or the route is consistently failing during replay. Next checks:

- owner process lifecycle around the retry
- full owner-side stack trace
- whether the failure is tied to this exact project/article payload

If the log says owner returned 5xx, then the proxy itself worked and the bug is inside the maintenance owner route. Next checks:

- owner error body preview from the new diagnostic log
- full owner-side stack trace
- conflict-resolution route validation and DuckDB mutation path
- payload fields for the Chinese article, including canonical article ID and resolution value

## Next Fix Direction If It Still Fails

Use the new diagnostics to choose one of these, in order:

1. Owner discovery failure: inspect the runtime directory/lease path and patch API/maintenance runtime-directory agreement.
2. Owner readiness timeout: instrument owner startup readiness blockers and preserve WAL/migration/checkpoint evidence.
3. Owner dies during POST: add owner-side route logging around conflict-resolution validation, upsert/delete, and deferred checkpoint scheduling; then reproduce against the user's project DB if available.
4. Owner 5xx: fix the maintenance-owner conflict-resolution handler, not the proxy.
5. Repeated SQLite/provider lease failures in topology: separate PR for provider-admission lease serialization; this was observed once in CI but was not the PR #395 code path.

The key rule: do not add another broad retry without knowing which stage failed. The route is already treated as replay-safe where appropriate; another retry would only mask the real owner lifecycle or route failure.
