import {Elysia, t} from 'elysia'

import {logConflictResolutionSavePhase} from './comparisonProjectConflictResolutionSaveDiagnostics.ts'
import {scheduleComparisonProjectConflictResolutionCheckpoint} from './comparisonProjectMutationCheckpoint.ts'
import {setComparisonProjectConflictResolution} from './comparisonProjectsRoutesPostConflictResolution/setComparisonProjectConflictResolution.ts'
import {getComparisonProjectScope} from './getComparisonProjectScope.ts'
import {getIsSummaryMode} from './getIsSummaryMode.ts'

export const comparisonProjectsRoutesPostConflictResolution = new Elysia().post(
  '/api/comparison-projects/:id/conflict-resolution',
  async (context) => {
    const {params, body, set} = context
    const scope = await getComparisonProjectScope(params.id)

    if (!scope) {
      set.status = 404
      return {data: null, error: 'Comparison project not found'}
    }

    const checkpointDiagnostic = {
      activeGeneration: scope.activeGeneration,
      articleId: body.articleId,
      comparisonProjectId: scope.id,
      isSummaryMode: getIsSummaryMode(scope),
      requestedValue: body.value,
    }
    const data = await setComparisonProjectConflictResolution({articleId: body.articleId, value: body.value, scope})
    scheduleComparisonProjectConflictResolutionCheckpoint(checkpointDiagnostic)
    logConflictResolutionSavePhase('deferred-checkpoint:scheduled', checkpointDiagnostic)

    return {data}
  },
  {body: t.Object({articleId: t.String(), value: t.String()})},
)
