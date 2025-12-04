# Database Sync: Local -> Remote

This guide explains how to use the `db:sync:local-to-remote` script to synchronize your **Local Development Database** to a **Remote PostgreSQL Database**.

## Overview

The script (`scripts/dbSyncLocalToRemote.ts`) performs a **one-way synchronization** from Local to Remote. It handles:

1.  **Schema Migrations**: Automatically applies pending Drizzle migrations to the remote database.
2.  **Data Synchronization**:
    *   **Updates**: Updates rows on the remote that have changed locally.
    *   **Inserts**: Inserts new rows from local that are missing on remote.
    *   **Delta Sync**: By default, it only scans local rows modified since the last sync (using `updated_at`).
3.  **Sequence Adjustment**: Updates sequences on the remote database to match the new data.

## Prerequisites

1.  **Local Database Running**: Your local Docker database must be up (`docker compose up -d db`).
2.  **SSH Tunnel**: You must have an active SSH tunnel to the remote database.
    *   Example: `ssh -N -L 8432:127.0.0.1:5433 alvis2`
    *   The script uses `REMOTE_DATABASE_URL` from your environment (e.g., `.env` or `.env.local`).

## Usage

### 1. Standard Sync (Delta Mode)

This is the default mode. It is efficient and only syncs data changed since the last run.

```bash
bun run db:sync:local-to-remote
```

### 2. Full Sync (Force Full Scan)

If you suspect data inconsistency or want to force a re-check of all rows (ignoring `updated_at` timestamps), use the `--full` flag. This will compare every row in every table.

```bash
bun run db:sync:local-to-remote --full
```

## How It Works

1.  **Migrations**: Runs `bunx drizzle-kit migrate` against the remote URL.
2.  **FDW Setup**: Creates a temporary `postgres_fdw` connection (`import_remote` schema) in your local DB to talk to the remote DB.
3.  **State Tracking**:
    *   Maintains a local table `sync_state_local_to_remote` to track the `last_synced_at` timestamp for each table.
    *   Tables with an `updated_at` column use this timestamp for delta syncing.
    *   Tables *without* `updated_at` are always fully scanned.
4.  **Data Sync**:
    *   Iterates through tables in topological order (respecting foreign keys).
    *   Performs `UPDATE` for changed rows.
    *   Performs `INSERT` for new rows.
5.  **Cleanup**: Removes the temporary FDW schemas and servers.

## Troubleshooting

*   **"extension 'postgres_fdw' already exists"**: This is a harmless notice. The script ensures the extension is enabled.
*   **Connection Refused**: Check your SSH tunnel. Ensure `REMOTE_DATABASE_URL` points to the correct local port forwarded to the remote.
*   **Permission Denied**: Ensure the remote database user (in `REMOTE_DATABASE_URL`) has sufficient privileges to create tables (for migrations) and modify data.

## Safety Warning

> [!WARNING]
> **Destructive Operation**: This script **modifies data on the remote database**. It will overwrite remote rows with local data if they share the same Primary Key.
>
> *   **Backups**: It is highly recommended to backup the remote database before running this, especially for the first time or after major schema changes.
> *   **One-Way**: This does NOT sync data back from Remote to Local. For that, use `db:sync:remote`.
