import {Effect} from 'effect'

import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getJsonValue, getSqlLiteral} from '../services/appQueryHelpers.ts'
import type {DuckdbWorkloadContext} from '../utils/duckdbService.ts'
import {getReviewServingRebuildChunkClaimPredicate} from './reviewServingChunkManifestRepository.ts'
import {
  isReviewServingProjectionComponent,
  type ReviewServingProjectionComponent,
  type ReviewServingSearchAvailability,
} from './reviewServingContracts.ts'
import {defaultReviewServingDirtyWorkStaleClaimSeconds} from './reviewServingDirtyWorkService.ts'
import {getReviewServingOptionalComponentAvailability} from './reviewServingSnapshotPromotionService.ts'

export type ReviewServingDiagnosticsDatabase = {
  queryJson: <T>(statement: string, workloadContext?: DuckdbWorkloadContext) => Promise<T[]>
}

export type ReviewServingDiagnosticsInput = {
  now?: Date | string
  projectId: string
  reviewConfigHash?: string | null
  workloadContext?: DuckdbWorkloadContext
}

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
    invalidCandidateReasons: {
      invalidOptionalStateCount: number
      invalidRequiredStateCount: number
      missingRequiredCount: number
      selectedImportIncompleteCount: number
    }
    invalidCandidateCount: number
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

type QuarantineStateRow = {quarantinedOutboxCount: number; retryableOutboxCount: number; unresolvedOutboxCount: number}

type QuarantinedCursorCountRow = {quarantinedCursorCount: number}

type DiagnosticsSummaryRow = {
  activeSnapshotComponentStateJson: unknown
  activeSnapshotLastKnownGoodSnapshotId: string | null
  activeSnapshotOptionalComponentsJson: unknown
  activeSnapshotSnapshotId: string | null
  activeSnapshotUpdatedAt: string | null
  dirtyWorkCompletedCount: number
  dirtyWorkFailedCount: number
  dirtyWorkOldestQueuedAt: string | null
  dirtyWorkPendingCount: number
  dirtyWorkRunningCount: number
  dirtyWorkUpdatedAt: string | null
  oldestBarrierOutboxId: string | null
  oldestBarrierSourceHighWaterMark: number | null
  oldestBarrierSourcePartition: string | null
  oldestBarrierStatus: string | null
  quarantinedCursorCount: number
  quarantinedOutboxCount: number
  rebuildChunkBlockedOverBudgetCount: number
  rebuildChunkBlockedQueuedCount: number
  rebuildChunkClaimableCount: number
  rebuildChunkCompletedCount: number
  rebuildChunkExpiredLeaseCount: number
  rebuildChunkFailedCount: number
  rebuildChunkOldestClaimableQueuedAt: string | null
  rebuildChunkOldestQueuedAt: string | null
  rebuildChunkPendingCount: number
  rebuildChunkQuarantinedCount: number
  rebuildChunkRunningCount: number
  rebuildChunkUpdatedAt: string | null
  retryableOutboxCount: number
  snapshotActiveCount: number
  snapshotCandidateCount: number
  snapshotFailedCount: number
  snapshotInvalidOptionalStateCandidateCount: number
  snapshotInvalidRequiredStateCandidateCount: number
  snapshotInvalidCandidateCount: number
  snapshotMissingRequiredCandidateCount: number
  snapshotRetiredCount: number
  snapshotSelectedImportIncompleteCandidateCount: number
  unresolvedOutboxCount: number
}

type OldestBarrierRow = {
  outboxId: string | null
  sourceHighWaterMark: number | null
  sourcePartition: string | null
  status: string | null
}

type SnapshotComponentStateEntry = {component: ReviewServingProjectionComponent}

const terminalOutboxStatuses = ['operator_terminal', 'reconciled'] as const
const componentSourceWatermarkKeys: Record<ReviewServingProjectionComponent, readonly string[]> = {
  display: ['reviewChange', 'review-change'],
  humanStatus: [
    'reviewChange',
    'review-change',
    'importRunArticle',
    'import-run-article',
    'projectScope',
    'project-scope',
  ],
  judgmentInputContent: ['reviewChange', 'review-change'],
  llmStatus: [
    'reviewChange',
    'review-change',
    'importRunArticle',
    'import-run-article',
    'projectScope',
    'project-scope',
  ],
  payload: ['reviewChange', 'review-change', 'importRunArticle', 'import-run-article', 'projectScope', 'project-scope'],
  posting: ['reviewChange', 'review-change', 'importRunArticle', 'import-run-article', 'projectScope', 'project-scope'],
  projectScope: [
    'reviewChange',
    'review-change',
    'importRunArticle',
    'import-run-article',
    'projectScope',
    'project-scope',
  ],
  queue: ['reviewChange', 'review-change', 'importRunArticle', 'import-run-article', 'projectScope', 'project-scope'],
  search: ['reviewChange', 'review-change', 'importRunArticle', 'import-run-article', 'projectScope', 'project-scope'],
  selectedImport: [
    'reviewChange',
    'review-change',
    'importRunArticle',
    'import-run-article',
    'projectScope',
    'project-scope',
  ],
  summary: ['reviewChange', 'review-change', 'importRunArticle', 'import-run-article', 'projectScope', 'project-scope'],
}
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

const getSourceWatermarkJsonExtract = (key: string) => {
  return `TRY_CAST(json_extract_string(snapshot.source_watermarks_json, '$."${key}"') AS BIGINT)`
}

const getSourceWatermarkAggregateSql = (keys: readonly string[]) => {
  return `GREATEST(0, ${keys
    .map((key) => {
      return `COALESCE(${getSourceWatermarkJsonExtract(key)}, 0)`
    })
    .join(', ')})`
}

const getComponentSourceWatermarkSql = (stateAlias: string) => {
  const componentSql = `json_extract_string(${stateAlias}.value, '$.component')`
  const componentSourceWatermarkSql = `TRY_CAST(json_extract_string(snapshot.source_watermarks_json, '$."' || ${componentSql} || '"') AS BIGINT)`
  const aggregateCaseSql = Object.entries(componentSourceWatermarkKeys)
    .map(([component, keys]) => {
      return `WHEN ${getSqlLiteral(component)} THEN ${getSourceWatermarkAggregateSql(keys)}`
    })
    .join('\n')
  const sourceKeyCaseSql = Object.entries(componentSourceWatermarkKeys)
    .map(([component, keys]) => {
      return `(${componentSql} = ${getSqlLiteral(component)} AND source_watermark.key IN (${getSqlStringList(keys)}))`
    })
    .join('\n                OR ')

  return `
            AND manifest.input_watermark >= COALESCE(
              ${componentSourceWatermarkSql},
              CASE ${componentSql}
                ${aggregateCaseSql}
                ELSE 0
              END
            )
            AND NOT EXISTS (
              SELECT 1
              FROM json_each(snapshot.source_watermarks_json) source_watermark
              WHERE (
                (${componentSourceWatermarkSql} IS NOT NULL AND source_watermark.key = ${componentSql})
                OR (${componentSourceWatermarkSql} IS NULL AND (${sourceKeyCaseSql}))
              )
                AND COALESCE(
                  TRY_CAST(json_extract_string(manifest.input_watermarks_json, '$."' || source_watermark.key || '"') AS BIGINT),
                  0
                ) < COALESCE(TRY_CAST(json_extract_string(source_watermark.value, '$') AS BIGINT), 0)
            )`
}

const getOutboxTerminalStatusList = () => {
  return getSqlStringList(terminalOutboxStatuses)
}

const getDiagnosticsTimestampLiteral = (value: Date | string) => {
  return value instanceof Date ? getSqlLiteral(value) : `TIMESTAMPTZ ${getSqlLiteral(value)}`
}

const queryEffect = <T>(
  database: ReviewServingDiagnosticsDatabase,
  statement: string,
  workloadContext?: DuckdbWorkloadContext,
) => {
  return Effect.tryPromise(() => {
    return database.queryJson<T>(statement, workloadContext)
  })
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

const getDiagnosticsSummaryRowsEffect = (
  input: ReviewServingDiagnosticsInput,
  database: ReviewServingDiagnosticsDatabase,
) => {
  const now = input.now ?? new Date()
  const retryableDirtyWorkPredicate = `updated_at <= ${getDiagnosticsTimestampLiteral(now)} - INTERVAL '${defaultReviewServingDirtyWorkStaleClaimSeconds} seconds'`
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
  const partitions = getProjectSourcePartitions(input.projectId)

  return queryEffect<DiagnosticsSummaryRow>(
    database,
    `
      WITH active_snapshot AS (
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
      ),
      snapshot_candidates AS (
        SELECT *
        FROM app.review_serving_snapshot_manifest
        WHERE project_id = ${getSqlLiteral(input.projectId)}
          ${getReviewConfigPredicate(input.reviewConfigHash)}
          AND snapshot_status = 'candidate'
      ), missing_required_candidate AS (
        SELECT DISTINCT snapshot.snapshot_id
        FROM snapshot_candidates snapshot,
          app.review_selected_import_snapshot selected_import,
          json_each(snapshot.required_components_json) required_component
        WHERE selected_import.selected_import_snapshot_id = snapshot.selected_import_snapshot_id
          AND selected_import.status = 'completed'
          AND NOT EXISTS (
          SELECT 1
          FROM json_each(json_extract(snapshot.component_state_json, '$.required')) required_state
          WHERE json_extract_string(required_state.value, '$.component') = json_extract_string(required_component.value, '$')
        )
      ), invalid_required_state_candidate AS (
        SELECT DISTINCT snapshot.snapshot_id
        FROM snapshot_candidates snapshot,
          app.review_selected_import_snapshot selected_import,
          json_each(json_extract(snapshot.component_state_json, '$.required')) required_state
        WHERE selected_import.selected_import_snapshot_id = snapshot.selected_import_snapshot_id
          AND selected_import.status = 'completed'
          AND NOT EXISTS (
          SELECT 1
          FROM app.review_projection_identity_manifest manifest
          WHERE manifest.project_id = snapshot.project_id
            AND manifest.projection_component = json_extract_string(required_state.value, '$.component')
            AND manifest.projection_identity = json_extract_string(required_state.value, '$.projectionIdentity')
            AND manifest.status IN ('active', 'candidate')
            AND (manifest.review_config_hash IS NULL OR manifest.review_config_hash = snapshot.review_config_hash)
            AND manifest.base_generation = TRY_CAST(json_extract_string(required_state.value, '$.baseGeneration') AS BIGINT)
            AND manifest.patch_watermark = TRY_CAST(json_extract_string(required_state.value, '$.patchWatermark') AS BIGINT)
            AND manifest.input_watermark >= TRY_CAST(json_extract_string(required_state.value, '$.patchWatermark') AS BIGINT)
            ${getComponentSourceWatermarkSql('required_state')}
        )
      ), invalid_optional_state_candidate AS (
        SELECT DISTINCT snapshot.snapshot_id
        FROM snapshot_candidates snapshot,
          app.review_selected_import_snapshot selected_import,
          json_each(json_extract(snapshot.component_state_json, '$.optional')) optional_state
        WHERE selected_import.selected_import_snapshot_id = snapshot.selected_import_snapshot_id
          AND selected_import.status = 'completed'
          AND NOT EXISTS (
          SELECT 1
          FROM app.review_projection_identity_manifest manifest
          WHERE manifest.project_id = snapshot.project_id
            AND manifest.projection_component = json_extract_string(optional_state.value, '$.component')
            AND manifest.projection_identity = json_extract_string(optional_state.value, '$.projectionIdentity')
            AND manifest.status IN ('active', 'candidate')
            AND (manifest.review_config_hash IS NULL OR manifest.review_config_hash = snapshot.review_config_hash)
            AND manifest.base_generation = TRY_CAST(json_extract_string(optional_state.value, '$.baseGeneration') AS BIGINT)
            AND manifest.patch_watermark = TRY_CAST(json_extract_string(optional_state.value, '$.patchWatermark') AS BIGINT)
            AND manifest.input_watermark >= TRY_CAST(json_extract_string(optional_state.value, '$.patchWatermark') AS BIGINT)
            ${getComponentSourceWatermarkSql('optional_state')}
        )
      ), selected_import_incomplete_candidate AS (
        SELECT snapshot.snapshot_id
        FROM snapshot_candidates snapshot
        LEFT JOIN app.review_selected_import_snapshot selected_import
          ON selected_import.selected_import_snapshot_id = snapshot.selected_import_snapshot_id
        WHERE snapshot.selected_import_snapshot_id IS NOT NULL
          AND COALESCE(selected_import.status, 'missing') <> 'completed'
      ), invalid_candidate AS (
        SELECT snapshot_id FROM selected_import_incomplete_candidate
        UNION
        SELECT snapshot_id FROM missing_required_candidate
        UNION
        SELECT snapshot_id FROM invalid_required_state_candidate
        UNION
        SELECT snapshot_id FROM invalid_optional_state_candidate
      ), snapshot_status_counts AS (
        SELECT
          CAST(COUNT(*) FILTER (WHERE snapshot_status = 'active') AS INTEGER) AS activeCount,
          CAST(COUNT(*) FILTER (WHERE snapshot_status = 'candidate') AS INTEGER) AS candidateCount,
          CAST(COUNT(*) FILTER (WHERE snapshot_status = 'failed') AS INTEGER) AS failedCount,
          CAST(COUNT(*) FILTER (WHERE snapshot_status = 'retired') AS INTEGER) AS retiredCount,
          CAST((SELECT COUNT(DISTINCT snapshot_id) FROM selected_import_incomplete_candidate) AS INTEGER) AS selectedImportIncompleteCandidateCount,
          CAST((SELECT COUNT(DISTINCT snapshot_id) FROM missing_required_candidate) AS INTEGER) AS missingRequiredCandidateCount,
          CAST((SELECT COUNT(DISTINCT snapshot_id) FROM invalid_required_state_candidate) AS INTEGER) AS invalidRequiredStateCandidateCount,
          CAST((SELECT COUNT(DISTINCT snapshot_id) FROM invalid_optional_state_candidate) AS INTEGER) AS invalidOptionalStateCandidateCount,
          CAST(COUNT(*) FILTER (
            WHERE snapshot_status = 'candidate'
              AND snapshot.snapshot_id IN (SELECT snapshot_id FROM invalid_candidate)
          ) AS INTEGER) AS invalidCandidateCount
        FROM app.review_serving_snapshot_manifest snapshot
        WHERE snapshot.project_id = ${getSqlLiteral(input.projectId)}
          ${getReviewConfigPredicate(input.reviewConfigHash)}
      ), dirty_work AS (
        SELECT
          CAST(COUNT(*) FILTER (
            WHERE status = 'pending' OR (status IN ('failed', 'running') AND ${retryableDirtyWorkPredicate})
          ) AS INTEGER) AS pendingCount,
          CAST(COUNT(*) FILTER (
            WHERE status IN ('failed', 'running') AND NOT (${retryableDirtyWorkPredicate})
          ) AS INTEGER) AS runningCount,
          CAST(0 AS INTEGER) AS failedCount,
          CAST(COUNT(*) FILTER (WHERE status = 'completed') AS INTEGER) AS completedCount,
          MIN(created_at) FILTER (
            WHERE status = 'pending' OR (status IN ('failed', 'running') AND ${retryableDirtyWorkPredicate})
          ) AS oldestQueuedAt,
          MAX(updated_at) FILTER (WHERE status IN ('failed', 'running', 'completed')) AS updatedAt
        FROM app.review_serving_dirty_work
        WHERE project_id = ${getSqlLiteral(input.projectId)}
      ), latest_request AS (
        SELECT request_id, admission_state, status
        FROM app.review_rebuild_request
        WHERE project_id IS NOT DISTINCT FROM ${getSqlLiteral(input.projectId)}
        ORDER BY
          CASE WHEN admission_state = 'admitted' AND status IN ('admitted', 'running') THEN 0 ELSE 1 END ASC,
          updated_at DESC,
          created_at DESC,
          request_id DESC
        LIMIT 1
      ), visible_chunk AS (
        SELECT chunk.*
        FROM app.review_rebuild_chunk_manifest chunk
        LEFT JOIN latest_request ON TRUE
        WHERE chunk.project_id IS NOT DISTINCT FROM ${getSqlLiteral(input.projectId)}
          AND (
            latest_request.request_id IS NULL
            OR chunk.request_id IS NULL
            OR chunk.request_id IS NOT DISTINCT FROM latest_request.request_id
          )
      ), classified_chunk AS (
        SELECT
          visible_chunk.*,
          CASE WHEN (${queuedPredicate}) THEN 1 ELSE 0 END AS queued,
          CASE WHEN (${claimablePredicate}) THEN 1 ELSE 0 END AS claimable
        FROM visible_chunk
      ), terminal_request AS (
        SELECT CAST(COUNT(*) AS INTEGER) AS failed_count
        FROM latest_request
        WHERE latest_request.status IN ('failed', 'quarantined')
          AND NOT EXISTS (
            SELECT 1
            FROM classified_chunk
            WHERE classified_chunk.claimable = 1
              AND (
                classified_chunk.request_id IS NULL
                OR classified_chunk.request_id IS NOT DISTINCT FROM latest_request.request_id
              )
          )
      ), rebuild_chunk AS (
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
          MIN(classified_chunk.created_at) FILTER (WHERE classified_chunk.queued = 1) AS oldestQueuedAt,
          MIN(classified_chunk.created_at) FILTER (WHERE classified_chunk.claimable = 1) AS oldestClaimableQueuedAt,
          MAX(classified_chunk.updated_at) FILTER (WHERE classified_chunk.status IN ('running', 'completed')) AS updatedAt
        FROM classified_chunk
        LEFT JOIN latest_request ON TRUE
      ), quarantine_state AS (
        SELECT
          CAST(COUNT(*) FILTER (WHERE status NOT IN (${getOutboxTerminalStatusList()})) AS INTEGER) AS unresolvedOutboxCount,
          CAST(COUNT(*) FILTER (WHERE status = 'quarantined') AS INTEGER) AS quarantinedOutboxCount,
          CAST(COUNT(*) FILTER (WHERE status NOT IN (${getOutboxTerminalStatusList()}) AND status <> 'quarantined') AS INTEGER) AS retryableOutboxCount
        FROM app.review_source_change_outbox
        WHERE source_partition IN (${getSqlStringList(partitions)})
      ), oldest_barrier AS (
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
      ), quarantined_cursor AS (
        SELECT CAST(COUNT(*) AS INTEGER) AS quarantinedCursorCount
        FROM app.review_delta_reconciliation_cursor
        WHERE source_partition IN (${getSqlStringList(partitions)})
          AND (status = 'quarantined' OR quarantined_at IS NOT NULL)
      )
      SELECT
        active_snapshot.snapshotId AS activeSnapshotSnapshotId,
        active_snapshot.lastKnownGoodSnapshotId AS activeSnapshotLastKnownGoodSnapshotId,
        active_snapshot.optionalComponentsJson AS activeSnapshotOptionalComponentsJson,
        active_snapshot.componentStateJson AS activeSnapshotComponentStateJson,
        active_snapshot.updatedAt AS activeSnapshotUpdatedAt,
        snapshot_status_counts.activeCount AS snapshotActiveCount,
        snapshot_status_counts.candidateCount AS snapshotCandidateCount,
        snapshot_status_counts.failedCount AS snapshotFailedCount,
        snapshot_status_counts.retiredCount AS snapshotRetiredCount,
        snapshot_status_counts.invalidCandidateCount AS snapshotInvalidCandidateCount,
        snapshot_status_counts.selectedImportIncompleteCandidateCount AS snapshotSelectedImportIncompleteCandidateCount,
        snapshot_status_counts.missingRequiredCandidateCount AS snapshotMissingRequiredCandidateCount,
        snapshot_status_counts.invalidRequiredStateCandidateCount AS snapshotInvalidRequiredStateCandidateCount,
        snapshot_status_counts.invalidOptionalStateCandidateCount AS snapshotInvalidOptionalStateCandidateCount,
        dirty_work.pendingCount AS dirtyWorkPendingCount,
        dirty_work.runningCount AS dirtyWorkRunningCount,
        dirty_work.failedCount AS dirtyWorkFailedCount,
        dirty_work.completedCount AS dirtyWorkCompletedCount,
        dirty_work.oldestQueuedAt AS dirtyWorkOldestQueuedAt,
        dirty_work.updatedAt AS dirtyWorkUpdatedAt,
        rebuild_chunk.pendingCount AS rebuildChunkPendingCount,
        rebuild_chunk.runningCount AS rebuildChunkRunningCount,
        rebuild_chunk.failedCount AS rebuildChunkFailedCount,
        rebuild_chunk.completedCount AS rebuildChunkCompletedCount,
        rebuild_chunk.claimableCount AS rebuildChunkClaimableCount,
        rebuild_chunk.blockedQueuedCount AS rebuildChunkBlockedQueuedCount,
        rebuild_chunk.blockedOverBudgetCount AS rebuildChunkBlockedOverBudgetCount,
        rebuild_chunk.quarantinedCount AS rebuildChunkQuarantinedCount,
        rebuild_chunk.expiredLeaseCount AS rebuildChunkExpiredLeaseCount,
        rebuild_chunk.oldestQueuedAt AS rebuildChunkOldestQueuedAt,
        rebuild_chunk.oldestClaimableQueuedAt AS rebuildChunkOldestClaimableQueuedAt,
        rebuild_chunk.updatedAt AS rebuildChunkUpdatedAt,
        quarantine_state.unresolvedOutboxCount AS unresolvedOutboxCount,
        quarantine_state.quarantinedOutboxCount AS quarantinedOutboxCount,
        quarantine_state.retryableOutboxCount AS retryableOutboxCount,
        oldest_barrier.outboxId AS oldestBarrierOutboxId,
        oldest_barrier.sourcePartition AS oldestBarrierSourcePartition,
        oldest_barrier.sourceHighWaterMark AS oldestBarrierSourceHighWaterMark,
        oldest_barrier.status AS oldestBarrierStatus,
        quarantined_cursor.quarantinedCursorCount AS quarantinedCursorCount
      FROM snapshot_status_counts
      CROSS JOIN dirty_work
      CROSS JOIN rebuild_chunk
      CROSS JOIN quarantine_state
      CROSS JOIN quarantined_cursor
      LEFT JOIN active_snapshot ON TRUE
      LEFT JOIN oldest_barrier ON TRUE
    `,
    input.workloadContext,
  )
}

const getDiagnosticsCountState = (
  row: DiagnosticsSummaryRow | undefined,
  prefix: 'dirtyWork' | 'rebuildChunk',
): ReviewServingDiagnosticsCountState => {
  if (row === undefined) {
    return emptyCountState
  }

  return {
    completedCount: Number(row[`${prefix}CompletedCount`]),
    failedCount: Number(row[`${prefix}FailedCount`]),
    oldestQueuedAt: row[`${prefix}OldestQueuedAt`],
    pendingCount: Number(row[`${prefix}PendingCount`]),
    runningCount: Number(row[`${prefix}RunningCount`]),
    updatedAt: row[`${prefix}UpdatedAt`],
  }
}

const getDiagnosticsRebuildChunkState = (row: DiagnosticsSummaryRow | undefined) => {
  return row === undefined
    ? emptyRebuildChunkState
    : {
        ...getDiagnosticsCountState(row, 'rebuildChunk'),
        blockedQueuedCount: Number(row.rebuildChunkBlockedQueuedCount),
        blockedOverBudgetCount: Number(row.rebuildChunkBlockedOverBudgetCount),
        claimableCount: Number(row.rebuildChunkClaimableCount),
        expiredLeaseCount: Number(row.rebuildChunkExpiredLeaseCount),
        oldestClaimableQueuedAt: row.rebuildChunkOldestClaimableQueuedAt,
        quarantinedCount: Number(row.rebuildChunkQuarantinedCount),
      }
}

const getDiagnosticsActiveSnapshot = (row: DiagnosticsSummaryRow | undefined): ActiveSnapshotRow | undefined => {
  return row === undefined || row.activeSnapshotSnapshotId === null
    ? undefined
    : {
        componentStateJson: row.activeSnapshotComponentStateJson,
        lastKnownGoodSnapshotId: row.activeSnapshotLastKnownGoodSnapshotId,
        optionalComponentsJson: row.activeSnapshotOptionalComponentsJson,
        snapshotId: row.activeSnapshotSnapshotId,
        updatedAt: row.activeSnapshotUpdatedAt,
      }
}

const getDiagnosticsSnapshot = (row: DiagnosticsSummaryRow | undefined): ReviewServingDiagnostics['snapshot'] => {
  const activeSnapshot = getDiagnosticsActiveSnapshot(row)

  return {
    activeCount: Number(row?.snapshotActiveCount ?? 0),
    activeSnapshotId: activeSnapshot?.snapshotId ?? null,
    activeUpdatedAt: activeSnapshot?.updatedAt ?? null,
    candidateCount: Number(row?.snapshotCandidateCount ?? 0),
    invalidCandidateReasons: {
      invalidOptionalStateCount: Number(row?.snapshotInvalidOptionalStateCandidateCount ?? 0),
      invalidRequiredStateCount: Number(row?.snapshotInvalidRequiredStateCandidateCount ?? 0),
      missingRequiredCount: Number(row?.snapshotMissingRequiredCandidateCount ?? 0),
      selectedImportIncompleteCount: Number(row?.snapshotSelectedImportIncompleteCandidateCount ?? 0),
    },
    invalidCandidateCount: Number(row?.snapshotInvalidCandidateCount ?? 0),
    failedCount: Number(row?.snapshotFailedCount ?? 0),
    lastKnownGoodSnapshotId: activeSnapshot?.lastKnownGoodSnapshotId ?? null,
    retiredCount: Number(row?.snapshotRetiredCount ?? 0),
  }
}

const getDiagnosticsOldestBarrier = (row: DiagnosticsSummaryRow | undefined): OldestBarrierRow | undefined => {
  return row === undefined || row.oldestBarrierOutboxId === null
    ? undefined
    : {
        outboxId: row.oldestBarrierOutboxId,
        sourceHighWaterMark: row.oldestBarrierSourceHighWaterMark,
        sourcePartition: row.oldestBarrierSourcePartition,
        status: row.oldestBarrierStatus,
      }
}

const getDiagnosticsQuarantine = (row: DiagnosticsSummaryRow | undefined): ReviewServingDiagnostics['quarantine'] => {
  return getQuarantineDiagnostics({
    oldestBarrier: getDiagnosticsOldestBarrier(row) as ReviewServingDiagnosticsQuarantineBarrier | undefined,
    quarantineState:
      row === undefined
        ? undefined
        : {
            quarantinedOutboxCount: Number(row.quarantinedOutboxCount),
            retryableOutboxCount: Number(row.retryableOutboxCount),
            unresolvedOutboxCount: Number(row.unresolvedOutboxCount),
          },
    quarantinedCursorCount:
      row === undefined ? undefined : {quarantinedCursorCount: Number(row.quarantinedCursorCount)},
  })
}

export const getReviewServingDiagnosticsEffect = (
  input: ReviewServingDiagnosticsInput,
  database: ReviewServingDiagnosticsDatabase = getDiagnosticsDatabase(),
) => {
  return Effect.gen(function* () {
    const [summaryRow] = yield* getDiagnosticsSummaryRowsEffect(input, database)
    const activeSnapshot = getDiagnosticsActiveSnapshot(summaryRow)
    const dirtyWork = getDiagnosticsCountState(summaryRow, 'dirtyWork')
    const rebuildChunks = getDiagnosticsRebuildChunkState(summaryRow)

    return {
      dirtyWork,
      maintenance: {
        dirtyWorkRunningCount: dirtyWork.runningCount,
        expiredRebuildChunkLeaseCount: rebuildChunks.expiredLeaseCount,
        rebuildChunkRunningCount: rebuildChunks.runningCount,
        requiredConsumerRole: 'maintenance-worker' as const,
      },
      projectId: input.projectId,
      quarantine: getDiagnosticsQuarantine(summaryRow),
      rebuildChunks,
      reviewConfigHash: input.reviewConfigHash ?? null,
      search: getSearchDiagnostics(activeSnapshot),
      snapshot: getDiagnosticsSnapshot(summaryRow),
    }
  })
}

export const getReviewServingDiagnostics = (
  input: ReviewServingDiagnosticsInput,
  database: ReviewServingDiagnosticsDatabase = getDiagnosticsDatabase(),
) => {
  return Effect.runPromise(getReviewServingDiagnosticsEffect(input, database))
}
