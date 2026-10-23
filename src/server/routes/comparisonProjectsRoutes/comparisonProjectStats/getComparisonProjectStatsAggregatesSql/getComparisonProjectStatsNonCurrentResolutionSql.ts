import {getSqlLiteral} from '../../../../services/appQueryHelpers.ts'
import {getComparisonProjectStatsCurrentJudgmentContextId} from '../comparisonProjectStatsConflictResolutionProvenanceSql.ts'
import {comparisonProjectConflictResolutionTable} from '../comparisonProjectStatsSql.ts'
import type {ComparisonProjectStatsConflictResolutionProvenanceParams} from '../comparisonProjectStatsTypes.ts'

const comparisonProjectStatsConflictResolutionKindsSql =
  "'llm-vs-conflict-resolution', 'llm-vs-conflict-resolution-no-fallback', 'human-vs-conflict-resolution'"

export const getComparisonProjectStatsNonCurrentResolutionCteSql = (
  params: ComparisonProjectStatsConflictResolutionProvenanceParams & {comparisonProjectId: string},
) => {
  const currentJudgmentContextId = getComparisonProjectStatsCurrentJudgmentContextId(params)

  return currentJudgmentContextId === null
    ? ''
    : `
    non_current_conflict_resolution_article AS (
      SELECT DISTINCT article_id
      FROM ${comparisonProjectConflictResolutionTable}
      WHERE comparison_project_id = ${getSqlLiteral(params.comparisonProjectId)}
        AND answer_value IS NOT NULL
        AND NULLIF(TRIM(answer_value), '') IS NOT NULL
        AND (judgment_context_id IS NULL OR judgment_context_id <> ${getSqlLiteral(currentJudgmentContextId)})
    ),`
}

export const getComparisonProjectStatsNonCurrentResolutionPairFilterSql = (
  params: ComparisonProjectStatsConflictResolutionProvenanceParams,
) => {
  return getComparisonProjectStatsCurrentJudgmentContextId(params) === null
    ? ''
    : `WHERE comparison_group.comparison_kind NOT IN (${comparisonProjectStatsConflictResolutionKindsSql})
        OR left_cell.article_id NOT IN (SELECT article_id FROM non_current_conflict_resolution_article)`
}
