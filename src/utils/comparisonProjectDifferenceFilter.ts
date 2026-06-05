export const comparisonProjectDifferenceFilters = [
  'all',
  'human-vs-llm-overlap',
  'human-vs-llm',
  'human-vs-llm-true-conflict',
  'llm-vs-llm',
  'any-disagreement',
] as const

export type ComparisonProjectDifferenceFilter = (typeof comparisonProjectDifferenceFilters)[number]

export type ComparisonProjectDifferenceColumn = {id: string; kind: 'llm' | 'human'; promptId: string}

type PromptColumnCounts = {humanCount: number; llmCount: number}
type PromptAnswerBuckets = {
  allAnswers: Set<string>
  allAnsweredCount: number
  allBinaryDecisions: Set<BinaryDecision>
  humanAnswers: Set<string>
  humanAnsweredCount: number
  humanBinaryDecisions: Set<BinaryDecision>
  llmAnswers: Set<string>
  llmAnsweredCount: number
  llmBinaryDecisions: Set<BinaryDecision>
}

type BinaryDecision = 'exclude' | 'include'

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

const getBinaryDecision = (answer: string): BinaryDecision | null => {
  return answer === 'yes' || answer === 'maybe' ? 'include' : answer === 'no' ? 'exclude' : null
}

const getBinaryDecisions = (answers: readonly string[]) => {
  return answers.map(getBinaryDecision).filter((decision): decision is BinaryDecision => {
    return decision !== null
  })
}

const createPromptAnswerBuckets = (): PromptAnswerBuckets => {
  return {
    allAnswers: new Set<string>(),
    allAnsweredCount: 0,
    allBinaryDecisions: new Set<BinaryDecision>(),
    humanAnswers: new Set<string>(),
    humanAnsweredCount: 0,
    humanBinaryDecisions: new Set<BinaryDecision>(),
    llmAnswers: new Set<string>(),
    llmAnsweredCount: 0,
    llmBinaryDecisions: new Set<BinaryDecision>(),
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
    const binaryDecisions = getBinaryDecisions(normalizedAnswers)
    const allBinaryDecisions = new Set([...currentBuckets.allBinaryDecisions, ...binaryDecisions])
    const kindAnswers =
      column.kind === 'human'
        ? new Set([...currentBuckets.humanAnswers, ...normalizedAnswers])
        : new Set([...currentBuckets.llmAnswers, ...normalizedAnswers])
    const kindBinaryDecisions =
      column.kind === 'human'
        ? new Set([...currentBuckets.humanBinaryDecisions, ...binaryDecisions])
        : new Set([...currentBuckets.llmBinaryDecisions, ...binaryDecisions])
    const nextBuckets =
      column.kind === 'human'
        ? {
            ...currentBuckets,
            allAnswers,
            allAnsweredCount: currentBuckets.allAnsweredCount + 1,
            allBinaryDecisions,
            humanAnswers: kindAnswers,
            humanAnsweredCount: currentBuckets.humanAnsweredCount + 1,
            humanBinaryDecisions: kindBinaryDecisions,
          }
        : {
            ...currentBuckets,
            allAnswers,
            allAnsweredCount: currentBuckets.allAnsweredCount + 1,
            allBinaryDecisions,
            llmAnswers: kindAnswers,
            llmAnsweredCount: currentBuckets.llmAnsweredCount + 1,
            llmBinaryDecisions: kindBinaryDecisions,
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

const getHasHumanVsLlmOverlap = (promptAnswerBuckets: Map<string, PromptAnswerBuckets>) => {
  return Array.from(promptAnswerBuckets.values()).some((answerBuckets) => {
    return answerBuckets.humanAnsweredCount > 0 && answerBuckets.llmAnsweredCount > 0
  })
}

const getHasHumanVsLlmTrueConflict = (promptAnswerBuckets: Map<string, PromptAnswerBuckets>) => {
  return Array.from(promptAnswerBuckets.values()).some((answerBuckets) => {
    return (
      answerBuckets.humanBinaryDecisions.size > 0
      && answerBuckets.llmBinaryDecisions.size > 0
      && answerBuckets.allBinaryDecisions.size > 1
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
    ...(hasHumanVsLlmComparison ? (['human-vs-llm-overlap'] as const) : []),
    ...(hasHumanVsLlmComparison ? (['human-vs-llm'] as const) : []),
    ...(hasHumanVsLlmComparison ? (['human-vs-llm-true-conflict'] as const) : []),
    ...(hasLlmVsLlmComparison ? (['llm-vs-llm'] as const) : []),
    ...(hasHumanVsLlmComparison && hasLlmVsLlmComparison ? (['any-disagreement'] as const) : []),
  ]
}

export const getSelectableComparisonProjectDifferenceFilters = (
  availableFilters: readonly ComparisonProjectDifferenceFilter[],
  selectedFilter: ComparisonProjectDifferenceFilter,
) => {
  const availableFilterSet = new Set(availableFilters)

  return comparisonProjectDifferenceFilters.filter((differenceFilter) => {
    return differenceFilter === selectedFilter || availableFilterSet.has(differenceFilter)
  })
}

export const getComparisonProjectDifferenceFilterLabel = (differenceFilter: ComparisonProjectDifferenceFilter) => {
  return differenceFilter === 'all'
    ? 'All rows'
    : differenceFilter === 'human-vs-llm-overlap'
      ? 'Human and LLM judged'
      : differenceFilter === 'human-vs-llm'
        ? 'Human vs LLM conflict'
        : differenceFilter === 'human-vs-llm-true-conflict'
          ? 'Human vs LLM true conflict'
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
    : normalizedDifferenceFilter === 'human-vs-llm-overlap'
      ? getHasHumanVsLlmOverlap(promptAnswerBuckets)
      : normalizedDifferenceFilter === 'human-vs-llm-true-conflict'
        ? getHasHumanVsLlmTrueConflict(promptAnswerBuckets)
        : normalizedDifferenceFilter === 'llm-vs-llm'
          ? getHasLlmVsLlmDifference(promptAnswerBuckets)
          : getHasAnyDisagreement(promptAnswerBuckets)
}

export const getComparisonProjectHasAnyConflict = (
  cells: Record<string, string | null>,
  columns: readonly ComparisonProjectDifferenceColumn[],
) => {
  return getHasAnyDisagreement(getPromptAnswerBuckets(cells, columns))
}
