# Review-Serving Post-Import Mart Creation Performance PLAN

## Context

Project-transfer import commit can now load judgment-heavy packages, but the
user-visible review pages are only fast once the imported project has usable
review-serving V4 snapshots and serving marts. This plan is about reducing the
time from a completed import commit to a project whose review pages can use the
serving marts without slow missing-snapshot repair.

This is not the same as DuckDB owner startup time, selected-import physical
evidence script time, or generic route-query latency. Those may share some
tables and diagnostics, but this plan's target is post-import mart creation for
the imported project.

Existing adjacent work:

- `plans/old/REVIEW_SERVING_REBUILD_SPEED_PLAN.md` optimized the generic V4
  missing-snapshot rebuild path and is marked complete for production-safe
  single-writer execution.
- `plans/old/PERF_BENCH_PLAN.md` defines planned physical DuckDB benchmark
  infrastructure, but does not yet give an import-to-review-ready metric.
- `docs/review-serving-selected-import-further-work-PLAN.md` targets
  selected-import evidence-query/operator cost, not post-import serving
  creation.

## Goal

Make large imported projects become review-page-ready faster after commit,
without weakening snapshot correctness, single-writer DuckDB safety, or the V4
serving ownership boundaries.

Current focus: optimize the physical mart shape used during post-import review
serving creation. Admission/scheduling remain tracked below, but the next slice
should first prove which hot table shape is paying the most write, payload, or
validation cost.

Primary metric:

- `import commit completed_at -> first active review-serving snapshot with all
  review-page-critical components ready`

Secondary metrics:

- Time from commit completion to first admitted rebuild request.
- Time from rebuild request admission to first user-visible review list
  readiness.
- Per-component wall time and rows/sec for `projectScope`, `selectedImport`,
  `display`, `llmStatus`, `humanStatus`, `queue`, `search`, `payload`,
  `posting`, and `summary`.
- Worker idle gaps between commit completion, delta intake, rebuild admission,
  chunk execution, request finalization, and snapshot promotion.
- DuckDB owner responsiveness and RSS/temp-spill behavior during the build.

## Shape-First Baseline

Start with a current-DB heavy import replay rather than synthetic assumptions.
Use a package close to the known heavy case:

- around `18,784` articles
- around `67,463` LLM judgment rows
- around `18,784` human judgment summaries
- selected-import data present

Capture shape evidence first:

1. Import session id, source package fingerprint, imported project id, and git
   SHA.
2. Rebuild chunk/request timing summary from
   `bun run db:duck:inspect-review-serving-rebuild-timings -- --project-id=<id>`.
3. Per-component rows, write/validation timings, and estimated/actual
   output/payload/temp bytes.
4. Hot-table physical shape estimates for posting arrays, queue arrays,
   judgment-detail scalar/array payloads, selected-import current/staging, and
   summary accumulator/finalization tables.
5. Table-level storage diagnostics for the leading one or two byte-heavy
   candidates.
6. API, DuckDB-owner, and judge readiness during the run.
7. RSS/temp-dir samples while the maintenance owner builds marts.

Capture admission/scheduling evidence second:

1. Commit start/end timestamps from project-transfer session/history.
2. First `missingReviewServingSnapshot` or post-import rebuild request id.
3. Review-page readiness/warnings before, during, and after rebuild.

Do not optimize a table shape before this baseline exists. The old rebuild-speed
plan is useful context, but the current imported-project workload may have
different dominant costs.

Known heavy replay fixture:

- source project `d03fe24a-cfcf-41ed-b09f-7b554a393d80`
  (`cov | GPT 5.5 xhigh | 5`)
- package `/tmp/project-transfer-d03-67463.zip`
- package fingerprint
  `3f97a7738e0b65489391c688bd4da9608e1b667a02ff2db5e54022f730eb356b`
- successful replay session `bdfc22c0-19ef-4fa7-b77a-8c5ebdd69d2b`
- imported project `84d27e5a-c032-445b-a308-48625c96d010`
- shape: `18,784` articles, `67,463` judgments, `18,784` human judgment
  summaries, `6` prompts, `1` model/provider

## Investigation Questions

### 1. Is post-import rebuild requested early enough?

Project-transfer commit appends V4 import, project-scope, review-config, LLM,
human, and import-run deltas. The worker later intakes deltas and may request a
`missingReviewServingSnapshot` rebuild when serving snapshots are absent.

Check whether imported projects wait for a user route or normal worker wake
before the full review-serving build is requested.

Evidence to collect:

- Commit completion timestamp.
- Earliest unreconciled delta timestamp for the imported project.
- Earliest dirty-work row timestamp.
- Earliest rebuild request timestamp.
- Whether the first review-page request had to discover missing serving state.

Potential fix if this is slow:

- Have import commit explicitly request or boost a foreground
  `missingReviewServingSnapshot` rebuild for the new project after deltas are
  durable.
- Preserve idempotency by reusing the existing active-request lookup.
- Do not run projector writes inline in the commit transaction.

### 2. Are imported projects scheduled with the right priority?

The imported project is usually foreground work: the user just imported it and
is likely to open review pages immediately. Treating it like generic background
dirty work can delay readiness behind unrelated rebuild or cleanup work.

Evidence to collect:

- Rebuild request priority for the imported project.
- Claim order relative to other pending chunks.
- Worker cycles spent on unrelated work before imported-project chunks.
- Whether `failInconsistentAndSupersededForegroundRebuildRequests` or priority
  boosting changes the request after the first route hit.

Potential fix if this is slow:

- Introduce a bounded post-import foreground priority window.
- Boost only the imported project's initial missing-snapshot request.
- Keep fairness: short TTL or chunk quota, then yield.

### 3. Which components dominate imported-project build time now?

The old speed plan removed many known hotspots. Re-measure the current workload
instead of assuming old bottlenecks still dominate.

Use existing chunk diagnostics:

- `duration_ms`
- `actual_output_rows`
- `diagnostics_json.phaseTimings`
- writer diagnostics
- validation mode

Likely candidates to inspect:

- `search`: token/index row volume.
- `posting`: filter fanout.
- `summary`: final count/facet aggregation and request finalization.
- `queue`: source judgment joins.
- `selectedImport`: base/current publication and direct serving refresh.

Potential fixes depend on measured phase:

- Source query slow: add bounded predicates, better join order, or staging
  tables for the import project's exact active snapshot.
- JS transform slow: move remaining transform to SQL-native statements.
- Writer slow: combine compatible chunks into one SQL-native multi-range write.
- Validation slow: use proportional validation where no strict checksum is
  required.
- Finalization slow: reduce request-scoped partials in bounded batches.

### 4. Does import commit already know enough to seed build state cheaply?

The import package and commit plan know row counts, dependency choices, project
scope, providers/models, prompt counts, judgment counts, and source payload
shape. Some rebuild admission estimates currently re-query current DB state.

Check whether post-import rebuild admission repeats expensive discovery that the
commit already computed.

Potential fix if this is slow:

- Persist an import-completion review-serving build hint with exact counts and
  component expectations.
- Let rebuild admission consume the hint only when it matches current source
  watermarks and project identity.
- Fall back to current DB stats when the hint is absent or stale.

### 5. Can the imported project use a pre-warmed candidate snapshot?

For very large packages, the fastest review-page readiness may come from
creating the rebuild request and candidate snapshot immediately after commit,
then letting chunks fill it under the normal maintenance owner.

Potential fix if safe:

- Add a post-import "prepare serving snapshot" step that admits the rebuild and
  seeds bootstrap chunks in the same durable owner transaction used for the
  rebuild request.
- Keep final snapshot promotion unchanged.
- Do not expose partially built candidate rows to readers.

### 6. Are the serving mart schemas carrying dead or cold columns?

The rebuild can be SQL-native and still slow if hot tables carry wide payloads,
unused columns, duplicated denormalized state, or indexes that must be maintained
during bulk creation but are not needed by review-page reads. Schema slimming is
especially plausible for imported projects because the initial build writes a
large contiguous set of rows before any user benefits from the extra physical
state.

Evidence to collect:

- Per-table row counts, bytes, and payload bytes for the imported project's
  active/candidate snapshot.
- Which review-page routes actually read each column in `selectedImport`,
  `display`, `payload`, `posting`, `queue`, and `summary` serving tables.
- Whether rebuild writers populate columns that are only used by old
  compatibility views, operator diagnostics, or retired fallback paths.
- Index/update cost for columns that are not used in the critical first review
  page.
- Whether wide JSON/detail payloads can be moved behind a lazy/detail-only
  table without making normal review list queries slower.
- Whether existing chunk metrics (`actual_output_bytes`,
  `actual_payload_bytes`, and `diagnostics_json.phaseTimings`) are sufficient
  to rank tables, or whether the rebuild timing inspector needs a physical
  table-size section.

Potential fixes if this is measured as a bottleneck:

- Drop retired compatibility columns from mart tables through explicit
  repair-table migrations.
- Split hot list/readiness columns from cold detail/debug payload columns.
- Defer non-critical derived columns until after first review-list readiness.
- Remove indexes or uniqueness constraints that are no longer read-path or
  correctness-critical.
- Keep operator-only evidence state out of the hot serving tables unless it is
  also needed for correctness.

Current schema context:

- Several slimming migrations have already landed for review-serving hot
  tables, including display-copy, full-text-copy, payload-byte,
  source-metadata/debug, list-mode-key, placeholder, and hot-index cleanup.
  Treat that as proof that physical shape matters here, but not as proof that a
  new column drop is still available.
- Recent migrations also rebuilt hot serving tables without several repair or
  lookup indexes, so any new index removal must be justified by current
  route-read evidence and rebuild timing.
- `app.review_rebuild_chunk_manifest` already records output/payload/temp byte
  estimates and actuals, plus write/validation timings. Prefer extending that
  evidence path before adding another ad-hoc profiler.

Initial route/schema audit:

- `posting` is the highest-risk physical shape. It is compact by row count, but
  stores `article_ids VARCHAR[]`; normal filter/count paths unnest that array,
  and validation also unnests it. Treat this as an array-payload/validation
  candidate, not as an unused-column candidate.
- `judgment detail` is high-cardinality (`article x prompt x payload kind`) and
  still carries `answered_original`, `answered_original_as_array`, and
  `human_comment`. The heavier model/explanation/quote/prompt metadata has
  already been split or rehydrated from app tables, so the current table should
  be measured before further slimming.
- `queue` has a narrower article-rank serving table for normal unassessed page
  reads. The wider `mart.review_unassessed_queue_serving_v4.prompt_ids` array is
  a cold/readiness-or-operator candidate unless measured route evidence says the
  normal review page needs it.
- `summary` finalization tables are not normal route tables. The accumulator
  carries repeated string keys plus `source_chunk_ids_key`; if summary dominates,
  prefer measuring accumulator bytes/finalization batches before changing final
  count/facet serving tables.
- `selectedImport` current is already fairly narrow. The cold-looking published
  fields are `selected_rank_key`, `selected_rank_numeric`, and
  `selected_import_updated_at`; staging is wider by design because it carries
  projection identity, watermarks, partition, publish key, and publish state.
- Most hot rebuild tables are now intentionally no-index/no-primary-key physical
  tables. The likely remaining costs are table width, array payload bytes,
  DELETE/INSERT scans, and validation scans more than index maintenance.

Useful measurement queries:

```sql
SELECT
  projection_component,
  status,
  count(*) AS chunks,
  sum(actual_output_rows) AS rows,
  sum(actual_output_bytes) AS output_bytes,
  sum(actual_payload_bytes) AS payload_bytes,
  avg(try_cast(json_extract_string(diagnostics_json, '$.phaseTimings.writeOutputMs') AS double)) AS avg_write_ms,
  avg(try_cast(json_extract_string(diagnostics_json, '$.phaseTimings.validationMs') AS double)) AS avg_validation_ms
FROM app.review_rebuild_chunk_manifest
WHERE project_id = $project_id
GROUP BY 1, 2
ORDER BY payload_bytes DESC NULLS LAST, rows DESC NULLS LAST;
```

```sql
SELECT
  'posting' AS table_name,
  count(*) AS rows,
  sum(length(cast(article_ids AS varchar))) AS payload_bytes
FROM mart.review_article_filter_posting_serving_v4
WHERE project_id = $project_id
UNION ALL
SELECT 'queue', count(*), sum(length(cast(prompt_ids AS varchar)))
FROM mart.review_unassessed_queue_serving_v4
WHERE project_id = $project_id
UNION ALL
SELECT 'detail', count(*),
  sum(length(coalesce(answered_original, ''))
    + length(cast(coalesce(answered_original_as_array, []::varchar[]) AS varchar))
    + length(coalesce(human_comment, '')))
FROM mart.review_article_judgment_detail_serving_v4
WHERE project_id = $project_id;
```

For table-level physical storage, use DuckDB storage diagnostics on each hot
table, for example:

```sql
SELECT
  table_name,
  column_name,
  sum(total_compressed_size) AS compressed_bytes
FROM pragma_storage_info('mart.review_article_filter_posting_serving_v4')
GROUP BY 1, 2
ORDER BY compressed_bytes DESC;
```

## Implementation Slices

### Slice 1: Shape-First Baseline Report

Add or improve operator tooling so a single command/report can answer:

- component timing summary
- component output/payload/temp byte summary
- hot-table row and approximate payload byte summary
- leading array/scalar payload columns for physical-shape candidates
- optional storage diagnostics for the selected hot table

Prefer extending the existing rebuild timing inspector over adding a new
parallel script, unless the table-shape queries become too large for the timing
report.

Acceptance criteria:

- Report works for a known imported project id.
- Report includes component timing, row counts, and estimated/actual
  output/payload/temp bytes.
- Report includes approximate payload bytes for `posting.article_ids`,
  `queue.prompt_ids`, judgment-detail answer/comment fields, selected-import
  current/staging rows, and summary accumulator/finalization rows when those
  tables exist.
- Operator output is clear enough to identify the first bottleneck without
  manually joining chunk, table, and storage diagnostics.

Current progress:

- The existing rebuild timing inspector now includes grouped estimated/actual
  output, payload, and temp byte aggregates from
  `app.review_rebuild_chunk_manifest`.
- The same inspector now emits an optional `physicalShape` section when
  `--project-id` is supplied. It reports posting `article_ids`, queue
  `prompt_ids`, judgment-detail answer/comment fields, selected-import
  current/staging rows, and summary accumulator string-key payload estimates.
- The physical-shape section tolerates absent tables and older table shapes
  where an optional array column is not present.
- A first posting-shape implementation is in progress: batched/ranged full
  rebuild writes now append segmented posting rows instead of merging large
  `article_ids` arrays back into one physical row per posting key, and cheap
  posting validation counts array lengths instead of unnesting arrays only to
  count them.
- Fresh heavy import replay `1574b432-49b1-4dda-913e-d930aecdd72a` completed
  for package fingerprint
  `3f97a7738e0b65489391c688bd4da9608e1b667a02ff2db5e54022f730eb356b`,
  creating project `9e25a18e-ad15-4d34-b999-608902e6d7a1` with `18,784`
  articles, `67,463` judgments, and `18,784` human judgment summaries.
- Live current-DB gate started a foreground missing-snapshot rebuild for that
  imported project. API, maintenance/DuckDB-owner, and judge readiness stayed
  healthy; progress was visible in rebuild counters (`projectScope` completed,
  then `selectedImport`, `judgmentInputContent`, and `payload` chunks advanced).
- Remaining gap: capture a posting-specific post-change timing artifact once
  the existing heavy rebuild reaches the posting component, or run a narrower
  posting-only gate against a clean/current project state.

### Slice 2: Optimize `posting.article_ids` Physical Shape

First implementation target: reduce the cost of repeatedly merging large
`article_ids VARCHAR[]` arrays during post-import full-rebuild posting chunks,
without changing route-visible table contracts or adding a migration.

Expected first shape:

- Keep `mart.review_article_filter_posting_serving_v4.article_ids` for the
  current public read contract.
- For batched/ranged full rebuilds, keep subtracting the chunk/range article ids
  from existing rows, then append the rebuilt chunk's compact posting rows as
  independent physical segments.
- Do not run the wide-array merge `UPDATE` or `WHERE NOT EXISTS` suppression for
  those batched range inserts.
- Preserve incremental dirty-claim behavior for now; those smaller updates can
  still merge into existing arrays.
- Make cheap posting validation count array lengths directly instead of
  unnesting arrays just to count rows.
- Treat a fully normalized scalar membership table as the follow-up shape if the
  heavy replay still shows posting arrays dominate after segmented writes.

Why this cut first:

- It attacks the widest write path in the post-import rebuild while keeping
  existing review-page SQL, retention cleanup, startup probes, and migrations
  unchanged.
- Existing read paths already unnest all matching posting rows and de-duplicate
  article ids for the important filter/count cases, so multiple physical rows
  per posting key are compatible with the intended logical contract.
- The normalized scalar membership table remains promising, but it touches
  migrations, readers, dynamic counts, bulk jobs, retention, startup probes, and
  benchmark gates. Do that as a separate PR with replay evidence from this
  smaller cut.

Expected code areas for the implementation PR:

- Posting component writer and validation code under
  `src/server/reviewServing/`.
- Worker chunk validation paths that count posting output rows.
- Rebuild timing/physical-shape diagnostics so the report shows posting header
  rows, array payload bytes, write time, and validation time.
- Focused adjacent tests proving batched/ranged rebuilds append segmented rows
  while incremental dirty-claim writes still merge/update as before.

Safety constraints:

- Do not weaken V4 snapshot promotion, candidate isolation, retention cleanup,
  or selected-import ownership boundaries.
- Do not introduce a second source of truth. The first slice still uses
  `article_ids`; it only changes how range rebuild segments are physically
  appended.
- Do not trust imported package data for serving marts. The scalar membership
  table must still be derived from current app/project state during rebuild.
- Do not add unbounded background scans over historical posting rows. Scope
  writes, deletes, cleanup, diagnostics, and validation by project, snapshot,
  candidate request, chunk range, or active snapshot.
- Do not add indexes or uniqueness constraints unless the measured route path
  or correctness checks require them; hot rebuild tables are intentionally
  mostly index-free.
- Preserve logical filter results when multiple physical posting rows share the
  same `(project_id, review_config_hash, snapshot_id, filter_kind,
  filter_value, list_mode_key)`.
- If the change exposes a DuckDB OOM or WAL/checkpoint failure, preserve
  evidence, fix the lifecycle/root cause, add a targeted regression test, and
  update `OOM_ERRORS.md` when the issue is an OOM.

Quality gates:

- Focused posting writer/validation tests adjacent to the changed
  `src/server/reviewServing/` code.
- Focused review-page route/query tests proving filter counts and filtered
  article lists match the old `article_ids` behavior.
- `bun test src/server/workers/reviewServingProjectorWorker.test.ts`
- `bun test src/server/reviewServing/reviewServingChunkManifestRepository.test.ts`
  if diagnostics or chunk-manifest byte reporting changes.
- `bun test scripts/operatorScriptDuckdbAccess.test.ts` if the rebuild timing
  inspector or physical-shape report changes.
- Targeted `bunx eslint` for touched TypeScript files.
- `git diff --check`.
- No `bun run db:mig` gate for the first segmented-write slice because it has no
  migration. Add it when the follow-up scalar membership table is implemented.
- Current-DB live progress gate: API readiness, maintenance/DuckDB-owner
  readiness, before/after project rebuild counters or `lastProgressedAt`, and
  no fatal DuckDB owner restart, WAL/checkpoint failure, OOM, or crash loop.

67k heavy replay validation:

1. Start from the known package
   `/tmp/project-transfer-d03-67463.zip` with fingerprint
   `3f97a7738e0b65489391c688bd4da9608e1b667a02ff2db5e54022f730eb356b`.
2. Capture a before artifact from the current array shape using imported project
   `84d27e5a-c032-445b-a308-48625c96d010` when still available, or a fresh
   replay of the same package if not. Record git SHA, import session id,
   imported project id, article/judgment/human-summary counts, and
   `bun run db:duck:inspect-review-serving-rebuild-timings -- --project-id=<id>`
   output.
3. Apply the posting-shape implementation and replay the same package into a
   fresh imported project. Do not compare against a different source package or
   smaller synthetic fixture.
4. During the rebuild, sample API readiness, DuckDB-owner readiness, RSS/temp
   behavior, and project progress counters before and after a short interval.
5. Compare posting component `duration_ms`, write phase, validation phase,
   output rows, payload bytes, temp bytes, and table-level storage diagnostics
   for posting header plus scalar membership tables.
6. Confirm the imported project promotes an active review-serving snapshot and
   normal review list/filter routes return the same counts and filtered article
   sets as the before artifact for representative prompt/status/filter cases.
7. Report regressions in other critical components (`selectedImport`, `display`,
   `queue`, `search`, `payload`, and `summary`) instead of claiming a posting
   win in isolation.

### Slice 3: Request Post-Import Serving Build Explicitly

If shape work is not the bottleneck, or if Slice 1 also shows rebuild admission
waits for route discovery or normal dirty work intake, wire import completion to
request or boost the imported project's missing-snapshot rebuild.

Constraints:

- Deltas must already be durable before requesting the rebuild.
- No projector mart writes inside the import commit transaction.
- Existing active rebuild requests must be reused/boosted, not duplicated.
- Terminal failed sessions must not request new serving work.

Acceptance criteria:

- A completed import creates or boosts exactly one rebuild request for the new
  project when no active snapshot exists.
- Repeated completion/recovery is idempotent.
- Existing active requests are not duplicated.
- Imported project warnings/readiness can report that serving build is queued or
  running immediately after commit.

### Slice 4: Foreground Scheduling For Newly Imported Projects

If admitted rebuilds still wait behind unrelated work, add a bounded foreground
priority lane for newly imported project serving creation.

Constraints:

- Do not starve global maintenance.
- Do not bypass component prerequisites.
- Keep RSS and batch-size caps active.

Acceptance criteria:

- Fresh imported-project chunks are claimed before lower-priority background
  chunks for a bounded TTL or chunk quota.
- Worker diagnostics show no unbounded foreground loop.
- Current-DB progress evidence shows the imported project advances while API and
  owner readiness remain healthy.

### Slice 5: Non-Shape Component Hotspot Fix

Pick exactly one measured component hotspot from Slice 1/2/3 evidence. Do not
optimize multiple components in one PR unless the same query shape causes the
same measured bottleneck.

Candidate examples:

- `search` source-query/token write path
- `posting` high-fanout filter rows
- `summary` finalization/reduction
- `queue` judgment source joins
- `selectedImport` publication/direct serving refresh
- `judgment detail` high-cardinality scalar/array payload writes

Acceptance criteria:

- Before/after timing artifact uses the same imported package/project shape.
- Correctness tests cover the changed component.
- Rebuild timing inspector shows target improvement without hiding regressions
  in other critical components.

### Slice 6: Physical Schema Slimming For A Measured Hot Table

If the baseline shows that a hot rebuild component is dominated by wide-row
writes, payload bytes, index maintenance, or dead-column population, make one
schema-focused change for that table/component.

Constraints:

- Start from route-read and writer-read evidence; do not remove columns by
  inspection alone.
- Use explicit DuckDB repair-table migrations when dropping columns from
  existing physical tables.
- Keep active/candidate snapshot compatibility, retention, and rollback
  semantics intact.
- Do not bundle unrelated schema cleanup with the measured performance fix.

Acceptance criteria:

- The removed or split columns are proven unused by normal review-page routes
  or moved to a cold path with tests.
- Before/after evidence includes table bytes/payload bytes and component
  rebuild timing for the same imported-project shape.
- Migration tests or schema-history checks cover the new physical shape.
- Current-DB live progress evidence shows rebuild still promotes a correct
  serving snapshot after the migration.

## Required Gates

For instrumentation-only changes:

- `bun test src/server/reviewServing/reviewServingChunkManifestRepository.test.ts`
- `bun test scripts/operatorScriptDuckdbAccess.test.ts`
- Targeted `bunx eslint` for touched files.
- `git diff --check`.

For import-trigger or scheduling changes:

- `bun test src/server/services/projectTransfer/projectTransferCommit.test.ts`
- `bun test src/server/services/projectTransfer/projectTransferCommitRecovery.test.ts`
- `bun test src/server/workers/reviewServingProjectorWorker.test.ts`
- `bun test src/server/reviewServing/reviewServingV4RebuildRequestService.test.ts`
- Relevant warnings/readiness route tests.
- Targeted `bunx eslint` for touched files.
- `git diff --check`.

For component rebuild performance changes:

- The focused projector/component tests for the changed component.
- `bun test src/server/workers/reviewServingProjectorWorker.test.ts`
- `bun run bench:review-serving-release-gate` when release-gate output or
  benchmark-critical behavior changes.
- Current-DB live progress gate: API readiness, DuckDB-owner readiness, before
  and after project rebuild counters/timestamps, and no fatal DuckDB restart,
  WAL/checkpoint, OOM, or owner crash-loop logs.

For any PR that claims faster post-import readiness:

- Include the before/after import-to-review-ready timing artifact.
- Include the imported package/project shape.
- Include current-DB progress evidence.

For physical schema slimming changes:

- The focused route tests proving review list/details still read the expected
  fields.
- The focused projector/writer tests for the affected table.
- Schema-history or migration coverage for the repair-table/drop/split shape.
- Current-DB row/byte evidence before and after the schema change.

## Non-Goals

- Do not import derived review-serving mart tables from the package as trusted
  data.
- Do not expose candidate snapshot rows before final promotion.
- Do not add a second DuckDB writer or enable true multi-writer rebuild writes.
- Do not weaken selected-import current/staging ownership guards.
- Do not solve operator physical-evidence script cost in the same PR unless it
  blocks the baseline report.
- Do not use route-level raw fallback speed as proof that mart creation got
  faster.

## New Session Prompt

```text
We are in `/Users/fredrik/Developer/forska.ai`. Continue the post-import
review-serving mart creation performance work from
`docs/review-serving-post-import-mart-creation-performance-PLAN.md`.

Goal: reduce time from project-transfer import commit completion to review-page
serving readiness for judgment-heavy imported projects.

Start by reading:
- `docs/review-serving-post-import-mart-creation-performance-PLAN.md`
- `plans/old/REVIEW_SERVING_REBUILD_SPEED_PLAN.md`
- `TESTS.md`
- `scripts/inspectReviewServingRebuildTimings.ts`
- `src/server/reviewServing/reviewServingV4RebuildRequestService.ts`
- `src/server/workers/reviewServingProjectorWorker.ts`
- relevant `src/server/services/projectTransfer/*Commit*` files

Choose the next coherent slice:
1. build an import-to-review-ready timing baseline/report;
2. explicitly request/boost serving rebuild after successful import commit if
   the baseline proves rebuild admission is delayed;
3. add bounded foreground scheduling for newly imported projects if admission is
   fast but execution waits behind unrelated work; or
4. optimize one measured component hotspot; or
5. slim/split one measured hot mart table if table bytes, dead columns, or
   index maintenance are proven to dominate creation time.

Do not run projector writes inside import commit. Do not duplicate active
rebuild requests. Do not weaken snapshot promotion, selected-import ownership,
or DuckDB single-writer safety. Do not remove columns without route-read and
writer-read evidence. Include before/after current-DB evidence before claiming
performance improvement.
```
