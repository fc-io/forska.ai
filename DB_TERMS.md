# Database Terms For The DuckDB Serving Plan

This document explains database terms that matter for the long-term DuckDB
serving-index plan. It is written for someone who understands the product but
is newer to database architecture.

## Big Picture

The goal is to keep the app fast and reliable when projects contain millions
of articles and judgments.

The main idea is to stop product routes from doing expensive database work on
demand. Instead, writes append small facts about what changed, background
workers turn those facts into read-optimized tables, and product reads use
those tables directly.

## Terms

### Freshness Contract

What it means: A freshness contract defines what users see when indexed data
is current, stale, still indexing, failed, or missing.

Example: If an import is still being indexed, the review list can keep showing
the last completed generation and display progress instead of scanning raw
tables.

Why it improves things: It prevents emergency fallback queries. Product routes
can always make a predictable choice without guessing whether they should run
expensive raw reads.

Performance benefit: Avoids sudden full-project scans when an index is dirty
or missing.

Consistency benefit: Users get a clear state: fresh data, stale data with
progress, or indexing unavailable.

Pros: Predictable UX, simpler route logic, fewer OOM paths.

Cons: Users may briefly see stale data unless the UI also shows pending
progress or optimistic updates.

### Atomic Generation Manifest

What it means: A generation is a version of the serving data. A manifest is a
small control record saying which pieces of that generation are complete, such
as rows, payloads, counts, facets, and selected import data.

Example: Generation 42 should not become active until
`review_article_serving`, `review_article_count_serving`, and
`review_filter_facet_serving` are all complete for generation 42.

Why it improves things: It prevents routes from reading a mix of old and new
tables.

Performance benefit: Foreground reads can trust one active generation instead
of checking many raw tables.

Consistency benefit: Promotion is all-or-nothing. Users do not see counts from
one version and rows from another.

Pros: Stronger consistency, easier recovery, clear diagnostics.

Cons: More state to maintain, and a generation may wait longer before
promotion if one projection lags.

### Projector Dependency Graph

What it means: A projector is a background worker that turns raw changes into
serving tables. A dependency graph defines the order those projectors must run
in.

Example order: import deltas -> project dirty work -> selected import ->
review serving -> counts/facets/queues.

Why it improves things: It prevents later projections from building on
incomplete earlier projections.

Performance benefit: Workers can focus on the next useful bounded task instead
of repeating broad discovery queries.

Consistency benefit: Every serving table can state which source version it is
based on.

Pros: Easier scheduling, clearer failure handling, fewer mismatched
projections.

Cons: More orchestration complexity, and slow upstream projectors can delay
downstream views.

### Delta Semantics

What it means: A delta is a compact record saying something changed. Delta
semantics define the exact kinds of changes the system supports.

Examples: article imported, import record updated, import route membership
removed, judgment created, judgment deleted, human judgment changed, project
config changed.

Why it improves things: Background workers can update only affected rows
instead of rediscovering all project state from scratch.

Performance benefit: Converts large scans into small incremental updates.

Consistency benefit: Deletes and updates are handled explicitly instead of
being missed by append-only logic.

Pros: Efficient incremental indexing, clear audit trail, easier replay.

Cons: Requires careful design. Missing a change kind can create stale or
incorrect serving rows.

### Idempotency And Replay

What it means: Idempotent work can safely run more than once and end in the
same result. Replay means a projector can rerun old deltas to rebuild state.

Example: If a projector crashes halfway through delta 1000, rerunning delta
1000 should not create duplicate rows or double-count anything.

Why it improves things: Crashes, restarts, and desktop sleep become routine
recovery cases instead of data corruption risks.

Performance benefit: Workers can retry bounded batches instead of triggering
full rebuilds.

Consistency benefit: Repeated work produces the same serving state.

Pros: Safer recovery, simpler retries, easier backfills.

Cons: Requires stable keys, upserts, tombstones, and careful transaction
boundaries.

### Watermark Model

What it means: A watermark is a marker for how far a projector has processed
source changes.

Example: A selected-import projection might say it includes import deltas
through `delta_id = 123456`.

Why it improves things: The system can prove what each serving generation
includes.

Performance benefit: Projectors resume from the next unprocessed delta instead
of scanning the whole source.

Consistency benefit: Routes and diagnostics can detect whether rows, counts,
and facets were built from matching source ranges.

Pros: Clear progress tracking, reliable resume, easier debugging.

Cons: Watermarks must be advanced atomically with projector output or they can
lie.

### Read-Your-Write Strategy

What it means: This defines what a user sees immediately after they make a
change, before background projection catches up.

Example: After a reviewer marks an article, the UI can optimistically update
the row, write a small overlay, or wait for the projector to refresh the
serving row.

Why it improves things: It avoids user confusion when serving indexes are
intentionally stale for a short time.

Performance benefit: Lets product reads stay on serving tables without forcing
synchronous full refreshes.

Consistency benefit: Defines exactly where immediate changes appear and when
they become part of the durable serving generation.

Pros: Better UX, fewer emergency refreshes, clearer route behavior.

Cons: Optimistic UI or overlay tables add complexity and must be reconciled
with projected data.

### Count And Facet Cardinality Limits

What it means: Cardinality is the number of distinct values or combinations.
Counts and facets can explode if the system precomputes every possible filter
combination.

Example: Counting every combination of model, prompt answer, date range,
duplicate flag, conflict flag, and search term may create too many rows.

Why it improves things: The plan must decide which counts are precomputed,
which are approximate or nullable, and which require a different UX.

Performance benefit: Prevents count/facet tables from becoming larger and
slower than the raw data.

Consistency benefit: Users get honest count behavior instead of hidden slow
scans.

Pros: Bounded storage, bounded query time, clearer product tradeoffs.

Cons: Some arbitrary filter combinations may not have instant exact counts.

### Keyset Cursor Contract

What it means: Keyset pagination uses the last row's sort values as the
next-page cursor instead of asking the database to skip many rows with
`OFFSET`.

Example: Page 2 asks for rows after `(activity_sort_at, article_id)` from the
last row of page 1.

Why it improves things: Skipping one million rows with `OFFSET` is expensive.
Continuing from a known key is much cheaper and more stable.

Performance benefit: Large projects keep fast page navigation.

Consistency benefit: Stable sort keys reduce duplicated or missing rows while
data changes.

Pros: Fast at scale, works well with indexes, avoids large skips.

Cons: Jumping directly to page 500 is harder, and every list needs a stable
deterministic sort key.

### Storage Retention

What it means: Retention defines how long to keep old deltas, old serving
generations, payload rows, and debug state.

Example: Keep the active generation, the staging generation, and one
last-known-good generation. Clean older rows in small batches.

Why it improves things: Generationing improves consistency, but unlimited
generations will eventually waste disk and slow maintenance.

Performance benefit: Smaller tables and indexes stay faster.

Consistency benefit: Keeping one last-known-good generation allows rollback if
a new generation fails validation.

Pros: Bounded disk usage, simpler cleanup, safer rollback.

Cons: Aggressive retention can remove useful debugging history or replay
sources too soon.

### Consistency Checks

What it means: Consistency checks are cheap validations before making a
generation active.

Examples: expected row count, source watermark match, required projection
tables complete, selected-import row count plausible, count totals match
serving rows.

Why it improves things: Bad projections are caught before users see them.

Performance benefit: Cheap checks prevent expensive recovery after incorrect
data becomes active.

Consistency benefit: The active generation is promoted only after passing
objective gates.

Pros: Safer promotion, better diagnostics, fewer silent data bugs.

Cons: Checks can slow promotion and need careful tuning so they do not become
expensive full scans.

### Priority And Backpressure

What it means: Priority decides which background work runs first. Backpressure
slows or pauses work when the system is busy or low on memory.

Example: Small user-visible review updates should run before a huge backfill.
Batch sizes should shrink under a low DuckDB memory limit.

Why it improves things: The shared DuckDB runtime stays responsive during
imports and rebuilds.

Performance benefit: Prevents background jobs from monopolizing CPU, memory,
disk, or the DuckDB queue.

Consistency benefit: Bounded work makes partial progress predictable and
resumable.

Pros: Better interactivity, lower OOM risk, fairer scheduling.

Cons: Large backfills may take longer, and scheduling rules need monitoring.

### Failure Recovery

What it means: Failure recovery defines what happens when a projector,
rebuild, or refresh fails.

Example: Keep serving the previous generation, mark the new generation failed,
store the error, expose it in progress UI, and allow bounded retry.

Why it improves things: A failed background job should not force foreground
routes into raw fallback or blank screens.

Performance benefit: Avoids repeated unbounded retry storms.

Consistency benefit: Users keep seeing a known-good generation until a
replacement is complete.

Pros: Safer failures, clearer operator action, fewer user-facing outages.

Cons: Requires state machines, leases, retry limits, and visible diagnostics.

### Desktop Constraints

What it means: Desktop runs on a user's local machine, often with lower
memory, slower disk, sleep/restart interruptions, and no server-class
operations team.

Example: A laptop may sleep during a rebuild, then resume later with the same
DuckDB file.

Why it improves things: The serving architecture must assume interruptions and
limited memory are normal.

Performance benefit: Small resumable batches work on both high-end servers and
laptops.

Consistency benefit: Cursors, leases, and generation manifests prevent
half-finished desktop work from becoming active data.

Pros: More reliable desktop app, same architecture for web and desktop, lower
memory pressure.

Cons: More resumability requirements and stricter batch-size discipline.

## Most Important First

If the plan needs to be staged, add these first:

1. Freshness contract.
2. Atomic generation manifest.
3. Projector dependency graph.
4. Watermark model.
5. Read-your-write strategy.

These define the consistency model. After that, the performance work has a
safer foundation.
