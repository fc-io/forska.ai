# Performance Benchmarks

Run benchmark commands through `bun run ...` from the repo root.

This file is for performance measurement, benchmark gates, and benchmark-driven
optimization workflows. Correctness, smoke, and regression tests live in
[TESTS.md](TESTS.md).

## Benchmark Integrity

- Treat fixture version, scale, seed, DuckDB memory limit, operation set,
  skipped operations, budgets, and comparison rules as benchmark-critical
  configuration.
- Do not silently retry, lower scale, raise memory limits, skip operations, or
  relax thresholds when a configured benchmark run fails.
- Do not mix benchmark harness/budget changes with benchmark optimization changes
  unless that is the explicit scope of the work.
- Keep benchmark artifacts when comparing before/after changes.
- Run correctness tests from [TESTS.md](TESTS.md) before treating a faster result
  as acceptable.

## Current Commands

| Command | What It Measures | Notes |
| --- | --- | --- |
| `bun run bench:articlesreviews` | `/api/articlesreviews` latency and response size | Requires a running server at `--base-url`, defaulting to `http://localhost:3004`. Supports filtered/unfiltered modes, iterations, warmup runs, project id, limit, page, and cursor steps. |
| `bun run bench:duckdb-append-lanes` | DuckDB append-lane throughput | Uses a temp DuckDB file and compares lane counts. Useful for write-lane throughput and queue-depth experiments. |
| `bun run bench:project-transfer` | Project transfer package/export/import performance | Supports single fixtures or `--fixture=matrix`, repeated runs, metrics output, progress output, and baseline files. |
| `bun run bench:review-serving-smoke` | Review-serving benchmark contract smoke | Uses mocked benchmark observations. It validates workload/report shape and does not claim a physical synthetic DuckDB run. |
| `bun run bench:review-serving-synthetic-check` | Medium synthetic DuckDB PR gate | Uses a temp DuckDB file under `.tmp/benchmarks/`, deterministic synthetic data, warmup-excluded samples, and pass/fail shape budgets. Run this for DuckDB/review-serving query, writer, projector, or benchmark-sensitive changes. |
| `bun run bench:review-serving-synthetic -- --mode=measure --scale=medium` | Measure-only synthetic artifact generation | Writes JSON artifacts without failing budgets. Use for before/after optimization evidence. Supports `--scale=small|medium|release`, `--seed=<n>`, `--holdout`, `--target-operation=<key>`, and `--target-metric=<metric>`. |
| `bun run bench:review-serving-compare -- --before=<old.json> --after=<new.json>` | Synthetic artifact comparison | Fails on benchmark-critical config drift unless `--allow-config-drift` is supplied. Reports per-operation deltas and fails on non-target regressions. |
| `bun run bench:review-serving-release-gate` | Review-serving benchmark test plus smoke report | Runs `reviewServingBenchmark.test.ts` and `bench:review-serving-smoke`; this is still a repo-native contract gate, not the planned physical release-scale DuckDB benchmark. |
| `bun run bench:review-serving-release-scale -- --confirm-release-scale --duckdb-memory-limit=6400MiB` | Manual long-running release-scale synthetic gate | Guarded wrapper around the release synthetic scale. It requires explicit confirmation and memory limit. |

Additional review-serving benchmark context lives in
[src/server/reviewServing/reviewServingBenchmark.md](src/server/reviewServing/reviewServingBenchmark.md).

## Review-Serving Synthetic Benchmarks

The physical synthetic benchmark uses temporary DuckDB files by default, never
Fredrik's current primary DB. Artifacts are written under `.tmp/benchmarks/`.

## Benchmark Optimization Workflow

Use this workflow when asking an agent to improve benchmark performance:

1. State the target operation and metric before code changes.
2. Run measure mode to capture a before artifact.
3. Make the code change without altering fixture scale, seed, budgets, skipped
   operations, or comparison rules.
4. Run the same benchmark in measure mode to capture an after artifact.
5. Run compare mode and inspect target improvements plus non-target regressions.
6. Run the relevant correctness tests from [TESTS.md](TESTS.md).
7. For broad query-plan, writer, projection, or intermediate-state changes, run a
   holdout fixture or release-scale benchmark before accepting the optimization.

Compare mode fails when before/after artifacts drift on benchmark-critical
configuration unless an explicit override is supplied for benchmark-harness work.

## Artifacts

Artifact location: `.tmp/benchmarks/`.

Benchmark artifacts should record:

- Git SHA.
- Benchmark command.
- Fixture version, scale, seed, and holdout identity when applicable.
- DuckDB memory limit and relevant benchmark-critical environment values.
- Platform, Bun version, and DuckDB version.
- Per-operation latency, rows scanned, rows returned, temp spill, RSS, writer
  batches, and diagnostic timings.
