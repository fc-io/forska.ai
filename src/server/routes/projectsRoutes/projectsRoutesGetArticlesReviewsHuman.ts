import {and, desc, eq, gte, inArray, lte, or, sql} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {
  articleRouteLink,
  articles,
  judgmentsHuman,
  projectArticles,
  projectRouteLink,
  projects,
  prompts,
  projectPrompts,
} from '../../../db/schema.ts'
import {getDatabase} from '../../utils/getDatabase.ts'

export const projectsRoutesGetArticlesReviewsHuman = new Elysia().post(
  '/api/articlesreviewshuman',
  async ({body}) => {
    try {
      const db = getDatabase()

      const page = parseInt(body?.page || '1', 10)
      const limit = parseInt(body?.limit || '100', 10)
      const offset = (page - 1) * limit

      const fromDate = body.from ? new Date(`${body.from}T00:00:00.000Z`) : null
      const toDate = body.to ? new Date(`${body.to}T23:59:59.999Z`) : null
      const searchTitle = typeof body.search === 'string' ? body.search.trim() : ''

      // Get prompts for the project (ordered)
      const projectPromptRows = await db
        .select({id: prompts.id, order: projectPrompts.order})
        .from(projectPrompts)
        .innerJoin(prompts, eq(projectPrompts.promptId, prompts.id))
        .where(and(eq(projectPrompts.projectId, body.projectId), eq(projectPrompts.enabled, true)))
        .orderBy(projectPrompts.order)
      if (projectPromptRows.length === 0) {
        return {data: [], totalCount: 0, page, limit, totalPages: 0}
      }

      const promptIds = projectPromptRows.map((p) => {
        return p.id
      })

      // Base condition: Article is fully assessed by at least one human user for all project prompts
      const fullyAssessedByHumanExists = sql`EXISTS (
        SELECT 1
        FROM ${judgmentsHuman} jh
        WHERE jh."article_id" = ${articles.id}
          AND jh."project_id" = ${body.projectId}::uuid
          AND jh."is_answered" = true
        GROUP BY jh."article_id", jh."user"
        HAVING COUNT(DISTINCT jh."prompt_id") = ${promptIds.length}
      )`

      // Prompt-specific filters (answers)
      const promptFilters = Object.entries(body.prompts || {}).map(([key, values]) => {
        return [key, Array.isArray(values) ? values : [String(values)]] as const
      })

      const conditions: Array<ReturnType<typeof sql>> = []

      for (const [promptId, answers] of promptFilters) {
        const subquery = db
          .select({exists: sql`1`})
          .from(judgmentsHuman)
          .where(
            and(
              eq(judgmentsHuman.articleId, articles.id),
              eq(judgmentsHuman.promptId, promptId),
              inArray(judgmentsHuman.answer, answers),
            ),
          )
          .limit(1)

        conditions.push(sql`EXISTS (${subquery})`)
      }

      // Always scope to project's configured import routes and project date bounds
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
              projectImportRoutes.map((r) => sql`${r.importRouteId}::uuid`),
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

      const whereParts: Array<ReturnType<typeof sql>> =
        conditions.length > 0
          ? [
              fullyAssessedByHumanExists,
              hasMatchingImportRoute ? or(hasMatchingImportRoute, hasProjectArticle) : hasProjectArticle,
              ...conditions,
            ]
          : [
              fullyAssessedByHumanExists,
              hasMatchingImportRoute ? or(hasMatchingImportRoute, hasProjectArticle) : hasProjectArticle,
            ]

      if (projectBounds?.dateFrom) {
        whereParts.push(gte(articles.articleCreatedAt, projectBounds.dateFrom))
      }
      if (projectBounds?.dateTo) {
        whereParts.push(lte(articles.articleCreatedAt, projectBounds.dateTo))
      }
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

      // Count total distinct articles
      const countQuery = await db
        .select({count: sql<number>`COUNT(DISTINCT ${articles.id})`.as('count')})
        .from(articles)
        .where(combinedWhereCondition)

      const totalCount = countQuery[0]?.count ?? 0

      // Fetch paginated list
      const articlesWithHumanJudgments = await db
        .select({article: articles})
        .from(articles)
        .where(combinedWhereCondition)
        .orderBy(desc(articles.articleCreatedAt))
        .limit(limit)
        .offset(offset)

      const articleIds = articlesWithHumanJudgments.map((a) => {
        return a.article.id
      })

      const allHumanJudgments =
        articleIds.length > 0
          ? await db
              .select()
              .from(judgmentsHuman)
              .where(and(inArray(judgmentsHuman.articleId, articleIds), inArray(judgmentsHuman.promptId, promptIds)))
          : []

      const judgmentsByArticle = allHumanJudgments.reduce(
        (acc, j) => {
          const arr = acc[j.articleId] ?? []
          return {...acc, [j.articleId]: [...arr, j]}
        },
        {} as Record<string, typeof allHumanJudgments>,
      )

      // Build prompt order map and sort judgments accordingly
      const promptOrderMap = projectPromptRows.reduce(
        (acc, p, idx) => {
          const ord = (p.order ?? idx) as number
          return {...acc, [p.id]: ord}
        },
        {} as Record<string, number>,
      )

      const result = articlesWithHumanJudgments.map(({article}) => {
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
      console.error('Error fetching human articles reviews:', error)
      throw new Error(error instanceof Error ? error.message : 'Failed to fetch human articles reviews')
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
