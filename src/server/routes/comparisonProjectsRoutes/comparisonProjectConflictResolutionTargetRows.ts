import {getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {getMaintenanceDuckdbWorkloadContext} from '../../utils/duckdbService.ts'
import {HttpError} from '../../utils/httpError.ts'
import {comparisonProjectConflictResolutionTable} from './comparisonProjectRouteConstants.ts'
import {appDatabaseService} from './comparisonProjectRouteServices.ts'
import type {ComparisonProjectConflictResolutionTargetRow} from './comparisonProjectRouteTypes.ts'
import type {ComparisonProjectScope} from './comparisonProjectScopeTypes.ts'
import {getComparisonProjectRowsForArticles} from './getComparisonProjectRowsForArticles.ts'

const getHasStoredComparisonProjectConflictResolution = async (comparisonProjectId: string, articleId: string) => {
  const rows = await appDatabaseService.queryJson<{articleId: string}>(
    `
    SELECT article_id AS articleId
    FROM ${comparisonProjectConflictResolutionTable}
    WHERE comparison_project_id = ${getSqlLiteral(comparisonProjectId)}
      AND article_id = ${getSqlLiteral(articleId)}
    LIMIT 1
  `,
    getMaintenanceDuckdbWorkloadContext('comparisonProjectConflictResolution.targetValidation'),
  )

  return rows.length > 0
}

const getEditableComparisonProjectConflictResolutionTargetRow = async (params: {
  articleId: string
  scope: ComparisonProjectScope
  targetRow: ComparisonProjectConflictResolutionTargetRow | null
}): Promise<ComparisonProjectConflictResolutionTargetRow> => {
  const isEditable =
    params.targetRow !== null
    && (params.targetRow.hasConflict
      || (await getHasStoredComparisonProjectConflictResolution(params.scope.id, params.articleId)))

  if (!params.targetRow || !isEditable) {
    throw new HttpError(400, 'Conflict resolution is only available for conflicting articles')
  }

  return params.targetRow
}

export const getComparisonProjectConflictResolutionServingTargetRow = async (
  scope: ComparisonProjectScope,
  articleId: string,
) => {
  const [servingRow] = await appDatabaseService.queryJson<ComparisonProjectConflictResolutionTargetRow>(
    `
    SELECT
      article_category AS articleCategory,
      has_conflict AS hasConflict
    FROM mart.comparison_article_serving
    WHERE comparison_project_id = ${getSqlLiteral(scope.id)}
      AND generation = ${getSqlLiteral(scope.activeGeneration)}
      AND article_id = ${getSqlLiteral(articleId)}
    LIMIT 1
  `,
    getMaintenanceDuckdbWorkloadContext('comparisonProjectConflictResolution.targetValidation'),
  )

  return servingRow ?? null
}

export const getComparisonProjectConflictResolutionScopedTargetRow = async (
  scope: ComparisonProjectScope,
  articleId: string,
) => {
  const [row] = await getComparisonProjectRowsForArticles(scope, [articleId])

  return row ? {articleCategory: null, hasConflict: row.hasConflict} : null
}

export const getComparisonProjectConflictResolutionTargetRow = async (
  scope: ComparisonProjectScope,
  articleId: string,
): Promise<ComparisonProjectConflictResolutionTargetRow> => {
  if (!scope.allowConflictResolution) {
    throw new HttpError(400, 'Conflict resolution is not enabled for this comparison project')
  }

  const targetRow =
    scope.activeGeneration === null
      ? await getComparisonProjectConflictResolutionScopedTargetRow(scope, articleId)
      : await getComparisonProjectConflictResolutionServingTargetRow(scope, articleId)

  return getEditableComparisonProjectConflictResolutionTargetRow({articleId, scope, targetRow})
}
