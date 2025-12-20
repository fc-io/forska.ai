import {Elysia, t} from 'elysia'

/**
 * Count endpoint for articles reviews.
 *
 * STUBBED: Returns 0 immediately.
 *
 * Why counting is inherently slow:
 * - Must scan ALL matching rows (no early exit like pagination)
 * - For sparse-scope projects, this means scanning millions of rows
 * - Progressive count doesn't help because we can't stop early
 *
 * Possible future solutions:
 * 1. Pre-computed counts (update on judgment insert/delete)
 * 2. Approximate counts (sample-based estimation)
 * 3. Background computation with caching
 * 4. ClickHouse (fast columnar aggregation)
 */
export const projectsRoutesGetArticlesReviewsCount = new Elysia().post(
  '/api/articlesreviewscount',
  async () => {
    console.log('⏭️ Count endpoint stubbed - returning 0')
    return {totalCount: 0, totalPages: 0}
  },
  {
    body: t.Object({
      from: t.Optional(t.String()),
      limit: t.String(),
      projectId: t.String(),
      prompts: t.Record(t.String(), t.Array(t.String())),
      to: t.Optional(t.String()),
      search: t.Optional(t.String()),
    }),
  },
)
