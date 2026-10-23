import {Elysia, t} from 'elysia'

import {getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {getComparisonProjectConflictResolutionTargetRow} from './comparisonProjectConflictResolutionTargetRows.ts'
import {scheduleComparisonProjectConflictResolutionCheckpoint} from './comparisonProjectMutationCheckpoint.ts'
import {comparisonProjectConflictResolutionTable} from './comparisonProjectRouteConstants.ts'
import {appDatabaseService} from './comparisonProjectRouteServices.ts'
import type {ComparisonProjectScope} from './comparisonProjectScopeTypes.ts'
import {getComparisonProjectScope} from './getComparisonProjectScope.ts'

const resetComparisonProjectConflictResolution = async (params: {articleId: string; scope: ComparisonProjectScope}) => {
  await getComparisonProjectConflictResolutionTargetRow(params.scope, params.articleId)

  await appDatabaseService.run(`
    DELETE FROM ${comparisonProjectConflictResolutionTable}
    WHERE comparison_project_id = ${getSqlLiteral(params.scope.id)}
      AND article_id = ${getSqlLiteral(params.articleId)}
  `)

  return {articleId: params.articleId}
}

export const comparisonProjectsRoutesPostConflictResolutionReset = new Elysia().post(
  '/api/comparison-projects/:id/conflict-resolution/reset',
  async (context) => {
    const {params, body, set} = context
    const scope = await getComparisonProjectScope(params.id)

    if (!scope) {
      set.status = 404
      return {data: null, error: 'Comparison project not found'}
    }

    const data = await resetComparisonProjectConflictResolution({articleId: body.articleId, scope})
    scheduleComparisonProjectConflictResolutionCheckpoint()

    return {data}
  },
  {body: t.Object({articleId: t.String()})},
)
