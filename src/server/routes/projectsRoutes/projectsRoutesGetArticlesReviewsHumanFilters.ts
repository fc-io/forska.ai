import {Elysia, t} from 'elysia'

import {getReviewFiltersFromServing} from '../../reviewServing/reviewServingFilterRouteService.ts'
import {getAppQueryService} from '../../services/getAppQueryService.ts'
import {assertProjectIsActive} from './projectAccessGuard.ts'

export const projectsRoutesGetArticlesReviewsHumanFilters = new Elysia().get(
  '/api/articlesreviewshumanfilters',
  async ({query, set}) => {
    try {
      if (!query?.projectId) {
        set.status = 400
        throw new Error('Project ID is required')
      }

      await assertProjectIsActive(query.projectId)

      const projectConfig = await getAppQueryService().getProjectReviewConfig(query.projectId)
      const humanJudgmentMode = projectConfig?.humanJudgmentMode ?? 'prompt'
      const projectPromptRows = await getAppQueryService().getProjectPromptRows(query.projectId)
      const result = await getReviewFiltersFromServing({mode: 'human', params: query, promptRows: projectPromptRows})

      return {...result, humanJudgmentMode}
    } catch (error) {
      console.error('Error fetching human articles reviews filters:', error)
      set.status = 500
      throw new Error(error instanceof Error ? error.message : 'Failed to fetch human articles reviews filters', {
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
