# Review-Serving Incremental Retention Cleanup Plan

Date: 2026-08-14

## Goal

Replace the disabled broad review-serving snapshot/mart retention cleanup with
an automatic incremental cleanup that is safe to run continuously on the primary
DuckDB owner.

The temporary gate from PR #374,
`FORSKA_REVIEW_SERVING_RETENTION_CLEANUP_ENABLED=true`, is a stop-the-bleeding
guard. It prevents the old cleanup from monopolizing the serialized DuckDB owner
with broad candidate scans and making foreground routes time out. It is not the
long-term operating model. No user or operator should have to remember to run
cleanup periodically.

The durable end state is:

- old retired review-serving mart/snapshot artifacts are cleaned automatically;
- cleanup work is resumable, bounded, and cheap per worker wake;
- foreground project/detail/review routes stay responsive while cleanup runs;
- dirty-work retention cleanup remains active and independent;
- live current-DB evidence proves review serving still progresses under cleanup
  load.

## Current Code Anchors

- Broad retention service:
  `src/server/reviewServing/reviewServingRetentionService.ts`.
- Worker cleanup gate:
  `src/server/workers/reviewServingProjectorWorker.ts`
  (`FORSKA_REVIEW_SERVING_RETENTION_CLEANUP_ENABLED`).
- Existing tests:
  `src/server/reviewServing/reviewServingRetentionService.test.ts` and
  `src/server/workers/reviewServingProjectorWorker.test.ts`.
- Dirty-work cleanup remains separate through the worker's
  `cleanupDirtyWorkRetention` dependency and must continue to run by default.
- Current broad cleanup specs cover snapshot-protected rows in review-serving
  mart tables, selected-import published rows, staging rows, and terminal
  rebuild chunk manifest rows.

## Problem

The old cleanup appears bounded because it deletes at most `batchSize` rows from
one cleanup target at a time. That bound is too late.

The expensive part is candidate discovery:

1. The worker selects up to 16 project/review-config targets from
   `app.review_serving_snapshot_manifest`.
2. For each target, cleanup scans a broad mart table or manifest table.
3. Protection checks are evaluated against active snapshots, last-known-good
   snapshots, selected-import snapshots, pins, and rebuild requests.
4. Only after that broad scan/order does `LIMIT 512` cap the final delete.
5. Because the DuckDB owner is serialized, these cleanup transactions can sit
   ahead of unrelated foreground reads and cause 504s.

The right fix is not a smaller final delete limit. The right fix is to make
candidate discovery itself incremental and bounded.

## Non-Goals

- Do not re-enable the old broad cleanup in production as an operational
  workaround.
- Do not rely on manual or periodic operator cleanup.
- Do not delete rows solely because they are old.
- Do not weaken active snapshot, last-known-good snapshot, selected-import, pin,
  failed diagnostic, or retryable rebuild protection semantics.
- Do not merge old and new cleanup paths indefinitely. The old gated path should
  be removed once the incremental path has live evidence.
- Do not move the same broad scans to a different owner and call the problem
  solved. Foreground responsiveness and current-DB progress still have to be
  proven.

## Principles

- Candidate discovery must be bounded before row deletion is attempted.
- Cleanup should be automatic and opportunistic, not operator driven.
- Each worker tick should have a hard row budget and preferably a time budget.
- Cleanup state should be explicit, inspectable, and resumable.
- Cursor identity must be table-specific. `snapshot_id` alone is never a
  sufficient row cursor because many cleanup tables contain many rows for one
  snapshot.
- Protection decisions should be snapshotted into cleanup-candidate state in
  small slices, then revalidated before delete.
- Discovery and deletion must have a proven physical access path in DuckDB, not
  just a syntactically bounded `LIMIT`. Many review-serving mart tables are
  deliberate heaps after the hot-table index removals, so keyset predicates and
  exact logical-key deletes can still plan as broad sequential scans.
- Deletion should use exact physical or stable row identities only after
  `EXPLAIN ANALYZE` or profiling proves the statement has a bounded owner hold
  on representative current-DB data.
- Any `rowid` use must be scoped to a table/database lifecycle token so stale
  rowids cannot survive table rebuilds, restore, checkpoint copy, or recreate
  events.
- If a batch finds protected rows, it should advance state without repeatedly
  rediscovering the same protected prefix forever.
- If DuckDB cannot provide a bounded physical access path for a table, the plan
  must switch to a write-fed inventory, lifecycle-tokened physical sweep, table
  rebuild-with-retention, or another design with measured per-query owner-hold
  bounds. Do not ship a heap-table cleanup that relies on elapsed-time checks
  after a long query has already started.

## Proposed Shape

### 1. Add Cleanup-Candidate State

Add a persistent cleanup state shape for broad retention work. The exact schema
can be adjusted during implementation, but it should represent work at three
levels:

- scope scheduler state per cleanup lane/spec/project/review-config;
- canonical artifact-incarnation availability state, visible to producers and
  consumers;
- per-spec artifact work-item state keyed by artifact incarnation plus cleanup
  spec/table family;
- candidate row state for exact physical row incarnations eligible for deletion
  or known protected rows that should be skipped until their protection changes.

Suggested tables:

```sql
app.review_serving_retention_cleanup_cursor
app.review_serving_retention_artifact_incarnation
app.review_serving_retention_cleanup_artifact
app.review_serving_retention_cleanup_candidate
```

The cursor table should track:

- cleanup scope: project id, review config hash, cleanup spec/table;
- scheduling state for artifact discovery, not a mandate to fan one scope into
  all target rows;
- stable scan cursor for the table's full per-table discovery key columns;
- requested, claimed, and processed sweep generations;
- claim lease owner and lease expiry for in-progress discovery/reconciliation
  work;
- last scan/check time;
- lifecycle status;
- counters for candidates found, deleted, protected, and skipped.

The canonical artifact-incarnation table should track:

- artifact incarnation id, separate from lifecycle event id and target row id;
- artifact identity, such as snapshot id, selected-import snapshot id, rebuild
  request id, chunk id, manifest generation, or staging generation;
- artifact availability state: `intact`, `draining`, `deleted`, or `rebuild_required`;
- live reference count or lease summary for consumers that can outlive one
  transaction;
- availability generation and lease owner for state transitions;
- unavailable tombstone/rebuild evidence while any external reference can still
  name the old artifact;
- owning producer version and minimum consumer protocol version required for
  safe cleanup cutover.

The per-spec artifact work-item table should track:

- artifact incarnation id and cleanup spec/table family;
- cleanup scope;
- requested, claimed, and processed generations for that artifact;
- claimed and processed target-write generation or immutable rowset seal
  incarnation for that artifact;
- claim lease owner and expiry for artifact-level discovery/recheck work;
- immutable lifecycle event ids that requested or invalidated the artifact, with
  idempotent delivery;
- all current protection causes or bounded invalidation keys for looking them
  up;
- per-spec artifact discovery cursor/fence so candidate rows are materialized in
  bounded slices after artifact eligibility is known;
- next recheck/probe time and scheduling debt for fair service.

The first component deletion for any spec under an artifact incarnation must
atomically compare-and-set the canonical artifact from `intact` to `draining`
only when the live reference count is zero and all long-lived readers have either
released their leases or use the new protection protocol. This availability CAS
is the boundary across every table/spec that makes up the consumer-visible
artifact. After `draining` or `deleted`, target writers and publishers must
write a new artifact incarnation; they must not resurrect the old one. Consumers
that need retired artifacts must acquire protection atomically before use, and
read leases are required for reads that can outlive one transaction. If a
consumer requests an artifact after it is `draining` or `deleted`, it must either
reject the reference or rebuild/publish a new artifact incarnation; it must not
observe a partially deleted artifact. `rebuild_required` means the old
incarnation cannot be served and a new incarnation must be produced before
publication. Keep unavailable tombstone evidence while any external reference
can still name the old artifact.

Project/config scope rows should only schedule artifact work. Lifecycle
producer transactions must enqueue or invalidate a constant number of artifact
records; they must not fan out to all candidate rows in the lifecycle
transaction.

The candidate table should track:

- cleanup scope and cleanup spec/table;
- lifecycle event id that produced or refreshed the work;
- artifact incarnation id that owns the work;
- unique physical target-row identity and target-row version/incarnation;
- stable logical key columns for the target row;
- nullable key-column values and null markers where the target table permits
  nulls;
- `rowid` only when safe to use within the current database lifecycle, plus the
  lifecycle token that makes that safety check explicit;
- protected identity fields such as snapshot id, selected-import snapshot id,
  request id, and chunk id;
- eligibility/protection status;
- requested, claimed, and processed generations copied from the producing
  lifecycle event or reconciler sweep;
- last eligibility check time;
- delete attempt count, last error, and retry/backoff state.

Candidate metadata must not become the next unbounded retention problem. Store
protected state at artifact level where possible, aggregate durable counters for
terminal outcomes, and compact terminal per-row candidate records in bounded
batches after diagnostics are no longer useful.
Do not compact live retry state: `protected` and `retryable_error` are
nonterminal statuses and are never TTL-eligible while the target row may still
exist. Terminal per-row records are limited to `deleted` and `target_absent`,
plus retained aggregate counters/tombstones that preserve evidence after
compaction.

Quarantine is also nonterminal unless another durable resolution is recorded.
It must retain exact target-row identity, target-row version/fingerprint,
artifact incarnation, last error class, and `next_probe_at`. Quarantine caps
apply only to diagnostic history, not to the actionable candidate/work item.
Candidate compaction and scope retirement are prohibited until the target is
deleted, proven absent, or resolved by another durable recovery path such as a
bounded artifact rebuild/swap that preserves evidence and gives future workers
an actionable state.

Add a persistent breaker table for cleanup faults:

```sql
app.review_serving_retention_cleanup_breaker
```

The breaker key should include cleanup lane, phase, spec/table, and scope when
the fault is local, with a separate systemic fault-domain key for database-wide
or owner-wide failures. It should track consecutive failures, first/last failure
time, last error class, cooldown-until, half-open probe state, and the latest
successful recovery time.

Acceptance criteria:

- The worker can inspect how much cleanup work is pending without scanning every
  mart table.
- Candidate rows can be deleted by exact identity.
- Candidate/cursor tables have uniqueness and lookup indexes that keep cleanup
  state cheap to query by scope, status, next-check time, and exact target
  identity.
- Artifact rows have uniqueness and lookup indexes that keep artifact discovery,
  invalidation, recheck, and scheduling cheap by lane/spec/scope/artifact
  incarnation.
- The schema can represent selected-import and terminal rebuild chunk cleanup
  without special unbounded paths.
- Terminal candidate metadata has its own bounded retention/compaction policy.
- Scope/candidate completion uses compare-and-set on generation plus lease, so a
  stale EOF/idle write from an older sweep cannot overwrite newer lifecycle work.
- Duplicate lifecycle events are idempotent through immutable event/artifact
  keys.
- Breaker and retry state survives process restart.
- Quarantined work blocks candidate compaction and scope retirement until
  deletion, proven absence, or durable recovery resolution.

### 2. Split Discovery From Deletion

Refactor cleanup into two small operations:

1. Discover a bounded slice of candidate keys from one table/spec/scope using
   that table's explicit discovery identity.
2. Delete a bounded slice of already-discovered eligible candidates.

Discovery must not sort or scan the whole table to find the globally oldest
eligible rows. It also must not assume that keyset pagination over a logical
natural key is physically bounded in DuckDB. Before coding runtime behavior, the
implementation must create a cleanup spec identity map derived from the current
table schemas and validated with representative query profiles.

For every cleanup table/spec, the map must include:

- final stable column list from the current migration/schema, not remembered
  names from older table versions;
- immutable scope dimensions;
- mutable payload columns that are not safe cursor or delete identities;
- null ordering and null-equality behavior for every nullable identity column;
- uniqueness guarantee, or an explicit statement that the table can contain
  physical duplicates;
- cursor tie-breaker that cannot skip duplicates at a batch boundary;
- exact delete identity;
- distinct identities for lifecycle event, artifact incarnation, and physical
  target-row incarnation/version;
- whether rowid or a new durable surrogate is mandatory;
- rowid lifecycle-token source, bump points, mismatch behavior, and stale-rowid
  reuse tests;
- `EXPLAIN ANALYZE` or profiling evidence for every owner-held statement in the
  spec, including rows/row-groups scanned and owner-hold duration on
  representative current-DB data.

Every cleanup table/spec also needs a semantic contract before it can be
enabled. The semantic matrix must include:

- exact eligibility predicate that makes the artifact/row deletable;
- all protection causes and their precedence;
- source lifecycle tables and generation fences;
- invalidation producers and event keys;
- grace periods or age rules, if any;
- terminal states and nonterminal states;
- stale-candidate behavior for identity/fingerprint mismatch;
- exact revalidation query and access-path profile;
- tests that prove protected survival, release/expiry deletion, missed-event
  recovery, and stale-candidate rediscovery.

Normal snapshot mart rows, selected-import current/published/staging rows, and
terminal rebuild chunk manifest rows must have separate semantic matrix entries.
Do not let them inherit a generic "not active/LKG/pinned" rule unless the
current schema and lifecycle tests prove that rule is complete for that spec.
Runtime enablement for a spec is blocked until both the identity/access-path map
and semantic matrix are complete and profiled.

Known schema traps that the implementation must resolve from the live schema
before enabling a spec:

- posting tables may use plural array/list payloads such as `article_ids`, not
  scalar `article_id`;
- judgment-detail and filtered-count tables have changed shape across recent
  migrations and may not have older identity columns such as `list_mode_key` or
  component identity fields;
- queue tables may carry `prompt_ids` rather than `prompt_id`;
- selected-import current/staging tables have their own published/staging
  identities and should not inherit snapshot-mart assumptions;
- title-search and article-rank specs remain undefined until their final schema,
  uniqueness, and physical access paths are proven.

If any table lacks a proven immutable, non-reusable unique physical row
identity, or DuckDB cannot execute the exact logical-key discovery/delete in
bounded time after the hot-table index removals, the implementation must either
add a durable cleanup identity column, use a write-fed cleanup inventory,
perform cleanup during a bounded rebuild/swap, or persist `rowid` with a table
lifecycle token and a full logical fingerprint used to reject stale or
mismatched rowids. This applies even when a table has a stable but non-unique
logical key. A stale candidate matching a reinserted row under the same logical
key must become stale work for rediscovery, not a deletion and not
`target_absent`.

The access-path/profile map must cover every runtime and producer query, not
only candidate discovery and delete. Required entries include outbox enqueue and
dequeue, scope selection, artifact selection, backfill, reconciliation,
protection lookup, protection invalidation, retry/recheck selection, breaker
recovery, exact revalidation, deletion, attempt persistence, and metadata
compaction. Each entry must name row/statement/transaction caps, measured
row-groups scanned, owner-hold limit, and the fallback when the measured plan is
not bounded enough.

Rollout DDL is part of the same owner-hold surface. The map must include every
migration statement, index build, durable-identity column addition, lifecycle
token bootstrap, inventory bootstrap, and existing-row identity/token backfill.
Choose the identity strategy before applying target-table migrations. If one
DDL/backfill statement cannot meet the hard owner-hold limits on current-DB
data, use a resumable shadow table, chunked backfill, rebuild/swap, or another
budgeted path with live readiness and review-progress evidence during and after
the migration.

The map must also classify target-table write behavior for each spec. Each spec
must have either:

- a proven immutable rowset seal, where no target rows can be inserted, updated,
  or deleted behind a completed discovery fence. The seal must have a persisted
  seal incarnation id and creation fence; or
- an exhaustive target-writer matrix where every target-table insert, update,
  delete, rebuild/swap, restore, and compaction atomically advances a durable
  write generation and/or writes the cleanup inventory.

EOF, lifecycle acknowledgment, metadata compaction, and scope retirement must
compare-and-set against both the lifecycle generation and the target write
generation. Legacy bootstrap must define coverage for orphan target rows whose
lifecycle source has already disappeared. A bit-identical delete/reinsert under
the same logical key and fingerprint is not safe unless the target row identity
also changes through a durable surrogate, rowset seal, lifecycle-tokened rowid,
or write-generation fence.

Executable target-write protocol:

- target-writer matrix rows must be implemented before a spec can be enabled,
  not merely classified;
- inventory writers append commit-ordered inventory records with a monotonic
  `inventory_sequence`, artifact incarnation id, exact target-row
  incarnation/identity, target-row fingerprint, operation type, tombstone flag,
  before/after artifact identities, and commit fence;
- artifact discovery claims both `claimed_target_write_generation` and
  `claimed_inventory_sequence` or the immutable rowset seal incarnation;
- successful discovery/deletion acknowledges
  `processed_target_write_generation` and `processed_inventory_sequence` only
  after all rows up to that fence are materialized or proven absent;
- generation, sequence, or seal mismatch restarts/replays the artifact from the
  new fence instead of marking it idle;
- cleanup deletes either do not advance target-write generation because they are
  recorded as cleanup-owned mutations in the same outcome transaction, or they
  advance a separate cleanup-delete generation excluded from producer-write EOF
  checks. The chosen rule must be explicit per spec;
- inventory and seal metadata retention follows the same terminality,
  replay/tombstone, and bounded-access rules as artifact metadata.

Generation-only and inventory modes are mutually explicit per spec. A
generation-only spec is allowed only when the target rowset is sealed or a
bounded target-row backfill can prove complete coverage without future heap
scans. A write-fed inventory spec must use inventory records as the source of
target-row discovery; artifact-only inventory is insufficient.

Crash-safe bootstrap for inventory specs:

1. Install target-writer hooks in observe-only mode and persist a bootstrap
   start watermark/seal.
2. Backfill pre-hook target rows into exact row-level inventory using bounded
   slices and a durable backfill cursor.
3. Replay post-watermark inventory records that arrived during backfill.
4. CAS artifact readiness only when the backfill cursor, replay sequence, target
   write generation, and artifact availability generation all match.
5. If the owner crashes, resume from the durable cursor/sequence; if any fence
   mismatches, restart or replay the affected artifact/spec instead of marking
   it ready.

Protection checks can be evaluated for the bounded slice and persisted into
candidate state. They should not be expressed as a broad anti-join over the
entire target table on each worker wake.

Acceptance criteria:

- Tests fail if `LIMIT` appears only inside the final `DELETE` candidate
  subquery while broad candidate discovery remains unbounded.
- Tests include more than one cleanup batch of rows sharing the same
  `snapshot_id`, proving cursor progress within a single snapshot.
- Tests include duplicate logical keys at a batch boundary for every non-unique
  spec, proving no physical duplicate is skipped.
- Tests include large duplicate groups, same-key delete/reinsert,
  out-of-order lifecycle events, stale fingerprint mismatch, and
  post-compaction event replay.
- Discovery advances a cursor even when the bounded slice is mostly protected.
- Deletion never needs to rediscover candidates with a full-table scan.
- Query-profile fixtures fail the slice if candidate discovery or delete scans a
  representative heap table broadly despite a small SQL `LIMIT`.
- Query-profile fixtures fail if any owner-held query in the runtime or
  producer path exceeds its scan or owner-hold budget.
- Tests cover target DML before and after the final discovery slice, before EOF,
  after restart, and before scope retirement, including bit-identical rowid
  reuse and legacy orphan rows.
- Tests cover inventory bootstrap hook activation, bounded target-row backfill,
  post-watermark replay, crash/resume, final readiness CAS, and orphan target
  rows for every write-fed inventory spec.

### 3. Seed Cleanup Scopes Without Per-Wake Global Scans

The current target discovery scans `app.review_serving_snapshot_manifest`,
groups by project/review-config, orders by `MAX(updated_at)`, and returns up to
16 targets. The incremental replacement should not perform that grouped target
scan every cleanup interval.

Scope creation should be event-fed:

- snapshot promotion, retirement, failure, and last-known-good changes enqueue
  or refresh constant-size artifact work for the affected
  project/review-config/artifact incarnation;
- selected-import publish and staging lifecycle changes enqueue selected-import
  artifact work;
- rebuild terminalization enqueues terminal chunk artifact work;
- pin acquire/release and rebuild request status changes mark affected protected
  artifacts for recheck.

The implementation must start with an exhaustive producer matrix and hook
inventory. At minimum it must cover manifest writers, selected-import lifecycle
writers, pin acquire/increment/release/expiry, rebuild request status writes,
terminal chunk manifest writes, direct worker SQL helpers, migrations/startup
repair, and any operator/debug command that mutates the same lifecycle tables.
Each producer row must name the lifecycle event id, affected artifact
incarnation id, affected scope/spec, source transaction, protection invalidation
keys, owner-held access-path profile, and tests that prove the hook fires.
Producer transactions may write only constant-size artifact/outbox records. Any
candidate fan-out, broad invalidation, or row materialization must happen later
through the bounded artifact worker path.

Add a consumer/reference matrix beside the producer matrix. At minimum it must
cover retired-snapshot resolution, export routes, selected-import readers,
pin/diagnostic consumers, rebuild consumers, and any route or worker that can
name an older artifact. Each consumer row must define how it atomically acquires
protection, how it handles `draining`/`deleted` artifacts, and which version is
safe to deploy. Cutover is blocked until every producer and consumer that can
publish, protect, or read retired artifacts uses the artifact-state protocol.

Existing databases still need an initial backfill. That backfill must have its
own bounded cursor over manifest/request/source tables and must run under the
same budget discipline as normal cleanup.

Event-fed does not mean event-only. Every lifecycle transition that creates,
retires, protects, or unprotects an artifact must enqueue artifact-level cleanup
work in the same transaction as the lifecycle write. A missed event cannot be a
permanent data leak, so the implementation also needs a recurring bounded
reconciler with a durable source cursor. The reconciler should use immutable
artifact fences or cyclic sweep generations so rows inserted behind a
project-level cursor are eventually rediscovered.

Generation and lease rules:

- every distinct lifecycle or reconciler event advances a durable monotonic
  `requested_generation` fence for the affected artifact incarnation and its
  parent scope;
- generation may be preserved only when the event key is an exact duplicate of
  an already-materialized event;
- a worker claims a bounded slice by setting `claimed_generation`, claim owner,
  and lease expiry only when no unexpired claim already owns that generation;
- completion writes `processed_generation` with compare-and-set on the claimed
  generation and lease owner;
- every cursor advance, candidate insertion, revalidation, delete, and outcome
  transaction compare-and-sets the current generation and lease owner before
  committing target mutations;
- a stale generation or lease mismatch rolls back the whole mutation and leaves
  the newer generation schedulable;
- EOF/idle scope completion is valid only when the worker has materialized all
  rows for the claimed generation and the CAS still observes no newer requested
  generation;
- stale leases are recoverable by a later worker without losing the original
  requested generation;
- source lifecycle rows are retained until cleanup acknowledgment, or an
  equivalent durable tombstone/outbox row is written before source deletion.

Atomicity requirements:

- lifecycle mutation and constant-size cleanup artifact/outbox enqueue happen in
  one transaction;
- target-table DML for specs without a proven immutable rowset seal advances the
  target write generation or writes the cleanup inventory in the same
  transaction as the target mutation;
- candidate insertion and cursor advance happen in one transaction;
- protection revalidation, delete attempt, and candidate outcome happen in one
  transaction;
- EOF/sweep generation advancement is persisted only after the bounded slice it
  represents has been materialized.
- failed attempts and breaker state are persisted outside a rolled-back delete
  transaction, or through a durable attempt lease that remains visible after the
  failed delete rolls back.

Acceptance criteria:

- Normal cleanup does not run a grouped manifest target scan every wake.
- Backfill can seed scopes for existing data without starving foreground reads.
- Newly retired/promoted artifacts become cleanup-visible without manual
  intervention.
- Lifecycle producer tests prove hooks do not perform candidate fan-out or broad
  invalidation in the producer transaction.
- Consumer tests prove protection acquisition before deletion, during partial
  deletion, and after deletion; late consumers must reject or rebuild into a new
  artifact incarnation instead of observing partial data.
- Fault-injection tests prove missed events, process death between enqueue and
  cursor advance, and rows inserted behind an old cursor are recovered by the
  bounded reconciler.
- Tests cover event-at-EOF races, duplicate delivery, crash/restart, stale
  leases, updates/deletes/inserts behind cursors, and deleted source rows that
  must remain recoverable through tombstone/outbox evidence.
- Tests cover a distinct event arriving after the final materialized slice but
  before EOF completion, proving the stale EOF CAS cannot hide the event.

### 4. Revalidate Before Exact Delete

Before deleting, revalidate each candidate batch against the current protection
state:

- active snapshot;
- last-known-good snapshot;
- selected-import snapshot still referenced by active/LKG manifest;
- active pins;
- running, admitted, blocked, quarantined, retryable failed, or newest failed
  diagnostic rebuild requests.

Then delete only exact candidate rows by stable identity.

For tables where `rowid` is used, keep the prior live lesson in mind: DuckDB
BIGINT rowids may arrive in JS as strings. Do not coerce them through
`Number(...)` if precision could matter.

Protected candidates need a reactivation path. A candidate marked protected
must carry `next_recheck_at` plus every protection cause currently known for the
artifact, not a single overwritten reason. Active snapshot, last-known-good,
selected-import, pin, and rebuild protections may overlap; releasing one cause
must not erase the others or delete the target prematurely. Where storing every
per-row cause would be too large, store artifact-level protection records and
candidate-level invalidation keys that can rejoin only a bounded due slice.

Recheck can be driven by:

- bounded stale-protected scans ordered by `next_recheck_at`;
- event-fed invalidation when active/LKG manifests, pins, or rebuild request
  statuses change;
- the earliest known protection expiry, such as pin expiry, rebuild request
  terminalization, or manifest generation change;
- a concrete maximum recheck interval, initially no longer than 24 hours, so
  missed events do not leave rows protected forever.

The due-protected queue must be bounded and fair across specs/scopes. A large
protected backlog for one project cannot prevent due rechecks for another
project, and due protected work cannot starve eligible deletion forever.

Acceptance criteria:

- A candidate protected after discovery is skipped, not deleted.
- A candidate that becomes unprotected is eventually deleted automatically.
- Protected candidates cannot become a permanent holding pen after pins expire,
  manifests change, or rebuild requests terminalize.
- Final mutations are exact-key or exact-row deletes, not broad anti-joins.
- Tests cover overlapping protections released individually, missed
  invalidation events, restart recovery, maximum recheck interval behavior, and
  large protected backlogs.

### 5. Persist Errors And Isolate Poison Candidates

Cleanup errors are part of the state machine, not transient logs. A failed
delete/revalidation transaction may roll back the target mutation, but it must
not roll back the fact that a candidate was attempted.

Error handling should classify failures into at least:

- retryable candidate-local errors;
- permanent candidate-local errors where the target is malformed or no longer
  addressable;
- spec/scope query-shape or schema errors;
- systemic owner/database errors.

Candidate-local failures should update attempt count, last error class, next
retry time, and quarantine state for that exact candidate in a recovery
transaction or durable attempt lease. Poison candidates must not stop unrelated
candidates in the same spec forever.

The shared budget must reserve profile/breaker/finalization capacity before any
owner-held cleanup statement starts. A cleanup statement may start only after
the worker has persisted a durable pre-attempt record with lane, phase, spec,
scope/artifact, statement class, generation/lease, and hard scan/owner-hold
caps, and still has reserved statement and transaction capacity for profiling
and outcome finalization. If the database or owner becomes unavailable before
the outcome can be classified, stale-attempt recovery must run before any retry
and must conservatively update candidate/artifact state, breaker state, and
retry/quarantine scheduling from the durable attempt record.

Circuit breakers should be durable and fault-domain aware:

- candidate quarantine for repeated candidate-local failures;
- phase/spec/scope breaker for repeated local cleanup failures;
- phase/spec/scope breaker for any successful statement that exceeds its hard
  row/row-group scan cap or owner-hold ceiling;
- systemic breaker only for errors that indicate owner/database health;
- exponential cooldown with jitter and a bounded maximum;
- half-open probe that allows one small retry after cooldown;
- automatic close only after half-open probes are functionally successful and
  within every hard scan and owner-hold cap;
- unrelated specs/phases continue while a local breaker is open.

A successful but over-budget statement is a fault. Record the measured scan and
owner-hold evidence against the pre-attempt record, open the relevant breaker
before another attempt from that phase/spec/scope, and recover only through
half-open probes or a revised access path. An unresolved pre-attempt whose
outcome was lost across crash/restart opens the breaker conservatively before
retry. Canary profiling is not enough; post-cutover runtime measurement must
continue and must enforce hard maximums in addition to p99 gates.

Quarantine recovery must be automatic. A quarantined candidate or artifact
retains its exact identity and schedules bounded probes through `next_probe_at`.
Recovery may mark the target deleted, prove target absence with the current
target-row incarnation/fingerprint, re-materialize stale work for rediscovery,
or hand the artifact to a bounded rebuild/swap path. It must not rely on a human
to clear state or on metadata TTL to hide the problem.

Acceptance criteria:

- A failed delete persists attempt/error/breaker state even when the delete
  transaction rolls back.
- Restart does not clear breaker or quarantine state.
- One poison row is isolated and does not prevent other eligible candidates,
  dirty-work cleanup, or review-serving projection from progressing.
- Quarantined candidates remain actionable across restart and cannot be
  compacted while target existence is unresolved.
- Tests cover rollback, restart, poison-row isolation, half-open recovery,
  quarantine recovery, stale attempt leases, scope-retirement rejection while
  quarantined work exists, and bypass for unrelated work.
- Tests cover failure in the final ordinary budget slot and owner crash/restart
  between pre-attempt lease and outcome finalization.
- Tests cover a slow successful query that exceeds its hard scan or owner-hold
  ceiling and opens a durable breaker before the next attempt.
- Tests cover final-slot, crash-window, unresolved-attempt recovery, and
  over-budget half-open probe behavior for non-delete owner-held statements such
  as scope selection, artifact discovery, revalidation, and metadata compaction.

### 6. Make The Worker Continuously Safe

Replace the env-gated broad cleanup call with an incremental cleanup lane that
runs by default under hard budgets.

Worker behavior:

- Use one cleanup budget object for the whole wake, with an absolute deadline,
  row cap, statement cap, and transaction cap. Pass it into dirty-work retention,
  scope seeding, discovery, protected rechecks, deletion, error recovery, and
  metadata compaction.
- Preserve dirty-work semantics through a budget-aware dirty-work cleanup API.
  "Dirty-work first" may reserve an initial share, but it cannot consume the
  entire shared budget forever under perpetual dirty backlog.
- Run at most one or a small fixed number of incremental retention cleanup
  steps per cleanup interval.
- Do not `reduce` over a target list and run many cleanup transactions
  sequentially in one worker wake.
- Return elapsed time, discovered/deleted row counts, budget-exhausted flags,
  and next suggested cleanup time in the cleanup result.
- Prefer alternating discovery and deletion so state does not grow without
  drain.
- Yield after budget exhaustion even if more cleanup is available.
- Use rotating scheduling, per-lane reservations, and maximum consecutive skip
  counts so every eligible phase progresses over repeated wakes.
- Persist hierarchical scheduling state across lane, spec, scope, and artifact.
  Each level needs bounded consecutive service, accumulated scheduling debt, and
  measurable maximum service lag when capacity exists. A hot scope, retry
  backlog, or compaction backlog cannot starve cold scopes or different specs.
- Recheck foreground queue pressure between cleanup phases and before starting
  any candidate discovery or delete statement. Foreground-pressure deferrals
  must record visible scheduling debt and still obey a maximum service-lag
  target when foreground load leaves capacity.
- Contain cleanup errors at cleanup-lane/spec scope. A thrown cleanup error must
  record diagnostics, trip a bounded circuit breaker for that lane/spec, and
  still allow review-serving projection/rebuild work to continue when otherwise
  healthy.
- Log concise counters: discovered, eligible, protected, deleted, skipped,
  errored, cursor scope, and elapsed time.

Before the incremental path is default-enabled, the old
`FORSKA_REVIEW_SERVING_RETENTION_CLEANUP_ENABLED` broad invocation must become
unreachable in normal worker code. Stale old-gate values must not be able to run
the broad cleanup after cutover. Use a separate incremental canary flag or kill
switch for the new path if needed, but do not reuse the old broad-cleanup gate
as a fallback.

Acceptance criteria:

- With default env, dirty-work cleanup and incremental broad cleanup both run.
- Default-on enablement is blocked until live evidence passes the predefined
  current-DB thresholds in the verification plan.
- A stale `FORSKA_REVIEW_SERVING_RETENTION_CLEANUP_ENABLED=true` cannot invoke
  the old broad cleanup after cutover.
- A worker wake cannot run 16 broad project/spec scans before foreground reads.
- Tests cover row-budget, statement-budget, transaction-budget, and
  elapsed-time-budget exhaustion. Elapsed-time checks are not enough by
  themselves because they cannot interrupt an already-running DuckDB statement.
- Worker tests prove cleanup status and diagnostics stay meaningful when only
  dirty-work cleanup ran, only incremental cleanup ran, both ran, or neither had
  work.
- Worker tests cover thrown cleanup, a foreground queue appearing after
  dirty-work cleanup, combined-budget exhaustion, and circuit-breaker recovery.
- Repeated-wake tests with a perpetual dirty-work backlog prove every eligible
  retention cleanup phase still progresses within the total owner-hold bound.
- Tests cover hot-scope backlog, retry backlog, compaction backlog, and
  sustained foreground-arrival scenarios, proving bounded service lag when
  capacity exists.

### 7. Add Operator Evidence, Not Operator Work

Add read-only evidence for cleanup state so operators can see whether automatic
cleanup is healthy, but they do not have to drive it manually.

The evidence should report:

- cleanup cursor scopes and lag;
- candidate counts by table/spec/status;
- top protected reasons;
- oldest discovered candidate;
- deleted rows per recent window;
- estimated retained rows for tables where this can be measured cheaply;
- whether the old broad gate is enabled.

This can extend the existing review-serving physical evidence script or add a
small focused diagnostic command.

Acceptance criteria:

- A current-DB evidence command can show cleanup progress without mutating the
  DB or scanning every row in every mart table.
- Evidence distinguishes "cleanup is idle because there is no work" from
  "cleanup is blocked behind protected rows" and "cleanup is failing".

### 8. Bound Cleanup Metadata Retention

Cleanup metadata needs its own retention design. Otherwise the cleanup system
can grow indefinitely or erase the retry state needed to finish work.

Add a retention matrix for every metadata class:

| Metadata class | Terminal predicate | Minimum evidence | Hard cap | Access path |
| --- | --- | --- | --- | --- |
| cursor/scope rows | scope retired after reconciliation fence | retained aggregate counters and final generation | per-spec/scope cap | scope/status/generation |
| canonical artifact incarnation rows | artifact unavailable tombstone no longer addressable by any external reference and all per-spec work is terminal/resolved | availability generation, state transitions, live-reference summary, retained tombstone/rebuild evidence | age/count cap only after external addressability ends | availability-state/project/artifact |
| per-spec artifact/work-item rows | artifact work terminal after all owned candidates are terminal/resolved and generation/write fences are acknowledged | artifact incarnation, spec, final generation, retained counters, replay tombstone | per-spec/scope age and count cap after terminality | status/next-check/scope/artifact |
| artifact protection rows | owning artifact terminal/resolved and no live candidates reference protection | protection cause, invalidation key, release/expiry evidence | bounded due queue, terminal age/count cap only | next-recheck/scope/artifact |
| candidate rows | `deleted` or `target_absent` only | aggregate/tombstone with target identity hash | per-status age and count cap | status/updated-at/scope |
| protected candidates | nonterminal, not TTL-eligible | full protection causes or artifact invalidation keys | bounded due queue, not TTL | next-recheck/scope |
| retryable errors and quarantine | nonterminal, not TTL-eligible | exact identity, attempts, last error, next retry/probe, recovery state | diagnostic-history cap only | next-retry/error-class |
| lifecycle outbox/tombstones | acknowledged by cleanup generation fence | immutable event/artifact key and source generation | age/count after fence | event-key/generation |
| target-write inventory/seals | acknowledged by artifact target-write or seal fence | inventory sequence, write generation, seal incarnation, replay tombstone | age/count after artifact terminality | spec/artifact/sequence |
| leases/attempts | expired and superseded by later generation | owner, expiry, generation, recovery result | short age cap after recovery | lease-expiry/status |
| breaker state | closed and quiet past evidence window | last failure/recovery aggregate | per-fault-domain cap | fault-domain/status |
| lifecycle-token history | no live rowid candidates reference token | token, bump reason, bump time | recent-token cap | token/table |
| diagnostics/profiles | summarized into retained evidence | statement hash, row groups scanned, owner-hold duration | rolling window cap | time/spec |

Compaction preconditions:

- per-row candidate compaction only after durable target absence/deletion and
  after the relevant lifecycle/reconciler generation fence;
- protected, retryable-error, and quarantined rows are excluded until they
  become terminal or are resolved by another durable recovery path that preserves
  actionable work and evidence;
- scope retirement only after no pending/protected/retryable/quarantined
  candidates or artifacts remain, no unacknowledged outbox/tombstone rows
  remain, and cursor/reconciler generations are fenced;
- per-spec artifact work compaction only after all candidate rows it owns are
  terminal or durably resolved, all artifact protection rows are terminal, and a
  replay tombstone/aggregate can reconstruct why future duplicate or
  out-of-order events are no-ops;
- canonical artifact-incarnation compaction only after no consumer can still
  address the old incarnation, every per-spec work item is terminal/resolved,
  and unavailable tombstone/rebuild evidence has moved to retained aggregate
  state;
- every metadata compaction query has the same bounded access-path and shared
  budget guarantees as normal cleanup.

Acceptance criteria:

- Tests cover high-volume terminal metadata drain without broad scans.
- Tests prove protected and retryable-error state survives restart and is not
  TTL-compacted while the target may remain.
- Tests prove quarantined state survives restart, schedules automatic recovery,
  and blocks scope retirement until deletion, proven absence, or durable
  recovery resolution.
- Tests cover safe scope retirement, retained tombstones/aggregates, and
  lifecycle-token history needed to reject stale rowids.
- Tests cover artifact terminality, artifact protection compaction,
  out-of-order event replay after artifact compaction, and bounded artifact
  metadata growth.

## Implementation Slices

### Slice 1: State And Read-Only Evidence

- Add cleanup cursor, canonical artifact-incarnation, per-spec artifact/work-item,
  artifact-protection, and candidate tables via migration.
- Add cleanup breaker, durable attempt/lease, lifecycle outbox/tombstone, and
  metadata aggregate tables via migration.
- Add repository/service helpers to read and write cursor, canonical
  artifact-incarnation, per-spec artifact, artifact-protection, and candidate
  state.
- Add indexes for canonical artifact availability, live-reference lookup,
  per-spec artifact scheduling, artifact incarnation identity, protection
  recheck, artifact-owned candidates, replay/tombstone lookup, and exact
  target-row identity.
- Add the producer matrix and hook inventory, with compile/test coverage that
  fails when a lifecycle writer is not classified.
- Add the consumer/reference matrix, artifact availability states, and
  protection acquisition protocol before any destructive cleanup enablement.
- Add the per-table cleanup identity/access-path map before any runtime worker
  enablement. The map must be generated or checked against the current schema
  and must classify each spec as logical-key, durable-surrogate, write-fed
  inventory, rebuild/swap cleanup, or lifecycle-tokened rowid.
- Add target-writer matrix implementation hooks, target-write generation or seal
  storage, inventory sequence/ack state, and migration/backfill profile entries
  for every first-slice spec.
- Add write-fed inventory bootstrap state, exact row-level inventory schema,
  post-watermark replay, readiness CAS, and inventory retention for every
  inventory-mode first-slice spec.
- Add the per-spec semantic matrix before runtime enablement for any spec.
- Add lifecycle-token storage and atomic bump hooks for any table that permits
  rowid-based cleanup.
- Add terminal candidate metadata compaction primitives and retention matrix
  checks, including artifact and artifact-protection compaction. Do not add TTL
  paths for protected, retryable-error, quarantined, or otherwise unresolved
  rows.
- Add read-only diagnostics for empty state and synthetic populated state,
  including artifact counts, artifact protection causes, scheduling debt, and
  replay/tombstone evidence.
- Add focused tests for schema, cursor serialization, rowid/string identity
  handling, lifecycle-token mismatch, stale-rowid reuse rejection, generation
  CAS, duplicate event idempotency, artifact terminality,
  artifact-protection recheck, breaker persistence, metadata compaction, and
  diagnostics.

Exit criteria:

- No runtime worker behavior changes yet.
- Diagnostics can display cleanup state.
- Artifact and artifact-protection state is created, indexed, inspectable, and
  bounded by the retention matrix.
- Every first-slice spec has physical access-path evidence or is explicitly
  blocked from worker enablement.
- Every first-slice target writer and consumer hook is installed, validated, and
  race-tested, or the spec is blocked from worker enablement.
- No spec can be enabled unless both its identity/access-path map and semantic
  matrix are complete.

### Slice 2: Incremental Discovery

- Implement one cleanup spec family first, preferably normal
  `snapshot_id`-scoped mart tables.
- Use the chosen proven access path with a small default discovery batch and the
  full per-table row identity, not `snapshot_id` alone.
- Persist candidate/protection state.
- Use requested/claimed/processed generations and claim leases for discovery and
  reconciler sweeps.
- Implement bounded source reconciliation/backfill for the first spec family,
  including outbox/tombstone recovery for source rows that can disappear.
- Add query-shape and query-profile tests that prevent full-scope scan/order
  regressions.
- Add a regression fixture with more than one batch of rows sharing a single
  `snapshot_id`.
- Add duplicate-boundary fixtures for specs without a uniqueness guarantee.
- Add event-at-EOF, duplicate delivery, crash/restart, stale lease, and
  insert/update/delete-behind-cursor fixtures.

Exit criteria:

- Discovery can make progress across protected and unprotected snapshots.
- Discovery can make progress within one snapshot that has more rows than the
  discovery batch size.
- Current-DB dry-run/profile evidence shows discovery rows/row-groups scanned
  and owner-hold duration within the configured per-query scan and owner-hold
  thresholds for that spec.

### Slice 3: Exact Candidate Deletion

- Delete already-discovered candidates by exact row identity.
- Revalidate protection immediately before delete.
- Mark candidates deleted or target-absent as terminal with concise diagnostics.
- Keep protected and retryable-error candidates nonterminal, with
  artifact-level protection causes, retry/backoff state, and due queue entries.
- Use lane/spec circuit breakers for repeated delete errors.
- Persist failed-attempt and breaker state even when target delete/revalidation
  transactions roll back.
- Add tests for protection changes between discovery and delete.
- Add stale-protected recheck tests for overlapping protections, pin expiry,
  active/LKG manifest change, selected-import references, and rebuild request
  terminalization.
- Add tests for foreground queue arrival before delete, thrown cleanup
  containment, poison-row isolation, half-open breaker recovery,
  lifecycle-token mismatch, and terminal metadata compaction.

Exit criteria:

- Synthetic tables drain automatically without broad delete predicates.
- Exact deletion is idempotent and retryable.
- Cleanup errors do not stop unrelated review-serving projection progress.

### Slice 4: Cover Selected-Import And Terminal Chunk Specs

- Port selected-import published/staging cleanup to the same discovery/delete
  model.
- Port terminal rebuild chunk manifest cleanup to the same model.
- Preserve the existing special protection semantics for selected-import LKG
  references and retryable/newest diagnostic rebuild requests.

Exit criteria:

- Every old cleanup spec has an incremental equivalent.
- The old broad cleanup path is no longer needed for coverage.

### Slice 5: Default Worker Enablement And Old-Path Removal

- Enable incremental broad retention cleanup by default.
- Before default-on enablement, make the old broad cleanup invocation
  unreachable from the worker and prove stale old-gate env values cannot invoke
  it.
- Run the incremental path behind a separate canary/kill switch until the live
  evidence gate passes.
- Keep dirty-work retention semantics unchanged, but move it behind the shared
  budget-aware cleanup API so it cannot starve other cleanup lanes forever.
- Add rotating/fair scheduling across dirty-work retention, scope seeding,
  discovery, protected rechecks, deletion, error recovery, and metadata
  compaction.
- Remove or retire the old broad cleanup path and the old env gate once the new
  path has live current-DB evidence and coverage for every old cleanup spec.
- Update docs and tests to describe automatic cleanup as the default behavior.

Exit criteria:

- Default worker logs show bounded incremental cleanup counters.
- No broad retention cleanup scan can run by default.
- Default-on cutover is blocked unless predefined live owner-hold, route-latency,
  queue-wait, error-rate, and completed-wake thresholds pass.

## Verification Plan

Focused tests:

```bash
bun test src/server/reviewServing/reviewServingRetentionService.test.ts
bun test src/server/reviewServing/reviewServingRetentionCleanupLifecycle.test.ts
bun test src/server/reviewServing/reviewServingRetentionCleanupFaults.test.ts
bun test src/server/workers/reviewServingProjectorWorker.test.ts
bun test src/db/migrateDuckdb.test.ts
bun test src/server/reviewServing/reviewServingSchema.test.ts
git diff --check
```

Producer-specific and durability suites must be added with the implementation
slice that introduces the corresponding hook. Do not wait until the final worker
slice to test lifecycle delivery. The new suites should cover manifest/projector
writers, selected-import lifecycle, pin lifecycle, rebuild request/status
writes, startup repair, hook inventory completeness, source reconciliation,
generation CAS, tombstone/outbox recovery, protection reactivation, breaker
containment, and shared-budget fairness. Add the focused command(s) to
`TESTS.md` when the suites are introduced.

Broader review-serving/DuckDB verification for the final worker-enabled slice:

```bash
bun run lint
bun run test:dev-server:current-db
bun run test:network-smoke:current-db:readonly
bun run test:network-smoke:current-db
```

Live current-DB evidence must include:

- API and maintenance/DuckDB-owner readiness;
- a real nonterminal current-DB review-serving workload while cleanup is active;
- the affected project's review-serving progress counters before and after a
  minimum 10-minute interval or at least 50 completed cleanup wakes, whichever
  is longer, including domain progress rather than readiness alone;
- project detail route latency for the previously failing route class under a
  stated concurrent foreground workload;
- cleanup cursor, artifact/work-item, artifact-protection, and candidate
  counters moving in the right direction;
- eligible deletion counters moving, not only discovery counters;
- per-spec eligible backlog slope, oldest-eligible age, and service-lag
  measurements;
- deletion throughput versus representative retirement rate, including headroom;
- bounded legacy-backfill progress and projected completion time;
- protected rows surviving while protection remains, then deleting after
  release/expiry;
- missed-event/reconciler recovery evidence for every default-on spec family;
- one intentionally broken or quarantined spec/candidate while unrelated cleanup
  and projection continue to progress;
- repeated wakes under dirty-work backlog showing every eligible cleanup phase
  progresses within the shared owner-hold bounds;
- metadata compaction counters moving only for terminal records;
- query-profile evidence for the enabled cleanup statements, including scanned
  row counts or row groups and owner-hold duration;
- migration, index build, durable-identity bootstrap, lifecycle-token bootstrap,
  and existing-row backfill profile evidence, plus API/readiness/progress
  evidence during and after those rollout steps;
- no 504s or owner starvation while cleanup is active.

Pre-enable pass thresholds must be written down before default-on cutover. Use
numerical thresholds when possible and baseline-relative thresholds only when
the baseline command is included in the evidence. Initial defaults:

- every enabled owner-held cleanup query has a profile entry and stays within
  its configured row/row-group scan cap;
- any hard-cap violation, unexpected breaker trip, or unresolved pre-attempt
  fails the canary even if p95/p99 aggregates remain within bounds;
- p99 owner hold per cleanup statement is less than 250 ms, or less than 2x the
  measured foreground-read baseline when the table requires a higher cap;
- p99 cleanup transaction owner hold is less than 500 ms;
- one worker wake holds the owner for less than 1 second total cleanup time;
- foreground queue wait p99 stays below 1 second during the canary;
- project-detail and review-warning routes return 100 percent HTTP 2xx over the
  canary window, with p95 below 1 second and p99 below 3 seconds;
- canary workload includes at least 4 concurrent foreground clients polling
  project detail, review warnings/status, and `llmstatus`;
- at least 50 cleanup wakes complete with dirty-work backlog present, and every
  default-on broad-retention spec has eligible discovery, revalidation, deletion,
  reconciliation, and compaction work exercised unless the spec is explicitly
  blocked from default-on enablement;
- define component-wise debt units and warmup completion for every enabled spec
  before the canary. Debt components include unmaterialized artifact work,
  inventory/backfill debt, eligible candidates, retry/quarantine debt,
  protected-due debt, and terminal metadata awaiting compaction;
- for every enabled spec, current-DB actionable retention debt must decline over
  the canary window after warmup, or have a measured bounded drain projection for
  finite backlog. Flat aggregate debt is not enough if any component is growing;
- synthetic retirement load may supplement low natural arrival volume to prove
  throughput headroom, but it cannot override a positive live current-DB debt
  slope;
- deletion throughput is at least 2x representative retirement rate when
  representative retirement arrivals are present;
- oldest-eligible age and per-spec service lag stay within the configured SLO;
- legacy backfill has a bounded completion projection and advances monotonically
  under foreground load, with measured arrival/deletion rates and an end-to-end
  drain projection for any finite backlog exception;
- review-serving domain progress advances during the canary:
  `lastProgressedAt` moves forward, completed chunks increase, and
  pending/queued/running work decreases or terminalizes. If no real
  nonterminal workload exists, the canary is invalid rather than passed;
- every distinct enabled access-path and reconciliation strategy is exercised;
- error rate for cleanup statements is zero except for deliberate
  fault-injection/quarantine evidence where unrelated work must continue.

## Definition Of Done

- Broad snapshot/mart retention cleanup runs automatically by default through
  incremental state, not through the old gated broad scan.
- Dirty-work retention cleanup still runs by default.
- Retired review-serving mart/snapshot artifacts drain over time without manual
  intervention.
- The final delete path uses exact candidates and revalidates protection.
- Tests cover the access-path bug: final `LIMIT` alone is not accepted as a
  bounded cleanup.
- Tests cover the physical-access bug: a syntactically bounded keyset/delete
  plan that still broad-scans a heap table is not accepted.
- Cleanup event hooks and bounded reconciliation recover from missed lifecycle
  events without operator work.
- Lifecycle completion is generation/lease/CAS protected, so stale sweep EOF
  writes cannot hide newer lifecycle work.
- Protected and retryable-error candidates are nonterminal and cannot be
  TTL-compacted while their target may still exist.
- Cleanup failures are contained by lane/spec circuit breakers and do not stop
  unrelated review-serving progress.
- Shared cleanup budgets cover dirty-work retention and all incremental
  retention phases, with fairness tests under perpetual dirty backlog.
- Cleanup metadata has bounded retention and cannot grow indefinitely with the
  marts it is meant to clean.
- Current-DB verification proves foreground routes remain responsive and review
  serving continues to progress while cleanup runs.
