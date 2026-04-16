import {getJudgmentJobSqliteService, JudgmentJobLeaseError} from './judgmentJobSqliteService.ts'

export const abandonedSentPromptGraceMs = 30_000

export const requeueAbandonedSentPrompts = async ({
  jobIds,
  serverJobId,
}: {
  jobIds: string[]
  serverJobId: string
}): Promise<number> => {
  if (jobIds.length === 0) return 0

  const sqliteService = getJudgmentJobSqliteService()
  const cutoff = new Date(Date.now() - abandonedSentPromptGraceMs)
  const sqliteRequeuedCounts = await Promise.all(
    jobIds.map(async (jobId) => {
      try {
        await sqliteService.ensureOwnedLease(jobId, serverJobId)
        return sqliteService.requeueAbandonedSentPrompts({jobId, serverJobId, staleBefore: cutoff})
      } catch (error) {
        if (error instanceof JudgmentJobLeaseError) {
          return 0
        }

        throw error
      }
    }),
  )

  const totalRequeued = sqliteRequeuedCounts.reduce((sum, count) => {
    return sum + count
  }, 0)

  if (totalRequeued > 0) {
    console.warn(
      `[judgments] requeued abandoned sent prompts ${JSON.stringify({count: totalRequeued, jobIds, serverJobId})}`,
    )
  }

  return totalRequeued
}
