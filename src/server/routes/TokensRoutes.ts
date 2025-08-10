import {Elysia} from 'elysia'

import {getDatabase} from '../utils/getDatabase.ts'

export const tokensRoutes = new Elysia().get(
  '/api/tokens/all-time',
  async () => {
    try {
      const db = getDatabase()
      const result = await db.execute<{
        total_prompt_tokens: string | null
        total_completion_tokens: string | null
      }>(
        `SELECT
         SUM(total_prompt_tokens) as total_prompt_tokens,
         SUM(total_completion_tokens) as total_completion_tokens
       FROM token_use`,
      )

      const row = result.rows[0]
      return {
        totalPromptTokens: row?.total_prompt_tokens
          ? parseInt(row.total_prompt_tokens, 10)
          : 0,
        totalCompletionTokens: row?.total_completion_tokens
          ? parseInt(row.total_completion_tokens, 10)
          : 0,
      }
    } catch (error) {
      console.error('Error fetching all-time token usage:', error)
      return {
        totalPromptTokens: null,
        totalCompletionTokens: null,
        error: 'Failed to fetch token usage',
      }
    }
  },
)
