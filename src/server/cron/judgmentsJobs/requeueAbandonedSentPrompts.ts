import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getQuotedStringList, getSqlLiteral, getTimestampLiteral} from '../../services/appQueryHelpers.ts'
import {getJudgmentJobSqliteService} from './judgmentJobSqliteService.ts'

const abandonedSentPromptGraceMs = 30_000

export const requeueAbandonedSentPrompts = async ({
  jobIds,
  serverJobId,
}: {
  jobIds: string[]
  serverJobId: string
}): Promise<number> => {
  if (jobIds.length === 0) return 0

  const sqliteService = getJudgmentJobSqliteService()
  const sqliteJobIds = jobIds.filter((jobId) => {
    return sqliteService.hasJob(jobId)
  })
  const duckdbJobIds = jobIds.filter((jobId) => {
    return !sqliteService.hasJob(jobId)
  })

  const cutoff = new Date(Date.now() - abandonedSentPromptGraceMs)
  const sqliteRequeuedCounts = await Promise.all(
    sqliteJobIds.map((jobId) => {
      return sqliteService.requeueAbandonedSentPrompts({jobId, serverJobId, staleBefore: cutoff})
    }),
  )
  const rows =
    duckdbJobIds.length === 0
      ? []
      : await getAppDatabaseService().queryJson<{id: string}>(`
          UPDATE app.judgment_job_prompt
          SET status = 'ready',
              sent_at = NULL,
              updated_at = current_timestamp,
              server_id = ${getSqlLiteral(serverJobId)}
          WHERE status = 'sent'
            AND job_id IN (${getQuotedStringList(duckdbJobIds).join(', ')})
            AND COALESCE(server_id, '') <> ${getSqlLiteral(serverJobId)}
            AND sent_at <= ${getTimestampLiteral(cutoff)}
          RETURNING id
        `)
  const sqliteRequeued = sqliteRequeuedCounts.reduce((sum, count) => {
    return sum + count
  }, 0)
  const totalRequeued = sqliteRequeued + rows.length

  if (totalRequeued > 0) {
    console.warn('[judgments] requeued abandoned sent prompts', {count: totalRequeued, jobIds, serverJobId})
  }

  return totalRequeued
}
