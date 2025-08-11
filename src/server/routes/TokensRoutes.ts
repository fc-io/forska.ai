import {and, between, gte, lte, sum} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {tokenUse} from '../../db/schema.ts'
import {getDatabase} from '../utils/getDatabase.ts'

export const tokensRoutes = new Elysia().get(
  '/api/tokens',
  async ({query}) => {
    try {
      const db = getDatabase()

      // Build where conditions based on query params
      const conditions = []

      if (query.startTime) {
        conditions.push(gte(tokenUse.createdAt, new Date(query.startTime)))
      }

      if (query.endTime) {
        conditions.push(lte(tokenUse.createdAt, new Date(query.endTime)))
      }

      const whereClause = conditions.length > 0 ? and(...conditions) : undefined

      const result = await db
        .select({
          totalPromptTokens: sum(tokenUse.totalPromptTokens),
          totalCompletionTokens: sum(tokenUse.totalCompletionTokens),
          totalTokens: sum(tokenUse.totalTokens),
        })
        .from(tokenUse)
        .where(whereClause)

      const row = result[0]
      return {
        totalPromptTokens: row?.totalPromptTokens
          ? Number(row.totalPromptTokens)
          : 0,
        totalCompletionTokens: row?.totalCompletionTokens
          ? Number(row.totalCompletionTokens)
          : 0,
        totalTokens: row?.totalTokens ? Number(row.totalTokens) : 0,
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
  },
  {
    query: t.Object({
      startTime: t.Optional(t.String()),
      endTime: t.Optional(t.String()),
    }),
  },
)
