import {and, eq, sql} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {articleRouteLink, projectArticles, projectPrompts, projectRouteLink} from '../../../db/schema.ts'
import {getDatabase} from '../../utils/getDatabase.ts'

const getEnabledPromptCount = async (projectId: string): Promise<number> => {
  const db = getDatabase()
  const rows = await db
    .select({count: sql<number>`COUNT(*)`.as('count')})
    .from(projectPrompts)
    .where(and(eq(projectPrompts.projectId, projectId), eq(projectPrompts.enabled, true)))

  return rows[0]?.count ?? 0
}

const getHasCuratedArticles = async (projectId: string): Promise<boolean> => {
  const db = getDatabase()
  const rows = await db
    .select({articleId: projectArticles.articleId})
    .from(projectArticles)
    .where(eq(projectArticles.projectId, projectId))
    .limit(1)

  return rows.length > 0
}

const getHasRouteArticles = async (projectId: string): Promise<boolean> => {
  const db = getDatabase()
  const rows = await db
    .select({articleId: articleRouteLink.articleId})
    .from(projectRouteLink)
    .innerJoin(articleRouteLink, eq(projectRouteLink.importRouteId, articleRouteLink.importRouteId))
    .where(eq(projectRouteLink.projectId, projectId))
    .limit(1)

  return rows.length > 0
}

export const projectsRoutesGetReviewsWarnings = new Elysia().post(
  '/api/projectsreviewswarnings',
  async ({body}) => {
    const projectId = body.projectId
    const [enabledPromptCount, hasCuratedArticles] = await Promise.all([
      getEnabledPromptCount(projectId),
      getHasCuratedArticles(projectId),
    ])
    const hasAnyArticlesInScope =
      enabledPromptCount === 0 || hasCuratedArticles ? hasCuratedArticles : await getHasRouteArticles(projectId)

    return {data: {projectId, enabledPromptCount, scope: {hasAnyArticlesInScope}}}
  },
  {body: t.Object({projectId: t.String()})},
)
