# Review Append-First Storage Strategy Plan

## Purpose

Define how to evaluate an append-first storage architecture for project reviews.
The goal is to make new imports, judgments, and review changes cheap to record
while preserving exact, bounded, query-ready review pages.

This is an options and investigation plan. It does not choose a final schema or
authorize a production cutover.

## Short Version

The append-first idea is:

1. Append stable facts cheaply in import or judgment batches.
2. Keep large history and payload immutable where practical.
3. Maintain only the small amount of current state needed to select and order
   article IDs quickly.
4. Resolve one manifest, select a bounded page, and hydrate larger fields by key.
5. Compact old versions or segments before they make reads expensive.

The main options are a narrow mutable current index, immutable component
segments, wide row versions with a pointer, or complete immutable snapshots. The
later benchmark will compare them rather than assuming append-only is always the
best read shape.

## Key Distinction

Appending immutable facts can be very fast. Exposing the exact current winner,
status, order, filter membership, and count requires an additional strategy.

For example:

```text
Article A first arrives through import route X
  -> append candidate X

Article A later arrives through route Y with a better rank
  -> append candidate Y
  -> current selected import changes from X to Y
  -> import-route filters and counts must stop treating X as current
```

The append is simple. The architecture must still decide how readers learn that Y
is now current without scanning every historical version.

## Goal

Find the simplest design that provides all of these properties:

- cheap batched writes for imports and judgment bursts
- exact current review rows, filters, queues, and named counts
- bounded foreground work based on page size or a selective posting
- no project-scale latest-version window in product reads
- explicit snapshot publication and last-known-good behavior
- idempotent replay after failure or restart
- bounded compaction and retention
- safe operation under browser/server and desktop memory limits

## Non-Goals

- Do not require every source mutation to synchronously build every project mart.
- Do not call an event log a serving index unless current-state reads are bounded.
- Do not make arbitrary exact count/filter combinations synchronous by default.
- Do not silently change model, provider, thinking level, prompts, or content
  settings to reduce work.
- Do not add multiple production DuckDB writers without explicit benchmark and
  conflict evidence.
- Do not assume Parquet, a separate database, or more indexes are automatically
  faster.
- Do not keep permanent V4 and replacement write paths for internal state.

## Working Vocabulary

| Term | Meaning | Example |
| --- | --- | --- |
| Fact | Immutable observation from a source mutation | Article A received candidate import X |
| Version | New value for the same logical key | Article A title changed from old to new |
| Tombstone | Immutable removal/invalidation record | Article A removed from project P |
| Segment | Bounded batch of immutable rows published together | One 25,000-row import projection batch |
| Current index | Small structure that identifies current state efficiently | `(project, article) -> selected import version` |
| Manifest | Atomic pointer to component generations or segments | Active review snapshot uses status generation 12 |
| Compaction | Merge versions/segments into a new bounded base | Combine 20 delta segments into one base segment |
| Retention | Delete state that no active, last-known-good, or pinned reader needs | Remove retired segments after publication safety checks |

## Data Classes

The later design should choose append and current-state behavior separately for
each data class.

| Data Class | Append-Friendly Input | Current-State Requirement | Example |
| --- | --- | --- | --- |
| Article display fact | Article create/update version | Usually keyed hydration; search may need its own index | Append a new title version, display it after page IDs are known |
| Import candidate fact | Route/article/source-record version | Select one current winner per project/article | Append rank fields once and update a narrow winner index |
| Project membership | Add/remove fact | Exact current scope before candidate selection | Append a removal tombstone and update current scope state |
| LLM judgment | Judgment version with full config identity | Latest non-deleted matching judgment and project prompt status | Append judgment; update affected project/article status |
| Human judgment | Human answer version | Current prompt/summary answer and review status | Append answer; update narrow status and queue state |
| Candidate order | Project/article sort state | Fast keyset order before `LIMIT` | Narrow current table or compact ordered segment |
| Filter posting | Membership add/remove | Exact selective article set | Append posting changes, then reduce or compact them |
| Named count/facet | `+old/-new` contribution | One current exact value per supported key | Add `-1` to unanswered and `+1` to answered |
| Search token | Token add/remove version | Current token candidates intersected with project scope | Reuse global title tokens when semantics permit |
| Payload/detail | Immutable keyed payload version | Fetch current referenced payload for selected IDs | Keep abstract or explanation out of candidate rows |
| Snapshot/control | Component publication event | One atomic active pointer and last-known-good pointer | Publish only after required components pass validation |

## Leading Hypothesis

The first design to prototype should be a hybrid:

```text
authoritative source transaction
  -> append compact fact/delta rows
  -> commit

bounded projector
  -> append immutable component rows or segments
  -> update a small current index where required
  -> validate component watermarks
  -> atomically publish a manifest

review request
  -> resolve manifest once
  -> select a bounded page of article IDs
  -> hydrate display, selected import, status, and payload by key
```

This is a hypothesis, not the final choice. The audit and physical benchmark must
compare it with the other options below.

## Architecture Options

### Option 1 - Append Facts, Keep Narrow Mutable Current Marts

Append source facts and deltas, then maintain compact current-state tables using
bounded `INSERT ... ON CONFLICT`, update, or delete operations.

Example:

```text
append import candidate version
upsert one selected-winner row for affected project/article
upsert one narrow list-status row
apply posting/count contribution differences
```

Advantages:

- simplest exact read path
- minimal latest-version work in foreground requests
- compatible with existing dirty-work and manifest concepts
- large payload and history can remain append-only

Costs:

- current indexes are not purely append-only
- indexed updates/deletes still need DuckDB memory and lifecycle testing
- project fan-out must remain bounded and asynchronous when not already known

### Option 2 - Immutable Component Segments Plus Manifest

Append bounded immutable segments for display, scope, selected import, status,
posting, and payload components. A manifest identifies the active base and small
set of delta segments for each component.

Example:

```text
status base segment 12
status delta segments 13, 14
manifest says read base 12 plus deltas 13-14
compaction publishes base 15 before a third delta threshold is exceeded
```

Advantages:

- bulk append is a natural DuckDB workload
- unchanged components can be reused across snapshots
- publication and rollback are explicit
- component changes do not rewrite unrelated wide columns

Costs:

- readers must merge a strictly bounded number of segments
- tombstone precedence and cursor identity become more complex
- compaction, pins, retention, and interrupted publication require careful state
  machines

### Option 3 - Append Wide Row Versions Plus A Narrow Current Pointer

Append a complete review-row version whenever any part changes. Maintain a narrow
pointer from logical row key to the current version.

Example:

```text
(project P, article A, mode llm) -> row version 44
```

Advantages:

- old versions are immutable and easy to audit
- reads can be exact if the pointer lookup is efficient
- no in-place wide-row update

Costs:

- one small status change rewrites title, identifiers, import fields, and other
  unchanged values
- four list modes and retained snapshots multiply versions
- pointer maintenance still mutates current state
- storage and compaction can become the dominant cost

This option is useful as a benchmark comparison, but it should not be assumed to
be compact.

### Option 4 - Append Complete Immutable Project Snapshots

Build and append every row for a new project snapshot, then atomically flip the
active snapshot pointer.

Advantages:

- simple and consistent reads
- straightforward rollback to the last-known-good snapshot
- initial empty-project builds can use fast set-based inserts

Costs:

- routine changes can copy millions of unchanged rows
- retained snapshots multiply storage
- publication latency remains project-scale

This may remain appropriate for rare structural rebuilds, but not routine article
or judgment changes.

### Option 5 - Pure Append Log With Latest-Version Resolution In Reads

Append every version and make product queries select the latest row with windows,
aggregates, or anti-joins.

Advantages:

- cheapest and simplest write path
- complete history is naturally retained

Costs:

- current-state resolution scales with history or project size
- exact counts, filters, and keyset pagination become difficult to bound
- recreates the raw project-scale query shapes the serving architecture avoids

This option should be rejected for hot large-project routes unless a physical
benchmark proves a bounded access path.

## Option Comparison

| Option | Write Shape | Foreground Read | Storage Growth | Compaction Need | Initial Assessment |
| --- | --- | --- | --- | --- | --- |
| Append facts plus narrow current marts | Append plus small keyed mutation | Simple and bounded | Low to medium | Moderate | Strong baseline candidate |
| Immutable component segments | Batched append | Bounded merge plus hydration | Medium | Required and explicit | Strong architecture candidate |
| Wide row versions plus pointer | Wide append plus pointer update | Bounded pointer join | High | High | Benchmark as comparison |
| Complete snapshots | Project-scale append | Very simple | Very high | Retention cleanup | Structural rebuild only |
| Pure append/latest at read | Cheapest append | Potentially unbounded | High history growth | Optional but eventually required | Poor hot-route fit |

## Where Data Could Live

The strategy should evaluate location separately from append semantics.

| Location | Good Fit | Risks And Questions |
| --- | --- | --- |
| DuckDB `app.*` | Authoritative relational facts and compact write-side state | Keep source writes small; avoid project fan-out in the transaction |
| DuckDB `mart.*` | Narrow current indexes, component segments, postings, named summaries | Index and cleanup cost must be measured under the maintenance memory profile |
| DuckDB keyed payload table | Moderate payloads needed by detail or bounded hydration | Do not join before candidate selection |
| Local files | PDFs, full text, or very large immutable blobs | Path portability, desktop lifecycle, backup, and deletion semantics |
| Parquet segments | Potential cold immutable history or large append batches | No current runtime integration; manifest, compaction, and desktop file safety add complexity |
| Separate serving DuckDB | Possible isolation of serving growth and rebuild work | Cross-database publication, backup, ownership, and browser/desktop path complexity |
| Delete entirely | Retired derived state with no product, recovery, or audit need | Requires the deletion proof from `REVIEW_STORAGE_SHAPE_AUDIT_PLAN.md` |

Parquet or another file format should advance only if a DuckDB-table prototype
shows a measured limitation that immutable files solve.

## Publication Choices

The product must define when an import or mutation is considered complete.

### Choice A - Source-Durable Completion

Return success after authoritative data and its append delta are durable. Review
state can temporarily be `indexing` or `stale`.

Good fit:

- import latency is more important than immediate review readiness
- the last-known-good snapshot can remain visible
- projector lag is bounded and observable

### Choice B - Review-Ready Completion

Do not mark an import batch complete until its required review segment or current
index is validated and published.

Good fit:

- users move directly from import to review
- affected project fan-out is known and bounded
- the extra import latency has an explicit budget

Risk:

- projection failures become import-completion failures
- large shared routes can make import latency depend on many projects

### Choice C - Two Explicit Statuses

Expose separate `sourceStored` and `reviewReady` states.

This is the clearest contract when source durability should not wait for serving
publication but the UI must know exactly when review pages are ready.

## Current-State Strategies

Every append design must choose one or more of these mechanisms:

| Strategy | Use When | Avoid When |
| --- | --- | --- |
| Narrow current row | One logical key changes often and hot reads need exact current fields | The row starts accumulating unrelated payloads |
| Current-version pointer | Payload versions are immutable and one small lookup identifies the winner | Candidate ordering would still require joining many pointers before `LIMIT` |
| Base plus bounded deltas | Changes arrive in batches and readers can merge a fixed small segment count | Delta count can grow without enforced compaction |
| Atomic full snapshot | Structural changes are rare and full copy cost is acceptable | Routine article or judgment updates |
| Async job/unavailable | Exact arbitrary search/count cannot be bounded synchronously | Product contract requires immediate exact state |

## Operation Examples

### New Import Batch

```text
1. Write canonical article and source records.
2. Append compact typed import facts and durable source deltas in the same
   transaction.
3. Commit without resolving unbounded route-to-project fan-out.
4. Coalesce affected project/article work.
5. Append project component rows in bounded batches.
6. Update narrow current indexes or publish bounded segments.
7. Validate and atomically publish review-ready state.
```

Fields such as publication year, rank, duplicate flag, and selected-source URL
are good append-fact candidates. Full text and large raw payload are not good
list-row candidates.

### Better Selected Import Candidate Arrives

```text
1. Append the new candidate fact.
2. Compare candidates for only the affected project/article.
3. Append the winner-change version or update its narrow current winner row.
4. Apply old/new posting and count changes.
5. Publish the selected-import component identity.
```

The projector should not reconstruct unrelated display, LLM, human, payload, and
snapshot columns merely to change the selected route.

### Judgment Changes From Unanswered To Answered

```text
1. Append the judgment with exact model and content settings.
2. Resolve only projects/configurations that match those settings.
3. Append or update narrow article/prompt status.
4. Apply `-1 unanswered` and `+1 answered` named contributions.
5. Update queue/posting membership and publish the affected components.
```

### Article Is Removed Or Project Config Changes

Removal can be represented by a tombstone and bounded current-index update. A
model, prompt-set, or content-setting change may invalidate many project-specific
status rows and legitimately require a new component base or structural snapshot.
Append-first storage does not eliminate all rebuilds.

## Counts, Filters, And Search

### Named Counts And Facets

- Append deterministic old/new contribution changes.
- Reduce them into one current value per named supported key.
- Keep contribution application idempotent by source watermark and definition
  version.
- Return unavailable or async state for unsupported arbitrary combinations.

Example: when one article becomes LLM-complete, apply `-1` to the project/config
unanswered key and `+1` to the complete key in the same publication transaction.

### Filter Postings

- Compare append-only membership events with narrow current posting rows or
  bounded posting segments.
- Keep only filter kinds mounted product routes use synchronously.
- Select the most selective posting before hydrating article rows.
- Do not scan a wide article table to rediscover one page of selective results.

### Search

- Evaluate reusable project-neutral title-token facts.
- Intersect token candidates with project scope through a bounded access path.
- Represent updates/removals with versions or tombstones.
- Keep arbitrary substring search async or unavailable unless an n-gram design is
  physically benchmarked.

## Compaction And Retention Rules

An append design is incomplete without explicit bounds.

- Define a maximum active delta-segment count per component.
- Define maximum delta rows/bytes and merge-cost estimates before publication.
- Compact before a candidate snapshot would exceed read budgets.
- Write a new base, validate it, and atomically update the manifest.
- Protect active, last-known-good, and pinned versions.
- Delete obsolete versions in small bounded batches.
- Retain source/audit facts according to their own policy, not mart retention.
- Record watermarks proving when append deltas are safe to purge.
- Treat physical disk reclamation as a separate measured maintenance operation.

Example: allow at most two small status delta segments in a hot read. When a third
would be published, merge the base and deltas into a new base first.

## Failure And Replay Rules

- Source write plus append delta must be one transaction, or use a durable outbox
  that blocks dependent watermark advancement.
- Every fact, tombstone, contribution, segment, and publication must have a stable
  idempotency identity.
- Replaying one source range must not duplicate counts or posting membership.
- A failed segment remains inactive.
- Readers continue using the last-known-good manifest.
- Component watermarks advance atomically with their output.
- Reviewer actions use optimistic UI or a small scoped overlay until publication.
- Desktop sleep, restart, and interrupted compaction must resume safely.

## Investigation Plan

### Phase 0 - Use The Storage Shape Audit

- [ ] Complete `REVIEW_STORAGE_SHAPE_AUDIT_PLAN.md` far enough to know row
      ownership, route contracts, fan-out, and deletion candidates.
- [ ] Identify fields that are immutable facts versus current-state indexes.
- [ ] Identify the current widest and highest-fan-out writes.
- [ ] Choose representative project/import/judgment shapes for the benchmark.

### Phase 1 - Establish A Physical Baseline

- [ ] Use a disposable synthetic DuckDB fixture, not the live database.
- [ ] Record source write time, projection time, rows and bytes written, writer
      batches, WAL/temp usage, RSS, and final database size.
- [ ] Record warm and cold list/filter/count/detail p95 and p99.
- [ ] Record OOM splits, retries, compaction, retention, and restart behavior.
- [ ] Keep fixture, scale, seed, memory limit, model, provider, prompts, and content
      settings fixed.

### Phase 2 - Prototype The Cheapest Useful Append

- [ ] Append one compact global article/import fact batch.
- [ ] Append one project scope or selected-import component batch.
- [ ] Measure unindexed and required-index DuckDB append throughput separately.
- [ ] Compare one large `INSERT ... SELECT` with many small transactions.
- [ ] Verify idempotent replay and tombstones.

### Phase 3 - Prototype Current-State Options

- [ ] Prototype append facts plus a narrow current table.
- [ ] Prototype immutable component base plus bounded delta segments.
- [ ] Prototype wide row versions plus a current pointer as a comparison.
- [ ] Execute the same exact read contracts against every prototype.
- [ ] Reject any option that needs a project-scale latest-version window.

### Phase 4 - Exercise Real Change Patterns

- [ ] Empty project initial import.
- [ ] Incremental import into an already-ready project.
- [ ] Duplicate candidate that does not change the selected winner.
- [ ] Better candidate that changes selected import and filters.
- [ ] Large LLM judgment completion burst.
- [ ] Human judgment update and immediate read-your-write behavior.
- [ ] Import route shared by several projects.
- [ ] Prompt, model, content setting, and date-range change.
- [ ] Membership removal, hard/soft delete, archive, and unarchive.
- [ ] Crash between append and publication.
- [ ] Desktop sleep/restart during projection and compaction.

### Phase 5 - Choose Publication And Compaction Contracts

- [ ] Choose source-durable, review-ready, or two-status import completion.
- [ ] Set hard segment, delta-row, byte, RSS, and compaction thresholds.
- [ ] Define active, last-known-good, and pin retention.
- [ ] Define stale/indexing/unavailable behavior per route.
- [ ] Prove foreground readers remain bounded while compaction is pending.

### Phase 6 - Plan A Clear Cutover

- [ ] Build the chosen replacement state from authoritative sources or durable
      append facts.
- [ ] Compare route parity and objective row/count invariants.
- [ ] Atomically switch mounted routes to the new manifest/storage model.
- [ ] Stop old writers in the same coordinated cutover.
- [ ] Delete or rebuild obsolete internal state instead of keeping compatibility
      shims.
- [ ] Clean old rows only after active, last-known-good, and pinned readers are
      protected.

## Decision Gates

An append architecture should advance only if all of these pass on unchanged
benchmark settings:

- exact route parity for rows, order, filters, counts, cursors, and details
- no project-scale latest-version resolution in foreground SQL
- no OOM, fatal DuckDB restart, or foreground temp spill
- at least 30% lower target projection wall time or bytes written than the current
  physical baseline, enough to justify structural complexity
- no more than 5% regression in non-target warm route p95
- source-write p95 regresses by no more than 5% for source-durable completion, or
  meets a separately approved review-ready completion budget
- bounded segment count and successful compaction/restart evidence
- lower or explicitly justified steady-state storage after retention

Thresholds are benchmark-critical once the comparison starts. Do not relax them,
change scale, or skip workloads in the optimization change.

## Quality Gates For Later Implementation

- `bun run db:mig` for schema work.
- Targeted adjacent `bun test` suites for append idempotency, tombstones,
  contributions, manifests, compaction, retention, readers, and route parity.
- `bun run lint`.
- `bun run build` for shared API/client changes.
- Physical synthetic benchmark and before/after artifact comparison.
- Browser verification for LLM, Human, Both, Unassessed, detail, search, and bulk
  flows.
- Desktop build plus restart/resume verification.
- Explicit current-DB live progress gate only after synthetic safety passes.
- Add a short `OOM_ERRORS.md` entry for any OOM fix.

## Related Documents

- `REVIEW_STORAGE_SHAPE_AUDIT_PLAN.md`
- `plans/old/DUCK_OOM_FIX_PLAN.md`
- `plans/old/REVIEW_SERVING_REBUILD_SPEED_PLAN.md`
- `plans/old/REVIEW_REBUILD_WORK_FANOUT_PLAN.md`
- `plans/old/PERF_BENCH_PLAN.md`
- `DB_TERMS.md`
