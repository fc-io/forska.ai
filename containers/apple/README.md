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
forwards termination to its app process group and waits for exit. The existing
low-memory app shutdown path may retain leases; after a stopped-VM verification,
preserve stale lease evidence before switching back to host-DB mode. The disposable container is removed
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

The existing approximately 123 GB primary database is **not verified at 8 GiB**:
its startup checkpoint exhausted the 4GB DuckDB budget on one run (the owner
subsequently became ready), and another run became unresponsive near the VM
memory limit. DB/WAL and boot/application logs were preserved locally. See
`OOM_ERRORS.md`; neither the checkpoint OOM nor the reported Windows
conflict-resolution crash is claimed fixed by this container work.
