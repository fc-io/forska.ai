# Review-Serving Summary Contribution Recoverability

This docs/read-only slice extends the summary contribution serving proof with
bounded recoverability classification only. It does not authorize deletion,
cleanup, migration, or schema removal.

The inspector now collects:

- aggregate `contribution_key` groups for JSON `summaryKind=count` and
  `summaryKind=facet`
- final count/facet serving rows that match those aggregate groups exactly by
  serving identity and `count_value`
- contribution aggregate groups that have no final serving row
- contribution aggregate groups whose final serving row has a different
  `count_value`
- final serving rows that have no corresponding contribution aggregate group
- exact logical common-column row overlap between
  `mart.review_article_summary_contribution_v4` and
  `mart.review_article_summary_contribution_rebuild_partial_v4`

The classification remains conservative: final aggregate rows can prove only
aggregate serving parity. They cannot reconstruct exact per-article
contribution ledger rows because the final count/facet tables do not retain
`article_id`, `component_kind`, or full ledger row identity.

The overlap check compares the shared logical contribution identity and value
columns only. It excludes request/chunk ownership and timestamps because those
belong to the rebuild-partial lifecycle, not the stable legacy ledger identity.

Generate the current artifact with:

```bash
bun run db:duck:inspect-review-serving-physical-evidence -- --format=markdown --output=.tmp/evidence/review-serving-summary-contribution-recoverability.md
```
