export type ComparisonProjectConflictResolutionFilter = string

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
    {label: 'All', value: 'all'},
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
