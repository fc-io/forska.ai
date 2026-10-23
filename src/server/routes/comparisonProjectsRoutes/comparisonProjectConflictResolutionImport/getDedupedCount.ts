import type {ComparisonProjectConflictResolutionImportCandidate} from './comparisonProjectConflictResolutionImportTypes.ts'

export const getDedupedCount = (candidates: readonly ComparisonProjectConflictResolutionImportCandidate[]) => {
  return candidates.reduce((count, candidate) => {
    return count + Math.max(candidate.sourceRows.length - 1, 0)
  }, 0)
}
