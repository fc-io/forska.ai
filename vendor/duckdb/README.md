# Pinned DuckDB native distribution

Forska installs **Forska-patched DuckDB `v2.0.0-alpha40881`** through six platform-specific npm tarballs, versioned `2.0.0-alpha40881.forska.2`. The engine uses official base `816a3eb2d512ce359efb40d9319f6db59788422a` plus the narrow truncated-string-maximum correction in [the native build recipe](NATIVE_BUILD.md). Its runtime source ID is `1a89b7dcc8`; the complete patch SHA-256 is `1a89b7dcc8d45db3c814b868adab64dbd700ebf0d6f8cfd035bce8eed00d2acb`. The official `@duckdb/node-bindings` `1.5.1-r.1` C bridge is unchanged. These are prebuilt Forska binaries, not byte-for-byte official DuckDB artifacts.

No native binaries are committed, compiled on users' machines, or downloaded by a postinstall script. Root `package.json` overrides install the pinned tarballs and `bun.lock` pins their integrity; the existing native loader selects the current operating system and architecture. Unsupported platforms fail instead of silently falling back to an older engine.

Bun 1.3.13 does not retain `os`/`cpu` selectors when resolving URL-tarball overrides, so it downloads and installs all six packages even though it loads only the matching one. This increases initial download and disk usage. Desktop packaging explicitly copies only its selected native platform package. The container uses the same dependency installation and selected runtime engine. We do not patch the lockfile by hand or delete other-platform packages in an install script. Registry distribution can restore native package-manager platform filtering later without changing the engine or loader contract.

## Provenance and reproducibility

`manifest.json` pins the upstream source archive/revision, exact patch, per-platform native build provenance, npm bridge tarball SHA-256 and SHA-512 integrity, and unpacked bridge/library checksums. Build provenance includes compiler and recipe inputs, workflow source/run, and the unique patched source identity. Every output contains `FORSKA_DUCKDB_PROVENANCE.json`, the Node binding MIT license, and the engine's pinned MIT license. Package archives contain only the selected bridge, patched library, metadata, licenses, and provenance. Tar entries have sorted names, UID/GID zero, fixed permissions, and timestamp zero.

Build with Bun 1.3.13 from the checksum-verified input mirrors retained with the release:

```sh
bun scripts/buildDuckdbDistribution.ts --input-dir=/tmp/duckdb-inputs --output-dir=/tmp/duckdb-packages
```

Rebuild offline from already verified input files:

```sh
bun scripts/buildDuckdbDistribution.ts --input-dir=/tmp/duckdb-inputs --output-dir=/tmp/duckdb-rebuilt --offline
```

`--platform=darwin-arm64` selects one platform for a focused package rebuild. `--upstream` uses each input's explicitly declared original URL instead of its release mirror; the corrected native libraries still come from the immutable Forska release, not an unpatched official preview. Native compilation and its six-platform verification are documented separately in [NATIVE_BUILD.md](NATIVE_BUILD.md). No fallback changes the source implicitly. The builder validates every input before unpacking and refuses different bytes at an existing output path. It compares outputs to committed release hashes and emits `SHA256SUMS`. It neither publishes nor replaces release assets. Original bridge, native, and source input archives are retained as release assets, together with exact patch/recipe inputs, so package reconstruction does not depend on temporary Actions artifacts. Native compiler/toolchain provenance is recorded; byte-identical native output across different toolchains is not assumed.

The user-facing tarballs belong in the versioned [Forska release](https://github.com/fc-io/forska.ai/releases/tag/duckdb-v2.0.0-alpha40881-forska.2). Never replace bytes under a published version; use a new distribution version, update provenance and dependency integrity, and rerun the upgrade gates in `TESTS.md`.

## Engine and data compatibility

This is a narrowly patched upstream alpha engine, not an official stable npm release. Shared connection setup applies two pinned compatibility settings:

- `legacy_disable_null_type=true`: the released Node bridge cannot decode the new untyped NULL vectors.
- `disabled_optimizers=cte_inlining`: CTE inlining can raise native `Vector::Reference` errors in real LLM/human status projections and review-page queries. Only this pass is disabled; statistics propagation, scan-level pruning, the remaining optimizers, and `delim_join_as_cte` retain their defaults. Disabling `delim_join_as_cte` alone does not fix both native CTE failures.

Run `bun test src/server/utils/duckdbEngineCompatibility.test.ts` for scalar/nested NULL, portable CTE negative/positive controls, and WAL compatibility. When upgrading, test the replacement engine with CTE inlining enabled against both retained SQL fixtures. Remove the CTE setting and update the pinned negative-control expectations only after the official engine executes both correctly, then rerun workflow, browser, low-memory checkpoint, and live review-progress gates. Do not retain an obsolete optimizer workaround after that removal gate passes. Retest the NULL setting separately when the binding gains native support.

Run `bun test src/server/utils/duckdbEngineCompatibility.statistics.test.ts src/server/utils/duckdbEngineCompatibility.updatedStatistics.test.ts --timeout 120000` for exact string-ID predicates across mixed-version WAL replay and live UPDATEs spanning legacy row groups. The narrow native patch corrects `StringStats::MergeStats` handling of unequal-length truncated maximum bounds introduced with [DuckDB #22692](https://github.com/duckdb/duckdb/pull/22692). The old engine could incorrectly eliminate real rows both during optimizer statistics propagation and during storage row-group pruning. Disabling only statistics propagation did not fix the latter, and a checkpoint could temporarily heal the state. The patched engine must pass exact retained/inserted/deleted IDs, ranges, joins and full counts before checkpoint, on another connection, after checkpoint and on fresh-process reopen, with native statistics and filter pushdown enabled. Read-only replay must leave DB/WAL bytes unchanged. Installed and copied-package verification repeat both public-data fixtures. The temporary statistics-propagation exclusion has been removed; do not replace the native fix with a broad optimizer disable or an application-query workaround. Remove the native patch only when an official replacement engine passes the same C++/SQL, application, copied-package and unchanged-memory live-progress gates. Recovery, ANALYZE, or WAL deletion alone is not a root-cause fix.

The same alpha initializes statically linked extensions after opening its primary database. A real application WAL can reference `core_functions`/JSON functions during replay, before that initialization, and incorrectly attempt an unavailable extension download. Every persistent opener therefore uses one up-front lifecycle: initialize an in-memory engine, attach the real DuckDB file, then detach all scratch catalogs before returning the instance. Later connections default to the persistent catalog; read-only access is enforced on the attachment. Startup repair/checkpoint children embed that same initializer, and desktop verification injects its copied package's factory. This does not retry a failed open, download extensions, change the memory budget, or discard WALs.

Run `bun test src/server/utils/createDuckdbInstance.test.ts src/server/utils/createDuckdbInstance.wal.test.ts` for catalog/resource safety and full application migrations plus a killed writer's committed WAL. The regression verifies an offline raw-open negative control, read-only replay without changing either file, generated startup-child replay/checkpoint, and managed owner startup. Remove the bootstrap lifecycle only after a replacement official engine passes direct full-application WAL replay with extension installation disabled, then rerun these lifecycle, desktop/container, and live progress gates.

New-WAL replay and ordinary checkpoint behavior must be tested, including the unchanged low-memory regression. An incompatible legacy WAL must not be silently deleted during install/startup. Follow the explicit migration/recovery guidance and runtime error before changing existing data.

### Existing databases and WALs

Ordinary DuckDB 1.5.1 WALs successfully replay in the preview, so users do **not** generally need to delete WAL files after updating. One previously preserved WAL contains multiple checkpoint markers that the preview rejects. Startup reports that incompatibility without altering or deleting the WAL.

For that exceptional state, stop every database owner and use the prior compatible engine to checkpoint the database before upgrading. If its checkpoint encounters the old memory bug, test recovery/replay with the verified backported engine on an isolated copy using the historical checkpoint-recovery guidance. This is an operator recovery procedure, not an automatic or competing application runtime. Keep the original data until recovery is verified. Only reset disposable data when its owner explicitly authorizes that loss; installation never makes that decision.

For a concrete macOS/Linux recovery rehearsal, stop Forska and every container or process using its data. Use a fresh Bash session and run each complete block; `set -euo pipefail` makes a failed copy, comparison, install, or checkpoint stop the procedure. Set `FORSKA_RECOVERY_SOURCE` to the exact database path in the failing startup log (the example is macOS primary). The recovery parent must be durable local storage, not `/tmp`, `$TMPDIR`, or another temporary directory: the judge journal is derived beside the copied database and temporary journals are rejected.

```bash
set -euo pipefail
FORSKA_RECOVERY_CHECKOUT="$(git rev-parse --show-toplevel)"
FORSKA_RECOVERY_SOURCE="$HOME/Library/Application Support/Forska/runtime/primary/forska.duckdb"
FORSKA_RECOVERY_PARENT="$(dirname "$FORSKA_RECOVERY_SOURCE")/recovery"
mkdir -p "$FORSKA_RECOVERY_PARENT"
FORSKA_RECOVERY_ROOT="$(mktemp -d "$FORSKA_RECOVERY_PARENT/duckdb-recovery.XXXXXX")"
export FORSKA_RECOVERY_CHECKOUT FORSKA_RECOVERY_SOURCE FORSKA_RECOVERY_ROOT
printf 'Preserved recovery workspace: %s\n' "$FORSKA_RECOVERY_ROOT"
mkdir "$FORSKA_RECOVERY_ROOT/data" "$FORSKA_RECOVERY_ROOT/spill-old" "$FORSKA_RECOVERY_ROOT/spill-current" "$FORSKA_RECOVERY_ROOT/logs"
test -f "$FORSKA_RECOVERY_SOURCE"
test -f "$FORSKA_RECOVERY_SOURCE.wal"
cp -p "$FORSKA_RECOVERY_SOURCE" "$FORSKA_RECOVERY_ROOT/data/forska.duckdb"
cp -p "$FORSKA_RECOVERY_SOURCE.wal" "$FORSKA_RECOVERY_ROOT/data/forska.duckdb.wal"
cmp -s "$FORSKA_RECOVERY_SOURCE" "$FORSKA_RECOVERY_ROOT/data/forska.duckdb"
cmp -s "$FORSKA_RECOVERY_SOURCE.wal" "$FORSKA_RECOVERY_ROOT/data/forska.duckdb.wal"
git worktree add --detach "$FORSKA_RECOVERY_ROOT/old-engine" 3702d345
cd "$FORSKA_RECOVERY_ROOT/old-engine"
bun install --frozen-lockfile
DUCKDB_PATH="$FORSKA_RECOVERY_ROOT/data/forska.duckdb" bun --no-env-file -e '
  const {DuckDBInstance, version} = await import("@duckdb/node-api")
  if (version() !== "v1.5.1") throw new Error("Expected the pinned previous engine")
  const instance = await DuckDBInstance.create(process.env.DUCKDB_PATH, {
    memory_limit: "4GB", threads: "1", temp_directory: process.env.FORSKA_RECOVERY_ROOT + "/spill-old"
  })
  try {
    const connection = await instance.connect()
    try {
      await connection.run("CHECKPOINT")
      console.log((await connection.runAndReadAll("SELECT COUNT(*) AS projects FROM app.project")).getRowObjectsJson())
    } finally { connection.closeSync() }
  } finally { instance.closeSync() }
' 2>&1 | tee "$FORSKA_RECOVERY_ROOT/logs/old-engine-checkpoint.log"
cd "$FORSKA_RECOVERY_CHECKOUT"
```

Both copies must compare byte-for-byte before the old engine is opened; comparisons of large databases take time. A missing WAL or unsuccessful checkpoint is not permission to continue with a database-only copy or remove evidence. Keep the output and the original pair. Follow the preserved [checkpoint investigation](../../docs/apple-container-checkpoint-investigation.md) if the old engine encounters the historical low-memory failure.

After a successful checkpoint, validate the copy using the **current checkout and its shared read-only initializer**. This direct command respects its explicit path, verifies the installed engine identity before attaching, initializes built-in extensions before replay, and prints the actual attached database path. It does not use a primary/secondary profile wrapper.

```bash
cd "$FORSKA_RECOVERY_CHECKOUT"
bun install --frozen-lockfile
DUCKDB_PATH="$FORSKA_RECOVERY_ROOT/data/forska.duckdb" bun --no-env-file -e '
  const {realpathSync} = await import("node:fs")
  const {DuckDBInstance} = await import("@duckdb/node-api")
  const {createDuckdbInstance} = await import("./src/server/utils/createDuckdbInstance.ts")
  const {duckdbEngineCompatibilityOptions} = await import("./src/server/utils/duckdbEngineContract.ts")
  const databasePath = process.env.DUCKDB_PATH
  const instance = await createDuckdbInstance({create: DuckDBInstance.create, databasePath, options: {
    ...duckdbEngineCompatibilityOptions, access_mode: "READ_ONLY", memory_limit: "4GB", threads: "1",
    temp_directory: process.env.FORSKA_RECOVERY_ROOT + "/spill-current"
  }})
  try {
    const connection = await instance.connect()
    try {
      const databases = (await connection.runAndReadAll("SELECT path FROM duckdb_databases() WHERE NOT internal")).getRowObjectsJson()
      if (databases.length !== 1 || realpathSync(databases[0].path) !== realpathSync(databasePath)) throw new Error("Wrong recovery database")
      const projects = (await connection.runAndReadAll("SELECT COUNT(*) AS projects FROM app.project")).getRowObjectsJson()
      console.log(JSON.stringify({databases, projects}))
    } finally { connection.closeSync() }
  } finally { instance.closeSync() }
' 2>&1 | tee "$FORSKA_RECOVERY_ROOT/logs/current-engine-readonly.log"
```

For live API/owner readiness and affected-project progress, use the supported supervisor **directly**, with three unused ports. Do not substitute `bun run dev:start`, `dev:server`, or a `runWithRuntimeProfile.ts --profile primary/secondary` command: those wrappers replace `DUCKDB_PATH` with the profile database. The copied application state is writable during this live check; unfinished judging jobs can resume, so account for those jobs before starting a full stack.

```bash
export DUCKDB_PATH="$FORSKA_RECOVERY_ROOT/data/forska.duckdb"
export FORSKA_RUNTIME_PROFILE=local
export DUCKDB_TEMP_DIRECTORY="$FORSKA_RECOVERY_ROOT/spill-current"
export DUCKDB_MEMORY_LIMIT=4GB
export BACKGROUND_MAINTENANCE_DUCKDB_MEMORY_LIMIT=4GB
export API_SERVER_PORT=43101
export BACKGROUND_MAINTENANCE_PORT=43102
export BACKGROUND_JUDGE_PORT=43103
export JUDGE_WORKER_ID="$(basename "$FORSKA_RECOVERY_ROOT")"
export JUDGE_WORKER_JOURNAL_PATH=
export LOG_DIR="$FORSKA_RECOVERY_ROOT/logs"
cd "$FORSKA_RECOVERY_CHECKOUT"
bun --no-env-file scripts/startServerStack.ts
```

The supervisor preserves that DB/spill/log configuration for all roles and derives the isolated journal at `$FORSKA_RECOVERY_ROOT/data/judge-worker-journals/$JUDGE_WORKER_ID.sqlite`. Confirm startup prints the copied DB path. In another terminal, check `/api/runtime/ready` on ports 43101, 43102, and 43103; each response must have `data.ready=true`. Against the recovery API, inspect the affected project's canonical records and review counters before and after a short interval. The existing read-only diagnostic command is `FORSKA_API_BASE_URL=http://127.0.0.1:43101 bun scripts/checkReviewServingCurrentDbWarningStatus.ts` from the current checkout; it uses that API, not a profile database. Readiness alone is not proof of recovered data or forward progress.

Stop the recovery supervisor with Ctrl-C and wait for its children and owner/journal leases to release before inspecting or moving files. Keep the copied DB, any new WAL/journal, and logs together; do not delete an unexpected remaining lease or WAL merely to force startup. Only replace the stopped application's database after verifying the affected data and live progress, retaining the original DB/WAL under a separate backup path. The old-engine checkout can then be removed with `git worktree remove "$FORSKA_RECOVERY_ROOT/old-engine"`; that is separate from the preserved `data`, spill, and log directories. On Windows use an equivalent stopped-owner copy and explicit-path commands, not these Bash commands.

An engine crash, unavailable extension, OOM, or unexplained replay subprocess failure is not proof that the WAL is corrupt. Startup leaves that pair in place and reports the underlying error rather than silently discarding committed work. The narrowly classified historical replay-recovery path remains distinct from these failures.

The six platforms are macOS ARM64/x64, Linux glibc ARM64/x64, and Windows ARM64/x64. A published binary's availability and checked digest do not establish runtime verification on every OS: consult the CI platform matrix and release verification evidence.

## Quality gates

```sh
bun test scripts/buildDuckdbDistribution.test.ts scripts/buildDuckdbDistribution
bunx eslint scripts/buildDuckdbDistribution.ts scripts/buildDuckdbDistribution scripts/buildDuckdbDistribution.test.ts
```

Also verify a clean dependency install, native package version/provenance, NULL decoding, transactions, restart/new-WAL replay, checkpoint memory regression, and the real application's progress on supported verification platforms. Web and desktop must resolve the same native engine.
