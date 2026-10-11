import type {JudgmentJobStopReason} from '../../../utils/judgmentJobStopConditions.ts'
import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString, getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {getJudgmentJobSqliteService} from './judgmentJobSqliteService.ts'

export type JudgmentJobMutationState = {
  error: unknown
  id: string
  status: string
  storageState: string
  quarantinedAt: unknown
  quarantineReason: string | null
  lastImportStartedAt: unknown
  lastImportCompletedAt: unknown
  lastImportErrorAt: unknown
  lastImportError: string | null
  lastImportExitCode: number | null
  importFailureCount: number | null
  pauseRequestedAt: unknown
  stopAfterArticles: number | null
  stopAfterTotalTokens: number | string | null
  stopAt: unknown
  stopReason: string | null
  stopReasonAt: unknown
  stopWhenHumanAnsweredDone: boolean | null
  updatedAt: unknown
}

type JudgmentJobMutationQueryRunner = {queryJson: <T>(statement: string) => Promise<T[]>}

export type JudgmentJobStatus =
  | 'completed'
  | 'failed'
  | 'not_started'
  | 'paused'
  | 'project_removed'
  | 'running'
  | 'waiting_on_db_connection'
  | 'waiting_on_llm_connection'

export const getJudgmentJobMutationState = async (
  db: JudgmentJobMutationQueryRunner,
  jobId: string,
): Promise<JudgmentJobMutationState | null> => {
  const [job] = await db.queryJson<JudgmentJobMutationState>(`
    SELECT
      id,
      status,
      storage_state AS storageState,
      quarantined_at AS quarantinedAt,
      quarantine_reason AS quarantineReason,
      last_import_started_at AS lastImportStartedAt,
      last_import_completed_at AS lastImportCompletedAt,
      last_import_error_at AS lastImportErrorAt,
      last_import_error AS lastImportError,
      last_import_exit_code AS lastImportExitCode,
      import_failure_count AS importFailureCount,
      pause_requested_at AS pauseRequestedAt,
      stop_after_articles AS stopAfterArticles,
      stop_after_total_tokens AS stopAfterTotalTokens,
      stop_at AS stopAt,
      COALESCE(stop_when_human_answered_done, FALSE) AS stopWhenHumanAnsweredDone,
      stop_reason AS stopReason,
      stop_reason_at AS stopReasonAt,
      updated_at AS updatedAt,
      TO_JSON(error) AS error
    FROM app.judgment_job
    WHERE id = '${escapeSqlString(jobId)}'
    LIMIT 1
  `)

  return job ?? null
}

const getStatusAssignments = ({error, status}: {error?: string[] | null; status?: JudgmentJobStatus}) => {
  return status === undefined ? null : `status = ${getSqlLiteral(status)}, error = ${getSqlLiteral(error ?? null)}`
}

const getStorageAssignments = ({
  clearTransientQuarantine,
  status,
}: {
  clearTransientQuarantine: boolean
  status?: JudgmentJobStatus
}) => {
  const statusAssignments =
    status === 'paused'
      ? "storage_state = 'draining', pause_requested_at = current_timestamp"
      : status === 'running'
        ? "storage_state = 'active', pause_requested_at = NULL"
        : null
  const quarantineAssignments = clearTransientQuarantine
    ? 'quarantined_at = NULL, quarantine_reason = NULL, import_failure_count = 0, last_import_error = NULL, last_import_error_at = NULL'
    : null

  return [statusAssignments, quarantineAssignments].filter((assignment): assignment is string => {
    return assignment !== null
  })
}

const getStopReasonAssignments = ({
  status,
  stopReason,
}: {
  status?: JudgmentJobStatus
  stopReason: JudgmentJobStopReason | null
}) => {
  return stopReason !== null
    ? `stop_reason = ${getSqlLiteral(stopReason)}, stop_reason_at = current_timestamp`
    : status === 'running'
      ? 'stop_reason = NULL, stop_reason_at = NULL'
      : null
}

const getExpectedStatusPredicate = (expectedStatus: JudgmentJobStatus | null) => {
  return expectedStatus === null ? '' : `AND status = ${getSqlLiteral(expectedStatus)}`
}

export const updateJudgmentJobStatus = async ({
  clearTransientQuarantine = false,
  error,
  expectedStatus = null,
  jobId,
  status,
  stopConditionAssignments = [],
  stopReason = null,
}: {
  clearTransientQuarantine?: boolean
  error?: string[] | null
  expectedStatus?: JudgmentJobStatus | null
  jobId: string
  status?: JudgmentJobStatus
  stopConditionAssignments?: string[]
  stopReason?: JudgmentJobStopReason | null
}): Promise<JudgmentJobMutationState | null> => {
  const sqliteService = getJudgmentJobSqliteService()
  const assignments = [
    getStatusAssignments({error, status}),
    ...getStorageAssignments({clearTransientQuarantine, status}),
    getStopReasonAssignments({status, stopReason}),
    ...stopConditionAssignments,
    'updated_at = current_timestamp',
  ].filter((assignment): assignment is string => {
    return assignment !== null
  })
  const update = await getAppDatabaseService().transaction(async (tx) => {
    const [updated] = await tx.queryJson<{id: string}>(`
      UPDATE app.judgment_job
      SET ${assignments.join(', ')}
      WHERE id = '${escapeSqlString(jobId)}'
        ${getExpectedStatusPredicate(expectedStatus)}
      RETURNING id
    `)

    return {job: await getJudgmentJobMutationState(tx, jobId), updated: updated !== undefined}
  })

  if (update.updated && status === 'paused') {
    await sqliteService.clearActiveQueue(jobId)
  }

  if (update.updated && status !== undefined && status !== 'running') {
    await sqliteService.releaseOwnedLease(jobId)
  }

  return update.job
}

export const pauseJudgmentJobForStopCondition = async ({
  jobId,
  stopReason,
}: {
  jobId: string
  stopReason: JudgmentJobStopReason
}): Promise<boolean> => {
  const job = await updateJudgmentJobStatus({expectedStatus: 'running', jobId, status: 'paused', stopReason})

  return job?.status === 'paused' && job.stopReason === stopReason
}
