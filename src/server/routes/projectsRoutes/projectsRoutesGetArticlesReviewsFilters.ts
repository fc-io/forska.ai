import {and, eq, gte, inArray, lte, or, sql} from 'drizzle-orm'
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

export const projectsRoutesGetArticlesReviewsFilters = new Elysia().get(
  '/api/articlesreviewsfilters',
  async ({query, set}) => {
    console.log('articlesreviewsfilters', query)
    try {
      const db = getDatabase()

      if (!query?.projectId) {
        set.status = 400
        throw new Error('Project ID is required')
      }

      const fromDate = query?.from ? new Date(`${query.from}T00:00:00.000Z`) : null
      const toDate = query?.to ? new Date(`${query.to}T23:59:59.999Z`) : null
      const searchTitle = typeof query?.search === 'string' ? query.search.trim() : ''

      // Get all prompts for this project
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

      // Single grouped query across all project prompts for distinct filter values
      // Use normalized array: COALESCE(answered_original_as_array, ARRAY[answered_original])
      const promptIds = projectPromptRows.map((p) => {
        return p.id
      })

      const whereParts: Array<ReturnType<typeof sql>> = [
        inArray(judgments.promptId, promptIds),
        hasMatchingImportRoute ? or(hasMatchingImportRoute, hasProjectArticle) : hasProjectArticle,
      ]
      if (projectBounds?.dateFrom) whereParts.push(gte(articles.articleCreatedAt, projectBounds.dateFrom))
      if (projectBounds?.dateTo) whereParts.push(lte(articles.articleCreatedAt, projectBounds.dateTo))
      if (fromDate) whereParts.push(gte(articles.articleCreatedAt, fromDate))
      if (toDate) whereParts.push(lte(articles.articleCreatedAt, toDate))
      if (searchTitle) whereParts.push(sql`${articles.articleTitle} ILIKE ${'%' + searchTitle + '%'}`)

      const normalized = sql`COALESCE(${judgments.answeredOriginalAsArray}, CASE WHEN ${judgments.answeredOriginal} IS NOT NULL THEN ARRAY[${judgments.answeredOriginal}] ELSE ARRAY[]::text[] END)`

      // Use raw SQL to UNNEST the normalized array per row and collect distinct elements
      const combinedWhere = and(...whereParts)
      const grouped = await db.execute(
        sql`
          SELECT ${judgments.promptId} AS "promptId", elem AS "value"
          FROM ${judgments}
          INNER JOIN ${articles} ON ${articles.id} = ${judgments.articleId}
          CROSS JOIN LATERAL UNNEST(${normalized}) AS elem
          WHERE ${combinedWhere}
          GROUP BY ${judgments.promptId}, elem
          ORDER BY ${judgments.promptId}, elem
        `,
      )

      const promptNameMap = new Map(
        projectPromptRows.map((p) => {
          return [p.id, p.promptHeading || p.originalText]
        }),
      )
      const byPrompt = new Map<string, string[]>()
      for (const row of grouped.rows as Array<{promptId: string; value: string}>) {
        const arr = byPrompt.get(row.promptId) || []
        if (row.value !== null && row.value !== undefined) arr.push(row.value)
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
      console.error('Error fetching articles reviews filters:', error)
      set.status = 500
      throw new Error(error instanceof Error ? error.message : 'Failed to fetch articles reviews filters')
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
