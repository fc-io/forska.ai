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
  - `STACK_ROOT=/valhalla/projects/ehpc-aif-2025pg01-233/dev` (as in `forska-dis.sbatch` and `08-openalex-dis-db-rest.sbatch`).
- [x] Ensure OpenAlex snapshot is present (already done per your note):
  - Example: `$STACK_ROOT/openalex-snapshot/works/*.gz`, `authors/*.gz`, etc.
- [x] DB name should be`openalex_snapshot`.
- [x] resuse existing DB user: postgres

## 3. Flatten JSONL to CSV + load into Postgres via split sbatch jobs

Use the numbered sbatch files in this repo:
- `01-openalex-flatten-topics.sbatch` through `07-openalex-flatten-works.sbatch` (one per flatten task)
- `08-openalex-dis-db-rest.sbatch` (Postgres startup + schema + CSV load)

**3.A. Prepare scripts and snapshot layout on Discoverer**

- [ ] Ensure snapshot is located at:
  - `$STACK_ROOT/openalex-snapshot` (as shown in your directory listing).
- [ ] Copy `flatten-openalex-jsonl.py` into the same folder as the sbatch files:
  - `"$STACK_ROOT/flatten-openalex-jsonl.py"`
- [ ] (Optional but recommended) Also copy the official SQL scripts from the OpenAlex docs into `$STACK_ROOT`:
  - `openalex-pg-schema.sql`
  - `copy-openalex-csv.sql`

**3.B. Submit the flatten + Postgres import job**

- [ ] From `login-plus` in this repo, submit the flatten jobs (parallel is fine):
  - `sbatch 01-openalex-flatten-topics.sbatch`
  - `sbatch 02-openalex-flatten-authors.sbatch`
  - `sbatch 03-openalex-flatten-concepts.sbatch`
  - `sbatch 04-openalex-flatten-institutions.sbatch`
  - `sbatch 05-openalex-flatten-publishers.sbatch`
  - `sbatch 06-openalex-flatten-sources.sbatch`
  - `sbatch 07-openalex-flatten-works.sbatch`
- [ ] After flattening completes, submit:
  - `sbatch 08-openalex-dis-db-rest.sbatch`
- [ ] Monitor the jobs:
  - `squeue -u $USER`
- [ ] Logs:
  - `$STACK_ROOT/logs/openalex-pg-<jobid>/flatten-<entity>.log` (per flatten job)
  - `$STACK_ROOT/logs/openalex-pg-<jobid>/db.log` (DB job)

**3.C. What the job does automatically**

- [x] Flatten jobs (01-07):
  - Verify host `python` and log `python --version`.
  - Check `flatten-openalex-jsonl.py` at `$STACK_ROOT/flatten-openalex-jsonl.py`.
  - Run `python flatten-openalex-jsonl.py <entity>` from `$STACK_ROOT`, writing logs to `$STACK_ROOT/logs/openalex-pg-<jobid>/flatten-<entity>.log`.
  - Create or reuse `$STACK_ROOT/csv-files` for gzipped CSV outputs.
- [x] Inside the Postgres container (`08-openalex-dis-db-rest.sbatch`):
  - Reads the DB password from `/run/secrets/db_password`.
  - Ensures database `openalex_snapshot` exists (creates it if missing).
  - If `openalex-pg-schema.sql` is present at `$STACK_ROOT/openalex-pg-schema.sql`, applies it against `openalex_snapshot` to create all `openalex.*` tables and indexes.
  - If `copy-openalex-csv.sql` is present at `$STACK_ROOT/copy-openalex-csv.sql`, runs it from `/stack` so that the `\copy ... from program 'gunzip -c csv-files/...'` commands can see the CSV files under `csv-files/`.
  - Logs the exit codes of both the schema and copy scripts; if either fails, logs a clear error and stops Postgres.
  - On successful completion, shuts down Postgres cleanly and exits.

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
- [ ] Start Postgres via Apptainer using `08-openalex-dis-db-rest.sbatch` (or another Forska Postgres job).
- [ ] Create `openalex_snapshot` database (and optional `openalex_app` user).
- [ ] Load OpenAlex schema into `openalex_snapshot`.
- [ ] Bulk `COPY` / `\copy` all snapshot files into the corresponding tables.
- [ ] Run `VACUUM ANALYZE` and confirm row counts match expectations.
- [ ] Document a connection string (e.g. `DATABASE_URL_OPENALEX`) for Forska code to query this DB.
- [ ] Implement ETL queries/scripts to copy only relevant works into the main DB.
