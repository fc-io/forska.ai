import {and, desc, eq, gte, inArray, lte, sql} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {articles, judgments, prompts} from '../../../db/schema.ts'
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

      // First get all prompts for this project
      const projectPrompts = await db.select().from(prompts).where(eq(prompts.projectId, body.projectId))

      if (projectPrompts.length === 0) {
        return {data: [], totalCount: 0, page, limit, totalPages: 0}
      }

      // Get articles that have judgments for ALL prompts of the project
      const promptIds = projectPrompts.map((p) => {
        return p.id
      })

      // Build the base query conditions
      const conditions: Array<ReturnType<typeof sql>> = []

      // Add filters for each prompt's answered_original if provided
      const promptFilters = Object.entries(body.prompts || {}).map(([key, value]) => {
        return [key, value] as const
      })

      console.log('promptFilters', promptFilters)

      // Apply prompt-specific filters using Drizzle subqueries
      for (const [promptId, answeredValue] of promptFilters) {
        const subquery = db
          .select({exists: sql`1`})
          .from(judgments)
          .where(
            and(
              eq(judgments.articleId, articles.id),
              eq(judgments.promptId, promptId),
              eq(judgments.answeredOriginal, answeredValue),
            ),
          )
          .limit(1)

        conditions.push(sql`EXISTS (${subquery})`)
      }

      // Build the base exists condition using Drizzle
      const baseExistsCondition = sql`EXISTS (
        ${db
          .select({exists: sql`1`})
          .from(judgments)
          .where(and(eq(judgments.articleId, articles.id), inArray(judgments.promptId, promptIds)))}
      )`

      // Build final where parts with optional date bounds
      const whereParts: Array<ReturnType<typeof sql>> =
        conditions.length > 0 ? [...conditions] : [baseExistsCondition]

      if (fromDate) {
        whereParts.push(gte(articles.createdAt, fromDate))
      }
      if (toDate) {
        whereParts.push(lte(articles.createdAt, toDate))
      }

      const combinedWhereCondition = whereParts.length > 1 ? and(...whereParts) : whereParts[0]

      // First, get the total count
      const countQuery = await db
        .select({count: sql<number>`COUNT(DISTINCT ${articles.id})`.as('count')})
        .from(articles)
        .where(combinedWhereCondition)
        .innerJoin(judgments, and(eq(judgments.articleId, articles.id), inArray(judgments.promptId, promptIds)))
        .groupBy(articles.id)
        .having(sql`COUNT(DISTINCT ${judgments.promptId}) = ${promptIds.length}`)

      const totalCount = countQuery.length

      // Query articles that have judgments for ALL prompts with pagination
      const articlesWithJudgments = await db
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
        .where(combinedWhereCondition)
        .having(sql`COUNT(DISTINCT ${judgments.promptId}) = ${promptIds.length}`)
        .innerJoin(judgments, and(eq(judgments.articleId, articles.id), inArray(judgments.promptId, promptIds)))
        .groupBy(articles.id)
        .orderBy(desc(articles.createdAt))
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

      // Combine articles with their judgments
      const result = articlesWithJudgments.map(({article}) => {
        return {...article, judgments: judgmentsByArticle[article.id] || []}
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
      prompts: t.Record(t.String(), t.String()),
      to: t.Optional(t.String()),
    }),
  },
)
