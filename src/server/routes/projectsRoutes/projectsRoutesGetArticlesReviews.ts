import {and, desc, eq, gte, inArray, lte, sql} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {
  articleRouteLink,
  articles,
  judgments,
  projectRouteLink,
  projects,
  prompts,
  projectPrompts,
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
        .where(eq(projectPrompts.projectId, body.projectId))
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

      // Apply prompt-specific filters using Drizzle subqueries
      for (const [promptId, answeredValues] of promptFilters) {
        const subquery = db
          .select({exists: sql`1`})
          .from(judgments)
          .where(
            and(
              eq(judgments.articleId, articles.id),
              eq(judgments.promptId, promptId),
              inArray(judgments.answeredOriginal, answeredValues),
            ),
          )
          .limit(1)

        conditions.push(sql`EXISTS (${subquery})`)
      }

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

      if (projectImportRoutes.length === 0) {
        return {data: [], totalCount: 0, page, limit, totalPages: 0}
      }

      const routeIdArray = sql.join(
        projectImportRoutes.map((r) => {
          return sql`${r.importRouteId}::uuid`
        }),
        sql`,`,
      )

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

      // Build grouped base query once, then count rows in a subquery (fast COUNT(*))
      const groupedBase = db
        .select({id: articles.id})
        .from(articles)
        .innerJoin(articleRouteLink, eq(articleRouteLink.articleId, articles.id))
        .innerJoin(judgments, and(eq(judgments.articleId, articles.id), inArray(judgments.promptId, promptIds)))
        .where(
          combinedWhereCondition
            ? and(combinedWhereCondition, sql`${articleRouteLink.importRouteId} = ANY(ARRAY[${routeIdArray}])`)
            : sql`${articleRouteLink.importRouteId} = ANY(ARRAY[${routeIdArray}])`,
        )
        .groupBy(articles.id)
        .having(sql`COUNT(DISTINCT ${judgments.promptId}) = ${promptIds.length}`)
        .as('grouped_articles')

      const [{count: totalCount = 0} = {count: 0}] = await db
        .select({count: sql<number>`COUNT(*)`})
        .from(groupedBase)

      // Query articles that have judgments for ALL prompts with pagination
      const articlesWithJudgments = await db
        .select({
          article: articles,
        })
        .from(articles)
        .innerJoin(articleRouteLink, eq(articleRouteLink.articleId, articles.id))
        .innerJoin(judgments, and(eq(judgments.articleId, articles.id), inArray(judgments.promptId, promptIds)))
        .where(
          combinedWhereCondition
            ? and(combinedWhereCondition, sql`${articleRouteLink.importRouteId} = ANY(ARRAY[${routeIdArray}])`)
            : sql`${articleRouteLink.importRouteId} = ANY(ARRAY[${routeIdArray}])`,
        )
        .having(sql`COUNT(DISTINCT ${judgments.promptId}) = ${promptIds.length}`)
        .groupBy(articles.id)
        .orderBy(desc(articles.articleCreatedAt))
        .limit(limit)
        .offset(offset)

      // Get the judgments for each article
      const articleIds = articlesWithJudgments.map((a) => {
        return a.article.id
      })

      const allJudgments =
        articleIds.length > 0
          ? await db
              .select()
              .from(judgments)
              .where(and(inArray(judgments.articleId, articleIds), inArray(judgments.promptId, promptIds)))
          : []

      // Group judgments by article
      const judgmentsByArticle = allJudgments.reduce(
        (acc, judgment) => {
          const articleJudgments = acc[judgment.articleId] ?? []
          return {...acc, [judgment.articleId]: [...articleJudgments, judgment]}
        },
        {} as Record<string, typeof allJudgments>,
      )

      // Build prompt order map and sort judgments accordingly
      const promptOrderMap = projectPromptRows.reduce(
        (acc, p, idx) => {
          const ord = (p.order ?? idx) as number
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
