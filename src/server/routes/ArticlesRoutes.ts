import {count, eq, isNull} from 'drizzle-orm'
import {Elysia} from 'elysia'

import {articles, judgments} from '../../db/schema.ts'
import {getDatabase} from '../utils/getDatabase.ts'

export const articlesRoutes = new Elysia().get(
  '/api/unassessed-count',
  async () => {
    try {
      const db = getDatabase()
      const result = await db
        .select({count: count()})
        .from(articles)
        .leftJoin(judgments, eq(articles.id, judgments.articleId))
        .where(isNull(judgments.id))

      return {count: result[0]?.count || 0}
    } catch (error) {
      console.error('Error fetching unassessed count:', error)
      return {count: null, error: 'Failed to fetch unassessed count'}
    }
  },
)
