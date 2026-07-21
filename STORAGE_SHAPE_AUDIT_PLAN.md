# Storage Shape Audit Results

Generated from the review-storage audit strategy in
`REVIEW_STORAGE_SHAPE_AUDIT_PLAN.md`.

## Durable Audit Control Framework

This is the audit control plane. Later stories must resume here and append
normalized evidence rather than creating parallel result files. Narrative
findings retained later in this file are discovery input, not substitutes for
the manifests and proof records below.

### Certification Snapshot

| Field | Value | Reason |
| --- | --- | --- |
| `overallCertification` | `INCOMPLETE` | The manifests are not populated or reconciled, revised proof is pending, and no inherited recommendation is actionable. |
| Framework version | `US-001 / 2026-07-21` | First normalized, resumable evidence structure. |
| Durable result file | `STORAGE_SHAPE_AUDIT_PLAN.md` | The only audit-result artifact; Ralph may separately update tracker metadata. |

`overallCertification: PASS` is forbidden until every in-scope manifest row is
`classified`, every reconciliation has zero nonterminal and blocked rows, all
completion gates pass, and every actionable recommendation has all applicable
positive and negative proof checks satisfied. Otherwise it remains
`INCOMPLETE`.

### Scope And Mutation Boundary

- Audit work may read repository files and approved immutable snapshots. It
  must not change repository schemas, code, routes, projectors, retention,
  runtime behavior, or data.
- Durable audit results go only in this file. Changes under `.ralph-tui/` are
  tracker metadata, not audit evidence.
- Never open or query the live DuckDB file directly. Physical evidence is
  acceptable only from approved snapshot tooling or an explicitly approved,
  isolated disposable fixture in a story that authorizes it.
- Do not start a server, worker, projector, migration, maintenance command, or
  database writer merely to fill this framework.
- Model, provider, thinking level, prompt set, content flags, memory limit, and
  runtime profile are benchmark-critical. Preserve failures under those
  settings; do not retry, downgrade, or silently work around them.

### Inherited Evidence And Disposition Rule

The pre-US-001 content below is preserved because it contains useful
repo-derived observations. Its factual claims remain discovery leads subject to
exact citation and manifest reconciliation. Every inherited `Disposition:`,
deletion/move candidate, target shape, implementation slice, and current
recommendation is **provisional** with
`recommendationActionability: unresolved` unless a later normalized row
cross-references revised proof.

- A broad path or glob is a discovery source, not a proof citation.
- A test, fixture, plan, comment, generated file, or historical migration does
  not prove production use.
- Absence from literal search does not prove absence from generated SQL,
  aliases, registries, allowlists, scripts, or runtime paths.
- No move, derive, archive, or delete recommendation may become stronger before
  API, writer, lifecycle, recovery, export, transfer, and retention evidence is
  traced. Final actionability also requires all applicable proof domains below.

## Stable Row IDs And Cross-References

Every normalized row receives an opaque stable ID. IDs identify evidence
records, not mutable object names.

| Prefix | Row family |
| --- | --- |
| `API-####` | Mounted API and read-contract manifest |
| `UIR-####` | UI and runtime consumption manifest |
| `BGO-####` | Background and operator surface manifest |
| `DBO-####` | DuckDB object, temporary shape, payload, or generated-file manifest |
| `CMF-####` | Column and material field manifest |
| `MAP-####` | Route-to-query and route-to-table map |
| `LIN-####` | Column-level lineage |
| `TLI-####` | Table, index, and lifecycle inventory |
| `FAN-####` | Fan-out or duplicate-byte measurement |
| `DSP-####` | Storage disposition |
| `PRF-####` | Positive or negative proof check |
| `TGT-####` | Candidate target shape |
| `SLC-####` | Implementation slice and benchmark gate |
| `EVD-####` | Exact evidence citation |
| `CMD-####` | Command or explicitly skipped check |
| `BLK-####` | Audit blocker |
| `OQ-####` | Owner question |

ID rules:

1. Allocate the next decimal ID within its family and zero-pad to four digits.
2. Never renumber, reuse, or derive an ID from a route, symbol, table, or
   column name.
3. A rename keeps the ID and records both locators. A split creates new IDs and
   cross-references the originating ID.
4. Keep retired or superseded rows for history; record an evidence-backed
   terminal state instead of deleting them.
5. Use IDs for all cross-output links. Citations supplement IDs but never
   replace them.

## State Model

The four state fields answer different questions and must never substitute for
one another.

### Manifest `auditStatus`

Only these values are valid:

| Value | Meaning |
| --- | --- |
| `not-started` | Discovered and allocated, but no required lineage has been traced. |
| `traced-to-api` | Product/API or explicit non-route scope is known; writer and lifecycle proof is incomplete. |
| `traced-to-writer` | Producers and mutations are traced; lifecycle/recovery or other required evidence is incomplete. |
| `traced-to-lifecycle` | Invalidation, replay/recovery, retention, and cleanup are traced; measurement or classification is incomplete. |
| `measured` | Required approved physical evidence is recorded; classification is incomplete. |
| `classified` | The in-scope row has complete required evidence and a use classification; this does not make a recommendation actionable. |
| `blocked` | Reconciliation-terminal for counting, but required evidence cannot currently be obtained; any blocked row prevents `PASS`. |
| `out-of-scope` | Evidence proves the row is outside the project-review domain and records the exact reason. |

The nonterminal values are `not-started`, `traced-to-api`,
`traced-to-writer`, `traced-to-lifecycle`, and `measured`. Every row with
one of those values must contain concrete `missingEvidence` and at least one
`ownerQuestionIds` reference. A `blocked` row must contain both as well.
`classified` and `out-of-scope` are the evidence-complete terminal states;
`out-of-scope` additionally requires a cited scope reason.

### `proofCheckState`

| Value | Meaning |
| --- | --- |
| `satisfied` | The named positive or negative proof is present and exactly cited. |
| `pending` | The proof is required but has not been established. |
| `blocked` | The proof is required and an identified blocker prevents collection. |
| `not-applicable` | Cited scope evidence shows why this proof domain cannot apply. |

### `recommendationActionability`

| Value | Meaning |
| --- | --- |
| `actionable` | Every applicable proof check and benchmark gate is satisfied. |
| `unresolved` | One or more proof checks or design consequences remain pending. |
| `blocked` | A required proof check is blocked. |

### `overallCertification`

| Value | Meaning |
| --- | --- |
| `PASS` | All manifests reconcile with no blocked rows, every completion gate passes, and every actionable recommendation has complete proof. |
| `INCOMPLETE` | Any other condition, including an empty/unbaselined manifest, nonterminal row, blocker, pending gate, or unresolved required proof. |

## Exact Evidence And Source Classification

Each `EVD-####` record states the claim it supports, source class, exact
locator, and `CMD-####` or approved snapshot that exposed it. Accepted exact
locators include:

- repository file plus symbol, exported constant, test name, or exact SQL
  statement shape;
- mounted method and route, UI query key, worker/scheduler entry point, or
  operator command;
- fully qualified table, column, JSON key, constraint, index name/expression,
  or temporary-table naming shape;
- exact current/final migration and every forward migration that changes it;
- immutable approved snapshot identity plus collection command and fixed
  benchmark configuration; and
- exact local path scheme or export/transfer mapping plus producer and consumer.

Every evidence record uses one source class:

| Source class | Evidentiary use |
| --- | --- |
| `production` | Runtime route, client, service, writer, worker, projector, lifecycle, recovery, export, transfer, or operator code. |
| `test` | Test behavior only; corroborates but does not prove production use. |
| `fixture` | Seed/mock/disposable-fixture behavior only; never live physical evidence. |
| `plan` | Intended or historical design only. |
| `comment` | Discovery hint only. |
| `generated` | Generated types/files; record the source and do not infer runtime mounting. |
| `historical-migration` | Schema history only; reconcile current declarations and forward migrations. |
| `approved-snapshot` | Immutable approved non-live physical evidence with fixed configuration. |

Globs, directory-level citations, unrecorded searches, and bare claims such as
“the tests cover this” cannot satisfy proof. Conflicting evidence is preserved
and linked to a blocker or owner question, never resolved by assumption.

## Recommendation Proof Gate

Create separate `PRF-####` rows for positive and negative proof. For a move,
derive, archive, or delete recommendation, the minimum domains are:

| Domain | Required proof |
| --- | --- |
| API and UI/runtime | Every mounted and shared browser/desktop behavior is preserved, replaced, or proven unrelated. |
| Writer | Every direct, generated, registry-driven, or script writer and invalidation input is traced. |
| Lifecycle | Create, update, publish, pin, retire, orphan, and cleanup behavior is traced. |
| Recovery | Replay, restart, repair, startup probe, audit-history, and disaster-recovery roles are preserved or proven absent. |
| Export | Project export, PDF/bulk hydration, and other exports are preserved or proven unrelated. |
| Transfer | Transfer-package write/read mappings and compatibility needs are preserved or proven unrelated. |
| Retention | Active, failed, last-known-good, pinned, historical, and terminal retention is explicit. |
| Snapshot consistency | Identity, cursor, ordering, count, freshness, and pin semantics remain exact. |
| Benchmark and parity | Same-fixture semantics and budgets pass without retry, fallback, spill, or settings changes. |
| Migration/backfill | Replacement ownership, bounded cutover/backfill, rollback/recovery, and cleanup are explicit. |
| Bounded reads | No foreground path regresses to a project-scale scan or unbounded hydration. |

Any applicable `pending` proof keeps
`recommendationActionability: unresolved`; any applicable `blocked` proof
sets it to `blocked`. Search absence, a test-only guard, historical migration,
or baseline size alone cannot strengthen a recommendation.

## Required Audit Outputs

### Output 01 - API Surface Inventory

Authoritative row family: `API-####`. Record one row per mounted route or
explicit read-contract entry point, including method/query key, inputs, output
fields, ordering, filters, counts, cursors, exactness/freshness, candidate
selection, bounded hydration, query count, owner, and exact tests. Cross-link
each row to `MAP-####`, `UIR-####`, `LIN-####`, and evidence IDs.

Current state: scaffolded. The inherited API list below is discovery input and
must be re-adopted row by row with exact mounting and contract citations.

### Output 02 - Route-To-Query And Route-To-Table Map

Authoritative row family: `MAP-####`. Map each `API-####` or `BGO-####`
entry point to exact reader/query-builder symbols, SQL shapes, tables,
columns/indexes, statement counts, pre-limit work, bounded hydration, and
snapshot/freshness reads. Cross-link UI consumers and lineage rows.

Current state: scaffolded; no inherited route-to-query claim is certified.

### Output 03 - Full Schema, Temporary, And File Census

Authoritative row families: `DBO-####` and `CMF-####`. Include every relevant
current table, material column/JSON key, index expression, constraint,
sequence-like identity, temporary-table pattern, payload directory, generated
file, export artifact, transfer package, backup, and snapshot. Record the final
declaration plus forward migrations, separating production from non-production
references.

Current state: scaffolded. The inherited schema census is a discovery backlog,
not proof that the census is exhaustive or current.

### Output 04 - Column-Level Data Lineage Matrix

Authoritative row family: `LIN-####`. Trace source-of-truth, transform,
persisted copies, API/UI consumers, producer and invalidation, pre-limit and
post-limit use, snapshot identity, export/transfer use, lifecycle, and exact
evidence for every `CMF-####` row.

Current state: scaffolded; inherited column-family observations are provisional.

### Output 05 - Table, Index, And Lifecycle Inventory

Authoritative row family: `TLI-####`. For each `DBO-####`, record key and
owner, production producers/consumers, the real predicate/order path for each
index, create/update/invalidate/publish/pin/retire/delete events, replay/repair
role, retention horizon, orphan handling, and non-production references.

Current state: scaffolded.

### Output 06 - Row Fan-Out And Duplicate-Byte Report

Authoritative row family: `FAN-####`. Record the row formula and every
article-, project-, prompt-, list-mode-, filter-value-, and snapshot-scaling
factor. Keep logical payload bytes, index cost/bytes, WAL bytes, temporary
spill, and physical database bytes separate. Measurements require
`approved-snapshot` evidence and fixed benchmark configuration.

Current state: scaffolded; inherited qualitative width observations are not
physical measurements.

### Output 07 - Storage Disposition Matrix

Authoritative row family: `DSP-####`. Give every table and material column
family exactly one provisional or revised disposition, product/query-budget
reason, bounded replacement when applicable, evidence IDs, proof IDs, and
`recommendationActionability`. A `classified` manifest row is necessary but
not sufficient for an actionable disposition.

Current state: scaffolded. Every disposition in the inherited material is
provisional and `unresolved` pending adoption into this matrix.

### Output 08 - Move/Delete Candidates And Proof Requirements

Authoritative row family: `PRF-####`, cross-referenced from `DSP-####`.
Record separate positive and negative checks for every applicable proof domain,
each with `proofCheckState`, evidence IDs, missing evidence, blockers, and
owner-question IDs.

Current state: scaffolded. The inherited candidate list is preserved but is not
certified and must not drive implementation.

### Output 09 - Candidate Target Shapes

Authoritative row family: `TGT-####`. Record ownership and identity, exact
columns/keys/indexes, read SQL shape, write fan-out, invalidation, publication,
retention, recovery, browser/desktop consequences, migration/backfill, cleanup,
and linked parity/benchmark proof.

Current state: scaffolded; inherited target-shape prose is provisional.

### Output 10 - Prioritized Implementation Slices With Benchmark Gates

Authoritative row family: `SLC-####`. Each slice names touched layers,
dependencies, exact changes, migration/cutover and cleanup, rollback/recovery,
fixed benchmark configuration, semantic parity gates, resource budgets, and
repo-native commands. A slice can be implementation-ready only when every
linked recommendation is `actionable`.

Current state: scaffolded. No implementation slice is certified actionable
while `overallCertification` is `INCOMPLETE`.

### Output 11 - Exhaustive Coverage Manifests

The five append-only manifests below are authoritative for discovery and
reconciliation. Narrative inventories and derived output tables must
cross-reference their stable IDs.

## Coverage Manifest 01 - Mounted API And Read Contracts

| rowId | Surface | Mounted method/route or contract entry | Response contract | Owning service | Exact tests | Evidence IDs | auditStatus | missingEvidence | ownerQuestionIds |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

_No normalized rows yet. US-002 and later API inventory stories must append
rows; zero rows does not mean zero surfaces._

## Coverage Manifest 02 - UI And Runtime Consumption

| rowId | Caller/query key | API surface IDs | Consumed fields | Ignored fields | Browser/desktop applicability | Evidence IDs | auditStatus | missingEvidence | ownerQuestionIds |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

_No normalized rows yet. Browser, desktop, export, PDF, bulk, warning, and
progress consumers remain to be baselined._

## Coverage Manifest 03 - Background And Operator Surfaces

| rowId | Entry point/owner | Read objects | Written objects | Lifecycle role | Recovery role | Exact tests | Evidence IDs | auditStatus | missingEvidence | ownerQuestionIds |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

_No normalized rows yet. Projectors, workers, schedulers, startup probes,
repair/recovery, retention, import/export/transfer, migrations, scripts, and
operator tools remain to be baselined._

## Coverage Manifest 04 - DuckDB Schema And Persisted Objects

| rowId | Object/kind | Key/index/path shape | Owner | Final declaration and forward migrations | Production refs | Non-production refs | Evidence IDs | auditStatus | missingEvidence | ownerQuestionIds |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

_No normalized rows yet. Tables, indexes, temporary patterns, payload
directories, generated files, exports, transfers, backups, and snapshots remain
to be baselined without inspecting live DuckDB._

## Coverage Manifest 05 - Columns And Material Fields

| rowId | Object ID | Column/JSON key/material field | Producer | Consumers | Pre-limit use | Post-limit use | Lifecycle | Provisional disposition | Proof IDs | Evidence IDs | auditStatus | missingEvidence | ownerQuestionIds |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

_No normalized rows yet. Later census stories must append one row per material
field rather than grouping fields with different producers, consumers, or
lifecycles._

## Reconciliation Summaries

For every manifest family `F`, calculate:

```text
discovered_F = count(all manifest rows in F)
classified_F = count(rows where auditStatus = classified)
out_of_scope_F = count(rows where auditStatus = out-of-scope)
blocked_F = count(rows where auditStatus = blocked)
nonterminal_F = discovered_F - classified_F - out_of_scope_F - blocked_F
required balance: discovered_F = classified_F + out_of_scope_F + blocked_F
```

The required balance is true only when `nonterminal_F = 0`. A balanced family
with `blocked_F > 0` is reconciled for accounting but still prevents
`overallCertification: PASS`. Indexes and payload/file shapes are typed
subsets of the `DBO-####` manifest and require separate summary rows.

| Family | Discovered | Classified | Out of scope | Blocked | Nonterminal | Required balance | Baseline state |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| Mounted API/read contracts | 0 | 0 | 0 | 0 | 0 | `0 = 0 + 0 + 0` | Not baselined |
| UI/runtime consumers | 0 | 0 | 0 | 0 | 0 | `0 = 0 + 0 + 0` | Not baselined |
| Background/operator surfaces | 0 | 0 | 0 | 0 | 0 | `0 = 0 + 0 + 0` | Not baselined |
| DuckDB/persisted objects | 0 | 0 | 0 | 0 | 0 | `0 = 0 + 0 + 0` | Not baselined |
| Columns/material fields | 0 | 0 | 0 | 0 | 0 | `0 = 0 + 0 + 0` | Not baselined |
| Indexes (DBO subset) | 0 | 0 | 0 | 0 | 0 | `0 = 0 + 0 + 0` | Not baselined |
| Payload/file shapes (DBO subset) | 0 | 0 | 0 | 0 | 0 | `0 = 0 + 0 + 0` | Not baselined |

These bootstrap zeros count only normalized rows. They are not evidence that
the repository has no surfaces or objects; `BLK-0001` prevents that
interpretation. Each later story must update affected counts with its rows.

## Commands And Skipped Checks

Record discovery, verification, approved-snapshot, and explicitly skipped
commands. A command proves only the claim linked through its evidence record.

| rowId | Date/story | Exact command or skipped check | Purpose | Result/evidence |
| --- | --- | --- | --- | --- |
| `CMD-0001` | 2026-07-21 / US-001 | `sed -n '1,260p' REVIEW_STORAGE_SHAPE_AUDIT_PLAN.md` and `sed -n '260,620p' REVIEW_STORAGE_SHAPE_AUDIT_PLAN.md` | Read the complete source strategy, including outputs, manifests, and gates. | Framework requirements extracted; repository files only. |
| `CMD-0002` | 2026-07-21 / US-001 | `sed -n '1,320p' .ralph-tui/progress.md` | Read tracker status and prior learnings. | No prior story implementation recorded. |
| `CMD-0003` | 2026-07-21 / US-001 | `sed -n '1,360p' STORAGE_SHAPE_AUDIT_PLAN.md` and `sed -n '300,620p' STORAGE_SHAPE_AUDIT_PLAN.md` | Inspect and preserve the inherited audit artifact. | Existing evidence and provisional recommendations identified. |
| `CMD-0004` | 2026-07-21 / US-001 | `bun run lint` | Run the repo-native lint gate. | Failed on six pre-existing formatting/import-order errors in `src/server/workers/comparisonProjectServingMaintenanceWorker.ts`, `src/server/workers/reviewServingProjectorWorker.test.ts`, and `src/server/workers/reviewServingProjectorWorker.ts`; US-001 does not touch `src/`, and unrelated lint was not fixed. |
| `CMD-0005` | 2026-07-21 / US-001 | `test "$(rg -c '^### Output [0-9]{2} -' STORAGE_SHAPE_AUDIT_PLAN.md)" -eq 11 && test "$(rg -c '^## Coverage Manifest [0-9]{2} -' STORAGE_SHAPE_AUDIT_PLAN.md)" -eq 5` | Verify required section cardinality. | Passed: eleven outputs and five manifests. |
| `CMD-0006` | 2026-07-21 / US-001 | `git diff --check -- STORAGE_SHAPE_AUDIT_PLAN.md` | Check patch whitespace. | Passed. |
| `CMD-0007` | 2026-07-21 / US-001 | `bun run typecheck` (skipped) | Typecheck gate. | `package.json` has no `typecheck` script, and US-001 changes no typed source. |
| `CMD-0008` | 2026-07-21 / US-001 | `bun test` and `bun run build` (skipped) | Runtime test/build gates. | Docs-only framework; no code, route, UI, browser, or desktop behavior changed. |
| `CMD-0009` | 2026-07-21 / US-001 | `bun run db:mig` and all DuckDB inspection commands (skipped) | Schema/data gates. | Schema and data mutation are out of scope; live DuckDB inspection is prohibited. |

## Blockers

| rowId | Scope | Missing evidence | Why blocked | Owner question IDs | Resolution condition |
| --- | --- | --- | --- | --- | --- |
| `BLK-0001` | Five manifests and eleven outputs | The inherited narrative has not been re-censused into stable rows with exact production/non-production evidence. | Later inventory and lineage stories own that work; treating narrative bullets as reconciled would overstate proof. | `OQ-0001` | Populate all manifests, update counts, and reconcile every inherited discovery. |
| `BLK-0002` | Physical fan-out, width, lifecycle age, and benchmark proof | No approved disposable-fixture or immutable-snapshot evidence is attached. | Live DuckDB inspection is prohibited and US-001 does not authorize fixture mutation. | `OQ-0002` | Record approval, fixed settings, collection commands, and evidence IDs in the designated measurement story. |
| `BLK-0003` | Inherited move/delete/retention candidates | Revised API, writer, lifecycle, recovery, export, transfer, and retention proof is absent. | Inherited evidence predates the normalized proof gate and cannot certify actionability. | `OQ-0003`, `OQ-0004` | All applicable proof checks are `satisfied` or evidence-backed `not-applicable`. |

## Owner Questions

| rowId | Owner needed | Question | Unblocks |
| --- | --- | --- | --- |
| `OQ-0001` | Audit owner | Who signs off that discovery sources are exhausted and all five manifests reconcile, including aliases, generated SQL, registries, allowlists, scripts, and non-production references? | `BLK-0001` and final coverage certification |
| `OQ-0002` | Benchmark/data owner | Which isolated disposable fixture or immutable snapshot is approved, and what fixed scale, seed, model, provider, thinking level, prompts, content flags, memory limit, and runtime profile apply? | `BLK-0002` and physical proof |
| `OQ-0003` | Product/API owner | Which mounted browser/desktop behaviors, export/PDF/bulk flows, transfer mappings, and exact response semantics must approve any move, derive, archive, or delete candidate? | Product and transfer proof in `BLK-0003` |
| `OQ-0004` | Storage/recovery owner | What replay, repair, pin, last-known-good, failed-job, audit/export, cleanup, and retention horizons are mandatory for each candidate object? | Lifecycle, recovery, and retention proof in `BLK-0003` |

## US-001 Quality Gates

- [x] All eleven output sections and five coverage manifests exist.
- [x] Stable IDs and four non-overlapping state fields are defined with only the
      permitted values.
- [x] Reconciliation uses
      `discovered = classified + out-of-scope + blocked` and exposes
      nonterminal rows.
- [x] Every nonterminal or blocked manifest row is required to record missing
      evidence and an owner question.
- [x] Inherited facts are retained while inherited dispositions are explicitly
      provisional and unresolved.
- [x] Exact evidence classes distinguish production from tests, fixtures,
      plans, comments, generated files, and historical migrations.
- [x] The live-DuckDB prohibition and recommendation proof gate are explicit.
- [x] Repository verification and explicitly skipped commands are recorded;
      the lint result is preserved without fixing unrelated source errors.

---

## Inherited Audit Material (Provisional)

Everything from this point to the end of the file predates the normalized
framework. Substantiated observations are retained for later adoption. All
dispositions, candidates, target shapes, implementation slices, and
recommendations in this inherited portion are provisional with
`recommendationActionability: unresolved` until linked to revised manifest and
proof rows.

## Inherited Status (Provisional)

This was the first durable audit artifact. It records repo-derived evidence from
the mounted API/read-contract inventory, DuckDB migrations, projector/reader
code, tests, and operator scripts. It does not inspect the live DuckDB file
directly.

The inherited version described its schema-shape recommendations as actionable
from code and schema. US-001 supersedes that disposition: its observations are
preserved, but every recommendation is provisional and
`recommendationActionability: unresolved` until revised proof is normalized.
Runtime row counts, physical bytes, null ratios, and oldest/newest update
timestamps also remain missing until collected through approved snapshot
tooling.

## Inherited Discovery Sources

Exact files below remain useful discovery sources. Wildcards are not proof
citations and must be expanded to exact files and symbols during manifest
adoption.

- `src/server/reviewServing/reviewServingReadContracts.ts`
- `src/server/reviewServing/reviewServingRouteParityCoverage.ts`
- `src/server/reviewServing/reviewServingContracts.ts`
- `src/server/reviewServing/reviewServingReader.ts`
- `src/server/reviewServing/*Projector*.ts`
- `src/server/routes/projectsRoutes/*Review*.ts`
- `src/server/routes/ArticlesRoutes.ts`
- `src/server/routes/ProjectExportRoutes.ts`
- `src/db/duckdbMigrations/0097_reviewServingV4Foundation.sql`
- `src/db/duckdbMigrations/0098_reviewServingPayloadOrderColumns.sql`
- `src/db/duckdbMigrations/0099_reviewServingCountScopeAndDetailOptionTables.sql`
- `src/db/duckdbMigrations/0100_reviewServingFilterOptionValueKey.sql`
- `src/db/duckdbMigrations/0101_reviewServingFacetSummaryScope.sql`
- `src/db/duckdbMigrations/0102_reviewWriteOverlayReadSurface.sql`
- `src/db/duckdbMigrations/0103_reviewProjectionInputWatermarks.sql`
- `src/db/duckdbMigrations/0104_reviewServingArticleDisplayMetadata.sql`
- `src/db/duckdbMigrations/0105_reviewServingArticleMetadataStatus.sql`
- `src/db/duckdbMigrations/0106_reviewServingRemoveHotSourceMetadata.sql`
- `src/db/duckdbMigrations/0107_reviewServingRebuildRequest.sql`
- `src/db/duckdbMigrations/0108_reviewSelectedImportPatchDisplayFields.sql`
- `src/db/duckdbMigrations/0109_reviewServingJudgmentDetailPayloadKindForwardMigration.sql`
- `src/db/duckdbMigrations/0111_rebuildReviewRebuildRequestIndex.sql`
- `src/db/duckdbMigrations/0112_reviewServingSummaryRebuildPartial.sql`
- `src/db/duckdbMigrations/0113_reviewServingSummaryContributionRebuildPartial.sql`
- `src/db/duckdbMigrations/0114_dropReviewFilterPostingStatsLookupIndex.sql`
- `src/db/duckdbMigrations/0115_rebuildReviewServingProjectorWatermarkWithoutPrimaryKey.sql`
- `src/db/duckdbMigrations/0116_dropReviewServingProjectorWatermarkLookupIndex.sql`

## Inherited API Surface Inventory

Mounted review read surfaces:

- `POST /api/articlesreviews`: LLM review rows, count state, prompt badges,
  postings, list judgment hydration, token-prefix search, async substring
  search.
- `POST /api/articlesreviewscount`: LLM count with filters and search state.
- `POST /api/articlesreviewshuman`: human review rows/count, postings,
  judgment hydration, search.
- `POST /api/articlesreviewsboth`: both-mode rows/count, LLM and human judgment
  hydration, postings, search.
- `POST /api/articlesreviewsunassessed`: unassessed queue rows/count, postings,
  queue access, search.
- `GET /api/articlesreviewsfilters`: review filter options, facets, and search
  scope.
- `GET /api/articlesreviewshumanfilters`: human filter options, facets, and
  search scope.
- `POST /api/projectsreview`: detail row, detail payload, LLM judgments, human
  judgments, prompt badges.
- `POST /api/projectsreviewswarnings`: snapshot and indexing warning state.
- `POST /api/projectsreviewshealth`: health snapshot.
- `GET /api/projects/:id/prompts/:promptId/preview`: prompt preview plus detail
  payload.
- `POST /api/articles/pdf-fetch-by-filter`: bulk/PDF selection by filter.
- `POST /api/projects/add_articles_by_filter`: bulk add by filter.
- `POST /api/articles/pdf-fetch-by-project`: PDF selection by project.
- `POST /api/articles/pdf-fetch-bulk`: PDF selection by explicit IDs.
- `POST /api/projects/:id/export`: export selection and detail hydration.

Known unmounted/internal route surface:

- `POST /api/review-serving/filter-postings`: classified in read contracts but
  not mounted; use as contract documentation only.

Parity gates already named by the repo:

- Review routes: semantic fixture, sampled parity, cursor, freshness state,
  named count state, SQL shape, forbidden foreground DuckDB work, latency, and
  response size.
- Job routes: durable job persistence, keyset batching, article-ID caps, filter
  signature, snapshot semantics, and foreground payload cap.

## Inherited Current Read Shape

The serving design already has a useful split:

- Candidate/list rows: `mart.review_article_serving_v4`.
- Filter postings: `mart.review_article_filter_posting_serving_v4`.
- Posting cardinality/statistics: `mart.review_filter_posting_stats_v4`.
- Large article payload: `mart.review_article_serving_payload_v4`.
- Judgment detail payload: `mart.review_article_judgment_detail_serving_v4`.
- Exact counts/facets/options: `mart.review_article_count_serving_v4`,
  `mart.review_filter_facet_serving_v4`, and
  `mart.review_filter_option_serving_v4`.
- Queue rows: `mart.review_unassessed_queue_serving_v4`.
- Title token-prefix search: `mart.review_title_search_serving_v4`.
- Snapshot publication/control: `app.review_serving_snapshot_manifest`,
  `app.review_projection_identity_manifest`, pins, dirty work, rebuild requests,
  and chunk manifests.

The main shape problem is not that the whole design is wrong. The problem is
that several hot rows still carry values that are only needed after candidate
selection, and some control/partial tables need explicit disposition and
retention proof.

## Inherited Schema Census

### Source, Delta, And Intake Tables

- `app.import_run_article_delta`
  - Columns: delta identity, source table/row/operation, source partition/high
    water mark, import route, article, selected rank, publication year,
    tombstone, payload JSON, reconciliation timestamps.
  - Classification: read-write delta ledger.
  - Disposition: keep.
  - Reason: import-route changes feed selected-import and project-scope
    projection.
  - Missing evidence: retention horizon and physical row count.

- `app.review_change_delta`
  - Columns: delta identity, source metadata, project/article/prompt/model,
    content flags, judgment IDs, config field set, tombstone, payload JSON.
  - Classification: read-write delta ledger.
  - Disposition: keep.
  - Reason: judgment, human judgment, prompt/config, and article changes feed
    dirty work and rebuild invalidation.
  - Missing evidence: retention horizon and payload JSON size by change kind.

- `app.review_source_change_outbox`
  - Classification: recovery outbox.
  - Disposition: keep with bounded retention.
  - Reason: preserves source-change evidence for reconciliation and recovery.
  - Missing evidence: oldest unreconciled rows and retry/quarantine aging.

- `app.review_delta_reconciliation_cursor`
  - Classification: reconciliation cursor.
  - Disposition: keep.
  - Reason: prevents replay gaps/duplicates per source partition.

- `app.review_import_article_hot_field`
  - Columns include selected rank, publication year, title, journal, external
    ID, duplicate/conflict flags, and filter bucket fields.
  - Classification: reusable hot import fact.
  - Disposition: keep, but audit `article_title`, `journal_title`, and
    `external_id` as possible display duplication.
  - Reason: selected-import and posting projectors need rank/filter facts before
    list rows are built.

### Manifest, Snapshot, And Control Tables

- `app.review_serving_dirty_work`
  - Classification: control queue.
  - Disposition: keep with retention cleanup for completed/stale rows.
  - Reason: incremental projection input.

- `app.review_serving_dirty_work_ack`
  - Classification: acknowledgement ledger.
  - Disposition: keep with bounded retention.
  - Reason: guards component watermarks against double-processing.

- `app.review_project_import_delta_cursor`
  - Classification: unresolved/schema-only candidate.
  - Evidence: current code search found schema/test references but no obvious
    production reader/writer outside schema tests.
  - Disposition: investigate for deletion or merge into dirty intake cursor
    state.
  - Proof needed: confirm no import-delta intake path reads/writes it in
    production and no operator recovery depends on it.

- `app.review_serving_projector_watermark`
  - Classification: projector cursor/control state.
  - Disposition: keep.
  - Reason: stores component/source partition watermarks, leases, and cursor
    JSON; recent migrations intentionally removed fragile primary-key/index
    assumptions.

- `app.review_projection_identity_manifest`
  - Classification: component identity manifest.
  - Disposition: keep.
  - Reason: connects snapshot components to projection identities, generations,
    patch watermarks, input watermarks, and invalidation reasons.

- `app.review_rebuild_request`
  - Classification: rebuild admission/retry policy.
  - Disposition: keep.
  - Reason: foreground/requestless rebuild ownership, retry, OOM/budget
    diagnostics, and terminal state.

- `app.review_rebuild_chunk_manifest`
  - Classification: chunk execution manifest.
  - Disposition: keep, but compact completed old requests under retention.
  - Reason: chunk leases, OOM splitting, budget diagnostics, progress, and
    restart recovery depend on it.

- `app.review_selected_import_snapshot`
  - Classification: selected-import snapshot manifest.
  - Disposition: keep.
  - Reason: selected import membership/rank publication boundary.

- `app.review_selected_article_import_v4`
  - Classification: selected-import base table.
  - Disposition: keep, but audit display/rank duplicates column-by-column.
  - Reason: selected import is a reusable pre-limit fact for project scope,
    postings, display composition, and selected-route semantics.

- `app.review_serving_snapshot_manifest`
  - Classification: published snapshot manifest.
  - Disposition: keep.
  - Reason: active/last-known-good status, component identities, selected import
    snapshot, validation, and freshness/warnings all depend on it.

- `app.review_serving_snapshot_pin`
  - Classification: pin/retention guard.
  - Disposition: keep.
  - Reason: long-running export/PDF/bulk operations need stable snapshot
    semantics.

- `app.review_write_overlay`
  - Classification: foreground write overlay.
  - Disposition: keep if read-surface reconciliation remains required; otherwise
    shrink after proving stale-read windows are gone.
  - Reason: protects UX after fresh writes before projector convergence.

- `app.review_bulk_operation_job`
  - Classification: durable job control.
  - Disposition: keep.
  - Reason: bulk/PDF/export operations need persistent criteria, cursor, result
    manifest, and snapshot pin ownership.

- `app.review_search_job`
  - Classification: async search job control.
  - Disposition: keep.
  - Reason: substring search is intentionally not foreground project-scale scan.

- `app.review_serving_retention_mark`
  - Classification: retention progress marker.
  - Disposition: keep.
  - Reason: cleanup must be bounded and restartable.

### Serving And Projection Tables

- `mart.review_title_search_serving_v4`
  - Classification: token-prefix index.
  - Disposition: keep, with fan-out measurement.
  - Reason: search must avoid foreground title scans; recent performance work
    increased search chunk coalescing because per-token/chunk overhead was high.

- `mart.review_article_serving_v4`
  - Classification: hot candidate/list mart.
  - Disposition: slim.
  - Keep pre-limit fields: project/review/snapshot identity, list mode, article
    ID, sort/activity keys, selected import route/rank when used for list
    semantics, publication year/date fields used for filters/order,
    duplicate/conflict flags, LLM/human status keys, prompt counts, review-open
    state, and snapshot component identities needed by readers.
  - Move or late-hydrate candidates: `article_title`, `article_external_id`,
    `arxiv_id`, `biorxiv_id`, `medrxiv_id`, `doi`, `pmid`, `journal_title`,
    `url`, `full_text_pdf`, `full_text_fetched_at`,
    `full_text_conversion_status` unless a route proves pre-limit use.
  - Reason: the current table is used for candidate selection and list display,
    so display columns are repeated per `project x snapshot x list_mode x
    article`. Display-only values should be fetched after candidate IDs are
    bounded.

- `mart.review_article_display_patch_v4`
  - Classification: display patch/staging.
  - Disposition: keep until the slim-list change is implemented; then re-audit.
  - Reason: it is the component-owned display input for publication and
    incremental replacement.

- `mart.review_selected_import_patch_v4`
  - Classification: selected-import patch/staging.
  - Disposition: keep if incremental selected-import publishing remains; delete
    only if direct base/serving writes fully replace patch semantics.

- `mart.review_llm_status_patch_v4`
  - Classification: LLM status patch/staging.
  - Disposition: keep unless direct status publication removes it.
  - Reason: LLM prompt status drives filters, counts, list badges, and both-mode
    semantics.

- `mart.review_human_status_patch_v4`
  - Classification: human status patch/staging.
  - Disposition: keep unless direct status publication removes it.
  - Reason: human/both/unassessed routes and summary-mode human judgment
    semantics depend on these states.

- `mart.review_queue_patch_v4`
  - Classification: queue patch/staging.
  - Disposition: keep if incremental queue projection remains; otherwise merge
    into queue serving writes.

- `mart.review_article_filter_posting_patch_v4`
  - Classification: posting patch/staging.
  - Disposition: keep until posting rebuild/incremental ownership is simplified.

- `mart.review_article_filter_posting_serving_v4`
  - Classification: hot posting index.
  - Disposition: keep and benchmark selective filter kinds.
  - Reason: prompt answer, import route, publication year, duplicate/conflict,
    status, queue, and search-filter intersections need bounded set selection.

- `mart.review_filter_posting_stats_v4`
  - Classification: posting cardinality/statistics.
  - Disposition: keep table, keep index dropped.
  - Reason: table is still used by projector/diagnostics; migration 0114 removed
    the lookup index after it became more write cost than read benefit.

- `mart.review_article_serving_payload_v4`
  - Classification: keyed article payload.
  - Disposition: keep and expand as the home for display/detail fields that can
    be hydrated after candidate selection.
  - Reason: it already holds `source_metadata`, `abstract_text`,
    `full_text_preview`, and payload byte tracking by article/snapshot.

- `mart.review_article_judgment_detail_serving_v4`
  - Classification: keyed judgment payload/detail rows.
  - Disposition: keep, but split list-badge/minimal judgment fields from large
    detail payload if route evidence shows list pages read more than they render.
  - Reason: detail, prompt preview, list judgment hydration, filters, export, and
    PDF routes all read this table.

- `mart.review_article_summary_contribution_v4`
  - Classification: likely retired main summary contribution ledger.
  - Evidence: `TESTS.md` already names guard coverage for no writer, startup
    probe, projector, or retention dependency on the main summary contribution
    ledger; rebuild now uses request-scoped partial tables.
  - Disposition: delete candidate.
  - Proof needed: migration removes the table; schema/static guards pass; summary
    rebuild, retention, repair, and route parity tests pass.

- `mart.review_article_count_serving_v4`
  - Classification: exact named count serving table.
  - Disposition: keep.
  - Reason: foreground count routes and freshness states require exact named
    counts without project-scale scans.

- `mart.review_filter_facet_serving_v4`
  - Classification: facet summary serving table.
  - Disposition: keep, but verify every facet kind is consumed by the UI.
  - Reason: filter endpoints consume facets with summary identity and
    availability.

- `mart.review_filter_option_serving_v4`
  - Classification: filter option serving table.
  - Disposition: keep, but slim `option_payload_json` after comparing UI fields
    against returned payload.
  - Reason: route builds prompt filters and numeric bins from these rows; large
    unused payload JSON would be pure hot-row width.

- `mart.review_unassessed_queue_serving_v4`
  - Classification: queue serving table.
  - Disposition: keep.
  - Reason: unassessed route needs priority ordering without foreground judgment
    scans.

- `mart.review_article_summary_rebuild_partial_v4`
  - Classification: request-scoped summary rebuild partial.
  - Disposition: keep with strict retention.
  - Reason: enables bounded summary reduction; old partials should not persist
    beyond terminal request cleanup.

- `mart.review_article_summary_contribution_rebuild_partial_v4`
  - Classification: request-scoped contribution rebuild partial.
  - Disposition: keep with strict retention.
  - Reason: replaces the broad persistent contribution ledger during rebuild.

## Inherited Column Family Findings

- Display metadata is the highest-confidence slimming target.
  - Repeated in `app.review_import_article_hot_field`,
    `app.review_selected_article_import_v4`,
    `mart.review_article_display_patch_v4`,
    `mart.review_article_serving_v4`, and payload/detail surfaces.
  - Keep only fields needed for pre-limit filters/order in candidate marts.
  - Hydrate titles, journal/source IDs, external IDs, URLs, and full-text status
    after article IDs are bounded.

- Snapshot/component identity columns are intentionally repeated in hot serving
  tables.
  - Keep until readers can resolve identities once from a manifest and join by
    snapshot/component identity without extra per-row cost.
  - Do not remove before proving cursor and snapshot consistency.

- Posting rows are valid hot index rows, not display duplication.
  - Keep selective postings that serve mounted filters.
  - Remove only posting kinds with no route/UI consumer and no async job use.

- Count/facet/option rows are valid if they correspond to named route contracts.
  - Keep named exact counts.
  - Re-audit option payload JSON and facet kinds against UI consumption.

- Large text/JSON belongs in keyed payload/detail tables.
  - `source_metadata`, abstract, full-text preview, judgment payload JSON,
    explanations, and quotes should not be copied into candidate rows.

- Control tables are not deletion candidates just because no route reads them.
  - Snapshot, pin, dirty-work, chunk, watermark, request, cursor, and retention
    tables are writer/recovery surfaces.

## Inherited Deletion And Move Candidates (Provisional)

1. Delete `mart.review_article_summary_contribution_v4`.
   - Confidence: high.
   - Reason: request-scoped partials have replaced the main ledger and existing
     tests describe static guard coverage for no remaining runtime dependency.
   - Required proof: migration, schema test, summary projector tests, retention
     tests, integration route parity.

2. Investigate/delete `app.review_project_import_delta_cursor`.
   - Confidence: medium-low.
   - Reason: code search found schema/test references only.
   - Required proof: no production writer/reader, no repair/operator dependency,
     and import-delta dirty intake still has exact replay protection elsewhere.

3. Move display fields out of `mart.review_article_serving_v4`.
   - Confidence: high for fields that are display-only.
   - Required proof: reader can first select article IDs/order/counts from the
     slim mart, then hydrate display metadata by bounded article IDs with the
     same p95 and response contract.

4. Slim `mart.review_filter_option_serving_v4.option_payload_json`.
   - Confidence: medium.
   - Required proof: UI and route response only consume typed columns or a
     smaller payload shape for each filter kind.

5. Add retention cleanup for request-scoped partial tables.
   - Confidence: high.
   - Required proof: terminal rebuild requests can be cleaned while preserving
     active, failed evidence, pinned snapshots, and operator diagnostics.

## Inherited Proposed Target Shape (Provisional)

### Slim Candidate Mart

`mart.review_article_serving_v4` should become a narrow candidate/list-state mart
owned by snapshot/list-mode selection:

- identity: project, review config, snapshot, list mode, article
- ordering: sort/activity/article-created keys
- filter/status: publication year, duplicate/conflict, LLM/human status,
  prompt counts, review state, selected import route/rank
- snapshot consistency: component identities and generation/watermark metadata

Display fields should move to keyed hydration through either
`mart.review_article_serving_payload_v4` or a narrower display payload table.

### Payload Hydration

After a route has selected at most the configured page size of article IDs, it
should hydrate display/detail data by key:

- article title, external IDs, journal, URL, full-text status
- abstract/source metadata/full-text preview
- judgment detail payload, answers, placeholders, model metadata

The hydration query must preserve response order from the candidate query and
must remain capped by route page size or explicit bulk batch size.

### Summary And Filter Shapes

Keep exact named summary tables for foreground routes:

- `mart.review_article_count_serving_v4`
- `mart.review_filter_facet_serving_v4`
- `mart.review_filter_option_serving_v4`
- `mart.review_filter_posting_stats_v4`

Do not reintroduce project-scale foreground aggregation. Any dynamic combination
that cannot be answered from a bounded posting intersection should be async or
explicitly unavailable.

## Inherited Implementation Slices (Not Actionable)

1. Remove the retired main summary contribution ledger.
   - Add a migration dropping `mart.review_article_summary_contribution_v4`.
   - Keep request-scoped partial tables.
   - Run summary, retention, schema, projector writer, and phase integration
     tests.

2. Prove and either delete or justify `app.review_project_import_delta_cursor`.
   - Search dynamic SQL and operator scripts again.
   - Add a static guard if deleting.
   - Run dirty intake and selected-import rebuild tests.

3. Introduce bounded display hydration for review list routes.
   - Keep candidate selection in `mart.review_article_serving_v4`.
   - Hydrate display metadata for selected article IDs from payload/display
     storage.
   - Update read-contract/parity tests for identical route responses.

4. Physically slim `mart.review_article_serving_v4`.
   - Drop display-only columns only after slice 3 proves parity and benchmarks.
   - Keep date/status/filter/order fields that are pre-limit.

5. Slim filter option payload.
   - Compare filter endpoint response fields with UI consumption.
   - Replace large generic JSON with typed columns where possible.

6. Add retention for request-scoped rebuild partials.
   - Clean completed terminal request partials after evidence horizon.
   - Preserve failed-request diagnostics and active/pinned snapshot data.

7. Benchmark and route-parity gate the final shape.
   - Same fixture, same prompts/models/content settings.
   - Measure rows scanned, rows written, output bytes, temp spill, RSS, and
     p50/p95/p99 latency.

## Inherited Required Verification

For the next implementation PRs:

- `bun test src/server/reviewServing/reviewServingSchema.test.ts`
- `bun test src/server/reviewServing/reviewServingSummaryProjector.test.ts src/server/reviewServing/reviewServingProjectorWriter.test.ts src/server/reviewServing/reviewServingRetentionService.test.ts`
- `bun test src/server/reviewServing/reviewServingReader.test.ts src/server/reviewServing/reviewServingReadContracts.test.ts src/server/reviewServing/reviewServingRouteParityCoverage.test.ts`
- `bun test src/server/reviewServing/reviewServingLlmReviewRouteService.test.ts src/server/reviewServing/reviewServingHumanBothUnassessedRouteService.test.ts src/server/reviewServing/reviewServingFilterRouteService.test.ts`
- `bun run lint`
- Same-fixture physical benchmark before and after any candidate-mart slimming.
- Browser review-tab verification for LLM, Human, Both, Unassessed, detail, and
  filters.
- Desktop restart/resume verification for storage/runtime changes.

## Inherited Missing Evidence To Collect

- Row counts and physical bytes for every current review-serving table.
- Null ratio and approximate distinct count for each candidate display/status
  column in `mart.review_article_serving_v4`.
- Oldest/newest `updated_at` or equivalent lifecycle timestamp for control,
  delta, partial, and retention tables.
- Per-route SQL timing before and after display hydration split.
- UI field-consumption proof for filter option payload JSON and facet groups.
- Active snapshot/pin counts and retained historical generation counts.

## Inherited Current Recommendation (Provisional)

Proceed in this order:

1. Delete the retired summary contribution ledger if the named proof passes.
2. Resolve the apparently schema-only import delta cursor.
3. Move display-only article metadata out of the hot list mart through bounded
   hydration.
4. Slim option payload JSON and add partial-table retention.

Do not start by deleting broad control tables or changing snapshot identity
columns. Those tables are part of correctness, replay, and recovery, even when no
mounted route reads them directly.
