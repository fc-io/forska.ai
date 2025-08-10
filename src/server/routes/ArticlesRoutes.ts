import {Elysia} from 'elysia'

import {getDatabase} from '../utils/getDatabase.ts'

export const articlesRoutes = new Elysia().get(
  '/api/unassessed-count',
  async () => {
    try {
      const db = getDatabase()
      // Get count of articles that don't have any judgments yet
      const result = await db.execute<{count: string}>(
        `SELECT COUNT(DISTINCT a.id) as count
       FROM articles a
       LEFT JOIN judgments j ON a.id = j.article_id
       WHERE j.id IS NULL`,
      )

      return {count: parseInt(result.rows[0]?.count || '0', 10)}
    } catch (error) {
      console.error('Error fetching unassessed count:', error)
      return {count: null, error: 'Failed to fetch unassessed count'}
    }
  },
)
