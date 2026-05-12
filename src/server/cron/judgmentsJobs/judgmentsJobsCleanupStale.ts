import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getJsonValue, getQuotedStringList, getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {getJudgeWorkerReadOnlyAppDatabaseService} from '../../services/appReadOnlyDatabaseService.ts'
import {pruneJudgmentProviderTelemetryHistorySamples} from '../../services/judgmentProviderTelemetryHistoryService.ts'
import {isJudgmentJobLeaseProcessAlive, isJudgmentJobLeaseStale} from './judgmentJobLease.ts'
import {getJudgmentJobSqliteJobIds} from './judgmentJobPaths.ts'
import {runJudgmentJobRepairAction} from './judgmentJobRepair.ts'
import {getDefaultJudgmentServerJobId} from './judgmentJobServerIdentity.ts'
import {getJudgmentJobSqliteService, JudgmentJobLeaseError} from './judgmentJobSqliteService.ts'
import {getTransientJudgmentJobSqliteLockReasonSql} from './judgmentJobSqliteTransientLock.ts'
import {
  getDurableTerminalRequestAttemptCloseoutProofs,
  type JudgmentRequestAttemptCloseoutProof,
  type JudgmentRequestAttemptJsonEntry,
  parseRequestAttempts,
} from './judgmentRequestAttemptManifest.ts'
import {reconcileProviderAdmissionLeasesThroughOwner} from './providerAdmissionLease.ts'
import {abandonedSentPromptGraceMs} from './requeueAbandonedSentPrompts.ts'

type RetentionPruneResult = {outboxRowsDeleted: number; queuePromptRowsDeleted: number}
type RequestAttemptsJsonRow = {requestAttemptsJson: unknown}
type ProviderRequestLeaseRow = {requestAttemptId: string}

const sqliteRetentionCleanupBatchSize = 1_000
const sqliteCleanupTerminalStatuses = ['completed', 'paused', 'project_removed'] as const
const tokenUseCloseoutLookupBatchSize = 128
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

const getRequestAttemptsFromDuckdbJson = (value: unknown): JudgmentRequestAttemptJsonEntry[] => {
  const parsed = getJsonValue(value)

  return parseRequestAttempts(Array.isArray(parsed) ? (parsed as JudgmentRequestAttemptJsonEntry[]) : null)
}

const getUniqueTrimmedValues = (values: string[]) => {
  return Array.from(
    values.reduce<Set<string>>((acc, value) => {
      const trimmedValue = value.trim()

      if (trimmedValue.length > 0) {
        acc.add(trimmedValue)
      }

      return acc
    }, new Set()),
  )
}

const getStringChunks = (values: string[], chunkSize: number): string[][] => {
  return values.length === 0
    ? []
    : values.length <= chunkSize
      ? [values]
      : [values.slice(0, chunkSize), ...getStringChunks(values.slice(chunkSize), chunkSize)]
}

const getActiveProviderRequestLeaseRows = async () => {
  return await getAppDatabaseService().queryJson<ProviderRequestLeaseRow>(`
    SELECT request_attempt_id AS requestAttemptId
    FROM app.provider_admission_lease
    WHERE lease_kind = 'request'
      AND request_attempt_id IS NOT NULL
      AND length(trim(request_attempt_id)) > 0
      AND expires_at > current_timestamp
    ORDER BY requestAttemptId ASC
  `)
}

const getTokenUseRequestAttemptContainsPredicate = (requestAttemptIds: string[]) => {
  return requestAttemptIds
    .map((requestAttemptId) => {
      return `contains(CAST(request_attempts_json AS VARCHAR), ${getSqlLiteral(requestAttemptId)})`
    })
    .join(' OR ')
}

const getDuckdbTokenUseRequestAttemptRows = async (requestAttemptIds: string[]): Promise<RequestAttemptsJsonRow[]> => {
  const rows = await getAppDatabaseService().queryJson<RequestAttemptsJsonRow>(`
    SELECT CAST(request_attempts_json AS VARCHAR) AS requestAttemptsJson
    FROM app.token_use
    WHERE request_attempts_json IS NOT NULL
      AND (${getTokenUseRequestAttemptContainsPredicate(requestAttemptIds)})
  `)

  return rows
}

const getDuckdbTokenUseRequestAttemptRowsForChunks = async (
  requestAttemptIdChunks: string[][],
): Promise<RequestAttemptsJsonRow[]> => {
  const [currentChunk = [], ...remainingChunks] = requestAttemptIdChunks

  if (currentChunk.length === 0) {
    return []
  }

  const rows = await getDuckdbTokenUseRequestAttemptRows(currentChunk)
  const remainingRows = await getDuckdbTokenUseRequestAttemptRowsForChunks(remainingChunks)

  return [...rows, ...remainingRows]
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

const getDuckdbTokenUseTerminalRequestAttemptCloseouts = async (): Promise<JudgmentRequestAttemptCloseoutProof[]> => {
  const activeLeaseRows = await getActiveProviderRequestLeaseRows()
  const activeRequestAttemptIds = getUniqueTrimmedValues(
    activeLeaseRows.map((row) => {
      return row.requestAttemptId
    }),
  )

  if (activeRequestAttemptIds.length === 0) {
    return []
  }

  const activeRequestAttemptIdSet = new Set(activeRequestAttemptIds)
  const rows = await getDuckdbTokenUseRequestAttemptRowsForChunks(
    getStringChunks(activeRequestAttemptIds, tokenUseCloseoutLookupBatchSize),
  )
  const closeouts = rows.flatMap((row) => {
    return getDurableTerminalRequestAttemptCloseoutProofs(getRequestAttemptsFromDuckdbJson(row.requestAttemptsJson))
  })

  return getUniqueRequestAttemptCloseouts(
    closeouts.filter((closeout) => {
      return activeRequestAttemptIdSet.has(closeout.requestAttemptId)
    }),
  )
}

const reconcileProviderAdmissionLeasesForDurableCloseout = async (): Promise<void> => {
  const [tokenUseCloseouts, sqliteCloseouts] = await Promise.all([
    getDuckdbTokenUseTerminalRequestAttemptCloseouts(),
    getJudgmentJobSqliteService().getDurableTerminalRequestAttemptCloseoutProofs(),
  ])

  await reconcileProviderAdmissionLeasesThroughOwner({
    terminalRequestAttemptCloseouts: [...tokenUseCloseouts, ...sqliteCloseouts],
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
