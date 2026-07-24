# Review-Serving Summary Contribution Serving Proof

This note tracks the docs/evidence-only readiness slice for
`mart.review_article_summary_contribution_v4`.

The physical evidence report now includes a global, read-only current-DB
snapshot section for the table, separate from the default project-scoped table
summary. The section records:

- global row count
- number of projects with nonzero rows
- top projects by row count
- duplicate key counts for the declared primary key and lookup-index key
- column and index shape

Current generated evidence shows:

- global rows: `1,009,294`
- projects with nonzero rows: `4`
- declared primary-key duplicate keys: `0`
- lookup-index duplicate keys without `article_id`: `282`
- table shape: `9` columns and `1` index

This is not deletion authorization. It is only readiness evidence for deciding
whether summary contribution serving can be investigated further. Any table
removal or schema change still requires summary route parity, benchmark,
recovery, and live progress proof before implementation.

Generate the current artifact with:

```bash
bun run db:duck:inspect-review-serving-physical-evidence -- --format=markdown --output=.tmp/evidence/review-serving-summary-contribution-serving-proof.md
```
