import {and, desc, eq, gte, inArray, isNull, lte, or, sql} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {
  importRoute,
  judgments,
  projectArticles,
  projectPrompts,
  projectRouteLink,
  projects,
  prompts,
} from '../../../db/schema.ts'
import {getDatabase} from '../../utils/getDatabase.ts'

/**
 * Optimized articles reviews API using denormalized judgment fields.
 *
 * Key optimizations:
 * 1. Query judgments directly (no JOIN to articles table)
 * 2. Use denormalized fields: articleTitle, articleCreatedAt, articleImportRoute
 * 3. Use subquery for project_articles (scales well for large curated article sets)
 * 4. Match import routes by TEXT instead of UUID EXISTS
 */
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

      // === PARALLEL METADATA QUERIES ===
      // Run these concurrently for better performance
      console.time('parallel metadata queries')
      const [projectPromptRows, projectBoundsResult, projectImportRouteTexts] = await Promise.all([
        // 1a. Get enabled prompts for project
        db
          .select({id: prompts.id, order: projectPrompts.order})
          .from(projectPrompts)
          .innerJoin(prompts, eq(projectPrompts.promptId, prompts.id))
          .where(and(eq(projectPrompts.projectId, body.projectId), eq(projectPrompts.enabled, true)))
          .orderBy(projectPrompts.order),

        // 1b. Get project date bounds
        db
          .select({dateFrom: projects.dateFrom, dateTo: projects.dateTo})
          .from(projects)
          .where(eq(projects.id, body.projectId))
          .limit(1),

        // 1c. Get import routes as TEXT (not UUID!)
        db
          .select({route: importRoute.route})
          .from(projectRouteLink)
          .innerJoin(importRoute, eq(projectRouteLink.importRouteId, importRoute.id))
          .where(eq(projectRouteLink.projectId, body.projectId)),
      ])
      console.timeEnd('parallel metadata queries')

      if (projectPromptRows.length === 0) {
        return {data: [], totalCount: 0, page, limit, totalPages: 0}
      }

      console.time('query preparation')
      const promptIds = projectPromptRows.map((p) => {
        return p.id
      })
      const projectBounds = projectBoundsResult[0]
      const routeTexts = projectImportRouteTexts.map((r) => {
        return r.route
      })
      const hasImportRoutes = routeTexts.length > 0

      // Add filters for each prompt's answered_original if provided
      const promptFilters = Object.entries(body.prompts || {}).map(([key, values]) => {
        return [key, Array.isArray(values) ? values : [String(values)]] as const
      })

      console.log('promptFilters', promptFilters)

      // === BUILD WHERE CONDITIONS ===
      // All conditions now use denormalized judgment fields (no articles table!)
      const whereParts: Array<ReturnType<typeof sql>> = [
        inArray(judgments.promptId, promptIds),
        isNull(judgments.deletedAt), // Soft delete filter
      ]

      // Project date bounds (using denormalized articleCreatedAt)
      if (projectBounds?.dateFrom) {
        whereParts.push(gte(judgments.articleCreatedAt, projectBounds.dateFrom))
      }
      if (projectBounds?.dateTo) {
        whereParts.push(lte(judgments.articleCreatedAt, projectBounds.dateTo))
      }

      // UI date filters
      if (fromDate) {
        whereParts.push(gte(judgments.articleCreatedAt, fromDate))
      }
      if (toDate) {
        whereParts.push(lte(judgments.articleCreatedAt, toDate))
      }

      // Search filter (using denormalized articleTitle)
      if (searchTitle) {
        whereParts.push(sql`${judgments.articleTitle} ILIKE ${'%' + searchTitle + '%'}`)
      }

      // === SCOPE CONDITION ===
      // Match by import route TEXT or curated articles subquery
      const scopeConditions: Array<ReturnType<typeof sql>> = []

      // Import route match using denormalized articleImportRoute
      if (hasImportRoutes) {
        const routeTextsArray = sql.join(
          routeTexts.map((r) => {
            return sql`${r}`
          }),
          sql`,`,
        )
        scopeConditions.push(sql`${judgments.articleImportRoute} = ANY(ARRAY[${routeTextsArray}])`)
      }

      // Curated articles - use subquery (scales well for large sets)
      scopeConditions.push(
        sql`${judgments.articleId} IN (
          SELECT pa."article_id" FROM ${projectArticles} pa
          WHERE pa."project_id" = ${body.projectId}::uuid
        )`,
      )

      // Combine scope with OR (scopeConditions always has at least 1 element)
      const scopeOr = scopeConditions.length > 1 ? or(...scopeConditions) : scopeConditions[0]
      if (scopeOr) {
        whereParts.push(scopeOr)
      }

      const combinedWhereCondition = and(...whereParts)

      // === HAVING CONDITIONS ===
      // Require all prompts answered, and filter by selected answer values
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

      const havingCondition = havingParts.length > 1 ? and(...havingParts) : havingParts[0]
      console.timeEnd('query preparation')

      // === COUNT QUERY ===
      // Group by articleId directly from judgments (no articles table join!)
      console.time('count query')
      const groupedBase = db
        .select({articleId: judgments.articleId})
        .from(judgments)
        .where(combinedWhereCondition)
        .groupBy(judgments.articleId)
        .having(havingCondition)
        .as('grouped_articles')

      const [{count: totalCount = 0} = {count: 0}] = await db.select({count: sql<number>`COUNT(*)`}).from(groupedBase)
      console.timeEnd('count query')

      // === PAGINATED QUERY ===
      // Get page of article IDs, ordered by articleCreatedAt (denormalized)
      console.time('paginated judgments fetch')
      const groupedPage = db
        .select({
          articleId: judgments.articleId,
          articleCreatedAt: sql<Date>`MAX(${judgments.articleCreatedAt})`.as('article_created_at'),
        })
        .from(judgments)
        .where(combinedWhereCondition)
        .groupBy(judgments.articleId)
        .having(havingCondition)
        .orderBy(desc(sql`MAX(${judgments.articleCreatedAt})`))
        .limit(limit)
        .offset(offset)
        .as('page_articles')

      // === FETCH JUDGMENTS FOR PAGE ===
      // Get all judgments for the paged articles
      const allJudgmentRows = await db
        .select({judgment: judgments})
        .from(judgments)
        .innerJoin(groupedPage, eq(groupedPage.articleId, judgments.articleId))
        .where(and(inArray(judgments.promptId, promptIds), isNull(judgments.deletedAt)))
      console.timeEnd('paginated judgments fetch')

      console.time('result processing')
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

      // === BUILD RESULT ===
      // Use denormalized fields from judgments to construct article data
      const result = Object.entries(judgmentsByArticle).map(([articleId, articleJudgments]) => {
        // Sort judgments by prompt order
        const sorted = [...articleJudgments].sort((a, b) => {
          const ao = promptOrderMap[a.promptId] ?? Number.MAX_SAFE_INTEGER
          const bo = promptOrderMap[b.promptId] ?? Number.MAX_SAFE_INTEGER
          return ao - bo
        })

        // Use denormalized article data from any judgment (they all have the same values)
        const firstJudgment = sorted[0]

        return {
          id: articleId,
          articleTitle: firstJudgment?.articleTitle ?? null,
          articleCreatedAt: firstJudgment?.articleCreatedAt ?? null,
          articleUpdatedAt: firstJudgment?.articleUpdatedAt ?? null,
          judgments: sorted,
        }
      })

      // Sort result by articleCreatedAt descending (to match pagination order)
      result.sort((a, b) => {
        const aDate = a.articleCreatedAt?.getTime() ?? 0
        const bDate = b.articleCreatedAt?.getTime() ?? 0
        return bDate - aDate
      })
      console.timeEnd('result processing')
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
