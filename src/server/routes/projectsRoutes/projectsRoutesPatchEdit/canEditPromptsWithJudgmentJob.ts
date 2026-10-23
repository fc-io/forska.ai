import {escapeSqlString, getDateValue} from '../../../services/appQueryHelpers.ts'
import type {AppQueryRunner} from '../appTx.ts'
import type {ProjectEditJudgmentJob} from './projectEditTypes.ts'

type ProjectEditJobSqliteHealthProjection = {
  claimedOutboxCount: number | null
  hasPendingCompletionAck: boolean | null
  orphanedJudgedRowCount: number | null
  outboxRowCount: number | null
  pendingCompletionAckCount: number | null
  promptClaimedCount: number | null
  promptReadyCount: number | null
  promptRunningCount: number | null
}

const getNumberOrZero = (value: number | null | undefined) => {
  return Number(value ?? 0)
}

const promptEditSafeJobStatuses = new Set(['paused', 'completed'])

const hasPromptEditJobImportInFlight = (job: ProjectEditJudgmentJob) => {
  const startedAt = getDateValue(job.lastImportStartedAt)
  const completedAt = getDateValue(job.lastImportCompletedAt)

  return Boolean(startedAt && (!completedAt || completedAt < startedAt))
}

const hasUnsafePromptEditSqliteHealth = (projection: ProjectEditJobSqliteHealthProjection) => {
  return (
    getNumberOrZero(projection.outboxRowCount) > 0
    || getNumberOrZero(projection.claimedOutboxCount) > 0
    || getNumberOrZero(projection.orphanedJudgedRowCount) > 0
    || getNumberOrZero(projection.pendingCompletionAckCount) > 0
    || getNumberOrZero(projection.promptReadyCount) > 0
    || getNumberOrZero(projection.promptClaimedCount) > 0
    || getNumberOrZero(projection.promptRunningCount) > 0
    || Boolean(projection.hasPendingCompletionAck)
  )
}

const getFreshPromptEditSqliteHealthProjection = async (db: AppQueryRunner, jobId: string) => {
  const [projection] = await db.queryJson<ProjectEditJobSqliteHealthProjection>(`
    SELECT
      outbox_row_count AS outboxRowCount,
      claimed_outbox_count AS claimedOutboxCount,
      orphaned_judged_row_count AS orphanedJudgedRowCount,
      pending_completion_ack_count AS pendingCompletionAckCount,
      has_pending_completion_ack AS hasPendingCompletionAck,
      prompt_ready_count AS promptReadyCount,
      prompt_claimed_count AS promptClaimedCount,
      prompt_running_count AS promptRunningCount
    FROM app.judgment_job_sqlite_health_projection
    WHERE job_id = '${escapeSqlString(jobId)}'
      AND fresh_until_at > current_timestamp
    LIMIT 1
  `)

  return projection ?? null
}

export const canEditPromptsWithJudgmentJob = async (db: AppQueryRunner, job: ProjectEditJudgmentJob) => {
  if (!promptEditSafeJobStatuses.has(job.status) || job.storageState === 'quarantined') {
    return false
  }

  if (hasPromptEditJobImportInFlight(job)) {
    return false
  }

  if (job.storageState === 'drained') {
    return true
  }

  const projection = await getFreshPromptEditSqliteHealthProjection(db, job.id)

  return projection !== null && !hasUnsafePromptEditSqliteHealth(projection)
}
