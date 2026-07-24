# Review-Serving Rebuild Artifact Operator Candidates

## Scope

This note records read-only current-DB evidence for rebuild artifact
dispositions that may need explicit operator recovery before retention cleanup
can remove partial or chunk artifacts.

It is evidence only. It does not authorize cleanup, request mutation, chunk
release, schema changes, or retention predicate broadening.

## Current-DB Evidence

Generated with:

```bash
bun run db:duck:inspect-review-serving-physical-evidence -- --format=markdown --output=.tmp/evidence/review-serving-requestless-artifact-operator-candidates.md
```

The current project has:

- 96,422 chunk-manifest rows.
- 0 currently requestless chunk-manifest rows.
- 79,852 chunk-manifest rows tied to two `failed-retryable`
  requestless-bootstrap requests.
- 16,570 chunk-manifest rows tied to one `failed-blocked-terminal` request.
- Summary rebuild partial artifacts still dominated by failed/unclassified,
  blocked-terminal, and retryable request dispositions.

The inspector now prints sample request ids per request disposition. For the
current run, the operator-relevant rows include:

- `failed-retryable`: `requestless-bootstrap:0d51c37206c26e26ed0f9109`,
  `requestless-bootstrap:6100fc2a4e93df428c3b97cd`
- `failed-blocked-terminal`: `rebuild:780e132cc91c31336d48f3ac67eb709a`
- `admitted-no-chunks`: `rebuild:91ea7f9f30bd9404e9b6db01a0b7d6f4`
- `failed-superseded-derived`: `rebuild:3c69f6834e35d933c2b924c18952111c`,
  `rebuild:46bc80c6d67f3c759427ee819654e429`,
  `requestless-bootstrap:929787658a6d45c4ac74985b`

## Disposition

The evidence narrows future operator work, but it does not make an apply action
safe by itself. The next step for any candidate request is a dry-run operator
command that preserves request rows and reports refusal reasons before mutation.

For failed requestless-bootstrap requests with chunks, use:

```bash
bun run db:duck:release-failed-requestless-review-serving-rebuild-chunks -- --project-id=<project-id> --request-id=<request-id>
```

Only apply after the dry run reports no refusal reasons, the target request and
chunk counts match the current evidence, and the current-DB progress gates are
planned for the post-apply state.

## Dry-Run Results

The following read-only dry runs were executed after this evidence section
started printing sample request ids:

```bash
bun run db:duck:release-failed-requestless-review-serving-rebuild-chunks -- --project-id=7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac --request-id=requestless-bootstrap:0d51c37206c26e26ed0f9109
bun run db:duck:release-failed-requestless-review-serving-rebuild-chunks -- --project-id=7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac --request-id=requestless-bootstrap:6100fc2a4e93df428c3b97cd
```

Both returned `status: "dry_run"` with no refusal reasons:

| Request id | Affected chunks | Dry-run status | Refusal reasons |
| --- | --- | --- | --- |
| `requestless-bootstrap:0d51c37206c26e26ed0f9109` | 1,509 | `dry_run` | none |
| `requestless-bootstrap:6100fc2a4e93df428c3b97cd` | 78,343 | `dry_run` | none |

This means the existing guarded operator can release those chunk rows if an
operator explicitly chooses to apply it with the acknowledgement token. It is
not an apply recommendation by itself: applying would mutate the live current
DB, detach the chunks from the failed requestless-bootstrap rows, and require
the current-DB progress gates afterward.

The admitted zero-chunk request from the same evidence was also checked with an
explicit primary DB environment:

```bash
FORSKA_RUNTIME_PROFILE=primary DUCKDB_PATH="$HOME/Library/Application Support/Forska/runtime/primary/forska.duckdb" bun run db:duck:terminalize-review-serving-rebuild-request -- --project-id=7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac --request-id=rebuild:91ea7f9f30bd9404e9b6db01a0b7d6f4
```

It returned `status: "dry_run"`, `chunkCount: 0`, and no refusal reasons. This
means the guarded terminalization operator can mark that stale zero-chunk
request terminal if an operator explicitly applies it with the acknowledgement
token. It is not cleanup authorization and does not touch chunk or partial
artifact rows.
