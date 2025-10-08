import {and, desc, eq, gte, inArray, lte, sql} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {articles, dataSource, judgments, projectDataSourceLink, projects, prompts} from '../../../db/schema.ts'
import {getDatabase} from '../../utils/getDatabase.ts'

export const projectsRoutesGetArticlesReviewsUnassessed = new Elysia().post(
  '/api/articlesreviewsunassessed',
  async ({body}) => {
    try {
      const db = getDatabase()

      const page = parseInt(body?.page || '1', 10)
      const limit = parseInt(body?.limit || '100', 10)
      const offset = (page - 1) * limit

      const projectPrompts = await db.select().from(prompts).where(eq(prompts.projectId, body.projectId))

      if (projectPrompts.length === 0) {
        return {data: [], totalCount: 0, page, limit, totalPages: 0}
      }

      const promptIds = projectPrompts.map((p) => {
        return p.id
      })

      // Compute allowed import routes via project -> datasource links
      const dsRoutes = await db
        .select({importRoute: dataSource.importRoute})
        .from(projectDataSourceLink)
        .leftJoin(dataSource, eq(projectDataSourceLink.dataSourceId, dataSource.id))
        .where(eq(projectDataSourceLink.projectId, body.projectId))
      const allowedImportRoutes = dsRoutes
        .map((r) => {
          return r.importRoute
        })
        .filter((v): v is string => {
          return Boolean(v)
        })

      if (allowedImportRoutes.length === 0) {
        return {data: [], totalCount: 0, page, limit, totalPages: 0}
      }

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

      const whereParts: Array<ReturnType<typeof sql>> = [noJudgmentsForProjectPrompts, inArray(articles.importRoute, allowedImportRoutes)]
      if (projectBounds?.dateFrom) {
        whereParts.push(gte(articles.createdAt, projectBounds.dateFrom))
      }
      if (projectBounds?.dateTo) {
        whereParts.push(lte(articles.createdAt, projectBounds.dateTo))
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
        .orderBy(desc(articles.createdAt))
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
    }),
  },
)
