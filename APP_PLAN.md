# App Packaging Plan

- Shared plan context lives here.
- Implemented work is tracked in `APP_PLAN_IMPLEMENTED.md`.
- Remaining work is tracked in `APP_PLAN_TODO.md`.

## Goal

- Ship Forska as an installable desktop app for macOS and Windows first, with Linux later.
- Keep the current local-first model: local UI, local API/background work, local DuckDB/SQLite state, optional remote providers.
- Preserve the current browser-based workflow so `bun run dev:server`, `bun run dev:app`, and the non-desktop local web flow keep working.
- Require no manual Bun, Node, DuckDB CLI, or repo checkout for normal end users.
- Store user data, caches, logs, and imported assets in per-user app directories instead of the repo root.

## Current Repo Fit

- This repo is already close to a desktop product shape: Bun/Elysia backend, Solid/Vite frontend, DuckDB local data, SQLite local job state, and single-user local-first defaults.
- `src/server/utils/getDuckdbPath.ts` already has platform-aware default DB locations for macOS, Windows, and Linux.
- The main packaging risk is not the UI. The risk is the runtime surface: Bun APIs, native DB dependencies, local subprocesses, CLI fallbacks, and repo-root file assumptions.
- `src/appServer.ts` exists mainly to serve the built web app in a browser. The desktop shell can avoid that extra process by loading packaged renderer assets directly.

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

### Spike Exit Criteria

- A desktop window opens and loads the app UI.
- The desktop shell starts the Bun backend successfully.
- The frontend can talk to the local API in desktop mode.
- Local writable state lands in app-owned directories rather than the repo root or install directory.
- `bun run dev:server` plus `bun run dev:app` still work in a normal browser.
- There is a clear list of remaining blockers for signed release packaging.

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
- Remote upgrades can update the app without touching local user data, and failures leave the previous app usable.
- The same packaging strategy leaves a clear path for Linux later.

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
