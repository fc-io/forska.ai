import {and, desc, eq, gte, inArray, lte, or, sql} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {
  articleRouteLink,
  articles,
  judgments,
  projectArticles,
  projectPrompts,
  projectRouteLink,
  projects,
  prompts,
} from '../../../db/schema.ts'
import {getDatabase} from '../../utils/getDatabase.ts'

export const projectsRoutesGetArticlesReviewsUnassessed = new Elysia().post(
  '/api/articlesreviewsunassessed',
  async ({body}) => {
    try {
      const db = getDatabase()

      const page = parseInt(body?.page || '1', 10)
      const limit = parseInt(body?.limit || '100', 10)
      const offset = (page - 1) * limit
      const searchTitle = typeof body.search === 'string' ? body.search.trim() : ''
      const fromDate = body.from ? new Date(`${body.from}T00:00:00.000Z`) : null
      const toDate = body.to ? new Date(`${body.to}T23:59:59.999Z`) : null

      const projectPromptRows = await db
        .select({id: prompts.id})
        .from(projectPrompts)
        .innerJoin(prompts, eq(projectPrompts.promptId, prompts.id))
        .where(and(eq(projectPrompts.projectId, body.projectId), eq(projectPrompts.enabled, true)))

      if (projectPromptRows.length === 0) {
        return {data: [], totalCount: 0, page, limit, totalPages: 0}
      }

      const promptIds = projectPromptRows.map((p) => {
        return p.id
      })

      // Always enforce the project's date range and capture bounds
      const [projectBounds] = await db
        .select({dateFrom: projects.dateFrom, dateTo: projects.dateTo})
        .from(projects)
        .where(eq(projects.id, body.projectId))
        .limit(1)

      // Filter by project's linked import routes via EXISTS against article_route_link
      const projectImportRoutes = await db
        .select({importRouteId: projectRouteLink.importRouteId})
        .from(projectRouteLink)
        .where(eq(projectRouteLink.projectId, body.projectId))

      const routeIdArray =
        projectImportRoutes.length > 0
          ? sql.join(
              projectImportRoutes.map((r) => {
                return sql`${r.importRouteId}::uuid`
              }),
              sql`,`,
            )
          : null

      const hasMatchingImportRoute =
        routeIdArray !== null
          ? sql`EXISTS (
              SELECT 1 FROM ${articleRouteLink} arl
              WHERE arl."article_id" = ${articles.id}
              AND arl."import_route_id" = ANY(ARRAY[${routeIdArray}])
            )`
          : null
      const hasProjectArticle = sql`EXISTS (
        SELECT 1 FROM ${projectArticles} pa
        WHERE pa."article_id" = ${articles.id}
        AND pa."project_id" = ${body.projectId}::uuid
      )`

      // Build scope condition (import route OR explicitly linked to project)
      const scopeCondition = hasMatchingImportRoute ? or(hasMatchingImportRoute, hasProjectArticle) : hasProjectArticle

      // Optional UI + project time bounds and search
      const whereParts: Array<ReturnType<typeof sql>> = [scopeCondition]
      if (projectBounds?.dateFrom) whereParts.push(gte(articles.articleCreatedAt, projectBounds.dateFrom))
      if (projectBounds?.dateTo) whereParts.push(lte(articles.articleCreatedAt, projectBounds.dateTo))
      if (fromDate) whereParts.push(gte(articles.articleCreatedAt, fromDate))
      if (toDate) whereParts.push(lte(articles.articleCreatedAt, toDate))
      if (searchTitle) whereParts.push(sql`${articles.articleTitle} ILIKE ${'%' + searchTitle + '%'}`)
      const combinedWhereCondition = whereParts.length > 1 ? and(...whereParts) : whereParts[0]

      // Select articles that are NOT fully assessed by LLM for all project prompts
      // Strategy: LEFT JOIN judgments filtered to this project's promptIds and HAVING count(distinct prompt_id) < total prompts
      const groupedBase = db
        .select({id: articles.id})
        .from(articles)
        .leftJoin(judgments, and(eq(judgments.articleId, articles.id), inArray(judgments.promptId, promptIds)))
        .where(combinedWhereCondition)
        .groupBy(articles.id)
        .having(sql`COUNT(DISTINCT ${judgments.promptId}) < ${promptIds.length}`)
        .as('grouped_unassessed')

      // Count total
      const [{count: totalCount = 0} = {count: 0}] = await db
        .select({count: sql<number>`COUNT(*)`.as('count')})
        .from(groupedBase)

      // Fetch paginated list
      const pageBase = db
        .select({id: groupedBase.id})
        .from(groupedBase)
        .innerJoin(articles, eq(groupedBase.id, articles.id))
        .orderBy(desc(articles.articleCreatedAt))
        .limit(limit)
        .offset(offset)
        .as('page_unassessed')

      const unassessedArticles = await db
        .select({article: articles})
        .from(articles)
        .innerJoin(pageBase, eq(pageBase.id, articles.id))
        .orderBy(desc(articles.articleCreatedAt))

      const result = unassessedArticles.map(({article}) => {
        return {...article, judgments: []}
      })

      return {data: result, totalCount, page, limit, totalPages: Math.ceil(totalCount / limit)}
    } catch (error) {
      console.error('Error fetching unassessed articles:', error)
      throw new Error(error instanceof Error ? error.message : 'Failed to fetch unassessed articles')
    }
  },
  {
    body: t.Object({
      limit: t.String(),
      page: t.String(),
      projectId: t.String(),
      from: t.Optional(t.String()),
      to: t.Optional(t.String()),
      search: t.Optional(t.String()),
    }),
  },
)
