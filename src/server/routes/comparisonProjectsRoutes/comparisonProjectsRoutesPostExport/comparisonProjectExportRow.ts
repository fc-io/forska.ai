import type {ComparisonProjectConflictComment} from '../comparisonProjectConflictComment.ts'
import type {ComparisonProjectJudgmentRow} from '../comparisonProjectJudgmentRows.ts'
import type {ComparisonProjectConflictResolution} from '../comparisonProjectRouteTypes.ts'

export type ComparisonProjectExportRow = ComparisonProjectJudgmentRow & {
  conflictComment?: ComparisonProjectConflictComment | null
  conflictResolution?: ComparisonProjectConflictResolution | null
}

export const getComparisonProjectExportCellValue = (value: string | null | undefined) => {
  return (value ?? '')
    .split(/\r\n|\n|\r/g)
    .map((line) => {
      return line.trim()
    })
    .filter((line) => {
      return line !== ''
    })
    .join('; ')
}
