import {getComparisonProjectConflictResolutionImportPlan} from './comparisonProjectConflictResolutionImport.ts'
import type {ComparisonProjectConflictResolutionImportSummary} from './comparisonProjectConflictResolutionImport/comparisonProjectConflictResolutionImportAnalyzeTypes.ts'

export const getConflictResolutionImportSummary = (params: {
  importedCount: number
  plan: ReturnType<typeof getComparisonProjectConflictResolutionImportPlan>
  scannedCount: number
}): ComparisonProjectConflictResolutionImportSummary => {
  const skippedCount =
    params.plan.skipCounts.ambiguousTarget
    + params.plan.skipCounts.conflictingIdentifiers
    + params.plan.skipCounts.conflicting
    + params.plan.skipCounts.existingTargetResolution
    + params.plan.skipCounts.invalidValue
    + params.plan.skipCounts.noTargetMatch
    + params.plan.skipCounts.noUsableKey
    + params.plan.skipCounts.notConflicting
    + params.plan.skipCounts.sameValue
    + params.plan.skipCounts.unsupportedMode

  return {
    deduped: params.plan.dedupedCount,
    scanned: params.scannedCount,
    matched: params.plan.candidates.reduce((count, candidate) => {
      return count + candidate.sourceRows.length
    }, 0),
    imported: params.importedCount,
    skipped: skippedCount,
    skippedAmbiguousTarget: params.plan.skipCounts.ambiguousTarget,
    skippedConflictingIdentifiers: params.plan.skipCounts.conflictingIdentifiers,
    skippedConflicting: params.plan.skipCounts.conflicting,
    skippedExistingTargetResolution: params.plan.skipCounts.existingTargetResolution,
    skippedInvalidValue: params.plan.skipCounts.invalidValue,
    skippedNoTargetMatch: params.plan.skipCounts.noTargetMatch,
    skippedNoUsableKey: params.plan.skipCounts.noUsableKey,
    skippedNotConflicting: params.plan.skipCounts.notConflicting,
    skippedUnsupportedMode: params.plan.skipCounts.unsupportedMode,
    sameValue: params.plan.skipCounts.sameValue,
    overwriteCandidates: 0,
    warnings: params.plan.warnings,
  }
}
