# Review-Serving Operations

This is the compact operator runbook for review-serving DuckDB recovery,
rebuild artifacts, request lifecycle fields, and related maintenance work.

## Evidence First

When a DuckDB, WAL, checkpoint, indexed-table, or owner restart problem appears:

1. Preserve runtime logs, especially maintenance/API JSONL logs around the first
   fatal event.
2. Do not delete the database, WAL, startup-recovery directory, owner lock, or
   projector markers just to make the stack boot.
3. If a byte-for-byte copy is needed, stop the stack first and copy the DuckDB
   file, any `.wal`, and any `<duckdb>.startup-recovery/` directory to a
   timestamped evidence path.
4. Record the table, project id, snapshot id, request id, worker id, and failing
   statement class before recovery.
5. Treat recovery as incomplete until the root cause is fixed and a current-DB
   progress gate shows real forward movement.

## Indexed-Table Recovery

For indexed-table delete or invalidation errors such as:

```text
Failed to delete all rows from index
database has been invalidated because of a previous fatal error
```

keep the generated recovery manifest and any `*.pre-repair.duckdb` copy. If the
affected table is `mart.review_filter_option_serving_v4`, use exclusive
maintenance access and rebuild the table into a fresh catalog lineage:

```sql
CREATE TABLE mart.review_filter_option_serving_v4_repair AS
SELECT *
FROM mart.review_filter_option_serving_v4
WHERE FALSE;

INSERT INTO mart.review_filter_option_serving_v4_repair BY NAME
SELECT *
FROM mart.review_filter_option_serving_v4;

DROP TABLE mart.review_filter_option_serving_v4;
ALTER TABLE mart.review_filter_option_serving_v4_repair RENAME TO review_filter_option_serving_v4;

CREATE UNIQUE INDEX IF NOT EXISTS idx_review_filter_option_serving_v4_repaired_pk
ON mart.review_filter_option_serving_v4(
  project_id,
  review_config_hash,
  snapshot_id,
  search_identity,
  filter_option_identity,
  filter_kind,
  facet_key,
  option_value_key
);

CREATE INDEX IF NOT EXISTS idx_review_filter_option_serving_v4_lookup
ON mart.review_filter_option_serving_v4(
  project_id,
  review_config_hash,
  snapshot_id,
  search_identity,
  filter_kind,
  facet_key,
  option_value_key
);
```

After recovery, restart the stack and verify readiness for API, maintenance
owner, and judge worker. Then confirm completed chunks, pending/running counts,
`lastProgressedAt`, or an equivalent current-DB domain signal moves forward.

## Fatal Restart Lessons

The July 2026 current-DB fatal restart was caused by duplicate requestless
bootstrap admission violating `app.review_rebuild_request.request_id`
uniqueness. The fix proof required:

- focused worker/request-admission tests for duplicate requestless bootstrap
  adoption
- `bun run test:dev-server:current-db` without forbidden DuckDB fatal restart
  logs
- `bun run test:network-smoke:current-db` completing both phases with live
  review-serving progress
- preservation or explicit explanation of recovery artifacts

Future fatal restart fixes should follow the same standard: identify the
lifecycle bug, add a regression test, preserve evidence, and prove live progress.

## Rebuild Artifact Cleanup

Use operator cleanup only after classifying the artifact. Do not clean by broad
table deletion.

Useful commands:

```bash
bun run db:duck:inspect-review-serving-project-state -- --project-id=<project-id> --limit=50
bun run db:duck:inspect-review-serving-rebuild-timings -- --project-id=<project-id>
bun run db:duck:request-review-serving-project-rebuild -- --project-id=<project-id> --reason=<reason>
bun run db:duck:request-review-serving-all-projects-rebuild -- --reason=<reason>
bun run db:duck:release-failed-requestless-review-serving-rebuild-chunks -- --project-id=<project-id> --request-id=<request-id>
bun run db:duck:terminalize-review-serving-rebuild-request -- --project-id=<project-id> --request-id=<request-id>
```

Only use `--apply` variants after the dry run identifies stale, terminal, or
operator-approved rows. Keep stale zero-chunk request cleanup separate from
active project rebuilds.

## Request Lifecycle Fields

For rebuild request and chunk diagnosis, keep these fields together:

- request: `request_id`, `project_id`, `reason`, `priority`, `status`,
  `requested_at`, `admitted_at`, `completed_at`, `failed_at`,
  `last_progressed_at`, `last_error`
- chunk: `chunk_id`, `request_id`, `projection_component`, `status`,
  `estimated_input_rows`, `actual_output_rows`, `lease_owner`,
  `lease_expires_at`, `started_at`, `completed_at`, `failed_at`,
  `parent_chunk_id`
- snapshot/component: `snapshot_id`, `review_config_hash`,
  `selected_import_snapshot_id`, component identities, watermarks, and manifest
  publication time

These fields are the minimum useful evidence for deciding whether to boost,
release, split, terminalize, or rebuild.

## Request Attempt Closeout Backfill

Legacy `token_use.request_attempts_json` closeout projection is automatic,
bounded, and maintenance-owned:

- maintenance owner wakes every 30 seconds
- batch size is 1,000 `token_use` rows
- max work per wake is 5 batches / 5,000 rows
- progress is persisted after every batch
- startup never runs a full historical backfill synchronously
- cleanup remains projection-only and does not scan `app.token_use`

The relevant service owner is `src/server/services/requestAttemptCloseoutService.ts`.
