# Robust Send Plan

Status: complete and archived on 2026-05-13.

## Goal

Keep provider-wide request-level `Live LLM calls` close to, and normally at or below, the saved user-configured max-inflight limit for the relevant provider when ready work exists and that provider can accept it, without changing provider/model settings.

`maxInflightRequests` is a provider-bucket limit. It is not per worker, not per model, and not shared globally across unrelated providers. Normal request admission must acquire a provider-scoped shared request lease for the canonical `providerKey`. Local counters and remote worker telemetry are diagnostics and leak detection, not admission authority.

## Current Runtime Shape

- Provider-wide request admission is owner-backed through `app.provider_admission_lease` and the owner admission service in `src/server/cron/judgmentsJobs/providerAdmissionLease.ts`.
- Normal request leases and endpoint probe leases share the same provider-wide physical-call cap, but probe leases are reported separately from request-level `Live LLM calls`.
- Request attempts are id-based. Runtime request closeout uses exact `requestAttemptId`s through `markJudgmentRequestAttemptsPersisted(...)` and `markJudgmentRequestAttemptsClosed(...)`, not count-only closeout.
- Request-attempt lifecycle state is stored in existing surfaces, not in a new lifecycle table. Local jobs use `queue_prompt`; judge-worker claims use `accepted_claim`; completion evidence uses `judgment_outbox`, `completion_outbox`, `pending_token_use`, `completion_ack`, and `app.token_use.request_attempts_json`.
- The request-attempt manifest state machine supports `waitingForRequestSlot`, `liveRequest`, `persistingCompletion`, `completedRequest`, `closedRequest`, `telemetryUnavailable`, and `workerUnavailable`.
- Prompt lifecycle telemetry is separate from request-attempt lifecycle telemetry, so chunked judging and retries can account for multiple request attempts under one prompt.
- Canonical provider buckets are created by `providerKey.ts`; endpoint health/probe identity is created by `endpointAvailabilityKey.ts`.
- Owner-backed judge-worker runtime data carries resolved provider runtime and provider bucket snapshots before claim/execution, so judge-worker execution does not locally read DuckDB provider configuration.
- Provider target allocation snapshots, bottleneck classification, and adaptive backlog targets are implemented through `providerTargetAllocationSnapshot.ts`, `judgmentBacklogController.ts`, and `judgmentDispatchTelemetry.ts`.
- The job detail API and admin job UI expose lease-authoritative provider fields separately from observed/best-effort telemetry fields.
- Scheduling and recovery must never retry, downgrade, override, or mutate provider/model/thinking/runtime settings to chase throughput success.

## Implemented

- [x] Added focused live provider admission lease schema and rebuilt it with shape checks for request and probe leases.
- [x] Made owner admission the only writer for provider admission leases, with per-provider serialization and owner fencing.
- [x] Added idempotent acquire behavior for same-holder request/probe leases and stale provider-limit snapshot rejection for non-idempotent acquire.
- [x] Added holder-token-scoped heartbeat and release behavior so one run cannot delete or extend another run's lease.
- [x] Added stale/missing/demoted holder reconciliation, durable terminal request-attempt closeout release for request leases, and probe-only reconciliation paths.
- [x] Added provider bucket snapshots with `providerKey`, `providerLimit`, `providerLimitVersion`, default-capacity handling, and synthetic owner-backed provider ids.
- [x] Added canonical `providerKey` and `endpointAvailabilityKey` helpers covering saved connections, owner-backed synthetic buckets, Codex defaults, and provider-scoped non-Codex defaults.
- [x] Added request-attempt manifests, CAS/versioned manifest writes, repair markers, state transition validation, late-evidence conflict capture, and terminal manifest compaction.
- [x] Added exact request-attempt closeout fields across token-use, local judgment outbox, completion ack, completion outbox, and pending token-use paths.
- [x] Added request-attempt-aware pending token-use identity with `(job_id, queue_record_id, request_attempt_id)`.
- [x] Added token-use conflict validation that reloads existing rows and compares durable request-attempt evidence instead of relying only on duplicate insert suppression.
- [x] Added startup rollout cleanup and legacy completion-evidence repair/quarantine flows for rows that predate exact request-attempt evidence.
- [x] Added local and owner-backed replay/import logic that treats completion ack and imported token-use as exact closeout evidence.
- [x] Added no-request prompt terminal handling with explicit success reason such as `alreadyJudged` and non-success prompt closeout reasons.
- [x] Added request-slot waiter cancellation by exact request attempt for Codex, fallback, worker, and provider-admission waiters.
- [x] Added shared request/probe lease authority inside `withJudgmentRequest`; normal LLM calls acquire request leases and endpoint probes acquire probe leases.
- [x] Added endpoint probe telemetry and provider-level endpoint diagnostics without counting probes as normal request-level `Live LLM calls`.
- [x] Added provider target allocation snapshots with `providerAllocationVersion`, `providerProbeOccupancyVersion`, `normalRequestCapacity`, `targetRequestLiveCalls`, per-worker `expectedLocalLiveShare`, and `unallocatedTargetLiveCalls`.
- [x] Added adaptive prompt/request-work backlog targets, low-limit rounding, target/replenishment separation, stage-age diagnostics, and prompt preparation concurrency bounds.
- [x] Added bottleneck classification for `completionPersistence`, `endpointUnavailable`, `effectiveCapacityLimited`, `workerCapacitySaturated`, `fallbackCapacitySaturated`, `providerSaturated`, `providerAtTarget`, `promptPreparation`, `requestSlotWait`, `claiming`, and `noReadyWork`.
- [x] Added subreason/source metadata for bottleneck fields and tests that subreasons do not overlap primary bottleneck names.
- [x] Added job detail route, Eden types, and admin UI fields for lease-authoritative counts, observed aggregate counts, endpoint diagnostics, allocation state, and convergence diagnostics.
- [x] Added provider telemetry history sampling and chart support; that completed plan has been moved to `plans/old/@LIMIT_TELEMETRY_PLAN.md`.
- [x] Added targeted tests for provider admission leases, request runtime, request-attempt lifecycle, request-attempt persistence, request slot waiters, provider target allocation, dispatch telemetry, owner-backed rollout, legacy evidence repair, SQLite runtime schema, job routes, and admin job UI helpers.

## Implemented Shape Differences

- The implemented storage shape is DuckDB JSON for `app.token_use.request_attempts_json` and SQLite TEXT JSON for local/job journal tables. `app.token_use.request_attempts_json` is nullable so pre-plan rows remain representable.
- Canonical `providerKey` is carried through runtime snapshots, prompt payloads, request-attempt manifests, token-use/outbox payloads, and telemetry. Local `queue_prompt` and `accepted_claim` do not add a standalone `provider_key` column.
- The current implementation uses plain TypeScript async services and existing runtime wiring. Do not rewrite working code to `Effect` only for style; use `Effect` for future non-trivial async/server flows when it materially improves resource lifetime, retries, or failure handling.
- Some older checklist names were implementation placeholders. The current code uses `judgmentBacklogControllerConstants`, manifest CAS limits, `unavailableRequestAttemptRepairDeadlineMs`, completion replay backoff/grace constants, existing stale cleanup, and legacy repair flows rather than every originally named constant such as `requestAttemptRepairDeadlineMs` or `completionPersistenceRepairDeadlineMs`.
- The old plan language described several additions as future work. Those items are now implemented and the remaining work below is the current source of truth.

## Remaining Work

- [x] Run the full robust-send quality gate suite and record the current pass/fail baseline.
- [x] Do a manual multi-worker convergence smoke with a real provider bucket: ready work present, stable endpoint, positive provider limit, probe occupancy changes, provider-limit decrease drain-down, worker loss, and owner restart.
- [x] Decide whether explicit named repair-deadline constants are still useful for unavailable diagnostics and completion persistence, or whether the current cleanup/repair flows are the intended final shape. Current shape is intended: unavailable diagnostics use `unavailableRequestAttemptRepairDeadlineMs`; completion persistence uses `completionReplayFailureBackoffMs` plus `successCompletionTokenUseReplayGraceMs` rather than another repair-deadline constant.
- [x] Confirm `legacy:unknown` provider-key evidence remains repair-only and can never become schedulable new runtime state. Schedulable runtime keys come from `getProviderKey(...)`, provider bucket snapshots, and prompt runtime payloads; `legacy:unknown` appears only in legacy evidence repair/import paths.
- [x] Keep route/UI naming aligned whenever telemetry contracts change: lease-authoritative fields must stay distinct from observed/best-effort fields.
- [x] For future shared admin UI/API changes, verify both browser/web flow and desktop build.

## Validation Baseline

2026-05-13:

- Robust-send targeted test files listed under Quality Gates passed when run as isolated per-file `bun test <file>` commands. A single combined `bun test` invocation is not a reliable baseline because these files mutate process env and Bun module mocks.
- `bun run build` passed.
- `bunx eslint src/server/routes/JudgmentsJobsRoutes.test.ts src/server/cron/judgmentsJobs/judgmentJobSqliteService.test.ts src/server/cron/judgmentsJobs/judgmentOwnerBackedRollout.test.ts` passed for files touched during validation.
- `bun run lint` currently fails on unrelated pre-existing format/import issues in `judgmentJobSqliteService.ts`, `judgmentsJobsGetRunningJobs.ts`, `judgmentsJobsSendToLLM.ts`, and `judgmentJobDeleteService.test.ts`.
- `bun run db:mig` was skipped because no schema or migration behavior changed; the targeted route/SQLite tests exercised fresh DuckDB migrations repeatedly.
- `bun run desktop:build` was skipped because this pass changed tests and plan documentation only, not shared runtime, API, or admin UI implementation.
- Manual multi-worker convergence smoke was user-confirmed complete.

## Success Criteria

- [x] Normal request admission requires a provider-scoped shared request lease for the canonical provider bucket.
- [x] Request and probe leases cannot exceed provider-wide physical-call capacity outside explicit limit-decrease drain-down.
- [x] Existing calls drain naturally after provider limit decreases, and no new request/probe lease is admitted while the provider is at or above the new cap.
- [x] Local counters and observed remote telemetry do not grant admission without a successful shared lease acquire.
- [x] Request-attempt closeout is id-based across local SQLite, judge-worker journal, owner ack/import, and token-use evidence.
- [x] Worker loss and missing telemetry can reconcile attempts to `telemetryUnavailable` or `workerUnavailable` and later supersede those diagnostics with exact durable evidence.
- [x] Endpoint cooldown and misconfiguration classify as `endpointUnavailable`; non-endpoint zero capacity and warmup-style gates classify as `effectiveCapacityLimited`.
- [x] Provider/model benchmark-critical settings are not mutated by scheduling, retry, lease, telemetry, or recovery paths.
- [x] Stable multi-worker convergence has been manually verified under the real deployment shape, not only unit/route tests.

## Quality Gates

- `bun test src/server/cron/judgmentsJobs/providerAdmissionLease.test.ts`
- `bun test src/server/cron/judgmentsJobs/providerAdmissionLeaseFencing.test.ts`
- `bun test src/server/cron/judgmentsJobs/providerTargetAllocationSnapshot.test.ts`
- `bun test src/server/cron/judgmentsJobs/judgmentsRequestRuntime.test.ts`
- `bun test src/server/cron/judgmentsJobs/judgmentRequestAttemptLifecycle.test.ts`
- `bun test src/server/cron/judgmentsJobs/judgmentRequestAttemptPersistence.test.ts`
- `bun test src/server/cron/judgmentsJobs/judgmentRequestSlotWaiters.test.ts`
- `bun test src/server/cron/judgmentsJobs/judgmentPromptPreparationConcurrency.test.ts`
- `bun test src/server/cron/judgmentsJobs/judgmentDispatchTelemetry.test.ts`
- `bun test src/server/cron/judgmentsJobs/judgmentDispatchRuntime.test.ts`
- `bun test src/server/cron/judgmentsJobs/judgmentControllerTelemetry.test.ts`
- `bun test src/server/cron/judgmentsJobs/judgmentLegacyEvidenceRepair.test.ts`
- `bun test src/server/cron/judgmentsJobs/judgmentOwnerBackedRollout.test.ts`
- `bun test src/server/cron/judgmentsJobs/judgeWorkerCompletionJournal.test.ts`
- `bun test src/server/cron/judgmentsJobs/judgmentRuntimeSqliteSchema.test.ts`
- `bun test src/server/cron/judgmentsJobs/judgmentJobSqliteService.test.ts`
- `bun test src/server/cron/judgmentsJobs/judgmentJobSqliteOutboxImport.test.ts`
- `bun test src/server/cron/judgmentsJobs/judgmentJobLease.test.ts`
- `bun test src/server/cron/judgmentsJobs/judgmentJobSqliteClaimRace.test.ts`
- `bun test src/server/cron/judgmentsJobs/judgmentsJobsCleanupStale.test.ts`
- `bun test src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM.test.ts`
- `bun test src/server/cron/judgmentsJobs/judgmentsJobsAddToQueue.test.ts`
- `bun test src/server/cron/judgmentsJobs/judgmentsJobsGetRunningJobs.test.ts`
- `bun test src/server/cron/judgmentsJobs/getJudgmentsCapacity.test.ts`
- `bun test src/agent/judge/judgeStoreTokenUse.test.ts`
- `bun test src/server/routes/JudgmentsJobsRoutes.test.ts`
- `bun test src/server/routes/JudgmentsJobsRoutes.crashContainment.test.ts`
- `bun test src/server/routes/judgmentsJobsRoutesApiReadModel.test.ts`
- `bun test src/app/routes/+admin/+jobs/jobsPageShared.test.ts`
- `bun run db:mig` when schema or migration behavior is touched.
- `bun run lint`
- `bun run build`
- `bun run desktop:build` when shared runtime, API, or admin UI contracts are touched.
- Browser verify `/admin/jobs/:id` telemetry fields after shared UI/API changes.
- Manual multi-worker convergence smoke before considering this plan complete.

## Touched Layers

- server runtime
- database and SQLite journal schemas
- judge-worker owner-backed runtime
- admin job API and UI
- browser and desktop shared flows
