# Dev Run Plan

## Goal

- Make `primary` and `secondary` first-class local runtime profiles.
- Give each profile isolated app/API/worker/app-server ports.
- Give each profile isolated DuckDB + judgment-job SQLite/lease files.
- Keep `bun run ...` UX simple; no `.env`/`dotenv` flow.

## Why

- Current side-by-side flow depends on manual env export.
- Port-only split is not enough.
- Judgment-job SQLite files live under `dirname(DUCKDB_PATH)/judgment-jobs`, so separate DB filenames alone still share SQLite state if parent dir matches.

## Target UX

- Keep `primary` implicit:
  - `bun run dev:server`
  - `bun run dev:app`
  - `bun run start`
  - `bun run db:mig`
  - `bun run dev:server:api`
  - `bun run dev:server:worker`
- Add explicit `secondary` commands:
  - `bun run dev:secondary:server`
  - `bun run dev:secondary:server:api`
  - `bun run dev:secondary:server:worker`
  - `bun run dev:secondary:app`
  - `bun run start:secondary`
  - `bun run db:mig:secondary`
- Skip explicit `primary` aliases in v1.

## Profile defaults

- `primary`
  - `VITE_PORT=3000`
  - `API_SERVER_PORT=3001`
  - `BACKGROUND_WRITER_PORT=3002`
  - `APP_SERVER_PORT=8080`
  - `DUCKDB_PATH=data/runtime/primary/forska.duckdb`
- `secondary`
  - `VITE_PORT=3100`
  - `API_SERVER_PORT=3101`
  - `BACKGROUND_WRITER_PORT=3102`
  - `APP_SERVER_PORT=8180`
  - `DUCKDB_PATH=data/runtime/secondary/forska.duckdb`
- Resulting SQLite roots:
  - `data/runtime/primary/judgment-jobs/`
  - `data/runtime/secondary/judgment-jobs/`

## Implementation

### 1. Add runtime profile source of truth

- Add `src/utils/runtimeProfile.ts`.
- Define profile names, ports, data root, DuckDB path.
- Export helpers:
  - get profile config
  - map profile config to env values
  - merge profile env with caller overrides

### 2. Add profile runner script

- Add `scripts/runWithRuntimeProfile.ts`.
- Inputs: profile + target mode.
- Modes:
  - stacked server
  - api-only server
  - worker-only server
  - app dev
  - app server
  - db migrate
- Spawn existing commands/entrypoints with profile env.
- Keep split API/worker wiring explicit via `SERVER_ROLE` + `SERVER_WRITER_URL`.

### 3. Rewire package scripts

- Repoint current default commands to `primary` runner.
- Keep `primary` short-name commands only.
- Add split `primary` commands: `dev:server:api`, `dev:server:worker`.
- Add full `secondary` command set.
- Keep current script names working.
- Keep `db:duck:mig` aligned with `primary` or alias to `db:mig:primary`.

### 4. Keep runtime code env-driven

- Do not add `dotenv`.
- Keep `src/server/utils/env.ts`, `src/server/utils/getAppServerRuntimeConfig.ts`, and `vite.config.ts` reading `process.env`.
- Make profiles only a launcher concern.

### 5. Docs

- Update `README.md`.
- Update `docs/README_RUN_LOCAL.md`.
- Document `primary` vs `secondary` commands.
- Document repo-local data roots and why SQLite isolation follows DuckDB parent dir.
- Document when to use stacked vs split API/worker commands.

## File touch list

- `package.json`
- `src/utils/runtimeProfile.ts`
- `scripts/runWithRuntimeProfile.ts`
- `README.md`
- `docs/README_RUN_LOCAL.md`
- tests for runtime profile helpers/launcher behavior

## Risks

- `db:mig` and `db:mig:secondary` must hit different DB paths.
- `secondary` app dev must proxy to `secondary` API, not `primary`.
- `secondary` split API must point to `secondary` worker URL.
- Existing default commands must remain stable for `primary`.

## Rollout

- Phase 1: profile foundation
  - add `src/utils/runtimeProfile.ts`
  - add `scripts/runWithRuntimeProfile.ts`
  - wire `db:mig` + `db:mig:secondary`
  - prove isolated DuckDB + `judgment-jobs` roots
- Phase 2: dev commands
  - wire `dev:server`, `dev:app`, `dev:server:api`, `dev:server:worker`
  - wire `dev:secondary:server`, `dev:secondary:app`, `dev:secondary:server:api`, `dev:secondary:server:worker`
  - verify stacked + split modes both work
- Phase 3: built app + docs
  - wire `start` + `start:secondary`
  - update `README.md` + `docs/README_RUN_LOCAL.md`
  - document `primary` vs `secondary` behavior

## Quality Gates

- Phase 1 pass: `bun test src/utils/runtimeProfile.test.ts`
- Phase 1 pass: `bun run db:mig`
- Phase 1 pass: `bun run db:mig:secondary`
- Pass: `bun test src/server/utils/backgroundServerStack.test.ts`
- Phase 2 pass: browser verify `primary` + `secondary` dev run together; separate ports; separate DuckDB files; separate `judgment-jobs` dirs
- Pass: `bun run build`
- Phase 3 pass: browser verify built `start` + `start:secondary` point at the correct API/profile
