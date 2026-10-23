import {Elysia, t} from 'elysia'

import {getUserConfigQueryService} from '../../services/userConfigQueryService.ts'
import {getMaintenanceDuckdbWorkloadContext} from '../../utils/duckdbService.ts'
import {HttpError} from '../../utils/httpError.ts'
import {
  getValidatedComparisonProjectConflictComment,
  replaceComparisonProjectConflictComment,
} from './comparisonProjectConflictComment.ts'
import {
  getComparisonProjectConflictResolutionScopedTargetRow,
  getComparisonProjectConflictResolutionServingTargetRow,
} from './comparisonProjectConflictResolutionTargetRows.ts'
import {scheduleComparisonProjectConflictResolutionCheckpoint} from './comparisonProjectMutationCheckpoint.ts'
import {appDatabaseService} from './comparisonProjectRouteServices.ts'
import type {ComparisonProjectScope} from './comparisonProjectScopeTypes.ts'
import {getComparisonProjectScope} from './getComparisonProjectScope.ts'
import {getIsSummaryMode} from './getIsSummaryMode.ts'

const getComparisonProjectConflictCommentTargetRow = async (scope: ComparisonProjectScope, articleId: string) => {
  if (!scope.allowConflictResolution) {
    throw new HttpError(400, 'Conflict resolution is not enabled for this comparison project')
  }

  const targetRow =
    scope.activeGeneration === null
      ? await getComparisonProjectConflictResolutionScopedTargetRow(scope, articleId)
      : await getComparisonProjectConflictResolutionServingTargetRow(scope, articleId)

  if (!targetRow) {
    throw new HttpError(400, 'Conflict comments are only available for articles in this comparison project')
  }

  return targetRow
}

const setComparisonProjectConflictComment = async (params: {
  articleId: string
  comment: string | null
  scope: ComparisonProjectScope
}) => {
  const comment = getValidatedComparisonProjectConflictComment(params.comment)

  await getComparisonProjectConflictCommentTargetRow(params.scope, params.articleId)

  const author = comment === null ? null : await getUserConfigQueryService().getOrCreateUserConfig()
  const conflictComment = await appDatabaseService.transaction(async (tx) => {
    return replaceComparisonProjectConflictComment({
      articleId: params.articleId,
      author,
      comment,
      comparisonProjectId: params.scope.id,
      tx,
    })
  }, getMaintenanceDuckdbWorkloadContext('comparisonProjectConflictComment.save'))

  return {articleId: params.articleId, conflictComment}
}

export const comparisonProjectsRoutesPostConflictComment = new Elysia().post(
  '/api/comparison-projects/:id/conflict-comment',
  async (context) => {
    const {params, body, set} = context
    const scope = await getComparisonProjectScope(params.id)

    if (!scope) {
      set.status = 404
      return {data: null, error: 'Comparison project not found'}
    }

    const data = await setComparisonProjectConflictComment({articleId: body.articleId, comment: body.comment, scope})
    scheduleComparisonProjectConflictResolutionCheckpoint({
      activeGeneration: scope.activeGeneration,
      articleId: body.articleId,
      comparisonProjectId: scope.id,
      isSummaryMode: getIsSummaryMode(scope),
      requestedValue: 'comment',
    })

    return {data}
  },
  {body: t.Object({articleId: t.String(), comment: t.Union([t.String(), t.Null()])})},
)
