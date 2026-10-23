import {getJudgmentJobSqliteService} from '../../../cron/judgmentsJobs/judgmentJobSqliteService.ts'

const abandonedClaimGraceMs = 30_000
const ownerBackedClaimRecoveryIntervalMs = 15_000
const ownerBackedClaimRecoveryCheckedAt = new Map<string, number>()

const getOwnerBackedClaimRecoveryKey = (jobId: string, claimedBy: string) => {
  return `${jobId}:${claimedBy}`
}

const shouldRunOwnerBackedClaimRecovery = (jobId: string, claimedBy: string) => {
  const key = getOwnerBackedClaimRecoveryKey(jobId, claimedBy)
  const now = Date.now()
  const checkedAt = ownerBackedClaimRecoveryCheckedAt.get(key) ?? 0
  const shouldRun = now - checkedAt >= ownerBackedClaimRecoveryIntervalMs

  if (shouldRun) {
    ownerBackedClaimRecoveryCheckedAt.set(key, now)
  }

  return shouldRun
}

const getRouteErrorMessage = (error: unknown) => {
  return error instanceof Error ? error.message : String(error)
}

export const runOwnerBackedClaimRecovery = async ({
  claimedBy,
  jobId,
  protectedRecordIds,
}: {
  claimedBy: string
  jobId: string
  protectedRecordIds?: string[]
}): Promise<void> => {
  if (!shouldRunOwnerBackedClaimRecovery(jobId, claimedBy)) {
    return
  }

  await getJudgmentJobSqliteService()
    .requeueAbandonedSentPrompts({
      jobId,
      serverJobId: claimedBy,
      staleBefore: new Date(Date.now() - abandonedClaimGraceMs),
      ...(protectedRecordIds !== undefined ? {protectedRecordIds} : {}),
    })
    .catch((error) => {
      console.warn('[judgmentsJobs] owner-backed claim recovery failed', {
        claimedBy,
        error: getRouteErrorMessage(error),
        jobId,
      })
    })
}
