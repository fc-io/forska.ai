# OLTP Plan

## Goal

- [ ] Move only the hot judgment queue path (`ready -> sent -> judged`) off live DuckDB.
- [ ] Keep final analytics, marts, and review-serving queries in DuckDB.
- [ ] Use `job_id` as the write-ownership boundary: one active owner per job, with phase 1 focused on exclusivity rather than distributed scheduling.
- [ ] Make final judgments durable on local disk before DuckDB import.
- [ ] Store the successful parsed judgment response in SQLite first, then batch-materialize it into DuckDB `app.judgment`.
- [ ] Prevent duplicate sends for the same `(job_id, article_id, prompt_id)`.

## Scope

- [ ] Phase 1 moves only the operational replacement for `app.judgment_job_prompt`.
- [ ] Phase 1 lease goal is exclusivity only: at most one server/process may own a given SQLite job at a time.
- [ ] Cross-server job distribution is explicitly out of scope for this phase; preventing split-brain on one job is enough for now.
- [ ] Keep `app.judgment_job`, project metadata, token usage, `llm_status`, and all `mart.*` tables in DuckDB for now.
- [ ] Keep current OLAP selection logic for finding new prompt/article pairs; only the hot queue state changes first.
- [ ] Represent retries as `sent -> ready`.
- [ ] Represent terminal skips as `judged` plus `terminal_kind = 'skipped'`, so the first state machine stays `ready|sent|judged` only.

## Why This Split

- [ ] Current contention is mostly the mutable queue path, not the final analytics path.
- [ ] `ready`/`sent` are transient operational states and already expire/requeue today.
- [ ] Final judgments are the durable fact; they can safely wait on disk until DuckDB is ready to ingest them.
- [ ] Per-job embedded state removes write contention across jobs without giving up an embedded architecture.

## Storage Layout

- [ ] Create one SQLite file per job under the OS app-data path, for example `.../oltp/judgmentsJobs/<jobId>.sqlite`.
- [ ] Keep one sidecar lease file per job, for example `.../oltp/judgmentsJobs/<jobId>.lease.json`.
- [ ] Open each job DB only from the process that holds that job lease.
- [ ] Configure job DBs with `WAL`, `busy_timeout`, and durable sync settings appropriate for final judgment persistence.
- [ ] Delete or archive the whole job DB only after its outbox is fully imported into DuckDB.

## SQLite Schema

### `job_info`

- [ ] Store immutable job config copied at job start: `job_id`, `project_id`, `model_id`, `model_name`, `model_provider`, `model_version`, `use_title`, `use_abstract`, `use_fulltext`, `use_fulltext_no_images`, `created_at`.
- [ ] Keep enough config locally so claim/send/judged flow does not need to query DuckDB for every prompt.

### `job_scan_state`

- [ ] Columns: `job_id PRIMARY KEY`, `cursor_last_date`, `cursor_last_article_id`, `scan_epoch`, `exhausted_at`, `last_project_refresh_ack_seq`, `updated_at`.
- [ ] The cursor tracks the last article scanned from DuckDB, not the last prompt successfully inserted into SQLite.
- [ ] `scan_epoch` increments only when a full pass wraps back to the start.
- [ ] `last_project_refresh_ack_seq` is the watermark proving DuckDB marts have incorporated exported judgments up through a given outbox sequence.

### `queue_prompt`

- [ ] Columns: `id`, `job_id`, `article_id`, `prompt_id`, `status`, `terminal_kind`, `skip_reason`, `server_id`, `claim_id`, `sent_at`, `judged_at`, `created_at`, `updated_at`.
- [ ] Unique key: `(job_id, article_id, prompt_id)`.
- [ ] Index for claim path: `(status, created_at, article_id)`.
- [ ] Optional ordering columns can be cached locally later if the current fulltext-first ordering still matters.

### `judgment_outbox`

- [ ] Columns: `outbox_seq INTEGER PRIMARY KEY AUTOINCREMENT`, `job_id`, `queue_prompt_id`, `judgment_id`, all fields needed for final `app.judgment` insert, `raw_response_json`, `exported_at`, `export_attempts`, `last_error`, `created_at`.
- [ ] Store both the parsed successful response (`answer`, `answered_original_as_array`, `explanation`, `quotes`) and the fully materialized DuckDB judgment row here before marking the prompt fully complete.
- [ ] Include all current judgment columns needed by the `app.judgment` insert path: `article_id`, `prompt_id`, `model_id`, `project_id`, `snapshot_project_id`, `snapshot_project_model_name`, `use_title`, `use_abstract`, `use_fulltext`, `use_fulltext_no_images`, `chunking_strategy`, `is_answered`, `answered_original`, `answered_original_as_array`, `confidence_original`, `explanation`, `quotes`, `created_at`, `updated_at`.
- [ ] Keep a unique key on `judgment_id` and preserve the natural dedupe key used by DuckDB judgment inserts.

## Ownership And Leases

- [ ] A process must acquire the `job_id` lease before it can top up, claim, requeue, or finalize prompts for that job.
- [ ] For now, leases are same-host/local-disk only and exist to guarantee one owner per `job_id`, not to distribute jobs across many servers.
- [ ] Lease metadata should include `leaseId`, `hostname`, `pid`, `port`, `heartbeatAt`.
- [ ] Stale takeover is allowed only after heartbeat timeout plus owner health failure.
- [ ] Duplicate processing is prevented by a combination of one active job owner plus the SQLite unique key on `(job_id, article_id, prompt_id)`.
- [ ] Allowing different jobs to run on different writers can come later; it is not required for the first lease-enforcement cut.

## Write Path

### Job Start

- [ ] Keep job creation in DuckDB for now.
- [ ] When a new job starts, create its SQLite DB and write one `job_info` row.
- [ ] All newly created jobs use the SQLite queue path immediately; no feature flag.

### Queue Top-Up (`ready`)

- [ ] Keep current DuckDB/OLAP prompt selection for now.
- [ ] Treat DuckDB/OLAP candidate selection as advisory only; SQLite is the canonical dedupe gate.
- [ ] Fetch candidates in windows using the per-job scan cursor, not from the start of the project each time.
- [ ] Advance the scan cursor to the last DuckDB article scanned even if every candidate in that window was ignored as already present locally.
- [ ] Request an overscanned candidate window (for example `5x` the needed ready count, capped) so top-up still fills quickly when some candidates are already `ready`, `sent`, or `judged` in SQLite.
- [ ] Insert new `(article_id, prompt_id)` pairs into `queue_prompt` with `INSERT OR IGNORE` against the unique key `(job_id, article_id, prompt_id)`.
- [ ] Repeated top-up runs for the same job must be safe: if the pair is already `ready`, `sent`, or `judged` in the job DB, the insert is ignored.
- [ ] Continue scanning successive DuckDB windows until either the ready deficit is filled or the current scan pass is exhausted.
- [ ] Only wrap the cursor to the start after a full pass reaches exhaustion; do not restart from the top on every top-up cycle.
- [ ] When a wrap is needed, do it only after DuckDB visibility has caught up enough that previously exported judgments will no longer be returned as unassessed.
- [ ] Stop writing new `ready` rows into DuckDB for SQLite-backed jobs.

### Claim (`ready -> sent`)

- [ ] Claim rows inside one SQLite transaction.
- [ ] Select the next claimable `ready` rows for the job.
- [ ] Update them to `sent`, set `sent_at`, `server_id`, and a fresh `claim_id`, then return the claimed rows.
- [ ] Requeue abandoned `sent` rows by TTL in SQLite, not DuckDB.

### Finalize (`sent -> judged`)

- [ ] On successful LLM completion, persist the successful parsed response and the full materialized `app.judgment` row into `judgment_outbox`, then update `queue_prompt.status = 'judged'` in the same SQLite transaction.
- [ ] On retryable failure, move `sent -> ready` in SQLite.
- [ ] On terminal non-judgment outcomes, keep `queue_prompt.status = 'judged'` and set `terminal_kind = 'skipped'`.
- [ ] Do not wait for DuckDB import before acknowledging the prompt as durably judged in the job DB.

## DuckDB Import Strategy

- [ ] Use one dedicated DuckDB importer on the current DuckDB owner process.
- [ ] The importer scans job SQLite DBs for `judgment_outbox.exported_at IS NULL`.
- [ ] Flush in bounded batches: target `100` judgments or `4 MiB` of payload, whichever comes first, with a max wait of about `2s`, and always flush on job completion.
- [ ] Insert the batch into DuckDB `app.judgment` in one transaction using idempotent insert semantics (`ON CONFLICT DO NOTHING` or equivalent).
- [ ] Queue mart refresh work for affected `project_id` / `article_id` pairs after a successful DuckDB insert batch.
- [ ] Only after the DuckDB transaction succeeds, mark those outbox rows `exported_at` back in SQLite.
- [ ] After the corresponding mart refresh completes, acknowledge a per-job/project visibility watermark back to SQLite so old dedupe rows can be pruned without risking re-enqueue from stale DuckDB reads.
- [ ] If the importer crashes after DuckDB commit but before SQLite ack, replay the same batch safely via idempotent judgment inserts.

## Retention And Cleanup

- [ ] Keep `ready` and `sent` rows only while the job is active.
- [ ] Keep each `queue_prompt` row present through the full `ready -> sent -> judged` lifecycle so it continues to block duplicate re-enqueue while DuckDB is still missing that judgment.
- [ ] Keep `judged` rows and exported outbox rows until DuckDB import and mart visibility are both confirmed for their outbox sequence.
- [ ] After the visibility watermark passes a row, delete exported outbox rows and terminal `queue_prompt` rows in batches.
- [ ] After job completion and full outbox drain, delete or archive the whole job SQLite file.
- [ ] Keep legacy cleanup for DuckDB-backed jobs until all jobs are migrated.

## API Changes

- [ ] `GET /api/judgmentsjobs/:id` should read prompt status counts from the job SQLite DB when one exists, with DuckDB fallback for legacy jobs.
- [ ] Job pause/delete should clear the SQLite job DB for SQLite-backed jobs after export is drained or after explicit discard logic.
- [ ] Existing analytics and review endpoints continue to read DuckDB only.
- [ ] DuckDB no longer needs to serve as the live source of truth for `ready`/`sent` counts on SQLite-backed jobs.

## Migration Path

- [ ] Switch all newly created jobs to the SQLite queue path immediately.
- [ ] Leave already-running legacy jobs on the current DuckDB queue path until they finish.
- [ ] Remove DuckDB writes for `app.judgment_job_prompt` on SQLite-backed jobs as part of the first cutover.
- [ ] Revisit moving cursor state out of DuckDB only if its writes remain noisy after the hot queue path is gone.

## Tests

- [ ] No duplicate claim for the same `(job_id, article_id, prompt_id)` under two competing writers.
- [ ] Stale `sent` rows requeue correctly after lease loss / timeout.
- [ ] Successful judgment is durable in SQLite before DuckDB import.
- [ ] Import replay after crash does not duplicate DuckDB judgments.
- [ ] Imported judgments trigger the expected mart refresh path.
- [ ] Job DB is deleted only after the outbox is drained.
- [ ] Legacy DuckDB-backed jobs remain readable during rollout.

## Done When

- [ ] `ready -> sent -> judged` no longer writes through the live DuckDB queue path for newly created jobs.
- [ ] Different jobs can be processed by different writers concurrently using embedded storage.
- [ ] Final judgments survive writer crashes before DuckDB ingestion.
- [ ] DuckDB receives judgments in bounded idempotent batches instead of one write per prompt.
- [ ] Job status APIs remain accurate during the SQLite-to-DuckDB lag window.

## Keep In Reserve

- [ ] If SQLite still proves too constraining, the next embedded fallback is the same per-job ownership model with append-only segment files plus a DuckDB importer, but SQLite is the first attempt because it gives claims, uniques, and recovery with much less custom machinery.
