import {and, desc, eq, inArray, sql} from 'drizzle-orm'
import {Elysia} from 'elysia'

import {articles, judgments, prompts} from '../../../db/schema.ts'
import {getDatabase} from '../../utils/getDatabase.ts'

export const projectsRoutesGetArticlesReviews = new Elysia().get(
  '/api/articlesreviews',
  async ({
    query,
  }: {
    query: {
      from: string
      limit: string
      page: string
      projectId: string
      prompts: string
      to: string
    }
  }) => {
    console.log('--------------------------------')
    console.log('--------------------------------')
    console.log('--------------------------------')
    console.log('--------------------------------')
    console.log('--------------------------------')
    console.log('--------------------------------')
    console.log('articlesreviews', query)
    console.log('--------------------------------')
    try {
      const db = getDatabase()

      // Parse pagination params with defaults
      const page = parseInt(query?.page || '1', 10)
      const limit = parseInt(query?.limit || '100', 10)
      const offset = (page - 1) * limit

      // First get all prompts for this project
      const projectPrompts = await db
        .select()
        .from(prompts)
        .where(eq(prompts.projectId, query.projectId))

      if (projectPrompts.length === 0) {
        return {data: [], totalCount: 0, page, limit, totalPages: 0}
      }

      // Get articles that have judgments for ALL prompts of the project
      const promptIds = projectPrompts.map((p) => {
        return p.id
      })

      // Build the base query conditions
      const conditions = []

      // Add filters for each prompt's answered_original if provided
      const parsedPrompts = JSON.parse(query.prompts) as Record<string, string>
      const promptFilters = Object.entries(parsedPrompts).map(
        ([key, value]) => {
          return [key, value] as const
        },
      )

      console.log('--------------------------------')
      console.log('--------------------------------')
      console.log('promptFilters', promptFilters)
      console.log('--------------------------------')

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
          .where(
            and(
              eq(judgments.articleId, articles.id),
              inArray(judgments.promptId, promptIds),
            ),
          )}
      )`

      // First, get the total count
      const countQuery = await db
        .select({
          count: sql<number>`COUNT(DISTINCT ${articles.id})`.as('count'),
        })
        .from(articles)
        .where(conditions.length > 0 ? and(...conditions) : baseExistsCondition)
        .innerJoin(
          judgments,
          and(
            eq(judgments.articleId, articles.id),
            inArray(judgments.promptId, promptIds),
          ),
        )
        .groupBy(articles.id)
        .having(
          sql`COUNT(DISTINCT ${judgments.promptId}) = ${promptIds.length}`,
        )

      const totalCount = countQuery.length

      // Query articles that have judgments for ALL prompts with pagination
      const articlesWithJudgments = await db
        .select({
          article: articles,
          judgmentCount: sql<number>`(
            ${db
              .select({count: sql`COUNT(DISTINCT ${judgments.promptId})`})
              .from(judgments)
              .where(
                and(
                  eq(judgments.articleId, articles.id),
                  inArray(judgments.promptId, promptIds),
                ),
              )}
          )`.as('judgment_count'),
        })
        .from(articles)
        .where(conditions.length > 0 ? and(...conditions) : baseExistsCondition)
        .having(
          sql`COUNT(DISTINCT ${judgments.promptId}) = ${promptIds.length}`,
        )
        .innerJoin(
          judgments,
          and(
            eq(judgments.articleId, articles.id),
            inArray(judgments.promptId, promptIds),
          ),
        )
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
              .where(
                and(
                  inArray(judgments.articleId, articleIds),
                  inArray(judgments.promptId, promptIds),
                ),
              )
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

      return {
        data: result,
        totalCount,
        page,
        limit,
        totalPages: Math.ceil(totalCount / limit),
      }
    } catch (error) {
      console.error('Error fetching articles reviews:', error)
      throw new Error(
        error instanceof Error
          ? error.message
          : 'Failed to fetch articles reviews',
      )
    }
  },
)
