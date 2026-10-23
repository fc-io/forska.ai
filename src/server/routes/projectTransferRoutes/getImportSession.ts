import type {ProjectTransferApiResponse} from '../../services/projectTransfer/projectTransferContracts.ts'
import {resolveProjectTransferTempWritablePath} from '../../services/projectTransfer/projectTransferPaths.ts'
import {
  getProjectTransferImportTempLayout,
  toProjectTransferSessionResponse,
} from '../../services/projectTransfer/projectTransferSession.ts'
import {getProjectTransferSessionRepository} from '../../services/projectTransfer/projectTransferSessionRepository.ts'
import {getProjectTransferCurrentImportStagingLayout} from '../../services/projectTransfer/projectTransferStaging.ts'
import {failImportSessionForUnavailableArtifacts} from './failImportSessionForUnavailableArtifacts.ts'
import {getImportSessionArtifactResponse} from './getImportSessionArtifactResponse.ts'
import {getImportSessionResponseFromRecord} from './getImportSessionResponseFromRecord.ts'
import {getProjectTransferApiError} from './getProjectTransferApiError.ts'
import type {ProjectTransferImportSessionData, RouteSet} from './projectTransferRouteTypes.ts'
import {readImportPlanArtifact} from './readImportPlanArtifact.ts'
import {shouldUseImportSessionArtifactResponse} from './shouldUseImportSessionArtifactResponse.ts'
import {terminalImportSessionStates} from './terminalImportSessionStates.ts'
import {validateCurrentImportPlanArtifact} from './validateCurrentImportPlanArtifact.ts'

export const getImportSession = async (
  set: RouteSet,
  sessionId: string,
  includePlan = false,
): Promise<ProjectTransferApiResponse<ProjectTransferImportSessionData>> => {
  const artifactResponse = await getImportSessionArtifactResponse(sessionId)

  if (artifactResponse !== null && artifactResponse.data?.state === 'failed') {
    const record = await getProjectTransferSessionRepository().getProjectTransferSession({sessionId})

    if (record !== null && terminalImportSessionStates.has(record.state)) {
      const response = await getImportSessionResponseFromRecord(set, record, undefined, includePlan)

      return response ?? getProjectTransferApiError(set, 500, 'Import session unavailable')
    }

    return artifactResponse
  }

  if (artifactResponse !== null && shouldUseImportSessionArtifactResponse(artifactResponse)) {
    return artifactResponse
  }

  const record = await getProjectTransferSessionRepository().getProjectTransferSession({sessionId})

  if (artifactResponse !== null && record !== null && terminalImportSessionStates.has(record.state)) {
    const response = await getImportSessionResponseFromRecord(set, record, undefined, includePlan)

    return response ?? getProjectTransferApiError(set, 500, 'Import session unavailable')
  }

  if (record !== null && (record.state === 'awaiting_resolution' || record.state === 'ready_to_commit')) {
    const response = toProjectTransferSessionResponse(record)
    const layout = getProjectTransferCurrentImportStagingLayout({
      layout: getProjectTransferImportTempLayout(sessionId),
      progress: response.progress,
    })
    const hasPlanArtifact = await globalThis.Bun.file(
      resolveProjectTransferTempWritablePath({pathValue: layout.planPath}),
    ).exists()

    if (!hasPlanArtifact) {
      return failImportSessionForUnavailableArtifacts({record, set})
    }

    if (includePlan) {
      const plan = await readImportPlanArtifact(response)
      const planValidation = validateCurrentImportPlanArtifact(response, plan)

      if (!planValidation.ok) {
        return failImportSessionForUnavailableArtifacts({record, set})
      }
    }
  }

  const response = await getImportSessionResponseFromRecord(set, record, undefined, includePlan)

  return response === null
    ? getProjectTransferApiError(set, 404, 'Project transfer import session not found')
    : response
}
