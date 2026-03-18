# Remove Env Plan

## Goal

- [ ] Make Forska behave like an app, like OpenClaw, rather than a SaaS product that depends on env vars for core product behavior.
- [ ] Make persisted app settings live in DuckDB and the app UI/API, not in `.env.local`.
- [ ] Keep env vars only for true process/bootstrap/runtime wiring, machine-local paths, and secrets.

## Rules

- [ ] Adopt one rule: if a setting should survive restart and a normal user may reasonably change it, it should not live in env.
- [ ] Adopt one rule: env is allowed only for bootstrap, ports, local file paths, background-job toggles, machine-specific endpoints, and secrets.
- [ ] Route all remaining env reads through one typed boundary; remove scattered direct `process.env` reads from app runtime code.

## Current Env Audit

- [x] Split current env keys into three buckets: keep in env, move to persisted config, delete.
- [x] Audit the direct `process.env` reads outside `src/server/utils/env.ts`.
- [ ] Remove or centralize those direct `process.env` reads.
- [ ] Mark legacy old-stack script envs separately so they do not block app-first cleanup.

## Next Focus

- [ ] Split worker-url handling by runtime: local/manual provider URLs may live in DuckDB; sbatch/Slurm worker URLs should come from launcher/runtime discovery, not persisted app config.
- [ ] Remove global `WORKER_URLS` as product config; only keep short-lived runtime wiring if a launcher still needs to pass discovered URLs.
- [ ] Keep model capability/config in the DB: `SGLANG_MODEL`, `SGLANG_CONTEXT_LENGTH`, `CODEX_CONTEXT_LENGTH`.
- [ ] Remove raw `process.env` reads in judgment scheduling/runtime code.
- [ ] Decide which inference/runtime values are product config vs machine/operator metadata.
- [ ] After the inference move, do docs cleanup and a minimal-env startup check.

## User Config Move

- [x] Add a persisted user setting for Unpaywall contact email under `app.user_config.unpaywall_email`.
- [x] Add a real read/write server path for `app.user_config` for the local settings flow.
- [x] Update the settings UI to edit the persisted Unpaywall email instead of showing a readonly env-derived value.
- [x] Change PDF retrieval paths that need a contact email to read it from persisted user config.
- [ ] Optional: add one-time bootstrap behavior for old installs if we still care about importing legacy env-backed contact values.

## Remove OpenAlex Env And Import

- [x] Remove `OPENALEX_MAILTO` from `src/server/utils/env.ts` and all runtime callers.
- [x] Remove the OpenAlex article import flow entirely.
- [x] Remove OpenAlex import routes, helpers, and UI entry points that only exist for that flow.
- [x] Remove OpenAlex-specific wording from settings and other user-facing screens.
- [x] Drop `app.user_config.openalex_mailto` after the OpenAlex import removal.

## Inference Config Move

- [ ] Move away from global `WORKER_URLS` env in app runtime.
- [ ] Keep local/manual provider worker URLs in DuckDB only where they are real saved app config.
- [ ] Keep sbatch/Slurm worker URLs out of persisted app config; derive them from launch/runtime state.
- [ ] Decide config shape: provider/model-owned config in DuckDB vs a small `app.runtime_config` table for true persisted runtime settings.
- [ ] Move `SGLANG_MODEL`, `SGLANG_CONTEXT_LENGTH`, and `CODEX_CONTEXT_LENGTH` into DB-backed inference config.
- [ ] Decide whether `GPU_NNODES`, `GPU_GPUS_PER_NODE`, `GPU_TOTAL_GPUS`, `TP_SIZE`, `PP_SIZE`, `DP_SIZE`, `GPU_SHAPE`, and `SGLANG_MAX_RUNNING_REQUESTS` stay env/runtime metadata or move to discovered/persisted runtime state.
- [ ] Move `CODEX_MAX_INFLIGHT` and similar judgment-scheduler knobs out of raw `process.env`.
- [ ] Update job scheduling and token logging to read the chosen config source instead of env.

## Keep As Env

- [x] Keep DuckDB bootstrap config in env: `DUCKDB_PATH`, `DUCKDB_MEMORY_LIMIT`, `DUCKDB_TEMP_DIRECTORY`.
- [x] Keep server/process wiring in env: `API_SERVER_PORT`, `VITE_PORT`, and similar launch-only values.
- [x] Keep background cron enable flags in env unless we intentionally build a runtime admin control surface for them.
- [ ] Keep machine-local external endpoints in env only if they are deployment wiring rather than product settings.

## Cleanup Direct Env Usage

- [ ] Remove direct `process.env` reads in judgment scheduling/runtime code and replace them with typed config reads.
- [ ] Remove direct `process.env` reads in `src/appServer.ts` that belong in a clearer runtime config layer.
- [ ] Decide whether binary override envs such as `DUCKDB_BIN` and `CODEX_BIN` stay as advanced runtime envs.
- [ ] Decide whether `HOSTNAME`, `SERVER_JOB_ID`, and related process identity values stay as operational metadata.

## Migration And Rollout

- [ ] Add migrations for any new config tables or columns.
- [x] Add migrations for the persisted Unpaywall email field and any cleanup needed after removing OpenAlex-specific config.
- [ ] Optional: add a bootstrap path for any remaining legacy env-backed contact values we still care to preserve.
- [ ] Update docs to say that core app behavior is configured in the app, not by editing env files.
- [ ] Remove stale env examples and old no-auth wording that still points users at env for app features.
- [ ] Verify the app still works after restart with only minimal env set.

## Done When

- [ ] A normal user can install and run Forska without editing env vars for core product features.
- [ ] Unpaywall contact email and persisted local provider/model config live in DuckDB and the UI/API.
- [ ] Remote sbatch/Slurm worker URLs are runtime-discovered rather than stored as app config.
- [x] `OPENALEX_MAILTO` and the OpenAlex article import flow are gone.
- [ ] The remaining env surface is small, explicit, and operational rather than product-facing.
