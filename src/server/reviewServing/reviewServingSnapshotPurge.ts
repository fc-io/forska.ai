import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {getReviewServingClosedRebuildRequestLastErrorSql} from './reviewServingSupersededRebuildChunk.ts'

// Failed and retired review-serving snapshots keep every serving row they were built with. Nothing reads them once
// nothing resolves them any more: the reader follows the active snapshot, its last known good snapshot and the latest
// retired snapshot of the same review config, a promotion hands a candidate's last known good snapshot to the reader,
// bootstrap rebuilds clone from what the reader resolves, and pins, search and bulk jobs (a completed pinned export
// included) and open rebuild requests (through their chunks or a requestless bootstrap identity) name their snapshot.
// This purge deletes everything else one snapshot at a time. Snapshot ids are deterministic and a rebuild can create
// the same id again as a new candidate, so the purge first moves the manifest to 'purging' and drops the snapshot's
// chunk manifests, component revisions and summary ledger in the same transaction (a re-created id must not inherit
// chunks that claim rows as built), then deletes serving rows table by table. Every row batch re-checks that the
// manifest is still 'purging' in its own transaction and stops once a rebuild re-created the id.

type ReviewServingSnapshotPurgeTransaction = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
}

export type ReviewServingSnapshotPurgeDatabase = ReviewServingSnapshotPurgeTransaction & {
  transaction: <T>(operation: (tx: ReviewServingSnapshotPurgeTransaction) => Promise<T>) => Promise<T>
}

type PurgeTableSpec = {rowsPerStatement: number; table: string}
type PurgeSnapshotStatus = 'failed' | 'purging' | 'retired'
type PurgeTarget = {projectId: string; snapshotId: string; snapshotStatus: PurgeSnapshotStatus}
type PurgeStopReason = 'budget' | 'complete' | 'rowBudget' | 'yield'

export type ReviewServingSnapshotPurgeOutcome = 'partial' | 'purged' | 'recreated' | 'skipped'

export type ReviewServingSnapshotPurgeSnapshotResult = {
  deletedRows: number
  outcome: ReviewServingSnapshotPurgeOutcome
  previousStatus: PurgeSnapshotStatus
  projectId: string
  snapshotId: string
}

export type ReviewServingSnapshotPurgeResult = {
  deletedRows: number
  elapsedMs: number
  snapshots: readonly ReviewServingSnapshotPurgeSnapshotResult[]
  stopReason: PurgeStopReason
}

export type PurgeReviewServingSnapshotsInput = {
  budgetMs?: number
  maxDeletedRows?: number
  maxSnapshots?: number
  nowMs?: () => number
  projectId?: string | null
  shouldYield?: () => boolean
}

type PurgeRun = {
  budgetMs: number
  deletedRows: number
  maxDeletedRows: number
  nowMs: () => number
  rowBatchCount: number
  shouldYield: () => boolean
  startedAtMs: number
}

type TablePurgeProgress = {deletedRows: number; state: 'done' | 'recreated' | PurgeStopReason}

export const reviewServingFailedSnapshotPurgeGraceSeconds = 60 * 60
export const reviewServingRetiredSnapshotPurgeGraceSeconds = 24 * 60 * 60
// A reader resolves its snapshot a moment before it reads rows, so a retired snapshot that just lost its last known
// good or latest-retired role waits until its scope has had no activation for this long.
export const reviewServingRetiredSnapshotScopeSettleSeconds = 60 * 60

const defaultPurgeBudgetMs = 5_000
const defaultPurgeMaxDeletedRows = 4_000_000
const defaultPurgeMaxSnapshots = 4

// A heap-table batch of a million rows deletes and commits in ~40 ms. The summary accumulators keep ART indexes and
// their commit updates them at ~6 µs per row, so they take smaller batches.
const heapTableRowsPerStatement = 1_000_000
const indexedTableRowsPerStatement = 25_000

export const reviewServingSnapshotPurgeBookkeepingTables = [
  'app.review_rebuild_chunk_manifest',
  'app.review_serving_component_revision',
  'mart.review_article_summary_bucket_v4',
  'mart.review_article_summary_bucket_partial_v4',
] as const

export const reviewServingSnapshotPurgeServingTables: readonly PurgeTableSpec[] = [
  {rowsPerStatement: heapTableRowsPerStatement, table: 'mart.review_title_search_serving_v4'},
  {rowsPerStatement: heapTableRowsPerStatement, table: 'mart.review_unassessed_queue_article_rank_serving_v4'},
  {rowsPerStatement: heapTableRowsPerStatement, table: 'mart.review_unassessed_queue_serving_v4'},
  {rowsPerStatement: heapTableRowsPerStatement, table: 'mart.review_article_serving_base_v4'},
  {rowsPerStatement: heapTableRowsPerStatement, table: 'mart.review_article_serving_list_mode_state_v4'},
  {rowsPerStatement: heapTableRowsPerStatement, table: 'mart.review_article_judgment_detail_serving_v4'},
  {rowsPerStatement: heapTableRowsPerStatement, table: 'mart.review_article_filter_posting_serving_v4'},
  {rowsPerStatement: heapTableRowsPerStatement, table: 'mart.review_article_count_serving_v4'},
  {rowsPerStatement: heapTableRowsPerStatement, table: 'mart.review_filtered_count_serving_v4'},
  {rowsPerStatement: heapTableRowsPerStatement, table: 'mart.review_filter_facet_serving_v4'},
  {rowsPerStatement: heapTableRowsPerStatement, table: 'mart.review_filter_option_serving_v4'},
  {rowsPerStatement: indexedTableRowsPerStatement, table: 'mart.review_article_summary_rebuild_accumulator_chunk_v4'},
  {rowsPerStatement: indexedTableRowsPerStatement, table: 'mart.review_article_summary_rebuild_accumulator_v4'},
]

const getPositiveLimit = (value: number | undefined, fallback: number) => {
  return value === undefined || !Number.isFinite(value) || value < 1 ? fallback : Math.trunc(value)
}

const getSnapshotKeyPredicateSql = (target: Pick<PurgeTarget, 'projectId' | 'snapshotId'>, alias?: string) => {
  const source = alias === undefined ? '' : `${alias}.`

  return `${source}project_id = ${getSqlLiteral(target.projectId)}
    AND ${source}snapshot_id = ${getSqlLiteral(target.snapshotId)}`
}

const getSecondsAgoSql = (seconds: number) => {
  return `current_timestamp - to_seconds(${getSqlLiteral(seconds)})`
}

// Requests that still run, wait for admission or can be readmitted (a failed request whose chunks may retry and that
// was not closed for good: readmission skips superseded and coalesced requests and ones with a terminal chunk). The
// list is uncorrelated so DuckDB builds it once instead of joining every chunk manifest with its request per snapshot.
const getOpenRebuildRequestIdsSql = () => {
  return `
    SELECT open_request.request_id
    FROM app.review_rebuild_request open_request
    WHERE open_request.status IN ('pending_admission', 'admitted', 'running', 'blocked_over_budget', 'quarantined')
      OR (
        open_request.status = 'failed'
        AND open_request.admission_state = 'admitted'
        AND NOT ${getReviewServingClosedRebuildRequestLastErrorSql('open_request')}
        AND NOT EXISTS (
          SELECT 1
          FROM app.review_rebuild_chunk_manifest terminal_chunk
          WHERE terminal_chunk.request_id = open_request.request_id
            AND terminal_chunk.status IN ('blocked_over_budget', 'quarantined')
        )
        AND EXISTS (
          SELECT 1
          FROM app.review_rebuild_chunk_manifest retryable_chunk
          WHERE retryable_chunk.request_id = open_request.request_id
            AND (
              retryable_chunk.status IN ('pending', 'running')
              OR (
                retryable_chunk.status = 'failed'
                AND COALESCE(retryable_chunk.retry_count, 0) < COALESCE(
                  GREATEST(
                    1,
                    TRY_CAST(json_extract_string(open_request.retry_policy_json, '$.maxAttempts') AS INTEGER)
                  ),
                  3
                )
              )
            )
        )
      )
  `
}

// The reader falls back to the latest retired snapshot of a review config (ordered by activated_at, then
// updated_at) whenever the active snapshot and its last known good one lack a component, so that snapshot stays.
const getLatestRetiredPredicateSql = (alias: string) => {
  return `(
    ${alias}.snapshot_status = 'retired'
    AND NOT EXISTS (
      SELECT 1
      FROM app.review_serving_snapshot_manifest newer_retired
      WHERE newer_retired.project_id = ${alias}.project_id
        AND newer_retired.review_config_hash IS NOT DISTINCT FROM ${alias}.review_config_hash
        AND newer_retired.snapshot_status = 'retired'
        AND newer_retired.snapshot_id <> ${alias}.snapshot_id
        AND (
          (
            newer_retired.activated_at IS NOT NULL
            AND (${alias}.activated_at IS NULL OR newer_retired.activated_at > ${alias}.activated_at)
          )
          OR (
            newer_retired.activated_at IS NOT DISTINCT FROM ${alias}.activated_at
            AND newer_retired.updated_at > ${alias}.updated_at
          )
        )
    )
  )`
}

const getPastGracePredicateSql = (alias: string) => {
  return `(
    (
      ${alias}.snapshot_status = 'failed'
      AND COALESCE(${alias}.failed_at, ${alias}.updated_at) <= ${getSecondsAgoSql(reviewServingFailedSnapshotPurgeGraceSeconds)}
    )
    OR (
      ${alias}.snapshot_status = 'retired'
      AND ${alias}.updated_at <= ${getSecondsAgoSql(reviewServingRetiredSnapshotPurgeGraceSeconds)}
      AND NOT EXISTS (
        SELECT 1
        FROM app.review_serving_snapshot_manifest recent_activation
        WHERE recent_activation.project_id = ${alias}.project_id
          AND recent_activation.review_config_hash IS NOT DISTINCT FROM ${alias}.review_config_hash
          AND recent_activation.activated_at > ${getSecondsAgoSql(reviewServingRetiredSnapshotScopeSettleSeconds)}
      )
    )
  )`
}

export const getReviewServingSnapshotPurgeEligiblePredicateSql = (alias: string) => {
  return `(
    ${alias}.snapshot_status IN ('failed', 'retired')
    AND ${getPastGracePredicateSql(alias)}
    AND NOT ${getLatestRetiredPredicateSql(alias)}
    AND NOT EXISTS (
      SELECT 1
      FROM app.review_serving_snapshot_manifest live_snapshot
      WHERE live_snapshot.project_id = ${alias}.project_id
        AND live_snapshot.snapshot_status IN ('active', 'candidate')
        AND live_snapshot.last_known_good_snapshot_id = ${alias}.snapshot_id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM app.review_serving_snapshot_pin pin
      WHERE pin.project_id = ${alias}.project_id
        AND pin.snapshot_id = ${alias}.snapshot_id
        AND pin.released_at IS NULL
        AND pin.expires_at > current_timestamp
    )
    AND NOT EXISTS (
      SELECT 1
      FROM app.review_search_job search_job
      WHERE search_job.snapshot_id = ${alias}.snapshot_id
        AND search_job.status IN ('pending', 'running')
    )
    AND NOT EXISTS (
      SELECT 1
      FROM app.review_bulk_operation_job bulk_job
      WHERE bulk_job.snapshot_id = ${alias}.snapshot_id
        AND (
          bulk_job.status IN ('pending', 'running')
          OR (
            bulk_job.status = 'completed'
            AND bulk_job.job_kind = 'review.export.selection'
            AND NOT bulk_job.latest_snapshot_semantics
          )
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM app.review_rebuild_request identity_request
      WHERE identity_request.project_id = ${alias}.project_id
        AND json_extract_string(identity_request.identity_json, '$.snapshotId') = ${alias}.snapshot_id
        AND identity_request.request_id IN (${getOpenRebuildRequestIdsSql()})
    )
    AND NOT EXISTS (
      SELECT 1
      FROM app.review_rebuild_chunk_manifest request_chunk
      WHERE request_chunk.project_id = ${alias}.project_id
        AND request_chunk.snapshot_id = ${alias}.snapshot_id
        AND (
          request_chunk.status IN ('pending', 'running')
          OR request_chunk.request_id IN (${getOpenRebuildRequestIdsSql()})
        )
    )
  )`
}

const getPurgeTargets = async (
  input: {limit: number; projectId: string | null},
  database: ReviewServingSnapshotPurgeTransaction,
) => {
  return database.queryJson<PurgeTarget>(`
    SELECT
      snapshot.project_id AS projectId,
      snapshot.snapshot_id AS snapshotId,
      snapshot.snapshot_status AS snapshotStatus
    FROM app.review_serving_snapshot_manifest snapshot
    WHERE (
        snapshot.snapshot_status = 'purging'
        OR ${getReviewServingSnapshotPurgeEligiblePredicateSql('snapshot')}
      )
      ${input.projectId === null ? '' : `AND snapshot.project_id = ${getSqlLiteral(input.projectId)}`}
    ORDER BY
      CASE WHEN snapshot.snapshot_status = 'purging' THEN 0 ELSE 1 END,
      snapshot.updated_at ASC,
      snapshot.project_id ASC,
      snapshot.snapshot_id ASC
    LIMIT ${getSqlLiteral(input.limit)}
  `)
}

const deleteSnapshotBookkeepingRows = async (target: PurgeTarget, tx: ReviewServingSnapshotPurgeTransaction) => {
  await reviewServingSnapshotPurgeBookkeepingTables.reduce<Promise<void>>(async (previous, table) => {
    await previous
    await tx.run(`DELETE FROM ${table} WHERE ${getSnapshotKeyPredicateSql(target)}`)
  }, Promise.resolve())
}

const fenceSnapshotForPurge = async (target: PurgeTarget, database: ReviewServingSnapshotPurgeDatabase) => {
  return database.transaction(async (tx) => {
    const fenced = await tx.queryJson<{snapshotId: string}>(`
      UPDATE app.review_serving_snapshot_manifest AS snapshot
      SET
        snapshot_status = 'purging',
        updated_at = current_timestamp
      WHERE ${getSnapshotKeyPredicateSql(target, 'snapshot')}
        AND (
          snapshot.snapshot_status = 'purging'
          OR ${getReviewServingSnapshotPurgeEligiblePredicateSql('snapshot')}
        )
      RETURNING snapshot.snapshot_id AS snapshotId
    `)

    if (fenced.length === 0) {
      return false
    }

    await deleteSnapshotBookkeepingRows(target, tx)

    return true
  })
}

const isStillPurging = async (target: PurgeTarget, tx: ReviewServingSnapshotPurgeTransaction) => {
  const rows = await tx.queryJson<{snapshotId: string}>(`
    UPDATE app.review_serving_snapshot_manifest
    SET updated_at = current_timestamp
    WHERE ${getSnapshotKeyPredicateSql(target)}
      AND snapshot_status = 'purging'
    RETURNING snapshot_id AS snapshotId
  `)

  return rows.length > 0
}

const deleteServingRowBatch = async (
  target: PurgeTarget,
  spec: PurgeTableSpec,
  database: ReviewServingSnapshotPurgeDatabase,
) => {
  return database.transaction(async (tx) => {
    if (!(await isStillPurging(target, tx))) {
      return null
    }

    const [row] = await tx.queryJson<{Count: number | string}>(`
      DELETE FROM ${spec.table}
      WHERE rowid IN (
        SELECT rowid
        FROM ${spec.table}
        WHERE ${getSnapshotKeyPredicateSql(target)}
        LIMIT ${getSqlLiteral(spec.rowsPerStatement)}
      )
    `)

    return Number(row?.Count ?? 0)
  })
}

const finishSnapshotPurge = async (target: PurgeTarget, database: ReviewServingSnapshotPurgeDatabase) => {
  return database.transaction(async (tx) => {
    const deleted = await tx.queryJson<{snapshotId: string}>(`
      DELETE FROM app.review_serving_snapshot_manifest
      WHERE ${getSnapshotKeyPredicateSql(target)}
        AND snapshot_status = 'purging'
      RETURNING snapshot_id AS snapshotId
    `)

    if (deleted.length > 0) {
      await deleteSnapshotBookkeepingRows(target, tx)
    }

    return deleted.length > 0
  })
}

// Every call deletes at least one row batch, so a busy foreground queue slows the purge down but cannot stall it.
const getPurgeStopReason = (run: PurgeRun): PurgeStopReason | null => {
  if (run.rowBatchCount === 0) {
    return null
  }

  if (run.nowMs() - run.startedAtMs >= run.budgetMs) {
    return 'budget'
  }

  if (run.deletedRows >= run.maxDeletedRows) {
    return 'rowBudget'
  }

  return run.shouldYield() ? 'yield' : null
}

const purgeServingTable = async (
  input: {run: PurgeRun; spec: PurgeTableSpec; target: PurgeTarget},
  database: ReviewServingSnapshotPurgeDatabase,
  progress: TablePurgeProgress = {deletedRows: 0, state: 'done'},
): Promise<TablePurgeProgress> => {
  const stopReason = getPurgeStopReason(input.run)

  if (stopReason !== null) {
    return {...progress, state: stopReason}
  }

  const deletedRows = await deleteServingRowBatch(input.target, input.spec, database)

  input.run.rowBatchCount += 1

  if (deletedRows === null) {
    return {...progress, state: 'recreated'}
  }

  input.run.deletedRows += deletedRows

  const nextProgress = {deletedRows: progress.deletedRows + deletedRows, state: 'done' as const}

  return deletedRows < input.spec.rowsPerStatement ? nextProgress : purgeServingTable(input, database, nextProgress)
}

const purgeServingTables = async (
  input: {run: PurgeRun; target: PurgeTarget},
  database: ReviewServingSnapshotPurgeDatabase,
  specs: readonly PurgeTableSpec[] = reviewServingSnapshotPurgeServingTables,
  deletedRows = 0,
): Promise<TablePurgeProgress> => {
  const [spec, ...remainingSpecs] = specs

  if (spec === undefined) {
    return {deletedRows, state: 'done'}
  }

  const progress = await purgeServingTable({...input, spec}, database)
  const totalDeletedRows = deletedRows + progress.deletedRows

  return progress.state === 'done'
    ? purgeServingTables(input, database, remainingSpecs, totalDeletedRows)
    : {deletedRows: totalDeletedRows, state: progress.state}
}

const getSnapshotResult = (
  target: PurgeTarget,
  outcome: ReviewServingSnapshotPurgeOutcome,
  deletedRows: number,
): ReviewServingSnapshotPurgeSnapshotResult => {
  return {
    deletedRows,
    outcome,
    previousStatus: target.snapshotStatus,
    projectId: target.projectId,
    snapshotId: target.snapshotId,
  }
}

const getPurgedSnapshotResult = async (
  input: {progress: TablePurgeProgress; target: PurgeTarget},
  database: ReviewServingSnapshotPurgeDatabase,
) => {
  const finished = await finishSnapshotPurge(input.target, database)

  return getSnapshotResult(input.target, finished ? 'purged' : 'recreated', input.progress.deletedRows)
}

const purgeSnapshot = async (
  input: {run: PurgeRun; target: PurgeTarget},
  database: ReviewServingSnapshotPurgeDatabase,
): Promise<{result: ReviewServingSnapshotPurgeSnapshotResult; stopReason: PurgeStopReason | null}> => {
  const fenced = await fenceSnapshotForPurge(input.target, database)

  if (!fenced) {
    return {result: getSnapshotResult(input.target, 'skipped', 0), stopReason: null}
  }

  const progress = await purgeServingTables(input, database)

  if (progress.state === 'done') {
    return {result: await getPurgedSnapshotResult({progress, target: input.target}, database), stopReason: null}
  }

  return progress.state === 'recreated'
    ? {result: getSnapshotResult(input.target, 'recreated', progress.deletedRows), stopReason: null}
    : {result: getSnapshotResult(input.target, 'partial', progress.deletedRows), stopReason: progress.state}
}

const purgeTargets = async (
  input: {run: PurgeRun; targets: readonly PurgeTarget[]},
  database: ReviewServingSnapshotPurgeDatabase,
  results: readonly ReviewServingSnapshotPurgeSnapshotResult[] = [],
): Promise<{results: readonly ReviewServingSnapshotPurgeSnapshotResult[]; stopReason: PurgeStopReason}> => {
  const [target, ...remainingTargets] = input.targets
  const stopReason = target === undefined ? 'complete' : getPurgeStopReason(input.run)

  if (target === undefined || stopReason !== null) {
    return {results, stopReason: stopReason ?? 'complete'}
  }

  const purged = await purgeSnapshot({run: input.run, target}, database)
  const nextResults = [...results, purged.result]

  return purged.stopReason === null
    ? purgeTargets({...input, targets: remainingTargets}, database, nextResults)
    : {results: nextResults, stopReason: purged.stopReason}
}

export const purgeReviewServingSnapshots = async (
  input: PurgeReviewServingSnapshotsInput = {},
  database: ReviewServingSnapshotPurgeDatabase = getAppDatabaseService(),
): Promise<ReviewServingSnapshotPurgeResult> => {
  const nowMs = input.nowMs ?? Date.now
  const run: PurgeRun = {
    budgetMs: getPositiveLimit(input.budgetMs, defaultPurgeBudgetMs),
    deletedRows: 0,
    maxDeletedRows: getPositiveLimit(input.maxDeletedRows, defaultPurgeMaxDeletedRows),
    nowMs,
    rowBatchCount: 0,
    shouldYield:
      input.shouldYield
      ?? (() => {
        return false
      }),
    startedAtMs: nowMs(),
  }
  const targets = await getPurgeTargets(
    {limit: getPositiveLimit(input.maxSnapshots, defaultPurgeMaxSnapshots), projectId: input.projectId ?? null},
    database,
  )
  const purged = await purgeTargets({run, targets}, database)

  return {
    deletedRows: run.deletedRows,
    elapsedMs: Math.max(0, nowMs() - run.startedAtMs),
    snapshots: purged.results,
    stopReason: purged.stopReason,
  }
}
