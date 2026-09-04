import type {ComparisonProjectJudgmentsRow} from '../services/comparisonProjectsService.ts'

export type RetainedComparisonProjectJudgmentRows = Record<string, ComparisonProjectJudgmentsRow>

export const getComparisonProjectJudgmentRowsWithRetainedEdits = (
  serverRows: ComparisonProjectJudgmentsRow[],
  retainedRowsByArticleId: RetainedComparisonProjectJudgmentRows,
) => {
  const serverArticleIds = new Set(
    serverRows.map((row) => {
      return row.canonicalArticleId
    }),
  )

  return [
    ...serverRows,
    ...Object.values(retainedRowsByArticleId).filter((row) => {
      return !serverArticleIds.has(row.canonicalArticleId)
    }),
  ]
}
