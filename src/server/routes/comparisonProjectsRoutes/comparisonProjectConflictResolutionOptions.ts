import type {ComparisonProjectConflictResolutionOption} from './comparisonProjectRouteTypes.ts'
import type {ComparisonProjectScope} from './comparisonProjectScopeTypes.ts'
import {getIsSummaryMode} from './getIsSummaryMode.ts'

export const getComparisonProjectPromptTypeOptions = (type: string | null) => {
  const matches = type?.match(/['"]([^'"]+)['"]/g) ?? []

  return matches.map((match) => {
    return match.slice(1, -1)
  })
}

const getUniqueComparisonProjectConflictResolutionOptions = (options: ComparisonProjectConflictResolutionOption[]) => {
  return Array.from(
    options
      .reduce<Map<string, ComparisonProjectConflictResolutionOption>>((optionMap, option) => {
        if (!optionMap.has(option.value)) {
          optionMap.set(option.value, option)
        }

        return optionMap
      }, new Map<string, ComparisonProjectConflictResolutionOption>())
      .values(),
  )
}

const getComparisonProjectPromptResolutionOptions = (scope: ComparisonProjectScope) => {
  return scope.prompts.map<ComparisonProjectConflictResolutionOption>((prompt) => {
    return {label: prompt.promptLabel, value: prompt.id}
  })
}

const getComparisonProjectSummaryAnswerResolutionOptions = (scope: ComparisonProjectScope) => {
  return getUniqueComparisonProjectConflictResolutionOptions(
    scope.prompts.flatMap((prompt) => {
      return getComparisonProjectPromptTypeOptions(prompt.type).map<ComparisonProjectConflictResolutionOption>(
        (option) => {
          return {label: option, value: option}
        },
      )
    }),
  )
}

export const getComparisonProjectConflictResolutionOptions = (scope: ComparisonProjectScope) => {
  return getIsSummaryMode(scope)
    ? getComparisonProjectSummaryAnswerResolutionOptions(scope)
    : getComparisonProjectPromptResolutionOptions(scope)
}

export const getComparisonProjectConflictResolutionOptionByValue = (scope: ComparisonProjectScope) => {
  return getComparisonProjectConflictResolutionOptions(scope).reduce<
    Map<string, ComparisonProjectConflictResolutionOption>
  >((optionMap, option) => {
    optionMap.set(option.value, option)
    return optionMap
  }, new Map<string, ComparisonProjectConflictResolutionOption>())
}
