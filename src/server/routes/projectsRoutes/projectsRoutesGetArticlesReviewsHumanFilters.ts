import {and, eq, gte, lte, sql} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {articles, judgmentsHuman, prompts} from '../../../db/schema.ts'
import {getDatabase} from '../../utils/getDatabase.ts'

export const projectsRoutesGetArticlesReviewsHumanFilters = new Elysia().get(
  '/api/articlesreviewshumanfilters',
  async ({query, set}) => {
    try {
      const db = getDatabase()

      if (!query?.projectId) {
        set.status = 400
        throw new Error('Project ID is required')
      }

      const fromDate = query?.from ? new Date(`${query.from}T00:00:00.000Z`) : null
      const toDate = query?.to ? new Date(`${query.to}T23:59:59.999Z`) : null
      const searchTitle = typeof query?.search === 'string' ? query.search.trim() : ''

      const projectPrompts = await db
        .select({id: prompts.id, promptHeading: prompts.promptHeading, originalText: prompts.originalText})
        .from(prompts)
        .where(eq(prompts.projectId, query.projectId))

      if (projectPrompts.length === 0) {
        return []
      }

      const promptFilters = await Promise.all(
        projectPrompts.map(async (prompt) => {
          const base = sql`SELECT DISTINCT ${judgmentsHuman.answer} as answer
                FROM ${judgmentsHuman}
                INNER JOIN ${articles} ON ${articles.id} = ${judgmentsHuman.articleId}
                WHERE ${judgmentsHuman.promptId} = ${prompt.id}::uuid
                AND ${judgmentsHuman.answer} IS NOT NULL`

          let scoped = base
          if (fromDate && toDate) {
            scoped = sql`${scoped} AND ${and(gte(articles.createdAt, fromDate), lte(articles.createdAt, toDate))}`
          }
          if (searchTitle) {
            scoped = sql`${scoped} AND ${articles.articleTitle} ILIKE ${'%' + searchTitle + '%'}`
          }
          const dateScoped = sql`${scoped} ORDER BY ${judgmentsHuman.answer}`

          const uniqueValues = await db.execute<{answer: string}>(dateScoped)

          return {
            promptId: prompt.id,
            promptName: prompt.promptHeading || prompt.originalText,
            answeredOriginalValues: uniqueValues.rows.map((v) => v.answer),
          }
        }),
      )

      return promptFilters
    } catch (error) {
      console.error('Error fetching human articles reviews filters:', error)
      set.status = 500
      throw new Error(error instanceof Error ? error.message : 'Failed to fetch human articles reviews filters')
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

