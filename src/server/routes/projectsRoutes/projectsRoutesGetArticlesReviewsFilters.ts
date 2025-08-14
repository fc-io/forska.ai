import {eq, sql} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {judgments, prompts} from '../../../db/schema.ts'
import {getDatabase} from '../../utils/getDatabase.ts'

export const projectsRoutesGetArticlesReviewsFilters = new Elysia().get(
  '/api/projects/:id/articles-reviews-filters',
  async ({params}) => {
    try {
      const db = getDatabase()

      // Get all prompts for this project
      const projectPrompts = await db
        .select({
          id: prompts.id,
          promptHeading: prompts.promptHeading,
          originalText: prompts.originalText,
        })
        .from(prompts)
        .where(eq(prompts.projectId, params.id))

      if (projectPrompts.length === 0) {
        return {data: [], error: null}
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

      return {data: promptFilters, error: null}
    } catch (error) {
      console.error('Error fetching articles reviews filters:', error)
      return {
        data: [],
        error:
          error instanceof Error
            ? error.message
            : 'Failed to fetch articles reviews filters',
      }
    }
  },
  {params: t.Object({id: t.String()})},
)
