# LOG_PLAN

Goal: move repeating runtime noise out of the terminal and into structured log files, while keeping the console useful for startup, failures, and interactive scripts.

Layers: server, client, scripts.

## Standard

- Use OpenTelemetry-aligned NDJSON/JSONL, not ad-hoc text or logfmt.
- Write one event per line to `logs/runtime/<profile>/<service>-YYYY-MM-DD.jsonl`.
- Console policy: `debug` and `info` go to file only.
- Console policy: `warn` and `error` go to file plus stderr.
- Console policy: startup and shutdown one-liners stay on console and also go to file.
- Prefer extending `src/server/utils/rateLimitedLogger.ts` with a file sink over adding a legacy logging framework.

## Log Files

- Start with one file per runtime process, not one file per feature.
- Recommended file: `logs/runtime/<profile>/app-server-YYYY-MM-DD.jsonl`.
- Recommended file: `logs/runtime/<profile>/api-server-YYYY-MM-DD.jsonl`.
- Recommended file: `logs/runtime/<profile>/worker-server-YYYY-MM-DD.jsonl`.
- Recommended file: `logs/runtime/<profile>/server-dev-single-YYYY-MM-DD.jsonl` when the combined role is used.
- This is more granular than just app vs api, because this repo already has a distinct worker runtime and that is where most repeating logs live.
- Do not split by subsystem in v1. Put `component`, `event`, `jobId`, `projectId`, `articleId`, and `serverRole` in each record instead.
- Split further only after observing real volume or retention pressure. The first candidate would be a dedicated worker LLM file, not per-route or per-module files.

Example line:

```json
{
  "timestamp": "2026-04-12T10:15:30.123Z",
  "severity": "INFO",
  "service": "worker",
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

## Move To Log Files

- Job scheduler and worker loop progress.
  Files: `src/server/cron/judgmentsJobs/judgmentsJobsAddToQueue.ts`, `src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM.ts`, `src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM/processPromptWithLLM.ts`, `src/server/cron/judgmentsJobs/judgmentsJobsCronGetPrompts.ts`, `src/services/olap/duckdbOlap.ts`.
  Messages: `[addToQueue] Filtered out ...`, `[addToQueue] Prioritized ...`, `[llm] Batch complete`, `[capacity:*] ...`, `[getPrompts] raw fallback ...`.

- Full-text fetch and conversion progress.
  Files: `src/server/cron/fullTextJobs.ts`, `src/server/cron/fullTextConversionJobs.ts`, `src/server/utils/ensureFullText.ts`, `src/server/utils/convertPdfToText.ts`.
  Messages: `Found ... running jobs`, `Project ... need ...`, `Fallback: fetching ...`, `Converting article ...`, `Success`, `Retry`, `Failed`, `No model configured`, `No articles to convert`.

- Repeating request and stream progress.
  Files: `src/server/routes/ProjectExportRoutes.ts`, `src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviews.ts`, `src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsCount.ts`, `src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsFilters.ts`, `src/server/routes/ProjectsAddArticlesRoutes.ts`.
  Messages: request-start, request-summary, export progress, streamed-count, applied-filter summaries.

- Background heartbeat and config logs.
  Files: `src/server/utils/projectMartRefreshWorkerHeartbeat.ts`, `src/server/utils/projectMartLargeRebuildHeartbeat.ts`.
  Messages: `background loop starting`, `background loop config ...`.

- Existing `console.time` and `console.timeEnd` output in hot paths.
  Files: `src/server/cron/fullTextJobs.ts`, `src/server/cron/fullTextConversionJobs.ts`.
  Replace with structured `durationMs` fields in JSONL events.

## Do Not Move To Log Files

- Keep on console, and optionally also duplicate to file.
  Files: `src/server/index.ts`, `src/appServer.ts`, `src/server/utils/getCodexAppServerClient.ts`.
  Messages: service start, port binding, role summary, Codex readiness and login guidance.

- Keep on console because they are operator-visible failures or recovery warnings.
  Files: `src/server/utils/routeErrorHandler.ts`, `src/server/utils/duckdbService.ts`, `src/server/utils/duckdbOwnerLease.ts`, `src/server/routes/ModelsRoutes.ts`.
  Messages: route failures, DuckDB restart or shutdown failures, malformed lease files, provider model load failures.

- Keep as script stdout or stderr because the console output is the product or API.
  Files: `scripts/startServerStack.ts`, `scripts/devServerWatch.ts`, `scripts/alvisLaunch.ts`, `scripts/mn5Launch.ts`, `scripts/recoverProjectMartRefreshClaims.ts`, `scripts/runProjectMartLargeRebuildCycle.ts`, `scripts/runProjectMartRefreshWorkerOnce.ts`, `scripts/runJudgmentJobRepair.ts`, `scripts/dbQuerySnapshot.ts`.
  Reason: these are interactive CLI tools or JSON-emitting scripts already consumed by people, tests, or wrapper scripts.

- Do not file-log these; remove them or gate them behind a dev-only flag.
  Files: `src/app/routes/+projects/+$id/+humanAssessment.tsx`, `src/app/routes/+admin/+failed_requests/+$id/+index.tsx`, `src/app/utils/client-env.ts`, `src/components/main/ProjectsGrid.tsx`, `src/app/routes/+projects/+$id/+reviews-llm/+$articleId/+index.tsx`, `src/app/routes/+projects/+$id/+reviews-llm/+$articleId/+fulltext.tsx`, `src/server/routes/HumanAssessmentRoutes/humanAssessmentRoutesPostInit.ts`.
  Reason: these are browser debug dumps, success chatter, or temporary server inspection logs, not durable runtime telemetry.

## Checklist

- [ ] Add a shared file-backed structured logger for server runtimes and background workers.
- [ ] Partition log files by runtime process: `app-server`, `api-server`, `worker-server`, and `dev-single` when needed.
- [ ] Add runtime config for `LOG_DIR`, `LOG_LEVEL`, and stderr threshold; default to `logs/runtime/<profile>/`.
- [ ] Extend `rateLimitedLogger` so noisy paths can keep rate limiting while writing structured JSONL.
- [ ] Use `Effect` inside the sink for file-handle lifecycle, flush, and shutdown behavior, without forcing `Effect` at every call site.
- [ ] Migrate the hottest repeating server paths first: judgments jobs, full-text pipeline, export streaming, request summaries.
- [ ] Replace `console.time` and `console.timeEnd` with explicit duration fields.
- [ ] Remove or dev-gate browser-side debug `console.log` calls instead of forwarding them to server log files.
- [ ] Leave interactive and JSON-contract scripts on stdout or stderr.
- [ ] Add or update tests for JSONL writing, rate limiting, and path selection.
- [ ] Verify that terminal output drops to startup, warnings, and real errors only.

## Quality Gates

- `bun run lint`
- `bun test src/server/cron/judgmentsJobs/judgmentsJobsAddToQueue.test.ts`
- `bun test src/server/utils/projectMartLargeRebuildHeartbeat.test.ts`
- `bun run build`
- Manual check: run `bun run dev:server`, hit a reviews flow and an export flow, confirm the terminal stays quiet while `logs/runtime/.../*.jsonl` gains structured entries.

## Commands Run

- `rg -n --glob '!**/*.test.*' "console\.(log|warn|error|info|debug)\s*\(" src/server src/db`
- `rg -n --glob '!**/*.test.*' "console\.(log|warn|error|info|debug)\s*\(" src/app src/components src/services`
- `rg -n --glob '!**/*.test.*' "console\.(log|warn|error|info|debug)\s*\(" src/agent scripts`
- `rg -n "console\.time(End)?\s*\(" src/server`
