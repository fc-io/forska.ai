export type ComparisonProjectDifferenceFilter = 'all' | 'human-vs-llm' | 'llm-vs-llm' | 'any-disagreement'

export type ComparisonProjectDifferenceColumn = {id: string; kind: 'llm' | 'human'; promptId: string}

type PromptColumnCounts = {humanCount: number; llmCount: number}
type PromptAnswerBuckets = {
  allAnswers: Set<string>
  allAnsweredCount: number
  humanAnswers: Set<string>
  humanAnsweredCount: number
  llmAnswers: Set<string>
  llmAnsweredCount: number
}

const getPromptColumnCounts = (columns: readonly ComparisonProjectDifferenceColumn[]) => {
  return columns.reduce<Map<string, PromptColumnCounts>>((countMap, column) => {
    const currentCounts = countMap.get(column.promptId) ?? {humanCount: 0, llmCount: 0}
    const nextCounts =
      column.kind === 'human'
        ? {humanCount: currentCounts.humanCount + 1, llmCount: currentCounts.llmCount}
        : {humanCount: currentCounts.humanCount, llmCount: currentCounts.llmCount + 1}

    countMap.set(column.promptId, nextCounts)
    return countMap
  }, new Map<string, PromptColumnCounts>())
}

const getNormalizedAnswers = (value: string | null | undefined) => {
  return Array.from(
    new Set(
      (value ?? '')
        .split('\n')
        .map((answer) => {
          return answer.trim().toLowerCase()
        })
        .filter((answer) => {
          return answer !== ''
        }),
    ),
  )
}

const createPromptAnswerBuckets = (): PromptAnswerBuckets => {
  return {
    allAnswers: new Set<string>(),
    allAnsweredCount: 0,
    humanAnswers: new Set<string>(),
    humanAnsweredCount: 0,
    llmAnswers: new Set<string>(),
    llmAnsweredCount: 0,
  }
}

const getPromptAnswerBuckets = (
  cells: Record<string, string | null>,
  columns: readonly ComparisonProjectDifferenceColumn[],
) => {
  return columns.reduce<Map<string, PromptAnswerBuckets>>((bucketMap, column) => {
    const normalizedAnswers = getNormalizedAnswers(cells[column.id])

    if (normalizedAnswers.length === 0) {
      return bucketMap
    }

    const currentBuckets = bucketMap.get(column.promptId) ?? createPromptAnswerBuckets()
    const allAnswers = new Set([...currentBuckets.allAnswers, ...normalizedAnswers])
    const kindAnswers =
      column.kind === 'human'
        ? new Set([...currentBuckets.humanAnswers, ...normalizedAnswers])
        : new Set([...currentBuckets.llmAnswers, ...normalizedAnswers])
    const nextBuckets =
      column.kind === 'human'
        ? {
            ...currentBuckets,
            allAnswers,
            allAnsweredCount: currentBuckets.allAnsweredCount + 1,
            humanAnswers: kindAnswers,
            humanAnsweredCount: currentBuckets.humanAnsweredCount + 1,
          }
        : {
            ...currentBuckets,
            allAnswers,
            allAnsweredCount: currentBuckets.allAnsweredCount + 1,
            llmAnswers: kindAnswers,
            llmAnsweredCount: currentBuckets.llmAnsweredCount + 1,
          }

    bucketMap.set(column.promptId, nextBuckets)
    return bucketMap
  }, new Map<string, PromptAnswerBuckets>())
}

const getHasHumanVsLlmDifference = (promptAnswerBuckets: Map<string, PromptAnswerBuckets>) => {
  return Array.from(promptAnswerBuckets.values()).some((answerBuckets) => {
    return (
      answerBuckets.humanAnsweredCount > 0
      && answerBuckets.llmAnsweredCount > 0
      && new Set([...answerBuckets.humanAnswers, ...answerBuckets.llmAnswers]).size > 1
    )
  })
}

const getHasLlmVsLlmDifference = (promptAnswerBuckets: Map<string, PromptAnswerBuckets>) => {
  return Array.from(promptAnswerBuckets.values()).some((answerBuckets) => {
    return answerBuckets.llmAnsweredCount > 1 && answerBuckets.llmAnswers.size > 1
  })
}

const getHasAnyDisagreement = (promptAnswerBuckets: Map<string, PromptAnswerBuckets>) => {
  return Array.from(promptAnswerBuckets.values()).some((answerBuckets) => {
    return answerBuckets.allAnsweredCount > 1 && answerBuckets.allAnswers.size > 1
  })
}

export const getAvailableComparisonProjectDifferenceFilters = (
  columns: readonly ComparisonProjectDifferenceColumn[],
): ComparisonProjectDifferenceFilter[] => {
  const promptColumnCounts = getPromptColumnCounts(columns)
  const hasHumanVsLlmComparison = Array.from(promptColumnCounts.values()).some((columnCounts) => {
    return columnCounts.humanCount > 0 && columnCounts.llmCount > 0
  })
  const hasLlmVsLlmComparison = Array.from(promptColumnCounts.values()).some((columnCounts) => {
    return columnCounts.llmCount > 1
  })

  return [
    'all',
    ...(hasHumanVsLlmComparison ? (['human-vs-llm'] as const) : []),
    ...(hasLlmVsLlmComparison ? (['llm-vs-llm'] as const) : []),
    ...(hasHumanVsLlmComparison && hasLlmVsLlmComparison ? (['any-disagreement'] as const) : []),
  ]
}

export const getComparisonProjectDifferenceFilterLabel = (differenceFilter: ComparisonProjectDifferenceFilter) => {
  return differenceFilter === 'all'
    ? 'All rows'
    : differenceFilter === 'human-vs-llm'
      ? 'Human vs LLM differences'
      : differenceFilter === 'llm-vs-llm'
        ? 'LLM vs LLM differences'
        : 'Any disagreement'
}

export const getNormalizedComparisonProjectDifferenceFilter = (
  differenceFilter: ComparisonProjectDifferenceFilter,
  columns: readonly ComparisonProjectDifferenceColumn[],
) => {
  const availableFilters = getAvailableComparisonProjectDifferenceFilters(columns)

  return availableFilters.includes(differenceFilter) ? differenceFilter : 'all'
}

export const getComparisonProjectHasDifferenceFilterMatch = (
  cells: Record<string, string | null>,
  columns: readonly ComparisonProjectDifferenceColumn[],
  differenceFilter: ComparisonProjectDifferenceFilter,
) => {
  const normalizedDifferenceFilter = getNormalizedComparisonProjectDifferenceFilter(differenceFilter, columns)

  if (normalizedDifferenceFilter === 'all') {
    return true
  }

  const promptAnswerBuckets = getPromptAnswerBuckets(cells, columns)

  return normalizedDifferenceFilter === 'human-vs-llm'
    ? getHasHumanVsLlmDifference(promptAnswerBuckets)
    : normalizedDifferenceFilter === 'llm-vs-llm'
      ? getHasLlmVsLlmDifference(promptAnswerBuckets)
      : getHasAnyDisagreement(promptAnswerBuckets)
}
