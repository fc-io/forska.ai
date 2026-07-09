# Review Serving Benchmark Harness

The smoke fixture uses mocked review-serving work items and admission decisions,
so it does not require a populated 10M DuckDB database, serving tables, or
projectors. It validates the release workload shape and release-report contract.

`reviewServingBenchmark.ts` currently owns the benchmark fixture, workload,
admission, sample, metric, and release-report contracts. Workload definitions end
at `ReviewServingBenchmarkWorkloadDefinition` plus generated `workItems`; actual
execution begins at `ReviewServingBenchmarkExecutor`. The smoke command uses the
default executor, which returns each mocked `workItem.observation`. Physical
DuckDB benchmark commands should inject an executor that preserves the same
workload/report contracts while sourcing observations from an isolated synthetic
DuckDB file.

The full benchmark fixture is `synthetic10m7PromptOverlap`: 10,000,000
articles, 7 prompts, and 70,000,000 article-prompt overlap rows. The true
physical full run is a Phase 6 release-evidence gate and is not required for
Phase 0 or Phase 5 synthetic validation completion.

The metrics and release-report contract records p50, p95, and p99 latency; RSS
memory; DuckDB memory limit; temp-dir growth; temp usage; queue depth; rows
scanned; rows returned; admitted or rejected work; and active snapshot, manifest,
count, search, project, and review-config identity state.

The release workload shape covers import append checkpoints, dirty
materialization resume checkpoints, serving refresh health/warning checkpoints,
review lists, filters, named counts, token-prefix search, async substring state,
bulk jobs, export/PDF jobs, article-set hydration, list/detail payload hydration,
human facets/options, queue reads, and desktop-style interruption/resume slices.
Validation fails on missing dimensions, request-slice diversity gaps, wrong
count keys/filter prefixes, bad search/count/job dimensions, over-wide scanned
rows, over-page returned rows, foreground temp spill, p95/p99 latency breaches,
RSS breaches, missing identity fields, or negative temp growth.

Phase 6 physical runs fail if p95 latency exceeds 2,000 ms, p99 latency exceeds
5,000 ms, peak process RSS exceeds 20 GiB, process RSS growth exceeds 4 GiB, or
any accepted foreground sample records DuckDB temp spill.

Smoke command:

```bash
bun run bench:review-serving-smoke
```

Repo-native release-gate validation command:

```bash
bun run bench:review-serving-release-gate
```

This command does not claim a true 10M DuckDB run. A real release-scale run must
provide `benchmarkRunKind: "releaseScaleDuckDb"`, the DuckDB memory limit used,
temp-dir growth, and active snapshot identity values in the emitted release
report.

`bench:review-serving-release-gate` remains the fast smoke/report validation
wrapper. Physical synthetic gates use separate `bench:review-serving-synthetic-*`
commands so benchmark-critical fixture scale, memory, and mode stay explicit.
