import {and, eq, gte, inArray, isNotNull, lte, or, sql} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {
  articleRouteLink,
  articles,
  judgmentsHuman,
  projectArticles,
  projectPrompts,
  projectRouteLink,
  projects,
  prompts,
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
        .select({id: prompts.id, promptHeading: prompts.promptHeading, originalText: prompts.originalText})
        .from(projectPrompts)
        .innerJoin(prompts, eq(projectPrompts.promptId, prompts.id))
        .where(and(eq(projectPrompts.projectId, query.projectId), eq(projectPrompts.enabled, true)))

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
          AND pa."project_id" = ${query.projectId}::uuid
      )`

      // Single grouped query across prompts for human answers
      const promptIds = projectPromptRows.map((p) => {
        return p.id
      })

      const whereParts = [
        inArray(judgmentsHuman.promptId, promptIds),
        eq(judgmentsHuman.isAnswered, true),
        isNotNull(judgmentsHuman.answer),
        hasMatchingImportRoute ? or(hasMatchingImportRoute, hasProjectArticle) : hasProjectArticle,
      ].filter((part): part is NonNullable<typeof part> => part != null)
      if (projectBounds?.dateFrom) whereParts.push(gte(articles.articleCreatedAt, projectBounds.dateFrom))
      if (projectBounds?.dateTo) whereParts.push(lte(articles.articleCreatedAt, projectBounds.dateTo))
      if (fromDate) whereParts.push(gte(articles.articleCreatedAt, fromDate))
      if (toDate) whereParts.push(lte(articles.articleCreatedAt, toDate))
      if (searchTitle) whereParts.push(sql`${articles.articleTitle} ILIKE ${'%' + searchTitle + '%'}`)

      const grouped = await db
        .select({promptId: judgmentsHuman.promptId, answer: judgmentsHuman.answer})
        .from(judgmentsHuman)
        .innerJoin(articles, eq(articles.id, judgmentsHuman.articleId))
        .where(and(...whereParts))
        .groupBy(judgmentsHuman.promptId, judgmentsHuman.answer)
        .orderBy(judgmentsHuman.promptId, judgmentsHuman.answer)

      const promptNameMap = new Map(
        projectPromptRows.map((p) => {
          return [p.id, p.promptHeading || p.originalText]
        }),
      )
      const byPrompt = new Map<string, string[]>()
      for (const row of grouped) {
        const arr = byPrompt.get(row.promptId) || []
        if (row.answer !== null) arr.push(row.answer as unknown as string)
        byPrompt.set(row.promptId, arr)
      }

      const result = projectPromptRows.map((p) => {
        return {
          promptId: p.id,
          promptName: promptNameMap.get(p.id) || p.id,
          answeredOriginalValues: byPrompt.get(p.id) || [],
        }
      })

      return result
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
