# Review-Serving Selected-Import Display-Copy Write Suppression

## Scope

This is a bounded read-only evidence slice for display-copy write suppression in
`app.review_selected_article_import_v4` after PR #150.

The display-copy columns are:

- `publication_year`
- `article_title`
- `journal_title`
- `external_id`

The identity/rank/source columns `import_route_id`, `source_record_key`,
`selected_rank_key`, and `selected_rank_numeric` are explicitly out of this
write-suppression claim. They remain selected-base runtime state.

## Evidence Command

```bash
bun test scripts/operatorScriptDuckdbAccess.test.ts
bun run db:duck:inspect-review-serving-physical-evidence -- --format=markdown --output=.tmp/evidence/review-serving-selected-import-display-copy-global-evidence.md
```

## Latest Current-DB Counts

The generated read-only snapshot evidence found:

- Global/current-DB selected-base rows: 620,792
- Active/LKG protected selected-import rows: 582,757
- Candidate selected-import rows: 0
- Other selected-import rows: 38,035
- Snapshot status/protection split: `completed` active/LKG protected = 582,757; `completed` unprotected/other = 38,035
- `publication_year`: 620,792 nulls, 0 non-nulls
- `article_title`: 620,792 nulls, 0 non-nulls
- `journal_title`: 620,792 nulls, 0 non-nulls
- `external_id`: 620,792 nulls, 0 non-nulls

## Verdict

This is no schema-slimming authorization. Display-copy writer/consumer
suppression is implemented. Schema drop still needs separate migration/recovery
proof, including route parity, benchmark evidence, and the required live
progress gate.
