# Performance Benchmark Plan

## Goal

Add a repo-native performance regression gate for heavy DuckDB/review-serving
operations using synthetic data. The gate should catch broad scans, write fanout,
temp spill, RSS growth, and obvious latency regressions without touching the live
current DB or making the normal test suite fragile.

## Chosen Direction

Use the existing review-serving benchmark harness as the source of truth, then
add a physical DuckDB executor and deterministic synthetic seeding.

This combines:

- Existing benchmark workload/report contracts.
- Shape and budget assertions instead of raw wall-clock-only checks.
- Two benchmark tiers: a medium PR gate and a larger manual/release gate.
- A measure/compare workflow for benchmark-driven optimization tasks.
- Small micro-perf tests only for known high-risk operations.

## Non-Goals

- Do not benchmark against Fredrik's current primary DB.
- Do not add a second parallel benchmark framework.
- Do not make `bun run test:bun` depend on long-running performance gates.
- Do not silently retry, lower scale, raise memory limits, or change benchmark
  settings when a configured benchmark run fails.
- Do not allow benchmark-improvement PRs to change budgets, fixture scale, seed,
  skipped operations, or comparison rules unless that is the explicit requested
  change.

## Benchmark Tiers

### PR Synthetic DB Gate

Purpose: catch common performance regressions during normal review-serving or
DuckDB-heavy PR work.

Target command:

```bash
bun run bench:review-serving-synthetic-check
```

Target properties:

- Uses a temp DuckDB file.
- Uses deterministic synthetic data.
- Runs at medium scale by default.
- Separates seed time, projection/build time, and benchmark query/write time.
- Emits a JSON report with metrics and violations.
- Fails on pass/fail budgets rather than subjective interpretation.

### Manual Release-Scale Gate

Purpose: prove real scale behavior before major review-serving releases or risky
DuckDB lifecycle changes.

Target command:

```bash
bun run bench:review-serving-release-scale
```

Target properties:

- Uses the documented `synthetic10m7PromptOverlap` fixture.
- Requires explicit DuckDB memory limit and scale settings.
- Writes a timestamped JSON artifact.
- Compares against checked-in or explicitly supplied baseline budgets.
- Is documented as manual/long-running, not a default PR gate.

### Targeted Micro-Perf Tests

Purpose: lock in fixes for operations that have already caused incidents or are
obviously high risk.

Candidate areas:

- Summary partial finalization and accumulator reduction.
- Filter option projection refresh.
- Posting projector rebuilds.
- Review list/count/search read contracts.
- DuckDB append lanes and checkpoint-sensitive write bursts.

These should remain adjacent Bun tests with small synthetic fixtures and clear
shape budgets.

## Benchmark Optimization Workflow

Some tasks will explicitly ask an agent to improve benchmark performance. That
workflow should be supported, but it needs stricter controls than a simple
regression gate so the benchmark cannot be accidentally optimized around.

### Measure Mode

Purpose: capture a before/after artifact without failing budgets.

Target command:

```bash
bun run bench:review-serving-synthetic -- --mode=measure --scale=medium
```

Target properties:

- Runs the exact configured fixture, scale, seed, DuckDB memory limit, and
  operation set.
- Writes a JSON artifact with the same metrics as the pass/fail gate.
- Records benchmark-critical configuration: git SHA, scale, seed, fixture
  version, Bun version, DuckDB version, platform, memory limit, command, and
  environment values that affect benchmark behavior.
- Does not lower scale, skip operations, or change thresholds automatically.

### Compare Mode

Purpose: compare two benchmark artifacts and show where performance changed.

Target command:

```bash
bun run bench:review-serving-compare -- --before old.json --after new.json
```

Target properties:

- Fails if before/after artifacts use different benchmark-critical settings
  unless an explicit `--allow-config-drift` flag is supplied.
- Reports total and per-operation deltas for p50/p95/p99 latency, rows scanned,
  rows returned, temp spill, RSS, writer batches, and diagnostic timings.
- Marks target-operation improvements separately from non-target regressions.
- Fails if non-target operations regress beyond the configured tolerance.

### Optimization Guardrails

Benchmark-improvement work must:

- State the target metric and operation before changing code.
- Capture a before artifact in measure mode.
- Capture an after artifact with the same fixture, scale, seed, operation set,
  DuckDB memory limit, and command.
- Include the compare output in the PR or final report.
- Keep correctness tests passing.
- Avoid fixture, budget, threshold, skip-list, scale, seed, and comparison-rule
  changes in the same PR unless the task explicitly asks for benchmark harness
  changes.
- Run a holdout benchmark or release-scale check before accepting broad rewrites
  that materially change query plans, writer behavior, projection layout, or
  intermediate state.

### Holdout Protection

Medium-scale optimization can overfit a single synthetic shape. Add at least one
holdout option before using the benchmark as an agent optimization target:

- Same scale with a different deterministic seed.
- Same article count with different filter/prompt overlap skew.
- Release-scale fixture for high-risk changes.

The holdout run should not be used during the agent's inner optimization loop.
Use it as an acceptance check after the targeted improvement looks real.

## Metrics And Budgets

The first version should prefer stable, actionable budgets:

- Rows scanned per operation.
- Rows returned per operation.
- Foreground temp spill bytes.
- Peak RSS and RSS growth.
- Writer batch count and rows per batch.
- Request/chunk timing diagnostics.
- p95 and p99 latency after warmup.

Wall-clock thresholds are allowed, but only as broad guardrails. A failure should
say what got worse, for example: rows scanned, temp spill, RSS growth, writer
batch fanout, or p95/p99 latency.

## Concrete Checklist

### 1. Inventory Existing Harness

- [x] Document the current `reviewServingBenchmark.ts` smoke/mock flow.
- [x] Identify where workload definitions end and executor behavior begins.
- [x] Confirm `reviewServingBenchmark.test.ts` covers workload shape and release
      report validation.
- [x] Decide whether existing `bench:review-serving-release-gate` should stay as
      smoke/report validation or become a wrapper around the new commands.

### 2. Add Deterministic Synthetic DuckDB Seeding

- [ ] Add a seeder that creates a temp DuckDB file under `.tmp/` or OS temp.
- [ ] Support explicit scales: `small`, `medium`, and `release`.
- [ ] Default PR scale to `medium`.
- [ ] Make seed generation deterministic from a fixed fixture version/seed.
- [ ] Seed enough data to exercise 7-prompt overlap, filters, counts, queues,
      review lists, search, payload hydration, and summary/posting paths.
- [ ] Write a fixture manifest into the report: scale, article count, prompt
      count, overlap rows, fixture version, seed, and DuckDB memory limit.
- [ ] Ensure cleanup removes temp DB, WAL/lock/history files, and temp dirs on
      success and failure.

### 3. Add A Physical DuckDB Executor

- [ ] Extend the benchmark harness with an executor that runs actual DuckDB-backed
      operations instead of mocked observations.
- [ ] Reuse existing review-serving read/write/projector code paths where
      practical.
- [ ] Keep the benchmark isolated from the live current DB.
- [ ] Capture per-operation samples with rows scanned, rows returned, latency,
      queue depth, temp usage, RSS, and diagnostics.
- [ ] Add warmup execution so p95/p99 exclude first-use initialization noise.
- [ ] Surface configured memory limit and benchmark-critical environment in the
      release report.
- [ ] Fail rather than silently changing scale, memory, provider/model settings,
      or execution mode.

### 4. Add Shape/Budget Validation

- [ ] Add PR-tier budgets for the medium synthetic fixture.
- [ ] Add release-tier budgets for the `synthetic10m7PromptOverlap` fixture.
- [ ] Fail if foreground samples spill to DuckDB temp storage.
- [ ] Fail if rows scanned exceed the per-operation budget.
- [ ] Fail if writer batch count or rows-per-batch fanout exceeds budget.
- [ ] Fail if peak RSS or RSS growth exceeds budget.
- [ ] Fail on broad p95/p99 latency guardrails after warmup.
- [ ] Include violations in the JSON report and terminal output.

### 5. Add Measure And Compare Modes

- [ ] Add measure mode that writes artifacts without failing budget thresholds.
- [ ] Add compare mode that accepts `--before` and `--after` artifacts.
- [ ] Fail compare mode when benchmark-critical settings drift unexpectedly.
- [ ] Report per-operation improvements and regressions.
- [ ] Add non-target regression tolerance for optimization tasks.
- [ ] Add support for a target-operation or target-metric label in artifact
      metadata.

### 6. Add Package Scripts

- [ ] Add `bench:review-serving-synthetic-check` for the medium PR gate.
- [ ] Add `bench:review-serving-synthetic` for explicit measure/check modes.
- [ ] Add `bench:review-serving-compare` for artifact comparison.
- [ ] Add `bench:review-serving-release-scale` for the manual long gate.
- [ ] Keep `bench:review-serving-smoke` for fast contract validation unless it is
      intentionally replaced.
- [ ] Ensure scripts set explicit runtime profile, DuckDB path, and memory limit.

### 7. Add Targeted Micro-Perf Tests

- [ ] Add a focused summary finalization perf regression test.
- [ ] Add a focused filter option projection refresh perf regression test.
- [ ] Add a focused posting projector rebuild perf regression test.
- [ ] Add read-contract micro-perf coverage for list/count/search if the physical
      benchmark does not provide enough diagnostic granularity.
- [ ] Keep these tests small enough for targeted `bun test path/to/file.test.ts`
      runs.

### 8. Add Optimization Workflow Guardrails

- [ ] Document the required before/after artifact flow for agent optimization.
- [ ] Document that optimization tasks must declare the target metric and
      operation before code changes.
- [ ] Block benchmark-improvement PRs from changing fixture, scale, seed,
      skipped operations, budgets, or comparison rules unless explicitly scoped.
- [ ] Add holdout fixture support for optimization acceptance checks.
- [ ] Require holdout or release-scale evidence for broad performance rewrites.

### 9. Document In `PERF.md`

- [ ] Add the PR synthetic benchmark command with scope, expected runtime, and when to
      run it.
- [ ] Add measure and compare commands for benchmark optimization work.
- [ ] Add the release-scale benchmark command as manual/long-running.
- [ ] State that performance gates use temp synthetic DBs and never the current
      DB by default.
- [ ] State which DuckDB/review-serving changes require the PR perf gate.
- [ ] State where JSON artifacts are written.
- [ ] State that benchmark optimization requires before/after artifacts and
      compare output.
- [ ] Keep `TESTS.md` focused on correctness, smoke, and regression tests, with
      only a pointer to `PERF.md` for benchmark workflows.

### 10. Baseline And Artifacts

- [ ] Decide artifact location, for example `.tmp/benchmarks/` for local output.
- [ ] Decide whether release baselines are checked in or supplied manually.
- [ ] Store enough identity data to compare runs: git SHA, fixture version, scale,
      memory limit, platform, Bun version, DuckDB version, and benchmark command.
- [ ] Make baseline comparison tolerant to machine noise but strict on shape
      regressions.
- [ ] Store target metric/operation metadata for optimization runs.
- [ ] Store holdout fixture identity when a holdout run is used.

## Quality Gates

Initial implementation should pass:

```bash
bun test src/server/reviewServing/reviewServingBenchmark.test.ts
bun run bench:review-serving-smoke
bun run bench:review-serving-synthetic-check
bun run bench:review-serving-synthetic -- --mode=measure --scale=medium
bun run bench:review-serving-compare -- --before <before.json> --after <after.json>
bun run lint
```

If schema or migration code changes, also run:

```bash
bun run db:mig
```

If any micro-perf test is added, run its exact targeted command before the broader
gates.

## Open Decisions

- What article count should `medium` use on Fredrik's dev machine: 100k, 250k,
  500k, or 1M?
- Should release-scale baselines be checked into the repo or stored as generated
  artifacts outside git?
- Should PR-tier latency budgets be absolute or compared against a local baseline
  generated at the beginning of the run?
- Which existing projector/read paths are safe to call directly from the physical
  executor without starting a full server stack?
- What non-target regression tolerance is acceptable for optimization work?
- Should the first holdout be a different seed, a different skew profile, or the
  full release-scale fixture?
