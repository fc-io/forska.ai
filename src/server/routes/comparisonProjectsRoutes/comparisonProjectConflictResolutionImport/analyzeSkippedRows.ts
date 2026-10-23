import type {ComparisonProjectConflictResolutionImportAnalyzeRow} from './comparisonProjectConflictResolutionImportAnalyzeTypes.ts'
import type {
  ImportCandidateRow,
  ImportCandidateRowResult,
} from './comparisonProjectConflictResolutionImportMatchTypes.ts'
import type {ComparisonProjectConflictResolutionImportSkippedRow} from './comparisonProjectConflictResolutionImportTypes.ts'
import {getAnalyzeRow, getAnalyzeRowFromCandidateRow} from './getAnalyzeRow.ts'
import type {CommentChangeBySourceRowId} from './getCommentChangeBySourceRowId.ts'

export const getInitialAnalyzeSkippedRows = (
  candidateRowResults: readonly ImportCandidateRowResult[],
  commentChangeBySourceRowId: CommentChangeBySourceRowId,
): ComparisonProjectConflictResolutionImportAnalyzeRow[] => {
  return candidateRowResults.flatMap((result) => {
    return result.skippedRow && result.detail
      ? [
          getAnalyzeRow({
            commentChangeBySourceRowId,
            detail: result.detail,
            reason: result.skippedRow.reason,
            selectedResolution: result.detail.sourceRow.resolutionValue ?? '',
          }),
        ]
      : []
  })
}

export const getInvalidValueAnalyzeSkippedRows = (
  candidateRows: readonly ImportCandidateRow[],
  skippedRows: readonly ComparisonProjectConflictResolutionImportSkippedRow[],
  commentChangeBySourceRowId: CommentChangeBySourceRowId,
): ComparisonProjectConflictResolutionImportAnalyzeRow[] => {
  const skippedSourceRowIds = new Set(
    skippedRows.map((skippedRow) => {
      return skippedRow.sourceRowId
    }),
  )

  return candidateRows
    .filter((candidateRow) => {
      return skippedSourceRowIds.has(candidateRow.sourceRowId)
    })
    .map((candidateRow) => {
      return {
        ...getAnalyzeRowFromCandidateRow(candidateRow, commentChangeBySourceRowId),
        reason: 'invalid-target-resolution-value' as const,
      }
    })
}

export const getConflictingAnalyzeSkippedRows = (
  candidateRows: readonly ImportCandidateRow[],
  skippedRows: readonly ComparisonProjectConflictResolutionImportSkippedRow[],
  commentChangeBySourceRowId: CommentChangeBySourceRowId,
): ComparisonProjectConflictResolutionImportAnalyzeRow[] => {
  const skippedSourceRowIds = new Set(
    skippedRows.map((skippedRow) => {
      return skippedRow.sourceRowId
    }),
  )

  return candidateRows
    .filter((candidateRow) => {
      return skippedSourceRowIds.has(candidateRow.sourceRowId)
    })
    .map((candidateRow) => {
      return {
        ...getAnalyzeRowFromCandidateRow(candidateRow, commentChangeBySourceRowId),
        reason: 'conflicting-resolution-values' as const,
      }
    })
}
