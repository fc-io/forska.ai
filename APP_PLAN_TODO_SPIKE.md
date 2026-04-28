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
- Target packaged desktop startup on a multi-worker Bun backend stack: `SERVER_ROLE=api`, `SERVER_ROLE=maintenance-worker`, and `SERVER_ROLE=judge-worker`.
- Keep the current `SERVER_ROLE=dev-single` desktop sidecar only as a transitional local-dev path until packaged launcher work switches over.
- Use a source-first backend artifact for this spike.
- Bundle Bun in the packaged app.
- Load the built frontend directly in the desktop shell.
- Do not bundle `sqlite3`.
- Keep DuckDB CLI out of packaged startup and core flows; any non-default DB, diagnostic, or developer-only CLI path must be optional and failure-tolerant.
- Keep Codex CLI as optional bring-your-own tooling.
- Do not start signed installers, auto-update, or release-ops work in this spike.

## Current Starting Point

- `package.json` already has `desktop:dev` and `desktop:build`.
- `src/desktop/index.ts` already launches one `SERVER_ROLE=dev-single` backend sidecar, bridges `/api` requests, and waits for `/api/runtime/ready`; it does not yet launch or own the packaged multi-worker stack.
- `scripts/startServerStack.ts` already manages API, maintenance-worker, and judge-worker subprocesses for the `server-stack` runtime-profile path and the `stacked-server` dev path through `scripts/devServerWatch.ts`, but desktop packaging has not adopted that lifecycle yet.
- `scripts/runWithRuntimeProfile.ts`, `scripts/devServerWatch.ts`, and `scripts/startServerStack.ts` still use bare `bun`/`bunx` commands and repo-relative entrypoints for current dev and server-stack launch paths.
- `src/desktop/getDesktopRuntimeConfig.ts` still resolves Bun from `FORSKA_DESKTOP_BUN_BIN`, host lookup, or bare `bun` instead of an artifact-relative bundled Bun, and still defaults desktop API to `32101`.
- `electrobun.config.ts` still copies `src` and `node_modules` directly, so the packaged runtime shape is not locked yet; it does not copy `scripts`, which matters if packaged startup launches `scripts/startServerStack.ts`, and its `watchIgnore` entries also miss the dot-prefixed `.desktopArtifacts` and `.desktopBuild` folders configured for generated output.
- `src/db/migrateDuckdb.ts` resolves SQL files from `import.meta.dir/duckdbMigrations`, so a source-first artifact must preserve the migration SQL folder at the same relative path as the migration module.
- `bun run lint` currently runs `bunx eslint src`, so work in `scripts/` or root config files needs explicit targeted ESLint coverage until the repo lint script is broadened.
- `scripts/runBunTests.ts` ignores `desktopArtifacts/` and `desktopBuild/` but not the actual dot-prefixed `.desktopArtifacts/` and `.desktopBuild/` output folders, so full Bun test discovery can pick up copied tests from generated desktop artifacts after packaging.
- `src/server/utils/getCodexAppServerClient.ts` still falls back to host-installed `codex`.
- `src/server/serverMain.ts` still logs Codex guidance that points packaged users at a browser-dev URL instead of an in-app desktop flow.
- `src/server/serverMain.ts` still warms/probes Codex on API and `dev-single` startup when Codex startup is enabled, so packaged API startup can still spawn or search for `codex` before the user opens a Codex flow.
- `src/server/services/providerSecretStore.ts` still shells out to macOS `security` for API-key provider secrets and has no Windows credential-store implementation; API-key provider setup can therefore depend on an OS CLI/PATH helper or fail on Windows even when secretless/manual provider setup works.
- `src/server/cron/judgmentsJobs/judgmentJobSqliteService.ts` still shells out to `sqlite3` for maintenance fallback flows.
- `src/services/olap/duckdbRunner.ts` can still shell out to the DuckDB CLI for non-default DuckDB paths; the default app DB path is covered by the shared app database service.
- `src/server/cron/nvidiaSmi.ts` can still shell out to `ssh` and remote `nvidia-smi` for optional remote-worker telemetry.
- `src/server/utils/localMachineIdentity.ts`, consumed by DuckDB owner lease and judge-worker journal identity helpers, can still shell out to system identity helpers such as `hostname`, `/usr/sbin/scutil`, and `/usr/sbin/ioreg` while building local-machine metadata.
- Runtime writable helpers are already wired into the known Covidence, structured import, uploaded PDF, fetched PDF, runtime asset serving, and PDF conversion local-file read paths; the remaining work is mostly audit plus packaged-mode verification, but `assets/...` request/input validation still needs explicit escape hardening.
- Less-visible writable state also needs packaged-mode verification under the desktop data root: provider runtime records, local app settings, DuckDB temp files, runtime temp/spool files, DuckDB Studio snapshot files, DuckDB owner lease/history files, worker-registry files, judgment-job SQLite/WAL/lease/repair-export files, judge-worker journals, Codex app-server safe cwd when Codex is used, desktop/backend-stack lock metadata, and runtime logs.
- Direct automated coverage is still missing for some listed runtime-write paths: uploaded PDF storage, fetched PDF storage, runtime asset serving, runtime asset path traversal rejection, PDF conversion local-file reads, FHIR `assets/...` input resolution, FHIR `assets/...` escape rejection, FHIR desktop temp-spooling behavior, DuckDB Studio snapshot/temp resolution, and Codex app-server safe-cwd resolution.

## Exit Criteria

- An unsigned macOS artifact opens a desktop window, starts the packaged Bun backend stack, and reaches a healthy app state across API, maintenance-worker, and judge-worker roles.
- The artifact does not rely on repo checkout, Bun on `PATH`, DuckDB CLI, `sqlite3`, `codex`, or optional telemetry CLIs such as `ssh` and `nvidia-smi` for startup, API, import, or secretless/manual provider setup.
- First launch, quit, relaunch, one import, and one secretless/manual non-Codex provider setup work with app-owned user directories and no host CLI dependency.
- API-key provider secret storage has an explicit packaged behavior on macOS and Windows, or unsupported API-key provider setup is recorded as a blocker and is not silently counted as passing provider setup.
- Browser workflows still work with `bun run dev:server` and `bun run dev:app`.
- At least one native Windows artifact smoke run is executed on the same source-first runtime shape and its results are captured.
- The spike ends with an explicit continue-or-fallback decision versus Electron.

## Phase 1 Recommendation

- Start with the smallest artifact that can pass real smoke tests: packaged Bun plus backend source, the multi-worker backend stack, and packaged frontend assets.
- Do not spend time on compiled backend artifacts, signed installers, updater wiring, or release channels before the source-first shape passes macOS smoke tests and completes one native Windows smoke run.

## Phase 1 Workstreams

### 1. Runtime Shape Lock-In

Goal: remove host-Bun and repo-root assumptions from the packaged desktop boot path.

Files:

- `electrobun.config.ts`
- `scripts/runWithRuntimeProfile.ts`
- `scripts/devServerWatch.ts`
- `scripts/startServerStack.ts`
- `scripts/runBunTests.ts`
- `src/desktop/getDesktopRuntimeConfig.ts`
- `src/desktop/index.ts`
- `src/desktop/desktopBackendStack.ts` (new packaged stack orchestration helper)
- `src/desktop/desktopApiBridge.ts` (new or extracted desktop fetch bridge helper if needed for testable request serialization)
- `src/desktop/desktopSingleInstance.ts`
- `src/server/routes/ApiProxyRoutes.ts`
- `src/server/routes/apiRouteClassification.ts`
- `src/server/utils/backgroundServerStack.ts`
- `src/server/utils/env.ts`
- `src/server/utils/runtimeWritablePath.ts`
- `src/server/utils/serverRole.ts`
- `package.json` if helper scripts become necessary

Deliverables:

- Packaged mode resolves only the bundled Bun from the artifact; `desktop:dev` may keep explicit or host Bun lookup, but that path must stay visibly separate from packaged startup.
- Missing bundled Bun fails with actionable diagnostics instead of silently falling back to host Bun.
- Backend entrypoint resolution is artifact-relative and deterministic.
- Packaged stack orchestration is an importable helper with no top-level side effects; dev scripts remain thin wrappers around shared process/env logic, and packaged startup does not depend on package scripts or repo-root `process.cwd()`.
- Desktop shell launcher code does not import server modules that load native DB dependencies, read app settings, or perform runtime I/O at module top level merely to compute child-process commands; server-specific imports stay lazy or inside backend child processes.
- Runtime-profile command construction stays lazy and mode-scoped so app/app-server launch modes do not import `@duckdb/node-api`, read local app settings, or touch server runtime state merely to spawn Vite or the static app server.
- The source-first artifact includes all runtime files required by the chosen packaged entrypoints, including backend source, DuckDB migration SQL under `src/db/duckdbMigrations/`, copied launcher source if used, runtime child-process entrypoints, native `node_modules`, package/runtime metadata files, and any other files that Bun or native modules need.
- Source-first copy rules exclude generated desktop output, tests, fixtures, and dev-only files unless a file is intentionally required at runtime and documented in the artifact manifest.
- Any reused stack launcher accepts artifact-relative Bun and backend entrypoint inputs instead of hard-coded bare `bun`, `bun run`, `bunx`, package-script, `PATH`, and `process.cwd()` source assumptions in packaged mode.
- The source-first artifact either includes every launched backend stack entrypoint such as `scripts/startServerStack.ts`, or moves the packaged stack launcher under copied `src` paths.
- Packaged child processes may use the artifact root for source lookup, but all writable env paths, DuckDB paths, runtime temp paths, lock/metadata paths, and log paths point at the desktop data root; introduce `FORSKA_RUNTIME_TEMP_DIR` as the packaged runtime temp root and propagate it to every backend role.
- Packaged desktop launches and owns API, maintenance-worker, and judge-worker roles instead of relying on `SERVER_ROLE=dev-single`.
- The API role proxies owner-dependent requests, including JSON, multipart/form-data, and other request bodies for POST/PATCH/PUT routes, to the maintenance-worker private API without changing browser or desktop client call sites.
- The desktop fetch bridge only intercepts relative or same-origin `/api` requests and the configured desktop API origin; it does not hijack arbitrary external URLs whose path happens to start with `/api/`.
- The desktop fetch bridge preserves method, query string, headers, binary bodies, JSON, and multipart/form-data uploads when forwarding renderer `/api` requests to the API role, cleans up pending requests on renderer aborts, backend errors, timeouts, and window shutdown, and keeps desktop imports on the same client call sites as browser flows.
- The desktop launcher assigns deterministic loopback ports, `SERVER_DUCKDB_OWNER_URL`, role env, a stable `JUDGE_WORKER_ID`, cleared inherited `JUDGE_WORKER_JOURNAL_PATH`, data paths, lock/metadata paths, and log paths for the stack.
- Before falling back to alternate ports, the desktop launcher distinguishes foreign port occupancy from an existing same-data-root Forska backend stack, attaches to or shuts down orphaned same-data-root stacks when safe, reclaims stale same-data-root metadata, and refuses to start a second stack against the same desktop data root only when another live shell/backend owner remains.
- Startup readiness, role logs, child-process shutdown, relaunch, and crash recovery are surfaced per role.
- Initial packaged startup has bounded role restart/readiness attempts; repeated role crashes or readiness timeouts fail with actionable diagnostics instead of looping until the shell-level timeout.
- Startup errors include resolved Bun path, backend entrypoint, API origin, data root, runtime temp path, and log path, and render dynamic error/log content as escaped text rather than raw HTML.
- ElectroBun watch ignores and Bun test discovery ignores match the actual dot-prefixed build and artifact folders.

Quality Gates:

- `bun run lint`
- `bunx eslint electrobun.config.ts scripts/runWithRuntimeProfile.ts scripts/devServerWatch.ts scripts/startServerStack.ts scripts/runBunTests.ts scripts/runBunTests.test.ts`
- Extend `scripts/runWithRuntimeProfile.test.ts` coverage for mode-scoped command/env construction that does not import `@duckdb/node-api` or read local app settings for app/app-server launch modes, then run `bun test scripts/runWithRuntimeProfile.test.ts`.
- Add `scripts/runBunTests.test.ts` coverage for dot-prefixed desktop artifact/build-folder ignores, then run `bun test scripts/runBunTests.test.ts`.
- Add `src/desktop/desktopBackendStack.test.ts` coverage for packaged stack process orchestration, then run `bun test src/desktop/desktopBackendStack.test.ts`.
- Add `src/desktop/desktopApiBridge.test.ts` coverage for renderer-to-API request serialization of query strings, JSON, binary bodies, multipart/form-data, same-origin versus external URL filtering, abort handling, timeout cleanup, and backend-error cleanup, then run `bun test src/desktop/desktopApiBridge.test.ts`.
- `bun test src/desktop/getDesktopRuntimeConfig.test.ts`
- `bun test src/desktop/desktopSingleInstance.test.ts`
- `bun test src/app/utils/getDesktopApiOrigin.test.ts`
- `bun test src/app/utils/getApiRequestUrl.test.ts`
- `bun test src/server/routes/ApiProxyRoutes.test.ts`
- `bun test src/server/routes/ApiProxyRoutes.retry.test.ts`
- `bun test src/server/utils/backgroundServerStack.test.ts`
- `bun test src/server/utils/env.test.ts`
- `bun test src/server/utils/runtimeWritablePath.test.ts`
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
- `src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostFhirEhrPatients.ts`
- `src/server/utils/convertPdfToText.ts`
- `src/agent/fhirEhrPatientsWorkflow/fhirEhrPatientsWorkflowStoreEntries.ts`
- `src/agent/fhirEhrPatientsWorkflow/fhirEhrPatientsWorkflowTypes.ts`
- `src/utils/providerRuntimeRecords.ts`

Deliverables:

- Structured imports, uploaded PDFs, fetched PDFs, FHIR EHR input folders, and runtime asset reads resolve through app-owned paths in desktop mode.
- Use one shared safe `assets/...` local-key normalizer/resolver for runtime asset serving, Covidence, structured imports, FHIR input folders, and PDF conversion instead of duplicating prefix checks.
- The shared safe-asset helper resolves env-dependent roots at call time, or through injected env/cwd/platform/path modules in tests, so desktop-mode and Windows separator/case-insensitivity behavior cannot be hidden by stale module-scope path constants.
- Runtime asset, Covidence package, structured-file package, FHIR cursor `assets/...`, and FHIR `fhir:` importRoute-derived inputs reject absolute paths, drive-letter and UNC paths, empty normalized asset keys, URL-decoded or raw `..` segments, and backslash-based escapes before resolving any local file.
- Resolved runtime asset paths are verified, with Windows separators and case-insensitive filesystems such as Windows and default macOS handled correctly, to stay inside the runtime writable root's `assets/` tree, or inside a narrower expected package folder when a flow owns one.
- Existing-file reads canonicalize with real paths after existence checks where the platform supports it, so symlinks inside `assets/` cannot escape the runtime writable root or a flow-owned package folder.
- Asset writes create and verify parent directories through the same containment helper and reject symlinked parent-directory escapes before writing Covidence packages, structured imports, uploaded PDFs, or fetched PDFs.
- Uploaded and fetched PDF filenames derived from article IDs, DOI values, arXiv IDs, or source URLs use encoded, hashed, or otherwise filesystem-safe bounded names and are verified inside the expected PDF folder before writing.
- PDF conversion resolves DB-stored `assets/...` PDF paths through runtime file-path helpers before reading local files.
- FHIR EHR import temp spooling uses an explicit runtime temp location with cleanup on success and failure in desktop mode; OS temp remains acceptable only for non-desktop mode or for a separately recorded product/security exception.
- Provider runtime records remain under the desktop runtime root in desktop mode and do not create repo-root `cache/` entries during packaged runs.
- Env-dependent writable directories in Covidence, structured imports, provider runtime records, and similar helpers resolve at call time or via test-injected env/cwd so desktop-mode tests cannot pass because a module imported before env setup froze a repo-root path.
- DB-stored `assets/...` references keep working in browser and desktop flows.

Quality Gates:

- `bun run lint`
- Extend `src/server/utils/runtimeWritablePath.test.ts` coverage for `FORSKA_RUNTIME_TEMP_DIR`, desktop asset-path escape rejection, Windows separator and case-insensitive filesystem containment, symlink escape rejection where supported, and the shared safe-asset-path helper, then run `bun test src/server/utils/runtimeWritablePath.test.ts`.
- `bun test src/app/utils/getRuntimeAssetUrl.test.ts`
- Extend `src/server/services/covidenceImportService.test.ts` coverage for desktop package paths and package-path escape rejection, then run `bun test src/server/services/covidenceImportService.test.ts`.
- Extend `src/server/services/structuredFileImportService.test.ts` coverage for desktop package paths and package-path escape rejection, then run `bun test src/server/services/structuredFileImportService.test.ts`.
- Add `src/server/routes/ArticleAdminRoutes.test.ts` coverage for uploaded PDF desktop paths, article IDs containing slash/backslash/traversal-like text, symlinked parent-directory escape rejection, and filename escape rejection, then run `bun test src/server/routes/ArticleAdminRoutes.test.ts`.
- Add `src/server/cron/fullTextJobs/fullTextArticleFetchFromArxiv.test.ts`, `src/server/cron/fullTextJobs/fullTextArticleFetchFromUnpaywall.test.ts`, and `src/server/cron/fullTextJobs/fullTextArticleFetchFromOriginalUrls.test.ts` coverage for desktop paths, DOI/arXiv/source-URL keys containing slash/backslash/traversal-like or long text, and symlinked parent-directory escape rejection, then run `bun test src/server/cron/fullTextJobs/fullTextArticleFetchFromArxiv.test.ts`, `bun test src/server/cron/fullTextJobs/fullTextArticleFetchFromUnpaywall.test.ts`, and `bun test src/server/cron/fullTextJobs/fullTextArticleFetchFromOriginalUrls.test.ts`.
- Add `src/server/routes/RuntimeAssetsRoutes.test.ts` coverage for desktop-mode `assets/...` serving and rejection of `assets/../...`, absolute, drive-letter, encoded traversal, backslash escape, and symlink escape inputs where supported, then run `bun test src/server/routes/RuntimeAssetsRoutes.test.ts`.
- Add `src/server/utils/convertPdfToText.test.ts` coverage for desktop-mode PDF file reads, then run `bun test src/server/utils/convertPdfToText.test.ts`.
- Add `src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostFhirEhrPatients.test.ts` coverage for desktop-mode `assets/...` FHIR input resolution and escape rejection, including encoded traversal, then run `bun test src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostFhirEhrPatients.test.ts`.
- Add `src/agent/fhirEhrPatientsWorkflow/fhirEhrPatientsWorkflowStoreEntries.test.ts` with desktop-mode FHIR temp-spooling coverage that asserts spool files are created under the runtime temp/data root and are cleaned up on success and failure, then run `bun test src/agent/fhirEhrPatientsWorkflow/fhirEhrPatientsWorkflowStoreEntries.test.ts`.
- Add `src/utils/providerRuntimeRecords.test.ts` coverage for desktop-mode `cache/providerRuntimeRecords` resolution, then run `bun test src/utils/providerRuntimeRecords.test.ts`.
- Browser verify: existing built web flow still serves and loads runtime assets correctly.
- Manual verify: uploaded PDFs, fetched PDFs, runtime asset reads, rejected runtime asset escapes, FHIR EHR input resolution, rejected FHIR escapes, provider runtime records, and FHIR EHR temp spooling do not touch the repo root or install directory in desktop mode.

### 3. Native Dependency And Startup Verification

Goal: prove the packaged backend can actually start, migrate, and reopen local state.

Files:

- `src/server/index.ts`
- `src/server/serverMain.ts`
- `scripts/runWithRuntimeProfile.ts`
- `scripts/startServerStack.ts`
- `src/server/utils/backgroundServerStack.ts`
- `src/server/utils/serverRole.ts`
- `src/server/utils/duckdbService.ts`
- `src/server/services/readOnlyDuckdbService.ts`
- `src/server/utils/ownerlessReadableBackends.ts`
- `src/server/routes/DuckdbStudioRoutes.ts`
- `src/server/utils/duckdbScriptAccess.ts`
- `src/server/cron/judgmentsJobs/judgeWorkerCompletionJournal.ts`
- `src/server/cron/judgmentsJobs/judgmentJobSqliteService.ts`
- `src/server/cron/judgmentsJobs/judgmentJobSqliteIsolatedImport.ts`
- `src/server/cron/judgmentsJobs/runJudgmentJobSqliteSingleJobClaimExport.ts`
- `src/server/cron/judgmentsJobs/judgmentJobPaths.ts`
- `src/server/utils/duckdbOwnerConnections.ts`
- `src/server/utils/localAppSettings.ts`
- `src/server/utils/runtimeLogger.ts`
- `src/db/migrateDuckdb.ts`
- `src/db/duckdbMigrations/`

Deliverables:

- `@duckdb/node-api` loads in the packaged backend.
- `bun:sqlite` works for job state and restart.
- Migrations run on first launch and relaunch, with `src/db/duckdbMigrations/` preserved next to `src/db/migrateDuckdb.ts` in the packaged artifact.
- `FORSKA_RUNTIME_TEMP_DIR` is translated into role env such as `DUCKDB_TEMP_DIRECTORY` and into read-only DuckDB instance options, so owner and read-only DuckDB temp files stay under the desktop data/runtime temp root.
- DuckDB temp directories for both owner and read-only DuckDB services, DuckDB Studio snapshot/diagnostic files, owner lease/history files, worker-registry files, local app settings, judgment-job SQLite/WAL/lease/repair-export files, judge-worker journals, desktop/backend-stack lock metadata, and runtime logs resolve under the desktop data root in packaged mode.
- Judgment-job isolated import and repair child processes use the bundled Bun `process.execPath` and artifact-relative entrypoint paths, including `runJudgmentJobSqliteSingleJobClaimExport.ts`, instead of host Bun or repo-checkout paths.
- Ownerless-readable backend validation still succeeds in packaged API startup after maintenance-worker migration, with a clear fallback to ownerless control state if live read-only DuckDB is unavailable.
- Restart and crash recovery leave local data usable.
- API, maintenance-worker, and judge-worker roles each start with the expected capabilities and recover without requiring `dev-single`.

Quality Gates:

- `bun run lint`
- `bunx eslint scripts/runWithRuntimeProfile.ts scripts/startServerStack.ts`
- `bun test src/server/utils/getDuckdbPath.test.ts`
- `bun test src/server/utils/backgroundServerStack.test.ts`
- `bun test src/server/utils/serverRole.test.ts`
- `bun test scripts/runWithRuntimeProfile.test.ts`
- `bun test src/db/migrateDuckdb.test.ts`
- `bun test src/server/utils/duckdbServiceNodeApiSpike.test.ts src/server/utils/duckdbServiceLease.test.ts src/server/utils/duckdbServiceShutdown.test.ts src/server/utils/duckdbServiceReload.test.ts src/server/utils/duckdbServiceMemoryLimit.test.ts`
- Add `src/server/utils/duckdbServiceSnapshot.test.ts` coverage for packaged-mode DuckDB snapshot/temp-directory resolution and cleanup, then run `bun test src/server/utils/duckdbServiceSnapshot.test.ts`.
- `bun test src/server/routes/DuckdbStudioRoutes.test.ts`
- `bun test src/server/utils/duckdbScriptAccess.test.ts`
- Add `src/server/services/readOnlyDuckdbService.test.ts` coverage for packaged-mode read-only DuckDB startup, then run `bun test src/server/services/readOnlyDuckdbService.test.ts`.
- Add `src/server/cron/judgmentsJobs/judgmentJobPaths.test.ts` coverage for desktop-mode judgment-job root resolution, then run `bun test src/server/cron/judgmentsJobs/judgmentJobPaths.test.ts`.
- `bun test src/server/cron/judgmentsJobs/judgeWorkerCompletionJournal.test.ts`
- `bun test src/server/cron/judgmentsJobs/judgmentJobSqliteService.test.ts`
- Add `src/server/cron/judgmentsJobs/judgmentJobSqliteIsolatedImport.test.ts` coverage for packaged/source-first child entrypoint resolution and bundled `process.execPath` usage, then run `bun test src/server/cron/judgmentsJobs/judgmentJobSqliteIsolatedImport.test.ts`.
- Extend `src/server/utils/duckdbOwnerConnections.test.ts` coverage for desktop-mode worker-registry storage, then run `bun test src/server/utils/duckdbOwnerConnections.test.ts`.
- `bun test src/server/utils/localAppSettings.test.ts`
- `bun test src/server/utils/runtimeLogger.test.ts`
- Extend `src/server/indexStartup.test.ts` coverage for packaged API startup after maintenance-worker migration and ownerless-readable backend fallback, then run `bun test src/server/indexStartup.test.ts`.
- macOS verify: first launch, quit, relaunch.

### 4. Port And Loopback Hardening

Goal: packaged desktop should not fail opaquely when any default backend stack port is already taken.

Files:

- `src/desktop/getDesktopRuntimeConfig.ts`
- `src/desktop/index.ts`
- `src/server/utils/backgroundServerStack.ts`
- `src/server/serverMain.ts`
- `src/server/utils/env.ts`
- `src/utils/runtimePortDefaults.ts` if shared defaults need to change

Deliverables:

- Occupied desktop API, maintenance-worker, or judge-worker ports either fall back to free loopback ports or show an actionable startup error.
- If free-port fallback is used, the selected API, maintenance-worker, and judge-worker ports are propagated to the preload bridge, backend role env, readiness checks, startup diagnostics, and logs with no stale hard-coded `32101` assumptions.
- Packaged mode binds backend listeners to loopback only and does not expose API, maintenance-worker, or judge-worker ports on LAN interfaces.
- API listener host selection is explicit and typed/configured for packaged mode; browser/dev defaults remain unchanged unless intentionally changed and documented.

Quality Gates:

- `bun run lint`
- `bun test src/desktop/getDesktopRuntimeConfig.test.ts`
- `bun test src/desktop/desktopSingleInstance.test.ts`
- `bun test src/server/utils/backgroundServerStack.test.ts`
- `bun test src/server/utils/env.test.ts`
- Extend `src/server/indexStartup.test.ts` coverage for packaged-mode loopback listener host selection and unchanged browser/dev defaults, then run `bun test src/server/indexStartup.test.ts`.
- `bun run desktop:build`
- macOS verify: launch with the default API, maintenance-worker, and judge-worker ports already occupied.
- Packaged app verify: API, maintenance-worker, and judge-worker listeners are reachable on loopback and not on non-loopback interfaces.

### 5. Optional CLI And Host Helper Behavior

Goal: missing optional CLIs or host credential/telemetry helpers must never block startup or normal use.

Files:

- `src/server/utils/getCodexAppServerClient.ts`
- `src/server/utils/codexCliAuth.ts`
- `src/server/utils/localAppSettings.ts`
- `src/server/serverMain.ts`
- `src/server/routes/ModelsRoutes.ts`
- `src/server/routes/ProviderConnectionsRoutes.ts`
- `src/server/routes/JudgmentsJobsRoutes.ts`
- `src/server/providers/providerAuthService.ts`
- `src/server/services/providerSecretStore.ts`
- `src/server/providers/providerSecretStore.ts`
- `src/server/providers/adapters/codexAdapter.ts`
- `src/server/providers/transports/codexAppTransport.ts`
- `src/server/cron/judgmentsJobs/judgmentJobSqliteService.ts`
- `src/server/cron/nvidiaSmi.ts`
- `src/server/utils/duckdbOwnerLease.ts`
- `src/server/utils/judgeWorkerJournalIdentity.ts`
- `src/server/utils/localMachineIdentity.ts`
- `src/services/olap/duckdbRunner.ts`
- `src/server/utils/duckdbBinary.ts`
- `src/app/routes/+admin/+models/providerConnectionsClient.ts`
- `src/app/routes/+admin/+models/providerUiState.ts`
- `src/app/routes/+providers/+add-provider.tsx`
- `src/app/routes/+providers/+$id/+index.tsx`
- `src/app/routes/+settings/+index.tsx`

Deliverables:

- Missing `codex` does not block startup.
- Codex binary resolution is platform-aware, including Windows executable suffixes/PATHEXT behavior, honors the Settings `codexBin` override, and does not advertise unsupported env vars.
- Codex-only flows surface install and configuration guidance before use.
- Codex login/start buttons are disabled or replaced with Settings/install guidance when runtime status reports that the CLI binary is unavailable.
- When Codex is used in desktop mode, its safe app-server cwd/scratch directory resolves under the desktop runtime temp/data root and not under the repo root or install directory; cleanup/retention is explicit.
- Codex guidance matches the actual configuration surface; it does not point to unsupported env vars such as `CODEX_BIN` unless that env var is implemented.
- `/api/models/codex/status` and `/api/models/codex/login` handle missing `codex` without unhandled spawn errors, and the login route does not start a device-login subprocess when status already reports that the CLI binary is unavailable.
- `/api/provider-auth/codex/begin` and `/api/provider-auth/codex/finish` handle missing `codex` consistently with the direct Codex status/login routes.
- Packaged desktop guidance points users to in-app Providers or Settings flows rather than `http://localhost:${env.VITE_PORT}/providers`.
- Packaged API startup does not call `warmCodexAppServer`, `getCodexCliLoginStatus`, or device-login startup until the user opens a Codex-specific flow; user-initiated Codex status checks remain bounded and degraded when the CLI is absent.
- Packaged startup and secretless/manual provider setup do not touch provider secret-storage CLIs or OS credential helpers.
- API-key provider setup has a supported packaged secret-storage behavior on macOS and Windows, or surfaces an explicit unsupported-state before attempting to store a secret; macOS `/usr/bin/security` helper use, if retained, is resolved explicitly as an OS credential helper, isolated behind timeout/degraded-error handling, and not used on Windows.
- `sqlite3` remains maintenance-only, is not invoked during packaged startup, restart, recovery, or core smoke flows, and explicit repair/diagnostic routes report degraded maintenance results if unavailable instead of unhandled spawn failures.
- DuckDB CLI use stays out of the default app database query path in packaged mode; non-default or diagnostic paths either remain developer-only or degrade with clear guidance if the CLI is unavailable.
- Optional `ssh` and `nvidia-smi` telemetry remains disabled unless remote worker URLs are configured, and missing binaries never block startup or core desktop flows.
- DuckDB owner lease and judge-worker journal identity helpers remain best-effort; local-machine identity lookup does not run blocking helper subprocesses at module import, and missing or slow `hostname`, `/usr/sbin/scutil`, or `/usr/sbin/ioreg` must not block packaged startup, ownership recovery, or journal lock recovery.

Quality Gates:

- `bun run lint`
- `bun run build`
- Extend `src/server/utils/getCodexAppServerClient.test.ts` coverage for Codex app-server spawn/exit diagnostics, platform-aware binary resolution, and desktop safe-cwd resolution, then run `bun test src/server/utils/getCodexAppServerClient.test.ts`.
- Add `src/server/utils/codexCliAuth.test.ts` coverage for missing `codex` status and device-login behavior, then run `bun test src/server/utils/codexCliAuth.test.ts`.
- Add `src/server/routes/ModelsRoutes.test.ts` coverage for missing-`codex` status and login behavior, then run `bun test src/server/routes/ModelsRoutes.test.ts`.
- Extend `src/server/indexStartup.test.ts` coverage for packaged startup with missing Codex that does not spawn Codex status/app-server probes, then run `bun test src/server/indexStartup.test.ts`.
- Extend `src/server/routes/ProviderConnectionsRoutes.test.ts` coverage for missing-`codex` provider-auth begin and finish behavior plus API-key secret-storage unavailable/degraded behavior, then run `bun test src/server/routes/ProviderConnectionsRoutes.test.ts`.
- `bun test src/server/providers/providerAuthService.test.ts`
- Add `src/server/services/providerSecretStore.test.ts` coverage for missing, slow, and Windows-unsupported credential helper behavior, then run `bun test src/server/services/providerSecretStore.test.ts`.
- Extend `src/server/providers/adapters/directAdapters.test.ts` coverage for Codex adapter unsupported-state behavior when runtime status reports missing `codex`, then run `bun test src/server/providers/adapters/directAdapters.test.ts`.
- Extend `src/server/providers/transports/codexAppTransport.test.ts` coverage for missing-`codex` runtime status guidance, then run `bun test src/server/providers/transports/codexAppTransport.test.ts`.
- `bun test src/app/routes/+admin/+models/providerUiState.test.ts`
- `bun test src/server/cron/judgmentsJobs/judgmentJobSqliteService.test.ts`
- `bun test src/server/routes/JudgmentsJobsRoutes.test.ts`
- `bun test src/services/olap/duckdbRunnerAppDatabase.test.ts`
- Extend `src/services/olap/duckdbRunner.test.ts` coverage for missing DuckDB CLI behavior on non-default DB paths, then run `bun test src/services/olap/duckdbRunner.test.ts`.
- Extend `src/server/utils/duckdbBinary.test.ts` coverage for missing DuckDB CLI resolution, then run `bun test src/server/utils/duckdbBinary.test.ts`.
- `bun test src/server/utils/duckdbOwnerLease.test.ts`
- `bun test src/server/utils/judgeWorkerJournalIdentity.test.ts`
- Add `src/server/utils/localMachineIdentity.test.ts` coverage for missing and slow identity-helper binaries, then run `bun test src/server/utils/localMachineIdentity.test.ts`.
- Add `src/server/cron/nvidiaSmi.test.ts` coverage for missing `ssh`/`nvidia-smi` telemetry behavior, then run `bun test src/server/cron/nvidiaSmi.test.ts`.
- Browser verify: Providers, Add Provider, Codex provider detail, and Settings show missing-Codex guidance without browser-dev-only instructions and without enabled login/start actions when the CLI is unavailable.
- Packaged app verify: startup, API, import, secretless/manual non-Codex provider setup, quit, and relaunch all work with no `codex`, DuckDB CLI, `sqlite3`, `ssh`, or `nvidia-smi` exposure.
- Packaged app verify: API-key provider setup either succeeds through the supported packaged secret-store backend or shows explicit unsupported secret-storage guidance before attempting to spawn an unavailable helper.
- Packaged app verify: opening Providers, Add Provider, Codex provider detail, and Settings with no `codex` installed shows in-app guidance, no browser-dev-only instruction, and no enabled login/start action that would spawn a missing binary.

### 6. macOS Smoke Run

Goal: validate the chosen source-first shape under clean-machine assumptions.

Build Commands:

- Run from the repo on a build machine with Bun available.
- `bun run desktop:build` (currently invokes `bun run build` before `electrobun build`)

Artifact Run Preconditions:

- Run the artifact outside the repo checkout.
- For at least one run, place the artifact under a parent path containing spaces.
- Do not set `FORSKA_DESKTOP_BUN_BIN`.
- Use a clean-machine shell or profile for the artifact run where host `bun`, DuckDB CLI, `codex`, `sqlite3`, `ssh`, and `nvidia-smi` are absent from `PATH`, or explicitly record why each host tool cannot be hidden.

Manual Checks:

- Open the unsigned artifact.
- Confirm startup diagnostics show the artifact Bun path, not a host `bun` path.
- Confirm artifact-relative backend paths work when the artifact parent path contains spaces.
- Confirm the backend stack reaches `/api/runtime/ready` and logs API, maintenance-worker, and judge-worker role readiness.
- Import one local file-backed dataset through the packaged UI/API path, using a flow that exercises multipart upload and runtime asset storage.
- Configure one secretless/manual non-Codex provider record that does not require a host CLI.
- If an API-key provider is tested, record the packaged secret-store backend used and any macOS `/usr/bin/security` helper exposure.
- Quit and relaunch.
- Confirm writes, runtime temp files, and any diagnostic snapshot files generated during the run land under the per-user desktop data root, not the repo root or install directory.
- Confirm deleting or misplacing the bundled Bun in a throwaway artifact copy produces an actionable startup error rather than falling back to host Bun.

Quality Gates:

- All commands complete successfully.
- All manual checks pass outside the repo checkout with no host `bun`, DuckDB CLI, `codex`, `sqlite3`, `ssh`, or `nvidia-smi` exposure unless the exposure is explicitly recorded; any provider secret-store helper exposure is recorded separately.
- Smoke result, command output summary, artifact path, artifact parent path space-check result, data root, runtime temp path, log path, provider secret-store backend if tested, and any host-tool exposure are recorded in `APP_PLAN_IMPLEMENTED.md` if it passes, or in this file under the relevant blocker if it fails.

### 7. Native Windows Smoke Run

Goal: run the same source-first artifact assumptions on native Windows before making the continue-or-fallback call.

Build Commands:

- Run on native Windows or a native Windows CI runner with Bun available.
- `bun run desktop:build` (currently invokes `bun run build` before `electrobun build`)

Artifact Run Preconditions:

- macOS source-first artifact passes the full smoke run.
- Run the built artifact on native Windows outside the repo checkout, including at least one run from an artifact parent path containing spaces, with no `FORSKA_DESKTOP_BUN_BIN` and no host `bun`, DuckDB CLI, `codex`, `sqlite3`, `ssh`, or `nvidia-smi` on `PATH`, or explicitly record any unavoidable host-tool exposure.

Manual Checks:

- Launch, quit, relaunch.
- API connectivity.
- API, maintenance-worker, and judge-worker role readiness.
- Import one local file-backed dataset through the packaged UI/API path, using a flow that exercises multipart upload and runtime asset storage.
- Configure one secretless/manual non-Codex provider record that does not require a host CLI.
- If an API-key provider is tested, verify it does not depend on macOS-only keychain behavior and record the packaged Windows secret-store backend used.
- Data root, runtime temp path, any generated diagnostic snapshot path, and log path.
- Spaces in user profile paths and artifact/install paths.
- No DuckDB CLI, `sqlite3`, `codex`, `ssh`, or `nvidia-smi` required for core flows.
- Startup diagnostics show the artifact Bun path, not a host `bun` path.

Quality Gates:

- All commands complete successfully on native Windows.
- All manual checks pass outside the repo checkout with no host `bun`, DuckDB CLI, `codex`, `sqlite3`, `ssh`, or `nvidia-smi` exposure unless the exposure is explicitly recorded; any provider secret-store helper exposure is recorded separately.
- Smoke result, command output summary, artifact path, artifact parent path space-check result, data root, runtime temp path, log path, provider secret-store backend if tested, Windows version, and any host-tool exposure are recorded in `APP_PLAN_IMPLEMENTED.md` if it passes, or in this file under the relevant blocker if it fails.

## Continue Or Fallback Decision

- Continue on ElectroBun only if the source-first artifact works on macOS, passes at least one native Windows core smoke run, and does not depend on host Bun or other unbundled CLIs for startup, API, import, judging, or secretless/manual provider setup.
- Treat any unresolved API-key provider secret-storage gap as an explicit continue/fallback decision input rather than a hidden pass.
- Escalate to Electron if either platform still exposes shell-blocking issues in artifact reliability, packaged Bun resolution, native dependency loading, or core smoke validation after this phase.
