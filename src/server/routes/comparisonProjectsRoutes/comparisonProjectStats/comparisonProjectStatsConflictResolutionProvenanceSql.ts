import {getSqlLiteral} from '../../../services/appQueryHelpers.ts'
import type {ComparisonProjectStatsConflictResolutionProvenanceParams} from './comparisonProjectStatsTypes.ts'

export const getComparisonProjectStatsCurrentJudgmentContextId = (
  params: ComparisonProjectStatsConflictResolutionProvenanceParams,
) => {
  return params.conflictResolutionProvenance === 'current' ? (params.currentJudgmentContextId ?? null) : null
}

export const getComparisonProjectStatsConflictResolutionProvenanceSql = (
  params: ComparisonProjectStatsConflictResolutionProvenanceParams,
) => {
  const currentJudgmentContextId = getComparisonProjectStatsCurrentJudgmentContextId(params)

  return currentJudgmentContextId === null ? '' : `AND judgment_context_id = ${getSqlLiteral(currentJudgmentContextId)}`
}
