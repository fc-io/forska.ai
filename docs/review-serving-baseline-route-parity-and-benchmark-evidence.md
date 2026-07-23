# Review-Serving Baseline Route Parity And Benchmark Evidence

## Scope And Non-Claims

This is a small evidence artifact for the storage-shape audit follow-up. It is
separate from `STORAGE_SHAPE_AUDIT_PLAN.md`.

This artifact records available route-parity and benchmark-contract evidence. It
does not claim physical release-scale DuckDB evidence, live browser parity, or
authorization to delete/slim storage.

## Commands

Route parity:

```bash
bun test src/server/reviewServing/reviewServingRouteParityCoverage.test.ts src/server/reviewServing/reviewServingRouteParityEvidence.test.ts src/server/reviewServing/reviewServingRouteParityRunner.test.ts
```

Result on `evidence/review-storage-audit-unblocker-20260723`:

```text
17 pass, 0 fail, 40 expect() calls
```

Benchmark contract:

```bash
bun test src/server/reviewServing/reviewServingBenchmark.test.ts
bun run bench:review-serving-smoke
bun run bench:review-serving-release-gate
```

Results on `evidence/review-storage-audit-unblocker-20260723`:

```text
reviewServingBenchmark.test.ts: 26 pass, 0 fail, 81 expect() calls
bench:review-serving-smoke: emitted syntheticValidation report, sampleCount 31, p95 20 ms, p99 20 ms, tempUsage.totalBytes 0
bench:review-serving-release-gate: passed
```

Current-DB smoke/progress gate:

```bash
bun run test:dev-server:current-db
```

Result on `evidence/review-storage-audit-unblocker-20260723` at git SHA
`77275f3d`:

```text
failed: forbidden output contained "DuckDB fatal runtime restart"
0 pass, 1 fail, 3 expect() calls
```

The dev stack reached readiness and projector statements made progress in the
captured output, but the gate explicitly rejects the fatal restart signal. This
artifact therefore records the blocker and does not claim current-DB gate
success.

Optional live HTTP baseline for the currently available `/api/articlesreviews`
benchmark:

```bash
bun run bench:articlesreviews -- --base-url=http://localhost:3004 --project-id=7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac --mode=both --iterations=5 --warmup-runs=1 --limit=100 --cursor-steps=3
```

## Evidence Boundary

- Route parity coverage is source/synthetic reader evidence.
- `bench:review-serving-smoke` emits a synthetic validation report.
- `bench:review-serving-release-gate` runs benchmark tests plus synthetic smoke.
- Existing live HTTP benchmarking covers `/api/articlesreviews`; it does not yet
  cover every review-serving route or job surface.
- Current-DB mutation progress remains guarded by `bun run test:dev-server:current-db`.

## Gaps And Required Follow-Up

- Add live HTTP baseline coverage for the remaining mounted review-serving
  routes and job surfaces before route-level storage changes.
- Add true physical DuckDB benchmark artifacts before claiming release-scale
  performance proof.
- Record approved project, snapshot identity, runtime profile, memory limit,
  temp directory, and git SHA for any live/physical baseline.
- Keep raw outputs under `.tmp/evidence/` or another explicit artifact path.
