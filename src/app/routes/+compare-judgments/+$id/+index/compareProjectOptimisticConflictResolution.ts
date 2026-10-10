import type {ComparisonProjectConflictResolutionValue} from '../../../../../services/comparisonProjectsService.ts'

export const getCompareProjectOptimisticConflictResolution = (params: {
  activeGeneration: number | null
  articleId: string
  judgmentContextId: string | null
  label: string
  previousConflictResolution: ComparisonProjectConflictResolutionValue | null
  setAt: Date
  value: string
}): ComparisonProjectConflictResolutionValue => {
  return {
    articleId: params.articleId,
    comment: params.previousConflictResolution?.comment ?? null,
    commentUpdatedAt: params.previousConflictResolution?.commentUpdatedAt ?? null,
    label: params.label,
    provenance: {
      contextId: params.judgmentContextId,
      generation: params.activeGeneration,
      origin: 'ui',
      setAt: params.setAt.toISOString(),
    },
    provenanceMatchesCurrent: params.judgmentContextId === null ? null : true,
    reviewer: null,
    reviewerDisplayName: null,
    reviewerUserId: null,
    setAt: params.setAt.toISOString(),
    value: params.value,
  }
}

export const getCompareProjectOptimisticConflictResolutionComment = (params: {
  comment: string | null
  commentUpdatedAt: Date
  conflictResolution: ComparisonProjectConflictResolutionValue
}): ComparisonProjectConflictResolutionValue => {
  return {
    ...params.conflictResolution,
    comment: params.comment,
    commentUpdatedAt: params.commentUpdatedAt.toISOString(),
  }
}
