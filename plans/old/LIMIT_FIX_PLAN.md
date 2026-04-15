# Limit Fix Plan

## Goal

- Make the saved provider connection limit the main knob for increasing per-connection local parallelism.
- Use that same limit as the upper bound for prompt launch concurrency, in-flight request concurrency, and chunk fan-out.
- Keep metrics owned by the API server / writer, not inferred from provider responses.
- Preserve lower downstream safety caps when worker availability, fallback runtime limits, or endpoint health require them.

## Current Problem

- `Claimed` drifts upward because dispatch capacity subtracts queued prompts but not active prompts.
- `Running Prompts` is local prompt state, while `Active LLM Calls` is local request state. They are related but not identical.
- Per-connection prompt dispatch is effectively serial, and it still adds launch jitter, so raising a limit does not materially raise parallelism.
- The current requeue logic assumes serial launch order, so it cannot safely distinguish started vs not-yet-started prompts once dispatch becomes parallel.
- Chunked prompts can fan out into multiple requests without respecting the provider connection limit.
- Request runtime still has worker / fallback gating, so the saved limit is an upper bound, not a guarantee of observed active calls.

## Proposed Meaning Of The Limit

- The saved provider connection limit is the primary per-connection parallelism control.
- Raising it should raise how many prompts may launch in parallel for that connection.
- It remains a hard upper bound inside `withJudgmentRequest(...)`.
- It does not override lower caps from worker availability, fallback capacity, or endpoint health gates.
- `Claimed` means claimed or sent prompt backlog reserved locally but not yet running.
- `Running Prompts` means prompt executions this server has started locally.
- `Active LLM Calls` means in-flight request slots currently in use for this job.
- The configured limit is shared across all jobs using the same provider connection, while the job detail page shows only this job's local slice.

## Changes

### 1. Dispatch Runtime Capacity

File: `src/server/cron/judgmentsJobs/judgmentDispatchRuntime.ts`

- Subtract both pending queued prompts and active prompts from provider capacity.
- Treat reserved prompt budget as `pendingPromptCount + activePrompts.length`.
- Make `getProviderQueueCapacity(...)` return remaining connection headroom, not just free queue slots.
- Result: `Claimed` stops drifting upward because active work and queued work consume the same per-connection budget.

### 2. Prompt Dispatch Concurrency

File: `src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM.ts`

- Replace serial per-connection prompt processing with bounded parallel launch up to the provider connection limit.
- Remove or sharply reduce the current per-prompt launch jitter so raising the limit materially raises parallelism.
- Track which claimed prompts have actually started launch.
- If endpoint availability flips or a `ConnectionError` occurs, stop launching new prompts for that connection.
- Requeue only claimed prompts that have not started launch yet.
- Keep already-started prompts on their existing retry / recovery path.

### 3. Request Runtime As Hard Guardrail

File: `src/server/cron/judgmentsJobs/judgmentsRequestRuntime.ts`

- Keep `withJudgmentRequest(...)` as the authoritative guardrail for actual LLM load.
- No provider request should exceed the saved provider connection limit locally.
- Keep existing worker, fallback, and endpoint-health gates even when prompt dispatch becomes more parallel.
- If observed active calls plateau below the saved limit, treat that as downstream capacity tuning, not a metric mismatch.

### 4. Chunked Prompt Safety

File: `src/agent/judge.ts`

- Cap chunk parallelism by both the chunk config and the provider connection cap.
- Use:

```ts
chunkParallel <= min(judgeChunkMaxParallel, providerMaxInflightRequests, chunkCount)
```

- Result: one chunked prompt cannot consume more request slots than the connection upper bound on its own.
- Request runtime remains the final hard guardrail when multiple jobs or prompts compete on the same connection.

### 5. Admin Metric Copy

File: `src/app/routes/+admin/+jobs/+$id/+index.tsx`

- Keep the current layout and mostly keep the current labels.
- Tighten wording only where needed so the meanings stay explicit:
  - `Claimed`: reserved local backlog not yet running
  - `Running Prompts`: prompt executions started locally
  - `Active LLM Calls`: request slots currently in use for this job
- Optionally note that the configured limit is shared across jobs on the same provider connection.

## Expected Behavior After Fix

### Non-chunked jobs

- Raising the saved provider limit should materially increase per-connection launch parallelism.
- `Active LLM Calls` should be able to climb higher than today, subject to worker, fallback, and endpoint-health caps.
- `Running Prompts` should usually stay close to `Active LLM Calls`.
- `Claimed` should stay closer to a short pre-launch backlog and may drop near zero while running work stays high.

### Chunked jobs

- Chunk fan-out remains bounded by both config and provider connection limit.
- `Active LLM Calls` remains capped by runtime guardrails.
- `Running Prompts` may differ from request count, especially when one prompt owns multiple chunk requests.
- A single chunked prompt can use multiple request slots, but not more than the same per-connection upper bound.

### Shared-connection caveat

- Job-level `Active LLM Calls` is not a connection-wide total.
- Multiple jobs sharing one provider connection still compete under the same saved limit.
- If worker or fallback caps are lower than the saved limit, observed active calls may plateau below the configured value.

## Pros

- Raising the saved provider limit becomes a meaningful way to raise parallelism.
- Throughput improves for normal prompt jobs.
- Metrics become easier to interpret without pretending prompt state and request state are identical.
- Chunked prompts remain bounded by the same connection-level upper bound.

## Cons

- The saved provider limit is still an upper bound, not a guaranteed observed request count.
- Parallel prompt launch requires explicit started / not-started tracking for safe requeue behavior.
- `Running Prompts` and `Active LLM Calls` will still diverge in chunked mode.
- Some tests need to be rewritten because serial assumptions no longer hold.

## Tests

### Update

- `src/server/cron/judgmentsJobs/judgmentDispatchRuntime.test.ts`
  - capacity should account for queued and active prompts
- `src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM.test.ts`
  - per-connection dispatch should launch up to the configured limit in parallel
  - connection failures should halt new launches and requeue only not-yet-started prompts
  - reduced or removed launch jitter should not reintroduce serial behavior
- `src/server/cron/judgmentsJobs/judgmentsRequestRuntime.test.ts`
  - request runtime should still enforce the connection-level upper bound while honoring existing lower runtime caps

### Add

- `src/agent/judge/judgeChunkedMode.test.ts`
  - chunk parallel limit should respect both global chunk config and provider connection cap

## Touched Layers

- server
- tests
- client (copy only, optional)

## Quality Gates

- `bun test src/server/cron/judgmentsJobs/judgmentDispatchRuntime.test.ts`
- `bun test src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM.test.ts`
- `bun test src/server/cron/judgmentsJobs/judgmentsRequestRuntime.test.ts`
- `bun test src/agent/judge/judgeChunkedMode.test.ts`
- `bun run lint`

## Commands Reviewed

- `curl http://localhost:3001/api/judgmentsjobs`
- `curl http://localhost:3001/api/judgmentsjobs/6a693f90-dcaa-4660-bc60-789b9ade0ac6`
- `curl http://localhost:3001/api/judgmentsjobs/6a693f90-dcaa-4660-bc60-789b9ade0ac6/health`
- `curl http://localhost:3001/api/projects/e45d9ba9-f8b7-4455-9e8d-7f7d6bd63c27`
- `curl http://localhost:3001/api/provider-connections`
- `ps -p 92185 -o pid,command`
- `lsof -iTCP -sTCP:LISTEN -nP`
