import {and, desc, eq, sql} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {articles, judgments, prompts} from '../../../db/schema.ts'
import {getDatabase} from '../../utils/getDatabase.ts'

export const projectsRoutesGetArticlesWithJudgments = new Elysia().get(
  '/api/projects/:id/articles-with-judgments',
  async ({params, query}) => {
    try {
      const db = getDatabase()

      // First get all prompts for this project
      const projectPrompts = await db
        .select()
        .from(prompts)
        .where(eq(prompts.projectId, params.id))

      if (projectPrompts.length === 0) {
        return {data: [], error: null}
      }

      // Get articles that have judgments for ALL prompts of the project
      const promptIds = projectPrompts.map((p) => {
        return p.id
      })

      // Build the base query conditions
      const conditions = []

      // Add filter for answered_original if provided
      if (query.answered_original !== undefined) {
        const answeredOriginalValue =
          query.answered_original === 'true' ? 'yes' : 'no'
        conditions.push(
          sql`NOT EXISTS (
            SELECT 1 FROM ${judgments}
            WHERE ${judgments.articleId} = ${articles.id}
            AND ${judgments.promptId} = ANY(ARRAY[${sql.join(
              promptIds.map((id) => {
                return sql`${id}::uuid`
              }),
              sql`,`,
            )}])
            AND ${judgments.answeredOriginal} != ${answeredOriginalValue}
          )`,
        )
      }

      // Query articles that have judgments for ALL prompts
      const articlesWithJudgments = await db
        .select({
          article: articles,
          judgmentCount: sql<number>`(
            SELECT COUNT(DISTINCT ${judgments.promptId})
            FROM ${judgments}
            WHERE ${judgments.articleId} = ${articles.id}
            AND ${judgments.promptId} = ANY(ARRAY[${sql.join(
              promptIds.map((id) => {
                return sql`${id}::uuid`
              }),
              sql`,`,
            )}])
          )`.as('judgment_count'),
        })
        .from(articles)
        .where(
          conditions.length > 0
            ? and(...conditions)
            : sql`EXISTS (
                SELECT 1 FROM ${judgments}
                WHERE ${judgments.articleId} = ${articles.id}
                AND ${judgments.promptId} = ANY(ARRAY[${sql.join(
                  promptIds.map((id) => {
                    return sql`${id}::uuid`
                  }),
                  sql`,`,
                )}])
              )`,
        )
        .having(
          sql`COUNT(DISTINCT ${judgments.promptId}) = ${promptIds.length}`,
        )
        .innerJoin(
          judgments,
          and(
            eq(judgments.articleId, articles.id),
            sql`${judgments.promptId} = ANY(ARRAY[${sql.join(
              promptIds.map((id) => {
                return sql`${id}::uuid`
              }),
              sql`,`,
            )}])`,
          ),
        )
        .groupBy(articles.id)
        .orderBy(desc(articles.createdAt))

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
                  sql`${judgments.articleId} = ANY(ARRAY[${sql.join(
                    articleIds.map((id) => {
                      return sql`${id}::uuid`
                    }),
                    sql`,`,
                  )}])`,
                  sql`${judgments.promptId} = ANY(ARRAY[${sql.join(
                    promptIds.map((id) => {
                      return sql`${id}::uuid`
                    }),
                    sql`,`,
                  )}])`,
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

      return {data: result, error: null}
    } catch (error) {
      console.error('Error fetching articles with judgments:', error)
      return {
        data: [],
        error:
          error instanceof Error
            ? error.message
            : 'Failed to fetch articles with judgments',
      }
    }
  },
  {
    params: t.Object({id: t.String()}),
    query: t.Object({answered_original: t.Optional(t.String())}),
  },
)
