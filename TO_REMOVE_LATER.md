# Things To Remove Later

Date recorded: 2026-09-10

Context: Windows DuckDB 2.0 rollout follow-ups after PR #428 was merged.

Relevant commits:

- `1fe7a60c` - PR #428 merge: DuckDB 2.0 alpha/Forska package rollout.
- `563d0900` - Defers stale DuckDB repair markers to migrations.
- `e7f9b5d2` - Checkpoints WAL before marker-only DuckDB repair.
- `e984e25b` - Removes mutable indexes from comparison conflict resolutions.
- `ca2b2425` - Defers migration-gated DuckDB repair markers and improves marker diagnostics.
- `bf45fa3b` - Gates `app.review_rebuild_chunk_manifest` startup repair on migration `0231`.

## Repo Cleanup Candidates

Do not remove these during routine cleanup. Revisit only during an explicit migration-history squash or a deliberate "minimum supported DuckDB schema is now after 0231" cleanup.

- `skipStartupPreflightUntilMigration` gates in `src/server/utils/duckdbService.ts`.
  - `app.judgment_job` -> `0229_rebuildWorkflowTablesWithoutInlinePrimaryKeys.sql`
  - `app.comparison_project_serving_generation` -> `0229_rebuildWorkflowTablesWithoutInlinePrimaryKeys.sql`
  - `app.comparison_project_conflict_resolution` -> `0230_rebuildComparisonProjectConflictResolutionsWithoutIndexes.sql`
  - `app.review_rebuild_chunk_manifest` -> `0231_rebuildReviewRebuildChunkManifestWithoutIndexes.sql`
- Startup repair marker/WAL compatibility logic added for late upgraders with old indexed tables and preserved WAL files.
- Targeted tests that exist mainly to pin those compatibility paths, especially in:
  - `src/server/utils/duckdbServiceReload.test.ts`
  - `src/db/migrateDuckdb.workflowTables.test.ts`
  - `src/db/migrateDuckdb.conflictResolutionTables.test.ts`
  - `src/db/migrateDuckdb.reviewRebuildChunkManifest.test.ts`

The numbered migrations themselves should remain in normal migration history. Remove or squash them only if the project intentionally resets/squashes DuckDB migrations and has a tested replacement baseline.

## User-Machine Cleanup

These are not repo files, but they can be removed later on affected machines once the app has started cleanly and no support evidence is needed:

- `runtime/primary/forska.duckdb.startup-recovery/*`
- Matching preserved recovery sets:
  - `*.recovery.json`
  - `*.pre-repair.duckdb`
  - `*.pre-repair.wal`
- Incident-specific diagnostic zips/logs collected during the Windows rollout.

Do not delete the live `forska.duckdb.wal` as a cleanup step. If a WAL remains live, startup/recovery code should handle it or preserve evidence and block safely.

## Removal Checklist

Before removing any repo compatibility path:

- Confirm all supported installs have applied migrations through at least `0231`.
- Prove startup from an old pre-0229/pre-0230/pre-0231 database is no longer supported, or is handled by a new squashed baseline.
- Keep evidence-preserving WAL behavior intact for any remaining startup repair path.
- Run the DuckDB migration, startup-repair, current-DB, and relevant workflow/browser gates from the final source.
