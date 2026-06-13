# DuckDB Long-Term Serving Index Plan

## Problem

Import and materialization should be able to run at the same time. The observed OOM happens when foreground review reads issue maintenance-grade DuckDB queries while import and mart refresh already use the same constrained DuckDB runtime.

The failing query shape includes `selected_scoped_article_import`, which ranks scoped import rows with `ROW_NUMBER()` and JSON metadata sort keys. That is too expensive for interactive review-list requests during large imports.

The long-term requirement is larger than avoiding one OOM. Review, filter, badge, queue, and count reads must stay fast and predictable for projects with millions of articles and judgments on the shared browser/desktop DuckDB runtime.

## Strategy

Use an event-driven serving-index pipeline as the durable read architecture.

Raw `app.*` tables are the write/audit model. Import, judgment, human-review, and project-scope writes append compact deltas. Bounded projectors consume those deltas and maintain projection-identity-scoped, read-optimized serving snapshots. Product review routes read only completed serving snapshots.

The important shift is to avoid selected scoped import resolution, raw judgment aggregation, raw count computation, JSON extraction, and project-wide windows in product reads. Import writes stay cheap, projectors do bounded work, and review routes have no code path that can perform project-wide windows, raw total counts, raw fallback, or large JSON sorts.

This is a CQRS-style split:

- Write model: `app.article`, `app.article_import_route`, `app.judgment`, human judgment tables, and append-only delta ledgers.
- Projection model: bounded projectors with leases, cursors, high-water marks, and completed-snapshot promotion.
- Read model: compact `mart.*_serving` tables keyed by project, required projection identities, logical snapshot/base generation, filter state, and cursor sort keys.

This should land as one integrated implementation, not as a staged product
rollout. The schema, projectors, serving writers, route changes, UI states,
diagnostics, cleanup, and tests should be completed together before the normal
review path is cut over. After cutover, raw fallback is removed from normal
review reads.

Before the normal product path switches, the new pipeline should run through an
internal parity gate. This is not a staged user rollout: it builds serving
snapshots, executes sampled read contracts, compares rows/count states and cursor
behavior against semantic fixtures and safe-size current behavior, records
latency/query-shape metrics, and blocks cutover on invariant, parity, or budget
failures.

## Scale Target

The initial production-scale target is 10 million articles in one project, with
an average of 7 prompts per article. A fully judged project can therefore have
about 70 million prompt judgment facts per model/content configuration before
human judgments, import records, filter members, payload rows, and history.

Best-in-class for this app means product reads stay bounded by page size,
selected filter postings, or precomputed summary rows. A foreground request must
not scale with total project article count, total judgment count, total import
route rows, or total selected article IDs. Work that must touch project-scale
state belongs in bounded projectors, async search/count jobs, exports, or bulk
operation jobs with durable cursors.

At this scale, import, dirty materialization, serving refresh, review reads,
filter reads, count reads, bulk actions, exports, and desktop resume must be able
to overlap under the configured DuckDB memory limit without OOM. The correct
failure mode is stale data, unavailable exact count/search state, queued async
work, or a rejected over-budget request, never a raw foreground scan.

## Initial Budgets To Validate

These are starting pass/fail budgets for the integrated implementation. They can
be tuned only with benchmark evidence and an explicit plan update.

| Area | Starting Budget |
|---|---|
| Review list page size | Default 100 rows, hard max 200 rows. |
| Review list latency | p95 under 500 ms from a warm completed serving snapshot during overlap workload. |
| Count/facet latency | p95 under 100 ms for named product-critical precomputed count/facet keys. |
| Foreground DuckDB temp spill | Zero temp spill for hot review list/count/facet reads. Any spill is a benchmark failure. |
| Foreground result size | Hot review responses under 2 MiB; larger payloads require detail or export jobs. |
| Detail hydration | No list route hydrates large JSON/detail payloads; detail routes are keyed and capped. |
| Bulk job batch | Process at most 5,000 article IDs or 25 MiB of job payload per batch, whichever comes first. |
| Projector wake | Release work after 5 seconds or the configured row/batch limit, whichever comes first. |
| Synchronous substring search | Not admitted at 10M scale by default; return ready token/prefix state, search-indexing, unavailable, or async job state. |
| Over-budget foreground work | Reject, serve stale, or enqueue async work before DuckDB query execution. |

## Core Contracts

These contracts make the serving-index plan safe to operate instead of only faster:

- Freshness contract: every review response has an explicit state: fresh, stale, indexing, failed, or missing. Stale state returns the last completed snapshot plus progress; missing state returns indexing state and empty rows.
- Atomic snapshot manifest: a snapshot becomes active only after every required route component completes for the same composed identity set. Optional components such as async search or unsupported counts have their own availability state and do not block unrelated review-list activation.
- Component-scoped projector graph: each delta kind enters the graph at the first affected component declared by the invalidation registry. Selected-import projection is only on import/scope paths; judgment and human-review deltas do not wait for selected-import work.
- Serving writer ownership: one normal writer owns `mart.review_*` serving rows and snapshot promotion. Legacy refresh/rebuild services either call that writer as helpers, produce deltas/dirty work, or are retired; they do not independently write or promote review-serving snapshots.
- Delta semantics: deltas enumerate supported changes explicitly, including article import, import record update, route membership removal, LLM judgment create/update/delete, human judgment update, and project config change.
- Delta coalescing: append-only delta ledgers feed compact dirty-work state keyed by project/article or projection scope. Projectors consume coalesced dirty work and source high-water marks instead of repeatedly scanning large historical delta ranges.
- Transaction boundary: source writes and delta/outbox writes commit in the same DuckDB transaction. If a source mutation cannot share the transaction, it must use a durable outbox plus reconciliation scan before the projector can advance the affected watermark.
- Idempotency and replay: projector writes use stable generation-scoped keys, upserts, tombstones, and transactions so the same delta range can be retried or replayed without double-counting.
- Layered projection identity: every serving row carries only the invalidation keys it depends on. Identities are stable base generation plus component patch watermark/ranges, not one global generation per small update. Display, search, judgment-input content, project scope, prompt config, and review config identities advance independently.
- Logical snapshot model: a route `generation` means a logical serving snapshot, not a full project-row copy. Normal deltas create component-narrow patches and manifest updates; full base generations are reserved for rebuilds, large compactions, or structural config changes.
- Change dependency matrix: every delta `change_kind` maps to affected projection components, affected keys, first affected component, downstream dependents, and update mode: component patch, contribution diff, posting update, queue update, search update, compacted base rebuild, or unavailable/async.
- Watermark model: every projected table records the source high-water mark it includes, and watermarks advance atomically with the projector output they describe.
- Dirty-work acknowledgement: dirty keys are acknowledged per projection component using bounded range/high-water ack state. A slow optional component must not cause already-current required components to reprocess the same key.
- Read-your-write strategy: reviewer actions have an explicit immediate path, either optimistic UI state or a small overlay, until the durable serving snapshot catches up.
- Overlay scope: read-your-write overlays apply to affected row/detail UI and local action state. Counts, facets, queues, and bulk eligibility stay snapshot-scoped unless a route explicitly supports overlay-aware semantics.
- Count and facet cardinality limits: only named product-critical count/facet shapes are precomputed; unsupported exact counts are nullable or surfaced as unavailable instead of scanning raw tables.
- Incremental summary contract: counts, facets, badges, and posting cardinalities update from old/new per-article contribution rows or deterministic contribution diffs. They do not reaggregate all serving rows for routine article, judgment, or human-review changes.
- Consistency checks: snapshot promotion runs cheap objective checks before activation, including row-count plausibility, required table completeness, source watermark match, and count totals matching serving rows.
- Priority and backpressure: projector work is scheduled by user-visible priority and constrained by memory, queue pressure, active import state, wake budget, and batch limits.
- Failure recovery: failed snapshots stay inactive, preserve the last known-good snapshot, expose the failure state, and allow bounded retry without raw foreground fallback.
- Desktop constraints: the same architecture must tolerate laptop memory limits, slower disks, sleep/restart interruptions, and resumable background work.
- Physical read-path contract: every hot route declares its serving table, required columns, filter keys, sort key, cursor shape, and index/access path. Hot reads use projected typed columns and config/snapshot-scoped keys, not runtime JSON extraction or selected-import joins.
- Filter access contract: every synchronous filter combination is allowlisted with a bounded physical access strategy: ordered prefix, posting/projection table, small candidate set, or unavailable/async. A serving-only predicate is not enough if it scans project-scale rows.
- Cursor contract: every cursor includes generation, sort key values, page direction, and a filter signature. If the generation or filter signature changes, the route returns a fresh first page or a cursor-invalid state instead of mixing generations.
- Snapshot pinning contract: durable jobs and long-lived cursors that require repeatable results acquire snapshot pins. Cleanup cannot delete pinned base rows, patches, payloads, counts, facets, or search state until the pin expires or is released.
- Rebuild chunk contract: long rebuilds use chunk manifests with incrementally maintained input watermarks/digests and output status. Rebuild workers skip unchanged completed chunks and resume failed/interrupted chunks instead of rerunning the full phase or rescanning source rows just to decide skip eligibility.
- Bulk-operation contract: select-all, add-to-project, PDF fetch, export, and similar actions operate through persisted selection jobs or cursor-batched server jobs. They never return or allocate all matching article IDs in one request.
- Search contract: synchronous ready search supports declared token/prefix semantics from compact search projections. Arbitrary substring/contains search over million-scale projects is async-only or unavailable unless a benchmarked n-gram projection is explicitly added.
- Specific-count contract: only named product-critical counts are synchronous and fast. Unsupported filter/search combinations return nullable/unavailable counts or start async count work; they never trigger raw aggregation.
- Workload admission contract: every normal foreground DuckDB request comes from a registered read/job contract with a workload class, result-size budget, row budget, memory/temp budget, and timeout. Ad hoc SQL estimation is not a safety boundary; unregistered foreground work is rejected before query execution.
- Result-size contract: API responses have maximum page size, row count, payload bytes, and hydrated-detail budgets. Detail payloads and ID lists are paged or job-backed, not embedded in hot list responses.
- Internal parity contract: internal parity reads compare semantic fixtures, sampled safe-size parity, invariants, freshness states, cursors, SQL shape, latency, and result-size behavior before cutover. Any mismatch, forbidden SQL shape, or budget breach blocks normal-route switching.

## Success Criteria

- [ ] Import, dirty materialization, and review-index refresh can overlap without review-list OOMs.
- [ ] A benchmark fixture with 10 million articles and an average of 7 prompts per article passes without OOM under the target DuckDB memory limits.
- [ ] Review lists remain readable during materialization by using the last completed serving snapshot.
- [ ] Review responses expose freshness state: fresh, stale, indexing, failed, or missing.
- [ ] Foreground API reads never run unbounded raw/import-route scans.
- [ ] Foreground review routes never execute project-wide windows, raw total counts, or JSON sorts.
- [ ] LLM, human, both, unassessed, filter, count, badge, bulk-action, PDF, and export flows are all covered by the same serving/cursor/job architecture.
- [ ] Import writes append deltas cheaply and do not synchronously fan out selected-import state to every affected project.
- [ ] Source writes and delta/outbox writes commit atomically, or reconciliation blocks watermark advancement until missing deltas are recovered.
- [ ] Delta ledgers cover article/import creates, updates, deletes, route membership changes, LLM judgments, human judgments, and project config changes explicitly.
- [ ] Selected scoped import state is maintained by bounded projectors with generation/checkpoint semantics.
- [ ] Serving snapshots use layered projection identity with stable base generations plus component patch watermarks/ranges, so small updates do not globally invalidate unchanged rows.
- [ ] Project model/content/prompt changes invalidate only dependent judgment-derived rows, cursors, counts, queues, and jobs, not config-independent display/import/title/payload/search projections.
- [ ] Every delta kind has an explicit affected-component matrix with affected keys and update mode.
- [ ] Projector execution starts at the first affected component for each delta kind and does not force unrelated upstream components to run.
- [ ] Prompt config changes reuse unchanged prompt outputs and rebuild only affected prompt-derived rows, contributions, counts, queues, and facets.
- [ ] Article display, search, and judgment-input content identities are separate so display-only edits do not rerun search or judgments, and search-only edits do not rerun judgments.
- [ ] Projector dependencies and source watermarks are explicit and durable.
- [ ] Dirty-work completion is tracked per projection component so already-current components do not rerun because another component is still lagging.
- [ ] Projector output is idempotent and replayable from stored watermarks.
- [ ] Serving snapshot promotion is atomic and gated by manifests plus consistency checks.
- [ ] Routine reviewer/import deltas do not full-copy 10 million serving rows; they promote bounded patches or compacted base generations by policy.
- [ ] Routine patches are component-narrow; judgment-only changes do not rewrite display, import, payload, or search fields.
- [ ] Serving manifests distinguish route-required projection components from optional async/search/count components.
- [ ] Exactly one normal serving writer owns `mart.review_*` writes and active snapshot promotion.
- [ ] Review list, count, facet, badge, and unassessed-queue reads use serving indexes only.
- [ ] Hot serving rows contain typed columns for sort, filters, badges, and selected import fields.
- [ ] Hot serving tables use physical layouts that keep product reads bounded by ordered generation/filter prefixes, typed columns, and compact projection-specific rows.
- [ ] Named product-critical counts and facets are precomputed or nullable; they are never computed from raw tables in request paths.
- [ ] Counts, facets, badges, and posting cardinalities update from per-article old/new contribution diffs instead of full reaggregation for routine changes.
- [ ] Count and facet projections document the specific fast count keys, cardinality limits, and unavailable states.
- [ ] Large JSON/detail payloads are kept out of hot list/filter serving rows.
- [ ] Read-your-write behavior is explicit for reviewer actions while serving projection catches up.
- [ ] Product list routes use keyset pagination and never require `OFFSET` over large scopes.
- [ ] Every synchronous filter combination has a bounded physical access path or returns unavailable/async state.
- [ ] Filter posting selectivity/cardinality stats are maintained incrementally and used to pick bounded leading access paths.
- [ ] Cursors include generation and filter signatures so pagination cannot mix generations or filter states.
- [ ] Bulk actions and exports never materialize all matching article IDs or payloads in memory.
- [ ] Durable bulk/export/PDF/search jobs pin the serving snapshot they read or explicitly declare latest-generation semantics.
- [ ] Delta ledgers are coalesced into bounded dirty-work queues and retained/compacted after all consumers pass the relevant watermarks.
- [ ] Long rebuilds use chunk manifests and skip unchanged completed chunks after crash, resume, or repeated runs.
- [ ] Chunk skip decisions use incrementally maintained input digests/watermarks, not source-row rescans.
- [ ] Dirty-work acknowledgements are compacted as component high-water rows or compressed ranges so ack state stays bounded.
- [ ] Token/prefix title search is served by projected search state, while arbitrary substring title search is async/unavailable unless a benchmarked n-gram projection is explicitly added.
- [ ] Foreground DuckDB admission rejects or serves stale for over-budget queries before execution.
- [ ] Foreground DuckDB admission accepts only registered read/job contracts for normal product work.
- [ ] API page size, response bytes, and hydrated-detail payloads are capped for every review route.
- [ ] DuckDB settings are not silently retried, downgraded, or mutated after failures.
- [ ] Failed snapshots preserve the last known-good snapshot and never trigger raw foreground fallback.
- [ ] Browser and desktop flows use the same bounded, resumable serving path.
- [ ] Internal parity validation passes semantic fixture, sampled parity, cursor, freshness-state, SQL-shape, and latency checks before normal-route cutover.
- [ ] Read-your-write overlay semantics are route-specific and do not silently mutate snapshot-scoped counts, facets, queues, or bulk eligibility.
- [ ] OOM logs include enough state to identify route, project, workload class, active snapshot/identity set, and raw/serving mode.

## Target Read Shape

Foreground judgment-derived review-list routes should follow this shape:

```sql
SELECT ...
FROM mart.review_article_serving
WHERE project_id = ?
  AND review_config_hash = ?
  AND generation = ?
  AND list_mode_key = ?
  AND <projected_filter_predicates>
  AND (activity_sort_at, article_id) < (?, ?)
ORDER BY activity_sort_at DESC, article_id ASC
LIMIT ?
```

Judgment-derived counts and facets should follow this shape:

```sql
SELECT count_value
FROM mart.review_article_count_serving
WHERE project_id = ?
  AND review_config_hash = ?
  AND generation = ?
  AND count_kind = ?
  AND filter_key = ?
```

The exact `list_mode_key` and projected filter predicates can vary by serving
contract, but each hot read must be backed by projected typed columns and an
explicit access path. No raw fallback. No `ROW_NUMBER()`. No JSON extraction. No
raw total count. No `OFFSET` over large projects.

Here, `generation` is a logical serving snapshot ID. It can refer to a compacted
base generation plus bounded patch watermarks; it must not imply a full 10M-row
copy for every routine delta.

If the active snapshot includes patches, the SQL builder may read bounded
component patch tables plus the compacted base with anti-joins only for the
patched/tombstoned component keys it needs. That patch path is admitted only
while the patch footprint is below the registered hot-read budgets. Large delta
sets must produce a new compacted base before they become the active product-read
snapshot.

Every hot read shape must declare:

- Primary table or compact summary table.
- Projection identity inputs, including `review_config_hash` only when the read depends on judgment configuration.
- Required projected columns.
- Sort key and keyset cursor columns.
- Filter keys that are allowed synchronously.
- Physical access strategy for each allowed synchronous filter combination.
- Which named counts are fast, and whether other count shapes return stale, nullable, unavailable, or async counts.
- Maximum page size, result row count, response bytes, and detail hydration budget.
- Workload class and admission budget.

Review cursors must encode the projection identities used by the route,
generation/snapshot ID, filter signature, sort direction, sort values, and
article ID. A cursor from one generation, identity set, or filter signature must
not page through a different generation, identity set, or filter state.

## Snapshot And Generation Model

The long-term design should avoid full project-row copies for routine updates.
A serving snapshot is a logical read contract that points to compact physical
state.

- Major base generation: a full, sorted, compact base for one project and the narrow projection identity it depends on. Build it for first indexing, schema/layout changes, structural project-scope changes, and patch compaction.
- Minor snapshot: a manifest update over the current base plus bounded component patch rows and tombstones for article display, selected import, LLM status, human status, queue, posting, and review-action changes.
- Patch tables: store only changed component fields/tombstones since the base generation, keyed by project, component identity, snapshot/patch watermark, list mode, article, and sort/filter keys. A judgment-only patch does not rewrite article display, selected import, payload, or search fields.
- Promotion: a minor snapshot promotes only after patches, counts affected by the patch, overlays, and required watermarks are transactionally consistent, and the patch footprint stays under every registered hot-read budget.
- Compaction: when a candidate patch would exceed the hot-read budget, storage budget, or configured ratio of the base, build a new major base generation before activation. If an already-active patch grows past a warning threshold, schedule compaction before it can breach the hard budget.
- Cursor behavior: ordinary interactive cursors may be invalidated when the active snapshot changes. Durable jobs that need repeatable results pin the snapshot instead of relying on long-lived interactive cursors.
- Cleanup: old base generations, patches, payloads, counts, facets, and search state are deleted only when no active manifest, last-known-good manifest, or snapshot pin references them.
- Large imports: append new or changed import rows as patches/partitions first. They become a full base rebuild only when read budgets, patch merge cost, or storage compaction thresholds require it.

Starting compaction thresholds should be validated by benchmark, but a safe
initial policy is to compact when patches exceed 100,000 rows, 1% of active
project rows, max anti-join keys, max skipped base rows for top-page reads, or
any hot-read row-scan/temp-spill budget.

## Projection Identity And Invalidation

Avoid using one broad version key for all serving state. Rebuilding should happen
only for components whose inputs changed.

- Article display identity: changes when title display, dates, metadata fields, payload pointers, source URL, source kind, or other article/import-display fields change. Display-only changes do not invalidate judgments.
- Search identity: changes when searchable title/text tokens change. Search-only changes do not invalidate display payloads or judgments unless the same source field also participates in judgment input.
- Judgment input content identity: changes when title, abstract, fulltext, or no-image fulltext content used by a project's judgment settings changes. It invalidates only affected article/config/prompt judgment-derived facts and summaries.
- Project scope identity: changes when project membership, import route membership, selected import ranking inputs, or source-record rank/filter fields change.
- Prompt config identity: changes per prompt when prompt text, answer schema, thresholding, or prompt-specific settings change. A single prompt change does not invalidate other prompts.
- Review config identity: composes model/content settings and prompt config identities only for the prompts/routes that need them.
- Count/facet identity: combines the specific summary definition with the narrow upstream identities it needs.

The reader composes these identities from the active manifest. For example, an
LLM review row can depend on article display identity, project scope identity,
judgment input content identity, one prompt config identity, and model/content
settings, while a title-search row depends only on search identity plus project
scope identity.

Every delta kind must map to a bounded set of affected components:

| Delta Kind | Affected Components | Efficient Update Mode |
|---|---|---|
| Article display metadata change | Article payload, hot row display fields, affected display/filter postings. | Patch changed display fields, update display postings, and apply contribution diffs for changed display-derived filter keys only. |
| Searchable title/text token change | Title/search projection and search posting stats. | Patch search rows and search stats for the article only. Do not rebuild judgment-derived rows unless the changed field is also judgment input. |
| Judgment input content change | Affected article/config/prompt judgment-derived rows, counts, badges, queues. | Invalidate or recompute only affected article/prompt/config facts and apply old/new contribution diffs. |
| Import route membership add/remove | Project scope, selected import, hot rows, counts/facets, queues, bulk eligibility. | Mark affected project/article dirty, patch/tombstone changed rows, apply old/new count and posting contributions. |
| Import rank/source-record field change | Selected import, hot display fields, duplicate/conflict filters, affected counts/facets. | Recompute selected import only for affected project/article keys and apply contribution diffs. |
| LLM judgment create/update/delete | Judgment-derived hot status, counts, badges, queues, review config-specific rows. | Recompute affected article/prompt contribution rows and apply `-old +new` diffs. |
| Human judgment update | Human/both hot status, counts, badges, queues. | Recompute affected article/prompt human contribution rows and apply `-old +new` diffs. |
| Prompt config change | Prompt config identity and only rows/counts/queues/facets that depend on that prompt. | Create a new prompt identity, reuse unchanged prompt outputs, and rebuild/apply contribution diffs only for affected prompt keys. |
| Model/content settings change | Review config identity and judgment-derived rows/counts/queues for affected prompts/content settings. | Create a new review config identity for affected routes and reuse article/display/search/payload projections. |
| Project membership bulk change | Project scope, selected import, hot rows, counts/facets, queues, bulk eligibility. | Process membership changes in keyset batches, patch/tombstone affected rows, compact only when patch budgets require it. |

Projectors should read this dependency matrix from code, not duplicate it in
worker-specific conditionals. A delta that lacks a dependency mapping is a failed
write or a quarantined dirty-work item, not a reason to rebuild every projection.

The projector scheduler should enqueue only the first affected component and its
declared downstream dependents. Examples:

- LLM judgment update starts at judgment-status/contribution components, then updates dependent counts, badges, queues, and postings. It does not run selected-import or display projectors.
- Article display-only update starts at display/payload/posting components. It does not run judgment-status or prompt summary projectors.
- Search-token update starts at search projection and search stats only. It does not run review-row compaction unless a route contract explicitly embeds search fields in hot rows.
- Prompt config change starts at that prompt's config identity and dependent prompt summaries. It does not rebuild unchanged prompt outputs.

## Filter Access Strategy

Serving-only SQL is not automatically safe. A predicate over
`mart.review_article_serving` can still scan millions of rows if it is not tied
to the physical layout.

Every synchronous filter combination in `reviewServingReadContracts.ts` must use
one of these strategies:

- Ordered-prefix read: the filter is part of the table order/prefix for that route and list mode.
- Posting/projection table: start from a compact table keyed by project, required projection identities, generation, filter kind/value, list mode, sort key, and article ID.
- Bounded candidate set: a prior contract step proves the candidate set is under the route row/result budget before hydration.
- Async/unavailable: the combination is not admitted synchronously and returns unavailable state or creates a durable job.

Multi-filter reads must start from the most selective bounded posting/projection
available. If no bounded leading access path exists, the route must not issue a
foreground DuckDB query for that filter combination.

The most selective posting must come from maintained stats, not runtime scans.
Each posting/projection table should have incrementally updated cardinality rows
keyed by project, projection identity, generation, filter kind/value, and list
mode. Admission uses those stats to reject combinations whose leading candidate
set cannot fit route budgets.

Patch reads also need merge-cost budgets, not only patch-row budgets. Each hot
route should declare maximum patch rows, anti-join keys, skipped base rows,
merged candidate rows, and patch/base input bytes. A small patch that tombstones
or reorders many top-ranked rows must trigger compaction before it can degrade
first-page latency.

## Physical DuckDB Layout

The serving design depends on columnar layout, not only query syntax. Hot tables
should be written so DuckDB can prune and stream bounded row groups instead of
discovering candidates through project-scale scans.

- Write hot serving rows ordered by the dominant read prefixes, such as `project_id`, required projection identities, optional `review_config_hash`, `generation`, `list_mode_key`, projected filter bucket, descending sort key, and `article_id`.
- Keep hot rows narrow and typed: IDs, timestamps, booleans, small enums, numeric sort keys, compact text needed by list UI, and precomputed membership/filter keys.
- Keep arrays, large text, raw metadata, source JSON, prompt payloads, and derived detail blobs out of hot rows. Store them in keyed payload/detail tables or export-job payload paths.
- Use projection-specific tables for high-cardinality or specialized access, such as title-search tokens, unassessed queue ordering, count/facet summaries, and bulk selection cursors.
- Avoid one universal wide table if a route would need to scan many irrelevant columns or rows. Add a compact projection when it makes the hot path bounded and easy to test.
- Treat DuckDB indexes as optional acceleration. Correctness and OOM safety must come from generation/filter prefixes, sorted writes, keyset cursors, result caps, and workload admission.
- Rebuild or compact serving projections in bounded batches that preserve the target physical order for the next completed snapshot.
- Benchmark row-group pruning, rows scanned, temp spill, and response bytes for every registered hot read; a syntactically valid serving query still fails if it scans project-scale rows.

## Chunked Rebuild And Resume

Rebuilds and compactions should avoid rerunning unchanged work. Every long
projector phase should be split into deterministic chunks.

- Chunk manifests are keyed by project, component, projection identity, incrementally maintained input watermark/digest, chunk key range, output generation, status, and error.
- A rebuild worker claims chunks independently, writes output for that chunk, validates chunk-level counts/checksums, and marks the chunk complete in the same transaction as output promotion for that chunk.
- On crash, sleep, or restart, workers skip completed chunks whose input watermark/hash still matches and retry only failed or missing chunks.
- If an upstream input hash changes for a chunk, invalidate only that chunk and dependent chunks, not the whole rebuild.
- Input digests come from upstream dirty tokens, contribution digests, posting stats, and per-chunk high-water rows maintained during normal projection. A rebuild worker must not scan source rows only to decide whether a completed chunk can be skipped.
- Final snapshot promotion verifies that every required chunk for that component is complete and matches the manifest input identity.
- Chunk size is budgeted by rows, bytes, and expected temp usage so desktop resume and low-memory runs do not have to rerun large phases.

## Count Semantics

Only specific product-critical counts need to be fast. An arbitrary exact count
means an exact matching-row count for any user-selected combination of list
mode, prompt answers, date filters, duplicate/conflict flags, search text, and
future filters. At 10 million articles and about 70 million prompt judgment
facts, computing those counts on demand can require a large aggregation, and
precomputing every possible combination can create a cardinality explosion.

The product contract should distinguish these cases:

- Fast exact count: available only for named product-critical precomputed count keys.
- Stale exact count: returned from the last completed snapshot when refresh is in progress.
- Unavailable count: returned when the filter/search shape is not precomputed.
- Async count: optional background work for expensive exact counts that are useful enough to compute outside the request path.

Unsupported count shapes must not fall back to raw `COUNT(*)`, raw prompt-answer
aggregation, or selected-import scans in foreground requests.

## Incremental Summary Updates

Counts, facets, badges, queues, and posting statistics should update from
contribution diffs. They should not re-run project-wide aggregations for routine
article, import, judgment, or human-review changes.

- Store previous per-article contribution rows for each named count/facet/badge/posting definition that is updated incrementally.
- For each dirty article, compute the new contribution set from projected typed fields and judgment facts scoped by `review_config_hash` only when needed.
- Apply `-old +new` deltas to summary tables in one transaction with the updated contribution rows and projector watermark.
- If contribution state is missing, corrupted, or from an incompatible definition version, enqueue a bounded repair for that component instead of falling back to a full foreground aggregation.
- Summary definition changes create a new summary definition version and rebuild only that summary component in chunks.
- Posting cardinality stats are summary rows too. They update from the same contribution diff path and let readers choose the most selective bounded posting without scanning.

Proposed contribution keys should include project, narrow projection identity,
optional review config hash, article ID, component kind, summary definition
version, and contribution key. Values should be small signed integers so deletes,
answer changes, and route removals can retract old contributions exactly.

## Search Semantics

Search should be explicit about user-visible behavior and physical cost.

- Synchronous ready search supports normalized token and prefix semantics from compact projected search rows.
- Arbitrary substring/contains search is not synchronous at 10M scale by default. It returns unavailable/search-indexing or creates a bounded async job.
- If exact substring search becomes product-critical, add a benchmarked n-gram/trigram projection with documented storage growth, query shape, and compaction rules before admitting it synchronously.
- Async search jobs operate over projected compact title/search state in keyset batches. They do not scan raw `app.article` titles or store one unbounded article-ID array.
- UI and API labels must distinguish token/prefix search from exact contains search so a performance-motivated semantic change is not hidden.

## Read-Your-Write Overlay Scope

Read-your-write behavior should improve reviewer feedback without making every
count, facet, queue, and bulk route recompute synchronously.

- Row/detail routes may merge a small overlay for the affected reviewer action and article.
- Count, facet, badge, and queue routes remain snapshot-scoped unless their contract explicitly declares overlay-aware behavior.
- Bulk, export, PDF, and search jobs read a pinned or declared-latest serving snapshot and do not silently include unprojected overlay state.
- Responses that combine active-snapshot data with pending reviewer changes should expose `overlayPending` or equivalent state.
- Overlay rows expire or reconcile after the durable serving snapshot includes the change, keyed by project, config hash, article, judgment/human-judgment key, and source watermark.

## Serving Logic Architecture

The new logic should not live in route handlers or continue growing the existing
`duckdbOlap.ts` monolith. Routes should express product intent. Shared serving
modules should own contracts, admission, cursor semantics, SQL shape, and job
state. Low-level DuckDB helpers should own execution, queueing, metrics, and
workload-class enforcement.

| Location | Owns | Rules |
|---|---|---|
| `src/server/reviewServing/reviewServingContracts.ts` | Shared types for freshness state, count state, search state, workload class, cursor payloads, filter signatures, route budgets, projection identity keys, snapshot IDs, and named count keys. | Pure TypeScript only. No database calls. This is the source of truth for route states and budget names. |
| `src/server/reviewServing/reviewProjectionIdentity.ts` | Builds narrow display, search, judgment input content, project-scope, per-prompt config, summary, and review-config identity hashes. | Identity builders are pure and deterministic. Do not use one broad config hash for config-independent projections or unchanged prompts. |
| `src/server/reviewServing/reviewServingInvalidationRegistry.ts` | Change-kind to affected-component matrix. | Every delta kind declares first affected component, downstream dependents, affected keys, and update mode. Unmapped deltas are quarantined or fail tests. |
| `src/server/reviewServing/reviewServingReadContracts.ts` | Registry of every hot product read: LLM, human, both, unassessed, filters, facets, badges, counts, rows, queues, PDF/export selection, and bulk selection. | Each contract declares allowed filters, named fast counts, serving table, physical filter access strategy, sort key, cursor fields, result-size caps, and DuckDB workload class. This registry is the normal foreground admission source. |
| `src/server/reviewServing/reviewServingCursor.ts` | Encoding, decoding, validation, and invalidation of projection-identity/generation/filter-scoped cursors. | Cursor payloads include the projection identities used by the route, snapshot ID, filter signature, sort direction, sort values, and article ID. Routes do not hand-roll cursors. |
| `src/server/reviewServing/reviewServingAdmission.ts` | Foreground query admission before DuckDB execution. | Admits only registered read/job contracts for normal product work. Validates workload class, page limit, result-size budget, stale-allowed behavior, temp-spill policy, and search/count availability before SQL runs. |
| `src/server/reviewServing/reviewServingReader.ts` | Product-facing serving reads for list/count/filter/facet/badge/queue/detail entrypoints. | Routes call this module instead of `duckdbOlap.ts`. It returns freshness/count/search states and never chooses raw fallback. |
| `src/server/reviewServing/reviewServingSql.ts` or sibling `reviewServingSql/` files | Small SQL builders for serving reads only. | Builders are pure, contract-driven, and tested for forbidden patterns. No route-specific string concatenation outside this layer. |
| `src/server/reviewServing/reviewServingManifestRepository.ts` | Active/candidate/failed generation manifests, consistency check results, last known-good generation, and promotion state. | Manifest reads are cheap keyed lookups. Promotion is transactional and all-or-nothing. |
| `src/server/reviewServing/reviewServingSnapshotPinRepository.ts` | Snapshot pins for durable jobs and any cursor/session that needs repeatable reads. | Cleanup must consult pins before deleting base generations, patches, payloads, counts, facets, queues, or search rows. |
| `src/server/reviewServing/reviewServingDeltaLedger.ts` | Append APIs for import, LLM judgment, human judgment, prompt/config, and project-scope deltas. | Write paths append compact deltas transactionally with source changes. Large payloads stay out of delta rows. |
| `src/server/reviewServing/reviewServingDirtyWorkService.ts` | Coalesced dirty-work state from append-only deltas to project/article or projection scopes. | Collapses repeated changes, tracks source high-water marks, and records component-level acknowledgements so current components do not reprocess lagging dirty keys. |
| `src/server/reviewServing/reviewServingContributionService.ts` | Old/new contribution rows and summary deltas for counts, facets, badges, queues, postings, and stats. | Applies `-old +new` changes transactionally with contribution rows and watermarks. No project-wide summary reaggregation for routine changes. |
| `src/server/reviewServing/reviewServingChunkManifestRepository.ts` | Chunk manifests for rebuilds, compactions, and repair jobs. | Tracks input watermark/hash, chunk key range, output status, checksums, and resume/skip behavior. |
| `src/server/reviewServing/reviewServingProjectorService.ts` | Projector dependency graph, watermarks, leases, idempotent replay, selected-import projection, serving-row projection, contribution projection, single serving-writer ownership, and cleanup. | Runs only bounded batches. Advances component watermarks and dirty-work acknowledgements in the same transaction as output. This is the only normal owner of `mart.review_*` writes and active-snapshot promotion. |
| `src/server/workers/reviewServingProjectorWorker.ts` | Scheduling bounded projector wakes. | Coordinates with existing mart refresh/dirty materialization workers and releases claims on wake budgets. It does not bypass `reviewServingProjectorService` to write serving rows or promote snapshots. |
| `src/server/reviewServing/reviewBulkOperationService.ts` | Select-all, add-to-project, PDF fetch, and export selection jobs. | Stores criteria, required projection identities, generation, cursor, and progress, then acquires snapshot pins when repeatable results are required. Processes keyset batches. Does not materialize all IDs in memory. |
| `src/server/workers/reviewBulkOperationWorker.ts` | Executes durable bulk jobs. | Uses batch budgets, cancellation, retry, progress state, and result manifests. |
| `src/server/reviewServing/reviewSearchService.ts` | Ready token/prefix search state and async substring search jobs. | Synchronous substring scans are not admitted unless a benchmarked n-gram projection is added. Missing search state returns search-indexing/unavailable or creates bounded async work over projected/searchable state, not raw title scans. |
| `src/server/reviewServing/reviewServingDiagnostics.ts` | OOM/workload diagnostics for route, project, workload class, active snapshot/identity set, queue state, memory limit, temp usage, and raw/serving mode. | Logging shape is shared by foreground reads, projectors, bulk jobs, search jobs, and benchmarks. |
| `src/server/utils/duckdbService.ts` | Low-level DuckDB execution, queues, memory/runtime metrics, owner behavior, and workload class enforcement hooks. | No product semantics. It enforces budgets supplied by serving/admission layers and records metrics for every DuckDB request. Normal product work must arrive classified from registered contracts. |
| `src/services/olap/*` | Temporary compatibility wrappers during internal cutover work. | Wrappers delegate to `reviewServingReader` or job services. After internal parity validation and hard cutover, raw review fallback logic is deleted rather than preserved. |

Route handlers should not call `runDuckdbJsonQuery`, build DuckDB SQL, decode
review cursors, compute filter signatures, or decide raw fallback. Route handlers
should validate request bodies, call the appropriate serving reader/job service,
and return the contract state to the client.

The serving projector service is the single normal write boundary for review
serving rows and snapshot promotion. Existing mart refresh, dirty
materialization, and large rebuild services may schedule work, produce deltas,
or provide implementation helpers behind that service, but they must not become
parallel writers with separate promotion rules.

Schema objects and persisted state stay in DuckDB migrations under
`src/db/duckdbMigrations/`. Runtime orchestration stays in server services and
workers. Client UI state for freshness/search/count/bulk progress stays near the
reviews UI and should consume server states directly instead of re-inferring
indexing state from missing rows.

## DuckDB Usage Migration Inventory

Every entry below must either move behind the new serving/admission/job logic or
be explicitly classified as admin/maintenance/debug-only before cutover.

| Area | Current DuckDB Use | New Logic Required |
|---|---|---|
| Low-level DuckDB execution | `src/server/utils/duckdbService.ts`, `src/services/olap/duckdbRunner.ts`, `src/server/services/readOnlyDuckdbService.ts`, `src/server/services/appDatabaseService.ts`, `src/server/services/appReadOnlyDatabaseService.ts` | Add workload classes, registry-based admission hooks, metrics, result-size accounting, temp-spill diagnostics, and foreground/background/bulk/projector classification. |
| Review OLAP monolith | `src/services/olap/duckdbOlap.ts` exported reads: `queryArticlesReviewsFromDuckdb`, `countArticlesReviewsFromDuckdb`, `queryArticlesReviewsBothFromDuckdb`, `getDatabaseBasedFiltersFromDuckdb`, `getNumericFiltersFromDuckdb`, `getUnassessedCountFromDuckdb`, `getUnassessedArticlesFromDuckdb`, `getUnassessedPairsFromDuckdb`, `selectArticleIdsByFilterDuckdb` | Replace with contract-driven `reviewServingReader`, search service, count/facet serving reads, queue serving reads, and bulk job creation. Delete raw fallback paths. |
| OLAP wrapper modules | `articlesReviewsOlap.ts`, `articlesReviewsBothOlap.ts`, `articlesReviewsFiltersOlap.ts`, `unassessedArticlesOlap.ts`, `selectArticleIdsOlap.ts` | Become thin delegates to `reviewServingReader` or durable job services. They must not expose all-ID arrays for large filters. |
| LLM review routes | `projectsRoutesGetArticlesReviews.ts`, `projectsRoutesGetArticlesReviewsCount.ts` | Use serving reader contracts, review config hash, keyset cursors, named count states, bounded filter access, route result caps, and foreground admission. |
| Both review routes | `projectsRoutesGetArticlesReviewsBoth.ts` and both-list logic in `duckdbOlap.ts` | Use serving-only both-mode rows and counts. No in-memory intersection of LLM/human article sets. |
| Human review routes | `projectsRoutesGetArticlesReviewsHuman.ts`, `projectsRoutesGetArticlesReviewsHumanFilters.ts` | Move to serving-only human rows, human prompt/facet projections, keyset cursors, and named fast counts. No raw `app.judgment_human*` candidate ID materialization. |
| Unassessed and queue routes | `projectsRoutesGetArticlesReviewsUnassessed.ts`, `JudgmentsJobsRoutes.ts`, `judgmentsJobsCronGetPrompts.ts` | Use `mart.review_unassessed_queue_serving` or equivalent queue projection, generation/filter cursors, and serving count states. No raw fallback windows in foreground/job API paths. |
| Filter/facet routes | `projectsRoutesGetArticlesReviewsFilters.ts`, `projectsRoutesGetArticlesReviewsHumanFilters.ts`, `getDatabaseBasedFiltersFromDuckdb`, `getNumericFiltersFromDuckdb` | Use precomputed facet tables, filter posting/projection tables, and count/facet availability states. No foreground `GROUP BY` over raw judgments, prompt facts, scoped import CTEs, or unbounded serving-table predicates. |
| Detail/hydration routes | `projectsRoutesPostArticleReviewDetails.ts`, `ArticlesRoutes.ts` detail reads, `appQueryServiceCore.ts` article hydration helpers | Use keyed serving payload/detail reads with payload budgets. Do not hydrate large metadata from list routes. |
| Search | Current title filters using `LOWER(...) LIKE '%term%'` in OLAP and route SQL | Use `reviewSearchService` and ready token/prefix search projection by default. Async substring jobs must use bounded cursors/projections, not raw title scans, and synchronous substring scans are not admitted at 10M scale unless a benchmarked n-gram projection is added. |
| Select-all and add-to-project | `selectArticleIdsByFilterDuckdb`, `selectArticleIdsOlap.ts`, `ProjectsAddArticlesRoutes.ts` | Replace all-ID result arrays with `reviewBulkOperationService` jobs using projection-identity/generation/filter criteria, snapshot pins when repeatable semantics are required, and keyset-batched processing. |
| PDF fetch | `ArticlesRoutes.ts` PDF-by-filter/project endpoints and `pdfFetchJobs.ts` | Use durable bulk jobs with snapshot pins or declared latest-generation semantics. PDF fetch receives bounded batches from serving selection jobs, not a full in-memory article ID list. |
| Project export | `ProjectExportRoutes.ts` | Use serving/export jobs with projection-identity/generation/filter cursors, snapshot pins, and payload budgets. No `OFFSET` batches, full prompt-filter in-memory passes, or raw project scans in request path. |
| Review health/warnings/prompt preview | `projectsRoutesGetReviewsHealth.ts`, `projectsRoutesGetReviewsWarnings.ts`, `projectsRoutesGetPromptPreview.ts` | Read manifest, diagnostics, and compact serving/progress state. Any project-scale inspection must be maintenance/debug-only or async. |
| Job execution snapshots | `judgmentExecutionSnapshotService.ts` | Use selected-import projection and review serving state for snapshot inputs. No foreground selected-import CTE recreation. |
| Mart refresh worker | `projectMartRefreshWorker.ts` | Coordinate with review serving projectors, snapshot manifests, wake budgets, and admission metrics. It may schedule or wake work but must not directly write `mart.review_*` rows or promote snapshots. |
| Dirty materialization services | `projectMartDirtyMaterializationService.ts`, `projectMartDirtyRefreshStateService.ts` | Consume coalesced dirty work/projector output and mark article-scoped dirty state without broad rediscovery. Maintain bounded batches, watermarks, and dirty-work compaction. |
| Mart maintenance service | `getDuckdbMartMaintenanceService.ts` | Either become implementation helpers behind `reviewServingProjectorService` or be retired for review serving. Do not remain a competing writer or promotion path. |
| Large rebuild services | `projectMartLargeRebuildExecutor.ts`, `projectMartLargeRebuildRunner.ts`, `projectMartLargeRebuildCyclesService.ts`, `projectMartLargeRebuildStateService.ts` | Rebuild only affected components through the same projector/manifest writer. Use chunk manifests, input hashes, bounded phases, and skip/resume behavior so unchanged completed chunks are not rerun. No foreground raw fallback during rebuild. |
| Import writers | `articleImportStoreService.ts`, `articleCanonicalMatcher.ts`, `structuredFileImportService.ts`, `pubmedWorkflowStoreEntries.ts`, `europePmcPprWorkflowStoreEntries.ts` | Append compact import/source-record deltas transactionally, pre-extract hot JSON fields, and avoid synchronous project fanout. |
| Route proxy/classification | `apiRouteClassification.ts`, `ApiProxyRoutes.ts`, `routeSurfaceInventory.ts` | Preserve browser/desktop owner routing while adding workload classifications for review reads, background jobs, bulk jobs, and maintenance/debug routes. |

## Testing Strategy

Testing should prove both behavior and query shape. A passing test suite must
show that product routes cannot accidentally reintroduce raw fallback, all-ID
materialization, `OFFSET`, project-wide windows, JSON sort/extraction, or
unclassified DuckDB work.

| Layer | Tests | Required Coverage |
|---|---|---|
| Contracts and registry | Adjacent unit tests for `reviewServingContracts.ts`, `reviewProjectionIdentity.ts`, `reviewServingInvalidationRegistry.ts`, and `reviewServingReadContracts.ts`. | Every route has a workload class, allowed filters, physical filter access strategy, named fast counts, cursor spec, page/result budget, freshness behavior, count/search unavailable state, narrow projection identity behavior, and required/optional projection component list. Every delta kind maps to first affected component, downstream dependents, affected keys, and update mode. |
| Cursor/filter signatures | Unit tests for `reviewServingCursor.ts`. | Round-trip encoding, config-hash mismatch, generation mismatch, filter-signature mismatch, sort direction mismatch, malformed cursors, and stable signatures for equivalent filters. |
| SQL builders | Unit tests for `reviewServingSql` builders using golden strings or parsed assertions. | Foreground SQL contains only serving tables and required keys. Assert absence of `selected_scoped_article_import`, `ROW_NUMBER(`, `OFFSET`, raw `app.article`/`app.judgment` scans, `json_extract`, and unbounded `GROUP BY`. |
| Admission and budgets | Unit tests for `reviewServingAdmission.ts` and DuckDB service workload hooks. | Over-limit page size, result bytes, temp-spill policy, unregistered foreground work, unclassified workload, synchronous substring search, unsupported count shape, and over-budget foreground work are rejected or served stale before DuckDB execution. |
| Route behavior | Route tests for LLM, human, both, unassessed, filters, counts, details, PDF/export job creation, and bulk add-to-project. | Responses include freshness/count/search/job states, clamp limits, reject invalid projection-identity/generation/filter cursors, avoid raw fallback, and create durable jobs instead of returning all IDs. |
| Delta ledgers | Unit/integration tests for import, LLM judgment, human judgment, prompt/config, and project-scope writers. | Deltas are transactional with source writes or recovered through outbox reconciliation, compact, ordered, idempotent, include tombstones for deletes/removals, coalesce into dirty work, have per-component acknowledgements, and can be retained/compacted after consumer watermarks pass. |
| Incremental summaries | Unit/integration tests for `reviewServingContributionService.ts`. | Old/new contribution rows apply exact `-old +new` updates to counts, facets, badges, queues, posting stats, deletes, answer changes, and membership removals without full reaggregation. |
| Projectors | Integration tests for projector services with small DuckDB fixtures. | Component-scoped dependency order, first-affected-component scheduling, leases, watermarks, idempotent replay, crash/retry, tombstones, dirty-work coalescing, compacted component acknowledgements, major base generation, append/patch imports, component-narrow patches, compaction thresholds, single-writer ownership, selected-import projection, serving rows, contribution summaries, search state, and queue state. |
| Manifest promotion | Integration tests for manifest repository and serving promotion. | Candidate snapshots promote only after all required pieces and checks pass. Optional components expose availability state without blocking unrelated routes. Failed snapshots preserve last known-good data and never trigger raw foreground fallback. |
| Snapshot pins | Unit/integration tests for snapshot pin repository and cleanup. | Durable jobs pin repeatable snapshots, pins expire/release, cleanup skips pinned base/patch/payload/count/search rows, and latest-generation jobs declare restart semantics. |
| Bulk jobs | Worker tests for `reviewBulkOperationService` and `reviewBulkOperationWorker`. | Jobs store criteria, projection identities, generation, and filter signature, pin or declare latest-generation semantics, process keyset batches, respect batch/result budgets, support cancellation/retry/resume, and never allocate all matching IDs. |
| Search jobs | Tests for `reviewSearchService` and any search projection. | Missing search state returns search-indexing/unavailable or async job state. Ready search state is bounded and token/prefix based unless an n-gram projection is explicitly added. Model/prompt changes do not rebuild title-search projections. Synchronous substring scans and raw-title async scans are not emitted. |
| Overlay semantics | Route/service tests for read-your-write overlays. | Row/detail overlays reconcile after projection, while counts/facets/queues/bulk jobs remain snapshot-scoped or explicitly return overlay-aware state. |
| Internal parity | Internal validation tests and benchmark assertions for parity mode. | Semantic fixtures, sampled safe-size parity, invariants, freshness states, cursors, SQL shape, latency, result bytes, and route states match expected behavior before normal-route cutover. |
| Desktop/proxy | Route-surface/proxy tests for browser and desktop owner paths. | Browser and desktop share the same serving/job/admission behavior and route classifications. |
| Benchmark | Scripted 10M-article/7-prompt synthetic benchmark. | Overlap import, dirty materialization, serving refresh, review reads, filters, counts, token/prefix search, unavailable/async substring state, bulk jobs, PDF/export jobs, and desktop interruption/resume under target memory limits. Include repeated small updates proving projectors do not rerun unrelated components. |

Add a shared foreground-SQL assertion helper used by route and SQL-builder tests.
It should fail if a foreground query contains any forbidden token or non-allowlisted
raw table. Existing tests in `duckdbOlap.test.ts` that currently expect raw
fallback should be replaced with tests proving raw fallback is absent after the
cutover.

## Implementation Phase Checklist

These are implementation phases, not staged product releases. Complete all
phases and pass the final cutover gate before the normal review path is switched
over. Each phase should leave tests passing, but users should not receive a
partial serving architecture.

| Status | Phase | Theme | Implement First | Done When |
|---|---|---|---|---|
| [ ] | 0 | Contracts, budgets, and module boundary | Add `src/server/reviewServing/` with contracts, projection identity builders, invalidation registry, read registry, cursor helpers, SQL-shape test helpers, admission interfaces, internal parity contracts, and diagnostics shape. Define freshness/count/search/bulk states, named fast counts, route budgets, workload classes, narrow projection identities, snapshot IDs, physical filter access strategies, and required/optional projection components. | Every product review route has a contract entry, every hot read has a declared table/cursor/budget/count/filter-access behavior, every delta kind maps to first affected component/downstream dependents/update mode, normal foreground admission is registry-based, and static tests prevent review routes from direct DuckDB SQL or raw fallback calls. |
| [ ] | 0 | Benchmark harness | Add the 10M-article/7-prompt synthetic fixture, overlap workload definition, memory limits, and metrics capture. | Benchmark can run without the final implementation and report p50/p95/p99 latency, memory, temp usage, queue depth, rows scanned, rows returned, and admitted/rejected work. |
| [ ] | 1 | Schema foundation | Add migrations for import deltas, review change deltas, coalesced dirty work, dirty-work acknowledgements, projector cursors/watermarks, projection identity manifests, rebuild chunk manifests, selected-import generations, logical snapshot manifests, snapshot pins, compacted serving bases, serving patches, filter postings, posting stats, contribution rows, payloads, count/facet rows, search state, bulk jobs, write overlays, and retention metadata. | `bun run db:mig` applies cleanly and schema tests prove narrow identity keys, sorted/order keys, snapshot/base/patch fields, required/optional component status, retention/pin fields, dirty-work acknowledgement fields, contribution keys, posting stats, and chunk resume fields exist. |
| [ ] | 1 | Runtime admission foundation | Add workload classifications and budget enforcement hooks in the DuckDB runtime without adding product-specific SQL there. | Foreground work is accepted only from registered read/job contracts, over-budget work can be rejected/served stale, and metrics include workload class, memory limit, temp usage, queue state, and route/project context. |
| [ ] | 2 | Write-side deltas | Update import, LLM judgment, human judgment, prompt/config, and project-scope writers to append compact deltas transactionally with change kinds from the invalidation registry. Pre-extract hot JSON fields during import. | Tests prove source writes and deltas/outbox rows commit atomically or reconcile before watermark advancement, deletes/removals create tombstones, config changes produce only the narrow identities they affect, and no write path synchronously fans out selected-import state to every project. |
| [ ] | 2 | Read-your-write state | Add optimistic/overlay state for reviewer actions that need immediate feedback before projection catches up. | Reviewer changes have a clear immediate response path, route-specific overlay semantics are documented, and reconciliation tests prove overlays disappear once included in a completed serving snapshot. |
| [ ] | 3 | Projector core | Build component-scoped projector dependency graph, coalesced dirty-work service, compacted component acknowledgements, leases, watermarks, idempotent replay, wake budgets, single serving-writer boundary, major base/minor patch snapshot model, contribution diff service, incrementally digested rebuild chunk manifests, failure state, snapshot pins, and retention cleanup primitives. | Projector tests prove crash/retry/replay safety, bounded batch size, dirty-work coalescing, component ack skip behavior, wake release, watermark atomicity, single-writer ownership, contribution diffs, component-narrow patches, patch compaction thresholds, chunk resume/skip behavior without source-row hash scans, pin-aware cleanup, and failed snapshots preserving last-known-good data. |
| [ ] | 3 | Selected-import projection | Replace runtime `selected_scoped_article_import` ranking with generation-scoped selected-import projection. | Selected import rows are projected by bounded batches, promoted atomically, and normal foreground SQL never contains `selected_scoped_article_import` after cutover. |
| [ ] | 3 | Serving projections | Write compacted base rows, component-narrow patch rows, payload rows, human/both/unassessed status, badges, contribution rows, count/facet rows, filter postings, posting stats, queue rows, and search projection or async search state from completed dependency inputs. | Manifest checks prove all route-required components and watermarks match one logical snapshot before promotion. Optional search/count components expose availability states and do not block unrelated route activation. Routine changes update only affected component fields, contributions, postings, and chunk digests. |
| [ ] | 4 | Foreground serving reads | Migrate LLM, human, both, unassessed, filters, facets, badges, counts, rows, queues, detail reads, health/warnings, and prompt preview to `reviewServingReader`. | Route tests prove serving-only reads, projection-identity/generation/filter-scoped cursors, bounded filter access, result caps, no raw fallback, no `OFFSET`, no JSON extraction/sorts, no project-wide windows, and registry-based admission. |
| [ ] | 4 | Internal parity validation | Run the new serving reader behind internal wiring against semantic fixtures, invariant checks, benchmarks, and safe-size current behavior before product cutover. | Parity checks pass for row payload semantics, named count states, freshness states, cursor behavior, SQL shape, latency budgets, result bytes, and no forbidden foreground DuckDB work. |
| [ ] | 4 | Bulk, export, PDF, and search jobs | Replace select-all/add-to-project/PDF/export all-ID materialization with durable keyset-batched jobs. Add token/prefix search and async-only substring behavior unless n-gram projection is benchmarked. | Bulk/search tests prove criteria/projection-identity/generation/filter signatures are persisted, repeatable jobs pin snapshots, batches are bounded, jobs resume/cancel/retry, and synchronous substring search scans are not admitted. |
| [ ] | 4 | DuckDB usage migration | Resolve every row in the DuckDB usage migration inventory. | Each current review-related DuckDB use delegates to serving/admission/job logic or is explicitly marked admin/maintenance/debug-only. |
| [ ] | 5 | Hard cutover and deletion | Remove normal raw review fallback, old selected-import foreground joins, large-ID return paths, hidden `OFFSET` pagination, competing serving writers, and obsolete intermediate state. | Static SQL-shape tests and route tests fail if forbidden raw paths return. Internal parity validation has passed. Obsolete state is rebuilt or cleared with no compatibility shim unless explicitly required. |
| [ ] | 5 | Desktop and interruption hardening | Verify browser and desktop use the same serving/job/admission behavior. Test sleep/restart/interruption for projectors, bulk jobs, search jobs, and low-memory runtime. | Desktop build or targeted desktop verification passes, interrupted work resumes safely, and low-memory batch defaults prevent OOM. |
| [ ] | 5 | Final benchmark and release gate | Run the overlap benchmark and repo-native quality gates. | 10M/7-prompt benchmark passes under target memory limits, no foreground temp spill occurs for hot reads, all targeted tests pass, lint passes, and `OOM_ERRORS.md` is updated with the implementation entry. |

## Proposed Tables

| Table | Purpose | Performance Notes |
|---|---|---|
| `app.import_run_article_delta` | Append-only ledger of article/import-route changes from import runs. | Index by `import_route_id, delta_id`, `article_id, delta_id`, and `import_run_id`. Keep rows compact and avoid large JSON payloads. Do not require project fanout in import writes. |
| `app.review_change_delta` | Append-only ledger of judgment, human-review, prompt/config, and scope changes that affect review serving rows. | Index by `project_id, delta_id`, `article_id, delta_id`, and change-specific stable keys. Keep payloads compact and use tombstones for deletes/removals. |
| `app.review_serving_dirty_work` | Coalesced dirty project/article or projection-scope work derived from append-only deltas. | Key by project/scope, article or projection key, dirty kind, and latest source high-water mark. Collapse repeated changes and compact completed work after all dependent projectors pass the watermark. |
| `app.review_serving_dirty_work_ack` | Per-component completion state for dirty keys or dirty ranges. | Prefer component high-water rows and compressed contiguous ranges over one row per key. Key by dirty work range, component, projection identity, completed source high-water mark, and status. Lets fast components skip already-processed dirty work even if optional components lag. |
| `app.review_project_import_delta_cursor` | Projector cursor from route/article import deltas to project/article dirty work. | Track project, route, source delta high-water, lease, status, cursor, and errors. Use this to resolve affected projects in bounded batches. |
| `app.review_serving_projector_watermark` | Durable source/output state for each review-serving projector dependency. | Track projector name, project/import scope, source high-water marks, output generation, status, lease, cursor, and error. Advance watermarks atomically with projector output. |
| `app.review_projection_identity_manifest` | Active narrow identity values for display, search, judgment input content, project scope, per-prompt config, summary, and review config projections. | Stores identity kind, base generation, patch watermark/ranges, input watermarks/digests, definition version, active generation, and invalidation reason. Readers compose these identities instead of forcing one broad rebuild key. |
| `app.review_rebuild_chunk_manifest` | Chunk-level rebuild/compaction/repair state. | Key by project, component, projection identity, incrementally maintained input watermark/digest, chunk range, output generation, status, checksum, lease, and error. Completed unchanged chunks are skipped on rerun without scanning source rows to decide skip eligibility. |
| `app.review_selected_article_import_generation` | Projector generation/checkpoint state for selected import projection. | Track `project_id`, `project_scope_generation`, `generation`, `source_delta_high_water`, cursor fields, status, owner, lease, started/completed timestamps, and errors. It does not depend on model/prompt config. |
| `app.review_selected_article_import` | Selected-import snapshot per project/article. | Key by `project_id, project_scope_generation, generation, article_id`. Store selected IDs and rank/filter/display fields. Promote completed selected-import snapshots atomically. |
| `app.review_serving_generation_manifest` | Atomic control record for logical review serving snapshots. | Track project, active/candidate/failed state, snapshot ID, base generation, patch watermark, composed projection identities, optional review config hash, route-required projection completeness, optional projection availability, source watermarks, validation results, selected-import generation, last known-good generation, timestamps, and last error. |
| `app.review_serving_snapshot_pin` | TTL/refcount pin for durable jobs and repeatable-read cursors. | Key by project, composed projection identities, snapshot ID, owner kind/job ID, expiration, and release state. Cleanup must not delete referenced base/patch/payload/count/search state while a pin is active. |
| `app.review_write_overlay` | Optional immediate read-your-write state for reviewer actions. | Key by `project_id`, `review_config_hash`, `article_id`, and judgment/human-judgment key. Keep small, expire/reconcile after the durable serving snapshot includes the change. |
| `app.review_bulk_operation_job` | Persisted select-all/add-to-project/PDF/export work. | Store project, composed projection identities, optional review config hash, generation, snapshot pin ID or latest-generation semantics, filter signature, serialized criteria, cursor, batch size, status, result manifest, progress, cancellation, retry count, and error. Never store unbounded article ID arrays. |
| `app.review_search_job` | Optional async title/search work for unsupported synchronous search. | Store project, search/project-scope identities, optional review config hash when combined with review filters, generation, snapshot pin ID or latest-generation semantics, search mode, search text, filter signature, cursor/progress, status, result count availability, expiration, and error. Do not store unbounded article ID arrays. Use when ready search projection is missing. |
| `mart.review_title_search_serving` | Optional compact token/prefix title search projection. | Store normalized token/prefix rows keyed by `project_id, search_generation, project_scope_generation, token/search_key, article_id`. Add n-gram rows only if benchmarked and product-critical. Request paths and async jobs must not scan raw titles or rebuild for model/prompt changes. |
| `mart.review_article_serving` | Compacted hot review-list/filter/count base for LLM, human, both, and unassessed modes. | Store small typed fields needed for list UI, filters, sorting, badges, selected external IDs, human status, LLM status, cursor sort keys, and count/facet membership. Key by project, component identities, optional review config hash for judgment-derived state, generation, list/filter/sort prefixes. |
| `mart.review_article_serving_patch` | Bounded component patch rows/tombstones over a compacted base generation. | Key by project, component kind, component identity, snapshot/patch watermark, list mode, article, and sort/filter keys. Store only changed fields for that component; compact into a new base before patch thresholds or hot-read budgets are exceeded. |
| `mart.review_article_filter_posting_serving` | Compact postings for synchronous filter combinations that are not ordered prefixes. | Key by project, required projection identities, optional review config hash, generation, filter kind/value, list mode, sort key, and article ID. Multi-filter reads must start from a bounded posting/projection or return async/unavailable. |
| `mart.review_filter_posting_stats` | Incremental cardinality/selectivity stats for posting tables. | Key by project, projection identities, filter kind/value, list mode, and generation. Updated from contribution diffs so readers can choose a leading posting without scanning. |
| `mart.review_article_serving_payload` | Optional detail payloads for larger JSON/raw metadata. | Load by `project_id, article_projection_generation, article_id` only on detail routes, export jobs, or explicit capped hydration steps. Never join by default in hot list/count/filter reads and never rebuild for model/prompt-only changes. |
| `mart.review_article_summary_contribution` | Previous per-article contributions for count/facet/badge/posting summaries. | Key by project, projection identities, optional review config hash, article ID, component kind, summary definition version, and contribution key. Enables exact `-old +new` summary updates. |
| `mart.review_article_count_serving` | Precomputed count and badge values. | Key by `project_id`, required projection identities, optional `review_config_hash`, generation, count kind, summary definition version, and filter key. Keep values small and nullable/stale-aware. |
| `mart.review_filter_facet_serving` | Precomputed filter/facet values. | Key by `project_id`, required projection identities, optional `review_config_hash`, generation, facet kind, prompt ID, answer ID/value, and summary definition version. Serve filter UIs without grouping raw facts. |
| `mart.review_unassessed_queue_serving` | Optional unassessed queue candidate ordering. | Key by `project_id, review_config_hash, generation, priority_bucket, activity_sort_at, article_id`. Use contribution diffs for routine judgment changes and rebuild in chunks for definition/config changes. |

## Delta Ledger Guidance

Delta rows should describe what changed, not every product view affected by the
change. This keeps imports, judgments, human review, and project-config writes
cheap at million-scale.

- For imports, prefer route/article deltas: `delta_id`, `import_run_id`, `import_route_id`, `article_id`, `change_kind`, source record key/hash, changed timestamp, and compact rank/filter fields.
- Define `change_kind` explicitly for creates, updates, removals, judgment changes, human judgment changes, and project config changes.
- Each `change_kind` must use the invalidation registry to produce affected projection components and keys. Do not let projectors infer broad invalidation from generic dirty flags.
- Write source mutations and delta/outbox rows in the same DuckDB transaction whenever the source write is local. If that is impossible, a reconciliation projector must detect missing/orphan changes before dependent watermarks advance.
- Project config changes that affect model, prompt set/version, or title/abstract/fulltext flags produce a new review config identity only for judgment-derived projections. They reuse article/import/title/payload projections when those inputs are unchanged.
- For import route deltas, resolve affected projects in bounded projector work by joining route deltas to `app.project_import_route`.
- Only persist `affected_project_id` in an import-write transaction if route-to-project fanout is measured and bounded.
- Keep large JSON, raw payloads, source records, and audit data out of the delta ledger.
- Convert delta ranges into `app.review_serving_dirty_work` before expensive projections. Coalesce repeated changes for the same project/article/projection key to the latest source high-water mark.
- Projectors should consume dirty-work keys and high-water marks, not repeatedly rescan historical delta ledgers for every serving component.
- Record per-component dirty-work acknowledgements in the same transaction as output rows and watermarks. Components that already acknowledged a key/range skip it on later wakes.
- Store acknowledgements as component high-water rows or compressed contiguous key ranges whenever possible. Do not retain one ack row per dirty key/component forever.
- Compact dirty work and acknowledgements together after every required consumer has acknowledged the range and optional consumers have either acknowledged, expired, or moved to async/unavailable state.
- Retain raw delta ledgers only as long as replay, audit, and lagging projectors require them. Compact or archive ranges after every consumer watermark has advanced past them.
- Make projector output idempotent by `(project_id, source_delta_high_water, article_id)` or generation-scoped keys.
- Use tombstones for deletes and membership removals so replay can retract stale serving rows.
- Advance projector watermarks in the same transaction as the output rows they describe.
- Judgment, human-review, prompt/config, and project-scope deltas should carry enough stable keys to mark exactly affected project/article serving rows dirty without scanning all judgments.

## Performance Rules

- Product review routes read only from `mart.review_article_serving` and keyed payload/detail tables.
- Product review routes include LLM, human, both, unassessed, filters, facets, badges, counts, rows, queues, bulk actions, PDF fetch, and export entrypoints.
- Product review routes do not call raw fallback, even when serving is stale or missing.
- Product review routes include only the projection identity keys they need. Judgment-derived reads include `review_config_hash`; article/import/title/payload reads use narrower identities and must not rebuild for model/prompt-only changes.
- Normal foreground DuckDB work must come from registered read/job contracts. Ad hoc product SQL is rejected before execution, even if a rough estimate appears small.
- Initial index missing means return indexing state and empty rows, not a raw scan.
- Dirty index means return stale serving rows plus progress state.
- Failed index means return the last known-good generation plus failure state, not a raw scan.
- Serving snapshot promotion must be all-or-nothing through a manifest.
- Serving manifests distinguish route-required components from optional search/count/job components so optional work does not block unrelated hot reads.
- Exactly one normal serving writer may write `mart.review_*` rows and promote active snapshots.
- Routine deltas promote logical snapshots with bounded patches; they do not copy all rows for a 10M-article project.
- Projector wakes start at the first affected component declared by the invalidation registry. Judgment-only and human-review changes must not run selected-import, display, payload, or search projectors.
- Prompt config changes are prompt-scoped. One prompt change must not rebuild unchanged prompt projections or summaries.
- Article display, search, and judgment-input content identities are separate. Display-only edits must not rerun search or judgments; search-only edits must not rerun judgments; judgment-input changes affect only affected article/config/prompt facts.
- Patch reads are allowed only while the patch set stays under validated hot-read budgets. A candidate snapshot that exceeds the patch budget must compact into a new major base before activation.
- Patches are component-narrow. Do not write row-wide hot patches when only display, selected-import, LLM status, human status, queue, posting, or search fields changed.
- Large append imports create append/patch partitions first and compact only when read budgets or storage policy require it; they do not automatically rebuild the full existing base.
- Foreground routes must verify they are reading one active snapshot with one composed identity set, not mixed rows/counts/facets from incompatible snapshots or identities.
- Hot serving tables must be physically written in generation/filter/sort order that matches the registered read contracts.
- Use keyset pagination, not offset pagination, for hot review lists.
- Cursors must include the route's projection identities, generation, filter signature, sort direction, sort values, and article ID.
- Cursor mismatch means restart from page one or return cursor-invalid state; never continue against a different generation/filter.
- Cursor projection-identity mismatch means cursor-invalid; never read a serving snapshot built from a different identity set.
- Every synchronous filter must use an ordered prefix, filter posting table, compact projection, or pre-proven bounded candidate set. Otherwise return unavailable or async state.
- Filter posting selection uses maintained cardinality stats. Do not compute selectivity with a foreground scan.
- Named product-critical counts must be precomputed or nullable; do not calculate raw counts on hot paths.
- Named product-critical counts, facets, badges, queue counts, and posting stats update from stored old/new contribution diffs for routine changes.
- Filter/facet values must be precomputed or served from compact facet tables; do not `GROUP BY` raw judgments on hot paths.
- Unsupported count/facet combinations return unavailable state instead of triggering raw aggregation.
- Exact counts for arbitrary prompt combinations or search terms are not synchronous unless that exact named key is product-critical and precomputed.
- Synchronous token/prefix title search may use ready projected search state. Synchronous arbitrary substring search over 10 million rows is not allowed unless a benchmarked n-gram projection is added; otherwise use bounded async jobs over projected/searchable state or unavailable/search-indexing state.
- Reviewer read-your-write behavior must use optimistic UI state or a small overlay, not synchronous raw refresh.
- Overlays affect only route contracts that declare overlay-aware behavior; snapshot-scoped counts/facets/queues/bulk jobs stay stale or pending until projection catches up.
- Select-all, add-to-project, PDF fetch, export, and other bulk operations must use durable jobs and keyset-batched processing.
- Repeatable bulk/export/PDF/search jobs must pin the serving snapshot they read. Latest-generation jobs must declare that they may restart if the active snapshot changes.
- Routes must never return or allocate all matching article IDs for a large filter in one request.
- API `limit` values must be clamped, and every hot route must have max response-byte and hydrated-payload budgets.
- Foreground queries must be admitted by workload class before execution. Over-budget work is rejected, queued as async work, or served from stale state.
- Do not run `ROW_NUMBER()` over project-wide import-route rows in request paths.
- Do not extract JSON inside `ORDER BY`, `GROUP BY`, or window functions on hot paths.
- Do not join `selected_scoped_article_import` in normal foreground review, filter, count, bulk, or export paths after cutover.
- Projectors consume deltas by cursor/high-water mark and bounded batch size.
- Projectors consume coalesced dirty-work keys for expensive serving components and compact delta/dirty state after dependent watermarks advance.
- Projectors use component-level dirty acknowledgements so lagging optional projections do not force current required projections to rerun.
- Dirty-work acknowledgements must compact to component high-water rows or compressed ranges before they become a maintenance workload.
- Projectors must be idempotent and replayable from durable watermarks.
- Rebuild and compaction projectors use chunk manifests and input hashes to skip unchanged completed chunks.
- Chunk input hashes must come from incrementally maintained dirty tokens, contribution digests, or posting stats. Do not scan source rows only to decide whether a chunk can be skipped.
- Projectors must not advance watermarks past source writes unless the source write and delta/outbox entry are known to be transactionally committed or reconciled.
- Background workers release claims after a wake budget so import, materialization, and serving refresh can interleave.
- Large JSON/raw payloads live in payload tables, not hot serving rows.
- Under low-memory runtimes, reduce projector/materialization batch sizes before increasing concurrency.
- Keep active, candidate, last known-good, and pinned snapshots; clean obsolete base, patch, payload, count, facet, queue, and search rows in bounded batches.
- Store and compare snapshot state explicitly so foreground routes know whether data is active, stale, indexing, failed, or missing.
- Prefer clear cutovers that rebuild obsolete intermediate state over compatibility shims that keep old and new paths alive.

## Cutover Gate

The cutover happens only after every implementation phase above is complete.
Until then, the work can exist behind internal wiring, but the normal product
review path should not partially switch to the new architecture.

- [ ] Phase 0 contracts, module boundaries, static guards, and benchmark harness are complete.
- [ ] Phase 1 schema and DuckDB workload-admission foundations are complete.
- [ ] Phase 2 write-side deltas, hot-field extraction, and read-your-write state are complete.
- [ ] Phase 3 projectors, selected-import projection, serving projections, manifests, and cleanup are complete.
- [ ] Phase 4 foreground serving reads, jobs, search, and DuckDB usage migration are complete.
- [ ] Phase 5 raw fallback deletion, desktop hardening, final benchmark, and repo quality gates are complete.
- [ ] Internal parity validation has passed for semantic fixtures, sampled safe-size parity, named counts, freshness states, cursor behavior, SQL shape, latency, and response-size budgets.
- [ ] A single normal serving writer owns all `mart.review_*` writes and active-snapshot promotion; legacy mart refresh/rebuild paths cannot promote competing review snapshots.
- [ ] Serving manifests classify required versus optional components, and optional search/count work cannot block unrelated review-list activation.
- [ ] Logical snapshot/base/patch behavior is benchmarked, and routine deltas cannot full-copy project-scale serving rows.
- [ ] Layered projection identities prove model/prompt/content changes do not rebuild article/import/title/payload/search projections when those inputs are unchanged.
- [ ] Prompt-level identities prove one prompt change does not rebuild unchanged prompt projections or summaries.
- [ ] Component-narrow patches prove judgment-only changes do not rewrite display/import/payload/search fields.
- [ ] The invalidation registry covers every delta kind and forbids unmapped broad rebuild behavior.
- [ ] Incremental contribution diffs update counts, facets, badges, queues, and posting stats for routine changes without full reaggregation.
- [ ] Component-level dirty acknowledgements prove current required projectors skip work already processed even when optional projectors lag.
- [ ] Dirty-work acknowledgement state is compacted and cannot grow as one permanent row per dirty key/component.
- [ ] Rebuild chunk manifests prove interrupted or repeated rebuilds skip unchanged completed chunks.
- [ ] Rebuild chunk input digests are maintained incrementally by normal projection work, not computed by rescanning source rows during rebuild startup.
- [ ] Snapshot pins prevent cleanup from deleting data needed by repeatable durable jobs.
- [ ] Every synchronous filter route has a bounded ordered-prefix, posting-table, projection, or pre-proven candidate-set access path.
- [ ] Serving reads, cursors, counts, search, and jobs include the narrow projection identities they depend on and reject mismatched identity state.
- [ ] No normal browser or desktop review flow can reach raw fallback, `selected_scoped_article_import`, raw project-wide scans, unbounded ID materialization, or large-offset pagination.
- [ ] Admin/maintenance/debug-only raw reads are named, route-classified, guarded, and excluded from normal product flows.

## Non-Goals

- Do not fix this only by raising `DUCKDB_MEMORY_LIMIT`.
- Do not silently retry, downgrade, or mutate DuckDB/query settings after OOM.
- Do not preserve obsolete intermediate state with compatibility shims unless explicitly required.
- Do not open additional live DuckDB readers for the API while a maintenance owner is writing, unless reads are from a controlled snapshot or serving projection.
- Do not keep raw review fallback as a hidden normal path for large/importing projects.
- Do not keep multiple normal writers or promotion paths for review-serving snapshots.
- Do not treat every routine delta as a full project serving-generation copy.
- Do not use one broad review config hash to invalidate config-independent article/import/title/payload/search projections.
- Do not reuse judgment-derived serving rows across model, prompt, or content-setting changes without a new review config identity.
- Do not rebuild unchanged prompt projections when only one prompt changes.
- Do not use row-wide patches for component-specific changes when a narrower display, selected-import, judgment-status, human-status, queue, posting, or search patch is sufficient.
- Do not let generic dirty flags wake every projector when a change-kind dependency matrix can identify affected components.
- Do not synchronously fan out selected import state to every project inside import writes.
- Do not make `affected_project_id` mandatory in import deltas unless route-to-project fanout is proven bounded.
- Do not preserve unlimited serving snapshots.
- Do not keep synchronous substring title search as a hidden scan over large serving/raw tables.
- Do not silently change substring search into token/prefix search without naming the semantic difference in the API/UI contract.
- Do not materialize all matching article IDs or payloads in memory for select-all, add-to-project, PDF fetch, export, or similar bulk actions.
- Do not delete base/patch/payload/search/count rows while durable jobs still pin the serving snapshot.
- Do not recompute counts, facets, posting stats, or queues from all serving rows for routine article/judgment/import changes when old/new contribution diffs are available.
- Do not rerun completed rebuild chunks whose input watermark/hash is unchanged.
- Do not compute rebuild chunk skip hashes by rescanning source rows when upstream dirty tokens or chunk digests can be maintained incrementally.
- Do not retain unbounded per-key/per-component dirty-work acknowledgement rows after compacted range/high-water acknowledgements are possible.
- Do not let caller-provided `limit` values control memory or response size without route-level caps.
- Do not treat SQL cost estimation as the safety boundary for normal foreground reads; use registered contracts and explicit budgets.

## Quality Gates

- [ ] 10M-article/7-prompt benchmark fixture or synthetic equivalent is available and documented.
- [ ] Overlap benchmark passes under target DuckDB memory limits with import, dirty materialization, serving refresh, review list, filters, counts, bulk jobs, export/PDF jobs, and desktop-style interruption/resume.
- [ ] Benchmark records p50/p95/p99 latency, peak process memory, DuckDB memory limit, temp-dir growth, queue depth, admitted/rejected query counts, rows scanned, rows returned, and active snapshot/identity state.
- [ ] Benchmark proves foreground review reads are bounded by page size, selected filter postings, or precomputed summary rows, not total project article/judgment/import-route count.
- [ ] Benchmark records physical read-shape evidence for hot routes: row groups/rows scanned, temp spill, response bytes, and whether ordered generation/filter prefixes were used.
- [ ] Benchmark proves routine deltas create bounded patches or dirty work, not full 10M-row serving copies, and compaction triggers before patch reads exceed hot-route budgets.
- [ ] Benchmark includes repeated article/title changes, judgment changes, human-review changes, import appends, and prompt/config changes proving unrelated projections are not rerun.
- [ ] Benchmark separately measures display-only, search-only, judgment-input-content, one-prompt config, and judgment-only changes proving each updates only affected components.
- [ ] Every product review route has a `reviewServingReadContracts.ts` registry entry with workload class, cursor spec, narrow projection identity behavior, budgets, allowed filters, physical filter access strategy, and named fast counts.
- [ ] Every normal foreground DuckDB call is traceable to a registered read/job contract; unregistered foreground calls fail tests before query execution.
- [ ] A static test or grep-based test fails if review route handlers call `runDuckdbJsonQuery`, build DuckDB SQL, decode cursors, or call raw OLAP fallback directly.
- [ ] Every row in the DuckDB usage migration inventory is either migrated to serving/admission/job logic or explicitly classified as admin/maintenance/debug-only.
- [ ] Shared foreground SQL-shape tests reject `selected_scoped_article_import`, `ROW_NUMBER(`, `OFFSET`, raw `app.article`/`app.judgment` scans, `json_extract`, and unbounded `GROUP BY` in product-read SQL.
- [ ] `bun test src/services/olap/duckdbOlap.test.ts`
- [ ] `bun test src/server/reviewServing`
- [ ] `bun test src/server/services/projectMartDirtyMaterializationService.test.ts`
- [ ] `bun test src/server/workers/projectMartRefreshWorker.test.ts`
- [ ] `bun test src/server/services/projectMartLargeRebuildExecutor.test.ts`
- [ ] Targeted tests for import delta ledger writes
- [ ] Targeted tests for review change delta writes from LLM judgments, human judgments, prompt/config changes, and project-scope changes
- [ ] Targeted tests proving source writes and delta/outbox writes are atomic or reconciled before watermarks advance
- [ ] Targeted tests proving projection identity changes invalidate only dependent components, and review config changes do not rebuild config-independent article/import/title/payload/search state
- [ ] Targeted tests proving display, search, judgment-input-content, project-scope, prompt config, and review config identities advance independently
- [ ] Targeted tests proving one prompt config change does not rebuild unchanged prompt outputs, summaries, queues, or facets
- [ ] Targeted tests proving every delta kind has an invalidation registry entry with first affected component, downstream dependents, affected keys, and update mode
- [ ] Targeted tests for delta semantics, tombstones, and replay after deletes/removals
- [ ] Targeted tests for coalesced dirty-work creation, repeated-change collapse, component acknowledgements, retention, and compaction after consumer watermarks advance
- [ ] Targeted tests proving dirty-work acknowledgements compact into component high-water rows or compressed ranges
- [ ] Targeted tests for route/project delta projector fanout and cursor behavior
- [ ] Targeted tests for projector dependency order, watermarks, and idempotent replay
- [ ] Targeted tests proving only the review serving projector boundary writes `mart.review_*` rows and promotes active snapshots
- [ ] Targeted tests for major base generation, append-first large imports, bounded patch promotion, patch merge-cost budgets, patch compaction thresholds, and pin-aware cleanup
- [ ] Targeted tests proving judgment-only, display-only, search-only, and selected-import-only changes write component-narrow patches instead of row-wide patches
- [ ] Targeted tests for chunk manifests proving rebuilds and compactions skip unchanged completed chunks, resume failed chunks, and use incrementally maintained input digests instead of source-row scans
- [ ] Targeted tests for selected import projector generation/checkpoint behavior
- [ ] Targeted tests for atomic review serving snapshot manifest promotion and failed-snapshot recovery
- [ ] Targeted tests for required versus optional manifest components and route-specific availability states
- [ ] Targeted tests for count/facet serving projections
- [ ] Targeted tests for old/new contribution diffs for counts, facets, badges, queues, posting stats, deletes, answer changes, and membership removals
- [ ] Targeted tests for unsupported count/facet combinations returning nullable or unavailable states
- [ ] Targeted tests for filter contracts proving every synchronous filter combination uses ordered-prefix, posting/projection, or bounded-candidate access with maintained selectivity stats.
- [ ] Targeted tests for token/prefix search behavior and async/unavailable substring behavior proving substring search never runs as a synchronous full-table scan.
- [ ] Targeted tests for projection-identity/generation/filter-scoped cursors and cursor-invalid behavior after identity/generation/filter mismatch.
- [ ] Targeted tests for hard route result-size caps: max page size, max response bytes, max hydrated payload bytes, and max per-request ID count.
- [ ] Targeted tests for read-your-write overlay or optimistic reconciliation behavior
- [ ] Targeted tests proving counts, facets, queues, and bulk jobs do not silently include overlay state unless declared by the route contract
- [ ] Targeted tests proving foreground LLM, human, both, unassessed, filter, count, badge, row, queue, bulk, PDF, and export routes do not include raw fallback, `selected_scoped_article_import`, or raw project-wide scans
- [ ] Targeted tests proving stale, indexing, failed, and missing serving states do not trigger raw fallback
- [ ] Targeted tests proving review list routes use keyset pagination and do not require large `OFFSET`
- [ ] Targeted tests proving select-all, add-to-project, PDF fetch, and export use durable jobs and keyset-batched execution without returning all matching article IDs.
- [ ] Targeted tests proving repeatable durable jobs pin serving snapshots and cleanup skips pinned base/patch/payload/count/search state
- [ ] Targeted tests proving foreground query admission rejects or serves stale for over-budget workload classes before DuckDB execution.
- [ ] Targeted tests proving internal parity validation blocks cutover on semantic fixture, invariant, sampled parity, cursor, freshness-state, SQL-shape, latency, or response-size mismatches.
- [ ] Browser review-flow verification for stale/indexing/failed/missing states
- [ ] Desktop review-flow verification or targeted desktop build when shared runtime paths change
- [ ] `bun run lint`
- [ ] `bun run db:mig` if schema/projection migrations are added
- [ ] Add an `OOM_ERRORS.md` entry in the same change as any OOM fix implementation
