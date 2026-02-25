# DuckDB plan (after SQLite)

## Goal

- DuckDB is only analytics engine.
- Remove ClickHouse.
- Remove Drizzle.

## Checklist

- [ ] Prerequisite: SQLite is primary application database.
- [ ] Decide DuckDB runtime: in server process, or separate `duckdb-api` service.
- [ ] Decide DuckDB data mode:
  - [ ] Scan SQLite file directly.
  - [ ] Materialize into `.duckdb` file, refresh job.
- [ ] Implement DuckDB query runner: parameter support, timeout, logging, profiling output.
- [ ] Port analytics queries:
  - [ ] Articles reviews list.
  - [ ] Articles reviews count.
  - [ ] Articles reviews filters.
  - [ ] Unassessed counts and lists.
  - [ ] Select article identifiers by filters.
  - [ ] Both human and model assessed list (if still needed).
- [ ] Correctness gates: golden cases, row counts, stable samples.
- [ ] Performance gates: median and 95th percentile timings on real dataset.
- [ ] Cutover: route all analytics endpoints to DuckDB.
- [ ] Delete old stack: ClickHouse code, containers, environment variables.
