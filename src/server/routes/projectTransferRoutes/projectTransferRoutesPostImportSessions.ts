import {randomUUID} from 'node:crypto'

import {type as arktype} from 'arktype'

import type {ProjectTransferApiResponse} from '../../services/projectTransfer/projectTransferContracts.ts'
import {isProjectTransferSessionId} from '../../services/projectTransfer/projectTransferSession.ts'
import {getProjectTransferSessionRepository} from '../../services/projectTransfer/projectTransferSessionRepository.ts'
import {getDefaultImportSessionExpiresAt} from './getDefaultImportSessionExpiresAt.ts'
import {getImportSessionResponseFromRecord} from './getImportSessionResponseFromRecord.ts'
import {getProjectTransferApiError} from './getProjectTransferApiError.ts'
import {parseRequestBody} from './projectTransferRequestBody.ts'
import type {ProjectTransferImportSessionData, RouteSet} from './projectTransferRouteTypes.ts'

const createImportSessionRequestShape = arktype({
  'expiresAt?': 'string',
  'packageFingerprint?': 'string | null',
  'sessionId?': 'string',
})

type CreateImportSessionRequest = typeof createImportSessionRequestShape.infer

const parseImportSessionExpiresAt = (expiresAt: string | undefined, now: Date) => {
  if (expiresAt === undefined) {
    return {ok: true as const, value: getDefaultImportSessionExpiresAt(now)}
  }

  const parsed = new Date(expiresAt)

  return Number.isNaN(parsed.getTime())
    ? {error: 'Project transfer import session expiresAt must be a valid date-time', ok: false as const}
    : parsed.getTime() <= now.getTime()
      ? {error: 'Project transfer import session expiresAt must be in the future', ok: false as const}
      : {ok: true as const, value: parsed}
}

const getImportSessionId = (requestedSessionId: string | undefined) => {
  const sessionId = requestedSessionId ?? randomUUID()

  return isProjectTransferSessionId(sessionId)
    ? {ok: true as const, value: sessionId}
    : {error: 'Project transfer session id must be path-safe', ok: false as const}
}

export const createImportSession = async (
  set: RouteSet,
  body: unknown,
): Promise<ProjectTransferApiResponse<ProjectTransferImportSessionData>> => {
  const request = parseRequestBody<CreateImportSessionRequest>(body, createImportSessionRequestShape, [
    'expiresAt',
    'packageFingerprint',
    'sessionId',
  ])

  if (!request.ok) {
    return getProjectTransferApiError(set, 400, request.error)
  }

  const now = new Date()
  const sessionId = getImportSessionId(request.value.sessionId)

  if (!sessionId.ok) {
    return getProjectTransferApiError(set, 400, sessionId.error)
  }

  const expiresAt = parseImportSessionExpiresAt(request.value.expiresAt, now)

  if (!expiresAt.ok) {
    return getProjectTransferApiError(set, 400, expiresAt.error)
  }

  const repository = getProjectTransferSessionRepository()
  const existing = await repository.getProjectTransferSession({sessionId: sessionId.value})

  if (existing !== null) {
    return getProjectTransferApiError(set, 409, 'Project transfer import session already exists')
  }

  const record = await repository.createProjectTransferSession({
    direction: 'import',
    expiresAt: expiresAt.value,
    id: sessionId.value,
    now,
    packageFingerprint: request.value.packageFingerprint ?? null,
    state: 'awaiting_upload',
  })

  set.status = 201

  return (
    (await getImportSessionResponseFromRecord(set, record))
    ?? getProjectTransferApiError(set, 500, 'Import session unavailable')
  )
}
