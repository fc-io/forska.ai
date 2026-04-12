# LOG_PLAN

Goal: move repeating runtime noise out of the terminal and into structured log files, while keeping the console useful for startup, failures, and interactive scripts.

Layers: server, client, scripts.

## Standard

- Use OpenTelemetry-aligned NDJSON/JSONL, not ad-hoc text or logfmt.
- Write one event per line to `logs/runtime/<profile>/<service>-YYYY-MM-DD.jsonl`.
- Resolve `<profile>` from the repo runtime-profile model. Use `primary` or `secondary` when launched through `scripts/runWithRuntimeProfile.ts`; otherwise use `local`.
- Use UTC calendar dates in filenames so rotation matches the event timestamps.
- V1 severity mapping: `console.log` and `rateLimitedLogger.log` map to `INFO`, `warn` maps to `WARN`, and `error` maps to `ERROR`. Add `DEBUG` only if a caller truly needs it.
- Sink: routine server `DEBUG` and `INFO` events are `file-only`.
- Sink: server `WARN` and `ERROR` events are `both`.
- Error visibility rule: unexpected failures, caught exceptions, startup failures, and recovery failures must always reach the terminal on stderr. File logging may duplicate them, but must never be the only sink.
- Error propagation rule: logging an error does not count as handling it. After emitting the structured error record, preserve the existing failure path by rethrowing, returning the error result, or letting the process-level handler print to stderr.
- Sink: startup and shutdown one-liners are `both`.
- Sink: interactive CLI stdout and stderr are `terminal-only`.
- Sink: browser debug logs and temporary inspection logs are `remove-or-dev-only`.
- Prefer extending `src/server/utils/rateLimitedLogger.ts` with a file sink over adding a legacy logging framework.
- Preserve Bun crash-safe argument serialization. Reuse the safe serializer already installed in `src/server/utils/installSafeConsoleLogging.ts` or extract a shared helper; do not introduce a second object-printing path.

## Log Files

- Start with one file per runtime service per day, not one file per feature.
- V1 partitioning is by `runtimeProfile + service + UTC date`, not by individual process.
- If multiple instances of the same service run in one profile on the same day, they append to the same service file and are distinguished by per-record instance fields.
- Recommended file: `logs/runtime/<profile>/app-server-YYYY-MM-DD.jsonl`.
- Recommended file: `logs/runtime/<profile>/api-server-YYYY-MM-DD.jsonl`.
- Recommended file: `logs/runtime/<profile>/worker-server-YYYY-MM-DD.jsonl`.
- Recommended file: `logs/runtime/<profile>/dev-single-server-YYYY-MM-DD.jsonl` when the combined role is used.
- This is more granular than just app vs api, because this repo already has a distinct worker runtime and that is where most repeating logs live.
- Do not split by subsystem in v1. Put `component`, `event`, `jobId`, `projectId`, and `articleId` in each record instead.
- Split further only after observing real volume or retention pressure. The first candidate would be a dedicated worker LLM file, not per-route or per-module files.

## Instance Identity

- Every server-side record must include `runtimeProfile`, `instanceId`, `hostname`, `pid`, `processStartedAt`, and `service`.
- Records from API, worker, and `dev-single` runtimes must also include `serverRole` and `apiServerPort`.
- Records from the app static server must include `appServerPort` instead of `serverRole`.
- `instanceId` format: `<service>:<hostname>:<port>:<pid>:<processStartedAt>`.
- Reuse the existing identity pieces already tracked in `src/server/utils/writerConnections.ts` where possible: `hostname`, `pid`, `startedAt`, `serverRole`, and server port.
- Do not rely on filename alone to identify a process. Instance identity must be present in every line so shared service files remain attributable.

Example line:

```json
{
  "timestamp": "2026-04-12T10:15:30.123Z",
  "severity": "INFO",
  "runtimeProfile": "primary",
  "service": "worker",
  "instanceId": "worker:my-host:3002:48192:2026-04-12T10:10:00.000Z",
  "hostname": "my-host",
  "pid": 48192,
  "processStartedAt": "2026-04-12T10:10:00.000Z",
  "apiServerPort": 3002,
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

## Config Placement

- Do not read raw `process.env.LOG_*` at call sites.
- Parse log config once in a shared helper or in the existing runtime config loaders.
- API, worker, and `dev-single` server processes should read log config through `src/server/utils/env.ts`.
- The app static server should read the same log config through `src/server/utils/getAppServerRuntimeConfig.ts` or a shared helper it calls.
- Add an explicit runtime-profile marker, for example `FORSKA_RUNTIME_PROFILE`, from `scripts/runWithRuntimeProfile.ts` so file paths resolve predictably to `primary`, `secondary`, or `local`.
- Add one shared helper that derives per-process instance identity for log records, reusing existing writer-connection identity fields where possible.

## File-Only

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
- [ ] Partition log files by runtime process: `app-server`, `api-server`, `worker-server`, and `dev-single` when needed.
- [ ] Add an explicit runtime-profile marker, for example `FORSKA_RUNTIME_PROFILE`, so `logs/runtime/<profile>/...` resolves stably for `primary`, `secondary`, and `local` runs.
- [ ] Add one shared instance-identity helper and emit `runtimeProfile`, `instanceId`, `hostname`, `pid`, `processStartedAt`, and port fields on every server-side log line.
- [ ] Add runtime config for `LOG_DIR`, `LOG_LEVEL`, and stderr threshold; default to `logs/runtime/<profile>/`, and load it through `src/server/utils/env.ts` plus `src/server/utils/getAppServerRuntimeConfig.ts` or one shared helper.
- [ ] Extend `rateLimitedLogger` so noisy paths can keep rate limiting while writing structured JSONL.
- [ ] Reuse or extract the safe console serializer so file logging does not reintroduce Bun pretty-print crashes.
- [ ] Use `Effect` inside the sink for file-handle lifecycle, flush, and shutdown behavior, without forcing `Effect` at every call site.
- [ ] Migrate the hottest repeating server paths first: judgments jobs, full-text pipeline, export streaming, request summaries.
- [ ] Preserve terminal-visible failure paths while migrating progress logs to JSONL.
- [ ] Preserve existing exception and error-result propagation after adding file logging.
- [ ] Replace `console.time` and `console.timeEnd` with explicit duration fields.
- [ ] Remove or dev-gate client-side debug logs and temporary server inspection logs instead of forwarding them to server log files.
- [ ] Leave interactive and JSON-contract scripts on stdout or stderr.
- [ ] Keep the sink decision explicit for every touched log call: `file-only`, `both`, `terminal-only`, or `remove-or-dev-only`.
- [ ] Add or update tests for JSONL writing, rate limiting, path selection, and env parsing.
- [ ] Verify that terminal output drops to startup, warnings, and real errors only.

## Quality Gates

- `bun run lint`
- `bun test src/server/utils/env.test.ts`
- `bun test src/server/utils/getAppServerRuntimeConfig.test.ts`
- `bun test src/server/cron/judgmentsJobs/judgmentsJobsAddToQueue.test.ts`
- `bun test src/server/utils/projectMartLargeRebuildHeartbeat.test.ts`
- `bun run build`
- Manual check: run `bun run dev:server`, hit a reviews flow and an export flow, confirm routine progress logs are `file-only` and `logs/runtime/primary/*.jsonl` gains structured entries.
- Manual check: trigger one failing request or background-job error path and confirm the error is `both`: visible in terminal stderr and present in the matching JSONL file.
- Manual check: if multiple same-service processes are started intentionally in one profile, confirm their shared daily file contains distinct `instanceId` values for each process.
- Manual check: if runtime-profile launchers are touched, run one `primary` or `secondary` flow via `scripts/runWithRuntimeProfile.ts` and confirm logs land under the matching profile directory.

## Commands Run

- `rg -n --glob '!**/*.test.*' "console\.(log|warn|error|info|debug)\s*\(" src/server src/db`
- `rg -n --glob '!**/*.test.*' "console\.(log|warn|error|info|debug)\s*\(" src/app src/components src/services`
- `rg -n --glob '!**/*.test.*' "console\.(log|warn|error|info|debug)\s*\(" src/agent scripts`
- `rg -n "console\.time(End)?\s*\(" src/server`
- `rg -n "runtimeProfile|mergeRuntimeProfileEnv|getAppServerRuntimeConfig|loadEnv" src scripts`
