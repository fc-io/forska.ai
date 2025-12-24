/**
 * Articles reviews API endpoint - ClickHouse implementation.
 *
 * This is the Phase 6 implementation using ClickHouse for dramatically faster
 * GROUP BY + ORDER BY + HAVING queries on judgment data.
 *
 * Performance improvement: ~50s (PostgreSQL) -> ~2s (ClickHouse)
 *
 * Uses PostgreSQL only for project metadata (prompts, routes, curated articles).
 * All judgment data is queried from ClickHouse.
 */
import {Elysia, t} from 'elysia'

import {queryArticlesReviewsFromClickHouse} from '../../../services/clickhouse/articlesReviewsClickHouse.ts'

export const projectsRoutesGetArticlesReviews = new Elysia().post(
  '/api/articlesreviews',
  async ({body}) => {
    try {
      console.log('[Articles Reviews API] Request:', {
        projectId: body.projectId,
        page: body.page,
        limit: body.limit,
        from: body.from,
        to: body.to,
        search: body.search,
        promptFilters: Object.keys(body.prompts || {}).length,
      })

      const page = parseInt(body?.page ?? '1', 10)
      const limit = parseInt(body?.limit ?? '100', 10)

      const result = await queryArticlesReviewsFromClickHouse({
        projectId: body.projectId,
        page,
        limit,
        from: body.from,
        to: body.to,
        search: body.search,
        prompts: body.prompts,
      })

      console.log(`[Articles Reviews API] Returning ${result.data.length} articles`)

      return result
    } catch (error) {
      console.error('[Articles Reviews API] Error:', error)
      throw new Error(error instanceof Error ? error.message : 'Failed to fetch articles reviews')
    }
  },
  {
    body: t.Object({
      from: t.Optional(t.String()),
      limit: t.String(),
      page: t.String(),
      projectId: t.String(),
      prompts: t.Record(t.String(), t.Array(t.String())),
      to: t.Optional(t.String()),
      search: t.Optional(t.String()),
    }),
  },
)
