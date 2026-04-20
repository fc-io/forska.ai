import {Elysia, t} from 'elysia'

import {countArticlesReviewsFromOlap} from '../../../services/olap/articlesReviewsOlap.ts'
import {createRateLimitedLogger} from '../../utils/rateLimitedLogger.ts'
import {assertProjectIsActive} from './projectAccessGuard.ts'

const articlesReviewsCountLogger = createRateLimitedLogger({sink: 'file-only', windowMs: 30_000})
const articlesReviewsCountErrorLogger = createRateLimitedLogger({sink: 'both', windowMs: 30_000})

export const projectsRoutesGetArticlesReviewsCount = new Elysia().post(
  '/api/articlesreviewscount',
  async ({body}) => {
    const startTime = Date.now()
    articlesReviewsCountLogger.force(
      'projects.articles-reviews-count.request-start',
      'Articles reviews count request started',
      'log',
      {
        projectId: body.projectId,
        limit: body.limit,
        from: body.from,
        to: body.to,
        search: body.search,
        promptFilterCount: Object.keys(body.prompts || {}).length,
        hasDuplicateStudyRecords: body.hasDuplicateStudyRecords,
        hasStudyDecisionConflict: body.hasStudyDecisionConflict,
        llmStatus: body.llmStatus,
      },
    )

    try {
      const limit = parseInt(body.limit, 10) || 100

      await assertProjectIsActive(body.projectId)

      const result = await countArticlesReviewsFromOlap({
        hasDuplicateStudyRecords: body.hasDuplicateStudyRecords,
        hasStudyDecisionConflict: body.hasStudyDecisionConflict,
        projectId: body.projectId,
        limit,
        from: body.from,
        to: body.to,
        search: body.search,
        prompts: body.prompts,
        ...(body.llmStatus ? {llmStatus: body.llmStatus} : {}),
      })

      const elapsed = Date.now() - startTime
      articlesReviewsCountLogger.force(
        'projects.articles-reviews-count.request-summary',
        'Articles reviews count request completed',
        'log',
        {projectId: body.projectId, durationMs: elapsed, totalCount: result.totalCount, totalPages: result.totalPages},
      )

      return result
    } catch (error) {
      articlesReviewsCountErrorLogger.force(
        'projects.articles-reviews-count.error',
        'Articles reviews count request failed',
        'error',
        {projectId: body.projectId, error: error instanceof Error ? error.message : String(error)},
      )
      return {totalCount: 0, totalPages: 0, error: error instanceof Error ? error.message : 'Unknown error'}
    }
  },
  {
    body: t.Object({
      from: t.Optional(t.String()),
      hasDuplicateStudyRecords: t.Optional(t.Boolean()),
      hasStudyDecisionConflict: t.Optional(t.Boolean()),
      llmStatus: t.Optional(t.Union([t.Literal('complete'), t.Literal('both'), t.Literal('partial')])),
      limit: t.String(),
      projectId: t.String(),
      prompts: t.Record(t.String(), t.Array(t.String())),
      to: t.Optional(t.String()),
      search: t.Optional(t.String()),
    }),
  },
)
