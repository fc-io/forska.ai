import type {ProjectTransferApiResponse} from '../../services/projectTransfer/projectTransferContracts.ts'
import {
  resolveProjectTransferDependencies,
  writeProjectTransferDependencyPlan,
} from '../../services/projectTransfer/projectTransferDependencyResolution.ts'
import {
  getProjectTransferPerformanceMetrics,
  measureProjectTransferPhase,
  projectTransferMetricUnavailable,
} from '../../services/projectTransfer/projectTransferPerformanceMetrics.ts'
import {getProjectTransferCompletedOverallProgress} from '../../services/projectTransfer/projectTransferProgressWeights.ts'
import {
  getProjectTransferImportTempLayout,
  toProjectTransferSessionResponse,
} from '../../services/projectTransfer/projectTransferSession.ts'
import {getProjectTransferSessionRepository} from '../../services/projectTransfer/projectTransferSessionRepository.ts'
import {
  getProjectTransferCurrentImportStagingLayout,
  getProjectTransferProgressStagingRevision,
} from '../../services/projectTransfer/projectTransferStaging.ts'
import {failImportSessionForUnavailableArtifacts} from './failImportSessionForUnavailableArtifacts.ts'
import {getImportAnalyzeNextState} from './getImportAnalyzeNextState.ts'
import {getImportSessionResponseFromRecord} from './getImportSessionResponseFromRecord.ts'
import {getMergedImportPerformanceMetrics} from './getMergedImportPerformanceMetrics.ts'
import {getProjectTransferApiError} from './getProjectTransferApiError.ts'
import {getDependencyResolutionOverallProgress} from './projectTransferRoutesPostImportResolveDependencies/getDependencyResolutionOverallProgress.ts'
import {getImportRuntimePhaseProgress} from './projectTransferRoutesPostImportResolveDependencies/getImportRuntimePhaseProgress.ts'
import {parseResolveDependenciesRequest} from './projectTransferRoutesPostImportResolveDependencies/parseResolveDependenciesRequest.ts'
import type {ProjectTransferImportSessionData, RouteSet} from './projectTransferRouteTypes.ts'
import {readImportPlanArtifact} from './readImportPlanArtifact.ts'
import {validateCurrentImportPlanArtifact} from './validateCurrentImportPlanArtifact.ts'
import {writeImportProgressArtifact} from './writeImportProgressArtifact.ts'

const getImportArtifactsUnavailableError = (error: string) => {
  return (
    error === 'Project transfer dependency payloads are unavailable'
    || error === 'Project transfer import plan artifact is unavailable'
  )
}

export const resolveImportDependencies = async (
  set: RouteSet,
  sessionId: string,
  body: unknown,
): Promise<ProjectTransferApiResponse<ProjectTransferImportSessionData>> => {
  const request = parseResolveDependenciesRequest(body)

  if (!request.ok) {
    return getProjectTransferApiError(set, 400, request.error)
  }

  const record = await getProjectTransferSessionRepository().getProjectTransferSession({sessionId})
  const response = await getImportSessionResponseFromRecord(set, record)

  if (response === null) {
    return getProjectTransferApiError(set, 404, 'Project transfer import session not found')
  }

  if (response.error !== null) {
    return response
  }

  if (response.data.planRevision !== request.value.planRevision) {
    return {data: {...response.data, stalePlan: true}, error: null}
  }

  if (response.data.state !== 'awaiting_resolution' && response.data.state !== 'ready_to_commit') {
    return getProjectTransferApiError(set, 409, 'Project transfer import session is not awaiting dependency resolution')
  }

  const layout = getProjectTransferCurrentImportStagingLayout({
    layout: getProjectTransferImportTempLayout(sessionId),
    progress: response.data.progress,
  })
  const plan = await readImportPlanArtifact(response.data)

  if (plan === null) {
    return failImportSessionForUnavailableArtifacts({record, set})
  }

  const planValidation = validateCurrentImportPlanArtifact(response.data, plan)

  if (!planValidation.ok) {
    return getProjectTransferApiError(set, 409, planValidation.error)
  }

  const resolvingAt = new Date()
  const resolvingProgress = getImportRuntimePhaseProgress({
    message: 'Resolving import dependencies',
    now: resolvingAt,
    overall: getDependencyResolutionOverallProgress(response.data.progress, 0),
    phase: 'dependency_resolution',
    previousProgress: response.data.progress,
    status: 'running',
  })
  const progressStarted = await getProjectTransferSessionRepository().updateProjectTransferSessionProgress({
    now: resolvingAt,
    progress: resolvingProgress,
    sessionId,
  })

  if (progressStarted === null) {
    return getProjectTransferApiError(
      set,
      409,
      'Project transfer import dependency resolution could not update progress',
    )
  }

  const dependencyResolutionMeasurement = await measureProjectTransferPhase('dependencyResolution', () => {
    return resolveProjectTransferDependencies({
      deferPlanWrite: true,
      layout,
      nextPlanRevision: response.data.planRevision + 1,
      plan,
      request: request.value,
    })
  })
  const result = dependencyResolutionMeasurement.value

  if (result.status === 'error') {
    if (getImportArtifactsUnavailableError(result.error)) {
      return failImportSessionForUnavailableArtifacts({record, set})
    }

    return getProjectTransferApiError(set, result.statusCode, result.error)
  }

  if (!result.changed) {
    return response
  }

  const dependencyPerformanceMetrics = getMergedImportPerformanceMetrics(
    response.data.progress?.performanceMetrics,
    getProjectTransferPerformanceMetrics({
      benchmark: {
        dependencyExecutionSignature: result.plan.dependencyResolution ?? projectTransferMetricUnavailable,
        warningDetails: [],
        wallTimeMs: dependencyResolutionMeasurement.timing.durationMs,
      },
      operation: 'import',
      phases: {dependencyResolution: dependencyResolutionMeasurement.timing},
      rows: response.data.progress?.performanceMetrics?.rows,
      warnings: result.planSummary.packageWarnings ?? [],
    }),
  )
  const updated = await getProjectTransferSessionRepository().updateProjectTransferSessionPlanRevision({
    expectedPlanRevision: response.data.planRevision,
    expectedStagingRevision: getProjectTransferProgressStagingRevision(response.data.progress),
    nextState: getImportAnalyzeNextState(result.planSummary),
    now: new Date(),
    planSummary: result.planSummary,
    progress: {
      ...getImportRuntimePhaseProgress({
        message: 'Persisting resolved dependency plan',
        now: new Date(),
        overall: getDependencyResolutionOverallProgress(resolvingProgress, 1),
        phase: 'dependency_resolution',
        previousProgress: resolvingProgress,
        status: 'running',
        warningCount: result.planSummary.warningCount,
      }),
      performanceMetrics: dependencyPerformanceMetrics,
    },
    sessionId,
  })

  if (updated === null) {
    return getProjectTransferApiError(
      set,
      409,
      'Project transfer import dependency resolution could not update the plan',
    )
  }

  await writeProjectTransferDependencyPlan({layout, plan: result.plan})
  const completedProgress = getImportRuntimePhaseProgress({
    message: 'Dependency resolution completed',
    now: new Date(),
    overall: getProjectTransferCompletedOverallProgress('analyze'),
    phase: 'dependency_resolution',
    previousProgress: toProjectTransferSessionResponse(updated).progress,
    status: 'completed',
    warningCount: result.planSummary.warningCount,
  })
  const completed = await getProjectTransferSessionRepository().transitionProjectTransferSessionState({
    expectedOwnerToken: updated.ownerToken,
    expectedPlanRevision: updated.planRevision,
    expectedState: updated.state,
    nextState: updated.state,
    progress: completedProgress,
    sessionId,
  })
  if (completed === null)
    return getProjectTransferApiError(
      set,
      409,
      'Project transfer import dependency resolution could not complete progress',
    )
  await writeImportProgressArtifact(sessionId, completedProgress)

  return (
    (await getImportSessionResponseFromRecord(set, completed))
    ?? getProjectTransferApiError(set, 500, 'Import session unavailable')
  )
}
