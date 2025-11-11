import {and, eq, gte, lte, sql} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {articles, judgments, prompts, projectPrompts} from '../../../db/schema.ts'
import {getDatabase} from '../../utils/getDatabase.ts'

export const projectsRoutesGetArticlesReviewsFilters = new Elysia().get(
  '/api/articlesreviewsfilters',
  async ({query, set}) => {
    console.log('articlesreviewsfilters', query)
    try {
      const db = getDatabase()

      if (!query?.projectId) {
        set.status = 400
        throw new Error('Project ID is required')
      }

      const fromDate = query?.from ? new Date(`${query.from}T00:00:00.000Z`) : null
      const toDate = query?.to ? new Date(`${query.to}T23:59:59.999Z`) : null
      const searchTitle = typeof query?.search === 'string' ? query.search.trim() : ''

      // Get all prompts for this project
      const projectPrompts = await db
        .select({
          id: prompts.id,
          promptHeading: prompts.promptHeading,
          originalText: prompts.originalText,
        })
        .from(projectPrompts)
        .innerJoin(prompts, eq(projectPrompts.promptId, prompts.id))
        .where(eq(projectPrompts.projectId, query.projectId))

      if (projectPrompts.length === 0) {
        return []
      }

      // For each prompt, get unique answered_original values (optionally scoped by date range)
      const promptFilters = await Promise.all(
        projectPrompts.map(async (prompt) => {
          const base = sql`SELECT DISTINCT ${judgments.answeredOriginal} as answered_original
                FROM ${judgments}
                INNER JOIN ${articles} ON ${articles.id} = ${judgments.articleId}
                WHERE ${judgments.promptId} = ${prompt.id}::uuid`

          let scoped = base
          if (fromDate && toDate) {
            scoped = sql`${scoped} AND ${and(gte(articles.createdAt, fromDate), lte(articles.createdAt, toDate))}`
          }
          if (searchTitle) {
            scoped = sql`${scoped} AND ${articles.articleTitle} ILIKE ${'%' + searchTitle + '%'}`
          }
          const dateScoped = sql`${scoped} ORDER BY ${judgments.answeredOriginal}`

          const uniqueValues = await db.execute<{answered_original: string}>(dateScoped)

          return {
            promptId: prompt.id,
            promptName: prompt.promptHeading || prompt.originalText,
            answeredOriginalValues: uniqueValues.rows.map((v) => {
              return v.answered_original
            }),
          }
        }),
      )

      return promptFilters
    } catch (error) {
      console.error('Error fetching articles reviews filters:', error)
      set.status = 500
      throw new Error(error instanceof Error ? error.message : 'Failed to fetch articles reviews filters')
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
