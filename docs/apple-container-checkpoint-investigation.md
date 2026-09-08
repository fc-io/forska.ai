# Apple-container checkpoint memory investigation

## Scope

Run the existing primary database in an 8 GiB Apple Linux ARM64 container.
The application uses a 4 GB maintenance DuckDB budget within that VM. This
investigation does not establish the cause of the Windows conflict-save crash.

## Evidence (2026-09-08)

The original database and its approximately 17 MiB WAL were preserved before
experimentation. Experiments below used a separate copy, with one database
consumer at a time. The database is approximately 115 GiB (123 GB decimal).

| Experiment | Result |
| --- | --- |
| DuckDB 1.5.1, explicit checkpoint, 4 GB cap | Native allocation OOM |
| Disable optional vacuum tasks | Same OOM |
| Upgrade attached storage compatibility to v1.2.0 | Same OOM |
| DuckDB 1.5.5, same cap | Same OOM |
| Hold a read snapshot, commit a second read, checkpoint | Completed in about 12 seconds, process RSS about 1.7 GB |
| Patched DuckDB 1.5.5, ordinary full checkpoint on preserved clone, literal `4GB` cap / `8G` VM | Passed in 13 seconds, process RSS about 2.11 GB |
| Host 1.5.1 seed → patched 32 MiB checkpoint → host 1.5.1 read-only compatibility reopen | Exact rows, sum and WAL marker preserved |

Memory sampling during the failing checkpoint showed `BASE_TABLE` growing to
about 3.84 GB while `ART_INDEX` stayed near 125 MB. This is not evidence of a
Linux OOM kill. The native engine exhausted its own configured allocation budget.

Checkpoint logging ended around `app.project_mart_large_rebuild_state`; that
table has only 10 live rows but about 168,000 physical historical rows. This
does not identify it as the sole offending table: checkpoint memory accumulates
across the database. Dropping that table alone is not a demonstrated fix.

## Native mechanism

Normal checkpoint vacuum initialization counts committed rows across row groups,
loading historical deletion metadata. The affected engine expands persisted
deletion masks and retains fixed-size allocations tagged `BASE_TABLE`.
The successful concurrent-checkpoint experiment bypasses that initialization
and supports this diagnosis. It is a diagnostic, not the production fix.

Upstream changes address the allocation lifecycle:

- <https://github.com/duckdb/duckdb/pull/23964>
- <https://github.com/duckdb/duckdb/pull/24336>

These changes are absent from stable DuckDB 1.5.5. A stable-version bump alone
was tested and is insufficient. The implemented container fix builds the stable
engine with the specific upstream changes, retaining its native API and storage
format. This changes the engine used by the container and must be recorded when
comparing results with another machine.

## Original-database live verification

The patched container subsequently ran against the original host database with
API, maintenance/DuckDB owner and judge readiness returning HTTP 200. An active
project made real indexing progress:

| Signal | 13:25:12 UTC | 13:26:36 UTC |
| --- | ---: | ---: |
| Completed rebuild chunks | 68 | 120 |
| Pending rebuild chunks | 317 | 265 |
| Pending refreshes | 162,166 | 162,112 |

`lastProgressedAt` advanced across the interval; failed, quarantined and expired
rebuild-chunk counts stayed zero. Evidence came from
`POST /api/projectsreviewswarnings` with the active project ID, using
`data.indexing.serving.diagnostics.rebuildChunks` and
`data.indexing.lastProgressedAt`. Before/after snapshots were preserved in the
local diagnostics archive. Other projects may remain queued; this is evidence
of the selected current workload progressing, not proof that every queue drained.

Tested image manifest:
`sha256:06e1e040dbcadbf087a3b313c96d82450e57661817ad4ed91066c07878ea7752`.
It was built from baseline commit `a46f0ef0` plus the then-uncommitted native
changes. These results identify that image, not a subsequently created final
source commit as independently tested.

Chromium loaded 100 article rows for that active project without page errors;
API, owner and judge readiness were again HTTP 200 around 13:29 UTC. During
background work the normal bounded-loop policy recycled the DuckDB runtime
twice after RSS crossed its 3 GB threshold (observed about 3.8/4.48 GB), with a
transient owner-not-ready HTTP 502 during recycling. It recovered; no OOM or
process crash was observed. Continuous request availability across scheduled
recycling was not established, and not every request succeeded. The test stack
was then stopped cleanly with SIGTERM.

## Quality gates and reproduction

- A disposable fragmented/deleted-row regression fails with the original engine
  at 32 MiB. The image build requires the patched engine to checkpoint and verify
  exact row count, sum and WAL marker again after a fresh-process 32 MiB reopen:
  `bun scripts/duckdbCheckpointMemoryRegression.ts`. That gate and all 13 upstream
  deletion/checkpoint cases passed in the patched build.
- Cross-engine compatibility passed. The old-host-engine `compat-reopen` phase
  uses 128 MiB in read-only mode because its deletion-metadata reads still need
  more memory; it does not weaken the patched engine's 32 MiB gates.
- The preserved current-database clone passed an ordinary full checkpoint at
  the unchanged 4 GB DuckDB / 8 GiB VM limits, without a snapshot guard.
- Original-database API/owner/judge readiness and the progress counters above
  passed. This resolves the reproduced container checkpoint failure; the
  Windows conflict-resolution crash remains unproven.
- Five focused launcher tests, launcher/regression lint and the web build passed;
  the test stack was stopped. Exact commands and the cross-engine fixture
  sequence are in [TESTS.md](../TESTS.md#apple-container-launcher). Host desktop
  native dependencies were not changed; this does not validate the Windows case.

## Evidence-preserving recovery

Stop the app and confirm all host and guest owners have exited before changing
database files or leases. Preserve the DB, WAL and logs together before another
experiment; use a separate consistent clone for diagnostic checkpoints. Do not
delete a WAL to make startup succeed. Investigate lock hostname/PID in its own
namespace, and preserve a confirmed stale lease before resuming one owner.
See the [host-database runbook](../containers/apple/README.md#use-the-existing-mac-database)
and [native backport/removal criteria](../containers/apple/duckdb-backport.md).
