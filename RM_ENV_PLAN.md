# Remove Env Plan

## Goal

- [ ] Make Forska behave like an app, like OpenClaw, rather than a SaaS product that depends on shell env for core product behavior.
- [ ] Make persisted app settings live in DuckDB and the app UI/API, not in env files.
- [ ] Keep shell env only for true process/bootstrap/runtime wiring, machine-local paths, and secrets.

## Rules

- [ ] Adopt one rule: if a setting should survive restart and a normal user may reasonably change it, it should not live in shell env.
- [ ] Adopt one rule: shell env is allowed only for bootstrap, ports, local file paths, background-job toggles, machine-specific endpoints, and secrets.
- [x] Route all remaining env reads through one typed boundary; remove scattered direct `process.env` reads from app runtime code.

## Current Env Audit

- [x] Split current env keys into three buckets: keep in env, move to persisted config, delete.
- [x] Audit the direct `process.env` reads outside `src/server/utils/env.ts`.
- [x] Remove or centralize those direct `process.env` reads.
- [x] Mark legacy old-stack script envs separately so they do not block app-first cleanup.
- Remaining script env users kept separate: launcher/operator scripts `scripts/alvisCommon.ts`, `scripts/alvisSglangPull.ts`, `scripts/sbatchPut.ts`; legacy old-stack `scripts/env.ts`, `scripts/dbReindexAll.ts`, `scripts/dbRepairAllIndexes.ts`, `scripts/dbRepairJudgmentsIndex.ts`, `src/db/getDatabaseUrl.ts`.

## Next Focus

- [x] Keep local/manual provider base URLs and worker URLs in DuckDB via provider connections, not env.
- [x] Keep sbatch/Slurm worker URLs coming from launcher/runtime discovery rather than persisted app config.
- [x] Remove global `WORKER_URLS` as product config; only keep short-lived runtime wiring if a launcher still needs to pass discovered URLs.
- [x] Remove global env usage for `SGLANG_MODEL`, `SGLANG_CONTEXT_LENGTH`, and `CODEX_CONTEXT_LENGTH`.
- [x] Prefer deriving model identity/capabilities from provider/runtime discovery; only persist per-model/per-provider capability data when discovery is missing.
- [x] Remove raw `process.env` reads in judgment scheduling/runtime code.
- [x] Move `DUCKDB_BIN` and `CODEX_BIN` out of env; treat them as advanced user settings.
- [x] Treat provider base URLs/auth refs/worker URLs for local-manual providers as product config in DuckDB, not machine env.
- [x] Replace `DOCLING_SERVE_URL` with provider/model-backed PDF conversion config.
- [x] Decide which inference/runtime values are product config vs machine/operator metadata.
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

- [x] Move away from global `WORKER_URLS` env in app runtime.
- [x] Keep local/manual provider worker URLs in DuckDB only where they are real saved app config.
- [x] Keep sbatch/Slurm worker URLs out of persisted app config; derive them from launch/runtime state.
- [x] Decide config shape: keep provider/model-owned config in DuckDB for provider/model settings; only add `app.runtime_config` later if true cross-provider runtime state appears.
- [x] Remove global env usage for `SGLANG_MODEL`, `SGLANG_CONTEXT_LENGTH`, and `CODEX_CONTEXT_LENGTH`.
- [x] Prefer deriving `SGLANG_MODEL` from launch/runtime/provider state rather than storing one global value.
- [x] Prefer deriving context lengths from runtime/provider capabilities; persist per-model/per-provider fallback values only when discovery is unavailable.
- [x] Decide whether `GPU_NNODES`, `GPU_GPUS_PER_NODE`, `GPU_TOTAL_GPUS`, `TP_SIZE`, `PP_SIZE`, `DP_SIZE`, `GPU_SHAPE`, and `SGLANG_MAX_RUNNING_REQUESTS` stay env/runtime metadata or move to discovered/persisted runtime state.
- [x] Move `CODEX_MAX_INFLIGHT` and similar judgment-scheduler knobs out of raw `process.env`.
- [x] Update job scheduling and token logging to read the chosen config source instead of env.

## Keep As Env

- [x] Keep DuckDB bootstrap config in env: `DUCKDB_PATH`, `DUCKDB_MEMORY_LIMIT`, `DUCKDB_TEMP_DIRECTORY`.
- [x] Keep server/process wiring in env: `API_SERVER_PORT`, `VITE_PORT`, and similar launch-only values.
- [x] Keep background cron enable flags in env unless we intentionally build a runtime admin control surface for them.
- [x] Treat local provider endpoints as product settings in DuckDB; remove `DOCLING_SERVE_URL` from env.

## Cleanup Direct Env Usage

- [x] Remove direct `process.env` reads in judgment scheduling/runtime code and replace them with typed config reads.
- [x] Remove direct `process.env` reads in `src/appServer.ts` that belong in a clearer runtime config layer.
- [x] Move binary override envs such as `DUCKDB_BIN` and `CODEX_BIN` into advanced app/user settings.
- [x] Derive or generate `HOSTNAME`, `SERVER_JOB_ID`, and related process identity values instead of treating them as user-set env config.

## Migration And Rollout

- [x] Add migrations for provider connection/model config tables used to replace env-backed provider settings.
- [x] Add migrations for the persisted Unpaywall email field and any cleanup needed after removing OpenAlex-specific config.
- [x] Add local persisted settings storage for advanced binary overrides without reintroducing env config.
- [x] Add schema support for a DB-selected PDF conversion model instead of relying on `DOCLING_SERVE_URL`.
- [ ] Optional: add a bootstrap path for any remaining legacy env-backed contact values we still care to preserve.
- [x] Update docs to say that core app behavior is configured in the app, not by editing env files.
- [x] Remove stale env examples and old no-auth wording that still points users at env for app features.
- [ ] Verify the app still works after restart with only minimal env set.

## Done When

- [ ] A normal user can install and run Forska without editing shell env for core product features.
- [x] Unpaywall contact email and persisted local provider/model config live in DuckDB and the UI/API.
- [x] Remote sbatch/Slurm worker URLs are runtime-discovered rather than stored as app config.
- [x] `OPENALEX_MAILTO` and the OpenAlex article import flow are gone.
- [ ] The remaining env surface is small, explicit, and operational rather than product-facing.
