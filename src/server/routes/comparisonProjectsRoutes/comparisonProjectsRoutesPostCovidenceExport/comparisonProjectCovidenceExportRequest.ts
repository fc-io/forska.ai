import {t} from 'elysia'

import {
  type ComparisonProjectCovidenceExportRequest,
  getNormalizedComparisonProjectCovidenceExportSelection,
} from '../../../../utils/comparisonProjectCovidenceExportSelection.ts'
import type {ComparisonProjectScope} from '../comparisonProjectScopeTypes.ts'
import {getIsSummaryMode} from '../getIsSummaryMode.ts'

export const comparisonProjectCovidenceExportSummaryModeError =
  'Covidence export requires a compare project that compares against human summary answers'

export const comparisonProjectCovidenceExportBodySchema = t.Object({
  columnSelections: t.Array(t.Object({columnId: t.String(), values: t.Array(t.String())})),
  conflictResolutionValues: t.Optional(t.Array(t.String())),
})

export const getIsComparisonProjectCovidenceExportAvailable = (scope: ComparisonProjectScope) => {
  return getIsSummaryMode(scope)
}

export const getRequestedComparisonProjectCovidenceExportSelection = (
  scope: ComparisonProjectScope,
  body: ComparisonProjectCovidenceExportRequest,
) => {
  return getNormalizedComparisonProjectCovidenceExportSelection(body, {
    allowConflictResolution: scope.allowConflictResolution,
    columnIds: scope.columns.map((column) => {
      return column.id
    }),
  })
}
