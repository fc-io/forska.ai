# App Packaging Plan

## Goal

- Ship Forska as an installable desktop app for macOS and Windows first, with Linux later.
- Keep the current local-first model: local UI, local API/background work, local DuckDB/SQLite state, optional remote providers.
- Preserve the current browser-based workflow so `bun run dev:server`, `bun run dev:app`, and the non-desktop local web flow keep working.
- Require no manual Bun, Node, DuckDB CLI, or repo checkout for normal end users.
- Store user data, caches, logs, and imported assets in per-user app directories instead of the repo root.

## Current Status Summary

- Status as of 2026-04-25: this is an active desktop feasibility spike, not a releasable installer yet.
- The local ElectroBun dev path is working enough to prove the basic shape: desktop shell, Bun backend sidecar, packaged frontend loading, API bridge, startup UI, logs, and single-instance protection.
- The release path is still unproven: unsigned artifacts, Windows launch, native dependency packaging, signed installers, and remote upgrades are not complete.
- Current plan progress is roughly one quarter done by checklist count, with the remaining work concentrated in packaging, cross-platform hardening, native dependency verification, signing, release operations, and upgrades.

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

### Not Done Yet

- There is no confirmed unsigned macOS artifact smoke test.
- There is no confirmed unsigned Windows artifact smoke test.
- Packaged `@duckdb/node-api`, Bun SQLite, DuckDB migrations, SQLite job state, and restart/crash recovery are not verified.
- The Windows strategy for `sqlite3`, subprocess lookup, spaces in profile paths, firewall prompts, and loopback behavior is unresolved.
- Release signing, notarization, installer generation, CI artifact publishing, and remote upgrades are not implemented.
- App diagnostics, "Open data folder", "Open logs folder", and recovery UX for locked or corrupt local state are not implemented.

### Recommended Next Steps

- Finish the desktop runtime path audit so all writable files land under app-owned user directories in packaged mode.
- Run a local macOS artifact smoke test: build, launch, quit, relaunch, confirm API, confirm data/log paths.
- Run a Windows artifact smoke test on a native Windows machine or CI runner.
- Verify native dependencies and migrations inside packaged artifacts before investing in signing and auto-update UX.
- Decide the external binary policy for Bun, DuckDB CLI, `sqlite3`, and Codex CLI.
- Add the remote upgrade pipeline only after basic unsigned artifacts are reliable on macOS and Windows.

### Windows Current Answer

- Source/dev mode on Windows should be treated as possible but unverified.
- Packaged Windows usage is not ready for end users until a native Windows artifact has passed launch, quit, relaunch, API connectivity, data path, and native dependency smoke tests.
- Build Windows artifacts on Windows or on a native Windows CI runner; do not rely on macOS cross-building for the release decision.

## Current Repo Fit

- This repo is already close to a desktop product shape: Bun/Elysia backend, Solid/Vite frontend, DuckDB local data, SQLite local job state, and single-user local-first defaults.
- `src/server/utils/getDuckdbPath.ts` already has platform-aware default DB locations for macOS, Windows, and Linux.
- The main packaging risk is not the UI. The risk is the runtime surface: Bun APIs, native DB dependencies, local subprocesses, CLI fallbacks, and repo-root file assumptions.
- `src/appServer.ts` exists mainly to serve the built web app in a browser. The desktop shell can avoid that extra process by loading packaged renderer assets directly.

## Repo Findings And Hotspots

- [x] `src/utils/providerRuntimeRecords.ts` now goes through `resolveRuntimeWritablePath({pathValue: 'cache/providerRuntimeRecords'})`, so desktop mode can move runtime records under the desktop data root.
- [x] `src/server/services/covidenceImportService.ts` now uses runtime path helpers for `assets/covidence_imports`, so desktop mode can move imports under the desktop data root.
- [x] `src/server/utils/duckdbBinary.ts` uses platform-aware `PATH` separators and `.exe` candidates.
- [ ] `src/server/cron/judgmentsJobs/judgmentJobSqliteService.ts` still shells out to `sqlite3` for fallback repair flows, so Windows packaging needs an explicit strategy.
- [ ] `src/server/utils/getCodexAppServerClient.ts` still needs a platform-aware packaged-build audit for Bun-global and macOS-style binary lookup assumptions.
- [ ] Packaged builds still need an audit of every runtime write that can touch `cache/`, `assets/`, temp files, lock files, exports, logs, DuckDB, SQLite, or generated diagnostics.
- [ ] `electrobun.config.ts` currently has no `release.baseUrl`, and `src/desktop/index.ts` does not use ElectroBun's `Updater`, so remote upgrades are not wired yet.

## Options

### Option 1 - ElectroBun

- Best first implementation track if the goal is to stay Bun-native end to end.
- Use an ElectroBun shell for the desktop window and keep one packaged Bun backend process for API, migrations, and background work.
- Pros:
  - Best runtime alignment with the existing backend.
  - Potentially the least conceptual overhead for a Bun-first team.
  - May let us keep more of the current backend boot model intact.
- Cons:
  - Highest uncertainty around production packaging, signing, updates, and native dependency edge cases.
  - Needs an explicit fallback plan if macOS or Windows release work gets blocked.

### Option 2 - Electron + Bun sidecar

- Best fit for the current codebase.
- Keep the existing Bun backend mostly intact and launch it from an Electron main process.
- Load the built frontend inside Electron and point it at a local loopback API.
- Pros:
  - Lowest rewrite risk.
  - Mature macOS and Windows installer/signing ecosystem.
  - Strong docs and packaging tooling around native modules and auto-update.
- Cons:
  - Largest bundle size.
  - Higher RAM use because Chromium ships with the app.

### Option 3 - Tauri + Bun sidecar

- Good long-term option if installer size matters a lot.
- Use Tauri for the native shell and still run the Bun backend as a bundled sidecar.
- Pros:
  - Smaller installers.
  - Strong native shell story.
- Cons:
  - More moving parts right now: Rust shell, Bun sidecar, native module packaging, OS-specific sidecar rules.
  - Higher integration risk than Electron for a first production desktop release.

### Option 4 - Local service + browser wrapper

- Simplest path for an internal alpha.
- Install a local Bun service and open the UI in the default browser.
- Pros:
  - Fastest to ship.
  - Minimal desktop-shell work.
- Cons:
  - Does not feel like a normal desktop app.
  - Worse lifecycle, startup, update, and UX control.

## Recommendation

- Use ElectroBun first.
- Run one packaged Bun backend process in `SERVER_ROLE=dev-single` first unless load testing proves the split API/worker model is necessary on user machines.
- Load the built frontend directly inside the desktop shell and inject the API origin from the shell, so `src/appServer.ts` becomes optional instead of required.
- Keep desktop support additive, not replacing the existing browser/server entrypoints.
- Add remote upgrades only after unsigned macOS and Windows artifacts are repeatable and native dependencies are verified in packaged mode.
- Treat Electron as the fallback shell if ElectroBun blocks signed installers, native module packaging, or stable macOS/Windows distribution.
- Keep Tauri as the likely later optimization path if installer size becomes a priority.

## ElectroBun Success And Fallback Criteria

- Stay on ElectroBun if we can boot the app reliably on macOS and Windows, bundle the Bun backend, package `@duckdb/node-api`, and produce installable signed artifacts.
- Stay on ElectroBun if its update mechanism can check, download, apply, and relaunch signed macOS and Windows builds without damaging local user data.
- Fall back to Electron if ElectroBun blocks any of these for too long: app startup reliability, native module packaging, code signing, notarization, Windows installer generation, or update strategy.
- Preserve the current backend/frontend split so a shell swap stays low-risk if fallback is needed.

## ElectroBun Feasibility Spike

### Goal

- Prove ElectroBun can run Forska as a desktop app on macOS and Windows without breaking the current browser-based workflow.

### Non-Goals

- Signed installers.
- Auto-update.
- Tray or menu bar polish.
- Linux packaging.
- Full product UX polish.

### Deliverables

- A minimal ElectroBun shell scaffold in the repo.
- One Bun backend sidecar boot path for desktop mode.
- A renderer path that loads the existing built frontend inside the desktop shell.
- A short blocker list with a go/no-go recommendation for continuing on ElectroBun.

### First Tasks

- [x] Add a minimal `desktop/` or equivalent ElectroBun app scaffold plus Bun scripts for desktop dev and desktop build.
- [x] Load the existing frontend build inside the ElectroBun window without changing current browser dev commands.
- [x] Add a desktop runtime config path so the frontend can read a shell-provided API origin while browser mode keeps its current behavior.
- [x] Launch the Bun backend as a separate desktop sidecar in `SERVER_ROLE=dev-single` and wait for a ready signal before showing the main window.
- [ ] Complete the desktop-mode path helper and audit for DB, cache, imports, temp files, exports, lock files, and logs so packaged runs stop depending on repo-root writes.
- [ ] Verify migrations, DuckDB boot, SQLite job state, and `@duckdb/node-api` all work in desktop mode on a local smoke run.
- [ ] Produce one unsigned macOS artifact and confirm launch, quit, relaunch, and basic in-app API connectivity.
- [ ] Produce one unsigned Windows artifact and confirm launch, quit, relaunch, and basic in-app API connectivity.
- [ ] Record blockers, required repo refactors, and an explicit continue-or-fallback decision versus Electron.

### Spike Exit Criteria

- A desktop window opens and loads the app UI.
- The desktop shell starts the Bun backend successfully.
- The frontend can talk to the local API in desktop mode.
- Local writable state lands in app-owned directories rather than the repo root or install directory.
- `bun run dev:server` plus `bun run dev:app` still work in a normal browser.
- There is a clear list of remaining blockers for signed release packaging.

### Current Spike Status

- Done in local ElectroBun dev: the desktop window opens, the Bun sidecar starts in `SERVER_ROLE=dev-single`, the frontend reaches the local API, and the normal browser dev commands still boot.
- Still open before calling the spike complete: unsigned macOS and Windows artifact smoke tests, packaged native dependency verification, and a final blocker list plus continue-or-fallback call.

### Current Blockers

- Unsigned macOS and Windows artifact creation and relaunch smoke tests are still pending.
- Packaged `@duckdb/node-api` verification is still pending on macOS and Windows.
- Windows strategy for the `sqlite3` fallback flow in `judgmentJobSqliteService.ts` is still unresolved.
- Packaged Codex CLI and Bun binary path resolution still need a platform-aware audit.
- Signing, notarization, installer generation, and remote upgrade strategy are not started.
- `electrobun.config.ts` has no release host configured, and the desktop shell does not call `Updater.checkForUpdate`, `Updater.downloadUpdate`, or `Updater.applyUpdate`.

### Spike Quality Gates

- `bun run build`
- `bun test src/app/utils/getApiRequestUrl.test.ts`
- `bun test src/server/utils/getDuckdbPath.test.ts`
- Browser verify: `bun run dev:server` and `bun run dev:app` still boot and the app works in a normal browser.
- ElectroBun verify: local desktop dev build opens a window, starts the backend, and reaches a healthy app state.
- ElectroBun verify: unsigned macOS and Windows artifacts launch and can reach the local API.

## Target Architecture

- ElectroBun shell owns window lifecycle, single-instance lock, menus, logs, crash reporting, and app updates.
- Bun backend sidecar owns API routes, background work, migrations, DuckDB, SQLite, imports, and provider orchestration.
- Frontend is a packaged Vite build loaded by the shell, not by a separate local static server.
- Frontend gets API origin from desktop runtime config instead of assuming browser localhost behavior.
- Browser/web mode remains a supported entry path for local dev and non-desktop usage.
- All writable state lives under app-controlled user directories.

## Detailed Checklist

### 1. Architecture Decision

- [x] Lock the first-shell choice to ElectroBun.
- [ ] Time-box an ElectroBun feasibility spike for macOS and Windows packaging.
- [x] Confirm v1 runtime shape: one Bun backend process in `dev-single` mode.
- [x] Decide whether the ElectroBun shell launches a separate backend process or embeds startup in-process. Default: separate backend process.
- [x] Confirm that `src/appServer.ts` is removed from the packaged path or kept only for web builds.
- [x] Confirm that current browser/server commands remain first-class supported workflows.
- [ ] Define supported targets for v1: macOS Intel/Apple Silicon, Windows x64, and Linux later.
- [ ] Define what "works offline" means versus what still needs network access for providers and remote runtimes.
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
- [ ] Keep browser built-mode behavior working when the app is opened outside the desktop shell.
- [ ] Audit code that assumes `/api` proxying through the app server.
- [x] Add a packaged-build path for TanStack router deep links and refreshes.
- [x] Add a backend-unavailable state in the UI instead of generic fetch failures.

### 4. Data, Cache, Import, And Log Paths

- [ ] Introduce one shared runtime-path helper for app data, cache, temp, logs, exports, and imports.
- [ ] Default structured runtime JSONL to `logs/runtime/<profile>/` via `src/server/utils/runtimeWritablePath.ts` so repo runs write under the repo and packaged desktop runs write under the desktop data root.
- [ ] Stop writing runtime files under repo-root paths like `cache/` and `assets/` in packaged builds.
- [x] Move provider runtime records from `cache/providerRuntimeRecords` to an app cache directory.
- [x] Move Covidence import storage from `assets/covidence_imports` to an app data or imports directory.
- [ ] Keep DuckDB, SQLite, WAL, lock files, and temp directories inside app-owned writable locations.
- [x] Add log-file locations for backend stdout, stderr, crash details, and migration failures.
- [ ] Keep the packaged desktop backend on the shared structured logging model: `SERVER_ROLE=dev-single`, `dev-single-server-YYYY-MM-DD.jsonl`, and 7-day pruning under the desktop data root.
- [ ] Treat `backend.log` as launcher capture only for startup and fatal diagnostics; routine backend telemetry should live in runtime JSONL instead.
- [ ] Make the shared runtime-path helper and desktop runtime config cooperate with `LOG_DIR`, `LOG_LEVEL`, `LOG_STDERR_LEVEL`, and `FORSKA_RUNTIME_PROFILE`.
- [ ] Add UI affordances for "Open data folder" and "Open logs folder".

### 5. Cross-Platform Hardening

- [ ] Audit all `process.cwd()` runtime writes and replace them with explicit runtime paths.
- [ ] Audit path parsing and separators for Windows correctness.
- [x] Fix `src/server/utils/duckdbBinary.ts` PATH parsing so it does not assume `:` on Windows.
- [ ] Audit hard-coded Bun global paths and macOS-specific binary lookup assumptions for Codex and DuckDB.
- [ ] Verify `src/server/utils/getDuckdbPath.ts` remains the single default DB-path source for packaged builds.
- [ ] Audit spawned subprocess commands for Windows-safe quoting and executable lookup.
- [ ] Audit temp-file, lock-file, and export-file naming for spaces and Windows path rules.

### 6. External Binary Strategy

- [ ] Decide whether the packaged app bundles Bun or requires a side-installed Bun runtime. Default: bundle Bun.
- [ ] Decide whether the packaged app bundles `sqlite3` fallback tooling or disables that fallback on platforms where it is unavailable.
- [ ] Decide whether the packaged app bundles a DuckDB CLI or keeps it optional for diagnostics only.
- [ ] Define the support policy for Codex CLI integration in packaged builds.
- [ ] Make all optional external tools clearly discoverable in Settings with platform-specific guidance.

### 7. Native Dependency Packaging

- [ ] Verify packaged startup with `@duckdb/node-api` on macOS.
- [ ] Verify packaged startup with `@duckdb/node-api` on Windows.
- [ ] Verify Bun SQLite behavior in the packaged backend.
- [ ] Verify migrations run correctly on first launch and app restart.
- [ ] Verify lock files and writer lease behavior survive restart and crash recovery.

### 8. Build And Packaging Pipeline

- [x] Add ElectroBun desktop build commands for local unsigned artifacts.
- [x] Build the Solid frontend once for desktop packaging.
- [ ] Package backend entrypoints, runtime assets, migrations, native modules, and ElectroBun shell assets.
- [ ] Decide whether to ship backend source files or a compiled backend artifact.
- [x] Keep existing web build and local browser startup commands unchanged or provide compatibility aliases.
- [ ] Create local macOS ElectroBun artifacts for smoke testing.
- [ ] Create local Windows ElectroBun artifacts for smoke testing.
- [ ] Make artifact naming consistent by version, platform, and architecture.
- [ ] Document the Electron fallback handoff so shell replacement stays isolated if needed.

### 9. UX And Product Polish

- [ ] Add a first-run experience that explains local storage, provider setup, and optional remote runtimes.
- [x] Add a startup splash or progress UI while the backend warms up.
- [ ] Add a clear recovery path when the local DB is locked, corrupt, or mid-migration.
- [ ] Add app-level diagnostics: version, data path, API port, DB path, log path, and backend health.
- [ ] Decide whether the app should minimize to tray/menu bar or fully quit.
- [ ] Decide what happens on uninstall: keep user data by default or offer explicit cleanup.

### 10. Security And Network Posture

- [ ] Restrict the backend to loopback-only access in packaged mode unless a user explicitly enables LAN access later.
- [ ] Audit CORS and origin rules for packaged desktop origins.
- [ ] Ensure secrets remain in OS-managed user storage and not in repo-relative files.
- [ ] Review whether any local debug/admin endpoints should be hidden or disabled in packaged builds.
- [ ] Document what traffic can leave the machine and under which provider modes.

### 11. macOS Release Work

- [ ] Set up Developer ID signing.
- [ ] Set up notarization.
- [ ] Verify install, first launch, update, and relaunch on clean macOS machines.
- [ ] Verify Apple Silicon and Intel behavior.
- [ ] Verify file permissions and app-data locations under normal user accounts.

### 12. Windows Release Work

- [ ] Set up code signing.
- [ ] Choose installer format: MSI, EXE, or both.
- [ ] Verify install, first launch, update, and relaunch on clean Windows machines.
- [ ] Verify behavior with spaces in user profile paths.
- [ ] Verify firewall prompts and loopback access behavior.

### 13. Linux Later

- [ ] Keep runtime paths XDG-compliant.
- [ ] Avoid introducing macOS-only or Windows-only assumptions into core runtime code.
- [ ] Decide later between AppImage, deb/rpm, Flatpak, or another Linux distribution format.
- [ ] Reuse the same backend path, migration, and loopback strategy where possible.

### 14. Test Matrix

- [ ] Clean install on macOS with no Bun/Node preinstalled.
- [ ] Clean install on Windows with no Bun/Node preinstalled.
- [x] Existing browser dev flow still works with `bun run dev:server` plus `bun run dev:app`.
- [ ] Existing browser built flow still works after desktop packaging changes.
- [x] First launch creates data directories and runs migrations.
- [ ] App restart reuses the same DB and settings safely.
- [ ] Import flow works and stores files in app-owned paths.
- [ ] Provider setup works for at least one local/manual provider and one remote provider.
- [ ] Background jobs still run in packaged mode.
- [ ] App recovers from forced quit during active work.
- [ ] Uninstall leaves or removes data according to the chosen product rule.

### 15. Remote Upgrade Strategy

- [ ] Decide whether remote upgrades ship in v1 or wait until after stable signed installer releases.
- [ ] Add a release host decision: S3, Cloudflare R2, GitHub Releases, or another static host.
- [ ] Add `release.baseUrl` to `electrobun.config.ts` once the release host is chosen.
- [ ] Add release channels, at minimum `stable`; optionally add `canary` for internal smoke builds.
- [ ] Add build scripts for channel builds, for example `desktop:build:stable` and `desktop:build:canary`.
- [ ] Add native CI jobs that build macOS and Windows artifacts on their own OS runners.
- [ ] Upload all generated update metadata, full artifacts, and patch artifacts to the release host.
- [ ] Keep older patch artifacts available so older installed versions can step through upgrades.
- [ ] Add desktop updater wiring in the shell with explicit states: idle, checking, available, downloading, ready, applying, failed, and up to date.
- [ ] Add a manual "Check for updates" affordance in Settings or diagnostics before enabling background update checks.
- [ ] Decide whether update downloads should happen automatically or only after user confirmation.
- [ ] Before applying an update, pause or drain background work, stop the backend sidecar cleanly, then apply and relaunch.
- [ ] Preserve user data across upgrades by keeping DuckDB, SQLite, imports, logs, settings, and provider secrets outside the install directory.
- [ ] Add an upgrade compatibility policy for database migrations: never downgrade schemas silently, record app version at migration time, and surface failed migrations with a recovery path.
- [ ] Add a rollback policy: publish a higher version to recover from a bad release rather than replacing an existing version in place.
- [ ] Add signed-update verification gates before enabling updates for normal users.
- [ ] Document the Electron fallback equivalent: `electron-builder` plus `electron-updater`, should ElectroBun updates fail the smoke gates.

### 16. Release Operations

- [ ] Add CI jobs for desktop artifact builds.
- [ ] Add versioning rules for app releases versus backend changes.
- [ ] Add a manual release checklist for signing, smoke tests, and rollback.
- [ ] Publish platform-specific install docs and troubleshooting notes.

## Quality Gates

- `bun run build`
- `bun run lint`
- `bun test src/server/utils/getDuckdbPath.test.ts`
- `bun test src/server/utils/backgroundServerStack.test.ts`
- `bun test src/server/utils/duckdbBinary.test.ts`
- `bun test src/app/utils/getApiRequestUrl.test.ts`
- Add and run targeted ElectroBun packaging smoke tests once the shell exists.
- ElectroBun verify: unsigned macOS artifact opens a desktop window, starts the backend, and reaches a healthy app state.
- ElectroBun verify: unsigned Windows artifact opens a desktop window, starts the backend, and reaches a healthy app state.
- Browser verify: `bun run dev:server` and `bun run dev:app` still boot successfully and the app works in a normal browser.
- Browser verify: existing built web flow still serves and loads correctly outside the desktop shell.
- macOS verify: clean install, first launch, restart, import one dataset, configure one provider, then quit and relaunch successfully.
- Windows verify: clean install, first launch, restart, import one dataset, configure one provider, then quit and relaunch successfully.
- Packaged app verify: all writable files land in app-owned user directories, not the repo root or install directory.
- Upgrade verify: install version N-1, create local data, publish version N, check for update, download, apply, relaunch, and confirm local data is intact.
- Upgrade verify: failed update download or failed apply leaves the current app version and user data usable.
- Upgrade verify: app version, release channel, update status, data path, and log path are visible in diagnostics.

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

## Done Criteria

- A normal user can install Forska on macOS or Windows without installing Bun, Node, or checking out the repo.
- The app opens as a normal desktop window and manages its own backend lifecycle.
- The existing browser-based run mode still works for local development and non-desktop usage.
- First launch creates local storage safely and runs required migrations.
- Restart, crash recovery, import flows, and background work all function in packaged mode.
- User data lives in stable per-user OS app directories.
- Remote upgrades can update the app without touching local user data, and failures leave the previous app usable.
- The same packaging strategy leaves a clear path for Linux later.
