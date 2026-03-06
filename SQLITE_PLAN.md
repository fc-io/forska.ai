# SQLite plan (PostgreSQL to Bun SQLite)

## Goal

- Bun SQLite is primary application database.
- Keep PostgreSQL until data migrated + verified.
- Single-user local app (no Better Auth/users).
- Remove Better Auth.
- Remove all admin validation in API router.
- Remove Drizzle.

## Checklist

- [ ] Add SQLite database file + environment variable (example: `SQLITE_PATH=./data/app.sqlite`).
- [ ] Add SQLite connection helper (`bun:sqlite`) + pragmas: `foreign_keys=ON`, `synchronous=NORMAL`, `busy_timeout`.
- [ ] Enable write-ahead log (WAL) mode (`PRAGMA journal_mode = WAL`) per Bun docs: https://bun.com/docs/runtime/sqlite#wal-mode.
- [ ] Add SQLite migration runner (own table like `schema_migrations`, ordered `.sql` files).
- [ ] Build target SQLite schema (tables + indexes + views) as SQL source of truth.
- [ ] Add database adapter layer so routes do not depend on Drizzle types.
- [ ] Port server reads and writes from Drizzle to SQLite SQL.
- [ ] Data backfill: copy PostgreSQL tables into SQLite (dependency order).
- [ ] Validate: row counts per table, foreign key checks, spot check critical flows.
- [ ] Delta catchup: freeze writes window for cutover, or dual-write until cutover.
- [ ] Cutover: switch server to SQLite for all reads and writes.
- [ ] Keep PostgreSQL running read-only until confidence, then remove.

## Remove Better Auth + admin validation

- [ ] Delete Better Auth server code and configuration.
- [ ] Remove `requireAdminAuth` and any admin-only checks from API router.
- [ ] Remove auth routes or keep but unauthenticated (explicit decision).
- [ ] Remove auth tables (`user`, `session`) and all foreign keys to them.
- [ ] Replace user references with nullable text identifiers where needed (owner, imported by, reviewer).
- [ ] Remove Better Auth environment variables.

## Schema adaptation (from `src/db/schema.ts` to SQLite)

- [ ] Stop using `pgTable`, `pgEnum`, `pgView` (SQLite DDL only).
- [ ] Identifiers: store as `TEXT` (keep existing identifier strings during migration).
- [ ] Timestamps: store as `INTEGER` (Unix milliseconds) or `TEXT` (ISO); pick one and apply everywhere.
- [ ] Booleans: store as `INTEGER` 0 or 1; keep `CHECK` when helpful.
- [ ] Enums: store as `TEXT` + `CHECK` (or remove constraint, validate in code).
- [ ] `jsonb`: store as `TEXT` JSON; use SQLite JSON functions only where needed.
- [ ] Postgres arrays: store as `TEXT` JSON; if query needs indexing, add child table.
- [ ] Link tables: drop surrogate `id`, use composite primary key, `WITHOUT ROWID`.
- [ ] Replace Postgres-only indexes with SQLite indexes (include partial and expression indexes when needed).
- [ ] Replace `project_stats` view: SQLite view or compute in code.
