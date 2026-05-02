# Robust Send Plan

## Goal

Keep request-level `Live LLM calls` close to the saved provider limit when ready work exists and the provider can accept it, without changing provider/model settings. Request admission is local-only: each judge worker uses local request counters as the authority for how many LLM requests it may send. Cross-worker telemetry is best-effort visibility and bottleneck context, not a distributed lock or an input that lowers local request admission.

## Definitions

- `providerKey`: the saved `providerConnectionId` when present; otherwise the existing provider family/default-capacity bucket.
- `providerLimit`: the saved provider limit for that `providerKey`, interpreted as the local request-admission target used by each judge worker for that provider.
- `effectiveProviderLimit`: the current local request-admission target after benchmark-preserving runtime gates such as Anthropic warmup and endpoint availability. It should not intentionally exceed `providerLimit` on a worker, but aggregate multi-worker over-cap windows are acceptable.
- `localLiveCalls`: live request count on the current worker for the same `providerKey`. This is the authoritative count for request admission.
- `globalLiveCalls`: best-effort live request count summed across fresh worker telemetry for the same `providerKey`. It is used for display and bottleneck context only, never to reduce the current worker's request-admission target.
- `localBacklog`: prompts claimed by the current worker and not yet terminal, including queued, preparing, waiting for a request slot, live request, and persisting states.
- `globalBacklog`: best-effort backlog count summed across workers for the same `providerKey`. It is used for display and bottleneck context only, not for local request admission.
- No new provider lease table or durable shared lease state. Cross-worker coordination uses existing worker telemetry/owner-connection discovery and local in-process counters only.
- Lifecycle telemetry is in-memory per worker and/or derived from existing SQLite, journal, and worker telemetry. Do not add a new table for lifecycle state.
- Prompt/pipeline concurrency is not the provider limit. The provider limit applies to active LLM requests admitted through `withJudgmentRequest`, including requests produced by chunked judging.

## Implementation Checklist

- [ ] Add lifecycle states to dispatch telemetry: `claimed`, `dispatchQueued`, `preparing`, `waitingForRequestSlot`, `liveRequest`, `persisting`, `completed`.
- [ ] Record per-state counts and age/duration summaries per `jobId` and `providerKey`.
- [ ] Define lifecycle ownership: claim code records `claimed`, dispatch runtime records `dispatchQueued`, prompt preparation records `preparing`, request runtime records `waitingForRequestSlot` and `liveRequest`, persistence records `persisting`, and terminal cleanup records `completed`.
- [ ] Add lifecycle cleanup for enqueue rejection, connection halt, worker shutdown, DuckDB owner demotion, prompt recovery, request failure, and persistence failure.
- [ ] Keep `withJudgmentRequest` as the only request admission point and the only place that updates request-level provider live counters.
- [ ] Use local in-process provider-scope live counters exposed through existing worker telemetry. Increment before the LLM request or probe starts, release in `finally`, and allow aggregate over-limit windows when workers race or operate independently.
- [ ] Make local provider live counters authoritative for sending requests. Do not subtract remote `globalLiveCalls` or `globalBacklog` from the local request target.
- [ ] Use global provider telemetry for display and bottleneck context: sum live and backlog counts across fresh workers by `providerKey`, but expose `providerActiveLimit` as the single effective provider target, not a sum of per-worker limits.
- [ ] Ignore stale worker telemetry using the existing owner-connection freshness/staleness signal for display and bottleneck classification so dead workers do not confuse the UI.
- [ ] Treat missing or slow remote telemetry as `telemetryUnavailable` for diagnostics, not as a reason to reduce local request admission.
- [ ] Keep a bounded claim batch size after the adaptive controller is in place. Remove fixed `16/64` behavior only after replacing it with a dynamic batch capped by a safe max transaction size.
- [ ] Add a provider/job backlog target computed from `effectiveProviderLimit`, `localLiveCalls`, `localBacklog`, active prompts, queued prompts, ready count, recent drain rate, endpoint availability, and current lifecycle ages. Use global telemetry only as diagnostic context.
- [ ] Claim more prompts when `localLiveCalls < effectiveProviderLimit`, ready work exists, endpoint state permits dispatch, and local backlog is below target.
- [ ] Stop claiming when local backlog is above target, local provider request slots appear saturated, endpoint state blocks dispatch, or completion persistence is backed up.
- [ ] Make prompt preparation concurrency dynamic instead of fixed at `16`.
- [ ] Bound preparation concurrency with a safe minimum/maximum so DB/CPU work cannot explode.
- [ ] Track prompts waiting for request slots separately from prompts doing preparation.
- [ ] Keep prompt/pipeline concurrency high enough to avoid underfeeding `withJudgmentRequest`, but never use prompt concurrency as the request cap.
- [ ] Add request-level accounting for chunked judging so one prompt that produces multiple LLM requests still consumes a provider request slot for each active request.
- [ ] Classify bottlenecks as `claiming`, `promptPreparation`, `requestSlotWait`, `providerSaturated`, `completionPersistence`, `endpointUnavailable`, or `noReadyWork`.
- [ ] Expose the bottleneck classification from the job detail API.
- [ ] Update `/admin/jobs/:id` to show the bottleneck state next to queue/request metrics.
- [ ] Make `Claimed`, `Running Prompts`, `Worker active prompts`, `Worker queued prompts`, and `Live LLM calls` use consistent lifecycle definitions based on `providerKey` and claim/request lifecycle state.
- [ ] Add tests for underfed provider, saturated provider, slow claim path, slow prep path, request-slot wait path, endpoint cooldown/misconfiguration, Anthropic warmup/effective cap behavior, multi-worker aggregate overshoot diagnostics, owner-backed judge-worker handoff, and lifecycle cleanup.

## Controller Rules

- [ ] Use `effectiveProviderLimit` for local scheduling decisions and display both saved and effective limits when they differ.
- [ ] If `readyCount > 0` and `localLiveCalls < effectiveProviderLimit`, increase target backlog until live calls rise or a bottleneck is identified.
- [ ] If `localLiveCalls >= effectiveProviderLimit * 0.9`, hold or reduce target backlog.
- [ ] If endpoint availability is `cooldown`, `misconfigured`, or `probing` with no eligible slot, classify `endpointUnavailable` and avoid increasing backlog.
- [ ] If `preparing` age grows while `localLiveCalls` is low, classify `promptPreparation`.
- [ ] If `waitingForRequestSlot` grows while `localLiveCalls` is near the effective limit, classify `providerSaturated`.
- [ ] If `waitingForRequestSlot` grows while `localLiveCalls` is low and endpoint state is healthy, classify `requestSlotWait`.
- [ ] If `persisting` age grows, classify `completionPersistence` and avoid claiming more backlog.
- [ ] If aggregate `globalLiveCalls` exceeds `effectiveProviderLimit`, show aggregate overshoot in diagnostics but do not lower local request admission from remote telemetry.
- [ ] Never change model, provider, thinking level, runtime model, or saved provider limit as part of scheduling.

## Success Criteria

- [ ] With ready work and provider limit `300`, local request-level `Live LLM calls` on an active judge worker converges toward `300` when the provider can accept it.
- [ ] Aggregate live requests across multiple judge workers are best-effort and may exceed the effective provider limit; overshoot is visible in diagnostics and should not cause local underfeeding.
- [ ] Local live requests for a provider normally stay at or below the effective provider limit on each worker; brief local over-limit windows from races are acceptable and should self-correct.
- [ ] If `Live LLM calls` cannot converge, the UI says which stage is limiting throughput.
- [ ] `Claimed` stays bounded by the adaptive backlog target.
- [ ] Fast GPUs do not drain to zero between scheduler ticks.
- [ ] Endpoint cooldown, misconfiguration, and warmup limits are shown as effective-cap or bottleneck reasons rather than scheduler underfeeding.
- [ ] Provider/model benchmark-critical settings are unchanged.

## Quality Gates

- [ ] `bun test src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM.test.ts`
- [ ] `bun test src/server/cron/judgmentsJobs/judgmentDispatchRuntime.test.ts`
- [ ] `bun test src/server/cron/judgmentsJobs/judgmentDispatchTelemetry.test.ts`
- [ ] `bun test src/server/cron/judgmentsJobs/judgmentsRequestRuntime.test.ts`
- [ ] Add or update targeted tests for provider-key aggregation, local live counter release on success/failure, stale or unavailable worker telemetry diagnostics, local admission ignoring remote telemetry, chunked judging request-slot accounting, and concurrent workers racing around the effective limit.
- [ ] `bun test src/server/routes/JudgmentsJobsRoutes.test.ts`
- [ ] `bun run lint`
- [ ] `bun run build` if admin UI metrics or shared UI code changes
- [ ] Browser verify `/admin/jobs/:id` during a running job
- [ ] Verify normal web flow; check desktop only if shared runtime paths or desktop-relevant wiring changes
