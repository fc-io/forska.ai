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
| [ ] | Contracts, budgets, and module boundary | Add `src/server/reviewServing/` with contracts, projection identity builders, invalidation registry, read registry, cursor helpers, SQL-shape test helpers, admission interfaces, route-specific parity contracts, and diagnostics shape. | Every planned hot read has a contract entry mapped to product routes in the migration inventory, every hot read has a declared physical table/cursor/budget/count/filter-access behavior, every delta kind maps to first affected component/downstream dependents/update mode, foreground admission is registry-based, and static tests guard the new SQL builders/registries from raw fallback shapes. |
| [ ] | Benchmark harness | Add the 10M-article/7-prompt synthetic fixture generator, overlap workload definition, memory limits, and metrics capture API. | The harness can run a smoke workload before final schema/projectors exist and can later run the full fixture. It reports p50/p95/p99 latency, memory, temp usage, queue depth, rows scanned, rows returned, and admitted/rejected work. The full 10M pass remains a Phase 5 release gate. |

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
- Do not add route behavior changes in Phase 0.
- Do not fail tests only because legacy pre-cutover routes still use raw OLAP paths.
- Every normal hot read planned for Phase 4 must have a contract before route migration starts.
- Every delta kind planned for Phase 2 and Phase 3 must have an invalidation registry entry before write paths emit it.
- The registry is the source of truth for first affected component, downstream dependents, affected keys, and update mode.
- SQL-shape guards should reject `selected_scoped_article_import`, `ROW_NUMBER(`, `OFFSET`, raw `app.article`/`app.judgment` scans, `json_extract`, and unbounded foreground `GROUP BY` in new serving SQL.

## Quality Gates

- [ ] `bun test src/server/reviewServing`
- [ ] `bunx eslint src/server/reviewServing`
- [ ] `bun run lint`
- [ ] Static tests prove every `reviewServingReadContracts.ts` key has workload class, cursor spec, budgets, allowed filters, physical filter access strategy, named fast counts, freshness behavior, and required/optional components.
- [ ] Static tests prove every `reviewServingChangeKind` has an invalidation registry entry and no unknown change kind becomes broad project invalidation.
- [ ] SQL-shape tests prove new serving SQL cannot include raw fallback shapes.
- [ ] Benchmark smoke harness can run without requiring completed schema/projectors.
