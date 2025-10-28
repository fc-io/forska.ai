# Database Sync (Bucardo)

This repository includes a Bucardo-based two-way sync between the local Compose Postgres (`db`) and a remote Postgres accessible from containers at `host.docker.internal:8432`.

Highlights
- Multi-master sync: both local and remote are sources
- Scope: all tables under `public.*`
- Excludes: `drizzle.__drizzle_migrations`
- Conflict policy: last-write-wins via Bucardo `latest` strategy (aligned with `updated_at` timestamps)
- Resumes when either DB comes back online

## Prerequisites
- `.env.local` contains:
  - `DB_NAME`, `DB_USER`, `DB_PASS` (used for both local and remote)
  - `REMOTE_DATABASE_URL` is informational; Bucardo uses host/port/env below
- Remote database reachable at `host.docker.internal:8432` from inside Docker
  - If you use an SSH tunnel, run it on the host to expose `localhost:8432`

## Boot and Status

- Start local DB and Bucardo:
  - `bun run bucardo:up`

- Tail logs:
  - `bun run bucardo:logs`

- Check status and objects:
  - `bun run bucardo:status`
  - `bun run bucardo:dbs`
  - `bun run bucardo:relgroups`
  - `bun run bucardo:syncs`

## Control

- Reload configuration (after schema changes):
  - `bun run bucardo:reload`

- Start/stop/restart:
  - `bun run bucardo:start`
  - `bun run bucardo:stop`
  - `bun run bucardo:restart`

- Kick a sync run:
  - `bun run bucardo:kick` (targets `public_all_sync`)

## Initial State and Data Merge

On first run, the sync is created with `onetimecopy=2`, which performs a one-time convergence copy in both directions. Since your databases previously shared most rows, this helps fill gaps. Conflicts are resolved with `latest` (last-write-wins), which works best when tables have `updated_at` timestamps.

## Schema Changes

When applying DDL changes:
1. Pause writes if possible (to minimize conflicts).
2. Apply Drizzle migrations to both databases.
3. Reload Bucardo config: `bun run bucardo:reload`.
4. If new `public` tables were added, restart the Bucardo service (`bun run bucardo:restart`) so the bootstrap script re-adds tables and sequences.

## Notes
- Exclusions: `drizzle.__drizzle_migrations` is excluded from replication.
- Control DB: Bucardo stores its metadata in a `bucardo` database on the local Postgres service.
- Credentials: Bucardo requires superuser-level privileges to create triggers.
- Availability: If either DB is down, Bucardo will retry and resume automatically once both are reachable.

For deeper details and manual commands, see `docs/bucardo.md`.

