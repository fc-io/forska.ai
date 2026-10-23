import {getNormalizedComparisonProjectConflictComment} from '../../../../../../utils/comparisonProjectConflictResolutionComment.ts'
import type {ComparisonProjectExportRow} from '../../comparisonProjectExportRow.ts'

export const getComparisonProjectPdfExportedComment = (row: ComparisonProjectExportRow) => {
  return getNormalizedComparisonProjectConflictComment(row.conflictComment?.comment)
}
