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
- `src/desktop/getDesktopRuntimeConfig.ts` still resolves Bun from `FORSKA_DESKTOP_BUN_BIN`, host lookup, or bare `bun` instead of an artifact-relative bundled Bun, and still defaults desktop API to `32101`.
- `electrobun.config.ts` still copies `src` and `node_modules` directly, so the packaged runtime shape is not locked yet; its `watchIgnore` entries also miss the dot-prefixed `.desktopArtifacts` and `.desktopBuild` folders configured for generated output.
- `src/server/utils/getCodexAppServerClient.ts` still falls back to host-installed `codex`.
- `src/server/serverMain.ts` still logs Codex guidance that points packaged users at a browser-dev URL instead of an in-app desktop flow.
- `src/server/cron/judgmentsJobs/judgmentJobSqliteService.ts` still shells out to `sqlite3` for maintenance fallback flows.
- `src/services/olap/duckdbRunner.ts` can still shell out to the DuckDB CLI for non-default DuckDB paths; the default app DB path is covered by the shared app database service.
- `src/server/cron/nvidiaSmi.ts` can still shell out to `ssh` and remote `nvidia-smi` for optional remote-worker telemetry.
- Runtime writable helpers are already wired into the known Covidence, structured import, uploaded PDF, fetched PDF, runtime asset serving, and PDF conversion local-file read paths; the remaining work is an audit plus packaged-mode verification rather than first implementation for those paths.
- Direct automated coverage is still missing for some listed runtime-write paths: uploaded PDF storage, fetched PDF storage, runtime asset serving, PDF conversion local-file reads, and FHIR desktop temp-spooling behavior.

## Exit Criteria

- An unsigned macOS artifact opens a desktop window, starts the packaged Bun backend, and reaches a healthy app state.
- The artifact does not rely on repo checkout, Bun on `PATH`, DuckDB CLI, `sqlite3`, `codex`, or optional telemetry CLIs such as `ssh` and `nvidia-smi` for startup or normal app usage.
- First launch, quit, relaunch, one import, and one non-Codex provider or manual provider setup work with app-owned user directories and no host CLI dependency.
- Browser workflows still work with `bun run dev:server` and `bun run dev:app`.
- At least one native Windows artifact smoke run is executed on the same source-first runtime shape and its results are captured.
- The spike ends with an explicit continue-or-fallback decision versus Electron.

## Phase 1 Recommendation

- Start with the smallest artifact that can pass real smoke tests: packaged Bun plus backend source plus packaged frontend assets.
- Do not spend time on compiled backend artifacts, signed installers, updater wiring, or release channels before the source-first shape passes macOS smoke tests and completes one native Windows smoke run.

## Phase 1 Workstreams

### 1. Runtime Shape Lock-In

Goal: remove host-Bun and repo-root assumptions from the packaged desktop boot path.

Files:

- `electrobun.config.ts`
- `src/desktop/getDesktopRuntimeConfig.ts`
- `src/desktop/index.ts`
- `package.json` if helper scripts become necessary

Deliverables:

- Packaged mode resolves only the bundled Bun from the artifact; `desktop:dev` may keep explicit or host Bun lookup, but that path must stay visibly separate from packaged startup.
- Missing bundled Bun fails with actionable diagnostics instead of silently falling back to host Bun.
- Backend entrypoint resolution is artifact-relative and deterministic.
- Startup errors include resolved Bun path, backend entrypoint, API origin, data root, and log path.
- ElectroBun watch ignores match the actual dot-prefixed build and artifact folders.

Quality Gates:

- `bun run lint`
- `bun test src/desktop/getDesktopRuntimeConfig.test.ts`
- `bun test src/app/utils/getDesktopApiOrigin.test.ts`
- `bun test src/app/utils/getApiRequestUrl.test.ts`
- `bun run build`
- `bun run desktop:build`
- Browser verify: `bun run dev:server` and `bun run dev:app` still boot after runtime-shape changes.
- Unsigned macOS artifact launches without repo checkout or Bun on `PATH`.

### 2. Runtime-Write Audit

Goal: keep first-spike packaged runtime writes under explicit desktop runtime locations while preserving relative `assets/...` keys.

Files:

- `src/server/utils/runtimeWritablePath.ts`
- `src/app/utils/getRuntimeAssetUrl.ts`
- `src/server/services/covidenceImportService.ts`
- `src/server/services/structuredFileImportService.ts`
- `src/server/routes/ArticleAdminRoutes.ts`
- `src/server/cron/fullTextJobs/fullTextArticleFetchFromArxiv.ts`
- `src/server/cron/fullTextJobs/fullTextArticleFetchFromUnpaywall.ts`
- `src/server/cron/fullTextJobs/fullTextArticleFetchFromOriginalUrls.ts`
- `src/server/routes/RuntimeAssetsRoutes.ts`
- `src/server/utils/convertPdfToText.ts`
- `src/agent/fhirEhrPatientsWorkflow/fhirEhrPatientsWorkflowStoreEntries.ts`

Deliverables:

- Structured imports, uploaded PDFs, fetched PDFs, and runtime asset reads resolve through app-owned paths in desktop mode.
- PDF conversion resolves DB-stored `assets/...` PDF paths through runtime file-path helpers before reading local files.
- FHIR EHR import temp spooling uses an explicit runtime temp location with cleanup in desktop mode, or is documented as intentionally OS-temp-only and verified not to touch the repo or install directory.
- DB-stored `assets/...` references keep working in browser and desktop flows.

Quality Gates:

- `bun run lint`
- `bun test src/server/utils/runtimeWritablePath.test.ts`
- `bun test src/app/utils/getRuntimeAssetUrl.test.ts`
- `bun test src/server/services/covidenceImportService.test.ts`
- `bun test src/server/services/structuredFileImportService.test.ts`
- Add `src/server/routes/ArticleAdminRoutes.test.ts` coverage for uploaded PDF desktop paths, then run `bun test src/server/routes/ArticleAdminRoutes.test.ts`.
- Add `src/server/cron/fullTextJobs/fullTextArticleFetchFromArxiv.test.ts`, `src/server/cron/fullTextJobs/fullTextArticleFetchFromUnpaywall.test.ts`, and `src/server/cron/fullTextJobs/fullTextArticleFetchFromOriginalUrls.test.ts` coverage for desktop paths, then run those three `bun test <file>` commands.
- Add `src/server/routes/RuntimeAssetsRoutes.test.ts` coverage for desktop-mode `assets/...` serving, then run `bun test src/server/routes/RuntimeAssetsRoutes.test.ts`.
- Add `src/server/utils/convertPdfToText.test.ts` coverage for desktop-mode PDF file reads, then run `bun test src/server/utils/convertPdfToText.test.ts`.
- Extend `src/agent/importerStoreEntries.test.ts` with desktop-mode FHIR temp-spooling coverage, then run `bun test src/agent/importerStoreEntries.test.ts`.
- Browser verify: existing built web flow still serves and loads runtime assets correctly.
- Manual verify: uploaded PDFs, fetched PDFs, runtime asset reads, and FHIR EHR temp spooling do not touch the repo root or install directory in desktop mode.

### 3. Native Dependency And Startup Verification

Goal: prove the packaged backend can actually start, migrate, and reopen local state.

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

- `bun run lint`
- `bun test src/server/utils/getDuckdbPath.test.ts`
- `bun test src/server/utils/backgroundServerStack.test.ts`
- `bun test src/server/utils/duckdbServiceNodeApiSpike.test.ts`
- `bun test src/server/indexStartup.test.ts`
- macOS verify: first launch, quit, relaunch.

### 4. Port And Loopback Hardening

Goal: packaged desktop should not fail opaquely when the default port is already taken.

Files:

- `src/desktop/getDesktopRuntimeConfig.ts`
- `src/desktop/index.ts`
- `src/server/serverMain.ts`
- `src/utils/runtimePortDefaults.ts` if shared defaults need to change

Deliverables:

- Occupied desktop API port either falls back to a free loopback port or shows an actionable startup error.
- Packaged mode stays loopback-only.

Quality Gates:

- `bun run lint`
- `bun test src/desktop/getDesktopRuntimeConfig.test.ts`
- `bun test src/desktop/desktopSingleInstance.test.ts`
- macOS verify: launch with the default port already occupied.

### 5. Optional CLI Behavior

Goal: missing optional CLIs must never block startup or normal use.

Files:

- `src/server/utils/getCodexAppServerClient.ts`
- `src/server/utils/codexCliAuth.ts`
- `src/server/serverMain.ts`
- `src/server/routes/ModelsRoutes.ts`
- `src/server/routes/ProviderConnectionsRoutes.ts`
- `src/server/routes/JudgmentsJobsRoutes.ts`
- `src/server/providers/providerAuthService.ts`
- `src/server/providers/adapters/codexAdapter.ts`
- `src/server/providers/transports/codexAppTransport.ts`
- `src/server/cron/judgmentsJobs/judgmentJobSqliteService.ts`
- `src/server/cron/nvidiaSmi.ts`
- `src/services/olap/duckdbRunner.ts`
- `src/server/utils/duckdbBinary.ts`
- `src/app/routes/+admin/+models/providerConnectionsClient.ts`
- `src/app/routes/+admin/+models/providerUiState.ts`
- `src/app/routes/+providers/+add-provider.tsx`
- `src/app/routes/+providers/+$id/+index.tsx`
- `src/app/routes/+settings/+index.tsx`

Deliverables:

- Missing `codex` does not block startup.
- Codex-only flows surface install and configuration guidance before use.
- `/api/models/codex/status` and `/api/models/codex/login` handle missing `codex` without unhandled spawn errors.
- `/api/provider-auth/codex/begin` and `/api/provider-auth/codex/finish` handle missing `codex` consistently with the direct Codex status/login routes.
- Packaged desktop guidance points users to in-app Providers or Settings flows rather than `http://localhost:${env.VITE_PORT}/providers`.
- `sqlite3` remains maintenance-only, is not invoked during packaged startup, restart, recovery, or core smoke flows, and explicit repair/diagnostic routes report degraded maintenance results if unavailable instead of unhandled spawn failures.
- DuckDB CLI use stays out of the default app database query path in packaged mode; non-default or diagnostic paths either remain developer-only or degrade with clear guidance if the CLI is unavailable.
- Optional `ssh` and `nvidia-smi` telemetry remains disabled unless remote worker URLs are configured, and missing binaries never block startup or core desktop flows.

Quality Gates:

- `bun run lint`
- `bun test src/server/utils/getCodexAppServerClient.test.ts`
- Add `src/server/routes/ModelsRoutes.test.ts` coverage for missing-`codex` status and login behavior, then run `bun test src/server/routes/ModelsRoutes.test.ts`.
- `bun test src/server/routes/ProviderConnectionsRoutes.test.ts`
- `bun test src/server/providers/providerAuthService.test.ts`
- `bun test src/server/providers/adapters/directAdapters.test.ts`
- `bun test src/server/cron/judgmentsJobs/judgmentJobSqliteService.test.ts`
- `bun test src/server/routes/JudgmentsJobsRoutes.test.ts`
- `bun test src/services/olap/duckdbRunnerAppDatabase.test.ts`
- `bun test src/server/utils/duckdbBinary.test.ts`
- Add `src/server/cron/nvidiaSmi.test.ts` coverage for missing `ssh`/`nvidia-smi` telemetry behavior, then run `bun test src/server/cron/nvidiaSmi.test.ts`.
- Packaged app verify: startup, API, import, non-Codex provider or manual provider setup, quit, and relaunch all work with no `codex`, DuckDB CLI, `sqlite3`, `ssh`, or `nvidia-smi` exposure.
- Packaged app verify: opening Providers or Settings with no `codex` installed shows in-app guidance and no browser-dev-only instruction.

### 6. macOS Smoke Run

Goal: validate the chosen source-first shape under clean-machine assumptions.

Build Commands:

- Run from the repo on a build machine with Bun available.
- `bun run build`
- `bun run desktop:build`

Artifact Run Preconditions:

- Run the artifact outside the repo checkout.
- Do not set `FORSKA_DESKTOP_BUN_BIN`.
- Use a clean-machine shell or profile for the artifact run where host `bun`, DuckDB CLI, `codex`, `sqlite3`, `ssh`, and `nvidia-smi` are absent from `PATH`, or explicitly record why each host tool cannot be hidden.

Manual Checks:

- Open the unsigned artifact.
- Confirm startup diagnostics show the artifact Bun path, not a host `bun` path.
- Confirm the backend reaches `/api/runtime/ready`.
- Import one dataset.
- Configure one non-Codex provider or manual provider record that does not require a host CLI.
- Quit and relaunch.
- Confirm writes land under the per-user desktop data root, not the repo root or install directory.
- Confirm deleting or misplacing the bundled Bun in a throwaway artifact copy produces an actionable startup error rather than falling back to host Bun.

Quality Gates:

- All commands complete successfully.
- All manual checks pass outside the repo checkout with no host `bun`, DuckDB CLI, `codex`, `sqlite3`, `ssh`, or `nvidia-smi` exposure unless the exposure is explicitly recorded.
- Smoke result, command output summary, artifact path, data root, log path, and any host-tool exposure are recorded in `APP_PLAN_IMPLEMENTED.md` if it passes, or in this file under the relevant blocker if it fails.

### 7. Native Windows Smoke Run

Goal: run the same source-first artifact assumptions on native Windows before making the continue-or-fallback call.

Build Commands:

- Run on native Windows or a native Windows CI runner with Bun available.
- `bun run build`
- `bun run desktop:build`

Artifact Run Preconditions:

- macOS source-first artifact passes the full smoke run.
- Run the built artifact on native Windows outside the repo checkout with no `FORSKA_DESKTOP_BUN_BIN` and no host `bun`, DuckDB CLI, `codex`, `sqlite3`, `ssh`, or `nvidia-smi` on `PATH`, or explicitly record any unavoidable host-tool exposure.

Manual Checks:

- Launch, quit, relaunch.
- API connectivity.
- Import one dataset.
- Configure one non-Codex provider or manual provider record that does not require a host CLI.
- Data root and log path.
- Spaces in user profile paths.
- No DuckDB CLI, `sqlite3`, `codex`, `ssh`, or `nvidia-smi` required for core flows.
- Startup diagnostics show the artifact Bun path, not a host `bun` path.

Quality Gates:

- All commands complete successfully on native Windows.
- All manual checks pass outside the repo checkout with no host `bun`, DuckDB CLI, `codex`, `sqlite3`, `ssh`, or `nvidia-smi` exposure unless the exposure is explicitly recorded.
- Smoke result, command output summary, artifact path, data root, log path, Windows version, and any host-tool exposure are recorded in `APP_PLAN_IMPLEMENTED.md` if it passes, or in this file under the relevant blocker if it fails.

## Continue Or Fallback Decision

- Continue on ElectroBun only if the source-first artifact works on macOS, passes at least one native Windows core smoke run, and does not depend on host Bun or other unbundled CLIs for normal usage.
- Escalate to Electron if either platform still exposes shell-blocking issues in artifact reliability, packaged Bun resolution, native dependency loading, or core smoke validation after this phase.
