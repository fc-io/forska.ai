# Pinned DuckDB native distribution

Forska installs DuckDB `v2.0.0-alpha40881` (`816a3eb2d512ce359efb40d9319f6db59788422a`) through six platform-specific npm tarballs. They keep the official `@duckdb/node-bindings` `1.5.1-r.1` C bridge and substitute the byte-for-byte official preview library from DuckDB CI run [34220083513](https://github.com/duckdb/duckdb/actions/runs/34220083513). The package version is explicitly `2.0.0-alpha40881.forska.1`.

No native binaries are committed, compiled on users' machines, or downloaded by a postinstall script. Root `package.json` overrides install the pinned tarballs and `bun.lock` pins their integrity; the existing native loader selects the current operating system and architecture. Unsupported platforms fail instead of silently falling back to an older engine.

Bun 1.3.13 does not retain `os`/`cpu` selectors when resolving URL-tarball overrides, so it downloads and installs all six packages even though it loads only the matching one. This increases initial download and disk usage. Desktop packaging explicitly copies only its selected native platform package. The container uses the same dependency installation and selected runtime engine. We do not patch the lockfile by hand or delete other-platform packages in an install script. Registry distribution can restore native package-manager platform filtering later without changing the engine or loader contract.

## Provenance and reproducibility

`manifest.json` pins official GitHub artifact IDs and SHA-256 digests, source revision, npm bridge tarball SHA-256 and SHA-512 integrity, and unpacked bridge/library checksums. Every output contains `FORSKA_DUCKDB_PROVENANCE.json`, the Node binding MIT license, and the engine's pinned MIT license. Package archives contain only the selected bridge, preview library, metadata, licenses, and provenance. Tar entries have sorted names, UID/GID zero, fixed permissions, and timestamp zero.

Build with Bun 1.3.13 from the checksum-verified input mirrors retained with the release:

```sh
bun scripts/buildDuckdbDistribution.ts --input-dir=/tmp/duckdb-inputs --output-dir=/tmp/duckdb-packages
```

Rebuild offline from already verified input files:

```sh
bun scripts/buildDuckdbDistribution.ts --input-dir=/tmp/duckdb-inputs --output-dir=/tmp/duckdb-rebuilt --offline
```

`--platform=darwin-arm64` selects one platform for a focused rebuild. `--upstream` explicitly downloads original official artifacts instead of release mirrors; this requires authenticated GitHub CLI access, and upstream Actions artifacts eventually expire. No fallback changes the source implicitly. The builder validates every input before unpacking and refuses different bytes at an existing output path. It compares outputs to committed release hashes and emits `SHA256SUMS`. It neither publishes nor replaces release assets. Original input archives are mirrored byte-for-byte as release assets so the distribution remains reproducible after upstream CI expires.

The user-facing tarballs belong in the versioned [Forska release](https://github.com/fc-io/forska.ai/releases/tag/duckdb-v2.0.0-alpha40881-forska.1). Never replace bytes under a published version; use a new distribution version, update provenance and dependency integrity, and rerun the upgrade gates in `TESTS.md`.

## Engine and data compatibility

This is an upstream alpha engine, not an official stable npm release. Shared connection setup applies two pinned compatibility settings:

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

For a concrete macOS/Linux recovery rehearsal, stop Forska and all containers that mount its data, then work on a copy. Set `FORSKA_RECOVERY_SOURCE` to the database path reported by your failing startup; the example is the normal macOS primary profile. Do not run a raw copy while any owner is writing. Keep the original database and WAL together, unchanged, until the repaired copy has been verified.

```sh
export FORSKA_RECOVERY_SOURCE="$HOME/Library/Application Support/Forska/runtime/primary/forska.duckdb"
export FORSKA_RECOVERY_ROOT="$(mktemp -d)"
mkdir "$FORSKA_RECOVERY_ROOT/data"
cp -p "$FORSKA_RECOVERY_SOURCE" "$FORSKA_RECOVERY_ROOT/data/forska.duckdb"
cp -p "$FORSKA_RECOVERY_SOURCE.wal" "$FORSKA_RECOVERY_ROOT/data/forska.duckdb.wal"
git worktree add --detach "$FORSKA_RECOVERY_ROOT/old-engine" 3702d345
cd "$FORSKA_RECOVERY_ROOT/old-engine"
bun install --frozen-lockfile
DUCKDB_PATH="$FORSKA_RECOVERY_ROOT/data/forska.duckdb" bun -e '
  const {DuckDBInstance, version} = await import("@duckdb/node-api")
  if (version() !== "v1.5.1") throw new Error("Expected the pinned previous engine")
  const instance = await DuckDBInstance.create(process.env.DUCKDB_PATH, {memory_limit: "4GB", threads: "1"})
  const connection = await instance.connect()
  await connection.run("CHECKPOINT")
  console.log((await connection.runAndReadAll("SELECT COUNT(*) AS projects FROM app.project")).getRowObjectsJson())
  connection.closeSync()
  instance.closeSync()
'
```

An unsuccessful checkpoint is not permission to remove the WAL. Keep that output and the original pair. Follow the preserved [checkpoint investigation](../../docs/apple-container-checkpoint-investigation.md) if the old engine encounters the historical low-memory failure. After a successful checkpoint, return to the current checkout and run `bun install --frozen-lockfile`, then validate the copied database using its explicit `DUCKDB_PATH` (including the affected project's rows and review progress). Only replace the stopped application's database after confirming that result; retain the original pair under a separate backup path. On Windows use an equivalent stopped-owner copy and separate worktree, not these POSIX shell commands.

An engine crash, unavailable extension, OOM, or unexplained replay subprocess failure is not proof that the WAL is corrupt. Startup leaves that pair in place and reports the underlying error rather than silently discarding committed work. The narrowly classified historical replay-recovery path remains distinct from these failures.

The six platforms are macOS ARM64/x64, Linux glibc ARM64/x64, and Windows ARM64/x64. A published binary's availability and checked digest do not establish runtime verification on every OS: consult the CI platform matrix and release verification evidence.

## Quality gates

```sh
bun test scripts/buildDuckdbDistribution.test.ts
bunx eslint scripts/buildDuckdbDistribution.ts scripts/buildDuckdbDistribution scripts/buildDuckdbDistribution.test.ts
```

Also verify a clean dependency install, native package version/provenance, NULL decoding, transactions, restart/new-WAL replay, checkpoint memory regression, and the real application's progress on supported verification platforms. Web and desktop must resolve the same native engine.
