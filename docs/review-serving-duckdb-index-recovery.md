# Review Serving DuckDB Index Recovery

Use this when a review-serving maintenance owner fails with a DuckDB indexed-table delete error such as:

```text
Failed to delete all rows from index
database has been invalidated because of a previous fatal error
```

## Preserve Evidence First

1. Keep the runtime logs, especially `logs/runtime/<profile>/maintenance-worker-server-*.jsonl`.
2. Do not delete the database or WAL to make the owner start.
3. If a byte-for-byte copy is needed, stop the server stack first, then copy the DuckDB file, any `.wal`, and the `.startup-recovery` directory to timestamped evidence paths.
4. Record the table, project id, snapshot id, and request id from the fatal log before recovery.

## Stabilize The Owner

1. Restart only after preserving evidence.
2. If startup recovery runs, keep the generated `<duckdb>.startup-recovery/*.recovery.json` manifest and `*.pre-repair.duckdb` backup.
3. If the loop is caused by completed request catch-up finalizing summary filter options, use the catch-up path that upserts filter options without scoped deletes. Do not silently clear mart rows.

## Targeted Table Rebuild

For `mart.review_filter_option_serving_v4` index corruption, use exclusive maintenance access and rebuild the derived table structure while preserving rows. Stop the stack before running write SQL directly.

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

After recovery, restart the stack and verify `/api/runtime/ready` for the API, maintenance owner, and judge worker. Then confirm the relevant project rebuild counters or warning-route progress move on the current DB workload.
