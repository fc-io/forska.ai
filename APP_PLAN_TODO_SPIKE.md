# App Packaging Spike TODO

- This file tracks the active ElectroBun feasibility spike and the next phase-1 execution plan.
- Full packaging and release work live in `APP_PLAN_TODO_FULL.md`.
- Completed work lives in `APP_PLAN_IMPLEMENTED.md`.

## Goal

- Prove ElectroBun can run Forska as a desktop app without breaking `bun run dev:server`, `bun run dev:app`, or the non-desktop web flow.
- Lock a source-first packaged runtime shape and validate clean-machine desktop startup for core user flows.
- Use macOS as the first artifact gate, then repeat the same runtime shape on native Windows.

## Locked Decisions

- Use ElectroBun first and keep Electron as the fallback shell.
- Use one Bun backend sidecar in `SERVER_ROLE=dev-single`.
- Use a source-first backend artifact for this spike.
- Bundle Bun in the packaged app.
- Load the built frontend directly in the desktop shell.
- Do not bundle `sqlite3`.
- Keep DuckDB CLI optional for diagnostics only.
- Keep Codex CLI as optional bring-your-own tooling.
- Do not start signed installers, auto-update, or release-ops work in this spike.

## Current Starting Point

- `package.json` already has `desktop:dev` and `desktop:build`.
- `src/desktop/index.ts` already launches the backend sidecar, bridges `/api` requests, and waits for `/api/runtime/ready`.
- `src/desktop/getDesktopRuntimeConfig.ts` still resolves Bun from the host machine and still defaults desktop API to `32101`.
- `electrobun.config.ts` still copies `src` and `node_modules` directly, so the packaged runtime shape is not locked yet.
- `src/server/utils/getCodexAppServerClient.ts` still falls back to host-installed `codex`.
- `src/server/cron/judgmentsJobs/judgmentJobSqliteService.ts` still shells out to `sqlite3` for maintenance fallback flows.

## Exit Criteria

- An unsigned macOS artifact opens a desktop window, starts the packaged Bun backend, and reaches a healthy app state.
- The artifact does not rely on repo checkout, Bun on `PATH`, DuckDB CLI, `sqlite3`, or `codex` for startup or normal app usage.
- First launch, quit, relaunch, one import, and one provider setup work with app-owned user directories.
- Browser workflows still work with `bun run dev:server` and `bun run dev:app`.
- The same source-first runtime shape is ready for a native Windows smoke run.
- The spike ends with an explicit continue-or-fallback decision versus Electron.

## Phase 1 Recommendation

- Start with the smallest artifact that can pass real smoke tests: packaged Bun plus backend source plus packaged frontend assets.
- Do not spend time on compiled backend artifacts, signed installers, updater wiring, or release channels before the source-first shape passes macOS smoke tests.

## Phase 1 Workstreams

### 1. Runtime Shape Lock-In

- Goal: remove host-Bun and repo-root assumptions from the packaged desktop boot path.
Files:
- `electrobun.config.ts`
- `src/desktop/getDesktopRuntimeConfig.ts`
- `src/desktop/index.ts`
- `package.json` if helper scripts become necessary
Deliverables:
- Packaged Bun is resolved from the artifact before any host fallback.
- Backend entrypoint resolution is artifact-relative and deterministic.
- Startup errors include resolved Bun path, backend entrypoint, API origin, data root, and log path.
Quality Gates:
- `bun run build`
- `bun run desktop:build`
- Unsigned macOS artifact launches without repo checkout or Bun on `PATH`.

### 2. Runtime-Write Audit

- Goal: keep all packaged runtime writes under the desktop data root while preserving relative `assets/...` keys.
Files:
- `src/server/utils/runtimeWritablePath.ts`
- `src/server/services/structuredFileImportService.ts`
- `src/server/routes/ArticleAdminRoutes.ts`
- `src/server/cron/fullTextJobs/fullTextArticleFetchFromArxiv.ts`
- `src/server/cron/fullTextJobs/fullTextArticleFetchFromUnpaywall.ts`
- `src/server/cron/fullTextJobs/fullTextArticleFetchFromOriginalUrls.ts`
- `src/server/routes/RuntimeAssetsRoutes.ts`
Deliverables:
- Structured imports, uploaded PDFs, fetched PDFs, and runtime asset reads resolve through app-owned paths in desktop mode.
- DB-stored `assets/...` references keep working in browser and desktop flows.
Quality Gates:
- `bun test src/server/utils/runtimeWritablePath.test.ts`
- Browser verify: existing built web flow still serves and loads runtime assets correctly.

### 3. Native Dependency And Startup Verification

- Goal: prove the packaged backend can actually start, migrate, and reopen local state.
Files:
- `src/server/index.ts`
- `src/server/serverMain.ts`
- `src/server/utils/backgroundServerStack.ts`
- `src/server/utils/duckdbService.ts`
- `src/server/services/readOnlyDuckdbService.ts`
- `src/server/cron/judgmentsJobs/judgeWorkerCompletionJournal.ts`
- `src/server/cron/judgmentsJobs/judgmentJobSqliteService.ts`
Deliverables:
- `@duckdb/node-api` loads in the packaged backend.
- `bun:sqlite` works for job state and restart.
- Migrations run on first launch and relaunch.
- Restart and crash recovery leave local data usable.
Quality Gates:
- `bun test src/server/utils/getDuckdbPath.test.ts`
- `bun test src/server/utils/backgroundServerStack.test.ts`
- `bun test src/server/utils/duckdbBinary.test.ts`
- macOS verify: first launch, quit, relaunch.

### 4. Port And Loopback Hardening

- Goal: packaged desktop should not fail opaquely when the default port is already taken.
Files:
- `src/desktop/getDesktopRuntimeConfig.ts`
- `src/desktop/index.ts`
- `src/server/serverMain.ts`
- `src/utils/runtimePortDefaults.ts` if shared defaults need to change
Deliverables:
- Occupied desktop API port either falls back to a free loopback port or shows an actionable startup error.
- Packaged mode stays loopback-only.
Quality Gates:
- `bun test src/desktop/getDesktopRuntimeConfig.test.ts`
- `bun test src/desktop/desktopSingleInstance.test.ts`
- macOS verify: launch with the default port already occupied.

### 5. Optional CLI Behavior

- Goal: missing optional CLIs must never block startup or normal use.
Files:
- `src/server/utils/getCodexAppServerClient.ts`
- `src/server/serverMain.ts`
- `src/server/cron/judgmentsJobs/judgmentJobSqliteService.ts`
Deliverables:
- Missing `codex` does not block startup.
- Codex-only flows surface install guidance before use.
- `sqlite3` remains maintenance-only and is not required for packaged core flows.
Quality Gates:
- `bun run lint`
- Packaged app verify: startup, API, import, provider setup, quit, and relaunch all work with no `codex` or `sqlite3` installed.

### 6. macOS Smoke Run

- Goal: validate the chosen source-first shape under clean-machine assumptions.
Commands:
- `bun run build`
- `bun run desktop:build`
Manual Checks:
- Open the unsigned artifact.
- Confirm the backend reaches `/api/runtime/ready`.
- Import one dataset.
- Configure one provider.
- Quit and relaunch.
- Confirm writes land under the per-user desktop data root, not the repo root or install directory.

### 7. Windows Follow-On

- Goal: repeat the same source-first artifact assumptions on native Windows before expanding scope.
Preconditions:
- macOS source-first artifact passes the full smoke run.
Manual Checks:
- Launch, quit, relaunch.
- API connectivity.
- Data root and log path.
- Spaces in user profile paths.
- No `sqlite3` or `codex` required for core flows.

## Continue Or Fallback Decision

- Continue on ElectroBun if the source-first artifact works on macOS, is ready to repeat on native Windows, and does not depend on host Bun or other unbundled CLIs for normal usage.
- Escalate to Electron if ElectroBun still blocks artifact reliability, packaged Bun resolution, native dependency loading, or basic macOS and Windows smoke validation after this phase.
