import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getDateValue, getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {HttpError} from '../../utils/httpError.ts'
import {getDefaultJudgmentServerJobId} from './judgmentJobServerIdentity.ts'
import {flushJudgmentJobSqliteOutbox} from './judgmentJobSqliteOutboxImport.ts'
import {getJudgmentJobSqliteService} from './judgmentJobSqliteService.ts'

export type JudgmentJobRepairAction = 'checkpoint' | 'drain' | 'preflight' | 'quarantine' | 'repair' | 'unquarantine'

type JudgmentJobRepairJobState = {
  id: string
  status: string
  storageState: string
  quarantinedAt: Date | null
  quarantineReason: string | null
  lastImportStartedAt: Date | null
  lastImportCompletedAt: Date | null
  lastImportErrorAt: Date | null
  lastImportError: string | null
  lastImportExitCode: number | null
  importFailureCount: number
  pauseRequestedAt: Date | null
  updatedAt: Date | null
}

type JudgmentJobRepairChanges = {
  checkpointed: boolean
  finalizedDrain: boolean
  importedOutboxRows: number
  initializedSqlite: boolean
  prunedOutboxRows: number
  prunedQueueRows: number
  quarantined: boolean
  reapedOutboxClaims: number
  requeuedSentPrompts: number
  unquarantined: boolean
}

type JudgmentJobRepairResult = {
  action: JudgmentJobRepairAction
  changes: JudgmentJobRepairChanges
  job: JudgmentJobRepairJobState
  jobId: string
  liveSqlite: Awaited<ReturnType<ReturnType<typeof getJudgmentJobSqliteService>['getHealthSnapshot']>>
  message: string
  ok: boolean
  preflight: Awaited<ReturnType<ReturnType<typeof getJudgmentJobSqliteService>['runIsolatedPreflight']>> | null
  requestedBy: string
}

type JobRepairActionInput = {
  action: JudgmentJobRepairAction
  claimedBy?: string | null
  jobId: string
  reason?: string | null
}
type RepairActionOutcome = {
  changes: JudgmentJobRepairChanges
  message: string
  ok: boolean
  preflight?: Awaited<ReturnType<ReturnType<typeof getJudgmentJobSqliteService>['runIsolatedPreflight']>> | null
}
type RetentionPruneResult = {outboxRowsDeleted: number; queuePromptRowsDeleted: number}
type RawRepairJobRow = {
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
  updatedAt: unknown
}

const defaultManualQuarantineReason = 'Manually quarantined by operator'
const retentionPruneChunkSize = 1_000

const getEmptyRepairChanges = (): JudgmentJobRepairChanges => {
  return {
    checkpointed: false,
    finalizedDrain: false,
    importedOutboxRows: 0,
    initializedSqlite: false,
    prunedOutboxRows: 0,
    prunedQueueRows: 0,
    quarantined: false,
    reapedOutboxClaims: 0,
    requeuedSentPrompts: 0,
    unquarantined: false,
  }
}

const getRepairJob = async (jobId: string): Promise<JudgmentJobRepairJobState> => {
  const [job] = await getAppDatabaseService().queryJson<RawRepairJobRow>(`
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
      updated_at AS updatedAt
    FROM app.judgment_job
    WHERE id = ${getSqlLiteral(jobId)}
    LIMIT 1
  `)

  if (!job) {
    throw new HttpError(404, `Job ${jobId} not found`)
  }

  return {
    id: job.id,
    status: job.status,
    storageState: job.storageState,
    quarantinedAt: getDateValue(job.quarantinedAt),
    quarantineReason: job.quarantineReason,
    lastImportStartedAt: getDateValue(job.lastImportStartedAt),
    lastImportCompletedAt: getDateValue(job.lastImportCompletedAt),
    lastImportErrorAt: getDateValue(job.lastImportErrorAt),
    lastImportError: job.lastImportError,
    lastImportExitCode: job.lastImportExitCode,
    importFailureCount: Number(job.importFailureCount ?? 0),
    pauseRequestedAt: getDateValue(job.pauseRequestedAt),
    updatedAt: getDateValue(job.updatedAt),
  }
}

const getRepairResult = async ({
  action,
  changes,
  jobId,
  message,
  ok,
  preflight = null,
  requestedBy,
}: {
  action: JudgmentJobRepairAction
  changes: JudgmentJobRepairChanges
  jobId: string
  message: string
  ok: boolean
  preflight?: Awaited<ReturnType<ReturnType<typeof getJudgmentJobSqliteService>['runIsolatedPreflight']>> | null
  requestedBy: string
}): Promise<JudgmentJobRepairResult> => {
  const sqliteService = getJudgmentJobSqliteService()
  const [job, liveSqlite] = await Promise.all([getRepairJob(jobId), sqliteService.getHealthSnapshot(jobId)])

  return {action, changes, job, jobId, liveSqlite, message, ok, preflight, requestedBy}
}

const setJobQuarantine = async ({jobId, reason}: {jobId: string; reason: string}) => {
  await getAppDatabaseService().run(`
    UPDATE app.judgment_job
    SET status = 'failed',
        storage_state = 'quarantined',
        quarantined_at = current_timestamp,
        quarantine_reason = ${getSqlLiteral(reason)},
        updated_at = current_timestamp
    WHERE id = ${getSqlLiteral(jobId)}
  `)
}

const clearJobQuarantine = async (jobId: string) => {
  await getAppDatabaseService().run(`
    UPDATE app.judgment_job
    SET status = CASE WHEN status = 'failed' THEN 'paused' ELSE status END,
        storage_state = 'active',
        quarantined_at = NULL,
        quarantine_reason = NULL,
        updated_at = current_timestamp
    WHERE id = ${getSqlLiteral(jobId)}
  `)
}

const markJobDraining = async (jobId: string) => {
  await getAppDatabaseService().run(`
    UPDATE app.judgment_job
    SET status = CASE WHEN status = 'running' THEN 'paused' ELSE status END,
        storage_state = 'draining',
        pause_requested_at = current_timestamp,
        updated_at = current_timestamp
    WHERE id = ${getSqlLiteral(jobId)}
  `)
}

const addPruneResults = (left: RetentionPruneResult, right: RetentionPruneResult): RetentionPruneResult => {
  return {
    outboxRowsDeleted: left.outboxRowsDeleted + right.outboxRowsDeleted,
    queuePromptRowsDeleted: left.queuePromptRowsDeleted + right.queuePromptRowsDeleted,
  }
}

const pruneRetentionUntilStable = async ({
  claimedBy,
  jobId,
  total = {outboxRowsDeleted: 0, queuePromptRowsDeleted: 0},
}: {
  claimedBy: string
  jobId: string
  total?: RetentionPruneResult
}): Promise<RetentionPruneResult> => {
  const current = await getJudgmentJobSqliteService().pruneVisibilityAckedRetention({
    jobId,
    maxRows: retentionPruneChunkSize,
    serverJobId: claimedBy,
  })

  return current.outboxRowsDeleted === 0 && current.queuePromptRowsDeleted === 0
    ? total
    : pruneRetentionUntilStable({claimedBy, jobId, total: addPruneResults(total, current)})
}

const getPreflightOutcome = async (jobId: string) => {
  try {
    const preflight = await getJudgmentJobSqliteService().runIsolatedPreflight(jobId)
    return {message: `SQLite preflight succeeded for ${jobId}`, ok: true, preflight}
  } catch (error) {
    return {message: error instanceof Error ? error.message : String(error), ok: false, preflight: null}
  }
}

const runPreflightAction = async ({jobId}: {jobId: string}): Promise<RepairActionOutcome> => {
  const outcome = await getPreflightOutcome(jobId)
  return {changes: getEmptyRepairChanges(), message: outcome.message, ok: outcome.ok, preflight: outcome.preflight}
}

const runCheckpointAction = async ({
  claimedBy,
  jobId,
}: {
  claimedBy: string
  jobId: string
}): Promise<RepairActionOutcome> => {
  const sqliteService = getJudgmentJobSqliteService()

  if (!sqliteService.hasJob(jobId)) {
    return {
      changes: getEmptyRepairChanges(),
      message: `SQLite job DB is missing for ${jobId}`,
      ok: false,
      preflight: null,
    }
  }

  const checkpointed = await sqliteService.checkpointWal({jobId, serverJobId: claimedBy})

  return {
    changes: {...getEmptyRepairChanges(), checkpointed},
    message: checkpointed
      ? `SQLite WAL checkpoint succeeded for ${jobId}`
      : `SQLite WAL checkpoint could not complete for ${jobId}`,
    ok: checkpointed,
    preflight: null,
  }
}

const runQuarantineAction = async ({
  jobId,
  reason,
}: {
  jobId: string
  reason: string | null | undefined
}): Promise<RepairActionOutcome> => {
  await setJobQuarantine({jobId, reason: reason?.trim() || defaultManualQuarantineReason})

  return {
    changes: {...getEmptyRepairChanges(), quarantined: true},
    message: `Job ${jobId} is quarantined`,
    ok: true,
    preflight: null,
  }
}

const runUnquarantineAction = async ({jobId}: {jobId: string}): Promise<RepairActionOutcome> => {
  const sqliteService = getJudgmentJobSqliteService()

  if (!sqliteService.hasJob(jobId)) {
    return {
      changes: getEmptyRepairChanges(),
      message: `SQLite job DB is missing for ${jobId}`,
      ok: false,
      preflight: null,
    }
  }

  const outcome = await getPreflightOutcome(jobId)

  if (!outcome.ok) {
    return {changes: getEmptyRepairChanges(), message: outcome.message, ok: false, preflight: outcome.preflight}
  }

  await clearJobQuarantine(jobId)

  return {
    changes: {...getEmptyRepairChanges(), unquarantined: true},
    message: `Job ${jobId} is no longer quarantined`,
    ok: true,
    preflight: outcome.preflight,
  }
}

const runDrainAction = async ({
  claimedBy,
  job,
  jobId,
}: {
  claimedBy: string
  job: JudgmentJobRepairJobState
  jobId: string
}) => {
  const sqliteService = getJudgmentJobSqliteService()

  if (!sqliteService.hasJob(jobId)) {
    return {
      changes: getEmptyRepairChanges(),
      message: `SQLite job DB is missing for ${jobId}`,
      ok: false,
      preflight: null,
    }
  }

  if (job.storageState === 'quarantined') {
    return {
      changes: getEmptyRepairChanges(),
      message: `Job ${jobId} is quarantined. Repair or unquarantine it before draining.`,
      ok: false,
      preflight: null,
    }
  }

  await markJobDraining(jobId)
  await sqliteService.clearActiveQueue(jobId)
  await sqliteService.releaseOwnedLease(jobId)

  const importedOutboxRows = await flushJudgmentJobSqliteOutbox({claimedBy, jobId})
  const pruned = await pruneRetentionUntilStable({claimedBy, jobId})
  const finalizedDrain = (await sqliteService.finalizeDrainingJobs({jobId, serverJobId: claimedBy})).includes(jobId)
  const checkpointed = await sqliteService.checkpointWal({jobId, serverJobId: claimedBy})

  return {
    changes: {
      ...getEmptyRepairChanges(),
      checkpointed,
      finalizedDrain,
      importedOutboxRows,
      prunedOutboxRows: pruned.outboxRowsDeleted,
      prunedQueueRows: pruned.queuePromptRowsDeleted,
    },
    message: finalizedDrain ? `Drain cleanup completed for ${jobId}` : `Drain cleanup ran for ${jobId}`,
    ok: true,
    preflight: null,
  }
}

const runRepairAction = async ({
  claimedBy,
  job,
  jobId,
}: {
  claimedBy: string
  job: JudgmentJobRepairJobState
  jobId: string
}) => {
  const sqliteService = getJudgmentJobSqliteService()
  const initializedSqlite = !sqliteService.hasJob(jobId)

  if (initializedSqlite) {
    await sqliteService.initializeJob(jobId)
  }

  const preflightOutcome = await getPreflightOutcome(jobId)

  if (!preflightOutcome.ok) {
    await setJobQuarantine({jobId, reason: preflightOutcome.message})

    return {
      changes: {...getEmptyRepairChanges(), initializedSqlite, quarantined: true},
      message: preflightOutcome.message,
      ok: false,
      preflight: preflightOutcome.preflight,
    }
  }

  const requeuedSentPrompts = await sqliteService.requeueAbandonedSentPrompts({
    jobId,
    serverJobId: claimedBy,
    staleBefore: new Date(),
  })
  const reapedOutboxClaims = await sqliteService.reapStaleOutboxClaims({jobId, staleBefore: new Date()})
  const importedOutboxRows = await flushJudgmentJobSqliteOutbox({claimedBy, jobId})
  const pruned = await pruneRetentionUntilStable({claimedBy, jobId})
  const finalizedDrain = (await sqliteService.finalizeDrainingJobs({jobId, serverJobId: claimedBy})).includes(jobId)
  const checkpointed = await sqliteService.checkpointWal({jobId, serverJobId: claimedBy})
  const shouldUnquarantine = job.storageState === 'missing' || job.storageState === 'quarantined'

  if (shouldUnquarantine) {
    await clearJobQuarantine(jobId)
  }

  return {
    changes: {
      ...getEmptyRepairChanges(),
      checkpointed,
      finalizedDrain,
      importedOutboxRows,
      initializedSqlite,
      prunedOutboxRows: pruned.outboxRowsDeleted,
      prunedQueueRows: pruned.queuePromptRowsDeleted,
      reapedOutboxClaims,
      requeuedSentPrompts,
      unquarantined: shouldUnquarantine,
    },
    message: `Repair completed for ${jobId}`,
    ok: true,
    preflight: preflightOutcome.preflight,
  }
}

export const runJudgmentJobRepairAction = async ({
  action,
  claimedBy,
  jobId,
  reason,
}: JobRepairActionInput): Promise<JudgmentJobRepairResult> => {
  const requestedBy = claimedBy ?? getDefaultJudgmentServerJobId()
  const sqliteService = getJudgmentJobSqliteService()
  const job = await getRepairJob(jobId)

  try {
    const outcome =
      action === 'preflight'
        ? await runPreflightAction({jobId})
        : action === 'checkpoint'
          ? await runCheckpointAction({claimedBy: requestedBy, jobId})
          : action === 'quarantine'
            ? await runQuarantineAction({jobId, reason})
            : action === 'unquarantine'
              ? await runUnquarantineAction({jobId})
              : action === 'drain'
                ? await runDrainAction({claimedBy: requestedBy, job, jobId})
                : await runRepairAction({claimedBy: requestedBy, job, jobId})

    return getRepairResult({
      action,
      changes: outcome.changes,
      jobId,
      message: outcome.message,
      ok: outcome.ok,
      preflight: outcome.preflight,
      requestedBy,
    })
  } finally {
    await sqliteService.releaseOwnedLease(jobId)
  }
}
