import {Elysia, t} from 'elysia'

import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString, getQuotedStringList} from '../../services/appQueryHelpers.ts'
import {getDuckdbMartRefreshService} from '../../services/getDuckdbMartRefreshService.ts'
import {shouldCurrentRuntimeRunMartRefreshDrain} from '../../utils/martRefreshDrainEligibility.ts'
import {shouldCurrentServerRunWriterWork} from '../../utils/serverRuntimeRole.ts'
import {assertProjectIsActive} from './projectAccessGuard.ts'

type ReviewsIndexingBlockedReason = 'paused_by_policy' | 'waiting_for_maintenance_worker' | null
type ReviewsIndexingProgressState = 'blocked' | 'completed' | 'failed' | 'processing' | 'queued' | 'stalled'
type ReviewsIndexingStatus = 'blocked' | 'failed' | 'not-needed' | 'ready' | 'refreshing' | 'stale'

type ProjectMartRefreshStatus = 'failed' | 'idle' | 'running'

type RefreshCountInfo = {oldestQueuedAt: string | null; queuedRefreshCount: number}

type ProjectLargeRebuildState = {
  cursorArticleCreatedAt: string | null
  cursorArticleId: string | null
  lastError: string | null
  lastCompletedAt: string | null
  lastStartedAt: string | null
  refreshStatus: ProjectMartRefreshStatus | null
  rebuildPhase: string | null
  refreshToken: number | null
}

const getLargeRebuildDetails = (state: ProjectLargeRebuildState) => {
  return state.refreshToken === null || state.refreshToken <= 0
    ? null
    : {
        cursorArticleCreatedAt: state.cursorArticleCreatedAt,
        cursorArticleId: state.cursorArticleId,
        lastError: state.lastError,
        rebuildPhase: state.rebuildPhase,
        refreshStatus: state.refreshStatus,
        refreshToken: state.refreshToken,
      }
}

type ProjectRefreshState = {
  dirtyToken: number | null
  isFresh: boolean
  lastCompletedAt: string | null
  lastCompletedRefreshToken: number | null
  lastRequestedAt: string | null
  lastStartedAt: string | null
  leaseExpiresAt: string | null
  refreshStatus: ProjectMartRefreshStatus | null
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
    lastCompletedRefreshToken: number | null
    lastRequestedAt: string | null
    lastStartedAt: string | null
    leaseExpiresAt: string | null
    refreshStatus: ProjectMartRefreshStatus | null
  }>(`
    SELECT
      CAST(dirty_token AS INTEGER) AS dirtyToken,
      last_completed_at AS lastCompletedAt,
      CAST(last_completed_refresh_token AS INTEGER) AS lastCompletedRefreshToken,
      last_requested_at AS lastRequestedAt,
      last_started_at AS lastStartedAt,
      lease_expires_at AS leaseExpiresAt,
      refresh_status AS refreshStatus
    FROM app.project_mart_refresh_state
    WHERE project_id = '${escapeSqlString(projectId)}'
    LIMIT 1
  `)

  const dirtyToken = row?.dirtyToken ?? null
  const lastCompletedRefreshToken = row?.lastCompletedRefreshToken ?? null
  const refreshStatus = row?.refreshStatus ?? null
  const isFresh = dirtyToken === null || (lastCompletedRefreshToken !== null && lastCompletedRefreshToken >= dirtyToken)

  return {
    dirtyToken,
    isFresh,
    lastCompletedAt: row?.lastCompletedAt ?? null,
    lastCompletedRefreshToken,
    lastRequestedAt: row?.lastRequestedAt ?? null,
    lastStartedAt: row?.lastStartedAt ?? null,
    leaseExpiresAt: row?.leaseExpiresAt ?? null,
    refreshStatus,
  }
}

const getProjectLargeRebuildState = async (projectId: string): Promise<ProjectLargeRebuildState> => {
  const [row] = await getAppDatabaseService().queryJson<{
    cursorArticleCreatedAt: string | null
    cursorArticleId: string | null
    lastError: string | null
    lastCompletedAt: string | null
    lastStartedAt: string | null
    rebuildPhase: string | null
    refreshStatus: ProjectMartRefreshStatus | null
    refreshToken: number | null
  }>(`
    SELECT
      cursor_article_created_at AS cursorArticleCreatedAt,
      cursor_article_id AS cursorArticleId,
      last_error AS lastError,
      last_completed_at AS lastCompletedAt,
      last_started_at AS lastStartedAt,
      rebuild_phase AS rebuildPhase,
      refresh_status AS refreshStatus,
      CAST(refresh_token AS INTEGER) AS refreshToken
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
    rebuildPhase: row?.rebuildPhase ?? null,
    refreshStatus: row?.refreshStatus ?? null,
    refreshToken: row?.refreshToken ?? null,
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
    WHERE article_state.project_id = '${escapeSqlString(projectId)}'
      AND (
        refresh_state.project_id IS NULL
        OR refresh_state.last_completed_refresh_token IS NULL
        OR CAST(article_state.last_dirty_token AS BIGINT) > CAST(refresh_state.last_completed_refresh_token AS BIGINT)
      )
  `)
  const [row] = rows

  return {oldestQueuedAt: row?.oldestQueuedAt ?? null, queuedRefreshCount: Number(row?.queuedRefreshCount ?? 0)}
}

const getScopedArticleRefreshCount = async (projectId: string, articleIds: string[]): Promise<number> => {
  if (articleIds.length === 0) {
    return 0
  }

  const rows = await getAppDatabaseService().queryJson<{count: number}>(`
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
    SELECT COUNT(*) AS count
    FROM scoped_article
    WHERE articleId IN (${getQuotedStringList(articleIds).join(', ')})
  `)

  return Number(rows[0]?.count ?? 0)
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
        OR CAST(refresh_state.dirty_token AS BIGINT) <= CAST(refresh_state.last_completed_refresh_token AS BIGINT)
      )
    LIMIT 1
  `)

  return rows.length > 0
}

const getReviewIndexingBlockedReason = (params: {
  canRunMartRefreshDrain: boolean
  canRunWriterWork: boolean
  pendingRefreshCount: number
}): ReviewsIndexingBlockedReason => {
  return params.pendingRefreshCount === 0 || (params.canRunWriterWork && params.canRunMartRefreshDrain)
    ? null
    : params.canRunWriterWork
      ? 'paused_by_policy'
      : 'waiting_for_maintenance_worker'
}

const getMatchingProjectRefreshCount = (projectId: string, projectIds: string[]) => {
  return projectIds.filter((currentProjectId) => {
    return currentProjectId === projectId
  }).length
}

const getNonNegativeDifference = (total: number, claimed: number) => {
  return Math.max(0, total - claimed)
}

const triggerMartRefreshDrain = (pendingRefreshCount: number) => {
  const martRefreshService = getDuckdbMartRefreshService()

  if (
    pendingRefreshCount === 0
    || !shouldCurrentServerRunWriterWork()
    || !shouldCurrentRuntimeRunMartRefreshDrain()
    || !martRefreshService.isAutoDrainEnabled()
  ) {
    return
  }

  void martRefreshService.flush().catch((error) => {
    console.warn('[reviewsWarnings] failed to trigger mart refresh drain', error)
  })
}

const getReviewsIndexingStatus = (params: {
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
      : params.pendingRefreshCount > 0 && !params.eligibleConsumerPresent
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
    const martRefreshService = getDuckdbMartRefreshService()
    const progressSnapshot = martRefreshService.getProgressSnapshot()
    const throughputSnapshot = martRefreshService.getThroughputSnapshot()
    const [
      enabledPromptCount,
      hasCuratedArticles,
      hasRouteArticles,
      projectRefreshState,
      projectLargeRebuildState,
      pendingArticleRefreshInfo,
      hasReviewServingRows,
      processingArticleRefreshCount,
    ] = await Promise.all([
      getEnabledPromptCount(projectId),
      getHasCuratedArticles(projectId),
      getHasRouteArticles(projectId),
      getProjectRefreshState(projectId),
      getProjectLargeRebuildState(projectId),
      getPendingArticleRefreshInfo(projectId),
      getHasReviewServingRows(projectId),
      getScopedArticleRefreshCount(projectId, progressSnapshot.processingArticleIds),
    ])
    const hasLiveProcessingSnapshot =
      getMatchingProjectRefreshCount(projectId, progressSnapshot.processingProjectIds) > 0
    const hasActiveProjectLease =
      projectRefreshState.leaseExpiresAt !== null && new Date(projectRefreshState.leaseExpiresAt) > new Date()
    const hasLargeRebuild = projectLargeRebuildState.refreshToken !== null && projectLargeRebuildState.refreshToken > 0
    const isLargeRebuildRunning = projectLargeRebuildState.refreshStatus === 'running'
    const isLargeRebuildQueued = hasLargeRebuild && projectLargeRebuildState.refreshStatus === 'idle'
    const isLargeRebuildFailed = projectLargeRebuildState.refreshStatus === 'failed'
    const canRunWriterWork = shouldCurrentServerRunWriterWork()
    const canRunMartRefreshDrain = shouldCurrentRuntimeRunMartRefreshDrain()
    const eligibleConsumerPresent = canRunWriterWork && canRunMartRefreshDrain
    const isProjectRunning =
      !projectRefreshState.isFresh
      && (hasLiveProcessingSnapshot || (projectRefreshState.refreshStatus === 'running' && hasActiveProjectLease))
    const rawInFlightProjectRefreshCount = isProjectRunning ? 1 : isLargeRebuildRunning ? 1 : 0
    const inFlightProjectRefreshCount = eligibleConsumerPresent ? rawInFlightProjectRefreshCount : 0
    const queuedProjectRefreshCount =
      projectRefreshState.isFresh && !hasLargeRebuild
        ? 0
        : isLargeRebuildQueued
          ? 1
          : getNonNegativeDifference(1, inFlightProjectRefreshCount)
    const rawInFlightArticleRefreshCount =
      processingArticleRefreshCount > 0
        ? processingArticleRefreshCount
        : isProjectRunning
          ? pendingArticleRefreshInfo.queuedRefreshCount
          : 0
    const inFlightArticleRefreshCount = eligibleConsumerPresent ? rawInFlightArticleRefreshCount : 0
    const queuedArticleRefreshCount =
      eligibleConsumerPresent && processingArticleRefreshCount > 0
        ? getNonNegativeDifference(pendingArticleRefreshInfo.queuedRefreshCount, processingArticleRefreshCount)
        : eligibleConsumerPresent && isProjectRunning
          ? 0
          : pendingArticleRefreshInfo.queuedRefreshCount
    const pendingProjectRefreshCount = queuedProjectRefreshCount + inFlightProjectRefreshCount
    const pendingArticleRefreshCount = queuedArticleRefreshCount + inFlightArticleRefreshCount
    const queuedRefreshCount = queuedProjectRefreshCount + queuedArticleRefreshCount
    const inFlightRefreshCount = inFlightProjectRefreshCount + inFlightArticleRefreshCount
    const hasAnyArticlesInScope = hasCuratedArticles || hasRouteArticles
    const pendingRefreshCount = pendingProjectRefreshCount + pendingArticleRefreshCount
    const rawBlockedReason = getReviewIndexingBlockedReason({
      canRunMartRefreshDrain,
      canRunWriterWork,
      pendingRefreshCount,
    })
    const hasFailedRefresh =
      (!projectRefreshState.isFresh && projectRefreshState.refreshStatus === 'failed') || isLargeRebuildFailed
    const indexingStatus = getReviewsIndexingStatus({
      enabledPromptCount,
      eligibleConsumerPresent,
      hasFailedRefresh,
      hasAnyArticlesInScope,
      hasReviewRollupRows: hasReviewServingRows,
      pendingRefreshCount,
    })
    const blockedReason = indexingStatus === 'blocked' ? rawBlockedReason : null
    const activeWorkCount = eligibleConsumerPresent ? inFlightRefreshCount : 0

    triggerMartRefreshDrain(pendingRefreshCount)

    return {
      data: {
        projectId,
        enabledPromptCount,
        scope: {hasAnyArticlesInScope},
        indexing: {
          activeConsumerCount: activeWorkCount > 0 ? 1 : 0,
          activeWorkCount,
          articleRefreshesPerMinute: throughputSnapshot.articleRefreshesPerMinute,
          blockedReason,
          eligibleConsumerCount: eligibleConsumerPresent ? 1 : 0,
          eligibleConsumerPresent,
          inFlightArticleRefreshCount,
          inFlightProjectRefreshCount,
          inFlightRefreshCount,
          largeRebuild: getLargeRebuildDetails(projectLargeRebuildState),
          lastProgressedAt: getLatestTimestamp(
            projectRefreshState.lastCompletedAt,
            projectLargeRebuildState.lastCompletedAt,
          ),
          lastStartedAt: getLatestTimestamp(projectRefreshState.lastStartedAt, projectLargeRebuildState.lastStartedAt),
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
          progressState: getReviewsIndexingProgressState({inFlightRefreshCount, status: indexingStatus}),
          recoveryMode: 'none',
          requiredConsumerRole: 'maintenance-worker',
          retryAfterAt: null,
          status: indexingStatus,
        },
      },
    }
  },
  {body: t.Object({projectId: t.String()})},
)
