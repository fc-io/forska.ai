import type {
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

const summaryPromptId = 'summary'

const notCurrentSuffix = ' (not current)'

const otherSettingsDifferLine =
  'Other settings differ from the current prompts (criteria dispositions, source projects or human judgment mode)'

const contentFlagLabels = [
  ['useTitle', 'title'],
  ['useAbstract', 'abstract'],
  ['useFulltext', 'full text'],
  ['useFulltextNoImages', 'full text without images'],
  ['useMetadata', 'metadata'],
] as const

export const getComparisonJudgmentContextIds = (rows: readonly ComparisonProjectJudgmentsRow[]) => {
  return Array.from(
    new Set(
      rows.flatMap((row) => {
        const contextId = row.conflictResolution?.provenance?.contextId

        return contextId ? [contextId] : []
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

const getIsNotCurrentEntry = (entry: ComparisonJudgmentContextSummaryEntry, currentIds: ReadonlySet<string> | null) => {
  return currentIds !== null && !currentIds.has(entry.id)
}

const getMarkedEntryLabels = (
  entries: readonly ComparisonJudgmentContextSummaryEntry[],
  currentIds: ReadonlySet<string> | null,
) => {
  const labels = entries.map((entry) => {
    return getIsNotCurrentEntry(entry, currentIds) ? `${entry.label}${notCurrentSuffix}` : entry.label
  })

  return labels.length > 0 ? labels.join(', ') : 'none'
}

const getModelEntries = (summary: ComparisonJudgmentContextSummary) => {
  return summary.models.map((model) => {
    return {id: model.id, label: getEntryLabel(model.name, model.id)}
  })
}

const getPromptEntries = (summary: ComparisonJudgmentContextSummary) => {
  return summary.prompts
    .filter((prompt) => {
      return prompt.id !== summaryPromptId
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
  return (summary.context?.columns ?? []).flatMap((column) => {
    return column.kind === 'llm' ? [getContentEntry(column)] : []
  })
}

const contextSummaryLineDefinitions: ComparisonJudgmentContextSummaryLineDefinition[] = [
  {getEntries: getModelEntries, label: 'Models'},
  {getEntries: getVariantEntries, label: 'System prompt variants'},
  {getEntries: getPromptEntries, label: 'Prompts'},
  {getEntries: getContentEntries, label: 'Content'},
]

const getIdSet = (entries: readonly ComparisonJudgmentContextSummaryEntry[]) => {
  return new Set(
    entries.map((entry) => {
      return entry.id
    }),
  )
}

const getCurrentIdSet = (
  currentSummary: ComparisonJudgmentContextSummary | null,
  getEntries: (summary: ComparisonJudgmentContextSummary) => ComparisonJudgmentContextSummaryEntry[],
) => {
  return currentSummary ? getIdSet(getEntries(currentSummary)) : null
}

export const getComparisonJudgmentContextSummaryLines = (
  summary: ComparisonJudgmentContextSummary,
  currentSummary: ComparisonJudgmentContextSummary | null = null,
) => {
  const comparedSummary = currentSummary && currentSummary.id !== summary.id ? currentSummary : null
  const lineParts = contextSummaryLineDefinitions.map((definition) => {
    return {
      currentIds: getCurrentIdSet(comparedSummary, definition.getEntries),
      entries: getDistinctEntries(definition.getEntries(summary)),
      label: definition.label,
    }
  })
  const hasNotCurrentEntry = lineParts.some((linePart) => {
    return linePart.entries.some((entry) => {
      return getIsNotCurrentEntry(entry, linePart.currentIds)
    })
  })
  const lines = lineParts.map((linePart) => {
    return `${linePart.label}: ${getMarkedEntryLabels(linePart.entries, linePart.currentIds)}`
  })

  return comparedSummary && !hasNotCurrentEntry ? [...lines, otherSettingsDifferLine] : lines
}
