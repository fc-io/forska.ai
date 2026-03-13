import {Elysia, t} from 'elysia'

import {countArticlesReviewsFromOlap} from '../../../services/olap/articlesReviewsOlap.ts'

export const projectsRoutesGetArticlesReviewsCount = new Elysia().post(
  '/api/articlesreviewscount',
  async ({body}) => {
    const startTime = Date.now()
    console.log('[Count API] Request starting...')

    try {
      const limit = parseInt(body.limit, 10) || 100

      const result = await countArticlesReviewsFromOlap({
        projectId: body.projectId,
        limit,
        from: body.from,
        to: body.to,
        search: body.search,
        prompts: body.prompts,
      })

      const elapsed = Date.now() - startTime
      console.log(`[Count API] Complete: ${result.totalCount.toLocaleString()} articles in ${elapsed}ms`)

      return result
    } catch (error) {
      console.error('[Count API] Error:', error)
      return {totalCount: 0, totalPages: 0, error: error instanceof Error ? error.message : 'Unknown error'}
    }
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
