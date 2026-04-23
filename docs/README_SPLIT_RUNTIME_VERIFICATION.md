# Split Runtime Verification

Use this when checking the local cutover stack before shipping runtime changes.

## Split Stack

The default profile stack starts all backend roles without editing files:

```bash
bun run db:mig
bun run dev:server
bun run dev:app
```

Primary ports:

- API: `3001`
- Maintenance worker and DuckDB owner: `3002`
- Judge worker: `3003`
- Vite app: `3000`
- Runtime root: `data/runtime/primary/`

Secondary uses the same layout on `3101`, `3102`, `3103`, and `3100`:

```bash
bun run db:mig:secondary
bun run dev:secondary:server
bun run dev:secondary:app
```

Single-role launchers are available when reproducing failures:

```bash
bun run dev:server:api
bun run dev:server:maintenance
bun run dev:server:judge
```

## Readiness And Registry

`GET /api/runtime/ready` is process-local bootstrap readiness. It must keep returning `200` even when shared worker registry state says maintenance is missing or takeover is in progress.

`GET /api/duckdb_owner_connections` is the operator registry and owner diagnostics surface. It can report:

- no eligible maintenance consumer
- owner proxy disabled or unavailable
- takeover status such as `takeover_in_progress`
- fresh or stale role heartbeats

Missing-maintenance drill:

```bash
FORSKA_OWNERLESS_READ_ONLY_DUCKDB=disabled bun run dev:server:api
curl -s http://127.0.0.1:3001/api/runtime/ready
curl -s http://127.0.0.1:3001/api/duckdb_owner_connections
curl -i http://127.0.0.1:3001/api/users
```

Expected result: readiness returns `ready: true`, the registry has no eligible maintenance consumer, and owner-dependent product routes fail closed with `502` when no DuckDB owner is reachable.

## Route Surfaces

Public product API routes belong on `api` and `dev-single`. A `maintenance-worker` exposes the product API only under the private owner RPC prefix.

```bash
bun run dev:server:maintenance
curl -i http://127.0.0.1:3002/api/users
curl -i http://127.0.0.1:3002/__duckdb-owner-rpc/api/users
```

Expected result: public `/api/users` is not mounted on the maintenance worker, while the private owner RPC route answers.

## Same-Host Failover

Use `auto` only for failover drills. Start two same-host runtimes against one DuckDB path:

```bash
DUCKDB_PATH=data/runtime/failover/forska.duckdb API_SERVER_PORT=3201 SERVER_ROLE=auto bun run src/server/index.ts
DUCKDB_PATH=data/runtime/failover/forska.duckdb API_SERVER_PORT=3202 SERVER_ROLE=auto bun run src/server/index.ts
```

Then stop the current owner and poll the follower:

```bash
curl -s http://127.0.0.1:3202/api/duckdb_owner_connections
```

Expected result: the follower reports itself as owner after the previous same-host owner exits. A responsive owner with a stale heartbeat must not be taken over.

## Cutover Refusal

Every peer-visible surface must carry the current split runtime version. Startup and proxy paths reject missing or incompatible writer-era peers:

- reachable owner diagnostics without `split-runtime-v1`
- fresh `.writer.lock` legacy writer leases
- owner-routed API requests with missing or mismatched runtime-version headers

Targeted checks:

```bash
bun test src/server/indexStartup.test.ts -t "pre-cutover"
bun test src/server/routes/ApiProxyRoutes.test.ts -t "runtime version"
```

Expected result: incompatible peers fail closed with `Incompatible Forska split runtime version`.

## Judge Journal

The primary profile sets `JUDGE_WORKER_ID=primary-judge-worker`; the secondary profile sets `secondary-judge-worker`. The journal path is derived from that durable identity unless `JUDGE_WORKER_JOURNAL_PATH` is explicitly set to another durable app-data path.

Collision drill:

```bash
bun run dev:server:judge
bun run dev:server:judge
```

Expected result: the second process refuses startup because the same live journal path is locked. Use the secondary profile or a different durable `JUDGE_WORKER_ID` for an additional worker.

Replay drill:

```bash
bun test src/server/indexStartup.test.ts -t "replays unacked completions"
```

Expected result: restarting a judge worker with the same durable identity reopens the same journal and replays unacknowledged completions to the owner before accepting new dispatch work.

## Snapshot Fetch

Owner-backed claim routes persist an immutable execution snapshot before returning work to a judge worker. Snapshot fetch requires both id and hash:

```bash
curl -s "http://127.0.0.1:3001/api/judgmentsjobs/execution-snapshots/<snapshot-id>?executionSnapshotHash=<hash>"
```

The API role proxies this owner-dependent read to the maintenance worker private RPC surface. The compatibility alias `/api/judgmentsjobs-execution-snapshots/<snapshot-id>?executionSnapshotHash=<hash>` is kept for clients that cannot express the nested path.

Disabling live read-only DuckDB must not break declared ownerless diagnostics:

```bash
FORSKA_OWNERLESS_READ_ONLY_DUCKDB=disabled bun run dev:server:api
curl -s http://127.0.0.1:3001/api/runtime/ready
curl -s http://127.0.0.1:3001/api/duckdb_owner_connections
curl -s http://127.0.0.1:3001/api/admin/worker-runtime-diagnostics
```

Expected result: ownerless routes answer through `ownerless-control-state` or process runtime state; owner-dependent product and snapshot routes still fail closed when no owner is reachable.

## Quality Gates

Run these before marking split-runtime verification complete:

```bash
bun test src/server/indexStartup.test.ts scripts/runWithRuntimeProfile.test.ts src/utils/runtimeProfile.test.ts
bun test src/desktop/getDesktopRuntimeConfig.test.ts src/desktop/desktopSingleInstance.test.ts
bun run build
bun run desktop:build
bun run lint
```
