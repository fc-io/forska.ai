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
type ActiveRequestLeaseCloseoutProbe = {providerKey: string; requestAttemptId: string}
type RecoverableOomQuarantinedJobRow = {id: string}

const sqliteRetentionCleanupBatchSize = 1_000
const duckdbProjectedCloseoutProbeBatchSize = 500
const recoverableOomQuarantineRecoveryBatchSize = 3
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

const getDuckdbActiveRequestLeaseCloseoutProbes = async (): Promise<ActiveRequestLeaseCloseoutProbe[]> => {
  const rows = await getAppDatabaseService().queryJson<ActiveRequestLeaseCloseoutProbe>(`
    SELECT
      provider_key AS providerKey,
      request_attempt_id AS requestAttemptId
    FROM app.provider_admission_lease
    WHERE lease_kind = 'request'
      AND request_attempt_id IS NOT NULL
      AND length(trim(request_attempt_id)) > 0
      AND expires_at > current_timestamp
    ORDER BY expires_at ASC, provider_key ASC, request_attempt_id ASC
    LIMIT ${duckdbProjectedCloseoutProbeBatchSize}
  `)

  return getUniqueRequestAttemptCloseouts(rows)
}

const getDuckdbProjectedTerminalRequestAttemptCloseout = async (
  lease: ActiveRequestLeaseCloseoutProbe,
): Promise<JudgmentRequestAttemptCloseoutProof | null> => {
  const [row] = await getAppDatabaseService().queryJson<JudgmentRequestAttemptCloseoutProof>(`
    SELECT
      closeout.provider_key AS providerKey,
      closeout.request_attempt_id AS requestAttemptId
    FROM app.request_attempt_closeout closeout
    WHERE closeout.provider_key = ${getSqlLiteral(lease.providerKey)}
      AND closeout.request_attempt_id = ${getSqlLiteral(lease.requestAttemptId)}
    LIMIT 1
  `)

  return row ?? null
}

const getDuckdbProjectedTerminalRequestAttemptCloseoutsForLeases = async (
  leases: ActiveRequestLeaseCloseoutProbe[],
): Promise<JudgmentRequestAttemptCloseoutProof[]> => {
  return leases.reduce<Promise<JudgmentRequestAttemptCloseoutProof[]>>(async (closeoutsPromise, lease) => {
    const closeouts = await closeoutsPromise
    const closeout = await getDuckdbProjectedTerminalRequestAttemptCloseout(lease)

    return closeout ? [...closeouts, closeout] : closeouts
  }, Promise.resolve([]))
}

const getDuckdbProjectedTerminalRequestAttemptCloseouts = async (): Promise<JudgmentRequestAttemptCloseoutProof[]> => {
  const leases = await getDuckdbActiveRequestLeaseCloseoutProbes()

  return getUniqueRequestAttemptCloseouts(await getDuckdbProjectedTerminalRequestAttemptCloseoutsForLeases(leases))
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

const getRecoverableOomQuarantinedJobIds = async () => {
  return (
    await getJudgeWorkerReadOnlyAppDatabaseService().queryJson<RecoverableOomQuarantinedJobRow>(`
      SELECT jj.id AS id
      FROM app.judgment_job jj
      INNER JOIN app.project_mart_refresh_state refresh_state ON refresh_state.project_id = jj.project_id
      WHERE jj.storage_state = ${getSqlLiteral('quarantined')}
        AND jj.status = ${getSqlLiteral('failed')}
        AND jj.pause_requested_at IS NULL
        AND (
          lower(COALESCE(jj.quarantine_reason, '')) LIKE '%out of memory%'
          OR lower(COALESCE(jj.last_import_error, '')) LIKE '%out of memory%'
          OR lower(COALESCE(jj.quarantine_reason, '')) LIKE '%failed to pin block%'
          OR lower(COALESCE(jj.last_import_error, '')) LIKE '%failed to pin block%'
        )
        AND refresh_state.dirty_token <= refresh_state.last_completed_dirty_token
        AND refresh_state.refresh_status = ${getSqlLiteral('idle')}
        AND NOT EXISTS (
          SELECT 1
          FROM app.project_mart_dirty_materialization_state materialization
          WHERE materialization.project_id = jj.project_id
            AND materialization.target_dirty_token <= refresh_state.dirty_token
            AND materialization.materialization_status <> ${getSqlLiteral('completed')}
        )
        AND NOT EXISTS (
          SELECT 1
          FROM app.project_mart_dirty_refresh_article_quarantine quarantine
          WHERE quarantine.project_id = jj.project_id
            AND quarantine.dirty_token <= refresh_state.dirty_token
            AND quarantine.resolved_at IS NULL
        )
      ORDER BY jj.quarantined_at ASC NULLS LAST, jj.updated_at ASC, jj.id ASC
      LIMIT ${recoverableOomQuarantineRecoveryBatchSize}
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

const resumeRecoveredOomQuarantinedJob = async (jobId: string): Promise<void> => {
  await getAppDatabaseService().run(`
    UPDATE app.judgment_job
    SET status = ${getSqlLiteral('running')},
        pause_requested_at = NULL,
        updated_at = current_timestamp
    WHERE id = ${getSqlLiteral(jobId)}
      AND storage_state = ${getSqlLiteral('active')}
      AND status = ${getSqlLiteral('paused')}
      AND pause_requested_at IS NULL
  `)
}

const recoverOomQuarantinedJobs = async ({
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

  const result = await runJudgmentJobRepairAction({action: 'unquarantine', claimedBy: serverJobId, jobId: currentJobId})

  if (result.ok && result.changes.unquarantined) {
    await resumeRecoveredOomQuarantinedJob(currentJobId)
  }

  return recoverOomQuarantinedJobs({jobIds: jobIds.slice(1), serverJobId})
}

export const judgmentsJobsCleanupStale = async (): Promise<void> => {
  const sixteenMinutesAgo = new Date(Date.now() - 16 * 60 * 1000)
  const serverJobId = getDefaultJudgmentServerJobId()
  const sqliteService = getJudgmentJobSqliteService()
  const sqliteJobIds = getJudgmentJobSqliteJobIds()
  const [
    drainingJobIds,
    missingLocalSqliteDrainingJobIds,
    recoverableOomQuarantinedJobIds,
    transientLockedQuarantinedJobIds,
  ] = await Promise.all([
    getDrainingSqliteJobIds(),
    getMissingLocalSqliteDrainingJobIds(),
    getRecoverableOomQuarantinedJobIds(),
    getTransientLockedQuarantinedSqliteJobIds(),
  ])

  await recoverTransientLockedQuarantinedJobs({jobIds: transientLockedQuarantinedJobIds, serverJobId})
  await recoverOomQuarantinedJobs({jobIds: recoverableOomQuarantinedJobIds, serverJobId})
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
