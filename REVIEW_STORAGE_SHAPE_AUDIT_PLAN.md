# Review Storage Shape Audit Plan

## Purpose

Define how to inspect every project-review API and database path before changing
the storage model. The later audit should determine which data:

- must remain in a read-optimized mart
- belongs in an authoritative `app.*` source table
- belongs in a compact reusable fact or lookup table
- should move to keyed payload or local file storage
- can be derived after a bounded article selection
- is temporary control state with a clear retention rule
- is redundant or unused and can be deleted

This document defines the investigation strategy only. It does not approve any
schema change or deletion.

The audit's result must be written to a new repo document named
`STORAGE_SHAPE_AUDIT_PLAN.md`. That output file is the durable audit artifact:
it should contain the completed inventories, table and column census, evidence,
dispositions, unresolved questions, and recommended implementation slices.

## Short Version

The later audit will follow the same seven steps for every review surface and
then reconcile the result against the full schema:

1. Start from one API behavior, such as loading the LLM review list.
2. List the response fields, filters, ordering, counts, and freshness it needs.
3. Trace each need to its current tables, columns, writers, and cleanup path.
4. Measure how many rows and bytes that behavior creates across projects,
   articles, prompts, list modes, and snapshots.
5. Classify each stored value as source, reusable fact, candidate mart, summary,
   keyed payload, bounded derivation, cold data, or deletion candidate.
6. Prove that the smaller candidate still gives exact bounded reads before
   recommending a schema change.
7. Cross-check every DuckDB table, index, and material column against the API-led
   findings so write-only, repair-only, schema-only, and obsolete state is
   explicitly classified rather than silently skipped.

## Goal

Produce a smaller, simpler review storage model without weakening exact review
results, snapshot consistency, benchmark-critical judgment configuration, or the
browser and desktop flows.

The audit should answer four questions for every stored row and column:

1. Which product behavior needs it?
2. Does that behavior need it before or after selecting a bounded page of
   article IDs?
3. Is this the authoritative copy, a reusable fact, a serving index, a payload,
   or accidental duplication?
4. What creates, updates, invalidates, retains, and eventually deletes it?

It must also answer one schema-wide question:

5. If no product behavior needs this table or column directly, is it still
   required for a writer, projector, replay, repair, export, transfer, benchmark,
   startup probe, retention rule, or migration boundary; and if not, can it be
   deleted or moved behind a bounded replacement?

## Scope

The audit covers the project-review domain end to end:

- LLM review lists, filters, counts, and pagination
- Human review lists, filters, counts, and pagination
- Both-mode review lists, filters, counts, and pagination
- Unassessed queues, counts, and pagination
- Review detail, full-text, prompt preview, and admin-support responses
- Search, select-all, add-to-project, export, PDF, and bulk operations
- Review warnings, health, readiness, and rebuild progress
- Article imports and import-route membership changes
- LLM judgment create, update, and delete paths
- Human judgment and review-state writes
- Project scope, prompt, model, content-setting, and date-range changes
- Background projectors, rebuilds, compaction, retention, startup checks, and
  operator scripts
- Shared browser and desktop API/runtime behavior

The audit includes relevant `app.*`, `mart.*`, internal state, indexes, temporary
tables, and local payload/file storage. Unrelated application domains are out of
scope unless a review path reads or writes their data.

## Non-Goals

- Do not change schemas, routes, projectors, or retention in this audit.
- Do not delete a table because its name looks obsolete.
- Do not treat test-only references as proof of production use.
- Do not replace exact product semantics with approximate counts or filters.
- Do not move a foreground query back to project-scale raw scans.
- Do not raise the DuckDB memory limit as a storage strategy.
- Do not add a long-lived compatibility or dual-write layer for internal marts.
- Do not inspect the live DuckDB file directly.

## Simple Storage Model

Use these categories consistently during the audit.

| Category | Purpose | Typical Contents | Example Decision |
| --- | --- | --- | --- |
| Authoritative source | Durable product truth and audit history | Articles, judgments, project membership | Keep the canonical article title in `app.article` |
| Reusable hot fact | Compact typed data reused by several projectors | Import rank, publication year, normalized source type | Extract a hot JSON field once instead of parsing it in every rebuild |
| Candidate/index mart | Data needed to select, filter, or order article IDs before `LIMIT` | Sort key, status key, posting membership, queue priority | Keep `article_created_at` if it drives keyset order |
| Summary mart | Named exact values that must be instant | Product-critical counts and facets | Keep a named unassessed count, not every possible dynamic count |
| Keyed payload | Larger data fetched only for selected IDs | Abstract, judgment explanation, quote JSON | Hydrate after selecting 100 article IDs |
| Manifest/control state | Publication, replay, leases, and recovery | Snapshot identity, watermark, chunk status | Store once per component or snapshot, not once per article |
| Cold or external data | Data not needed in the hot review database | Historical raw payload or large files | Consider local files or cold immutable storage if recovery/export requires it |
| Derived on bounded read | Cheap calculation over an already bounded set | Display formatting or a small row-level flag | Calculate after page IDs are known |
| Delete | No required producer, consumer, audit, or recovery role | Retired table, unused duplicate column, obsolete index | Drop only after evidence and parity checks |

## Core Decision Rule

A field belongs in a hot mart only when at least one of these is true:

- it is required to select candidate article IDs before applying `LIMIT`
- it is required for keyset ordering or cursor correctness
- it is required for a synchronous selective filter or queue access path
- it is a named count or facet that cannot be calculated within the foreground
  budget
- it must be fixed to a published snapshot for consistency
- joining its source before candidate selection would create an unbounded scan

A field normally does not belong in every mart row when all of these are true:

- it is display-only or detail-only
- it is available from one stable keyed source
- the page already has a bounded set of article IDs before it is needed
- a keyed join or hydration query fits the result and latency budgets

## Examples To Test

These examples explain the decisions the later audit should make. They are not
pre-judged conclusions about the current schema.

| Example | Question | Possible Outcome |
| --- | --- | --- |
| Article title repeated across four list modes and two snapshots | Is the title used to select/order rows, or only displayed after selection? | Keep a search/index representation where required and hydrate the display title once by article ID |
| `article_created_at` copied into several tables | Which copies are required for date filtering or keyset ordering? | Keep it in the narrow candidate table and remove copies from detail-only tables |
| Abstract or full-text preview in a list-serving row | Is it returned for every list row or only detail/preview requests? | Move it to keyed payload storage and hydrate only selected rows |
| Selected import route and publication year | Are these required for synchronous filters? | Keep narrow typed values or postings, but avoid copying unrelated display and judgment fields |
| Snapshot and component identity repeated per article | Does the reader need every identity from every row? | Resolve identities once from a manifest and key component tables by their owning identity |
| Filter posting rows | Which mounted filters actually use each posting kind? | Keep selective, benchmarked postings; remove unused kinds or make unsupported combinations async |
| Filter-option rows | Does the UI consume all returned facets and diagnostics? | Keep only the requested product contract and stop storing or computing unused payloads |
| Delta and rebuild rows | What consumer watermark makes them safe to remove? | Add an explicit bounded retention rule instead of keeping history forever |
| Patch or contribution table | Is there a production writer and reader, or only migration/test references? | Delete after proving it is outside publication, replay, recovery, and retention paths |
| Composite ART index | Which real query uses its equality prefix and ordering suffix? | Keep only measured access-path indexes; remove indexes that add write/delete cost without read benefit |

## Required Audit Outputs

The later audit should produce one new file, `STORAGE_SHAPE_AUDIT_PLAN.md`,
before any implementation plan is treated as actionable. That file should include
these artifacts:

1. API surface inventory.
2. Route-to-query and route-to-table map.
3. Full schema census for every relevant table, column, index, sequence-like
   identity, temporary shape, and local payload/file store.
4. Column-level data lineage matrix.
5. Table, index, and lifecycle inventory.
6. Row fan-out and duplicate-byte report.
7. Storage disposition matrix for every table and material column family.
8. Move/delete candidate list with proof requirements.
9. Candidate target shapes with read and write consequences.
10. Prioritized implementation slices with benchmark gates.

Do not leave the results only in notes, chat, logs, or temporary scripts. If a
check cannot be completed, `STORAGE_SHAPE_AUDIT_PLAN.md` should record the
missing evidence, why it is missing, and what would unblock it.

## Inventory Templates

### API Surface Record

Create one record for each mounted route and important background consumer.

| Field | Meaning |
| --- | --- |
| Surface | LLM rows, Human filters, detail, export, warning, projector, and so on |
| Entry point | Route, worker, cron, script, or UI query |
| Frequency | Per page, per poll, per action, per import batch, or maintenance only |
| Inputs | Project, config, filters, cursor, article IDs, and limits |
| Output contract | Fields and exactness/freshness behavior the caller consumes |
| Candidate operation | How article IDs are selected and ordered |
| Hydration operation | What is read only after candidate IDs are bounded |
| Counts/facets | Named precomputed, bounded exact, async, or unavailable |
| Current tables | Every source, mart, manifest, queue, and payload table touched |
| Query count | Statements and repeated metadata/diagnostic work |
| Browser/desktop | Shared behavior or runtime-specific behavior |

### Table Record

Create one record for every relevant DuckDB table and materialized temporary
shape.

| Field | Meaning |
| --- | --- |
| Table | Fully qualified table name |
| Role | Source, hot fact, mart, payload, manifest, queue, staging, or retired |
| Key and ownership | What makes one row unique and which component owns it |
| Producers | Every production write path |
| Consumers | Every production read, recovery, export, and cleanup path |
| Row formula | For example `projects x articles x list modes x snapshots` |
| Width drivers | Text, JSON, arrays, repeated identity columns, or wide indexes |
| Lifecycle | Create, update, invalidate, publish, pin, retire, and delete |
| Recovery need | Whether replay or disaster recovery depends on the rows |
| Candidate disposition | Keep, slim, split, move, derive, archive, or delete |
| Evidence status | Confirmed, inferred, missing measurement, or blocked |

### Column Family Record

Audit related columns together when they have the same purpose, such as article
display fields, judgment status fields, or snapshot identities.

| Field | Meaning |
| --- | --- |
| Source of truth | Original authoritative column or deterministic input |
| Transform | Parsing, ranking, normalization, aggregation, or formatting |
| Storage copies | All places where the value is persisted |
| Pre-limit use | Filter, sort, eligibility, posting, queue, or none |
| Post-limit use | List display, detail, export, diagnostics, or none |
| Freshness | Which mutation invalidates it |
| Suggested home | Source, hot fact, mart, payload, manifest, bounded derivation, or delete |

### Exhaustive Table And Column Census Record

Create one census record for every table and materialized local storage shape
before making any keep, move, or delete recommendation. Populate it from the
current schema, then reconcile it with the API-led lineage records.

| Field | Meaning |
| --- | --- |
| Object | Table, temporary table pattern, index, payload directory, or generated file |
| Columns or keys | Every persisted column, key, and index expression |
| Declared by | Current migration or schema builder that creates the object |
| Current references | Production reads, writes, deletes, repairs, startup probes, retention, export, transfer, and scripts |
| Non-production references | Tests, comments, plans, old migrations, fixtures, and generated typings |
| Runtime evidence | Row count, bytes, newest/oldest update, null ratio, distinct values, index size/cost where available |
| Use classification | Read-write, write-only, read-only, repair-only, retention-only, migration-only, test-only, or unreferenced |
| Column disposition | Keep, move, derive, merge, archive, delete, or needs investigation |
| Removal blocker | Product contract, authoritative/audit role, recovery role, pinned snapshot, migration compatibility, or none |
| Proof needed | Query parity, replay test, repair test, export test, retention test, migration/backfill, or operator playbook |

## Audit Process

Use the phases below as the actual order of work. Complete one API surface end to
end before assuming that a table or field has only one purpose.

### Phase 0 - Freeze Contracts, Baseline, And Schema Census

- [ ] Record the mounted review routes and read contracts before proposing
      storage changes.
- [ ] Record exact ordering, filter, count, cursor, stale-data, and unavailable
      behavior for each route.
- [ ] Record the configured DuckDB memory and runtime profile used for evidence.
- [ ] Capture baseline database size, table row counts, estimated bytes, index
      inventory, rebuild wall time, rows written, RSS, and foreground p95.
- [ ] Separate source seeding/import time, projection time, and route read time.
- [ ] Keep benchmark fixture, scale, seed, model, provider, content flags, and
      prompt configuration fixed across comparisons.
- [ ] Generate the full current DuckDB object inventory for relevant `app.*`,
      `mart.*`, internal, temporary, index, and local payload/file shapes from
      migrations/schema inspection and approved database snapshot tooling.
- [ ] For each table, list every current column, index, primary/unique key, and
      generated or JSON-derived material field.
- [ ] For each column, record type, nullability/default where available, row
      count, null ratio, approximate distinct count, repeated-byte drivers, and
      newest/oldest update evidence when the table has lifecycle timestamps.
- [ ] Search production code for each object and column name, including dynamic
      SQL builders, table allowlists, route services, projectors, workers,
      startup probes, repair code, retention, export, transfer, operator scripts,
      and desktop/runtime paths.
- [ ] Separately record test-only, fixture-only, plan-only, comment-only, and
      historical migration references so they do not masquerade as production
      use.
- [ ] Mark every table and column as read-write, write-only, read-only,
      repair-only, retention-only, migration-only, test-only, unreferenced, or
      unresolved before proposing movement or deletion.
- [ ] Do not treat the census as sufficient proof of use. Reconcile every
      census entry with the API and lifecycle lineage phases below.

### Phase 1 - Inventory API And UI Consumption

- [ ] Trace every review UI query key to its API route and response fields.
- [ ] Include LLM, Human, Both, and Unassessed list/count/filter paths.
- [ ] Include detail, full-text, admin info, prompt preview, warning, and health
      paths.
- [ ] Include search, bulk selection, add-to-project, export, and PDF paths.
- [ ] Record fields returned by the server but ignored by the UI.
- [ ] Record duplicated requests, repeated manifest/diagnostic reads, and route
      waterfalls.
- [ ] Verify the same shared API/UI behavior in browser and desktop flows.

Example: if a filter endpoint computes five facet groups but the UI consumes only
the option labels, mark the unused groups for contract review before deciding
whether their rows or projectors should exist.

### Phase 2 - Trace Data Lineage

- [ ] Start at each response field, filter predicate, sort key, and count.
- [ ] Trace backward through route service, reader, SQL builder, mart column,
      projector, and authoritative source.
- [ ] Trace forward from every source mutation to deltas, dirty work, projectors,
      manifests, serving rows, and retention.
- [ ] Record whether the same deterministic transform is stored more than once.
- [ ] Record raw JSON extraction and identify the small typed fields actually
      needed by hot paths.
- [ ] Preserve model and content-setting filters for all judgment lineage.

Example: a publication year parsed from import JSON may belong in one reusable
typed import fact and one selective posting. It should not be reparsed from JSON
or copied into unrelated payload and judgment tables without a measured reason.

### Phase 3 - Reconcile Tables, Columns, Indexes, And Hidden Consumers

- [ ] Read current migrations and resulting schema, not only the original table
      creation migration.
- [ ] Search production code, SQL builders, writer allowlists, schema tests, and
      dynamic table registries for every table name.
- [ ] Search production code for every material column and JSON key that appears
      in hot tables, allowing for aliases and generated SQL fragments.
- [ ] Search startup probes, repair code, retention, backup, transfer, export,
      and operator scripts for non-route dependencies.
- [ ] Distinguish production references from tests, comments, plans, and retired
      migrations.
- [ ] Identify schema-only tables, write-only tables, read-only tables, and tables
      with no current production path.
- [ ] Identify schema-only columns, write-only columns, columns populated but
      never read, columns read only by diagnostics, and columns that duplicate a
      source value without adding a pre-limit or snapshot-consistency role.
- [ ] Map every index to the real predicate/order path it is intended to serve.
- [ ] Use approved snapshot/query tooling for row counts and storage evidence;
      never open the live database directly.

Example: a table with no route reader may still be required for projector replay
or snapshot retention. Conversely, a startup probe and test reference alone do
not justify retaining an otherwise unused table.

### Phase 4 - Measure Row Fan-Out And Width

- [ ] Write the row-count formula for each table.
- [ ] Separate article-scaled, prompt-scaled, filter-value-scaled,
      list-mode-scaled, and snapshot-scaled rows.
- [ ] Measure repeated values across list modes, snapshots, prompts, and projects.
- [ ] Estimate logical payload bytes separately from index, WAL, and physical
      database bytes.
- [ ] Identify full-row rewrites caused by one component changing a few columns.
- [ ] Identify large temporary materializations and read-modify-write statements.
- [ ] Measure active, last-known-good, candidate, retired, pinned, and orphaned
      generations separately.

Example formula:

```text
wide list rows = scoped articles x list modes x retained snapshots
prompt details = scoped articles x enabled prompts x applicable modes
posting rows = scoped articles x materialized filter memberships x modes
```

### Phase 5 - Classify Every Stored Shape

- [ ] Apply the core decision rule to every material column family.
- [ ] Mark each table and column family as keep, slim, split, move, derive,
      archive, or delete.
- [ ] For every table, choose one table-level disposition: keep as-is, slim
      columns, split by ownership, move to keyed payload/file storage, replace
      with a reusable fact/current index, derive on bounded read, archive/cold
      retain, or delete.
- [ ] For every material column, choose one column-level disposition and name the
      exact evidence that supports it.
- [ ] State the product behavior and query budget that justifies every mart field.
- [ ] State the bounded join or hydration strategy for every field moved out of a
      mart.
- [ ] State the invalidation and retention rule for every retained derived table.
- [ ] Require stronger proof for deleting authoritative, audit, export, recovery,
      or benchmark-critical data.
- [ ] Treat move decisions like delete decisions until the replacement has an
      owner, read path, write path, retention rule, migration/backfill path, and
      parity gate.

### Phase 6 - Design Candidate Target Shapes

- [ ] Group fields by ownership and invalidation boundary rather than by current
      response object.
- [ ] Compare one wide serving row with narrow candidate, status, posting, and
      payload component tables.
- [ ] Compare per-snapshot physical copies with component-identity reuse through a
      manifest.
- [ ] Compare stored display fields with page-sized keyed hydration.
- [ ] Compare stored dynamic counts with named counts plus explicit async or
      unavailable states.
- [ ] Compare project-specific search rows with reusable global tokens plus
      bounded project intersection.
- [ ] Document read SQL, write fan-out, retention, and failure behavior for every
      candidate, not only estimated storage savings.

### Phase 7 - Validate Before Recommending Changes

- [ ] Execute current and candidate query shapes against the same disposable
      physical fixture.
- [ ] Verify exact row IDs, order, filters, counts, cursor behavior, and snapshot
      consistency.
- [ ] Measure rows scanned, rows written, output bytes, temp spill, RSS, and
      p50/p95/p99 latency.
- [ ] Test initial build, routine article update, judgment burst, shared import
      route, prompt/config change, deletion, archive, and interrupted restart.
- [ ] Reject any smaller schema that moves unbounded work into foreground reads.
- [ ] Reject broad rewrites that improve only a mock/smoke benchmark.

### Phase 8 - Produce The Implementation Order

- [ ] Start with unused rows, unused columns, duplicate API work, and payloads
      that can be safely late-hydrated.
- [ ] Then separate component-owned fields that currently cause wide-row rewrites.
- [ ] Change indexes only after the target table shape and access paths are known.
- [ ] Put structural schema replacements behind a physical benchmark and parity
      gate.
- [ ] Use a clear rebuild and cutover for internal marts; do not leave permanent
      dual-write compatibility paths.
- [ ] Add bounded cleanup for obsolete state after cutover and snapshot-pin
      protection.

## Deletion Proof

A table, column, index, or payload is a deletion or move-away candidate only when
all relevant checks pass:

- no mounted product route consumes it
- no source writer, projector, replay, repair, export, transfer, or cleanup path
  requires it
- no browser or desktop behavior depends on it
- it is not the only authoritative or audit copy
- snapshot consistency and recovery do not depend on it
- benchmark and parity fixtures cover its former behavior
- a migration or bounded cleanup can remove existing data safely
- for moved data, the replacement location has exact ownership, hydration,
  invalidation, retention, and recovery semantics

Deletion evidence must include both negative and positive proof: negative proof
that no required consumer remains, and positive proof that the product behavior,
recovery behavior, or audit/export behavior is either preserved elsewhere or was
not required.

## Decision Priorities

Rank recommendations in this order:

1. Correctness and benchmark integrity.
2. Bounded foreground reads.
3. Lower rebuild memory and write fan-out.
4. Lower hot database and backup size.
5. Simpler invalidation, retention, and recovery.
6. Lower implementation and migration risk.

## Audit Completion Quality Gates

- [ ] A new `STORAGE_SHAPE_AUDIT_PLAN.md` file exists and contains the audit
      results, not just the strategy.
- [ ] Every mounted review API route and important background consumer has an API
      surface record.
- [ ] Every relevant current table and index has confirmed production producers,
      consumers, ownership, and lifecycle, or is explicitly marked unused with
      proof still required.
- [ ] Every column from the full schema census has a use classification and a
      keep, move, derive, archive, delete, or unresolved disposition.
- [ ] Every material mart column family has a source lineage and proposed
      disposition.
- [ ] Every keep-in-mart decision identifies a pre-`LIMIT`, exact-summary, or
      snapshot-consistency requirement.
- [ ] Every move/derive decision includes a bounded read strategy.
- [ ] Every deletion candidate satisfies the deletion proof checklist.
- [ ] Row fan-out formulas and physical baseline measurements exist for all large
      review tables.
- [ ] Candidate shapes have exact parity tests and a physical benchmark plan.
- [ ] Browser and desktop implications are documented.
- [ ] The final audit lists the commands and approved database tooling used; any
      skipped obvious check is explained.

## Implementation Quality Gates For Later Changes

- `bun run db:mig` for schema changes.
- Targeted adjacent `bun test` suites for changed routes, readers, projectors,
  retention, and migrations.
- `bun run lint`.
- `bun run build` for shared API/client response changes.
- Browser verification for all four review tabs and detail flows.
- Desktop build and restart/resume verification for shared storage/runtime changes.
- Same-fixture physical before/after benchmark with unchanged critical settings.
- Zero new DuckDB OOM, fatal restart, or foreground temp spill.
- Add a short `OOM_ERRORS.md` entry for any OOM fix.

## Related Documents

- `plans/old/DUCK_OOM_FIX_PLAN.md`
- `plans/old/REVIEW_SERVING_REBUILD_SPEED_PLAN.md`
- `plans/old/REVIEW_REBUILD_WORK_FANOUT_PLAN.md`
- `plans/old/PERF_BENCH_PLAN.md`
- `DB_TERMS.md`
