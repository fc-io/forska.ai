export type ComparisonProjectColumnOrderColumn = {kind: 'llm' | 'human'; promptId: string}
export type ComparisonProjectColumnOrderPrompt = {id: string; order: number}

type IndexedComparisonProjectColumn<TColumn extends ComparisonProjectColumnOrderColumn> = {
  column: TColumn
  index: number
}

const getPromptOrderMap = (prompts: readonly ComparisonProjectColumnOrderPrompt[]) => {
  return prompts.reduce<Record<string, number>>((orderMap, prompt) => {
    return {...orderMap, [prompt.id]: prompt.order}
  }, {})
}

const getColumnPromptOrder = (promptOrderMap: Record<string, number>, column: ComparisonProjectColumnOrderColumn) => {
  return promptOrderMap[column.promptId] ?? Number.MAX_SAFE_INTEGER
}

const getColumnKindOrder = (column: ComparisonProjectColumnOrderColumn) => {
  return column.kind === 'llm' ? 0 : 1
}

const getColumnOrderDiff = <TColumn extends ComparisonProjectColumnOrderColumn>(
  left: IndexedComparisonProjectColumn<TColumn>,
  right: IndexedComparisonProjectColumn<TColumn>,
  promptOrderMap: Record<string, number>,
) => {
  const promptDiff =
    getColumnPromptOrder(promptOrderMap, left.column) - getColumnPromptOrder(promptOrderMap, right.column)
  const kindDiff = getColumnKindOrder(left.column) - getColumnKindOrder(right.column)

  return (
    [promptDiff, kindDiff, left.index - right.index].find((diff) => {
      return diff !== 0
    }) ?? 0
  )
}

export const getOrderedComparisonProjectColumns = <TColumn extends ComparisonProjectColumnOrderColumn>(
  columns: readonly TColumn[],
  prompts: readonly ComparisonProjectColumnOrderPrompt[],
) => {
  const promptOrderMap = getPromptOrderMap(prompts)

  return columns
    .map<IndexedComparisonProjectColumn<TColumn>>((column, index) => {
      return {column, index}
    })
    .sort((left, right) => {
      return getColumnOrderDiff(left, right, promptOrderMap)
    })
    .map(({column}) => {
      return column
    })
}
