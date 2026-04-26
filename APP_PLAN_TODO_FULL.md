# App Packaging Full Plan TODO

- This file tracks the full remaining desktop packaging and release work beyond landed items.
- Completed work lives in `APP_PLAN_IMPLEMENTED.md`.
- The active ElectroBun feasibility spike and phase-1 execution plan live in `APP_PLAN_TODO_SPIKE.md`.

## Goals

- Ship Forska as an installable desktop app for macOS and Windows first, with Linux later.
- Keep the current local-first model: local UI, local API/background work, local DuckDB/SQLite state, optional remote providers.
- Preserve the current browser-based workflow so `bun run dev:server`, `bun run dev:app`, and the non-desktop local web flow keep working.
- Require no manual Bun, Node, DuckDB CLI, `sqlite3`, or repo checkout for normal end users.
- Keep Codex CLI as an optional bring-your-own integration: users install it separately only if they want Codex features.
- Store user data, caches, logs, and imported assets in per-user app directories instead of the repo root.

## Current Repo Fit

- This repo is already close to a desktop product shape: Bun/Elysia backend, Solid/Vite frontend, DuckDB local data, SQLite local job state, and single-user local-first defaults.
- `src/server/utils/getDuckdbPath.ts` already has platform-aware default DB locations for macOS, Windows, and Linux.
- The main packaging risk is the runtime surface, not the UI: Bun APIs, native DB dependencies, local subprocesses, CLI fallbacks, and repo-root file assumptions.
- `src/appServer.ts` exists mainly to serve the built web app in a browser. The current ElectroBun spike already loads packaged renderer assets directly in the desktop shell, so `src/appServer.ts` is optional at desktop startup.

## Working Strategy

### Packaging Options

- ElectroBun: best first implementation track if the goal is to stay Bun-native end to end. Keep one packaged Bun backend process for API, migrations, and background work. Pros: best runtime alignment with the existing backend, least conceptual overhead for a Bun-first team, and the best chance of preserving the current backend boot model. Cons: highest uncertainty around production packaging, signing, updates, and native dependency edge cases.
- Electron + Bun sidecar: best fallback if ElectroBun blocks release work. Pros: lowest rewrite risk, mature macOS and Windows installer/signing ecosystem, and strong native module plus auto-update tooling. Cons: the largest bundle size and higher RAM use.
- Tauri + Bun sidecar: likely later optimization path if installer size becomes the main priority. Pros: smaller installers and a strong native shell story. Cons: more moving parts and higher first-release integration risk than Electron.
- Local service + browser wrapper: fastest internal alpha path. Pros: minimal desktop-shell work. Cons: it does not feel like a normal desktop app and gives worse lifecycle, startup, update, and UX control.

### Active Recommendation

- Use ElectroBun first.
- Run one packaged Bun backend process in `SERVER_ROLE=dev-single` first unless load testing proves split API/worker roles are necessary on user machines.
- Load the built frontend directly inside the desktop shell and inject the API origin from the shell, so `src/appServer.ts` becomes optional instead of required.
- Keep desktop support additive, not replacing the existing browser/server entrypoints.
- Treat Codex CLI as optional user-installed tooling in packaged builds; desktop startup and normal app flows must not depend on it.
- Do not bundle `sqlite3`; keep any `sqlite3` fallback or repair flows out of packaged startup, API serving, and normal user flows.
- Add remote upgrades only after unsigned macOS and Windows artifacts are repeatable and native dependencies are verified in packaged mode.
- Treat Electron as the fallback shell if ElectroBun blocks signed installers, native module packaging, or stable macOS/Windows distribution.
- Keep Tauri as the likely later optimization path if installer size becomes a priority.

### Success And Fallback Criteria

- Stay on ElectroBun if we can boot the app reliably on macOS and Windows, bundle the Bun backend, package `@duckdb/node-api`, and produce installable signed artifacts.
- Stay on ElectroBun if its update mechanism can check, download, apply, and relaunch signed macOS and Windows builds without damaging local user data, once remote upgrades are intentionally in scope.
- Fall back to Electron if ElectroBun blocks any of these for too long: app startup reliability, native module packaging, code signing, notarization, Windows installer generation, or update strategy.
- Preserve the current backend/frontend split so a shell swap stays low-risk if fallback is needed.

## Current Status Summary

- Status as of 2026-04-26: the overall packaging effort is still downstream of an active desktop feasibility spike tracked in `APP_PLAN_TODO_SPIKE.md`.
- The release path is still unproven: unsigned artifacts, Windows launch, native dependency packaging, signed installers, and remote upgrades are not complete.
- Current plan progress is still early and foundational, with the remaining work concentrated in packaging, cross-platform hardening, native dependency verification, signing, release operations, and upgrades.

### Not Done Yet

- There is no confirmed unsigned macOS artifact smoke test.
- There is no confirmed unsigned Windows artifact smoke test.
- Packaged Bun bundling is not implemented yet, and the backend artifact shape is not locked yet for clean-machine smoke tests.
- Packaged `@duckdb/node-api`, Bun SQLite, DuckDB migrations, SQLite job state, and restart/crash recovery are not verified.
- Core packaged validation that normal startup and API flows do not require `sqlite3` or other unbundled CLIs is still pending.
- The Windows strategy for subprocess lookup, spaces in profile paths, firewall prompts, and loopback behavior is unresolved.
- Optional Codex CLI lookup and missing-binary handling are not yet verified on packaged macOS or Windows builds.
- Release signing, notarization, installer generation, CI artifact publishing, and remote upgrades are not implemented.
- Settings already exposes server and worker runtime diagnostics, but desktop-specific diagnostics and shell actions are not implemented yet: surfaced app version, API port, data path, DB path, log path, update state, plus "Open data folder", "Open logs folder", and recovery UX for locked or corrupt local state.

### Recommended Next Steps

- Finish the remaining desktop runtime-write audit so all writable files land under app-owned user directories in packaged mode.
- Lock the packaged runtime shape first: bundle Bun, decide whether desktop ships backend source or a compiled backend artifact, and make clean-machine smoke tests validate that exact shape.
- Verify native dependencies and migrations inside packaged artifacts before investing in signing and auto-update UX.
- Prove the packaged app boots and serves normal user flows on clean machines without `codex`, `sqlite3`, or DuckDB CLI installed.
- Run a local macOS artifact smoke test on the chosen packaged shape, without relying on repo checkout or Bun already being on `PATH`.
- Run a Windows artifact smoke test on a native Windows machine or CI runner with the same clean-machine assumptions.
- Add the remote upgrade pipeline only after basic unsigned artifacts are reliable on macOS and Windows.

### Windows Current Answer

- Source/dev mode on Windows should be treated as possible but unverified.
- Packaged Windows usage is not ready for end users until a native Windows artifact has passed launch, quit, relaunch, API connectivity, data path, and native dependency smoke tests.
- Build Windows artifacts on Windows or on a native Windows CI runner; do not rely on macOS cross-building for the release decision.

## Target Architecture

- ElectroBun shell owns window lifecycle, single-instance lock, menus, logs, crash reporting, and app updates.
- Bun backend sidecar owns API routes, background work, migrations, DuckDB, SQLite, imports, and provider orchestration.
- Frontend is a packaged Vite build loaded by the shell, not by a separate local static server.
- Frontend gets API origin from desktop runtime config instead of assuming browser localhost behavior.
- Browser/web mode remains a supported entry path for local dev and non-desktop usage.
- All writable state lives under app-controlled user directories.

## Done Criteria

- A normal user can install Forska on macOS or Windows without installing Bun, Node, or checking out the repo.
- The app opens as a normal desktop window and manages its own backend lifecycle.
- The existing browser-based run mode still works for local development and non-desktop usage.
- First launch creates local storage safely and runs required migrations.
- Restart, crash recovery, import flows, and background work all function in packaged mode.
- User data lives in stable per-user OS app directories.
- Core packaged startup and normal app usage work without `codex`, DuckDB CLI, or `sqlite3` installed; optional Codex usage is install-guided.
- Remote upgrades can update the app without touching local user data, and failures leave the previous app usable, once remote upgrades are intentionally in scope.
- The same packaging strategy leaves a clear path for Linux later.

## Quality Gates

- `bun run build`
- `bun run desktop:build`
- `bun run lint`
- `bun test src/server/utils/getDuckdbPath.test.ts`
- `bun test src/server/utils/runtimeWritablePath.test.ts`
- `bun test src/server/utils/backgroundServerStack.test.ts`
- `bun test src/server/utils/duckdbBinary.test.ts`
- `bun test src/desktop/getDesktopRuntimeConfig.test.ts`
- `bun test src/desktop/desktopSingleInstance.test.ts`
- `bun test src/app/utils/getDesktopApiOrigin.test.ts`
- `bun test src/app/utils/getApiRequestUrl.test.ts`
- `bun test src/app/utils/getRuntimeAssetUrl.test.ts`
- Run targeted ElectroBun packaging smoke tests on the chosen packaged Bun/backend shape.
- ElectroBun verify: unsigned macOS artifact opens a desktop window, starts the backend, and reaches a healthy app state.
- ElectroBun verify: unsigned Windows artifact opens a desktop window, starts the backend, and reaches a healthy app state.
- Browser verify: `bun run dev:server` and `bun run dev:app` still boot successfully and the app works in a normal browser.
- Browser verify: existing built web flow still serves and loads correctly outside the desktop shell.
- macOS verify: clean install, first launch, restart, import one dataset, configure one provider, then quit and relaunch successfully.
- Windows verify: clean install, first launch, restart, import one dataset, configure one provider, then quit and relaunch successfully.
- Packaged app verify: core startup, API, import, provider setup, quit, and relaunch work on a clean machine with no Bun, Node, DuckDB CLI, `sqlite3`, or `codex` installed.
- Packaged app verify: missing `codex` does not block startup and the app surfaces install guidance before any Codex-only action.
- Packaged app verify: all writable files land in app-owned user directories, not the repo root or install directory.
- Release-only after remote upgrades are intentionally in scope: install version N-1, create local data, publish version N, check for update, download, apply, relaunch, and confirm local data is intact.
- Release-only after remote upgrades are intentionally in scope: failed update download or failed apply leaves the current app version and user data usable.
- Release-only after remote upgrades are intentionally in scope: app version, release channel, update status, data path, and log path are visible in diagnostics.

## Repo Findings And Hotspots

- [ ] `src/server/cron/judgmentsJobs/judgmentJobSqliteService.ts` still shells out to `sqlite3` for fallback repair flows, so packaged desktop needs to keep that path maintenance-only and out of core runtime requirements.
- [ ] `src/server/utils/getCodexAppServerClient.ts` still needs a platform-aware packaged-build audit so optional user-installed Codex lookup works consistently and fails gracefully when `codex` is absent.
- [ ] Packaged builds still need the remaining audit of runtime writes that can touch `cache/`, `assets/`, temp files, lock files, exports, DuckDB, SQLite, or generated diagnostics.
- [ ] `electrobun.config.ts` currently has no `release.baseUrl`, and `src/desktop/index.ts` does not use ElectroBun's `Updater`, so remote upgrades are not wired yet.

## Active Spike

- See `APP_PLAN_TODO_SPIKE.md` for the active ElectroBun feasibility spike, the source-first runtime-shape decision, and the current phase-1 execution plan.

## Detailed Checklist

### 1. Architecture Decision

- [ ] Close the active ElectroBun feasibility spike in `APP_PLAN_TODO_SPIKE.md` with a continue-or-fallback decision.
- [ ] Define supported targets for v1: macOS Intel/Apple Silicon, Windows x64, and Linux later.
- [ ] Define what "works offline" means versus what still needs network access for providers and remote runtimes.

### 2. Desktop Shell Bootstrap

- See `APP_PLAN_IMPLEMENTED.md` for landed shell bootstrap work and `APP_PLAN_TODO_SPIKE.md` for the active phase-1 shell work; remaining release tasks are tracked under sections 5, 8, 9, and 15 below.

### 3. Frontend Runtime Wiring

- [ ] Verify browser built-mode behavior still works when the app is opened outside the desktop shell.

### 4. Data, Cache, Import, And Log Paths

- [ ] Finish the remaining runtime-write audit so packaged builds stop writing runtime files under repo-root paths like `cache/` and `assets/`.
- [ ] Verify DuckDB, SQLite, WAL, lock files, temp directories, exports, and generated diagnostics all stay inside app-owned writable locations during packaged runs.
- [ ] Confirm packaged smoke runs keep routine backend telemetry in runtime JSONL and use `backend.log` as launcher capture only for startup and fatal diagnostics.
- [ ] Add UI affordances for "Open data folder" and "Open logs folder".

### 5. Cross-Platform Hardening

- [ ] Audit runtime code paths that derive writable locations from `process.cwd()` and replace them with explicit runtime paths.
- [ ] Audit path parsing and separators for Windows correctness.
- [ ] Audit hard-coded Bun global paths and macOS-specific binary lookup assumptions for optional Codex and DuckDB CLI discovery.
- [ ] Make the packaged desktop DB-path source of truth explicit: either keep `src/desktop/getDesktopRuntimeConfig.ts` as the packaged owner or route packaged defaults back through `src/server/utils/getDuckdbPath.ts`.
- [ ] Audit spawned subprocess commands for Windows-safe quoting and executable lookup.
- [ ] Audit temp-file, lock-file, and export-file naming for spaces and Windows path rules.
- [ ] Add a packaged desktop API-port strategy that handles occupied ports with either a free-loopback fallback or an actionable startup failure path.

### 6. External Binary Strategy

- [ ] Bundle Bun in the packaged app and make the first clean-machine artifact smoke tests validate that packaged runtime.
- [ ] Do not bundle `sqlite3`; keep any `sqlite3`-based repair or export paths out of packaged startup, API serving, and normal user flows.
- [ ] Keep DuckDB CLI optional for diagnostics only, not required for packaged startup or core flows.
- [ ] Keep Codex CLI as an optional bring-your-own integration in packaged builds; users install and configure it separately if they want it.
- [ ] Make all optional external tools clearly discoverable in Settings with platform-specific install guidance and unavailable-state UX.

### 7. Native Dependency Packaging

- [ ] Verify packaged startup with `@duckdb/node-api` on macOS.
- [ ] Verify packaged startup with `@duckdb/node-api` on Windows.
- [ ] Verify Bun SQLite behavior in the packaged backend.
- [ ] Verify migrations run correctly on first launch and app restart.
- [ ] Verify lock files and writer lease behavior survive restart and crash recovery.

### 8. Build And Packaging Pipeline

- [ ] Package backend entrypoints, runtime assets, migrations, native modules, and ElectroBun shell assets.
- [ ] Decide whether to ship backend source files or a compiled backend artifact before the first clean-machine artifact smoke tests.
- [ ] Create local macOS ElectroBun artifacts for smoke testing on the chosen packaged Bun/backend shape.
- [ ] Create local Windows ElectroBun artifacts for smoke testing on the chosen packaged Bun/backend shape.
- [ ] Make artifact naming consistent by version, platform, and architecture.
- [ ] Document the Electron fallback handoff so shell replacement stays isolated if needed.

### 9. UX And Product Polish

- [ ] Add a first-run experience that explains local storage, provider setup, and optional remote runtimes.
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

- [ ] Clean install on macOS with no Bun/Node preinstalled, using the chosen packaged Bun/backend shape.
- [ ] Clean install on Windows with no Bun/Node preinstalled, using the chosen packaged Bun/backend shape.
- [ ] Existing browser built flow still works after desktop packaging changes.
- [ ] App restart reuses the same DB and settings safely.
- [ ] Import flow works and stores files in app-owned paths.
- [ ] Provider setup works for at least one local/manual provider and one remote provider.
- [ ] Background jobs still run in packaged mode.
- [ ] App recovers from forced quit during active work.
- [ ] Occupied desktop API port either falls back to a free loopback port or fails with an actionable recovery message.
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
