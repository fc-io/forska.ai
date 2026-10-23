import {isProjectTransferFailedCommitRetryCandidate} from '../../services/projectTransfer/projectTransferCommit.ts'
import type {
  ProjectTransferApiResponse,
  ProjectTransferExecutionMode,
  ProjectTransferSessionResponse,
} from '../../services/projectTransfer/projectTransferContracts.ts'
import {resolveProjectTransferTempWritablePath} from '../../services/projectTransfer/projectTransferPaths.ts'
import {
  getProjectTransferImportTempLayout,
  toProjectTransferSessionResponse,
} from '../../services/projectTransfer/projectTransferSession.ts'
import {getProjectTransferSessionRepository} from '../../services/projectTransfer/projectTransferSessionRepository.ts'
import {getProjectTransferCurrentImportStagingLayout} from '../../services/projectTransfer/projectTransferStaging.ts'
import {getImportSessionData} from './getImportSessionData.ts'
import {getProjectTransferApiError} from './getProjectTransferApiError.ts'
import {hasSessionExpired} from './hasSessionExpired.ts'
import type {ProjectTransferImportSessionData, RouteSet} from './projectTransferRouteTypes.ts'
import {readImportPlanArtifact} from './readImportPlanArtifact.ts'

const hasFailedCommitRetryArtifacts = async (response: ProjectTransferSessionResponse) => {
  if (!isProjectTransferFailedCommitRetryCandidate(response)) {
    return false
  }

  const layout = getProjectTransferCurrentImportStagingLayout({
    layout: getProjectTransferImportTempLayout(response.id),
    progress: response.progress,
  })
  const [hasAnalysis, hasPlan] = await Promise.all(
    [layout.analysisPath, layout.planPath].map((pathValue) => {
      return globalThis.Bun.file(resolveProjectTransferTempWritablePath({pathValue})).exists()
    }),
  )

  return hasAnalysis && hasPlan
}

const getImportSessionError = (
  response: ProjectTransferSessionResponse,
  now: Date,
): {error: string; status: number} | null => {
  return response.state !== 'completed' && (response.state === 'expired' || hasSessionExpired(response, now))
    ? {error: 'Project transfer import session expired', status: 410}
    : null
}

export const getImportSessionResponseFromRecord = async (
  set: RouteSet,
  record: Awaited<ReturnType<ReturnType<typeof getProjectTransferSessionRepository>['getProjectTransferSession']>>,
  executionMode?: ProjectTransferExecutionMode,
  includePlan = false,
): Promise<ProjectTransferApiResponse<ProjectTransferImportSessionData> | null> => {
  if (record === null) {
    return null
  }

  const response = toProjectTransferSessionResponse(record)

  if (response.direction !== 'import') {
    return getProjectTransferApiError(set, 409, 'Project transfer session is not an import session')
  }

  const sessionError = getImportSessionError(response, new Date())

  if (sessionError !== null) {
    return getProjectTransferApiError(set, sessionError.status, sessionError.error)
  }

  const plan = includePlan ? await readImportPlanArtifact(response) : null
  const failedCommitArtifactsAvailable = await hasFailedCommitRetryArtifacts(response)

  return {data: getImportSessionData(response, plan, executionMode, failedCommitArtifactsAvailable), error: null}
}
