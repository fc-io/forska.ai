# App Packaging Plan TODO

- Shared strategy lives in `APP_PLAN.md`.
- Completed work lives in `APP_PLAN_IMPLEMENTED.md`.

## Current Status Summary

- Status as of 2026-04-25: this is an active desktop feasibility spike, not a releasable installer yet.
- The release path is still unproven: unsigned artifacts, Windows launch, native dependency packaging, signed installers, and remote upgrades are not complete.
- Current plan progress is roughly one quarter done by checklist count, with the remaining work concentrated in packaging, cross-platform hardening, native dependency verification, signing, release operations, and upgrades.

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

## Repo Findings And Hotspots

- [ ] `src/server/cron/judgmentsJobs/judgmentJobSqliteService.ts` still shells out to `sqlite3` for fallback repair flows, so Windows packaging needs an explicit strategy.
- [ ] `src/server/utils/getCodexAppServerClient.ts` still needs a platform-aware packaged-build audit for Bun-global and macOS-style binary lookup assumptions.
- [ ] Packaged builds still need an audit of every runtime write that can touch `cache/`, `assets/`, temp files, lock files, exports, logs, DuckDB, SQLite, or generated diagnostics.
- [ ] `electrobun.config.ts` currently has no `release.baseUrl`, and `src/desktop/index.ts` does not use ElectroBun's `Updater`, so remote upgrades are not wired yet.

## ElectroBun Feasibility Spike

### Remaining First Tasks

- [ ] Complete the desktop-mode path helper and audit for DB, cache, imports, temp files, exports, lock files, and logs so packaged runs stop depending on repo-root writes.
- [ ] Verify migrations, DuckDB boot, SQLite job state, and `@duckdb/node-api` all work in desktop mode on a local smoke run.
- [ ] Produce one unsigned macOS artifact and confirm launch, quit, relaunch, and basic in-app API connectivity.
- [ ] Produce one unsigned Windows artifact and confirm launch, quit, relaunch, and basic in-app API connectivity.
- [ ] Record blockers, required repo refactors, and an explicit continue-or-fallback decision versus Electron.

### Current Spike Status

- Still open before calling the spike complete: unsigned macOS and Windows artifact smoke tests, packaged native dependency verification, and a final blocker list plus continue-or-fallback call.

### Current Blockers

- Unsigned macOS and Windows artifact creation and relaunch smoke tests are still pending.
- Packaged `@duckdb/node-api` verification is still pending on macOS and Windows.
- Windows strategy for the `sqlite3` fallback flow in `judgmentJobSqliteService.ts` is still unresolved.
- Packaged Codex CLI and Bun binary path resolution still need a platform-aware audit.
- Signing, notarization, installer generation, and remote upgrade strategy are not started.
- `electrobun.config.ts` has no release host configured, and the desktop shell does not call `Updater.checkForUpdate`, `Updater.downloadUpdate`, or `Updater.applyUpdate`.

## Detailed Checklist

### 1. Architecture Decision

- [ ] Time-box an ElectroBun feasibility spike for macOS and Windows packaging.
- [ ] Define supported targets for v1: macOS Intel/Apple Silicon, Windows x64, and Linux later.
- [ ] Define what "works offline" means versus what still needs network access for providers and remote runtimes.

### 3. Frontend Runtime Wiring

- [ ] Keep browser built-mode behavior working when the app is opened outside the desktop shell.
- [ ] Audit code that assumes `/api` proxying through the app server.

### 4. Data, Cache, Import, And Log Paths

- [ ] Introduce one shared runtime-path helper for app data, cache, temp, logs, exports, and imports.
- [ ] Default structured runtime JSONL to `logs/runtime/<profile>/` via `src/server/utils/runtimeWritablePath.ts` so repo runs write under the repo and packaged desktop runs write under the desktop data root.
- [ ] Stop writing runtime files under repo-root paths like `cache/` and `assets/` in packaged builds.
- [ ] Keep DuckDB, SQLite, WAL, lock files, and temp directories inside app-owned writable locations.
- [ ] Keep the packaged desktop backend on the shared structured logging model: `SERVER_ROLE=dev-single`, `dev-single-server-YYYY-MM-DD.jsonl`, and 7-day pruning under the desktop data root.
- [ ] Treat `backend.log` as launcher capture only for startup and fatal diagnostics; routine backend telemetry should live in runtime JSONL instead.
- [ ] Make the shared runtime-path helper and desktop runtime config cooperate with `LOG_DIR`, `LOG_LEVEL`, `LOG_STDERR_LEVEL`, and `FORSKA_RUNTIME_PROFILE`.
- [ ] Add UI affordances for "Open data folder" and "Open logs folder".

### 5. Cross-Platform Hardening

- [ ] Audit all `process.cwd()` runtime writes and replace them with explicit runtime paths.
- [ ] Audit path parsing and separators for Windows correctness.
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

- [ ] Package backend entrypoints, runtime assets, migrations, native modules, and ElectroBun shell assets.
- [ ] Decide whether to ship backend source files or a compiled backend artifact.
- [ ] Create local macOS ElectroBun artifacts for smoke testing.
- [ ] Create local Windows ElectroBun artifacts for smoke testing.
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

- [ ] Clean install on macOS with no Bun/Node preinstalled.
- [ ] Clean install on Windows with no Bun/Node preinstalled.
- [ ] Existing browser built flow still works after desktop packaging changes.
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
