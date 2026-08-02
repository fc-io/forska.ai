# Review-Serving Cold Bootstrap Rebuild Improvement Plan

Date: 2026-08-02

## Goal

Make a review-serving rebuild from empty project-scoped serving state complete
without operator intervention, promote a correct default-readable snapshot as
early as possible, and leave slower secondary artifacts to finish under explicit
readiness semantics.

This plan follows the measured cold rebuild of project
`9e25a18e-ad15-4d34-b999-608902e6d7a1`
(`cov | GPT 5.5 xhigh | 5`):

- queued/manual request created: 22:42:20
- admitted: 22:47:07
- first chunk started: 22:47:37
- active snapshot promoted: 23:17:50
- created to active: about 35m30s
- admitted to active: about 30m43s
- worker chunk window: about 30m13s
- completed chunks: 3,276
- search/title index chunks: 3,078
- pending/running/failed/quarantined/over-budget after cleanup: 0

The current pipeline can produce a correct active snapshot, but the cold path is
still shaped like an oversized exceptional rebuild instead of a first-class
bootstrap workflow.

## Success Criteria

- A project with deleted review-serving/cache rows can request a rebuild through
  the same creation path used by the real API and maintenance owner.
- The rebuild admits automatically without a manual budget override.
- Obsolete project-scoped dirty work does not contaminate cold rebuild timing or
  block the new snapshot.
- A minimal default-readable snapshot promotes before optional secondary
  artifacts when the API does not need those artifacts for default routes.
- Full completion remains observable and eventually reaches zero pending,
  running, failed, quarantined, and over-budget chunks.
- Background indexing/materialization work does not block normal foreground UI
  interactions once the default-readable snapshot is available.
- The system records one canonical rebuild timeline with created, admitted,
  first-work, default-readable, fully-enriched, and promoted timestamps.

## Non-Goals

- Do not change source article, import, prompt, or judgment semantics.
- Do not bypass model/provider/content-setting filters in judgment queries.
- Do not add compatibility shims for obsolete intermediate state unless a live
  migration window explicitly requires one.
- Do not optimize by silently skipping artifacts that routes still treat as
  ready or exact.

## Work Breakdown

### 1. First-Class Cold Bootstrap Admission

Problem:

When the active review-serving snapshot is missing, the root rebuild estimate is
large enough to trip the existing admission budget. The worker can split the
work into bounded chunks after admission, but a totally empty serving state
currently needs manual/operator help to reach that point.

Tasks:

- Add an explicit cold-bootstrap request classification for projects with no
  usable active/candidate review-serving snapshot.
- Teach admission to accept the cold-bootstrap root when it can immediately
  create bounded child work under the normal per-component budgets.
- Keep the safety invariant on executable work: only bounded child chunks should
  claim actual DuckDB work.
- Record the reason for admission in rebuild diagnostics, including
  `coldBootstrap`, estimated root cost, child budget, and split counts.
- Add regression coverage for missing-snapshot rebuilds that would previously
  have been rejected as over budget.

Acceptance criteria:

- A no-snapshot rebuild creates bounded child work without manual SQL or
  operator metadata edits.
- No single claimed child chunk exceeds the existing executable-work budget.
- An overlarge child chunk is still split, quarantined, or rejected by the
  existing safety path.

### 2. Project-Scoped Rebuild Reset Semantics

Problem:

The timing run was initially polluted by old dirty-work backlog. A cold rebuild
needs a clear project-scoped reset/adoption policy so obsolete dirty work does
not drain before the measurement starts or leave false pending warnings after
the rebuild.

Tasks:

- Define the project-scoped rows that belong to review-serving control state:
  requests, dirty work, manifests, component readiness, active/candidate
  snapshot metadata, and cache/materialized serving rows.
- Add one internal reset/adopt operation used by cold rebuild tooling and tests.
- Within a transaction, cancel, supersede, or adopt obsolete dirty work for the
  same project/projection generation before the new cold-bootstrap work starts.
- Preserve evidence for failed, quarantined, or over-budget work instead of
  silently deleting diagnostic rows.
- Add cleanup for operator/manual root request metadata once all adopted child
  work has completed or been superseded.

Acceptance criteria:

- Cold rebuild timing starts from the intended rebuild work, not an old dirty
  backlog.
- Completed/readable projects do not show stale pending warnings from superseded
  root requests.
- Failures remain inspectable.

### 3. Minimal Default-Readable Snapshot

Problem:

The current active promotion effectively couples default API readiness to full
artifact completion. The lazy-readiness work already split some optional
surfaces, but cold bootstrap still needs an explicit default-readable milestone
that is separate from fully-enriched completion.

Tasks:

- Define the minimal default-readable component set for the unfiltered review
  API:
  - project scope
  - selected-import ordering
  - base display rows needed for default lists
  - LLM/Human/Both/Unassessed status and exact tab totals
  - unassessed queue list/count readiness required by the default page
  - basic unfiltered summary/count surfaces required by the default page
- Define the secondary component set:
  - search/title index
  - prompt-answer postings
  - prompt-derived facets/filter options
  - detail hydration payloads beyond visible-page needs
  - queue prompt-pair payload expansion
- Add readiness state for `defaultReadable` and `fullyEnriched`.
- Permit promotion or API routing to a default-readable snapshot only when all
  default routes can answer exactly without consulting unavailable secondary
  artifacts.
- Ensure routes that require secondary artifacts either use lazy fallback,
  return explicit stale/async availability, or wait for the matching readiness
  key.

Acceptance criteria:

- Default LLM, Human, Both, and Unassessed tab counts match source truth after
  cold rebuild before secondary completion.
- Default list reads do not wait for search/title index completion.
- Filtered/search-specific routes never present secondary artifacts as ready
  unless they are actually built or answered exactly through fallback.

### 4. Search/Title Index Rebuild Optimization

Problem:

Search/title index dominated the cold rebuild: 3,078 of 3,276 chunks and the
last completed work. Improving cold time requires either moving this work out of
the default-readiness path or making the bulk build substantially cheaper.

Tasks:

- Measure the current search/title chunk shape:
  - average chunk wall time
  - claim/select time
  - execute time
  - split/recovery time
  - rows/articles per chunk
  - index rows written per article
- Identify whether the bottleneck is queue overhead, SQL execution, text
  normalization, write amplification, or excessive chunk fragmentation.
- Prefer a set-oriented rebuild path for search/title index when starting from
  empty serving state.
- Increase calibrated chunk sizes only when memory and writer latency evidence
  show it is safe.
- Consider a separate `searchReady` readiness key so default routes promote
  before search completion while search routes can remain explicit.

Acceptance criteria:

- Search/title work no longer blocks default-readable promotion.
- Full enrichment time decreases or has clear per-phase evidence explaining the
  remaining cost.
- Search route behavior is exact: it waits, lazily builds, or reports
  unavailable/stale state instead of reading missing index rows silently.

### 5. Work Fan-Out And Queue Overhead Reduction

Problem:

Prior timing evidence showed meaningful overhead in claim/split bookkeeping and
many small chunks. Cold bootstrap should reduce queue churn as well as tune SQL.

Tasks:

- Add chunk-level timing fields for claim selection, execution, split/recovery,
  and metadata updates where they are missing.
- Coalesce child work for adjacent ranges or compatible component keys when the
  same SQL can build them safely in one bounded operation.
- Avoid creating child chunks for optional secondary surfaces until their
  readiness tier is needed.
- Replace repeated root/child polling patterns with a cheaper aggregate progress
  query where possible.
- Keep backpressure per project and per component so a cold rebuild does not
  starve unrelated maintenance work.

Acceptance criteria:

- Rebuild progress can be observed without scanning or joining large control
  sets repeatedly.
- Chunk count drops for equivalent cold work, or chunk timing shows that the
  remaining chunking is dominated by useful SQL execution rather than queue
  metadata overhead.
- Concurrent project maintenance remains bounded.

### 6. Canonical Rebuild Timeline And Operator Readout

Problem:

The timing run required reconstructing the useful wall-clock signal from child
chunks, active snapshot promotion, and stale manual root metadata. The system
should report the answer directly.

Tasks:

- Add a rebuild timeline view or inspect command that reports:
  - root request id
  - project id and review config identity
  - created at
  - admitted at
  - first chunk started at
  - default-readable at
  - fully-enriched at
  - active snapshot promoted at
  - component counts by pending/running/completed/failed/quarantined/over-budget
  - component wall-clock spans
- Include adoption/supersession relationships when child work is adopted from an
  older missing-snapshot request.
- Make stale pending metadata visible as superseded rather than active pending.
- Add an operator-facing summary for cold rebuilds and default-readiness rebuilds.

Acceptance criteria:

- The rebuild duration can be read from one command or API route.
- Operator-created/manual metadata cannot make a completed project look pending.
- The readout distinguishes default-readable time from fully-enriched time.

### 7. Foreground UI Latency Protection During Background Work

Problem:

Moving search/title and other secondary artifacts out of the default-readable
critical path is only useful if the background work does not still monopolize
the shared DuckDB/runtime. After `defaultReadable`, users should be able to
switch tabs, page through default lists, open article rows, change selections,
and start normal review actions while search indexing or lazy materialization
continues.

Tasks:

- Classify review-serving operations into foreground and background priority:
  - foreground: default tab counts, default list reads, visible-row hydration,
    article selection, route metadata, and review actions the user explicitly
    triggers
  - background: search/title indexing, prompt-answer bucket materialization,
    prompt-derived facet/summary buckets, queue prompt-pair expansion, and full
    enrichment cleanup
- Add worker backpressure so background work yields to foreground reads and
  writes. Prefer short DuckDB transactions, bounded batches, lease pauses, and
  per-project/per-component concurrency caps over long monopolizing jobs.
- Make search/title and lazy materialization resumable between small units of
  work so a foreground request can make progress quickly.
- Add request/runtime metrics for foreground routes during background rebuild:
  p50/p95/p99 latency, timeout count, DuckDB wait time, and whether the request
  waited behind background work.
- Ensure the UI can keep interacting with already-ready default surfaces while
  secondary readiness states are still pending.
- If a foreground route needs an unfinished secondary artifact, return an
  explicit pending/stale state or run a bounded foreground fallback for only the
  requested key. Do not block unrelated UI interactions behind the whole
  background rebuild.

Acceptance criteria:

- While search/title indexing is running for
  `9e25a18e-ad15-4d34-b999-608902e6d7a1`, default tab count/list routes still
  respond within the agreed latency budget.
- Switching between LLM, Human, Both, and Unassessed tabs does not wait for full
  enrichment.
- Opening a visible article row does not wait for unrelated prompt-answer,
  search/title, or queue prompt-pair materialization.
- Background chunk progress continues, but it yields or slows down under
  foreground UI load instead of causing route timeouts.
- Search-specific interactions are explicit: they either use ready search data,
  trigger/wait for bounded search work, or return a pending search state.

## Recommended Implementation Order

1. Add instrumentation and canonical timeline readout first. This makes every
   following performance claim easier to prove.
2. Add project-scoped reset/adoption semantics so cold rebuild experiments start
   from clean control state.
3. Add first-class cold-bootstrap admission and regression tests.
4. Add default-readable versus fully-enriched readiness and route guards.
5. Move search/title index behind its own readiness key and optimize the bulk
   build path.
6. Add foreground UI latency protection and tests while secondary background
   work is running.
7. Reduce fan-out and queue overhead using timing evidence from the new
   instrumentation.

## Quality Gates

Documentation-only plan creation:

- [x] `git diff --check`

Implementation gates for future PRs:

- [ ] Targeted unit tests for cold-bootstrap admission and child split budget
      behavior.
- [ ] Targeted unit tests for project-scoped dirty-work reset/adoption and
      stale pending metadata cleanup.
- [ ] Route parity tests proving default tab counts and list reads match source
      truth before secondary artifacts are ready.
- [ ] Targeted tests for search route behavior when `searchReady` is missing.
- [ ] Concurrency regression test: run background search/title or lazy
      materialization work, then issue default tab count/list reads and assert
      they complete within a fixed latency budget without waiting for full
      enrichment.
- [ ] Concurrency regression test: while background chunks are claimable/running,
      visible-row hydration and tab switching still use default-readable
      artifacts and do not trigger unrelated secondary materialization.
- [ ] Backpressure regression test: foreground route load reduces or pauses
      background claim/execution concurrency instead of increasing foreground
      DuckDB wait time until timeout.
- [ ] `bun run db:mig` for any DuckDB migration or schema change.
- [ ] `bun run lint` for touched TypeScript.
- [ ] Relevant `bun test <file>` commands for touched server/database modules.
- [ ] Current-DB cold rebuild smoke on
      `9e25a18e-ad15-4d34-b999-608902e6d7a1`, recording:
      - created to admitted
      - admitted to default-readable
      - default-readable to fully-enriched
      - fully-enriched to active/promoted, if distinct
      - completed/pending/running/failed/quarantined/over-budget counts
- [ ] Current-DB interaction smoke: after `defaultReadable` and before
      `fullyEnriched`, exercise the review UI/API while search/title or other
      secondary chunks are still running:
      - switch LLM/Human/Both/Unassessed tabs
      - page a default list
      - open a visible article row
      - request one search query and verify explicit ready/pending behavior
      - record route latencies and DuckDB wait/timeout counts
- [ ] Live progress gate before PR/merge for changes touching maintenance,
      DuckDB lifecycle, rebuild queues, worker scheduling, or progress
      reporting:
      - API and maintenance/DuckDB owner readiness are healthy.
      - Relevant review-serving progress counters move over a short interval.
      - `lastProgressedAt`, completed chunks, or pending/running counts move in
        the expected direction.

## Risks

- Promoting default-readable too early can hide missing secondary artifacts if
  route readiness checks are incomplete.
- Cold-bootstrap admission can weaken safety if the root request is allowed to
  execute directly instead of only splitting into bounded child work.
- Resetting old dirty work can destroy useful evidence unless failures and
  supersession relationships are preserved.
- Search/title optimization can trade wall-clock speed for DuckDB memory
  pressure; bulk paths need memory-capped verification.
- Background materialization can still make the UI feel broken if it monopolizes
  DuckDB or the maintenance owner; latency gates must run while background work
  is actively running, not only after it finishes.
- More readiness states can make operator output confusing unless the timeline
  clearly distinguishes default-readable, search-ready, fully-enriched, and
  promoted.

## Open Questions

- Should `defaultReadable` promote an active snapshot immediately, or should it
  publish a candidate/default-readable snapshot while active promotion waits for
  full enrichment?
- Which routes are allowed to depend on `searchReady`, and what exact state
  should they return while search/title is still rebuilding?
- What foreground latency budget should be enforced while background
  materialization is running?
- Should cold-bootstrap reset/adoption be exposed as an operator command, a
  maintenance-internal transition, or both?
- What target should be set for admitted-to-default-readable on the current-DB
  project after search/title is decoupled?
