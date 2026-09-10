# DuckDB Compaction Admin UI Plan

## Goal

Add a built-in admin page for DuckDB compaction at `/admin/duckdb-compaction`, linked from the existing admin navigation. The page should show:

- the current primary DuckDB size and WAL state;
- the expected compaction benefit in GB/GiB before running;
- disk headroom and whether a compaction run is safe to start;
- current or last compaction run status;
- old temporary/outdated Forska files that match reliable, explainable patterns;
- a guarded button to execute compaction.

## Existing integration points

- Admin navigation: `src/components/Navigation.tsx`
  - Add `DuckDB Compaction` to the System admin section near `DuckDB Append Metrics`.
- Frontend route: add `src/app/routes/+admin/+duckdb-compaction/+index.tsx`
  - Follow the existing Solid/TanStack file-route style used by `+admin/+duckdb-append/+index.tsx` and `+admin/+duckdb-owner-connections/+index.tsx`.
- API aggregation: `src/server/routes/productApiRoutes.ts`
  - Add a focused admin route module, for example `src/server/routes/DuckdbCompactionRoutes.ts`.
- Route inventory: `src/server/routes/routeSurfaceInventory.ts`
  - Classify the status endpoint as local/admin maintenance diagnostics.
  - Classify the execute endpoint as sensitive local admin maintenance because it can rewrite/swap the primary DB and clean generated artifacts.
- Exclusive DuckDB work guard: `src/server/utils/duckdbExclusiveWork.ts`
  - Extend the existing exclusive-work model instead of inventing a parallel lock.
  - Add a kind such as `duckdb_compaction` and phases such as `analyze`, `checkpoint`, `export`, `import`, `validate`, `swap`, and `cleanup`.

## API shape

Add two core endpoints:

```ts
GET /api/admin/duckdb-compaction
POST /api/admin/duckdb-compaction/runs
```

`GET /api/admin/duckdb-compaction` should return all data needed to render the page without starting work:

```ts
type DuckdbCompactionStatus = {
  database: {
    path: string;
    fileBytes: number;
    databaseSizeBytes: number;
    blockSizeBytes: number;
    usedBlockBytes: number;
    freeBlockBytes: number;
    walBytes: number;
    conservativeReclaimBytes: number;
    estimatedRewriteSavingsBytes: number | null;
    hasWal: boolean;
    lastMeasuredAt: string;
  };
  disk: {
    volumePath: string;
    availableBytes: number;
    requiredFreeBytes: number;
    headroomStatus: 'ok' | 'tight' | 'blocked';
    reason: string | null;
  };
  activeRun: DuckdbCompactionRun | null;
  lastRun: DuckdbCompactionRun | null;
  cleanupCandidates: DuckdbCleanupCandidate[];
};
```

`POST /api/admin/duckdb-compaction/runs` should start one background run and return quickly:

```ts
type StartDuckdbCompactionRunResult = {
  runId: string;
  status: 'started' | 'already_running' | 'blocked';
  reason: string | null;
};
```

Avoid a long blocking HTTP request. The page should poll the status endpoint for progress.

## Benefit calculation

Use a conservative pre-run benefit calculation and label it clearly:

- `freeBlockBytes = free_blocks * block_size` from `PRAGMA database_size`;
- `walBytes = stat(forska.duckdb.wal)` if present;
- `conservativeReclaimBytes = freeBlockBytes + walBytes`;
- `estimatedRewriteSavingsBytes = fileBytes - estimatedTargetBytes` only when a safe estimate exists.

Do not promise that `fileBytes - usedBlockBytes` is exact. The recent manual compaction showed that a rewrite can save more than free blocks alone because exported/imported storage can be denser. The UI should display:

- `Conservative reclaimable`: safe lower-bound GB/GiB;
- `Estimated after rewrite`: nullable estimate when available;
- `Actual saved`: only after a completed run, computed from pre-run and post-run file sizes.

## Backend compaction service

Create a focused backend service, for example `src/server/services/duckdbCompactionService.ts`, with these responsibilities:

1. Locate the configured primary runtime DB through existing runtime config helpers; do not hardcode the macOS path.
2. Collect read-only status with project DuckDB bindings and the same runtime options used elsewhere.
3. Check writer/owner/exclusive-work state before mutation.
4. Run a checkpoint through the existing maintenance path when safe.
5. Create timestamped artifacts next to the primary DB on the same volume:
   - `forska.duckdb.export-<timestamp>/`
   - `forska.duckdb.compact-temp-<timestamp>/`
   - `forska.duckdb.compact-<timestamp>`
6. Export/import with `@duckdb/node-api`, not the Homebrew CLI, to match the app engine.
7. Use low-memory settings proven during manual recovery:
   - `memory_limit = 20GB` unless config says otherwise;
   - `threads = 1`;
   - `preserve_insertion_order = false`;
   - explicit temp directory under the timestamped compact temp directory.
8. Validate before swap:
   - target opens read-only;
   - table list matches;
   - row counts match;
   - constraints match;
   - indexes match;
   - views match;
   - `PRAGMA database_size` has zero or near-zero free blocks;
   - no WAL exists for the target.
9. Swap only after validation:
   - rename current `forska.duckdb` to `forska.duckdb.precompact-<timestamp>`;
   - rename compact target to canonical `forska.duckdb`;
   - never overwrite an existing rollback file.
10. Delete only artifacts created by the current run after success.
11. Keep the precompact rollback DB and show it on the page.

The first implementation should not delete unrelated old files as part of pressing `Run Compaction`. Cleanup candidates should be shown separately so the operator can inspect them.

## Durable run state

Store run state outside the DuckDB file being swapped, for example in a small JSON manifest under the runtime directory:

```text
runtime/primary/duckdb-compaction-runs/<runId>.json
```

Track:

- run id, timestamps, phase, status, error;
- source path, compact target path, rollback path;
- pre/post file sizes and `PRAGMA database_size` snapshots;
- validation summary;
- artifacts created by the run;
- cleanup result.

This makes the page reload-safe and avoids writing status into the database that is being compacted.

## Cleanup candidate scanner

The page should show old temporary/outdated files only when they match allow-listed roots and anchored patterns. Do not accept arbitrary glob input from the UI.

Rules:

- use `realpath` and require every candidate to stay under an allow-listed Forska runtime/diagnostics root;
- do not follow symlinked directories;
- include `patternId`, `kind`, `path`, `sizeBytes`, `mtime`, `ageDays`, `confidence`, `reason`, and `protected`;
- default to display-only in the first slice;
- mark evidence/protected files as visible but not deletable.

Initial reliable patterns:

| Pattern id | Root | Match | Default treatment |
| --- | --- | --- | --- |
| `compaction_export_dir` | runtime primary | `^forska\\.duckdb\\.export-\\d{8}T\\d{6}Z$` directory | candidate if no active run and older than 24h |
| `compaction_temp_dir` | runtime primary | `^forska\\.duckdb\\.compact-temp-\\d{8}T\\d{6}Z$` directory | candidate if no active run and older than 24h |
| `partial_compact_db` | runtime primary | `^forska\\.duckdb\\.compact-\\d{8}T\\d{6}Z$` file | candidate if no active run and older than 24h |
| `precompact_rollback_db` | runtime primary | `^forska\\.duckdb\\.precompact-\\d{8}T\\d{6}Z$` file | show as rollback; do not delete by default |
| `diagnostic_duckdb_copy` | diagnostics root | `forska.duckdb` files below timestamped diagnostics folders | show as old diagnostic copy; require explicit separate delete action |
| `startup_recovery_evidence` | runtime primary | `.startup-recovery/` contents | protected evidence; show only |
| `preserved_wal_or_lock` | runtime primary | preserved WAL/owner-lock/recovery artifacts | protected evidence; show only |
| `projector_pause_marker` | runtime primary | review-serving projector pause markers/backups | protected evidence; show only |

Explicit exclusions:

- canonical `forska.duckdb`;
- canonical `forska.duckdb.wal`;
- active compaction artifacts for the current run;
- active owner locks;
- current startup recovery evidence;
- files outside configured Forska runtime/diagnostics roots.

## Frontend page

The page at `/admin/duckdb-compaction` should use TanStack Query and the Eden client, with explicit loading and error states.

Suggested layout:

1. Summary cards
   - Primary DB size
   - Conservative reclaimable GB/GiB
   - Estimated/actual saved GB/GiB
   - WAL size
   - Disk headroom
2. Safety state
   - writer/owner/exclusive-work status;
   - whether the run button is enabled;
   - specific blocking reason if disabled.
3. Run control
   - `Run Compaction` button;
   - disabled when another exclusive DuckDB job is active, disk headroom is blocked, status is stale, or preflight failed;
   - progress phase and latest message while running.
4. Cleanup candidates
   - grouped by kind;
   - size, age, path, reason, confidence, protected flag;
   - display-only for protected/evidence files;
   - optional future separate action: delete explicitly selected cleanup files.
5. Last run
   - started/completed time;
   - pre/post size;
   - actual saved GB/GiB;
   - rollback path and size;
   - validation summary.

The same route should work in web and desktop shells. Use existing runtime config and local API behavior rather than macOS-specific paths in the frontend.

## Implementation steps

1. Add backend service for status, benefit calculation, cleanup scanning, run-state manifests, and compaction execution.
2. Extend `duckdbExclusiveWork` with the compaction kind/phases.
3. Add `DuckdbCompactionRoutes.ts` and register it in `productApiRoutes.ts`.
4. Add route inventory entries for the new admin endpoints.
5. Add the Solid route page and API query/mutation hooks.
6. Add the navigation link in `Navigation.tsx`.
7. Add backend tests for:
   - benefit calculation;
   - safe cleanup pattern matching and exclusions;
   - blocked run when disk headroom is insufficient;
   - export/import compaction of a fixture DB with foreign keys;
   - failed validation leaves the original DB untouched.
8. Add frontend tests for:
   - benefit display in GB/GiB;
   - run button disabled/enabled states;
   - cleanup candidates grouped and protected candidates not deletable;
   - admin menu link.
9. Verify browser/web and desktop-relevant flows.

## Quality gates

Run the focused gates after implementation:

```bash
bun test src/server/services/duckdbCompactionService.test.ts
bun test src/server/routes/DuckdbCompactionRoutes.test.ts
bun test src/server/utils/duckdbExclusiveWork.test.ts
bun test src/server/routes/routeSurfaceInventory.test.ts
bun test src/components/Navigation.vitest.tsx
bun test src/app/routes/+admin/+duckdb-compaction/+index.vitest.tsx
bun run lint
bun run build
```

If the implementation touches desktop packaging/runtime path resolution, also run the relevant desktop build or smoke command from `TESTS.md`.

Live verification before opening a PR:

1. Start the server/app normally.
2. Visit `/admin/duckdb-compaction`.
3. Confirm the admin menu link opens the page.
4. Confirm the page shows the current primary DB, benefit, WAL, disk headroom, and cleanup candidates without mutating anything.
5. Run compaction only against a disposable fixture/runtime DB unless Fredrik explicitly authorizes a live primary run.
6. Confirm progress phases update and the final status shows actual saved GB/GiB plus validation summary.
7. Confirm no active writer/owner state is left behind.

## Rollback and failure behavior

- Before swap failure: leave canonical `forska.duckdb` untouched and clean only artifacts from the current failed run.
- After source rename but before target rename: restore the rollback file to canonical name and record the error in the run manifest.
- After successful swap: keep `forska.duckdb.precompact-<timestamp>` until an operator explicitly removes it.
- Never silently delete WAL, startup recovery evidence, owner-lock evidence, or projector markers to make the UI green.
