# Multi Duck Plan

## Goal

- [ ] Make live DuckDB single-owner.
- [ ] Let multiple Forska processes run without lock churn.
- [ ] Keep failover possible.
- [ ] Keep DuckDB UI usable.

## Hard Rules

- [ ] One process owns writable `DUCKDB_PATH`.
- [ ] Non-owner processes never open the live file, even read-only.
- [ ] Only owner mounts DB-writing cron from `src/server/index.ts`.
- [ ] Route DB-backed reads/writes through owner; do not rely on open-close-per-query retries.
- [ ] DuckDB UI never opens the live file writable while owner is up.
- [ ] Do not store the writer lease inside the live DuckDB file.

## Why

- [ ] `src/server/utils/duckdbService.ts` keeps one warm child per Bun process; second process means second lock attempt.
- [ ] `src/server/index.ts` mounts cron in every server today.
- [ ] `src/server/cron/fullTextJobs.ts` and `src/server/cron/fullTextConversionJobs.ts` can double-pick work.
- [ ] `src/server/cron/judgmentsJobs/jobCursorStore.ts` updates cursors without ownership checks.
- [ ] `scripts/dbStudio.ts` opens the database directly.

## Target Model

- [ ] `writer`: owns DuckDB, runs cron, serves internal DB RPC, runs marts and maintenance.
- [ ] `api`: serves HTTP/UI, no local DuckDB, proxies DB work to `writer`.
- [ ] `worker`: optional; either DB-free or talks to `writer`.
- [ ] `dev-single`: one-process local mode.

## Phase 0 - Effect First

- [x] Install `effect` with `bun add effect`.
- [ ] Use `Effect.gen` for writer startup, lease flow, shutdown, snapshot creation, and DB RPC.
- [ ] Use `Layer`/`Context` for lease provider, local DB, remote DB client, and snapshot services.
- [ ] Use `Effect.acquireRelease` and `Scope` for DuckDB child lifecycle and lease lifetime.
- [ ] Use `Schedule` for lease renewal, retry, and backoff instead of ad hoc timers.

## Phase 1 - Single Owner Guard

- [ ] Add `SERVER_ROLE` with `writer | api | worker | dev-single`.
- [ ] Add `duckdbOwnerLease` before `ensureStartedDuckdbProcess()` in `src/server/utils/duckdbService.ts`.
- [ ] Start with sidecar lockfile lease for same-host safety.
- [ ] Keep lease provider pluggable; later swap in Redis/Postgres/etc for multi-host failover.
- [ ] On lease miss, refuse local DuckDB startup and print owner metadata.
- [ ] Add `SIGINT`/`SIGTERM` shutdown hooks so writer closes DuckDB and releases lease.

## Phase 2 - Split Local vs Remote DB Service

- [ ] Keep `getAppDatabaseService()` call shape: `queryJson`, `run`, `transaction`, `maintenance`, `close`.
- [ ] `writer` uses current local `duckdbService`.
- [ ] Non-writer roles use `remoteAppDatabaseService`.
- [ ] Expose internal DB RPC on loopback/private transport only; do not make it a public app API.
- [ ] Move read services too; do not depend on live read-only side connections.

## Phase 3 - Cron And Script Ownership

- [ ] Mount `judgmentsJobsCron`, `fullTextJobsCron`, `fullTextConversionJobsCron`, and `nvidiaSmiCron` only in `writer`.
- [ ] Keep current env flags as sub-toggles, not as ownership.
- [ ] Log role, owner id, and enabled cron families at boot.
- [ ] Mark migrations, imports, rebuilds, and maintenance scripts as `writer`-only or maintenance-only.

## Phase 4 - Work Claims

- [ ] Judgments: keep atomic prompt claim, add compare-and-set cursor updates, consider DB constraint for one running job per project.
- [ ] Full-text fetch: add explicit claim fields or queue table before network fetch.
- [ ] Full-text conversion: add explicit claim fields or queue table before conversion.
- [ ] Nvidia SMI: owner-only, or a dedicated telemetry worker that writes through owner RPC.

## Phase 5 - DuckDB UI

- [ ] Default `dbStudio` mode becomes snapshot UI, not live DB.
- [ ] `writer` adds a snapshot operation: checkpoint, copy/export DB to temp path, return snapshot path + timestamp.
- [ ] Launch UI against snapshot with `duckdb -ui <snapshot>` or `duckdb -readonly -ui <snapshot>`.
- [ ] Show snapshot age; refresh means rebuild snapshot.
- [ ] Optional `--live-readonly` mode only after explicit verification on our DuckDB version; never default while writer is active.
- [ ] Optional `--maintenance-live` mode: stop writer, release lease, open live UI, reacquire on exit.

## Phase 6 - Rollout

- [ ] v1: same-host safety; one writer, many api processes.
- [ ] v2: multi-host safety with external lease provider and health-based promotion.
- [ ] v3: optional dedicated writer service binary.

## Tests

- [ ] Add test: second process cannot acquire writer lease.
- [ ] Add test: non-writer process routes DB calls remotely.
- [ ] Add test: cron does not run outside writer.
- [ ] Add test: full-text and judgment claim paths stay single-owner.
- [ ] Add test: UI snapshot path works while writer is live.
- [ ] Add test: stale lease recovery after unclean exit.

## Done When

- [ ] Starting a second server never spawns a second live DuckDB child for the same DB.
- [ ] Multiple Forska API processes can run together.
- [ ] All DB-backed cron/work is single-owner or explicitly claimed.
- [ ] DuckDB UI works via snapshot without stopping the app.
- [ ] Live maintenance UI is explicit, not accidental.
