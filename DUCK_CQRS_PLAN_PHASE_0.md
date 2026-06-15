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
| [ ] | Benchmark harness | Add the 10M-article/7-prompt synthetic fixture generator, overlap workload definition, memory limits, and metrics capture API. | The harness can run a smoke workload before final schema/projectors exist and can later run the full fixture. It reports p50/p95/p99 latency, memory, temp usage, queue depth, rows scanned, rows returned, and admitted/rejected work. The full 10M pass remains a Phase 5 release gate. |

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
- The Phase 5 workload definition in the benchmark harness must exercise the
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
