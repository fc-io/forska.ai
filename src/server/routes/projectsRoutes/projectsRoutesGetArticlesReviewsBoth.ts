import {and, desc, eq, gte, inArray, lte, sql} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {articles, judgments, judgmentsHuman, prompts} from '../../../db/schema.ts'
import {getDatabase} from '../../utils/getDatabase.ts'

export const projectsRoutesGetArticlesReviewsBoth = new Elysia().post(
  '/api/articlesreviewsboth',
  async ({body}) => {
    const db = getDatabase()

    const page = parseInt(body?.page || '1', 10)
    const limit = parseInt(body?.limit || '100', 10)
    const offset = (page - 1) * limit

    const fromDate = body.from ? new Date(`${body.from}T00:00:00.000Z`) : null
    const toDate = body.to ? new Date(`${body.to}T23:59:59.999Z`) : null
    const searchTitle = typeof body.search === 'string' ? body.search.trim() : ''

    // Get prompts for project
    const projectPrompts = await db.select().from(prompts).where(eq(prompts.projectId, body.projectId))
    if (projectPrompts.length === 0) {
      return {data: [], totalCount: 0, page, limit, totalPages: 0}
    }

    const promptIds = projectPrompts.map((p) => {
      return p.id
    })

    // Fully assessed by a single human for ALL prompts
    const fullyAssessedByHumanExists = sql`EXISTS (
      SELECT 1
      FROM ${judgmentsHuman} jh
      WHERE jh."article_id" = ${articles.id}
        AND jh."project_id" = ${body.projectId}::uuid
        AND jh."answer" IS NOT NULL
      GROUP BY jh."article_id", jh."user"
      HAVING COUNT(DISTINCT jh."prompt_id") = ${promptIds.length}
    )`

    // Prompt-specific filters for LLM judgments (answered_original)
    const promptFilters = Object.entries(body.prompts || {}).map(([key, values]) => {
      return [key, Array.isArray(values) ? values : [String(values)]] as const
    })

    const filterConditions: Array<ReturnType<typeof sql>> = []

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

      filterConditions.push(sql`EXISTS (${subquery})`)
    }

    const whereParts: Array<ReturnType<typeof sql>> = [fullyAssessedByHumanExists]
    if (filterConditions.length > 0) whereParts.push(...filterConditions)
    if (fromDate) whereParts.push(gte(articles.createdAt, fromDate))
    if (toDate) whereParts.push(lte(articles.createdAt, toDate))
    if (searchTitle) whereParts.push(sql`${articles.articleTitle} ILIKE ${'%' + searchTitle + '%'}`)

    const combinedWhere = whereParts.length > 1 ? and(...whereParts) : whereParts[0]

    // Count articles that have LLM judgments for ALL prompts AND satisfy human condition
    const countQuery = await db
      .select({count: sql<number>`COUNT(DISTINCT ${articles.id})`.as('count')})
      .from(articles)
      .where(combinedWhere)
      .innerJoin(judgments, and(eq(judgments.articleId, articles.id), inArray(judgments.promptId, promptIds)))
      .groupBy(articles.id)
      .having(sql`COUNT(DISTINCT ${judgments.promptId}) = ${promptIds.length}`)

    const totalCount = countQuery.length

    // Fetch paginated list
    const articlesWithBoth = await db
      .select({
        article: articles,
        judgmentCount: sql<number>`(
          ${db
            .select({count: sql`COUNT(DISTINCT ${judgments.promptId})`})
            .from(judgments)
            .where(and(eq(judgments.articleId, articles.id), inArray(judgments.promptId, promptIds)))}
        )`.as('judgment_count'),
      })
      .from(articles)
      .where(combinedWhere)
      .having(sql`COUNT(DISTINCT ${judgments.promptId}) = ${promptIds.length}`)
      .innerJoin(judgments, and(eq(judgments.articleId, articles.id), inArray(judgments.promptId, promptIds)))
      .groupBy(articles.id)
      .orderBy(desc(articles.createdAt))
      .limit(limit)
      .offset(offset)

    const articleIds = articlesWithBoth.map((a) => {
      return a.article.id
    })

    const allLlMJudgments =
      articleIds.length > 0
        ? await db
            .select()
            .from(judgments)
            .where(and(inArray(judgments.articleId, articleIds), inArray(judgments.promptId, promptIds)))
        : []

    const judgmentsByArticle = allLlMJudgments.reduce(
      (acc, j) => {
        const arr = acc[j.articleId] ?? []
        return {...acc, [j.articleId]: [...arr, j]}
      },
      {} as Record<string, typeof allLlMJudgments>,
    )

    const result = articlesWithBoth.map(({article}) => {
      return {...article, judgments: judgmentsByArticle[article.id] || []}
    })

    return {data: result, totalCount, page, limit, totalPages: Math.ceil(totalCount / limit)}
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
