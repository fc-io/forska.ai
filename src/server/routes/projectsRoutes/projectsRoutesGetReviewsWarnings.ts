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
    const [enabledPromptCount, hasCuratedArticles, hasRouteArticles, pendingProjectRefreshInfo, hasReviewRollupRows] =
      await Promise.all([
        getEnabledPromptCount(projectId),
        getHasCuratedArticles(projectId),
        getHasRouteArticles(projectId),
        getPendingProjectRefreshInfo(projectId),
        getHasReviewRollupRows(projectId),
      ])
    const hasAnyArticlesInScope = hasCuratedArticles || hasRouteArticles
    const indexingStatus = getReviewsIndexingStatus({
      enabledPromptCount,
      hasAnyArticlesInScope,
      hasReviewRollupRows,
      pendingRefreshCount: pendingProjectRefreshInfo.pendingRefreshCount,
    })

    return {
      data: {
        projectId,
        enabledPromptCount,
        scope: {hasAnyArticlesInScope},
        indexing: {
          oldestQueuedAt: pendingProjectRefreshInfo.oldestQueuedAt,
          pendingRefreshCount: pendingProjectRefreshInfo.pendingRefreshCount,
          status: indexingStatus,
        },
      },
    }
  },
  {body: t.Object({projectId: t.String()})},
)
