import type {ComparisonProjectConflictResolutionValue} from '../../../../../services/comparisonProjectsService.ts'

export const getCompareProjectOptimisticConflictResolution = (params: {
  activeGeneration: number | null
  articleId: string
  judgmentContextId: string | null
  label: string
  setAt: Date
  value: string
}): ComparisonProjectConflictResolutionValue => {
  return {
    articleId: params.articleId,
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
