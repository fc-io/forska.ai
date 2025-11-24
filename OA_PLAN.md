**OpenAlex Snapshot Database Plan (HPC)**

Goal: load the full OpenAlex snapshot into its own Postgres database on the HPC, then query it and copy only relevant subsets into the Forska main database when needed.

---

## 0. High‑level architecture

- [x] Keep OpenAlex data in a **separate Postgres database** (same Postgres instance as Forska, different DB name).
- [x] Treat OpenAlex DB as **read‑only warehouse**; Forska main DB remains small and app‑focused.
- [x] Use **ETL jobs** (SQL or scripts) to copy subsets (years, concepts, etc.) from OpenAlex DB into the main DB.

---

## 1. Postgres deployment choice on HPC

**Recommendation (easiest): reuse Apptainer Postgres instance**

- [x] Reuse the existing `postgres_18.sif` Apptainer image and `$STACK_ROOT/pgdata` that you already use in your Discoverer setup (see `forska-dis.sbatch`).
- [x] Run **one Postgres instance** (as you do today) and create a **second database** (e.g. `openalex_snapshot`) inside that instance.
- [x] Reuse the existing Postgres superuser/password from `$STACK_ROOT/.secrets/db_password.txt` (no new secret management).
- [ ] Optionally add a separate DB user/role (e.g. `openalex_app`) for read‑only access from Forska.

Why this is easiest:
- You already have a working Apptainer + Postgres setup, including secrets and data directory.
- Creating another DB inside the same instance is a single `CREATE DATABASE` command.
- You avoid compiling or installing Postgres under your user account, and you keep all DB state in the same `$STACK_ROOT/pgdata`.

**Decision:** use the **Apptainer‑based Postgres** you already run and create a new database `openalex_snapshot` in that instance.

---

## 2. Preconditions and directories

- [x] Confirm shared HPC root:
  - `STACK_ROOT=/valhalla/projects/ehpc-aif-2025pg01-233/dev` (as in `forska-dis.sbatch` and `openalex-dis-db.sbatch`).
- [x] Ensure OpenAlex snapshot is present (already done per your note):
  - Example: `$STACK_ROOT/openalex-snapshot/works/*.gz`, `authors/*.gz`, etc.
- [x] DB name should be`openalex_snapshot`.
- [x] resuse existing DB user: postgres

## 3. Start Postgres + import all snapshot JSON via `openalex-dis-db.sbatch`

On Discoverer, everything runs from a single batch job: it starts Postgres via Apptainer and then runs a container‑side script that creates the `openalex_snapshot` database (if needed) and imports all JSON snapshot files under `openalex-snapshot/data/**.gz` into a raw table. No manual `psql`, no extra scripts.

**3.A. Submit the Postgres + import job**

- [ ] From `login-plus` in this repo, submit:
  - `sbatch openalex-dis-db.sbatch`
- [ ] Monitor the job:
  - `squeue -u $USER`
- [ ] The job writes logs under:
  - `$STACK_ROOT/logs/openalex-pg-<jobid>/db.log`
  where you can follow Postgres startup and import progress.

**3.B. What the job does automatically**

Inside the Postgres container, the generated script:

- [x] Reads the DB password from `/run/secrets/db_password`.
- [x] Ensures database `openalex_snapshot` exists (creates it if missing).
- [x] Ensures schema and table exist:
  - `CREATE SCHEMA IF NOT EXISTS openalex;`
  - `CREATE TABLE IF NOT EXISTS openalex.raw_json_lines (entity text, source text, line text);`
- [x] Walks all `.gz` files under:
  - `/data/openalex/data/**`
  - `/data/openalex/legacy-data/**` (if present)
- [x] For each `.gz` file:
  - Computes a relative path `source` (e.g. `data/works/...gz` or `legacy-data/works/...gz`).
  - Derives `entity` from the path (`works`, `authors`, etc.; falls back to `"unknown"` if the layout is unexpected).
  - Deletes any existing rows with that `source` to keep the import idempotent.
  - Decompresses the file with `gzip -dc`, prefixes each JSON line with `entity` and `source` (tab‑separated), and streams it into:
    - `COPY openalex.raw_json_lines (entity, source, line) FROM STDIN WITH (FORMAT text);`
- [x] Logs progress with human‑friendly messages like:
  - `[openalex-pg] [import] scanning /data/openalex/data for .gz files (current)`
  - `[openalex-pg] [import] [current] loading file: data/works/...gz (entity=works)`
  - `[openalex-pg] [import] processed N file(s) under /data/openalex/data (current)`
- [x] On successful completion, shuts down Postgres cleanly and exits.

---

## 4. Create the `openalex_snapshot` database and credentials

For the fully batch path, add these `psql` commands to `openalex_import.sql`. For manual runs, you can also execute them interactively in `psql`.

- [ ] In `openalex_import.sql`, create the new database:
  - `CREATE DATABASE openalex_snapshot;`
- [ ] (Optional) Create a read‑only user (can also be done manually later):
  - `CREATE USER openalex_app WITH PASSWORD '<reuse-or-new-password>';`
  - Grant privileges:
    - `GRANT CONNECT ON DATABASE openalex_snapshot TO openalex_app;`
    - After schema is created (next section), run:
      - `GRANT USAGE ON SCHEMA public TO openalex_app;`
      - `GRANT SELECT ON ALL TABLES IN SCHEMA public TO openalex_app;`
      - `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO openalex_app;`

---

## 5. Load the OpenAlex schema into `openalex_snapshot`

- [ ] From the OpenAlex docs / downloads, obtain the **Postgres schema SQL** for the snapshot (usually one or more `.sql` files with `CREATE TABLE` and `CREATE INDEX` statements).
- [ ] Copy the schema SQL into `$STACK_ROOT/openalex-snapshot/schema/` (or similar).
- [ ] In `openalex_import.sql`, after `\c openalex_snapshot`, load the schema:
  - `\i /data/openalex/schema/openalex_schema.sql`
- [ ] When the batch job runs, this will be executed via `psql` inside the container. Afterwards, you can verify tables with:
  - `\dt` (if you also run `psql` interactively at some point).

---

## 6. Load snapshot data files (works, authors, etc.)

The OpenAlex instructions use bulk `COPY`/`\copy` into each table from the JSON/TSV snapshot files. For the batch job, add the relevant `\copy` commands directly into `openalex_import.sql`.

- [ ] Confirm snapshot layout under `$STACK_ROOT/openalex-snapshot` (e.g. `works/*.gz`, `authors/*.gz`).
- [ ] In `openalex_import.sql`, for each entity (e.g. `works`):
  - Decompress if needed:
    - Either pre‑decompress to `.jsonl`/`.tsv` in `$STACK_ROOT/openalex-snapshot/works/`, or:
    - Use `\copy` with `PROGRAM 'zcat …'`.
  - Example pattern (adapt to actual OpenAlex docs):
    - `\copy works FROM PROGRAM 'zcat /data/openalex/works/works-part-1.gz' WITH (FORMAT text);`
- [ ] Repeat for other OpenAlex tables (authors, venues, institutions, concepts, etc.) following the exact `COPY` statements in the OpenAlex docs.
- [ ] Submit `openalex-dis-db.sbatch`; the job will execute all of `openalex_import.sql` via `psql` inside the container and write progress/output to the log.

---

## 7. Post‑load maintenance (indexes, vacuum, analyze)

- [ ] Ensure all indexes from the OpenAlex schema are created (if some are optional, consider skipping the heaviest ones initially).
- [ ] Run `VACUUM ANALYZE` on the most important tables to help the planner:
  - `VACUUM ANALYZE works;`
  - `VACUUM ANALYZE authors;`
  - etc.
- [ ] Optionally tune `maintenance_work_mem` and `work_mem` temporarily for faster indexing and analyze during the loading job (via Postgres config or `ALTER SYSTEM` / session settings).

---

## 8. Integration with Forska main DB

Once the OpenAlex snapshot is in `openalex_snapshot`, treat it as a read‑only source.

- [ ] Decide on subsets you care about:
  - Example: works in specific years, selected concepts, language filters, or venues.
- [ ] Design ETL queries that:
  - Connect to `openalex_snapshot`.
  - Select rows with the filters you care about.
  - Insert those rows into your main Forska DB tables (or staging tables).
- [ ] Implementation options:
  - Simple: use `psql` scripts that connect to each DB separately and dump/import via CSV (`\copy` out then `\copy` in).
  - More flexible: a small Bun/Node script in this repo that:
    - Reads from `openalex_snapshot` via `DATABASE_URL_OPENALEX`.
    - Writes into the existing Forska DB via `DATABASE_URL`.
- [ ] Keep the Forska DB schema lean; avoid mirroring the entire OpenAlex schema there. Only copy what you actually use.

---

## 9. Checklist summary

- [ ] Confirm OpenAlex snapshot location under `$STACK_ROOT/openalex-snapshot`.
- [ ] Start Postgres via Apptainer using `openalex-dis-db.sbatch` (or another Forska Postgres job).
- [ ] Create `openalex_snapshot` database (and optional `openalex_app` user).
- [ ] Load OpenAlex schema into `openalex_snapshot`.
- [ ] Bulk `COPY` / `\copy` all snapshot files into the corresponding tables.
- [ ] Run `VACUUM ANALYZE` and confirm row counts match expectations.
- [ ] Document a connection string (e.g. `DATABASE_URL_OPENALEX`) for Forska code to query this DB.
- [ ] Implement ETL queries/scripts to copy only relevant works into the main DB.
