import type {
  ComparisonJudgmentContextCriterion,
  ComparisonJudgmentContextLlmColumn,
  ComparisonJudgmentContextSummary,
  ComparisonProjectJudgmentsRow,
} from '../services/comparisonProjectsService.ts'

export type ComparisonJudgmentContextSummariesById = Record<string, ComparisonJudgmentContextSummary>

type ComparisonJudgmentContextSummaryEntry = {id: string; label: string}

type ComparisonJudgmentContextSummaryLineDefinition = {
  getEntries: (summary: ComparisonJudgmentContextSummary) => ComparisonJudgmentContextSummaryEntry[]
  label: string
}

type ComparisonJudgmentContextSummaryLinePart = {
  addedEntries: ComparisonJudgmentContextSummaryEntry[]
  entries: ComparisonJudgmentContextSummaryEntry[]
  label: string
  removedIds: ReadonlySet<string>
}

const summaryPromptId = 'summary'

const noLongerUsedSuffix = ' (no longer used)'

const otherSettingsDifferLine =
  'Other settings differ from the current prompts (source projects, human judgment mode or how columns combine these settings)'

const contentFlagLabels = [
  ['useTitle', 'title'],
  ['useAbstract', 'abstract'],
  ['useFulltext', 'full text'],
  ['useFulltextNoImages', 'full text without images'],
  ['useMetadata', 'metadata'],
] as const

export const getComparisonJudgmentContextIds = (
  rows: readonly ComparisonProjectJudgmentsRow[],
  excludedContextId: string | null = null,
) => {
  return Array.from(
    new Set(
      rows.flatMap((row) => {
        const contextId = row.conflictResolution?.provenance?.contextId

        return contextId && contextId !== excludedContextId ? [contextId] : []
      }),
    ),
  ).sort()
}

export const getComparisonJudgmentContextSummariesById = (
  summaries: readonly ComparisonJudgmentContextSummary[],
  currentSummary: ComparisonJudgmentContextSummary | null = null,
): ComparisonJudgmentContextSummariesById => {
  return [...summaries, ...(currentSummary ? [currentSummary] : [])].reduce<ComparisonJudgmentContextSummariesById>(
    (summariesById, summary) => {
      return {...summariesById, [summary.id]: summary}
    },
    {},
  )
}

const getEntryLabel = (label: string | null, id: string) => {
  return label?.trim() || id
}

const getDistinctEntries = (entries: readonly ComparisonJudgmentContextSummaryEntry[]) => {
  return Array.from(
    entries
      .reduce<Map<string, ComparisonJudgmentContextSummaryEntry>>((entriesById, entry) => {
        return entriesById.has(entry.id) ? entriesById : entriesById.set(entry.id, entry)
      }, new Map<string, ComparisonJudgmentContextSummaryEntry>())
      .values(),
  )
}

const getEntryIds = (entries: readonly ComparisonJudgmentContextSummaryEntry[]) => {
  return new Set(
    entries.map((entry) => {
      return entry.id
    }),
  )
}

const getEntriesMissingFrom = (
  entries: readonly ComparisonJudgmentContextSummaryEntry[],
  otherEntries: readonly ComparisonJudgmentContextSummaryEntry[],
) => {
  const otherIds = getEntryIds(otherEntries)

  return entries.filter((entry) => {
    return !otherIds.has(entry.id)
  })
}

const getLlmColumns = (summary: ComparisonJudgmentContextSummary) => {
  return (summary.context?.columns ?? []).filter((column): column is ComparisonJudgmentContextLlmColumn => {
    return column.kind === 'llm'
  })
}

const getCriteria = (summary: ComparisonJudgmentContextSummary): ComparisonJudgmentContextCriterion[] => {
  return getLlmColumns(summary).flatMap((column) => {
    return column.criteria ?? []
  })
}

const getCriterionEntry = (criterion: ComparisonJudgmentContextCriterion): ComparisonJudgmentContextSummaryEntry => {
  const heading = getEntryLabel(criterion.promptHeading, criterion.promptId)

  return {
    id: `${criterion.promptId}\u001F${criterion.criteriaDisposition ?? ''}`,
    label: criterion.criteriaDisposition ? `${heading} (${criterion.criteriaDisposition})` : heading,
  }
}

const getCriteriaEntries = (summary: ComparisonJudgmentContextSummary) => {
  return getCriteria(summary).map(getCriterionEntry)
}

const getModelEntries = (summary: ComparisonJudgmentContextSummary) => {
  return summary.models.map((model) => {
    return {id: model.id, label: getEntryLabel(model.name, model.id)}
  })
}

const getPromptEntries = (summary: ComparisonJudgmentContextSummary) => {
  const criteriaPromptIds = new Set(
    getCriteria(summary).map((criterion) => {
      return criterion.promptId
    }),
  )

  return summary.prompts
    .filter((prompt) => {
      return prompt.id !== summaryPromptId && !criteriaPromptIds.has(prompt.id)
    })
    .map((prompt) => {
      return {id: prompt.id, label: getEntryLabel(prompt.heading, prompt.id)}
    })
}

const getVariantEntries = (summary: ComparisonJudgmentContextSummary) => {
  return summary.systemPromptVariants.map((variant) => {
    return {id: variant, label: variant}
  })
}

const getContentEntry = (column: ComparisonJudgmentContextLlmColumn): ComparisonJudgmentContextSummaryEntry => {
  const label = contentFlagLabels
    .filter(([flag]) => {
      return column[flag]
    })
    .map(([, flagLabel]) => {
      return flagLabel
    })
    .join(' + ')

  return {id: label, label: label || 'none'}
}

const getContentEntries = (summary: ComparisonJudgmentContextSummary) => {
  return getLlmColumns(summary).map(getContentEntry)
}

const contextSummaryLineDefinitions: ComparisonJudgmentContextSummaryLineDefinition[] = [
  {getEntries: getModelEntries, label: 'Models'},
  {getEntries: getVariantEntries, label: 'System prompt variants'},
  {getEntries: getPromptEntries, label: 'Prompts'},
  {getEntries: getCriteriaEntries, label: 'Criteria'},
  {getEntries: getContentEntries, label: 'Content'},
]

const getLinePart = (
  definition: ComparisonJudgmentContextSummaryLineDefinition,
  summary: ComparisonJudgmentContextSummary,
  comparedSummary: ComparisonJudgmentContextSummary | null,
): ComparisonJudgmentContextSummaryLinePart => {
  const entries = getDistinctEntries(definition.getEntries(summary))
  const comparedEntries = comparedSummary ? getDistinctEntries(definition.getEntries(comparedSummary)) : entries

  return {
    addedEntries: getEntriesMissingFrom(comparedEntries, entries),
    entries,
    label: definition.label,
    removedIds: getEntryIds(getEntriesMissingFrom(entries, comparedEntries)),
  }
}

const getEntryLabels = (entries: readonly ComparisonJudgmentContextSummaryEntry[]) => {
  return entries
    .map((entry) => {
      return entry.label
    })
    .join(', ')
}

const getMarkedEntryLabels = (linePart: ComparisonJudgmentContextSummaryLinePart) => {
  const labels = linePart.entries.map((entry) => {
    return linePart.removedIds.has(entry.id) ? `${entry.label}${noLongerUsedSuffix}` : entry.label
  })

  return labels.length > 0 ? labels.join(', ') : 'none'
}

const getLine = (linePart: ComparisonJudgmentContextSummaryLinePart) => {
  const addedLabel = linePart.addedEntries.length > 0 ? `; added since: ${getEntryLabels(linePart.addedEntries)}` : ''

  return `${linePart.label}: ${getMarkedEntryLabels(linePart)}${addedLabel}`
}

const getHasLineEntries = (linePart: ComparisonJudgmentContextSummaryLinePart) => {
  return linePart.entries.length > 0 || linePart.addedEntries.length > 0
}

const getHasLineDifference = (linePart: ComparisonJudgmentContextSummaryLinePart) => {
  return linePart.removedIds.size > 0 || linePart.addedEntries.length > 0
}

export const getComparisonJudgmentContextSummaryLines = (
  summary: ComparisonJudgmentContextSummary,
  currentSummary: ComparisonJudgmentContextSummary | null = null,
) => {
  const comparedSummary = currentSummary && currentSummary.id !== summary.id ? currentSummary : null
  const lineParts = contextSummaryLineDefinitions
    .map((definition) => {
      return getLinePart(definition, summary, comparedSummary)
    })
    .filter(getHasLineEntries)
  const lines = lineParts.map(getLine)

  return comparedSummary && !lineParts.some(getHasLineDifference) ? [...lines, otherSettingsDifferLine] : lines
}
