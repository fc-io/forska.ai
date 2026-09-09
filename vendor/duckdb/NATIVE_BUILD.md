# Patched alpha native build

`native-build.json` describes the immutable `2.0.0-alpha40881.forska.2` candidate.
It is not the active installation manifest until the six verified artifacts are
published and the root dependencies are updated together.

The base is official DuckDB commit `816a3eb2d512ce359efb40d9319f6db59788422a`.
The source archive and narrow truncated-string-maximum patch have separate
SHA-256 pins. The engine keeps the upstream version string, but its source ID is
the first ten characters of the complete patch SHA-256. Provenance identifies
the upstream base, exact patch, compiler, CMake arguments, recipe/input hashes,
GitHub run, and resulting native-library checksum. These binaries are **Forska
patched builds**, not byte-for-byte official DuckDB artifacts.

## Build and verification

The `Patched DuckDB native build` workflow runs on six native x64/ARM64 Linux,
macOS, and Windows runners. Linux uses digest-pinned manylinux 2.28 containers
and statically links the C++ runtime; macOS targets macOS 11 or newer. Compiler
parallelism is capped at four and reusable compiler caches are limited to 2 GiB.
Compiler versions are recorded because native-build byte reproducibility is
not assumed across changing runner toolchains. Package reconstruction from the
retained native inputs must be byte-identical.

The upstream bundled extension configuration retains `core_functions`, JSON,
ICU, Parquet, and autocomplete. Each shared library is tested with the unchanged
official `1.5.1-r.1` Node bridge in an isolated minimal installation. The active
checkout's `node_modules` is never overwritten for candidate verification.

Only `duckdb_main_capi_v2` uses unity compilation, matching the upstream C API's
translation-unit dependency. The rest of the build stays non-unity. The CMake
hook is part of the hashed build recipe; it does not alter engine source or
disable runtime optimizations.

Every target must pass exactly 18 named native cases: 13 existing checkpoint,
deletion, snapshot and rollback cases, one new SQL/WAL case, and four new C++
string-bound cases. An empty, partial, or skipped selection fails the build.
The isolated package then runs both mixed-version string-statistics fixtures,
including UPDATE, multiple connections, WAL replay, checkpoint and fresh reopen
with statistics propagation and filter pushdown enabled. Function-bearing WAL,
NULL decoding, transactions and the unchanged 32 MiB checkpoint regression also
run before that target is marked verified.

## Assemble a release candidate

Download the six `patched-duckdb-<platform>-<arch>` workflow artifacts and the
`patched-duckdb-source-input` artifact into a dedicated directory. Preserve their
original `native-output`, `candidate`, and evidence directories.

```sh
bun scripts/combinePatchedDuckdbDistribution.ts --input-dir /path/to/downloads --output-dir /path/to/new-release
bun scripts/buildDuckdbDistribution.ts --manifest /path/to/new-release/manifest.json --input-dir /path/to/new-release --output-dir /path/to/rebuilt --offline
```

Assembly rejects missing or duplicate targets, differing source/patch identities,
unverified builds, changed input checksums, and non-reproducible npm packages.
It retains the source archive, all native input archives, original bridge
archives, licenses, exact manifest and package hashes. A deterministic
`duckdb-native-build-inputs-<version>.tar.gz` additionally retains the exact
patch, CMake hook, recipe, build scripts and workflow. `NATIVE_BUILD_INPUTS.json`
maps each flat archive entry back to its original repository path and checksum.
Assembly rejects a changed recipe input even when a library checksum still
matches. Publication is separate:
never replace an existing versioned release asset. Only after publication and
public-URL verification should `vendor/duckdb/manifest.json`, root package URLs,
lockfile, and positive runtime checks move coherently to Forska.2.

Focused build/packaging checks:

```sh
bun test scripts/buildPatchedDuckdb.test.ts scripts/buildDuckdbDistribution.test.ts --timeout 120000
```
