import {Elysia} from 'elysia'

import {
  comparisonProjectCovidenceExportBodySchema,
  comparisonProjectCovidenceExportSummaryModeError,
  getIsComparisonProjectCovidenceExportAvailable,
  getRequestedComparisonProjectCovidenceExportSelection,
} from './comparisonProjectsRoutesPostCovidenceExport/comparisonProjectCovidenceExportRequest.ts'
import {getComparisonProjectCovidenceExportCount} from './comparisonProjectsRoutesPostCovidenceExport/getComparisonProjectCovidenceExportCount.ts'
import {getComparisonProjectScope} from './getComparisonProjectScope.ts'

export const comparisonProjectsRoutesPostCovidenceExportCount = new Elysia().post(
  '/api/comparison-projects/:id/covidence-export/count',
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

    return {
      data: await getComparisonProjectCovidenceExportCount(
        scope,
        getRequestedComparisonProjectCovidenceExportSelection(scope, body),
      ),
    }
  },
  {body: comparisonProjectCovidenceExportBodySchema},
)
