# Data Source Continuous Tracking Plan

Date: 2026-09-14

## Goal

Let supported data sources opt into continuous downloads so a source such as
"this year" keeps importing newly available articles without manual reimport.

Continuous tracking has two work types:

- incremental catch-up as soon as the provider exposes a new complete window
- scheduled age-bucket reconciliation, run monthly for records that have reached
  roughly 3, 12, 24, and 36 months old, so older provider records that changed
  or disappeared are detected without rescanning the full data range every month
- manual full-range reconciliation on demand when an operator explicitly wants
  to re-run from the start of the configured data range

The first implementation supports:

- `/api/datasources/import/europe-pmc-ppr`
- `/api/datasources/import/pubmed`

The current PubMed route is implemented through Europe PMC `SRC:MED`, so both
initial providers are day-granular through `FIRST_PDATE:[from TO to]`. The
design should still model source granularity explicitly so later APIs can poll
hourly, minutely, or by source cursor when the provider allows it.

Tracking is optional per data source and configurable from the individual
new/edit Data Source pages.

Tracked sources must also expose a deleted/changed article log from the data
source detail page. Source-deleted articles should keep their historical
`app.article` row, but no longer participate in the normal selected-import /
review workflow for that data source.

## Current Findings

- `app.data_source` stores `date_from`, `date_to`, `import_route`,
  `last_import_at`, `items_after_last_import`, and an overloaded `cursor`.
- The PubMed and Europe PMC PPR route handlers load a data source, derive
  `fromDate` and `toDate`, call the harvester, count linked articles for the
  route/date range, update `last_import_at`, then clear `cursor`.
- During a manual import, `createCursorUpdater(record.id)` persists the current
  Europe PMC page cursor in `data_source.cursor`. That helps manual retries, but
  it is not enough for continuous tracking because `cursor` is also used as
  durable import configuration for structured-file and Covidence sources.
- `storeImportedArticles` already performs canonical/idempotent storage and
  emits review-serving deltas. The tracking worker must reuse this path instead
  of adding a parallel article write path.
- Server roles already distinguish mutating maintenance loops through
  `shouldCurrentServerRunMaintenanceLoops()`. Tracking work should run only in
  that maintenance-capable role.
- The existing Europe PMC fetch retry loops can sleep for long periods inside a
  single import. For continuous tracking, retry/backoff should be owned by
  durable worker state and Effect schedules, not by a stuck in-memory request.
- The DuckDB owner is shared with foreground UI/API and review-serving work.
  Continuous tracking must not persist every provider page through DuckDB or
  hold a DuckDB transaction while fetching provider pages. Provider fetch
  progress needs a lightweight durable spool, then bounded background DuckDB
  ingest.
- `app.article_import_route_source_record` already records
  `source_record_key`, `source_record_hash`, `raw_payload`, quarantine fields,
  and route/article linkage. This is the right foundation for detecting source
  changes during scheduled or manual reconciliation.
- `storeImportedArticles` appends/upserts records but does not remove route
  links that are missing from the new provider response. The existing
  `syncImportedArticlesWithTx` path can compare accepted source records against
  existing route records and emit tombstone deltas for stale records, but the
  tracking plan should preserve user-visible deletion/change evidence instead
  of making stale source records silently disappear.

## Non-Goals

- Do not add tracking for arXiv, bioRxiv, medRxiv, FHIR, structured files, or
  Covidence in the first slice.
- Do not replace canonical article matching or review-serving invalidation.
- Do not store tracking state in `data_source.cursor`.
- Do not run tracking from API-only or judge-worker roles.
- Do not make DuckDB the per-page scratchpad for continuous provider downloads.
  DuckDB remains the canonical committed store, but provider fetch progress
  should land in the SQLite spool first.
- Do not make hidden retries look like success. Failed windows should preserve
  the last error, failure count, and next retry time.
- Do not physically delete `app.article` rows when a provider stops returning a
  record. Remove or tombstone the data-source membership while keeping the
  historical article and audit evidence.

## Data Model

Add a DuckDB migration, tentatively
`src/db/duckdbMigrations/0234_dataSourceContinuousTracking.sql`.

### `app.data_source`

Add stable user-facing configuration:

- `tracking_enabled BOOLEAN NOT NULL DEFAULT FALSE`
- `tracking_reconcile_schedule_months JSON NOT NULL DEFAULT '[3,12,24,36]'`

Keep existing `date_from` and `date_to` as the tracked range boundaries.
Existing data sources remain untracked after migration.

### `app.data_source_tracking_state`

Add one row per tracked data source:

- `data_source_id VARCHAR PRIMARY KEY REFERENCES app.data_source(id)`
- `route VARCHAR NOT NULL`
- `granularity VARCHAR NOT NULL`
- `high_water_completed_at TIMESTAMPTZ`
- `active_window_start TIMESTAMPTZ`
- `active_window_end TIMESTAMPTZ`
- `active_cursor VARCHAR`
- `last_attempt_at TIMESTAMPTZ`
- `last_success_at TIMESTAMPTZ`
- `next_run_after TIMESTAMPTZ`
- `last_reconciliation_scheduler_at TIMESTAMPTZ`
- `last_reconciliation_completed_at TIMESTAMPTZ`
- `failure_count INTEGER NOT NULL DEFAULT 0`
- `last_error VARCHAR`
- `active_run_kind VARCHAR`
- `active_reconciliation_age_months INTEGER`
- `lease_owner VARCHAR`
- `lease_expires_at TIMESTAMPTZ`
- `last_import_run_id VARCHAR`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp`

Rules:

- `high_water_completed_at` advances only after a whole tracking window
  completes successfully.
- `active_window_*` survives process death and is cleared only when the active
  window is committed into DuckDB. `active_cursor` may mirror coarse progress
  for diagnostics/API responses, but page-level cursor resume state lives in the
  SQLite tracking spool and is the restart authority.
- Stale leases are recoverable after `lease_expires_at`.
- Archiving or disabling a data source leaves state for diagnostics but makes it
  ineligible for new claims.
- `active_run_kind` distinguishes `incremental` and `reconciliation` so a
  server restart resumes the correct semantics.
- `last_reconciliation_scheduler_at` records the last monthly scheduling pass.
  The scheduler uses it to create missing age-bucket work items after downtime.
- `active_reconciliation_age_months` is null for manual full-range
  reconciliation and one of the configured schedule months for automatic
  age-bucket reconciliation.

### SQLite data source tracking spool

Add a profile-local SQLite database for provider fetch progress, for example
`data-source-tracking-spool.sqlite` under the runtime profile directory. The
spool is not the canonical article store; it is a durable landing zone between
provider network fetches and bounded DuckDB ingest.

Initial tables:

- `tracking_spool_window`
  - `id TEXT PRIMARY KEY`
  - `data_source_id TEXT NOT NULL`
  - `route TEXT NOT NULL`
  - `run_kind TEXT NOT NULL`
  - `window_start TEXT NOT NULL`
  - `window_end TEXT NOT NULL`
  - `status TEXT NOT NULL`
  - `cursor TEXT`
  - `failure_count INTEGER NOT NULL DEFAULT 0`
  - `last_error TEXT`
  - `lease_owner TEXT`
  - `lease_expires_at TEXT`
  - `spooled_at TEXT`
  - `duckdb_ingested_at TEXT`
  - `created_at TEXT NOT NULL`
  - `updated_at TEXT NOT NULL`
- `tracking_spool_page`
  - `id TEXT PRIMARY KEY`
  - `window_id TEXT NOT NULL REFERENCES tracking_spool_window(id)`
  - `page_index INTEGER NOT NULL`
  - `cursor_before TEXT`
  - `cursor_after TEXT`
  - `source_record_count INTEGER NOT NULL`
  - `source_record_hash TEXT NOT NULL`
  - `raw_payload_json TEXT NOT NULL`
  - `normalized_records_json TEXT NOT NULL`
  - `fetched_at TEXT NOT NULL`
  - `duckdb_ingested_at TEXT`

Rules:

- Provider fetches write each page and its next cursor to SQLite in a short
  SQLite transaction. They must not hold a DuckDB transaction and should not
  touch the DuckDB owner per page.
- A window moves to a ready/spooled status only after every provider page for
  that window has landed in SQLite.
- DuckDB ingest claims ready SQLite windows, reads spooled pages, and writes to
  DuckDB in bounded background-priority batches through the shared canonical
  article path.
- `high_water_completed_at` advances only after the full window has been
  committed to DuckDB, linked article counts are updated, and review-serving
  deltas have been emitted.
- SQLite spool rows remain until the corresponding DuckDB ingest is durable and
  cleanup-safe. Cleanup should be bounded and keep recent failure evidence.
- Fetching should apply backpressure when too many windows/pages are spooled but
  not yet ingested, so the provider downloader cannot outrun DuckDB indefinitely.

### `app.data_source_reconciliation_work`

Add a durable queue for reconciliation chunks:

- `id VARCHAR PRIMARY KEY`
- `data_source_id VARCHAR NOT NULL REFERENCES app.data_source(id)`
- `route VARCHAR NOT NULL`
- `run_kind VARCHAR NOT NULL`
- `age_months INTEGER`
- `period_start TIMESTAMPTZ NOT NULL`
- `period_end TIMESTAMPTZ NOT NULL`
- `spool_window_id VARCHAR`
- `cursor VARCHAR`
- `status VARCHAR NOT NULL`
- `failure_count INTEGER NOT NULL DEFAULT 0`
- `last_error VARCHAR`
- `lease_owner VARCHAR`
- `lease_expires_at TIMESTAMPTZ`
- `import_run_id VARCHAR`
- `scheduled_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp`
- `started_at TIMESTAMPTZ`
- `completed_at TIMESTAMPTZ`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp`

Rules:

- `run_kind` is `automatic_age_bucket` or `manual_full_range`.
- `age_months` is one of `3`, `12`, `24`, or `36` for automatic work and null
  for manual full-range work.
- The automatic monthly scheduler creates one work item per due age bucket and
  target source-date month, constrained by `date_from` and `date_to`.
- Example: on a September scheduler pass, a 3-month work item rechecks the June
  source-date window, a 12-month item rechecks the previous September window, a
  24-month item rechecks the September window two years back, and a 36-month
  item rechecks the September window three years back.
- Work items are idempotent by
  `(data_source_id, run_kind, age_months, period_start, period_end)` so
  scheduler retries do not duplicate them.
- Work item status, failures, leases, and `spool_window_id` make each bucket
  restartable and timeout-safe. Page-level cursor state lives in the SQLite
  spool; `cursor` is retained only as an optional coarse diagnostics mirror.

### `app.data_source_article_change_log`

Add an operator/user-visible audit table for tracked provider changes:

- `id VARCHAR PRIMARY KEY`
- `data_source_id VARCHAR NOT NULL REFERENCES app.data_source(id)`
- `route VARCHAR NOT NULL`
- `import_route_id VARCHAR`
- `article_id VARCHAR`
- `external_article_id VARCHAR`
- `source_record_key VARCHAR`
- `change_kind VARCHAR NOT NULL`
- `previous_source_record_hash VARCHAR`
- `next_source_record_hash VARCHAR`
- `changed_fields JSON`
- `previous_snapshot JSON`
- `next_snapshot JSON`
- `import_run_id VARCHAR`
- `run_kind VARCHAR NOT NULL`
- `detected_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp`

Initial `change_kind` values:

- `article_added`
- `source_record_changed`
- `canonical_article_changed`
- `source_record_deleted`
- `source_record_restored`

Rules:

- Reconciliation work writes log rows for changed hashes and missing source
  records before mutating the current membership state.
- Incremental runs may write `article_added`, `source_record_changed`, and
  `canonical_article_changed`, but only reconciliation work is allowed to mark
  records as `source_record_deleted`.
- Log rows should be deduplicated by source identity, previous hash, next hash,
  and run kind so a retry does not spam the log.
- The log must retain enough old/new summary data for the UI to show what
  changed without requiring the stale source record to remain active.

## Provider Contract

Create a source-specific tracking adapter layer, for example under
`src/server/services/dataSourceTracking/`.

Shape:

```ts
type DataSourceTrackingGranularity = 'day' | 'hour' | 'minute' | 'cursor'

type DataSourceTrackingProvider = {
  getGranularity: () => DataSourceTrackingGranularity
  getNextWindow: (input: {
    dataSource: DataSourceRecord
    state: DataSourceTrackingState | null
    now: Date
  }) => TrackingWindow | null
  getReconciliationRange: (input: {
    ageMonths: number | null
    dataSource: DataSourceRecord
    mode: 'automaticAgeBucket' | 'manualFullRange'
    now: Date
    periodEnd?: Date
    periodStart?: Date
  }) => TrackingRange | null
  runWindow: (input: TrackingWindowRunInput) => Effect.Effect<TrackingWindowRunResult, TrackingError, TrackingDeps>
  runRange: (input: TrackingRangeRunInput) => Effect.Effect<TrackingRangeRunResult, TrackingError, TrackingDeps>
  route: string
}
```

Initial adapters:

- Europe PMC PPR: route `/api/datasources/import/europe-pmc-ppr`,
  granularity `day`, query `SRC:PPR AND FIRST_PDATE:[from TO to]`.
- PubMed route: route `/api/datasources/import/pubmed`, granularity `day`,
  query `SRC:MED AND FIRST_PDATE:[from TO to]`.

Window rules:

- Use UTC date boundaries for day-granular sources.
- If `date_from` is missing, use the current route default start date only for
  existing manual behavior; tracked sources should require or set a real
  `date_from` when enabling tracking.
- If `date_to` is null, the source is open-ended and tracks through the latest
  fully closed provider window.
- If `date_to` is in the future, track up to the latest fully closed provider
  window until reaching `date_to`.
- If `date_to` is in the past and `high_water_completed_at >= date_to`, the
  source is complete and no longer claimed.
- For day-granular Europe PMC routes, schedule work after a UTC day closes.
  Later providers can return shorter windows or a cursor-based continuation.
- Initial catch-up may process bounded multi-day chunks, but the state still
  records progress by completed windows and never advances past a failed or
  interrupted active window.
- Automatic reconciliation uses monthly age buckets. Each scheduler pass checks
  the configured schedule months, default `[3, 12, 24, 36]`, and re-runs only
  the source-date window that just reached that age.
- The monthly window is interpreted in UTC for day-granular Europe PMC routes:
  `[first day of target month, first day of following month)`, clipped to the
  data source's `date_from` / `date_to`.
- Records older than the last configured bucket are not automatically rescanned
  unless another bucket is configured later or a manual reconciliation is
  triggered.
- Manual reconciliation uses the full configured data range. For open-ended
  sources, "full range" means `date_from` through the latest fully closed
  provider window, bounded into resumable chunks.
- Manual and automatic reconciliation both use provider `runRange` and durable
  `app.data_source_reconciliation_work` state. Neither should call a separate
  ad hoc route that lacks cursor, timeout, or restart recovery.

## Effect-Based Runtime Design

Use the `effect` package for new non-trivial async flow:

- `DataSourceTrackingRepository`: DuckDB reads/writes, due-source selection,
  lease claim/release, state transition, and metrics. Expose it as an Effect
  `Context` service.
- `DataSourceTrackingSpoolRepository`: SQLite reads/writes for fetch windows,
  page payloads, cursor resume state, ingest claims, cleanup, and spool
  backpressure. Expose it as an Effect `Context` service.
- `DataSourceReconciliationWorkRepository`: schedules, claims, resumes, and
  completes monthly age-bucket and manual full-range reconciliation work items.
- `DataSourceTrackingProviderRegistry`: supported route lookup and provider
  metadata. Expose it as a `Layer`.
- `DataSourceTrackingWorker`: an Effect service that claims due sources, spools
  one bounded incremental window or reconciliation work chunk per claim, drains
  bounded ready SQLite windows into DuckDB, and records success/failure.
- `DataSourceArticleChangeLogRepository`: an Effect `Context` service for
  writing and reading deleted/changed article log entries.
- `Effect.gen`: main service flow, provider fetch spooling, and DuckDB ingest
  orchestration.
- `Schedule`: provider fetch retry, lease retry, and failure backoff.
- `Effect.timeout`: network calls and page fetches.
- `Effect.acquireRelease` or scoped finalizers: lease heartbeat/release and
  worker shutdown cleanup.
- `Layer` and `Context`: dependency injection for repository, provider
  registry, clock, fetch implementation, and logging.

The Elysia cron should stay thin: it should check
`shouldCurrentServerRunMaintenanceLoops()`, then run the Effect worker wake.

## Import Flow

Refactor the PubMed and Europe PMC PPR import code into reusable functions:

1. Resolve data source and route.
2. Claim a data-source import lease shared by manual and tracking imports.
3. Create or resume a SQLite spool window for the exact source-date window.
4. Fetch provider pages outside DuckDB. After each successful page, write the
   page payload, normalized records, `cursor_before`, and `cursor_after` to the
   SQLite spool in a short SQLite transaction.
5. Mark the SQLite window ready only after all pages for that source-date window
   are spooled. Do not advance DuckDB high water at this point.
6. Drain ready SQLite windows into DuckDB in bounded background-priority
   transactions through `storeImportedArticles`.
7. On DuckDB ingest success, update total linked article count and
   `last_import_at`, mark the spool window ingested/cleanup-eligible, clear the
   active window, advance `high_water_completed_at`, set `last_success_at`,
   reset failure count, and compute `next_run_after`.
8. On fetch failure, preserve the SQLite window/page cursor state, store
   `last_error`, increment `failure_count`, and compute a durable retry time.
9. On DuckDB ingest failure, preserve the ready SQLite window for idempotent
   re-ingest and use the same durable failure/backoff fields.

Incremental imports should keep append/upsert semantics through
`storeImportedArticles`.

Reconciliation should use a reconciliation-specific service around
`syncImportedArticlesWithTx` semantics:

1. Fetch every source record for the reconciliation work item's period, in
   bounded windows.
2. Store current records through the same canonical article path.
3. Compare incoming `source_record_key` / `source_record_hash` values with the
   existing records for the route and period.
4. Log `source_record_changed` rows when the source hash changes, even if the
   canonical fields do not change.
5. Log `canonical_article_changed` rows when canonical fields such as title,
   abstract, authors, DOI, PMID, URL, or publication status change.
6. For records missing from the provider response, remove the active
   data-source membership and mark/preserve the source record as
   `quarantine_reason = 'source_record_deleted'` or an equivalent tombstone.
   The `app.article` row remains.
7. Emit the existing review-serving tombstone deltas so selected-import,
   posting, search, summary, and queue surfaces stop treating source-deleted
   records as active for that data source.

Manual route behavior should remain synchronous for the UI, but it should use
the same shared import service. If tracking owns the lease, the manual route
should return a clear conflict error rather than run a duplicate import.

## Reconciliation And Change Detection

Automatic monthly age-bucket reconciliation:

- Once per month, the scheduler reads tracked data sources and their configured
  `tracking_reconcile_schedule_months`, default `[3, 12, 24, 36]`.
- For each age bucket, it computes the source-date month that reached that age
  during the current scheduler month.
- The scheduler inserts a reconciliation work item for that bucket/month if it
  intersects the data source's configured range and is not already queued,
  running, or completed.
- The worker claims due work items and processes each one through provider
  `runRange`, with page cursor state persisted in SQLite and lease, failure,
  completion, and `spool_window_id` state persisted on the work item.
- On success, mark the work item completed and update
  `last_reconciliation_completed_at`.
- On failure or timeout, preserve the work item period plus SQLite spool cursor
  state and schedule durable retry with the same Effect `Schedule`/backoff
  contract as incremental work.
- This makes automatic reconciliation cheap and predictable for long-lived data
  sources: it rechecks likely-change windows without re-downloading the whole
  historical range every month.

Manual reconciliation trigger:

- Add an owner-routed endpoint such as
  `POST /api/datasources/:id/tracking/reconcile`.
- The route validates that tracking is supported for the data source route,
  creates a `manual_full_range` reconciliation work item covering the configured
  data range, and returns the updated tracking state.
- If another import/reconciliation lease is active, return the current active
  state rather than starting a second run.

Change/deletion semantics:

- A source record missing from a full reconciliation is a source deletion for
  that data source, not an article deletion globally.
- A source record missing from an automatic age-bucket reconciliation is a
  source deletion for that data source within that source-date period.
- Source-deleted records no longer appear in normal selected-import/review
  workflows because the active import-route membership is removed or the source
  record is tombstoned/quarantined.
- The old `app.article` remains visible through the data source's deleted/changed
  log and can still exist through other import routes.
- If a later reconciliation sees the same `source_record_key` again, log
  `source_record_restored`, clear the source-deleted tombstone, and re-activate
  the membership.
- Article/source updates should preserve previous and next hashes plus a compact
  field-level summary. Raw payload snapshots can be stored in the log only when
  bounded enough for the UI and diagnostics; otherwise store source hashes and
  selected display fields.

## Recovery Contracts

Server restart:

- On startup, the worker reads persisted state. No in-memory queue is required
  for correctness.
- Active windows with expired leases are claimable and resume from
  the SQLite spool cursor/page manifest.
- Active reconciliation work items resume the same way as incremental imports and
  must not restart from the beginning unless the persisted work item period or
  SQLite spool cursor manifest is invalid.
- If the server stops while fetching, the next wake resumes from the last page
  durably spooled in SQLite.
- If the server stops after spooling a page but before DuckDB ingest, the page is
  ingested later.
- If the server stops during DuckDB ingest, the SQLite window remains ready and
  is retried idempotently through `storeImportedArticles`.
- If the server stops after DuckDB commit but before spool cleanup, duplicate
  ingest must see existing records and cleanup catches up later.
- If the server stops after storing a page payload but before persisting the next
  cursor in SQLite, rerunning that page is safe because the DuckDB ingest path is
  idempotent.
- If the server stops after advancing a cursor but before storing the page
  payload, the implementation can lose data. The fetch path must therefore store
  page payload plus next cursor atomically in SQLite and only use that stored
  cursor for resume.

Lost connections/timeouts:

- Each provider fetch uses `Effect.timeout`.
- Transient HTTP/network failures use `Schedule` with capped retries inside the
  current wake.
- After capped retries, the window fails durably and `next_run_after` carries
  the backoff. The worker should not sleep for hours inside one cron wake.
- Reconciliation failures use the same durable failure path and do not advance
  work-item completion state until the claimed period completes.
- HTTP 429 or source rate-limit responses should set a provider-aware
  `next_run_after` when the response gives a retry time.
- DuckDB owner pressure should slow or pause DuckDB ingest, not provider fetch
  correctness. The SQLite spool applies backpressure when pending ingest exceeds
  a configured cap, so the downloader cannot fill disk while DuckDB is busy.

Role changes and duplicate servers:

- Claims require a non-expired lease.
- The worker checks `shouldCurrentServerRunMaintenanceLoops()` before claiming
  and between windows.
- DuckDB owner demotion should interrupt active fibers through Effect scope; the
  durable state remains resumable after lease expiry.

Tracking toggles:

- Disabling tracking prevents new claims immediately.
- An in-flight page may finish, but the worker should stop before starting the
  next page/window once the disabled state is observed.
- Re-enabling tracking resumes from persisted high water or the active window if
  one was left behind.

## API And UI

Server routes:

- Extend `GET /api/datasources`, `GET /api/datasources/:id`,
  `POST /api/datasources`, and `PATCH /api/datasources/:id` with
  `trackingEnabled` plus a compact `trackingState` response.
- Add `POST /api/datasources/:id/tracking/reconcile` for manual full-range
  reconciliation.
- Add `GET /api/datasources/:id/tracking/changes` for paginated deleted/changed
  article log entries.
- Include automatic age-bucket reconciliation status in `trackingState`: pending
  work count, last completed reconciliation, active work item, and configured
  schedule months.
- Validate that tracking can only be enabled for supported routes in the first
  slice.
- Reject tracking enablement when the source has no usable start boundary.
- Keep no-auth single-user behavior.

Client:

- Add a tracking option to `/admin/datasources/create`.
- Add a tracking option and status display to `/admin/datasources/$id/edit`.
- Add a "Run full reconciliation" action on the edit page for tracked supported
  sources.
- Add a linked subpage from the edit page, for example
  `/admin/datasources/$id/changes`, showing deleted and changed articles with
  filters by change kind and run kind.
- The option should appear only for supported built-in routes, or be disabled
  with a precise unsupported-route state.
- Show status fields that matter operationally: enabled, granularity, last
  success, next run, last reconciliation, pending reconciliation count, active
  reconciliation bucket/range, last error, and active window.
- Deleted article rows should be visibly marked as deleted from the data source,
  while still linking to the preserved article identity where available.
- Preserve browser and desktop app flows because this is shared UI and API
  surface.

## Implementation Steps

1. Add schema and typed state.
   - Add the migration and update `schemaTypes.ts`.
   - Add repository functions for create/update state, due-source selection,
     monthly age-bucket scheduling, reconciliation work claiming, lease
     claim/release, success, failure, and disable handling.
   - Add the article change log repository and response types.
   - Add migration tests and repository unit tests.
   - Add the SQLite tracking spool schema and repository tests for window/page
     claim, cursor resume, ingest claim, cleanup, and backpressure.

2. Extract shared import execution for PubMed and Europe PMC PPR.
   - Factor current route logic into route-neutral functions that accept
     `fromDate`, `toDate`, `cursor`, and page persistence callbacks.
   - Add a tracked path that writes provider pages to SQLite spool first, then
     lets DuckDB ingest drain ready spool windows.
   - Convert long retry/sleep loops in the tracked path to Effect
     `Schedule`/`timeout`.
   - Keep manual imports working through the existing route URLs.

3. Add the SQLite spool drainer and DuckDB ingester.
   - Claim ready SQLite windows with a lease and drain them into DuckDB in
     bounded background-priority transactions.
   - Commit spooled records through `storeImportedArticles` and emit the normal
     review-serving deltas.
   - Advance `high_water_completed_at` only after the DuckDB commit path
     completes for the full window.
   - Add spool cleanup that preserves recent failure evidence and never deletes
     a window before committed high water covers it.

4. Add tracking provider adapters.
   - Implement day-granular Europe PMC PPR and PubMed route adapters.
   - Add tests for window selection, open-ended tracking, future `date_to`,
     finite completed ranges, and active-window resume.
   - Add tests for manual full-range reconciliation chunking and monthly
     `[3, 12, 24, 36]` age-bucket scheduling.

5. Add the maintenance worker.
   - Mount a lightweight cron with the same role checks used by other
     maintenance loops.
   - Claim a bounded number of due tracked sources per wake.
   - Run one bounded incremental fetch/spool window or reconciliation work chunk
     per claimed source.
   - Drain a bounded number of ready SQLite spool windows per wake without
     blocking foreground DuckDB work.
   - Record durable success/failure state through Effect finalizers.

6. Add reconciliation and change detection.
   - Compare reconciliation-period source records by `source_record_key` and
     `source_record_hash`.
   - Log source/canonical changes before mutating current membership.
   - Tombstone source-deleted records without deleting `app.article`.
   - Emit review-serving deltas that remove source-deleted records from normal
     selected-import/review surfaces.
   - Add manual reconciliation trigger route.

7. Wire API create/edit/change-log routes.
   - Extend route validation and normalized response shape.
   - Preserve immutable structured-file and Covidence rules.
   - Add route tests for supported and unsupported tracking enablement, manual
     reconciliation trigger, and paginated change-log reads.

8. Wire the Data Source UI.
   - Add tracking controls on create/edit.
   - Show tracking status on edit.
   - Add the manual reconciliation action.
   - Add the deleted/changed article log subpage.
   - Keep query invalidation/refetch behavior explicit so status updates do not
     overwrite unsaved form fields.

9. Add operator visibility.
   - Log tracking successes/failures with data source id, route, window, cursor
     state, run kind, reconciliation age bucket/range, spool backlog, DuckDB
     ingest status, and run id.
   - Include a focused diagnostic helper if route tests are not enough to
     inspect stuck tracked sources.

10. Update `TESTS.md`.
   - Add the new focused data-source tracking verification command if it is not
     already covered by an existing entry.

## Quality Gates

Focused implementation gates:

```bash
bun test src/db/migrateDuckdb.test.ts src/server/routes/DataSourcesRoutes.test.ts
bun test src/server/services/dataSourceTrackingRepository.test.ts src/server/services/dataSourceTrackingSpoolRepository.test.ts src/server/services/dataSourceTrackingScheduler.test.ts src/server/services/dataSourceTrackedImportService.test.ts src/server/services/dataSourceTrackingSpoolIngester.test.ts src/server/services/dataSourceArticleChangeLogRepository.test.ts
bun test src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostPubmed.test.ts src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostEuropePmcPpr.test.ts
bun test src/server/reviewServing/importAndMetadataFanoutGuard.test.ts
bunx vitest run 'src/app/routes/+admin/+datasources/-trackingOptions.vitest.tsx' 'src/app/routes/+admin/+datasources/+$id/+changes.vitest.tsx'
bun run db:mig
bun run lint
bun run build
```

Runtime smoke before PR/merge:

- Start `bun run dev:server` and `bun run dev:app`.
- In the browser, create a supported data source with tracking disabled and
  confirm manual behavior is unchanged.
- Enable tracking for a supported route and confirm the API returns tracking
  state without a full-page reload.
- Use a test/stubbed provider or a very narrow live window to prove one tracking
  wake advances `last_success_at`, `high_water_completed_at`, and
  `items_after_last_import`.
- Prove provider fetches first create SQLite spool windows/pages without holding
  a DuckDB transaction, then a separate background DuckDB ingest advances
  committed high water.
- Fill the SQLite spool above its configured backlog cap and confirm fetch
  claims pause/back off instead of filling disk while DuckDB is busy.
- Trigger a manual full reconciliation and confirm the API records a
  reconciliation run instead of an incremental run.
- Simulate a monthly scheduler pass and confirm it creates bounded
  reconciliation work for 3-, 12-, 24-, and 36-month source-date windows rather
  than a full-range automatic work item.
- Simulate a previous source record disappearing during reconciliation and
  confirm the article remains stored, the source membership is inactive, and the
  change log shows a deleted-from-source entry.
- Simulate a previous source record changing and confirm the log shows old/new
  hash or field summary and review-serving deltas are emitted when canonical
  fields changed.
- Restart the server during an active tracked import and prove the next wake
  resumes the active window without duplicate article links.
- Restart after SQLite spooling but before DuckDB ingest and prove the ingester
  drains the existing spool without refetching provider pages.
- Restart after DuckDB commit but before SQLite spool cleanup and prove re-ingest
  is idempotent and cleanup catches up later.
- Force a fetch timeout/failure and prove `last_error`, `failure_count`, and
  `next_run_after` are persisted while the cursor/window remain resumable.

Live current-DB gate if the final implementation changes worker scheduling or
review-serving import invalidation behavior:

- Check API and maintenance/DuckDB-owner readiness at the intended memory cap.
- Capture due tracked-source counts and the selected test source's tracking
  state before and after a short interval.
- Confirm the source-specific progress signal moves: high water, last success,
  completed window, or linked article count.
- If imported articles affect a project route, confirm review-serving
  selected-import/progress counters move or report a truthful no-eligible-work
  reason.
