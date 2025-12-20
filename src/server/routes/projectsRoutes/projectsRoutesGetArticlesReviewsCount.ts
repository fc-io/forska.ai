import {Elysia, t} from 'elysia'

/**
 * TEMPORARILY STUBBED: Count endpoint for articles reviews.
 *
 * Returns 0 immediately to test progressive fetch performance
 * without the slow count query blocking.
 *
 * TODO: Re-enable the real count query or implement progressive count
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
