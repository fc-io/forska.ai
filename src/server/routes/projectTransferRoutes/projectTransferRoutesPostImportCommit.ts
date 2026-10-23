import {type as arktype} from 'arktype'

import {commitProjectTransferImportSession} from '../../services/projectTransfer/projectTransferCommit.ts'
import type {
  ProjectTransferApiResponse,
  ProjectTransferExecutionMode,
} from '../../services/projectTransfer/projectTransferContracts.ts'
import {getImportSessionResponseFromRecord} from './getImportSessionResponseFromRecord.ts'
import {getProjectTransferApiError} from './getProjectTransferApiError.ts'
import {parseRequestBody} from './projectTransferRequestBody.ts'
import type {ProjectTransferImportSessionData, RouteSet} from './projectTransferRouteTypes.ts'

const commitImportSessionRequestShape = arktype({
  'expectedPlanRevision?': 'number.integer >= 0',
  'planRevision?': 'number.integer >= 0',
})

type CommitImportSessionRequest = typeof commitImportSessionRequestShape.infer

const getCommitRequestRevision = (
  request: CommitImportSessionRequest,
): {error: string; ok: false} | {ok: true; request: CommitImportSessionRequest} => {
  const hasPlanRevision = request.planRevision !== undefined
  const hasExpectedPlanRevision = request.expectedPlanRevision !== undefined

  if (!hasPlanRevision && !hasExpectedPlanRevision) {
    return {error: 'Project transfer commit requires planRevision', ok: false}
  }

  if (hasPlanRevision && hasExpectedPlanRevision && request.planRevision !== request.expectedPlanRevision) {
    return {error: 'Project transfer commit planRevision and expectedPlanRevision conflict', ok: false}
  }

  if (hasPlanRevision && hasExpectedPlanRevision) {
    return {error: 'Project transfer commit requires exactly one reviewed plan revision', ok: false}
  }

  return {ok: true, request}
}

const getCommitSessionResponse = async ({
  executionMode,
  result,
  set,
  stalePlan,
}: {
  executionMode?: ProjectTransferExecutionMode
  result: Exclude<Awaited<ReturnType<typeof commitProjectTransferImportSession>>, {status: 'error'}>
  set: RouteSet
  stalePlan?: boolean
}): Promise<ProjectTransferApiResponse<ProjectTransferImportSessionData>> => {
  set.status = result.statusCode
  const response = await getImportSessionResponseFromRecord(set, result.session, executionMode)

  return response === null
    ? getProjectTransferApiError(set, 500, 'Import session unavailable')
    : stalePlan
      ? {data: {...response.data, stalePlan: true}, error: null}
      : response
}

export const commitImportSession = async (
  set: RouteSet,
  sessionId: string,
  body: unknown,
): Promise<ProjectTransferApiResponse<ProjectTransferImportSessionData>> => {
  const request = parseRequestBody<CommitImportSessionRequest>(body, commitImportSessionRequestShape, [
    'expectedPlanRevision',
    'planRevision',
  ])

  if (!request.ok) {
    return getProjectTransferApiError(set, 400, request.error)
  }

  const revision = getCommitRequestRevision(request.value)

  if (!revision.ok) {
    return getProjectTransferApiError(set, 400, revision.error)
  }

  const result = await commitProjectTransferImportSession({request: revision.request, sessionId})

  if (result.status === 'error') {
    return getProjectTransferApiError(set, result.statusCode, result.error)
  }

  if (result.status === 'stale') {
    return getCommitSessionResponse({result, set, stalePlan: true})
  }

  if (result.status === 'claimed') {
    return getCommitSessionResponse({executionMode: result.executionMode, result, set})
  }

  return getCommitSessionResponse({result, set})
}
