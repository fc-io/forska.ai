import type {ComparisonProjectConflictResolutionImportSourceRow} from './comparisonProjectConflictResolutionImportTypes.ts'

export type ComparisonProjectConflictResolutionImportSourceRowQueryRow =
  ComparisonProjectConflictResolutionImportSourceRow & {
    sourceJudgmentContextId?: string | null
    sourceReviewerDisplayName?: string | null
    sourceReviewerUserId?: string | null
  }

export const getComparisonProjectConflictResolutionImportSourceRowValue = ({
  sourceJudgmentContextId,
  sourceReviewerDisplayName,
  sourceReviewerUserId,
  ...row
}: ComparisonProjectConflictResolutionImportSourceRowQueryRow): ComparisonProjectConflictResolutionImportSourceRow => {
  return {
    ...row,
    sourceProvenance: {
      judgmentContextId: sourceJudgmentContextId ?? null,
      reviewerDisplayName: sourceReviewerDisplayName ?? null,
      reviewerUserId: sourceReviewerUserId ?? null,
    },
  }
}
