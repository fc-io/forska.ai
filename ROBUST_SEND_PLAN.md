# Robust Send Plan

## Goal

Keep `Live LLM calls` close to the saved provider limit when ready work exists and the provider can accept it, without changing provider/model settings.

## Implementation Checklist

- [ ] Add lifecycle states to dispatch telemetry: `claimed`, `dispatchQueued`, `preparing`, `waitingForRequestSlot`, `liveRequest`, `persisting`, `completed`.
- [ ] Record per-state counts and age/duration summaries per `jobId` and `providerConnectionId`.
- [ ] Keep `withJudgmentRequest` as the only hard limiter for live LLM requests.
- [ ] Remove fixed `16/64` claim chunk behavior after the adaptive controller is in place.
- [ ] Add a provider/job backlog target computed from `providerLimit`, `liveCalls`, `activePrompts`, `queuedPrompts`, `readyCount`, and recent drain rate.
- [ ] Claim more prompts when `liveCalls < providerLimit`, ready work exists, and local backlog is below target.
- [ ] Stop claiming when local backlog is above target or provider slots are saturated.
- [ ] Make prompt preparation concurrency dynamic instead of fixed at `16`.
- [ ] Bound preparation concurrency with a safe minimum/maximum so DB/CPU work cannot explode.
- [ ] Track prompts waiting for request slots separately from prompts doing preparation.
- [ ] Classify bottlenecks as `claiming`, `promptPreparation`, `requestSlotWait`, `providerSaturated`, `completionPersistence`, or `noReadyWork`.
- [ ] Expose the bottleneck classification from the job detail API.
- [ ] Update `/admin/jobs/:id` to show the bottleneck state next to queue/request metrics.
- [ ] Make `Claimed`, `Running Prompts`, `Worker active prompts`, `Worker queued prompts`, and `Live LLM calls` use consistent lifecycle definitions.
- [ ] Add tests for underfed provider, saturated provider, slow claim path, slow prep path, and request-slot wait path.

## Controller Rules

- [ ] If `readyCount > 0` and `liveCalls < providerLimit`, increase target backlog until live calls rise or a bottleneck is identified.
- [ ] If `liveCalls >= providerLimit * 0.9`, hold or reduce target backlog.
- [ ] If `preparing` age grows while `liveCalls` is low, classify `promptPreparation`.
- [ ] If `waitingForRequestSlot` grows while `liveCalls` is near limit, classify `providerSaturated`.
- [ ] If `waitingForRequestSlot` grows while `liveCalls` is low, classify `requestSlotWait` or endpoint availability trouble.
- [ ] If `persisting` age grows, classify `completionPersistence` and avoid claiming more backlog.
- [ ] Never change model, provider, thinking level, runtime model, or saved provider limit as part of scheduling.

## Success Criteria

- [ ] With ready work and provider limit `300`, `Live LLM calls` converges toward `300` when the provider can accept it.
- [ ] If `Live LLM calls` cannot converge, the UI says which stage is limiting throughput.
- [ ] `Claimed` stays bounded by the adaptive backlog target.
- [ ] Fast GPUs do not drain to zero between scheduler ticks.
- [ ] Provider/model benchmark-critical settings are unchanged.

## Quality Gates

- [ ] `bun test src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM.test.ts`
- [ ] `bun test src/server/cron/judgmentsJobs/judgmentDispatchRuntime.test.ts`
- [ ] `bun test src/server/cron/judgmentsJobs/judgmentsRequestRuntime.test.ts`
- [ ] `bun test src/server/routes/JudgmentsJobsRoutes.test.ts`
- [ ] `bun run lint`
- [ ] `bun run build` if admin UI metrics or shared UI code changes
- [ ] Browser verify `/admin/jobs/:id` during a running job
- [ ] Verify normal web flow; check desktop only if shared runtime paths or desktop-relevant wiring changes
