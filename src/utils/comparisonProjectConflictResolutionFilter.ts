import {
  getComparisonProjectCanonicalFilterSelection,
  getComparisonProjectFilterSelectionValues,
} from './comparisonProjectFilterSelection.ts'

export type ComparisonProjectConflictResolutionFilter = string

export const comparisonProjectConflictResolutionProvenanceFilters = ['current', 'outdated', 'unknown'] as const

export type ComparisonProjectConflictResolutionProvenanceFilter =
  (typeof comparisonProjectConflictResolutionProvenanceFilters)[number]

export type ComparisonProjectConflictResolutionProvenanceFilterOption = {
  label: string
  value: ComparisonProjectConflictResolutionProvenanceFilter
}

const comparisonProjectConflictResolutionProvenanceFilterLabels = {
  current: 'Current prompts',
  outdated: 'Older prompts',
  unknown: 'Prompts unknown',
} satisfies Record<ComparisonProjectConflictResolutionProvenanceFilter, string>

export type ComparisonProjectConflictResolutionFilterOption = {
  label: string
  value: ComparisonProjectConflictResolutionFilter
}
type ComparisonProjectPromptWithType = {type: string | null}

export const defaultComparisonProjectConflictResolutionFilter: ComparisonProjectConflictResolutionFilter = 'all'

export const getNormalizedComparisonProjectConflictResolutionFilter = (
  value: unknown,
): ComparisonProjectConflictResolutionFilter => {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : defaultComparisonProjectConflictResolutionFilter
}

export const getNormalizedComparisonProjectConflictResolutionFilters = (
  value: unknown,
): ComparisonProjectConflictResolutionFilter[] => {
  return getComparisonProjectFilterSelectionValues(value)
}

export const getComparisonProjectConflictResolutionFilterLabel = (
  conflictResolutionFilter: ComparisonProjectConflictResolutionFilter,
) => {
  return conflictResolutionFilter === 'all'
    ? 'All'
    : conflictResolutionFilter === 'not-set'
      ? 'Not set'
      : conflictResolutionFilter
}

export const getComparisonProjectConflictResolutionFilterOptions = (
  resolutionOptions: readonly {label: string; value: string}[],
): ComparisonProjectConflictResolutionFilterOption[] => {
  return [
    {label: 'Not set', value: 'not-set'},
    ...resolutionOptions.map((option) => {
      return {label: option.label, value: option.value}
    }),
  ]
}

const getComparisonProjectPromptTypeOptions = (type: string | null) => {
  const matches = type?.match(/['"]([^'"]+)['"]/g) ?? []

  return matches.map((match) => {
    return match.slice(1, -1)
  })
}

export const getComparisonProjectSummaryConflictResolutionOptions = (
  prompts: readonly ComparisonProjectPromptWithType[],
) => {
  return Array.from(
    prompts
      .flatMap((prompt) => {
        return getComparisonProjectPromptTypeOptions(prompt.type).map((option) => {
          return {label: option, value: option}
        })
      })
      .reduce<Map<string, {label: string; value: string}>>((optionMap, option) => {
        if (!optionMap.has(option.value)) {
          optionMap.set(option.value, option)
        }

        return optionMap
      }, new Map<string, {label: string; value: string}>())
      .values(),
  )
}

export const getNormalizedComparisonProjectConflictResolutionProvenanceFilters = (
  value: unknown,
): ComparisonProjectConflictResolutionProvenanceFilter[] => {
  return getComparisonProjectCanonicalFilterSelection(value, comparisonProjectConflictResolutionProvenanceFilters)
}

export const getComparisonProjectConflictResolutionProvenanceFilterOptions =
  (): ComparisonProjectConflictResolutionProvenanceFilterOption[] => {
    return comparisonProjectConflictResolutionProvenanceFilters.map((value) => {
      return {label: comparisonProjectConflictResolutionProvenanceFilterLabels[value], value}
    })
  }
