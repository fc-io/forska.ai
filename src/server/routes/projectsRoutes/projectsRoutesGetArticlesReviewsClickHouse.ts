/**
 * ClickHouse-based articles reviews API endpoint.
 *
 * This is the Phase 6 replacement for the PostgreSQL-based projectsRoutesGetArticlesReviews.
 * Uses ClickHouse for dramatically faster GROUP BY + ORDER BY + HAVING queries.
 *
 * Expected performance improvement: ~50s (PostgreSQL) -> ~2s (ClickHouse)
 *
 * This implementation:
 * 1. Keeps the same API contract as the PostgreSQL version
 * 2. Queries ClickHouse for judgment data
 * 3. Still uses PostgreSQL for project metadata (prompts, routes, curated articles)
 *
 * Feature flag: Set USE_CLICKHOUSE=true to enable this implementation
 */
import {Elysia, t} from 'elysia'

import {queryArticlesReviewsFromClickHouse} from '../../../services/clickhouse/articlesReviewsClickHouse.ts'

export const projectsRoutesGetArticlesReviewsClickHouse = new Elysia().post(
  '/api/articlesreviews/clickhouse',
  async ({body}) => {
    try {
      console.log('[ClickHouse API] Request:', {
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

      console.log(`[ClickHouse API] Returning ${result.data.length} articles`)

      return result
    } catch (error) {
      console.error('[ClickHouse API] Error:', error)
      throw new Error(error instanceof Error ? error.message : 'Failed to fetch articles reviews from ClickHouse')
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
