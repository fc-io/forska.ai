import {Elysia, t} from 'elysia'

import {getReviewServingSearchAvailabilityFromManifest} from '../../reviewServing/reviewServingTitleSearchProjector.ts'
import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString, getJsonValue, getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {getDuckdbMartMaintenanceService} from '../../services/getDuckdbMartMaintenanceService.ts'
import {
  type FreshMaintenanceWorkLeaseRecord,
  getMaintenanceWorkLeaseService,
} from '../../services/maintenanceWorkLeaseService.ts'
import {getProjectMartDirtyRefreshStateService} from '../../services/projectMartDirtyRefreshStateService.ts'
import {
  getProjectMartLargeRebuildRowsPerMs,
  getProjectMartLargeRebuildScopeProgress,
  isArticleScopedLargeRebuildPhase,
} from '../../services/projectMartLargeRebuildProgressService.ts'
import {getProjectVisibleJudgmentScopeSql} from '../../services/projectVisibleJudgmentRule.ts'
import {getDuckdbOwnerConnectionsOverview} from '../../utils/duckdbOwnerConnections.ts'
import {
  type DuckdbQueueRuntimeMetrics,
  type DuckdbTempSpillMetrics,
  getDuckdbQueueRuntimeMetricsSnapshot,
  getDuckdbTempSpillMetricsSnapshot,
} from '../../utils/duckdbService.ts'
import {shouldCurrentRuntimeRunMartRefreshDrain} from '../../utils/martRefreshDrainEligibility.ts'
import {getProjectMartLargeRebuildRuntimeMetrics} from '../../utils/projectMartLargeRebuildRuntimeMetrics.ts'
import {shouldCurrentServerRunMaintenanceLoops} from '../../utils/serverRuntimeRole.ts'
import {assertProjectIsActive} from './projectAccessGuard.ts'

type ReviewsIndexingBlockedReason = 'paused_by_policy' | 'quarantine_barrier' | 'waiting_for_maintenance_worker' | null
type ReviewsIndexingProgressState = 'blocked' | 'completed' | 'failed' | 'processing' | 'queued' | 'stalled'
type ReviewsIndexingStatus = 'blocked' | 'failed' | 'not-needed' | 'ready' | 'refreshing' | 'stale'
type ReviewsIndexingRecoveryMode = 'archived_project_mart_recovery' | 'none' | 'retry_backoff'
type ReviewsIndexingFreshnessStatus = 'fresh' | 'pending' | 'stale'

type ProjectMartRefreshStatus = 'blocked_by_quarantine' | 'failed' | 'idle' | 'paused' | 'running'

type RefreshCountInfo = {oldestQueuedAt: string | null; queuedRefreshCount: number}
type ProjectLargeRebuildProgress = {
  remainingCurrentPhaseArticleCount: number | null
  rowsPerMinute: number | null
  scopeArticleCount: number
}
type ProjectDirtyMaterializationSummary = {
  activeOwnerCount: number
  failedCount: number
  incompleteCount: number
  isActive: boolean
  lastProgressedAt: string | null
  oldestQueuedAt: string | null
  pendingCount: number
  runningCount: number
  unreconciledCount: number
}
type ProjectReviewIndexCleanup = {inFlightGenerationCleanupCount: number; lastProgressedAt: string | null}
type ProjectLargeRebuildRuntimeCycle = ReturnType<
  typeof getProjectMartLargeRebuildRuntimeMetrics
>['recentCycles'][number]
type ProjectLargeRebuildRuntimeCycleDiagnostic = {
  endedAt: string
  phase: string | null
  queueWaitMs: number | null
  rowsPerSecond: number | null
  rssBytes: number | null
  tempSpill: DuckdbTempSpillMetrics | null
}
type ProjectLargeRebuildRuntimePhaseDiagnostic = {
  committedRowCount: number
  cycleCount: number
  durationMs: number
  lastEndedAt: string | null
  lastRssBytes: number | null
  lastTempSpill: DuckdbTempSpillMetrics | null
  maxRssBytes: number | null
  maxTempSpillBytes: number | null
  phase: string | null
  queueWaitMs: number | null
  rowsPerSecond: number | null
}
type ReviewsRuntimeDiagnostics = {
  duckdbQueues: DuckdbQueueRuntimeMetrics
  largeRebuild: {
    currentPhase: ProjectLargeRebuildRuntimePhaseDiagnostic | null
    lastCycle: ProjectLargeRebuildRuntimeCycleDiagnostic | null
  }
  processMemory: {rssBytes: number}
  tempSpill: DuckdbTempSpillMetrics
}
type ReviewServingSearchDiagnostic = {
  availability: 'ready' | 'indexing' | 'unavailable' | 'async'
  optionalComponent: boolean
  snapshotId: string | null
}

type ProjectLargeRebuildState = {
  cursorArticleCreatedAt: string | null
  cursorArticleId: string | null
  lastError: string | null
  lastCompletedAt: string | null
  lastStartedAt: string | null
  leaseExpiresAt: string | null
  operatorNote: string | null
  refreshStatus: ProjectMartRefreshStatus | null
  rebuildPhase: string | null
  refreshToken: number | null
  updatedAt: string | null
  workerId: string | null
}

type QuarantinedArticleRefresh = {
  articleId: string
  createdAt: string | null
  detectedBy: string | null
  error: string
  updatedAt: string | null
}

const missingJudgmentFactRepairArticleLimit = 4

const getLargeRebuildDetails = (state: ProjectLargeRebuildState, progress: ProjectLargeRebuildProgress | null) => {
  return state.refreshToken === null || state.refreshToken <= 0
    ? null
    : {
        cursorArticleCreatedAt: state.cursorArticleCreatedAt,
        cursorArticleId: state.cursorArticleId,
        lastError: state.lastError,
        lastProgressedAt: state.updatedAt ?? state.lastCompletedAt,
        lastStartedAt: state.lastStartedAt,
        operatorNote: state.operatorNote,
        progress,
        rebuildPhase: state.rebuildPhase,
        refreshStatus: state.refreshStatus,
        refreshToken: state.refreshToken,
      }
}

const getRowsPerSecond = (rows: number, durationMs: number) => {
  return rows > 0 && durationMs > 0 ? Number((rows / (durationMs / 1000)).toFixed(2)) : null
}

const getMaxNullableNumber = (left: number | null, right: number | null) => {
  return left === null ? right : right === null ? left : Math.max(left, right)
}

const getNullableNumberSum = (values: Array<number | null>) => {
  return values.every((value) => {
    return value === null
  })
    ? null
    : values.reduce((sum, value) => {
        return sum + (value ?? 0)
      }, 0)
}

const getLargeRebuildRuntimeCycleDiagnostic = (
  cycle: ProjectLargeRebuildRuntimeCycle | null,
): ProjectLargeRebuildRuntimeCycleDiagnostic | null => {
  return cycle === null
    ? null
    : {
        endedAt: cycle.endedAt,
        phase: cycle.phase,
        queueWaitMs: cycle.queueWaitMs,
        rowsPerSecond: cycle.rowsPerSecond,
        rssBytes: cycle.processMemory.rssBytes,
        tempSpill: cycle.tempSpill,
      }
}

const getLargeRebuildRuntimePhaseDiagnostic = (
  phase: string | null,
  cycles: ProjectLargeRebuildRuntimeCycle[],
): ProjectLargeRebuildRuntimePhaseDiagnostic | null => {
  const [lastCycle = null] = cycles.slice(-1)
  const committedRowCount = cycles.reduce((sum, cycle) => {
    return sum + cycle.committedRowCount
  }, 0)
  const durationMs = cycles.reduce((sum, cycle) => {
    return sum + cycle.durationMs
  }, 0)
  const queueWaitMs = getNullableNumberSum(
    cycles.map((cycle) => {
      return cycle.queueWaitMs
    }),
  )
  const maxRssBytes = cycles.reduce<number | null>((maxValue, cycle) => {
    return getMaxNullableNumber(maxValue, cycle.processMemory.rssBytes)
  }, null)
  const maxTempSpillBytes = cycles.reduce<number | null>((maxValue, cycle) => {
    return getMaxNullableNumber(maxValue, cycle.tempSpill?.totalBytes ?? null)
  }, null)

  return cycles.length === 0
    ? null
    : {
        committedRowCount,
        cycleCount: cycles.length,
        durationMs,
        lastEndedAt: lastCycle?.endedAt ?? null,
        lastRssBytes: lastCycle?.processMemory.rssBytes ?? null,
        lastTempSpill: lastCycle?.tempSpill ?? null,
        maxRssBytes,
        maxTempSpillBytes,
        phase,
        queueWaitMs,
        rowsPerSecond: getRowsPerSecond(committedRowCount, durationMs),
      }
}

const getReviewsRuntimeDiagnostics = (
  projectId: string,
  state: ProjectLargeRebuildState,
): ReviewsRuntimeDiagnostics => {
  const projectMartLargeRebuildRuntimeMetrics = getProjectMartLargeRebuildRuntimeMetrics()
  const projectCycles = projectMartLargeRebuildRuntimeMetrics.recentCycles.filter((cycle) => {
    return cycle.projectId === projectId
  })
  const currentPhaseCycles = projectCycles.filter((cycle) => {
    return cycle.phase === state.rebuildPhase
  })
  const [lastProjectCycle = null] = projectCycles.slice(-1)
  const processMemory = process.memoryUsage()

  return {
    duckdbQueues: getDuckdbQueueRuntimeMetricsSnapshot(),
    largeRebuild: {
      currentPhase: getLargeRebuildRuntimePhaseDiagnostic(state.rebuildPhase, currentPhaseCycles),
      lastCycle: getLargeRebuildRuntimeCycleDiagnostic(lastProjectCycle),
    },
    processMemory: {rssBytes: processMemory.rss},
    tempSpill: getDuckdbTempSpillMetricsSnapshot(),
  }
}

type ProjectRefreshState = {
  dirtyMaterialization: ProjectDirtyMaterializationSummary
  dirtyToken: number | null
  freshnessStatus: ReviewsIndexingFreshnessStatus
  hasIncompleteDirtyMaterialization: boolean
  hasUnresolvedQuarantineBarrier: boolean
  isFresh: boolean
  lastCompletedAt: string | null
  lastCompletedDirtyToken: number | null
  lastRequestedAt: string | null
  lastStartedAt: string | null
  leaseExpiresAt: string | null
  refreshStatus: ProjectMartRefreshStatus | null
  unresolvedQuarantineBarrierCount: number
  updatedAt: string | null
  workerId: string | null
}

const getEnabledPromptCount = async (projectId: string): Promise<number> => {
  const rows = await getAppDatabaseService().queryJson<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.project_prompt
    WHERE project_id = '${escapeSqlString(projectId)}'
      AND enabled = TRUE
  `)

  return Number(rows[0]?.count ?? 0)
}

const getHasCuratedArticles = async (projectId: string): Promise<boolean> => {
  const rows = await getAppDatabaseService().queryJson<{articleId: string}>(`
    SELECT article_id AS articleId
    FROM app.project_article
    WHERE project_id = '${escapeSqlString(projectId)}'
    LIMIT 1
  `)

  return rows.length > 0
}

const getHasRouteArticles = async (projectId: string): Promise<boolean> => {
  const rows = await getAppDatabaseService().queryJson<{articleId: string}>(`
    SELECT air.article_id AS articleId
    FROM app.project_import_route pir
    INNER JOIN app.article_import_route air ON air.import_route_id = pir.import_route_id
    WHERE pir.project_id = '${escapeSqlString(projectId)}'
    LIMIT 1
  `)

  return rows.length > 0
}

const getEmptyDirtyMaterializationSummary = (): ProjectDirtyMaterializationSummary => {
  return {
    activeOwnerCount: 0,
    failedCount: 0,
    incompleteCount: 0,
    isActive: false,
    lastProgressedAt: null,
    oldestQueuedAt: null,
    pendingCount: 0,
    runningCount: 0,
    unreconciledCount: 0,
  }
}

const getRefreshFreshnessStatus = (params: {
  hasFailedMaterialization: boolean
  hasUnresolvedQuarantineBarrier: boolean
  isFresh: boolean
  refreshStatus: ProjectMartRefreshStatus | null
}): ReviewsIndexingFreshnessStatus => {
  return params.isFresh
    ? 'fresh'
    : params.hasUnresolvedQuarantineBarrier || params.hasFailedMaterialization || params.refreshStatus === 'failed'
      ? 'stale'
      : 'pending'
}

const getProjectRefreshState = async (projectId: string): Promise<ProjectRefreshState> => {
  const [row] = await getAppDatabaseService().queryJson<{
    activeMaterializationOwnerCount: number | null
    dirtyToken: number | null
    failedMaterializationCount: number | null
    incompleteMaterializationCount: number | null
    lastDirtyMaterializationProgressedAt: string | null
    lastCompletedAt: string | null
    lastCompletedDirtyToken: number | null
    lastRequestedAt: string | null
    lastStartedAt: string | null
    leaseExpiresAt: string | null
    oldestDirtyMaterializationQueuedAt: string | null
    pendingMaterializationCount: number | null
    refreshStatus: ProjectMartRefreshStatus | null
    runningMaterializationCount: number | null
    unresolvedQuarantineBarrierCount: number | null
    unreconciledMaterializationCount: number | null
    updatedAt: string | null
    workerId: string | null
  }>(`
    WITH refresh_state AS (
      SELECT
        project_id,
        dirty_token,
        last_completed_at,
        last_completed_dirty_token,
        last_requested_at,
        last_started_at,
        lease_expires_at,
        refresh_status,
        updated_at,
        worker_id
      FROM app.project_mart_refresh_state
      WHERE project_id = '${escapeSqlString(projectId)}'
      LIMIT 1
    ),
    materialization_summary AS (
      SELECT
        CAST(COUNT(*) FILTER (WHERE materialization.materialization_status <> 'completed') AS INTEGER) AS incompleteMaterializationCount,
        CAST(COUNT(*) FILTER (WHERE materialization.materialization_status = 'pending') AS INTEGER) AS pendingMaterializationCount,
        CAST(COUNT(*) FILTER (WHERE materialization.materialization_status = 'running') AS INTEGER) AS runningMaterializationCount,
        CAST(COUNT(*) FILTER (WHERE materialization.materialization_status = 'failed') AS INTEGER) AS failedMaterializationCount,
        CAST(COUNT(*) FILTER (WHERE materialization.materialization_status = 'unreconciled') AS INTEGER) AS unreconciledMaterializationCount,
        CAST(COUNT(DISTINCT materialization.materialization_owner) FILTER (
          WHERE materialization.materialization_status = 'running'
            AND materialization.materialization_owner IS NOT NULL
            AND materialization.lease_expires_at > current_timestamp
        ) AS INTEGER) AS activeMaterializationOwnerCount,
        MIN(COALESCE(materialization.last_started_at, materialization.created_at)) FILTER (
          WHERE materialization.materialization_status <> 'completed'
        ) AS oldestDirtyMaterializationQueuedAt,
        MAX(COALESCE(materialization.last_completed_at, materialization.updated_at)) FILTER (
          WHERE materialization.materialization_status = 'running'
             OR materialization.materialization_status = 'completed'
        ) AS lastDirtyMaterializationProgressedAt
      FROM app.project_mart_dirty_materialization_state materialization
      INNER JOIN refresh_state state ON state.project_id = materialization.project_id
      WHERE state.dirty_token IS NOT NULL
        AND materialization.target_dirty_token <= state.dirty_token
    ),
    quarantine_summary AS (
      SELECT CAST(COUNT(*) AS INTEGER) AS unresolvedQuarantineBarrierCount
      FROM app.project_mart_dirty_refresh_article_quarantine quarantine
      INNER JOIN refresh_state state ON state.project_id = quarantine.project_id
      WHERE state.dirty_token IS NOT NULL
        AND quarantine.dirty_token <= state.dirty_token
        AND quarantine.resolved_at IS NULL
    )
    SELECT
      CAST(dirty_token AS INTEGER) AS dirtyToken,
      last_completed_at AS lastCompletedAt,
      CAST(last_completed_dirty_token AS INTEGER) AS lastCompletedDirtyToken,
      last_requested_at AS lastRequestedAt,
      last_started_at AS lastStartedAt,
      lease_expires_at AS leaseExpiresAt,
      refresh_status AS refreshStatus,
      updated_at AS updatedAt,
      worker_id AS workerId,
      COALESCE(materialization_summary.incompleteMaterializationCount, 0) AS incompleteMaterializationCount,
      COALESCE(materialization_summary.pendingMaterializationCount, 0) AS pendingMaterializationCount,
      COALESCE(materialization_summary.runningMaterializationCount, 0) AS runningMaterializationCount,
      COALESCE(materialization_summary.failedMaterializationCount, 0) AS failedMaterializationCount,
      COALESCE(materialization_summary.unreconciledMaterializationCount, 0) AS unreconciledMaterializationCount,
      COALESCE(materialization_summary.activeMaterializationOwnerCount, 0) AS activeMaterializationOwnerCount,
      materialization_summary.oldestDirtyMaterializationQueuedAt AS oldestDirtyMaterializationQueuedAt,
      materialization_summary.lastDirtyMaterializationProgressedAt AS lastDirtyMaterializationProgressedAt,
      COALESCE(quarantine_summary.unresolvedQuarantineBarrierCount, 0) AS unresolvedQuarantineBarrierCount
    FROM refresh_state
    CROSS JOIN materialization_summary
    CROSS JOIN quarantine_summary
  `)

  const dirtyToken = row?.dirtyToken ?? null
  const failedMaterializationCount = Number(row?.failedMaterializationCount ?? 0)
  const incompleteMaterializationCount = Number(row?.incompleteMaterializationCount ?? 0)
  const lastCompletedDirtyToken = row?.lastCompletedDirtyToken ?? null
  const pendingMaterializationCount = Number(row?.pendingMaterializationCount ?? 0)
  const refreshStatus = row?.refreshStatus ?? null
  const runningMaterializationCount = Number(row?.runningMaterializationCount ?? 0)
  const unresolvedQuarantineBarrierCount = Number(row?.unresolvedQuarantineBarrierCount ?? 0)
  const unreconciledMaterializationCount = Number(row?.unreconciledMaterializationCount ?? 0)
  const hasIncompleteDirtyMaterialization = incompleteMaterializationCount > 0
  const hasUnresolvedQuarantineBarrier = unresolvedQuarantineBarrierCount > 0
  const isFresh =
    dirtyToken === null
    || (!hasIncompleteDirtyMaterialization
      && !hasUnresolvedQuarantineBarrier
      && lastCompletedDirtyToken !== null
      && lastCompletedDirtyToken >= dirtyToken)
  const dirtyMaterialization = row
    ? {
        activeOwnerCount: Number(row.activeMaterializationOwnerCount ?? 0),
        failedCount: failedMaterializationCount,
        incompleteCount: incompleteMaterializationCount,
        isActive: Number(row.activeMaterializationOwnerCount ?? 0) > 0,
        lastProgressedAt: row.lastDirtyMaterializationProgressedAt ?? null,
        oldestQueuedAt: row.oldestDirtyMaterializationQueuedAt ?? null,
        pendingCount: pendingMaterializationCount,
        runningCount: runningMaterializationCount,
        unreconciledCount: unreconciledMaterializationCount,
      }
    : getEmptyDirtyMaterializationSummary()

  return {
    dirtyMaterialization,
    dirtyToken,
    freshnessStatus: getRefreshFreshnessStatus({
      hasFailedMaterialization: failedMaterializationCount > 0 || unreconciledMaterializationCount > 0,
      hasUnresolvedQuarantineBarrier,
      isFresh,
      refreshStatus,
    }),
    hasIncompleteDirtyMaterialization,
    hasUnresolvedQuarantineBarrier,
    isFresh,
    lastCompletedAt: row?.lastCompletedAt ?? null,
    lastCompletedDirtyToken,
    lastRequestedAt: row?.lastRequestedAt ?? null,
    lastStartedAt: row?.lastStartedAt ?? null,
    leaseExpiresAt: row?.leaseExpiresAt ?? null,
    refreshStatus,
    unresolvedQuarantineBarrierCount,
    updatedAt: row?.updatedAt ?? null,
    workerId: row?.workerId ?? null,
  }
}

const getProjectLargeRebuildState = async (projectId: string): Promise<ProjectLargeRebuildState> => {
  const [row] = await getAppDatabaseService().queryJson<{
    cursorArticleCreatedAt: string | null
    cursorArticleId: string | null
    lastError: string | null
    lastCompletedAt: string | null
    lastStartedAt: string | null
    leaseExpiresAt: string | null
    operatorNote: string | null
    rebuildPhase: string | null
    refreshStatus: ProjectMartRefreshStatus | null
    refreshToken: number | null
    updatedAt: string | null
    workerId: string | null
  }>(`
    SELECT
      cursor_article_created_at AS cursorArticleCreatedAt,
      cursor_article_id AS cursorArticleId,
      last_error AS lastError,
      last_completed_at AS lastCompletedAt,
      last_started_at AS lastStartedAt,
      lease_expires_at AS leaseExpiresAt,
      operator_note AS operatorNote,
      rebuild_phase AS rebuildPhase,
      refresh_status AS refreshStatus,
      CAST(refresh_token AS INTEGER) AS refreshToken,
      updated_at AS updatedAt,
      worker_id AS workerId
    FROM app.project_mart_large_rebuild_state
    WHERE project_id = '${escapeSqlString(projectId)}'
    LIMIT 1
  `)

  return {
    cursorArticleCreatedAt: row?.cursorArticleCreatedAt ?? null,
    cursorArticleId: row?.cursorArticleId ?? null,
    lastError: row?.lastError ?? null,
    lastCompletedAt: row?.lastCompletedAt ?? null,
    lastStartedAt: row?.lastStartedAt ?? null,
    leaseExpiresAt: row?.leaseExpiresAt ?? null,
    operatorNote: row?.operatorNote ?? null,
    rebuildPhase: row?.rebuildPhase ?? null,
    refreshStatus: row?.refreshStatus ?? null,
    refreshToken: row?.refreshToken ?? null,
    updatedAt: row?.updatedAt ?? null,
    workerId: row?.workerId ?? null,
  }
}

const getReviewServingSearchDiagnostic = async (projectId: string): Promise<ReviewServingSearchDiagnostic> => {
  const [row] = await getAppDatabaseService().queryJson<{
    componentStateJson: unknown
    optionalComponentsJson: unknown
    snapshotId: string
  }>(`
    SELECT
      snapshot_id AS snapshotId,
      component_state_json AS componentStateJson,
      optional_components_json AS optionalComponentsJson
    FROM app.review_serving_snapshot_manifest
    WHERE project_id = ${getSqlLiteral(projectId)}
      AND snapshot_status = 'active'
    ORDER BY activated_at DESC NULLS LAST, updated_at DESC
    LIMIT 1
  `)
  const optionalComponents = (getJsonValue(row?.optionalComponentsJson ?? []) as readonly string[]) ?? []
  const componentState = getJsonValue(row?.componentStateJson ?? {}) as {optional?: Array<{component?: string}>}
  const optionalSearchStatePresent = (componentState.optional ?? []).some((state) => {
    return state.component === 'search'
  })

  return {
    availability: getReviewServingSearchAvailabilityFromManifest({
      hasActiveSnapshot: row !== undefined,
      optionalComponents,
      optionalSearchStatePresent,
    }),
    optionalComponent: optionalComponents.includes('search'),
    snapshotId: row?.snapshotId ?? null,
  }
}

const getPendingArticleRefreshInfo = async (projectId: string): Promise<RefreshCountInfo> => {
  const projectLiteral = getSqlLiteral(projectId)
  const rows = await getAppDatabaseService().queryJson<{oldestQueuedAt: string | null; queuedRefreshCount: number}>(`
    WITH pending_article_state AS (
      SELECT
        article_state.article_id AS articleId,
        article_state.updated_at AS updatedAt
      FROM app.project_mart_refresh_article_state article_state
      LEFT JOIN app.project_mart_refresh_state refresh_state
        ON refresh_state.project_id = article_state.project_id
      LEFT JOIN app.project_mart_dirty_refresh_article_quarantine quarantine
        ON quarantine.project_id = article_state.project_id
        AND quarantine.article_id = article_state.article_id
        AND quarantine.resolved_at IS NULL
      WHERE article_state.project_id = ${projectLiteral}
        AND quarantine.project_id IS NULL
        AND (
          refresh_state.project_id IS NULL
          OR refresh_state.last_completed_dirty_token IS NULL
          OR CAST(article_state.last_dirty_token AS BIGINT) > CAST(refresh_state.last_completed_dirty_token AS BIGINT)
        )
    ),
    scoped_pending_article AS (
      SELECT
        pending.articleId,
        pending.updatedAt
      FROM pending_article_state pending
      INNER JOIN app.project_article project_article
        ON project_article.project_id = ${projectLiteral}
       AND project_article.article_id = pending.articleId
      UNION
      SELECT
        pending.articleId,
        pending.updatedAt
      FROM pending_article_state pending
      INNER JOIN app.article_import_route article_import_route
        ON article_import_route.article_id = pending.articleId
      INNER JOIN app.project_import_route project_import_route
        ON project_import_route.import_route_id = article_import_route.import_route_id
       AND project_import_route.project_id = ${projectLiteral}
    )
    SELECT
      MIN(scoped_pending_article.updatedAt) AS oldestQueuedAt,
      COUNT(*) AS queuedRefreshCount
    FROM scoped_pending_article
  `)
  const [row] = rows

  return {oldestQueuedAt: row?.oldestQueuedAt ?? null, queuedRefreshCount: Number(row?.queuedRefreshCount ?? 0)}
}

const getTimestampValue = (value: Date | string | null) => {
  return value instanceof Date ? value.toISOString() : value
}

const getQuarantinedArticleRefreshes = async (projectId: string): Promise<QuarantinedArticleRefresh[]> => {
  const rows = await getProjectMartDirtyRefreshStateService().getQuarantinedArticlesForProject({projectId})

  return rows.map((row) => {
    return {
      articleId: row.articleId,
      createdAt: getTimestampValue(row.createdAt),
      detectedBy: row.detectedBy,
      error: row.error,
      updatedAt: getTimestampValue(row.updatedAt),
    }
  })
}

const getLargeRebuildProgress = async (
  projectId: string,
  state: ProjectLargeRebuildState,
): Promise<ProjectLargeRebuildProgress> => {
  const scopeProgress = await getProjectMartLargeRebuildScopeProgress({projectId, state})
  const rowsPerMs = getProjectMartLargeRebuildRowsPerMs({projectId, rebuildPhase: state.rebuildPhase})

  return {
    remainingCurrentPhaseArticleCount: isArticleScopedLargeRebuildPhase(state.rebuildPhase)
      ? scopeProgress.remainingCurrentPhaseArticleCount
      : null,
    rowsPerMinute: rowsPerMs === null ? null : Math.round(rowsPerMs * 60 * 1000),
    scopeArticleCount: scopeProgress.scopeArticleCount,
  }
}

const getLatestTimestamp = (...values: Array<string | null>) => {
  const timestampValues = values.filter((value): value is string => {
    return typeof value === 'string' && value !== ''
  })

  return timestampValues.reduce<string | null>((latestValue, value) => {
    if (latestValue === null) {
      return value
    }

    return new Date(value).getTime() > new Date(latestValue).getTime() ? value : latestValue
  }, null)
}

const getOldestQueuedAt = (...values: Array<string | null>) => {
  const queuedAtValues = values.filter((value): value is string => {
    return typeof value === 'string' && value !== ''
  })

  return queuedAtValues.reduce<string | null>((oldestValue, value) => {
    if (oldestValue === null) {
      return value
    }

    return new Date(value).getTime() < new Date(oldestValue).getTime() ? value : oldestValue
  }, null)
}

const getHasReviewServingRows = async (projectId: string): Promise<boolean> => {
  const rows = await getAppDatabaseService().queryJson<{projectId: string}>(`
    SELECT generation.project_id AS projectId
    FROM app.project_review_serving_generation generation
    LEFT JOIN app.project_mart_refresh_state refresh_state
      ON refresh_state.project_id = generation.project_id
    INNER JOIN mart.review_article_serving serving
      ON serving.project_id = generation.project_id
     AND serving.generation = generation.active_generation
    WHERE generation.project_id = '${escapeSqlString(projectId)}'
      AND (
        refresh_state.project_id IS NULL
        OR CAST(refresh_state.dirty_token AS BIGINT) <= CAST(refresh_state.last_completed_dirty_token AS BIGINT)
      )
    LIMIT 1
  `)

  return rows.length > 0
}

const getMissingVisibleJudgmentFactArticleIds = async (projectId: string): Promise<string[]> => {
  const projectLiteral = getSqlLiteral(projectId)
  const rows = await getAppDatabaseService().queryJson<{articleId: string}>(`
    SELECT judgment.article_id AS articleId
    FROM mart.project_scope_article scope_article
    INNER JOIN app.project project
      ON project.id = scope_article.project_id
     AND project.archived = FALSE
    INNER JOIN app.project_prompt project_prompt
      ON project_prompt.project_id = scope_article.project_id
     AND project_prompt.enabled = TRUE
    INNER JOIN app.judgment judgment
      ON ${getProjectVisibleJudgmentScopeSql({
        judgmentAlias: 'judgment',
        projectAlias: 'project',
        projectPromptAlias: 'project_prompt',
        projectScopeAlias: 'scope_article',
      })}
    LEFT JOIN mart.judgment_fact judgment_fact ON judgment_fact.judgment_id = judgment.id
    WHERE scope_article.project_id = ${projectLiteral}
      AND judgment.deleted_at IS NULL
      AND judgment_fact.judgment_id IS NULL
    GROUP BY judgment.article_id
    ORDER BY judgment.article_id ASC
    LIMIT ${missingJudgmentFactRepairArticleLimit}
  `)

  return rows.map((row) => {
    return row.articleId
  })
}

const queueMissingVisibleJudgmentFactRepair = async (projectId: string): Promise<void> => {
  const [projectRefreshState, projectLargeRebuildState] = await Promise.all([
    getProjectRefreshState(projectId),
    getProjectLargeRebuildState(projectId),
  ])
  const hasLargeRebuild = projectLargeRebuildState.refreshToken !== null && projectLargeRebuildState.refreshToken > 0

  if (!projectRefreshState.isFresh || hasLargeRebuild) {
    return
  }

  const articleIds = await getMissingVisibleJudgmentFactArticleIds(projectId)

  if (articleIds.length === 0) {
    return
  }

  await getProjectMartDirtyRefreshStateService().markProjectsDirtyAtomically({
    projects: [{articleIds, projectId}],
    reason: 'missingVisibleJudgmentFacts',
    requestedBy: 'reviews-warnings',
  })
}

const getReviewIndexingBlockedReason = (params: {
  canRunMartRefreshDrain: boolean
  canRunMaintenanceWork: boolean
  hasUnresolvedQuarantineBarrier: boolean
  pendingRefreshCount: number
}): ReviewsIndexingBlockedReason => {
  return params.hasUnresolvedQuarantineBarrier
    ? 'quarantine_barrier'
    : params.pendingRefreshCount === 0 || (params.canRunMaintenanceWork && params.canRunMartRefreshDrain)
      ? null
      : params.canRunMaintenanceWork
        ? 'paused_by_policy'
        : 'waiting_for_maintenance_worker'
}

const getMaintenanceConsumerAvailability = async () => {
  const registry = (await getDuckdbOwnerConnectionsOverview()).registry
  const maintenance = registry.capabilities.find((capability) => {
    return capability.capability === 'maintenance'
  })

  return {
    canRunMaintenanceWork: (maintenance?.freshConsumerCount ?? 0) > 0,
    canRunMartRefreshDrain: (maintenance?.eligibleConsumerCount ?? 0) > 0,
    eligibleConsumerCount: maintenance?.eligibleConsumerCount ?? 0,
    eligibleConsumerPresent: maintenance?.eligibleConsumerPresent ?? false,
  }
}

const getNonNegativeDifference = (total: number, claimed: number) => {
  return Math.max(0, total - claimed)
}

const getFreshMaintenanceLeaseCount = (
  leases: FreshMaintenanceWorkLeaseRecord[],
  workKind: FreshMaintenanceWorkLeaseRecord['workKind'],
) => {
  return leases.filter((lease) => {
    return lease.workKind === workKind
  }).length
}

const getFreshMaintenanceLeases = (
  leases: FreshMaintenanceWorkLeaseRecord[],
  workKind: FreshMaintenanceWorkLeaseRecord['workKind'],
) => {
  return leases.filter((lease) => {
    return lease.workKind === workKind
  })
}

const getFreshArticleRefreshLeaseCount = (leases: FreshMaintenanceWorkLeaseRecord[]) => {
  return getUniqueCount(
    leases
      .filter((lease) => {
        return lease.workKind === 'review_index_article_refresh'
      })
      .map((lease) => {
        return lease.articleId
      }),
  )
}

const getUniqueCount = (values: Array<string | null>) => {
  return new Set(
    values.filter((value): value is string => {
      return value !== null && value !== ''
    }),
  ).size
}

const getActiveConsumerCount = (params: {
  activeDirtyMaterializationOwnerCount: number
  freshMaintenanceLeases: FreshMaintenanceWorkLeaseRecord[]
  isLargeRebuildRunning: boolean
  isProjectRunning: boolean
  projectLargeRebuildState: ProjectLargeRebuildState
  projectRefreshState: ProjectRefreshState
}) => {
  return getUniqueCount([
    ...params.freshMaintenanceLeases.map((lease) => {
      return lease.consumerId
    }),
    ...Array.from({length: params.activeDirtyMaterializationOwnerCount}, (_, index) => {
      return `dirty-materialization-owner-${index}`
    }),
    params.isProjectRunning ? params.projectRefreshState.workerId : null,
    params.isLargeRebuildRunning ? params.projectLargeRebuildState.workerId : null,
  ])
}

const getHasActiveLease = (leaseExpiresAt: string | null, now: Date) => {
  return leaseExpiresAt !== null && new Date(leaseExpiresAt) > now
}

const getReviewsIndexingStatus = (params: {
  activeWorkCount: number
  enabledPromptCount: number
  hasFailedRefresh: boolean
  hasAnyArticlesInScope: boolean
  hasReviewRollupRows: boolean
  hasUnresolvedQuarantineBarrier: boolean
  eligibleConsumerPresent: boolean
  pendingRefreshCount: number
}): ReviewsIndexingStatus => {
  const shouldIndexReviews = params.enabledPromptCount > 0 && params.hasAnyArticlesInScope

  return !shouldIndexReviews
    ? 'not-needed'
    : params.hasFailedRefresh
      ? 'failed'
      : params.hasUnresolvedQuarantineBarrier
        ? 'blocked'
        : params.pendingRefreshCount > 0 && params.activeWorkCount === 0 && !params.eligibleConsumerPresent
          ? 'blocked'
          : params.pendingRefreshCount > 0
            ? 'refreshing'
            : params.hasReviewRollupRows
              ? 'ready'
              : 'stale'
}

const getReviewsIndexingProgressState = (params: {
  inFlightRefreshCount: number
  status: ReviewsIndexingStatus
}): ReviewsIndexingProgressState => {
  return params.status === 'ready' || params.status === 'not-needed'
    ? 'completed'
    : params.status === 'failed'
      ? 'failed'
      : params.status === 'blocked'
        ? 'blocked'
        : params.status === 'refreshing' && params.inFlightRefreshCount > 0
          ? 'processing'
          : params.status === 'refreshing'
            ? 'queued'
            : 'stalled'
}

export const projectsRoutesGetReviewsWarnings = new Elysia().post(
  '/api/projectsreviewswarnings',
  async ({body}) => {
    const projectId = body.projectId
    await assertProjectIsActive(projectId)
    await queueMissingVisibleJudgmentFactRepair(projectId)
    const martRefreshService = getDuckdbMartMaintenanceService()
    const throughputSnapshot = martRefreshService.getThroughputSnapshot()
    const currentNow = new Date()
    const [
      enabledPromptCount,
      hasCuratedArticles,
      hasRouteArticles,
      projectRefreshState,
      projectLargeRebuildState,
      pendingArticleRefreshInfo,
      quarantinedArticleRefreshes,
      hasReviewServingRows,
      freshMaintenanceLeases,
      maintenanceRecoveryContext,
      maintenanceConsumerAvailability,
      searchDiagnostic,
    ] = await Promise.all([
      getEnabledPromptCount(projectId),
      getHasCuratedArticles(projectId),
      getHasRouteArticles(projectId),
      getProjectRefreshState(projectId),
      getProjectLargeRebuildState(projectId),
      getPendingArticleRefreshInfo(projectId),
      getQuarantinedArticleRefreshes(projectId),
      getHasReviewServingRows(projectId),
      getMaintenanceWorkLeaseService().getFreshProjectMaintenanceWorkLeases(projectId, currentNow),
      getMaintenanceWorkLeaseService().getProjectMaintenanceRecoveryContext(projectId, currentNow),
      getMaintenanceConsumerAvailability(),
      getReviewServingSearchDiagnostic(projectId),
    ])
    const freshArticleRefreshLeaseCount = getFreshArticleRefreshLeaseCount(freshMaintenanceLeases)
    const freshProjectRefreshLeaseCount = getFreshMaintenanceLeaseCount(
      freshMaintenanceLeases,
      'review_index_project_refresh',
    )
    const freshLargeRebuildLeaseCount = getFreshMaintenanceLeaseCount(
      freshMaintenanceLeases,
      'review_index_large_rebuild',
    )
    const freshGenerationCleanupLeases = getFreshMaintenanceLeases(
      freshMaintenanceLeases,
      'review_index_serving_generation_cleanup',
    )
    const freshGenerationCleanupLeaseCount = freshGenerationCleanupLeases.length
    const reviewIndexCleanup: ProjectReviewIndexCleanup = {
      inFlightGenerationCleanupCount: freshGenerationCleanupLeaseCount,
      lastProgressedAt: getLatestTimestamp(
        ...freshGenerationCleanupLeases.map((lease) => {
          return lease.lastProgressedAt
        }),
      ),
    }
    const hasActiveProjectLease =
      getHasActiveLease(projectRefreshState.leaseExpiresAt, currentNow) || freshProjectRefreshLeaseCount > 0
    const hasActiveLargeRebuildLease =
      getHasActiveLease(projectLargeRebuildState.leaseExpiresAt, currentNow) || freshLargeRebuildLeaseCount > 0
    const hasLargeRebuild = projectLargeRebuildState.refreshToken !== null && projectLargeRebuildState.refreshToken > 0
    const largeRebuildProgress = hasLargeRebuild
      ? await getLargeRebuildProgress(projectId, projectLargeRebuildState)
      : null
    const isLargeRebuildRunning = projectLargeRebuildState.refreshStatus === 'running' && hasActiveLargeRebuildLease
    const isLargeRebuildQueued = hasLargeRebuild && projectLargeRebuildState.refreshStatus === 'idle'
    const isLargeRebuildFailed = projectLargeRebuildState.refreshStatus === 'failed'
    const canRunMaintenanceWork =
      maintenanceConsumerAvailability.canRunMaintenanceWork || shouldCurrentServerRunMaintenanceLoops()
    const canRunMartRefreshDrain =
      maintenanceConsumerAvailability.canRunMartRefreshDrain
      || (shouldCurrentServerRunMaintenanceLoops() && shouldCurrentRuntimeRunMartRefreshDrain())
    const eligibleConsumerPresent = maintenanceConsumerAvailability.eligibleConsumerPresent || canRunMartRefreshDrain
    const isProjectRunning =
      freshProjectRefreshLeaseCount > 0
      || projectRefreshState.dirtyMaterialization.isActive
      || (!projectRefreshState.isFresh && projectRefreshState.refreshStatus === 'running' && hasActiveProjectLease)
    const rawInFlightProjectRefreshCount = isProjectRunning ? 1 : isLargeRebuildRunning ? 1 : 0
    const inFlightProjectRefreshCount = rawInFlightProjectRefreshCount
    const queuedProjectRefreshCount =
      projectRefreshState.isFresh && !hasLargeRebuild && !isProjectRunning
        ? 0
        : isLargeRebuildQueued
          ? 1
          : getNonNegativeDifference(1, inFlightProjectRefreshCount)
    const rawInFlightArticleRefreshCount =
      freshArticleRefreshLeaseCount > 0
        ? freshArticleRefreshLeaseCount
        : isProjectRunning
          ? pendingArticleRefreshInfo.queuedRefreshCount
          : 0
    const inFlightArticleRefreshCount = rawInFlightArticleRefreshCount
    const queuedArticleRefreshCount =
      freshArticleRefreshLeaseCount > 0
        ? getNonNegativeDifference(pendingArticleRefreshInfo.queuedRefreshCount, freshArticleRefreshLeaseCount)
        : isProjectRunning
          ? 0
          : pendingArticleRefreshInfo.queuedRefreshCount
    const pendingProjectRefreshCount = queuedProjectRefreshCount + inFlightProjectRefreshCount
    const pendingArticleRefreshCount = queuedArticleRefreshCount + inFlightArticleRefreshCount
    const queuedRefreshCount = queuedProjectRefreshCount + queuedArticleRefreshCount
    const inFlightRefreshCount = inFlightProjectRefreshCount + inFlightArticleRefreshCount
    const hasAnyArticlesInScope = hasCuratedArticles || hasRouteArticles
    const pendingRefreshCount = pendingProjectRefreshCount + pendingArticleRefreshCount
    const activeWorkCount = inFlightRefreshCount
    const rawBlockedReason = getReviewIndexingBlockedReason({
      canRunMaintenanceWork,
      canRunMartRefreshDrain,
      hasUnresolvedQuarantineBarrier: projectRefreshState.hasUnresolvedQuarantineBarrier,
      pendingRefreshCount,
    })
    const hasFailedRefresh =
      (!projectRefreshState.isFresh && projectRefreshState.refreshStatus === 'failed')
      || projectRefreshState.dirtyMaterialization.failedCount > 0
      || projectRefreshState.dirtyMaterialization.unreconciledCount > 0
      || isLargeRebuildFailed
    const indexingStatus = getReviewsIndexingStatus({
      activeWorkCount,
      enabledPromptCount,
      eligibleConsumerPresent,
      hasFailedRefresh,
      hasAnyArticlesInScope,
      hasReviewRollupRows: hasReviewServingRows,
      hasUnresolvedQuarantineBarrier: projectRefreshState.hasUnresolvedQuarantineBarrier,
      pendingRefreshCount,
    })
    const blockedReason = indexingStatus === 'blocked' ? rawBlockedReason : null
    const activeConsumerCount = getActiveConsumerCount({
      activeDirtyMaterializationOwnerCount: projectRefreshState.dirtyMaterialization.activeOwnerCount,
      freshMaintenanceLeases,
      isLargeRebuildRunning,
      isProjectRunning,
      projectLargeRebuildState,
      projectRefreshState,
    })

    return {
      data: {
        projectId,
        enabledPromptCount,
        scope: {hasAnyArticlesInScope},
        indexing: {
          activeConsumerCount,
          activeWorkCount,
          articleRefreshesPerMinute: throughputSnapshot.articleRefreshesPerMinute,
          blockedReason,
          cleanup: reviewIndexCleanup,
          diagnostics: getReviewsRuntimeDiagnostics(projectId, projectLargeRebuildState),
          dirtyMaterialization: projectRefreshState.dirtyMaterialization,
          eligibleConsumerCount: Math.max(
            maintenanceConsumerAvailability.eligibleConsumerCount,
            eligibleConsumerPresent ? 1 : 0,
          ),
          eligibleConsumerPresent,
          freshness: {
            dirtyToken: projectRefreshState.dirtyToken,
            hasIncompleteDirtyMaterialization: projectRefreshState.hasIncompleteDirtyMaterialization,
            hasUnresolvedQuarantineBarrier: projectRefreshState.hasUnresolvedQuarantineBarrier,
            isFresh: projectRefreshState.isFresh,
            lastCompletedDirtyToken: projectRefreshState.lastCompletedDirtyToken,
            refreshStatus: projectRefreshState.refreshStatus,
            status: projectRefreshState.freshnessStatus,
            unresolvedQuarantineBarrierCount: projectRefreshState.unresolvedQuarantineBarrierCount,
          },
          inFlightArticleRefreshCount,
          inFlightProjectRefreshCount,
          inFlightRefreshCount,
          largeRebuild: getLargeRebuildDetails(projectLargeRebuildState, largeRebuildProgress),
          lastProgressedAt: getLatestTimestamp(
            projectRefreshState.lastCompletedAt,
            isProjectRunning ? projectRefreshState.updatedAt : null,
            projectRefreshState.dirtyMaterialization.lastProgressedAt,
            projectLargeRebuildState.lastCompletedAt,
            isLargeRebuildRunning ? projectLargeRebuildState.updatedAt : null,
            ...freshMaintenanceLeases.map((lease) => {
              return lease.lastProgressedAt
            }),
          ),
          lastProcessedAt: getLatestTimestamp(
            projectRefreshState.lastCompletedAt,
            projectLargeRebuildState.lastCompletedAt,
          ),
          lastStartedAt: getLatestTimestamp(
            projectRefreshState.lastStartedAt,
            projectLargeRebuildState.lastStartedAt,
            ...freshMaintenanceLeases.map((lease) => {
              return lease.lastStartedAt
            }),
          ),
          oldestQueuedAt: getOldestQueuedAt(
            projectRefreshState.isFresh ? null : projectRefreshState.lastRequestedAt,
            projectRefreshState.dirtyMaterialization.oldestQueuedAt,
            pendingArticleRefreshInfo.oldestQueuedAt,
          ),
          pendingArticleRefreshCount,
          pendingProjectRefreshCount,
          pendingRefreshCount,
          projectRefreshesPerMinute: throughputSnapshot.projectRefreshesPerMinute,
          queuedArticleRefreshCount,
          queuedProjectRefreshCount,
          queuedRefreshCount,
          quarantinedArticleRefreshCount: quarantinedArticleRefreshes.length,
          quarantinedArticles: quarantinedArticleRefreshes,
          progressState: getReviewsIndexingProgressState({inFlightRefreshCount, status: indexingStatus}),
          recoveryContext: maintenanceRecoveryContext?.recoveryContext ?? null,
          recoveryMode: (maintenanceRecoveryContext?.recoveryMode ?? 'none') as ReviewsIndexingRecoveryMode,
          requiredConsumerRole: 'maintenance-worker',
          retryAfterAt: maintenanceRecoveryContext?.retryAfterAt ?? null,
          search: searchDiagnostic,
          status: indexingStatus,
        },
      },
    }
  },
  {body: t.Object({projectId: t.String()})},
)
