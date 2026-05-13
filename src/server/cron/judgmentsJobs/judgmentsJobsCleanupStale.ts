import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getQuotedStringList, getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {getJudgeWorkerReadOnlyAppDatabaseService} from '../../services/appReadOnlyDatabaseService.ts'
import {pruneJudgmentProviderTelemetryHistorySamples} from '../../services/judgmentProviderTelemetryHistoryService.ts'
import {isJudgmentJobLeaseProcessAlive, isJudgmentJobLeaseStale} from './judgmentJobLease.ts'
import {getJudgmentJobSqliteJobIds} from './judgmentJobPaths.ts'
import {runJudgmentJobRepairAction} from './judgmentJobRepair.ts'
import {getDefaultJudgmentServerJobId} from './judgmentJobServerIdentity.ts'
import {getJudgmentJobSqliteService, JudgmentJobLeaseError} from './judgmentJobSqliteService.ts'
import {getTransientJudgmentJobSqliteLockReasonSql} from './judgmentJobSqliteTransientLock.ts'
import {type JudgmentRequestAttemptCloseoutProof} from './judgmentRequestAttemptManifest.ts'
import {reconcileProviderAdmissionLeasesThroughOwner} from './providerAdmissionLease.ts'
import {abandonedSentPromptGraceMs} from './requeueAbandonedSentPrompts.ts'

type RetentionPruneResult = {outboxRowsDeleted: number; queuePromptRowsDeleted: number}

const sqliteRetentionCleanupBatchSize = 1_000
const sqliteCleanupTerminalStatuses = ['completed', 'paused', 'project_removed'] as const
const transientLockedQuarantineRecoveryBatchSize = 5

const getEmptyRetentionPruneResult = (): RetentionPruneResult => {
  return {outboxRowsDeleted: 0, queuePromptRowsDeleted: 0}
}

const addRetentionPruneResults = (left: RetentionPruneResult, right: RetentionPruneResult): RetentionPruneResult => {
  return {
    outboxRowsDeleted: left.outboxRowsDeleted + right.outboxRowsDeleted,
    queuePromptRowsDeleted: left.queuePromptRowsDeleted + right.queuePromptRowsDeleted,
  }
}

const getUniqueRequestAttemptCloseoutKey = (closeout: {providerKey: string; requestAttemptId: string}) => {
  return `${closeout.providerKey}\n${closeout.requestAttemptId}`
}

const getUniqueRequestAttemptCloseouts = <TCloseout extends {providerKey: string; requestAttemptId: string}>(
  closeouts: TCloseout[],
): TCloseout[] => {
  return Array.from(
    closeouts
      .reduce<Map<string, TCloseout>>((acc, closeout) => {
        const key = getUniqueRequestAttemptCloseoutKey(closeout)

        if (!acc.has(key)) {
          acc.set(key, closeout)
        }

        return acc
      }, new Map())
      .values(),
  )
}

const getDuckdbProjectedTerminalRequestAttemptCloseouts = async (): Promise<JudgmentRequestAttemptCloseoutProof[]> => {
  const rows = await getAppDatabaseService().queryJson<JudgmentRequestAttemptCloseoutProof>(`
    SELECT DISTINCT
      closeout.provider_key AS providerKey,
      closeout.request_attempt_id AS requestAttemptId
    FROM app.provider_admission_lease lease
    INNER JOIN app.request_attempt_closeout closeout
      ON closeout.provider_key = lease.provider_key
     AND closeout.request_attempt_id = lease.request_attempt_id
    WHERE lease.lease_kind = 'request'
      AND lease.request_attempt_id IS NOT NULL
      AND length(trim(lease.request_attempt_id)) > 0
      AND lease.expires_at > current_timestamp
    ORDER BY providerKey ASC, requestAttemptId ASC
  `)

  return getUniqueRequestAttemptCloseouts(rows)
}

export const reconcileProviderAdmissionLeasesForDurableCloseout = async (): Promise<void> => {
  const [projectionCloseouts, sqliteCloseouts] = await Promise.all([
    getDuckdbProjectedTerminalRequestAttemptCloseouts(),
    getJudgmentJobSqliteService().getDurableTerminalRequestAttemptCloseoutProofs(),
  ])

  await reconcileProviderAdmissionLeasesThroughOwner({
    terminalRequestAttemptCloseouts: [...projectionCloseouts, ...sqliteCloseouts],
  })
}

const getDrainingSqliteJobIds = async () => {
  const sqliteJobIds = getJudgmentJobSqliteJobIds()

  return sqliteJobIds.length === 0
    ? []
    : (
        await getJudgeWorkerReadOnlyAppDatabaseService().queryJson<{id: string}>(`
          SELECT id
          FROM app.judgment_job
          WHERE id IN (${getQuotedStringList(sqliteJobIds).join(', ')})
            AND storage_state = ${getSqlLiteral('draining')}
        `)
      ).map((row) => {
        return row.id
      })
}

const getTransientLockedQuarantinedSqliteJobIds = async () => {
  const sqliteJobIds = getJudgmentJobSqliteJobIds()

  return sqliteJobIds.length === 0
    ? []
    : (
        await getJudgeWorkerReadOnlyAppDatabaseService().queryJson<{id: string}>(`
          SELECT id
          FROM app.judgment_job
          WHERE id IN (${getQuotedStringList(sqliteJobIds).join(', ')})
            AND storage_state = ${getSqlLiteral('quarantined')}
            AND (${getTransientJudgmentJobSqliteLockReasonSql('quarantine_reason')})
          ORDER BY quarantined_at ASC NULLS LAST, updated_at ASC
          LIMIT ${transientLockedQuarantineRecoveryBatchSize}
        `)
      ).map((row) => {
        return row.id
      })
}

const getMissingLocalSqliteDrainingJobIds = async () => {
  const sqliteJobIds = getJudgmentJobSqliteJobIds()
  const localSqliteExclusion =
    sqliteJobIds.length === 0 ? '' : `AND id NOT IN (${getQuotedStringList(sqliteJobIds).join(', ')})`

  return (
    await getJudgeWorkerReadOnlyAppDatabaseService().queryJson<{id: string}>(`
      SELECT id
      FROM app.judgment_job
      WHERE storage_state = ${getSqlLiteral('draining')}
        AND status IN (${getQuotedStringList([...sqliteCleanupTerminalStatuses]).join(', ')})
        ${localSqliteExclusion}
    `)
  ).map((row) => {
    return row.id
  })
}

const finalizeMissingLocalSqliteDrainingJobs = async (jobIds: string[]): Promise<void> => {
  return jobIds.length === 0
    ? Promise.resolve()
    : getAppDatabaseService().run(`
        UPDATE app.judgment_job
        SET storage_state = ${getSqlLiteral('drained')},
            updated_at = current_timestamp
        WHERE id IN (${getQuotedStringList(jobIds).join(', ')})
          AND storage_state = ${getSqlLiteral('draining')}
          AND status IN (${getQuotedStringList([...sqliteCleanupTerminalStatuses]).join(', ')})
      `)
}

const hasFreshLiveJudgmentJobLease = async (jobId: string) => {
  const leaseMetadata = await getJudgmentJobSqliteService().getJudgmentJobLeaseMetadata(jobId)

  return (
    leaseMetadata !== null && isJudgmentJobLeaseProcessAlive(leaseMetadata) && !isJudgmentJobLeaseStale(leaseMetadata)
  )
}

const recoverDrainingQueueRows = async ({
  jobIds,
  serverJobId,
}: {
  jobIds: string[]
  serverJobId: string
}): Promise<void> => {
  const [currentJobId = ''] = jobIds
  const sqliteService = getJudgmentJobSqliteService()

  if (!currentJobId) {
    return
  }

  try {
    await sqliteService.ensureOwnedLease(currentJobId, serverJobId)
    await sqliteService.requeueAbandonedSentPrompts({
      jobId: currentJobId,
      serverJobId,
      staleBefore: new Date(Date.now() - abandonedSentPromptGraceMs),
    })
    await sqliteService.clearActiveQueue(currentJobId)
  } catch (error) {
    if (!(error instanceof JudgmentJobLeaseError)) {
      throw error
    }
  }

  return recoverDrainingQueueRows({jobIds: jobIds.slice(1), serverJobId})
}

const repairOrphanedDrainingJobs = async (jobIds: string[]): Promise<void> => {
  const [currentJobId = ''] = jobIds
  const sqliteService = getJudgmentJobSqliteService()

  if (!currentJobId) {
    return
  }

  const healthSnapshot = await sqliteService.getHealthSnapshot(currentJobId)

  if (healthSnapshot.orphanedJudgedRowCount > 0) {
    await runJudgmentJobRepairAction({
      action: 'repair',
      claimedBy: getDefaultJudgmentServerJobId(),
      jobId: currentJobId,
    })
  }

  return repairOrphanedDrainingJobs(jobIds.slice(1))
}

const repairUnavailableRequestAttemptDiagnostics = async ({
  jobIds,
  serverJobId,
  staleBefore,
}: {
  jobIds: string[]
  serverJobId: string
  staleBefore: Date
}): Promise<void> => {
  const [currentJobId = ''] = jobIds

  if (!currentJobId) {
    return
  }

  try {
    await getJudgmentJobSqliteService().repairUnavailableRequestAttemptDiagnostics({
      jobId: currentJobId,
      serverJobId,
      staleBefore,
    })
  } catch (error) {
    if (!(error instanceof JudgmentJobLeaseError)) {
      throw error
    }
  }

  return repairUnavailableRequestAttemptDiagnostics({jobIds: jobIds.slice(1), serverJobId, staleBefore})
}

const pruneVisibilityAckedRetentionUntilStable = async ({
  jobId,
  serverJobId,
  total = getEmptyRetentionPruneResult(),
}: {
  jobId: string
  serverJobId: string
  total?: RetentionPruneResult
}): Promise<RetentionPruneResult> => {
  const current = await getJudgmentJobSqliteService().pruneVisibilityAckedRetention({
    jobId,
    maxRows: sqliteRetentionCleanupBatchSize,
    serverJobId,
  })

  return current.outboxRowsDeleted === 0 && current.queuePromptRowsDeleted === 0
    ? total
    : pruneVisibilityAckedRetentionUntilStable({jobId, serverJobId, total: addRetentionPruneResults(total, current)})
}

const pruneDrainingVisibilityAckedRetention = async ({
  jobIds,
  serverJobId,
}: {
  jobIds: string[]
  serverJobId: string
}): Promise<void> => {
  const [currentJobId = ''] = jobIds

  if (!currentJobId) {
    return
  }

  await pruneVisibilityAckedRetentionUntilStable({jobId: currentJobId, serverJobId})
  return pruneDrainingVisibilityAckedRetention({jobIds: jobIds.slice(1), serverJobId})
}

const recoverTransientLockedQuarantinedJobs = async ({
  jobIds,
  serverJobId,
}: {
  jobIds: string[]
  serverJobId: string
}): Promise<void> => {
  const [currentJobId = ''] = jobIds

  if (!currentJobId) {
    return
  }

  const hasFreshLiveLease = await hasFreshLiveJudgmentJobLease(currentJobId)

  if (!hasFreshLiveLease) {
    await runJudgmentJobRepairAction({action: 'unquarantine', claimedBy: serverJobId, jobId: currentJobId})
  }

  return recoverTransientLockedQuarantinedJobs({jobIds: jobIds.slice(1), serverJobId})
}

export const judgmentsJobsCleanupStale = async (): Promise<void> => {
  const sixteenMinutesAgo = new Date(Date.now() - 16 * 60 * 1000)
  const serverJobId = getDefaultJudgmentServerJobId()
  const sqliteService = getJudgmentJobSqliteService()
  const sqliteJobIds = getJudgmentJobSqliteJobIds()
  const [drainingJobIds, missingLocalSqliteDrainingJobIds, transientLockedQuarantinedJobIds] = await Promise.all([
    getDrainingSqliteJobIds(),
    getMissingLocalSqliteDrainingJobIds(),
    getTransientLockedQuarantinedSqliteJobIds(),
  ])

  await recoverTransientLockedQuarantinedJobs({jobIds: transientLockedQuarantinedJobIds, serverJobId})
  await sqliteService.reapStaleOutboxClaims({staleBefore: sixteenMinutesAgo})
  await recoverDrainingQueueRows({jobIds: drainingJobIds, serverJobId})
  await sqliteService.pruneVisibilityAckedRetention({maxRows: sqliteRetentionCleanupBatchSize})
  await pruneDrainingVisibilityAckedRetention({jobIds: drainingJobIds, serverJobId})
  await repairOrphanedDrainingJobs(drainingJobIds)
  await repairUnavailableRequestAttemptDiagnostics({jobIds: sqliteJobIds, serverJobId, staleBefore: sixteenMinutesAgo})
  await finalizeMissingLocalSqliteDrainingJobs(missingLocalSqliteDrainingJobIds)
  await pruneJudgmentProviderTelemetryHistorySamples()
  await sqliteService.finalizeDrainingJobs()
  await reconcileProviderAdmissionLeasesForDurableCloseout()
  await sqliteService.deleteDrainedJobs()
}
