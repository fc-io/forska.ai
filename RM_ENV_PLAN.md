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

- [ ] Split current env keys into three buckets: keep in env, move to persisted config, delete.
- [ ] Review all direct `process.env` reads outside `src/server/utils/env.ts` and either fold them into the typed boundary or remove them.
- [ ] Mark legacy old-stack script envs separately so they do not block app-first cleanup.

## User Config Move

- [x] Add a persisted user setting for Unpaywall contact email under `app.user_config.unpaywall_email`.
- [x] Add a real read/write server path for `app.user_config` for the local settings flow.
- [x] Update the settings UI to edit the persisted Unpaywall email instead of showing a readonly env-derived value.
- [x] Change PDF retrieval paths that need a contact email to read it from persisted user config.
- [ ] Add one-time bootstrap behavior: if a legacy env-backed contact value exists and the DB value is empty, copy it once and stop treating env as the source of truth.

## Remove OpenAlex Env And Import

- [x] Remove `OPENALEX_MAILTO` from `src/server/utils/env.ts` and all runtime callers.
- [x] Remove the OpenAlex article import flow entirely.
- [x] Remove OpenAlex import routes, helpers, and UI entry points that only exist for that flow.
- [x] Remove OpenAlex-specific wording from settings and other user-facing screens.
- [x] Drop `app.user_config.openalex_mailto` after the OpenAlex import removal.

## Inference Config Move

- [ ] Stop syncing `WORKER_URLS` from env into `app.model.worker_urls`; make the DB value authoritative.
- [ ] Decide where global inference settings live: extend existing tables or add a single-row `app.runtime_config` table.
- [ ] Move `SGLANG_MODEL`, `SGLANG_CONTEXT_LENGTH`, and `CODEX_CONTEXT_LENGTH` into persisted config owned by the inference/model layer.
- [ ] Decide whether `GPU_NNODES`, `GPU_GPUS_PER_NODE`, `GPU_TOTAL_GPUS`, `TP_SIZE`, `PP_SIZE`, `DP_SIZE`, `GPU_SHAPE`, and `SGLANG_MAX_RUNNING_REQUESTS` are persisted settings, detected runtime state, or both.
- [ ] Move `CODEX_MAX_INFLIGHT` out of raw `process.env` and into the chosen runtime config surface if it is still a product setting.
- [ ] Update job scheduling and token logging to read runtime metadata from persisted or discovered state instead of env.

## Keep As Env

- [ ] Keep DuckDB bootstrap config in env: `DUCKDB_PATH`, `DUCKDB_MEMORY_LIMIT`, `DUCKDB_TEMP_DIRECTORY`.
- [ ] Keep server/process wiring in env: `API_SERVER_PORT`, `VITE_PORT`, and similar launch-only values.
- [ ] Keep background cron enable flags in env unless we intentionally build a runtime admin control surface for them.
- [ ] Keep machine-local external endpoints in env only if they are deployment wiring rather than product settings.

## Cleanup Direct Env Usage

- [ ] Remove direct `process.env` reads in judgment scheduling code and replace them with typed config reads.
- [ ] Remove direct `process.env` reads in `src/appServer.ts` that belong in a clearer runtime config layer.
- [ ] Audit binary override envs such as `DUCKDB_BIN` and `CODEX_BIN` and decide whether they stay as advanced runtime envs.
- [ ] Audit `HOSTNAME`, `SERVER_JOB_ID`, and related process identity values and keep them only if they are operational metadata.

## Migration And Rollout

- [ ] Add migrations for any new config tables or columns.
- [x] Add migrations for the persisted Unpaywall email field and any cleanup needed after removing OpenAlex-specific config.
- [ ] Add a bootstrap path that imports legacy env-backed contact values into DuckDB only when persisted values are missing.
- [ ] Update docs to say that core app behavior is configured in the app, not by editing env files.
- [ ] Remove stale env examples and old no-auth wording that still points users at env for app features.
- [ ] Verify the app still works after restart with only minimal env set.

## Done When

- [ ] A normal user can install and run Forska without editing env vars for core product features.
- [ ] Unpaywall contact email, worker/model config, and other app behavior live in DuckDB and the UI/API.
- [x] `OPENALEX_MAILTO` and the OpenAlex article import flow are gone.
- [ ] The remaining env surface is small, explicit, and operational rather than product-facing.
