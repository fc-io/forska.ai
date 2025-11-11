import {and, eq, gte, lte, sql} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {
  articleRouteLink,
  articles,
  judgmentsHuman,
  projectRouteLink,
  projects,
  prompts,
  projectPrompts,
} from '../../../db/schema.ts'
import {getDatabase} from '../../utils/getDatabase.ts'

export const projectsRoutesGetArticlesReviewsHumanFilters = new Elysia().get(
  '/api/articlesreviewshumanfilters',
  async ({query, set}) => {
    try {
      const db = getDatabase()

      if (!query?.projectId) {
        set.status = 400
        throw new Error('Project ID is required')
      }

      const fromDate = query?.from ? new Date(`${query.from}T00:00:00.000Z`) : null
      const toDate = query?.to ? new Date(`${query.to}T23:59:59.999Z`) : null
      const searchTitle = typeof query?.search === 'string' ? query.search.trim() : ''

      const projectPromptRows = await db
        .select({
          id: prompts.id,
          promptHeading: prompts.promptHeading,
          originalText: prompts.originalText,
        })
        .from(projectPrompts)
        .innerJoin(prompts, eq(projectPrompts.promptId, prompts.id))
        .where(eq(projectPrompts.projectId, query.projectId))

      if (projectPromptRows.length === 0) {
        return []
      }

      // Always enforce project import routes and project date bounds; then apply optional UI date and search filters
      const [projectBounds] = await db
        .select({dateFrom: projects.dateFrom, dateTo: projects.dateTo})
        .from(projects)
        .where(eq(projects.id, query.projectId))
        .limit(1)

      const projectImportRoutes = await db
        .select({importRouteId: projectRouteLink.importRouteId})
        .from(projectRouteLink)
        .where(eq(projectRouteLink.projectId, query.projectId))

      if (projectImportRoutes.length === 0) {
        return []
      }

      const routeIdArray = sql.join(
        projectImportRoutes.map((r) => sql`${r.importRouteId}::uuid`),
        sql`,`,
      )

      const hasMatchingImportRoute = sql`EXISTS (
        SELECT 1 FROM ${articleRouteLink} arl
        WHERE arl."article_id" = ${articles.id}
          AND arl."import_route_id" = ANY(ARRAY[${routeIdArray}])
      )`

      const promptFilters = await Promise.all(
        projectPromptRows.map(async (prompt) => {
          let scoped = sql`SELECT DISTINCT ${judgmentsHuman.answer} as answer
                FROM ${judgmentsHuman}
                INNER JOIN ${articles} ON ${articles.id} = ${judgmentsHuman.articleId}
                WHERE ${judgmentsHuman.promptId} = ${prompt.id}::uuid
                AND ${judgmentsHuman.isAnswered} = true
                AND ${judgmentsHuman.answer} IS NOT NULL
                AND ${hasMatchingImportRoute}`

          if (projectBounds?.dateFrom) {
            scoped = sql`${scoped} AND ${gte(articles.articleCreatedAt, projectBounds.dateFrom)}`
          }
          if (projectBounds?.dateTo) {
            scoped = sql`${scoped} AND ${lte(articles.articleCreatedAt, projectBounds.dateTo)}`
          }
          if (fromDate) {
            scoped = sql`${scoped} AND ${gte(articles.articleCreatedAt, fromDate)}`
          }
          if (toDate) {
            scoped = sql`${scoped} AND ${lte(articles.articleCreatedAt, toDate)}`
          }
          if (searchTitle) {
            scoped = sql`${scoped} AND ${articles.articleTitle} ILIKE ${'%' + searchTitle + '%'}`
          }
          const dateScoped = sql`${scoped} ORDER BY ${judgmentsHuman.answer}`

          const uniqueValues = await db.execute<{answer: string}>(dateScoped)

          return {
            promptId: prompt.id,
            promptName: prompt.promptHeading || prompt.originalText,
            answeredOriginalValues: uniqueValues.rows.map((v) => {
              return v.answer
            }),
          }
        }),
      )

      return promptFilters
    } catch (error) {
      console.error('Error fetching human articles reviews filters:', error)
      set.status = 500
      throw new Error(error instanceof Error ? error.message : 'Failed to fetch human articles reviews filters')
    }
  },
  {
    query: t.Object({
      projectId: t.String(),
      from: t.Optional(t.String()),
      to: t.Optional(t.String()),
      search: t.Optional(t.String()),
    }),
  },
)
