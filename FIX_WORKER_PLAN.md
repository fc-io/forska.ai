# Fix Worker Plan

## Goal

- Make judgmenting, SQLite backlog import, and review-index refresh continue to make forward progress even when memory gets tight.
- Keep low-memory systems slower but correct, instead of apparently healthy while queues stop draining.
- Let higher-memory systems process the same queues faster by scaling batch sizes, concurrency, and maintenance throughput.
- Remove the current failure mode where one constrained worker both keeps the app alive and prevents required maintenance from ever finishing.

## Problem Summary

Today the same writer path is responsible for three different kinds of work:

- live judging and prompt dispatch
- SQLite outbox import into DuckDB
- review-index refresh and rebuild work

Under tight memory, the system currently protects uptime by disabling or bypassing some heavy background work. That keeps the worker alive, but it creates a worse product failure:

- jobs can stay `running` while never refilling
- import backlog can remain stuck in SQLite
- review indexing can display `in progress` while nothing is actually consuming the queue

The system needs to guarantee eventual queue drain, not just process survival.

## Core Recommendation

Adopt the explicit long-term role split in one migration: `api`, `maintenance-worker`, and `judge-worker`.

Terms used in this plan:

- split deployment means `api`, `maintenance-worker`, and `judge-worker` run as separate processes, usually on separate ports; when `maintenance-worker` must adopt existing judgment-job SQLite state, the candidate processes must run on the same host and share the same data volume
- cutover release means the first shipped runtime that removes production dependence on `writer`, `auto`, and compatibility `worker`; it is not a special git branch requirement

Do not ship an intermediate production topology.

- testing-only harnesses and temporary local-development shims are acceptable while building the change
- the released runtime surface should complete the role, routing, env, and ownership migration in one go
- production should no longer rely on `writer`, `auto`, or compatibility `worker` roles after the cutover release

Recommended production topology:

- `api`
  - non-owner API surface
  - may open DuckDB in read-only mode for query, health, and diagnostics routes
  - serves product and operator status from shared persisted state even when no owner is active
  - proxies owner-only writes and owner-local operations to the active DuckDB owner
- `maintenance-worker`
  - sole DuckDB owner when `api`, `maintenance-worker`, and `judge-worker` run as separate processes
  - owns SQLite outbox import
  - owns review-index refresh
  - owns large rebuild work
  - owns archival cleanup and backlog draining
  - owns persisted worker-registry writes and queue-progress updates
  - owns owner-backed judgment-job control APIs for local SQLite and queue source-of-truth work
- `judge-worker`
  - does not own DuckDB
  - does not own local judgment-job SQLite state
  - obtains claim batches and dispatch snapshots through maintenance-owned APIs, including prompt and model or content-setting identity
  - executes LLM requests and posts completions through maintenance-owned APIs using that same claimed identity

Optional later split if needed:

- `import-worker`
- `review-index-worker`

Testing-only local mode:

- `dev-single`
  - may host combined capabilities for local verification and debugging
  - is not a production role or deployment target

The release should ship the end-state role model, not a compatibility bridge.

## Decision Summary

- persisted and user-facing writer or background-writer names should not survive the cutover release
- migrate `backgroundWriterDuckdbMemoryLimit`, `background_writer_duckdb_memory_limit`, local settings keys, `BACKGROUND_WRITER_PORT`, `BACKGROUND_WRITER_DUCKDB_MEMORY_LIMIT`, and related runtime-profile names to explicit maintenance-worker naming in the same cutover
- long-term routing should be explicit and capability-based, but the cutover must fail closed: keep `/api/*` owner-proxied by default until a route is audited and moved onto an explicit local-read allowlist
- local `api` reads should use a dedicated read-only DuckDB or query path; routes that still depend on owner-local side effects, local SQLite, or process-local snapshots stay owner-proxied
- queue `processing`, `activeConsumerCount`, and `activeWorkCount` should be derived from persisted claims or leases and their freshness, not from standalone increment or decrement counters
- cached counters may exist for diagnostics or performance, but they must never be the product source of truth
- `maintenance-worker` failover for SQLite-backed judgment work is same-host shared-volume only in the cutover release; cross-machine takeover without shared SQLite storage is out of scope
- shared worker registry, queue progress, and judgment-job SQLite health projection are part of the first cutover slice, not a later optional phase
- the cutover must include one-time migration of DuckDB-stored config and local `forska.settings.json` keys, plus simultaneous updates to runtime scripts, desktop readiness, and admin or client queries that still use writer-era names
- judgment dispatch claims, completion APIs, and shared projections must preserve the benchmark-critical tuple `promptId`, `modelId`, `useTitle`, `useAbstract`, `useFulltext`, `useFulltextNoImages`

## Product Fix

The product must stop presenting stalled backlog as generic progress.

### Current Wrong State

- `Review indexing in progress`
- queue counts visible
- no eligible worker actually draining them

### Required Product State Model

Replace vague status with explicit orthogonal fields:

- `progressState`
- `blockedReason`
- `requiredConsumerRole`
- `eligibleConsumerPresent`
- `activeConsumerCount`
- `activeWorkCount`
- `lastStartedAt`
- `lastProgressedAt`

Recommended `progressState` values:

- `processing`
- `queued`
- `blocked`
- `stalled`
- `failed`
- `repair_required`
- `completed`

Role-specific explanations belong in `blockedReason` and `requiredConsumerRole`, not in the state enum itself.

`processing` should require both an eligible consumer and active in-flight work. Do not infer it from queue depth alone.

### Required UI Copy

When no eligible maintenance worker is running, the UI should say something like:

- `Review indexing paused: waiting for maintenance worker`
- `Judgment backlog queued: waiting for maintenance worker`

Do not show `in progress` unless a consumer is both eligible and actively advancing the queue.

## Non-Negotiable System Rules

1. If a queue exists, there must always be an eligible consumer for it.
2. If no eligible consumer exists, surface that explicitly in health and UI.
3. Required backlog consumers must never be disabled forever by low-memory policy.
4. Heavy work must be chunked, resumable, and idempotent.
5. Memory pressure should reduce throughput, not correctness.
6. Bigger memory should increase throughput automatically without changing correctness semantics.
7. Cross-process health must come from shared persisted state, not local in-memory snapshots.
8. Non-owner roles must write through the active DuckDB owner.
9. Product and operator status routes must stay available without an active owner whenever shared persisted state is sufficient to answer them.

## Architecture Decisions

## DuckDB Ownership

In target deployments:

- `maintenance-worker` is the only role allowed to hold the DuckDB owner lease
- multiple `maintenance-worker` candidates may run, but only one may hold the active write lease at a time
- standby `maintenance-worker` processes should follow the shared owner lease and take over on missing or stale ownership only when they run on the same host and share access to the same judgment-job SQLite volume
- `api` may open DuckDB in read-only mode for query, health, and diagnostics routes, but it must never own the write lease
- `judge-worker` does not open DuckDB in write mode and must never own the write lease
- non-owner processes write through the active DuckDB owner HTTP/RPC surface

## One-Time Migration Requirements

This plan assumes the shipped runtime surface moves fully to the new names and roles.

- remove production support for `SERVER_ROLE=writer`, `SERVER_ROLE=auto`, and compatibility `SERVER_ROLE=worker`
- replace owner-routing config such as `SERVER_WRITER_URL` with an explicit owner name such as `SERVER_DUCKDB_OWNER_URL`, but keep steady-state owner discovery lease-driven; the env value is only a bootstrap hint or manual override, not the failover mechanism
- replace background worker env and runtime-profile names such as `BACKGROUND_WRITER_PORT` and `BACKGROUND_WRITER_DUCKDB_MEMORY_LIMIT` with maintenance-worker equivalents
- replace writer-named diagnostics and routing surfaces with owner or worker-registry naming
- replace writer-named lease artifacts such as `.writer.lock` and `.writer.history.json` with explicit DuckDB-owner names
- replace persisted and user-facing writer-era config such as `backgroundWriterDuckdbMemoryLimit`, `background_writer_duckdb_memory_limit`, and local settings keys with maintenance-worker naming, including a one-time DuckDB data migration and one-time rewrite of local `forska.settings.json` keys
- update package scripts, runtime-profile launchers, desktop backend startup and readiness checks, and admin or client queries to the final names in the same cutover so no shipped surface still depends on writer-era env or route names
- do not keep legacy writer or background-writer field names, env aliases, or public API aliases after the cutover release; if upgrade code reads legacy data during first startup, it must rewrite it to the final names immediately rather than keep a steady-state alias
- provide a one-time startup handoff so an existing writer lease can be adopted or cleanly replaced during the cutover release instead of requiring manual cleanup

Existing purpose of `auto` and `writer`:

- today they are the current multi-node owner-election model
- `auto` allows multiple similar server processes to observe the owner lease, follow while another owner is healthy, and promote on missing or stale ownership
- `writer` is the elected owner role that actually holds the DuckDB write lease and runs owner-side work

Target replacement for that behavior:

- explicit owner election moves from generic API processes to owner-eligible `maintenance-worker` processes
- multiple `api` processes may still run, but they remain non-owner followers and never silently become the DuckDB owner
- if high availability is needed, run more than one `maintenance-worker` candidate that shares the same data volume, with a single active lease and follower takeover semantics

## Routing Contract During Migration

Do not treat the new `api` role as a pure proxy immediately.

- start with proxy-by-default for `/api/*` on `api`
- classify every route as `owner-only`, `api-read-only`, or `hybrid`
- only `api-read-only` routes may be served locally on `api`, and only after they use the dedicated read-only query path and perform no owner-local side effects
- `hybrid` routes may keep the public route on `api`, but each owner-backed sub-operation must proxy explicitly to the active owner
- health, diagnostics, and product-truth routes must move off owner-local in-memory snapshots onto shared persisted state
- owner-only writes and owner-local operations should proxy to the active owner
- judgment-job control routes that touch local SQLite or queue source-of-truth state must proxy to maintenance-owned APIs even when the public route continues to live under `/api/judgmentsjobs/...`
- replace the current blanket `/api/*` owner proxy only after the route inventory, read-only query path, and explicit local-read allowlist are in place
- if no owner exists, owner-only routes should return an explicit owner-unavailable or waiting-for-maintenance response, not a generic transport `502` where a product-state answer is possible

## Read-Only Query Path

Add an explicit read-only DuckDB and query path for audited `api` routes.

- local reads on `api` should use dedicated read-only helpers instead of the current owner-capable `getAppDatabaseService()` path
- a route must stay owner-proxied if it still depends on local SQLite, owner-side maintenance triggers, or process-local runtime snapshots
- route classification should fail closed so new or unclassified routes do not accidentally start running locally on `api`
- early local-read candidates are diagnostics, registry, and health routes after their shared persisted state exists; current mixed routes like review warnings and judgment-job health stay owner-proxied until they stop reading owner-local state

## Effect Control Flow

Use the `Effect` library as the default control-flow model for the new worker split.

- use `Effect.gen` for multi-step owner-routing, claim, import, repair, and completion flows
- use `Layer` and `Context` for owner-backed clients, worker-registry access, queue-progress writes, and judgment-job SQLite health projection services
- use `Schedule` for heartbeats, retries, lease-follow polling, takeover checks, and stall detection windows
- use `Effect.acquireRelease` and `Scope` for DuckDB ownership, SQLite leases, child-process maintenance work, and long-lived worker loops
- keep only tiny pure transforms outside `Effect`; avoid ad hoc promise chains for new split-role control flow

## Shared Worker Presence And Queue Progress

Add a persisted worker registry and queue-progress source of truth.

- store worker heartbeats in DuckDB, for example with fields like `instanceId`, `role`, `capabilities`, `memoryLimit`, `throughputProfile`, and `lastHeartbeatAt`
- have every process heartbeat through the active DuckDB owner so the registry remains authoritative
- persist `lastStartedAt` per backlog type when a consumer actually begins a batch
- persist `lastProgressedAt` per backlog type when a batch actually completes
- persist per-backlog claim or lease rows with worker identity, consumer role, work scope, `startedAt`, `heartbeatAt` or `expiresAt`, and `lastProgressedAt` where relevant
- derive `activeConsumerCount` and `activeWorkCount` from non-stale claim or lease rows instead of treating standalone counters as truth
- keep process-local snapshots only for debugging and operator drill-down, not for product health decisions

## Persisted Active Work Model

Use persisted claims and leases as the source of truth for queue activity.

- project refresh and large rebuild work should write claims directly in DuckDB
- judgment prompt execution and SQLite outbox import already use persisted local SQLite claims today; `maintenance-worker` should project the claim summaries and freshness needed for shared health into DuckDB
- `processing` should require fresh worker presence plus at least one fresh claim or lease for the relevant backlog
- queue-level counters may exist as derived debug views, but stale or crashed work must be cleared by claim freshness rules, not by assuming a matching decrement always happened

## Shared SQLite Health Projection

Add a persisted judgment-job SQLite health projection so `api` can answer health honestly without local SQLite ownership.

- have `maintenance-worker` write lightweight judgment-job SQLite health snapshots into DuckDB through owner-side writes
- project at least retained outbox counts, claimed outbox counts, ready or claimed or running prompt counts, orphaned judged counts, WAL bytes, import timestamps and errors, local claim freshness, lease metadata, recovery mode, and projection freshness
- make `/api/judgmentsjobs/:id/health` and `/api/judgmentsjobs-health` read this shared projection first
- if the projection is missing or too stale to trust, proxy to the active owner or return an explicit maintenance-unavailable response; do not guess from missing local state

## Judgment Claim Identity

Preserve benchmark-critical judgment identity across the split.

- every maintenance-issued judgment claim, dispatch snapshot, completion payload, and shared progress row must carry `jobId`, `projectId`, `promptId`, `modelId`, `useTitle`, `useAbstract`, `useFulltext`, and `useFulltextNoImages`
- maintenance-owned completion bookkeeping must validate completions against the claimed tuple before mutating queue source-of-truth state
- shared health, progress, and diagnostics projections must preserve or derive this tuple wherever queue truth depends on it; do not coalesce incompatible model or content settings into one generic backlog

## Queue Ownership

### Production Roles

#### `maintenance-worker`

Owns:

- DuckDB owner lease
- SQLite retained backlog import into DuckDB
- project mart refresh queues
- large rebuild queues
- heavy archival cleanup
- persisted worker-registry writes
- queue-progress updates
- queue insertion and claim persistence for judgment work
- local judgment-job SQLite state, leases, import, and repair
- owner-backed judgment-job control routes for `start`, `pause`, `start-clean`, `preflight`, `drain`, `checkpoint`, `repair`, `quarantine`, `unquarantine`, and `delete`
- persisted judgment-job SQLite health projection writes

#### `api`

Owns:

- public API surface
- read-only query, health, and diagnostics routes
- proxying owner-only writes and owner-local operations to the active DuckDB owner
- front-door routing for judgment-job mutations that must execute on `maintenance-worker`

#### `judge-worker`

Owns:

- LLM execution
- dispatch execution against claim batches issued by maintenance-owned APIs
- completion submission back to maintenance-owned APIs without direct DuckDB access

Does not own:

- local judgment-job SQLite state
- judgment-job mutation routes that touch local SQLite or queue source-of-truth state
- SQLite retained backlog import into DuckDB
- project mart refresh queues
- large rebuild queues
- heavy archival cleanup

Final split boundary:

- `maintenance-worker` remains the control plane for claim persistence, SQLite leases, outbox import, and repair
- `maintenance-worker` remains the control plane for judgment-job mutation routes that touch local SQLite or queue source-of-truth state
- `judge-worker` is the execution plane for LLM work and should not mutate queue source-of-truth state directly

## Memory-Adaptive Behavior

The system should not use one binary behavior like `enabled` vs `disabled` for required maintenance.

Instead, each worker role should use adaptive throughput.

### Low Memory

Expected behavior:

- fewer threads
- smaller import batches
- fewer rebuild cycles per wake
- one claim at a time where needed
- slower progress, but guaranteed progress
- isolated child-process execution for the heaviest maintenance tasks when appropriate

### Higher Memory

Expected behavior:

- larger import batches
- more rebuild work per wake
- higher claim concurrency
- more aggressive queue draining
- faster refresh completion

### Rule

Memory pressure should scale throughput down, not disable required consumers.

## Required Product And API Changes

## Health And Status Semantics

Add explicit status fields for each backlog type.

For every backlog, expose the same semantics even if route-specific field names differ:

- `requiredConsumerRole`
- `eligibleConsumerPresent`
- `eligibleConsumerCount`
- `activeConsumerCount`
- `activeWorkCount`
- `lastStartedAt`
- `lastProgressedAt`
- `progressState`
- `blockedReason`

### Example `progressState`

- `processing`
- `queued`
- `blocked`
- `stalled`
- `failed`
- `repair_required`
- `completed`

### Example `blockedReason`

- `waiting_for_maintenance_worker`
- `paused_by_policy`
- `duckdb_memory_throttled`
- `offline_repair_required`
- `provider_unavailable`
- `quarantined_local_state`

Keep the state model flat and reusable. Do not encode role-specific text into `progressState`.

## Judgment Job Control And Health Contract

- keep public judgment-job routes stable where that reduces client churn, but route all SQLite-affecting mutations through maintenance-owned APIs
- this includes `PATCH /api/judgmentsjobs/:id`, `POST /api/judgmentsjobs/:id/start-clean`, `POST /api/judgmentsjobs/:id/preflight`, `POST /api/judgmentsjobs/:id/drain`, `POST /api/judgmentsjobs/:id/checkpoint`, `POST /api/judgmentsjobs/:id/repair`, `POST /api/judgmentsjobs/:id/quarantine`, `POST /api/judgmentsjobs/:id/unquarantine`, and `DELETE /api/judgmentsjobs/:id`
- make `/api/judgmentsjobs/:id/health` and `/api/judgmentsjobs-health` read the shared SQLite health projection when that data is fresh enough
- when shared projection is not sufficient, proxy to the active owner or return an explicit waiting-for-maintenance or owner-unavailable response

## Routing And Diagnostics

Diagnostics should show:

- active worker role
- configured worker role
- whether the current process owns DuckDB
- whether the current route is being served locally or proxied to the owner when relevant
- current-process capabilities
- registry view of active workers by capability
- configured memory limit
- active adaptive throughput profile
- whether any active worker is eligible to consume import backlog
- whether any active worker is eligible to consume review refresh backlog
- last progress timestamp per queue
- last started timestamp per queue
- active work counts per queue
- queue-level batch sizes and current caps

## Release Policy

The phases below describe build order, not separate production rollouts.

- implement and verify the phases in order where that helps reduce engineering risk
- do not stop at a compatibility midpoint in production
- cut over production only after the explicit role split, owner election, judge-worker path, status semantics, and naming migration are complete
- do not cut over production until the shared worker registry, queue progress state, and judgment-job SQLite health projection exist for the routes that `api` must answer without owner-local state
- local and staging environments may use temporary test harnesses while validating the in-progress change, but the shipped runtime surface should already be the final one

## Implementation Plan

## Phase 1. Replace Roles And Ownership With The Final Runtime Surface

Layers:

- server
- docs

Changes:

- Replace production `writer`, `auto`, and compatibility `worker` roles with explicit `maintenance-worker`, `judge-worker`, and `api` roles.
- Define central capability helpers instead of ad hoc `if role === ...` checks.
- Make the active DuckDB owner explicit in startup and proxy routing.
- Complete the owner-naming migration for env vars, runtime profiles, persisted config, local settings, diagnostics, routes, and lease artifacts.
- Add explicit route classification for `owner-only`, `api-read-only`, and `hybrid` behavior.
- Keep `/api/*` proxying fail-closed by default until a route is moved onto the audited local-read allowlist.
- Add a dedicated read-only DuckDB and query path for audited `api` routes.
- Replace `writer_connections` naming in diagnostics, readiness, and desktop startup with owner or worker-registry naming.
- Keep owner discovery lease-driven after startup; treat any explicit owner URL env as bootstrap-only.
- Add role diagnostics to the worker runtime endpoint.
- Land this phase in the same cutover slice as the shared worker registry, queue progress state, and SQLite health projection so `api` can answer health honestly after routing changes.

Practical next steps:

1. Add a role capability map.
2. Define owner-specific helpers such as:
   - DuckDB owner eligibility
   - maintenance eligibility
   - judging eligibility
   - API proxy-to-owner eligibility
3. Add a route inventory with explicit `owner-only`, `api-read-only`, and `hybrid` classification.
4. Keep API routing proxy-by-default and introduce an explicit local-read allowlist that fails closed for unclassified routes.
5. Add a dedicated read-only DuckDB and query path for audited `api` routes.
6. Replace writer-named env, runtime-profile, persisted-config, route, lease, readiness, and desktop-startup surfaces with owner or maintenance-worker naming.
7. Move mixed read or write status routes off local snapshots and owner-side effects before taking them off the owner proxy.
8. Preserve lease election and follower takeover by moving it onto `maintenance-worker` candidates that share the same data volume when SQLite-backed judgment work must survive takeover.
9. Update background startup registration, local stack scripts, and desktop readiness checks to use capability checks and final role names.
10. Express startup role monitoring, owner routing, and takeover polling with `Effect` services rather than ad hoc promise chains.
11. Add docs for how to run:
    - API plus `maintenance-worker` plus `judge-worker`
    - API plus redundant same-host `maintenance-worker` candidates sharing the data volume for failover testing

Quality Gates:

- `bun test src/server/utils/startBackgroundWork.test.ts src/server/utils/backgroundServerStack.test.ts`
- `bun test src/server/routes/AdminInvestigateRoutes.test.ts src/server/routes/ApiProxyRoutes.test.ts src/server/indexStartup.test.ts`
- `bun test scripts/runWithRuntimeProfile.test.ts`
- `bun test src/utils/runtimeProfile.test.ts`
- `bun test src/server/utils/writerConnections.test.ts`
- `bun x eslint src/server/utils/serverRole.ts src/server/utils/serverRuntimeRole.ts src/server/utils/env.ts src/server/serverMain.ts src/server/utils/startBackgroundWork.ts src/server/utils/backgroundServerStack.ts src/server/services/userConfigQueryService.ts src/server/routes/UsersRoutes.ts src/server/utils/localAppSettings.ts src/utils/runtimeProfile.ts scripts/runWithRuntimeProfile.ts scripts/startServerStack.ts`
- `bun run desktop:build`

## Phase 2. Add Shared Worker Presence And Queue Progress State

Layers:

- server
- database
- docs

Changes:

- Add a persisted worker registry and heartbeat model in DuckDB.
- Have every process heartbeat role, capabilities, memory limit, and throughput profile through the active owner.
- Persist queue-level `lastStartedAt` when batches actually begin.
- Persist queue-level `lastProgressedAt` when batches actually complete.
- Persist per-backlog claim or lease rows and derive active consumer and work counts from their freshness, preserving the benchmark-critical judgment config tuple where applicable.
- Persist a judgment-job SQLite health projection that `api` can read without local SQLite ownership.
- Make health routes read shared registry and progress state rather than process-local snapshots.

Practical next steps:

1. Add DuckDB schema for worker heartbeats, queue progress, per-backlog claim or lease state, and judgment-job SQLite health or claim projection.
2. Add heartbeat writes and stale-worker pruning.
3. Update queue consumers to create claims or leases when work starts, refresh them while active, and stamp progress on successful batch completion.
4. Add maintenance-owned writes for judgment-job SQLite health and claim projection refresh, including prompt, model, and content-setting identity where queue truth depends on it.
5. Add registry queries for eligible maintenance consumers by capability.

Quality Gates:

- `bun run db:mig`
- `bun test src/server/routes/AdminInvestigateRoutes.test.ts`
- `bun test src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.test.ts`
- `bun test src/server/routes/JudgmentsJobsRoutes.test.ts`
- `bun x eslint src/server/routes/AdminInvestigateRoutes.ts src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.ts src/server/routes/JudgmentsJobsRoutes.ts`

## Phase 3. Make Health And UI Honest

Layers:

- server
- client

Changes:

- Add explicit queue-consumer state to project warnings and job health APIs.
- Replace `in progress` copy when no eligible consumer is present.
- Use shared worker and queue state as the source of truth.
- Surface `waiting_for_maintenance_worker` clearly.
- Keep those status routes locally answerable on `api` from audited read-only/shared state even when no owner is active.

Practical next steps:

1. Extend review warnings API with queue consumer state.
2. Extend judgment job health API with consumer-role and last-progress fields.
3. Update all affected review UI messaging for:
   - active processing
   - queued
   - blocked
   - stalled
   - repair required
4. Add explicit timestamps in UI for latest queue progress.

Quality Gates:

- `bun test src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.test.ts`
- `bun test src/server/routes/JudgmentsJobsRoutes.test.ts`
- `bun run build`
- `bun run desktop:build`
- Browser verification:
  - review warning shows `waiting for maintenance worker` when appropriate
  - judgment job page does not show false `in progress`
  - review empty states distinguish blocked from stale

## Phase 4. Complete The `judge-worker` Split

Layers:

- server
- docs

Changes:

- Introduce the non-owner `judge-worker` role.
- Keep local judgment-job SQLite state, SQLite leases, import, repair, queue insertion, and claim persistence on `maintenance-worker`.
- Add owner-backed dispatch, completion, and judgment-job control APIs so `judge-worker` can run without direct DuckDB writes or direct SQLite ownership.
- Make dispatch claim, completion, and shared-projection contracts carry `promptId`, `modelId`, `useTitle`, `useAbstract`, `useFulltext`, and `useFulltextNoImages` as part of judgment work identity.
- Move LLM execution onto `judge-worker` while keeping queue source-of-truth mutations owner-backed.
- Remove production code paths that expect combined judging plus maintenance roles.

Practical next steps:

1. Add owner-backed APIs or RPC methods for dispatch snapshot reads, completion bookkeeping, lease sync, and judgment-job control operations, carrying the benchmark-critical judgment config tuple.
2. Move `PATCH /api/judgmentsjobs/:id`, `POST /api/judgmentsjobs/:id/start-clean`, `POST /api/judgmentsjobs/:id/preflight`, `POST /api/judgmentsjobs/:id/drain`, `POST /api/judgmentsjobs/:id/checkpoint`, `POST /api/judgmentsjobs/:id/repair`, `POST /api/judgmentsjobs/:id/quarantine`, `POST /api/judgmentsjobs/:id/unquarantine`, and `DELETE /api/judgmentsjobs/:id` behind maintenance-owned handlers, even if the public route stays stable.
3. Keep claim persistence and local SQLite ownership on `maintenance-worker` while `judge-worker` consumes owner-issued claim batches and completion bookkeeping validates the claimed tuple before applying source-of-truth updates.
4. Keep `runAddToQueue` on `maintenance-worker` and move `sendToLLM` onto `judge-worker` behind judging capability helpers.
5. Ensure `judge-worker` never opens DuckDB in write mode and never mutates local judgment-job SQLite state directly.
6. Keep judgment-job health readable from shared projection on `api`, with owner-proxy fallback when projection freshness is insufficient.
7. Express dispatch, completion, and control-plane flows with `Effect.gen`, `Layer`, and `Schedule`.
8. Remove combined-role startup and routing paths from the shipped runtime surface.

Quality Gates:

- `bun test src/server/routes/ApiProxyRoutes.test.ts`
- `bun test src/server/routes/JudgmentsJobsRoutes.test.ts`
- `bun test src/server/indexStartup.test.ts`
- `bun x eslint src/server/cron/judgmentsJobs.ts src/server/routes/JudgmentsJobsRoutes.ts src/server/serverMain.ts`

## Phase 5. Make Maintenance Queues Always Consumable

Layers:

- server
- docs

Changes:

- Replace current low-memory `disable` logic for required maintenance with adaptive throttling.
- Keep import and refresh consumers eligible even at low memory.
- Constrain them to smaller work units instead of turning them off.
- Keep the option to use isolated child processes for import and refresh batches.

Practical next steps:

1. Add shared adaptive throughput profiles derived from the active DuckDB memory cap.
2. Define per-profile values for:
   - import batch rows
   - import batch bytes
   - rebuild batch size
   - max cycles per wake
   - refresh claim concurrency
3. Apply those profiles to:
   - SQLite outbox import
   - project refresh claim loops
   - large rebuild loops
4. Ensure every loop can continue with `small` profile settings.

Quality Gates:

- `bun test src/server/utils/projectMartLargeRebuildHeartbeat.test.ts`
- `bun test src/server/workers/projectMartRefreshWorker.test.ts src/server/services/projectMartLargeRebuildRunner.test.ts`
- `bun test src/server/cron/judgmentsJobs/judgmentJobSqliteOutboxImport.test.ts`
- `bun x eslint src/server/utils/projectMartLargeRebuildTuning.ts src/server/workers/projectMartRefreshWorker.ts src/server/cron/judgmentsJobs/judgmentJobSqliteOutboxImport.ts`

## Phase 6. Separate Repair From Normal Drain

Layers:

- server
- docs

Changes:

- Keep normal maintenance drain lightweight and automatic.
- Keep repair logic explicit and resumable.
- Add a maintenance-worker-safe auto-recovery loop for small retained backlog.
- Reserve full offline repair for larger or repeated failure cases.

Practical next steps:

1. Define thresholds for:
   - safe live import retry
   - maintenance-worker auto-repair
   - offline repair required
2. Record recovery mode in health responses.
3. Teach maintenance-worker to auto-run small safe repair operations.
4. Preserve offline repair for larger retained backlog and repeated append OOM.

Quality Gates:

- `bun test src/server/cron/judgmentsJobs/judgmentJobRepair.test.ts`
- `bun test src/server/routes/JudgmentsJobsRoutes.test.ts`
- `bun x eslint src/server/cron/judgmentsJobs/judgmentJobRepair.ts src/server/routes/JudgmentsJobsRoutes.ts`

## Phase 7. Add Queue Progress SLAs And Stall Detection

Layers:

- server
- client

Changes:

- Track queue-level `lastProgressedAt` for:
  - judgment import backlog
  - article refresh backlog
  - project refresh backlog
  - rebuild backlog
- Track queue-level `lastStartedAt` and active-work counters for those same backlogs.
- Compute stalled state from:
  - queue depth
  - active work presence
  - last progress age
  - eligible consumer presence

Practical next steps:

1. Add health rules for stale drain windows.
2. Update UI to show `stalled` only when a consumer should be progressing but is not.
3. Keep `blocked` separate from `stalled`.
4. Add explicit operator thresholds for acceptable queue delay by backlog type.

Quality Gates:

- `bun test src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.test.ts`
- `bun test src/server/routes/JudgmentsJobsRoutes.test.ts`
- `bun run build`
- `bun run desktop:build`

## Phase 8. Optimize High-Memory Fast Path

Layers:

- server

Changes:

- Once correctness is guaranteed under low memory, scale up throughput under higher memory.
- Keep the same queue semantics while increasing:
  - batch sizes
  - cycles per wake
  - concurrency

Practical next steps:

1. Add profile tiers such as:
   - `small`
   - `medium`
   - `large`
2. Tune maintenance-worker profiles separately from judge-worker profiles.
3. Keep diagnostics explicit about which profile is active.
4. Validate that profile changes only affect throughput, not correctness.

Quality Gates:

- `bun test src/server/utils/projectMartLargeRebuildHeartbeat.test.ts`
- `bun test src/server/utils/duckdbServiceMemoryLimit.test.ts`
- `bun x eslint src/server/utils/projectMartLargeRebuildTuning.ts src/server/utils/duckdbService.ts`

## Rollout Order

Recommended order:

1. role capability map and explicit owner semantics
2. owner-backed judgment dispatch and explicit `judge-worker` split
3. shared worker registry and persisted queue progress
4. honest health and UI states
5. adaptive maintenance throttling instead of disablement
6. stall detection and SLAs
7. auto-repair thresholds
8. high-memory throughput optimization

This order matters because the final role split and owner election need to exist before the health model can describe them accurately, and throughput tuning should not start before correctness is guaranteed under the shipped topology.

## Operational Model After Implementation

### Low-Memory Single Machine

- a single `maintenance-worker` plus `judge-worker` pair can still run slowly on one machine
- queues continue to drain slowly but correctly
- UI says `processing`, `queued`, or `blocked`, never fake `in progress`

### Mixed-Memory Setup

- low-memory `judge-worker` handles LLM dispatch work safely after Phase 4
- higher-memory `maintenance-worker` drains import and review backlog faster
- no cross-role ambiguity about who owns backlog queues

### High-Memory Single Machine

- one machine may still host all long-term roles, but as separate `api`, `maintenance-worker`, and `judge-worker` processes
- adaptive profile scales up automatically
- throughput improves without changing queue correctness guarantees

## Risks

- adding roles without shared worker state will still confuse operators
- making maintenance adaptive but not resumable will just create slower failure loops
- auto-repair without thresholds can interfere with valid paused states
- stale worker heartbeats can create ghost-capacity signals if cleanup is weak
- scaling high-memory fast paths too early can reintroduce OOM instability

## Success Criteria

The system is fixed when all of these are true:

1. Review-index backlog never depends on a low-memory judge-only worker to drain.
2. Required maintenance queues always have an eligible consumer or an explicit blocked state.
3. Cross-process health answers come from shared persisted state, not whichever process handled the request.
4. Low-memory systems continue to make progress, even if slowly.
5. Higher-memory systems drain the same queues faster without special-case behavior.
6. UI and API no longer claim generic progress when no worker is actually draining the queue.

## Practical Next Step To Start Implementation

Start with Phase 1, Phase 2, and Phase 4 together, and include the server-contract work from Phase 3 in the same cutover slice.

Why:

- Phase 1 fixes the final runtime surface and naming.
- Phase 2 gives `api` a shared worker registry, queue progress source of truth, and SQLite health projection so status routes stay honest after the role split.
- the server-contract work from Phase 3 makes review warnings and judgment health describe the real shared state instead of owner-local snapshots.
- Phase 4 makes the long-term `judge-worker` path real instead of leaving a combined-role gap.

Suggested first implementation slice:

1. replace production roles with explicit `api`, `maintenance-worker`, and `judge-worker`
2. add explicit route classification plus proxy-by-default safety with an audited local-read allowlist
3. add the dedicated read-only query path for audited `api` routes
4. migrate writer-named env, runtime-profile, persisted-config, local-settings, route, and lease surfaces to owner or maintenance-worker naming, including one-time DuckDB and local settings rewrite
5. add persisted worker heartbeat, queue progress, and shared SQLite health projection
6. expose local capabilities and registry-derived eligible consumers in diagnostics
7. extend review warnings and judgment-job health APIs so they answer from shared or read-only state and report honest consumer semantics
8. add owner-backed judging APIs that preserve the benchmark-critical judgment config tuple and move `sendToLLM` onto `judge-worker`

That is the smallest useful step that creates the actual end-state topology instead of a temporary bridge or a role split that still depends on owner-local health.

## First Coding Slice Task List

This section turns the first implementation slice into an actual change list.

## Step 1. Extend Server Roles And Add Capability Helpers

Primary files:

- `src/server/utils/serverRole.ts`
- `src/server/utils/serverRuntimeRole.ts`
- `src/server/utils/env.ts`
- `src/server/utils/backgroundServerStack.ts`
- `src/server/services/userConfigQueryService.ts`
- `src/server/routes/UsersRoutes.ts`
- `src/server/utils/localAppSettings.ts`
- `src/utils/runtimeProfile.ts`

Changes:

- Add `maintenance-worker` to `serverRoles`.
- Add `judge-worker` to `serverRoles`.
- Remove production `writer`, `auto`, and `worker` role support.
- Keep `dev-single` only as a local testing role if still needed.
- Rename writer or background-writer env, runtime-profile, persisted-config, and local-settings names to maintenance-worker naming through one-time DuckDB and local `forska.settings.json` migration, without keeping public legacy aliases after upgrade.
- Replace the current coarse helpers with capability helpers, for example:
  - `canServerRoleOwnDuckdb(...)`
  - `shouldServerRoleRunMaintenance(...)`
  - `shouldServerRoleRunJudging(...)`
  - `shouldServerRoleProxyApiToDuckdbOwner(...)`
- Keep `api` and future `judge-worker` style roles from accidentally claiming owner-only work.

Why these files first:

- `serverRole.ts` is currently the single place where runtime role semantics are encoded.
- `serverRuntimeRole.ts` already exposes the live effective role used by diagnostics and startup.
- the env, runtime-profile, and stored config files are the current source of writer-era naming that must disappear in the same cutover

Acceptance criteria:

- role helpers express capabilities, not just owner vs not-owner
- production startup supports only the final explicit roles
- persisted and user-facing maintenance memory settings use the final maintenance-worker naming only
- DuckDB owner election works on `maintenance-worker` candidates, and SQLite-backed judgment takeover is explicitly limited to candidates that run on the same host and share the same data volume

## Step 2. Split Background Startup And Owner Routing By Capability

Primary files:

- `src/server/utils/startBackgroundWork.ts`
- `src/server/utils/martRefreshDrainHeartbeat.ts`
- `src/server/serverMain.ts`
- `src/server/utils/backgroundServerStack.ts`
- `src/server/routes/ApiProxyRoutes.ts`

Changes:

- Change `startBackgroundWork()` so it starts different loops by capability.
- Keep runtime role monitor and owner-heartbeat infrastructure shared.
- Start mart refresh drain only when maintenance capability is true.
- Stop relying on one coarse owner gate for all crons.
- Add explicit route classification and keep `/api/*` proxy-by-default until routes are audited for local-read safety.
- Introduce the dedicated read-only query path used by local `api` reads.
- Keep `api` serving read-only health and diagnostics locally while proxying owner-only routes to the active DuckDB owner.
- Preserve lease-follow and takeover behavior on explicit `maintenance-worker` candidates that run on the same host and share the data volume needed for SQLite-backed judgment work.

Current extension points already confirmed:

- `startBackgroundWork()` currently starts `startMartRefreshDrainHeartbeat()` unconditionally.
- `serverMain.ts` currently mounts multiple cron bundles through one `writerCronRoutes` gate.

Acceptance criteria:

- a `maintenance-worker` process can start as the DuckDB owner
- a `judge-worker` process can start without DuckDB write ownership
- unclassified `api` routes fail closed to owner proxy instead of accidentally running locally
- `api` still proxies correctly to the active owner for owner-only routes
- health and diagnostics routes remain answerable on `api` without requiring owner-local runtime state
- standby same-host `maintenance-worker` candidates sharing the data volume can follow and take over correctly

## Step 3. Add Persisted Worker Heartbeat And Capability Registry

Primary files:

- new worker-registry persistence code under `src/server/utils/` or `src/server/services/`
- renamed worker-registry route replacing `src/server/routes/WriterConnectionsRoutes.ts`
- `src/server/routes/AdminInvestigateRoutes.ts`
- `src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.ts`
- `src/server/routes/JudgmentsJobsRoutes.ts`

Changes:

- Add durable worker heartbeat records for role, capabilities, memory limit, throughput profile, and last heartbeat.
- Have API, maintenance, and future judge processes heartbeat through the owner API.
- Add registry queries for eligible maintenance consumers.
- Persist queue-level claim or lease rows for import and refresh work, including claim freshness and the benchmark-critical judgment config tuple where applicable.
- Persist queue-level `lastProgressedAt` for import and refresh work.

Acceptance criteria:

- health routes can tell when no maintenance worker exists even if the handling process is not the owner
- `processing` derives from fresh claims or leases, not queue depth or orphaned counters
- stale worker records and stale claims age out cleanly and do not create ghost capacity

## Step 4. Expose Local Capabilities And Registry State In Diagnostics

Primary files:

- `src/server/routes/AdminInvestigateRoutes.ts`
- `src/server/routes/AdminInvestigateRoutes.test.ts`

Changes:

- Extend `/api/admin/worker-runtime-diagnostics` to return:
  - local `role`
  - local `serverRole`
  - local `capabilities`
  - whether the current process owns DuckDB
  - whether key status routes are served locally or owner-proxied
  - registry-derived eligible consumers by capability
  - active adaptive profile or queue policy if derivable

Acceptance criteria:

- diagnostics clearly show both current-process intent and shared worker availability
- tests cover the new diagnostics payload shape

## Step 5. Make Review Warning API And All Review UIs Honest

Primary files:

- `src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.ts`
- `src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.test.ts`
- `src/components/main/reviews/reviewsWarningsQuery.ts`
- `src/components/main/reviews/reviewsProjectWarnings.tsx`
- `src/components/main/reviews/reviewsIndexingProgress.tsx`
- `src/components/main/reviews/reviewsArticlesTable/reviewsArticlesTableContainer.tsx`
- `src/components/main/reviews/reviewsArticlesTable/reviewsArticlesUnassessedTableContainer.tsx`

Changes:

- Extend `/api/projectsreviewswarnings` with fields such as:
  - `requiredConsumerRole`
  - `eligibleConsumerPresent`
  - `activeConsumerCount`
  - `activeWorkCount`
  - `progressState`
  - `blockedReason`
  - `lastStartedAt`
  - `lastProgressedAt`
- Keep current counts (`pendingProjectRefreshCount`, `pendingArticleRefreshCount`) intact.
- Stop mapping `pendingRefreshCount > 0` directly to `status = 'refreshing'` when no eligible consumer exists.
- Update all review UI consumers so blocked queues render as blocked, not generic refresh or empty states.

Current bug source already confirmed:

- `projectsRoutesGetReviewsWarnings.ts` derives `status = 'refreshing'` from queue counts
- it does not know whether any role is actually eligible to drain those queues

Acceptance criteria:

- no review UI says `in progress` when no eligible maintenance worker is running
- review empty states distinguish blocked, stale, and actively processing states
- tests cover the blocked and waiting status
- the API route can still answer from shared/read-only state when the owner is absent after it has been moved onto the audited local-read path

## Step 6. Make Judgment Job Health Honest About Import Ownership And SQLite State

Primary files:

- `src/server/routes/JudgmentsJobsRoutes.ts`
- `src/server/routes/JudgmentsJobsRoutes.test.ts`

Changes:

- Extend `/api/judgmentsjobs/:id/health` with:
  - `eligibleImportConsumerPresent`
  - `eligibleImportConsumerRole`
  - `activeImportConsumerCount`
  - `activeImportWorkCount`
  - `progressState`
  - `blockedReason`
  - `lastStartedAt`
  - `lastProgressedAt`
- Add shared SQLite health projection fields or equivalent derived fields for:
  - retained outbox presence
  - claimed outbox presence
  - ready or claimed or running prompt presence
  - orphaned judged queue presence
  - WAL size bucket or threshold status
  - projection freshness
  - projection source
- Ensure shared import or running-work summaries preserve the job's model and content-setting tuple instead of collapsing incompatible work into one generic backlog.
- Extend `/api/judgmentsjobs-health` summary aggregation to count jobs blocked on missing maintenance workers separately from truly stale or failed jobs.
- Keep current `recommendedNextAction` but stop overloading it as the only machine-readable state.
- Read shared SQLite health projection on `api` when it is fresh enough, and proxy to the owner or return explicit maintenance-unavailable when it is not.

Acceptance criteria:

- job health can distinguish:
  - import actively draining
  - import queued but blocked on missing maintenance worker
  - repair required
- job health remains available on `api` even when no owner is active, as long as audited shared/read-only state is sufficient to answer it
- job health never guesses `healthy` from absence of local SQLite state on `api`

## Step 7. Wire A First End-To-End Final Split Dev Mode

Primary files:

- `scripts/runWithRuntimeProfile.ts`
- `scripts/startServerStack.ts`
- relevant docs under `docs/README_RUN_LOCAL.md`

Changes:

- Add a dev/runtime mode that can start:
  - API
  - dedicated `maintenance-worker`
  - dedicated `judge-worker`
- Document the minimal local command needed to test missing-maintenance versus maintenance-present behavior.
- Document the minimal local command needed to test same-host maintenance-worker failover with more than one candidate sharing the data volume.

Acceptance criteria:

- local dev can run `api`, `maintenance-worker`, and `judge-worker` without manual file edits
- operators can intentionally reproduce `no maintenance worker` versus `maintenance worker present` behavior
- operators can intentionally reproduce same-host shared-volume maintenance-worker failover behavior
- `api` still serves blocked or waiting status from audited shared/read-only state while maintenance is intentionally absent

## First APIs To Change

These should be the first API contracts touched because they expose the product truth directly:

1. `GET /api/admin/worker-runtime-diagnostics`
2. replacement owner or worker-registry route for current `GET /api/writer_connections`
3. `POST /api/projectsreviewswarnings`
4. `GET /api/judgmentsjobs/:id/health`
5. `GET /api/judgmentsjobs-health`
6. owner-backed judgment-job control endpoints behind the existing `/api/judgmentsjobs/...` surface
7. owner-backed dispatch claim and completion endpoints that preserve `promptId`, `modelId`, `useTitle`, `useAbstract`, `useFulltext`, and `useFulltextNoImages`

These routes, plus the new durable worker-heartbeat contract and shared SQLite health projection, are enough to make role ownership visible before deeper queue logic changes land. The claim and completion APIs must preserve the benchmark-critical judgment config tuple, and the health routes should remain locally answerable on `api` only after they use audited shared/read-only state. They should proxy explicitly to the owner when they cannot answer honestly.

## First Test Files To Update

- `src/server/routes/AdminInvestigateRoutes.test.ts`
- `src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.test.ts`
- `src/server/routes/JudgmentsJobsRoutes.test.ts`
- `src/server/utils/startBackgroundWork.test.ts`
- `src/server/utils/backgroundServerStack.test.ts`
- `src/server/routes/ApiProxyRoutes.test.ts`
- `src/server/indexStartup.test.ts`
- `scripts/runWithRuntimeProfile.test.ts`
- `src/utils/runtimeProfile.test.ts`

## Minimal Implementation Order

Implement in this exact order:

1. `serverRole.ts`
2. `serverRuntimeRole.ts`
3. `backgroundServerStack.ts`
4. `startBackgroundWork.ts`
5. `serverMain.ts`
6. explicit route classification and read-only query path
7. owner or worker-registry route migration replacing `writer_connections`
8. worker heartbeat, queue progress, and judgment-job SQLite health projection persistence
9. `AdminInvestigateRoutes.ts`
10. `projectsRoutesGetReviewsWarnings.ts`
11. `reviewsWarningsQuery.ts`
12. `reviewsProjectWarnings.tsx`
13. `reviewsIndexingProgress.tsx`
14. `reviewsArticlesTableContainer.tsx`
15. `reviewsArticlesUnassessedTableContainer.tsx`
16. `JudgmentsJobsRoutes.ts` health and owner-backed control routing
17. runtime scripts, persisted-config rename cleanup, desktop readiness, and docs

This order keeps the system diagnosable after each step and limits UI churn before the server contract is ready.

## Quality Gates For The First Coding Slice

- `bun run db:mig`
- `bun test src/server/utils/startBackgroundWork.test.ts src/server/utils/backgroundServerStack.test.ts`
- `bun test src/server/routes/ApiProxyRoutes.test.ts src/server/routes/AdminInvestigateRoutes.test.ts src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.test.ts src/server/routes/JudgmentsJobsRoutes.test.ts`
- `bun test src/server/indexStartup.test.ts scripts/runWithRuntimeProfile.test.ts src/utils/runtimeProfile.test.ts`
- `bun run build`
- `bun run desktop:build`
- Browser verification:
  - review warning shows `waiting for maintenance worker` when no maintenance-worker heartbeat exists
  - worker diagnostics show local capabilities and active worker registry clearly
  - judgment job health distinguishes blocked import from active import
