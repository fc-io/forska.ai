---
name: forskai-duckdb
description: Use ONLY when touching DuckDB, duckdbMigrations, schema work, db:* commands, marts, queues, cron jobs, judgment queries, OOM errors, or database runtime safety.
---

# Forska DuckDB

## Database Rules

- Do not create Postgres migrations.
- Use the existing DuckDB SQL migration flow.
- Prefer the shared DuckDB services and helpers over ad hoc DB access.
- For local DuckDB work, never open the live DB file directly.
- Use `bun run db:studio`, `bun run db:query:snapshot -- --sql="..."`, or maintenance scripts with no running writer.
- For direct DuckDB CLI or manual work, always set a memory cap.
- Use `SET memory_limit = '20GB'` unless a smaller limit is needed.
- Use transactions for multi-table operations.
- Prefer `db.select()`, `db.insert()`, `db.update()`, and `db.delete()` over `db.execute()`.
- Use singular table names.
- Keep using the existing SQL migration files under `src/db/duckdbMigrations/`.

## Shared DuckDB Runtime Safety

- Foreground routes, cron jobs, queues, marts, and maintenance tasks share one constrained DuckDB runtime.
- Background jobs should not run unbounded scans over JSON, text, or historical tables.
- Scope background work by active rows, project, dirty token, cursor, batch limit, or an explicit time window.
- Persist relational keys and prefer compact lookup or projection tables for maintenance state.
- Raising `DUCKDB_MEMORY_LIMIT` is an emergency mitigation, not the root fix.

## OOM Errors

- When fixing any out-of-memory issue, add an entry to `OOM_ERRORS.md` in the same change.
- Keep each entry short.
- Include the error excerpt, affected job/query/command, likely cause, fix, and verification.
- This includes DuckDB OOMs like `Out of Memory Error: failed to pin block` from cron jobs, queues, marts, or large queries.

## Judgment Queries

- When querying judgments in a project context, always filter by model and content settings.
- The unique constraint is `(articleId, promptId, modelId, useTitle, useAbstract, useFulltext, useFulltextNoImages) WHERE deletedAt IS NULL`.

```ts
const judgmentConfigCondition = and(
  eq(judgments.modelId, project.modelId),
  eq(judgments.useTitle, project.useTitle),
  eq(judgments.useAbstract, project.useAbstract),
  eq(judgments.useFulltext, project.useFulltext),
  eq(judgments.useFulltextNoImages, project.useFulltextNoImages),
)
```

```ts
const judgmentConfigParts = projects.map((proj) => and(...))
const judgmentConfigCondition = or(...judgmentConfigParts)
```

## Commands

- Use `bun run db:mig` for migration work.
- Use `bun run db:duck:request-review-serving-large-rebuild` when that rebuild is relevant.
