## Bucardo Two-Way Sync

This stack includes a Bucardo service that syncs the local Postgres (Compose `db`) with a remote Postgres reachable at `host.docker.internal:8432`.

Key properties:
- Multi-master (both local and remote are sources)
- Scoped to `public` schema tables only
- Excludes `drizzle.__drizzle_migrations`
- Conflict policy: last-write-wins (Bucardo `latest` strategy)
- Seeds initial convergence using `onetimecopy=2` when the sync is first created

Environment assumptions:
- Both DBs use superuser creds from `.env.local` (`DB_USER`, `DB_PASS`, `DB_NAME`).
- Remote DB is accessible inside Docker via `host.docker.internal:8432`.

### Compose Service

The `bucardo` service uses image `bucardo/bucardo:latest` and runs an idempotent bootstrap script at `scripts/bucardo/bootstrap.sh` which:
1. Waits for the local Postgres to be healthy.
2. Ensures a `bucardo` control database exists on the local cluster.
3. Installs Bucardo.
4. Registers `localdb` and `remotedb` connections.
5. Creates a relgroup and adds all `public.*` tables and sequences (excluding `drizzle.__drizzle_migrations`).
6. Creates a bidirectional sync with conflict strategy `latest`, autokick enabled, and `onetimecopy=2` for initial convergence.
7. Starts the Bucardo daemon and prints status every 60s.

### Operations

- Status (live):
  - `docker compose exec bucardo bucardo status`
  - Continuous: the container prints `bucardo status --loop 60` to stdout

- List objects:
  - `docker compose exec bucardo bucardo list db`
  - `docker compose exec bucardo bucardo list relgroup`
  - `docker compose exec bucardo bucardo list sync`

- Control:
  - `docker compose exec bucardo bucardo start`
  - `docker compose exec bucardo bucardo stop`
  - `docker compose exec bucardo bucardo reload`
  - `docker compose exec bucardo bucardo kick public_all_sync`

### Schema changes

When applying DDL changes:
1. Pause writes if possible, or expect a brief replication stall.
2. Run migrations on both databases (Drizzle) to keep schemas aligned.
3. Reload Bucardo: `docker compose exec bucardo bucardo reload`.
4. If you add new tables in `public`, restart the `bucardo` service or re-run the container to let the bootstrap script re-add new tables to the relgroup.

### Notes

- Initial merge: The sync is created with `onetimecopy=2` to help converge data both ways on first run. If you prefer to avoid this, set `onetimecopy=0` manually and seed copies yourself.
- Conflict policy: `latest` approximates last-write-wins. Tables with `updated_at` timestamps align naturally with this policy.
- Availability: If either DB goes down, Bucardo will resume sync when both are reachable again.

