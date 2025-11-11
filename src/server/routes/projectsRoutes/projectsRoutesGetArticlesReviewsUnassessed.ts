import {and, desc, eq, gte, inArray, lte, sql} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {articleRouteLink, articles, judgments, projectRouteLink, projects, prompts, projectPrompts} from '../../../db/schema.ts'
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

      const projectPrompts = await db
        .select({id: prompts.id})
        .from(projectPrompts)
        .innerJoin(prompts, eq(projectPrompts.promptId, prompts.id))
        .where(eq(projectPrompts.projectId, body.projectId))

      if (projectPrompts.length === 0) {
        return {data: [], totalCount: 0, page, limit, totalPages: 0}
      }

      const promptIds = projectPrompts.map((p) => {
        return p.id
      })

      // Condition: there are NO judgments for this article for any of the project's prompts
      const noJudgmentsForProjectPrompts = sql`NOT EXISTS (
        ${db
          .select({exists: sql`1`})
          .from(judgments)
          .where(and(eq(judgments.articleId, articles.id), inArray(judgments.promptId, promptIds)))
          .limit(1)}
      )`

      // Always enforce the project's date range, regardless of provided start/end
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

      if (projectImportRoutes.length === 0) {
        return {data: [], totalCount: 0, page, limit, totalPages: 0}
      }

      const routeIdArray = sql.join(
        projectImportRoutes.map((r) => {
          return sql`${r.importRouteId}::uuid`
        }),
        sql`,`,
      )

      const hasMatchingImportRoute = sql`EXISTS (
        SELECT 1 FROM ${articleRouteLink} arl
        WHERE arl."article_id" = ${articles.id}
        AND arl."import_route_id" = ANY(ARRAY[${routeIdArray}])
      )`

      const whereParts: Array<ReturnType<typeof sql>> = [noJudgmentsForProjectPrompts, hasMatchingImportRoute]
      if (projectBounds?.dateFrom) {
        whereParts.push(gte(articles.articleCreatedAt, projectBounds.dateFrom))
      }
      if (projectBounds?.dateTo) {
        whereParts.push(lte(articles.articleCreatedAt, projectBounds.dateTo))
      }
      if (searchTitle) {
        whereParts.push(sql`${articles.articleTitle} ILIKE ${'%' + searchTitle + '%'}`)
      }
      const combinedWhereCondition = whereParts.length > 1 ? and(...whereParts) : whereParts[0]

      // Count total
      const [{count: totalCount = 0} = {count: 0}] = await db
        .select({count: sql<number>`COUNT(*)`.as('count')})
        .from(articles)
        .where(combinedWhereCondition)

      // Fetch paginated list
      const unassessedArticles = await db
        .select({article: articles})
        .from(articles)
        .where(combinedWhereCondition)
        .orderBy(desc(articles.articleCreatedAt))
        .limit(limit)
        .offset(offset)

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
