import {eq, sql} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {judgments, prompts} from '../../../db/schema.ts'
import {getDatabase} from '../../utils/getDatabase.ts'

export const projectsRoutesGetArticlesReviewsFilters = new Elysia().get(
  '/api/articlesreviewsfilters',
  async ({query, set}) => {
    console.log('--------------------------------')
    console.log('--------------------------------')
    console.log('--------------------------------')
    console.log('--------------------------------')
    console.log('--------------------------------')
    console.log('--------------------------------')
    console.log('articlesreviewsfilters', query)
    console.log('--------------------------------')
    try {
      const db = getDatabase()

      if (!query?.projectId) {
        set.status = 400
        throw new Error('Project ID is required')
      }

      // Get all prompts for this project
      const projectPrompts = await db
        .select({id: prompts.id, promptHeading: prompts.promptHeading, originalText: prompts.originalText})
        .from(prompts)
        .where(eq(prompts.projectId, query.projectId))

      if (projectPrompts.length === 0) {
        return []
      }

      // For each prompt, get unique answered_original values
      const promptFilters = await Promise.all(
        projectPrompts.map(async (prompt) => {
          const uniqueValues = await db.execute<{answered_original: string}>(
            sql`SELECT DISTINCT answered_original
                FROM ${judgments}
                WHERE prompt_id = ${prompt.id}::uuid
                ORDER BY answered_original`,
          )

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
  {query: t.Object({projectId: t.String()})},
)
