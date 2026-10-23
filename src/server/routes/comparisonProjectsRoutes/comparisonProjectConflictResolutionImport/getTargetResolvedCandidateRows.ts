import type {ImportCandidateRow} from './comparisonProjectConflictResolutionImportMatchTypes.ts'
import type {
  ComparisonProjectConflictResolutionImportSkippedRow,
  ComparisonProjectConflictResolutionImportWarning,
} from './comparisonProjectConflictResolutionImportTypes.ts'
import {getNormalizedResolutionValue} from './comparisonProjectConflictResolutionImportUtils.ts'
import {getWarningSourceRow, getWarningTargetArticle} from './getImportWarningRows.ts'
import {getSkippedRow} from './getSkippedRow.ts'

const getTargetSummaryOptionValueMap = (targetSummaryOptionValues: readonly string[]) => {
  return targetSummaryOptionValues.reduce<Map<string, string[]>>((optionValueMap, optionValue) => {
    const normalizedValue = getNormalizedResolutionValue(optionValue)
    const currentValues = optionValueMap.get(normalizedValue) ?? []

    return normalizedValue.length === 0
      ? optionValueMap
      : optionValueMap.set(normalizedValue, [...currentValues, normalizedValue])
  }, new Map<string, string[]>())
}

const getCanonicalTargetSummaryOptionValue = (
  resolutionValue: string,
  targetSummaryOptionValueMap: Map<string, string[]>,
) => {
  const normalizedValue = getNormalizedResolutionValue(resolutionValue)
  const matchingOptionValues = targetSummaryOptionValueMap.get(normalizedValue) ?? []

  return matchingOptionValues.length === 1 ? matchingOptionValues[0] : null
}

const getInvalidTargetResolutionValueWarning = (
  row: ImportCandidateRow,
): ComparisonProjectConflictResolutionImportWarning => {
  return {
    code: 'invalid-target-resolution-value',
    matchKey: row.matchKey,
    matchKind: row.matchKind,
    message: `Source resolution value does not map to exactly one target summary option: ${row.resolutionValue ?? ''}`,
    sourceRows: [getWarningSourceRow(row.sourceRow)],
    targetArticles: [getWarningTargetArticle(row.targetArticle)],
    value: row.resolutionValue ?? '',
  }
}

export const getTargetResolvedCandidateRows = (
  candidateRows: readonly ImportCandidateRow[],
  targetSummaryOptionValues: readonly string[],
) => {
  const targetSummaryOptionValueMap = getTargetSummaryOptionValueMap(targetSummaryOptionValues)

  return candidateRows.reduce<{
    candidateRows: ImportCandidateRow[]
    skippedRows: ComparisonProjectConflictResolutionImportSkippedRow[]
    warnings: ComparisonProjectConflictResolutionImportWarning[]
  }>(
    (result, row) => {
      const targetResolutionValue =
        row.resolutionValue === null
          ? null
          : (getCanonicalTargetSummaryOptionValue(row.resolutionValue, targetSummaryOptionValueMap) ?? null)

      return row.resolutionValue === null || targetResolutionValue !== null
        ? {...result, candidateRows: [...result.candidateRows, {...row, resolutionValue: targetResolutionValue}]}
        : {
            candidateRows: result.candidateRows,
            skippedRows: [...result.skippedRows, getSkippedRow(row.sourceRowId, 'invalid-target-resolution-value')],
            warnings: [...result.warnings, getInvalidTargetResolutionValueWarning(row)],
          }
    },
    {candidateRows: [], skippedRows: [], warnings: []},
  )
}
