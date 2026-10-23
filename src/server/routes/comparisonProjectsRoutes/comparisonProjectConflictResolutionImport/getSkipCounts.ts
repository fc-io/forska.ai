import type {
  ComparisonProjectConflictResolutionImportSkipCounts,
  ComparisonProjectConflictResolutionImportSkippedRow,
} from './comparisonProjectConflictResolutionImportTypes.ts'

export const getSkipCounts = (
  skippedRows: readonly ComparisonProjectConflictResolutionImportSkippedRow[],
): ComparisonProjectConflictResolutionImportSkipCounts => {
  return skippedRows.reduce<ComparisonProjectConflictResolutionImportSkipCounts>(
    (counts, skippedRow) => {
      return {
        ambiguousTarget: counts.ambiguousTarget + (skippedRow.reason === 'ambiguous-target-match' ? 1 : 0),
        conflictingIdentifiers:
          counts.conflictingIdentifiers + (skippedRow.reason === 'conflicting-identifiers' ? 1 : 0),
        conflicting: counts.conflicting + (skippedRow.reason === 'conflicting-resolution-values' ? 1 : 0),
        existingTargetResolution:
          counts.existingTargetResolution + (skippedRow.reason === 'existing-target-resolution' ? 1 : 0),
        invalidValue: counts.invalidValue + (skippedRow.reason === 'invalid-target-resolution-value' ? 1 : 0),
        noTargetMatch: counts.noTargetMatch + (skippedRow.reason === 'no-target-match' ? 1 : 0),
        noUsableKey: counts.noUsableKey + (skippedRow.reason === 'no-usable-key' ? 1 : 0),
        notConflicting: counts.notConflicting + (skippedRow.reason === 'not-conflicting' ? 1 : 0),
        sameValue: counts.sameValue + (skippedRow.reason === 'same-value' ? 1 : 0),
        unsupportedMode: counts.unsupportedMode + (skippedRow.reason === 'unsupported-mode' ? 1 : 0),
      }
    },
    {
      ambiguousTarget: 0,
      conflictingIdentifiers: 0,
      conflicting: 0,
      existingTargetResolution: 0,
      invalidValue: 0,
      noTargetMatch: 0,
      noUsableKey: 0,
      notConflicting: 0,
      sameValue: 0,
      unsupportedMode: 0,
    },
  )
}
