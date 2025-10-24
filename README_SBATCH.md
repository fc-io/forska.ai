# Slurm sbatch examples (Apptainer)

These examples show how to run the database (Postgres), the GPU-backed vLLM server, and the web app using Apptainer on an HPC cluster managed by Slurm.

Before using these, follow the Host networking – for HPCs running Apptainer section in README.md to:
- Set `STACK_ROOT` and create the shared dirs (`pgdata`, `models`, `hf_cache`, `logs`, `.cache`).
- Pull the required SIF images into `$STACK_ROOT`.
- Create secrets under `$STACK_ROOT/.secrets` as described (database password and connection URL).
- Populate the database base

Assumptions
- Apptainer is available on the compute node.
- Ports 5432 (db), 8000 (vLLM), and 8123 (app) ain't conflicting and are reachable from where you access them (often via SSH tunnel).

