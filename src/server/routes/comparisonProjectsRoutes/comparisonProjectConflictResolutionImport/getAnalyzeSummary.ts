import type {ComparisonProjectConflictResolutionImportAnalyzeSummary} from './comparisonProjectConflictResolutionImportAnalyzeTypes.ts'
import {getComparisonProjectConflictResolutionImportCommentChangeCounts} from './comparisonProjectConflictResolutionImportCommentChanges.ts'
import type {
  ComparisonProjectConflictResolutionImportCommentChange,
  ComparisonProjectConflictResolutionImportPlan,
} from './comparisonProjectConflictResolutionImportTypes.ts'

export const getAnalyzeSummary = (params: {
  commentChanges: readonly ComparisonProjectConflictResolutionImportCommentChange[]
  importableCount: number
  plan: ComparisonProjectConflictResolutionImportPlan
  scannedCount: number
}): ComparisonProjectConflictResolutionImportAnalyzeSummary => {
  const skippedConflicting = params.plan.skipCounts.conflicting + params.plan.skipCounts.conflictingIdentifiers
  const skipped =
    params.plan.skipCounts.ambiguousTarget
    + skippedConflicting
    + params.plan.skipCounts.existingTargetResolution
    + params.plan.skipCounts.invalidValue
    + params.plan.skipCounts.noTargetMatch
    + params.plan.skipCounts.noUsableKey
    + params.plan.skipCounts.notConflicting
    + params.plan.skipCounts.sameValue
    + params.plan.skipCounts.unsupportedMode

  return {
    scanned: params.scannedCount,
    matched: params.plan.candidates.reduce((count, candidate) => {
      return count + candidate.sourceRows.length
    }, 0),
    importable: params.importableCount,
    deduped: params.plan.dedupedCount,
    skipped,
    skippedExisting: params.plan.skipCounts.existingTargetResolution,
    skippedUnsupportedMode: params.plan.skipCounts.unsupportedMode,
    skippedNoUsableKey: params.plan.skipCounts.noUsableKey,
    skippedNoTargetMatch: params.plan.skipCounts.noTargetMatch,
    skippedNotConflicting: params.plan.skipCounts.notConflicting,
    skippedAmbiguousTarget: params.plan.skipCounts.ambiguousTarget,
    skippedConflicting,
    skippedInvalidValue: params.plan.skipCounts.invalidValue,
    sameValue: params.plan.skipCounts.sameValue,
    overwriteCandidates: 0,
    ...getComparisonProjectConflictResolutionImportCommentChangeCounts(params.commentChanges),
  }
}
