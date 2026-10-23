import {
  getIsComparisonProjectStatsHumanComparison,
  getIsComparisonProjectStatsNoFallbackConflictResolutionComparison,
} from './comparisonProjectStatsComparisonKind.ts'
import {
  getComparisonProjectStatsColumnLabel,
  getComparisonProjectStatsContentLabel,
  getComparisonProjectStatsHumanComparisonColumnInfo,
} from './comparisonProjectStatsLabels.ts'
import type {
  ComparisonProjectStatsColumn,
  ComparisonProjectStatsComparisonGroup,
  ComparisonProjectStatsComparisonKind,
  ComparisonProjectStatsLabelContext,
} from './comparisonProjectStatsTypes.ts'

const getComparisonProjectStatsGroupLabel = (
  kind: ComparisonProjectStatsComparisonKind,
  leftColumn: ComparisonProjectStatsColumn,
  rightColumn: ComparisonProjectStatsColumn,
  context: ComparisonProjectStatsLabelContext,
) => {
  const leftColumnLabel = getComparisonProjectStatsColumnLabel(leftColumn, context)
  const rightColumnLabel = getComparisonProjectStatsColumnLabel(rightColumn, context)

  if (kind === 'llm-vs-conflict-resolution') {
    return `${rightColumnLabel} vs Conflict resolution (fallback to human answer if no resolution provided)`
  }

  if (getIsComparisonProjectStatsNoFallbackConflictResolutionComparison(kind)) {
    return `${rightColumnLabel} vs Conflict resolution (no fallback)`
  }

  return getIsComparisonProjectStatsHumanComparison(kind)
    ? `${rightColumnLabel} vs ${leftColumnLabel}`
    : `${leftColumnLabel} vs ${rightColumnLabel}`
}

const getComparisonProjectStatsLlmVsLlmColumnInfo = (leftColumnInfo: string | null, rightColumnInfo: string | null) => {
  if (leftColumnInfo && rightColumnInfo && leftColumnInfo !== rightColumnInfo) {
    return `${leftColumnInfo} vs ${rightColumnInfo}`
  }

  return leftColumnInfo ?? rightColumnInfo
}

const getComparisonProjectStatsGroupColumnInfo = (
  kind: ComparisonProjectStatsComparisonKind,
  leftColumn: ComparisonProjectStatsColumn,
  rightColumn: ComparisonProjectStatsColumn,
) => {
  const leftColumnInfo = getComparisonProjectStatsContentLabel(leftColumn)
  const rightColumnInfo = getComparisonProjectStatsContentLabel(rightColumn)

  return getIsComparisonProjectStatsHumanComparison(kind)
    ? getComparisonProjectStatsHumanComparisonColumnInfo(leftColumnInfo, rightColumnInfo)
    : getComparisonProjectStatsLlmVsLlmColumnInfo(leftColumnInfo, rightColumnInfo)
}

export const getComparisonProjectStatsGroup = (
  kind: ComparisonProjectStatsComparisonKind,
  leftColumn: ComparisonProjectStatsColumn,
  rightColumn: ComparisonProjectStatsColumn,
  context: ComparisonProjectStatsLabelContext,
): ComparisonProjectStatsComparisonGroup => {
  return {
    columnInfo: getComparisonProjectStatsGroupColumnInfo(kind, leftColumn, rightColumn),
    id: `${kind}:${leftColumn.id}:${rightColumn.id}`,
    kind,
    label: getComparisonProjectStatsGroupLabel(kind, leftColumn, rightColumn, context),
    leftColumnId: leftColumn.id,
    rightColumnId: rightColumn.id,
  }
}
