# Sent Queue Fix Plan

## Goal

- Make scheduler capacity track real active LLM work instead of treating every claimed prompt as already running.
- Make the UI distinguish local worker backlog from actual LLM calls so the numbers tell one coherent story.
- Replace the current ad hoc detached dispatch flow with an Effect-owned runtime so queueing, concurrency, interruption, and cleanup are explicit.
- Preserve crash recovery for locally claimed prompts and avoid over-claiming after restart.

## Problem Summary

- `queue_prompt.status = 'sent'` currently means `claimed by the worker`, not `actively running on the LLM`.
- The scheduler counts all `sent` rows as in-flight capacity, so it believes the provider is full long before SGLang is full.
- The worker then drains claimed prompts through detached background loops, which produces a real concurrency far below the configured provider and runtime caps.
- The job detail UI labels `sent` as `Prompts in Progress`, while the request card separately shows actual LLM calls. That makes the page easy to misread.
- The nav `Waiting / Running` indicator is runtime-only SGLang data, so `waiting = 0` can still coexist with a large Forska-side claimed backlog.

## Core Decisions

- Rename the local queue concept from `sent` to `claimed` in Forska-owned code paths and UI.
- Add an explicit prompt-level `running` state for prompts that a worker fiber has started processing.
- Keep request-level `inFlight` separate from prompt-level `running` because one prompt can fan out into multiple LLM calls during chunking.
- Keep the nav `Waiting / Running` indicator as runtime-only SGLang metrics. Do not mix local claimed backlog into that indicator.
- Introduce a scoped Effect service, `JudgmentDispatchRuntime`, to own:
  - provider-scoped bounded queues
  - provider/request semaphores
  - prompt lifecycle transitions
  - worker fibers
  - cleanup on interruption, shutdown, or writer demotion
- First pass should keep the prefetch buffer intentionally small. Target: `min(effective provider cap, promptPreparationMaxInFlight)` per provider connection. That is enough to hide prompt-preparation latency without recreating a `200 claimed / 35 active` backlog.

## State Model

- `ready`: prompt is claimable from the per-job SQLite queue.
- `claimed`: prompt is reserved by the current worker and is waiting in the local dispatch buffer.
- `running`: a worker fiber has started processing the prompt. This includes prompt preparation and any active or pending subrequests for that prompt.
- `judged`: prompt completed successfully.
- `skipped`: prompt reached a terminal skip state.

## UI Model

- Job Queue card on `/admin/jobs/:id` should show prompt-level queue state:
  - `Ready`
  - `Claimed`
  - `Running Prompts`
  - `Judged`
  - `Skipped`
- Request Activity card should stay request-level:
  - `Active LLM Calls`
  - `Attempts`
- Replace the current `Prompts in Progress` wording because it currently points at `sent`, which is a local reservation count, not a real request count.
- Keep the nav indicator runtime-only, but rename or tooltip it so the scope is obvious, for example `LLM Runtime Waiting / Running`.
- Add one short explanatory line on the job page:
  - `Claimed = reserved by this worker`
  - `Running Prompts = prompts actively being processed`
  - `Active LLM Calls = live upstream requests`

## Effect Runtime Shape

- Add `src/server/cron/judgmentsJobs/judgmentDispatchRuntime.ts`.
- Model the dispatcher as a small Effect service using repo-preferred primitives:
  - `Context` / `Layer` for wiring
  - `Effect.gen` for control flow
  - `Effect.acquireRelease` for prompt state transitions and request slot release
  - bounded `Queue` per provider connection for claimed prompts
  - `Semaphore` or equivalent permit accounting for provider-scoped active workers
  - scoped worker fibers so they stop cleanly when the service scope closes
- The cron should only top up the dispatcher. It should no longer spawn detached serial reducers that outlive the tick without a single owner.
- Register dispatcher shutdown with the existing server-role lifecycle so a writer demotion interrupts fibers and leaves prompts in a recoverable state.

## Implementation Order

1. SQLite queue semantics.
   - Upgrade the per-job SQLite schema and helpers so Forska code uses `claimed` and `running` instead of overloading `sent`.
   - Migrate legacy `sent` rows to `claimed` on open.
   - Add helpers such as:
     - `markPromptAsClaimed`
     - `markPromptAsRunning`
     - `getClaimedCount`
     - `getRunningCount`
     - `getDispatchCounts`
   - Update stale requeue logic so legacy `sent`, new `claimed`, and new `running` rows all recover safely when a worker dies.

2. Prompt lifecycle ownership.
   - Keep `claimReadyPrompts` responsible only for `ready -> claimed`.
   - Move `claimed -> running` into the worker-owned dispatch runtime when a processing fiber actually starts the prompt.
   - Move `running -> ready` retry cleanup and `running -> judged/skipped` terminal cleanup into Effect-managed acquire/release boundaries so interruption does not strand rows.

3. Dispatcher service.
   - Build `JudgmentDispatchRuntime` as the single owner of provider-scoped queues and worker fibers.
   - One provider connection gets one bounded local queue and a bounded set of prompt-processing fibers.
   - The dispatcher should expose a small surface such as:
     - `getProviderBacklog`
     - `getAvailableQueueCapacity`
     - `enqueueClaimedPrompts`
     - `drainProvider` or similar internal worker loop
   - Keep `withJudgmentRequest` as the actual request-slot gate for upstream calls, but stop using SQLite `sent` rows as the scheduler's definition of in-flight work.

4. Scheduler top-up logic.
   - Update `judgmentsJobsSendToLLM.ts` so the cron computes deficits from:
     - current request runtime activity
     - current dispatcher queue capacity
     - current per-provider fair-share limits
   - Remove the current detached per-connection serial reducer behavior from `processClaimedPromptsByConnection`.
   - The cron should claim only enough prompts to fill the bounded dispatcher buffer, not an entire provider cap worth of local backlog.

5. API and UI payloads.
   - Update `JudgmentsJobsRoutes` payloads to return prompt-level counts using `claimed` and `running` names.
   - Keep `requestStats.inFlight` as actual live LLM calls.
   - Update `src/services/judgmentsJobsService.ts` defaults to match the new fields.
   - Update `/admin/jobs/:id` copy so the prompt queue card and request activity card no longer conflict semantically.
   - Update the nav indicator copy or tooltip to make the runtime-only scope explicit.

6. Legacy compatibility and rollout safety.
   - Treat legacy SQLite rows with `status = 'sent'` as `claimed` during upgrade.
   - Keep requeue-on-stale behavior idempotent so a worker restart during rollout does not duplicate work.
   - Avoid adding backward-compat aliases to the API unless a concrete consumer outside the repo requires them. The repo-owned UI can move in the same patch.

## Test Plan

- `src/server/cron/judgmentsJobs/judgmentJobSqliteService.test.ts`
  - legacy `sent` rows upgrade to `claimed`
  - `ready -> claimed -> running -> judged`
  - `ready -> claimed -> running -> retry`
  - stale requeue recovers `claimed` rows
  - stale requeue recovers `running` rows
  - counts for `claimed` and `running` are reported separately

- `src/server/cron/judgmentsJobs/requeueAbandonedSentPrompts.test.ts`
  - extend coverage so old `sent` data and new `claimed` / `running` data all requeue correctly
  - preserve queue order after requeue

- `src/server/cron/judgmentsJobs/judgmentsRequestRuntime.test.ts`
  - request stats still reflect actual active LLM calls only
  - permits release correctly on success, connection failure, and interruption
  - provider-scoped caps still apply across multiple jobs on the same provider connection

- New `src/server/cron/judgmentsJobs/judgmentDispatchRuntime.test.ts`
  - bounded queue never over-accepts claimed prompts
  - dispatcher starts work up to the configured provider cap
  - dispatcher top-up uses available queue capacity instead of raw claimed-row count
  - interruption returns prompts to a recoverable state
  - one provider connection cannot starve another beyond the intended shared limits

- `src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM.test.ts`
  - scheduler top-up uses dispatcher capacity and actual request activity
  - scheduler no longer treats all claimed prompts as running
  - fairness across jobs sharing one provider connection still holds

- `src/server/routes/JudgmentsJobsRoutes.test.ts`
  - route payload exposes renamed prompt stats and request stats correctly
  - job detail page data can show `claimed`, `running`, and `inFlight` without ambiguity

- `src/utils/llmStatusQuery.test.ts`
  - keep runtime-only waiting/running aggregation stable after UI copy changes

## Done Criteria

- The scheduler no longer stalls because `claimed` prompts are counted as if they were active LLM calls.
- Real upstream concurrency can rise to the configured provider/runtime limits when enough work exists.
- The worker keeps only a small bounded claimed backlog per provider connection.
- `/admin/jobs/:id` clearly separates local prompt backlog from actual LLM calls.
- The nav indicator remains accurate as runtime-only LLM metrics.
- Restarting or demoting the worker does not strand prompts permanently in `claimed` or `running`.

## Not Now

- No new global admin page for claimed backlog.
- No auto-tuning of prefetch size from live runtime metrics.
- No attempt to merge prompt-level and request-level activity into a single number.

## Quality Gates

- `bun test src/server/cron/judgmentsJobs/judgmentJobSqliteService.test.ts`
- `bun test src/server/cron/judgmentsJobs/requeueAbandonedSentPrompts.test.ts`
- `bun test src/server/cron/judgmentsJobs/judgmentsRequestRuntime.test.ts`
- `bun test src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM.test.ts`
- `bun test src/server/routes/JudgmentsJobsRoutes.test.ts`
- `bun test src/utils/llmStatusQuery.test.ts`
- `bun run build`
- `bun run lint`
- Browser verify `/admin/jobs/:id`:
  - local queue card shows `Ready`, `Claimed`, `Running Prompts`, `Judged`, and `Skipped`
  - request activity card shows `Active LLM Calls` and `Attempts`
  - nav indicator still reflects runtime-only waiting/running
  - under active load, `claimed` can exceed `active LLM calls`, but the page copy makes the difference obvious
  - after a worker restart, previously claimed prompts recover and continue processing without duplicate terminal judgments
