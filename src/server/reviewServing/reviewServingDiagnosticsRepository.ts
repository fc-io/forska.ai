import {Effect} from 'effect'

import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getJsonValue, getSqlLiteral} from '../services/appQueryHelpers.ts'
import {getReviewServingRebuildChunkClaimPredicate} from './reviewServingChunkManifestRepository.ts'
import {
  isReviewServingProjectionComponent,
  type ReviewServingProjectionComponent,
  type ReviewServingSearchAvailability,
  type ReviewServingSnapshotStatus,
} from './reviewServingContracts.ts'
import {defaultReviewServingDirtyWorkStaleClaimSeconds} from './reviewServingDirtyWorkService.ts'
import {getReviewServingOptionalComponentAvailability} from './reviewServingSnapshotPromotionService.ts'

export type ReviewServingDiagnosticsDatabase = {queryJson: <T>(statement: string) => Promise<T[]>}

export type ReviewServingDiagnosticsInput = {now?: Date | string; projectId: string; reviewConfigHash?: string | null}

export type ReviewServingDiagnosticsCountState = {
  completedCount: number
  failedCount: number
  oldestQueuedAt: string | null
  pendingCount: number
  runningCount: number
  updatedAt: string | null
}

export type ReviewServingDiagnosticsRebuildChunkState = ReviewServingDiagnosticsCountState & {
  blockedQueuedCount: number
  blockedOverBudgetCount: number
  claimableCount: number
  expiredLeaseCount: number
  oldestClaimableQueuedAt: string | null
  quarantinedCount: number
}

export type ReviewServingDiagnosticsQuarantineBarrier = {
  outboxId: string
  sourceHighWaterMark: number
  sourcePartition: string
  status: string
}

export type ReviewServingDiagnostics = {
  dirtyWork: ReviewServingDiagnosticsCountState
  maintenance: {
    dirtyWorkRunningCount: number
    expiredRebuildChunkLeaseCount: number
    rebuildChunkRunningCount: number
    requiredConsumerRole: 'maintenance-worker'
  }
  projectId: string
  quarantine: {
    oldestBarrier: ReviewServingDiagnosticsQuarantineBarrier | null
    quarantinedCursorCount: number
    quarantinedOutboxCount: number
    retryableOutboxCount: number
    unresolvedOutboxCount: number
  }
  rebuildChunks: ReviewServingDiagnosticsRebuildChunkState
  reviewConfigHash: string | null
  search: {availability: ReviewServingSearchAvailability; optionalComponent: boolean; snapshotId: string | null}
  snapshot: {
    activeCount: number
    activeSnapshotId: string | null
    activeUpdatedAt: string | null
    candidateCount: number
    failedCount: number
    lastKnownGoodSnapshotId: string | null
    retiredCount: number
  }
}

type ActiveSnapshotRow = {
  componentStateJson: unknown
  lastKnownGoodSnapshotId: string | null
  optionalComponentsJson: unknown
  snapshotId: string
  updatedAt: string | null
}

type SnapshotStatusCountRow = {snapshotCount: number; snapshotStatus: ReviewServingSnapshotStatus}

type CountStateRow = {
  completedCount: number
  failedCount: number
  oldestQueuedAt: string | null
  pendingCount: number
  runningCount: number
  updatedAt: string | null
}

type RebuildChunkStateRow = CountStateRow & {
  blockedQueuedCount: number
  blockedOverBudgetCount: number
  claimableCount: number
  expiredLeaseCount: number
  oldestClaimableQueuedAt: string | null
  quarantinedCount: number
}

type QuarantineStateRow = {quarantinedOutboxCount: number; retryableOutboxCount: number; unresolvedOutboxCount: number}

type QuarantinedCursorCountRow = {quarantinedCursorCount: number}

type SnapshotComponentStateEntry = {component: ReviewServingProjectionComponent}

const terminalOutboxStatuses = ['operator_terminal', 'reconciled'] as const
const emptyCountState: ReviewServingDiagnosticsCountState = {
  completedCount: 0,
  failedCount: 0,
  oldestQueuedAt: null,
  pendingCount: 0,
  runningCount: 0,
  updatedAt: null,
}
const emptyRebuildChunkState: ReviewServingDiagnosticsRebuildChunkState = {
  ...emptyCountState,
  blockedQueuedCount: 0,
  blockedOverBudgetCount: 0,
  claimableCount: 0,
  expiredLeaseCount: 0,
  oldestClaimableQueuedAt: null,
  quarantinedCount: 0,
}
const emptyQuarantineState = {quarantinedOutboxCount: 0, retryableOutboxCount: 0, unresolvedOutboxCount: 0}

const getDiagnosticsDatabase = () => {
  return getAppDatabaseService() as ReviewServingDiagnosticsDatabase
}

const getReviewConfigPredicate = (reviewConfigHash: string | null | undefined) => {
  return reviewConfigHash === undefined
    ? ''
    : `AND review_config_hash IS NOT DISTINCT FROM ${getSqlLiteral(reviewConfigHash)}`
}

const getProjectSourcePartitions = (projectId: string) => {
  return [
    `import-run-article:${projectId}`,
    `importRunArticle:${projectId}`,
    `import_run_article_delta:${projectId}`,
    `project-scope:${projectId}`,
    `projectScope:${projectId}`,
    `review-change:${projectId}`,
    `reviewChange:${projectId}`,
    `review_change_delta:${projectId}`,
  ]
}

const getSqlStringList = (values: readonly string[]) => {
  return values.map(getSqlLiteral).join(', ')
}

const getOutboxTerminalStatusList = () => {
  return getSqlStringList(terminalOutboxStatuses)
}

const getDiagnosticsTimestampLiteral = (value: Date | string) => {
  return value instanceof Date ? getSqlLiteral(value) : `TIMESTAMPTZ ${getSqlLiteral(value)}`
}

const queryEffect = <T>(database: ReviewServingDiagnosticsDatabase, statement: string) => {
  return Effect.tryPromise(() => {
    return database.queryJson<T>(statement)
  })
}

const getCountState = (row: CountStateRow | undefined): ReviewServingDiagnosticsCountState => {
  return row === undefined
    ? emptyCountState
    : {
        completedCount: Number(row.completedCount),
        failedCount: Number(row.failedCount),
        oldestQueuedAt: row.oldestQueuedAt,
        pendingCount: Number(row.pendingCount),
        runningCount: Number(row.runningCount),
        updatedAt: row.updatedAt,
      }
}

const getRebuildChunkState = (row: RebuildChunkStateRow | undefined): ReviewServingDiagnosticsRebuildChunkState => {
  return row === undefined
    ? emptyRebuildChunkState
    : {
        ...getCountState(row),
        blockedQueuedCount: Number(row.blockedQueuedCount),
        blockedOverBudgetCount: Number(row.blockedOverBudgetCount),
        claimableCount: Number(row.claimableCount),
        expiredLeaseCount: Number(row.expiredLeaseCount),
        oldestClaimableQueuedAt: row.oldestClaimableQueuedAt,
        quarantinedCount: Number(row.quarantinedCount),
      }
}

const getSnapshotStatusCounts = (rows: readonly SnapshotStatusCountRow[]) => {
  return rows.reduce<Record<ReviewServingSnapshotStatus, number>>(
    (counts, row) => {
      return {...counts, [row.snapshotStatus]: Number(row.snapshotCount)}
    },
    {active: 0, candidate: 0, failed: 0, retired: 0},
  )
}

const getOptionalComponents = (optionalComponentsJson: unknown) => {
  const parsed = getJsonValue(optionalComponentsJson)

  return Array.isArray(parsed)
    ? parsed.filter((entry): entry is ReviewServingProjectionComponent => {
        return typeof entry === 'string' && isReviewServingProjectionComponent(entry)
      })
    : []
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const isSnapshotComponentStateEntry = (value: unknown): value is SnapshotComponentStateEntry => {
  return isRecord(value) && typeof value.component === 'string' && isReviewServingProjectionComponent(value.component)
}

const getUnknownArray = (value: unknown): readonly unknown[] => {
  return Array.isArray(value) ? (value as readonly unknown[]) : []
}

const getSnapshotComponentStateEntries = (componentStateJson: unknown) => {
  const parsed = getJsonValue(componentStateJson)
  const state = isRecord(parsed) ? parsed : {}
  const required = getUnknownArray(state.required)
  const optional = getUnknownArray(state.optional)

  return [...required, ...optional].filter(isSnapshotComponentStateEntry)
}

const getSearchAvailability = (input: {
  optionalComponents: readonly ReviewServingProjectionComponent[]
  optionalStatePresent: boolean
  snapshotPresent: boolean
}): ReviewServingSearchAvailability => {
  const availability = getReviewServingOptionalComponentAvailability({
    component: 'search',
    hasActiveSnapshot: input.snapshotPresent,
    optionalComponents: input.optionalComponents,
    optionalStatePresent: input.optionalStatePresent,
  })

  return availability === 'stale' ? 'unavailable' : availability
}

const getSearchDiagnostics = (activeSnapshot: ActiveSnapshotRow | undefined): ReviewServingDiagnostics['search'] => {
  const optionalComponents = getOptionalComponents(activeSnapshot?.optionalComponentsJson ?? [])
  const optionalStatePresent = getSnapshotComponentStateEntries(activeSnapshot?.componentStateJson ?? {}).some(
    (state) => {
      return state.component === 'search'
    },
  )

  return {
    availability: getSearchAvailability({
      optionalComponents,
      optionalStatePresent,
      snapshotPresent: activeSnapshot !== undefined,
    }),
    optionalComponent: optionalComponents.includes('search'),
    snapshotId: activeSnapshot?.snapshotId ?? null,
  }
}

const getSnapshotDiagnostics = (
  activeSnapshot: ActiveSnapshotRow | undefined,
  snapshotStatusCounts: readonly SnapshotStatusCountRow[],
): ReviewServingDiagnostics['snapshot'] => {
  const counts = getSnapshotStatusCounts(snapshotStatusCounts)

  return {
    activeCount: counts.active,
    activeSnapshotId: activeSnapshot?.snapshotId ?? null,
    activeUpdatedAt: activeSnapshot?.updatedAt ?? null,
    candidateCount: counts.candidate,
    failedCount: counts.failed,
    lastKnownGoodSnapshotId: activeSnapshot?.lastKnownGoodSnapshotId ?? null,
    retiredCount: counts.retired,
  }
}

const getQuarantineDiagnostics = (input: {
  oldestBarrier: ReviewServingDiagnosticsQuarantineBarrier | undefined
  quarantineState: QuarantineStateRow | undefined
  quarantinedCursorCount: QuarantinedCursorCountRow | undefined
}): ReviewServingDiagnostics['quarantine'] => {
  const quarantineState = input.quarantineState ?? emptyQuarantineState

  return {
    oldestBarrier: input.oldestBarrier ?? null,
    quarantinedCursorCount: Number(input.quarantinedCursorCount?.quarantinedCursorCount ?? 0),
    quarantinedOutboxCount: Number(quarantineState.quarantinedOutboxCount),
    retryableOutboxCount: Number(quarantineState.retryableOutboxCount),
    unresolvedOutboxCount: Number(quarantineState.unresolvedOutboxCount),
  }
}

const getActiveSnapshotRowsEffect = (
  input: ReviewServingDiagnosticsInput,
  database: ReviewServingDiagnosticsDatabase,
) => {
  return queryEffect<ActiveSnapshotRow>(
    database,
    `
      SELECT
        snapshot_id AS snapshotId,
        last_known_good_snapshot_id AS lastKnownGoodSnapshotId,
        optional_components_json AS optionalComponentsJson,
        component_state_json AS componentStateJson,
        updated_at AS updatedAt
      FROM app.review_serving_snapshot_manifest
      WHERE project_id = ${getSqlLiteral(input.projectId)}
        ${getReviewConfigPredicate(input.reviewConfigHash)}
        AND snapshot_status = 'active'
      ORDER BY activated_at DESC NULLS LAST, updated_at DESC
      LIMIT 1
    `,
  )
}

const getSnapshotStatusCountRowsEffect = (
  input: ReviewServingDiagnosticsInput,
  database: ReviewServingDiagnosticsDatabase,
) => {
  return queryEffect<SnapshotStatusCountRow>(
    database,
    `
      SELECT
        snapshot_status AS snapshotStatus,
        CAST(COUNT(*) AS INTEGER) AS snapshotCount
      FROM app.review_serving_snapshot_manifest
      WHERE project_id = ${getSqlLiteral(input.projectId)}
        ${getReviewConfigPredicate(input.reviewConfigHash)}
      GROUP BY snapshot_status
    `,
  )
}

const getDirtyWorkRowsEffect = (input: ReviewServingDiagnosticsInput, database: ReviewServingDiagnosticsDatabase) => {
  const now = input.now ?? new Date()
  const retryableDirtyWorkPredicate = `updated_at <= ${getDiagnosticsTimestampLiteral(now)} - INTERVAL '${defaultReviewServingDirtyWorkStaleClaimSeconds} seconds'`

  return queryEffect<CountStateRow>(
    database,
    `
      SELECT
        CAST(COUNT(*) FILTER (
          WHERE status = 'pending' OR (status IN ('failed', 'running') AND ${retryableDirtyWorkPredicate})
        ) AS INTEGER) AS pendingCount,
        CAST(COUNT(*) FILTER (WHERE status = 'running' AND NOT (${retryableDirtyWorkPredicate})) AS INTEGER) AS runningCount,
        CAST(COUNT(*) FILTER (WHERE status = 'failed' AND NOT (${retryableDirtyWorkPredicate})) AS INTEGER) AS failedCount,
        CAST(COUNT(*) FILTER (WHERE status = 'completed') AS INTEGER) AS completedCount,
        MIN(created_at) FILTER (WHERE status IN ('pending', 'failed')) AS oldestQueuedAt,
        MAX(updated_at) FILTER (WHERE status IN ('running', 'completed')) AS updatedAt
      FROM app.review_serving_dirty_work
      WHERE project_id = ${getSqlLiteral(input.projectId)}
    `,
  )
}

const getRebuildChunkRowsEffect = (
  input: ReviewServingDiagnosticsInput,
  database: ReviewServingDiagnosticsDatabase,
) => {
  const now = input.now ?? new Date()
  const staleLeasePredicate = `
    visible_chunk.status = 'running'
    AND (
      visible_chunk.lease_expires_at IS NULL
      OR visible_chunk.lease_expires_at <= ${getDiagnosticsTimestampLiteral(now)}
    )
  `
  const queuedPredicate = `
    visible_chunk.status IN ('pending', 'failed')
    OR (${staleLeasePredicate})
  `
  const claimablePredicate = getReviewServingRebuildChunkClaimPredicate({now}, 'visible_chunk')

  return queryEffect<RebuildChunkStateRow>(
    database,
    `
      WITH latest_request AS (
        SELECT request_id, admission_state, status
        FROM app.review_rebuild_request
        WHERE project_id IS NOT DISTINCT FROM ${getSqlLiteral(input.projectId)}
        ORDER BY
          CASE WHEN admission_state = 'admitted' AND status IN ('admitted', 'running') THEN 0 ELSE 1 END ASC,
          updated_at DESC,
          created_at DESC,
          request_id DESC
        LIMIT 1
      ),
      visible_chunk AS (
        SELECT chunk.*
        FROM app.review_rebuild_chunk_manifest chunk
        LEFT JOIN latest_request ON TRUE
        WHERE chunk.project_id IS NOT DISTINCT FROM ${getSqlLiteral(input.projectId)}
          AND (
            latest_request.request_id IS NULL
            OR chunk.request_id IS NULL
            OR chunk.request_id IS NOT DISTINCT FROM latest_request.request_id
          )
      ),
      classified_chunk AS (
        SELECT
          visible_chunk.*,
          CASE WHEN (${queuedPredicate}) THEN 1 ELSE 0 END AS queued,
          CASE WHEN (${claimablePredicate}) THEN 1 ELSE 0 END AS claimable
        FROM visible_chunk
      ),
      terminal_request AS (
        SELECT CAST(COUNT(*) AS INTEGER) AS failed_count
        FROM latest_request
        WHERE latest_request.status IN ('failed', 'quarantined')
          AND NOT EXISTS (
            SELECT 1
            FROM classified_chunk
            WHERE classified_chunk.request_id IS NOT DISTINCT FROM latest_request.request_id
              AND classified_chunk.claimable = 1
          )
      )
      SELECT
        CAST(COUNT(*) FILTER (WHERE classified_chunk.status IN ('pending', 'failed')) AS INTEGER) AS pendingCount,
        CAST(COUNT(*) FILTER (WHERE classified_chunk.status = 'running') AS INTEGER) AS runningCount,
        COALESCE((SELECT failed_count FROM terminal_request), 0) AS failedCount,
        CAST(COUNT(*) FILTER (WHERE classified_chunk.status = 'completed') AS INTEGER) AS completedCount,
        CAST(COUNT(*) FILTER (WHERE classified_chunk.claimable = 1) AS INTEGER) AS claimableCount,
        CAST(COUNT(*) FILTER (WHERE classified_chunk.queued = 1 AND classified_chunk.claimable = 0) AS INTEGER) AS blockedQueuedCount,
        CAST(COUNT(*) FILTER (
          WHERE classified_chunk.status = 'blocked_over_budget'
            AND (
              latest_request.request_id IS NULL
              OR (
                classified_chunk.request_id IS NOT DISTINCT FROM latest_request.request_id
                AND latest_request.status IN ('blocked_over_budget', 'failed')
                AND latest_request.admission_state = 'blocked_over_budget'
              )
            )
        ) AS INTEGER) AS blockedOverBudgetCount,
        CAST(COUNT(*) FILTER (
          WHERE classified_chunk.status = 'quarantined'
            AND (
              latest_request.request_id IS NULL
              OR (
                classified_chunk.request_id IS NOT DISTINCT FROM latest_request.request_id
                AND latest_request.status IN ('quarantined', 'failed')
              )
            )
        ) AS INTEGER) AS quarantinedCount,
        CAST(COUNT(*) FILTER (
          WHERE classified_chunk.status = 'running'
            AND (
              classified_chunk.lease_expires_at IS NULL
              OR classified_chunk.lease_expires_at <= ${getDiagnosticsTimestampLiteral(now)}
            )
        ) AS INTEGER) AS expiredLeaseCount,
        MIN(classified_chunk.created_at) FILTER (
          WHERE classified_chunk.queued = 1
        ) AS oldestQueuedAt,
        MIN(classified_chunk.created_at) FILTER (
          WHERE classified_chunk.claimable = 1
        ) AS oldestClaimableQueuedAt,
        MAX(classified_chunk.updated_at) FILTER (WHERE classified_chunk.status IN ('running', 'completed')) AS updatedAt
      FROM classified_chunk
      LEFT JOIN latest_request ON TRUE
    `,
  )
}

const getQuarantineRowsEffect = (input: ReviewServingDiagnosticsInput, database: ReviewServingDiagnosticsDatabase) => {
  const partitions = getProjectSourcePartitions(input.projectId)

  return queryEffect<QuarantineStateRow>(
    database,
    `
      SELECT
        CAST(COUNT(*) FILTER (WHERE status NOT IN (${getOutboxTerminalStatusList()})) AS INTEGER) AS unresolvedOutboxCount,
        CAST(COUNT(*) FILTER (WHERE status = 'quarantined') AS INTEGER) AS quarantinedOutboxCount,
        CAST(COUNT(*) FILTER (WHERE status NOT IN (${getOutboxTerminalStatusList()}) AND status <> 'quarantined') AS INTEGER) AS retryableOutboxCount
      FROM app.review_source_change_outbox
      WHERE source_partition IN (${getSqlStringList(partitions)})
    `,
  )
}

const getOldestBarrierRowsEffect = (
  input: ReviewServingDiagnosticsInput,
  database: ReviewServingDiagnosticsDatabase,
) => {
  const partitions = getProjectSourcePartitions(input.projectId)

  return queryEffect<ReviewServingDiagnosticsQuarantineBarrier>(
    database,
    `
      SELECT
        outbox_id AS outboxId,
        source_partition AS sourcePartition,
        source_high_water_mark AS sourceHighWaterMark,
        status
      FROM app.review_source_change_outbox
      WHERE source_partition IN (${getSqlStringList(partitions)})
        AND status NOT IN (${getOutboxTerminalStatusList()})
      ORDER BY source_high_water_mark ASC, created_at ASC, outbox_id ASC
      LIMIT 1
    `,
  )
}

const getQuarantinedCursorRowsEffect = (
  input: ReviewServingDiagnosticsInput,
  database: ReviewServingDiagnosticsDatabase,
) => {
  const partitions = getProjectSourcePartitions(input.projectId)

  return queryEffect<QuarantinedCursorCountRow>(
    database,
    `
      SELECT
        CAST(COUNT(*) AS INTEGER) AS quarantinedCursorCount
      FROM app.review_delta_reconciliation_cursor
      WHERE source_partition IN (${getSqlStringList(partitions)})
        AND (status = 'quarantined' OR quarantined_at IS NOT NULL)
    `,
  )
}

export const getReviewServingDiagnosticsEffect = (
  input: ReviewServingDiagnosticsInput,
  database: ReviewServingDiagnosticsDatabase = getDiagnosticsDatabase(),
) => {
  return Effect.gen(function* () {
    const [
      activeSnapshots,
      snapshotStatusCounts,
      dirtyWorkRows,
      rebuildChunkRows,
      quarantineRows,
      barrierRows,
      cursorRows,
    ] = yield* Effect.all([
      getActiveSnapshotRowsEffect(input, database),
      getSnapshotStatusCountRowsEffect(input, database),
      getDirtyWorkRowsEffect(input, database),
      getRebuildChunkRowsEffect(input, database),
      getQuarantineRowsEffect(input, database),
      getOldestBarrierRowsEffect(input, database),
      getQuarantinedCursorRowsEffect(input, database),
    ])
    const activeSnapshot = activeSnapshots[0]
    const dirtyWork = getCountState(dirtyWorkRows[0])
    const rebuildChunks = getRebuildChunkState(rebuildChunkRows[0])

    return {
      dirtyWork,
      maintenance: {
        dirtyWorkRunningCount: dirtyWork.runningCount,
        expiredRebuildChunkLeaseCount: rebuildChunks.expiredLeaseCount,
        rebuildChunkRunningCount: rebuildChunks.runningCount,
        requiredConsumerRole: 'maintenance-worker' as const,
      },
      projectId: input.projectId,
      quarantine: getQuarantineDiagnostics({
        oldestBarrier: barrierRows[0],
        quarantinedCursorCount: cursorRows[0],
        quarantineState: quarantineRows[0],
      }),
      rebuildChunks,
      reviewConfigHash: input.reviewConfigHash ?? null,
      search: getSearchDiagnostics(activeSnapshot),
      snapshot: getSnapshotDiagnostics(activeSnapshot, snapshotStatusCounts),
    }
  })
}

export const getReviewServingDiagnostics = (
  input: ReviewServingDiagnosticsInput,
  database: ReviewServingDiagnosticsDatabase = getDiagnosticsDatabase(),
) => {
  return Effect.runPromise(getReviewServingDiagnosticsEffect(input, database))
}
