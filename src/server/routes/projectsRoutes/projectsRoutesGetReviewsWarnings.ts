import {Elysia, t} from 'elysia'

import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString, getQuotedStringList} from '../../services/appQueryHelpers.ts'
import {getDuckdbMartRefreshService} from '../../services/getDuckdbMartRefreshService.ts'
import {shouldCurrentServerRunWriterWork} from '../../utils/serverRuntimeRole.ts'
import {assertProjectIsActive} from './projectAccessGuard.ts'

type ReviewsIndexingStatus = 'not-needed' | 'ready' | 'refreshing' | 'stale'

type RefreshCountInfo = {oldestQueuedAt: string | null; queuedRefreshCount: number}

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

const getPendingProjectRefreshInfo = async (projectId: string): Promise<RefreshCountInfo> => {
  const rows = await getAppDatabaseService().queryJson<{oldestQueuedAt: string | null; queuedRefreshCount: number}>(`
    SELECT
      MIN(created_at) AS oldestQueuedAt,
      COUNT(*) AS queuedRefreshCount
    FROM app.mart_refresh_queue
    WHERE project_id = '${escapeSqlString(projectId)}'
      AND completed_at IS NULL
  `)
  const [row] = rows

  return {oldestQueuedAt: row?.oldestQueuedAt ?? null, queuedRefreshCount: Number(row?.queuedRefreshCount ?? 0)}
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
      MIN(queue.created_at) AS oldestQueuedAt,
      COUNT(*) AS queuedRefreshCount
    FROM app.mart_refresh_queue queue
    INNER JOIN scoped_article ON scoped_article.articleId = queue.article_id
    WHERE queue.refresh_scope = 'judgment_article'
      AND queue.completed_at IS NULL
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

const getHasReviewRollupRows = async (projectId: string): Promise<boolean> => {
  const rows = await getAppDatabaseService().queryJson<{projectId: string}>(`
    SELECT project_id AS projectId
    FROM mart.review_article_rollup
    WHERE project_id = '${escapeSqlString(projectId)}'
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
  hasAnyArticlesInScope: boolean
  hasReviewRollupRows: boolean
  pendingRefreshCount: number
}): ReviewsIndexingStatus => {
  const shouldIndexReviews = params.enabledPromptCount > 0 && params.hasAnyArticlesInScope

  return !shouldIndexReviews
    ? 'not-needed'
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
    await martRefreshService.ensureQueueSchema()
    const progressSnapshot = martRefreshService.getProgressSnapshot()
    const throughputSnapshot = martRefreshService.getThroughputSnapshot()
    const [
      enabledPromptCount,
      hasCuratedArticles,
      hasRouteArticles,
      pendingProjectRefreshInfo,
      pendingArticleRefreshInfo,
      hasReviewRollupRows,
      claimedQueuedArticleRefreshCount,
      inFlightArticleRefreshCount,
    ] = await Promise.all([
      getEnabledPromptCount(projectId),
      getHasCuratedArticles(projectId),
      getHasRouteArticles(projectId),
      getPendingProjectRefreshInfo(projectId),
      getPendingArticleRefreshInfo(projectId),
      getHasReviewRollupRows(projectId),
      getScopedArticleRefreshCount(projectId, progressSnapshot.claimedQueuedArticleIds),
      getScopedArticleRefreshCount(projectId, progressSnapshot.processingArticleIds),
    ])
    const claimedQueuedProjectRefreshCount = getMatchingProjectRefreshCount(
      projectId,
      progressSnapshot.claimedQueuedProjectIds,
    )
    const inFlightProjectRefreshCount = getMatchingProjectRefreshCount(projectId, progressSnapshot.processingProjectIds)
    const queuedProjectRefreshCount = getNonNegativeDifference(
      pendingProjectRefreshInfo.queuedRefreshCount,
      claimedQueuedProjectRefreshCount,
    )
    const queuedArticleRefreshCount = getNonNegativeDifference(
      pendingArticleRefreshInfo.queuedRefreshCount,
      claimedQueuedArticleRefreshCount,
    )
    const pendingProjectRefreshCount = queuedProjectRefreshCount + inFlightProjectRefreshCount
    const pendingArticleRefreshCount = queuedArticleRefreshCount + inFlightArticleRefreshCount
    const queuedRefreshCount = queuedProjectRefreshCount + queuedArticleRefreshCount
    const inFlightRefreshCount = inFlightProjectRefreshCount + inFlightArticleRefreshCount
    const hasAnyArticlesInScope = hasCuratedArticles || hasRouteArticles
    const pendingRefreshCount = pendingProjectRefreshCount + pendingArticleRefreshCount
    const indexingStatus = getReviewsIndexingStatus({
      enabledPromptCount,
      hasAnyArticlesInScope,
      hasReviewRollupRows,
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
            pendingProjectRefreshInfo.oldestQueuedAt,
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
