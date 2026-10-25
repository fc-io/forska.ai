import {Elysia} from 'elysia'

import {
  comparisonProjectCovidenceExportBodySchema,
  comparisonProjectCovidenceExportSummaryModeError,
  getIsComparisonProjectCovidenceExportAvailable,
  getRequestedComparisonProjectCovidenceExportSelection,
} from './comparisonProjectsRoutesPostCovidenceExport/comparisonProjectCovidenceExportRequest.ts'
import {getComparisonProjectCovidenceExportResponse} from './comparisonProjectsRoutesPostCovidenceExport/getComparisonProjectCovidenceExportResponse.ts'
import {getComparisonProjectScope} from './getComparisonProjectScope.ts'

export const comparisonProjectsRoutesPostCovidenceExport = new Elysia().post(
  '/api/comparison-projects/:id/covidence-export',
  async (context) => {
    const {params, body, set} = context
    const scope = await getComparisonProjectScope(params.id)

    if (!scope) {
      set.status = 404
      return {data: null, error: 'Comparison project not found'}
    }

    if (!getIsComparisonProjectCovidenceExportAvailable(scope)) {
      set.status = 409
      return {data: null, error: comparisonProjectCovidenceExportSummaryModeError}
    }

    return getComparisonProjectCovidenceExportResponse(
      scope,
      getRequestedComparisonProjectCovidenceExportSelection(scope, body),
    )
  },
  {body: comparisonProjectCovidenceExportBodySchema},
)
