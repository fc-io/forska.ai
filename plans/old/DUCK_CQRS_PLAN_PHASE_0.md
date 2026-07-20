# DuckDB CQRS Plan Phase 0 - Contracts, Budgets, Module Boundary

Master coordinator: [DUCK_OOM_FIX_PLAN.md](./DUCK_OOM_FIX_PLAN.md)

## Objective

Create the pure contracts and static guardrails that every later phase depends on. This phase must not switch product routes or change normal review behavior.

## Cut Line

Add pure contracts, registries, cursor/admission helpers, diagnostic shapes, and SQL-shape guards without changing existing route behavior.

Static guards in Phase 0 protect the new `reviewServing` package and record the current migration inventory. They must not fail simply because legacy routes still delegate to OLAP before Phase 4.

Route-level raw-path guards become blocking when those routes are migrated in Phase 4 and remain blocking through the Phase 5 final verification sweep.

## Workstreams

| Status | Theme | Implement First | Done When |
|---|---|---|---|
| [ ] | Contracts, budgets, and module boundary | Add `src/server/reviewServing/` with contracts, projection identity builders, invalidation registry, read registry, cursor helpers, SQL-shape test helpers, admission interfaces, route-specific parity contracts, and diagnostics shape. | Every planned hot read has a contract entry and conservative migration inventory entry, every mounted route entry represents complete product-route coverage, incomplete helper/future contracts stay unmounted, every hot read has a declared physical table/cursor/budget/count/filter-access behavior, every delta kind maps to first affected component/downstream dependents/update mode, foreground admission is registry-based, and static tests guard the new SQL builders/registries from raw fallback shapes. |
| [ ] | Benchmark harness | Add the 10M-article/7-prompt synthetic fixture generator, overlap workload definition, memory limits, and metrics capture API. | The harness can run a smoke workload before final schema/projectors exist and can later run the full fixture. It reports p50/p95/p99 latency, memory, temp usage, queue depth, rows scanned, rows returned, and admitted/rejected work. The full physical 10M pass is a Phase 6 release-evidence gate. |

## Review-Driven Phase 0 Refinements

PR 68 review feedback expanded the Phase 0 contract surface so later phases cannot
certify partial route coverage as a safe migration.

- Direct list row contracts represent unfiltered ordered-prefix reads only. They
  must not advertise filters or search modes that generated SQL ignores.
- Filtered list pages require a posting/search selection contract plus
  `articleSetLookup` row hydration contracts for LLM, human, both, and unassessed
  rows.
- List judgment arrays are separate article-set payload contracts: LLM list
  judgments, human list judgments, both-list LLM judgments, and both-list human
  judgments. Prompt-overlap row budgets must account for page size times prompt
  count.
- Detail judgment contracts distinguish LLM and human payload kind. The broad
  `/api/projectsreview` route remains unmounted until all extra detail payloads,
  including current judgment details, human details, related records, project
  context, freshness, and warning panels, have explicit coverage.
- Filter vocabulary includes explicit article-created date range keys,
  duplicate/conflict/import route scope, prompt/human/LLM filters, queue kind, and
  token-prefix search scope where current routes apply those predicates.
- Human filter facets/options are separate from generic LLM/review filter
  facets/options and include summary-mode human answer coverage.
- Count contracts derive list mode from the named count key before falling back to
  a fixed contract or global mode. Unsupported searched-count shapes stay
  unmounted or unavailable/async.
- Job criteria contracts use job-table cursor/sort fields and job identities,
  including job kind, filter signature, search mode/text, pinned snapshot, or
  declared latest-snapshot semantics.
- Manifest status reads must select usable snapshot statuses explicitly and not
  treat candidate or failed manifests as active serving snapshots.
- The Phase 5 synthetic workload definition and Phase 6 physical release run must exercise the
  added contracts: article-set hydration, list/detail payloads, human facets and
  options, counts across list modes, queue kind, token-prefix search, async
  substring jobs, and durable bulk/export/PDF jobs.

## Required Artifacts

- `src/server/reviewServing/reviewServingContracts.ts`
- `src/server/reviewServing/reviewProjectionIdentity.ts`
- `src/server/reviewServing/reviewServingInvalidationRegistry.ts`
- `src/server/reviewServing/reviewServingReadContracts.ts`
- `src/server/reviewServing/reviewServingCursor.ts`
- `src/server/reviewServing/reviewServingAdmission.ts`
- `src/server/reviewServing/reviewServingSql.ts` or sibling `reviewServingSql/` files
- Adjacent tests for contracts, identities, invalidation, read contracts, cursors, admission, and SQL shape
- Benchmark harness scaffold and metrics shape

## Rules

- Keep the Phase 0 package pure where possible. Contracts, identity builders, invalidation registry, cursor helpers, read contracts, and SQL-shape helpers should not call the database.
- Use the `effect` library for non-trivial JavaScript/TypeScript async and server flow. Prefer `Effect.gen` for sequencing, `Layer`/`Context` for service wiring, `Effect.acquireRelease`/`Scope` for resource lifetime, and `Schedule` for retries, polling, and backoff. Keep pure transforms and very small handlers as plain functions.
- Do not add route behavior changes in Phase 0.
- Do not fail tests only because legacy pre-cutover routes still use raw OLAP paths.
- Every normal hot read planned for Phase 4 must have a contract before route migration starts.
- A route inventory entry may be `mounted: true` only when the listed contracts cover the complete current product response shape. Partial contracts for count panels, filter options, detail judgment payloads, warning diagnostics, or future helper reads must stay unmounted.
- Route inventory entries must use real product route paths. Synthetic helper paths may exist only as unmounted helper coverage and cannot certify a mounted product route.
- Admission must reject requested search modes that do not match the registered contract search mode. Omitted search mode means no search.
- Every delta kind planned for Phase 2 and Phase 3 must have an invalidation registry entry before write paths emit it.
- The registry is the source of truth for first affected component, downstream dependents, affected keys, and update mode.
- SQL-shape guards should reject `selected_scoped_article_import`, `ROW_NUMBER(`, `OFFSET`, raw `app.article`/`app.judgment` scans, `json_extract`, and unbounded foreground `GROUP BY` in new serving SQL.
- SQL-shape guards must require bound project/snapshot predicates in the `WHERE` clause for every serving table reference. Mentions in `ORDER BY`, cursor predicates, literals, or `QUALIFY` clauses do not satisfy scope.
- Keyed detail dedupe may use a deterministic bounded list-mode priority only after the read is article-scoped. Project-wide windows or `ROW_NUMBER()` remain forbidden in foreground serving SQL.

## Quality Gates

- [ ] `bun test src/server/reviewServing`
- [ ] `bunx eslint src/server/reviewServing`
- [ ] `bun run lint`
- [ ] Static tests prove every `reviewServingReadContracts.ts` key has workload class, cursor spec, budgets, allowed filters, physical filter access strategy, named fast counts, freshness behavior, and required/optional components.
- [ ] Static tests prove mounted route inventory entries do not claim partial count, filter-option, detail, warning, or route-helper coverage.
- [ ] Static tests prove route inventory entries map real product endpoints and keep helper-only routes unmounted.
- [ ] Static tests prove direct ordered-prefix row contracts do not advertise filters/search, and filtered routes use posting/search plus article-set hydration contracts.
- [ ] Static tests prove list/detail judgment payload contracts cover LLM, human, both-mode, payload-kind, and prompt-overlap budgets.
- [ ] Static tests prove count contracts derive list mode from named count keys and reject unsupported searched-count shapes.
- [ ] Admission tests prove mismatched search modes are rejected before DuckDB execution.
- [ ] Static tests prove every `reviewServingChangeKind` has an invalidation registry entry and no unknown change kind becomes broad project invalidation.
- [ ] SQL-shape tests prove new serving SQL cannot include raw fallback shapes.
- [ ] SQL-shape tests prove multi-table serving reads qualify scope predicates and reject scope hidden in `ORDER BY`, literals, cursor-only clauses, or `QUALIFY`.
- [ ] Benchmark smoke harness can run without requiring completed schema/projectors and validates request dimensions, queue kind, list mode, count keys, search modes, row targets, scanned-row ceilings, zero temp spill, latency, and memory targets.

## 2026-06-20 Phase 0 Audit Status

Audited branch: `opencode/duck-cqrs-plan-sequential-audit-20260620-1920`.

Scope: Phase 0 only. Later-phase serving implementation exists in the tree, so this audit checks whether the Phase 0 contracts, guardrails, and harness still support those later phases without re-auditing later-phase correctness.

| Status | Item | Evidence |
|---|---|---|
| [x] | Required `reviewServing` contract artifacts exist. | `src/server/reviewServing/reviewServingContracts.ts`, `reviewProjectionIdentity.ts`, `reviewServingInvalidationRegistry.ts`, `reviewServingReadContracts.ts`, `reviewServingCursor.ts`, `reviewServingAdmission.ts`, `reviewServingSql.ts`, and `reviewServingSqlForbiddenPatterns.ts`. |
| [x] | Every registered hot read key has a complete contract entry. | `src/server/reviewServing/reviewServingReadContracts.ts`; covered by `reviewServingReadContracts.test.ts` tests `review serving read contracts cover every registered hot read key` and `review serving read contracts declare every static registry field`. |
| [x] | Route inventory uses real product routes and keeps helper-only coverage unmounted. | `reviewServingReadContractRouteInventory` in `reviewServingReadContracts.ts`; covered by `reviewServingReadContracts.test.ts` tests `US-017 migrated review route inventory rows are mounted or explicitly internal`, `review serving migration inventory maps contracts to product routes and planned surfaces`, and route-specific inventory tests for detail, count, bulk/PDF/export, filters, and list reads. |
| [x] | Filtered reads are represented by posting/search selection plus article-set hydration contracts. | `review.filters.postings`, `review.search.tokenPrefix`, `review.search.substringAsync`, and `*.rowsByArticleSet` entries in `reviewServingReadContracts.ts`; covered by `reviewServingReadContracts.test.ts` tests `filtered row routes have article-set hydration contracts` and `filtered row product routes include posting-intersection coverage`. |
| [x] | List/detail judgment payload contracts distinguish LLM, human, both-list, and payload kind. | `review.detail.judgments`, `review.detail.humanJudgments`, `review.llm.list.judgments`, `review.human.list.judgments`, `review.both.list.judgments`, and `review.both.list.humanJudgments` in `reviewServingReadContracts.ts`; covered by `reviewServingReadContracts.test.ts` test `human payload contracts cover list and detail response judgments` and `reviewServingSql.test.ts` payload-kind SQL tests. |
| [x] | Filter vocabulary includes explicit date ranges, duplicate/conflict/import-route scope, prompt/human/LLM filters, queue kind, and token-prefix search scope. | `reviewServingFilterKeys` in `reviewServingContracts.ts`; contract use covered by `reviewServingReadContracts.test.ts` tests `review serving contracts represent article-created date ranges explicitly`, count/filter/queue tests, and human facet tests. |
| [x] | Count contracts use named fast count keys and derive list mode from the named count key. | `namedReviewFastCountKeys`, `namedReviewFastCountDefinitions`, and count contracts in `reviewServingContracts.ts` and `reviewServingReadContracts.ts`; SQL behavior in `reviewServingSql.ts`; covered by `reviewServingReadContracts.test.ts` count dependency tests and `reviewServingSql.test.ts` count-shape tests. |
| [x] | Job criteria contracts declare job-table cursor/sort fields and search/job identities. | `review.bulk.selection`, `review.bulk.substringSelection`, `review.export.selection`, `review.pdf.selection`, and `review.search.substringAsync` in `reviewServingReadContracts.ts`; covered by `reviewServingReadContracts.test.ts` test `job criteria contracts use job-table cursor and sort columns` and benchmark operation shape tests. |
| [x] | Manifest reads select usable statuses explicitly. | `buildReviewServingRowsSql` in `reviewServingSql.ts` emits `snapshot_status IN ('active', 'retired')`; covered by `reviewServingSql.test.ts` test `buildReviewServingRowsSql pins snapshot manifests to the active review config`. |
| [x] | Foreground admission is registry-based and rejects mismatched search modes before DuckDB execution. | `reviewServingAdmission.ts`; covered by `reviewServingAdmission.test.ts` tests for unregistered work, budget checks, search-mode mismatch, count shape, readiness, serving identity, and DuckDB workload context mapping. |
| [x] | Every declared change kind has an invalidation registry entry and unknown kinds are not broadened. | `reviewServingChangeKinds` in `reviewServingContracts.ts` and `reviewServingInvalidationRegistry.ts`; covered by `reviewServingInvalidationRegistry.test.ts`. |
| [x] | SQL-shape guard rejects new serving SQL raw fallback shapes and hidden/unbounded scope patterns. | `reviewServingSqlForbiddenPatterns.ts` and `reviewServingSql.ts`; covered by `reviewServingSql.test.ts`, including static source scans and bound project/snapshot predicate tests. |
| [x] | Benchmark harness scaffold, smoke fixture, 10M/7-prompt workload definition, and metrics/release report shapes exist. | `reviewServingBenchmark.ts`, `reviewServingBenchmark.test.ts`, and `reviewServingBenchmark.md`; smoke run covered by `reviewServingBenchmark.test.ts` test `review-serving smoke benchmark runs against mocked inputs without completed schema or projectors`. |

### Stale Assumptions And Gaps

- Phase 0's original cut line says product routes must not switch. That statement is stale for the current branch because later phases have already mounted serving-backed product routes. For Phase 0 dependency purposes, the relevant invariant is now that the contract inventory and static guards still describe and protect the mounted routes.
- The full physical 10M DuckDB benchmark is a Phase 6 release-evidence gate. Phase 0 has a smokeable harness and full workload definition only; it does not provide physical 10M scan/temp/RSS evidence.
- The SQL static source guard intentionally excludes projector, diagnostics, retention, review-config, and residual-read allowlist files. Those files are not foreground serving SQL builders and are covered by later-phase route/residual-read tests where applicable.

### Fixes Made During This Audit

- Updated `reviewServingAdmission.test.ts` to match the current `review.llm.rows` page/result budget of `501` and to include serving identity in over-budget cases so the tests actually prove budget rejection precedence.
- Updated `reviewServingSql.test.ts` to exclude `reviewServingResidualReadAllowlist.ts` from the static serving-SQL source scan, because that file contains audited marker strings such as `INNER JOIN app.judgment judgment`, not executable serving SQL.
- Updated `reviewServingHookInventory.test.ts` so the add-articles route inventory tracks the current bulk job seam, `createReviewBulkOperationJob`, instead of the old direct `insertArticlesIntoProject` fan-in.
- Updated `reviewServingFilterRouteService.test.ts` so tokenization coverage asserts normalized search-token diagnostics and search scope, not obsolete SQL text embedding.

### Audit Verification

- `bun test src/server/reviewServing/reviewServingAdmission.test.ts src/server/reviewServing/reviewServingReadContracts.test.ts src/server/reviewServing/reviewServingSql.test.ts src/server/reviewServing/reviewServingBenchmark.test.ts src/server/reviewServing/reviewServingInvalidationRegistry.test.ts src/server/reviewServing/reviewProjectionIdentity.test.ts src/server/reviewServing/reviewServingCursor.test.ts src/server/reviewServing/reviewServingContracts.test.ts`
- `bun test src/server/reviewServing`
- `bunx eslint src/server/reviewServing` failed on pre-existing prettier issues in untouched files: `reviewServingAdjacentRouteSurfaces.ts`, `reviewServingBenchmark.test.ts`, and `reviewServingBenchmark.ts`.
- `bunx eslint src/server/reviewServing/reviewServingAdmission.test.ts src/server/reviewServing/reviewServingFilterRouteService.test.ts src/server/reviewServing/reviewServingHookInventory.test.ts src/server/reviewServing/reviewServingSql.test.ts`
- `git diff --check`
