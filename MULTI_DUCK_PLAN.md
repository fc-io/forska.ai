# Multi Duck Plan

## Goal

- [ ] Make live DuckDB single-owner.
- [ ] Let multiple Forska processes run without lock churn.
- [ ] Auto elect one writer on one machine.
- [ ] Keep DuckDB UI usable.

## Hard Rules

- [ ] One process owns writable `DUCKDB_PATH`.
- [ ] Non-owner processes never open the live file, even read-only.
- [ ] Only owner mounts DB-writing cron from `src/server/index.ts`.
- [ ] Route DB-backed reads/writes through owner; do not rely on open-close-per-query retries.
- [ ] `auto` becomes default; manual roles stay as override/debug mode.
- [ ] DuckDB UI never opens the live file writable while owner is up.
- [ ] Do not store the writer lease inside the live DuckDB file.

## Why

- [ ] `src/server/utils/duckdbService.ts` keeps one warm child per Bun process; second process means second lock attempt.
- [ ] `src/server/index.ts` mounts cron in every server today.
- [ ] `src/server/cron/fullTextJobs.ts` and `src/server/cron/fullTextConversionJobs.ts` can double-pick work.
- [ ] `src/server/cron/judgmentsJobs/jobCursorStore.ts` updates cursors without ownership checks.
- [ ] `scripts/dbStudio.ts` opens the database directly.

## Target Model

- [ ] `auto`: default; race for lease, become `writer` or `api`.
- [ ] `writer`: manual override; owns DuckDB, runs cron, serves snapshots, runs maintenance.
- [ ] `api`: manual override/debug; no local DuckDB, proxies `/api/*` to current `writer`.
- [ ] `worker`: optional; either DB-free or talks to `writer`.
- [ ] `dev-single`: one-process local mode.

## Phase 0 - Effect First

- [x] Install `effect` with `bun add effect`.
- [ ] Use `Effect.gen` for writer startup, lease flow, shutdown, snapshot creation, and DB RPC.
- [ ] Use `Layer`/`Context` for lease provider, local DB, remote DB client, and snapshot services.
- [ ] Use `Effect.acquireRelease` and `Scope` for DuckDB child lifecycle and lease lifetime.
- [ ] Use `Schedule` for lease renewal, retry, and backoff instead of ad hoc timers.

## Phase 1 - Manual Single-Machine Guard

- [x] Add `SERVER_ROLE` with `writer | api | worker | dev-single`.
- [x] Add `duckdbOwnerLease` before `ensureStartedDuckdbProcess()` in `src/server/utils/duckdbService.ts`.
- [x] Start with sidecar lockfile lease for same-host safety.
- [x] On lease miss, refuse local DuckDB startup and print owner metadata.
- [x] Add `SIGINT`/`SIGTERM` shutdown hooks so writer closes DuckDB and releases lease.

## Phase 2 - Manual API Followers

- [x] `api` proxies `/api/*` to `writer` over loopback/private URL.
- [x] Keep transactions on `writer` by proxying at route level, not DB-call level.
- [x] Replace static `SERVER_WRITER_URL` with lease discovery in `auto` mode.

## Phase 3 - Auto Mode

- [x] Add `SERVER_ROLE=auto`; make it default outside `dev-single`.
- [x] On boot, `auto` races for sidecar writer lease.
- [x] Winner becomes `writer`; loser reads lease metadata and becomes `api`.
- [x] Lease metadata stores `leaseId`, `pid`, `port`, `heartbeatAt`.
- [x] Writer heartbeats lease on interval.
- [x] Followers reread lease on proxy failure and retry once.
- [x] If `pid` is dead, followers race to take over.
- [ ] If heartbeat is stale but pid alive, decide whether to promote or just warn.
- [ ] If writer loses lease, demote: stop cron, close DuckDB, become `api`.
- [x] Keep manual `writer | api | dev-single` as override/debug modes.

## Phase 4 - Cron And Script Ownership

- [x] Mount `judgmentsJobsCron`, `fullTextJobsCron`, `fullTextConversionJobsCron`, and `nvidiaSmiCron` only in `writer`.
- [ ] Keep current env flags as sub-toggles, not as ownership.
- [x] Log role and writer status at boot.
- [ ] Mark migrations, imports, rebuilds, and maintenance scripts as `writer`-only or maintenance-only.

## Phase 5 - Work Claims

- [ ] Judgments: keep atomic prompt claim, add compare-and-set cursor updates, consider DB constraint for one running job per project.
- [ ] Full-text fetch: add explicit claim fields or queue table before network fetch.
- [ ] Full-text conversion: add explicit claim fields or queue table before conversion.
- [ ] Nvidia SMI: owner-only, or a dedicated telemetry worker that writes through owner RPC.

## Phase 6 - DuckDB UI

- [x] Default `dbStudio` mode becomes snapshot UI, not live DB.
- [x] `writer` adds a snapshot operation: checkpoint, copy/export DB to temp path, return snapshot path + timestamp.
- [x] Launch UI against snapshot with `duckdb -readonly -ui <snapshot>`.
- [ ] Show snapshot age; refresh means rebuild snapshot.
- [x] In `auto`, resolve current writer from lease, not static env config.
- [ ] Optional `--maintenance-live` mode: stop writer, release lease, open live UI, reacquire on exit.

## Phase 6.5 - Writer Connections UI

- [x] Track follower api processes on writer with `hostname`, `pid`, `port`, `lastHeartbeatAt`, `lastProxyAt`.
- [x] Add `/api/writer_connections` for current writer + follower list.
- [x] Add admin page for writer connections.
- [x] Add admin menu link to that page.
- [x] In `auto`, use lease metadata to show current writer and takeover history.
- [x] Show stale vs active followers and last proxied route.
- [x] Add takeover event log.

## Phase 7 - Rollout

- [x] v1: same-host safety; manual `writer`, many `api` processes.
- [x] v2: same-host `auto` with takeover and lease discovery.
- [ ] v3: optional dedicated writer service binary.

## Tests

- [x] Add test: second process cannot acquire writer lease.
- [x] Add test: non-writer process routes API requests to writer.
- [x] Add test: first `auto` instance becomes writer.
- [x] Add test: second `auto` instance becomes api.
- [x] Add test: follower promotes after writer exit.
- [x] Add test: proxy rereads lease and reconnects to new writer.
- [ ] Add test: cron does not run outside current writer.
- [ ] Add test: full-text and judgment claim paths stay single-owner.
- [x] Add test: writer connections endpoint shows follower api process.
- [x] Add test: UI snapshot path works while writer is live.
- [ ] Add test: stale lease recovery after unclean exit.

## Done When

- [ ] Starting a second server never spawns a second live DuckDB child for the same DB.
- [x] `auto` elects one writer on one machine.
- [x] Writer handoff works after writer exit.
- [ ] Multiple Forska API processes can run together.
- [ ] All DB-backed cron/work is single-owner or explicitly claimed.
- [ ] DuckDB UI works via snapshot without stopping the app.
- [ ] Live maintenance UI is explicit, not accidental.
