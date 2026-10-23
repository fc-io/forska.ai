import {randomUUID} from 'node:crypto'

import {type as arktype} from 'arktype'

import {
  getProjectTransferImportAnalyzeExecutionMode,
  type ProjectTransferApiResponse,
  type ProjectTransferExecutionMode,
} from '../../services/projectTransfer/projectTransferContracts.ts'
import {getProjectTransferSessionRepository} from '../../services/projectTransfer/projectTransferSessionRepository.ts'
import {getAnalyzeProgress} from './getAnalyzeProgress.ts'
import {getImportSessionResponseFromRecord} from './getImportSessionResponseFromRecord.ts'
import {getProjectTransferApiError} from './getProjectTransferApiError.ts'
import {parseRequestBody} from './projectTransferRequestBody.ts'
import {getAnalyzeJobAttempt} from './projectTransferRoutesPostImportAnalyze/getAnalyzeJobAttempt.ts'
import {getAnalyzeStartOverallProgress} from './projectTransferRoutesPostImportAnalyze/getAnalyzeStartOverallProgress.ts'
import {startBackgroundAnalyzeJob} from './projectTransferRoutesPostImportAnalyze/startBackgroundAnalyzeJob.ts'
import type {ProjectTransferImportSessionData, RouteSet} from './projectTransferRouteTypes.ts'

const analyzeImportSessionRequestShape = arktype({
  'expectedPlanRevision?': 'number.integer >= 0',
  'expandedBytes?': 'number.integer >= 0',
  'zipBytes?': 'number.integer >= 0',
})

type AnalyzeImportSessionRequest = typeof analyzeImportSessionRequestShape.infer

const getImportAnalyzeExecutionMode = ({
  expandedBytes,
  zipBytes,
}: {
  expandedBytes?: number
  zipBytes: number
}): ProjectTransferExecutionMode => {
  return expandedBytes === undefined
    ? 'background'
    : getProjectTransferImportAnalyzeExecutionMode({expandedBytes, zipBytes})
}

export const analyzeImportSession = async (
  set: RouteSet,
  sessionId: string,
  body: unknown,
): Promise<ProjectTransferApiResponse<ProjectTransferImportSessionData>> => {
  const request = parseRequestBody<AnalyzeImportSessionRequest>(body, analyzeImportSessionRequestShape, [
    'expectedPlanRevision',
    'expandedBytes',
    'zipBytes',
  ])

  if (!request.ok) {
    return getProjectTransferApiError(set, 400, request.error)
  }

  const repository = getProjectTransferSessionRepository()
  const current = await repository.getProjectTransferSession({sessionId})
  const currentResponse = await getImportSessionResponseFromRecord(set, current)

  if (currentResponse === null) {
    return getProjectTransferApiError(set, 404, 'Project transfer import session not found')
  }

  if (currentResponse.error !== null) {
    return currentResponse
  }

  if (currentResponse.data.state !== 'queued') {
    return getProjectTransferApiError(set, 409, 'Project transfer import session is not queued for analysis')
  }

  const upload = currentResponse.data.upload

  if (upload === null) {
    return getProjectTransferApiError(set, 409, 'Project transfer import upload metadata is unavailable')
  }

  const executionMode = getImportAnalyzeExecutionMode({
    expandedBytes: request.value.expandedBytes,
    zipBytes: request.value.zipBytes ?? upload.byteLength,
  })
  const ownerToken = randomUUID()
  const claimedAt = new Date()
  const claimed = await repository.transitionProjectTransferSessionState({
    expectedOwnerToken: null,
    expectedPlanRevision: request.value.expectedPlanRevision,
    expectedState: 'queued',
    nextOwnerLeaseMs: 60_000,
    nextOwnerToken: ownerToken,
    nextState: 'extracting',
    now: claimedAt,
    progress: getAnalyzeProgress({
      now: claimedAt,
      overall: getAnalyzeStartOverallProgress(),
      phase: 'package_scan',
      status: 'running',
      upload,
    }),
    sessionId,
  })

  if (claimed === null) {
    return getProjectTransferApiError(set, 409, 'Project transfer import analysis could not be claimed')
  }

  if (executionMode === 'background') {
    set.status = 202
    startBackgroundAnalyzeJob({ownerToken, sessionId})
    return (
      (await getImportSessionResponseFromRecord(set, claimed, executionMode))
      ?? getProjectTransferApiError(set, 500, 'Import session unavailable')
    )
  }

  const analyzed = await getAnalyzeJobAttempt({ownerToken, sessionId})

  return analyzed === null
    ? getProjectTransferApiError(set, 409, 'Project transfer import analysis ownership was lost')
    : ((await getImportSessionResponseFromRecord(set, analyzed, executionMode))
        ?? getProjectTransferApiError(set, 500, 'Import session unavailable'))
}
