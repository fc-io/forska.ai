# Fix Worker Plan

## Goal

- Make judgmenting, SQLite backlog import, and review-index refresh continue to make forward progress even when memory gets tight.
- Keep low-memory systems slower but correct, instead of apparently healthy while queues stop draining.
- Let higher-memory systems process the same queues faster by scaling batch sizes, concurrency, and maintenance throughput.
- Remove the current failure mode where one constrained worker both keeps the app alive and prevents required maintenance from ever finishing.
- Start DuckDB ownership on `maintenance-worker` at the highest safe active cap rung at or below the configured ceiling instead of booting above what the machine can sustain.
- Keep `maintenance-worker` and non-DuckDB API flow alive through DuckDB OOM pressure by using controlled in-process cap step-down and restart rather than requiring a manual restart.

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
- non-local worker process means a worker process other than the process handling the current API request; it may run on the same machine on another port or on a separate host, depending on the deployment
- worker-registry code should use names such as `registeredWorker`, `registeredWorkerHeartbeat`, or `nonLocalWorkerProcess` for process-relative registry concepts; reserve `remoteWorker` names for resources that are actually remote by network location, such as existing inference or GPU worker URLs
- cutover release means the first shipped runtime that removes production dependence on `writer`, `auto`, and compatibility `worker`; it is not a special git branch requirement

Do not ship an intermediate production topology.

- testing-only harnesses and temporary local-development shims are acceptable while building the change
- the released runtime surface should complete the role, routing, env, and ownership migration in one go
- production should no longer rely on `writer`, `auto`, or compatibility `worker` roles after the cutover release

Recommended production topology:

- `api`
  - sole public product and operator `/api/*` surface in split deployments
  - non-owner API surface
  - owns a dedicated bootstrap-safe readiness route, for example `GET /api/runtime/ready`, for desktop startup, app-shell availability, and local stack launchers
  - exposes owner and worker-registry status separately from readiness, for example `GET /api/worker-registry`
  - may open DuckDB in read-only mode for query, health, and diagnostics routes
  - serves product and operator status from shared persisted state even when no owner is active
  - proxies owner-only writes and owner-local operations to the active DuckDB owner
- `maintenance-worker`
  - sole DuckDB owner when `api`, `maintenance-worker`, and `judge-worker` run as separate processes
  - exposes only private owner-backed RPC or control routes and internal health needed by `api` and `judge-worker`; it does not mount the public product route tree
  - owns SQLite outbox import
  - owns review-index refresh
  - owns large rebuild work
  - owns full-text fetch and full-text conversion in the cutover release
  - owns `nvidia-smi` polling and persisted GPU telemetry writes in the cutover release
  - owns archival cleanup and backlog draining
  - owns persisted worker-registry writes and queue-progress updates
  - owns owner-backed judgment-job control APIs for local SQLite and queue source-of-truth work
  - owns token-use persistence for judge completions through the same owner-backed idempotent completion apply path
- `judge-worker`
  - does not own DuckDB
  - does not own local judgment-job SQLite state
  - exposes no public product routes; optional diagnostics are local-only and not browser or desktop dependencies
  - obtains claim batches and dispatch snapshots through maintenance-owned APIs, including prompt and model or content-setting identity
  - executes LLM requests against immutable snapshot inputs only and posts completions through maintenance-owned APIs using that same claimed identity
  - writes token-use summaries and completion payloads into its durable local completion outbox instead of writing DuckDB directly

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
- only `api` should mount the public product route tree after cutover; `maintenance-worker` may expose private owner RPC or control plus internal health endpoints, and `judge-worker` should expose no client-routable product API surface
- replace the bootstrap role currently carried by `/api/writer_connections` with two explicit routes in the same cutover: a dedicated bootstrap-safe readiness route for startup and availability checks, and a separate owner or worker-registry route for detailed operator status
- local `api` reads should use a dedicated read-only DuckDB or query path; routes that still depend on owner-local side effects, local SQLite, or process-local snapshots stay owner-proxied
- `judge-worker` should use a dedicated read-only DuckDB or query path for immutable or snapshot-keyed judgment inputs such as article, prompt, project, model, and provider metadata when that path is validated; still ship a maintenance-owned immutable snapshot fetch fallback for separate-host or unvalidated read-only deployments
- a route or worker flow may use live read-only DuckDB only after explicit parity and concurrent-owner-write validation; if validation fails or read-only open is unavailable, keep that flow owner-proxied or move it onto a verified snapshot or replica path
- queue `processing`, `activeConsumerCount`, and `activeWorkCount` should be derived from persisted claims or leases and their freshness, not from standalone increment or decrement counters
- review refresh truth must be project-scoped and article-scoped from the first cutover slice so `/api/projectsreviewswarnings` can answer for the requested project from shared state; queue-level totals should derive from those scoped rows, not vice versa
- cached counters may exist for diagnostics or performance, but they must never be the product source of truth
- `maintenance-worker` failover for SQLite-backed judgment work is same-host shared-volume only in the cutover release; cross-machine takeover without shared SQLite storage is out of scope
- shared worker registry, queue progress, and judgment-job SQLite health projection are part of the first cutover slice, not a later optional phase
- the cutover must include one-time migration of DuckDB-stored config and local `forska.settings.json` keys, plus simultaneous updates to runtime scripts, desktop readiness and startup, settings UI and PATCH payloads, rebuild-tuning surfaces, stored types, and admin or client queries that still use writer-era names
- every currently writer-gated cron or background loop must be explicitly reassigned in the cutover inventory; for the cutover release, full-text fetch and full-text conversion stay on `maintenance-worker`, `judge-worker` owns only LLM execution, and no loop may silently disappear behind removed writer gating
- `nvidiaSmiCron` stays on `maintenance-worker` in the cutover release because it writes shared operator telemetry into DuckDB; it is not an `api` or `judge-worker` process-local diagnostics loop
- judgment dispatch claims, completion APIs, and shared projections must preserve benchmark-critical work-item identity, including `jobId`, `projectId`, `queueRecordId`, `articleId`, `promptId`, `modelId`, `useTitle`, `useAbstract`, `useFulltext`, and `useFulltextNoImages`
- maintenance-issued judgment claims must carry `claimId`, `executionSnapshotId`, and `executionSnapshotHash` for prompt, model, provider, content-setting, article-input, and other reliability-affecting runtime inputs; the id must resolve to an immutable persisted snapshot record and the hash is an integrity check, not a substitute for stored snapshot data
- immutable execution snapshots must be persisted before claim issuance, never rewritten in place, and retained until all dependent claims are terminal and acknowledged plus a minimum 30-day audit window
- `judge-worker` must durably journal accepted claims and produced completion payloads in a dedicated file-backed local SQLite store on durable app-data storage until maintenance acknowledges them idempotently; a maintenance restart or transient network failure after LLM completion must not lose the result
- `judge-worker` durable journal storage must be keyed by a stable configured logical worker id or explicit configured journal path, not by runtime `instanceId`, `pid`, or process start time; runtime `instanceId` is diagnostics metadata only
- canonical split-runtime durability config is env-driven: `JUDGE_WORKER_ID` is the required stable logical identity when `JUDGE_WORKER_JOURNAL_PATH` is omitted, `JUDGE_WORKER_JOURNAL_PATH` is an optional explicit override, and when the path is omitted the runtime must derive a durable app-data journal path from `JUDGE_WORKER_ID`; runtime profiles, local stack scripts, and desktop startup must all wire this contract through unchanged, and startup must fail closed when neither value yields a stable durable target or when the resolved target is missing, unstable, unwritable, or non-durable
- `judge-worker` must fail closed instead of accepting claims when its durable journal or completion-outbox store is unavailable or unwritable
- `judge-worker` must never write `app.token_use` or any other DuckDB-backed judge completion metadata directly; token-use summaries and failed-request diagnostics must travel inside the durable completion outbox and be persisted by maintenance in the same idempotent owner-backed completion apply path
- audited `api-read-only` routes and `judge-worker` snapshot reads must use dedicated read-only helpers enforced by restricted-import lint or tests and runtime guards; they must not import owner-capable database helpers
- every route that promises ownerless health, diagnostics, or product-truth answers must have a mandatory ownerless-readable backend in that deployment; validated live read-only DuckDB is preferred, but it may need a small ownerless-readable lease or control-state sidecar for takeover visibility, and a verified replica or dedicated control-state store is also acceptable; owner proxy alone is not
- legacy writer lease adoption or replacement during cutover must be fenced by an exclusive cutover-migration marker plus legacy-peer reachability and lease-freshness checks; if a pre-cutover writer is still reachable or its lease is still fresh, startup must fail closed instead of replacing it
- `maintenance-worker` scheduling must reserve bounded service for required queues, especially SQLite backlog import and review refresh, so rebuild, full-text, or cleanup work cannot starve them while the worker still appears healthy
- standby `maintenance-worker` candidates must publish ownerless-readable takeover intent and last-seen-owner freshness outside owner-routed heartbeats so `api` can distinguish no candidate from takeover in progress during owner loss
- separate-host `judge-worker` deployment is in scope for the cutover release; validated local read-only DuckDB access is optional, and the required fallback is a maintenance-owned immutable snapshot fetch path keyed by `executionSnapshotId` plus `executionSnapshotHash`
- `maintenance-worker` must freeze prompt-ready article input or immutable fulltext or content refs before claim issuance for any claim that needs them; `judge-worker` must not call live full-text fetch or conversion paths such as `ensureFullText` during claim execution
- DuckDB OOM on `maintenance-worker` must be treated as a retryable operational state, not a generic exception; the worker should derive a process-local active DuckDB cap rung from the configured ceiling, use that rung for the first open and later restarts, and step the active rung down automatically when heavy work does not fit
- first-open and recovery behavior should use one shared active-cap source of truth for DuckDB runtime, refresh admission, rebuild tuning, adaptive throughput profiles, and diagnostics; do not persist stepped-down runtime caps back into user-configured ceiling values
- cap step-down and fatal DuckDB recovery should use one controlled restart gate that serializes behind the main DuckDB work queue, drains append and background lanes, closes the embedded runtime cleanly, and lets it reopen lazily while non-DuckDB API flow remains available
- project-local DuckDB OOM on refresh or large rebuild should mark that work `failed` with explicit retry-after cooldown, re-enter the normal claim path behind fresh claimable work after cooldown, and transition only the still-failing project-scoped work to `paused` at the floor rung with an explicit operator resume path
- repeated no-context or cross-project DuckDB OOM bursts should trip a `maintenance-worker` heavy-work breaker that pauses only named heavy maintenance loops for a bounded cooldown while lighter loops and non-DuckDB API flow stay available
- production cutover is a coordinated same-version replacement, not a rolling mixed-version upgrade; post-cutover processes must reject incompatible pre-cutover peers and writer-era APIs or leases instead of trying to interoperate
- the cutover must ship automated first-start upgrade verification against pre-cutover DuckDB config rows, local `forska.settings.json`, and writer-era lease artifacts so the coordinated replacement does not rely on manual cleanup

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
- `eligibleConsumerCount`
- `activeConsumerCount`
- `activeWorkCount`
- `lastStartedAt`
- `lastProgressedAt`
- `retryAfterAt`
- `recoveryMode`

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

- `Review indexing blocked: waiting for maintenance worker`
- `Judgment backlog blocked: waiting for maintenance worker`

When standby maintenance is already taking over, the UI should say something like:

- `Review indexing blocked: maintenance takeover in progress`

When maintenance is cooling down or protecting itself after DuckDB memory pressure, the UI should say something like:

- `Review indexing retrying soon: cooling down after memory pressure`
- `Review indexing blocked: heavy maintenance work cooling down`

When work has reached the floor rung and now requires operator action, the UI should say something like:

- `Review indexing blocked: operator resume required after memory floor`

When offline repair is required, the UI should say something like:

- `Judgment backlog repair required: offline repair needed`

Do not show `in progress` unless a consumer is both eligible and actively advancing the queue.

For review indexing, the shared truth must be scoped to the requested `projectId`. Activity on some other project's refresh queue must not make this project look `processing`.

## Non-Negotiable System Rules

1. If a queue exists, it must have a designated consumer role and either a live eligible consumer or an explicit blocked state.
2. If no eligible consumer exists, surface that explicitly in health and UI.
3. Required backlog consumers must never be disabled forever by low-memory policy.
4. Heavy work must be chunked, resumable, and idempotent.
5. Memory pressure should reduce throughput, not correctness.
6. Bigger memory should increase throughput automatically without changing correctness semantics.
7. Cross-process health must come from shared persisted state, not local in-memory snapshots.
8. Non-owner roles must write DuckDB-backed shared state through the active DuckDB owner; ownerless control-state and lease metadata are the only explicit exception.
9. Product and operator status routes must stay available without an active owner whenever shared persisted state is sufficient to answer them.
10. Benchmark-critical judgment inputs must be frozen at claim time in an immutable persisted snapshot record; ids without stored frozen values are insufficient, and execution must not silently read newer mutable prompt, article, model, provider, or other reliability-affecting runtime state.
11. Any cross-process handoff after an external side effect, especially LLM completion, must use a durable retryable journal or outbox on file-backed storage until the owner acknowledges it.
12. A route or worker flow may use local read-only DuckDB only after parity and concurrency validation, and only through dedicated read-only helpers enforced by import boundaries and runtime guards; otherwise it stays owner-proxied or uses a verified snapshot or replica fallback.
13. `judge-worker` must refuse startup or claim acceptance if its durable claim journal or completion outbox store is unavailable or unwritable.
14. Immutable execution snapshots must not be garbage-collected until every referencing claim is terminal and acknowledged and the retention window has elapsed.
15. Incompatible pre-cutover and post-cutover runtimes must fail closed rather than partially interoperate.
16. Every route that is expected to answer without an active owner must have a mandatory ownerless-readable truth path in that deployment; validated live read-only DuckDB is one implementation, but it may require a small lease or control-state sidecar for takeover visibility, and a replica or dedicated control-state store is required before cutover when live read-only is unavailable.
17. `maintenance-worker` scheduling must prevent starvation: a ready protected queue must receive bounded service even while heavier opportunistic queues are also backlogged.
18. Legacy writer lease adoption or replacement must be fenced; no post-cutover owner may replace a fresh or reachable pre-cutover writer lease.
19. Separate-host `judge-worker` deployment is supported only through a validated local read-only snapshot path or a maintenance-owned immutable snapshot fetch API; the cutover must not assume shared local DuckDB file access.
20. Only `api` may expose the public product route tree; `maintenance-worker` may expose private owner RPC or control plus internal health only, and `judge-worker` must not expose browser or desktop-facing product routes.
21. Startup and backend availability checks must use a dedicated bootstrap-safe readiness route that does not depend on owner health, worker-registry freshness, or mirrored shared projections becoming non-empty.
22. `judge-worker` token-use summaries and failed-request diagnostics must travel in the durable completion outbox and be persisted by maintenance in the same idempotent owner-backed completion apply path; replay must not double-count token use.
23. `judge-worker` executes only against immutable or snapshot-keyed inputs and must not call live full-text fetch or conversion paths or latest mutable prompt or article reads outside validated snapshot resolution.
24. `maintenance-worker` DuckDB OOM recovery must be process-local and automatic: derive the first open from an active cap rung at or below the configured ceiling, step the active cap down on qualifying OOM, and reuse one controlled restart gate instead of requiring process restart.
25. Project-scoped heavy maintenance work that still OOMs at the floor rung must transition to `paused` with an explicit operator resume path instead of hot-looping in retryable `failed` state forever.
26. Repeated no-context or cross-project DuckDB OOM bursts must activate a bounded `maintenance-worker` heavy-work breaker that pauses only heavy maintenance queues while lighter work and non-DuckDB API flow remain available.
27. Status, routing, tuning, and diagnostics must read one shared active-cap source of truth rather than mixing configured ceiling values with stale runtime-local guesses.

## Architecture Decisions

## DuckDB Ownership

In target deployments:

- `maintenance-worker` is the only role allowed to hold the DuckDB owner lease
- multiple `maintenance-worker` candidates may run, but only one may hold the active write lease at a time
- standby `maintenance-worker` processes should follow the shared owner lease and take over on missing or stale ownership only when they run on the same host and share access to the same judgment-job SQLite volume
- a post-cutover `maintenance-worker` may adopt or replace a legacy writer lease only after it acquires an exclusive cutover-migration fence, verifies the legacy writer is unreachable or stale beyond the configured TTL, and confirms same-host shared-volume access for SQLite-backed judgment state; otherwise startup must fail closed with an explicit cutover-fence error
- `api` may open DuckDB in read-only mode for query, health, and diagnostics routes, but it must never own the write lease
- `judge-worker` may open DuckDB in read-only mode for audited judgment-input reads, but it does not open DuckDB in write mode and must never own the write lease
- any local read-only DuckDB path is conditional on verified concurrent-read behavior with the active owner; otherwise the route or worker flow must proxy through the owner or use a verified snapshot or replica path
- any route that promises ownerless answers must also have a mandatory ownerless-readable backend for that deployment, such as validated live read-only DuckDB plus any needed ownerless-readable lease or control-state sidecar, a verified replica, or a dedicated control-state store
- non-owner processes write DuckDB-backed shared state through the active DuckDB owner HTTP/RPC surface; ownerless control-state and lease metadata remain the explicit exception used for takeover visibility
- separate-host `judge-worker` processes are supported; when they cannot use a validated local read-only snapshot path, they must fetch immutable snapshot payloads through maintenance-owned APIs instead of assuming access to the owner's DuckDB file

## One-Time Migration Requirements

This plan assumes the shipped runtime surface moves fully to the new names and roles.

- remove production support for `SERVER_ROLE=writer`, `SERVER_ROLE=auto`, and compatibility `SERVER_ROLE=worker`
- replace owner-routing config such as `SERVER_WRITER_URL` with an explicit owner name such as `SERVER_DUCKDB_OWNER_URL`, but keep steady-state owner discovery lease-driven; the env value is only a bootstrap hint or manual override, not the failover mechanism
- replace background worker env and runtime-profile names such as `BACKGROUND_WRITER_PORT` and `BACKGROUND_WRITER_DUCKDB_MEMORY_LIMIT` with maintenance-worker equivalents
- replace writer-named diagnostics and routing surfaces with owner or worker-registry naming
- replace generic runtime service names such as `worker-server` and `single-server` with explicit split-role service names across bootstrap, process identity, heartbeats, diagnostics, and runtime logs; backend server-process names should be canonical and explicit, for example `api-server`, `maintenance-worker-server`, `judge-worker-server`, and `dev-single-server`, while non-server process names such as `app-server` stay unchanged where applicable
- replace writer-named lease artifacts such as `.writer.lock` and `.writer.history.json` with explicit DuckDB-owner names
- replace persisted and user-facing writer-era config such as `backgroundWriterDuckdbMemoryLimit`, `background_writer_duckdb_memory_limit`, and local settings keys with maintenance-worker naming, including a one-time DuckDB data migration and one-time rewrite of local `forska.settings.json` keys
- replace the current `/api/writer_connections` bootstrap responsibilities with a dedicated readiness route, for example `GET /api/runtime/ready`, plus a separate owner or worker-registry route; update desktop startup, app-shell availability, local stack launchers, and CLI readiness checks to use the readiness route instead of the registry route
- replace the private `POST /api/writer_connections/heartbeat` contract with an explicit owner-backed worker-registry or heartbeat-write route in the same cutover so no shipped process still posts to writer-era route names
- mount the public product route tree only on `api` after cutover; `maintenance-worker` should expose private owner-backed RPC or control plus internal health only, and `judge-worker` should expose no public product API surface
- introduce canonical `judge-worker` durability config surfaces: `JUDGE_WORKER_ID` required when `JUDGE_WORKER_JOURNAL_PATH` is omitted and optional explicit `JUDGE_WORKER_JOURNAL_PATH`, carried through runtime profiles, local stack scripts, and desktop startup wiring so split-role startup either resolves a stable durable journal target or fails closed
- update package scripts, runtime-profile launchers, desktop backend startup and readiness checks, app-shell backend availability probes, navigation warnings, admin route paths, settings UI and PATCH payloads, rebuild-tuning surfaces, stored types, and admin or client queries to the final names in the same cutover so no shipped surface still depends on writer-era env or route names
- audit and replace remaining role-string checks outside startup, including low-memory token-use persistence suppression and other logic that still keys off removed `writer` or `worker` roles
- replace direct judge-side DuckDB token-use persistence with owner-backed completion persistence; the durable completion outbox must carry token-use summaries and failed-request diagnostics, and maintenance must apply them transactionally and idempotently with completion acknowledgment
- freeze prompt-ready article input or immutable content refs before claim issuance for any claim that needs fulltext so `judge-worker` never needs live full-text fetch or conversion during execution
- do not keep legacy writer or background-writer field names, env aliases, or public API aliases after the cutover release; if upgrade code reads legacy data during first startup, it must rewrite it to the final names immediately rather than keep a steady-state alias
- provide a one-time startup handoff so an existing writer lease can be adopted or cleanly replaced during the cutover release without manual cleanup, but only through an exclusive cutover-migration fence that probes legacy-writer reachability and refuses replacement while the old writer is still reachable or its lease is still fresh
- require every deployment to provision the ownerless-readable backend for routes that must answer without an active owner, choosing one of: validated live read-only DuckDB plus any needed ownerless-readable lease or control-state sidecar, verified replica, or dedicated control-state store
- add a cutover runtime version to owner-routed APIs, worker heartbeats, and lease metadata, and make startup fail closed on incompatible pre-cutover peers
- add an automated first-start upgrade harness that boots against pre-cutover `app.user_config`, local `forska.settings.json`, `.writer.lock`, and `.writer.history.json`, rewrites or replaces them as needed, proves startup does not require manual cleanup, and proves cutover refusal when a legacy writer is still reachable or its lease is still fresh
- make `judge-worker` startup fail closed when neither `JUDGE_WORKER_ID` nor `JUDGE_WORKER_JOURNAL_PATH` yields a stable durable journal target or when the resolved target is missing, unstable, unwritable, or non-durable, and make local multi-worker setups use distinct stable ids unless an explicit shared-path collision test is intended
- support separate-host `judge-worker` deployments by treating maintenance-owned immutable snapshot fetch as the required fallback when validated local read-only snapshot access is unavailable
- perform production cutover as a coordinated same-version replacement or maintenance window rather than a normal rolling deploy across mixed old and new role surfaces

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

- only `api` owns the public `/api/*` product surface for browser, desktop, and operator clients in split deployments
- `maintenance-worker` may expose a private owner-backed RPC or control surface plus internal health endpoints for `api` and `judge-worker`, but it should not mount the public product route tree directly
- `judge-worker` exposes no public product routes; optional local diagnostics are not browser or desktop dependencies
- start with proxy-by-default for `/api/*` on `api`
- classify every route as `owner-only`, `api-read-only`, or `hybrid`
- only `api-read-only` routes may be served locally on `api`, and only after they use the dedicated read-only query path and perform no owner-local side effects
- `hybrid` routes may keep the public route on `api`, but each owner-backed sub-operation must proxy explicitly to the active owner
- health, diagnostics, and product-truth routes must move off owner-local in-memory snapshots onto shared persisted state
- owner-only writes and owner-local operations should proxy to the active owner
- judgment-job control routes that touch local SQLite or queue source-of-truth state must proxy to maintenance-owned APIs even when the public route continues to live under `/api/judgmentsjobs/...`
- replace the current blanket `/api/*` owner proxy only after the route inventory, read-only query path, and explicit local-read allowlist are in place
- if no owner exists, owner-only routes should return an explicit owner-unavailable or waiting-for-maintenance response, not a generic transport `502` where a product-state answer is possible

## Readiness And Bootstrap Contract

- replace the current combined `/api/writer_connections` startup role with two explicit routes in the cutover release:
  - `GET /api/runtime/ready` is the bootstrap-safe readiness route for desktop startup, root backend-availability checks, local stack launchers, and simple CLI health probes
  - `GET /api/worker-registry` or an equivalent owner or worker-registry route is for detailed owner, follower, and capability status and is not the process readiness gate
- the readiness route should answer successfully once the `api` process is listening, the public route tree is mounted, and any deployment-required readiness dependencies are initialized enough to serve the normal shell
- readiness must not depend on an active owner, fresh worker heartbeats, non-empty registry projections, or mirrored shared state having already caught up
- owner loss, waiting-for-maintenance, or takeover-in-progress are valid ready states for the `api` process when the product shell can still answer honestly from shared or ownerless-readable state
- if the deployment requires an ownerless-readable backend for ownerless routes, startup validation should fail before advertising ready instead of becoming ready and only later discovering that the backend contract is missing
- desktop startup, app-shell availability probes, stack launchers, and DuckDB CLI helper guards should use the readiness route for bootstrap and only query the worker-registry route when they need detailed owner or worker status

## Ownerless Control-State Path

Routes that promise answers without an active owner need a deployment-required backend that remains readable when owner proxying is unavailable.

- every route that must answer without an active owner, including worker diagnostics, worker registry, review warnings, and judgment-job health, must declare which ownerless-readable backend it uses
- acceptable backends are validated live read-only DuckDB plus any needed ownerless-readable lease or control-state sidecar, a verified read-only replica, or a dedicated control-state store such as a small file-backed SQLite or replicated snapshot store
- the chosen backend may be composite, but it must carry the shared worker registry projection, queue progress state, judgment-job SQLite health projection, and maintenance takeover intent needed by those routes
- owner proxy is not an ownerless fallback and does not satisfy this requirement
- if a deployment cannot provide one of these backends for a route, that route must remain owner-dependent and must not advertise ownerless availability in product or operator flows

## Read-Only Query Path

Add an explicit read-only DuckDB and query path for audited `api` routes.

- local reads on `api` should use dedicated read-only helpers instead of the current owner-capable `getAppDatabaseService()` and `getAppQueryService()` paths
- create separate read-only helper modules for `api` local-read routes and `judge-worker` snapshot lookups; do not reuse owner-capable service constructors
- a route must stay owner-proxied if it still depends on local SQLite, owner-side maintenance triggers, or process-local runtime snapshots
- route classification should fail closed so new or unclassified routes do not accidentally start running locally on `api`
- early local-read candidates are diagnostics, registry, and health routes after their shared persisted state exists on the mandatory ownerless-readable backend; current mixed routes like review warnings and judgment-job health stay owner-proxied until they stop reading owner-local state
- do not promote a route onto local-read until result parity with the owner-proxy path has been verified under active owner write load
- if live read-only open fails, blocks, or cannot be trusted on a target deployment, core ownerless routes must use the deployment's mandatory ownerless-readable backend and owner-dependent routes must stay owner-proxied; do not silently switch back to owner-capable helpers
- enforce the boundary with restricted-import lint or tests so audited local-read files cannot import owner-capable helpers, and add runtime guards that throw on write-capable opens in `api-read-only` and `judge-worker` contexts

## Read-Only Path Validation And Fallback

- validate every local-read route and worker flow explicitly; read-only is not assumed to be safe just because the API can open the file in one environment
- validation must cover concurrent active-owner writes, result parity against the owner-proxy path, and fail-closed behavior when local read-only open is unavailable
- preferred fallback order is validated live read-only DuckDB first, then the route's mandatory ownerless-readable backend for core ownerless `api` routes, then explicit owner proxy for routes that remain owner-dependent; for `judge-worker` inputs, the fallback is maintenance-owned immutable snapshot fetch or verified snapshot or replica lookup
- local-read adoption is optional per route or flow; if validation is not complete by cutover time, keep that path proxied and ship the role split anyway

## Judge-worker Read Path

Use a dedicated read-only query path on `judge-worker` for immutable judgment inputs.

- `judge-worker` may read article metadata or fulltext, prompt definitions, project content settings, and model or provider metadata from read-only DuckDB helpers only when those reads are immutable or keyed by a maintenance-issued `executionSnapshotId` and verified against `executionSnapshotHash`
- snapshot lookup must resolve against immutable snapshot tables or immutable blob refs; latest mutable article, prompt, project, model, or provider rows by id alone are not sufficient
- `maintenance-worker` must persist the exact prompt-ready article input, or an immutable content ref plus hash that reproduces it exactly, before claim issuance when a claim needs fulltext; `judge-worker` must not call live full-text fetch or conversion during execution
- prefer this read-only path over maintenance APIs shipping full article, prompt, or provider payloads end-to-end in the first cutover slice, but freeze benchmark-critical execution inputs at claim time and retrieve them by immutable snapshot reference rather than by latest mutable ids
- if a read-only lookup cannot reproduce the claimed snapshot exactly, fail the claim explicitly or fetch the missing immutable snapshot from maintenance; do not silently read newer mutable state
- separate-host `judge-worker` deployment is in scope; when that host does not have a validated local read-only snapshot path, it must fetch immutable snapshot payloads from maintenance-owned APIs keyed by `executionSnapshotId` plus `executionSnapshotHash`
- keep queue truth, claim issuance, completion acceptance, retry or skip or judged state transitions, SQLite mutation, and judgment persistence on maintenance-owned APIs
- `judge-worker` must not use owner-capable database helpers, local judgment-job SQLite helpers, or live full-text helpers such as `ensureFullText`; enforce this with restricted-import lint or tests in addition to runtime guards

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
- have every process heartbeat through the active DuckDB owner so the DuckDB registry remains authoritative while an owner is healthy
- use the worker registry to count eligible consumers across all live worker processes, not just the local process serving the API request; an `api` process can then distinguish no maintenance worker from a healthy non-local `maintenance-worker` on another port or host
- have standby `maintenance-worker` candidates also publish minimal ownerless-readable candidacy and takeover-intent state, including `lastSeenOwnerAt`, `lastTakeoverAttemptAt`, and current takeover status, through the mandatory control-state backend or shared lease metadata so `api` can distinguish missing maintenance from takeover in progress during owner loss
- persist `maintenance-worker` recovery state needed for ownerless diagnostics and honest status, including configured DuckDB ceiling, derived startup rung, current active cap rung, controlled DuckDB restart-gate state, and heavy-work breaker cooldown when those fields affect operator or product truth
- persist `lastStartedAt` per backlog type when a consumer actually begins a batch
- persist `lastProgressedAt` per backlog type when a batch actually completes
- persist per-backlog claim or lease rows with worker identity, consumer role, work scope, `startedAt`, `heartbeatAt` or `expiresAt`, and `lastProgressedAt` where relevant; review refresh rows must carry at least `projectId`, and article-refresh work must carry `projectId` plus `articleId` or an equivalent batch scope that can be expanded back to concrete articles
- persist refresh or rebuild recovery state needed for product truth, such as retry-after timestamps, paused-at-floor reasons, and current recovery mode, or mirror those fields from existing state into the shared projection when that is simpler than inventing a parallel queue state model
- include `judge-worker` completion-handoff visibility in shared state, for example pending completion-ack count and oldest unacked completion age, so health can distinguish active LLM work from a stuck completion outbox
- derive `activeConsumerCount` and `activeWorkCount` from non-stale claim or lease rows instead of treating standalone counters as truth
- derive queue-wide totals from scoped claim rows instead of trying to reconstruct scoped truth from global counters later
- mirror the worker-registry projection, queue-progress projection, judgment-job SQLite health projection, maintenance OOM recovery state, and maintenance takeover-intent view into the ownerless-readable backend for any route that must answer without an active owner when live read-only DuckDB is not the deployment choice
- keep process-local snapshots only for debugging and operator drill-down, not for product health decisions

## Persisted Active Work Model

Use persisted claims and leases as the source of truth for queue activity.

- project refresh and large rebuild work should write claims directly in DuckDB with explicit scope identifiers
- review-index product truth must be project-scoped from the first cutover slice; `/api/projectsreviewswarnings` should answer from rows keyed to the requested project, not from unrelated global queue activity
- judgment prompt execution and SQLite outbox import already use persisted local SQLite claims today; `maintenance-worker` should project the claim summaries and freshness needed for shared health into DuckDB
- project-scoped refresh or rebuild retry-after cooldown and paused-at-floor state must also be readable through shared state so ownerless product routes do not guess at memory-recovery status
- `processing` should require fresh worker presence plus at least one fresh claim or lease for the relevant backlog
- queue-level counters may exist as derived debug views, but stale or crashed work must be cleared by claim freshness rules, not by assuming a matching decrement always happened

## Shared SQLite Health Projection

Add a persisted judgment-job SQLite health projection so `api` can answer health honestly without local SQLite ownership.

- have `maintenance-worker` write lightweight judgment-job SQLite health snapshots into DuckDB through owner-side writes
- have `maintenance-worker` also mirror the fields needed for ownerless health routes into the mandatory ownerless-readable backend when live read-only DuckDB is not the deployment choice
- project at least retained outbox counts, claimed outbox counts, ready or claimed or running prompt counts, orphaned judged counts, pending completion-ack counts or age, WAL bytes, import timestamps and errors, local claim freshness, lease metadata, recovery mode, and projection freshness
- include retry-after and paused-at-floor context where judgment-job or maintenance recovery state depends on DuckDB memory pressure or controlled restart state
- make `/api/judgmentsjobs/:id/health` and `/api/judgmentsjobs-health` read this shared projection first
- if the projection is missing or too stale to trust, proxy to the active owner or return an explicit maintenance-unavailable response; do not guess from missing local state

## Judgment Claim Identity

Preserve benchmark-critical judgment identity across the split.

- every maintenance-issued judgment claim and completion payload must carry `jobId`, `projectId`, `claimId`, `queueRecordId`, `articleId`, `promptId`, `modelId`, `useTitle`, `useAbstract`, `useFulltext`, and `useFulltextNoImages`
- maintenance-owned completion bookkeeping must validate `claimId`, `jobId`, `projectId`, `queueRecordId`, `articleId`, and the claimed prompt or model or content tuple before mutating queue source-of-truth state
- shared health, progress, and diagnostics projections must preserve or derive the same article or prompt or model or content identity wherever queue truth depends on it; do not coalesce incompatible articles, models, or content settings into one generic backlog

## Immutable Execution Snapshot Store

- `maintenance-worker` should persist a write-once execution snapshot record in DuckDB before issuing a claim, for example via `app.judgment_execution_snapshot` plus child tables or JSON payload columns for frozen prompt text, resolved model or provider settings, content flags, and article-input refs
- every claim and completion should carry `executionSnapshotId`; `executionSnapshotHash` travels with the payload as an integrity checksum over the persisted snapshot record
- if article metadata or fulltext can change, the snapshot must store the exact prompt-ready article input or an immutable content-version ref plus hash; do not rely on latest article rows by `articleId` alone
- snapshot rows are write-once; edits to prompts, models, providers, or reliability-affecting runtime settings create a new snapshot id
- retain snapshot rows until all referencing claims and completion-outbox records are terminal and acknowledged, plus a minimum 30-day audit retention window, then prune them in maintenance-owned cleanup

## Judgment Execution Snapshot

- every maintenance-issued judgment claim must include `claimId`, `executionSnapshotId`, and `executionSnapshotHash`
- the execution snapshot record must freeze every benchmark-critical input that can change judgment behavior, including prompt text or prompt version or hash, project content settings, model or provider routing metadata, model runtime settings, exact prompt-ready article input or immutable article-content refs, and any reliability-affecting options such as thinking level or equivalent provider knobs when present
- when a value is too large to inline, the persisted snapshot row may carry immutable refs plus hashes or versions; `judge-worker` read-only lookups must be keyed by `executionSnapshotId` and verify `executionSnapshotHash` rather than current mutable ids alone
- snapshot lookup by hash alone is not enough for replay or diagnostics; the persisted immutable snapshot record is the source of truth
- maintenance completion handlers must reject completions whose snapshot id or hash does not match the accepted claim instead of silently binding them to current mutable state
- snapshot mismatches should surface as explicit `failed` or `repair_required` health, not as hidden retries against newer config

## Judge-worker Completion Durability

- `judge-worker` must store accepted claims and produced completion or terminal failure or skip payloads in a dedicated file-backed local SQLite database under a durable app-data path before attempting the maintenance callback
- the journal or outbox database must be owned by exactly one logical `judge-worker`: choose its path from an explicit configured journal path or stable configured logical worker id, not from runtime `instanceId`, `pid`, or process start time, and fail closed on collision
- runtime `instanceId` may be recorded inside the journal for diagnostics, but restart replay must reopen the same durable store after process restarts
- production cutover assumes the `judge-worker` journal database lives on persistent local storage; tmp directories or ephemeral container filesystems are unsupported for `judge-worker` durability
- if the journal database cannot be opened read-write during startup or before claim acceptance, `judge-worker` must refuse startup or stop claiming new work
- a second `judge-worker` process pointing at the same configured journal path must deterministically fail startup instead of sharing or racing on the same SQLite files
- accepted claims must be written to a local claim journal before LLM execution; completions, terminal failures, and skips must be inserted into `completion_outbox` in the same local SQLite store before callback
- completion outbox rows must also carry the token-use summary and failed-request diagnostics needed for `app.token_use`; `judge-worker` must never write token-use rows directly into DuckDB
- maintenance completion APIs must be idempotent by `jobId` plus `projectId` plus `claimId` plus `queueRecordId` plus `executionSnapshotId`, must verify `executionSnapshotHash` before acknowledging the outbox row, and must persist judgments, token-use, and queue-source-of-truth updates in one owner-backed idempotent apply path so replay cannot double-count token use
- `judge-worker` must retry unsent completion-outbox records until acknowledged, replay them on startup before fetching new claims, and reconcile journaled claimed-but-unfinished work through maintenance-owned lease status instead of dropping it locally
- acknowledged journal and outbox rows may be compacted only after maintenance acknowledgment and a minimum 7-day local retention window; unacked rows must never be removed by best-effort cleanup
- shared health and diagnostics should surface pending completion-ack backlog and last acknowledged completion age so stuck handoffs are visible

## Queue Ownership

### Production Roles

#### `maintenance-worker`

Owns:

- DuckDB owner lease
- SQLite retained backlog import into DuckDB
- project mart refresh queues
- large rebuild queues
- full-text fetch and full-text conversion
- `nvidia-smi` polling and persisted GPU telemetry writes
- heavy archival cleanup
- persisted worker-registry writes
- queue-progress updates
- queue insertion and claim persistence for judgment work
- token-use persistence for judge completions
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
- read-only lookup of immutable judgment inputs through dedicated query helpers
- durable local claim journal and completion outbox, including token-use summaries and failed-request diagnostics, before completion submission back to maintenance-owned APIs without direct DuckDB access

Does not own:

- local judgment-job SQLite state
- judgment-job mutation routes that touch local SQLite or queue source-of-truth state
- SQLite retained backlog import into DuckDB
- project mart refresh queues
- large rebuild queues
- full-text fetch and full-text conversion
- `nvidia-smi` polling and persisted GPU telemetry writes
- heavy archival cleanup
- direct `app.token_use` or other DuckDB-backed completion metadata writes

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
- lower active DuckDB cap rungs after qualifying OOM recovery events, with project-local cooldown instead of immediate retry thrash

### Higher Memory

Expected behavior:

- larger import batches
- more rebuild work per wake
- higher claim concurrency
- more aggressive queue draining
- faster refresh completion
- a higher startup active cap rung when the configured ceiling and machine stability allow it

### Rule

Memory pressure should scale throughput down, not disable required consumers.

## Maintenance OOM Recovery

- `maintenance-worker` owns DuckDB OOM recovery because it is the only DuckDB owner in split deployments.
- Treat DuckDB OOM as a retryable operational state, not a generic exception.
- Keep the configured DuckDB memory limit as the operator-facing ceiling, but derive a process-local active cap rung and use that rung for the first DuckDB open and later restarts.
- On first open, start DuckDB at the highest safe rung at or below the configured ceiling. The first implementation may use a fixed ladder such as `6400MiB`, `4096MiB`, `3072MiB`, `2048MiB`, `1536MiB`, and `1024MiB`, while preserving the same semantics if later platform tuning changes the exact rung set.
- Use one shared active-cap source of truth for DuckDB runtime, refresh admission, rebuild tuning, throughput profiles, and diagnostics.
- On project-local DuckDB OOM in review refresh or large rebuild, step the active cap down one rung, enter a controlled in-process DuckDB restart gate that serializes behind the main DuckDB queue and drains append or background lanes, mark that work `failed` with explicit retry-after cooldown, and let it re-enter the normal claim path behind fresh claimable work after cooldown. An initial default may use one shared project-local cooldown such as `5m`.
- At the floor rung, transition only the still-failing project-scoped heavy work to `paused` with a clear system-generated reason and an explicit operator resume path.
- Do not persist stepped-down runtime caps into `app.user_config` or other user-facing config; runtime recovery stays process-local and the configured ceiling remains unchanged.
- Prefer reusing existing refresh or rebuild state to represent retry-after and paused-at-floor semantics when current state can express them cleanly; do not add a parallel retry queue unless existing state is insufficient.

## Maintenance Scheduling And Fairness

Adaptive throughput is not enough on its own. The sole `maintenance-worker` also needs explicit fairness rules so one backlog cannot monopolize the owner.

- treat SQLite backlog import and review refresh as protected queues that must continue to receive bounded service while they are ready
- a protected queue in explicit retry-after cooldown, breaker pause, or paused-at-floor state is not considered ready for fairness accounting until it becomes claimable again
- treat large rebuild, full-text fetch, full-text conversion, and archival cleanup as opportunistic queues that must yield after each bounded slice
- reserve at least one batch or bounded time slice per scheduler window for every ready protected queue before opportunistic queues consume extra slices
- enforce a configured consecutive-slice cap so no opportunistic queue can keep running while a ready protected queue has not progressed within its allowed window
- keep lightweight telemetry such as `nvidia-smi` polling preemptible and outside the fairness budget for protected queues
- drive profile tuning through batch size, slice length, and concurrency caps, not by disabling protected queues entirely
- keep cooled-down failed refresh or rebuild work behind fresh claimable work after cooldown instead of reintroducing immediate retry storms
- surface starvation explicitly in diagnostics and health when a ready protected queue misses its progress window while the worker remains healthy

## Maintenance OOM Breaker

- Repeated no-context or cross-project DuckDB OOM bursts should trip a bounded `maintenance-worker` heavy-work breaker.
- An initial default may use `3` qualifying OOM events inside `60s` with a `5m` breaker cooldown, while treating those thresholds as runtime tuning rather than product semantics.
- The breaker should pause only named heavy maintenance loops such as review refresh, large rebuild, full-text fetch, full-text conversion, heavy archival cleanup, and any optional bulk import outside the protected SQLite retained-outbox path. Protected SQLite retained-outbox import must keep its own adaptive bounded-service path unless its specific work is in an explicit retry-after cooldown.
- Lighter control-plane work, small housekeeping cleanup, status propagation, and non-DuckDB API flow should remain available while the breaker is active.
- Operator-triggered heavy maintenance during breaker cooldown should return an explicit blocked reason plus `retryAfterAt` instead of bypassing the safety rail.
- The breaker should auto-resume heavy work after cooldown when recovery remains possible.

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
- `retryAfterAt`
- `recoveryMode`

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
- `maintenance_takeover_in_progress`
- `paused_by_policy`
- `duckdb_memory_throttled`
- `duckdb_restart_in_progress`
- `cooldown_after_oom`
- `paused_at_memory_floor`
- `maintenance_heavy_work_breaker_active`
- `offline_repair_required`
- `provider_unavailable`
- `quarantined_local_state`

### Example `recoveryMode`

- `none`
- `cooldown_after_oom`
- `paused_at_memory_floor`
- `auto_repair_active`
- `offline_repair_required`
- `heavy_work_breaker_active`
- `quarantined_local_state`

Keep the state model flat and reusable. Do not encode role-specific text into `progressState`.

- `blockedReason` should explain why work is not progressing right now.
- `recoveryMode` should explain which recovery path is active or required when that context matters for product or operator truth.

- Retryable maintenance cooldown after DuckDB OOM should normally surface as `progressState = 'blocked'` plus explicit `blockedReason` and `retryAfterAt`; internal refresh or rebuild work items may still use a retryable `failed` state for scheduling so they re-enter the normal claim path after cooldown.
- Terminal floor-exhausted or breaker-blocked maintenance should normally surface as `progressState = 'blocked'` plus explicit `blockedReason`, and include `retryAfterAt` when the block will auto-clear.
- Offline repair or other operator-only reconciliation should normally surface as `progressState = 'repair_required'` plus explicit `blockedReason`; include `retryAfterAt` only when a bounded automated retry is actually scheduled.

## Judgment Job Control And Health Contract

- keep public judgment-job routes stable where that reduces client churn, but route all SQLite-affecting mutations through maintenance-owned APIs
- this includes `PATCH /api/judgmentsjobs/:id`, `POST /api/judgmentsjobs/:id/start-clean`, `POST /api/judgmentsjobs/:id/preflight`, `POST /api/judgmentsjobs/:id/drain`, `POST /api/judgmentsjobs/:id/checkpoint`, `POST /api/judgmentsjobs/:id/repair`, `POST /api/judgmentsjobs/:id/quarantine`, `POST /api/judgmentsjobs/:id/unquarantine`, and `DELETE /api/judgmentsjobs/:id`
- make `/api/judgmentsjobs/:id/health` and `/api/judgmentsjobs-health` read the shared SQLite health projection when that data is fresh enough
- when shared projection is not sufficient, proxy to the active owner or return an explicit waiting-for-maintenance or owner-unavailable response
- keep the split control plane narrow: maintenance-owned APIs should issue claims with frozen snapshot identity and accept idempotent completions that also carry token-use summaries, while `judge-worker` reads large immutable article or prompt or provider inputs locally through the read-only path only when those reads are keyed by that snapshot instead of receiving full mutable payload snapshots from maintenance

## Routing And Diagnostics

Diagnostics should show:

- active worker role
- configured worker role
- whether the current process owns DuckDB
- whether the current route is being served locally or proxied to the owner when relevant
- current-process capabilities
- registry view of active workers by capability
- configured DuckDB memory ceiling
- derived startup active cap rung
- current active DuckDB cap rung
- whether a controlled DuckDB restart gate is active
- active adaptive throughput profile
- heavy-work breaker state and `retryAfterAt` when active
- whether any active worker is eligible to consume import backlog
- whether any active worker is eligible to consume review refresh backlog
- last progress timestamp per queue
- last started timestamp per queue
- active work counts per queue
- queue-level batch sizes and current caps
- project-scoped refresh or rebuild cooldown and paused-at-floor state when present
- read path mode per route or worker flow, for example live read-only, snapshot or replica, or owner-proxied
- `judge-worker` pending completion-ack count and oldest unacked completion age when available
- cutover runtime version and incompatible-peer refusal status

## Release Policy

The phases below are workstreams and dependency buckets, not literal one-by-one production rollouts.

- implement and verify the phases in dependency order where that helps reduce engineering risk
- the production cutover slice intentionally combines Phase 1, Phase 2, Phase 4, and the server-contract subset of Phase 3; any remaining Phase 3 UI polish can follow immediately after those APIs land
- do not stop at a compatibility midpoint in production
- cut over production only after the explicit role split, owner election, judge-worker path, status semantics, and naming migration are complete
- do not cut over production until the shared worker registry, queue progress state, and judgment-job SQLite health projection exist for the routes that `api` must answer without owner-local state
- before that shared state exists, any health or status route that still depends on owner-local state stays owner-proxied; do not move it onto local `api` reads early
- do not cut over production until every route that must answer without an active owner has a mandatory ownerless-readable backend in that deployment; owner proxy is not sufficient
- do not cut over production until the dedicated bootstrap-safe readiness route is in place and desktop startup, app-shell availability probes, and stack launchers have moved off the detailed worker-registry route
- do not cut over production until only `api` mounts the public product route tree and worker roles are limited to their intended private RPC or diagnostics surfaces
- production cutover is a coordinated same-version replacement or maintenance window, not a normal rolling deploy across writer-era and split-role runtimes
- owner APIs, worker-registry heartbeats, lease metadata, startup, and local stack scripts must carry or check a cutover version; incompatible peers should refuse startup or refuse serving with an explicit incompatible-runtime error
- do not cut over production until the cutover-migration fence has been verified to refuse lease adoption or replacement while a legacy writer is still reachable or its lease is still fresh
- if a route or worker flow has not yet passed read-only validation, it stays proxied or snapshot-backed; local-read adoption is not itself a release blocker
- do not cut over production until the immutable execution snapshot store and the `judge-worker` durable journal or outbox storage are present in the target deployment, including token-use transport inside the durable completion outbox; stateless `judge-worker` instances without durable local storage are out of scope for the cutover release
- local and staging environments may use temporary test harnesses while validating the in-progress change, but the shipped runtime surface should already be the final one

## Implementation Plan

## Phase 1. Replace Roles And Ownership With The Final Runtime Surface

Layers:

- server
- client
- desktop
- database
- docs

Changes:

- Replace production `writer`, `auto`, and compatibility `worker` roles with explicit `maintenance-worker`, `judge-worker`, and `api` roles.
- Define central capability helpers instead of ad hoc `if role === ...` checks.
- Make the active DuckDB owner explicit in startup and proxy routing.
- Complete the owner-naming migration for env vars, runtime profiles, persisted config, local settings, settings UI and PATCH payloads, rebuild-tuning surfaces, stored types, diagnostics, routes, client queries, desktop startup and readiness, and lease artifacts.
- Introduce the canonical split-runtime `judge-worker` durability contract: `JUDGE_WORKER_ID` required when `JUDGE_WORKER_JOURNAL_PATH` is omitted, optional explicit `JUDGE_WORKER_JOURNAL_PATH`, deterministic app-data path derivation when only the id is set, and fail-closed startup when neither value resolves a stable durable journal target or when the resolved target is missing, unstable, unwritable, or non-durable.
- Audit and replace writer-era behavior branches outside startup, including app-shell availability checks, navigation and admin surfaces, and low-memory token-use persistence logic that still keys off `writer` or `worker`.
- Split the current `/api/writer_connections` responsibilities into a dedicated bootstrap-safe readiness route and a separate owner or worker-registry route, and move desktop startup, app-shell availability, and local stack launchers onto the readiness route.
- Restrict the public product route tree to `api`; `maintenance-worker` exposes only private owner-backed RPC or control plus internal health, and `judge-worker` exposes no public product routes.
- Add explicit route classification for `owner-only`, `api-read-only`, and `hybrid` behavior.
- Keep `/api/*` proxying fail-closed by default until a route is moved onto the audited local-read allowlist.
- Add a dedicated read-only DuckDB and query path for audited `api` routes.
- Require a mandatory ownerless-readable backend for every route that must answer without an active owner, and make that deployment choice visible in diagnostics and startup validation.
- Add code-level read-only boundary enforcement so audited `api` and `judge-worker` paths cannot import owner-capable database helpers and fail closed on write-capable opens.
- Add cutover-version handshake and fail-closed startup refusal for incompatible pre-cutover peers.
- Add an explicit cutover-migration fence that probes legacy-writer reachability, respects lease TTL, and refuses lease adoption or replacement while a legacy writer is still reachable or fresh.
- Keep any candidate local-read route or worker flow proxied or snapshot-backed until live read-only parity and concurrency validation passes.
- Replace `writer_connections` naming in diagnostics, readiness, and desktop startup with owner or worker-registry naming.
- Keep owner discovery lease-driven after startup; treat any explicit owner URL env as bootstrap-only.
- Add role diagnostics to the worker runtime endpoint.
- Add an owner-backed token-use persistence contract so `judge-worker` never writes DuckDB directly; token-use travels in the durable completion outbox and is applied idempotently by maintenance.
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
5. Add a dedicated bootstrap-safe readiness route for backend availability and split detailed owner or worker-registry status onto a separate route.
6. Add a dedicated read-only DuckDB and query path for audited `api` routes, audit existing `getAppQueryService()` call sites, and add parity and fallback validation, separate read-only helper modules, restricted-import lint or tests, and runtime guards that fail closed on write-capable opens.
7. Add the mandatory ownerless-readable backend contract for routes that must answer without an active owner, and wire the chosen backend into startup validation and diagnostics.
8. Replace writer-named env, runtime-profile, persisted-config, route, lease, settings UI, stored-type, client-query, package-script, dev-watch, CLI-guard, app-shell availability, admin-route, readiness, and desktop-startup surfaces with owner or maintenance-worker naming.
9. Add `JUDGE_WORKER_ID` and optional explicit `JUDGE_WORKER_JOURNAL_PATH` to env parsing, runtime profiles, local stack scripts, and desktop startup, and make startup fail closed when neither value resolves a stable durable journal target or when the resolved target is missing, unstable, unwritable, or non-durable.
10. Replace remaining removed-role checks outside startup, including low-memory token-use persistence suppression and any `writer` or `worker` string checks in runtime behavior.
11. Replace direct server-side token-use writes from the judging path with owner-backed completion persistence carried by the durable completion outbox.
12. Move mixed read or write status routes off local snapshots and owner-side effects before taking them off the owner proxy.
13. Preserve lease election and follower takeover by moving it onto `maintenance-worker` candidates that share the same data volume when SQLite-backed judgment work must survive takeover.
14. Add a cutover-version handshake across owner routes, worker heartbeats, startup, and lease metadata so incompatible pre-cutover peers fail closed.
15. Add the cutover-migration fence and upgrade harness that seed pre-cutover DuckDB config rows, local settings, and writer-era lease files, verify first-boot rewrite, verify refusal while a legacy writer is still reachable or fresh, and only then verify clean lease adoption or replacement.
16. Update runtime bootstrap, process identity, heartbeat payloads, and runtime log service naming to use explicit split-role service names instead of generic worker-era service labels.
17. Update background startup registration, local stack scripts, dev-watch helpers, DuckDB CLI guards, desktop readiness checks, and app-shell availability probes to use capability checks, cutover-version checks, the readiness route, final role names, stable `judge-worker` journal identity wiring, and the selected ownerless-readable backend.
18. Express startup role monitoring, owner routing, and takeover polling with `Effect` services rather than ad hoc promise chains.
19. Add docs for how to run:
    - API plus `maintenance-worker` plus `judge-worker`
    - API plus redundant same-host `maintenance-worker` candidates sharing the data volume for failover testing
    - a coordinated same-version cutover or maintenance-window replacement without mixed old and new runtime surfaces

Quality Gates:

- When a gate below names a current writer-era file that this slice renames, run the same gate against the final renamed replacement file.
- `bun run db:mig`
- `bun test src/server/utils/startBackgroundWork.test.ts src/server/utils/backgroundServerStack.test.ts`
- `bun test src/server/utils/projectMartLargeRebuildHeartbeat.test.ts`
- `bun test src/server/routes/AdminInvestigateRoutes.test.ts src/server/routes/ApiProxyRoutes.test.ts src/server/indexStartup.test.ts`
- `bun test src/server/routes/ApiProxyRoutes.retry.test.ts`
- `bun test src/server/utils/serverRuntimeRoleDuplicateServer.test.ts src/server/utils/serverRuntimeRoleWriterWorkError.test.ts src/server/utils/duckdbOwnerLease.test.ts src/server/utils/duckdbServiceLease.test.ts`
- `bun test src/server/utils/serverRole.test.ts src/server/utils/duckdbServiceErrorNormalization.test.ts src/server/utils/duckdbServiceReload.test.ts src/server/utils/duckdbServiceTransactionRollback.test.ts src/server/utils/duckdbServiceShutdown.test.ts src/server/utils/duckdbServiceMemoryLimit.test.ts`
- `bun test src/server/utils/duckdbScriptAccess.test.ts src/server/utils/runtimeLogger.test.ts src/server/services/getAppQueryService.test.ts`
- `bun test src/server/routes/DuckdbStudioRoutes.test.ts src/server/routes/PromptsRoutes.test.ts src/server/routes/JudgmentsJobsRoutes.crashContainment.test.ts src/server/cron/judgmentsJobs/judgmentsJobsAddToQueue.test.ts src/server/cron/judgmentsJobs/requeueAbandonedSentPrompts.test.ts`
- `bun test src/server/services/appDatabaseServiceAppendJudgments.test.ts src/server/services/articleImportStoreService.test.ts src/server/services/covidenceImportService.test.ts src/server/services/getDuckdbMartRefreshService.test.ts src/server/services/judgmentJobDeleteService.test.ts src/server/services/projectMartLargeRebuildExecutor.test.ts src/server/services/projectMartLargeRebuildStateService.test.ts src/server/services/projectMartRefreshStateService.test.ts src/server/services/tokenUseQueryService.test.ts`
- `bun test scripts/runWithRuntimeProfile.test.ts`
- `bun test scripts/reproArchivedProjectServingDelete.test.ts scripts/projectMartRefreshRecovery.test.ts scripts/recoverArchivedProjectRefreshQueue.test.ts scripts/recoverJudgmentJobWithSystemSqlite.test.ts scripts/dbBackup.test.ts`
- `bun test src/desktop/getDesktopRuntimeConfig.test.ts src/desktop/desktopSingleInstance.test.ts`
- `bun test src/utils/runtimeProfile.test.ts`
- `bun test src/server/utils/writerConnections.test.ts`
- `bun test src/agent/judge/judgeStoreTokenUse.test.ts`
- `bun x eslint src/server/utils/serverRole.ts src/server/utils/serverRuntimeRole.ts src/server/utils/duckdbOwnerLease.ts src/server/utils/duckdbService.ts src/server/utils/env.ts src/server/utils/runtimeBootstrap.ts src/server/utils/runtimeProcessIdentity.ts src/server/utils/runtimeLogger.ts src/server/utils/writerConnections.ts src/server/utils/writerWarnings.ts src/server/utils/ensureFullText.ts src/server/serverMain.ts src/server/utils/startBackgroundWork.ts src/server/utils/backgroundServerStack.ts src/server/utils/projectMartLargeRebuildHeartbeat.ts src/server/utils/projectMartRefreshWorkerHeartbeat.ts src/server/utils/writerConnectionHeartbeat.ts src/server/utils/duckdbScriptAccess.ts src/server/services/getAppQueryService.ts src/server/services/userConfigQueryService.ts src/server/routes/ApiProxyRoutes.ts src/server/routes/WriterConnectionsRoutes.ts src/server/routes/AdminInvestigateRoutes.ts src/server/routes/UsersRoutes.ts src/server/utils/localAppSettings.ts src/server/utils/projectMartLargeRebuildTuning.ts src/server/cron/fullTextJobs.ts src/server/cron/fullTextConversionJobs.ts src/server/cron/judgmentsJobs.ts src/server/cron/nvidiaSmi.ts src/agent/judge.ts src/agent/judge/storeSinglePromptJudgment.ts src/agent/judge/judgeStoreTokenUse.ts src/app/routes/+__root.tsx src/components/Navigation.tsx src/app/routes/+admin/+writer-connections/+index.tsx src/app/routes/+settings/+index.tsx src/db/schemaTypes.ts src/utils/runtimeProfile.ts src/utils/writerConnectionsQuery.ts src/desktop/index.ts src/desktop/getDesktopRuntimeConfig.ts scripts/reproArchivedProjectServingDelete.ts scripts/benchmarkDuckdbAppendLanes.ts scripts/recoverProjectMartRefreshClaims.ts scripts/devServerWatch.ts scripts/runWithRuntimeProfile.ts scripts/startServerStack.ts`
- `bun run build`
- `bun run desktop:build`
- Runtime verification:
  - an audited local-read route matches the owner-proxy response while `maintenance-worker` is actively heartbeating and writing
  - the dedicated readiness route returns ready for a healthy `api` process even when maintenance is intentionally absent, while the worker-registry route separately reports `waiting_for_maintenance_worker`
  - a forced local read-only-open failure moves a core ownerless route onto the mandatory ownerless-readable backend and keeps an owner-dependent route proxied, both with explicit diagnostics
  - an audited `api-read-only` or `judge-worker` file cannot use owner-capable database helpers, and a forced write-capable open attempt fails closed
  - startup rejects incompatible writer-era peers or mismatched cutover versions
  - startup refuses cutover lease adoption or replacement while a legacy writer is still reachable or its lease is still fresh
  - first boot against pre-cutover `app.user_config`, `forska.settings.json`, `.writer.lock`, and `.writer.history.json` rewrites or cleanly replaces them without manual cleanup
  - `judge-worker` startup refuses to run when neither `JUDGE_WORKER_ID` nor `JUDGE_WORKER_JOURNAL_PATH` resolves a stable durable journal target or when the resolved target is missing, unstable, unwritable, or non-durable
  - `maintenance-worker` and `judge-worker` do not expose the public product route tree after cutover, while `api` still serves the public surface and owner-proxies as needed
  - a separate-host `judge-worker` can fetch immutable snapshot inputs through maintenance-owned APIs when validated local read-only access is unavailable on that host

## Phase 2. Add Shared Worker Presence And Queue Progress State

Layers:

- server
- database
- docs

Changes:

- Add a persisted worker registry and heartbeat model in DuckDB.
- Have every process heartbeat role, capabilities, memory limit, and throughput profile through the active owner.
- Mirror the worker registry, queue progress state, judgment-job SQLite health projection, and maintenance takeover-intent view into the mandatory ownerless-readable backend when live read-only DuckDB is not the deployment choice.
- Persist or mirror maintenance OOM recovery state needed for diagnostics and ownerless product truth, including configured ceiling, derived startup rung, current active cap rung, controlled restart-gate state, and heavy-work breaker cooldown.
- Persist queue-level `lastStartedAt` when batches actually begin.
- Persist queue-level `lastProgressedAt` when batches actually complete.
- Persist per-backlog claim or lease rows and derive active consumer and work counts from their freshness, preserving project or article scope for review refresh work and `jobId` plus `projectId` plus `queueRecordId` plus `articleId` plus prompt or model or content identity for judgment work where applicable.
- Persist or mirror project-scoped refresh or rebuild retry-after timestamps, paused-at-floor reasons, and recovery mode where those states affect honest API or UI answers.
- Persist a judgment-job SQLite health projection that `api` can read without local SQLite ownership.
- Persist enough `judge-worker` completion-handoff state for shared health, such as pending completion-ack counts or oldest unacked completion age.
- Persist standby `maintenance-worker` takeover intent and last-seen-owner freshness in an ownerless-readable form so `api` can tell the difference between `waiting_for_maintenance_worker` and `takeover_in_progress`.
- Make health routes read shared registry and progress state rather than process-local snapshots.

Practical next steps:

1. Add DuckDB schema for worker heartbeats, queue progress, per-backlog claim or lease state, and judgment-job SQLite health or claim projection.
2. Add heartbeat writes and stale-worker pruning.
3. Update queue consumers to create claims or leases when work starts, refresh them while active, and stamp progress on successful batch completion.
4. Make review refresh claims explicitly project-scoped from the first cutover slice, with article-refresh work preserving `projectId` plus `articleId` or equivalent batch scope.
5. Add maintenance-owned writes for judgment-job SQLite health and claim projection refresh, including `jobId`, `projectId`, `queueRecordId`, `articleId`, prompt, model, and content-setting identity where queue truth depends on it.
6. Add registry queries for eligible maintenance consumers by capability across all fresh worker heartbeats.
7. Add shared projection or heartbeat fields for `judge-worker` completion-outbox backlog and last acknowledged completion timestamp.
8. Add maintenance-candidate takeover-intent writes and readers for the ownerless-readable backend.
9. Add shared recovery-state projection for maintenance active cap, restart gate, breaker cooldown, and project-scoped retry-after or paused-at-floor maintenance states.

Quality Gates:

- When a gate below names a current writer-era file that this phase renames, run the same gate against the final renamed replacement file.
- `bun run db:mig`
- `bun test src/server/utils/writerConnections.test.ts`
- `bun test src/server/services/projectMartRefreshStateService.test.ts src/server/services/projectMartLargeRebuildStateService.test.ts`
- `bun test src/server/routes/AdminInvestigateRoutes.test.ts`
- `bun test src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.test.ts`
- `bun test src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarningsTrigger.test.ts`
- `bun test src/server/routes/JudgmentsJobsRoutes.test.ts`
- `bun x eslint src/server/utils/writerConnections.ts src/server/utils/writerConnectionHeartbeat.ts src/server/routes/WriterConnectionsRoutes.ts src/server/routes/AdminInvestigateRoutes.ts src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.ts src/server/routes/JudgmentsJobsRoutes.ts`
- Runtime verification:
  - when the active owner disappears but a standby `maintenance-worker` candidate is present, diagnostics and health show takeover in progress instead of `waiting_for_maintenance_worker`
  - when live read-only DuckDB is not the deployment choice, ownerless routes still answer from the mirrored ownerless-readable backend
  - ownerless diagnostics and product routes can still report mirrored takeover intent, shared queue progress, and shared SQLite health without an active owner when the deployment promises those answers; later maintenance recovery fields such as active cap rung, breaker cooldown, and project-scoped retry-after or paused-at-floor states are verified in Phase 5 once those producers exist

## Phase 3. Make Health And UI Honest

Layers:

- server
- client

Changes:

- Add explicit queue-consumer state to project warnings and job health APIs.
- Replace `in progress` copy when no eligible consumer is present.
- Use shared worker and scoped queue state as the source of truth.
- Surface `waiting_for_maintenance_worker` clearly.
- Surface DuckDB restart-gate, cooldown-after-OOM, paused-at-memory-floor, and heavy-work-breaker states distinctly from generic blocked or stalled states when shared state can support them.
- Keep those status routes locally answerable on `api` from audited read-only/shared state or the mandatory ownerless-readable backend even when no owner is active.

Practical next steps:

1. Extend review warnings API with project-scoped queue consumer state.
2. Extend judgment job health API with consumer-role and last-progress fields.
3. Update all affected review UI messaging for:
   - active processing
   - queued
   - blocked
   - stalled
   - repair required
4. Add explicit timestamps in UI for latest queue progress.
5. Do not treat unrelated project activity as local `processing`; the requested project must only show `processing` when its own scoped claims or leases are fresh.
6. Add `retryAfterAt` handling and blocked-reason messaging for cooldown-after-OOM, paused-at-memory-floor, and heavy-work-breaker states.

Quality Gates:

- `bun test src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.test.ts`
- `bun test src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarningsTrigger.test.ts`
- `bun test src/server/routes/JudgmentsJobsRoutes.test.ts`
- `bun x eslint src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.ts src/server/routes/JudgmentsJobsRoutes.ts src/components/main/reviews/reviewsWarningsQuery.ts src/components/main/reviews/reviewsProjectWarnings.tsx src/components/main/reviews/reviewsIndexingProgress.tsx src/components/main/reviews/reviewsArticlesTable/reviewsArticlesTableContainer.tsx src/components/main/reviews/reviewsArticlesTable/reviewsArticlesUnassessedTableContainer.tsx`
- `bun run build`
- `bun run desktop:build`
- Browser verification:
  - review warning shows `waiting for maintenance worker` when appropriate
  - judgment job page does not show false `in progress`
  - review empty states distinguish blocked from stale
  - review and judgment health surfaces show cooldown or paused-at-floor memory states with explicit `retryAfterAt` when applicable

## Phase 4. Complete The `judge-worker` Split

Layers:

- server
- database
- docs

Changes:

- Introduce the non-owner `judge-worker` role.
- Keep local judgment-job SQLite state, SQLite leases, import, repair, queue insertion, and claim persistence on `maintenance-worker`.
- Add owner-backed dispatch, completion, and judgment-job control APIs so `judge-worker` can run without direct DuckDB writes or direct SQLite ownership.
- Let `judge-worker` read immutable article or prompt or project or model or provider inputs through a dedicated read-only query path when that path is validated, but only when those reads are keyed by the frozen claim snapshot stored in the immutable execution snapshot store.
- Keep full-text fetch and conversion on `maintenance-worker` and freeze prompt-ready article input or immutable content refs before claim issuance so `judge-worker` never needs live full-text fetch or conversion during execution.
- Support separate-host `judge-worker` deployment by making maintenance-owned immutable snapshot fetch the required fallback whenever validated local read-only snapshot access is unavailable on that host.
- Make dispatch claim, completion, and shared-projection contracts carry `jobId`, `projectId`, `claimId`, `executionSnapshotId`, `executionSnapshotHash`, `queueRecordId`, `articleId`, `promptId`, `modelId`, `useTitle`, `useAbstract`, `useFulltext`, and `useFulltextNoImages` as part of judgment work identity.
- Freeze benchmark-critical execution inputs at claim time in the immutable execution snapshot store before claim issuance, including prompt text or prompt version or hash, model or provider runtime resolution, content settings, exact prompt-ready article input or immutable article-content refs, and reliability-affecting options when present.
- Add a durable `judge-worker` claim journal and completion outbox in a file-backed local SQLite database on durable app-data storage, keyed by a stable configured logical worker id or explicit journal path plus exclusive file locking, and fail closed if that store is unavailable or already claimed by another process.
- Carry token-use summaries and failed-request diagnostics inside that durable completion outbox so `judge-worker` never writes `app.token_use` or other DuckDB-backed completion metadata directly.
- Move LLM execution onto `judge-worker` while keeping queue source-of-truth mutations and persisted judgment writes owner-backed.
- Remove production code paths that expect combined judging plus maintenance roles.

Practical next steps:

1. Add owner-backed APIs or RPC methods for claim issuance, immutable snapshot lookup or fetch from the persisted snapshot store, completion bookkeeping, token-use apply, lease sync, and judgment-job control operations, carrying `jobId`, `projectId`, `claimId`, `executionSnapshotId`, `executionSnapshotHash`, `queueRecordId`, `articleId`, and the benchmark-critical judgment config tuple.
2. Move `PATCH /api/judgmentsjobs/:id`, `POST /api/judgmentsjobs/:id/start-clean`, `POST /api/judgmentsjobs/:id/preflight`, `POST /api/judgmentsjobs/:id/drain`, `POST /api/judgmentsjobs/:id/checkpoint`, `POST /api/judgmentsjobs/:id/repair`, `POST /api/judgmentsjobs/:id/quarantine`, `POST /api/judgmentsjobs/:id/unquarantine`, and `DELETE /api/judgmentsjobs/:id` behind maintenance-owned handlers, even if the public route stays stable.
3. Split the current `sendToLLM` path so `judge-worker` resolves immutable snapshot inputs, prepares prompts, and invokes the LLM without calling live full-text fetch or conversion, writes accepted claims and resulting completions plus token-use summaries to a durable file-backed local SQLite journal or outbox in app-data storage, keys that store from a stable configured logical worker id or explicit journal path, protects it with an exclusive file lock, replays unacked rows on startup before fetching new claims, and only then posts idempotent completion callbacks that maintenance applies to queue truth and token-use persistence.
4. Keep claim persistence and local SQLite ownership on `maintenance-worker` while `judge-worker` consumes owner-issued claim batches, durably records accepted claim state, and completion bookkeeping validates `claimId`, `jobId`, `projectId`, `queueRecordId`, `articleId`, `executionSnapshotId`, and `executionSnapshotHash` before applying source-of-truth updates and token-use writes exactly once.
5. Keep `runAddToQueue` on `maintenance-worker` and move `sendToLLM` onto `judge-worker` behind judging capability helpers.
6. Ensure `judge-worker` only uses read-only DuckDB helpers for immutable reference data or snapshot-keyed lookups when validated on that host, otherwise fetches immutable snapshots from maintenance-owned APIs; in all cases it must never open DuckDB in write mode, never mutate local judgment-job SQLite state directly, never call live full-text helpers, and must be kept off owner-capable helpers by restricted-import lint or tests plus runtime guards.
7. Keep judgment-job health readable from shared projection on `api`, with owner-proxy fallback when projection freshness is insufficient.
8. Project pending completion-ack backlog and snapshot mismatch failures into shared health or diagnostics.
9. Express dispatch, completion, and control-plane flows with `Effect.gen`, `Layer`, and `Schedule`.
10. Remove combined-role startup and routing paths from the shipped runtime surface.

Quality Gates:

- `bun run db:mig`
- `bun test src/server/routes/ApiProxyRoutes.test.ts`
- `bun test src/server/routes/JudgmentsJobsRoutes.test.ts`
- `bun test src/server/indexStartup.test.ts`
- `bun test scripts/runWithRuntimeProfile.test.ts`
- `bun test src/server/cron/judgmentsJobs/judgmentDispatchRuntime.test.ts src/server/cron/judgmentsJobs/judgmentJobSqliteService.test.ts src/server/cron/judgmentsJobs/judgmentsRequestRuntime.test.ts src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM.test.ts src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM/getAndUpdateReadyPrompts.test.ts`
- `bun test src/agent/judge/judgeStoreTokenUse.test.ts`
- `bun x eslint src/server/cron/judgmentsJobs.ts src/server/cron/judgmentsJobs/judgmentDispatchRuntime.ts src/server/cron/judgmentsJobs/judgmentJobSqliteService.ts src/server/cron/judgmentsJobs/judgmentsRequestRuntime.ts src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM.ts src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM/processPromptWithLLM.ts src/server/utils/ensureFullText.ts src/server/routes/JudgmentsJobsRoutes.ts src/server/serverMain.ts src/agent/judge.ts src/agent/judge/storeSinglePromptJudgment.ts src/agent/judge/judgeStoreTokenUse.ts`
- Runtime verification:
  - `judge-worker` replays an unacked completion after `maintenance-worker` restart and the completion is applied exactly once
  - `judge-worker` startup fails closed when neither `JUDGE_WORKER_ID` nor `JUDGE_WORKER_JOURNAL_PATH` resolves a stable durable journal target or when the resolved target is missing, unstable, unwritable, or non-durable
  - a second `judge-worker` started with the same journal path deterministically refuses startup instead of sharing SQLite state
  - a separate-host `judge-worker` without validated local read-only access can still execute claimed work by fetching immutable snapshots from maintenance-owned APIs
  - mutating prompt or provider settings after claim issuance does not change the `judge-worker` execution inputs for that already-issued claim
  - `judge-worker` never calls live full-text fetch or conversion during execution; claims that need fulltext resolve entirely from immutable snapshots or maintenance snapshot fetch
  - replaying a completion outbox row after maintenance restart does not double-count token use
  - completion callback rejects snapshot mismatch instead of binding work to current mutable prompt or provider state

## Phase 5. Make Maintenance Queues Always Consumable And OOM-Recoverable

Layers:

- server
- docs

Changes:

- Replace current low-memory `disable` logic for required maintenance with adaptive throttling.
- Keep import and refresh consumers eligible even at low memory.
- Constrain them to smaller work units instead of turning them off.
- Add explicit fair scheduling so required queues cannot be starved by rebuild, full-text, or cleanup work.
- Keep the option to use isolated child processes for import and refresh batches.
- Add a shared `maintenance-worker` DuckDB OOM recovery governor plus active-cap accessor.
- Derive the first DuckDB open from the highest safe active cap rung at or below the configured ceiling instead of opening at the raw ceiling.
- Use one controlled in-process DuckDB restart gate for cap step-down and fatal-runtime recovery so non-DuckDB API flow stays up while DuckDB-backed work waits.
- Apply project-local retry-after cooldown and paused-at-floor semantics to review refresh and large rebuild OOM recovery instead of immediate retry thrash.
- Tie predictive refresh admission, rebuild tuning, and adaptive throughput profiles to the current active cap rung rather than the configured ceiling alone.
- Add a bounded `maintenance-worker` heavy-work breaker for repeated no-context or cross-project OOM pressure.
- Keep the breaker scoped to named heavy maintenance loops such as review refresh, large rebuild, full-text fetch, full-text conversion, heavy archival cleanup, and any optional bulk import outside the protected SQLite retained-outbox path; keep protected SQLite retained-outbox import on its adaptive bounded-service path unless its own work is in explicit cooldown, and keep lighter control-plane work, small housekeeping cleanup, and non-DuckDB API flow available.
- Make operator-triggered heavy maintenance respect both project-local cooldown and breaker cooldown with explicit blocked responses.
- Extend `/api/admin/worker-runtime-diagnostics` to expose shared maintenance recovery state when available, including configured DuckDB ceiling, derived startup rung, current active cap rung, controlled restart-gate state, heavy-work breaker cooldown, and current maintenance `retryAfterAt` context.

Practical next steps:

1. Add shared adaptive throughput profiles derived from the active DuckDB memory cap.
2. Add a shared DuckDB OOM governor and `isDuckdbOutOfMemoryError(...)` helper, seed it during runtime bootstrap before the first DuckDB open, and derive the startup rung from the configured ceiling.
3. Add a controlled in-process DuckDB restart gate that serializes through the main DuckDB queue, drains append and background work, and reopens lazily on the next query after cap step-down.
4. Define per-profile values for:
   - import batch rows
   - import batch bytes
   - rebuild batch size
   - max cycles per wake
   - refresh claim concurrency
5. Apply those profiles to:
   - SQLite outbox import
   - project refresh claim loops
   - large rebuild loops
6. Reuse existing refresh or rebuild state where possible to represent retry-after cooldown, keep failed cooled-down work behind fresh claimable work after cooldown, and keep floor-exhausted work in `paused` until explicit operator resume.
7. Add protected versus opportunistic queue classes plus a bounded-slice or weighted-round-robin scheduler so import and review refresh always get service before opportunistic work can consume extra slices.
8. Ensure every loop can continue with `small` profile settings and lower active cap rungs.
9. Add a bounded heavy-work breaker that pauses only named heavy maintenance loops after repeated no-context or cross-project OOM pressure, auto-resumes after cooldown, and surfaces `retryAfterAt` in diagnostics or operator responses.
10. Add starvation alarms when a ready protected queue exceeds its no-progress window while the worker heartbeat remains healthy.
11. Update `/api/admin/worker-runtime-diagnostics` to read the shared maintenance recovery-state projection so diagnostics show configured ceiling, startup rung, active cap rung, restart-gate state, breaker cooldown, and maintenance retry-after context from shared truth.

Quality Gates:

- `bun test src/server/services/projectMartRefreshStateService.test.ts src/server/services/projectMartLargeRebuildStateService.test.ts src/server/services/projectMartLargeRebuildCyclesService.test.ts`
- `bun test src/server/utils/projectMartLargeRebuildHeartbeat.test.ts`
- `bun test src/server/utils/duckdbServiceReload.test.ts src/server/utils/duckdbServiceMemoryLimit.test.ts src/server/utils/backgroundServerStack.test.ts src/server/utils/martRefreshDrainHeartbeat.test.ts`
- `bun test src/server/workers/projectMartRefreshWorker.test.ts src/server/services/projectMartLargeRebuildRunner.test.ts`
- `bun test src/server/cron/judgmentsJobs/judgmentJobSqliteOutboxImport.test.ts`
- `bun test src/server/routes/AdminInvestigateRoutes.test.ts src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.test.ts src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarningsTrigger.test.ts`
- `bun x eslint src/server/utils/projectMartLargeRebuildTuning.ts src/server/workers/projectMartRefreshWorker.ts src/server/cron/judgmentsJobs/judgmentJobSqliteOutboxImport.ts src/server/utils/duckdbService.ts src/server/utils/backgroundServerStack.ts src/server/utils/startBackgroundWork.ts src/server/utils/projectMartRefreshWorkerHeartbeat.ts src/server/utils/projectMartLargeRebuildHeartbeat.ts src/server/cron/fullTextJobs.ts src/server/cron/fullTextConversionJobs.ts src/server/cron/judgmentsJobs.ts src/server/routes/AdminInvestigateRoutes.ts`
- Runtime verification:
  - the first DuckDB startup uses the highest active rung at or below the configured ceiling instead of booting at the raw ceiling
  - a controlled in-process restart drains queued DuckDB work cleanly and reopens DuckDB at the lower rung after cap step-down
  - project-local refresh or rebuild OOM attaches cooldown, retries behind fresh claimable work after cooldown, and pauses at the floor rung with explicit operator-visible reason
  - under the `small` profile with simultaneous import, review refresh, rebuild, and full-text backlog, import and review refresh each record bounded forward progress instead of waiting indefinitely behind opportunistic work
  - repeated no-context or cross-project OOMs trip the heavy-work breaker, pause only named heavy maintenance loops, keep lighter maintenance and non-DuckDB API flow available, and auto-resume after cooldown
  - a healthy `maintenance-worker` surfaces explicit starvation diagnostics before a protected queue exceeds its allowed no-progress window
  - worker diagnostics surface configured ceiling, startup rung, active cap rung, controlled restart-gate state, and breaker cooldown from shared recovery state while those recovery paths are active

## Phase 6. Separate Repair From Normal Drain

Layers:

- server
- docs

Changes:

- Keep normal maintenance drain lightweight and automatic.
- Keep repair logic explicit and resumable.
- Add a maintenance-worker-safe auto-recovery loop for small retained backlog.
- Reserve full offline repair for larger or repeated failure cases.
- Keep floor-exhausted refresh and rebuild work in explicit `paused` state with operator resume paths instead of collapsing them into generic repair-required or endless retry states.

Practical next steps:

1. Define thresholds for:
   - safe live import retry
   - maintenance-worker auto-repair
   - offline repair required
2. Record recovery mode in health responses.
3. Teach maintenance-worker to auto-run small safe repair operations.
4. Preserve offline repair for larger retained backlog and repeated append OOM.
5. Keep project-local OOM cooldown and paused-at-floor state separate from offline repair so operators can resume normal work without manual DB edits.

Quality Gates:

- `bun test src/server/cron/judgmentsJobs/judgmentsJobsCleanupStale.test.ts src/server/cron/judgmentsJobs/judgmentJobSqliteService.test.ts`
- `bun test src/server/routes/JudgmentsJobsRoutes.test.ts`
- `bun x eslint src/server/cron/judgmentsJobs/judgmentJobRepair.ts src/server/routes/JudgmentsJobsRoutes.ts`
- Runtime verification:
  - small retained backlog auto-repair can run without collapsing normal drain into generic offline repair
  - larger retained backlog or repeated append OOM surfaces explicit offline repair or paused recovery state instead of silently looping normal drain
  - health responses expose `recoveryMode` so cooldown, auto-repair, offline repair, and paused-at-floor states are distinguishable without parsing free-form text

## Phase 7. Add Queue Progress SLAs And Stall Detection

Layers:

- server
- client

Changes:

- Use the queue-level `lastProgressedAt`, `lastStartedAt`, and active-work counters persisted in Phase 2 for:
  - judgment import backlog
  - article refresh backlog
  - project refresh backlog
  - rebuild backlog
- Do not add a second timestamp or counter store for stall detection; Phase 7 should derive from the Phase 2 queue-progress source of truth.
- Compute stalled state from:
  - queue depth
  - active work presence
  - last progress age
  - eligible consumer presence
  - absence of any explicit blocked or repair-required recovery state

Practical next steps:

1. Add health rules and backlog-specific stale-drain windows using the Phase 2 persisted timestamps, active-work counters, and claim freshness rules.
2. Update UI to show `stalled` only when a consumer should be progressing but is not.
3. Keep `blocked` and `repair_required` separate from `stalled`; an explicit cooldown, breaker, paused-at-floor, or offline-repair state must not be relabeled as stalled.
4. Add explicit operator thresholds for acceptable queue delay by backlog type.

Quality Gates:

- `bun test src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.test.ts`
- `bun test src/server/routes/JudgmentsJobsRoutes.test.ts`
- `bun run build`
- `bun run desktop:build`
- Runtime verification:
  - a queue with an eligible consumer, no explicit blocked or repair state, and expired no-progress window surfaces `stalled`
  - a queue in cooldown, paused-at-floor, breaker, or offline-repair state remains `blocked` or `repair_required` instead of flipping to `stalled`
- Browser verification:
  - review and judgment surfaces show `stalled` only for true stale-drain cases and keep blocked or repair states distinct in both web and desktop flows

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
- Runtime verification:
  - a higher-memory profile increases maintenance throughput versus `small` for the same representative backlog without changing queue correctness semantics or blocked-state behavior
  - diagnostics show the active throughput profile and current active cap rung so operators can explain why throughput changed

## Rollout Order

Recommended dependency order for the workstreams:

1. role capability map and explicit owner semantics
2. shared worker registry and persisted queue progress
3. owner-backed judgment dispatch and explicit `judge-worker` split, landed in the same cutover slice as honest health and status server contracts
4. remaining honest health UI states and copy cleanup
5. adaptive maintenance throttling plus `maintenance-worker` DuckDB OOM recovery governor instead of disablement
6. auto-repair thresholds
7. stall detection and SLAs
8. high-memory throughput optimization

This order matters because role semantics and owner election need to be defined before shared status can describe them accurately, the cutover slice ships the shared registry and queue truth together with the final `judge-worker` split and the Phase 3 server contract, and throughput tuning should not start before correctness is guaranteed under the shipped topology.

## Operational Model After Implementation

### Low-Memory Single Machine

- one machine can still host separate `api`, `maintenance-worker`, and `judge-worker` processes under a low-memory profile
- queues continue to drain slowly but correctly
- UI says `processing`, `queued`, or `blocked`, never fake `in progress`
- if one refresh or rebuild still OOMs, `maintenance-worker` steps the active cap down, cools only that work, and keeps unrelated work and non-DuckDB API flow alive

### Mixed-Memory Setup

- one or more `api` processes remain the non-owner public surface for the split deployment
- low-memory `judge-worker` handles LLM dispatch work safely after Phase 4
- higher-memory `maintenance-worker` drains import and review backlog faster
- no cross-role ambiguity about who owns backlog queues
- work that still fails at the floor rung pauses locally with explicit operator recovery instead of destabilizing unrelated maintenance work

### Separate-Host Judge-worker

- separate-host `judge-worker` deployment is supported for the cutover release
- shared local DuckDB file access is optional, not assumed
- when validated local read-only snapshot access is unavailable on that host, `judge-worker` fetches immutable snapshot payloads from maintenance-owned APIs and still preserves frozen execution identity

### High-Memory Single Machine

- one machine may still host all long-term roles, but as separate `api`, `maintenance-worker`, and `judge-worker` processes
- adaptive profile scales up automatically
- throughput improves without changing queue correctness guarantees

## Risks

- adding roles without shared worker state will still confuse operators
- making maintenance adaptive but not resumable will just create slower failure loops
- auto-repair without thresholds can interfere with valid paused states
- stale worker heartbeats can create ghost-capacity signals if cleanup is weak
- stale ownerless-control mirrors can misreport takeover or queue state if freshness rules are weak
- scaling high-memory fast paths too early can reintroduce OOM instability
- an active-cap ladder that is too coarse or too machine-specific can either leave performance on the table or step down more aggressively than needed
- a controlled DuckDB restart gate can deadlock or over-serialize work if it does not share the same queue ordering rules as normal DuckDB work
- breaker thresholds that are too sensitive can suppress useful maintenance work during transient pressure spikes

## Success Criteria

The system is fixed when all of these are true:

1. Review-index backlog never depends on a low-memory judge-only worker to drain.
2. Required maintenance queues always have an eligible consumer or an explicit blocked state.
3. Cross-process health answers come from shared persisted state, not whichever process handled the request.
4. Low-memory systems continue to make progress, even if slowly.
5. Higher-memory systems drain the same queues faster without special-case behavior.
6. UI and API no longer claim generic progress when no worker is actually draining the queue.
7. An LLM completion is not lost if `maintenance-worker` restarts or the network blips after the model returns; the completion is replayed until maintenance acknowledges it exactly once.
8. During cutover, incompatible old and new runtimes fail closed instead of serving mixed routing, lease, or health semantics.
9. Every route that promises ownerless answers has a mandatory ownerless-readable backend in the deployment, so the route stays honest even when owner proxying is unavailable.
10. Separate-host `judge-worker` deployments can execute claimed work through validated local read-only snapshot access or the maintenance-owned immutable snapshot fetch fallback; cutover does not assume shared local DuckDB file access.
11. Under the low-memory profile with simultaneous backlog, import and review refresh still make bounded forward progress instead of waiting behind rebuild or full-text work.
12. No post-cutover owner adopts or replaces a legacy writer lease while that legacy writer is still reachable or its lease is still fresh.
13. The first DuckDB open on `maintenance-worker` uses the highest active rung at or below the configured ceiling instead of booting at the raw ceiling.
14. A DuckDB OOM in review refresh or large rebuild does not require restarting `maintenance-worker`.
15. The active DuckDB cap steps down automatically through the configured ladder until the floor rung and that active rung is visible in diagnostics.
16. Work that still OOMs at the floor rung transitions to `paused` with explicit operator resume instead of remaining in retryable `failed` state forever.
17. Repeated no-context or cross-project DuckDB OOM bursts activate a bounded heavy-work breaker that pauses only named heavy maintenance loops and auto-resumes later.
18. Non-DuckDB API flow stays up while DuckDB-backed work waits behind the controlled restart gate.

## Practical Next Step To Start Implementation

Start with Phase 1, Phase 2, and Phase 4 together, and include the server-contract work from Phase 3 in the same cutover slice.

Why:

- Phase 1 fixes the final runtime surface and naming.
- Phase 2 gives `api` a shared worker registry, project-scoped and article-scoped queue progress source of truth, SQLite health projection, and takeover-intent view so status routes stay honest after the role split.
- the server-contract work from Phase 3 makes review warnings and judgment health describe the real shared state instead of owner-local snapshots.
- Phase 4 makes the long-term `judge-worker` path real instead of leaving a combined-role gap.
- the same slice must add the mandatory ownerless-readable backend, cutover-version refusal, cutover fencing, frozen claim snapshots, maintenance-owned immutable snapshot fetch fallback, and durable completion replay so the split fails closed rather than losing work.

Suggested first implementation slice:

1. replace production roles with explicit `api`, `maintenance-worker`, and `judge-worker`
2. add explicit route classification plus proxy-by-default safety with an audited local-read allowlist
3. add the dedicated read-only query path for audited `api` routes plus the mandatory ownerless-readable backend for routes that must answer without an active owner
4. migrate writer-named env, runtime-profile, persisted-config, local-settings, settings UI, rebuild-tuning, client-query, package-script, dev-watch, CLI-helper, desktop-startup, route, lease, and runtime-service naming surfaces to owner or maintenance-worker naming, including one-time DuckDB and local settings rewrite
5. add persisted worker heartbeat, project-scoped and article-scoped queue progress, shared SQLite health projection, and maintenance takeover intent
6. expose local capabilities and registry-derived eligible consumers across separate worker processes in diagnostics
7. extend review warnings and judgment-job health APIs so they answer from shared or read-only state and report honest consumer semantics
8. add owner-backed judging APIs that preserve `jobId`, `projectId`, `claimId`, `executionSnapshotId`, `executionSnapshotHash`, `queueRecordId`, `articleId`, and the benchmark-critical judgment config tuple, back them with an immutable execution snapshot store, add `JUDGE_WORKER_ID` or explicit `JUDGE_WORKER_JOURNAL_PATH` startup wiring, move `sendToLLM` onto `judge-worker` with a durable file-backed local SQLite claim journal and completion outbox keyed by that stable logical id or explicit journal path plus replay, and support maintenance-owned immutable snapshot fetch for separate-host `judge-worker` fallback
9. add cutover-version checks and the cutover-migration fence so incompatible writer-era peers or fresh reachable legacy writer leases refuse startup or serving during the release

That is the smallest useful step that creates the actual end-state topology instead of a temporary bridge or a role split that still depends on owner-local health.

## First Coding Slice Task List

This section turns the first implementation slice into an actual change list.

## Step 1. Extend Server Roles And Add Capability Helpers

Primary files:

- `package.json`
- `src/server/utils/serverRole.ts`
- `src/server/utils/serverRuntimeRole.ts`
- `src/server/utils/duckdbOwnerLease.ts`
- `src/server/utils/duckdbService.ts`
- `src/server/utils/env.ts`
- `src/server/utils/backgroundServerStack.ts`
- `src/server/utils/runtimeBootstrap.ts`
- `src/server/utils/runtimeProcessIdentity.ts`
- `src/server/utils/runtimeLogger.ts`
- `src/server/utils/writerConnections.ts`
- `src/server/utils/writerWarnings.ts`
- `src/server/utils/ensureFullText.ts`
- `src/server/utils/writerConnectionHeartbeat.ts`
- `src/server/utils/duckdbScriptAccess.ts`
- `src/server/services/getAppQueryService.ts`
- `src/server/services/userConfigQueryService.ts`
- `src/server/routes/UsersRoutes.ts`
- `src/server/utils/localAppSettings.ts`
- `src/server/utils/projectMartLargeRebuildTuning.ts`
- `src/agent/judge/judgeStoreTokenUse.ts`
- `src/agent/judge.ts`
- `src/app/routes/+__root.tsx`
- `src/components/Navigation.tsx`
- `src/app/routes/+admin/+writer-connections/+index.tsx`
- `src/app/routes/+settings/+index.tsx`
- `src/db/duckdbMigrations/`
- `src/db/schemaTypes.ts`
- `src/utils/runtimeProfile.ts`
- `src/utils/writerConnectionsQuery.ts`
- `src/desktop/index.ts`
- `src/desktop/getDesktopRuntimeConfig.ts`
- `scripts/reproArchivedProjectServingDelete.ts`
- `scripts/reproArchivedProjectServingDelete.test.ts`
- `scripts/benchmarkDuckdbAppendLanes.ts`
- `scripts/recoverProjectMartRefreshClaims.ts`
- `scripts/projectMartRefreshRecovery.test.ts`
- `scripts/recoverArchivedProjectRefreshQueue.test.ts`
- `scripts/recoverJudgmentJobWithSystemSqlite.test.ts`
- `scripts/dbBackup.test.ts`
- `scripts/devServerWatch.ts`
- `scripts/runWithRuntimeProfile.ts`
- `scripts/startServerStack.ts`
- `docs/README_RUN_LOCAL.md`

Changes:

- Add `maintenance-worker` to `serverRoles`.
- Add `judge-worker` to `serverRoles`.
- Remove production `writer`, `auto`, and `worker` role support.
- Keep `dev-single` only as a local testing role if still needed.
- Rename writer or background-writer env, runtime-profile, persisted-config, local-settings, settings UI field, rebuild-tuning, stored-type, client-query, and desktop-readiness names to maintenance-worker naming through one-time DuckDB and local `forska.settings.json` migration, without keeping public legacy aliases after upgrade.
- Replace generic runtime service identities such as `worker-server` and `single-server` with explicit split-role service names in bootstrap, process identity, heartbeat payloads, diagnostics, and runtime log naming, for example `api-server`, `maintenance-worker-server`, `judge-worker-server`, and `dev-single-server`, so maintenance and judge processes are distinguishable after cutover while `app-server` remains the app-shell process name where applicable.
- Add the canonical split-runtime `judge-worker` durability config surface: `JUDGE_WORKER_ID` required when `JUDGE_WORKER_JOURNAL_PATH` is omitted, optional explicit `JUDGE_WORKER_JOURNAL_PATH`, deterministic app-data path derivation from the id when the path is omitted, and fail-closed startup when neither value resolves a stable durable journal target or when the resolved target is missing, unstable, unwritable, or non-durable.
- Make env the canonical runtime contract for `judge-worker` journal identity, and have runtime profiles, local stack scripts, and desktop startup pass it through rather than inventing separate naming.
- Rename the writer-connections query, admin route, navigation warning surface, root backend-availability probe, and desktop readiness probe to owner or worker-registry naming in the same cutover.
- Rename warning kinds and user-facing warning copy that still say `writer`, such as `writer-disabled` or `unresponsive-writer`, to owner or maintenance-worker terminology in the same cutover.
- Rename package scripts, dev-watch helpers, DuckDB CLI guards, and local run docs that still expose writer-era roles, env vars, or `/api/writer_connections`, so operator entry points move to the readiness-plus-worker-registry contract in the same cutover.
- Rename script-level `SERVER_ROLE=writer` and `SERVER_WRITER_URL` overrides in maintenance helper scripts and their tests, so repo tooling no longer depends on removed writer-era role names after cutover.
- Audit current `getAppQueryService()` local-read call sites and either keep them owner-proxied or move them onto dedicated read-only helpers; do not leave audited `api` routes on owner-capable query opens.
- Update low-level DuckDB service and role tests, plus downstream service and route tests that still hardcode `writer`, `worker`, `auto`, `SERVER_WRITER_URL`, or writer-era lease filenames, because those assumptions are part of the cutover contract too.
- Replace remaining runtime behavior that branches on removed `writer` or `worker` roles, including low-memory token-use persistence suppression and similar role-string checks outside startup.
- Add the deployment-level contract for the mandatory ownerless-readable backend used by routes that must answer without an active owner.
- Replace the current coarse helpers with capability helpers, for example:
  - `canServerRoleOwnDuckdb(...)`
  - `shouldServerRoleRunMaintenance(...)`
  - `shouldServerRoleRunJudging(...)`
  - `shouldServerRoleProxyApiToDuckdbOwner(...)`
- Keep `api`, `judge-worker`, and any future non-owner roles from accidentally claiming owner-only work.
- Add cutover-version constants and startup refusal for incompatible writer-era peers.
- Add cutover-migration fencing so legacy writer reachability and lease freshness are checked before lease adoption or replacement is allowed.

Why these files first:

- `serverRole.ts` is currently the single place where runtime role semantics are encoded.
- `serverRuntimeRole.ts` already exposes the live effective role used by diagnostics and startup.
- the env, runtime-profile, and stored config files are the current source of writer-era naming that must disappear in the same cutover

Acceptance criteria:

- role helpers express capabilities, not just owner vs not-owner
- production startup supports only the final explicit roles
- persisted and user-facing maintenance memory settings use the final maintenance-worker naming only
- settings UI, diagnostics queries, backend-availability probes, admin routes, and desktop readiness no longer expose writer-era names
- package scripts, local run docs, dev-watch helpers, and DuckDB CLI guards no longer expose writer-era commands or use `/api/writer_connections` as the bootstrap contract
- maintenance helper scripts and their tests no longer require `SERVER_ROLE=writer` or `SERVER_WRITER_URL`
- user-facing warning kinds and warning copy no longer expose writer-era terms such as `writer-disabled` or `unresponsive-writer`
- bootstrap, runtime logs, process identity, and heartbeat or registry service labels use canonical explicit split-role service names such as `api-server`, `maintenance-worker-server`, `judge-worker-server`, and `dev-single-server` rather than generic `worker-server` or `single-server` in production split deployments
- audited `api` local-read routes no longer rely on owner-capable `getAppQueryService()` or `getAppDatabaseService()` paths
- no shipped runtime behavior still branches on removed `writer` or `worker` roles
- `judge-worker` startup requires stable `JUDGE_WORKER_ID` or `JUDGE_WORKER_JOURNAL_PATH` wiring through env, runtime profiles, local stack scripts, and desktop startup, and refuses startup when that contract is missing or when the resolved journal target is missing, unstable, unwritable, or non-durable
- startup validates that each ownerless route has a configured mandatory ownerless-readable backend in the deployment
- DuckDB owner election works on `maintenance-worker` candidates, and SQLite-backed judgment takeover is explicitly limited to candidates that run on the same host and share the same data volume
- startup refuses incompatible pre-cutover peers instead of attempting mixed-mode operation
- startup refuses lease adoption or replacement while a legacy writer is still reachable or its lease is still fresh

## Step 2. Split Background Startup And Owner Routing By Capability

Primary files:

- `src/server/utils/startBackgroundWork.ts`
- `src/server/utils/martRefreshDrainHeartbeat.ts`
- `src/server/utils/projectMartLargeRebuildHeartbeat.ts`
- `src/server/utils/projectMartRefreshWorkerHeartbeat.ts`
- `src/server/cron/fullTextJobs.ts`
- `src/server/cron/fullTextConversionJobs.ts`
- `src/server/cron/judgmentsJobs.ts`
- `src/server/cron/nvidiaSmi.ts`
- `src/server/serverMain.ts`
- `src/server/utils/backgroundServerStack.ts`
- `src/server/routes/WriterConnectionsRoutes.ts`
- `src/server/routes/ApiProxyRoutes.ts`
- `src/server/utils/writerConnectionHeartbeat.ts`
- `src/server/utils/duckdbScriptAccess.ts`

Changes:

- Change `startBackgroundWork()` so it starts different loops by capability.
- Keep runtime role monitor and owner-heartbeat infrastructure shared.
- Start mart refresh drain only when maintenance capability is true.
- Stop relying on one coarse owner gate for all crons.
- Split the current `writerCronRoutes` bundle into explicit maintenance, judging, and process-local diagnostics mounts.
- Mount `fullTextJobsCron`, `fullTextConversionJobsCron`, and `nvidiaSmiCron` on `maintenance-worker` in the cutover release instead of letting them disappear behind removed writer gating.
- Keep `nvidiaSmiCron` maintenance-owned in the cutover release because it polls separate GPU worker processes or hosts and persists shared operator telemetry into DuckDB; do not duplicate it across `api` or `judge-worker` processes.
- Mount the public product route tree only on `api`; keep `maintenance-worker` on its private owner-backed RPC or control plus internal health surface, and keep `judge-worker` off public product routes entirely.
- Add explicit route classification and keep `/api/*` proxy-by-default until routes are audited for local-read safety.
- Expose the dedicated bootstrap-safe readiness route on `api` independently from the detailed worker-registry route.
- Replace `writer_connections` heartbeat and polling clients with readiness and worker-registry aware behavior; use readiness for bootstrap and keep detailed owner or worker status on the renamed registry route.
- Replace the private `/api/writer_connections/heartbeat` route with an explicit owner-backed worker-registry or heartbeat-write route, and move runtime heartbeats onto that renamed contract with cutover-version checks.
- Introduce the dedicated read-only query path used by local `api` reads.
- Route ownerless health and diagnostics APIs through the mandatory ownerless-readable backend when live read-only DuckDB is unavailable or untrusted.
- Keep `api` serving locally only the health and diagnostics routes that already answer from audited shared or read-only state; all remaining owner-dependent routes stay proxied to the active DuckDB owner until Step 3 lands and the later route-specific audits switch them onto shared or read-only truth.
- Preserve lease-follow and takeover behavior on explicit `maintenance-worker` candidates that run on the same host and share the data volume needed for SQLite-backed judgment work.
- Keep any unvalidated local-read flow owner-proxied or snapshot-backed until parity and concurrent-write validation passes.

Current extension points already confirmed:

- `startBackgroundWork()` currently starts `startWriterConnectionHeartbeat()` unconditionally.
- `startBackgroundWork()` currently starts `startMartRefreshDrainHeartbeat()` unconditionally.
- `martRefreshDrainHeartbeat.ts` currently starts `startProjectMartLargeRebuildHeartbeat()` and `startProjectMartRefreshWorkerHeartbeat()` behind writer-era work helpers.
- `serverMain.ts` currently mounts `fullTextJobsCron`, `fullTextConversionJobsCron`, `judgmentsJobsCron`, and `nvidiaSmiCron` through one `writerCronRoutes` gate.

Acceptance criteria:

- a `maintenance-worker` process can start as the DuckDB owner
- a `judge-worker` process can start without DuckDB write ownership
- full-text fetch and full-text conversion continue to run on `maintenance-worker` after writer-role removal
- `nvidia-smi` polling and GPU telemetry persistence continue to run only on `maintenance-worker` after writer-role removal
- the public product route tree is mounted only on `api`, while `maintenance-worker` and `judge-worker` stay on their intended private RPC or diagnostics surfaces
- the dedicated readiness route stays available on `api` without depending on the worker-registry route to become healthy first
- desktop startup, dev-watch helpers, stack launchers, and DuckDB CLI guards no longer rely on `GET /api/writer_connections` as the bootstrap or availability contract
- unclassified `api` routes fail closed to owner proxy instead of accidentally running locally
- `api` still proxies correctly to the active owner for owner-only routes
- until Step 3 shared state lands and the later route-specific audits adopt that shared truth, routes that still require owner-local runtime state remain proxied; once the shared projection exists and an audited health or diagnostics route has been updated to use it correctly, that route answers locally on `api`
- standby same-host `maintenance-worker` candidates sharing the data volume can follow and take over correctly
- live read-only routes fail closed onto the mandatory ownerless-readable backend or proxy or snapshot mode as appropriate when local read-only access is unavailable or untrusted

## Step 3. Add Persisted Worker Heartbeat And Capability Registry

Primary files:

- new worker-registry persistence code under `src/server/utils/` or `src/server/services/`
- `src/server/utils/writerConnections.ts`
- `src/server/utils/writerConnectionHeartbeat.ts`
- renamed worker-registry route replacing `src/server/routes/WriterConnectionsRoutes.ts`
- `src/server/routes/AdminInvestigateRoutes.ts`
- `src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.ts`
- `src/server/routes/JudgmentsJobsRoutes.ts`

Changes:

- Add durable worker heartbeat records for role, capabilities, memory limit, throughput profile, and last heartbeat, covering both the local process and non-local worker processes in the same deployment.
- Have `api`, `maintenance-worker`, and `judge-worker` processes heartbeat through the owner API.
- Add registry queries for eligible maintenance consumers across all fresh worker heartbeats, not only the local runtime role.
- Name worker-registry implementation types and variables around registered or non-local worker processes instead of `remoteWorker*`, unless the value specifically represents a network-remote worker URL or host.
- Add ownerless-readable maintenance takeover-intent records so status routes can show `takeover_in_progress` during owner loss.
- Persist queue-level claim or lease rows for import and refresh work, including claim freshness, `projectId` and `articleId` scope for review work, and `jobId` plus `projectId` plus `queueRecordId` plus `articleId` plus the benchmark-critical judgment config tuple where applicable.
- Persist queue-level and project-scoped `lastStartedAt` for import and refresh work.
- Persist queue-level and project-scoped `lastProgressedAt` for import and refresh work.
- Persist `judge-worker` completion-handoff visibility such as pending completion-ack count and oldest unacked completion age.
- Keep health and status routes owner-proxied until this shared state exists and each route has been audited to use it correctly, then move only those audited routes to local `api` reads against that shared projection.

Acceptance criteria:

- health routes can tell when no maintenance worker exists even if the handling process is not the owner
- `processing` derives from fresh claims or leases, not queue depth or orphaned counters
- `/api/projectsreviewswarnings` can distinguish this project's active work from unrelated project activity
- stale worker records and stale claims age out cleanly and do not create ghost capacity
- shared queue progress exposes `lastStartedAt` and `lastProgressedAt` from persisted state instead of reconstructing them from local runtime snapshots
- shared health can distinguish active LLM work from completion handoff waiting on owner acknowledgment
- shared health and diagnostics can distinguish no maintenance candidate from takeover already in progress during owner loss

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
  - which ownerless-readable backend each ownerless route is using
  - registry-derived eligible consumers by capability across separate worker processes
  - maintenance takeover intent and takeover status when present
  - active adaptive profile or queue policy if derivable
  - read path mode per key route or flow
  - pending completion-ack visibility for `judge-worker` when available
  - cutover runtime version and incompatible-peer refusal status

Acceptance criteria:

- diagnostics clearly show current-process intent, shared worker availability, ownerless backend choice, and whether a missing owner means no candidate or takeover in progress
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
  - `eligibleConsumerCount`
  - `activeConsumerCount`
  - `activeWorkCount`
  - `progressState`
  - `blockedReason`
  - `lastStartedAt`
  - `lastProgressedAt`
  - `retryAfterAt`
  - `recoveryMode`
- Keep current counts (`pendingProjectRefreshCount`, `pendingArticleRefreshCount`) intact.
- Drive those fields from project-scoped persisted claims or leases rather than only queue-wide snapshots.
- Stop mapping `pendingRefreshCount > 0` directly to `status = 'refreshing'` when no eligible consumer exists.
- Update all review UI consumers so blocked queues render as blocked, not generic refresh or empty states.

Current bug source already confirmed:

- `projectsRoutesGetReviewsWarnings.ts` derives `status = 'refreshing'` from queue counts
- it does not know whether any role is actually eligible to drain those queues

Acceptance criteria:

- no review UI says `in progress` when no eligible maintenance worker is running
- unrelated project activity does not make the requested project display `processing`
- review empty states distinguish blocked, stale, and actively processing states
- review warning responses expose `eligibleConsumerCount` and `retryAfterAt` when those values are needed to explain waiting, cooldown, or breaker-blocked states
- review warning responses expose `recoveryMode` when paused-at-floor, cooldown, breaker, or repair context changes the operator or UI explanation
- tests cover the blocked and waiting status
- the API route can still answer from shared/read-only state or the mandatory ownerless-readable backend when the owner is absent after it has been moved off the owner proxy

## Step 6. Make Judgment Job Health Honest About Import Ownership And SQLite State

Primary files:

- `src/server/routes/JudgmentsJobsRoutes.ts`
- `src/server/routes/JudgmentsJobsRoutes.test.ts`

Changes:

- Extend `/api/judgmentsjobs/:id/health` with:
  - `eligibleImportConsumerPresent`
  - `requiredImportConsumerRole`
  - `eligibleImportConsumerCount`
  - `activeImportConsumerCount`
  - `activeImportWorkCount`
  - `progressState`
  - `blockedReason`
  - `lastStartedAt`
  - `lastProgressedAt`
  - `retryAfterAt`
  - `recoveryMode`
- Add shared SQLite health projection fields or equivalent derived fields for:
  - retained outbox presence
  - claimed outbox presence
  - ready or claimed or running prompt presence
  - orphaned judged queue presence
  - WAL size bucket or threshold status
  - pending completion-ack presence
  - oldest unacked completion age
  - projection freshness
  - projection source
- Ensure shared import or running-work summaries preserve the job's model and content-setting tuple instead of collapsing incompatible work into one generic backlog.
- Extend `/api/judgmentsjobs-health` summary aggregation to count jobs blocked on missing maintenance workers or retry-after maintenance cooldown or heavy-work breaker separately from truly stale or failed jobs.
- Keep current `recommendedNextAction` but stop overloading it as the only machine-readable state.
- Read shared SQLite health projection on `api` when it is fresh enough from audited shared state or the mandatory ownerless-readable backend, and proxy to the owner or return explicit maintenance-unavailable when it is not.

Acceptance criteria:

- job health can distinguish:
  - import actively draining
  - import queued but blocked on missing maintenance worker
  - import blocked by cooldown or heavy-work breaker with explicit `retryAfterAt` when the block will auto-clear
  - completion waiting for owner acknowledgment
  - repair required
- job health exposes `recoveryMode` so offline repair, auto-repair, cooldown, and paused-at-floor states are machine-readable without inferring them from text
- job health remains available on `api` even when no owner is active, as long as audited shared/read-only state or the mandatory ownerless-readable backend is sufficient to answer it
- job health never guesses `healthy` from absence of local SQLite state on `api`

## Step 7. Add The First Owner-Backed Judge-worker Execution Path

Primary files:

- `src/server/cron/judgmentsJobs/judgmentDispatchRuntime.ts`
- `src/server/cron/judgmentsJobs/judgmentJobSqliteService.ts`
- `src/server/cron/judgmentsJobs/judgmentJobSqliteService.test.ts`
- `src/server/cron/judgmentsJobs/judgmentsRequestRuntime.ts`
- `src/server/cron/judgmentsJobs/judgmentsRequestRuntime.test.ts`
- `src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM.ts`
- `src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM/processPromptWithLLM.ts`
- `src/server/utils/ensureFullText.ts`
- `src/server/routes/JudgmentsJobsRoutes.ts`
- `src/agent/judge.ts`
- `src/agent/judge/storeSinglePromptJudgment.ts`
- `src/agent/judge/judgeStoreTokenUse.ts`
- new durable `judge-worker` journal or completion-outbox code under `src/agent/judge/` or `src/server/cron/judgmentsJobs/`

Changes:

- Add the first owner-backed claim issue and completion-ack path that `judge-worker` can call without direct DuckDB writes or local judgment-job SQLite ownership.
- Freeze immutable execution snapshot identity before claim issuance and require completion callbacks to validate `claimId`, `jobId`, `projectId`, `queueRecordId`, `articleId`, `executionSnapshotId`, and `executionSnapshotHash` before mutating queue truth.
- Keep local judgment-job SQLite source-of-truth state, leases, import, and repair on `maintenance-worker`.
- Move `sendToLLM` onto `judge-worker` behind judging capability helpers while keeping `runAddToQueue` on `maintenance-worker`.
- Add durable local claim journal and completion-outbox persistence for `judge-worker`, including replay on startup and token-use summaries carried in the completion outbox rather than written directly to DuckDB.
- Make snapshot mismatch, completion replay backlog, and owner acknowledgment state visible through shared health or diagnostics.

Acceptance criteria:

- `judge-worker` can execute owner-issued claims without direct DuckDB writes or local SQLite ownership
- completions replay until maintenance acknowledges them exactly once
- token-use persistence is owner-backed and replay-safe
- snapshot mismatch rejects the completion instead of binding work to current mutable state
- maintenance remains the control plane for queue source-of-truth state and judgment-job SQLite mutation

## Step 8. Wire A First End-To-End Final Split Dev Mode

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
- Document the minimal local command needed to verify cutover-version refusal and no mixed old or new runtime serving.
- Document the minimal local command needed to verify cutover-migration refusal while a legacy writer is still reachable or its lease is still fresh.
- Document the minimal local command needed to verify that a second `judge-worker` using the same journal path refuses startup.
- Document the stable logical journal id or explicit journal path configuration required for `judge-worker` restart replay.
- Document that `JUDGE_WORKER_ID` is the required stable logical id when `JUDGE_WORKER_JOURNAL_PATH` is omitted, `JUDGE_WORKER_JOURNAL_PATH` is the optional explicit override, and runtime profiles or stack scripts or desktop startup must pass one consistent contract through to the `judge-worker` process.
- Document which ownerless-readable backend the local stack is using, and how to force the fallback path when live read-only DuckDB is intentionally disabled.
- Document how to force a `judge-worker` onto the maintenance-owned immutable snapshot fetch fallback when validated local read-only snapshot access is intentionally disabled or unavailable on that host.
- Document that desktop startup, app-shell backend availability, and local stack launchers use the dedicated readiness route rather than the worker-registry route.
- Document that only `api` exposes the public product API, while `maintenance-worker` and `judge-worker` stay on private RPC or diagnostics surfaces.

Acceptance criteria:

- local dev can run `api`, `maintenance-worker`, and `judge-worker` without manual file edits
- operators can intentionally reproduce `no maintenance worker` versus `maintenance worker present` behavior
- operators can intentionally reproduce same-host shared-volume maintenance-worker failover behavior
- `api` still serves blocked or waiting status from audited shared/read-only state or the configured ownerless-readable backend while maintenance is intentionally absent
- startup refuses incompatible writer-era peers or mismatched cutover versions during final-split local verification
- startup refuses cutover when a legacy writer is still reachable or its lease is still fresh during final-split local verification
- operators can intentionally reproduce same-path `judge-worker` journal collision and see the second process refuse startup deterministically
- operators can restart a `judge-worker` with the same `JUDGE_WORKER_ID` or explicit journal path and see it reopen the same durable journal for replay
- operators can intentionally reproduce the maintenance-owned immutable snapshot fetch fallback for a `judge-worker` when validated local read-only snapshot access is unavailable on that host

## First APIs To Change

These should be the first API contracts touched because they either expose product truth directly or unblock the routing and control-plane cutover:

1. `GET /api/admin/worker-runtime-diagnostics`
2. `GET /api/runtime/ready`
3. replacement owner or worker-registry route for current `GET /api/writer_connections`
4. `POST /api/projectsreviewswarnings`
5. `GET /api/judgmentsjobs/:id/health`
6. `GET /api/judgmentsjobs-health`
7. owner-backed judgment-job control endpoints behind the existing `/api/judgmentsjobs/...` surface, with cutover-version checks
8. owner-backed immutable snapshot fetch endpoint keyed by `executionSnapshotId` plus `executionSnapshotHash` for separate-host or unvalidated local-read `judge-worker` fallback
9. owner-backed dispatch claim and completion endpoints that preserve `jobId`, `projectId`, `claimId`, `executionSnapshotId`, `executionSnapshotHash`, `queueRecordId`, `articleId`, `promptId`, `modelId`, `useTitle`, `useAbstract`, `useFulltext`, and `useFulltextNoImages`, carry token-use summaries, and support idempotent completion replay
10. private owner-backed heartbeat contract replacing `POST /api/writer_connections/heartbeat`

These contracts, plus the new durable worker-heartbeat contract, takeover-intent view, shared SQLite health projection, and dedicated readiness route, are enough to make role ownership visible before deeper queue logic changes land. The readiness route must stay bootstrap-safe and must not depend on the worker-registry route becoming healthy first. The claim and completion APIs must preserve full work-item identity plus frozen snapshot identity backed by immutable persisted snapshot rows, must carry token-use summaries through the durable completion outbox instead of direct judge-side DuckDB writes, and `judge-worker` should read immutable article or prompt or provider inputs through the audited read-only path only when those reads are keyed by that snapshot instead of receiving mutable latest rows from maintenance; when local read-only is unavailable on a separate host, it should fetch immutable snapshots from maintenance instead. The health routes should remain locally answerable on `api` only after they use audited shared or read-only state or the mandatory ownerless-readable backend. They should proxy explicitly to the owner when they cannot answer honestly.

## First Test Files To Update

- `src/server/routes/AdminInvestigateRoutes.test.ts`
- `src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.test.ts`
- `src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarningsTrigger.test.ts`
- `src/server/routes/JudgmentsJobsRoutes.test.ts`
- `src/server/utils/startBackgroundWork.test.ts`
- `src/server/utils/backgroundServerStack.test.ts`
- `src/server/utils/serverRuntimeRoleDuplicateServer.test.ts`
- `src/server/utils/serverRuntimeRoleWriterWorkError.test.ts`
- `src/server/utils/duckdbOwnerLease.test.ts`
- `src/server/utils/duckdbServiceLease.test.ts`
- `src/server/utils/serverRole.test.ts`
- `src/server/utils/duckdbServiceErrorNormalization.test.ts`
- `src/server/utils/duckdbServiceReload.test.ts`
- `src/server/utils/duckdbServiceTransactionRollback.test.ts`
- `src/server/utils/duckdbServiceShutdown.test.ts`
- `src/server/utils/duckdbServiceMemoryLimit.test.ts`
- `src/server/routes/DuckdbStudioRoutes.test.ts`
- `src/server/routes/PromptsRoutes.test.ts`
- `src/server/routes/JudgmentsJobsRoutes.crashContainment.test.ts`
- `src/server/cron/judgmentsJobs/judgmentsJobsAddToQueue.test.ts`
- `src/server/cron/judgmentsJobs/requeueAbandonedSentPrompts.test.ts`
- `src/server/routes/ApiProxyRoutes.test.ts`
- `src/server/routes/ApiProxyRoutes.retry.test.ts`
- `src/server/indexStartup.test.ts`
- `scripts/reproArchivedProjectServingDelete.test.ts`
- `scripts/projectMartRefreshRecovery.test.ts`
- `scripts/recoverArchivedProjectRefreshQueue.test.ts`
- `scripts/recoverJudgmentJobWithSystemSqlite.test.ts`
- `scripts/dbBackup.test.ts`
- `src/desktop/getDesktopRuntimeConfig.test.ts`
- `src/desktop/desktopSingleInstance.test.ts`
- `src/server/utils/duckdbScriptAccess.test.ts`
- `src/server/services/getAppQueryService.test.ts`
- `src/server/utils/runtimeLogger.test.ts`
- `src/server/utils/projectMartLargeRebuildHeartbeat.test.ts`
- `src/server/services/appDatabaseServiceAppendJudgments.test.ts`
- `src/server/services/articleImportStoreService.test.ts`
- `src/server/services/covidenceImportService.test.ts`
- `src/server/services/getDuckdbMartRefreshService.test.ts`
- `src/server/services/judgmentJobDeleteService.test.ts`
- `src/server/services/projectMartLargeRebuildExecutor.test.ts`
- `src/server/services/projectMartLargeRebuildStateService.test.ts`
- `src/server/services/projectMartRefreshStateService.test.ts`
- `src/server/services/tokenUseQueryService.test.ts`
- `src/server/cron/judgmentsJobs/judgmentDispatchRuntime.test.ts`
- `src/server/cron/judgmentsJobs/judgmentJobSqliteService.test.ts`
- `src/server/cron/judgmentsJobs/judgmentsRequestRuntime.test.ts`
- `src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM.test.ts`
- `src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM/getAndUpdateReadyPrompts.test.ts`
- `src/server/utils/writerConnections.test.ts`
- `src/agent/judge/judgeStoreTokenUse.test.ts`
- `scripts/runWithRuntimeProfile.test.ts`
- `src/utils/runtimeProfile.test.ts`

## Minimal Implementation Order

Implement in this exact order:

1. `serverRole.ts`
2. `env.ts`
3. `serverRuntimeRole.ts`
4. `runtimeBootstrap.ts`, `runtimeProcessIdentity.ts`, and `runtimeLogger.ts`
5. `duckdbService.ts`
6. `backgroundServerStack.ts`
7. `startBackgroundWork.ts`
8. `serverMain.ts`
9. cutover-version handshake plus cutover-migration fence and incompatible-peer startup refusal
10. explicit route classification, public-route surface restriction by role, read-only query path, dedicated readiness route, and mandatory ownerless-readable backend plus validation and fallback
11. owner or worker-registry route migration replacing `writer_connections`
12. worker heartbeat, queue progress, shared maintenance recovery-state projection, judgment-job SQLite health projection persistence, maintenance takeover-intent visibility, and `judge-worker` completion-handoff visibility
13. `AdminInvestigateRoutes.ts`
14. `projectsRoutesGetReviewsWarnings.ts`
15. `reviewsWarningsQuery.ts`
16. `reviewsProjectWarnings.tsx`
17. `reviewsIndexingProgress.tsx`
18. `reviewsArticlesTableContainer.tsx`
19. `reviewsArticlesUnassessedTableContainer.tsx`
20. `JudgmentsJobsRoutes.ts` health and owner-backed control routing
21. owner-backed judgment claim snapshot, immutable snapshot fetch fallback endpoint, token-use apply, and durable completion-outbox routing
22. `judgmentDispatchRuntime.ts`, `judgmentJobSqliteService.ts`, `judgmentsRequestRuntime.ts`, `processPromptWithLLM.ts`, `ensureFullText.ts`, `judge.ts`, and `storeSinglePromptJudgment.ts` for the first owner-backed `judge-worker` execution path
23. runtime scripts, settings UI, app-shell availability and admin-route rename cleanup, stored-type and client-query rename cleanup, persisted-config rename cleanup, desktop readiness and startup, and docs

This order keeps role and runtime identity changes ahead of routing, updates DuckDB ownership plumbing before split routing depends on it, keeps routing fail-closed early, fences cutover before legacy lease replacement, and makes the system diagnosable once step 12 lands. It also puts frozen claim snapshots, token-use apply, and durable completion-outbox routing ahead of the first owner-backed `judge-worker` execution path so the execution slice lands on top of its required identity and durability plumbing instead of assuming it. Before the shared worker registry, queue progress, SQLite health projection, and ownerless-readable backend exist, health and status routes that still depend on owner-local state stay proxied to the owner. It also limits UI churn before the server contract is ready.

## Quality Gates For The First Coding Slice

- When a gate below names a current writer-era file that this slice renames, run the same gate against the final renamed replacement file.
- `bun run db:mig`
- `bun test src/server/utils/startBackgroundWork.test.ts src/server/utils/backgroundServerStack.test.ts`
- `bun test src/server/utils/projectMartLargeRebuildHeartbeat.test.ts`
- `bun test src/server/utils/serverRuntimeRoleDuplicateServer.test.ts src/server/utils/serverRuntimeRoleWriterWorkError.test.ts src/server/utils/duckdbOwnerLease.test.ts src/server/utils/duckdbServiceLease.test.ts`
- `bun test src/server/utils/serverRole.test.ts src/server/utils/duckdbServiceErrorNormalization.test.ts src/server/utils/duckdbServiceReload.test.ts src/server/utils/duckdbServiceTransactionRollback.test.ts src/server/utils/duckdbServiceShutdown.test.ts src/server/utils/duckdbServiceMemoryLimit.test.ts`
- `bun test src/server/routes/DuckdbStudioRoutes.test.ts src/server/routes/PromptsRoutes.test.ts src/server/routes/JudgmentsJobsRoutes.crashContainment.test.ts src/server/cron/judgmentsJobs/judgmentsJobsAddToQueue.test.ts src/server/cron/judgmentsJobs/requeueAbandonedSentPrompts.test.ts`
- `bun test src/server/services/appDatabaseServiceAppendJudgments.test.ts src/server/services/articleImportStoreService.test.ts src/server/services/covidenceImportService.test.ts src/server/services/getDuckdbMartRefreshService.test.ts src/server/services/judgmentJobDeleteService.test.ts src/server/services/projectMartLargeRebuildExecutor.test.ts src/server/services/projectMartLargeRebuildStateService.test.ts src/server/services/projectMartRefreshStateService.test.ts src/server/services/tokenUseQueryService.test.ts`
- `bun test src/server/routes/ApiProxyRoutes.test.ts src/server/routes/ApiProxyRoutes.retry.test.ts src/server/routes/AdminInvestigateRoutes.test.ts src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.test.ts src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarningsTrigger.test.ts src/server/routes/JudgmentsJobsRoutes.test.ts`
- `bun test src/server/cron/judgmentsJobs/judgmentDispatchRuntime.test.ts src/server/cron/judgmentsJobs/judgmentJobSqliteService.test.ts src/server/cron/judgmentsJobs/judgmentsRequestRuntime.test.ts src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM.test.ts src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM/getAndUpdateReadyPrompts.test.ts`
- `bun test scripts/reproArchivedProjectServingDelete.test.ts scripts/projectMartRefreshRecovery.test.ts scripts/recoverArchivedProjectRefreshQueue.test.ts scripts/recoverJudgmentJobWithSystemSqlite.test.ts scripts/dbBackup.test.ts`
- `bun test src/desktop/getDesktopRuntimeConfig.test.ts src/desktop/desktopSingleInstance.test.ts`
- `bun test src/server/utils/writerConnections.test.ts src/agent/judge/judgeStoreTokenUse.test.ts`
- `bun test src/server/indexStartup.test.ts src/server/utils/duckdbScriptAccess.test.ts src/server/services/getAppQueryService.test.ts src/server/utils/runtimeLogger.test.ts scripts/runWithRuntimeProfile.test.ts src/utils/runtimeProfile.test.ts`
- `bun x eslint src/server/utils/serverRole.ts src/server/utils/serverRuntimeRole.ts src/server/utils/duckdbOwnerLease.ts src/server/utils/duckdbService.ts src/server/utils/env.ts src/server/utils/runtimeBootstrap.ts src/server/utils/runtimeProcessIdentity.ts src/server/utils/runtimeLogger.ts src/server/utils/writerConnections.ts src/server/utils/writerWarnings.ts src/server/utils/ensureFullText.ts src/server/utils/startBackgroundWork.ts src/server/utils/backgroundServerStack.ts src/server/utils/projectMartLargeRebuildHeartbeat.ts src/server/utils/projectMartRefreshWorkerHeartbeat.ts src/server/utils/writerConnectionHeartbeat.ts src/server/utils/duckdbScriptAccess.ts src/server/serverMain.ts src/server/services/getAppQueryService.ts src/server/services/userConfigQueryService.ts src/server/routes/ApiProxyRoutes.ts src/server/routes/WriterConnectionsRoutes.ts src/server/routes/AdminInvestigateRoutes.ts src/server/routes/UsersRoutes.ts src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.ts src/server/routes/JudgmentsJobsRoutes.ts src/server/utils/localAppSettings.ts src/server/utils/projectMartLargeRebuildTuning.ts src/server/cron/judgmentsJobs.ts src/server/cron/judgmentsJobs/judgmentDispatchRuntime.ts src/server/cron/judgmentsJobs/judgmentJobSqliteService.ts src/server/cron/judgmentsJobs/judgmentsRequestRuntime.ts src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM.ts src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM/processPromptWithLLM.ts src/agent/judge.ts src/agent/judge/storeSinglePromptJudgment.ts src/agent/judge/judgeStoreTokenUse.ts src/components/Navigation.tsx src/components/main/reviews/reviewsWarningsQuery.ts src/components/main/reviews/reviewsProjectWarnings.tsx src/components/main/reviews/reviewsIndexingProgress.tsx src/components/main/reviews/reviewsArticlesTable/reviewsArticlesTableContainer.tsx src/components/main/reviews/reviewsArticlesTable/reviewsArticlesUnassessedTableContainer.tsx src/app/routes/+__root.tsx src/app/routes/+admin/+writer-connections/+index.tsx src/app/routes/+settings/+index.tsx src/db/schemaTypes.ts src/utils/runtimeProfile.ts src/utils/writerConnectionsQuery.ts src/desktop/index.ts src/desktop/getDesktopRuntimeConfig.ts scripts/reproArchivedProjectServingDelete.ts scripts/benchmarkDuckdbAppendLanes.ts scripts/recoverProjectMartRefreshClaims.ts scripts/devServerWatch.ts scripts/runWithRuntimeProfile.ts scripts/startServerStack.ts`
- `bun run build`
- `bun run desktop:build`
- Browser verification:
  - review warning shows `waiting for maintenance worker` when no maintenance-worker heartbeat exists
  - worker diagnostics show local capabilities and active worker registry clearly
  - judgment job health distinguishes blocked import from active import
- Runtime verification:
  - the dedicated readiness route remains usable for desktop startup, root backend-availability checks, and stack launchers while the worker-registry route can still report missing maintenance or takeover in progress
  - startup rejects incompatible writer-era peers or mismatched cutover versions
  - startup refuses cutover lease adoption or replacement while a legacy writer is still reachable or its lease is still fresh
  - first boot against pre-cutover `app.user_config`, `forska.settings.json`, `.writer.lock`, and `.writer.history.json` rewrites or cleanly replaces them without manual cleanup
  - full-text fetch, full-text conversion, and `nvidia-smi` polling are mounted only on `maintenance-worker` after writer-role removal, and are absent from `api` and `judge-worker`
  - the public product route tree is mounted only on `api` after cutover, while `maintenance-worker` and `judge-worker` stay on their private RPC or diagnostics surfaces
  - `judge-worker` startup refuses to run without writable durable journal storage
  - `judge-worker` startup refuses to run when neither `JUDGE_WORKER_ID` nor `JUDGE_WORKER_JOURNAL_PATH` resolves a stable durable journal target or when the resolved target is missing, unstable, unwritable, or non-durable
  - a second `judge-worker` started with the same journal path deterministically refuses startup instead of sharing SQLite state
  - restarting a `judge-worker` with the same `JUDGE_WORKER_ID` or explicit journal path reopens the same durable journal and replays unacked completions
  - an audited `api-read-only` or `judge-worker` path cannot silently fall back to owner-capable database helpers
  - disabling live read-only DuckDB for an ownerless route still leaves that route answerable through the configured mandatory ownerless-readable backend
  - an unacked `judge-worker` completion is replayed after maintenance restart and applied exactly once
  - token-use persistence is applied through the owner-backed completion path exactly once even when the same durable completion outbox row is replayed
  - a separate-host `judge-worker` without validated local read-only access can still execute claimed work by fetching immutable snapshots from maintenance-owned APIs
  - mutating prompt or provider settings after claim issuance does not change the execution inputs for that already-issued claim
  - snapshot mismatch is surfaced explicitly instead of silently reading newer mutable prompt or provider state
