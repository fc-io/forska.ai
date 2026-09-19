import {getComparisonProjectCanonicalFilterSelection} from './comparisonProjectFilterSelection.ts'

export const comparisonProjectDifferenceFilters = [
  'all',
  'human-vs-llm-overlap',
  'human-vs-llm',
  'human-vs-llm-true-conflict',
  'llm-vs-llm',
  'llm-vs-llm-true-difference',
  'any-disagreement',
  'resolution-vs-llm',
  'resolution-vs-llm-true-conflict',
  'resolution-vs-human',
  'resolution-vs-human-true-conflict',
] as const

export type ComparisonProjectDifferenceFilter = (typeof comparisonProjectDifferenceFilters)[number]

export type ComparisonProjectDifferenceColumn = {id: string; kind: 'llm' | 'human'; promptId: string}

export type ComparisonProjectDifferenceFilterAvailability = {hasConflictResolution?: boolean}

const comparisonProjectConflictResolutionDifferenceFilters = [
  'resolution-vs-llm',
  'resolution-vs-llm-true-conflict',
  'resolution-vs-human',
  'resolution-vs-human-true-conflict',
] as const satisfies readonly ComparisonProjectDifferenceFilter[]

export type ComparisonProjectConflictResolutionDifferenceFilter =
  (typeof comparisonProjectConflictResolutionDifferenceFilters)[number]

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
type ComparisonProjectDifferenceKind = ComparisonProjectDifferenceColumn['kind']
type ComparisonProjectDifferenceFilterMatcher = (
  promptAnswerBuckets: Map<string, PromptAnswerBuckets>,
  conflictResolution: string | null,
) => boolean

const comparisonProjectDifferenceFilterLabels = {
  all: 'All rows',
  'any-disagreement': 'Any disagreement',
  'human-vs-llm': 'Human vs LLM conflict',
  'human-vs-llm-overlap': 'Human and LLM judged',
  'human-vs-llm-true-conflict': 'Human vs LLM true conflict',
  'llm-vs-llm': 'LLM vs LLM differences',
  'llm-vs-llm-true-difference': 'LLM vs LLM true differences',
  'resolution-vs-human': 'Conflict resolution vs human conflict',
  'resolution-vs-human-true-conflict': 'Conflict resolution vs human true conflict',
  'resolution-vs-llm': 'Conflict resolution vs LLM conflict',
  'resolution-vs-llm-true-conflict': 'Conflict resolution vs LLM true conflict',
} satisfies Record<ComparisonProjectDifferenceFilter, string>

export const getIsComparisonProjectConflictResolutionDifferenceFilter = (
  differenceFilter: ComparisonProjectDifferenceFilter,
): differenceFilter is ComparisonProjectConflictResolutionDifferenceFilter => {
  return comparisonProjectConflictResolutionDifferenceFilters.includes(
    differenceFilter as ComparisonProjectConflictResolutionDifferenceFilter,
  )
}

export const comparisonProjectPrecomputedDifferenceFilters = comparisonProjectDifferenceFilters.filter(
  (differenceFilter) => {
    return !getIsComparisonProjectConflictResolutionDifferenceFilter(differenceFilter)
  },
)

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

const getNormalizedConflictResolution = (conflictResolution: string | null | undefined) => {
  const normalizedConflictResolution = (conflictResolution ?? '').trim().toLowerCase()

  return normalizedConflictResolution === '' ? null : normalizedConflictResolution
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

const getKindAnswers = (answerBuckets: PromptAnswerBuckets, kind: ComparisonProjectDifferenceKind) => {
  return kind === 'human' ? answerBuckets.humanAnswers : answerBuckets.llmAnswers
}

const getKindBinaryDecisions = (answerBuckets: PromptAnswerBuckets, kind: ComparisonProjectDifferenceKind) => {
  return kind === 'human' ? answerBuckets.humanBinaryDecisions : answerBuckets.llmBinaryDecisions
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

const getHasLlmVsLlmTrueDifference = (promptAnswerBuckets: Map<string, PromptAnswerBuckets>) => {
  return Array.from(promptAnswerBuckets.values()).some((answerBuckets) => {
    return answerBuckets.llmAnsweredCount > 1 && answerBuckets.llmBinaryDecisions.size > 1
  })
}

const getHasAnyDisagreement = (promptAnswerBuckets: Map<string, PromptAnswerBuckets>) => {
  return Array.from(promptAnswerBuckets.values()).some((answerBuckets) => {
    return answerBuckets.allAnsweredCount > 1 && answerBuckets.allAnswers.size > 1
  })
}

const getHasConflictResolutionVsKindDifference = (
  promptAnswerBuckets: Map<string, PromptAnswerBuckets>,
  kind: ComparisonProjectDifferenceKind,
  conflictResolution: string | null,
) => {
  return (
    conflictResolution !== null
    && getHasAnyDisagreement(promptAnswerBuckets)
    && Array.from(promptAnswerBuckets.values()).some((answerBuckets) => {
      return Array.from(getKindAnswers(answerBuckets, kind)).some((answer) => {
        return answer !== conflictResolution
      })
    })
  )
}

const getHasConflictResolutionVsKindTrueConflict = (
  promptAnswerBuckets: Map<string, PromptAnswerBuckets>,
  kind: ComparisonProjectDifferenceKind,
  conflictResolution: string | null,
) => {
  const conflictResolutionDecision = conflictResolution === null ? null : getBinaryDecision(conflictResolution)

  return (
    conflictResolutionDecision !== null
    && getHasAnyDisagreement(promptAnswerBuckets)
    && Array.from(promptAnswerBuckets.values()).some((answerBuckets) => {
      return Array.from(getKindBinaryDecisions(answerBuckets, kind)).some((decision) => {
        return decision !== conflictResolutionDecision
      })
    })
  )
}

const comparisonProjectDifferenceFilterMatchers = {
  'any-disagreement': getHasAnyDisagreement,
  'human-vs-llm': getHasHumanVsLlmDifference,
  'human-vs-llm-overlap': getHasHumanVsLlmOverlap,
  'human-vs-llm-true-conflict': getHasHumanVsLlmTrueConflict,
  'llm-vs-llm': getHasLlmVsLlmDifference,
  'llm-vs-llm-true-difference': getHasLlmVsLlmTrueDifference,
  'resolution-vs-human': (promptAnswerBuckets, conflictResolution) => {
    return getHasConflictResolutionVsKindDifference(promptAnswerBuckets, 'human', conflictResolution)
  },
  'resolution-vs-human-true-conflict': (promptAnswerBuckets, conflictResolution) => {
    return getHasConflictResolutionVsKindTrueConflict(promptAnswerBuckets, 'human', conflictResolution)
  },
  'resolution-vs-llm': (promptAnswerBuckets, conflictResolution) => {
    return getHasConflictResolutionVsKindDifference(promptAnswerBuckets, 'llm', conflictResolution)
  },
  'resolution-vs-llm-true-conflict': (promptAnswerBuckets, conflictResolution) => {
    return getHasConflictResolutionVsKindTrueConflict(promptAnswerBuckets, 'llm', conflictResolution)
  },
} satisfies Record<Exclude<ComparisonProjectDifferenceFilter, 'all'>, ComparisonProjectDifferenceFilterMatcher>

export const getAvailableComparisonProjectDifferenceFilters = (
  columns: readonly ComparisonProjectDifferenceColumn[],
  availability: ComparisonProjectDifferenceFilterAvailability = {},
): ComparisonProjectDifferenceFilter[] => {
  const promptColumnCounts = getPromptColumnCounts(columns)
  const hasHumanVsLlmComparison = Array.from(promptColumnCounts.values()).some((columnCounts) => {
    return columnCounts.humanCount > 0 && columnCounts.llmCount > 0
  })
  const hasLlmVsLlmComparison = Array.from(promptColumnCounts.values()).some((columnCounts) => {
    return columnCounts.llmCount > 1
  })
  const hasLlmColumns = Array.from(promptColumnCounts.values()).some((columnCounts) => {
    return columnCounts.llmCount > 0
  })
  const hasHumanColumns = Array.from(promptColumnCounts.values()).some((columnCounts) => {
    return columnCounts.humanCount > 0
  })
  const hasConflictResolution = availability.hasConflictResolution ?? false

  return [
    'all',
    ...(hasHumanVsLlmComparison ? (['human-vs-llm-overlap'] as const) : []),
    ...(hasHumanVsLlmComparison ? (['human-vs-llm'] as const) : []),
    ...(hasHumanVsLlmComparison ? (['human-vs-llm-true-conflict'] as const) : []),
    ...(hasLlmVsLlmComparison ? (['llm-vs-llm'] as const) : []),
    ...(hasLlmVsLlmComparison ? (['llm-vs-llm-true-difference'] as const) : []),
    ...(hasHumanVsLlmComparison && hasLlmVsLlmComparison ? (['any-disagreement'] as const) : []),
    ...(hasConflictResolution && hasLlmColumns
      ? (['resolution-vs-llm', 'resolution-vs-llm-true-conflict'] as const)
      : []),
    ...(hasConflictResolution && hasHumanColumns
      ? (['resolution-vs-human', 'resolution-vs-human-true-conflict'] as const)
      : []),
  ]
}

export const getSelectableComparisonProjectDifferenceFilters = (
  availableFilters: readonly ComparisonProjectDifferenceFilter[],
  selectedFilters: readonly ComparisonProjectDifferenceFilter[],
) => {
  const availableFilterSet = new Set(availableFilters)

  return comparisonProjectDifferenceFilters.filter((differenceFilter) => {
    return (
      differenceFilter !== 'all'
      && (selectedFilters.includes(differenceFilter) || availableFilterSet.has(differenceFilter))
    )
  })
}

export const getComparisonProjectDifferenceFilterLabel = (differenceFilter: ComparisonProjectDifferenceFilter) => {
  return comparisonProjectDifferenceFilterLabels[differenceFilter]
}

export const getComparisonProjectDifferenceFiltersLabel = (
  differenceFilters: readonly ComparisonProjectDifferenceFilter[],
) => {
  return differenceFilters.length === 0
    ? getComparisonProjectDifferenceFilterLabel('all')
    : differenceFilters.map(getComparisonProjectDifferenceFilterLabel).join(' + ')
}

export const getNormalizedComparisonProjectDifferenceFilter = (
  differenceFilter: ComparisonProjectDifferenceFilter,
  columns: readonly ComparisonProjectDifferenceColumn[],
  availability: ComparisonProjectDifferenceFilterAvailability = {},
) => {
  const availableFilters = getAvailableComparisonProjectDifferenceFilters(columns, availability)

  return availableFilters.includes(differenceFilter) ? differenceFilter : 'all'
}

export const getComparisonProjectDifferenceFilterSelection = (value: unknown): ComparisonProjectDifferenceFilter[] => {
  return getComparisonProjectCanonicalFilterSelection(value, comparisonProjectDifferenceFilters)
}

export const getNormalizedComparisonProjectDifferenceFilters = (
  value: unknown,
  columns: readonly ComparisonProjectDifferenceColumn[],
  availability: ComparisonProjectDifferenceFilterAvailability = {},
): ComparisonProjectDifferenceFilter[] => {
  const availableFilters = new Set(getAvailableComparisonProjectDifferenceFilters(columns, availability))

  return getComparisonProjectDifferenceFilterSelection(value).filter((differenceFilter) => {
    return availableFilters.has(differenceFilter)
  })
}

export const getComparisonProjectHasDifferenceFilterMatch = (
  cells: Record<string, string | null>,
  columns: readonly ComparisonProjectDifferenceColumn[],
  differenceFilter: ComparisonProjectDifferenceFilter,
  conflictResolution?: string | null,
) => {
  const normalizedDifferenceFilter = getNormalizedComparisonProjectDifferenceFilter(differenceFilter, columns, {
    hasConflictResolution: conflictResolution !== undefined,
  })

  if (normalizedDifferenceFilter === 'all') {
    return true
  }

  const promptAnswerBuckets = getPromptAnswerBuckets(cells, columns)

  return comparisonProjectDifferenceFilterMatchers[normalizedDifferenceFilter](
    promptAnswerBuckets,
    getNormalizedConflictResolution(conflictResolution),
  )
}

export const getComparisonProjectHasAnyConflict = (
  cells: Record<string, string | null>,
  columns: readonly ComparisonProjectDifferenceColumn[],
) => {
  return getHasAnyDisagreement(getPromptAnswerBuckets(cells, columns))
}
