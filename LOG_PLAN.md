# LOG_PLAN

Goal: move repeating runtime noise out of the terminal and into structured log files, while keeping the console useful for startup, failures, interactive scripts, and desktop startup diagnostics.

Layers: server, desktop backend, client, scripts.

## Standard

- Use OpenTelemetry-aligned NDJSON/JSONL, not ad-hoc text or logfmt.
- Write one event per line to `logs/runtime/<profile>/<service>-YYYY-MM-DD.jsonl`.
- Resolve `<profile>` from the repo runtime-profile model. Use `primary` or `secondary` when launched through `scripts/runWithRuntimeProfile.ts`; otherwise use `local`.
- Resolve the default `logs/` root from `src/server/utils/runtimeWritablePath.ts` so repo runs write under the repo and desktop runs write under the desktop data root.
- Use UTC calendar dates in filenames so rotation matches the event timestamps.
- V1 severity mapping: `console.log` and `rateLimitedLogger.log` map to `INFO`, `warn` maps to `WARN`, and `error` maps to `ERROR`. Add `DEBUG` only if a caller truly needs it.
- Structured runtime file logging is enabled by default in dedicated long-lived runtime bootstrap entrypoints. Shared modules must not auto-enable file logging just because they were imported.
- Interactive CLI and JSON-contract scripts stay terminal-only because they never install the runtime file sink.
- Tests or one-off harnesses that spawn sink-owning entrypoints such as `src/server/index.ts` or `src/appServer.ts` should default `LOG_DIR` to a temp location so parallel runs do not share append or pruning state. Only use the default profile directory when a test is explicitly covering shared runtime log behavior.
- Sink-owning entrypoints must bootstrap before importing runtime modules that read process identity or install routing. `src/server/index.ts` and `src/appServer.ts` must either be those thin bootstrap wrappers themselves or delegate immediately to dedicated bootstrap modules.
- Service naming is decided once at process bootstrap and stays stable for the life of that process. Use `app-server` for `src/appServer.ts`, `api-server` for API-only backend processes whether they were launched through the split stack or directly with `SERVER_ROLE=api`, `worker-server` for worker-owned backend processes whether they were launched through the split stack or directly with `SERVER_ROLE=worker` or `SERVER_ROLE=writer`, `dev-single-server` for the desktop-backed backend, and `single-server` only for combined one-process `src/server/index.ts` runs such as `start:server:single`, `dev:server:single`, and raw `SERVER_ROLE=auto` launches.
- `single-server` is reserved for combined one-process backend runs. Direct `SERVER_ROLE=api` runs use `api-server`, direct `SERVER_ROLE=worker` or `SERVER_ROLE=writer` runs use `worker-server`, and `single-server` records still include `serverRole` on every line so an `auto` process can promote or demote while keeping one stable service file.
- Shared modules, including current code under `src/agent`, inherit logging behavior from the hosting process. They never decide sink installation on import.
- Do not route logs to file or terminal based on source file path, folder, or module name. The active process bootstrap and per-event sink decision decide routing.
- If a touched `file-only` call site runs in a process that did not install the runtime file sink, preserve the current terminal behavior instead of silently dropping the event.
- Sink: routine server `DEBUG` and `INFO` events are `file-only`.
- Sink: server `WARN` and `ERROR` events are `both`.
- Sink routing is decided first per event: `file-only`, `both`, `terminal-only`, or `remove-or-dev-only`.
- Until a call site is explicitly migrated, preserve its current terminal behavior. Installing the runtime sink must not silently reinterpret untouched `console.*` calls as `file-only`; only touched call sites opt into `file-only`, `both`, `terminal-only`, or removal/dev-gating during the rollout.
- `LOG_LEVEL` gates file writes after sink routing. Default `LOG_LEVEL=INFO`.
- `LOG_STDERR_LEVEL` gates terminal duplication after sink routing. Default `LOG_STDERR_LEVEL=WARN`.
- `terminal-only` bypasses file filtering entirely. `file-only` never writes to stderr. `both` writes to file if the event passes `LOG_LEVEL` and writes to stderr if it passes `LOG_STDERR_LEVEL`.
- Startup, shutdown, and operator-guidance events are an explicit exception to `LOG_STDERR_LEVEL`. They must always stay terminal-visible even when they are `INFO`.
- For terminal-visible startup, shutdown, and operator-guidance events, keep warnings and errors on stderr. Non-error status lines may stay on stdout.
- Error visibility rule: unexpected failures, caught exceptions, startup failures, and recovery failures must always reach the terminal on stderr. File logging may duplicate them, but must never be the only sink.
- Error propagation rule: logging an error does not count as handling it. After emitting the structured error record, preserve the existing failure path by rethrowing, returning the error result, or letting the process-level handler print to stderr.
- Any process that installs the file sink must also expose one shared bounded `flushRuntimeLogs` path and call it before controlled `process.exit(...)` paths, signal-driven shutdown exits, and other planned teardown that already owns the exit flow. Keep the flush best-effort and time-bounded so shutdown still completes if the filesystem stalls.
- Fatal or duplicate-process exits may attempt the same bounded flush after writing the terminal-visible error, but terminal visibility wins over file durability. File logging supplements the existing failure path; it must not delay or replace it.
- Retention: automatically prune managed runtime JSONL files whose UTC filename date is more than 7 days old. Run pruning at sink bootstrap and again after UTC date rollover. Keep pruning best-effort and time-bounded, and ignore files that do not match the managed runtime log filename patterns.
- Sink: startup and shutdown one-liners are `both`.
- Sink: interactive CLI stdout and stderr are `terminal-only`.
- Sink: browser debug logs and temporary inspection logs are `remove-or-dev-only`.
- Prefer extending `src/server/utils/rateLimitedLogger.ts` with a file sink over adding a legacy logging framework.
- Preserve Bun crash-safe argument serialization. Reuse the safe serializer already installed in `src/server/utils/installSafeConsoleLogging.ts` or extract a shared helper; do not introduce a second object-printing path.

## Log Files

- Start with one file per runtime service per day, not one file per feature.
- V1 partitioning is by `runtimeProfile + service + UTC date`, not by individual process.
- If multiple instances of the same service run in one profile on the same day, they append to the same service file and are distinguished by per-record instance fields.
- If shared daily files are not safe on the current platform/runtime, fall back to `logs/runtime/<profile>/<service>-<instanceKey>-YYYY-MM-DD.jsonl`, where `instanceKey` is a filename-safe encoding of `hostname`, `listenPort`, `pid`, and `processStartedAt`.
- Shared daily service files are only allowed when each record is serialized once and appended as one newline-terminated buffer with append-mode file semantics. Do not split a single record across multiple writes.
- Keep a per-process write queue so one process never interleaves its own records. If the target path cannot preserve whole-record appends safely for shared files, fall back to per-instance filenames rather than risk corrupt JSONL.
- Decide shared-file vs per-instance-file mode once at bootstrap from a tested platform allowlist. Do not try to infer append safety after corruption has already happened.
- On the first write whose event timestamp lands on a new UTC date, rotate by closing or releasing the previous day's handle after queued writes for that file drain and append subsequent records to the new day's file. Do not require a restart or a background timer for midnight rollover.
- During bootstrap and after rollover, prune managed runtime log files older than 7 UTC days in the active profile directory.
- Recommended file: `logs/runtime/<profile>/app-server-YYYY-MM-DD.jsonl`.
- Recommended file: `logs/runtime/<profile>/api-server-YYYY-MM-DD.jsonl` for API-only backend processes, including direct `SERVER_ROLE=api` runs.
- Recommended file: `logs/runtime/<profile>/worker-server-YYYY-MM-DD.jsonl` for worker-owned backend processes, including direct `SERVER_ROLE=worker` or `SERVER_ROLE=writer` runs.
- Recommended file: `logs/runtime/<profile>/dev-single-server-YYYY-MM-DD.jsonl` when the combined role is used.
- Recommended file: `logs/runtime/<profile>/single-server-YYYY-MM-DD.jsonl` for direct combined `src/server/index.ts` runs such as `SERVER_ROLE=auto`, `start:server:single`, and `dev:server:single`.
- This is more granular than just app vs api, because this repo already has a distinct worker runtime and that is where most repeating logs live.
- Do not split by subsystem in v1. Put `component`, `event`, `jobId`, `projectId`, and `articleId` in each record instead.
- Split further only after observing real volume or retention pressure. The first candidate would be a dedicated worker LLM file, not per-route or per-module files.

## Instance Identity

- Every server-side record must include `runtimeProfile`, `instanceId`, `hostname`, `pid`, `processStartedAt`, `service`, and `listenPort`.
- Records from API, worker, `dev-single`, and direct `single-server` runtimes must also include `serverRole`.
- Records from the app static server omit `serverRole` but still include `listenPort`.
- `instanceId` format: `<service>:<hostname>:<listenPort>:<pid>:<processStartedAt>`.
- Reuse the existing identity pieces already tracked in `src/server/utils/writerConnections.ts` where possible: `hostname`, `pid`, `serverRole`, and the listening port. The current `writerConnections` implementation calls that field `apiServerPort`; treat that as an internal legacy name, not the public log schema.
- Capture `processStartedAt` once in one shared runtime-process-identity helper during bootstrap and reuse that exact value for every record from that process.
- Add dedicated bootstrap modules for long-lived runtimes so the shared runtime identity is created before importing modules that read it. `src/server/index.ts` and `src/appServer.ts` must become thin bootstrap wrappers, or every supported long-lived launcher must be repointed to the new bootstrap entrypoints.
- `writerConnections` must read that same shared identity helper instead of minting its own `startedAt` value during import. The runtime logger and writer heartbeat/proxy metadata must describe the same process identity.
- Do not rely on filename alone to identify a process. Instance identity must be present in every line so shared service files remain attributable.

Example bootstrap invariant:

- Good: a dedicated bootstrap entrypoint such as `src/server/bootstrapServer.ts` initializes one shared runtime identity with `processStartedAt=2026-04-12T10:10:00.000Z`, then imports the server wiring, and both the runtime logger and `writerConnections` read that same value.
- Bad: `src/server/index.ts` imports `writerConnectionsRoutes`, which imports `writerConnections` and stores `startedAt=2026-04-12T10:10:00.000Z`, then the runtime logger boots later and stores `processStartedAt=2026-04-12T10:10:01.200Z`. The same process now emits two different identities.

Example line:

```json
{
  "timestamp": "2026-04-12T10:15:30.123Z",
  "severity": "INFO",
  "runtimeProfile": "primary",
  "service": "worker-server",
  "instanceId": "worker-server:my-host:3002:48192:2026-04-12T10:10:00.000Z",
  "hostname": "my-host",
  "pid": 48192,
  "processStartedAt": "2026-04-12T10:10:00.000Z",
  "listenPort": 3002,
  "event": "llm.batch.complete",
  "message": "LLM batch complete",
  "serverRole": "worker",
  "jobId": "...",
  "projectId": "...",
  "articleId": null,
  "durationMs": 842,
  "attrs": {"claimedPrompts": 24, "fulfilled": 23, "requeuedCount": 1}
}
```

## Why This Is The Right Approach

- OTel-aligned JSONL is modern, machine-readable, and easy to ingest later into Loki, ClickHouse, or an OpenTelemetry pipeline.
- It preserves useful context like `jobId`, `projectId`, `articleId`, and durations without flooding the terminal.
- It keeps same-service concurrent runs attributable without exploding the number of log files.
- It fits the repo as-is: `logs/` is already ignored, and `rateLimitedLogger` already exists in the noisy server paths.
- It matches the runtime shape of this repo better than a flat app/api split because `app-server`, `api`, and `worker` have different noise levels and operator use.
- It uses `Effect` only where it adds value: resource lifetime, retries, and shutdown-safe flushing.
- It avoids the wrong move of silently shipping browser console chatter into server log files.

## Effect Guidance

- Use `Effect` inside the logger implementation, not as a second public logging API.
- Good `Effect` use in this change: `Effect.acquireRelease` for opening and closing file handles.
- Good `Effect` use in this change: `Scope` for logger lifetime tied to server startup and shutdown.
- Good `Effect` use in this change: `Layer` and `Context` if a shared server logger service is introduced.
- Good `Effect` use in this change: `Schedule` for retrying transient filesystem flush failures.
- Good `Effect` use in this change: `Effect.gen` for the non-trivial async sink flow when batching or rotating files.
- Keep the call sites simple. A plain `logEvent(...)` or extended `rateLimitedLogger` API is better than rewriting route handlers around `Effect` in v1.
- Do not adopt `Effect.log*` across the app right now. That would create two logging styles in one codebase.
- Do not use `Effect` for browser console cleanup. Client-side debug logs should mostly be removed or gated, not routed into the server logging pipeline.

## Desktop

- The desktop backend is a normal server runtime with `SERVER_ROLE=dev-single`, so it writes structured JSONL too.
- Resolve desktop runtime logs from the desktop writable root, which means the backend writes under the desktop data directory instead of the repo `logs/` folder.
- Keep `src/desktop/index.ts` mirroring backend stdout and stderr into `backend.log`, but treat that file as launcher capture only for startup and fatal diagnostics. It is not the durable runtime telemetry store.
- As routine server INFO noise moves to JSONL, `backend.log` should naturally shrink to startup lines, warnings, and real errors.
- Apply the same 7-day runtime JSONL retention under the desktop data root. `backend.log` remains launcher capture and is outside the runtime JSONL retention rule.
- Preserve existing stdout vs stderr meaning for startup and operator guidance so desktop launcher capture stays useful and does not reclassify non-error startup lines as stderr noise.
- Do not forward browser or renderer console chatter into desktop backend JSONL.

## Config Placement

- Do not read raw `process.env.LOG_*` at call sites.
- Parse log config once in a shared helper or in the existing runtime config loaders.
- API, worker, and `dev-single` server processes should read log config through `src/server/utils/env.ts`.
- The app static server should read the same log config through `src/server/utils/getAppServerRuntimeConfig.ts` or a shared helper it calls.
- Add an explicit runtime-profile marker, for example `FORSKA_RUNTIME_PROFILE`, from `scripts/runWithRuntimeProfile.ts` so file paths resolve predictably to `primary`, `secondary`, or `local`.
- Default `LOG_DIR` from the runtime writable root plus `logs/runtime/<profile>/`, not from raw `process.cwd()`.
- Bootstrap the runtime file sink and shared runtime identity by default in dedicated long-lived runtime bootstrap entrypoints. `src/server/index.ts` and `src/appServer.ts` must either be those thin bootstrap wrappers or delegate to them before importing the existing runtime wiring, so raw direct launches still bootstrap first.
- Interactive and JSON-contract scripts should keep the bootstrap off.
- Because sink installation lives in those entrypoints, every supported sink-owning launcher must use them: `package.json` scripts, `scripts/runWithRuntimeProfile.ts`, split-stack launchers, desktop startup, cluster dev helpers, and spawn-based test helpers.
- Tests or harnesses that spawn sink-owning entrypoints should set `LOG_DIR` to a temp directory by default. Only shared-log-path tests should intentionally reuse `logs/runtime/<profile>/...`.
- For direct local one-process backend runs such as `start:server:single`, `dev:server:single`, or raw `bun run src/server/index.ts`, choose `service=single-server` only for combined `SERVER_ROLE=auto` runs. Direct `SERVER_ROLE=api` runs use `api-server`; direct `SERVER_ROLE=worker` or `SERVER_ROLE=writer` runs use `worker-server`. Keep the file name stable for `single-server` even if `SERVER_ROLE=auto` later changes effective role; the per-record `serverRole` field captures the live role.
- If code currently under `src/agent` is moved under a server-only runtime area, that narrows the chance of accidental non-server file logging. The sink installation rule still stays process-based, not path-based.
- Moving code from `src/agent` into an API-only area is a code-ownership and runtime-scope improvement, not the mechanism that turns file logging on. File logging still requires explicit bootstrap in the running process.
- Because scripts import shared server modules at top level, execution context and shared runtime identity must be decided in the bootstrap entrypoint before importing modules that may read them, not by mutating env after imports have already run.
- Add one shared helper that derives per-process instance identity for log records, reusing existing writer-connection identity fields where possible.

## File-Only

- `file-only` is a sink decision made by the hosting process, not by module path. Shared modules may emit `file-only` events only through the runtime logger, and those events fall back to current terminal behavior when no sink is installed.

- Job scheduler and worker loop progress.
  Sink: `file-only` for routine progress and summary events. Any warning or error from these paths is `both`.
  Files: `src/server/cron/judgmentsJobs/judgmentsJobsAddToQueue.ts`, `src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM.ts`, `src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM/processPromptWithLLM.ts`, `src/server/cron/judgmentsJobs/judgmentsJobsCronGetPrompts.ts`, `src/services/olap/duckdbOlap.ts`.
  Messages: `[addToQueue] Filtered out ...`, `[addToQueue] Prioritized ...`, `[llm] Batch complete`, `[capacity:*] ...`, `[getPrompts] raw fallback ...`.

- Full-text fetch and conversion progress.
  Sink: `file-only` for routine progress and summary events. Any warning or error from these paths is `both`.
  Files: `src/server/cron/fullTextJobs.ts`, `src/server/cron/fullTextConversionJobs.ts`, `src/server/utils/ensureFullText.ts`, `src/server/utils/convertPdfToText.ts`.
  Messages: `Found ... running jobs`, `Project ... need ...`, `Fallback: fetching ...`, `Converting article ...`, `Success`, `Retry`, `Failed`, `No model configured`, `No articles to convert`.

- Repeating request and stream progress.
  Sink: `file-only` for request-start, request-summary, export progress, streamed-count, and applied-filter summaries. Any warning or error from these paths is `both`.
  Files: `src/server/routes/ProjectExportRoutes.ts`, `src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviews.ts`, `src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsCount.ts`, `src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsFilters.ts`, `src/server/routes/ProjectsAddArticlesRoutes.ts`.
  Messages: request-start, request-summary, export progress, streamed-count, applied-filter summaries.

- Background heartbeat and config logs.
  Sink: `file-only` for steady-state heartbeat and config lines. Any warning or error from these paths is `both`.
  Files: `src/server/utils/projectMartRefreshWorkerHeartbeat.ts`, `src/server/utils/projectMartLargeRebuildHeartbeat.ts`.
  Messages: `background loop starting`, `background loop config ...`.

- Existing `console.time` and `console.timeEnd` output in hot paths.
  Sink: replace with `file-only` structured events carrying `durationMs`. Timing-related failures stay `both`.
  Files: `src/server/cron/fullTextJobs.ts`, `src/server/cron/fullTextConversionJobs.ts`.
  Replace with structured `durationMs` fields in JSONL events.

## Both

- Startup, shutdown, and operator guidance.
  Sink: `both`.
  Files: `src/server/index.ts`, `src/appServer.ts`, `src/server/utils/getCodexAppServerClient.ts`.
  Messages: service start, port binding, role summary, Codex readiness and login guidance.

- Operator-visible failures and recovery warnings.
  Sink: `both`.
  Files: `src/server/utils/routeErrorHandler.ts`, `src/server/utils/duckdbService.ts`, `src/server/utils/duckdbOwnerLease.ts`, `src/server/routes/ModelsRoutes.ts`.
  Messages: route failures, DuckDB restart or shutdown failures, malformed lease files, provider model load failures.

- Failure paths inside areas that otherwise become `file-only`.
  Sink: `both`.
  Rule: success chatter moves to JSONL-only, but warnings, errors, thrown failures, and returned error results stay terminal-visible and also land in JSONL.

## Terminal-Only

- Interactive CLI and JSON-contract scripts.
  Sink: `terminal-only`.
  Files: `scripts/startServerStack.ts`, `scripts/devServerWatch.ts`, `scripts/alvisLaunch.ts`, `scripts/mn5Launch.ts`, `scripts/recoverProjectMartRefreshClaims.ts`, `scripts/runProjectMartLargeRebuildCycle.ts`, `scripts/runProjectMartRefreshWorkerOnce.ts`, `scripts/runJudgmentJobRepair.ts`, `scripts/dbQuerySnapshot.ts`.
  Reason: these are interactive CLI tools or JSON-emitting scripts already consumed by people, tests, or wrapper scripts.
- Implementation rule: these entrypoints must not install the runtime file sink, and importing shared server modules from them must not silently start JSONL file logging.

## Remove Or Dev-Gate

- Browser debug dumps and success chatter.
  Sink: `remove-or-dev-only`.
  Files: `src/app/routes/+projects/+$id/+humanAssessment.tsx`, `src/app/routes/+admin/+failed_requests/+$id/+index.tsx`, `src/app/utils/client-env.ts`, `src/components/main/ProjectsGrid.tsx`, `src/app/routes/+projects/+$id/+reviews-llm/+$articleId/+index.tsx`, `src/app/routes/+projects/+$id/+reviews-llm/+$articleId/+fulltext.tsx`.
  Reason: these are browser debug dumps or success chatter, not durable runtime telemetry.

- Temporary server inspection logs.
  Sink: `remove-or-dev-only`.
  Files: `src/server/routes/HumanAssessmentRoutes/humanAssessmentRoutesPostInit.ts`.
  Reason: temporary server inspection logs should not become part of the structured runtime stream.

## Checklist

- [ ] Add a shared file-backed structured logger for server runtimes and background workers.
- [ ] Partition log files by runtime process: `app-server`, `api-server`, `worker-server`, `dev-single-server`, and `single-server` only for combined one-process backend runs.
- [ ] Add an explicit runtime-profile marker, for example `FORSKA_RUNTIME_PROFILE`, so `logs/runtime/<profile>/...` resolves stably for `primary`, `secondary`, and `local` runs.
- [ ] Add one shared runtime-process-identity helper, capture `processStartedAt` in a bootstrap module before importing modules that read it, and emit `runtimeProfile`, `instanceId`, `hostname`, `pid`, `processStartedAt`, `listenPort`, and service fields on every server-side log line.
- [ ] Make `writerConnections` and runtime logging share that same identity helper instead of minting timestamps at import time so one process cannot emit different `startedAt` values in heartbeat metadata and JSONL.
- [ ] Add runtime config for `LOG_DIR`, `LOG_LEVEL`, and `LOG_STDERR_LEVEL`; default to runtime-writable-root + `logs/runtime/<profile>/`, default `LOG_LEVEL=INFO`, default `LOG_STDERR_LEVEL=WARN`, and load it through `src/server/utils/env.ts` plus `src/server/utils/getAppServerRuntimeConfig.ts` or one shared helper.
- [ ] Make the shared daily-file append path explicit: serialize one complete JSONL line per write, queue writes per process, choose shared-file vs per-instance-file mode from a tested platform allowlist at bootstrap, rotate on UTC date boundaries without restart, and use a filename-safe per-instance suffix when shared append mode is disabled.
- [ ] Repoint every supported sink-owning launcher to the bootstrap-first path, or make `src/server/index.ts` and `src/appServer.ts` themselves be thin bootstrap wrappers so raw direct launches cannot bypass identity and sink setup.
- [ ] Extend `rateLimitedLogger` so noisy paths can keep rate limiting while writing structured JSONL.
- [ ] Reuse or extract the safe console serializer so file logging does not reintroduce Bun pretty-print crashes.
- [ ] Use `Effect` inside the sink for file-handle lifecycle, flush, rollover, and shutdown behavior, without forcing `Effect` at every call site.
- [ ] Install the runtime file sink by default in dedicated long-lived runtime bootstrap entrypoints, including the legacy direct backend modes, and keep interactive or JSON-contract scripts terminal-only because they never install the sink.
- [ ] Default spawned tests and harnesses that use sink-owning entrypoints to temp `LOG_DIR` locations unless the test is explicitly validating shared profile log paths.
- [ ] Add one bounded flush helper and call it before controlled exits in sink-owning runtimes.
- [ ] Prune managed runtime JSONL files older than 7 UTC days during sink startup and after UTC date rollover.
- [ ] Keep sink installation process-based, not path-based: moving modules such as current `src/agent` code must not by itself change whether logs write to JSONL.
- [ ] Migrate the hottest repeating server paths first: judgments jobs, full-text pipeline, export streaming, request summaries.
- [ ] Keep untouched `console.*` call sites on their current terminal behavior until each one is explicitly migrated.
- [ ] For touched `file-only` call sites in shared modules, preserve current terminal behavior when the hosting process did not install the runtime file sink.
- [ ] Preserve terminal-visible failure paths while migrating progress logs to JSONL.
- [ ] Preserve existing exception and error-result propagation after adding file logging.
- [ ] Replace `console.time` and `console.timeEnd` with explicit duration fields.
- [ ] Keep the desktop backend on the same structured logging model, with runtime JSONL under the desktop data root and `backend.log` retained only as terminal capture.
- [ ] Remove or dev-gate client-side debug logs and temporary server inspection logs instead of forwarding them to server log files.
- [ ] Leave interactive and JSON-contract scripts on stdout or stderr.
- [ ] Keep the sink decision explicit for every touched log call: `file-only`, `both`, `terminal-only`, or `remove-or-dev-only`.
- [ ] Add or update tests for JSONL writing, concurrent append safety, shared-file allowlist selection, rate limiting, path selection, runtime-profile propagation, desktop path resolution, env parsing, and 7-day retention pruning.
- [ ] Add or update tests for canonical `api-server` and `worker-server` service selection on direct runs, `single-server` selection for combined `SERVER_ROLE=auto` runs, UTC date rollover, bounded flush-before-exit behavior, bootstrap-before-import process identity capture, and shared identity between runtime logging and `writerConnections`.
- [ ] Verify that terminal output drops to startup, warnings, and real errors only for the explicitly migrated hot paths; untouched legacy call sites may remain terminal-visible until they are converted.

## Quality Gates

- `bun run lint`
- `bun test src/server/utils/runtimeLogger.test.ts`
- `bun test src/server/utils/env.test.ts`
- `bun test src/server/utils/getAppServerRuntimeConfig.test.ts`
- `bun test src/server/utils/runtimeWritablePath.test.ts`
- `bun test src/server/utils/writerConnections.test.ts`
- `bun test src/server/cron/judgmentsJobs/judgmentsJobsAddToQueue.test.ts`
- `bun test src/server/utils/projectMartLargeRebuildHeartbeat.test.ts`
- `bun test src/desktop/getDesktopRuntimeConfig.test.ts`
- `bun test scripts/runWithRuntimeProfile.test.ts`
- `bun run build`
- `bun run desktop:build`
- Manual check: run `bun run dev:server`, hit a reviews flow and an export flow, confirm the migrated routine progress logs are `file-only` and `logs/runtime/primary/*.jsonl` gains structured entries.
- Manual check: trigger one failing request or background-job error path and confirm the error is `both`: visible in terminal stderr and present in the matching JSONL file.
- Manual check: if multiple same-service processes are started intentionally in one profile and shared-file append mode is enabled on the current platform, confirm their shared daily file contains distinct `instanceId` values for each process and still parses as one valid JSON object per line. If per-instance fallback mode is enabled instead, confirm separate instance-suffixed files are created.
- Manual check: if runtime-profile launchers are touched, run one `primary` or `secondary` flow via `scripts/runWithRuntimeProfile.ts` and confirm logs land under the matching profile directory.
- Manual check: run `bun run dev:server:single` or `bun run start:server:single`, confirm logs land under `logs/runtime/local/single-server-*.jsonl`, confirm a direct `SERVER_ROLE=auto` run keeps one `single-server` file even if the per-record `serverRole` changes, and confirm direct `SERVER_ROLE=api`, `SERVER_ROLE=worker`, and `SERVER_ROLE=writer` runs land under `api-server` or `worker-server` rather than `single-server`.
- Manual check: launch the desktop backend flow, confirm runtime JSONL lands under the desktop data root, and confirm `backend.log` contains only the reduced terminal stream rather than routine progress noise.
- Manual check: seed one managed runtime log file whose UTC filename date is older than 7 days, start a sink-owning runtime, and confirm that old file is pruned while newer files remain.

## Commands Run

- `rg -n --glob '!**/*.test.*' "console\.(log|warn|error|info|debug)\s*\(" src/server src/db`
- `rg -n --glob '!**/*.test.*' "console\.(log|warn|error|info|debug)\s*\(" src/app src/components src/services`
- `rg -n --glob '!**/*.test.*' "console\.(log|warn|error|info|debug)\s*\(" src/agent scripts`
- `rg -n "console\.time(End)?\s*\(" src/server`
- `rg -n "runtimeProfile|mergeRuntimeProfileEnv|getAppServerRuntimeConfig|loadEnv" src scripts`
