import {getSqlLiteral} from '../../services/appQueryHelpers.ts'
import type {
  ComparisonProjectConflictResolutionImportSourceRow,
  ComparisonProjectConflictResolutionImportTargetArticle,
} from './comparisonProjectConflictResolutionImport/comparisonProjectConflictResolutionImportTypes.ts'
import {comparisonProjectConflictResolutionTable} from './comparisonProjectRouteConstants.ts'
import type {AppQueryRunner} from './comparisonProjectRouteTypes.ts'
import type {ComparisonProjectScope} from './comparisonProjectScopeTypes.ts'
import {getInClause} from './comparisonProjectSqlClauses.ts'
import {getUniqueStringValues} from './comparisonProjectValueHelpers.ts'
import {getComparisonProjectRowsForArticles} from './getComparisonProjectRowsForArticles.ts'
import {getConflictResolutionImportCandidateTargetRows} from './getConflictResolutionImportTargetArticles/getConflictResolutionImportCandidateTargetRows.ts'

const getConflictResolutionImportExistingTargetResolutionValues = async (params: {
  articleIds: string[]
  comparisonProjectId: string
  tx: AppQueryRunner
}) => {
  if (params.articleIds.length === 0) {
    return new Map<string, string | null>()
  }

  const rows = await params.tx.queryJson<{articleId: string; answerValue: string | null; promptId: string | null}>(`
    SELECT
      article_id AS articleId,
      answer_value AS answerValue,
      prompt_id AS promptId
    FROM ${comparisonProjectConflictResolutionTable}
    WHERE comparison_project_id = ${getSqlLiteral(params.comparisonProjectId)}
      AND article_id IN (${getInClause(params.articleIds)})
  `)

  return rows.reduce<Map<string, string | null>>((resolutionValues, row) => {
    return resolutionValues.set(row.articleId, row.answerValue ?? row.promptId ?? null)
  }, new Map<string, string | null>())
}

export const getConflictResolutionImportTargetArticles = async (params: {
  sourceRows: readonly ComparisonProjectConflictResolutionImportSourceRow[]
  scope: ComparisonProjectScope
  tx: AppQueryRunner
}): Promise<ComparisonProjectConflictResolutionImportTargetArticle[]> => {
  const candidateRows = await getConflictResolutionImportCandidateTargetRows({
    sourceRows: params.sourceRows,
    scope: params.scope,
    tx: params.tx,
  })
  const articleIds = getUniqueStringValues(
    candidateRows.map((row) => {
      return row.articleId
    }),
  )
  const conflictingArticleRows = await getComparisonProjectRowsForArticles(params.scope, articleIds, params.tx)
  const conflictingArticleIds = new Set(
    conflictingArticleRows
      .filter((row) => {
        return row.hasConflict
      })
      .map((row) => {
        return row.canonicalArticleId
      }),
  )
  const existingTargetResolutionValues = await getConflictResolutionImportExistingTargetResolutionValues({
    articleIds,
    comparisonProjectId: params.scope.id,
    tx: params.tx,
  })

  return candidateRows.map((row) => {
    return {
      ...row,
      existingResolutionValue: existingTargetResolutionValues.get(row.articleId) ?? null,
      hasExistingResolution: existingTargetResolutionValues.has(row.articleId),
      isConflictResolutionEligible: conflictingArticleIds.has(row.articleId),
    }
  })
}
