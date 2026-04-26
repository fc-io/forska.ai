# App Packaging Plan Implemented

- Shared strategy lives in `APP_PLAN.md`.
- Remaining work lives in `APP_PLAN_TODO.md`.

## Current Status Summary

- Status as of 2026-04-25: this is still an active desktop feasibility spike. See `APP_PLAN_TODO.md` for remaining blockers and release work.
- The local ElectroBun dev path is working enough to prove the basic shape: desktop shell, Bun backend sidecar, packaged frontend loading, API bridge, startup UI, logs, and single-instance protection.

### Done Now

- ElectroBun is selected as the first shell, with Electron kept as the fallback.
- `bun run desktop:dev` and `bun run desktop:build` exist.
- The desktop shell starts a separate Bun backend in `SERVER_ROLE=dev-single`.
- The desktop shell waits for backend readiness before showing the main UI.
- Startup splash and startup error screens exist.
- Desktop single-instance protection exists.
- Frontend API origin can come from desktop runtime config while browser dev mode keeps its normal behavior.
- Provider runtime records, Covidence import files, DuckDB path defaults, and backend launcher logs have at least an initial app-owned path story.
- `src/server/utils/duckdbBinary.ts` no longer assumes `:` for `PATH` parsing on Windows.

## Repo Findings And Hotspots

- [x] `src/utils/providerRuntimeRecords.ts` now goes through `resolveRuntimeWritablePath({pathValue: 'cache/providerRuntimeRecords'})`, so desktop mode can move runtime records under the desktop data root.
- [x] `src/server/services/covidenceImportService.ts` now uses runtime path helpers for `assets/covidence_imports`, so desktop mode can move imports under the desktop data root.
- [x] `src/server/utils/duckdbBinary.ts` uses platform-aware `PATH` separators and `.exe` candidates.

## ElectroBun Feasibility Spike

### Completed First Tasks

- [x] Add a minimal `desktop/` or equivalent ElectroBun app scaffold plus Bun scripts for desktop dev and desktop build.
- [x] Load the existing frontend build inside the ElectroBun window without changing current browser dev commands.
- [x] Add a desktop runtime config path so the frontend can read a shell-provided API origin while browser mode keeps its current behavior.
- [x] Launch the Bun backend as a separate desktop sidecar in `SERVER_ROLE=dev-single` and wait for a ready signal before showing the main window.

### Current Spike Status

- Done in local ElectroBun dev: the desktop window opens, the Bun sidecar starts in `SERVER_ROLE=dev-single`, the frontend reaches the local API, and the normal browser dev commands still boot.

## Detailed Checklist

### 1. Architecture Decision

- [x] Lock the first-shell choice to ElectroBun.
- [x] Confirm v1 runtime shape: one Bun backend process in `dev-single` mode.
- [x] Decide whether the ElectroBun shell launches a separate backend process or embeds startup in-process. Default: separate backend process.
- [x] Confirm that `src/appServer.ts` is removed from the packaged path or kept only for web builds.
- [x] Confirm that current browser/server commands remain first-class supported workflows.
- [x] Define explicit fallback triggers for switching the shell layer to Electron.

### 2. Desktop Shell Bootstrap

- [x] Add an ElectroBun desktop entrypoint and folder for shell-specific code.
- [x] Start the Bun backend on app launch.
- [x] Wait for backend readiness before showing the main UI.
- [x] Surface a startup error screen when migration or backend boot fails.
- [x] Stop the backend cleanly when the app quits.
- [x] Add single-instance protection so two app launches do not race for the same local DB.

### 3. Frontend Runtime Wiring

- [x] Replace localhost-only API resolution with a shell-provided API origin for packaged builds.
- [x] Keep existing browser/dev behavior working for `bun run dev:app` and `bun run dev:server`.
- [x] Add a packaged-build path for TanStack router deep links and refreshes.
- [x] Add a backend-unavailable state in the UI instead of generic fetch failures.

### 4. Data, Cache, Import, And Log Paths

- [x] Move provider runtime records from `cache/providerRuntimeRecords` to an app cache directory.
- [x] Move Covidence import storage from `assets/covidence_imports` to an app data or imports directory.
- [x] Add log-file locations for backend stdout, stderr, crash details, and migration failures.

### 5. Cross-Platform Hardening

- [x] Fix `src/server/utils/duckdbBinary.ts` PATH parsing so it does not assume `:` on Windows.

### 8. Build And Packaging Pipeline

- [x] Add ElectroBun desktop build commands for local unsigned artifacts.
- [x] Build the Solid frontend once for desktop packaging.
- [x] Keep existing web build and local browser startup commands unchanged or provide compatibility aliases.

### 9. UX And Product Polish

- [x] Add a startup splash or progress UI while the backend warms up.

### 14. Test Matrix

- [x] Existing browser dev flow still works with `bun run dev:server` plus `bun run dev:app`.
- [x] First launch creates data directories and runs migrations.

## Commands Run For This Plan

- `bun run build`
- `bun run desktop:dev`
- `bun run dev:app`
- `bun run dev:server`
- `bun test src/app/utils/getApiRequestUrl.test.ts`
- `bun test src/app/utils/client-env.test.ts`
- `bun test src/desktop/getDesktopRuntimeConfig.test.ts`
- `bun test src/desktop/desktopSingleInstance.test.ts`
- `bun test src/server/utils/duckdbBinary.test.ts`
- `bunx eslint src/desktop/index.ts src/desktop/getDesktopRuntimeConfig.ts src/desktop/getDesktopRuntimeConfig.test.ts src/app/index.tsx src/services/apiClient.ts src/app/utils/postFormDataToApi.ts 'src/app/routes/+projects/+$id/+export.tsx' src/app/utils/client-env.ts src/app/utils/client-env.test.ts`
