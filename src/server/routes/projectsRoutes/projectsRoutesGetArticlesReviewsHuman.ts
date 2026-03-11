import {and, desc, eq, gte, inArray, lte, or, sql} from 'drizzle-orm'
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

      // OPTIMIZATION: Start from the small judgmentsHuman table instead of the large articles table.
      // Step 1: Find all article IDs that are fully assessed.
      const fullyAssessedArticleIdsQuery = await db
        .select({articleId: judgmentsHuman.articleId})
        .from(judgmentsHuman)
        .where(
          and(
            eq(judgmentsHuman.projectId, body.projectId),
            eq(judgmentsHuman.isAnswered, true),
            inArray(judgmentsHuman.promptId, promptIds),
          ),
        )
        .groupBy(judgmentsHuman.articleId)
        .having(sql`COUNT(DISTINCT ${judgmentsHuman.promptId}) = ${promptIds.length}`)

      const fullyAssessedArticleIds = [
        ...new Set(
          fullyAssessedArticleIdsQuery.map((r) => {
            return r.articleId
          }),
        ),
      ]

      // If no articles are fully assessed by humans, return early
      if (fullyAssessedArticleIds.length === 0) {
        return {data: [], totalCount: 0, page, limit, totalPages: 0}
      }

      // Step 2: Apply prompt-specific answer filters (if any) to narrow down the article set
      const promptFilters = Object.entries(body.prompts || {}).map(([key, values]) => {
        return [key, Array.isArray(values) ? values : [String(values)]] as const
      })

      let candidateArticleIds = fullyAssessedArticleIds

      for (const [promptId, answers] of promptFilters) {
        // Find articles in candidateArticleIds that have a matching human answer for this prompt
        const matchingArticles = await db
          .select({articleId: judgmentsHuman.articleId})
          .from(judgmentsHuman)
          .where(
            and(
              inArray(judgmentsHuman.articleId, candidateArticleIds),
              eq(judgmentsHuman.promptId, promptId),
              inArray(judgmentsHuman.answer, answers),
            ),
          )
        candidateArticleIds = [
          ...new Set(
            matchingArticles.map((r) => {
              return r.articleId
            }),
          ),
        ]
        if (candidateArticleIds.length === 0) {
          return {data: [], totalCount: 0, page, limit, totalPages: 0}
        }
      }

      // Step 3: Get project bounds and import routes for article scoping
      const [projectBounds] = await db
        .select({dateFrom: projects.dateFrom, dateTo: projects.dateTo})
        .from(projects)
        .where(eq(projects.id, body.projectId))
        .limit(1)

      const projectImportRoutes = await db
        .select({importRouteId: projectRouteLink.importRouteId})
        .from(projectRouteLink)
        .where(eq(projectRouteLink.projectId, body.projectId))

      const routeIds = projectImportRoutes.map((row) => {
        return row.importRouteId
      })

      const hasMatchingImportRoute =
        routeIds.length > 0
          ? sql`EXISTS (
            SELECT 1 FROM ${articleRouteLink} arl
            WHERE arl."article_id" = ${articles.id}
              AND ${inArray(articleRouteLink.importRouteId, routeIds)}
          )`
          : null
      const hasProjectArticle = sql`EXISTS (
        SELECT 1 FROM ${projectArticles} pa
        WHERE pa."article_id" = ${articles.id}
          AND pa."project_id" = ${body.projectId}
      )`

      // Step 4: Build final WHERE conditions for articles (using the pre-filtered candidate IDs)
      const whereParts: Array<ReturnType<typeof sql>> = [inArray(articles.id, candidateArticleIds)]
      // Scope to project's import routes or curated project articles
      if (hasMatchingImportRoute) {
        const scopeCondition = or(hasMatchingImportRoute, hasProjectArticle)
        if (scopeCondition) {
          whereParts.push(scopeCondition)
        }
      } else {
        whereParts.push(hasProjectArticle)
      }

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
        whereParts.push(sql`LOWER(${articles.articleTitle}) LIKE ${'%' + searchTitle.toLowerCase() + '%'}`)
      }

      const combinedWhereCondition = whereParts.length > 1 ? and(...whereParts) : whereParts[0]

      // Count total distinct articles (now much faster since we're filtering by candidateArticleIds)
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
          const ord = p.order ?? idx
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
