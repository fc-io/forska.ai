import {Elysia, t} from 'elysia'

import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString, getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {getDuckdbMartRefreshService} from '../../services/getDuckdbMartRefreshService.ts'
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

type ReviewsIndexingBlockedReason = 'paused_by_policy' | 'waiting_for_maintenance_worker' | null
type ReviewsIndexingProgressState = 'blocked' | 'completed' | 'failed' | 'processing' | 'queued' | 'stalled'
type ReviewsIndexingStatus = 'blocked' | 'failed' | 'not-needed' | 'ready' | 'refreshing' | 'stale'
type ReviewsIndexingRecoveryMode = 'archived_project_mart_recovery' | 'none' | 'retry_backoff'

type ProjectMartRefreshStatus = 'failed' | 'idle' | 'paused' | 'running'

type RefreshCountInfo = {oldestQueuedAt: string | null; queuedRefreshCount: number}
type ProjectLargeRebuildProgress = {
  remainingCurrentPhaseArticleCount: number | null
  rowsPerMinute: number | null
  scopeArticleCount: number
}
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
  dirtyToken: number | null
  isFresh: boolean
  lastCompletedAt: string | null
  lastCompletedDirtyToken: number | null
  lastRequestedAt: string | null
  lastStartedAt: string | null
  leaseExpiresAt: string | null
  refreshStatus: ProjectMartRefreshStatus | null
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

const getProjectRefreshState = async (projectId: string): Promise<ProjectRefreshState> => {
  const [row] = await getAppDatabaseService().queryJson<{
    dirtyToken: number | null
    lastCompletedAt: string | null
    lastCompletedDirtyToken: number | null
    lastRequestedAt: string | null
    lastStartedAt: string | null
    leaseExpiresAt: string | null
    refreshStatus: ProjectMartRefreshStatus | null
    updatedAt: string | null
    workerId: string | null
  }>(`
    SELECT
      CAST(dirty_token AS INTEGER) AS dirtyToken,
      last_completed_at AS lastCompletedAt,
      CAST(last_completed_dirty_token AS INTEGER) AS lastCompletedDirtyToken,
      last_requested_at AS lastRequestedAt,
      last_started_at AS lastStartedAt,
      lease_expires_at AS leaseExpiresAt,
      refresh_status AS refreshStatus,
      updated_at AS updatedAt,
      worker_id AS workerId
    FROM app.project_mart_refresh_state
    WHERE project_id = '${escapeSqlString(projectId)}'
    LIMIT 1
  `)

  const dirtyToken = row?.dirtyToken ?? null
  const lastCompletedDirtyToken = row?.lastCompletedDirtyToken ?? null
  const refreshStatus = row?.refreshStatus ?? null
  const isFresh = dirtyToken === null || (lastCompletedDirtyToken !== null && lastCompletedDirtyToken >= dirtyToken)

  return {
    dirtyToken,
    isFresh,
    lastCompletedAt: row?.lastCompletedAt ?? null,
    lastCompletedDirtyToken,
    lastRequestedAt: row?.lastRequestedAt ?? null,
    lastStartedAt: row?.lastStartedAt ?? null,
    leaseExpiresAt: row?.leaseExpiresAt ?? null,
    refreshStatus,
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

const getPendingArticleRefreshInfo = async (projectId: string): Promise<RefreshCountInfo> => {
  const rows = await getAppDatabaseService().queryJson<{oldestQueuedAt: string | null; queuedRefreshCount: number}>(`
    WITH scoped_article AS (
      SELECT article_id AS articleId
      FROM app.project_article
      WHERE project_id = '${escapeSqlString(projectId)}'
      UNION
      SELECT air.article_id AS articleId
      FROM app.project_import_route pir
      INNER JOIN app.article_import_route air ON air.import_route_id = pir.import_route_id
      WHERE pir.project_id = '${escapeSqlString(projectId)}'
    )
    SELECT
      MIN(article_state.updated_at) AS oldestQueuedAt,
      COUNT(*) AS queuedRefreshCount
    FROM app.project_mart_refresh_article_state article_state
    INNER JOIN scoped_article ON scoped_article.articleId = article_state.article_id
    LEFT JOIN app.project_mart_refresh_state refresh_state
      ON refresh_state.project_id = article_state.project_id
    LEFT JOIN app.project_mart_refresh_article_quarantine quarantine
      ON quarantine.article_id = article_state.article_id
    WHERE article_state.project_id = '${escapeSqlString(projectId)}'
      AND quarantine.article_id IS NULL
      AND (
        refresh_state.project_id IS NULL
        OR refresh_state.last_completed_dirty_token IS NULL
        OR CAST(article_state.last_dirty_token AS BIGINT) > CAST(refresh_state.last_completed_dirty_token AS BIGINT)
      )
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
  pendingRefreshCount: number
}): ReviewsIndexingBlockedReason => {
  return params.pendingRefreshCount === 0 || (params.canRunMaintenanceWork && params.canRunMartRefreshDrain)
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
  eligibleConsumerPresent: boolean
  pendingRefreshCount: number
}): ReviewsIndexingStatus => {
  const shouldIndexReviews = params.enabledPromptCount > 0 && params.hasAnyArticlesInScope

  return !shouldIndexReviews
    ? 'not-needed'
    : params.hasFailedRefresh
      ? 'failed'
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
    const martRefreshService = getDuckdbMartRefreshService()
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
      pendingRefreshCount,
    })
    const hasFailedRefresh =
      (!projectRefreshState.isFresh && projectRefreshState.refreshStatus === 'failed') || isLargeRebuildFailed
    const indexingStatus = getReviewsIndexingStatus({
      activeWorkCount,
      enabledPromptCount,
      eligibleConsumerPresent,
      hasFailedRefresh,
      hasAnyArticlesInScope,
      hasReviewRollupRows: hasReviewServingRows,
      pendingRefreshCount,
    })
    const blockedReason = indexingStatus === 'blocked' ? rawBlockedReason : null
    const activeConsumerCount = getActiveConsumerCount({
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
          diagnostics: getReviewsRuntimeDiagnostics(projectId, projectLargeRebuildState),
          eligibleConsumerCount: Math.max(
            maintenanceConsumerAvailability.eligibleConsumerCount,
            eligibleConsumerPresent ? 1 : 0,
          ),
          eligibleConsumerPresent,
          inFlightArticleRefreshCount,
          inFlightProjectRefreshCount,
          inFlightRefreshCount,
          largeRebuild: getLargeRebuildDetails(projectLargeRebuildState, largeRebuildProgress),
          lastProgressedAt: getLatestTimestamp(
            projectRefreshState.lastCompletedAt,
            isProjectRunning ? projectRefreshState.updatedAt : null,
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
          status: indexingStatus,
        },
      },
    }
  },
  {body: t.Object({projectId: t.String()})},
)
