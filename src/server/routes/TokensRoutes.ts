import {sum} from 'drizzle-orm'
import {Elysia} from 'elysia'

import {tokenUse} from '../../db/schema.ts'
import {getDatabase} from '../utils/getDatabase.ts'

export const tokensRoutes = new Elysia().get('/api/tokens', async () => {
  try {
    const db = getDatabase()
    const result = await db
      .select({
        totalPromptTokens: sum(tokenUse.totalPromptTokens),
        totalCompletionTokens: sum(tokenUse.totalCompletionTokens),
        totalTokens: sum(tokenUse.totalTokens),
      })
      .from(tokenUse)

    const row = result[0]
    return {
      totalPromptTokens: row?.totalPromptTokens
        ? Number(row.totalPromptTokens)
        : 0,
      totalCompletionTokens: row?.totalCompletionTokens
        ? Number(row.totalCompletionTokens)
        : 0,
      totalTokens: row?.totalPromptTokens ? Number(row.totalPromptTokens) : 0,
    }
  } catch (error) {
    console.error('Error fetching token usage:', error)
    return {
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalTokens: 0,
      error: 'Failed to fetch token usage',
    }
  }
})
