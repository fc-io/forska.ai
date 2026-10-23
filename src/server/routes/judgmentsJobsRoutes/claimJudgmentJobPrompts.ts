import {
  isJudgeWorkerPausedAfterArmedTestClaim,
  pauseJudgeWorkerAfterArmedTestClaim,
} from '../../cron/judgmentsJobs/judgeWorkerLeaseLossTestBarrier.ts'
import {getJudgmentJobSqliteService} from '../../cron/judgmentsJobs/judgmentJobSqliteService.ts'
import {isTransientJudgmentJobSqliteLockMessage} from '../../cron/judgmentsJobs/judgmentJobSqliteTransientLock.ts'
import {getJudgmentJobFullTextClaimError} from '../../services/judgmentJobFullTextPreconditions.ts'
import {getJudgmentJobModelContextWindowClaimError} from '../../services/judgmentJobModelContextWindow.ts'
import {
  getOwnerProviderClaimGate,
  getProviderGatedClaimLimit,
  logFullTextClaimGate,
  logModelContextWindowClaimGate,
  logProviderClaimGate,
  markOwnerProviderProbeClaimed,
} from './claimJudgmentJobPrompts/providerClaimGate.ts'
import {runOwnerBackedClaimRecovery} from './claimJudgmentJobPrompts/runOwnerBackedClaimRecovery.ts'
import {getMaintenanceUnavailableError} from './getMaintenanceUnavailableError.ts'
import {judgmentJobServerId} from './judgmentJobServerId.ts'

type JudgmentClaimRequestBody = {claimedBy?: string; limit?: number; protectedRecordIds?: string[]}

const getNormalizedClaimLimit = (limit: number | null | undefined) => {
  return Number.isFinite(limit) ? Math.max(0, Math.floor(limit ?? 0)) : 1
}

const getOwnerBackedClaimResponse = (
  claims: Awaited<ReturnType<ReturnType<typeof getJudgmentJobSqliteService>['claimReadyPrompts']>>,
) => {
  return claims.map(({executionSnapshotPayload: _executionSnapshotPayload, ...claim}) => {
    return claim
  })
}

export const claimJudgmentJobPrompts = async (jobId: string, body: JudgmentClaimRequestBody | undefined) => {
  const claimedBy = body?.claimedBy ?? judgmentJobServerId
  if (isJudgeWorkerPausedAfterArmedTestClaim({claimedBy})) {
    return {data: {claims: []}, error: null}
  }
  await runOwnerBackedClaimRecovery({claimedBy, jobId, protectedRecordIds: body?.protectedRecordIds})
  const providerClaimGate = await getOwnerProviderClaimGate(jobId)

  if (!providerClaimGate.claimsAllowed) {
    void logProviderClaimGate(jobId, providerClaimGate)
    return {data: {claims: []}, error: null}
  }

  const modelContextWindowError = await getJudgmentJobModelContextWindowClaimError(jobId)

  if (modelContextWindowError) {
    logModelContextWindowClaimGate(jobId, modelContextWindowError.message)
    return {data: {claims: []}, error: null}
  }

  const fullTextClaimError = await getJudgmentJobFullTextClaimError(jobId)

  if (fullTextClaimError) {
    logFullTextClaimGate(jobId, fullTextClaimError)
    return {data: {claims: []}, error: null}
  }

  try {
    const claims = await getJudgmentJobSqliteService().claimReadyPrompts(
      jobId,
      claimedBy,
      getProviderGatedClaimLimit(getNormalizedClaimLimit(body?.limit ?? 1), providerClaimGate),
    )
    pauseJudgeWorkerAfterArmedTestClaim({claimedBy, claimedCount: claims.length})
    markOwnerProviderProbeClaimed({claimedCount: claims.length, jobId, providerClaimGate})

    return {data: {claims: getOwnerBackedClaimResponse(claims)}, error: null}
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)

    if (isTransientJudgmentJobSqliteLockMessage(errorMessage)) {
      throw getMaintenanceUnavailableError(errorMessage, error)
    }

    throw error
  }
}
