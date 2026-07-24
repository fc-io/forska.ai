# Review-Serving Summary Contribution Serving Proof

This note tracks the docs/evidence-only readiness slice for
`mart.review_article_summary_contribution_v4`.

The physical evidence report now includes a global, read-only current-DB
snapshot section for the table, separate from the default project-scoped table
summary. The section records:

- global row count
- number of projects with nonzero rows
- top projects by row count
- active/last-known-good snapshot protected row count
- active pin protected row count
- rows with no matching snapshot manifest
- rows by project
- rows by component kind
- rows by summary definition version
- top contribution keys by row count
- rows by snapshot manifest status when `snapshot_status` exists
- duplicate key counts for the declared primary key and lookup-index key
- column and index shape

The generated evidence is for deletion decisions only in the sense of
classification: it can identify which rows are active, pinned, status-grouped,
or missing manifest coverage. The verdict remains `not-authorized`.

Prior generated evidence showed:

- global rows: `1,009,294`
- projects with nonzero rows: `4`
- active/LKG snapshot protected rows: `177,498`
- active pin protected rows: `0`
- rows with no matching snapshot manifest: `0`
- snapshot manifest status rows: `candidate=831,796`, `active=177,498`
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
