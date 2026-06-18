import {Elysia, t} from 'elysia'

import {getReviewFiltersFromServing} from '../../reviewServing/reviewServingFilterRouteService.ts'
import {getAppQueryService} from '../../services/getAppQueryService.ts'
import {createRateLimitedLogger} from '../../utils/rateLimitedLogger.ts'
import {assertProjectIsActive} from './projectAccessGuard.ts'

const articlesReviewsFiltersLogger = createRateLimitedLogger({sink: 'file-only', windowMs: 30_000})
const articlesReviewsFiltersErrorLogger = createRateLimitedLogger({sink: 'both', windowMs: 30_000})

export const projectsRoutesGetArticlesReviewsFilters = new Elysia().get(
  '/api/articlesreviewsfilters',
  async ({query, set}) => {
    try {
      if (!query?.projectId) {
        set.status = 400
        throw new Error('Project ID is required')
      }

      await assertProjectIsActive(query.projectId)

      const hasDuplicateStudyRecords = query?.covidenceDuplicates === '1'
      const hasStudyDecisionConflict = query?.covidenceConflicts === '1'
      const searchTitle = typeof query?.search === 'string' ? query.search.trim() : ''
      articlesReviewsFiltersLogger.force(
        'projects.articles-reviews-filters.request-start',
        'Articles reviews filters request started',
        'log',
        {
          projectId: query.projectId,
          from: query.from,
          to: query.to,
          search: searchTitle,
          hasDuplicateStudyRecords,
          hasStudyDecisionConflict,
        },
      )

      const projectPromptRows = await getAppQueryService().getProjectPromptRows(query.projectId)
      const result = await getReviewFiltersFromServing({mode: 'review', params: query, promptRows: projectPromptRows})

      articlesReviewsFiltersLogger.force(
        'projects.articles-reviews-filters.request-summary',
        'Articles reviews filters request completed',
        'log',
        {
          projectId: query.projectId,
          promptCount: projectPromptRows.length,
          facetCount: result.facets.length,
          filterOptionCount: result.filterOptions.length,
          resultFilterCount: result.filters.length,
        },
      )

      return result
    } catch (error) {
      articlesReviewsFiltersErrorLogger.force(
        'projects.articles-reviews-filters.error',
        'Articles reviews filters request failed',
        'error',
        {projectId: query?.projectId, error: error instanceof Error ? error.message : String(error)},
      )
      set.status = 500
      throw new Error(error instanceof Error ? error.message : 'Failed to fetch articles reviews filters', {
        cause: error,
      })
    }
  },
  {
    query: t.Object({
      projectId: t.String(),
      covidenceConflicts: t.Optional(t.String()),
      covidenceDuplicates: t.Optional(t.String()),
      from: t.Optional(t.String()),
      to: t.Optional(t.String()),
      search: t.Optional(t.String()),
    }),
  },
)
