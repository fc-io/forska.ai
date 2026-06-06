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
type ComparisonProjectRowFilterLabelColumn = {
  kind: 'llm' | 'human'
  modelLabel?: string | null
  sourceProjectId?: string | null
  sourceProjectName?: string | null
}
type ComparisonProjectRowFilterLabelContext = {columns?: readonly ComparisonProjectRowFilterLabelColumn[]}

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

export const defaultComparisonProjectRowFilter = 'all' satisfies ComparisonProjectRowFilter

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

const getIsAnswerRowFilter = (rowFilter: ComparisonProjectRowFilter): rowFilter is ComparisonProjectAnswerRowFilter => {
  return comparisonProjectAnswerRowFilters.includes(rowFilter as ComparisonProjectAnswerRowFilter)
}

const getColumnLabelPart = (value: string | null | undefined) => {
  const trimmedValue = value?.trim() ?? ''

  return trimmedValue.length > 0 ? trimmedValue : null
}

const getColumnSourceProjectKey = (column: ComparisonProjectRowFilterLabelColumn) => {
  return getColumnLabelPart(column.sourceProjectId) ?? getColumnLabelPart(column.sourceProjectName)
}

const getUniqueLabelParts = (values: readonly (string | null | undefined)[]) => {
  return Array.from(
    new Set(
      values.map(getColumnLabelPart).filter((value): value is string => {
        return value !== null
      }),
    ),
  )
}

const getLlmRowFilterSubjectLabel = (columns: readonly ComparisonProjectRowFilterLabelColumn[] | undefined) => {
  if (!columns) {
    return 'LLM'
  }

  const llmColumns = columns.filter((column) => {
    return column.kind === 'llm'
  })

  if (llmColumns.length === 0) {
    return 'LLM'
  }

  const modelLabels = getUniqueLabelParts(
    llmColumns.map((column) => {
      return column.modelLabel
    }),
  )
  const sourceProjectKeys = getUniqueLabelParts(llmColumns.map(getColumnSourceProjectKey))

  return modelLabels.length === 1 && sourceProjectKeys.length <= 1 ? (modelLabels[0] ?? 'LLM') : 'Any LLM'
}

const getAnswerRowFilterLabel = (
  rowFilter: ComparisonProjectAnswerRowFilter,
  context?: ComparisonProjectRowFilterLabelContext,
) => {
  const config = answerRowFilterConfig[rowFilter]
  const subjectLabel = config.kind === 'human' ? 'Human' : getLlmRowFilterSubjectLabel(context?.columns)

  return `${subjectLabel} has answered ${config.answer}`
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

export const getSelectableComparisonProjectRowFilters = (
  columns: readonly ComparisonProjectRowFilterLabelColumn[],
  currentRowFilter: ComparisonProjectRowFilter,
) => {
  const hasHumanColumns = columns.some((column) => {
    return column.kind === 'human'
  })
  const hasLlmColumns = columns.some((column) => {
    return column.kind === 'llm'
  })

  return comparisonProjectRowFilters.filter((rowFilter) => {
    const config = getIsAnswerRowFilter(rowFilter) ? answerRowFilterConfig[rowFilter] : null
    const isAvailable = !config || (config.kind === 'human' ? hasHumanColumns : hasLlmColumns)

    return isAvailable || rowFilter === currentRowFilter
  })
}

export const getComparisonProjectRowFilterLabel = (
  rowFilter: ComparisonProjectRowFilter,
  isSummaryMode: boolean,
  context?: ComparisonProjectRowFilterLabelContext,
) => {
  return rowFilter === 'multiple-answers'
    ? isSummaryMode
      ? 'Rows with more than 1 answer'
      : 'Rows with more than 1 answered prompt'
    : rowFilter === 'fully-answered'
      ? 'Rows where all shown columns are answered'
      : getIsAnswerRowFilter(rowFilter)
        ? getAnswerRowFilterLabel(rowFilter, context)
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
