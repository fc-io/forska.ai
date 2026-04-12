import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getDateValue, getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {HttpError} from '../../utils/httpError.ts'
import {getDefaultJudgmentServerJobId} from './judgmentJobServerIdentity.ts'
import {runJudgmentJobSqliteIsolatedFlush} from './judgmentJobSqliteIsolatedImport.ts'
import {
  getJudgmentJobSqliteService,
  type JudgmentJobSystemSqliteFallbackResult,
  type JudgmentJobSystemSqliteFallbackStep,
} from './judgmentJobSqliteService.ts'
import {getJudgmentJobRepairMode} from './judgmentJobStoragePolicy.ts'

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
  deletedOrphanedJudgedRows: number
  finalizedDrain: boolean
  importedOutboxRows: number
  initializedSqlite: boolean
  prunedOutboxRows: number
  prunedQueueRows: number
  quarantined: boolean
  reapedOutboxClaims: number
  requeuedOrphanedJudgedRows: number
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
  systemSqliteFallback: {
    requestedSteps: JudgmentJobSystemSqliteFallbackStep[]
    results: JudgmentJobSystemSqliteFallbackResult[]
  }
}

type JobRepairActionInput = {
  action: JudgmentJobRepairAction
  allowOfflineRepairForQuarantinedLocalState?: boolean
  claimedBy?: string | null
  jobId: string
  reason?: string | null
  systemSqliteFallbackSteps?: JudgmentJobSystemSqliteFallbackStep[] | null
}
type RepairActionOutcome = {
  changes: JudgmentJobRepairChanges
  message: string
  ok: boolean
  preflight?: Awaited<ReturnType<ReturnType<typeof getJudgmentJobSqliteService>['runIsolatedPreflight']>> | null
  systemSqliteFallbackResults?: JudgmentJobSystemSqliteFallbackResult[]
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
const allowedSystemSqliteFallbackSteps = new Set<JudgmentJobSystemSqliteFallbackStep>([
  'checkpoint',
  'diagnostic',
  'export',
])

const getEmptyRepairChanges = (): JudgmentJobRepairChanges => {
  return {
    checkpointed: false,
    deletedOrphanedJudgedRows: 0,
    finalizedDrain: false,
    importedOutboxRows: 0,
    initializedSqlite: false,
    prunedOutboxRows: 0,
    prunedQueueRows: 0,
    quarantined: false,
    reapedOutboxClaims: 0,
    requeuedOrphanedJudgedRows: 0,
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
  systemSqliteFallbackResults = [],
  systemSqliteFallbackSteps = [],
}: {
  action: JudgmentJobRepairAction
  changes: JudgmentJobRepairChanges
  jobId: string
  message: string
  ok: boolean
  preflight?: Awaited<ReturnType<ReturnType<typeof getJudgmentJobSqliteService>['runIsolatedPreflight']>> | null
  requestedBy: string
  systemSqliteFallbackResults?: JudgmentJobSystemSqliteFallbackResult[]
  systemSqliteFallbackSteps?: JudgmentJobSystemSqliteFallbackStep[]
}): Promise<JudgmentJobRepairResult> => {
  const sqliteService = getJudgmentJobSqliteService()
  const [jobResult, liveSqliteResult] = await Promise.allSettled([
    getRepairJob(jobId),
    sqliteService.getHealthSnapshot(jobId),
  ])
  const job = jobResult.status === 'fulfilled' ? jobResult.value : await getRepairJob(jobId)
  const liveSqlite =
    liveSqliteResult.status === 'fulfilled'
      ? liveSqliteResult.value
      : {
          claimedOutboxCount: 0,
          lastAckSeq: null,
          oldestUnexportedAgeMs: null,
          orphanedJudgedRowCount: 0,
          outboxRowCount: 0,
          promptCounts: {claimed: 0, judged: 0, ready: 0, running: 0, skipped: 0},
          retainedRowCount: 0,
          sqliteFileBytes: null,
          walBytes: 0,
        }

  return {
    action,
    changes,
    job,
    jobId,
    liveSqlite,
    message,
    ok,
    preflight,
    requestedBy,
    systemSqliteFallback: {requestedSteps: systemSqliteFallbackSteps, results: systemSqliteFallbackResults},
  }
}

const normalizeSystemSqliteFallbackSteps = (steps: JudgmentJobSystemSqliteFallbackStep[] | null | undefined) => {
  return [
    ...new Set(
      (steps ?? []).filter((step) => {
        return allowedSystemSqliteFallbackSteps.has(step)
      }),
    ),
  ]
}

const appendFallbackMessage = ({
  baseMessage,
  fallbackResults,
}: {
  baseMessage: string
  fallbackResults: JudgmentJobSystemSqliteFallbackResult[]
}) => {
  const ranSteps = fallbackResults.map((result) => {
    return result.step
  })

  return ranSteps.length === 0 ? baseMessage : `${baseMessage} System sqlite3 fallback ran: ${ranSteps.join(', ')}.`
}

const runSystemSqliteFallback = async ({
  claimedBy,
  jobId,
  steps,
}: {
  claimedBy: string
  jobId: string
  steps: JudgmentJobSystemSqliteFallbackStep[]
}) => {
  return steps.length === 0
    ? []
    : getJudgmentJobSqliteService().runSystemSqliteFallback({jobId, serverJobId: claimedBy, steps})
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
        import_failure_count = 0,
        last_import_error = NULL,
        last_import_error_at = NULL,
        updated_at = current_timestamp
    WHERE id = ${getSqlLiteral(jobId)}
  `)
}

const restoreJobForResumedLocalQueue = async (jobId: string) => {
  await getAppDatabaseService().run(`
    UPDATE app.judgment_job
    SET status = CASE
          WHEN status IN ('completed', 'failed', 'project_removed') THEN 'paused'
          ELSE status
        END,
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

const getRepairMode = ({hasLocalSqlite, job}: {hasLocalSqlite: boolean; job: JudgmentJobRepairJobState}) => {
  return getJudgmentJobRepairMode({hasLocalSqliteState: hasLocalSqlite, job})
}

const runLiveSafeFlush = async ({claimedBy, jobId}: {claimedBy: string; jobId: string}) => {
  const result = await runJudgmentJobSqliteIsolatedFlush({claimedBy, jobId})

  return result.errorMessage === null
    ? {errorMessage: null, importedOutboxRows: result.importedCount}
    : {errorMessage: result.errorMessage, importedOutboxRows: result.importedCount}
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
  systemSqliteFallbackSteps,
}: {
  claimedBy: string
  jobId: string
  systemSqliteFallbackSteps: JudgmentJobSystemSqliteFallbackStep[]
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
  const systemSqliteFallbackResults = checkpointed
    ? []
    : await runSystemSqliteFallback({claimedBy, jobId, steps: systemSqliteFallbackSteps})
  const fallbackCheckpointed = systemSqliteFallbackResults.some((result) => {
    return result.step === 'checkpoint' && result.ok
  })
  const finalCheckpointed = checkpointed || fallbackCheckpointed

  return {
    changes: {...getEmptyRepairChanges(), checkpointed: finalCheckpointed},
    message: appendFallbackMessage({
      baseMessage: finalCheckpointed
        ? `SQLite WAL checkpoint succeeded for ${jobId}`
        : `SQLite WAL checkpoint could not complete for ${jobId}`,
      fallbackResults: systemSqliteFallbackResults,
    }),
    ok: finalCheckpointed,
    preflight: null,
    systemSqliteFallbackResults,
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
  systemSqliteFallbackSteps,
}: {
  claimedBy: string
  job: JudgmentJobRepairJobState
  jobId: string
  systemSqliteFallbackSteps: JudgmentJobSystemSqliteFallbackStep[]
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
      message: `Job ${jobId} is quarantined. Live drain is disabled while local SQLite state is quarantined. Run offline repair first.`,
      ok: false,
      preflight: null,
    }
  }

  await markJobDraining(jobId)
  await sqliteService.clearActiveQueue(jobId)
  await sqliteService.releaseOwnedLease(jobId)

  const flushResult = await runLiveSafeFlush({claimedBy, jobId})

  if (flushResult.errorMessage) {
    return {
      changes: {...getEmptyRepairChanges(), importedOutboxRows: flushResult.importedOutboxRows},
      message: `Drain cleanup stopped safely for ${jobId}: ${flushResult.errorMessage}`,
      ok: false,
      preflight: null,
    }
  }

  const importedOutboxRows = flushResult.importedOutboxRows
  const pruned = await pruneRetentionUntilStable({claimedBy, jobId})
  const nativeFinalizedDrain = (await sqliteService.finalizeDrainingJobs({jobId, serverJobId: claimedBy})).includes(
    jobId,
  )
  const nativeCheckpointed = await sqliteService.checkpointWal({jobId, serverJobId: claimedBy})
  const systemSqliteFallbackResults = nativeCheckpointed
    ? []
    : await runSystemSqliteFallback({claimedBy, jobId, steps: systemSqliteFallbackSteps})
  const fallbackCheckpointed = systemSqliteFallbackResults.some((result) => {
    return result.step === 'checkpoint' && result.ok
  })
  const checkpointed = nativeCheckpointed || fallbackCheckpointed
  const finalizedDrain = nativeFinalizedDrain

  return {
    changes: {
      ...getEmptyRepairChanges(),
      checkpointed,
      finalizedDrain,
      importedOutboxRows,
      prunedOutboxRows: pruned.outboxRowsDeleted,
      prunedQueueRows: pruned.queuePromptRowsDeleted,
    },
    message: appendFallbackMessage({
      baseMessage: finalizedDrain ? `Drain cleanup completed for ${jobId}` : `Drain cleanup ran for ${jobId}`,
      fallbackResults: systemSqliteFallbackResults,
    }),
    ok: true,
    preflight: null,
    systemSqliteFallbackResults,
  }
}

const runRepairAction = async ({
  allowOfflineRepairForQuarantinedLocalState = false,
  claimedBy,
  job,
  jobId,
  systemSqliteFallbackSteps,
}: {
  allowOfflineRepairForQuarantinedLocalState?: boolean
  claimedBy: string
  job: JudgmentJobRepairJobState
  jobId: string
  systemSqliteFallbackSteps: JudgmentJobSystemSqliteFallbackStep[]
}) => {
  const sqliteService = getJudgmentJobSqliteService()
  const initializedSqlite = !sqliteService.hasJob(jobId)

  if (initializedSqlite) {
    await sqliteService.initializeJob(jobId)
  }

  const preflightOutcome = await getPreflightOutcome(jobId)
  const initialFallbackResults = preflightOutcome.ok
    ? []
    : await runSystemSqliteFallback({claimedBy, jobId, steps: systemSqliteFallbackSteps})
  const fallbackCheckpointed = initialFallbackResults.some((result) => {
    return result.step === 'checkpoint' && result.ok
  })
  const recoveredPreflightOutcome =
    !preflightOutcome.ok && fallbackCheckpointed ? await getPreflightOutcome(jobId) : preflightOutcome
  const repairMode = getRepairMode({hasLocalSqlite: !initializedSqlite, job})

  if (!recoveredPreflightOutcome.ok) {
    await setJobQuarantine({jobId, reason: recoveredPreflightOutcome.message})

    return {
      changes: {...getEmptyRepairChanges(), initializedSqlite, quarantined: true},
      message: appendFallbackMessage({
        baseMessage: recoveredPreflightOutcome.message,
        fallbackResults: initialFallbackResults,
      }),
      ok: false,
      preflight: recoveredPreflightOutcome.preflight,
      systemSqliteFallbackResults: initialFallbackResults,
    }
  }

  if (repairMode === 'offline_repair_required' && !allowOfflineRepairForQuarantinedLocalState) {
    return {
      changes: {...getEmptyRepairChanges(), initializedSqlite},
      message:
        `Live repair is disabled for ${jobId} because this quarantined job still has local SQLite state. `
        + `Keep the job quarantined and run offline repair after stopping the server stack, for example: `
        + `bun scripts/runJudgmentJobRepair.ts --action=repair --jobId=${jobId}`,
      ok: false,
      preflight: recoveredPreflightOutcome.preflight,
      systemSqliteFallbackResults: initialFallbackResults,
    }
  }

  await sqliteService.releaseOwnedLease(jobId)

  const flushResult = await runLiveSafeFlush({claimedBy, jobId})

  if (flushResult.errorMessage) {
    return {
      changes: {...getEmptyRepairChanges(), importedOutboxRows: flushResult.importedOutboxRows, initializedSqlite},
      message: `Repair stopped safely for ${jobId}: ${flushResult.errorMessage}`,
      ok: false,
      preflight: recoveredPreflightOutcome.preflight,
      systemSqliteFallbackResults: initialFallbackResults,
    }
  }

  const requeuedSentPromptsCount = await sqliteService.requeueAbandonedSentPrompts({
    jobId,
    serverJobId: claimedBy,
    staleBefore: new Date(),
  })
  const reapedOutboxClaimsCount = await sqliteService.reapStaleOutboxClaims({jobId, staleBefore: new Date()})
  const orphanedQueueRepair = await sqliteService.repairOrphanedJudgedQueueRows({
    jobId,
    maxRows: retentionPruneChunkSize,
    serverJobId: claimedBy,
  })

  if (orphanedQueueRepair.requeuedRows > 0) {
    await restoreJobForResumedLocalQueue(jobId)

    return {
      changes: {
        ...getEmptyRepairChanges(),
        deletedOrphanedJudgedRows: orphanedQueueRepair.deletedRows,
        importedOutboxRows: flushResult.importedOutboxRows,
        initializedSqlite,
        reapedOutboxClaims: reapedOutboxClaimsCount,
        requeuedOrphanedJudgedRows: orphanedQueueRepair.requeuedRows,
        requeuedSentPrompts: requeuedSentPromptsCount,
        unquarantined: true,
      },
      message: appendFallbackMessage({
        baseMessage: `Repair restored ${orphanedQueueRepair.requeuedRows} orphaned local queue row(s) for ${jobId}`,
        fallbackResults: initialFallbackResults,
      }),
      ok: true,
      preflight: recoveredPreflightOutcome.preflight,
      systemSqliteFallbackResults: initialFallbackResults,
    }
  }

  const importedOutboxRows = flushResult.importedOutboxRows
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
      deletedOrphanedJudgedRows: orphanedQueueRepair.deletedRows,
      finalizedDrain,
      importedOutboxRows,
      initializedSqlite,
      prunedOutboxRows: pruned.outboxRowsDeleted,
      prunedQueueRows: pruned.queuePromptRowsDeleted,
      reapedOutboxClaims: reapedOutboxClaimsCount,
      requeuedOrphanedJudgedRows: orphanedQueueRepair.requeuedRows,
      requeuedSentPrompts: requeuedSentPromptsCount,
      unquarantined: shouldUnquarantine,
    },
    message: appendFallbackMessage({
      baseMessage: `Repair completed for ${jobId}`,
      fallbackResults: initialFallbackResults,
    }),
    ok: true,
    preflight: recoveredPreflightOutcome.preflight,
    systemSqliteFallbackResults: initialFallbackResults,
  }
}

export const runJudgmentJobRepairAction = async ({
  action,
  allowOfflineRepairForQuarantinedLocalState,
  claimedBy,
  jobId,
  reason,
  systemSqliteFallbackSteps,
}: JobRepairActionInput): Promise<JudgmentJobRepairResult> => {
  const requestedBy = claimedBy ?? getDefaultJudgmentServerJobId()
  const sqliteService = getJudgmentJobSqliteService()
  const job = await getRepairJob(jobId)
  const normalizedFallbackSteps = normalizeSystemSqliteFallbackSteps(systemSqliteFallbackSteps)

  try {
    const outcome =
      action === 'preflight'
        ? await runPreflightAction({jobId})
        : action === 'checkpoint'
          ? await runCheckpointAction({
              claimedBy: requestedBy,
              jobId,
              systemSqliteFallbackSteps: normalizedFallbackSteps,
            })
          : action === 'quarantine'
            ? await runQuarantineAction({jobId, reason})
            : action === 'unquarantine'
              ? await runUnquarantineAction({jobId})
              : action === 'drain'
                ? await runDrainAction({
                    claimedBy: requestedBy,
                    job,
                    jobId,
                    systemSqliteFallbackSteps: normalizedFallbackSteps,
                  })
                : await runRepairAction({
                    allowOfflineRepairForQuarantinedLocalState,
                    claimedBy: requestedBy,
                    job,
                    jobId,
                    systemSqliteFallbackSteps: normalizedFallbackSteps,
                  })

    return getRepairResult({
      action,
      changes: outcome.changes,
      jobId,
      message: outcome.message,
      ok: outcome.ok,
      preflight: outcome.preflight,
      requestedBy,
      systemSqliteFallbackResults: outcome.systemSqliteFallbackResults,
      systemSqliteFallbackSteps: normalizedFallbackSteps,
    })
  } finally {
    await sqliteService.releaseOwnedLease(jobId)
  }
}
