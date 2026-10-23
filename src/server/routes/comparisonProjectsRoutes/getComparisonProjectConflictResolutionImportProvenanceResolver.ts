import type {ComparisonProjectConflictResolutionImportSourceRow} from './comparisonProjectConflictResolutionImport.ts'
import {
  type ComparisonProjectConflictResolutionImportCandidate,
  getComparisonProjectConflictResolutionImportCandidateSourceRow,
  getComparisonProjectConflictResolutionImportSourceRowsById,
} from './comparisonProjectConflictResolutionImportCandidates.ts'
import {
  type ComparisonProjectConflictResolutionOrigin,
  type ComparisonProjectConflictResolutionWriteProvenance,
  getComparisonProjectConflictResolutionOriginRef,
} from './comparisonProjectConflictResolutionProvenance.ts'

const getComparisonProjectConflictResolutionImportOriginRef = (
  sourceRow: ComparisonProjectConflictResolutionImportSourceRow | null,
) => {
  return sourceRow
    ? getComparisonProjectConflictResolutionOriginRef({
        sourceComparisonProjectId: sourceRow.sourceComparisonProjectId,
        sourceResolutionId: sourceRow.sourceResolutionId,
      })
    : null
}

export const getComparisonProjectConflictResolutionImportProvenanceResolver = (params: {
  judgmentContextId?: (sourceRow: ComparisonProjectConflictResolutionImportSourceRow | null) => string | null
  origin: ComparisonProjectConflictResolutionOrigin
  reviewer: (sourceRow: ComparisonProjectConflictResolutionImportSourceRow | null) => {
    displayName: string | null
    userId: string | null
  }
  sourceRows: readonly ComparisonProjectConflictResolutionImportSourceRow[]
}) => {
  const sourceRowsById = getComparisonProjectConflictResolutionImportSourceRowsById(params.sourceRows)

  return (
    candidate: ComparisonProjectConflictResolutionImportCandidate,
  ): ComparisonProjectConflictResolutionWriteProvenance => {
    const sourceRow = getComparisonProjectConflictResolutionImportCandidateSourceRow(candidate, sourceRowsById)
    const reviewer = params.reviewer(sourceRow)

    return {
      judgmentContextId: params.judgmentContextId
        ? params.judgmentContextId(sourceRow)
        : (sourceRow?.sourceProvenance?.judgmentContextId ?? null),
      origin: params.origin,
      originRef: getComparisonProjectConflictResolutionImportOriginRef(sourceRow),
      reviewerDisplayName: reviewer.displayName,
      reviewerUserId: reviewer.userId,
      servingGeneration: null,
    }
  }
}
