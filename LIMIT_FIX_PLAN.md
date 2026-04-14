# Limit Fix Plan

## Goal

- Make one limit mean `max concurrent local LLM calls per provider connection`.
- Keep metrics owned by the API server / writer, not inferred from provider responses.
- Prevent chunked prompts from exceeding the same connection cap.

## Current Problem

- `Claimed` can grow above the configured limit because queued prompts count against capacity, but active prompts are not fully included in the same way.
- `Running Prompts` is local prompt state, while `Active LLM Calls` is local request state. They are related but not identical.
- Per-connection prompt dispatch is effectively serial, so a connection with limit `10` can still sit at `1` active request.
- Chunked prompts can fan out into multiple requests, so prompt-level and request-level counts cannot safely be forced to match 1:1.

## Proposed Meaning Of The Limit

- The single limit controls `Active LLM Calls`.
- `Active LLM Calls` is the hard concurrency cap.
- `Running Prompts` means prompts this server has actively started processing.
- `Claimed` means local backlog reserved by this server.

## Changes

### 1. Dispatch Runtime Capacity

File: `src/server/cron/judgmentsJobs/judgmentDispatchRuntime.ts`

- Subtract both queued prompts and active prompts from provider capacity.
- Treat active work as consuming the same connection budget as queued work.
- Result: `Claimed` stays closer to real local work instead of drifting upward.

### 2. Prompt Dispatch Concurrency

File: `src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM.ts`

- Replace serial per-connection prompt processing with bounded parallel processing.
- Use the provider connection limit as the per-connection launch cap.
- If a connection-level failure occurs, stop launching new prompts for that connection.
- Requeue only prompts that were claimed but not yet started.
- Keep already-started prompts on their existing retry / recovery path.

### 3. Request Runtime As Hard Guardrail

File: `src/server/cron/judgmentsJobs/judgmentsRequestRuntime.ts`

- Keep `withJudgmentRequest(...)` as the authoritative guardrail for actual LLM load.
- No provider request should exceed the local request cap, even if prompt dispatch becomes more parallel.

### 4. Chunked Prompt Safety

File: `src/agent/judge.ts`

- Cap chunk parallelism by the same provider connection limit.
- Use:

```ts
chunkParallel <= min(judgeChunkMaxParallel, providerMaxInflightRequests, chunkCount)
```

- Result: one chunked prompt cannot consume more request slots than the connection allows.

### 5. Admin Metric Copy

File: `src/app/routes/+admin/+jobs/+$id/+index.tsx`

- Keep `Active LLM Calls` as the primary live throughput metric.
- Clarify labels:
  - `Claimed`: reserved local backlog
  - `Running Prompts`: prompt executions started locally
  - `Active LLM Calls`: local request slots currently in use

## Expected Behavior After Fix

### Non-chunked jobs

- `Active LLM Calls` should rise toward the configured limit.
- `Running Prompts` should usually stay close to `Active LLM Calls`.
- `Claimed` should stay near active work plus a small queue.

### Chunked jobs

- `Active LLM Calls` remains capped by the same limit.
- `Running Prompts` may differ from request count, but stays server-owned and meaningful.
- Chunk fan-out remains bounded and should not overload the provider.

## Pros

- The single limit becomes understandable and operationally useful.
- Throughput improves for normal prompt jobs.
- Metrics better reflect what the local server is actually doing.
- Chunked prompts remain safe under the same concurrency cap.

## Cons

- `Running Prompts` and `Active LLM Calls` will still not be perfectly identical for chunked prompts.
- Parallel prompt dispatch increases coordination complexity around connection failures.
- Some tests need to be rewritten because serial assumptions no longer hold.

## Tests

### Update

- `src/server/cron/judgmentsJobs/judgmentDispatchRuntime.test.ts`
  - capacity should account for queued and active prompts
- `src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM.test.ts`
  - per-connection dispatch should launch up to the configured limit
  - connection failures should halt new launches and requeue only not-yet-started prompts

### Add

- coverage for chunk parallel limit respecting both global chunk config and provider connection cap

## Touched Layers

- server
- client
- tests

## Quality Gates

- `bun test src/server/cron/judgmentsJobs/judgmentDispatchRuntime.test.ts`
- `bun test src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM.test.ts`
- targeted chunk concurrency test near `src/agent/judge.ts`
- `bun run lint`

## Commands Reviewed

- `curl http://localhost:3001/api/judgmentsjobs`
- `curl http://localhost:3001/api/judgmentsjobs/6a693f90-dcaa-4660-bc60-789b9ade0ac6`
- `curl http://localhost:3001/api/judgmentsjobs/6a693f90-dcaa-4660-bc60-789b9ade0ac6/health`
- `curl http://localhost:3001/api/projects/e45d9ba9-f8b7-4455-9e8d-7f7d6bd63c27`
- `curl http://localhost:3001/api/provider-connections`
- `ps -p 92185 -o pid,command`
- `lsof -iTCP -sTCP:LISTEN -nP`
