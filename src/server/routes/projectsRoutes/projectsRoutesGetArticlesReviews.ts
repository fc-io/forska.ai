import {Elysia, t} from 'elysia'

import {queryArticlesReviewsFromOlap} from '../../../services/olap/articlesReviewsOlap.ts'
import {getAppQueryService} from '../../services/getAppQueryService.ts'
import {createRateLimitedLogger} from '../../utils/rateLimitedLogger.ts'
import {assertProjectIsActive} from './projectAccessGuard.ts'

const articlesReviewsLogger = createRateLimitedLogger({sink: 'file-only', windowMs: 30_000})
const articlesReviewsErrorLogger = createRateLimitedLogger({sink: 'both', windowMs: 30_000})

export const projectsRoutesGetArticlesReviews = new Elysia().post(
  '/api/articlesreviews',
  async ({body}) => {
    try {
      articlesReviewsLogger.force(
        'projects.articles-reviews.request-start',
        'Articles reviews request started',
        'log',
        {
          projectId: body.projectId,
          page: body.page,
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

      const page = parseInt(body?.page ?? '1', 10)
      const limit = parseInt(body?.limit ?? '100', 10)

      await assertProjectIsActive(body.projectId)

      const result = await queryArticlesReviewsFromOlap({
        cursor: body.cursor,
        hasDuplicateStudyRecords: body.hasDuplicateStudyRecords,
        hasStudyDecisionConflict: body.hasStudyDecisionConflict,
        projectId: body.projectId,
        page,
        limit,
        from: body.from,
        to: body.to,
        search: body.search,
        prompts: body.prompts,
        ...(body.llmStatus ? {llmStatus: body.llmStatus} : {}),
      })

      const hasInlineHydration = result.data.every((article) => {
        return Object.hasOwn(article, 'articleId')
      })

      if (hasInlineHydration) {
        articlesReviewsLogger.force(
          'projects.articles-reviews.request-summary',
          'Articles reviews request completed',
          'log',
          {projectId: body.projectId, page, limit, returnedCount: result.data.length, hydrationMode: 'inline'},
        )
        return result
      }

      const articleIds = result.data.map((a) => {
        return a.id
      })
      const fullTextRows = await getAppQueryService().getReviewHydrationRows(articleIds)
      const fullTextById = fullTextRows.reduce(
        (acc, row) => {
          return {...acc, [row.id]: row}
        },
        {} as Record<string, (typeof fullTextRows)[number]>,
      )
      const data = result.data.map((article) => {
        const fullText = fullTextById[article.id]
        return {
          ...article,
          articleTitle: fullText ? fullText.articleTitle : article.articleTitle,
          articleCreatedAt: fullText ? fullText.articleCreatedAt : article.articleCreatedAt,
          articleUpdatedAt: fullText ? fullText.articleUpdatedAt : article.articleUpdatedAt,
          journalTitle: fullText?.sourceMetadata?.journalTitle ?? article.journalTitle,
          articleId: fullText?.articleId ?? null,
          url: fullText?.url ?? null,
          fullTextPDF: fullText?.fullTextPDF ?? null,
          fullTextFetchedAt: fullText?.fullTextFetchedAt ?? null,
          fullTextConversionStatus: fullText?.fullTextConversionStatus ?? null,
          sourceMetadata: fullText?.sourceMetadata ?? null,
        }
      })

      articlesReviewsLogger.force(
        'projects.articles-reviews.request-summary',
        'Articles reviews request completed',
        'log',
        {
          projectId: body.projectId,
          page,
          limit,
          returnedCount: result.data.length,
          hydrationMode: 'fallback',
          hydrationRowCount: fullTextRows.length,
        },
      )

      return {...result, data}
    } catch (error) {
      articlesReviewsErrorLogger.force('projects.articles-reviews.error', 'Articles reviews request failed', 'error', {
        projectId: body.projectId,
        error: error instanceof Error ? error.message : String(error),
      })
      throw new Error(error instanceof Error ? error.message : 'Failed to fetch articles reviews', {cause: error})
    }
  },
  {
    body: t.Object({
      cursor: t.Optional(t.String()),
      from: t.Optional(t.String()),
      hasDuplicateStudyRecords: t.Optional(t.Boolean()),
      hasStudyDecisionConflict: t.Optional(t.Boolean()),
      llmStatus: t.Optional(t.Union([t.Literal('complete'), t.Literal('both'), t.Literal('partial')])),
      limit: t.String(),
      page: t.String(),
      projectId: t.String(),
      prompts: t.Record(t.String(), t.Array(t.String())),
      to: t.Optional(t.String()),
      search: t.Optional(t.String()),
    }),
  },
)
