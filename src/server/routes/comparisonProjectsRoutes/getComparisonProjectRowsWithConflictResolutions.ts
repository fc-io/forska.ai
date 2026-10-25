import {getDateValue, getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {
  type ComparisonProjectConflictComment,
  type ComparisonProjectConflictCommentReadRow,
  getComparisonProjectConflictCommentReadRowsSql,
  getComparisonProjectConflictCommentsByArticleId,
} from './comparisonProjectConflictComment.ts'
import {getComparisonProjectConflictResolutionOptionByValue} from './comparisonProjectConflictResolutionOptions.ts'
import {
  type ComparisonProjectConflictResolutionProvenanceRow,
  getComparisonProjectConflictResolutionProvenance,
  getComparisonProjectConflictResolutionProvenanceMatchesCurrent,
  getComparisonProjectConflictResolutionReviewer,
} from './comparisonProjectConflictResolutionProvenance.ts'
import type {ComparisonProjectJudgmentRow} from './comparisonProjectJudgmentRows/comparisonProjectJudgmentRowsTypes.ts'
import {comparisonProjectConflictResolutionTable} from './comparisonProjectRouteConstants.ts'
import {appDatabaseService} from './comparisonProjectRouteServices.ts'
import type {ComparisonProjectConflictResolution} from './comparisonProjectRouteTypes.ts'
import type {ComparisonProjectScope} from './comparisonProjectScopeTypes.ts'
import {getInClause} from './comparisonProjectSqlClauses.ts'
import {getIsSummaryMode} from './getIsSummaryMode.ts'

type ComparisonProjectConflictResolutionReadRow = ComparisonProjectConflictResolutionProvenanceRow & {
  answerValue: string | null
  articleId: string
  promptId: string | null
}

const getComparisonProjectConflictResolutionReadRowsSql = (comparisonProjectId: string, articleIds: string[]) => {
  return `
    SELECT
      cr.article_id AS articleId,
      cr.prompt_id AS promptId,
      cr.answer_value AS answerValue,
      cr.reviewer_user_id AS reviewerUserId,
      COALESCE(NULLIF(TRIM(cr.reviewer_display_name), ''), NULLIF(TRIM(reviewer.name), '')) AS reviewerDisplayName,
      cr.judgment_context_id AS judgmentContextId,
      cr.serving_generation AS servingGeneration,
      cr.origin AS origin,
      cr.updated_at AS setAt
    FROM ${comparisonProjectConflictResolutionTable} cr
    LEFT JOIN app.user_config reviewer ON reviewer.id = cr.reviewer_user_id
    WHERE cr.comparison_project_id = ${getSqlLiteral(comparisonProjectId)}
      AND cr.article_id IN (${getInClause(articleIds)})
  `
}

const getComparisonProjectConflictResolutionsByArticleId = (
  scope: ComparisonProjectScope,
  resolutionRows: readonly ComparisonProjectConflictResolutionReadRow[],
) => {
  const optionByValue = getComparisonProjectConflictResolutionOptionByValue(scope)

  return resolutionRows.reduce<Map<string, ComparisonProjectConflictResolution>>((resolutionMap, row) => {
    const value = getIsSummaryMode(scope) ? row.answerValue : row.promptId
    const option = value ? optionByValue.get(value) : null

    if (!option) {
      return resolutionMap
    }

    resolutionMap.set(row.articleId, {
      articleId: row.articleId,
      label: option.label,
      provenance: getComparisonProjectConflictResolutionProvenance(row),
      provenanceMatchesCurrent: getComparisonProjectConflictResolutionProvenanceMatchesCurrent(
        row.judgmentContextId,
        scope.judgmentContextId,
      ),
      reviewer: getComparisonProjectConflictResolutionReviewer(row),
      reviewerDisplayName: row.reviewerDisplayName ?? null,
      reviewerUserId: row.reviewerUserId ?? null,
      setAt: getDateValue(row.setAt),
      value: option.value,
    })
    return resolutionMap
  }, new Map<string, ComparisonProjectConflictResolution>())
}

const getComparisonProjectRowArticleIds = (rows: readonly ComparisonProjectJudgmentRow[]) => {
  return rows.map((row) => {
    return row.canonicalArticleId
  })
}

const getComparisonProjectConflictResolutions = async (scope: ComparisonProjectScope, articleIds: string[]) => {
  if (!scope.allowConflictResolution || articleIds.length === 0) {
    return new Map<string, ComparisonProjectConflictResolution>()
  }

  const resolutionRows = await appDatabaseService.queryJson<ComparisonProjectConflictResolutionReadRow>(
    getComparisonProjectConflictResolutionReadRowsSql(scope.id, articleIds),
  )

  return getComparisonProjectConflictResolutionsByArticleId(scope, resolutionRows)
}

const getComparisonProjectConflictComments = async (scope: ComparisonProjectScope, articleIds: string[]) => {
  if (!scope.allowConflictResolution || articleIds.length === 0) {
    return new Map<string, ComparisonProjectConflictComment>()
  }

  const commentRows = await appDatabaseService.queryJson<ComparisonProjectConflictCommentReadRow>(
    getComparisonProjectConflictCommentReadRowsSql(scope.id, articleIds),
  )

  return getComparisonProjectConflictCommentsByArticleId(commentRows)
}

export const getComparisonProjectRowsWithConflictResolutions = async (
  scope: ComparisonProjectScope,
  rows: ComparisonProjectJudgmentRow[],
) => {
  const articleIds = getComparisonProjectRowArticleIds(rows)
  const [conflictResolutions, conflictComments] = await Promise.all([
    getComparisonProjectConflictResolutions(scope, articleIds),
    getComparisonProjectConflictComments(scope, articleIds),
  ])

  return rows.map((row) => {
    return {
      ...row,
      conflictComment: conflictComments.get(row.canonicalArticleId) ?? null,
      conflictResolution: conflictResolutions.get(row.canonicalArticleId) ?? null,
    }
  })
}
