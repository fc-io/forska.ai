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

The proof extends the physical evidence inspector only. It does not change runtime projector code, schemas, migrations, retention behavior, or route consumers.

## Latest Evidence

Generated with:

```bash
bun run db:duck:inspect-review-serving-physical-evidence -- --format=markdown --output=.tmp/evidence/review-serving-selected-import-payload-consumer-proof.md
```

For project `7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac`, the read-only snapshot evidence found:

- Selected-base scoped rows: 18,784
- Active/LKG selected-import rows: 0
- Candidate selected-import rows: 0
- Other selected-import rows: 18,784
- Selected-import snapshot status rows: `completed=18,784`
- Hot-field scoped rows through `app.project_import_route`: 0
- For all eight candidate columns: selected-base nulls 18,784, selected-base non-nulls 0, hot-field non-nulls 0

## Verdict

This is not deletion or schema-slimming authorization.

The evidence only shows that the scoped project has no non-null selected-base values for the eight candidate columns and no same-project hot-field rows available through project import routes. Runtime writer, reader, and recovery paths still carry these fields, and future slimming work still needs consumer changes or consumer irrelevance proof, route parity, benchmark evidence, recovery behavior, and the required live progress gate for any runtime/storage change.
