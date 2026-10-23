import {getJsonValue, getQuotedStringList, getSqlLiteral} from '../../services/appQueryHelpers.ts'
import type {JudgmentJobSqliteHealthProjectionReader} from '../../services/judgmentJobSqliteHealthProjectionService.ts'
import {getIsoDateString} from './getIsoDateString.ts'
import type {JudgmentJobImportWorkLease} from './judgmentJobHealthTypes.ts'

export const getJudgmentImportWorkLeasesByJobId = async ({
  db,
  jobIds,
  now,
}: {
  db: JudgmentJobSqliteHealthProjectionReader
  jobIds: string[]
  now: Date
}): Promise<Map<string, JudgmentJobImportWorkLease[]>> => {
  if (jobIds.length === 0) {
    return new Map()
  }

  const rows = await db.queryJson<{
    consumerId: string | null
    freshUntilAt: unknown
    jobId: string
    lastProgressedAt: unknown
    lastStartedAt: unknown
    recoveryContext: unknown
    recoveryMode: JudgmentJobImportWorkLease['recoveryMode']
    retryAfterAt: unknown
  }>(`
    SELECT
      judgment_job_id AS jobId,
      consumer_id AS consumerId,
      last_started_at AS lastStartedAt,
      last_progressed_at AS lastProgressedAt,
      fresh_until_at AS freshUntilAt,
      retry_after_at AS retryAfterAt,
      recovery_mode AS recoveryMode,
      TO_JSON(recovery_context) AS recoveryContext
    FROM app.maintenance_work_lease
    WHERE work_kind = 'judgment_sqlite_outbox_import'
      AND scope_kind = 'job'
      AND judgment_job_id IN (${getQuotedStringList(jobIds).join(', ')})
      AND completed_at IS NULL
      AND (
        fresh_until_at > ${getSqlLiteral(now)}
        OR recovery_mode <> 'none'
        OR retry_after_at > ${getSqlLiteral(now)}
      )
    ORDER BY judgment_job_id ASC, fresh_until_at DESC NULLS LAST, updated_at DESC
  `)

  return rows.reduce((map, row) => {
    const lease = {
      consumerId: row.consumerId,
      freshUntilAt: getIsoDateString(row.freshUntilAt),
      lastProgressedAt: getIsoDateString(row.lastProgressedAt),
      lastStartedAt: getIsoDateString(row.lastStartedAt),
      recoveryContext: getJsonValue(row.recoveryContext) as Record<string, unknown> | null,
      recoveryMode: row.recoveryMode,
      retryAfterAt: getIsoDateString(row.retryAfterAt),
    }
    map.set(row.jobId, [...(map.get(row.jobId) ?? []), lease])
    return map
  }, new Map<string, JudgmentJobImportWorkLease[]>())
}
