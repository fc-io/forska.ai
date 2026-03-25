import {Elysia, t} from 'elysia'

import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString} from '../../services/appQueryHelpers.ts'
import {assertProjectIsActive} from './projectAccessGuard.ts'

type ReviewsIndexingStatus = 'not-needed' | 'ready' | 'refreshing' | 'stale'

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

const getPendingProjectRefreshInfo = async (
  projectId: string,
): Promise<{oldestQueuedAt: string | null; pendingRefreshCount: number}> => {
  const rows = await getAppDatabaseService().queryJson<{oldestQueuedAt: string | null; pendingRefreshCount: number}>(`
    SELECT
      MIN(created_at) AS oldestQueuedAt,
      COUNT(*) AS pendingRefreshCount
    FROM app.mart_refresh_queue
    WHERE project_id = '${escapeSqlString(projectId)}'
  `)
  const [row] = rows

  return {oldestQueuedAt: row?.oldestQueuedAt ?? null, pendingRefreshCount: Number(row?.pendingRefreshCount ?? 0)}
}

const getPendingArticleRefreshInfo = async (
  projectId: string,
): Promise<{oldestQueuedAt: string | null; pendingRefreshCount: number}> => {
  const rows = await getAppDatabaseService().queryJson<{oldestQueuedAt: string | null; pendingRefreshCount: number}>(`
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
      COUNT(*) AS pendingRefreshCount
    FROM app.mart_refresh_queue queue
    INNER JOIN scoped_article ON scoped_article.articleId = queue.article_id
    WHERE queue.refresh_scope = 'judgment_article'
  `)
  const [row] = rows

  return {oldestQueuedAt: row?.oldestQueuedAt ?? null, pendingRefreshCount: Number(row?.pendingRefreshCount ?? 0)}
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
    const [
      enabledPromptCount,
      hasCuratedArticles,
      hasRouteArticles,
      pendingProjectRefreshInfo,
      pendingArticleRefreshInfo,
      hasReviewRollupRows,
    ] = await Promise.all([
      getEnabledPromptCount(projectId),
      getHasCuratedArticles(projectId),
      getHasRouteArticles(projectId),
      getPendingProjectRefreshInfo(projectId),
      getPendingArticleRefreshInfo(projectId),
      getHasReviewRollupRows(projectId),
    ])
    const hasAnyArticlesInScope = hasCuratedArticles || hasRouteArticles
    const pendingRefreshCount =
      pendingProjectRefreshInfo.pendingRefreshCount + pendingArticleRefreshInfo.pendingRefreshCount
    const indexingStatus = getReviewsIndexingStatus({
      enabledPromptCount,
      hasAnyArticlesInScope,
      hasReviewRollupRows,
      pendingRefreshCount,
    })

    return {
      data: {
        projectId,
        enabledPromptCount,
        scope: {hasAnyArticlesInScope},
        indexing: {
          oldestQueuedAt: getOldestQueuedAt(
            pendingProjectRefreshInfo.oldestQueuedAt,
            pendingArticleRefreshInfo.oldestQueuedAt,
          ),
          pendingArticleRefreshCount: pendingArticleRefreshInfo.pendingRefreshCount,
          pendingProjectRefreshCount: pendingProjectRefreshInfo.pendingRefreshCount,
          pendingRefreshCount,
          status: indexingStatus,
        },
      },
    }
  },
  {body: t.Object({projectId: t.String()})},
)
