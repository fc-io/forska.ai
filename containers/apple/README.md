# Apple-container development stack

Requires an Apple Silicon Mac, macOS 26 or newer, Bun on the host, and Apple's
[`container` CLI](https://github.com/apple/container/releases). Install the signed
package from Apple (or `brew install container`). Initialize its kernel once:

```sh
container system start --disable-kernel-install
container system kernel set --recommended
```

Docker Desktop is not required. Kernel installation downloads Apple's recommended
Linux guest kernel; the launcher does not override a configured custom kernel.

```sh
bun run dev:container
```

The launcher starts Apple's container service, builds the Linux ARM64 image, and
runs **`bun run dev:start`** with **`--memory 8G`** (8 GiB). Open
<http://localhost:3300>. The API, maintenance owner, and judge worker stay inside
the VM; Vite proxies browser API requests to the internal API. Only Vite is
published, on host loopback. Normal web and desktop commands are unchanged.

```sh
# Inspect commands without installing or starting the container runtime
bun run dev:container --dry-run

# Use another host port without changing the container's runtime profile
FORSKA_CONTAINER_PORT=3400 bun run dev:container

# Compare VM budgets (default is 8G; positive whole GiB values only)
FORSKA_CONTAINER_MEMORY=16G bun run dev:container --host-db

# From another terminal
container stats forska-dev-8gb --no-stream
container stop --signal SIGTERM --time 60 forska-dev-8gb
```

Ctrl-C requests SIGTERM shutdown with a 60-second grace period. The entrypoint
forwards termination to its app process group and waits for exit. The supervisor
removes its stopped children's DuckDB-owner and judge-journal leases only after
confirming process exit, matching the host/PID and acquisition time to that child.
The low-memory owner keeps its lease until exit; cleanup does not force a native
checkpoint/close or remove the WAL. A killed VM/supervisor can still leave a
lease: verify the VM is stopped and preserve stale lease evidence before switching
back to host-DB mode. The disposable container is removed
on exit; the image, builder, container service and named volume remain. An
existing container with the same name is not automatically deleted or replaced.

## Use the existing Mac database

Stop the host `bun run dev:start` stack (or desktop app) cleanly, then run:

```sh
bun run dev:container --host-db
```

The launcher resolves the Mac primary runtime directory using the same runtime
profile helper as the app, and mounts it read/write at
`/data/share/forska/runtime/primary`. The container therefore opens the original
`forska.duckdb` through its normal Linux primary-profile path. The whole directory
is shared so WAL files and owner locks stay alongside the database. It also
mounts this checkout's `assets` directory at `/data/assets`, reached by the app
through `/app/assets`. It does not copy or overwrite either directory.

`bun run dev:container --host-db --dry-run` displays the resolved mounts without
starting anything. The source DB and assets directory must already exist.

Before starting the container, the launcher refuses an existing owner/writer/judge-journal lock
or an open database, WAL, journal or journal sidecar reported by `lsof`. It never removes locks or stops the host
app. A leftover lock must be investigated through the normal host recovery flow.
Check its hostname/PID in the correct host or guest namespace and verify there
are no file users. Preserve a confirmed stale lock with a timestamped rename;
never delete a live lease. Container PIDs cannot be checked with host `kill -0`.
These checks are a startup preflight, **not a cross-VM locking guarantee**. Keep
all host DB consumers stopped for the entire container run; do not restart the
host app until the container has exited. Host and guest PIDs are not comparable.

This mode modifies the original DB, including startup migrations and background
work. Keep a backup if those changes must be reversible. macOS shared-folder I/O
may differ from native Linux-volume I/O and affect memory/latency experiments.
Absolute host paths stored inside the DB are not rewritten; paths outside the
mounted runtime/assets directories are not available inside the container.
Omit `--host-db` to return to the isolated named-volume database.

## Considerations

- **Memory comparisons:** `FORSKA_CONTAINER_MEMORY` changes only the VM limit;
  the container name stays `forska-dev-8gb` to prevent simultaneous use of its
  shared data volume. The app may auto-size DuckDB and worker budgets from the
  detected RAM, so compare the logged runtime budgets as well as the VM limit.
  Start each comparison from a consistent baseline if background work changes data.
- **Memory:** 8 GiB is shared by the Linux guest, Vite, Bun processes, DuckDB,
  caches and workers. It is not an 8 GiB DuckDB budget or a strict ceiling on total
  macOS usage: the builder and virtualization overhead consume additional RAM.
  Existing application memory defaults still apply. A sufficiently large job can
  still OOM; this isolates the workload, not fixes its memory demand.
- **Persistence:** the `forska-dev-data` named volume stores the Linux runtime DB
  under `/data/share/forska/runtime/primary`, assets under `/data/assets`, legacy
  relative data under `/data/local`, and logs under `/data/logs`. In default mode this uses the
  VM's Linux filesystem instead of a macOS bind mount for database writes. Do not
  prune/delete this volume if you need its data. Export/back up important data.
- **Separate dataset (default mode):** this starts with a fresh database. It does not mount or
  modify your normal Mac database. Use app export/import to transfer data; never
  open the same DuckDB file from the host and container simultaneously.
- **Source snapshot:** the build includes local source changes but excludes host
  dependencies, databases, uploads, `.git`, and environment files. Rerun the
  command after edits; host files are not live-mounted. Build layers are cached.
  The recorded commit SHA identifies the checkout baseline, not uncommitted edits.
- **Dependencies:** Bun is pinned to 1.3.13 and dependencies install from
  `bun.lock` inside Linux. Native macOS modules are never reused. The first build
  needs network access for the base image and packages.
- **Providers and secrets:** shell credentials and local model runtimes are not
  automatically forwarded. Configure providers in the app as usual. Container
  `localhost` means the VM, not the Mac; a model server on the host needs a
  container-reachable host address and suitable bind/firewall configuration.
  Apple GPU/Metal workloads and the native desktop UI do not run in this Linux VM.
- **Scope:** this is a development server, not a production deployment. One named
  instance is supported to avoid concurrent use of the same database volume.

## Verification

```sh
bun test scripts/runAppleContainer.test.ts scripts/appleContainerHostDatabase.test.ts
bun run dev:container --dry-run
bunx eslint scripts/runAppleContainer.ts scripts/runAppleContainer.test.ts vite.config.ts
bun run build
```

On a machine with the CLI installed, run `bun run dev:container`, open the app,
create/import a small dataset, stop and restart, and confirm that data persists.
Use `container stats forska-dev-8gb --no-stream` to inspect the running VM.

CLI syntax reference: <https://github.com/apple/container/blob/main/docs/command-reference.md>.

## Live verification notes (2026-09-08)

Apple CLI 1.3.1 with the recommended Linux kernel successfully built and ran the
ARM64 image. With an isolated database, Chromium rendered the UI, API and owner
readiness returned 200, and `/api/comparison-projects` returned 200 through Vite.
Memory was about 1.7 GiB of the configured 8 GiB.

The unpatched engine exhausted its 4GB checkpoint budget on the existing
approximately 123 GB primary database. The former container-only native backport
fixed the reproduced deletion-metadata allocation problem: an ordinary full
checkpoint on the preserved real-DB clone passed at the unchanged literal
`4GB` DuckDB / `8G` VM limits in 13 seconds, with process RSS about 2.11 GB.

The patched app also ran against the original host DB: API, DuckDB owner and
judge readiness returned 200. On an active project, completed rebuild chunks advanced
68 → 120 and pending chunks fell 317 → 265 between 13:25:12 and 13:26:36 UTC.
`lastProgressedAt` advanced; failed/quarantined/expired chunk counts stayed zero.
This is real current-DB progress, not just a readiness smoke test.

Chromium loaded 100 article rows without page errors, and all three readiness
checks returned 200 again around 13:29 UTC. Normal bounded-loop runtime recycling
occurred twice after exceeding the 3 GB RSS threshold; an owner-not-ready 502
was observed during recycling and recovered. No OOM/process crash was observed,
but uninterrupted request availability across recycling is not established.
The test stack was then stopped cleanly with SIGTERM.

A disposable host 1.5.1 → patched-container checkpoint → host 1.5.1 read-only
roundtrip retained exact rows, sum and WAL marker. The old-engine compatibility
read uses 128 MiB; patched checkpoint and fresh-process reopen gates stay at
32 MiB. The patched image passed that regression and all 13 upstream native
cases; five launcher tests, focused lint and the web build also passed.
Reproduction commands are in [TESTS.md](../../TESTS.md#apple-container-launcher).
DB/WAL and logs remain preserved. See the
[investigation record](../../docs/apple-container-checkpoint-investigation.md)
and `OOM_ERRORS.md`. The Windows conflict-resolution crash has **not** been
reproduced or proven fixed by these historical checks. At that point, host
web/desktop native dependencies had not been changed.

## Shared pinned DuckDB engine

The container, normal web/server installation, and desktop build now install the
same official **DuckDB `v2.0.0-alpha40881`** revision
`816a3eb2d512ce359efb40d9319f6db59788422a` through platform-specific packages.
The unchanged Node C-API bridge is packaged together with the official native
library; the package lock pins the distribution. See
[distribution provenance and update procedure](../../vendor/duckdb/README.md).

The Dockerfile uses `bun install --frozen-lockfile`; it does not compile C++ or
replace installed native libraries afterward. The native backport build and
patch files have been removed. The earlier backport investigation remains in
[the historical record](duckdb-backport.md).

Every image build runs `bun scripts/verifyDuckdbDistribution.ts`: it validates
which package and engine actually loaded, scalar/nested NULL decoding,
transaction commit/rollback, new-WAL replay in a fresh process, and the unchanged
32 MiB checkpoint regression. Startup prints the installed package's provenance.
Desktop builds remove other platforms’ DuckDB packages from the copied bundle,
then verify its native files and load that copied engine before packaging; the app does not download DuckDB at
runtime. Build each desktop target natively so the copied engine can be executed.

Bun currently downloads all six tarball-override packages even though each package
has platform metadata; the installed loader selects only the current target.
The image build removes unused targets in the same install layer and keeps the
Bun download cache outside the image. Desktop pruning touches only copied build
output, never the developer's installed packages. This bounds delivered image/app
size; it does not hide or eliminate Bun's extra initial download cost.

No separate engine installation or file copying is required:

```sh
git pull
bun install
bun run dev:container
```

For ordinary host development use `bun run dev:start` after the same install.
The image still needs network access for its base image and pinned packages on
its first build, but no compiler toolchain or custom engine build cache.

### Existing databases and WAL

Do not delete WAL files as a routine upgrade step. A WAL can hold committed data
not yet written to the database file. This alpha rejects one historical WAL
shape accepted by 1.5.1. A normal pending 1.5.1 WAL replays successfully, so
users generally do not need to remove WAL files; new-alpha replay is checked
separately. The runtime
must report the compatibility problem rather than silently discard data.
Follow [the migration/recovery guidance](../../vendor/duckdb/README.md) if an old
WAL is rejected. Discarding an old WAL is only appropriate for an explicitly
authorized disposable reset with all database users stopped.

The shared compatibility option `legacy_disable_null_type=true` is required by
the existing Node bindings and is applied by the application on every relevant
connection. Without it, the alpha's SQLNULL results can fail decoding even when
a simple version/query check passes.

An alpha engine and a passing checkpoint regression are not a promise that every
platform workload is correct. Review the
[recorded preview findings](duckdb-preview-evaluation.md), require the CI native
install matrix, and verify the affected Windows conflict-resolution workload
before claiming that specific crash is fixed.
