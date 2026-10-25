import type {ComparisonProjectCovidenceExportSelection} from '../../../../utils/comparisonProjectCovidenceExportSelection.ts'
import type {ComparisonProjectScope} from '../comparisonProjectScopeTypes.ts'
import {forEachComparisonProjectCovidenceExportRowBatch} from './forEachComparisonProjectCovidenceExportRowBatch.ts'

export const getComparisonProjectCovidenceExportCount = async (
  scope: ComparisonProjectScope,
  selection: ComparisonProjectCovidenceExportSelection,
) => {
  const countState = {totalCount: 0}

  await forEachComparisonProjectCovidenceExportRowBatch({
    onRows: (rows) => {
      countState.totalCount += rows.length
    },
    scope,
    selection,
  })

  return {totalCount: countState.totalCount}
}
