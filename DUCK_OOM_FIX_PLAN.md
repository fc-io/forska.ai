# DuckDB Long-Term Serving Index Plan

This is the master coordinator for the DuckDB CQRS serving-index work. It owns
the global problem statement, scale target, contracts, architecture rules,
cutover gate, non-goals, and repo-wide quality gates.

Phase execution details live in the phase files below:

| Phase | File | Scope |
|---|---|---|
| 0 | [DUCK_CQRS_PLAN_PHASE_0.md](./DUCK_CQRS_PLAN_PHASE_0.md) | Contracts, budgets, module boundary, static guards, and benchmark harness. |
| 1 | [DUCK_CQRS_PLAN_PHASE_1.md](./DUCK_CQRS_PLAN_PHASE_1.md) | Durable schema foundation and generic DuckDB workload admission hooks. |
| 2 | [DUCK_CQRS_PLAN_PHASE_2.md](./DUCK_CQRS_PLAN_PHASE_2.md) | Write-side deltas, import hot-field extraction, outbox reconciliation, and overlays. |
| 3 | [DUCK_CQRS_PLAN_PHASE_3.md](./DUCK_CQRS_PLAN_PHASE_3.md) | Projector core, selected-import projection, serving projections, manifests, and cleanup. |
| 4 | [DUCK_CQRS_PLAN_PHASE_4.md](./DUCK_CQRS_PLAN_PHASE_4.md) | Production serving reads, route-specific parity validation, bulk/search/export/PDF jobs, and usage migration. |
| 5 | [DUCK_CQRS_PLAN_PHASE_5.md](./DUCK_CQRS_PLAN_PHASE_5.md) | Final hardening sweep, any remaining raw fallback deletion, desktop hardening, benchmark, and release gates. |

When a phase-specific detail conflicts with this master document, update both in
the same change and keep this master as the coordination source of truth.

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
- Read model: compact `mart.*_serving` tables keyed by project, required projection identities, logical `snapshot_id`, component `base_generation`, filter state, and cursor sort keys.

This should land as one coordinated CQRS cutover, not as long-lived parallel
fallback paths. Phase 4 may migrate production route handlers as soon as the
route-specific serving path, parity checks, SQL-shape checks, budget checks, and
relevant browser/desktop checks pass. When a route is migrated, remove or hard
disable the corresponding legacy raw path in the same change unless it is
explicitly reclassified as admin/maintenance/debug-only.

Before any normal product route switches, the new pipeline should pass the
route-specific parity gate for that route. The parity gate builds serving
snapshots, executes sampled read contracts, compares rows/count states and cursor
behavior against semantic fixtures and safe-size current behavior, records
latency/query-shape metrics, and blocks that route migration on invariant,
parity, or budget failures.

The route inventory is intentionally conservative. `mounted: true` means the
registered contracts cover the full product response shape for that route.
Partial helper contracts, future route contracts, or contracts missing search,
filter-option, detail, or warning-diagnostic parity stay unmounted until their
route-specific gates pass.

## PR 68 Review Alignment

The Phase 0 review comments tightened this plan rather than changing its
direction. The accepted fixes and pending gates all reinforce the same goal:
normal review flows must not be able to certify partial serving coverage and then
fall back to expensive raw DuckDB behavior.

The plan now treats these review-driven refinements as part of the serving-index
goal:

- Direct ordered-prefix row contracts are only unfiltered list reads. Filtered
  pages must go through bounded posting/search selection and then hydrate the
  selected page by an `articleSetLookup` contract, never by N+1 single-article
  lookups or by reading an unfiltered page.
- Product route inventories must include list judgment payload contracts, human
  summary/prompt payload contracts, count contracts, facet and filter-option
  contracts, substring-job contracts, and warning/detail extras before a route can
  be marked mounted. Incomplete detail, prompt-preview, warning, or helper routes
  stay unmounted.
- Filter signatures include explicit article-created date bounds
  (`articleCreatedAtFrom` and `articleCreatedAtTo`), duplicate/conflict flags,
  import route scope, prompt/human/LLM status, queue kind, publication year, and
  search scope where the current product route applies those predicates.
- Human filter routes have human-specific facet and option contracts. Summary-mode
  human answers are first-class summary/facet inputs instead of being modeled as
  prompt-only human judgments.
- Synchronous title search is token/prefix only. Substring search, including
  add-to-project-by-filter substring requests, is represented by async job
  contracts over projected state or remains unavailable.
- Job criteria reads use job-table identities such as `job_kind`,
  `filter_signature`, `search_mode`, `search_text`, `updated_at`, and `job_id`.
  They do not inherit article-row ordering or article-ID cursor assumptions.
- Snapshot/health/warning reads must select usable manifests explicitly, such as
  active or last-known-good/retired states, and must not make candidate or failed
  manifests drive normal freshness decisions.
- The Phase 5 benchmark is a release gate only if it covers rows, filtered
  posting plus article-set hydration, list/detail judgment payloads, human facets
  and options, named counts across list modes, queue kind, token-prefix search,
  async substring jobs, bulk/export/PDF jobs, request-slice diversity, scanned-row
  ceilings, zero foreground temp spill, latency, and RSS targets.

These refinements do not conflict with the OOM fix. They reduce the chance of a
false cutover by making semantic parity and physical boundedness part of the same
contract.

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

- JavaScript/TypeScript implementation uses the `effect` library for non-trivial async and server flow in every phase. Phase docs call out the specific JS/TS surfaces that should use `Effect.gen`, `Layer`/`Context`, `Effect.acquireRelease`/`Scope`, and `Schedule`.
- Freshness contract: every review response has an explicit readiness state using the implementation vocabulary `ready`, `stale`, `indexing`, or `unavailable`, plus snapshot status and diagnostics when the underlying manifest is candidate, failed, missing, or retired. Stale state returns the last completed snapshot plus progress; unavailable/missing initial state returns indexing or unavailable state and empty rows.
- Atomic snapshot manifest: a snapshot becomes active only after every required route component completes for the same composed identity set. Optional components such as async search or unsupported counts have their own availability state and do not block unrelated review-list activation.
- Component-scoped projector graph: each delta kind enters the graph at the first affected component declared by the invalidation registry. Selected-import projection is only on import/scope paths; judgment and human-review deltas do not wait for selected-import work.
- Serving writer ownership: one normal writer owns V4 `mart.review_*_v4` serving rows and V4 snapshot promotion. Legacy refresh/rebuild services either call that writer as helpers, produce deltas/dirty work, or are retired; they do not independently write or promote V4 review-serving snapshots.
- Delta semantics: deltas enumerate supported changes explicitly, including article import, import record update, route membership removal, LLM judgment create/update/delete, human judgment update, and project config change.
- Delta coalescing: append-only delta ledgers feed compact dirty-work state keyed by project/article or projection scope. Projectors consume coalesced dirty work and source high-water marks instead of repeatedly scanning large historical delta ranges.
- Transaction boundary: source writes and delta/outbox writes commit in the same DuckDB transaction. If a source mutation cannot share the transaction, it must use a durable outbox plus reconciliation scan before the projector can advance the affected watermark.
- Idempotency and replay: projector writes use stable snapshot/base-scoped keys, upserts, tombstones, and transactions so the same delta range can be retried or replayed without double-counting.
- Layered projection identity: every serving row carries only the invalidation keys it depends on. Identities are stable base generation plus component patch watermark/ranges, not one global generation per small update. Display, search, judgment-input content, project scope, prompt config, and review config identities advance independently.
- Logical snapshot model: a route reads one `snapshot_id`, not a full project-row copy. `base_generation` is per component and reserved for first builds, rebuilds, large compactions, or structural config changes. Normal deltas create component-narrow patches and manifest updates.
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
- Route inventory contract: mounted route inventory entries are complete product-route coverage only. Partial contracts remain unmounted and cannot be used as evidence that the route is migrated or safe.
- Filter access contract: every synchronous filter combination is allowlisted with a bounded physical access strategy: ordered prefix, posting/projection table, small candidate set, or unavailable/async. A serving-only predicate is not enough if it scans project-scale rows.
- Filtered hydration contract: posting/search contracts produce bounded page article sets, and row/detail/list-payload hydration for those sets uses `articleSetLookup` with explicit article-ID-set budgets. Direct ordered-prefix row contracts must not advertise filters that their SQL does not bind.
- Cursor contract: every cursor includes `snapshot_id`, required component identities, component base/patch state, sort key values, page direction, and a filter signature. If the snapshot, identity set, component state, or filter signature changes, the route returns a fresh first page or a cursor-invalid state instead of mixing snapshots.
- Snapshot pinning contract: durable jobs and long-lived cursors that require repeatable results acquire snapshot pins. Cleanup cannot delete pinned base rows, patches, payloads, counts, facets, or search state until the pin expires or is released.
- Rebuild chunk contract: long rebuilds use chunk manifests with incrementally maintained input watermarks/digests and output status. Rebuild workers skip unchanged completed chunks and resume failed/interrupted chunks instead of rerunning the full phase or rescanning source rows just to decide skip eligibility.
- Bulk-operation contract: select-all, add-to-project, PDF fetch, export, and similar actions operate through persisted selection jobs or cursor-batched server jobs. They never return or allocate all matching article IDs in one request.
- Job-criteria contract: durable bulk/export/PDF/search job lookups are keyed by job kind, filter signature, search mode/text when relevant, projection identities, and either a pinned snapshot or explicit latest-snapshot semantics. Job reads use job-table cursor/sort columns, not article-row ordering.
- Search contract: synchronous ready search supports declared token/prefix semantics from compact search projections. Arbitrary substring/contains search over million-scale projects is async-only or unavailable unless a benchmarked n-gram projection is explicitly added.
- Specific-count contract: only named product-critical counts are synchronous and fast. Unsupported filter/search combinations return nullable/unavailable counts or start async count work; they never trigger raw aggregation.
- Workload admission contract: every normal foreground DuckDB request comes from a registered read/job contract with a workload class, search mode, result-size budget, row budget, memory/temp budget, and timeout. Ad hoc SQL estimation is not a safety boundary; unregistered foreground work or mismatched search-mode work is rejected before query execution.
- Result-size contract: API responses have maximum page size, row count, payload bytes, and hydrated-detail budgets. Detail payloads and ID lists are paged or job-backed, not embedded in hot list responses.
- Route-specific parity contract: parity reads compare semantic fixtures, sampled safe-size parity, invariants, freshness states, cursors, SQL shape, latency, and result-size behavior before each production route or flow migrates. Any mismatch, forbidden SQL shape, or budget breach blocks that route migration.

## Success Criteria

- [ ] Import, dirty materialization, and review-index refresh can overlap without review-list OOMs.
- [ ] A benchmark fixture with 10 million articles and an average of 7 prompts per article passes without OOM under the target DuckDB memory limits.
- [ ] Review lists remain readable during materialization by using the last completed serving snapshot.
- [ ] Review responses expose `ready`, `stale`, `indexing`, or `unavailable` readiness plus snapshot status/diagnostics for failed, missing, candidate, retired, or last-known-good state.
- [ ] Foreground API reads never run unbounded raw/import-route scans.
- [ ] Foreground review routes never execute project-wide windows, raw total counts, or JSON sorts.
- [ ] LLM, human, both, unassessed, filter, count, badge, bulk-action, PDF, and export flows are all covered by the same serving/cursor/job architecture.
- [ ] Import writes append deltas cheaply and do not synchronously fan out selected-import state to every affected project.
- [ ] Source writes and delta/outbox writes commit atomically, or reconciliation blocks watermark advancement until missing deltas are recovered.
- [ ] Delta ledgers cover article/import creates, updates, deletes, route membership changes, LLM judgments, human judgments, and project config changes explicitly.
- [ ] Selected scoped import state is maintained by bounded projectors with snapshot/checkpoint semantics.
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
- [ ] Exactly one normal V4 serving writer owns `mart.review_*_v4` writes and active V4 snapshot promotion.
- [ ] Review list, count, facet, badge, and unassessed-queue reads use serving indexes only.
- [ ] Filtered review pages use posting/search selection plus `articleSetLookup` row hydration, with stable sort tie-breaks and no N+1 single-article hydration.
- [ ] Filter-option routes, detail routes, and warning/health routes are not marked migrated until their contracts cover the complete response shape, including search-scoped options, prompt judgment details, and maintenance diagnostics.
- [ ] List routes are not marked migrated until they preserve current row metadata, article timestamps, LLM judgment arrays, human prompt/summary payloads, both-mode payloads, prompt badges, and supported duplicate/conflict/date/prompt/search filter scopes.
- [ ] Hot serving rows contain typed columns for sort, filters, badges, and selected import fields.
- [ ] Hot serving tables use physical layouts that keep product reads bounded by ordered snapshot/filter prefixes, typed columns, and compact projection-specific rows.
- [ ] Named product-critical counts and facets are precomputed or nullable; they are never computed from raw tables in request paths.
- [ ] Counts, facets, badges, and posting cardinalities update from per-article old/new contribution diffs instead of full reaggregation for routine changes.
- [ ] Count and facet projections document the specific fast count keys, cardinality limits, and unavailable states.
- [ ] Large JSON/detail payloads are kept out of hot list/filter serving rows.
- [ ] Read-your-write behavior is explicit for reviewer actions while serving projection catches up.
- [ ] Product list routes use keyset pagination and never require `OFFSET` over large scopes.
- [ ] Every synchronous filter combination has a bounded physical access path or returns unavailable/async state.
- [ ] Filter posting selectivity/cardinality stats are maintained incrementally and used to pick bounded leading access paths.
- [ ] Cursors include `snapshot_id`, component base/patch state, and filter signatures so pagination cannot mix snapshots or filter states.
- [ ] Bulk actions and exports never materialize all matching article IDs or payloads in memory.
- [ ] Durable bulk/export/PDF/search jobs pin the serving snapshot they read or explicitly declare latest-snapshot semantics.
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
- [ ] Route-specific parity validation passes semantic fixture, sampled parity, cursor, freshness-state, SQL-shape, and latency checks before each production route or flow migrates.
- [ ] Read-your-write overlay semantics are route-specific and do not silently mutate snapshot-scoped counts, facets, queues, or bulk eligibility.
- [ ] OOM logs include enough state to identify route, project, workload class, active snapshot/identity set, and raw/serving mode.

## Target Read Shape

Foreground judgment-derived review-list routes should follow this shape:

```sql
SELECT ...
FROM mart.review_article_serving_v4
WHERE project_id = ?
  AND review_config_hash = ?
  AND snapshot_id = ?
  AND list_mode_key = ?
  AND <projected_filter_predicates>
  AND (activity_sort_at, article_id) < (?, ?)
ORDER BY activity_sort_at DESC, article_id ASC
LIMIT ?
```

Filtered list routes should split selection from hydration. The posting/search
step returns the bounded page article set, and the row hydration step follows an
article-set shape instead of replaying unfiltered list SQL or doing N+1 lookups:

```sql
SELECT ...
FROM mart.review_article_serving_v4
WHERE project_id = ?
  AND review_config_hash = ?
  AND snapshot_id = ?
  AND list_mode_key = ?
  AND article_id IN (SELECT unnest(?))
ORDER BY activity_sort_at DESC, article_id ASC
LIMIT ?
```

Judgment-derived counts and facets should follow this shape:

```sql
SELECT count_value
FROM mart.review_article_count_serving_v4
WHERE project_id = ?
  AND review_config_hash = ?
  AND snapshot_id = ?
  AND count_kind = ?
  AND filter_key = ?
```

The exact `list_mode_key` and projected filter predicates can vary by serving
contract, but each hot read must be backed by projected typed columns and an
explicit access path. No raw fallback. No `ROW_NUMBER()`. No JSON extraction. No
raw total count. No `OFFSET` over large projects.

Job criteria reads should follow job-table identity, not article-row identity:

```sql
SELECT ...
FROM app.review_bulk_operation_job
WHERE project_id = ?
  AND job_kind = ?
  AND filter_signature = ?
  AND (snapshot_id = ? OR (latest_snapshot_semantics = TRUE AND snapshot_id IS NULL))
ORDER BY updated_at DESC, job_id DESC
LIMIT 1
```

Search-job reads similarly include search mode/text, filter signature, project
scope identity, and null-safe optional identities. They must not be ordered by or
scoped through article-row fields.

Here, `snapshot_id` is a logical serving snapshot ID. It points at component
projection identities, compacted `base_generation` values, and bounded patch
watermarks; it must not imply a full 10M-row copy for every routine delta.

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
- Whether the contract is complete product-route coverage or only an unmounted helper/future contract.
- Which named counts are fast, and whether other count shapes return stale, nullable, unavailable, or async counts.
- Maximum page size, result row count, response bytes, and detail hydration budget.
- Workload class and admission budget.

Review cursors must encode the projection identities used by the route,
`snapshot_id`, component base/patch state, filter signature, sort direction,
sort values, and article ID. A cursor from one snapshot, identity set, component
state, or filter signature must not page through a different snapshot, identity
set, or filter state.

## Persisted Identity Glossary

Use these names consistently in code, schema, manifests, cursors, jobs, and logs.
Do not invent parallel terms during implementation.

| Term | Meaning | Persistence Rule |
|---|---|---|
| `projectionComponent` | A independently updated serving component such as `display`, `search`, `judgmentInputContent`, `projectScope`, `selectedImport`, `llmStatus`, `humanStatus`, `queue`, `posting`, `summary`, or `payload`. | Stored as a small string/enum in manifests, dirty work, acks, chunks, and diagnostics. |
| `projectionIdentity` | The narrow identity for one component, derived from that component's definition version, base generation, patch range, and upstream input digests. | Stored as `projection_identity` on component manifests and as component-specific identity columns on serving rows/jobs/cursors that need it. |
| `baseGeneration` | A compacted, sorted physical base for one component and identity. | Stored as `base_generation`; only changes after first build, structural rebuild, or compaction. |
| `patchWatermark` | The highest component patch/delta watermark included by a logical snapshot. | Stored as `patch_watermark`; advances for routine updates without changing the base generation. |
| `snapshotId` | A logical product-read snapshot composed from component identities plus base generations and patch watermarks. | Stored as `snapshot_id`; routes/cursors/jobs read one snapshot ID and identity set. |
| `reviewConfigHash` | Review-only identity derived from model, content flags, and prompt identities used by the route. | Stored only on judgment-derived rows, summaries, queues, cursors, and jobs. It is not used for config-independent display/search/payload state. |
| `promptConfigHash` | Prompt-level identity for prompt text, answer schema, thresholding, and prompt-specific settings. | Stored per prompt. A single changed prompt creates a new prompt identity without invalidating unchanged prompts. |
| `summaryDefinitionVersion` | Version of a named count/facet/badge/posting contribution definition. | Stored on contribution and summary rows. Summary definition changes rebuild only that summary component. |
| `inputDigest` | Incrementally maintained digest or high-water marker proving a chunk/component input set is unchanged. | Stored on projection identity and chunk manifests. It is updated during normal projection work, not by rebuild-time source scans. |
| `dirtyRange` | Coalesced range or keyset of dirty work for a component. | Stored in dirty work and ack tables as compact ranges/high-water rows where possible. |

Database columns should prefer these names: `projection_component`,
`projection_identity`, `base_generation`, `patch_watermark`, `snapshot_id`,
`review_config_hash`, `prompt_config_hash`, `summary_definition_version`,
`input_digest`, and `dirty_range`.

## Snapshot And Generation Model

The long-term design should avoid full project-row copies for routine updates.
A serving snapshot is a logical read contract that points to compact physical
state.

- Major base generation: a full, sorted, compact base for one project and the narrow projection identity it depends on. Build it for first indexing, schema/layout changes, structural project-scope changes, and patch compaction.
- Minor snapshot: a manifest update over the current base plus bounded component patch rows and tombstones for article display, selected import, LLM status, human status, queue, posting, and review-action changes.
- Patch tables: use typed per-component patch tables for hot paths, not one generic JSON/blob patch table. Each table stores only changed component fields/tombstones since the base generation, keyed by project, component identity, snapshot/patch watermark, list mode when relevant, article, and sort/filter keys. A judgment-only patch does not rewrite article display, selected import, payload, or search fields.
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

Initial `change_kind` values for Phase 0 contracts:

| Change Kind | Required Keys |
|---|---|
| `article.display.updated` | `articleId`, changed display field names, source high-water mark. |
| `article.searchText.updated` | `articleId`, changed searchable field names, source high-water mark. |
| `article.judgmentInput.updated` | `articleId`, affected content flags, source high-water mark. |
| `importRoute.article.added` | `importRouteId`, `articleId`, import/source record key, source high-water mark. |
| `importRoute.article.removed` | `importRouteId`, `articleId`, import/source record key, source high-water mark. |
| `importRoute.article.rankFields.updated` | `importRouteId`, `articleId`, changed rank/filter fields, source high-water mark. |
| `projectScope.article.added` | `projectId`, `articleId`, route/import source key, source high-water mark. |
| `projectScope.article.removed` | `projectId`, `articleId`, route/import source key, source high-water mark. |
| `judgment.llm.created` | `projectId`, `articleId`, `promptId`, `modelId`, content flags, judgment ID, source high-water mark. |
| `judgment.llm.updated` | `projectId`, `articleId`, `promptId`, `modelId`, content flags, judgment ID, source high-water mark. |
| `judgment.llm.deleted` | `projectId`, `articleId`, `promptId`, `modelId`, content flags, judgment ID, source high-water mark. |
| `judgment.human.updated` | `projectId`, `articleId`, `promptId`, human judgment key, source high-water mark. |
| `prompt.config.updated` | `projectId`, `promptId`, changed prompt config fields, source high-water mark. |
| `project.reviewConfig.updated` | `projectId`, changed model/content/prompt membership fields, source high-water mark. |

Phase 0 must add this enum and the invalidation registry before Phase 2 write
paths append these values. If a write path cannot map its source change to one of
these values, it fails tests or quarantines the delta instead of emitting a broad
project dirty flag.

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
`mart.review_article_serving_v4` can still scan millions of rows if it is not tied
to the physical layout.

Every synchronous filter combination in `reviewServingReadContracts.ts` must use
one of these strategies:

- Ordered-prefix read: the filter is part of the table order/prefix for that route and list mode.
- Posting/projection table: start from a compact table keyed by project, required projection identities, `snapshot_id`, filter kind/value, list mode, sort key, and article ID.
- Bounded candidate set: a prior contract step proves the candidate set is under the route row/result budget before hydration.
- Async/unavailable: the combination is not admitted synchronously and returns unavailable state or creates a durable job.

Multi-filter reads must start from the most selective bounded posting/projection
available. If no bounded leading access path exists, the route must not issue a
foreground DuckDB query for that filter combination.

The most selective posting must come from maintained stats, not runtime scans.
Each posting/projection table should have incrementally updated cardinality rows
keyed by project, projection identity, `snapshot_id`, filter kind/value, and list
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

- Write hot serving rows ordered by the dominant read prefixes, such as `project_id`, required projection identities, optional `review_config_hash`, `snapshot_id`, `list_mode_key`, projected filter bucket, descending sort key, and `article_id`.
- Keep hot rows narrow and typed: IDs, timestamps, booleans, small enums, numeric sort keys, compact text needed by list UI, and precomputed membership/filter keys.
- Keep arrays, large text, raw metadata, source JSON, prompt payloads, and derived detail blobs out of hot rows. Store them in keyed payload/detail tables or export-job payload paths.
- Use projection-specific tables for high-cardinality or specialized access, such as title-search tokens, unassessed queue ordering, count/facet summaries, and bulk selection cursors.
- Avoid one universal wide table if a route would need to scan many irrelevant columns or rows. Add a compact projection when it makes the hot path bounded and easy to test.
- Treat DuckDB indexes as optional acceleration. Correctness and OOM safety must come from snapshot/filter prefixes, sorted writes, keyset cursors, result caps, and workload admission.
- Rebuild or compact serving projections in bounded batches that preserve the target physical order for the next completed snapshot.
- Benchmark row-group pruning, rows scanned, temp spill, and response bytes for every registered hot read; a syntactically valid serving query still fails if it scans project-scale rows.

## Chunked Rebuild And Resume

Rebuilds and compactions should avoid rerunning unchanged work. Every long
projector phase should be split into deterministic chunks.

- Chunk manifests are keyed by project, component, projection identity, incrementally maintained input watermark/digest, chunk key range, output `base_generation`, status, and error.
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

Initial named fast counts and facets for Phase 0 contracts:

| Key | Kind | Scope | Notes |
|---|---|---|---|
| `review.list.total` | Count | Project, list mode, active snapshot. | Total rows for LLM, human, both, and unassessed list modes. |
| `review.list.filteredTotal` | Count | Project, list mode, allowed synchronous filter signature. | Available only when the filter contract has a bounded leading access path. |
| `review.llm.assessedByPrompt` | Count | Project, prompt, review config, answer/status. | Supports LLM prompt badges and review filters. |
| `review.llm.unassessedByPrompt` | Count | Project, prompt, review config. | Supports unassessed queue and prompt progress. |
| `review.human.reviewedByPrompt` | Count | Project, prompt, human status. | Supports human review progress and filters. |
| `review.both.conflictByPrompt` | Count | Project, prompt, review config. | Supports both-mode disagreement/conflict badges. |
| `review.queue.unassessedReady` | Count | Project, prompt, review config, queue kind. | Supports job/queue availability without raw scans. |
| `review.filter.duplicateFlag` | Facet | Project, list mode, duplicate/conflict flag. | Derived from selected import/display contribution rows. |
| `review.filter.importRoute` | Facet | Project, list mode, import route/source kind. | Derived from project-scope/selected-import contribution rows. |
| `review.filter.promptAnswer` | Facet | Project, prompt, answer/status. | Derived from LLM/human contribution rows. |
| `review.human.filter.summaryAnswer` | Facet | Project, human summary mode answer/status. | Derived from summary-mode human contribution rows and not modeled as prompt-scoped human judgments. |
| `review.filter.publicationYear` | Facet | Project, list mode, year bucket. | Derived from article display contribution rows. |

Any count or facet not listed here is unavailable or async until added to this
table with a summary definition version, contribution keys, and tests.

Date filters are explicit range keys, not publication-year approximations. Routes
that accept partial article-created bounds must use `articleCreatedAtFrom` and
`articleCreatedAtTo` in the filter signature, count/facet identity, posting
selection, and durable job criteria, or they must return unavailable/async state.

Unsupported count shapes must not fall back to raw `COUNT(*)`, raw prompt-answer
aggregation, or selected-import scans in foreground requests.

Filter-option routes are distinct from article posting rows. A migrated filter
option route must return the complete option/min-max payload expected by the UI,
scoped to active search and filters when the current product route does so. A
posting contract is only a row-candidate access path unless paired with an option
or facet contract that proves full response parity.

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
| `src/server/reviewServing/reviewServingCursor.ts` | Encoding, decoding, validation, and invalidation of projection-identity/snapshot/filter-scoped cursors. | Cursor payloads include the projection identities used by the route, snapshot ID, component base/patch state, filter signature, sort direction, sort values, and article ID. Routes do not hand-roll cursors. |
| `src/server/reviewServing/reviewServingAdmission.ts` | Foreground query admission before DuckDB execution. | Admits only registered read/job contracts for normal product work. Validates workload class, page limit, result-size budget, stale-allowed behavior, temp-spill policy, and search/count availability before SQL runs. |
| `src/server/reviewServing/reviewServingReader.ts` | Product-facing serving reads for list/count/filter/facet/badge/queue/detail entrypoints. | Routes call this module instead of `duckdbOlap.ts`. It returns freshness/count/search states and never chooses raw fallback. |
| `src/server/reviewServing/reviewServingSql.ts` or sibling `reviewServingSql/` files | Small SQL builders for serving reads only. | Builders are pure, contract-driven, and tested for forbidden patterns. No route-specific string concatenation outside this layer. |
| `src/server/reviewServing/reviewServingManifestRepository.ts` | Active/candidate/failed snapshot manifests, consistency check results, last-known-good snapshot, and promotion state. | Manifest reads are cheap keyed lookups. Promotion is transactional and all-or-nothing. |
| `src/server/reviewServing/reviewServingSnapshotPinRepository.ts` | Snapshot pins for durable jobs and any cursor/session that needs repeatable reads. | Cleanup must consult pins before deleting base generations, patches, payloads, counts, facets, queues, or search rows. |
| `src/server/reviewServing/reviewServingDeltaLedger.ts` | Append APIs for import, LLM judgment, human judgment, prompt/config, and project-scope deltas. | Write paths append compact deltas transactionally with source changes. Large payloads stay out of delta rows. |
| `src/server/reviewServing/reviewServingDeltaReconciliation.ts` | Durable outbox conversion, source high-water reconciliation, quarantine, and missing-delta recovery. | Used only when a source write cannot append the final delta in the same transaction. Projector watermarks must consult reconciliation state before advancing. |
| `src/server/reviewServing/reviewImportHotFieldService.ts` | Compact hot-field extraction for import/source-record writes. | Stores only typed fields needed by selected-import ranking, display, filters, postings, and contribution keys. Raw JSON remains in source/audit tables. |
| `src/server/reviewServing/reviewServingDirtyWorkService.ts` | Coalesced dirty-work state from append-only deltas to project/article or projection scopes. | Collapses repeated changes, tracks source high-water marks, and records component-level acknowledgements so current components do not reprocess lagging dirty keys. |
| `src/server/reviewServing/reviewServingContributionService.ts` | Old/new contribution rows and summary deltas for counts, facets, badges, queues, postings, and stats. | Applies `-old +new` changes transactionally with contribution rows and watermarks. No project-wide summary reaggregation for routine changes. |
| `src/server/reviewServing/reviewServingChunkManifestRepository.ts` | Chunk manifests for rebuilds, compactions, and repair jobs. | Tracks input watermark/hash, chunk key range, output status, checksums, and resume/skip behavior. |
| `src/server/reviewServing/reviewServingProjectorService.ts` | Projector dependency graph, watermarks, leases, idempotent replay, selected-import projection, serving-row projection, contribution projection, single serving-writer ownership, and cleanup. | Runs only bounded batches. Advances component watermarks and dirty-work acknowledgements in the same transaction as output. This is the only normal owner of V4 `mart.review_*_v4` writes and active V4 snapshot promotion. |
| `src/server/workers/reviewServingProjectorWorker.ts` | Scheduling bounded projector wakes. | Coordinates with existing mart refresh/dirty materialization workers and releases claims on wake budgets. It does not bypass `reviewServingProjectorService` to write serving rows or promote snapshots. |
| `src/server/reviewServing/reviewBulkOperationService.ts` | Select-all, add-to-project, PDF fetch, and export selection jobs. | Stores criteria, required projection identities, snapshot ID, cursor, and progress, then acquires snapshot pins when repeatable results are required. Processes keyset batches. Does not materialize all IDs in memory. |
| `src/server/workers/reviewBulkOperationWorker.ts` | Executes durable bulk jobs. | Uses batch budgets, cancellation, retry, progress state, and result manifests. |
| `src/server/reviewServing/reviewSearchService.ts` | Ready token/prefix search state and async substring search jobs. | Synchronous substring scans are not admitted unless a benchmarked n-gram projection is added. Missing search state returns search-indexing/unavailable or creates bounded async work over projected/searchable state, not raw title scans. |
| `src/server/reviewServing/reviewServingDiagnostics.ts` | OOM/workload diagnostics for route, project, workload class, active snapshot/identity set, queue state, memory limit, temp usage, and raw/serving mode. | Logging shape is shared by foreground reads, projectors, bulk jobs, search jobs, and benchmarks. |
| `src/server/utils/duckdbService.ts` | Low-level DuckDB execution, queues, memory/runtime metrics, owner behavior, and workload class enforcement hooks. | No product semantics. It enforces budgets supplied by serving/admission layers and records metrics for every DuckDB request. Normal product work must arrive classified from registered contracts. |
| `src/services/olap/*` | Temporary compatibility wrappers during route migration work. | Wrappers delegate to `reviewServingReader` or job services for migrated routes. After route-specific parity validation and route migration, matching raw review fallback logic is deleted rather than preserved. |

Route handlers should not call `runDuckdbJsonQuery`, build DuckDB SQL, decode
review cursors, compute filter signatures, or decide raw fallback. Route handlers
should validate request bodies, call the appropriate serving reader/job service,
and return the contract state to the client.

The serving projector service is the single normal write boundary for new V4
review-serving rows and V4 snapshot promotion. Existing mart refresh, dirty
materialization, and large rebuild services may schedule work, produce deltas,
or provide implementation helpers behind that service, but they must not become
parallel V4 writers with separate promotion rules.

Implementation choice for cutover: `reviewServingProjectorService` replaces the
review-serving write role of existing mart maintenance/rebuild services for V4
state after Phase 3. Legacy V3 writers may continue only for not-yet-migrated
normal routes during Phase 4. When a route is migrated to V4 serving reads, the
matching legacy V3 normal writer/read path should be deleted or hard disabled in
the same change unless explicitly reclassified as admin/maintenance/debug-only.

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
| Unassessed and queue routes | `projectsRoutesGetArticlesReviewsUnassessed.ts`, `JudgmentsJobsRoutes.ts`, `judgmentsJobsCronGetPrompts.ts` | Use `mart.review_unassessed_queue_serving_v4` or equivalent queue projection, snapshot/filter cursors, and serving count states. No raw fallback windows in foreground/job API paths. |
| Filter/facet routes | `projectsRoutesGetArticlesReviewsFilters.ts`, `projectsRoutesGetArticlesReviewsHumanFilters.ts`, `getDatabaseBasedFiltersFromDuckdb`, `getNumericFiltersFromDuckdb` | Use precomputed facet tables, filter posting/projection tables, and count/facet availability states. No foreground `GROUP BY` over raw judgments, prompt facts, scoped import CTEs, or unbounded serving-table predicates. |
| Detail/hydration routes | `projectsRoutesPostArticleReviewDetails.ts`, `ArticlesRoutes.ts` detail reads, `appQueryServiceCore.ts` article hydration helpers | Use keyed serving payload/detail reads with payload budgets. Do not hydrate large metadata from list routes. |
| Search | Current title filters using `LOWER(...) LIKE '%term%'` in OLAP and route SQL | Use `reviewSearchService` and ready token/prefix search projection by default. Async substring jobs must use bounded cursors/projections, not raw title scans, and synchronous substring scans are not admitted at 10M scale unless a benchmarked n-gram projection is added. |
| Select-all and add-to-project | `selectArticleIdsByFilterDuckdb`, `selectArticleIdsOlap.ts`, `ProjectsAddArticlesRoutes.ts` | Replace all-ID result arrays with `reviewBulkOperationService` jobs using projection-identity/snapshot/filter criteria, snapshot pins when repeatable semantics are required, and keyset-batched processing. |
| PDF fetch | `ArticlesRoutes.ts` PDF-by-filter/project endpoints and `pdfFetchJobs.ts` | Use durable bulk jobs with snapshot pins or declared latest-snapshot semantics. PDF fetch receives bounded batches from serving selection jobs, not a full in-memory article ID list. |
| Project export | `ProjectExportRoutes.ts` | Use serving/export jobs with projection-identity/snapshot/filter cursors, snapshot pins, and payload budgets. No `OFFSET` batches, full prompt-filter in-memory passes, or raw project scans in request path. |
| Review health/warnings/prompt preview | `projectsRoutesGetReviewsHealth.ts`, `projectsRoutesGetReviewsWarnings.ts`, `projectsRoutesGetPromptPreview.ts` | Read manifest, diagnostics, and compact serving/progress state. Any project-scale inspection must be maintenance/debug-only or async. |
| Job execution snapshots | `judgmentExecutionSnapshotService.ts` | Use selected-import projection and review serving state for snapshot inputs. No foreground selected-import CTE recreation. |
| Mart refresh worker | `projectMartRefreshWorker.ts` | Coordinate with review serving projectors, snapshot manifests, wake budgets, and admission metrics. It may schedule or wake work but must not directly write V4 `mart.review_*_v4` rows or promote V4 snapshots. |
| Dirty materialization services | `projectMartDirtyMaterializationService.ts`, `projectMartDirtyRefreshStateService.ts` | Consume coalesced dirty work/projector output and mark article-scoped dirty state without broad rediscovery. Maintain bounded batches, watermarks, and dirty-work compaction. |
| Mart maintenance service | `getDuckdbMartMaintenanceService.ts` | Retire as a direct V4 review-serving writer. Keep only migration/backfill/admin helpers that call `reviewServingProjectorService`; no direct V4 `mart.review_*_v4` writes or V4 manifest promotion after Phase 3. |
| Large rebuild services | `projectMartLargeRebuildExecutor.ts`, `projectMartLargeRebuildRunner.ts`, `projectMartLargeRebuildCyclesService.ts`, `projectMartLargeRebuildStateService.ts` | Become schedulers/backfill drivers for `reviewServingProjectorService`. Rebuild only affected components through the same projector/manifest writer. Use chunk manifests, input hashes, bounded phases, and skip/resume behavior so unchanged completed chunks are not rerun. No foreground raw fallback during rebuild. |
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
| Cursor/filter signatures | Unit tests for `reviewServingCursor.ts`. | Round-trip encoding, config-hash mismatch, snapshot/component-state mismatch, filter-signature mismatch, sort direction mismatch, malformed cursors, and stable signatures for equivalent filters. |
| SQL builders | Unit tests for `reviewServingSql` builders using golden strings or parsed assertions. | Foreground SQL contains only serving tables and required keys. Assert absence of `selected_scoped_article_import`, `ROW_NUMBER(`, `OFFSET`, raw `app.article`/`app.judgment` scans, `json_extract`, and unbounded `GROUP BY`. |
| Admission and budgets | Unit tests for `reviewServingAdmission.ts` and DuckDB service workload hooks. | Over-limit page size, result bytes, temp-spill policy, unregistered foreground work, unclassified workload, synchronous substring search, unsupported count shape, and over-budget foreground work are rejected or served stale before DuckDB execution. |
| Route behavior | Route tests for LLM, human, both, unassessed, filters, counts, details, PDF/export job creation, and bulk add-to-project. | Responses include freshness/count/search/job states, clamp limits, reject invalid projection-identity/snapshot/filter cursors, avoid raw fallback, and create durable jobs instead of returning all IDs. |
| Delta ledgers | Unit/integration tests for import, article display/search/judgment-input, LLM judgment, human judgment, prompt/config, and project-scope writers. | Deltas use the common envelope, are transactional with source writes or recovered through outbox reconciliation, compact, ordered, idempotent, include tombstones for deletes/removals, preserve benchmark-critical model/content settings, coalesce into dirty work, have per-component acknowledgements, and can be retained/compacted after consumer watermarks pass. |
| Incremental summaries | Unit/integration tests for `reviewServingContributionService.ts`. | Old/new contribution rows apply exact `-old +new` updates to counts, facets, badges, queues, posting stats, deletes, answer changes, and membership removals without full reaggregation. |
| Projectors | Integration tests for projector services with small DuckDB fixtures. | Component-scoped dependency order, first-affected-component scheduling, leases, watermarks, idempotent replay, crash/retry, tombstones, dirty-work coalescing, compacted component acknowledgements, major base generation, append/patch imports, component-narrow patches, compaction thresholds, single-writer ownership, selected-import projection, serving rows, contribution summaries, search state, and queue state. |
| Manifest promotion | Integration tests for manifest repository and serving promotion. | Candidate snapshots promote only after all required pieces and checks pass. Optional components expose availability state without blocking unrelated routes. Failed snapshots preserve last known-good data and never trigger raw foreground fallback. |
| Snapshot pins | Unit/integration tests for snapshot pin repository and cleanup. | Durable jobs pin repeatable snapshots, pins expire/release, cleanup skips pinned base/patch/payload/count/search rows, and latest-snapshot jobs declare restart semantics. |
| Bulk jobs | Worker tests for `reviewBulkOperationService` and `reviewBulkOperationWorker`. | Jobs store criteria, projection identities, snapshot ID, and filter signature, pin or declare latest-snapshot semantics, process keyset batches, respect batch/result budgets, support cancellation/retry/resume, and never allocate all matching IDs. |
| Search jobs | Tests for `reviewSearchService` and any search projection. | Missing search state returns search-indexing/unavailable or async job state. Ready search state is bounded and token/prefix based unless an n-gram projection is explicitly added. Model/prompt changes do not rebuild title-search projections. Synchronous substring scans and raw-title async scans are not emitted. |
| Overlay semantics | Route/service tests for read-your-write overlays. | Row/detail overlays reconcile after projection, while counts/facets/queues/bulk jobs remain snapshot-scoped or explicitly return overlay-aware state. |
| Route-specific parity | Validation tests and benchmark assertions for parity mode. | Semantic fixtures, sampled safe-size parity, invariants, freshness states, cursors, SQL shape, latency, result bytes, and route states match expected behavior before each production route or flow migrates. |
| Desktop/proxy | Route-surface/proxy tests for browser and desktop owner paths. | Browser and desktop share the same serving/job/admission behavior and route classifications. |
| Benchmark | Scripted 10M-article/7-prompt synthetic benchmark. | Overlap import, dirty materialization, serving refresh, direct rows, filtered postings, article-set hydration, list/detail judgment payloads, human facets/options, named counts across list modes, queue-kind reads, token/prefix search, unavailable/async substring state, bulk substring selection, bulk jobs, PDF/export jobs, and desktop interruption/resume under target memory limits. Validate request-slice diversity, expected count/search/job dimensions, rows scanned ceilings, zero foreground temp spill, latency, and RSS targets. Include repeated small updates proving projectors do not rerun unrelated components. |

Add a shared foreground-SQL assertion helper used by route and SQL-builder tests.
It should fail if a foreground query contains any forbidden token or non-allowlisted
raw table. Existing tests in `duckdbOlap.test.ts` that currently expect raw
fallback should be replaced route-by-route with tests proving raw fallback is
absent after each route migration.

## Implementation Phase Index

These are implementation phases, not staged product releases. Production route
migration happens in Phase 4 route-by-route after the relevant gates pass. Final
cutover is complete only after all phases and the Phase 5 release gate pass. Each
phase should leave tests passing, and migrated routes should not retain hidden
legacy fallback paths.

The phase files are authoritative for implementation tasks and phase-local
quality gates. This master remains authoritative for shared constraints, terms,
non-goals, architecture boundaries, migration inventory, and final cutover gates.

| Phase | File | Cut Line | Product Route Switch? |
|---|---|---|---|
| 0 | [DUCK_CQRS_PLAN_PHASE_0.md](./DUCK_CQRS_PLAN_PHASE_0.md) | Contracts, budgets, module boundary, static guards, and benchmark harness. | No |
| 1 | [DUCK_CQRS_PLAN_PHASE_1.md](./DUCK_CQRS_PLAN_PHASE_1.md) | Empty durable schema plus generic DuckDB workload-admission hooks. | No |
| 2 | [DUCK_CQRS_PLAN_PHASE_2.md](./DUCK_CQRS_PLAN_PHASE_2.md) | Transactional deltas, import hot fields, outbox/reconciliation, and overlays. | No |
| 3 | [DUCK_CQRS_PLAN_PHASE_3.md](./DUCK_CQRS_PLAN_PHASE_3.md) | Projector core, selected-import projection, serving projections, manifests, and cleanup. | No |
| 4 | [DUCK_CQRS_PLAN_PHASE_4.md](./DUCK_CQRS_PLAN_PHASE_4.md) | Production route migration to serving readers, durable jobs, route-specific parity validation, and DuckDB usage migration. | Yes, per route after gates pass |
| 5 | [DUCK_CQRS_PLAN_PHASE_5.md](./DUCK_CQRS_PLAN_PHASE_5.md) | Final hardening sweep, any remaining raw fallback deletion, desktop hardening, final benchmark, and release gate. | Final verification |

Rules for phase coordination:

- Phase 4 may switch production route handlers one route or flow at a time after route-specific serving, parity, SQL-shape, budget, and relevant browser/desktop gates pass.
- When a Phase 4 route switches, delete or hard-disable the matching legacy raw path in the same change unless it is explicitly reclassified as admin/maintenance/debug-only.
- Phase 5 is the final hardening and verification sweep, not the first normal-route switch.
- Do not preserve raw fallback as a hidden normal path after a route has migrated.
- If a phase file changes a global contract, term, table name, or cutover gate, update this master document in the same change.
- If this master document changes a phase cut line or quality gate, update the affected phase file in the same change.

## Proposed Tables

| Table | Purpose | Performance Notes |
|---|---|---|
| `app.import_run_article_delta` | Append-only ledger of article/import-route changes from import runs. | Include the common delta envelope plus import-specific typed keys: `import_run_id`, `import_route_id`, `article_id`, source record key/hash, compact rank/filter/display key changes, and tombstone state. Index by `import_route_id, delta_id`, `article_id, delta_id`, `import_run_id`, `source_partition, source_high_water_mark`, and idempotency key. Keep rows compact and avoid large JSON payloads. Do not require project fanout in import writes. |
| `app.review_change_delta` | Append-only ledger of article display/search/judgment-input, LLM judgment, human-review, prompt/config, and direct project-scope changes that affect review serving rows. | Include the common delta envelope plus change-specific typed keys such as project ID, article ID, prompt ID, model ID, content flags, judgment ID, human judgment key, and config field set. Index by `project_id, delta_id`, `article_id, delta_id`, `source_partition, source_high_water_mark`, idempotency key, and change-specific stable keys. Keep payloads compact and use tombstones for deletes/removals. |
| `app.review_source_change_outbox` | Durable outbox for source mutations that cannot append the final delta ledger row in the same transaction. | Key by source table/row/operation/version and idempotency key. Store only compact recovery payload, source high-water mark, status, retry count, last error, and timestamps. Reconciliation must drain or quarantine these rows before affected projector watermarks advance. |
| `app.review_delta_reconciliation_cursor` | Cursor state for reconciling source writes, outbox rows, and delta ledger high-water marks. | Track source partition, source high-water mark, last reconciled delta ID, status, lease, retry/error fields, and quarantine state. Used only to prove missing deltas are recovered or quarantined before projector advancement. |
| `app.review_import_article_hot_field` | Compact current hot fields extracted during import/source-record writes for selected-import ranking, display, filters, postings, and contribution keys. | Key by `import_route_id`, `article_id`, source record key/hash, and active/tombstone state. Store only typed small fields such as source kind, selected rank key, publication year, journal/title display snippets, duplicate/conflict flags, and compact filter buckets. Keep raw source JSON out of this table. |
| `app.review_serving_dirty_work` | Coalesced dirty project/article or projection-scope work derived from append-only deltas. | Key by project/scope, article or projection key, dirty kind, and latest source high-water mark. Collapse repeated changes and compact completed work after all dependent projectors pass the watermark. |
| `app.review_serving_dirty_work_ack` | Per-component completion state for dirty keys or dirty ranges. | Prefer component high-water rows and compressed contiguous ranges over one row per key. Key by dirty work range, component, projection identity, completed source high-water mark, and status. Lets fast components skip already-processed dirty work even if optional components lag. |
| `app.review_project_import_delta_cursor` | Projector cursor from route/article import deltas to project/article dirty work. | Track project, route, source delta high-water, lease, status, cursor, and errors. Use this to resolve affected projects in bounded batches. |
| `app.review_serving_projector_watermark` | Durable source/output state for each review-serving projector dependency. | Track projector name, project/import scope, source high-water marks, output `base_generation` or `patch_watermark`, status, lease, cursor, and error. Advance watermarks atomically with projector output. |
| `app.review_projection_identity_manifest` | Active narrow identity values for display, search, judgment input content, project scope, per-prompt config, summary, and review config projections. | Stores `projection_component`, `projection_identity`, `base_generation`, `patch_watermark`, patch ranges, input watermarks/digests, definition version, status, and invalidation reason. Readers compose these identities instead of forcing one broad rebuild key. |
| `app.review_rebuild_chunk_manifest` | Chunk-level rebuild/compaction/repair state. | Key by project, component, projection identity, incrementally maintained input watermark/digest, chunk range, output `base_generation`, status, checksum, lease, and error. Completed unchanged chunks are skipped on rerun without scanning source rows to decide skip eligibility. |
| `app.review_selected_import_snapshot` | Projector snapshot/checkpoint state for selected import projection. | Track `project_id`, `project_scope_identity`, `selected_import_snapshot_id`, `source_delta_high_water`, cursor fields, status, owner, lease, started/completed timestamps, and errors. It does not depend on model/prompt config. |
| `app.review_selected_article_import_v4` | Selected-import snapshot rows per project/article. | Key by `project_id, project_scope_identity, selected_import_snapshot_id, article_id`. Store selected IDs and rank/filter/display fields. Promote completed selected-import snapshots atomically. The `_v4` name avoids mutating legacy selected-import state during Phase 1. |
| `app.review_serving_snapshot_manifest` | Atomic control record for logical review serving snapshots. | Track project, active/candidate/failed state, `snapshot_id`, composed projection identities, component `base_generation` and `patch_watermark` state, optional review config hash, route-required projection completeness, optional projection availability, source watermarks, validation results, selected-import snapshot, last-known-good snapshot, timestamps, and last error. |
| `app.review_serving_snapshot_pin` | TTL/refcount pin for durable jobs and repeatable-read cursors. | Key by project, composed projection identities, snapshot ID, owner kind/job ID, expiration, and release state. Cleanup must not delete referenced base/patch/payload/count/search state while a pin is active. |
| `app.review_write_overlay` | Optional immediate read-your-write state for reviewer actions. | Key by `project_id`, optional `review_config_hash`, `article_id`, prompt/judgment or human-judgment key, overlay kind, and source high-water mark. Store only small typed values, created/expiration timestamps, and reconcile status. Counts, facets, queues, search, bulk, PDF, and export remain snapshot-scoped unless their route contracts explicitly opt in. |
| `app.review_bulk_operation_job` | Persisted select-all/add-to-project/PDF/export work. | Store project, composed projection identities, optional review config hash, `snapshot_id`, snapshot pin ID or latest-snapshot semantics, filter signature, serialized criteria, cursor, batch size, status, result manifest, progress, cancellation, retry count, and error. Never store unbounded article ID arrays. |
| `app.review_search_job` | Optional async title/search work for unsupported synchronous search. | Store project, search/project-scope identities, optional review config hash when combined with review filters, `snapshot_id`, snapshot pin ID or latest-snapshot semantics, search mode, search text, filter signature, cursor/progress, status, result count availability, expiration, and error. Do not store unbounded article ID arrays. Use when ready search projection is missing. |
| `mart.review_title_search_serving_v4` | Optional compact token/prefix title search projection. | Store normalized token/prefix rows keyed by `project_id`, `search_identity`, `project_scope_identity`, `snapshot_id`, token/search key, and `article_id`. Add n-gram rows only if benchmarked and product-critical. Request paths and async jobs must not scan raw titles or rebuild for model/prompt changes. |
| `mart.review_article_serving_v4` | Compacted hot review-list/filter/count base for LLM, human, both, and unassessed modes. | Store small typed fields needed for list UI, filters, sorting, badges, selected external IDs, article timestamps required by current list responses, human status, LLM status, cursor sort keys, and count/facet membership. Key by project, component identities, optional review config hash for judgment-derived state, `snapshot_id`, list/filter/sort prefixes. The `_v4` table must exist alongside legacy `mart.review_article_serving` until cutover. |
| `mart.review_article_display_patch_v4` | Bounded display/payload-field patch rows/tombstones over a compacted base generation. | Key by project, display identity, base generation, patch watermark, article ID, and display sort/filter keys. Store only changed display fields. |
| `mart.review_selected_import_patch_v4` | Bounded selected-import patch rows/tombstones over selected-import base state. | Key by project, project-scope identity, selected-import snapshot ID, patch watermark, article ID, and selected-import sort/filter keys. Store only selected import/rank/display source fields. |
| `mart.review_llm_status_patch_v4` | Bounded LLM judgment-status patch rows/tombstones. | Key by project, review config hash, prompt config hash, base generation, patch watermark, list mode, article ID, prompt ID, and LLM status sort/filter keys. Store only LLM-derived status/badge fields. |
| `mart.review_human_status_patch_v4` | Bounded human judgment-status patch rows/tombstones. | Key by project, prompt config hash, base generation, patch watermark, list mode, article ID, prompt ID, and human status sort/filter keys. Store only human-derived status/badge fields. |
| `mart.review_queue_patch_v4` | Bounded queue ordering patch rows/tombstones. | Key by project, queue component identity, base generation, patch watermark, queue kind, priority bucket, sort key, and article ID. Store only queue membership/order fields. |
| `mart.review_article_filter_posting_patch_v4` | Bounded posting patch rows/tombstones for changed filter memberships. | Key by project, posting component identity, base generation, patch watermark, filter kind/value, list mode, sort key, and article ID. Store only added/removed posting memberships. |
| `mart.review_article_filter_posting_serving_v4` | Compact postings for synchronous filter combinations that are not ordered prefixes. | Key by project, required projection identities, optional review config hash, `snapshot_id`, filter kind/value, list mode, sort key, and article ID. Multi-filter reads must start from a bounded posting/projection or return async/unavailable. |
| `mart.review_filter_posting_stats_v4` | Incremental cardinality/selectivity stats for posting tables. | Key by project, projection identities, filter kind/value, list mode, and `snapshot_id`. Updated from contribution diffs so readers can choose a leading posting without scanning. |
| `mart.review_article_serving_payload_v4` | Optional detail payloads for larger JSON/raw metadata. | Load by `project_id`, display/payload identity, `snapshot_id`, and `article_id` only on detail routes, export jobs, prompt preview, or explicit capped hydration steps. Never join by default in hot list/count/filter reads and never rebuild for model/prompt-only changes. |
| `mart.review_article_judgment_detail_serving_v4` | Prompt/detail/list judgment payload rows. | Key by project, review config, snapshot, list mode, payload kind (`llm` or `human`), article, and prompt. List payload reads use article-set hydration and prompt-overlap row budgets. Detail reads may use deterministic list-mode priority only after article-scoped filtering keeps the window bounded. |
| `mart.review_article_summary_contribution_v4` | Previous per-article contributions for count/facet/badge/posting summaries. | Key by project, projection identities, optional review config hash, article ID, component kind, summary definition version, and contribution key. Enables exact `-old +new` summary updates. |
| `mart.review_article_count_serving_v4` | Precomputed count and badge values. | Key by `project_id`, required projection identities, optional `review_config_hash`, `snapshot_id`, `list_mode_key`, count kind, summary definition version, and filter key. Count SQL derives list mode from the named count key before falling back to a contract/global mode. Keep values small and nullable/stale-aware. |
| `mart.review_filter_facet_serving_v4` | Precomputed filter/facet values. | Key by `project_id`, required projection identities, optional `review_config_hash`, `snapshot_id`, summary identity/filter scope, facet kind, facet key/value, prompt ID, answer ID/value, and summary definition version. Serve review and human-specific filter UIs without grouping raw facts. |
| `mart.review_filter_option_serving_v4` | Precomputed filter option/min-max payload rows. | Key by project, review config, snapshot, search identity, filter option identity, filter kind, facet key, option value key, and option payload fields. A filter route cannot mount with facet rows alone when the UI expects option/min-max payloads. |
| `mart.review_unassessed_queue_serving_v4` | Optional unassessed queue candidate ordering. | Key by `project_id, review_config_hash, snapshot_id, priority_bucket, activity_sort_at, article_id`. Use contribution diffs for routine judgment changes and rebuild in chunks for definition/config changes. |

## Delta Ledger Guidance

Delta rows should describe what changed, not every product view affected by the
change. This keeps imports, judgments, human review, and project-config writes
cheap at million-scale.

- For imports, prefer route/article deltas with the common envelope plus `import_run_id`, `import_route_id`, `article_id`, source record key/hash, changed timestamp, compact rank/filter fields, and tombstone state.
- Define `change_kind` explicitly for creates, updates, removals, judgment changes, human judgment changes, article display/search/judgment-input changes, direct project-scope changes, and project config changes.
- Each `change_kind` must use the invalidation registry to produce affected projection components and keys. Do not let projectors infer broad invalidation from generic dirty flags.
- Write source mutations and delta rows in the same DuckDB transaction whenever the source write is local. If the source write cannot append the final delta row in that transaction, it must append `app.review_source_change_outbox` in the same durable source transaction and a reconciliation cursor must convert or quarantine it before dependent watermarks advance.
- Use deterministic idempotency keys for every delta/outbox write, such as source table, source row ID, source operation, source version/high-water mark, and change kind. Retried writes must not duplicate deltas or overlays.
- Treat reconciliation quarantine as a serving-indexing failure state for affected components. Do not skip or silently mark source high-water ranges complete when a delta is missing, malformed, or unmapped.
- Keep the invalidation registry as the only source of change-kind to affected-component mapping. Write paths supply source facts; they do not compute downstream projector fanout.
- Project config changes that affect model, prompt set/version, or title/abstract/fulltext flags produce a new review config identity only for judgment-derived projections. They reuse article/import/title/payload projections when those inputs are unchanged.
- For import route deltas, resolve affected projects in bounded projector work by joining route deltas to `app.project_import_route`.
- Only persist `affected_project_id` in an import-write transaction if route-to-project fanout is measured and bounded.
- Direct project membership writes already know the affected project and may write `projectScope.article.*` deltas directly. Import-route writes must not synthesize `projectScope.article.*` deltas synchronously.
- Article updates that change title, abstract, fulltext, source display fields, or search text should emit every applicable article delta in one transaction. A title change can affect display, search, and judgment-input identities; emitting only one of them is a failed source-delta test.
- LLM judgment deltas must include the persisted model ID and content flags from the actual judgment request profile. They must not infer or rewrite benchmark-critical settings during delta emission.
- Prompt/config deltas should carry the smallest changed field set that lets identity builders determine whether a prompt, review config, or summary definition changed. They do not mark unrelated article/import/search identities dirty.
- Keep large JSON, raw payloads, source records, and audit data out of the delta ledger.
- Pre-extract import hot fields in `app.review_import_article_hot_field` before or with the import delta. If a source record lacks a hot field, store a typed null/unavailable value rather than requiring projectors or foreground reads to parse raw JSON.
- Convert delta ranges into `app.review_serving_dirty_work` before expensive projections. Coalesce repeated changes for the same project/article/projection key to the latest source high-water mark.
- Projectors should consume dirty-work keys and high-water marks, not repeatedly rescan historical delta ledgers for every serving component.
- Record per-component dirty-work acknowledgements in the same transaction as output rows and watermarks. Components that already acknowledged a key/range skip it on later wakes.
- Store acknowledgements as component high-water rows or compressed contiguous key ranges whenever possible. Do not retain one ack row per dirty key/component forever.
- Compact dirty work and acknowledgements together after every required consumer has acknowledged the range and optional consumers have either acknowledged, expired, or moved to async/unavailable state.
- Retain raw delta ledgers only as long as replay, audit, and lagging projectors require them. Compact or archive ranges after every consumer watermark has advanced past them.
- Make projector output idempotent by `(project_id, source_delta_high_water, article_id)` or snapshot/base-scoped keys.
- Use tombstones for deletes and membership removals so replay can retract stale serving rows.
- Advance projector watermarks in the same transaction as the output rows they describe.
- Judgment, human-review, prompt/config, and project-scope deltas should carry enough stable keys to mark exactly affected project/article serving rows dirty without scanning all judgments.

## Performance Rules

- Product review routes read only from `mart.review_article_serving_v4` and keyed payload/detail tables after cutover.
- Product review routes include LLM, human, both, unassessed, filters, facets, badges, counts, rows, queues, bulk actions, PDF fetch, and export entrypoints.
- Product review routes do not call raw fallback, even when serving is stale or missing.
- Product review routes include only the projection identity keys they need. Judgment-derived reads include `review_config_hash`; article/import/title/payload reads use narrower identities and must not rebuild for model/prompt-only changes.
- Normal foreground DuckDB work must come from registered read/job contracts. Ad hoc product SQL is rejected before execution, even if a rough estimate appears small.
- Initial index missing means return indexing state and empty rows, not a raw scan.
- Dirty index means return stale serving rows plus progress state.
- Failed index means return the last known-good snapshot plus failure state, not a raw scan.
- Serving snapshot promotion must be all-or-nothing through a manifest.
- Serving manifests distinguish route-required components from optional search/count/job components so optional work does not block unrelated hot reads.
- Exactly one normal V4 serving writer may write `mart.review_*_v4` rows and promote active V4 snapshots.
- Routine deltas promote logical snapshots with bounded patches; they do not copy all rows for a 10M-article project.
- Projector wakes start at the first affected component declared by the invalidation registry. Judgment-only and human-review changes must not run selected-import, display, payload, or search projectors.
- Prompt config changes are prompt-scoped. One prompt change must not rebuild unchanged prompt projections or summaries.
- Article display, search, and judgment-input content identities are separate. Display-only edits must not rerun search or judgments; search-only edits must not rerun judgments; judgment-input changes affect only affected article/config/prompt facts.
- Patch reads are allowed only while the patch set stays under validated hot-read budgets. A candidate snapshot that exceeds the patch budget must compact into a new major base before activation.
- Patches are component-narrow. Do not write row-wide hot patches when only display, selected-import, LLM status, human status, queue, posting, or search fields changed.
- Large append imports create append/patch partitions first and compact only when read budgets or storage policy require it; they do not automatically rebuild the full existing base.
- Foreground routes must verify they are reading one active snapshot with one composed identity set, not mixed rows/counts/facets from incompatible snapshots or identities.
- Hot serving tables must be physically written in snapshot/filter/sort order that matches the registered read contracts.
- Use keyset pagination, not offset pagination, for hot review lists.
- Cursors must include the route's projection identities, `snapshot_id`, component base/patch state, filter signature, sort direction, sort values, and article ID.
- Cursor mismatch means restart from page one or return cursor-invalid state; never continue against a different snapshot/filter/component state.
- Cursor projection-identity mismatch means cursor-invalid; never read a serving snapshot built from a different identity set.
- Every synchronous filter must use an ordered prefix, filter posting table, compact projection, or pre-proven bounded candidate set. Otherwise return unavailable or async state.
- Filtered list reads must not use direct ordered-prefix row contracts unless those contracts bind every advertised filter. Use posting/search selection plus article-set row hydration when the filter predicate is not part of the row-table prefix.
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
- Repeatable bulk/export/PDF/search jobs must pin the serving snapshot they read. Latest-snapshot jobs must declare that they may restart if the active snapshot changes.
- Durable job lookups must bind job kind, filter signature, and search mode/text when relevant. They use `updated_at`/`job_id` cursors and must support explicitly declared latest-snapshot rows with `snapshot_id IS NULL` where the schema allows them.
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
- Health and warning reads choose usable manifests explicitly, such as active or last-known-good/retired state, and do not let newer candidate/failed manifests masquerade as readable snapshots.
- Prefer clear cutovers that rebuild obsolete intermediate state over compatibility shims that keep old and new paths alive.

## Cutover Gate

Cutover can happen route-by-route in Phase 4 after route-specific gates pass.
Final cutover is complete only after every implementation phase above is
complete and no normal product review flow can reach legacy raw fallback.

### Final Cross-Phase Audit - 2026-06-20

- Phase 0 through Phase 4 implementation evidence is aligned with the phase files: route/job migration, residual-read classification, parity evidence, browser diagnostics, desktop build evidence, and broad lint evidence are now recorded.
- Phase 5 implementation hardening and repo-native synthetic release-gate validation are recorded, but final cutover remains open. No true 10M DuckDB release-scale run, physical row-group/rows-scanned profile, temp-dir/RSS/latency profile, large local desktop sleep/process-kill simulation, or release-scale compaction proof exists in this branch.
- Master checkboxes that require true physical release evidence remain unchecked. Synthetic fixture/report validation may be checked only as synthetic validation and must not be treated as the physical 10M pass.
- `OOM_ERRORS.md` already records the Phase 5 desktop DuckDB runtime-memory default; this final audit did not add a new OOM or runtime-memory implementation change.

- [ ] [Phase 0](./DUCK_CQRS_PLAN_PHASE_0.md) contracts, module boundaries, static guards, and benchmark harness are complete.
- [ ] [Phase 1](./DUCK_CQRS_PLAN_PHASE_1.md) schema and DuckDB workload-admission foundations are complete.
- [ ] [Phase 2](./DUCK_CQRS_PLAN_PHASE_2.md) write-side deltas, hot-field extraction, and read-your-write state are complete.
- [ ] [Phase 3](./DUCK_CQRS_PLAN_PHASE_3.md) projectors, selected-import projection, serving projections, manifests, and cleanup are complete.
- [ ] [Phase 4](./DUCK_CQRS_PLAN_PHASE_4.md) production route migration, jobs, search, route-specific parity, and DuckDB usage migration are complete.
- [ ] [Phase 5](./DUCK_CQRS_PLAN_PHASE_5.md) remaining raw fallback deletion, desktop hardening, final benchmark, and repo quality gates are complete.
- [ ] Route-specific parity validation has passed for semantic fixtures, sampled safe-size parity, named counts, freshness states, cursor behavior, SQL shape, latency, and response-size budgets for every migrated route/flow.
- [ ] A single normal V4 serving writer owns all `mart.review_*_v4` writes and active V4 snapshot promotion; legacy mart refresh/rebuild paths cannot promote competing V4 review snapshots.
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
- [ ] Filtered list routes prove posting/search selection plus article-set hydration, including stable list-mode and article-ID tie-break ordering.
- [ ] List/detail judgment payload contracts preserve LLM, human prompt-mode, human summary-mode, and both-mode payloads without single-article N+1 lookups.
- [ ] Count, facet, option, and durable job contracts include duplicate/conflict/date/search/list-mode/filter-signature scope where the current product flow applies it.
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
- Do not treat every routine delta as a full project serving snapshot/base copy.
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

Phase-local quality gates live in the phase files and must pass before that phase
is treated as complete. This master tracks only final cross-phase gates.

- [ ] [Phase 0](./DUCK_CQRS_PLAN_PHASE_0.md) quality gates pass.
- [ ] [Phase 1](./DUCK_CQRS_PLAN_PHASE_1.md) quality gates pass.
- [ ] [Phase 2](./DUCK_CQRS_PLAN_PHASE_2.md) quality gates pass.
- [ ] [Phase 3](./DUCK_CQRS_PLAN_PHASE_3.md) quality gates pass.
- [ ] [Phase 4](./DUCK_CQRS_PLAN_PHASE_4.md) quality gates pass for every migrated route/flow.
- [ ] [Phase 5](./DUCK_CQRS_PLAN_PHASE_5.md) final hardening and release gates pass.
- [x] 10M-article/7-prompt benchmark fixture or synthetic equivalent is available and documented.
- [ ] Overlap benchmark passes under target DuckDB memory limits with import, dirty materialization, serving refresh, review list, filters, counts, bulk jobs, export/PDF jobs, and desktop-style interruption/resume.
- [x] Synthetic benchmark/release-report validation records p50/p95/p99 latency, peak process memory, DuckDB memory limit, temp-dir growth, queue depth, admitted/rejected query counts, rows scanned, rows returned, and active snapshot/identity state.
- [x] Synthetic benchmark validation proves foreground review read reports are bounded by page size, selected filter postings, or precomputed summary rows, not total project article/judgment/import-route count.
- [x] Synthetic benchmark validation rejects wrong or missing request dimensions, including list mode, queue kind, search mode/text, named count key/filter prefix, job kind/filter signature, request-slice diversity, scanned-row ceilings, temp spill, latency, and RSS budgets.
- [ ] Every product review route has a `reviewServingReadContracts.ts` registry entry with workload class, cursor spec, narrow projection identity behavior, budgets, allowed filters, physical filter access strategy, and named fast counts.
- [ ] Every normal foreground DuckDB call is traceable to a registered read/job contract; unregistered foreground calls fail tests before query execution.
- [ ] Every row in the DuckDB usage migration inventory is either migrated to serving/admission/job logic or explicitly classified as admin/maintenance/debug-only.
- [ ] No normal browser or desktop review flow can reach raw fallback, `selected_scoped_article_import`, raw project-wide scans, unbounded ID materialization, or large-offset pagination.
- [x] `bun run lint`
- [ ] `bun run db:mig` if schema/projection migrations are added.
- [ ] Add an `OOM_ERRORS.md` entry in the same change as any OOM fix implementation.
