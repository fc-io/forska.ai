# Match Provider Limit Plan

## Goal

- Keep `Active LLM Calls` much closer to the saved provider connection limit during healthy steady-state work.
- Treat the saved provider limit as the main operating target, while preserving lower caps from worker availability, fallback capacity, endpoint health, and chunk safety.
- Implement this in small steps, starting with `src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM/processPromptWithLLM.ts`.
- Keep drain, retry, stale-row recovery, and request-runtime safety behavior intact.

## Success Signal

- For healthy non-chunked jobs with enough ready prompts, live LLM calls should rise quickly and usually stay near the effective provider cap after warmup.
- If observed calls stay low, logs and admin diagnostics should show which gate is responsible: prompt prep, runtime resolution, queue refill, endpoint cooldown, shared-connection allocation, chunk cap, or Codex transport.

## Scope Now

- Remove scheduler-side and pre-request bottlenecks that keep `requestStats.inFlight` below the provider cap.
- Add only the observability needed to explain low utilization.
- Prioritize normal prompt jobs first, then Codex-specific follow-up if generic fixes are not enough.

## Not Now

- New provider settings UI.
- Auto-tuning from long-term metrics.
- A full rewrite of the scheduler into a continuous streaming pipeline.
- Changing the meaning of `Running Prompts` vs `Active LLM Calls`.

## Step 1. Prompt Preparation Headroom

Files:

- `src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM/processPromptWithLLM.ts`
- `src/server/utils/getInferenceRuntimeConfig.ts`
- `src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM.test.ts`

Changes:

- Replace the hardcoded `promptPreparationMaxInFlight = 16` with an explicit runtime-configured limit.
- Start with one global preparation semaphore that is comfortably above expected provider caps before attempting per-provider preparation budgets.
- Add minimal logging or counters for preparation queue wait time and preparation duration.
- Keep `withJudgmentRequest(...)` as the final request-level guardrail; this step only removes pre-request starvation.

Expected result:

- More prompts reach `generateSinglePromptResponse(...)` quickly enough to keep provider request slots full.
- `Running Prompts` should stop flattening far below the provider cap when prompt preparation is the bottleneck.

## Step 2. Resolve Runtime Once Per Job Per Tick

Files:

- `src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM/getAndUpdateReadyPrompts.ts`
- `src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM.ts`
- `src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM/getAndUpdateReadyPrompts.test.ts`

Changes:

- Resolve provider runtime once per job per send tick.
- Reuse the resolved runtime for dispatchability checks, endpoint availability checks, and claimed prompt materialization.
- Remove the current double-resolution path where runtime is resolved in both `getReadyPromptRuntime(...)` and `getSqliteReadyRows(...)`.

Expected result:

- Lower claim latency and less per-tick scheduler overhead before prompts are launched.

## Step 3. Let Dispatch Continue During Import

Files:

- `src/server/cron/judgmentsJobs.ts`
- `src/server/cron/judgmentsJobs/judgmentJobSqliteBackgroundImport.ts`
- related cron tests if needed

Changes:

- Stop global import activity from blocking `sendToLLM`.
- Keep import itself single-flight, but allow active request dispatch to continue while import is running.
- If needed, unblock `sendToLLM` first and leave `addToQueue` guarded until after measurement.

Expected result:

- Fewer one-second dead periods where no new requests are launched.
- Better steady-state saturation under constant import activity.

## Step 4. Feed The Ready Queue Faster

Files:

- `src/server/cron/judgmentsJobs/judgmentsJobsAddToQueue.ts`
- `src/server/cron/judgmentsJobs/judgmentsJobsCronGetPrompts.ts`
- `src/server/cron/judgmentsJobs/judgmentsJobsAddToQueue.test.ts`

Changes:

- Parallelize add-to-queue work across safe buckets or jobs.
- Revisit `sqliteScanMaxWindowsPerTick` and `sqliteScanExhaustedCooldownMs` for high-cap providers.
- Increase ready-target headroom only when queue starvation is the measured limiter.

Expected result:

- Dispatch has enough ready prompts to refill open request slots immediately.

## Step 5. Backfill Unused Shared-Connection Budget

Files:

- `src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM.ts`
- `src/server/cron/judgmentsJobs/judgmentDispatchRuntime.ts`
- `src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM.test.ts`
- `src/server/cron/judgmentsJobs/judgmentDispatchRuntime.test.ts`

Changes:

- Replace strict equal preallocation with opportunistic backfill inside a shared provider connection.
- Let fast-launching jobs borrow unused connection budget from slower jobs in the same tick.
- Preserve fairness over time instead of enforcing strict fairness in each allocation pass.

Expected result:

- Shared connections stay closer to their configured limit instead of idling behind slow jobs.

## Step 6. Soften Endpoint Cooldown Recovery

Files:

- `src/server/cron/judgmentsJobs/judgmentEndpointAvailability.ts`
- `src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM.ts`
- `src/server/cron/judgmentsJobs/judgmentsRequestRuntime.ts`
- `src/server/cron/judgmentsJobs/judgmentsRequestRuntime.test.ts`

Changes:

- Shorten or stage cooldown recovery after transient failures.
- After a successful probe, ramp back to normal dispatch faster than the current one-probe pattern.
- Keep hard stops for real outages and misconfiguration.

Expected result:

- Less time stuck at `0-1` live calls after a temporary provider failure.

## Step 7. Codex Transport Follow-Up

Files:

- `src/server/utils/getCodexAppServerClient.ts`
- `src/server/providers/transports/codexAppTransport.ts`
- Codex-related runtime tests

Changes:

- Profile the singleton `codex app-server` client under concurrent load.
- If it materially serializes turns, introduce a small client pool per provider connection.
- Keep the same saved provider cap as the hard upper bound across the pool.

Expected result:

- Codex jobs can actually consume the configured provider budget instead of being limited by one subprocess.

## Step 8. Chunked Prompt Follow-Up

Files:

- `src/agent/judge.ts`
- `src/agent/judge/judgeChunkedMode.test.ts`

Changes:

- Revisit chunk parallelism only after Steps 1-7 are measured.
- Tune `judgeChunkMaxParallel` or chunk pipeline staging if chunk-heavy workloads still under-fill the provider cap.
- Keep provider cap and request runtime as the hard ceilings.

Expected result:

- Chunk-heavy jobs stop underutilizing the provider connection for scheduler reasons rather than workload shape.

## Observability

- Emit structured runtime events through the shared runtime logger or extended `rateLimitedLogger`, not ad-hoc `console.*` calls.
- Use stable event names such as `judgments.promptPreparation.wait`, `judgments.runtimeResolution.cache`, `judgments.dispatch.idle`, and `judgments.codex.turnStart`, with attrs like `jobId`, `providerConnectionId`, `modelId`, `waitMs`, `durationMs`, `cacheHit`, `reason`, `limit`, `inFlight`, and `readyCount`.
- Treat routine scheduler, prep, allocation, and utilization diagnostics as `file-only` so steady-state saturation debugging lands in JSONL instead of the terminal.
- Treat endpoint cooldown transitions, provider misconfiguration, and request-launch failures as `both` so operators still see terminal-visible warnings and errors.
- Replace any `console.time` and `console.timeEnd` timing with structured `durationMs` fields on those runtime events.

## Implementation Order

1. Ship Step 1 alone and measure healthy non-chunked jobs.
2. Ship Step 2 and remeasure claim-to-launch latency.
3. Ship Step 3 and confirm import no longer causes troughs.
4. Ship Step 4 and Step 5 if refill or allocation is still the limiter.
5. Ship Step 6 only if cooldowns are still a major source of idle capacity.
6. Ship Step 7 only if Codex remains well below cap after the generic pipeline fixes.
7. Ship Step 8 last.

## Done Criteria

- With enough ready work and healthy endpoints, live LLM calls usually stay close to the effective provider cap after warmup.
- `Running Prompts` no longer stalls far below the provider limit because of scheduler-side prep or refill bottlenecks.
- Low utilization can be explained by explicit diagnostics instead of hidden throttles.
- Shared-provider jobs backfill unused capacity instead of leaving slots idle.
- No regression in stale-row recovery, drain behavior, or request-runtime safety.

## Touched Layers

- server
- tests
- docs

## Quality Gates

- `bun test src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM.test.ts`
- `bun test src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM/getAndUpdateReadyPrompts.test.ts`
- `bun test src/server/cron/judgmentsJobs/judgmentsRequestRuntime.test.ts`
- `bun test src/server/cron/judgmentsJobs/judgmentsJobsAddToQueue.test.ts`
- `bun test src/server/cron/judgmentsJobs/judgmentDispatchRuntime.test.ts`
- `bun test src/agent/judge/judgeChunkedMode.test.ts`
- `bun run lint`
- `bun run build` only when admin UI or diagnostics copy changes

## Commands Reviewed

- None. Planning-only change; no shell commands were needed.
