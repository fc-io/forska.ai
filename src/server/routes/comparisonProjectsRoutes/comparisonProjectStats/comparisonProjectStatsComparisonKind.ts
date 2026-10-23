import type {ComparisonProjectStatsComparisonKind} from './comparisonProjectStatsTypes.ts'

export const getIsComparisonProjectStatsNoFallbackConflictResolutionComparison = (
  kind: ComparisonProjectStatsComparisonKind,
) => {
  return kind === 'llm-vs-conflict-resolution-no-fallback' || kind === 'human-vs-conflict-resolution'
}

export const getIsComparisonProjectStatsHumanComparison = (kind: ComparisonProjectStatsComparisonKind) => {
  return (
    kind === 'primary-vs-human'
    || kind === 'human-vs-llm'
    || kind === 'llm-vs-conflict-resolution'
    || getIsComparisonProjectStatsNoFallbackConflictResolutionComparison(kind)
  )
}
