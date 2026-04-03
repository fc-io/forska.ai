import {Elysia, t} from 'elysia'

import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString, getQuotedStringList} from '../../services/appQueryHelpers.ts'
import {getDuckdbMartRefreshService} from '../../services/getDuckdbMartRefreshService.ts'
import {shouldCurrentServerRunWriterWork} from '../../utils/serverRuntimeRole.ts'
import {assertProjectIsActive} from './projectAccessGuard.ts'

type ReviewsIndexingStatus = 'failed' | 'not-needed' | 'ready' | 'refreshing' | 'stale'

type ProjectMartRefreshStatus = 'failed' | 'idle' | 'running'

type RefreshCountInfo = {oldestQueuedAt: string | null; queuedRefreshCount: number}

type ProjectRefreshState = {
  dirtyToken: number | null
  isFresh: boolean
  lastCompletedRefreshToken: number | null
  lastRequestedAt: string | null
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
    lastCompletedRefreshToken: number | null
    lastRequestedAt: string | null
    leaseExpiresAt: string | null
    refreshStatus: ProjectMartRefreshStatus | null
  }>(`
    SELECT
      CAST(dirty_token AS INTEGER) AS dirtyToken,
      CAST(last_completed_refresh_token AS INTEGER) AS lastCompletedRefreshToken,
      last_requested_at AS lastRequestedAt,
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
    lastCompletedRefreshToken,
    lastRequestedAt: row?.lastRequestedAt ?? null,
    leaseExpiresAt: row?.leaseExpiresAt ?? null,
    refreshStatus,
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

  if (pendingRefreshCount === 0 || !shouldCurrentServerRunWriterWork() || !martRefreshService.isAutoDrainEnabled()) {
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
  pendingRefreshCount: number
}): ReviewsIndexingStatus => {
  const shouldIndexReviews = params.enabledPromptCount > 0 && params.hasAnyArticlesInScope

  return !shouldIndexReviews
    ? 'not-needed'
    : params.hasFailedRefresh
      ? 'failed'
      : params.pendingRefreshCount > 0
        ? 'refreshing'
        : params.hasReviewRollupRows
          ? 'ready'
          : 'stale'
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
      pendingArticleRefreshInfo,
      hasReviewServingRows,
      processingArticleRefreshCount,
    ] = await Promise.all([
      getEnabledPromptCount(projectId),
      getHasCuratedArticles(projectId),
      getHasRouteArticles(projectId),
      getProjectRefreshState(projectId),
      getPendingArticleRefreshInfo(projectId),
      getHasReviewServingRows(projectId),
      getScopedArticleRefreshCount(projectId, progressSnapshot.processingArticleIds),
    ])
    const hasLiveProcessingSnapshot =
      getMatchingProjectRefreshCount(projectId, progressSnapshot.processingProjectIds) > 0
    const hasActiveProjectLease =
      projectRefreshState.leaseExpiresAt !== null && new Date(projectRefreshState.leaseExpiresAt) > new Date()
    const isProjectRunning =
      !projectRefreshState.isFresh
      && (hasLiveProcessingSnapshot || (projectRefreshState.refreshStatus === 'running' && hasActiveProjectLease))
    const inFlightProjectRefreshCount = isProjectRunning ? 1 : 0
    const queuedProjectRefreshCount = projectRefreshState.isFresh
      ? 0
      : getNonNegativeDifference(1, inFlightProjectRefreshCount)
    const inFlightArticleRefreshCount =
      processingArticleRefreshCount > 0
        ? processingArticleRefreshCount
        : isProjectRunning
          ? pendingArticleRefreshInfo.queuedRefreshCount
          : 0
    const queuedArticleRefreshCount =
      processingArticleRefreshCount > 0
        ? getNonNegativeDifference(pendingArticleRefreshInfo.queuedRefreshCount, processingArticleRefreshCount)
        : isProjectRunning
          ? 0
          : pendingArticleRefreshInfo.queuedRefreshCount
    const pendingProjectRefreshCount = queuedProjectRefreshCount + inFlightProjectRefreshCount
    const pendingArticleRefreshCount = queuedArticleRefreshCount + inFlightArticleRefreshCount
    const queuedRefreshCount = queuedProjectRefreshCount + queuedArticleRefreshCount
    const inFlightRefreshCount = inFlightProjectRefreshCount + inFlightArticleRefreshCount
    const hasAnyArticlesInScope = hasCuratedArticles || hasRouteArticles
    const pendingRefreshCount = pendingProjectRefreshCount + pendingArticleRefreshCount
    const indexingStatus = getReviewsIndexingStatus({
      enabledPromptCount,
      hasFailedRefresh: !projectRefreshState.isFresh && projectRefreshState.refreshStatus === 'failed',
      hasAnyArticlesInScope,
      hasReviewRollupRows: hasReviewServingRows,
      pendingRefreshCount,
    })

    triggerMartRefreshDrain(pendingRefreshCount)

    return {
      data: {
        projectId,
        enabledPromptCount,
        scope: {hasAnyArticlesInScope},
        indexing: {
          articleRefreshesPerMinute: throughputSnapshot.articleRefreshesPerMinute,
          inFlightArticleRefreshCount,
          inFlightProjectRefreshCount,
          inFlightRefreshCount,
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
          status: indexingStatus,
        },
      },
    }
  },
  {body: t.Object({projectId: t.String()})},
)
