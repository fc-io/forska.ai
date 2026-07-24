# Review-Serving Selected-Import Payload Consumer Proof

## Scope

This is a read-only evidence slice for the selected-import payload slimming candidate columns in `app.review_selected_article_import_v4`:

- `import_route_id`
- `source_record_key`
- `selected_rank_key`
- `selected_rank_numeric`
- `publication_year`
- `article_title`
- `journal_title`
- `external_id`

The initial proof extended the physical evidence inspector only. The follow-up
consumer-migration slices changed runtime projectors so the display-copy
columns `publication_year`, `article_title`, `journal_title`, and `external_id`
are no longer written into selected-base rows and no longer used as downstream
fallbacks. After PR #151, bounded forward migration
`0124_dropReviewSelectedImportDisplayCopyColumns.sql` drops only those four
nullable display-copy columns. Retention behavior, recovery probes, and the
identity/rank/source columns remain unchanged.

After PR #150, the inspector also reports global/current-DB selected-base
counts for only those four display-copy columns, split by selected-import
snapshot status and active/LKG protection. `import_route_id`,
`source_record_key`, `selected_rank_key`, and `selected_rank_numeric` stay out
of the write-suppression claim because they remain identity/rank/source state.

## Latest Evidence

Generated with:

```bash
bun run db:duck:inspect-review-serving-physical-evidence -- --format=markdown --output=.tmp/evidence/review-serving-selected-import-payload-consumer-proof.md
bun run db:duck:inspect-review-serving-physical-evidence -- --format=markdown --output=.tmp/evidence/review-serving-selected-import-display-copy-global-evidence.md
```

For project `7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac`, the read-only snapshot evidence found:

- Selected-base scoped rows: 18,784
- Active/LKG selected-import rows: 0
- Candidate selected-import rows: 0
- Other selected-import rows: 18,784
- Selected-import snapshot status rows: `completed=18,784`
- Hot-field scoped rows through `app.project_import_route`: 0
- For all eight candidate columns: selected-base nulls 18,784, selected-base non-nulls 0, hot-field non-nulls 0

The global/current-DB display-copy evidence found:

- Selected-base rows: 620,792
- Active/LKG protected selected-import rows: 582,757
- Candidate selected-import rows: 0
- Other selected-import rows: 38,035
- Selected-import snapshot status/protection rows: `completed` active/LKG protected = 582,757, `completed` unprotected/other = 38,035
- For `publication_year`, `article_title`, `journal_title`, and `external_id`: selected-base nulls 620,792, selected-base non-nulls 0

## Verdict

This is no schema-slimming authorization.

The evidence shows that the scoped project has no non-null selected-base values
for the eight candidate columns and no same-project hot-field rows available
through project import routes. The current runtime now treats the four
display-copy columns as write-suppressed/consumer-migrated, and global/current-DB
selected-base evidence showed those four columns were 100% null across
active/LKG protected and other completed selected-import rows before the
bounded schema drop. Display-copy writer/consumer suppression is implemented
and migration `0124_dropReviewSelectedImportDisplayCopyColumns.sql` retires
those physical columns, while
`import_route_id`, `source_record_key`, `selected_rank_key`, and
`selected_rank_numeric` remain active identity/rank/source state and are not
part of the write-suppression claim.
