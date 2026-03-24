# Better Mart Plan

## Goal

- Keep DB-backed routes responsive during judgment ingest and mart drain.
- Keep the existing single-writer lease unchanged.
- Improve ingest only after mart work stops monopolizing the DB lane.

## Decision

- Replace the CLI DuckDB runtime with `@duckdb/node-api`.
- Keep 1 cached embedded instance.
- Keep 1 serialized control lane for reads, transactions, mart refresh, DDL, checkpoint, snapshot, maintenance, shutdown.
- Add `2` append lanes only for SQLite outbox -> `app.judgment` import.
- Add a global quiet barrier before checkpoint, snapshot, maintenance, shutdown.

## Main point

- Append lanes help ingest.
- Append lanes do not make reads responsive by themselves.
- Route responsiveness mostly comes from:
  1. mart queue correctness
  2. mart coalescing by project
  3. real yielding between drain passes

## Order

1. Spike `@duckdb/node-api`.
2. Ship embedded control-lane parity.
3. Fix mart queue correctness + coalescing.
4. Ship time-budgeted mart drain.
5. Add SQLite outbox claiming.
6. Add `2` append lanes for import.
7. Add quiet barrier + hardening.
8. Only then consider `4` lanes or appender.

## Guardrails

- Do not change lease ownership semantics.
- Do not move reads off the control lane.
- Do not switch to appender before exactly-once semantics are proven.
- Keep one transaction per claimed append batch.
- Apply startup config to every lane, or prove instance-level parity.
- Do not delete mart queue rows blindly by id after work.

## Risks

- Faster ingest can worsen mart backlog.
- Snapshot/checkpoint/shutdown can race append lanes without a barrier.
- Soft-delete + `delete_generation` semantics can still block replay/reinsert.
- One long mart statement can still block reads on the control lane.

## Acceptance

- [ ] No child-process DuckDB runtime on the normal server path.
- [ ] `/api/projects` stays responsive during import and mart drain.
- [ ] Mart queue does not lose requeues during active drain.
- [ ] Outbox throughput materially improves.
- [ ] No duplicate or partial `app.judgment` imports from one claim.
- [ ] Writer demotion, snapshot, checkpoint, shutdown stay safe.
- [ ] Mart queue depth trends down under steady-state load.

## Verify

- `bun test`
- `bun run build`
- `bun run dev:server`
- `bun run db:query:snapshot -- --sql "SELECT COUNT(*) FROM app.mart_refresh_queue"`
- `bun run db:query:snapshot -- --sql "SELECT COUNT(*) FROM app.judgment"`

## Detailed plan

- Concrete PR-by-PR schema and API changes: `BETTER_MART_PR_PLAN.md`
