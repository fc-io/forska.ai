import {randomUUID} from 'node:crypto'
import {rm} from 'node:fs/promises'

import {type as arktype} from 'arktype'

import type {
  ProjectTransferApiResponse,
  ProjectTransferCancellationReason,
  ProjectTransferProgressPayload,
  ProjectTransferUploadMetadataPayload,
} from '../../services/projectTransfer/projectTransferContracts.ts'
import {resolveProjectTransferTempWritablePath} from '../../services/projectTransfer/projectTransferPaths.ts'
import {
  getProjectTransferPerformanceMetrics,
  measureProjectTransferPhase,
  type ProjectTransferPerformanceMetrics,
} from '../../services/projectTransfer/projectTransferPerformanceMetrics.ts'
import {getProjectTransferImportTempLayout} from '../../services/projectTransfer/projectTransferSession.ts'
import {getProjectTransferSessionRepository} from '../../services/projectTransfer/projectTransferSessionRepository.ts'
import {getImportSession} from './getImportSession.ts'
import {getImportSessionResponseFromRecord} from './getImportSessionResponseFromRecord.ts'
import {getMergedImportPerformanceMetrics} from './getMergedImportPerformanceMetrics.ts'
import {getProjectTransferApiError} from './getProjectTransferApiError.ts'
import {isRecord, parseRequestBody} from './projectTransferRequestBody.ts'
import type {ProjectTransferImportSessionData, RouteSet} from './projectTransferRouteTypes.ts'

const cancelImportSessionRequestShape = arktype({
  'cleanupTempArtifacts?': 'boolean',
  'expectedOwnerToken?': 'string',
  'reason?': arktype('"cleanup_failed" | "session_expired" | "user_cancelled"'),
})

type CancelImportSessionRequest = typeof cancelImportSessionRequestShape.infer

const getCancelRequestDefaults = (request: CancelImportSessionRequest) => {
  return {
    cleanupTempArtifacts: request.cleanupTempArtifacts ?? true,
    expectedOwnerToken: request.expectedOwnerToken,
    reason: request.reason ?? 'user_cancelled',
  }
}

const getCancelNextState = (reason: ProjectTransferCancellationReason) => {
  return reason === 'session_expired' ? 'expired' : 'cancelled'
}

const isEmptyRequestBody = (body: unknown) => {
  return body === null || body === undefined || (isRecord(body) && Object.keys(body).length === 0)
}

const getCancellationMetadata = (error: unknown) => {
  return isRecord(error) ? error : {}
}

const isMatchingTerminalCancellationRequest = ({
  body,
  request,
  response,
}: {
  body: unknown
  request: ReturnType<typeof getCancelRequestDefaults>
  response: ProjectTransferImportSessionData
}) => {
  if (isEmptyRequestBody(body)) {
    return true
  }

  const metadata = getCancellationMetadata(response.error)
  const reasonMatches = metadata.reason === undefined || request.reason === metadata.reason
  const cleanupMatches =
    metadata.cleanupTempArtifacts === undefined || request.cleanupTempArtifacts === metadata.cleanupTempArtifacts

  return reasonMatches && cleanupMatches
}

const getCancelProgress = ({
  cleanupTempArtifacts,
  now,
  performanceMetrics,
  upload,
}: {
  cleanupTempArtifacts: boolean
  now: Date
  performanceMetrics?: ProjectTransferPerformanceMetrics
  upload: ProjectTransferUploadMetadataPayload | null
}): ProjectTransferProgressPayload => {
  return {
    phase: 'cleanup',
    performanceMetrics,
    status: cleanupTempArtifacts ? 'completed' : 'pending',
    updatedAt: now.toISOString(),
    uploadMetadata: upload,
  }
}

const cleanupCancelledImportSession = async ({
  cleanupTempArtifacts,
  ownerToken,
  sessionId,
  state,
}: {
  cleanupTempArtifacts: boolean
  ownerToken: string
  sessionId: string
  state: 'cancelled' | 'expired'
}) => {
  if (cleanupTempArtifacts) {
    const rootPath = resolveProjectTransferTempWritablePath({
      pathValue: getProjectTransferImportTempLayout(sessionId).rootPath,
    })
    await rm(rootPath, {force: true, recursive: true})
  }

  return getProjectTransferSessionRepository().markProjectTransferSessionTerminalCleanupComplete({
    expectedOwnerToken: ownerToken,
    expectedState: state,
    sessionId,
  })
}

export const cancelImportSession = async (
  set: RouteSet,
  sessionId: string,
  body: unknown,
): Promise<ProjectTransferApiResponse<ProjectTransferImportSessionData>> => {
  const parsedRequest = parseRequestBody<CancelImportSessionRequest>(body, cancelImportSessionRequestShape, [
    'cleanupTempArtifacts',
    'expectedOwnerToken',
    'reason',
  ])

  if (!parsedRequest.ok) {
    return getProjectTransferApiError(set, 400, parsedRequest.error)
  }

  const response = await getImportSession(set, sessionId)

  if (response.error !== null) {
    return response
  }

  const request = getCancelRequestDefaults(parsedRequest.value)

  if (response.data.state === 'cancelled' || response.data.state === 'expired') {
    return isMatchingTerminalCancellationRequest({body, request, response: response.data})
      ? response
      : getProjectTransferApiError(set, 409, 'Project transfer import session terminal cleanup request does not match')
  }

  if (response.data.state === 'committing' || response.data.state === 'completed' || response.data.state === 'failed') {
    return getProjectTransferApiError(set, 409, 'Project transfer import session cannot be cancelled from this state')
  }

  const ownerToken = randomUUID()
  const cancelledAt = new Date()
  const nextState = getCancelNextState(request.reason)
  const cancelled = await getProjectTransferSessionRepository().cancelProjectTransferImportSession({
    error: {cleanupTempArtifacts: request.cleanupTempArtifacts, reason: request.reason},
    expectedOwnerToken: request.expectedOwnerToken,
    expectedState: [
      'awaiting_upload',
      'uploading',
      'queued',
      'extracting',
      'analyzing',
      'awaiting_resolution',
      'ready_to_commit',
    ],
    nextState,
    now: cancelledAt,
    ownerToken,
    progress: getCancelProgress({
      cleanupTempArtifacts: request.cleanupTempArtifacts,
      now: cancelledAt,
      upload: response.data.upload,
    }),
    sessionId,
  })

  if (cancelled === null) {
    return getProjectTransferApiError(set, 409, 'Project transfer import session cancellation could not be claimed')
  }

  const cleanupMeasurement = await measureProjectTransferPhase('cleanup', () => {
    return cleanupCancelledImportSession({
      cleanupTempArtifacts: request.cleanupTempArtifacts,
      ownerToken,
      sessionId,
      state: nextState,
    })
  })
  const cleanupPerformanceMetrics = getMergedImportPerformanceMetrics(
    response.data.progress?.performanceMetrics,
    getProjectTransferPerformanceMetrics({
      benchmark: {wallTimeMs: cleanupMeasurement.timing.durationMs},
      operation: 'import',
      phases: {cleanup: cleanupMeasurement.timing},
    }),
  )
  const cleaned = await getProjectTransferSessionRepository().updateProjectTransferSessionProgress({
    expectedOwnerToken: ownerToken,
    progress: getCancelProgress({
      cleanupTempArtifacts: request.cleanupTempArtifacts,
      now: new Date(),
      performanceMetrics: cleanupPerformanceMetrics,
      upload: response.data.upload,
    }),
    sessionId,
  })

  return (
    (await getImportSessionResponseFromRecord(set, cleaned ?? cleanupMeasurement.value ?? cancelled))
    ?? getProjectTransferApiError(set, 500, 'Import session unavailable')
  )
}
