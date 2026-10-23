import {Elysia, t} from 'elysia'

import {
  comparisonProjectFilterSelectionBodySchema,
  getRequestedComparisonProjectJudgmentFilters,
} from './comparisonProjectJudgmentFilters.ts'
import {getRequestedPositiveInteger} from './comparisonProjectValueHelpers.ts'
import {getComparisonProjectJudgmentsCount} from './getComparisonProjectJudgmentsCount.ts'
import {getComparisonProjectScope} from './getComparisonProjectScope.ts'

export const comparisonProjectsRoutesPostJudgmentsCount = new Elysia().post(
  '/api/comparison-projects/:id/judgments/count',
  async (context) => {
    const {params, body, set} = context
    const data = await getComparisonProjectScope(params.id)

    if (!data) {
      set.status = 404
      return {data: null, error: 'Comparison project not found'}
    }

    const parsedLimit = getRequestedPositiveInteger(body.limit, 50)
    const limit = Math.min(Math.max(parsedLimit, 1), 100)
    const countResult = await getComparisonProjectJudgmentsCount(
      data,
      limit,
      getRequestedComparisonProjectJudgmentFilters(data, body),
    )

    return {data: countResult}
  },
  {
    body: t.Object({
      limit: t.Union([t.String(), t.Number()]),
      search: t.Optional(t.String()),
      rowFilter: t.Optional(comparisonProjectFilterSelectionBodySchema),
      articleCategoryFilter: t.Optional(comparisonProjectFilterSelectionBodySchema),
      conflictResolutionFilter: t.Optional(comparisonProjectFilterSelectionBodySchema),
      conflictResolutionProvenanceFilter: t.Optional(comparisonProjectFilterSelectionBodySchema),
      differenceFilter: t.Optional(comparisonProjectFilterSelectionBodySchema),
    }),
  },
)
