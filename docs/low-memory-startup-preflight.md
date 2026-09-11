# Low-Memory Startup Mutation Preflight

Date: 2026-09-11

Context commit when written: `bfdbdfad` (`Fix comparison rollback delete mock`)

## Log Message

```text
[duckdb] skipped proactive startup mutation preflight under low-memory runtime
```

In simple terms, this means:

Forska noticed that the DuckDB maintenance owner is running with a low memory
budget, so it skipped an extra startup safety probe that would otherwise try to
exercise and, when needed, repair old mutable indexed DuckDB tables before the
normal application starts.

It does not mean "the app cannot make progress." It means "Forska did not run
this optional proactive startup mutation probe because running that probe could
itself be too expensive or risky under the current memory cap."

## What The Preflight Is For

Some older DuckDB tables were created with primary keys, unique constraints, or
secondary indexes on tables that the application later mutates heavily. Several
real failures have involved DuckDB index delete or repair paths, for example
errors like:

```text
Failed to delete all rows from index
```

The proactive startup mutation preflight is a defensive startup check for that
family of problems. It can run targeted mutation/repair probes against known
risky tables before the app proceeds with normal work.

The check is useful because it can expose or repair old indexed-table hazards
early. It is also potentially expensive because it can require DuckDB mutation,
index, checkpoint, or WAL-sensitive work during startup.

## Why Low Memory Skips It

The low-memory maintenance profile exists so Forska can keep operating on
machines that cannot safely spend large amounts of memory on startup repair or
large maintenance jobs.

Under that profile, Forska prioritizes:

- starting safely
- preserving WAL/database evidence
- running schema migrations that are safe and required
- keeping lightweight operational progress alive
- deferring heavyweight or risky maintenance

The proactive startup mutation preflight falls into the "heavy/risky startup
maintenance" class, so it is skipped when the DuckDB runtime is below the
preflight memory threshold.

## Work Stopped By This Specific Skip

This log line only means the following work did not run at startup:

- proactive startup mutation/index preflight
- eager startup probing of known historical indexed-table hazards
- eager startup repair attempts that require the proactive mutation preflight

It can delay discovering or repairing an old indexed-table hazard until one of
these later events happens:

- a migration rebuilds the table into a safer shape
- an operator starts with enough memory to run the preflight
- normal application work touches the bad table and exposes the problem
- a table-specific startup marker routes recovery through a safer migration path

## Work Not Stopped By This Specific Skip

This log line should not stop ordinary app progress. These should still run,
assuming the rest of the stack is healthy:

- API and maintenance-owner readiness
- WAL replay/checkpoint attempts
- schema migrations that are allowed to run
- judgment queue refill
- judgment import
- stale-job cleanup
- provider telemetry sampling
- LLM status ingestion
- bounded review-serving projection/rebuild chunks
- normal API/UI requests that do not hit an unrepaired legacy table hazard

If those are not progressing, treat that as a separate bug or operational
problem. The skipped-preflight log is a clue about the runtime profile, not by
itself proof that progress is disabled.

## Work Limited By Broader Low-Memory Mode

Low-memory mode affects more than this one preflight. The broader low-memory
runtime can also limit or defer:

- broad startup repair work
- expensive compaction/checkpoint-adjacent maintenance
- full-text or conversion maintenance crons
- high-throughput review-serving rebuild work
- large batches that could push the owner over its memory budget

In low-memory mode, review-serving and judgment work should still make bounded
progress, but it may be slower. The intended behavior is:

- lightweight operational crons stay active
- heavy maintenance is deferred or run only when safe
- progress counters and admin diagnostics show what is active or deferred

## Consequences If The Preflight Never Runs

If the proactive startup mutation preflight never runs, the main consequence is
not automatic data growth. The main consequence is that legacy indexed-table
hazards may remain latent longer.

Practical consequences:

- An old risky table may not be discovered at startup.
- A latent DuckDB index bug may instead appear later when a user action or
  background job mutates that table.
- Startup may rely more on explicit migrations and table-specific repair gates
  to remove old indexes safely.
- Operators may see fewer early warnings before the app reaches normal work.

It does not mean every queue grows forever. However, related state can grow if
the system is otherwise too constrained to keep up:

- review-serving pending chunks can grow if work is admitted faster than bounded
  low-memory chunks complete
- runtime logs can grow if the skip message is emitted repeatedly
- startup-recovery evidence directories can grow after repeated real failures
- old hazardous table shapes can persist in dormant databases until migrations
  rebuild them

The skipped preflight itself does not add rows or create backlog. It simply does
not perform the extra early mutation probe.

## Will This Grow Larger And Larger?

Not directly.

The skipped preflight is a startup decision, not a loop that accumulates work.
It does not by itself create more database rows, more queue entries, or more
WAL.

Things that can grow for adjacent reasons:

- logs, if the message is emitted every time DuckDB is reopened or the owner
  restarts
- startup-recovery artifacts, if real DuckDB failures keep happening and
  evidence is preserved
- pending review-serving or judgment work, if the low-memory owner is healthy
  but cannot process work as quickly as new work is admitted

Those should be monitored separately. A healthy low-memory system can emit this
message and still reduce pending work over time.

## Operator Interpretation

When this log appears:

1. Do not assume progress is blocked.
2. Check owner/API readiness.
3. Check the progress counters relevant to the current workload:
   - completed chunks
   - pending/running/failed chunks
   - `lastProgressedAt`
   - judgment queue ready/claimed counts
   - provider telemetry freshness
   - LLM status freshness
4. If counters are moving, this is mostly a noisy low-memory startup note.
5. If counters are not moving, investigate queue admission, worker readiness,
   owner restarts, WAL/checkpoint blocks, or deferred heavy maintenance.

## Recommended Long-Term Shape

Keep low-memory mode progress-first:

- operational progress stays active at low memory
- heavyweight startup repair and maintenance defer unless safe
- logs distinguish "preflight skipped" from "progress stopped"
- admin pages show which cron classes are active, stale, or deferred
- heavier repair/rebuild work can run opportunistically when real memory
  headroom exists

Do not solve this only by raising the default memory cap. A higher cap is a
valid operator override, but Forska should remain useful under the intended
low-memory maintenance profile.
