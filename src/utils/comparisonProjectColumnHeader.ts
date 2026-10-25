export type ComparisonProjectColumnHeaderColumn = {
  contentLabel: string | null
  kind: 'human' | 'llm'
  modelLabel: string
  promptLabel: string
  sourceProjectName: string | null
}

export const getComparisonProjectColumnHeader = (column: ComparisonProjectColumnHeaderColumn) => {
  const answerSourceLabel = column.kind === 'human' ? 'Human answer' : `LLM - ${column.modelLabel}`

  return [column.sourceProjectName, column.promptLabel, answerSourceLabel, column.contentLabel]
    .map((part) => {
      return part?.trim() ?? ''
    })
    .filter((part) => {
      return part !== ''
    })
    .join(' - ')
}
