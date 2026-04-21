export const comparisonProjectRowFilters = ['multiple-answers', 'fully-answered', 'all'] as const

export type ComparisonProjectRowFilter = (typeof comparisonProjectRowFilters)[number]

export type ComparisonProjectRowFilterEvaluation = {
  answeredColumnCount: number
  answeredPromptCount: number
  hasAllHumanColumns: boolean
  hasAllLlmColumns: boolean
  isSummaryMode: boolean
  rowFilter: ComparisonProjectRowFilter
}

export const defaultComparisonProjectRowFilter = 'multiple-answers' satisfies ComparisonProjectRowFilter

export const getNormalizedComparisonProjectRowFilter = (value: unknown): ComparisonProjectRowFilter => {
  return comparisonProjectRowFilters.includes(value as ComparisonProjectRowFilter)
    ? (value as ComparisonProjectRowFilter)
    : defaultComparisonProjectRowFilter
}

export const getComparisonProjectRowFilterLabel = (rowFilter: ComparisonProjectRowFilter, isSummaryMode: boolean) => {
  return rowFilter === 'multiple-answers'
    ? isSummaryMode
      ? 'Rows with more than 1 answer'
      : 'Rows with more than 1 answered prompt'
    : rowFilter === 'fully-answered'
      ? 'Rows where all shown columns are answered'
      : 'All rows'
}

export const getComparisonProjectPassesRowFilter = (params: ComparisonProjectRowFilterEvaluation) => {
  return params.rowFilter === 'all'
    ? true
    : params.rowFilter === 'fully-answered'
      ? params.hasAllLlmColumns && params.hasAllHumanColumns
      : params.isSummaryMode
        ? params.answeredColumnCount >= 2
        : params.answeredPromptCount >= 2
}
