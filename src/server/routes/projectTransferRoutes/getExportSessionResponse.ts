import type {
  ProjectTransferApiResponse,
  ProjectTransferExportReadyPayload,
  ProjectTransferSessionResponse,
} from '../../services/projectTransfer/projectTransferContracts.ts'
import {toProjectTransferSessionResponse} from '../../services/projectTransfer/projectTransferSession.ts'
import {getProjectTransferSessionRepository} from '../../services/projectTransfer/projectTransferSessionRepository.ts'
import {getExportSessionArtifactResponse} from './getExportSessionArtifactResponse.ts'
import {getProjectTransferApiError} from './getProjectTransferApiError.ts'
import {hasSessionExpired} from './hasSessionExpired.ts'
import {isRecord} from './projectTransferRequestBody.ts'
import type {
  ProjectTransferExportNonReadyStatus,
  ProjectTransferExportSessionData,
  ProjectTransferExportSessionReadyResponse,
  RouteSet,
} from './projectTransferRouteTypes.ts'

const isProjectTransferExportNonReadyStatus = (
  state: ProjectTransferSessionResponse['state'],
): state is ProjectTransferExportNonReadyStatus => {
  return state === 'queued' || state === 'assembling' || state === 'packaging'
}

const getReadyExportSessionData = (
  response: ProjectTransferSessionResponse,
  completion: ProjectTransferExportReadyPayload,
): ProjectTransferExportSessionReadyResponse => {
  return {
    byteLength: completion.byteLength,
    checksumSha256: completion.checksumSha256,
    downloadUrl: completion.downloadUrl,
    expiresAt: completion.expiresAt,
    exportId: response.id,
    filename: completion.filename,
    packageFingerprint: completion.packageFingerprint,
    progress: response.progress,
    status: 'ready',
  }
}

const getExportSessionData = (response: ProjectTransferSessionResponse): ProjectTransferExportSessionData | null => {
  if (isProjectTransferExportNonReadyStatus(response.state)) {
    return {
      exportId: response.id,
      expiresAt: response.expiresAt.toISOString(),
      progress: response.progress,
      status: response.state,
    }
  }

  return response.state === 'ready' && response.completion?.status === 'ready'
    ? getReadyExportSessionData(response, response.completion)
    : null
}

const getProjectTransferExportFailureMessage = (error: unknown) => {
  const detail =
    isRecord(error) && typeof error.message === 'string'
      ? error.message.trim()
      : isRecord(error) && typeof error.reason === 'string'
        ? error.reason.trim()
        : typeof error === 'string'
          ? error.trim()
          : ''

  return detail.length > 0 ? `Project transfer export failed: ${detail}` : 'Project transfer export failed'
}

const getExportSessionError = (
  response: ProjectTransferSessionResponse,
  now: Date,
): {error: string; status: number} | null => {
  if (response.direction !== 'export') {
    return {error: 'Project transfer session is not an export session', status: 409}
  }

  if (response.state === 'failed') {
    return {error: getProjectTransferExportFailureMessage(response.error), status: 409}
  }

  if (response.state === 'expired' || hasSessionExpired(response, now)) {
    return {error: 'Project transfer export session expired', status: 410}
  }

  if (response.state === 'ready' && response.completion?.status !== 'ready') {
    return {error: 'Project transfer export metadata is unavailable', status: 409}
  }

  return null
}

export const getExportSessionResponse = async (
  set: RouteSet,
  exportId: string,
): Promise<ProjectTransferApiResponse<ProjectTransferExportSessionData>> => {
  const artifactResponse = await getExportSessionArtifactResponse(set, exportId)

  if (artifactResponse !== null) {
    return artifactResponse
  }

  const record = await getProjectTransferSessionRepository().getProjectTransferSession({sessionId: exportId})

  if (record === null) {
    return getProjectTransferApiError(set, 404, 'Project transfer export session not found')
  }

  const response = toProjectTransferSessionResponse(record)
  const sessionError = getExportSessionError(response, new Date())

  if (sessionError !== null) {
    return getProjectTransferApiError(set, sessionError.status, sessionError.error)
  }

  const data = getExportSessionData(response)

  return data === null
    ? getProjectTransferApiError(set, 409, 'Project transfer export session state is unavailable')
    : {data, error: null}
}
