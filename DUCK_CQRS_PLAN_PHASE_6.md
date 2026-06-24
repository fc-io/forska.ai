# DuckDB CQRS Plan Phase 6 - Physical Release Evidence And Cutover Proof

Master coordinator: [DUCK_OOM_FIX_PLAN.md](./DUCK_OOM_FIX_PLAN.md)

## Objective

Collect the physical release evidence that cannot be proven by repo-native synthetic validation. Phase 6 does not add product implementation scope; it proves the final cutover gates on a real release-scale DuckDB database and desktop runtime.

## Owned Final Cutover Gates

- [ ] True 10M/7-prompt DuckDB release-scale run with physical row-group/rows-scanned, temp-dir, RSS, latency, queue, admission, and active identity evidence.
- [ ] Large local desktop sleep/process-kill interruption evidence.
- [ ] Release-scale proof that routine deltas and compaction stay within hot-route budgets.
- [ ] Adversarial OOM and legacy-retirement evidence covering checkpoint, append/import, V4 chunk retry, cross-project, offline repair, and blocked legacy rebuild paths.

## Prerequisites

- Phases 0 through 5C are complete in the master coordinator.
- `bun run bench:review-serving-release-gate` passes as synthetic validation before the physical run starts.
- The release-scale machine, data root, DuckDB path, DuckDB memory limit, DuckDB temp directory, and output evidence directory are chosen before work starts.
- The evidence bundle records commit SHA, branch, command lines, environment variables, machine RAM, disk free space, report paths, log paths, and operator notes.
- If a repo-native release-scale runner or fixture builder is missing, add that tooling first. Do not mark Phase 6 complete by adapting the smoke runner output.

Suggested evidence directory shape:

```text
artifacts/review-serving-phase6/<YYYYMMDD-HHMM>-<commit>/
  environment.md
  release-scale-report.json
  duckdb-physical-profile.json
  desktop-interruption.md
  delta-compaction-report.json
  adversarial-oom.md
  legacy-retirement.md
  logs/
```

## Gate 1 - True 10M/7-Prompt Release-Scale Run

Steps:

1. Prepare the target machine with the intended DuckDB memory limit, temp directory, and foreground admission settings.
2. Record baseline state: commit SHA, `git status --short`, DuckDB memory limit, DuckDB temp directory, temp-dir size, data-root free space, machine RAM, and active runtime profile.
3. Run DuckDB migrations against the fixture database if the fixture data root has not been migrated at the current commit. Use an explicit fixture `DUCKDB_PATH`; do not rely on `bun run db:mig` unless the selected runtime profile is already pointed at the release fixture.
4. Build the 10M/7-prompt fixture if it does not already exist. If it does exist, verify dimensions before reuse: 10,000,000 project articles, 7 prompts, 70,000,000 article-prompt overlap rows, expected import routes, expected review modes, and expected search/count/job dimensions.
5. Run the release benchmark with `benchmarkRunKind: "releaseScaleDuckDb"` and the same workload shape validated by `bun run bench:review-serving-release-gate`. If no command exists yet, add a repo-native runner such as `bun run bench:review-serving-release-scale -- --fixture <fixture> --out <evidence-dir>` before claiming this gate.
6. Capture the emitted release report and DuckDB/runtime evidence from the same run.
7. Capture legacy-retirement evidence from the same runtime: no normal legacy large-rebuild heartbeat, no claimable old phase rows, no legacy normal SQL execution, and no warning/admin/recovery side effect that schedules V3 repair.
8. Fail the gate if any accepted foreground hot read spills temp, exceeds latency/RSS budgets, lacks active identity fields, scans beyond the registered contract ceiling, or relies on legacy rebuild/repair state for freshness.

Command checklist:

- [ ] `git rev-parse HEAD`
- [ ] `git status --short`
- [ ] `bun run bench:review-serving-release-gate`
- [ ] `DUCKDB_PATH=<fixture-duckdb-path> DUCKDB_MEMORY_LIMIT=<limit> DUCKDB_TEMP_DIRECTORY=<temp-dir> bun src/db/migrateDuckdb.ts` if the fixture needs migrations
- [ ] Build fixture if absent; otherwise run the fixture-dimension verification command and save its output
- [ ] Run the physical release-scale benchmark with `benchmarkRunKind: "releaseScaleDuckDb"` and save stdout/stderr plus JSON reports
- [ ] Save legacy-retirement proof from the benchmark runtime: startup loops, package entrypoints, warning/admin/recovery routes, old phase rows, and observed SQL/event logs

Evidence checklist:

- [ ] Fixture dimensions: article count, prompt count, overlap row count, import-route distribution, review-mode coverage, job/search/count dimensions.
- [ ] Environment: DuckDB memory limit, temp directory path, temp directory before/after bytes, machine RAM, process/thread settings.
- [ ] Physical reads: row groups touched, rows scanned, rows returned, scan ceiling per operation, foreground temp-spill status.
- [ ] Runtime metrics: p50/p95/p99 latency, peak RSS, RSS growth, queue depth, admitted/rejected counts.
- [ ] Active identities: project, snapshot, review config, manifest, component identities, count identity, search identity.
- [ ] Workload coverage: import, dirty materialization, serving refresh, review list, filters, counts, token-prefix search, async substring state, bulk/export/PDF jobs, article-set hydration, list/detail payloads, human facets/options, queue reads.
- [ ] Legacy retirement: no normal execution of `project_scope_article`, `judgment_fact`, `prompt_answer_fact`, `review_answer_dictionary`, filter-member, rollup, serving, or detail legacy phases; old state is absent, retired, or admin/debug-only.

## Gate 2 - Large Local Desktop Interruption Evidence

Steps:

1. Use a large local desktop database derived from the release fixture or a documented large equivalent with the desktop DuckDB memory profile.
2. Run `bun run desktop:build` and launch the desktop app path against the large database.
3. Confirm requests flow through the shared backend `/api/` routes, serving contracts, admission, and job/projector workers.
4. While projector, bulk/export/PDF, search, and cleanup work is active, run OS sleep/resume and process-kill/restart scenarios.
5. After each interruption, wait for ownership recovery and resume processing without manual database repair.
6. Fail the gate if jobs lose durable progress, snapshots become unreadable without a supported freshness state, cleanup deletes pinned data, or desktop behavior diverges from browser route behavior.
7. Fail the gate if desktop startup or recovery mounts legacy large-rebuild/dirty-refresh cycles for normal product freshness.

Command checklist:

- [ ] `bun run desktop:build`
- [ ] Launch desktop against the large data root and record the backend command, PID, API origin, DuckDB path, memory limit, and temp directory.
- [ ] Start active projector, bulk/export/PDF, search, and cleanup work.
- [ ] Record OS sleep start/end timestamps and logs.
- [ ] Kill the desktop backend or worker process during active work, relaunch, and record recovery logs.
- [ ] Query or export job/projector/search/cleanup state before and after each interruption.

Evidence checklist:

- [ ] Desktop runtime config: backend command, API bridge/origin, DuckDB memory limit, temp directory, database path.
- [ ] Interruption matrix: OS sleep/resume, backend process kill, desktop app quit/reopen, worker lease expiration, restart during cleanup.
- [ ] Resume state: projector dirty-work release, chunk skip/resume, bulk/export/PDF cursor progress, search job progress, cleanup mark/pin protection.
- [ ] User-visible state: active, stale, indexing, unavailable, failed, retired, candidate, and missing snapshot diagnostics where applicable.
- [ ] Browser parity: same API route behavior and no desktop-only raw fallback, large-offset pagination, or unbounded ID materialization.
- [ ] Legacy retirement: desktop startup, warning/progress reads, recovery, and admin status do not schedule old V3 refresh or large-rebuild work.

## Gate 3 - Routine Delta And Compaction Hot-Route Budgets

Steps:

1. On the release-scale fixture, apply repeated small article/title, judgment, human-review, import append, and prompt/config deltas.
2. Record dirty-work rows, component acknowledgements, patch rows, contribution diffs, and compaction decisions after each delta batch.
3. Run the affected hot routes before and after compaction using the same registered read contracts and admission budgets.
4. Confirm compaction triggers before patch reads exceed hot-route scan, temp, latency, RSS, or response-size budgets.
5. Fail the gate if routine deltas create full 10M-row serving copies, unrelated component rebuilds, permanent per-key dirty acknowledgements, or route reads that exceed contract ceilings before compaction.

Command checklist:

- [ ] Start from an active 10M serving snapshot and record active snapshot/identity state.
- [ ] Apply each delta batch separately: article/title, judgment, human-review, import append, prompt/config, and no-op/idempotent replay.
- [ ] After each batch, export dirty-work, acknowledgement, patch/base, manifest, contribution, and watermark state.
- [ ] Run the affected hot-route benchmark slices before compaction and save physical read metrics.
- [ ] Trigger natural or configured compaction thresholds at release scale and save compaction decision/output state.
- [ ] Re-run hot-route benchmark slices after compaction and compare scan, temp, latency, RSS, response-size, and queue metrics.

Evidence checklist:

- [ ] Delta batches: article/title, judgment, human-review, import append, prompt/config, and no-op/idempotent replay cases.
- [ ] Bounded work: affected components, dirty keys/ranges, acknowledgement compaction, contribution diff counts, skipped unrelated projections.
- [ ] Patch/base state: base generation, patch watermark, patch row counts, compaction threshold, compaction output rows, retained pinned state.
- [ ] Hot-route budget proof: rows scanned, row groups touched, temp spill, p95/p99 latency, RSS, response bytes, queue depth before and after compaction.
- [ ] Identity proof: display/import/title/payload/search identities remain stable when inputs are unchanged; prompt-level identities rebuild only affected prompt projections.

## Gate 4 - Adversarial OOM And Legacy-Retirement Proof

Steps:

1. Start from the Phase 5C cutover state with legacy normal rebuild disabled and V4 rebuild requests/chunks enabled.
2. Trigger or simulate each adversarial OOM class: checkpoint under heavy writer/temp pressure, append/import burst with large payloads, over-budget V4 chunk, repeated failed chunk retry, cross-project dirty/rebuild burst, stale recovery command, warning/admin remediation path, and offline repair from failed or invalidated runtime state.
3. Confirm each case is admitted, split, cooled down, parked, quarantined, or rejected before retrying the same unsafe shape.
4. Confirm last-known-good snapshots remain readable and no failed/missing/stale V4 state schedules a legacy raw/mart rebuild.
5. Save durable OOM/workload events and operator-visible diagnostics for each case.
6. Fail the gate if any case silently retries, mutates DuckDB settings to chase success, schedules legacy normal work, loses pinned state, or requires manual database edits without an explicit offline repair plan.

Command checklist:

- [ ] Run the repo-native adversarial OOM/recovery test suite added in Phase 5C.
- [ ] Run checkpoint pressure proof and save WAL/temp/RSS/checkpoint logs.
- [ ] Run append/import burst proof and save row/parameter/payload/lane-pressure logs.
- [ ] Run V4 chunk over-budget and retry-thrash proof and save request/chunk state.
- [ ] Run cross-project fairness proof and save per-project queue/cooldown state.
- [ ] Run warning/admin/recovery side-effect proof and save route/script outputs.
- [ ] Run offline repair proof and save repair plan plus resumed runtime state.

Evidence checklist:

- [ ] OOM event shape: error class, operation, SQL shape hash, route/job/project/component/chunk, retry count, retry-after, memory limit, threads, temp dir bytes, WAL/checkpoint size, append lane depth, queue depth, RSS, fallback decision, and legacy-blocked flag.
- [ ] Checkpoint proof: no checkpoint retry loop, no corrupt owner state, and clear restart or offline repair state.
- [ ] Append/import proof: batches split by row count, parameter count, payload bytes, lane pressure, and project fanout before DuckDB execution.
- [ ] V4 chunk proof: over-budget work is split, parked, or quarantined with previous snapshot active and no partial promotion.
- [ ] Cross-project proof: one project cannot monopolize projector, append, checkpoint, or maintenance queues.
- [ ] Recovery proof: stale claims, warning/admin actions, and offline repair enqueue V4 work or remain read-only; legacy normal rebuild stays blocked.

## Quality Gates

- [ ] True 10M/7-prompt DuckDB release-scale run evidence is captured and passes the physical read, temp, RSS, latency, queue, admission, and identity checks above.
- [ ] Large local desktop sleep/process-kill interruption evidence is captured and passes the resume, pin, job, route, and browser-parity checks above.
- [ ] Release-scale routine delta and compaction evidence is captured and proves hot-route budgets hold before final cutover.
- [ ] Adversarial OOM and legacy-retirement evidence is captured and passes the checkpoint, append/import, V4 chunk, retry-thrash, cross-project, recovery, and offline-repair checks above.
