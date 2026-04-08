# Faster Rebuild Plan

## Goal

- Make project mart large rebuilds catch up fast enough that `lastAckSeq` advances and retained SQLite rows drain.
- Tune the background writer path for large rebuilds without assuming only one machine shape.
- Keep laptop-safe defaults, but stop hard-coding a throughput profile that is too slow for large projects.

## Live Background Readout

- Worker process: `bun` on port `3002`, pid `21781`, `DUCKDB_MEMORY_LIMIT=4GB`, role `worker`.
- API follower: `bun` on port `3001`, pid `21785`.
- Machine RAM: `51,539,607,552` bytes total, current macOS free memory about `38%`.
- Worker RSS: about `3.56GB`, CPU about `139%` during rebuild activity.
- DuckDB main file: about `203GB` at `/Users/fredrc/Library/Application Support/Forska/forska.duckdb`.
- DuckDB temp dir: about `69MB` at `/Users/fredrc/Library/Application Support/Forska/duckdb-temp`, stable across samples.
- Append metrics were quiet: queue depth `0`, last append activity earlier, no current append backlog.
- Large rebuild cursor kept advancing with no errors for project `2293577e-95a6-443d-ae18-76bd25eb34e5` while `refreshStatus` returned to `idle` between cycles.

## What This Means For 4 vs 5

- `#5 DuckDB memory limit` does not look like the live bottleneck right now.
  - The worker is near the current `4GB` cap, but the machine itself is not under memory pressure.
  - Temp spill stayed tiny and flat (`69MB`), which is not what a memory-thrashing rebuild usually looks like.
  - There were no OOM-like failures, spill explosions, or WAL/temp growth suggesting memory pressure was forcing the slowdown.
- `#4 shared DuckDB queue contention` is also not the main live bottleneck right now.
  - Append lanes were idle.
  - The mart refresh loop showed no active drain backlog.
  - We do not currently expose main DuckDB queue depth, so this is an inference, not a direct metric.
- The dominant live bottlenecks are still `#1 batch size`, `#2 poll interval`, and `#3 one cycle per wake`.

## Why The Worker Default Is 4GB

- I did not find a documented rationale in the repo for `src/server/utils/backgroundServerStack.ts:12` using `4GB`.
- The likely reason is conservative dev safety:
  - keep the split background writer from taking over a laptop,
  - leave headroom for the API server, browser, editor, Bun, and OS,
  - make `bun scripts/startServerStack.ts` predictable on 8-16GB machines.
- That made sense as a safe baseline, but it is too conservative as a universal default for large rebuilds on larger-memory machines.
- The good news: the code already supports override via `BACKGROUND_WRITER_DUCKDB_MEMORY_LIMIT` or fallback `DUCKDB_MEMORY_LIMIT`.

## Recommendation On Memory Default

- Do not keep `4GB` as the universal worker default.
- Replace it with a machine-aware default, while preserving explicit env overrides.
- Suggested tiered default for the background writer:
  - total RAM `<= 8GB` -> `2GB`
  - total RAM `<= 16GB` -> `4GB`
  - total RAM `<= 32GB` -> `8GB`
  - total RAM `> 32GB` -> `12GB`
- On this machine, that would make the worker default `12GB`.
- Keep `BACKGROUND_WRITER_DUCKDB_MEMORY_LIMIT` as the escape hatch for very small or very large machines.

## Tuning Strategy

### 1. Batch Size

- Current default `PROJECT_MART_LARGE_REBUILD_BATCH_SIZE=1` is the first thing to fix.
- Strategy:
  - move default to something meaningful, not heroic: start around `128`;
  - let larger machines or manual recovery use `256`, `512`, or `1000`;
  - keep env override for targeted bursts.
- Runtime rule:
  - if a cycle finishes quickly and temp dir stays flat, increase batch size;
  - if cycle latency spikes hard, temp dir starts growing fast, or API latency regresses, reduce it.
- Cross-machine default:
  - use `128` as portable baseline,
  - recommend `256` on `>= 16GB` machines,
  - recommend `512` on `>= 32GB` machines during catch-up.

### 2. Poll Interval

- Current default `PROJECT_MART_LARGE_REBUILD_POLL_INTERVAL_MS=5000` is too sleepy.
- Strategy:
  - lower idle poll to `500-1000ms`;
  - do not sleep between successful cycles when more rebuild work is immediately available.
- Practical default:
  - `1000ms` portable default,
  - `500ms` for explicit catch-up mode.

### 3. One Cycle Per Wake

- The current heartbeat runs one cycle, then waits for the next timer tick.
- That wastes time even when the same project still has obvious remaining work.
- Strategy:
  - keep one claimed rebuild per worker by default,
  - but let each wake run a bounded burst of consecutive cycles before sleeping.
- Proposed new control:
  - `PROJECT_MART_LARGE_REBUILD_MAX_CYCLES_PER_WAKE`, default around `4` or `8`.
- Stop a burst early on:
  - `idle`,
  - `failed`,
  - `paused`,
  - repeated no-progress,
  - time-budget exhaustion.
- This is safer than jumping straight to multi-project concurrency.

### 4. Shared DuckDB Queue Contention

- Right now large rebuild executor work goes through the normal DuckDB `queryJson` / `run` path.
- That means rebuild work shares the same serialized writer queue as other app DB work.
- It is not the dominant bottleneck in the current live sample, but it will matter once 1-3 are raised.
- Strategy:
  - first add direct metrics for main queue depth and wait time, not just append-lane metrics;
  - then move large rebuild batch work onto the background DuckDB queue or a dedicated rebuild queue/connection;
  - keep rebuild execution serialized at first, but isolate it from short control-plane writes and reads.
- Proposed metrics to add:
  - main queue depth,
  - background queue depth,
  - average queue wait time,
  - average cycle duration by rebuild phase,
  - rows processed per cycle.

### 5. DuckDB Memory Limit

- Live evidence says memory is not the current wall, but the `4GB` cap is still too low for this machine and too static for the fleet.
- Strategy:
  - move to the machine-aware default above,
  - keep temp-directory spill enabled,
  - expose the effective runtime config so we can see the real active limit without reading process env manually.
- Proposed runtime reporting:
  - effective `DUCKDB_MEMORY_LIMIT`,
  - effective temp directory,
  - worker RSS,
  - temp dir size,
  - optional `current_setting('memory_limit')`.

## Recommended Implementation Order

1. Observability first.
   - Add main/background DuckDB queue metrics and rebuild cycle timing metrics.
   - Expose effective worker DuckDB runtime config in an admin/debug endpoint.
2. Fix the cheap throughput ceilings.
   - Raise default rebuild batch size.
   - Lower idle poll interval.
   - Add `maxCyclesPerWake` burst execution.
3. Make worker memory default machine-aware.
   - Replace hard-coded `4GB` fallback.
   - Keep env overrides winning.
4. Isolate rebuild DB work.
   - Move rebuild executor queries/statements off the main control queue.
5. Only then consider multi-project concurrency.
   - Add a small `maxConcurrentProjects` knob later if one worker still cannot keep up.
   - Start with `1` by default and `2` only on larger machines after queue metrics look healthy.

## Suggested Safe Defaults After The First Pass

- Portable defaults:
  - `PROJECT_MART_LARGE_REBUILD_BATCH_SIZE=128`
  - `PROJECT_MART_LARGE_REBUILD_POLL_INTERVAL_MS=1000`
  - `PROJECT_MART_LARGE_REBUILD_MAX_CYCLES_PER_WAKE=4`
- This machine local catch-up mode:
  - `BACKGROUND_WRITER_DUCKDB_MEMORY_LIMIT=12GB`
  - `PROJECT_MART_LARGE_REBUILD_BATCH_SIZE=512`
  - `PROJECT_MART_LARGE_REBUILD_POLL_INTERVAL_MS=500`
  - `PROJECT_MART_LARGE_REBUILD_MAX_CYCLES_PER_WAKE=8`
- Conservative small-machine mode:
  - `BACKGROUND_WRITER_DUCKDB_MEMORY_LIMIT=2GB` or `4GB`
  - `PROJECT_MART_LARGE_REBUILD_BATCH_SIZE=64`
  - `PROJECT_MART_LARGE_REBUILD_POLL_INTERVAL_MS=1000-2000`
  - `PROJECT_MART_LARGE_REBUILD_MAX_CYCLES_PER_WAKE=2-4`

## Commands Run

- `lsof -n -P -iTCP:3001 -sTCP:LISTEN`
- `lsof -n -P -iTCP:3002 -sTCP:LISTEN`
- `curl -s http://127.0.0.1:3002/api/writer_connections`
- `curl -s http://127.0.0.1:3002/api/judgmentsjobs/3a20f0d4-d305-4135-b0d8-650a9c660362`
- `curl -s http://127.0.0.1:3002/api/admin/duckdb-append-metrics`
- `curl -s "http://127.0.0.1:3002/api/admin/project-mart-large-rebuild-status?projectId=2293577e-95a6-443d-ae18-76bd25eb34e5"`
- `ps -o pid,ppid,%cpu,%mem,rss,vsz,etime,state,command -p 21781,21785`
- `ps eww -p 21781`
- `sysctl -n hw.memsize`
- `vm_stat`
- `memory_pressure -Q`
- `du -sh "/Users/fredrc/Library/Application Support/Forska/duckdb-temp"`
- `ls -lh "/Users/fredrc/Library/Application Support/Forska/forska.duckdb" "/Users/fredrc/Library/Application Support/Forska/forska.duckdb.wal"`

## Skipped On Purpose

- I did not run mutating burst scripts such as `bun scripts/runProjectMartLargeRebuildCycles.ts ...` because this pass was to diagnose the current background worker path without changing throughput behavior yet.

## Quality Gates

- `bun test src/server/utils/backgroundServerStack.test.ts`
- `bun test src/server/utils/projectMartLargeRebuildHeartbeat.test.ts`
- `bun test src/server/services/projectMartLargeRebuildRunner.test.ts`
- `bun run lint`
- Live verify after implementation:
  - worker reports the effective DuckDB memory limit,
  - large rebuild cursor advances multiple batches per wake,
  - `lastAckSeq` starts moving,
  - `retainedRowCount` declines,
  - temp dir does not grow explosively,
  - API latency remains acceptable while rebuild is active.
