export const comparisonProjectAnswerRowFilters = [
  'llm-answered-yes',
  'llm-answered-no',
  'llm-answered-maybe',
  'human-answered-yes',
  'human-answered-no',
  'human-answered-maybe',
] as const

export const comparisonProjectRowFilters = [
  'multiple-answers',
  'fully-answered',
  ...comparisonProjectAnswerRowFilters,
  'all',
] as const

export type ComparisonProjectRowFilter = (typeof comparisonProjectRowFilters)[number]
export type ComparisonProjectAnswerRowFilter = (typeof comparisonProjectAnswerRowFilters)[number]

type ComparisonProjectAnswerFilterValue = 'yes' | 'no' | 'maybe'
type ComparisonProjectRowFilterColumn = {id: string; kind: 'llm' | 'human'}

export type ComparisonProjectRowFilterEvaluation = {
  answeredColumnCount: number
  answeredPromptCount: number
  cells: Record<string, string | null>
  columns: readonly ComparisonProjectRowFilterColumn[]
  hasAllHumanColumns: boolean
  hasAllLlmColumns: boolean
  isSummaryMode: boolean
  rowFilter: ComparisonProjectRowFilter
}

export const defaultComparisonProjectRowFilter = 'multiple-answers' satisfies ComparisonProjectRowFilter

const answerRowFilterConfig = {
  'human-answered-maybe': {answer: 'maybe', kind: 'human'},
  'human-answered-no': {answer: 'no', kind: 'human'},
  'human-answered-yes': {answer: 'yes', kind: 'human'},
  'llm-answered-maybe': {answer: 'maybe', kind: 'llm'},
  'llm-answered-no': {answer: 'no', kind: 'llm'},
  'llm-answered-yes': {answer: 'yes', kind: 'llm'},
} satisfies Record<
  ComparisonProjectAnswerRowFilter,
  {answer: ComparisonProjectAnswerFilterValue; kind: 'human' | 'llm'}
>

const answerRowFilterLabels = {
  'human-answered-maybe': 'Human has answered maybe',
  'human-answered-no': 'Human has answered no',
  'human-answered-yes': 'Human has answered yes',
  'llm-answered-maybe': 'LLM has answered maybe',
  'llm-answered-no': 'LLM has answered no',
  'llm-answered-yes': 'LLM has answered yes',
} satisfies Record<ComparisonProjectAnswerRowFilter, string>

const getIsAnswerRowFilter = (rowFilter: ComparisonProjectRowFilter): rowFilter is ComparisonProjectAnswerRowFilter => {
  return comparisonProjectAnswerRowFilters.includes(rowFilter as ComparisonProjectAnswerRowFilter)
}

const getNormalizedCellAnswers = (value: string | null | undefined) => {
  return (value ?? '')
    .split('\n')
    .map((answer) => {
      return answer.trim().toLowerCase()
    })
    .filter((answer) => {
      return answer !== ''
    })
}

const getHasAnsweredValue = (
  cells: Record<string, string | null>,
  columns: readonly ComparisonProjectRowFilterColumn[],
  kind: 'human' | 'llm',
  answer: ComparisonProjectAnswerFilterValue,
) => {
  return columns.some((column) => {
    return column.kind === kind && getNormalizedCellAnswers(cells[column.id]).includes(answer)
  })
}

const getPassesAnswerRowFilter = (params: ComparisonProjectRowFilterEvaluation) => {
  const config = getIsAnswerRowFilter(params.rowFilter) ? answerRowFilterConfig[params.rowFilter] : null

  return config ? getHasAnsweredValue(params.cells, params.columns, config.kind, config.answer) : false
}

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
      : getIsAnswerRowFilter(rowFilter)
        ? answerRowFilterLabels[rowFilter]
        : 'All rows'
}

export const getComparisonProjectPassesRowFilter = (params: ComparisonProjectRowFilterEvaluation) => {
  return params.rowFilter === 'all'
    ? true
    : params.rowFilter === 'fully-answered'
      ? params.hasAllLlmColumns && params.hasAllHumanColumns
      : getIsAnswerRowFilter(params.rowFilter)
        ? getPassesAnswerRowFilter(params)
        : params.isSummaryMode
          ? params.answeredColumnCount >= 2
          : params.answeredPromptCount >= 2
}
