import {Elysia, t} from 'elysia'

import {
  comparisonProjectFilterSelectionBodySchema,
  type ComparisonProjectJudgmentFilters,
  getRequestedComparisonProjectJudgmentFilters,
} from './comparisonProjectJudgmentFilters.ts'
import type {ComparisonProjectScope} from './comparisonProjectScopeTypes.ts'
import {getComparisonProjectExportResponse} from './comparisonProjectsRoutesPostExport/getComparisonProjectExportResponse.ts'
import {getComparisonProjectPdfExportResponse} from './comparisonProjectsRoutesPostExport/getComparisonProjectPdfExportResponse.ts'
import {getComparisonProjectScope} from './getComparisonProjectScope.ts'

type ComparisonProjectExportFormat = 'csv' | 'pdf'

const getComparisonProjectFormattedExportResponse = async (
  scope: ComparisonProjectScope,
  filters: ComparisonProjectJudgmentFilters,
  format: ComparisonProjectExportFormat,
) => {
  return format === 'pdf'
    ? getComparisonProjectPdfExportResponse(scope, filters)
    : getComparisonProjectExportResponse(scope, filters)
}

export const comparisonProjectsRoutesPostExport = new Elysia().post(
  '/api/comparison-projects/:id/export',
  async (context) => {
    const {params, body, set} = context
    const data = await getComparisonProjectScope(params.id)

    if (!data) {
      set.status = 404
      return {data: null, error: 'Comparison project not found'}
    }

    const format: ComparisonProjectExportFormat = body.format === 'pdf' ? 'pdf' : 'csv'

    return getComparisonProjectFormattedExportResponse(
      data,
      getRequestedComparisonProjectJudgmentFilters(data, body),
      format,
    )
  },
  {
    body: t.Object({
      rowFilter: t.Optional(comparisonProjectFilterSelectionBodySchema),
      articleCategoryFilter: t.Optional(comparisonProjectFilterSelectionBodySchema),
      conflictResolutionFilter: t.Optional(comparisonProjectFilterSelectionBodySchema),
      conflictResolutionProvenanceFilter: t.Optional(comparisonProjectFilterSelectionBodySchema),
      format: t.Optional(t.Union([t.Literal('csv'), t.Literal('pdf')])),
      search: t.Optional(t.String()),
      differenceFilter: t.Optional(comparisonProjectFilterSelectionBodySchema),
    }),
  },
)
