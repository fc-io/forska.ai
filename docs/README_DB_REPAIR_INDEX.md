Database Repair: judgments index

Context
- If inserts into `judgments` fail with a Postgres error like `XX002 right sibling's left-link doesn't match ... in index "judgments_pkey"`, the primary key B-tree index is corrupted and needs a REINDEX.

Prerequisites
- SSH tunnel from the remote host to your machine on port 8432, e.g.
  - `ssh -N -L 8432:127.0.0.1:${POSTGRES_PORT:-5432} <remote-host>`
- Local `psql` installed.

Quick repair (concurrent)
- Preferred: TypeScript/Bun script (uses local psql under the hood).
- Defaults assume the tunnel at `localhost:8432` and `postgres/postgres` DB/user.
- Provide `DB_PASS` if your instance requires a password.

Examples
- With password env var:
  - `DB_PASS=your_password bun run db:repair-judgments-index`
- Custom user/db/port:
  - `DB_USER=postgres DB_NAME=postgres DB_PORT=8432 bun run db:repair-judgments-index`
- Non-interactive:
  - `DB_PASS=your_password bun scripts/dbRepairJudgmentsIndex.ts --yes`

What the script does
- Attempts `REINDEX INDEX CONCURRENTLY public.judgments_pkey;`
- If that fails, attempts `REINDEX TABLE CONCURRENTLY public.judgments;`
- If both fail, prints a locking (non-concurrent) fallback you can run during a quiet window.

Verification
- Re-run your job or try a simple insert/update into `judgments`.
- Optional (if available): enable amcheck and run `SELECT bt_index_check('public.judgments_pkey'::regclass, true);`

Reindex many indexes at once
- To repair all indexes in a schema (default public):
  - `DB_PASS=your_password bun run db:reindex-all`
  - Custom schema: `DB_SCHEMA=public bun run db:reindex-all`
- To repair all indexes in the entire database:
  - `DB_PASS=your_password bun run db:reindex-all --scope database`
- Add `--no-concurrent` for a blocking rebuild (use only in a quiet window).

Deduplicate before reindex (when REINDEX fails with duplicates)
- If REINDEX reports duplicate key values (e.g., `could not create unique index ... Key (id)=... is duplicated`),
  run the combined dedupe + reindex helper:
  - `DB_PASS=your_password bun run db:repair-all-indexes`
  - It scans all tables in the target schema with a single-column PK `id`, removes duplicate rows by keeping the newest (by created_at/updated_at/ctid), then reindexes the schema (concurrently by default). Use `--scope database` for DB-wide reindex.
