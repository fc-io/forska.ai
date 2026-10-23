import type {
  ComparisonProjectConflictResolutionImportSkippedRow,
  ComparisonProjectConflictResolutionImportSkipReason,
} from './comparisonProjectConflictResolutionImportTypes.ts'

export const getSkippedRow = (
  sourceRowId: string,
  reason: ComparisonProjectConflictResolutionImportSkipReason,
): ComparisonProjectConflictResolutionImportSkippedRow => {
  return {reason, sourceRowId}
}
