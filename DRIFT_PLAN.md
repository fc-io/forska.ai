# Drift Handling Plan (PeerDB + ClickHouse Derived Tables)

## Problem Statement

We replicate Postgres tables into ClickHouse via PeerDB (e.g. `forska.articles`, `forska.judgments_raw`).

We also maintain a derived ClickHouse table (`forska.judgments`) populated by a materialized view (`forska.judgments_mv`) that enriches `judgments_raw` with article metadata (title, import route, years).

When `forska.articles` replication is temporarily behind/stalled and later catches up, `forska.judgments_mv` can insert derived rows during the lag window where the article row/version is missing in ClickHouse. These derived rows then have missing enrichment (e.g. `articleTitle = ''`, `articleImportRoute IS NULL`).

ClickHouse materialized views are insert-triggered on the source table only (`judgments_raw`), so they do not retroactively recompute derived rows when `articles` arrives/updates later. Without an explicit repair/backfill, enrichment can remain stale indefinitely.

Separately, the judging queue is capacity-driven and works on `(articleId, promptId)` pairs. A small number of articles times many prompts can yield thousands of pairs (e.g. 300 articles x 23 prompts ~= 6900 pairs). This amplifies any drift bugs.

## Goals

- Keep `forska.judgments` (derived) continuously correct and self-healing after upstream catch-up.
- Ensure judging “ready fetch” never wedges when ClickHouse is unhealthy or out-of-date.
- Provide clear operational signals (health metrics) and safe recovery paths.

## Non-Goals

- Fix PeerDB itself (we can detect stalls and optionally restart, but replication correctness is owned by PeerDB).
- Make ClickHouse derived tables transactional with Postgres (we accept eventual consistency).

## Current Mitigations (Already in Code)

- Admin UI has a “Rebuild CH Judgments Derived Table” action which drops/recreates `forska.judgments_mv` and rebuilds `forska.judgments`.
- Admin UI has a derived-health card that measures:
  - row drift (`judgments_raw` vs `judgments`)
  - missing derived rows (recent window)
  - enrichment gaps (`articleTitle = ''`, `articleImportRoute IS NULL`) and whether the article now exists in CH

These are useful diagnostics, but rebuild is a manual, disruptive repair.

## Proposed Solution

### 1) Incremental Repair Cron (Recommended)

Add a server-side cron job that incrementally repairs derived enrichment after `forska.articles` catches up.

Key idea: when ClickHouse receives an article row/version late, we re-emit enriched derived judgment rows for that `articleId` by joining `forska.judgments_raw` to `forska.articles` and inserting into `forska.judgments`.

#### Repair input signals

The repair job processes `articleId`s from one or both of these sources:

1. Newly synced articles (robust for catch-up):

- Read `forska.articles` ordered by `(_peerdb_synced_at, id)` and process rows where `_peerdb_synced_at > cursor`.

2. Stale enrichment backlog (targets what is known broken):

- Read `forska.judgments` where `articleTitle = '' OR articleImportRoute IS NULL` and the article exists in `forska.articles`.

Practical approach:

- Primary driver: `_peerdb_synced_at` cursor (fast convergence after catch-up)
- Secondary driver: periodic backlog sweep (keeps the broken set near zero)

#### Versioning so repairs replace stale rows

`forska.judgments` uses `ReplacingMergeTree(_peerdb_version)`. If we re-insert the same `id` with the same `_peerdb_version`, replacement is ambiguous.

We need a deterministic derived version scheme:

- In MV output: set `_peerdb_version = j._peerdb_version * 2`
- In repair inserts: set `_peerdb_version = j._peerdb_version * 2 + 1`

This guarantees:

- repair row wins over the original MV row for the same raw version
- a future raw update (higher `j._peerdb_version`) will still win over any earlier derived rows

This requires updating:

- MV query in `src/services/clickhouse/ensureClickhouseSchema.ts`
- Rebuild script in `src/services/clickhouse/rebuildClickhouseJudgmentsDerivedTable.ts`

#### Cursor/state

Store a cursor for the repair cron:

- `lastPeerdbSyncedAt` (DateTime)
- `lastArticleId` (String) for tie-breaker

Recommended storage: Postgres (new small table), to keep state durable and observable.

#### Throttling and safety

- Run every N minutes (e.g. 1–5 minutes)
- Process bounded batches (e.g. 200–1000 article IDs)
- Ensure singleton execution (skip if still running)
- Log batch size, duration, rows inserted, and cursor advancement
- Feature flag via env (default false): `RUN_SERVER_CH_DERIVED_REPAIR_CRON`

#### SQL shape (ClickHouse)

For a batch of `articleId`s:

- `INSERT INTO forska.judgments (...)`
- `SELECT ... FROM forska.judgments_raw FINAL j ANY LEFT JOIN forska.articles a ON j.article_id = a.id AND a._peerdb_is_deleted = 0`
- `WHERE j._peerdb_is_deleted = 0 AND j.deleted_at IS NULL AND j.article_id IN (...)`

### 2) Plan-B: Degrade Gracefully for Ready-Fetch

Even with repair, PeerDB can stall, ClickHouse can be temporarily unreachable, or ClickHouse can be slow.

The judging scheduler should keep making progress without depending on ClickHouse.

#### Fallback behavior

Implement a Postgres-based fallback for fetching “unassessed pairs” under the same scoping rules:

- Scope is the union of:
  - project routes (via `article_route_link` and `import_route`)
  - curated articles (via `project_articles`)
- Apply project date bounds on `articles.articleCreatedAt`
- Apply content flags and modelId when excluding already-judged pairs (content-aware uniqueness)
- Keep the same cursor ordering semantics (by article updated/created date + id)

#### When to fall back

Trigger fallback when any of these conditions hold:

- ClickHouse query fails/times out
- ClickHouse returns 0 pairs while the scheduler still needs work
- ClickHouse returns many pairs but Postgres filter drops ~all of them for multiple consecutive ticks (heuristic; reduces flapping)

Integration point:

- After ClickHouse fetch + Postgres `filterAlreadyJudged`, if the effective “new” pairs are still below target, top up using Postgres fallback.

#### Operational note

This is a safety valve. It can be slower than ClickHouse, so it should be:

- bounded
- used only when needed
- instrumented (log when it kicks in)

### 3) Handling Actual `articles` Replication Drift

No derived-table repair can fix missing article rows in ClickHouse if PeerDB is not delivering them.

We can:

- Detect drift (already on `/admin/sync-stats`):
  - `max(_peerdb_synced_at)` and `max(updated_at)` divergence for `forska.articles`
  - “PG rows updated after CH max updated” counters

- Degrade judging safely (Plan-B fallback above)

- Provide recovery UX:
  - Safe: show copy-pastable `docker compose restart ...` commands for PeerDB
  - Optional (env flag): a button that executes docker restarts only when `ENABLE_ADMIN_DOCKER_CONTROLS=1` and the server host has Docker access

## Rollout Plan

1. Add repair cron behind an env flag; deploy disabled.
2. Add metrics/logging; test on a staging dataset (simulate `articles` lag).
3. Enable repair cron; verify the derived-health card converges to near-zero enrichment gaps.
4. Add Postgres fallback; verify judging continues when CH is down or `articles` is lagging.
5. Consider optional recovery actions for PeerDB (env flag).

## Testing / Verification

- Unit-level: validate derived versioning scheme and cursor advancement logic.
- Integration-level (local):
  - pause PeerDB `articles` replication, create judgments, resume replication
  - observe enrichment gaps appear, then repair cron removes them
- Load-level: ensure repair batches don’t overwhelm ClickHouse.
