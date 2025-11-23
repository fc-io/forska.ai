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

- [x] Reuse the existing `postgres_18.sif` Apptainer image and `$STACK_ROOT/pgdata` that you already use in `forska-alvis.sbatch`.
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
  - `STACK_ROOT=/mimer/NOBACKUP/groups/clin-agent-bench/dev` (as in `forska-alvis.sbatch`).
- [x] Ensure OpenAlex snapshot is present (already done per your note):
  - Example: `$STACK_ROOT/openalex-snapshot/works/*.gz`, `authors/*.gz`, etc.
- [x] DB name should be`openalex_snapshot`.
- [x] resuse existing DB user: postgres

## 3. Start Postgres via Apptainer for maintenance / loading

You have two patterns:
- **A. Reuse the running Postgres** from a Forska job (if you already have a job with Postgres up).
- **B. Launch a small, DB‑only job** (no GPUs) dedicated to snapshot loading.

**3.A. Use existing Forska job’s Postgres**

- [ ] Submit `forska-alvis.sbatch` (or similar) as usual to start Postgres and your services.
- [ ] From a login node, open a tunnel to the node running the job if you want local `psql` access:
  - `ssh -N -L 8432:<job-host>:5432 alvis2` (see the hints at the bottom of `forska-alvis.sbatch`).
- [ ] Use `psql` from your laptop or inside Apptainer to create the OpenAlex DB (see Section 4).

**3.B. Create a dedicated DB‑only job for loading (recommended for long imports)**

- [ ] Copy `forska-alvis.sbatch` to e.g. `openalex-load-db.sbatch`.
- [ ] Strip out all SGLang/API/App parts; keep only:
  - `STACK_ROOT` setup.
  - `SIF_DB`, `DB_PW_FILE`, `DB_URL_FILE`.
  - The `apptainer run ... "$SIF_DB"` block that starts Postgres on `$POSTGRES_PORT`.
- [ ] Remove GPU directives and request a simple CPU job, e.g.:
  - `#SBATCH -p <cpu-partition>`
  - `#SBATCH --gpus-per-node=0` (or omit GPUs entirely).
- [ ] Submit this job and keep it running while you create the DB and load data.

---

## 4. Create the `openalex_snapshot` database and credentials

Assuming Postgres is running via Apptainer as in `forska-alvis.sbatch`:

- [ ] Get the connection info:
  - Host: `127.0.0.1`
  - Port: `$POSTGRES_PORT` (defaults to `5432` unless overridden).
  - User: `${DB_USER:-postgres}`.
  - Password: from `$STACK_ROOT/.secrets/db_password.txt`.
- [ ] Either:
  - SSH to the node and run `psql` inside Apptainer:
    - `apptainer exec --cleanenv "$SIF_DB" psql -h 127.0.0.1 -p "$POSTGRES_PORT" -U "${DB_USER:-postgres}" postgres`
  - Or tunnel from your laptop to `127.0.0.1:$POSTGRES_PORT` and use local `psql`.
- [ ] Create the new database:
  - `CREATE DATABASE openalex_snapshot;`
- [ ] (Optional) Create a read‑only user:
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
- [ ] Start an interactive shell inside the DB container with the snapshot directory bound:
  - `apptainer exec --cleanenv --bind "$STACK_ROOT/openalex-snapshot:/data/openalex:ro" "$SIF_DB" bash`
- [ ] Inside the container, load the schema:
  - `psql -h 127.0.0.1 -p "$POSTGRES_PORT" -U "${DB_USER:-postgres}" -d openalex_snapshot -f /data/openalex/schema/openalex_schema.sql`
- [ ] Verify tables exist:
  - In `psql`: `\dt` and check for tables like `works`, `authors`, `venues`, etc.

---

## 6. Load snapshot data files (works, authors, etc.)

The OpenAlex instructions use bulk `COPY`/`\copy` into each table from the JSON/TSV snapshot files.

- [ ] Confirm snapshot layout under `$STACK_ROOT/openalex-snapshot` (e.g. `works/*.gz`, `authors/*.gz`).
- [ ] Create a small shell script (or sbatch job) that:
  - Binds the snapshot directory into the DB container:
    - `--bind "$STACK_ROOT/openalex-snapshot:/data/openalex:ro"`.
  - Runs `psql` commands to `\copy` data into each table.

Example loading workflow (pseudo‑script, adapt to actual file formats from OpenAlex docs):

- [ ] For each entity (e.g. `works`):
  - Decompress if needed:
    - Either pre‑decompress to `.jsonl`/`.tsv` in `$STACK_ROOT/openalex-snapshot/works/`, or:
    - Use a pipeline: `zcat file.gz | psql -c "\copy works FROM STDIN WITH (FORMAT csv or text, ...)"`.
  - Use `psql` inside Apptainer:
    - `apptainer exec --cleanenv --bind "$STACK_ROOT/openalex-snapshot:/data/openalex:ro" "$SIF_DB" psql -h 127.0.0.1 -p "$POSTGRES_PORT" -U "${DB_USER:-postgres}" -d openalex_snapshot -c '\copy works FROM PROGRAM '\''zcat /data/openalex/works/works-part-1.gz'\'' WITH (FORMAT text)'`
- [ ] Repeat for other OpenAlex tables (authors, venues, institutions, concepts, etc.) following the exact `COPY` statements in the OpenAlex docs.
- [ ] Run these loads in a **CPU job** with enough wall‑time and I/O quota, not on the GPU job that serves the app.

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
- [ ] Start Postgres via Apptainer (Forska job or dedicated DB job).
- [ ] Create `openalex_snapshot` database (and optional `openalex_app` user).
- [ ] Load OpenAlex schema into `openalex_snapshot`.
- [ ] Bulk `COPY` / `\copy` all snapshot files into the corresponding tables.
- [ ] Run `VACUUM ANALYZE` and confirm row counts match expectations.
- [ ] Document a connection string (e.g. `DATABASE_URL_OPENALEX`) for Forska code to query this DB.
- [ ] Implement ETL queries/scripts to copy only relevant works into the main DB.
