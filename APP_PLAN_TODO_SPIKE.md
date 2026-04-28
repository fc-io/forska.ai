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
- `src/desktop/getDesktopRuntimeConfig.ts` still resolves Bun from `FORSKA_DESKTOP_BUN_BIN`, host lookup, or bare `bun` instead of an artifact-relative bundled Bun, still defaults desktop API to `32101`, and still treats `FORSKA_DESKTOP_API_SERVER_PORT` as a host env override without a packaged/dev-mode boundary.
- `src/desktop/getDesktopRuntimeConfig.ts` currently spreads the parent process environment into `backendEnv`, so packaged launch can inherit development/runtime overrides such as `DUCKDB_PATH`, `LOG_DIR`, `SERVER_ROLE`, background ports, or `JUDGE_WORKER_JOURNAL_PATH` unless the packaged child env is built from an explicit sanitized base.
- `src/desktop/getDesktopRuntimeConfig.ts` also computes the desktop `viewsRoot` from the desktop source module location, so phase 1 must verify and lock dev and packaged frontend asset resolution against the `electrobun.config.ts` copy target instead of accidentally depending on an un-copied `src/views` path, repo `dist`, or `process.cwd()`.
- `electrobun.config.ts` still copies `src` and `node_modules` directly, so the packaged runtime shape is not locked yet; it does not copy `scripts`, which matters if packaged startup launches `scripts/startServerStack.ts`, and its `watchIgnore` entries also miss the dot-prefixed `.desktopArtifacts` and `.desktopBuild` folders configured for generated output.
- `src/db/migrateDuckdb.ts` resolves SQL files from `import.meta.dir/duckdbMigrations`, so a source-first artifact must preserve the migration SQL folder at the same relative path as the migration module.
- `bun run lint` currently runs `bunx eslint src`, so work in `scripts/` or root config files needs explicit targeted ESLint coverage until the repo lint script is broadened.
- `scripts/runBunTests.ts` ignores `desktopArtifacts/` and `desktopBuild/` but not the actual dot-prefixed `.desktopArtifacts/` and `.desktopBuild/` output folders, so full Bun test discovery can pick up copied tests from generated desktop artifacts after packaging.
- `src/server/utils/getCodexAppServerClient.ts` still falls back to host-installed `codex`.
- `src/server/serverMain.ts` still logs Codex guidance that points packaged users at a browser-dev URL instead of an in-app desktop flow.
- `src/server/serverMain.ts` still warms/probes Codex on API and `dev-single` startup when Codex startup is enabled, so packaged API startup can still spawn or search for `codex` before the user opens a Codex flow.
- `src/app/routes/+projects/+create.tsx`, `src/app/routes/+projects/+$id/+edit.tsx`, and `src/app/routes/+admin/+datasources/+covidence-import.tsx` still expose a "Create default model" action backed by `/api/judgments/model`, and `src/server/routes/JudgmentsRoutes.ts` still seeds a local SGLang `Qwen3-32B-FP8` model at `http://localhost:30000/v1`; packaged desktop needs explicit in-app provider setup/guidance instead of silently creating unreachable local-runtime defaults.
- `src/server/services/providerSecretStore.ts` still shells out to macOS `security` for API-key provider secrets and has no Windows credential-store implementation; API-key provider setup can therefore depend on an OS CLI/PATH helper or fail on Windows even when secretless/manual provider setup works.
- `src/server/cron/judgmentsJobs/judgmentJobSqliteService.ts` still shells out to `sqlite3` for maintenance fallback flows.
- `src/services/olap/duckdbRunner.ts` can still shell out to the DuckDB CLI for non-default DuckDB paths; the default app DB path is covered by the shared app database service.
- `src/server/cron/nvidiaSmi.ts` can still shell out to `ssh` and remote `nvidia-smi` for optional remote-worker telemetry.
- `src/server/utils/getInferenceRuntimeConfig.ts` still reads provider-runtime, telemetry, judging-capacity, GPU, SGLang, TP/PP/DP topology, and Codex tuning from `process.env` at module evaluation, so packaged child envs must not inherit host shell `FORSKA_RUNTIME_*`, `NVIDIA_SMI_*`, `GPU_*`, `SGLANG_*`, `TP_SIZE`, `PP_SIZE`, `DP_SIZE`, `CODEX_MAX_INFLIGHT`, judgment tuning, `BUN_CONFIG_MAX_HTTP_REQUESTS`, or full-text cron toggle values except for launcher-owned `FORSKA_RUNTIME_PROFILE`, `FORSKA_RUNTIME_SERVICE`, `FORSKA_RUNTIME_TEMP_DIR`, and values explicitly owned by packaged Settings/provider-runtime records.
- `src/server/utils/env.ts`, `src/server/utils/duckdbService.ts`, `src/server/workers/projectMartRefreshWorker.ts`, `src/server/utils/projectMartLargeRebuildTuning.ts`, and `src/server/utils/duckdbOwnerConnections.ts` still read DuckDB append-lane, full-text conversion, project-mart refresh/rebuild, worker-registry throughput, log-level, and test-log-mode values from `process.env`, so packaged env sanitization must treat them as reliability-affecting runtime settings rather than inherited developer overrides.
- `src/server/utils/localMachineIdentity.ts`, consumed by DuckDB owner lease and judge-worker journal identity helpers, can still shell out to system identity helpers such as `hostname`, `/usr/sbin/scutil`, and `/usr/sbin/ioreg` while building local-machine metadata.
- Runtime writable helpers are already wired into the known Covidence, structured import, uploaded PDF, fetched PDF, runtime asset serving, and PDF conversion local-file read paths; the remaining work is mostly audit plus packaged-mode verification, but `assets/...` request/input validation still needs explicit escape hardening.
- Less-visible writable state also needs packaged-mode verification under the desktop data root: provider runtime records, local app settings, DuckDB temp files, runtime temp/spool files, DuckDB Studio snapshot files, DuckDB owner lease/history files, worker-registry files, judgment-job SQLite/WAL/lease/repair-export files, judge-worker journals, Codex app-server safe cwd when Codex is used, desktop/backend-stack lock metadata, and runtime logs.
- `src/server/cron/judgmentsJobs/judgeWorkerCompletionJournal.ts` still opens `getEnv().JUDGE_WORKER_JOURNAL_PATH` directly, while the packaged stack should clear inherited explicit journal paths and rely on `JUDGE_WORKER_ID`-derived app-data paths; completion journal open/replay must use the initialized resolved journal identity and never fall back to an empty or CWD-relative path.
- Direct automated coverage is still missing for some listed runtime-write paths: uploaded PDF storage, fetched PDF storage, runtime asset serving, runtime asset path traversal rejection, PDF conversion local-file reads, FHIR `assets/...` input resolution, FHIR `assets/...` escape rejection, FHIR desktop temp-spooling behavior, DuckDB Studio snapshot/temp resolution, and Codex app-server safe-cwd resolution.
- Direct automated coverage is also missing for desktop bridge/export response behavior: large CSV/download responses, `Content-Disposition` preservation, and bounded/streamed response handling without unbounded base64 IPC allocation.

## Exit Criteria

- An unsigned macOS artifact opens a desktop window, starts the packaged Bun backend stack, and reaches a healthy app state across API, maintenance-worker, and judge-worker roles.
- The artifact does not rely on repo checkout, host Bun/Node/npm/bunx on `PATH`, DuckDB CLI, `sqlite3`, `codex`, or optional telemetry CLIs such as `ssh` and `nvidia-smi` for startup, API, import, CSV export/download, or secretless/manual provider setup.
- First launch, quit, relaunch, one import, one CSV export/download, and one secretless/manual non-Codex provider setup work with app-owned user directories and no host CLI dependency.
- If a reachable secretless/manual non-Codex provider endpoint is available for the smoke environment, one tiny judgment runs through the packaged judge-worker; if no such endpoint is available, judging invocation is recorded as unverified and is not silently counted as passing the judging portion of the continue/fallback decision.
- API-key provider secret storage has an explicit packaged behavior on macOS and Windows, or unsupported API-key provider setup is recorded as a blocker and is not silently counted as passing provider setup.
- Browser workflows still work with `bun run dev:server` and `bun run dev:app`.
- At least one native Windows artifact smoke run is executed on the same source-first runtime shape and its results are captured.
- The spike ends with an explicit continue-or-fallback decision versus Electron.

## Implementation Readiness

- Status: ready to start implementation with the order below; not ready to release until the macOS and Windows smoke runs pass and the continue-or-fallback decision is recorded.
- The implementation unit is a small slice, not a whole workstream. Each slice must leave `bun run dev:server`, `bun run dev:app`, and the desktop build path either passing or with an explicitly recorded blocker.
- Do not start signed installers, updater wiring, release channels, Linux packaging, or compiled-backend artifact work during this spike.
- Do not treat a manual smoke step as passing if the required provider endpoint, host-tool isolation, API-key secret-store backend, or platform machine is unavailable; record it as unverified or blocked.
- Every completed slice moves landed details into `APP_PLAN_IMPLEMENTED.md`, removes or rewrites stale TODO bullets in this file, and lists commands run or explicitly skipped.

## Phase 1 Implementation Order

1. Packaged runner proof and artifact manifest: prove whether ElectroBun's packaged `process.execPath` can launch backend TypeScript children or copy a separate platform-specific Bun binary, then lock the artifact-relative runner path, backend entrypoints, frontend views root, migration SQL location, native module roots, and copy/exclude manifest.
2. Runtime config and env sanitization: split dev and packaged desktop config, build packaged child envs from an explicit safe base, assign data/temp/log/lock paths, clear host runtime/provider/telemetry/topology/project-mart/full-text/DuckDB/log/test env leakage, and keep desktop launcher imports free of server/native-DB top-level side effects.
3. Backend stack orchestration: add the packaged API, maintenance-worker, and judge-worker lifecycle helper with deterministic ports, readiness, logs, shutdown, restart limits, stale-stack handling, per-role diagnostics, and `dev-single` retained only for the transitional dev path.
4. API proxy and desktop bridge: implement owner-route proxying plus desktop request forwarding for JSON, multipart, binary bodies, aborts, timeouts, filtered headers, large upload/download behavior, and `Content-Disposition` preservation without changing browser client call sites.
5. Runtime-write audit and safe asset paths: move remaining packaged writes under desktop data/temp roots, introduce one safe `assets/...` resolver, harden escape rejection and symlink containment, and preserve existing DB-stored asset keys.
6. Native dependency, restart, and worker state verification: verify packaged `@duckdb/node-api`, `bun:sqlite`, migrations, DuckDB/read-only temp paths, judgment-job SQLite/WAL/leases, worker journals, owner leases, logs, and crash recovery in the multi-worker stack.
7. Optional CLI, provider, and secret-store behavior: make missing `codex`, DuckDB CLI, `sqlite3`, `ssh`, `nvidia-smi`, and OS credential helpers degraded or explicitly unsupported in packaged mode, and prevent default-model/provider flows from silently seeding unreachable local runtimes.
8. macOS smoke run: build and run the unsigned artifact outside the repo checkout, including a path-with-spaces run and host-tool isolation, then record the result.
9. Native Windows smoke run: repeat the same source-first runtime shape on native Windows, including path-with-spaces and host-tool isolation, then record the result.
10. Continue-or-fallback decision: continue with ElectroBun only if both smoke runs pass the exit criteria, otherwise record the fallback reason and switch the next plan to Electron.

## Dependency Rules

- The packaged backend runner decision in step 1 blocks backend stack orchestration and isolated repair/import child-process work.
- The sanitized packaged env from step 2 blocks trustworthy native dependency verification, provider-runtime verification, and smoke runs.
- The bridge/proxy large-transfer decision in step 4 must be closed before import and CSV export/download smoke checks can pass.
- The safe asset-path helper from step 5 must land before adding more desktop-mode tests around Covidence, structured imports, uploaded PDFs, fetched PDFs, FHIR input folders, or runtime asset serving.
- The provider secret-store decision in step 7 must be closed before counting API-key provider setup as passing on macOS or Windows.
- macOS smoke starts only after steps 1 through 7 have passed their relevant quality gates; Windows smoke starts only after the same source-first shape passes macOS smoke.

## First Implementation Slice

Files:

- `electrobun.config.ts`
- `src/desktop/getDesktopRuntimeConfig.ts`
- `src/desktop/getDesktopRuntimeConfig.test.ts`
- `scripts/runBunTests.ts`
- `scripts/runBunTests.test.ts` (new)
- `package.json` only if a helper script is required

Deliverables:

- Decide and document the packaged backend runner path: verified ElectroBun `process.execPath` child launch or a copied platform-specific Bun binary.
- Produce actionable startup diagnostics for a missing/unusable packaged runner with no host-Bun fallback in packaged mode.
- Lock artifact-relative `views/mainview`, backend entrypoint, migration SQL, source roots, native module roots, and required metadata expectations in an artifact manifest or equivalent testable helper.
- Fix ElectroBun watch ignores and Bun test discovery ignores for `.desktopArtifacts/` and `.desktopBuild/`.
- Keep `desktop:dev` visibly separate from packaged runner resolution and allow it to keep explicit host-Bun lookup only in dev mode.

Quality Gates:

- `bun run lint`
- `bunx eslint electrobun.config.ts scripts/runBunTests.ts scripts/runBunTests.test.ts src/desktop/getDesktopRuntimeConfig.ts src/desktop/getDesktopRuntimeConfig.test.ts`
- `bun test src/desktop/getDesktopRuntimeConfig.test.ts`
- `bun test scripts/runBunTests.test.ts`
- `bun run build`
- `bun run desktop:build`
- Inspect the built artifact, or run the artifact-manifest test, to confirm required backend/frontend/migration/native-module files are present while tests, fixtures, generated desktop output folders, and dev-only files are absent unless intentionally documented.
- Browser verify: `bun run dev:server` and `bun run dev:app` still boot after the runner/artifact changes.

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
- `src/desktop/desktopApiBridge.ts` (new/extracted desktop fetch bridge helper for testable request serialization)
- `src/desktop/desktopStartupPage.ts` (new/extracted startup splash/error page helper for testable escaping and diagnostics)
- `src/desktop/desktopSingleInstance.ts`
- `src/app/utils/client-env.ts`
- `src/app/utils/getDesktopApiOrigin.ts`
- `src/app/utils/getApiRequestUrl.ts`
- `src/app/utils/postFormDataToApi.ts`
- `src/app/utils/downloadCsv.ts`
- `src/server/routes/ApiProxyRoutes.ts`
- `src/server/routes/apiRouteClassification.ts`
- `src/server/utils/backgroundServerStack.ts`
- `src/server/utils/env.ts`
- `src/server/utils/runtimeWritablePath.ts`
- `src/server/utils/runtimeTempPath.ts` (new shared runtime-temp helper if not kept inside `runtimeWritablePath.ts`)
- `src/server/utils/serverRole.ts`
- `src/server/utils/serverRuntimeRole.ts`
- `package.json` if helper scripts become necessary

Deliverables:

- Packaged mode resolves only the bundled Bun from the artifact; `desktop:dev` may keep explicit or host Bun lookup, but that path must stay visibly separate from packaged startup.
- The chosen packaged backend runner is explicit and verified: either use ElectroBun's packaged Bun runtime only after proving `process.execPath` can launch backend TypeScript child entrypoints, or copy a separate platform-specific Bun binary into the artifact and resolve that path; macOS executable bits and Windows `.exe` naming are preserved.
- A missing or unusable packaged backend runner fails with actionable diagnostics instead of silently falling back to host Bun.
- Backend entrypoint resolution is artifact-relative and deterministic.
- Frontend `viewsRoot`, `windowUrl`, preload scripts, and renderer asset paths are artifact-relative and point at the copied `views/mainview` frontend assets in both dev and packaged modes; they do not assume `src/views`, repo `dist`, or the launcher `process.cwd()`.
- Packaged stack orchestration is an importable helper with no top-level side effects; dev scripts remain thin wrappers around shared process/env logic, and packaged startup does not depend on package scripts or repo-root `process.cwd()`.
- Backend server module imports remain role-scoped or side-effect-free: importing the API, maintenance, or judge role must not spawn optional CLIs, run local-machine helper subprocesses, open DuckDB, or read/write role-irrelevant runtime state before that role's explicit startup gate needs it.
- Packaged stack configuration resolution does not import `@duckdb/node-api`, open the DuckDB file, or read mutable app settings merely to choose ports or child commands before the maintenance role starts; stored maintenance tuning is read lazily with bounded failures and env/default fallbacks.
- Desktop shell launcher code does not import server modules that load native DB dependencies, read app settings, or perform runtime I/O at module top level merely to compute child-process commands; server-specific imports stay lazy or inside backend child processes.
- Runtime-profile command construction stays lazy and mode-scoped so app/app-server launch modes do not import `@duckdb/node-api`, read local app settings, or touch server runtime state merely to spawn Vite or the static app server.
- The source-first artifact includes all runtime files required by the chosen packaged entrypoints, including backend source, DuckDB migration SQL under `src/db/duckdbMigrations/`, copied launcher source if used, runtime child-process entrypoints, native `node_modules`, package/runtime metadata files, and any other files that Bun or native modules need.
- The artifact manifest records the chosen backend runner path, backend entrypoints, copied source roots, required metadata files such as `package.json`/`tsconfig.json` if used by the source-first runner, native module roots, migration SQL, frontend `views/mainview` files, and intentionally retained non-source files.
- Source-first copy rules exclude generated desktop output, tests, fixtures, and dev-only files unless a file is intentionally required at runtime and documented in the artifact manifest.
- Any reused stack launcher accepts artifact-relative Bun and backend entrypoint inputs instead of hard-coded bare `bun`, `bun run`, `bunx`, package-script, `PATH`, and `process.cwd()` source assumptions in packaged mode.
- The source-first artifact either includes every launched backend stack entrypoint such as `scripts/startServerStack.ts`, or moves the packaged stack launcher under copied `src` paths.
- Packaged child processes may use the artifact root for source lookup, but all writable env paths, DuckDB paths, runtime temp paths, lock/metadata paths, and log paths point at the desktop data root; introduce a shared runtime-temp helper backed by `FORSKA_RUNTIME_TEMP_DIR`, propagate it to every backend role, and do not rely on `os.tmpdir()` for packaged runtime files.
- Packaged child-process envs are built from a small explicit base plus documented safe passthrough values, then force desktop-owned values for `FORSKA_DESKTOP_MODE`, `FORSKA_RUNTIME_PROFILE`, `DUCKDB_PATH`, `DUCKDB_TEMP_DIRECTORY`, `FORSKA_RUNTIME_TEMP_DIR`, `LOG_DIR`, `LOG_LEVEL`, `LOG_STDERR_LEVEL`, `SERVER_ROLE`, `SERVER_DUCKDB_OWNER_URL`, `API_SERVER_PORT`, stack ports, `JUDGE_WORKER_ID`, cleared `JUDGE_WORKER_JOURNAL_PATH`, disabled/default full-text cron toggles and conversion tuning, packaged/default project-mart refresh/rebuild tuning, packaged/default DuckDB append-lane and `BUN_CONFIG_MAX_HTTP_REQUESTS` values, and child `TMPDIR`/`TMP`/`TEMP`; host development overrides cannot redirect packaged data, ports, roles, logs, journals, HTTP request caps, background cron behavior, provider-runtime discovery, telemetry, project-mart maintenance, or judging capacity.
- Packaged maintenance tuning and read-only backend toggles come from packaged defaults or app-owned Settings only; host shell `DUCKDB_MEMORY_LIMIT`, `DUCKDB_APPEND_LANE_COUNT`, `BACKGROUND_MAINTENANCE_DUCKDB_MEMORY_LIMIT`, `PROJECT_MART_LARGE_REBUILD_*`, `PROJECT_MART_REFRESH_MAX_FULL_SCOPE_ARTICLES`, `FULL_TEXT_CONVERSION_BATCH_SIZE`, `FULL_TEXT_CONVERSION_CONCURRENCY`, `FORSKA_DISABLE_LIVE_READ_ONLY_DUCKDB`, `FORSKA_OWNERLESS_READ_ONLY_DUCKDB`, host provider-runtime env except launcher-owned `FORSKA_RUNTIME_PROFILE`, `FORSKA_RUNTIME_SERVICE`, and `FORSKA_RUNTIME_TEMP_DIR`, bare topology env such as `TP_SIZE`, `PP_SIZE`, and `DP_SIZE`, GPU/SGLang env, `NVIDIA_SMI_*`, `CODEX_MAX_INFLIGHT`, `BUN_CONFIG_MAX_HTTP_REQUESTS`, `LOG_LEVEL`, `LOG_STDERR_LEVEL`, `NODE_ENV`, `FORSKA_TEST_LOG_ROOT`, and judgment tuning env are cleared unless explicitly documented as packaged settings.
- Packaged desktop launches and owns API, maintenance-worker, and judge-worker roles instead of relying on `SERVER_ROLE=dev-single`.
- The API role proxies owner-dependent requests, including JSON, multipart/form-data, and other body-bearing POST/PATCH/PUT/DELETE routes, to the maintenance-worker private API without changing browser or desktop client call sites.
- The API role proxy preserves response status, status text, headers, and binary/streamed response bodies, and it has explicit size/backpressure behavior for buffered multipart or binary request bodies instead of unbounded memory growth.
- The API role proxy propagates client aborts/cancellations where the runtime exposes them and uses bounded upstream timeouts so abandoned browser or desktop requests do not keep maintenance-worker work running indefinitely.
- API proxy and desktop bridge forwarding filter or regenerate hop-by-hop and transport-owned headers such as `Host`, `Connection`, `Keep-Alive`, `Transfer-Encoding`, `Upgrade`, and `Content-Length` instead of blindly forwarding client or renderer values; application headers and multipart `Content-Type` boundaries remain preserved.
- The desktop fetch bridge only intercepts relative `/api` requests and configured desktop API-origin requests whose pathname starts with `/api/`; it falls back to native fetch for same-origin non-API paths and for arbitrary external URLs whose path happens to start with `/api/`.
- The desktop fetch bridge preserves method, query string, headers, binary bodies, JSON, and multipart/form-data uploads when forwarding renderer `/api` requests to the API role, cleans up pending requests on renderer aborts, backend errors, timeouts, body-read failures, and window shutdown, and keeps desktop imports on the same client call sites as browser flows.
- Large desktop uploads have a deliberate tested path: either streamed/chunked forwarding without base64 IPC memory blowups, or a documented pre-send limit with actionable UI/API failure before the renderer or shell allocates unbounded buffers.
- Large desktop downloads and export responses, including CSV exports and runtime-asset/PDF responses, have a deliberate tested path: either streamed/chunked delivery without base64 IPC memory blowups, or a documented response-size limit that preserves `Content-Disposition`/content type and fails with actionable UI/API guidance before unbounded renderer or shell allocation.
- If any desktop request path bypasses IPC and uses direct loopback `fetch`, packaged CORS/preflight handling explicitly allows the actual ElectroBun renderer origin (`views://mainview` or `null`, whichever the runtime sends) without broadening browser/dev origins unintentionally.
- The desktop launcher assigns deterministic loopback ports, `SERVER_DUCKDB_OWNER_URL`, role env, a stable `JUDGE_WORKER_ID`, cleared inherited `JUDGE_WORKER_JOURNAL_PATH`, data paths, runtime temp paths, lock/metadata paths, log paths, and child `TMPDIR`/`TMP`/`TEMP` fallbacks for the stack.
- Before falling back to alternate ports, the desktop launcher distinguishes foreign port occupancy from an existing same-data-root Forska backend stack, attaches to or shuts down orphaned same-data-root stacks when safe, reclaims stale same-data-root metadata, and refuses to start a second stack against the same desktop data root only when another live shell/backend owner remains.
- Startup readiness, role logs, child-process shutdown, relaunch, and crash recovery are surfaced per role.
- Initial packaged startup has bounded role restart/readiness attempts; repeated role crashes or readiness timeouts fail with actionable diagnostics instead of looping until the shell-level timeout.
- Startup errors include resolved Bun path, backend entrypoint, frontend views root, API/maintenance/judge origins, data root, runtime temp path, and log path, and render dynamic error/log content as escaped text rather than raw HTML.
- ElectroBun watch ignores and Bun test discovery ignores match the actual dot-prefixed build and artifact folders.

Quality Gates:

- `bun run lint`
- `bunx eslint electrobun.config.ts scripts/runWithRuntimeProfile.ts scripts/devServerWatch.ts scripts/startServerStack.ts scripts/runBunTests.ts scripts/runBunTests.test.ts`
- Extend `scripts/runWithRuntimeProfile.test.ts` coverage for mode-scoped command/env construction that does not import `@duckdb/node-api` or read local app settings for app/app-server launch modes, then run `bun test scripts/runWithRuntimeProfile.test.ts`.
- Add `scripts/runBunTests.test.ts` coverage for dot-prefixed desktop artifact/build-folder ignores, then run `bun test scripts/runBunTests.test.ts`.
- Add `src/desktop/desktopBackendStack.test.ts` coverage for packaged stack process orchestration, sanitized child env construction, packaged Bun runner selection, no host-runner fallback in packaged mode, cleared host runtime/provider/telemetry/topology/project-mart/full-text/DuckDB-append/log-test-mode/HTTP-request-limit env, and packaged defaults for full-text cron toggles, then run `bun test src/desktop/desktopBackendStack.test.ts`.
- Add `src/desktop/desktopApiBridge.test.ts` coverage for renderer-to-API request serialization of query strings, JSON, binary bodies, multipart/form-data, same-origin API versus same-origin non-API versus external URL filtering, hop-by-hop header filtering, abort handling, body-read failures, timeout cleanup, backend-error cleanup, large-upload limit/streaming behavior, and large download/export response streaming or bounded-size behavior with `Content-Disposition` preservation, then run `bun test src/desktop/desktopApiBridge.test.ts`.
- If a direct loopback desktop fetch path is used for any request class, extend server startup/CORS coverage for the actual ElectroBun renderer origin and preflight headers without changing browser/dev defaults.
- Add `src/desktop/desktopStartupPage.test.ts` coverage for escaped startup error rendering and diagnostic fields, then run `bun test src/desktop/desktopStartupPage.test.ts`.
- Extend `src/desktop/getDesktopRuntimeConfig.test.ts` coverage for artifact-relative bundled Bun or verified packaged `process.execPath` runner selection, backend entrypoint, sanitized packaged env overrides including cleared host provider-runtime/telemetry/topology/project-mart/full-text/DuckDB-append/log-test-mode/HTTP-request-limit env, runtime temp root, and frontend views-root resolution, then run `bun test src/desktop/getDesktopRuntimeConfig.test.ts`.
- `bun test src/desktop/desktopSingleInstance.test.ts`
- `bun test src/app/utils/client-env.test.ts`
- `bun test src/app/utils/getDesktopApiOrigin.test.ts`
- `bun test src/app/utils/getApiRequestUrl.test.ts`
- Add `src/app/utils/postFormDataToApi.test.ts` coverage for desktop API-origin multipart request URL selection without changing browser call sites, then run `bun test src/app/utils/postFormDataToApi.test.ts`.
- `bun test src/app/utils/downloadCsv.test.ts`
- Extend `src/server/routes/ApiProxyRoutes.test.ts` coverage for JSON, multipart/form-data, binary body, query string, response header/status/body preservation including `Content-Disposition`, streamed or bounded large response behavior, hop-by-hop header filtering, client-abort/upstream-timeout behavior, and explicit large-body request behavior, then run `bun test src/server/routes/ApiProxyRoutes.test.ts`.
- `bun test src/server/routes/ApiProxyRoutes.retry.test.ts`
- `bun test src/server/utils/backgroundServerStack.test.ts`
- `bun test src/server/utils/env.test.ts`
- `bun test src/server/utils/runtimeWritablePath.test.ts` and, if a separate helper is added, `bun test src/server/utils/runtimeTempPath.test.ts`
- `bun run build`
- `bun run desktop:build`
- Inspect the built artifact, or add an artifact-manifest test, to confirm required backend/frontend/migration/native-module files are present while tests, fixtures, generated desktop output folders, and dev-only files are absent unless intentionally documented.
- Browser verify: `bun run dev:server` and `bun run dev:app` still boot after runtime-shape changes.
- Unsigned macOS artifact launches without repo checkout or host Bun/Node/npm/bunx on `PATH`.

### 2. Runtime-Write Audit

Goal: keep first-spike packaged runtime writes under explicit desktop runtime locations while preserving relative `assets/...` keys.

Files:

- `src/server/utils/runtimeWritablePath.ts`
- `src/server/utils/runtimeTempPath.ts` (new shared runtime-temp helper if not kept inside `runtimeWritablePath.ts`)
- `src/app/utils/getRuntimeAssetUrl.ts`
- `src/server/services/covidenceImportService.ts`
- `src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostCovidence.ts`
- `src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostCovidenceAnalyze.ts`
- `src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostCovidenceCreate.ts`
- `src/server/services/structuredFileImportService.ts`
- `src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostStructuredFile.ts`
- `src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostStructuredFileAnalyze.ts`
- `src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostStructuredFileCreate.ts`
- `src/server/routes/ArticleAdminRoutes.ts`
- `src/server/routes/ArticlesRoutes.ts`
- `src/server/services/pdfFetchJobs.ts`
- `src/server/cron/fullTextJobs.ts`
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

- Structured imports, uploaded PDFs, fetched PDFs from Article Admin, bulk article fetch jobs, and maintenance full-text fetch jobs, FHIR EHR input folders, and runtime asset reads resolve through app-owned paths in desktop mode.
- Use one shared safe `assets/...` local-key normalizer/resolver for runtime asset serving, Covidence, structured imports, uploaded and fetched PDFs, FHIR input folders, and PDF conversion instead of duplicating prefix checks.
- The shared safe-asset helper resolves env-dependent roots at call time, or through injected env/cwd/platform/path modules in tests, so desktop-mode and Windows separator/case-insensitivity behavior cannot be hidden by stale module-scope path constants.
- Runtime asset, Covidence package, structured-file package, FHIR cursor `assets/...`, and FHIR `fhir:` importRoute-derived inputs reject absolute paths, drive-letter and UNC paths, empty normalized asset keys, URL-decoded or raw `..` segments, and backslash-based escapes before resolving any local file.
- Resolved runtime asset paths are verified, with Windows separators and case-insensitive filesystems such as Windows and default macOS handled correctly, to stay inside the runtime writable root's `assets/` tree, or inside a narrower expected package folder when a flow owns one.
- Existing-file reads canonicalize with real paths after existence checks where the platform supports it, so symlinks inside `assets/` cannot escape the runtime writable root or a flow-owned package folder.
- Asset writes create and verify parent directories through the same containment helper and reject symlinked parent-directory escapes before writing Covidence packages, structured imports, uploaded PDFs, or fetched PDFs.
- Uploaded and fetched PDF filenames derived from article IDs, DOI values, arXiv IDs, or source URLs use encoded, hashed, or otherwise filesystem-safe bounded names and are verified inside the expected PDF folder before writing.
- All generated runtime asset filenames and package folder names, including Covidence and structured-file uploads, are bounded and Windows-safe: reserved device names, trailing dots/spaces, control characters, separators, and overlong path segments cannot be produced from user or dataset input.
- PDF conversion resolves DB-stored `assets/...` PDF paths through the shared safe-asset helper before reading local files in desktop mode, and rejects arbitrary absolute, drive-letter, UNC, traversal, and non-asset local paths unless a separately documented trusted import path owns them.
- FHIR EHR import temp spooling uses the shared runtime-temp helper and `FORSKA_RUNTIME_TEMP_DIR` with cleanup on success and failure in desktop mode; OS temp remains acceptable only for non-desktop mode or for a separately recorded product/security exception.
- Provider runtime records remain under the desktop runtime root in desktop mode and do not create repo-root `cache/` entries during packaged runs.
- Env-dependent writable directories in Covidence, structured imports, provider runtime records, and similar helpers resolve at call time or via test-injected env/cwd so desktop-mode tests cannot pass because a module imported before env setup froze a repo-root path.
- DB-stored `assets/...` references keep working in browser and desktop flows.

Quality Gates:

- `bun run lint`
- Extend `src/server/utils/runtimeWritablePath.test.ts` coverage for desktop asset-path escape rejection, Windows separator and case-insensitive filesystem containment, symlink escape rejection where supported, and the shared safe-asset-path helper; cover `FORSKA_RUNTIME_TEMP_DIR` there or in a new `src/server/utils/runtimeTempPath.test.ts` if the temp helper is split out; then run the relevant targeted test file(s).
- `bun test src/app/utils/getRuntimeAssetUrl.test.ts`
- Extend `src/server/services/covidenceImportService.test.ts` coverage for desktop package paths, package-path escape rejection, and Windows-safe bounded generated package/file names, then run `bun test src/server/services/covidenceImportService.test.ts`.
- Add/extend Covidence route-level coverage for multipart analyze/create/import flows using desktop package paths and rejecting escaped cursor/config asset paths, then run `bun test src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostCovidenceAnalyze.test.ts src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostCovidenceCreate.test.ts src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostCovidence.test.ts`.
- Extend `src/server/services/structuredFileImportService.test.ts` coverage for desktop package paths, package-path escape rejection, and Windows-safe bounded generated package/file names, then run `bun test src/server/services/structuredFileImportService.test.ts`.
- Add/extend structured-file route-level coverage for multipart analyze/create/import flows using desktop package paths and rejecting escaped cursor/config asset paths, then run `bun test src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostStructuredFileAnalyze.test.ts src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostStructuredFileCreate.test.ts src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostStructuredFile.test.ts`.
- Add `src/server/routes/ArticleAdminRoutes.test.ts` coverage for uploaded PDF desktop paths, article IDs containing slash/backslash/traversal-like text, Windows reserved device names/trailing dots/trailing spaces, symlinked parent-directory escape rejection, and filename escape rejection, then run `bun test src/server/routes/ArticleAdminRoutes.test.ts`.
- Add `src/server/cron/fullTextJobs/fullTextArticleFetchFromArxiv.test.ts`, `src/server/cron/fullTextJobs/fullTextArticleFetchFromUnpaywall.test.ts`, and `src/server/cron/fullTextJobs/fullTextArticleFetchFromOriginalUrls.test.ts` coverage for desktop paths, DOI/arXiv/source-URL keys containing slash/backslash/traversal-like or long text, Windows reserved device names/trailing dots/trailing spaces, and symlinked parent-directory escape rejection, then run `bun test src/server/cron/fullTextJobs/fullTextArticleFetchFromArxiv.test.ts`, `bun test src/server/cron/fullTextJobs/fullTextArticleFetchFromUnpaywall.test.ts`, and `bun test src/server/cron/fullTextJobs/fullTextArticleFetchFromOriginalUrls.test.ts`.
- Add `src/server/services/pdfFetchJobs.test.ts` and `src/server/routes/ArticlesRoutes.test.ts` coverage for desktop-mode bulk/by-filter fetched-PDF jobs using safe app-data asset paths and preserving existing user-upload skip behavior, then run `bun test src/server/services/pdfFetchJobs.test.ts src/server/routes/ArticlesRoutes.test.ts`.
- Add `src/server/routes/RuntimeAssetsRoutes.test.ts` coverage for desktop-mode `assets/...` serving and rejection of `assets/../...`, absolute, drive-letter, encoded traversal, backslash escape, and symlink escape inputs where supported, then run `bun test src/server/routes/RuntimeAssetsRoutes.test.ts`.
- Add `src/server/utils/convertPdfToText.test.ts` coverage for desktop-mode safe `assets/...` PDF file reads and rejection of absolute, drive-letter, UNC, traversal, backslash, and non-asset local paths, then run `bun test src/server/utils/convertPdfToText.test.ts`.
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
- `src/server/utils/serverRuntimeRole.ts`
- `src/server/utils/duckdbService.ts`
- `src/server/services/readOnlyDuckdbService.ts`
- `src/server/services/appReadOnlyDatabaseService.ts`
- `src/server/services/getDuckdbMartRefreshService.ts`
- `src/server/workers/projectMartRefreshWorker.ts`
- `src/server/utils/martRefreshDrainEligibility.ts`
- `src/server/utils/martRefreshDrainHeartbeat.ts`
- `src/server/utils/projectMartRefreshWorkerHeartbeat.ts`
- `src/server/utils/projectMartLargeRebuildTuning.ts`
- `src/server/utils/projectMartLargeRebuildHeartbeat.ts`
- `src/server/utils/ownerlessReadableBackends.ts`
- `src/server/routes/apiRouteClassification.ts`
- `src/server/routes/DuckdbOwnerConnectionsRoutes.ts`
- `src/server/routes/JudgmentsJobsRoutes.ts`
- `src/server/routes/AdminInvestigateRoutes.ts`
- `src/server/routes/JudgmentDispatchTelemetryRoutes.ts`
- `src/server/routes/DuckdbStudioRoutes.ts`
- `src/server/utils/duckdbScriptAccess.ts`
- `src/server/cron/judgmentsJobs/judgmentDispatchTelemetry.ts`
- `src/server/cron/judgmentsJobs/judgeWorkerCompletionJournal.ts`
- `src/server/cron/judgmentsJobs/judgmentJobSqliteService.ts`
- `src/server/cron/judgmentsJobs/judgmentJobSqliteIsolatedImport.ts`
- `src/server/cron/judgmentsJobs/runJudgmentJobSqliteSingleJobClaimExport.ts`
- `src/server/cron/judgmentsJobs/judgmentJobLease.ts`
- `src/server/cron/judgmentsJobs/judgmentJobPaths.ts`
- `src/server/utils/duckdbOwnerConnections.ts`
- `src/server/utils/duckdbOwnerLease.ts`
- `src/server/utils/judgeWorkerJournalIdentity.ts`
- `src/server/utils/localAppSettings.ts`
- `src/server/utils/runtimeLogger.ts`
- `src/server/utils/runtimeTempPath.ts` (new shared runtime-temp helper if not kept inside `runtimeWritablePath.ts`)
- `src/db/migrateDuckdb.ts`
- `src/db/duckdbMigrations/`

Deliverables:

- `@duckdb/node-api` loads in the packaged backend.
- `bun:sqlite` works for job state and restart.
- Migrations run on first launch and relaunch, with `src/db/duckdbMigrations/` preserved next to `src/db/migrateDuckdb.ts` in the packaged artifact.
- `FORSKA_RUNTIME_TEMP_DIR` is translated into role env such as `DUCKDB_TEMP_DIRECTORY` and into read-only DuckDB instance options, so owner and read-only DuckDB temp files stay under the desktop data/runtime temp root.
- DuckDB temp directories for both owner and read-only DuckDB services, DuckDB Studio snapshot/diagnostic files, owner lease/history files, worker-registry files, local app settings, judgment-job SQLite/WAL/lease/repair-export files, judge-worker journals, desktop/backend-stack lock metadata, and runtime logs resolve under the desktop data root in packaged mode through call-time runtime path/temp helpers rather than module-scope `tmpdir()` constants.
- Judge-worker completion journal open/replay paths use the same resolved journal identity as `initializeJudgeWorkerJournalIdentity`, including worker-id-derived app-data paths when `JUDGE_WORKER_JOURNAL_PATH` is cleared, and fail closed rather than opening an empty or CWD-relative SQLite database.
- Project-mart refresh/rebuild scheduling, worker-registry throughput diagnostics, and maintenance drain eligibility use sanitized packaged defaults or app-owned Settings/DB state, not host `PROJECT_MART_*`, `DUCKDB_APPEND_LANE_COUNT`, or log/test-mode env leakage.
- Judgment-job isolated import and repair child processes use the bundled Bun `process.execPath` and artifact-relative entrypoint paths, including `runJudgmentJobSqliteSingleJobClaimExport.ts`, instead of host Bun or repo-checkout paths.
- Ownerless-readable backend validation still succeeds in packaged API startup after maintenance-worker migration, with a clear fallback to ownerless control state if live read-only DuckDB is unavailable.
- Ownerless-readable route classification, ownerless backend declarations, and API-role read implementations stay consistent, so routes classified as local diagnostics never accidentally perform owner-dependent DuckDB work in the API role without a read-only backend or an explicit owner proxy fallback.
- Restart and crash recovery leave local data usable.
- API, maintenance-worker, and judge-worker roles each start with the expected capabilities and recover without requiring `dev-single`.

Quality Gates:

- `bun run lint`
- `bunx eslint scripts/runWithRuntimeProfile.ts scripts/startServerStack.ts`
- `bun test src/server/utils/getDuckdbPath.test.ts`
- `bun test src/server/utils/backgroundServerStack.test.ts`
- `bun test src/server/utils/serverRole.test.ts`
- `bun test src/server/utils/serverRuntimeRoleDuplicateServer.test.ts src/server/utils/serverRuntimeRoleWriterWorkError.test.ts`
- `bun test scripts/runWithRuntimeProfile.test.ts`
- `bun test src/db/migrateDuckdb.test.ts`
- `bun test src/server/utils/duckdbServiceNodeApiSpike.test.ts src/server/utils/duckdbServiceLease.test.ts src/server/utils/duckdbServiceShutdown.test.ts src/server/utils/duckdbServiceReload.test.ts src/server/utils/duckdbServiceMemoryLimit.test.ts`
- Add `src/server/utils/duckdbServiceSnapshot.test.ts` coverage for packaged-mode DuckDB snapshot/temp-directory resolution and cleanup, then run `bun test src/server/utils/duckdbServiceSnapshot.test.ts`.
- `bun test src/server/routes/DuckdbStudioRoutes.test.ts`
- `bun test src/server/utils/duckdbScriptAccess.test.ts`
- Add `src/server/services/readOnlyDuckdbService.test.ts` coverage for packaged-mode read-only DuckDB startup, then run `bun test src/server/services/readOnlyDuckdbService.test.ts`.
- Add `src/server/cron/judgmentsJobs/judgmentJobPaths.test.ts` coverage for desktop-mode judgment-job root resolution, then run `bun test src/server/cron/judgmentsJobs/judgmentJobPaths.test.ts`.
- Extend `src/server/cron/judgmentsJobs/judgmentJobLease.test.ts` coverage for desktop-mode judgment-job lease files under the judgment-job root, then run `bun test src/server/cron/judgmentsJobs/judgmentJobLease.test.ts`.
- Extend `src/server/utils/duckdbOwnerLease.test.ts` coverage for desktop-mode owner lease/history storage under the data root, then run `bun test src/server/utils/duckdbOwnerLease.test.ts`.
- Extend `src/server/utils/judgeWorkerJournalIdentity.test.ts` coverage for desktop-mode worker-id journal paths under the data root and inherited `JUDGE_WORKER_JOURNAL_PATH` clearing, then run `bun test src/server/utils/judgeWorkerJournalIdentity.test.ts`.
- Extend `src/server/cron/judgmentsJobs/judgeWorkerCompletionJournal.test.ts` coverage for worker-id-derived journal paths when `JUDGE_WORKER_JOURNAL_PATH` is cleared, replay after initialization, and failure on missing identity instead of empty/CWD journal paths, then run `bun test src/server/cron/judgmentsJobs/judgeWorkerCompletionJournal.test.ts`.
- `bun test src/server/cron/judgmentsJobs/judgmentJobSqliteService.test.ts`
- Add `src/server/cron/judgmentsJobs/judgmentJobSqliteIsolatedImport.test.ts` coverage for packaged/source-first child entrypoint resolution and bundled `process.execPath` usage, then run `bun test src/server/cron/judgmentsJobs/judgmentJobSqliteIsolatedImport.test.ts`.
- Extend `src/server/utils/duckdbOwnerConnections.test.ts` coverage for desktop-mode worker-registry storage and sanitized project-mart throughput profile values, then run `bun test src/server/utils/duckdbOwnerConnections.test.ts`.
- Add `src/server/utils/projectMartLargeRebuildTuning.test.ts` and `src/server/utils/martRefreshDrainEligibility.test.ts` coverage for packaged/default versus app-owned maintenance tuning and host-env rejection, then run `bun test src/server/utils/projectMartLargeRebuildTuning.test.ts src/server/utils/martRefreshDrainEligibility.test.ts`.
- Extend `src/server/utils/projectMartLargeRebuildHeartbeat.test.ts`, `src/server/utils/martRefreshDrainHeartbeat.test.ts`, and `src/server/workers/projectMartRefreshWorker.test.ts` coverage for packaged maintenance tuning and low-memory guard behavior, then run `bun test src/server/utils/projectMartLargeRebuildHeartbeat.test.ts src/server/utils/martRefreshDrainHeartbeat.test.ts src/server/workers/projectMartRefreshWorker.test.ts`.
- `bun test src/server/utils/localAppSettings.test.ts`
- `bun test src/server/utils/runtimeLogger.test.ts`
- If a separate runtime-temp helper is added, `bun test src/server/utils/runtimeTempPath.test.ts`
- Add or extend `src/server/routes/apiRouteClassification.test.ts` coverage for ownerless-readable classification and ownerless backend declaration consistency, then run `bun test src/server/routes/apiRouteClassification.test.ts`.
- Add `src/server/routes/JudgmentDispatchTelemetryRoutes.test.ts` coverage for API-role ownerless-readable judgment-dispatch telemetry that stays local/process-backed and does not open owner DuckDB, and extend `src/server/cron/judgmentsJobs/judgmentDispatchTelemetry.test.ts` if aggregation behavior changes; then run `bun test src/server/routes/JudgmentDispatchTelemetryRoutes.test.ts src/server/cron/judgmentsJobs/judgmentDispatchTelemetry.test.ts`.
- Extend `src/server/routes/DuckdbOwnerConnectionsRoutes.test.ts`, `src/server/routes/JudgmentsJobsRoutes.test.ts`, and `src/server/routes/AdminInvestigateRoutes.test.ts` coverage for API-role ownerless-readable fallbacks that do not accidentally open owner DuckDB or require maintenance-only state, then run `bun test src/server/routes/DuckdbOwnerConnectionsRoutes.test.ts src/server/routes/JudgmentsJobsRoutes.test.ts src/server/routes/AdminInvestigateRoutes.test.ts`.
- Extend `src/server/indexStartup.test.ts` coverage for packaged API startup after maintenance-worker migration and ownerless-readable backend fallback, then run `bun test src/server/indexStartup.test.ts`.
- macOS verify: first launch, quit, relaunch.

### 4. Port And Loopback Hardening

Goal: packaged desktop should not fail opaquely when any default backend stack port is already taken.

Files:

- `src/desktop/getDesktopRuntimeConfig.ts`
- `src/desktop/index.ts`
- `src/app/utils/client-env.ts`
- `src/app/utils/getDesktopApiOrigin.ts`
- `src/app/utils/getApiRequestUrl.ts`
- `src/server/utils/backgroundServerStack.ts`
- `src/server/serverMain.ts`
- `src/server/utils/env.ts`
- `src/utils/runtimePortDefaults.ts` if shared defaults need to change

Deliverables:

- Occupied desktop API, maintenance-worker, or judge-worker ports either fall back to free loopback ports or show an actionable startup error.
- If free-port fallback is used, the selected API, maintenance-worker, and judge-worker ports are propagated to the preload bridge, backend role env, readiness checks, startup diagnostics, and logs with no stale hard-coded `32101` assumptions.
- Packaged mode binds backend listeners to loopback only and does not expose API, maintenance-worker, or judge-worker ports on LAN interfaces.
- API listener host selection is explicit and typed/configured for packaged mode; browser/dev defaults remain unchanged unless intentionally changed and documented.
- Packaged port selection ignores dev-only host overrides such as `FORSKA_DESKTOP_API_SERVER_PORT`, runtime-profile port env, or stale built frontend defaults unless they are promoted to a documented packaged setting and reflected in startup diagnostics.

Quality Gates:

- `bun run lint`
- `bun test src/desktop/getDesktopRuntimeConfig.test.ts`
- `bun test src/desktop/desktopSingleInstance.test.ts`
- `bun test src/app/utils/client-env.test.ts src/app/utils/getDesktopApiOrigin.test.ts src/app/utils/getApiRequestUrl.test.ts`
- `bun test src/server/utils/backgroundServerStack.test.ts`
- `bun test src/server/utils/env.test.ts`
- Extend `src/server/indexStartup.test.ts` coverage for packaged-mode loopback listener host selection and unchanged browser/dev defaults, then run `bun test src/server/indexStartup.test.ts`.
- Extend `src/desktop/getDesktopRuntimeConfig.test.ts` or `src/desktop/desktopBackendStack.test.ts` coverage for packaged port selection ignoring dev-only host port overrides while `desktop:dev` remains explicitly configurable.
- `bun run desktop:build`
- macOS verify: launch with the default API, maintenance-worker, and judge-worker ports already occupied.
- Packaged app verify: API, maintenance-worker, and judge-worker listeners are reachable on loopback and not on non-loopback interfaces.

### 5. Optional CLI And Host Helper Behavior

Goal: missing optional CLIs or host credential/telemetry helpers must never block startup or normal use.

Files:

- `src/server/utils/getCodexAppServerClient.ts`
- `src/server/utils/codexCliAuth.ts`
- `src/server/utils/getInferenceRuntimeConfig.ts`
- `src/server/utils/localAppSettings.ts`
- `src/server/serverMain.ts`
- `src/server/routes/ModelsRoutes.ts`
- `src/server/routes/JudgmentsRoutes.ts`
- `src/server/routes/apiRouteClassification.ts`
- `src/server/routes/ProviderConnectionsRoutes.ts`
- `src/server/routes/ProviderModelsRoutes.ts`
- `src/server/routes/JudgmentsJobsRoutes.ts`
- `src/server/routes/UsersRoutes.ts`
- `src/server/providers/providerAuthService.ts`
- `src/server/providers/providerInvocationService.ts`
- `src/server/providers/providerRuntimeDetector.ts`
- `src/server/providers/providerRuntimeDiscovery.ts`
- `src/server/providers/providerRuntimeState.ts`
- `src/server/providers/providerSyncService.ts`
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
- `src/app/routes/+projects/+create.tsx`
- `src/app/routes/+projects/+$id/+edit.tsx`
- `src/app/routes/+admin/+datasources/+covidence-import.tsx`
- `src/utils/getSglangRuntimeModelNotice.ts`
- `src/app/routes/+providers/+index.tsx`
- `src/app/routes/+providers/+add-provider.tsx`
- `src/app/routes/+providers/+$id/+index.tsx`
- `src/app/routes/+providers/providerCatalogUi.ts`
- `src/app/routes/+providers/providerRuntimeStateCard.tsx`
- `src/app/routes/+settings/+index.tsx`

Deliverables:

- Missing `codex` does not block startup.
- Codex binary resolution is platform-aware, including Windows executable suffixes/PATHEXT behavior, honors the Settings `codexBin` override, and does not advertise unsupported env vars.
- Codex-only flows surface install and configuration guidance before use.
- Codex login/start buttons are disabled or replaced with Settings/install guidance when runtime status reports that the CLI binary is unavailable.
- When Codex is used in desktop mode, its safe app-server cwd/scratch directory resolves under the desktop runtime temp/data root and not under the repo root or install directory; cleanup/retention is explicit.
- Codex guidance matches the actual configuration surface; it does not point to unsupported env vars such as `CODEX_BIN` unless that env var is implemented.
- `/api/models/codex/status` and `/api/models/codex/login` handle missing `codex` without unhandled spawn errors, and the login route does not start a device-login subprocess when status already reports that the CLI binary is unavailable.
- Codex status/login/provider-auth/model-discovery route ownership is explicit in the multi-worker stack: API proxy classification either keeps these routes local to the API role or deliberately sends them to the maintenance owner, and user-initiated Codex model discovery plus judge-worker invocation do not create competing long-lived Codex app-server children unless that per-role ownership is documented and shut down cleanly.
- Codex judge-worker invocation paths through `providerInvocationService` and the Codex adapter report missing CLI/runtime as a model-specific unsupported state without affecting non-Codex judging capacity, model listing, or provider setup.
- `/api/provider-auth/codex/begin` and `/api/provider-auth/codex/finish` handle missing `codex` consistently with the direct Codex status/login routes.
- Packaged desktop guidance points users to in-app Providers or Settings flows rather than `http://localhost:${env.VITE_PORT}/providers`.
- Packaged API startup does not call `warmCodexAppServer`, `getCodexCliLoginStatus`, or device-login startup until the user opens a Codex-specific flow; user-initiated Codex status checks remain bounded and degraded when the CLI is absent.
- Non-Codex model listing and project/model-selection routes such as `/api/models` do not spawn `codex` merely because a saved Codex connection or model exists; missing Codex degrades to stored/manual Codex metadata and guidance without blocking non-Codex workflows.
- `/api/judgments/model` and the project create/edit plus Covidence import "Create default model" actions do not silently create a local SGLang `localhost:30000` Qwen model in packaged desktop. If the legacy route is retained, it requires explicit user-selected provider/name/baseURL values, stores metadata consistent with those values, and surfaces missing-local-runtime guidance before the model can be selected for judging.
- Project create/edit and Covidence import model pickers guide users to Providers or Settings when no selectable model exists, and saved SGLang/local-runtime models show an explicit missing-runtime or mismatch notice instead of looking like a packaged default that is ready to run.
- Provider runtime detection and runtime-state cards are user-initiated, bounded, and degraded when saved local runtimes are unreachable; they do not inherit host provider-runtime env or block project/model-selection routes in packaged mode.
- Packaged startup and secretless/manual provider setup do not touch provider secret-storage CLIs or OS credential helpers.
- Existing `env:*` provider secret refs and host API-key environment variables are not silently read by packaged desktop unless the user has explicitly configured an app-owned packaged secret surface; missing env-backed secrets degrade to clear Settings/Providers guidance.
- API-key provider setup has a supported packaged secret-storage behavior on macOS and Windows, or surfaces an explicit unsupported-state before attempting to store a secret; macOS `/usr/bin/security` helper use, if retained, is resolved explicitly as an OS credential helper, isolated behind timeout/degraded-error handling, and not used on Windows.
- `sqlite3` remains maintenance-only, is not invoked during packaged startup, restart, recovery, or core smoke flows, and explicit repair/diagnostic routes report degraded maintenance results if unavailable instead of unhandled spawn failures.
- DuckDB CLI use stays out of the default app database query path in packaged mode; default app-database detection canonicalizes equivalent paths, including Windows case-insensitive spellings, before deciding a query is non-default; non-default or diagnostic paths either remain developer-only or degrade with clear guidance if the CLI is unavailable.
- Optional DuckDB CLI resolution and diagnostics are platform-aware on Windows, including executable suffix and `PATHEXT` behavior, even though the CLI remains outside startup and core flows.
- Optional `ssh` and `nvidia-smi` telemetry remains disabled unless remote worker URLs are configured by packaged-owned provider runtime records or explicit Settings, and missing binaries never block startup or core desktop flows.
- Packaged startup does not inherit host shell `FORSKA_RUNTIME_*`, `NVIDIA_SMI_*`, `GPU_*`, `SGLANG_*`, bare `TP_SIZE`/`PP_SIZE`/`DP_SIZE`, `CODEX_MAX_INFLIGHT`, `BUN_CONFIG_MAX_HTTP_REQUESTS`, `DUCKDB_APPEND_LANE_COUNT`, `PROJECT_MART_LARGE_REBUILD_*`, `PROJECT_MART_REFRESH_MAX_FULL_SCOPE_ARTICLES`, `FULL_TEXT_CONVERSION_*`, log/test-mode env, or judgment/Codex tuning env in a way that changes model/provider selection, telemetry, HTTP request caps, maintenance throughput, or judging capacity; only launcher-owned `FORSKA_RUNTIME_PROFILE`, `FORSKA_RUNTIME_SERVICE`, `FORSKA_RUNTIME_TEMP_DIR`, and app-owned configuration surfaces may supply benchmark-critical runtime settings.
- DuckDB owner lease and judge-worker journal identity helpers remain best-effort; local-machine identity lookup does not run blocking helper subprocesses at module import, and missing or slow `hostname`, `/usr/sbin/scutil`, or `/usr/sbin/ioreg` must not block packaged startup, ownership recovery, or journal lock recovery.

Quality Gates:

- `bun run lint`
- `bun run build`
- Extend `src/server/utils/getCodexAppServerClient.test.ts` coverage for Codex app-server spawn/exit diagnostics, platform-aware binary resolution, and desktop safe-cwd resolution, then run `bun test src/server/utils/getCodexAppServerClient.test.ts`.
- Add `src/server/utils/codexCliAuth.test.ts` coverage for missing `codex` status and device-login behavior, then run `bun test src/server/utils/codexCliAuth.test.ts`.
- Add `src/server/routes/ModelsRoutes.test.ts` coverage for missing-`codex` status/login behavior and `/api/models` degradation that does not spawn Codex for non-Codex workflows, then run `bun test src/server/routes/ModelsRoutes.test.ts`.
- Add `src/server/routes/JudgmentsRoutes.test.ts` coverage for packaged-mode `/api/judgments/model` behavior that does not silently seed localhost SGLang defaults, validates explicit provider/model/baseURL input if retained, and returns actionable guidance when no runtime/provider is configured; then run `bun test src/server/routes/JudgmentsRoutes.test.ts`.
- Extend `src/server/routes/ProviderModelsRoutes.test.ts` coverage for missing-`codex` sync-models/model-discovery behavior that degrades cleanly without spawning competing Codex children, then run `bun test src/server/routes/ProviderModelsRoutes.test.ts`.
- Add `src/server/routes/apiRouteClassification.test.ts` coverage for explicit Codex route ownership/proxy classification expectations, then run `bun test src/server/routes/apiRouteClassification.test.ts`.
- Extend `src/server/indexStartup.test.ts` coverage for packaged startup with missing Codex that does not spawn Codex status/app-server probes, then run `bun test src/server/indexStartup.test.ts`.
- Extend `src/server/utils/getInferenceRuntimeConfig.test.ts` coverage for explicit sanitized-env defaults and provider-runtime-record precedence for telemetry, GPU/SGLang, TP/PP/DP topology, Codex, HTTP request caps, and judgment tuning values, then run `bun test src/server/utils/getInferenceRuntimeConfig.test.ts`.
- Extend `src/server/routes/ProviderConnectionsRoutes.test.ts` coverage for missing-`codex` provider-auth begin and finish behavior plus API-key secret-storage unavailable/degraded behavior, env-backed secret refs missing in packaged mode, and bounded/degraded provider-runtime detection, then run `bun test src/server/routes/ProviderConnectionsRoutes.test.ts`.
- `bun test src/server/providers/providerAuthService.test.ts`
- Extend `src/server/providers/providerRuntimeDetector.test.ts`, `src/server/providers/providerRuntimeDiscovery.test.ts`, and `src/server/providers/providerRuntimeState.test.ts` coverage for packaged-mode unreachable local-runtime guidance and no host provider-runtime env leakage, then run `bun test src/server/providers/providerRuntimeDetector.test.ts src/server/providers/providerRuntimeDiscovery.test.ts src/server/providers/providerRuntimeState.test.ts`.
- Add `src/server/services/providerSecretStore.test.ts` coverage for missing, slow, Windows-unsupported, and env-backed secret behavior, then run `bun test src/server/services/providerSecretStore.test.ts`.
- Extend `src/server/providers/adapters/directAdapters.test.ts` coverage for Codex adapter unsupported-state behavior when runtime status reports missing `codex`, then run `bun test src/server/providers/adapters/directAdapters.test.ts`.
- Extend `src/server/providers/providerInvocationService.test.ts` coverage for Codex invocation missing-runtime failures that do not affect non-Codex invocation paths, then run `bun test src/server/providers/providerInvocationService.test.ts`.
- Extend `src/server/providers/transports/codexAppTransport.test.ts` coverage for missing-`codex` runtime status guidance, then run `bun test src/server/providers/transports/codexAppTransport.test.ts`.
- `bun test src/app/routes/+admin/+models/providerUiState.test.ts`
- `bun test src/app/routes/+providers/providerCatalogUi.test.ts`
- Add `src/app/routes/+projects/-+create.vitest.tsx` and `src/app/routes/+admin/+datasources/-+covidence-import.vitest.tsx` coverage and extend `src/app/routes/+projects/+$id/-+edit.vitest.tsx` for no-model packaged guidance, disabled/default-model behavior, and SGLang missing-runtime notices; then run `bunx vitest run src/app/routes/+projects/-+create.vitest.tsx src/app/routes/+projects/+$id/-+edit.vitest.tsx src/app/routes/+admin/+datasources/-+covidence-import.vitest.tsx`.
- `bun test src/server/cron/judgmentsJobs/judgmentJobSqliteService.test.ts`
- `bun test src/server/routes/JudgmentsJobsRoutes.test.ts`
- Extend `src/services/olap/duckdbRunnerAppDatabase.test.ts` coverage for equivalent default DB paths staying on the app database service without resolving the DuckDB CLI, including Windows path case behavior, then run `bun test src/services/olap/duckdbRunnerAppDatabase.test.ts`.
- Extend `src/services/olap/duckdbRunner.test.ts` coverage for missing DuckDB CLI behavior on non-default DB paths, then run `bun test src/services/olap/duckdbRunner.test.ts`.
- Extend `src/server/utils/duckdbBinary.test.ts` coverage for missing DuckDB CLI resolution and Windows executable suffix/`PATHEXT` behavior, then run `bun test src/server/utils/duckdbBinary.test.ts`.
- `bun test src/server/utils/duckdbOwnerLease.test.ts`
- `bun test src/server/utils/judgeWorkerJournalIdentity.test.ts`
- Add `src/server/utils/localMachineIdentity.test.ts` coverage for missing and slow identity-helper binaries, then run `bun test src/server/utils/localMachineIdentity.test.ts`.
- Add `src/server/cron/nvidiaSmi.test.ts` coverage for missing `ssh`/`nvidia-smi` telemetry behavior, then run `bun test src/server/cron/nvidiaSmi.test.ts`.
- Browser verify: Providers, Add Provider, Codex provider detail, Settings, Project Create, Project Edit, and Covidence Import show missing-Codex or missing-local-runtime guidance without browser-dev-only instructions and without enabled login/start/default-model actions that would spawn or seed unavailable tooling.
- Packaged app verify: startup, API, import, CSV export/download, secretless/manual non-Codex provider setup, quit, and relaunch all work with no host Bun/Node/npm/bunx, `codex`, DuckDB CLI, `sqlite3`, `ssh`, or `nvidia-smi` exposure.
- Packaged app verify: API-key provider setup either succeeds through the supported packaged secret-store backend or shows explicit unsupported secret-storage guidance before attempting to spawn an unavailable helper.
- Packaged app verify: opening Providers, Add Provider, Codex provider detail, Settings, Project Create, Project Edit, and Covidence Import with no `codex` and no local SGLang runtime installed shows in-app guidance, no browser-dev-only instruction, and no enabled login/start/default-model action that would spawn a missing binary or seed an unreachable localhost model.

### 6. macOS Smoke Run

Goal: validate the chosen source-first shape under clean-machine assumptions.

Build Commands:

- Run from the repo on a build machine with Bun available.
- `bun run desktop:build` (currently invokes `bun run build` before `electrobun build`)

Artifact Run Preconditions:

- Run the artifact outside the repo checkout.
- For at least one run, place the artifact under a parent path containing spaces.
- Do not set `FORSKA_DESKTOP_BUN_BIN`.
- Use a clean-machine shell or profile for the artifact run where host `bun`, `node`, `npm`, `bunx`, DuckDB CLI, `codex`, `sqlite3`, `ssh`, and `nvidia-smi` are absent from `PATH`, or explicitly record why each host tool cannot be hidden.

Manual Checks:

- Open the unsigned artifact.
- Confirm startup diagnostics show the packaged backend runner/Bun path, not a host `bun` path.
- Confirm artifact-relative backend paths work when the artifact parent path contains spaces.
- Confirm the backend stack reaches `/api/runtime/ready` and logs API, maintenance-worker, and judge-worker role readiness.
- Import one local file-backed dataset through the packaged UI/API path, using a flow that exercises multipart upload and runtime asset storage; record the upload size and whether the request used direct loopback fetch, streamed bridge forwarding, or a documented bounded bridge limit.
- Run one CSV export/download from the packaged UI/API path; record the response size, `Content-Disposition` filename behavior, and whether the response used direct loopback, streamed bridge forwarding, or a documented bounded bridge limit.
- Configure one secretless/manual non-Codex provider record that does not require a host CLI.
- If a reachable secretless/manual non-Codex provider endpoint is available, run one tiny judgment through the packaged judge-worker and record whether any host tool was touched; if unavailable, record judging invocation as unexercised rather than passed.
- If an API-key provider is tested, record the packaged secret-store backend used and any macOS `/usr/bin/security` helper exposure.
- Quit and relaunch.
- Confirm writes, runtime temp files, and any diagnostic snapshot files generated during the run land under the per-user desktop data root, not the repo root or install directory.
- If the packaged backend runner is a separate copied Bun binary, confirm deleting or misplacing it in a throwaway artifact copy produces an actionable startup error rather than falling back to host Bun; if the runner is ElectroBun's `process.execPath`, record that this destructive check is not applicable and verify no packaged setting can redirect to host Bun.

Quality Gates:

- All commands complete successfully.
- All manual checks pass outside the repo checkout with no host `bun`, `node`, `npm`, `bunx`, DuckDB CLI, `codex`, `sqlite3`, `ssh`, or `nvidia-smi` exposure unless the exposure is explicitly recorded; any provider secret-store helper exposure is recorded separately.
- Smoke result, command output summary, artifact path, artifact parent path space-check result, data root, runtime temp path, log path, export/download result, provider secret-store backend if tested, judging invocation result, and any host-tool exposure are recorded in `APP_PLAN_IMPLEMENTED.md` if it passes, or in this file under the relevant blocker if it fails.

### 7. Native Windows Smoke Run

Goal: run the same source-first artifact assumptions on native Windows before making the continue-or-fallback call.

Build Commands:

- Run on native Windows or a native Windows CI runner with Bun available.
- `bun run desktop:build` (currently invokes `bun run build` before `electrobun build`)

Artifact Run Preconditions:

- macOS source-first artifact passes the full smoke run.
- Run the built artifact on native Windows outside the repo checkout, including at least one run from an artifact parent path containing spaces, with no `FORSKA_DESKTOP_BUN_BIN` and no host `bun`, `node`, `npm`, `bunx`, DuckDB CLI, `codex`, `sqlite3`, `ssh`, or `nvidia-smi` on `PATH`, or explicitly record any unavoidable host-tool exposure.

Manual Checks:

- Launch, quit, relaunch.
- API connectivity.
- API, maintenance-worker, and judge-worker role readiness.
- Import one local file-backed dataset through the packaged UI/API path, using a flow that exercises multipart upload and runtime asset storage; record the upload size and whether the request used direct loopback fetch, streamed bridge forwarding, or a documented bounded bridge limit.
- Run one CSV export/download from the packaged UI/API path; record the response size, `Content-Disposition` filename behavior, and whether the response used direct loopback, streamed bridge forwarding, or a documented bounded bridge limit.
- Configure one secretless/manual non-Codex provider record that does not require a host CLI.
- If a reachable secretless/manual non-Codex provider endpoint is available, run one tiny judgment through the packaged judge-worker and record whether any host tool was touched; if unavailable, record judging invocation as unexercised rather than passed.
- If an API-key provider is tested, verify it does not depend on macOS-only keychain behavior and record the packaged Windows secret-store backend used.
- Data root, runtime temp path, any generated diagnostic snapshot path, and log path.
- Spaces in user profile paths and artifact/install paths.
- No host Bun/Node/npm/bunx, DuckDB CLI, `sqlite3`, `codex`, `ssh`, or `nvidia-smi` required for core flows.
- Startup diagnostics show the packaged backend runner/Bun path, not a host `bun` path.

Quality Gates:

- All commands complete successfully on native Windows.
- All manual checks pass outside the repo checkout with no host `bun`, `node`, `npm`, `bunx`, DuckDB CLI, `codex`, `sqlite3`, `ssh`, or `nvidia-smi` exposure unless the exposure is explicitly recorded; any provider secret-store helper exposure is recorded separately.
- Smoke result, command output summary, artifact path, artifact parent path space-check result, data root, runtime temp path, log path, export/download result, provider secret-store backend if tested, judging invocation result, Windows version, and any host-tool exposure are recorded in `APP_PLAN_IMPLEMENTED.md` if it passes, or in this file under the relevant blocker if it fails.

## Continue Or Fallback Decision

- Continue on ElectroBun only if the source-first artifact works on macOS, passes at least one native Windows core smoke run, and does not depend on host Bun/Node/npm/bunx or other unbundled CLIs for startup, API, import, CSV export/download, judging, or secretless/manual provider setup.
- Treat any unresolved API-key provider secret-storage gap as an explicit continue/fallback decision input rather than a hidden pass.
- Escalate to Electron if either platform still exposes shell-blocking issues in artifact reliability, packaged Bun resolution, native dependency loading, or core smoke validation after this phase.
