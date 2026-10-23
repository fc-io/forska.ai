import type {ProjectTransferSessionRecord} from '../../../db/schemaTypes.ts'
import type {ProjectTransferApiResponse} from '../../services/projectTransfer/projectTransferContracts.ts'
import {toProjectTransferSessionResponse} from '../../services/projectTransfer/projectTransferSession.ts'
import {getProjectTransferSessionRepository} from '../../services/projectTransfer/projectTransferSessionRepository.ts'
import {getAnalyzeProgress} from './getAnalyzeProgress.ts'
import {getImportSessionResponseFromRecord} from './getImportSessionResponseFromRecord.ts'
import {getProjectTransferApiError} from './getProjectTransferApiError.ts'
import {getUploadMetadataFromProgress} from './getUploadMetadataFromProgress.ts'
import type {ProjectTransferImportSessionData, RouteSet} from './projectTransferRouteTypes.ts'

const importArtifactsUnavailableMessage =
  'Project transfer import artifacts are unavailable. Create a new import session and upload the package again.'

const getFailedImportArtifactsProgress = (record: ProjectTransferSessionRecord, now: Date) => {
  const response = toProjectTransferSessionResponse(record)

  return response.progress
    ? {...response.progress, status: 'failed' as const, updatedAt: now.toISOString()}
    : getAnalyzeProgress({
        now,
        phase: 'analyze',
        status: 'failed',
        upload: getUploadMetadataFromProgress(response.progress),
      })
}

export const failImportSessionForUnavailableArtifacts = async ({
  record,
  set,
}: {
  record: ProjectTransferSessionRecord
  set: RouteSet
}): Promise<ProjectTransferApiResponse<ProjectTransferImportSessionData>> => {
  const now = new Date()
  const failed = await getProjectTransferSessionRepository().transitionProjectTransferSessionState({
    error: {message: importArtifactsUnavailableMessage, name: 'ProjectTransferImportArtifactsUnavailableError'},
    expectedState: record.state,
    nextOwnerToken: null,
    nextState: 'failed',
    progress: getFailedImportArtifactsProgress(record, now),
    sessionId: record.id,
  })

  if (failed === null) {
    set.status = 409

    return {data: null, error: importArtifactsUnavailableMessage}
  }

  set.status = 200

  return (
    (await getImportSessionResponseFromRecord(set, failed))
    ?? getProjectTransferApiError(set, 500, 'Import session unavailable')
  )
}
