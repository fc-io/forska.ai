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

This is an upstream alpha engine, not an official stable npm release. The released Node bridge requires `legacy_disable_null_type=true`; shared connection setup applies that setting explicitly. New-WAL replay and ordinary checkpoint behavior must be tested, including the unchanged low-memory regression. An incompatible legacy WAL must not be silently deleted during install/startup. Follow the explicit migration/recovery guidance and runtime error before changing existing data.

### Existing databases and WALs

Ordinary DuckDB 1.5.1 WALs successfully replay in the preview, so users do **not** generally need to delete WAL files after updating. One previously preserved WAL contains multiple checkpoint markers that the preview rejects. Startup reports that incompatibility without altering or deleting the WAL.

For that exceptional state, stop every database owner and use the prior compatible engine to checkpoint the database before upgrading. If its checkpoint encounters the old memory bug, test recovery/replay with the verified backported engine on an isolated copy using the historical checkpoint-recovery guidance. This is an operator recovery procedure, not an automatic or competing application runtime. Keep the original data until recovery is verified. Only reset disposable data when its owner explicitly authorizes that loss; installation never makes that decision.

The six platforms are macOS ARM64/x64, Linux glibc ARM64/x64, and Windows ARM64/x64. A published binary's availability and checked digest do not establish runtime verification on every OS: consult the CI platform matrix and release verification evidence.

## Quality gates

```sh
bun test scripts/buildDuckdbDistribution.test.ts
bunx eslint scripts/buildDuckdbDistribution.ts scripts/buildDuckdbDistribution scripts/buildDuckdbDistribution.test.ts
```

Also verify a clean dependency install, native package version/provenance, NULL decoding, transactions, restart/new-WAL replay, checkpoint memory regression, and the real application's progress on supported verification platforms. Web and desktop must resolve the same native engine.
