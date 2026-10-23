import {getComparisonProjectConflictResolutionImportDoiKeys} from './comparisonProjectConflictResolutionImportIdentifierKeys.ts'
import type {NormalizedSourceRow} from './comparisonProjectConflictResolutionImportMatchTypes.ts'
import {
  getComparisonProjectConflictResolutionImportCovidenceIdTitleKey,
  getComparisonProjectConflictResolutionImportIdTitleKey,
  getComparisonProjectConflictResolutionImportTitleKey,
} from './comparisonProjectConflictResolutionImportTitleKeys.ts'
import type {ComparisonProjectConflictResolutionImportSourceRow} from './comparisonProjectConflictResolutionImportTypes.ts'
import {getNormalizedResolutionValue} from './comparisonProjectConflictResolutionImportUtils.ts'
import {getNormalizedIdentifierKeys} from './getNormalizedIdentifierKeys.ts'

export const getNormalizedSourceRows = (
  sourceRows: readonly ComparisonProjectConflictResolutionImportSourceRow[],
): NormalizedSourceRow[] => {
  return sourceRows.map((row) => {
    return {
      ...row,
      covidenceIdTitleKey: getComparisonProjectConflictResolutionImportCovidenceIdTitleKey(row),
      doiKeys: getComparisonProjectConflictResolutionImportDoiKeys(row),
      identifierKeys: getNormalizedIdentifierKeys(row),
      idTitleKey: getComparisonProjectConflictResolutionImportIdTitleKey(row),
      resolutionMode: row.resolutionMode ?? 'summary',
      resolutionValue: row.resolutionValue === null ? null : getNormalizedResolutionValue(row.resolutionValue),
      titleKey: getComparisonProjectConflictResolutionImportTitleKey(row),
    }
  })
}
