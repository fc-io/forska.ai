import type {ImportCandidateRow} from './comparisonProjectConflictResolutionImportMatchTypes.ts'
import type {ComparisonProjectConflictResolutionImportCandidate} from './comparisonProjectConflictResolutionImportTypes.ts'

export const getCandidateRowsForCandidates = (params: {
  candidates: readonly ComparisonProjectConflictResolutionImportCandidate[]
  candidateRows: readonly ImportCandidateRow[]
}) => {
  const candidateSourceRowIds = new Set(
    params.candidates.flatMap((candidate) => {
      return candidate.sourceRows.map((sourceRow) => {
        return sourceRow.sourceRowId
      })
    }),
  )

  return params.candidateRows.filter((candidateRow) => {
    return candidateSourceRowIds.has(candidateRow.sourceRowId)
  })
}
