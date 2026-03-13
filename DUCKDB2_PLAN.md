# DuckDB2 plan

Goal: remove ClickHouse only after DuckDB matches current ClickHouse contract.

## Rules

- [ ] Match ClickHouse first. No cleanup/behavior changes in same pass.
- [ ] Add parity tests before deleting ClickHouse codepaths.
- [ ] Keep response shape, ordering, paging, error behavior identical.
- [ ] Keep scope/filter/group/having/order/pagination in DuckDB SQL where ClickHouse did SQL-first work.

## `src/services/olap/sqliteOlap.ts`

- [ ] Reviews/count vs `src/services/clickhouse/articlesReviewsClickHouse.ts`: fix `modelId: null`, empty `totalCount`/`totalPages`, prompt-order ties, error contract.
- [ ] Filters vs `src/services/clickhouse/articlesReviewsFiltersClickHouse.ts`: fix answer parsing parity, numeric parsing parity, empty/error contract.
- [ ] Both vs `src/services/clickhouse/articlesReviewsBothClickHouse.ts`: fix page echo, null-date ordering, curated `>1000` behavior, missing-article fallback.
- [ ] Unassessed vs `src/services/clickhouse/unassessedArticlesClickHouse.ts`: fix param usage, zero-judgment behavior, missing-model behavior, cursor semantics.
- [ ] Selection vs `src/services/clickhouse/selectArticleIdsClickHouse.ts`: fix `llm`/`human`/`both` filter semantics, ordering, `modelId: null` behavior.
- [ ] Pushdown: remove JS-heavy materialization/filter/pagination where old ClickHouse path did SQL-first work.

## Tests

- [ ] Add `src/services/olap/sqliteOlap.test.ts` with parity fixtures for reviews, count, filters, both, unassessed, selection.
- [ ] Add route regressions for old ClickHouse-backed behavior still visible at API layer.
- [ ] Keep ClickHouse tests until DuckDB parity passes; delete after cutover.

## Active ClickHouse runtime blockers

- [ ] `src/server/routes/SubprojectsRoutes.ts`: remove direct ClickHouse fast-path after OLAP parity covers prompt-filter selection.
- [ ] `src/server/routes/AdminImportRouteStatsRoutes.ts`: rewrite from SQLite/DuckDB or delete with `src/app/routes/+admin/+import-route-stats/**`.
- [ ] `src/server/routes/AdminInvestigateRoutes.ts`: delete or redesign with `src/app/routes/+admin/+diagnose-unassessed/+index.tsx`; stop SQLite-vs-ClickHouse diff payload.
- [ ] `src/server/routes/AdminClickhouseHealthRoutes.ts`: delete unless a DuckDB health route is still wanted.
- [ ] `src/app/routes/+admin/+clickhouse-sync/**`: delete; regenerate `src/app/routeTree.gen.ts`.

## Final removal

- [ ] Delete `src/services/clickhouse/**`.
- [ ] Remove ClickHouse toggle from `src/server/utils/env.ts` and `src/services/olap/olapDb.ts`.
- [ ] Remove ClickHouse deps from `package.json` and lockfile.
- [ ] Remove ClickHouse infra/docs: `docker-compose.yml`, `scripts/*clickhouse*`, `config/clickhouse/**`, old ClickHouse plans/docs.
- [ ] Delete ClickHouse-only tests after all callers are migrated.
