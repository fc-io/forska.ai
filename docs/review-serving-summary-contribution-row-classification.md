# Review-Serving Summary Contribution Row Classification

This evidence slice classifies rows in
`mart.review_article_summary_contribution_v4` using a read-only snapshot of the
current primary DuckDB database.

The classification is intentionally conservative and does not authorize
deletion. The report keeps `verdict: not-authorized` when collection succeeds
and switches to `blocked` only when evidence collection fails.

Collected classifications:

- active/last-known-good snapshot protected rows
- pinned snapshot rows using active snapshot pins
- rows with no matching `app.review_serving_snapshot_manifest` record
- rows by project
- rows by `component_kind`
- rows by `summary_definition_version`
- top `contribution_key` counts
- rows by manifest `snapshot_status` when that status column exists

Generate the markdown artifact with:

```bash
bun run db:duck:inspect-review-serving-physical-evidence -- --format=markdown --output=.tmp/evidence/review-serving-summary-contribution-serving-proof.md
```

The command uses `createDuckdbSnapshotForCli` and
`getReadOnlyDuckdbRuntimeOptions`, so it must remain a read-only evidence path.
