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

export const projectsRoutesGetArticlesReviews = new Elysia().post(
  '/api/articlesreviews',
  async ({body}) => {
    try {
      const db = getDatabase()

      // Parse pagination params with defaults
      const page = parseInt(body?.page || '1', 10)
      const limit = parseInt(body?.limit || '100', 10)
      const offset = (page - 1) * limit

      // Parse optional date range
      const fromDate = body.from ? new Date(`${body.from}T00:00:00.000Z`) : null
      const toDate = body.to ? new Date(`${body.to}T23:59:59.999Z`) : null
      const searchTitle = typeof body.search === 'string' ? body.search.trim() : ''

      // First get all prompts for this project (ordered)
      const projectPromptRows = await db
        .select({id: prompts.id, order: projectPrompts.order})
        .from(projectPrompts)
        .innerJoin(prompts, eq(projectPrompts.promptId, prompts.id))
        .where(and(eq(projectPrompts.projectId, body.projectId), eq(projectPrompts.enabled, true)))
        .orderBy(projectPrompts.order)

      if (projectPromptRows.length === 0) {
        return {data: [], totalCount: 0, page, limit, totalPages: 0}
      }

      // Get articles that have judgments for ALL prompts of the project
      const promptIds = projectPromptRows.map((p) => {
        return p.id
      })

      // Build the base query conditions
      const conditions: Array<ReturnType<typeof sql>> = []

      // Add filters for each prompt's answered_original if provided (multiple values allowed)
      const promptFilters = Object.entries(body.prompts || {}).map(([key, values]) => {
        return [key, Array.isArray(values) ? values : [String(values)]] as const
      })

      console.log('promptFilters', promptFilters)

      // Always scope to project's configured import routes and date bounds
      const [projectBounds] = await db
        .select({dateFrom: projects.dateFrom, dateTo: projects.dateTo})
        .from(projects)
        .where(eq(projects.id, body.projectId))
        .limit(1)

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

      // Build final where parts with optional filters (route scoping applied via join)
      const whereParts: Array<ReturnType<typeof sql>> = []
      if (conditions.length > 0) {
        whereParts.push(...conditions)
      }

      if (projectBounds?.dateFrom) {
        whereParts.push(gte(articles.articleCreatedAt, projectBounds.dateFrom))
      }
      if (projectBounds?.dateTo) {
        whereParts.push(lte(articles.articleCreatedAt, projectBounds.dateTo))
      }

      // Additional optional UI filters
      if (fromDate) {
        whereParts.push(gte(articles.articleCreatedAt, fromDate))
      }
      if (toDate) {
        whereParts.push(lte(articles.articleCreatedAt, toDate))
      }
      if (searchTitle) {
        whereParts.push(sql`${articles.articleTitle} ILIKE ${'%' + searchTitle + '%'}`)
      }

      const combinedWhereCondition = whereParts.length > 1 ? and(...whereParts) : whereParts[0]

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
      const scopeCondition = hasMatchingImportRoute ? or(hasMatchingImportRoute, hasProjectArticle) : hasProjectArticle

      // Build grouped base query once, then count rows in a subquery (fast COUNT(*))
      // Build HAVING conditions: require one judgment per prompt overall, and if a prompt has selected filters,
      // require at least one element in normalized answer array to overlap the selected set for that prompt.
      const havingParts: Array<ReturnType<typeof sql>> = [
        sql`COUNT(DISTINCT ${judgments.promptId}) = ${promptIds.length}`,
      ]
      const normalized = sql`COALESCE(${judgments.answeredOriginalAsArray}, CASE WHEN ${judgments.answeredOriginal} IS NOT NULL THEN ARRAY[${judgments.answeredOriginal}] ELSE ARRAY[]::text[] END)`
      for (const [promptId, answeredValues] of promptFilters) {
        if (answeredValues.length === 0) continue
        const answeredValsArray = sql.join(
          answeredValues.map((v) => {
            return sql`${v}`
          }),
          sql`,`,
        )
        havingParts.push(
          sql`SUM(CASE WHEN ${judgments.promptId} = ${promptId}::uuid AND (${normalized}) && ARRAY[${answeredValsArray}]::text[] THEN 1 ELSE 0 END) > 0`,
        )
      }

      const groupedBase = db
        .select({id: articles.id})
        .from(articles)
        .innerJoin(judgments, and(eq(judgments.articleId, articles.id), inArray(judgments.promptId, promptIds)))
        .where(combinedWhereCondition ? and(combinedWhereCondition, scopeCondition) : scopeCondition)
        .groupBy(articles.id)
        .having(havingParts.length > 1 ? and(...havingParts) : havingParts[0])
        .as('grouped_articles')

      const [{count: totalCount = 0} = {count: 0}] = await db.select({count: sql<number>`COUNT(*)`}).from(groupedBase)

      // Build a paged set of qualifying article ids to avoid massive IN (...) parameter lists
      const groupedPage = db
        .select({id: articles.id})
        .from(articles)
        .innerJoin(judgments, and(eq(judgments.articleId, articles.id), inArray(judgments.promptId, promptIds)))
        .where(combinedWhereCondition ? and(combinedWhereCondition, scopeCondition) : scopeCondition)
        .groupBy(articles.id)
        .having(havingParts.length > 1 ? and(...havingParts) : havingParts[0])
        .orderBy(desc(articles.articleCreatedAt))
        .limit(limit)
        .offset(offset)
        .as('page_articles')

      // Query the page of articles using the paged id set
      const articlesWithJudgments = await db
        .select({article: articles})
        .from(articles)
        .innerJoin(groupedPage, eq(groupedPage.id, articles.id))
        .orderBy(desc(articles.articleCreatedAt))

      // Fetch all judgments for the paged articles via join to the paged id set
      const allJudgmentRows = await db
        .select({judgment: judgments})
        .from(judgments)
        .innerJoin(groupedPage, eq(groupedPage.id, judgments.articleId))
        .where(inArray(judgments.promptId, promptIds))

      const judgmentsRows = allJudgmentRows.map(({judgment}) => {
        return judgment
      })

      // Group judgments by article
      const judgmentsByArticle = judgmentsRows.reduce<Record<string, Array<(typeof judgmentsRows)[number]>>>(
        (acc, judgment) => {
          const articleJudgments = acc[judgment.articleId] ?? []
          return {...acc, [judgment.articleId]: [...articleJudgments, judgment]}
        },
        {},
      )

      // Build prompt order map and sort judgments accordingly
      const promptOrderMap = projectPromptRows.reduce(
        (acc, p, idx) => {
          const ord = p.order ?? idx
          return {...acc, [p.id]: ord}
        },
        {} as Record<string, number>,
      )

      // Combine articles with their judgments sorted by prompt order
      const result = articlesWithJudgments.map(({article}) => {
        const unsorted = judgmentsByArticle[article.id] || []
        const sorted = [...unsorted].sort((a, b) => {
          const ao = promptOrderMap[a.promptId] ?? Number.MAX_SAFE_INTEGER
          const bo = promptOrderMap[b.promptId] ?? Number.MAX_SAFE_INTEGER
          return ao - bo
        })
        return {...article, judgments: sorted}
      })

      return {data: result, totalCount, page, limit, totalPages: Math.ceil(totalCount / limit)}
    } catch (error) {
      console.error('Error fetching articles reviews:', error)
      throw new Error(error instanceof Error ? error.message : 'Failed to fetch articles reviews')
    }
  },
  {
    body: t.Object({
      from: t.Optional(t.String()),
      limit: t.String(),
      page: t.String(),
      projectId: t.String(),
      prompts: t.Record(t.String(), t.Array(t.String())),
      to: t.Optional(t.String()),
      search: t.Optional(t.String()),
    }),
  },
)
