import {getQuotedStringList, getSqlLiteral, getTimestampLiteral} from '../../services/appQueryHelpers.ts'
import {getJudgeWorkerReadOnlyAppDatabaseService} from '../../services/appReadOnlyDatabaseService.ts'
import {
  judgmentProviderTelemetryHistoryPruneBatchSize,
  pruneJudgmentProviderTelemetryHistorySamples,
} from '../../services/judgmentProviderTelemetryHistoryService.ts'
import {
  beginJudgmentsCleanupStaleCronRun,
  failJudgmentsCleanupStaleCronRun,
  finishJudgmentsCleanupStaleCronRun,
  JUDGMENTS_CLEANUP_STALE_DEFAULT_BUDGET_MS,
  markJudgmentsCleanupStaleCronPartial,
  updateJudgmentsCleanupStaleCronStep,
} from '../judgmentsJobsCronState.ts'
import {isJudgmentJobLeaseProcessAlive, isJudgmentJobLeaseStale} from './judgmentJobLease.ts'
import {getJudgmentJobSqliteJobIds} from './judgmentJobPaths.ts'
import {runJudgmentJobRepairAction} from './judgmentJobRepair.ts'
import {getDefaultJudgmentServerJobId} from './judgmentJobServerIdentity.ts'
import {getJudgmentJobSqliteService, JudgmentJobLeaseError} from './judgmentJobSqliteService.ts'
import {getTransientJudgmentJobSqliteLockReasonSql} from './judgmentJobSqliteTransientLock.ts'
import {type JudgmentRequestAttemptCloseoutProof} from './judgmentRequestAttemptManifest.ts'
import {
  finalizeMissingLocalSqliteDrainingJobs,
  resumeRecoveredOomQuarantinedJob,
  sqliteCleanupTerminalStatuses,
} from './judgmentsJobsCleanupStaleDuckdbWrites.ts'
import {reconcileProviderAdmissionLeasesThroughOwner} from './providerAdmissionLease.ts'
import {abandonedSentPromptGraceMs} from './requeueAbandonedSentPrompts.ts'

type RetentionPruneResult = {outboxRowsDeleted: number; queuePromptRowsDeleted: number}
type RecoverableOomQuarantinedJobRow = {id: string}
type RecoverableOomQuarantinedJobPrefixRow = {id: string; quarantinedAt: unknown; updatedAt: unknown}
type RecoverableOomQuarantinedCursor = {id: string; quarantinedAt: Date; updatedAt: Date}
type CleanupCandidateSelection = {jobIds: string[]; limited: boolean}
type CleanupLocalSqliteJobSelection = CleanupCandidateSelection & {totalJobIds: number}

export type CleanupStaleStepStatus = 'completed' | 'failed' | 'partial' | 'skipped'

export type CleanupStaleStepResult = {
  candidatesSeen?: number
  durationMs: number
  jobsHandled?: number
  name: string
  rowsChanged?: number
  skippedReason?: string
  status: CleanupStaleStepStatus
}

export type CleanupStaleBudget = {
  deadlineMs: number
  maxDrainingJobs: number
  maxDuckdbSteps: number
  maxRepairActions: number
  maxSqliteJobActions: number
  maxSqliteRowsPerJob: number
  maxSqliteRetentionBatches: number
  maxSqliteRetentionRows: number
  now: Date
  serverJobId: string
}

type CleanupStaleBudgetState = CleanupStaleBudget & {
  duckdbStepsUsed: number
  repairActionsUsed: number
  runId: string
  sqliteJobActionsUsed: number
  sqliteRetentionBatchesUsed: number
  sqliteRetentionRowsUsed: number
}

export type CleanupStaleResult = {
  budget: {
    maxDrainingJobs: number
    maxDuckdbSteps: number
    maxRepairActions: number
    maxSqliteJobActions: number
    maxSqliteRowsPerJob: number
    maxSqliteRetentionBatches: number
    maxSqliteRetentionRows: number
    startedWithBudgetMs: number
  }
  completed: boolean
  exhaustedBudget: boolean
  finishedAtMs: number
  partialReason: string | null
  runId: string | null
  startedAtMs: number
  steps: CleanupStaleStepResult[]
  totals: {
    duckdbStepsUsed: number
    repairActionsUsed: number
    sqliteJobActionsUsed: number
    sqliteRetentionBatchesUsed: number
    sqliteRetentionRowsDeleted: number
  }
}

export type JudgmentsJobsCleanupStaleOptions = Partial<{
  budgetMs: number
  maxDrainingJobs: number
  maxDuckdbSteps: number
  maxRepairActions: number
  maxSqliteJobActions: number
  maxSqliteRowsPerJob: number
  maxSqliteRetentionBatches: number
  maxSqliteRetentionRows: number
}>

const sqliteRetentionCleanupBatchSize = 1_000
const duckdbProjectedCloseoutProbeBatchSize = 500
const duckdbProviderAdmissionLeaseExpireBatchSize = 1_000
const duckdbProviderAdmissionLeaseProviderBatchSize = 4
const recoverableOomQuarantineRecoveryBatchSize = 3
const transientLockedQuarantineRecoveryBatchSize = 5
const cleanupStaleDefaultMaxDrainingJobs = 20
const cleanupStaleDefaultMaxDuckdbSteps = 16
const cleanupStaleDefaultMaxRepairActions = 3
const cleanupStaleDefaultMaxSqliteJobActions = 100
const cleanupStaleDefaultMaxSqliteRowsPerJob = 1_000
const cleanupStaleDefaultMaxSqliteRetentionBatches = 5
const cleanupStaleDefaultMaxSqliteRetentionRows = 5_000
const cleanupStaleLocalCandidateScanWindowMultiplier = 4
const cleanupStaleMissingLocalCandidateScanWindowMultiplier = 4
const cleanupStaleRecoverableOomCandidateScanWindowMultiplier = 4
const cleanupStaleNullQuarantinedAtCursorDate = new Date('9999-12-31T23:59:59.999Z')

let cleanupStaleLocalCandidateCursor = 0
let cleanupStaleMissingLocalDrainingCursorId: string | null = null
let cleanupStaleRecoverableOomQuarantinedCursor: RecoverableOomQuarantinedCursor | null = null
let cleanupStaleRetentionCursorJobId: string | null = null

const getEmptyRetentionPruneResult = (): RetentionPruneResult => {
  return {outboxRowsDeleted: 0, queuePromptRowsDeleted: 0}
}

const addRetentionPruneResults = (left: RetentionPruneResult, right: RetentionPruneResult): RetentionPruneResult => {
  return {
    outboxRowsDeleted: left.outboxRowsDeleted + right.outboxRowsDeleted,
    queuePromptRowsDeleted: left.queuePromptRowsDeleted + right.queuePromptRowsDeleted,
  }
}

const getPositiveIntegerOption = (value: number | undefined, defaultValue: number) => {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value ?? defaultValue)) : defaultValue
}

const createCleanupStaleBudget = ({
  options,
  runId,
  serverJobId,
  startedAtMs,
}: {
  options: JudgmentsJobsCleanupStaleOptions
  runId: string
  serverJobId: string
  startedAtMs: number
}): CleanupStaleBudgetState => {
  const budgetMs = getPositiveIntegerOption(options.budgetMs, JUDGMENTS_CLEANUP_STALE_DEFAULT_BUDGET_MS)

  return {
    deadlineMs: startedAtMs + budgetMs,
    duckdbStepsUsed: 0,
    maxDrainingJobs: getPositiveIntegerOption(options.maxDrainingJobs, cleanupStaleDefaultMaxDrainingJobs),
    maxDuckdbSteps: getPositiveIntegerOption(options.maxDuckdbSteps, cleanupStaleDefaultMaxDuckdbSteps),
    maxRepairActions: getPositiveIntegerOption(options.maxRepairActions, cleanupStaleDefaultMaxRepairActions),
    maxSqliteJobActions: getPositiveIntegerOption(options.maxSqliteJobActions, cleanupStaleDefaultMaxSqliteJobActions),
    maxSqliteRowsPerJob: getPositiveIntegerOption(options.maxSqliteRowsPerJob, cleanupStaleDefaultMaxSqliteRowsPerJob),
    maxSqliteRetentionBatches: getPositiveIntegerOption(
      options.maxSqliteRetentionBatches,
      cleanupStaleDefaultMaxSqliteRetentionBatches,
    ),
    maxSqliteRetentionRows: getPositiveIntegerOption(
      options.maxSqliteRetentionRows,
      cleanupStaleDefaultMaxSqliteRetentionRows,
    ),
    now: new Date(startedAtMs),
    repairActionsUsed: 0,
    runId,
    serverJobId,
    sqliteJobActionsUsed: 0,
    sqliteRetentionBatchesUsed: 0,
    sqliteRetentionRowsUsed: 0,
  }
}

const createInitialCleanupStaleResult = ({
  budget,
  startedAtMs,
}: {
  budget: CleanupStaleBudgetState
  startedAtMs: number
}): CleanupStaleResult => {
  return {
    budget: {
      maxDrainingJobs: budget.maxDrainingJobs,
      maxDuckdbSteps: budget.maxDuckdbSteps,
      maxRepairActions: budget.maxRepairActions,
      maxSqliteJobActions: budget.maxSqliteJobActions,
      maxSqliteRowsPerJob: budget.maxSqliteRowsPerJob,
      maxSqliteRetentionBatches: budget.maxSqliteRetentionBatches,
      maxSqliteRetentionRows: budget.maxSqliteRetentionRows,
      startedWithBudgetMs: Math.max(0, budget.deadlineMs - startedAtMs),
    },
    completed: true,
    exhaustedBudget: false,
    finishedAtMs: startedAtMs,
    partialReason: null,
    runId: budget.runId,
    startedAtMs,
    steps: [],
    totals: {
      duckdbStepsUsed: 0,
      repairActionsUsed: 0,
      sqliteJobActionsUsed: 0,
      sqliteRetentionBatchesUsed: 0,
      sqliteRetentionRowsDeleted: 0,
    },
  }
}

const createSkippedCleanupStaleResult = ({
  reason,
  startedAtMs,
}: {
  reason: string
  startedAtMs: number
}): CleanupStaleResult => {
  return {
    budget: {
      maxDrainingJobs: 0,
      maxDuckdbSteps: 0,
      maxRepairActions: 0,
      maxSqliteJobActions: 0,
      maxSqliteRowsPerJob: 0,
      maxSqliteRetentionBatches: 0,
      maxSqliteRetentionRows: 0,
      startedWithBudgetMs: 0,
    },
    completed: false,
    exhaustedBudget: false,
    finishedAtMs: startedAtMs,
    partialReason: reason,
    runId: null,
    startedAtMs,
    steps: [{durationMs: 0, name: 'cleanup-stale', skippedReason: reason, status: 'skipped'}],
    totals: {
      duckdbStepsUsed: 0,
      repairActionsUsed: 0,
      sqliteJobActionsUsed: 0,
      sqliteRetentionBatchesUsed: 0,
      sqliteRetentionRowsDeleted: 0,
    },
  }
}

const refreshCleanupStaleTotals = (result: CleanupStaleResult, budget: CleanupStaleBudgetState) => {
  result.totals.duckdbStepsUsed = budget.duckdbStepsUsed
  result.totals.repairActionsUsed = budget.repairActionsUsed
  result.totals.sqliteJobActionsUsed = budget.sqliteJobActionsUsed
  result.totals.sqliteRetentionBatchesUsed = budget.sqliteRetentionBatchesUsed
  result.totals.sqliteRetentionRowsDeleted = budget.sqliteRetentionRowsUsed
}

export const getCleanupBudgetRemainingMs = (budget: CleanupStaleBudget): number => {
  return Math.max(0, budget.deadlineMs - Date.now())
}

export const hasCleanupBudgetRemaining = (budget: CleanupStaleBudget): boolean => {
  return getCleanupBudgetRemainingMs(budget) > 0
}

const markCleanupStalePartial = ({
  budget,
  exhaustedBudget = true,
  reason,
  result,
}: {
  budget: CleanupStaleBudgetState
  exhaustedBudget?: boolean
  reason: string
  result: CleanupStaleResult
}) => {
  result.completed = false
  result.exhaustedBudget = result.exhaustedBudget || exhaustedBudget
  result.partialReason ??= reason

  markJudgmentsCleanupStaleCronPartial({exhaustedBudget, reason, runId: budget.runId})
}

const ensureCleanupBudgetRemaining = ({
  budget,
  reason,
  result,
}: {
  budget: CleanupStaleBudgetState
  reason: string
  result: CleanupStaleResult
}): boolean => {
  if (hasCleanupBudgetRemaining(budget)) {
    return true
  }

  markCleanupStalePartial({budget, reason, result})
  return false
}

const consumeDuckdbStep = ({
  budget,
  result,
  steps = 1,
}: {
  budget: CleanupStaleBudgetState
  result: CleanupStaleResult
  steps?: number
}): boolean => {
  const normalizedSteps = getPositiveIntegerOption(steps, 1)

  if (normalizedSteps <= 0) {
    return true
  }

  if (budget.duckdbStepsUsed + normalizedSteps > budget.maxDuckdbSteps) {
    markCleanupStalePartial({budget, reason: 'duckdb-step-budget-exhausted', result})
    return false
  }

  budget.duckdbStepsUsed += normalizedSteps
  refreshCleanupStaleTotals(result, budget)
  return true
}

const getDuckdbStepsRemaining = (budget: CleanupStaleBudgetState): number => {
  return Math.max(0, budget.maxDuckdbSteps - budget.duckdbStepsUsed)
}

const consumeSqliteJobAction = ({
  budget,
  result,
}: {
  budget: CleanupStaleBudgetState
  result: CleanupStaleResult
}): boolean => {
  if (budget.sqliteJobActionsUsed >= budget.maxSqliteJobActions) {
    markCleanupStalePartial({budget, reason: 'sqlite-job-action-budget-exhausted', result})
    return false
  }

  budget.sqliteJobActionsUsed += 1
  refreshCleanupStaleTotals(result, budget)
  return true
}

const consumeRepairAction = ({
  budget,
  result,
}: {
  budget: CleanupStaleBudgetState
  result: CleanupStaleResult
}): boolean => {
  if (budget.repairActionsUsed >= budget.maxRepairActions) {
    markCleanupStalePartial({budget, reason: 'repair-action-budget-exhausted', result})
    return false
  }

  budget.repairActionsUsed += 1
  refreshCleanupStaleTotals(result, budget)
  return true
}

const consumeRetentionBatch = ({
  budget,
  result,
  rowsDeleted,
}: {
  budget: CleanupStaleBudgetState
  result: CleanupStaleResult
  rowsDeleted: number
}): boolean => {
  if (rowsDeleted <= 0) {
    return true
  }

  budget.sqliteRetentionBatchesUsed += 1
  budget.sqliteRetentionRowsUsed += rowsDeleted
  refreshCleanupStaleTotals(result, budget)

  if (budget.sqliteRetentionBatchesUsed >= budget.maxSqliteRetentionBatches && rowsDeleted > 0) {
    markCleanupStalePartial({budget, reason: 'sqlite-retention-batch-budget-exhausted', result})
    return false
  }

  if (budget.sqliteRetentionRowsUsed >= budget.maxSqliteRetentionRows && rowsDeleted > 0) {
    markCleanupStalePartial({budget, reason: 'sqlite-retention-row-budget-exhausted', result})
    return false
  }

  return true
}

const runCleanupStaleStep = async <TResult extends Partial<Omit<CleanupStaleStepResult, 'durationMs' | 'name'>>>({
  budget,
  name,
  result,
  run,
  duckdbSteps = 0,
  usesDuckdbStep = false,
}: {
  budget: CleanupStaleBudgetState
  duckdbSteps?: number
  name: string
  result: CleanupStaleResult
  run: () => Promise<TResult>
  usesDuckdbStep?: boolean
}): Promise<TResult | null> => {
  if (!ensureCleanupBudgetRemaining({budget, reason: 'wall-clock-budget-exhausted', result})) {
    result.steps.push({durationMs: 0, name, skippedReason: result.partialReason ?? undefined, status: 'partial'})
    return null
  }

  const requiredDuckdbSteps = usesDuckdbStep ? 1 : duckdbSteps

  if (requiredDuckdbSteps > 0 && !consumeDuckdbStep({budget, result, steps: requiredDuckdbSteps})) {
    result.steps.push({durationMs: 0, name, skippedReason: result.partialReason ?? undefined, status: 'partial'})
    return null
  }

  const startedAtMs = Date.now()
  updateJudgmentsCleanupStaleCronStep({nowMs: startedAtMs, runId: budget.runId, step: name})

  try {
    const stepResult = await run()
    const durationMs = Math.max(0, Date.now() - startedAtMs)
    const status = stepResult.status ?? 'completed'

    result.steps.push({...stepResult, durationMs, name, status})
    refreshCleanupStaleTotals(result, budget)

    if (status === 'partial') {
      markCleanupStalePartial({
        budget,
        reason: stepResult.skippedReason ?? result.partialReason ?? `${name}-partial`,
        result,
      })
    }

    return stepResult
  } catch (error) {
    result.steps.push({durationMs: Math.max(0, Date.now() - startedAtMs), name, status: 'failed'})
    throw error
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

const getDuckdbProjectedTerminalRequestAttemptCloseouts = async (
  limit = duckdbProjectedCloseoutProbeBatchSize,
): Promise<JudgmentRequestAttemptCloseoutProof[]> => {
  const normalizedLimit = getPositiveIntegerOption(limit, duckdbProjectedCloseoutProbeBatchSize)

  if (normalizedLimit <= 0) {
    return []
  }

  const rows = await getJudgeWorkerReadOnlyAppDatabaseService().queryJson<JudgmentRequestAttemptCloseoutProof>(`
    WITH active_request_leases AS (
      SELECT
        provider_key AS providerKey,
        request_attempt_id AS requestAttemptId
      FROM app.provider_admission_lease
      WHERE lease_kind = 'request'
        AND request_attempt_id IS NOT NULL
        AND length(trim(request_attempt_id)) > 0
        AND expires_at > current_timestamp
      ORDER BY expires_at ASC, provider_key ASC, request_attempt_id ASC
      LIMIT ${normalizedLimit}
    )
    SELECT
      closeout.provider_key AS providerKey,
      closeout.request_attempt_id AS requestAttemptId
    FROM active_request_leases lease
    JOIN app.request_attempt_closeout closeout
      ON closeout.provider_key = lease.providerKey
     AND closeout.request_attempt_id = lease.requestAttemptId
    ORDER BY lease.providerKey ASC, lease.requestAttemptId ASC
  `)

  return getUniqueRequestAttemptCloseouts(rows)
}

const getSqliteTerminalRequestAttemptCloseouts = async ({
  jobIds,
  maxCloseouts,
}: {
  jobIds?: string[]
  maxCloseouts?: number
}): Promise<{closeouts: JudgmentRequestAttemptCloseoutProof[]; limited: boolean}> => {
  const normalizedMaxCloseouts =
    maxCloseouts === undefined ? null : getPositiveIntegerOption(maxCloseouts, cleanupStaleDefaultMaxSqliteRowsPerJob)

  if (normalizedMaxCloseouts === 0) {
    return {closeouts: [], limited: false}
  }

  if (!jobIds) {
    const closeouts = await getJudgmentJobSqliteService().getDurableTerminalRequestAttemptCloseoutProofs(
      undefined,
      normalizedMaxCloseouts === null ? undefined : normalizedMaxCloseouts + 1,
    )

    return getBoundedCloseouts(closeouts, normalizedMaxCloseouts)
  }

  const closeouts: JudgmentRequestAttemptCloseoutProof[] = []

  for (const jobId of jobIds) {
    if (normalizedMaxCloseouts !== null && closeouts.length > normalizedMaxCloseouts) {
      break
    }

    const remainingBudget =
      normalizedMaxCloseouts === null ? undefined : Math.max(0, normalizedMaxCloseouts + 1 - closeouts.length)
    closeouts.push(
      ...(await getJudgmentJobSqliteService().getDurableTerminalRequestAttemptCloseoutProofs(jobId, remainingBudget)),
    )
  }

  return getBoundedCloseouts(closeouts, normalizedMaxCloseouts)
}

const getBoundedCloseouts = (
  closeouts: JudgmentRequestAttemptCloseoutProof[],
  maxCloseouts: number | null,
): {closeouts: JudgmentRequestAttemptCloseoutProof[]; limited: boolean} => {
  const uniqueCloseouts = getUniqueRequestAttemptCloseouts(closeouts)

  return maxCloseouts === null
    ? {closeouts: uniqueCloseouts, limited: false}
    : {closeouts: uniqueCloseouts.slice(0, maxCloseouts), limited: uniqueCloseouts.length > maxCloseouts}
}

export const reconcileProviderAdmissionLeasesForDurableCloseout = async ({
  jobIds,
  maxExpiredLeaseDeletes = duckdbProviderAdmissionLeaseExpireBatchSize,
  maxProviderKeys = duckdbProviderAdmissionLeaseProviderBatchSize,
  maxProjectionCloseoutProbes = duckdbProjectedCloseoutProbeBatchSize,
  maxSqliteCloseouts,
}: {
  jobIds?: string[]
  maxExpiredLeaseDeletes?: number
  maxProviderKeys?: number
  maxProjectionCloseoutProbes?: number
  maxSqliteCloseouts?: number
} = {}): Promise<{limited: boolean; rowsChanged: number}> => {
  const [projectionCloseouts, sqliteCloseoutSelection] = await Promise.all([
    getDuckdbProjectedTerminalRequestAttemptCloseouts(maxProjectionCloseoutProbes),
    getSqliteTerminalRequestAttemptCloseouts({jobIds, maxCloseouts: maxSqliteCloseouts}),
  ])

  const reconciliationResult = await reconcileProviderAdmissionLeasesThroughOwner({
    maxExpiredLeaseDeletes,
    maxProviderKeys,
    terminalRequestAttemptCloseouts: [...projectionCloseouts, ...sqliteCloseoutSelection.closeouts],
  })

  return {
    limited:
      projectionCloseouts.length >= maxProjectionCloseoutProbes
      || sqliteCloseoutSelection.limited
      || reconciliationResult.expiredLeaseCount >= maxExpiredLeaseDeletes,
    rowsChanged:
      reconciliationResult.durableRequestCloseoutLeaseCount
      + reconciliationResult.expiredLeaseCount
      + reconciliationResult.holderDemotionLeaseCount
      + reconciliationResult.suspectFreshProofLeaseCount,
  }
}

const getBoundedSelection = (jobIds: string[], maxJobIds: number): CleanupCandidateSelection => {
  return {jobIds: jobIds.slice(0, maxJobIds), limited: jobIds.length > maxJobIds}
}

const getRotatingBoundedLocalSqliteJobIds = (maxJobIds: number): CleanupLocalSqliteJobSelection => {
  const allJobIds = getJudgmentJobSqliteJobIds().sort()
  const normalizedMaxJobIds = getPositiveIntegerOption(maxJobIds, cleanupStaleDefaultMaxSqliteJobActions)

  if (normalizedMaxJobIds <= 0) {
    return {jobIds: [], limited: allJobIds.length > 0, totalJobIds: allJobIds.length}
  }

  if (allJobIds.length <= normalizedMaxJobIds) {
    cleanupStaleLocalCandidateCursor = 0
    return {jobIds: allJobIds, limited: false, totalJobIds: allJobIds.length}
  }

  const startIndex = cleanupStaleLocalCandidateCursor % allJobIds.length
  const jobIds = Array.from({length: normalizedMaxJobIds}, (_, index) => {
    return allJobIds[(startIndex + index) % allJobIds.length]
  })

  cleanupStaleLocalCandidateCursor = (startIndex + normalizedMaxJobIds) % allJobIds.length

  return {jobIds, limited: true, totalJobIds: allJobIds.length}
}

const getDrainingSqliteJobIds = async ({
  localSelection,
  maxJobIds,
}: {
  localSelection: CleanupLocalSqliteJobSelection
  maxJobIds: number
}): Promise<CleanupCandidateSelection> => {
  const normalizedMaxJobIds = getPositiveIntegerOption(maxJobIds, cleanupStaleDefaultMaxDrainingJobs)

  if (normalizedMaxJobIds <= 0) {
    return {jobIds: [], limited: localSelection.totalJobIds > 0}
  }

  if (localSelection.jobIds.length === 0) {
    return {jobIds: [], limited: localSelection.limited}
  }

  const jobIds = (
    await getJudgeWorkerReadOnlyAppDatabaseService().queryJson<{id: string}>(`
      SELECT id
      FROM app.judgment_job
      WHERE id IN (${getQuotedStringList(localSelection.jobIds).join(', ')})
        AND storage_state = ${getSqlLiteral('draining')}
      ORDER BY updated_at ASC, id ASC
      LIMIT ${normalizedMaxJobIds + 1}
    `)
  ).map((row) => {
    return row.id
  })

  const bounded = getBoundedSelection(jobIds, normalizedMaxJobIds)

  return {...bounded, limited: bounded.limited || localSelection.limited}
}

const getTransientLockedQuarantinedSqliteJobIds = async ({
  localSelection,
  maxJobIds,
}: {
  localSelection: CleanupLocalSqliteJobSelection
  maxJobIds: number
}): Promise<CleanupCandidateSelection> => {
  const normalizedMaxJobIds = getPositiveIntegerOption(maxJobIds, transientLockedQuarantineRecoveryBatchSize)

  if (normalizedMaxJobIds <= 0) {
    return {jobIds: [], limited: localSelection.totalJobIds > 0}
  }

  if (localSelection.jobIds.length === 0) {
    return {jobIds: [], limited: localSelection.limited}
  }

  const jobIds = (
    await getJudgeWorkerReadOnlyAppDatabaseService().queryJson<{id: string}>(`
      SELECT id
      FROM app.judgment_job
      WHERE id IN (${getQuotedStringList(localSelection.jobIds).join(', ')})
        AND storage_state = ${getSqlLiteral('quarantined')}
        AND (${getTransientJudgmentJobSqliteLockReasonSql('quarantine_reason')})
      ORDER BY quarantined_at ASC NULLS LAST, updated_at ASC
      LIMIT ${normalizedMaxJobIds + 1}
    `)
  ).map((row) => {
    return row.id
  })

  const bounded = getBoundedSelection(jobIds, normalizedMaxJobIds)

  return {...bounded, limited: bounded.limited || localSelection.limited}
}

const getMissingLocalSqliteDrainingJobIds = async (maxJobIds: number): Promise<CleanupCandidateSelection> => {
  const normalizedMaxJobIds = getPositiveIntegerOption(maxJobIds, cleanupStaleDefaultMaxSqliteJobActions)

  if (normalizedMaxJobIds <= 0) {
    return {jobIds: [], limited: false}
  }

  const localSqliteJobIds = new Set(getJudgmentJobSqliteJobIds())
  const scanLimit = Math.max(
    normalizedMaxJobIds + 1,
    normalizedMaxJobIds * cleanupStaleMissingLocalCandidateScanWindowMultiplier,
  )
  const readPage = async (cursorId: string | null) => {
    const cursorClause = cursorId === null ? '' : `AND id > ${getSqlLiteral(cursorId)}`

    return getJudgeWorkerReadOnlyAppDatabaseService().queryJson<{id: string}>(`
      SELECT id
      FROM app.judgment_job
      WHERE storage_state = ${getSqlLiteral('draining')}
        AND status IN (${getQuotedStringList([...sqliteCleanupTerminalStatuses]).join(', ')})
        ${cursorClause}
      ORDER BY id ASC
      LIMIT ${scanLimit}
    `)
  }

  let rows = await readPage(cleanupStaleMissingLocalDrainingCursorId)

  if (rows.length === 0 && cleanupStaleMissingLocalDrainingCursorId !== null) {
    cleanupStaleMissingLocalDrainingCursorId = null
    rows = await readPage(null)
  }

  if (rows.length > 0) {
    cleanupStaleMissingLocalDrainingCursorId = rows[rows.length - 1]?.id ?? null
  }

  const jobIds = rows
    .map((row) => {
      return row.id
    })
    .filter((jobId) => {
      return !localSqliteJobIds.has(jobId)
    })

  const bounded = getBoundedSelection(jobIds, normalizedMaxJobIds)

  return {...bounded, limited: bounded.limited || rows.length >= scanLimit}
}

const getRecoverableOomQuarantinedCursorDate = (value: unknown, fallback: Date): Date => {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value
  }

  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value)

    if (Number.isFinite(date.getTime())) {
      return date
    }
  }

  return fallback
}

const getRecoverableOomQuarantinedCursorFromRow = (
  row: RecoverableOomQuarantinedJobPrefixRow,
): RecoverableOomQuarantinedCursor => {
  return {
    id: row.id,
    quarantinedAt: getRecoverableOomQuarantinedCursorDate(row.quarantinedAt, cleanupStaleNullQuarantinedAtCursorDate),
    updatedAt: getRecoverableOomQuarantinedCursorDate(row.updatedAt, new Date(0)),
  }
}

const getRecoverableOomQuarantinedCursorClause = (): string => {
  if (!cleanupStaleRecoverableOomQuarantinedCursor) {
    return ''
  }

  const cursor = cleanupStaleRecoverableOomQuarantinedCursor
  const quarantinedAtExpression = `COALESCE(jj.quarantined_at, ${getTimestampLiteral(
    cleanupStaleNullQuarantinedAtCursorDate,
  )})`
  const cursorQuarantinedAt = getTimestampLiteral(cursor.quarantinedAt)
  const cursorUpdatedAt = getTimestampLiteral(cursor.updatedAt)

  return `
    AND (
      ${quarantinedAtExpression} > ${cursorQuarantinedAt}
      OR (
        ${quarantinedAtExpression} = ${cursorQuarantinedAt}
        AND jj.updated_at > ${cursorUpdatedAt}
      )
      OR (
        ${quarantinedAtExpression} = ${cursorQuarantinedAt}
        AND jj.updated_at = ${cursorUpdatedAt}
        AND jj.id > ${getSqlLiteral(cursor.id)}
      )
    )
  `
}

const getRecoverableOomQuarantinedPrefixRows = async (
  scanLimit: number,
): Promise<RecoverableOomQuarantinedJobPrefixRow[]> => {
  return getJudgeWorkerReadOnlyAppDatabaseService().queryJson<RecoverableOomQuarantinedJobPrefixRow>(`
    SELECT
      jj.id AS id,
      jj.quarantined_at AS quarantinedAt,
      jj.updated_at AS updatedAt
    FROM app.judgment_job jj
    WHERE jj.storage_state = ${getSqlLiteral('quarantined')}
      AND jj.status = ${getSqlLiteral('failed')}
      AND jj.pause_requested_at IS NULL
      ${getRecoverableOomQuarantinedCursorClause()}
    ORDER BY
      COALESCE(jj.quarantined_at, ${getTimestampLiteral(cleanupStaleNullQuarantinedAtCursorDate)}) ASC,
      jj.updated_at ASC,
      jj.id ASC
    LIMIT ${scanLimit}
  `)
}

const getRecoverableOomQuarantinedJobIds = async (maxJobIds: number): Promise<CleanupCandidateSelection> => {
  const normalizedMaxJobIds = getPositiveIntegerOption(maxJobIds, recoverableOomQuarantineRecoveryBatchSize)

  if (normalizedMaxJobIds <= 0) {
    return {jobIds: [], limited: false}
  }

  const scanLimit = Math.max(
    normalizedMaxJobIds + 1,
    normalizedMaxJobIds * cleanupStaleRecoverableOomCandidateScanWindowMultiplier,
  )
  let prefixRows = await getRecoverableOomQuarantinedPrefixRows(scanLimit)

  if (prefixRows.length === 0 && cleanupStaleRecoverableOomQuarantinedCursor) {
    cleanupStaleRecoverableOomQuarantinedCursor = null
    prefixRows = await getRecoverableOomQuarantinedPrefixRows(scanLimit)
  }

  if (prefixRows.length === 0) {
    return {jobIds: [], limited: false}
  }

  cleanupStaleRecoverableOomQuarantinedCursor = getRecoverableOomQuarantinedCursorFromRow(
    prefixRows[prefixRows.length - 1] as RecoverableOomQuarantinedJobPrefixRow,
  )

  const jobIds = (
    await getJudgeWorkerReadOnlyAppDatabaseService().queryJson<RecoverableOomQuarantinedJobRow>(`
      SELECT jj.id AS id
      FROM app.judgment_job jj
      INNER JOIN app.project_mart_refresh_state refresh_state ON refresh_state.project_id = jj.project_id
      WHERE jj.id IN (${getQuotedStringList(
        prefixRows.map((row) => {
          return row.id
        }),
      ).join(', ')})
        AND jj.storage_state = ${getSqlLiteral('quarantined')}
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
      ORDER BY
        COALESCE(jj.quarantined_at, ${getTimestampLiteral(cleanupStaleNullQuarantinedAtCursorDate)}) ASC,
        jj.updated_at ASC,
        jj.id ASC
      LIMIT ${normalizedMaxJobIds + 1}
    `)
  ).map((row) => {
    return row.id
  })

  const bounded = getBoundedSelection(jobIds, normalizedMaxJobIds)

  return {...bounded, limited: bounded.limited || prefixRows.length >= scanLimit}
}

const getDrainedSqliteCleanupJobIds = async (maxJobIds: number): Promise<CleanupCandidateSelection> => {
  const normalizedMaxJobIds = getPositiveIntegerOption(maxJobIds, cleanupStaleDefaultMaxSqliteJobActions)

  if (normalizedMaxJobIds <= 0) {
    return {jobIds: [], limited: false}
  }

  const jobIds = (
    await getJudgeWorkerReadOnlyAppDatabaseService().queryJson<{id: string}>(`
      SELECT id
      FROM app.judgment_job
      WHERE storage_state = ${getSqlLiteral('drained')}
        AND status IN (${getQuotedStringList([...sqliteCleanupTerminalStatuses]).join(', ')})
      ORDER BY updated_at ASC, id ASC
      LIMIT ${normalizedMaxJobIds + 1}
    `)
  ).map((row) => {
    return row.id
  })

  return getBoundedSelection(jobIds, normalizedMaxJobIds)
}

const hasFreshLiveJudgmentJobLease = async (jobId: string) => {
  const leaseMetadata = await getJudgmentJobSqliteService().getJudgmentJobLeaseMetadata(jobId)

  return (
    leaseMetadata !== null && isJudgmentJobLeaseProcessAlive(leaseMetadata) && !isJudgmentJobLeaseStale(leaseMetadata)
  )
}

const recoverDrainingQueueRows = async ({
  budget,
  jobIds,
  result,
  staleBefore,
}: {
  budget: CleanupStaleBudgetState
  jobIds: string[]
  result: CleanupStaleResult
  staleBefore: Date
}): Promise<{jobsHandled: number; rowsChanged: number; status?: CleanupStaleStepStatus; skippedReason?: string}> => {
  const sqliteService = getJudgmentJobSqliteService()
  let jobsHandled = 0
  let rowsChanged = 0

  for (const currentJobId of jobIds) {
    if (!ensureCleanupBudgetRemaining({budget, reason: 'wall-clock-budget-exhausted', result})) {
      return {jobsHandled, skippedReason: result.partialReason ?? undefined, status: 'partial'}
    }

    if (!consumeSqliteJobAction({budget, result})) {
      return {jobsHandled, skippedReason: result.partialReason ?? undefined, status: 'partial'}
    }

    try {
      await sqliteService.ensureOwnedLease(currentJobId, budget.serverJobId)
      const requeuedRows = await sqliteService.requeueAbandonedSentPrompts({
        jobId: currentJobId,
        maxRows: budget.maxSqliteRowsPerJob,
        serverJobId: budget.serverJobId,
        staleBefore,
      })
      const clearedRows = await sqliteService.clearActiveQueue(currentJobId, budget.maxSqliteRowsPerJob)
      rowsChanged += requeuedRows + clearedRows

      if (requeuedRows >= budget.maxSqliteRowsPerJob || clearedRows >= budget.maxSqliteRowsPerJob) {
        markCleanupStalePartial({budget, reason: 'sqlite-row-budget-exhausted', result})
        jobsHandled += 1
        return {jobsHandled, rowsChanged, skippedReason: result.partialReason ?? undefined, status: 'partial'}
      }
    } catch (error) {
      if (!(error instanceof JudgmentJobLeaseError)) {
        throw error
      }
    }

    jobsHandled += 1
  }

  return {jobsHandled, rowsChanged}
}

const repairOrphanedDrainingJobs = async ({
  budget,
  jobIds,
  result,
}: {
  budget: CleanupStaleBudgetState
  jobIds: string[]
  result: CleanupStaleResult
}): Promise<{jobsHandled: number; status?: CleanupStaleStepStatus; skippedReason?: string}> => {
  let jobsHandled = 0

  for (const currentJobId of jobIds) {
    if (!ensureCleanupBudgetRemaining({budget, reason: 'wall-clock-budget-exhausted', result})) {
      return {jobsHandled, skippedReason: result.partialReason ?? undefined, status: 'partial'}
    }

    if (!consumeRepairAction({budget, result})) {
      return {jobsHandled, skippedReason: result.partialReason ?? undefined, status: 'partial'}
    }

    await runJudgmentJobRepairAction({
      action: 'repair_orphaned_queue',
      claimedBy: budget.serverJobId,
      jobId: currentJobId,
    })
    jobsHandled += 1
  }

  return {jobsHandled}
}

const getOrphanedDrainingJobIds = async ({
  budget,
  jobIds,
  result,
}: {
  budget: CleanupStaleBudgetState
  jobIds: string[]
  result: CleanupStaleResult
}): Promise<{jobIds: string[]; jobsHandled: number; status?: CleanupStaleStepStatus; skippedReason?: string}> => {
  const orphanedJobIds: string[] = []
  const sqliteService = getJudgmentJobSqliteService()
  let jobsHandled = 0

  for (const currentJobId of jobIds) {
    if (!ensureCleanupBudgetRemaining({budget, reason: 'wall-clock-budget-exhausted', result})) {
      return {jobIds: orphanedJobIds, jobsHandled, skippedReason: result.partialReason ?? undefined, status: 'partial'}
    }

    if (!consumeSqliteJobAction({budget, result})) {
      return {jobIds: orphanedJobIds, jobsHandled, skippedReason: result.partialReason ?? undefined, status: 'partial'}
    }

    const healthSnapshot = await sqliteService.getHealthSnapshot(currentJobId)

    if (healthSnapshot.orphanedJudgedRowCount > 0) {
      orphanedJobIds.push(currentJobId)
    }
    jobsHandled += 1
  }

  return {jobIds: orphanedJobIds, jobsHandled}
}

const repairUnavailableRequestAttemptDiagnostics = async ({
  budget,
  jobIds,
  result,
  staleBefore,
}: {
  budget: CleanupStaleBudgetState
  jobIds: string[]
  result: CleanupStaleResult
  staleBefore: Date
}): Promise<{jobsHandled: number; rowsChanged: number; status?: CleanupStaleStepStatus; skippedReason?: string}> => {
  let jobsHandled = 0
  let rowsChanged = 0

  for (const currentJobId of jobIds) {
    if (!ensureCleanupBudgetRemaining({budget, reason: 'wall-clock-budget-exhausted', result})) {
      return {jobsHandled, rowsChanged, skippedReason: result.partialReason ?? undefined, status: 'partial'}
    }

    if (!consumeSqliteJobAction({budget, result})) {
      return {jobsHandled, rowsChanged, skippedReason: result.partialReason ?? undefined, status: 'partial'}
    }

    try {
      const repairedRows = await getJudgmentJobSqliteService().repairUnavailableRequestAttemptDiagnostics({
        jobId: currentJobId,
        maxRows: budget.maxSqliteRowsPerJob,
        serverJobId: budget.serverJobId,
        staleBefore,
      })
      rowsChanged += repairedRows

      if (repairedRows >= budget.maxSqliteRowsPerJob) {
        markCleanupStalePartial({budget, reason: 'sqlite-row-budget-exhausted', result})
        jobsHandled += 1
        return {jobsHandled, rowsChanged, skippedReason: result.partialReason ?? undefined, status: 'partial'}
      }
    } catch (error) {
      if (!(error instanceof JudgmentJobLeaseError)) {
        throw error
      }
    }

    jobsHandled += 1
  }

  return {jobsHandled, rowsChanged}
}

const pruneVisibilityAckedRetentionBatches = async ({
  budget,
  jobIds,
  result,
}: {
  budget: CleanupStaleBudgetState
  jobIds: string[]
  result: CleanupStaleResult
}): Promise<{jobsHandled: number; rowsChanged: number; skippedReason?: string; status?: CleanupStaleStepStatus}> => {
  let jobsHandled = 0
  let total = getEmptyRetentionPruneResult()
  const sqliteService = getJudgmentJobSqliteService()

  for (const currentJobId of jobIds) {
    let handledCurrentJob = false

    while (true) {
      if (!ensureCleanupBudgetRemaining({budget, reason: 'wall-clock-budget-exhausted', result})) {
        cleanupStaleRetentionCursorJobId = currentJobId
        return {
          jobsHandled,
          rowsChanged: total.outboxRowsDeleted + total.queuePromptRowsDeleted,
          skippedReason: result.partialReason ?? undefined,
          status: 'partial',
        }
      }

      if (budget.sqliteRetentionBatchesUsed >= budget.maxSqliteRetentionBatches) {
        markCleanupStalePartial({budget, reason: 'sqlite-retention-batch-budget-exhausted', result})
        cleanupStaleRetentionCursorJobId = currentJobId
        return {
          jobsHandled,
          rowsChanged: total.outboxRowsDeleted + total.queuePromptRowsDeleted,
          skippedReason: result.partialReason ?? undefined,
          status: 'partial',
        }
      }

      const remainingRows = budget.maxSqliteRetentionRows - budget.sqliteRetentionRowsUsed

      if (remainingRows <= 0) {
        markCleanupStalePartial({budget, reason: 'sqlite-retention-row-budget-exhausted', result})
        cleanupStaleRetentionCursorJobId = currentJobId
        return {
          jobsHandled,
          rowsChanged: total.outboxRowsDeleted + total.queuePromptRowsDeleted,
          skippedReason: result.partialReason ?? undefined,
          status: 'partial',
        }
      }

      const current = await sqliteService.pruneVisibilityAckedRetention({
        jobId: currentJobId,
        maxRows: Math.min(sqliteRetentionCleanupBatchSize, remainingRows),
        serverJobId: budget.serverJobId,
      })
      const rowsDeleted = current.outboxRowsDeleted + current.queuePromptRowsDeleted

      total = addRetentionPruneResults(total, current)

      if (!handledCurrentJob) {
        jobsHandled += 1
        handledCurrentJob = true
      }

      const canContinue = consumeRetentionBatch({budget, result, rowsDeleted})

      if (current.outboxRowsDeleted === 0 && current.queuePromptRowsDeleted === 0) {
        break
      }

      if (!canContinue) {
        cleanupStaleRetentionCursorJobId = currentJobId
        return {
          jobsHandled,
          rowsChanged: total.outboxRowsDeleted + total.queuePromptRowsDeleted,
          skippedReason: result.partialReason ?? undefined,
          status: 'partial',
        }
      }
    }
  }

  cleanupStaleRetentionCursorJobId = null
  return {jobsHandled, rowsChanged: total.outboxRowsDeleted + total.queuePromptRowsDeleted}
}

const recoverTransientLockedQuarantinedJobs = async ({
  budget,
  jobIds,
  result,
}: {
  budget: CleanupStaleBudgetState
  jobIds: string[]
  result: CleanupStaleResult
}): Promise<{jobsHandled: number; status?: CleanupStaleStepStatus; skippedReason?: string}> => {
  let jobsHandled = 0

  for (const currentJobId of jobIds) {
    if (!ensureCleanupBudgetRemaining({budget, reason: 'wall-clock-budget-exhausted', result})) {
      return {jobsHandled, skippedReason: result.partialReason ?? undefined, status: 'partial'}
    }

    if (!consumeSqliteJobAction({budget, result})) {
      return {jobsHandled, skippedReason: result.partialReason ?? undefined, status: 'partial'}
    }

    const hasFreshLiveLease = await hasFreshLiveJudgmentJobLease(currentJobId)

    if (!hasFreshLiveLease) {
      if (!consumeRepairAction({budget, result})) {
        return {jobsHandled, skippedReason: result.partialReason ?? undefined, status: 'partial'}
      }
      await runJudgmentJobRepairAction({action: 'unquarantine', claimedBy: budget.serverJobId, jobId: currentJobId})
    }

    jobsHandled += 1
  }

  return {jobsHandled}
}

const recoverOomQuarantinedJobs = async ({
  budget,
  jobIds,
  result,
}: {
  budget: CleanupStaleBudgetState
  jobIds: string[]
  result: CleanupStaleResult
}): Promise<{jobsHandled: number; status?: CleanupStaleStepStatus; skippedReason?: string}> => {
  let jobsHandled = 0

  for (const currentJobId of jobIds) {
    if (!ensureCleanupBudgetRemaining({budget, reason: 'wall-clock-budget-exhausted', result})) {
      return {jobsHandled, skippedReason: result.partialReason ?? undefined, status: 'partial'}
    }

    if (!consumeRepairAction({budget, result})) {
      return {jobsHandled, skippedReason: result.partialReason ?? undefined, status: 'partial'}
    }

    const repairResult = await runJudgmentJobRepairAction({
      action: 'unquarantine',
      claimedBy: budget.serverJobId,
      jobId: currentJobId,
    })

    if (repairResult.ok && repairResult.changes.unquarantined) {
      await resumeRecoveredOomQuarantinedJob(currentJobId)
    }

    jobsHandled += 1
  }

  return {jobsHandled}
}

const getUniqueJobIds = (jobIds: string[]) => {
  return Array.from(new Set(jobIds))
}

const getRotatedJobIdsAfterCursor = (jobIds: string[], cursorJobId: string | null): string[] => {
  const uniqueJobIds = getUniqueJobIds(jobIds)

  if (!cursorJobId) {
    return uniqueJobIds
  }

  const cursorIndex = uniqueJobIds.indexOf(cursorJobId)

  if (cursorIndex < 0 || cursorIndex === uniqueJobIds.length - 1) {
    return uniqueJobIds
  }

  return [...uniqueJobIds.slice(cursorIndex + 1), ...uniqueJobIds.slice(0, cursorIndex + 1)]
}

const getCleanupRetentionJobIds = ({
  drainingJobIds,
  maxJobIds,
  sqliteJobIds,
}: {
  drainingJobIds: string[]
  maxJobIds: number
  sqliteJobIds: string[]
}) => {
  return getRotatedJobIdsAfterCursor(
    getUniqueJobIds([...drainingJobIds, ...sqliteJobIds]),
    cleanupStaleRetentionCursorJobId,
  ).slice(0, maxJobIds)
}

const selectCleanupCandidates = async ({
  budget,
  result,
}: {
  budget: CleanupStaleBudgetState
  result: CleanupStaleResult
}): Promise<{
  drainedJobIds: string[]
  drainingJobIds: string[]
  missingLocalSqliteDrainingJobIds: string[]
  recoverableOomQuarantinedJobIds: string[]
  sqliteJobIds: string[]
  transientLockedQuarantinedJobIds: string[]
}> => {
  const localSqliteSelection = getRotatingBoundedLocalSqliteJobIds(
    Math.max(
      budget.maxSqliteJobActions,
      budget.maxDrainingJobs * cleanupStaleLocalCandidateScanWindowMultiplier,
      budget.maxRepairActions * cleanupStaleLocalCandidateScanWindowMultiplier,
    ),
  )
  const [
    drainingSelection,
    missingLocalSelection,
    recoverableOomSelection,
    transientLockedSelection,
    drainedSelection,
  ] = await Promise.all([
    getDrainingSqliteJobIds({localSelection: localSqliteSelection, maxJobIds: budget.maxDrainingJobs}),
    getMissingLocalSqliteDrainingJobIds(budget.maxSqliteJobActions),
    getRecoverableOomQuarantinedJobIds(budget.maxRepairActions),
    getTransientLockedQuarantinedSqliteJobIds({
      localSelection: localSqliteSelection,
      maxJobIds: budget.maxRepairActions,
    }),
    getDrainedSqliteCleanupJobIds(budget.maxSqliteJobActions),
  ])

  if (
    drainingSelection.limited
    || missingLocalSelection.limited
    || recoverableOomSelection.limited
    || transientLockedSelection.limited
    || drainedSelection.limited
    || localSqliteSelection.limited
  ) {
    markCleanupStalePartial({budget, reason: 'candidate-job-budget-exhausted', result})
  }

  return {
    drainedJobIds: drainedSelection.jobIds,
    drainingJobIds: drainingSelection.jobIds,
    missingLocalSqliteDrainingJobIds: missingLocalSelection.jobIds,
    recoverableOomQuarantinedJobIds: recoverableOomSelection.jobIds,
    sqliteJobIds: localSqliteSelection.jobIds.slice(0, budget.maxSqliteJobActions),
    transientLockedQuarantinedJobIds: transientLockedSelection.jobIds,
  }
}

const reapStaleOutboxClaimsForJobs = async ({
  budget,
  jobIds,
  result,
  staleBefore,
}: {
  budget: CleanupStaleBudgetState
  jobIds: string[]
  result: CleanupStaleResult
  staleBefore: Date
}): Promise<{jobsHandled: number; rowsChanged: number; status?: CleanupStaleStepStatus; skippedReason?: string}> => {
  let jobsHandled = 0
  let rowsChanged = 0
  const sqliteService = getJudgmentJobSqliteService()

  for (const currentJobId of jobIds) {
    if (!ensureCleanupBudgetRemaining({budget, reason: 'wall-clock-budget-exhausted', result})) {
      return {jobsHandled, rowsChanged, skippedReason: result.partialReason ?? undefined, status: 'partial'}
    }

    if (!consumeSqliteJobAction({budget, result})) {
      return {jobsHandled, rowsChanged, skippedReason: result.partialReason ?? undefined, status: 'partial'}
    }

    const reapedRows = await sqliteService.reapStaleOutboxClaims({
      jobId: currentJobId,
      maxRows: budget.maxSqliteRowsPerJob,
      staleBefore,
    })
    rowsChanged += reapedRows

    if (reapedRows >= budget.maxSqliteRowsPerJob) {
      markCleanupStalePartial({budget, reason: 'sqlite-row-budget-exhausted', result})
      jobsHandled += 1
      return {jobsHandled, rowsChanged, skippedReason: result.partialReason ?? undefined, status: 'partial'}
    }
    jobsHandled += 1
  }

  return {jobsHandled, rowsChanged}
}

const finalizeDrainingSqliteJobs = async ({
  budget,
  jobIds,
  result,
}: {
  budget: CleanupStaleBudgetState
  jobIds: string[]
  result: CleanupStaleResult
}): Promise<{
  drainedJobIds: string[]
  jobsHandled: number
  rowsChanged: number
  status?: CleanupStaleStepStatus
  skippedReason?: string
}> => {
  const drainedJobIds: string[] = []
  let jobsHandled = 0
  let rowsChanged = 0
  const sqliteService = getJudgmentJobSqliteService()

  for (const currentJobId of jobIds) {
    if (!ensureCleanupBudgetRemaining({budget, reason: 'wall-clock-budget-exhausted', result})) {
      return {
        drainedJobIds,
        jobsHandled,
        rowsChanged,
        skippedReason: result.partialReason ?? undefined,
        status: 'partial',
      }
    }

    if (!consumeSqliteJobAction({budget, result})) {
      return {
        drainedJobIds,
        jobsHandled,
        rowsChanged,
        skippedReason: result.partialReason ?? undefined,
        status: 'partial',
      }
    }

    const currentDrainedJobIds = await sqliteService.finalizeDrainingJobs({
      jobId: currentJobId,
      serverJobId: budget.serverJobId,
    })

    rowsChanged += currentDrainedJobIds.length
    drainedJobIds.push(...currentDrainedJobIds)
    jobsHandled += 1
  }

  return {drainedJobIds, jobsHandled, rowsChanged}
}

const deleteDrainedSqliteJobs = async ({
  budget,
  jobIds,
  result,
}: {
  budget: CleanupStaleBudgetState
  jobIds: string[]
  result: CleanupStaleResult
}): Promise<{jobsHandled: number; rowsChanged: number; status?: CleanupStaleStepStatus; skippedReason?: string}> => {
  let jobsHandled = 0
  let rowsChanged = 0
  const sqliteService = getJudgmentJobSqliteService()

  for (const currentJobId of jobIds) {
    if (!ensureCleanupBudgetRemaining({budget, reason: 'wall-clock-budget-exhausted', result})) {
      return {jobsHandled, rowsChanged, skippedReason: result.partialReason ?? undefined, status: 'partial'}
    }

    if (!consumeSqliteJobAction({budget, result})) {
      return {jobsHandled, rowsChanged, skippedReason: result.partialReason ?? undefined, status: 'partial'}
    }

    rowsChanged += (await sqliteService.deleteDrainedJobs({jobId: currentJobId, serverJobId: budget.serverJobId}))
      .length
    jobsHandled += 1
  }

  return {jobsHandled, rowsChanged}
}

const shouldStopCleanupAfterStep = (stepResult: {status?: CleanupStaleStepStatus} | null): boolean => {
  return stepResult === null || stepResult.status === 'partial'
}

export const judgmentsJobsCleanupStale = async (
  options: JudgmentsJobsCleanupStaleOptions = {},
): Promise<CleanupStaleResult> => {
  const startedAtMs = Date.now()
  const budgetMs = getPositiveIntegerOption(options.budgetMs, JUDGMENTS_CLEANUP_STALE_DEFAULT_BUDGET_MS)
  const runId = beginJudgmentsCleanupStaleCronRun({budgetMs, nowMs: startedAtMs})

  if (!runId) {
    return createSkippedCleanupStaleResult({reason: 'cleanup-stale-already-running', startedAtMs})
  }

  const serverJobId = getDefaultJudgmentServerJobId()
  const budget = createCleanupStaleBudget({options, runId, serverJobId, startedAtMs})
  const result = createInitialCleanupStaleResult({budget, startedAtMs})
  const sixteenMinutesAgo = new Date(budget.now.getTime() - 16 * 60 * 1000)
  const abandonedSentPromptStaleBefore = new Date(budget.now.getTime() - abandonedSentPromptGraceMs)

  const finishResult = () => {
    result.finishedAtMs = Date.now()
    refreshCleanupStaleTotals(result, budget)
    updateJudgmentsCleanupStaleCronStep({runId: budget.runId, step: null})
    finishJudgmentsCleanupStaleCronRun({
      exhaustedBudget: result.exhaustedBudget,
      partialReason: result.partialReason,
      runId: budget.runId,
    })
    return result
  }

  try {
    let cleanupCandidates: Awaited<ReturnType<typeof selectCleanupCandidates>> = {
      drainedJobIds: [],
      drainingJobIds: [],
      missingLocalSqliteDrainingJobIds: [],
      recoverableOomQuarantinedJobIds: [],
      sqliteJobIds: [],
      transientLockedQuarantinedJobIds: [],
    }

    const candidateStep = await runCleanupStaleStep({
      budget,
      name: 'select-candidates',
      result,
      run: async () => {
        cleanupCandidates = await selectCleanupCandidates({budget, result})
        return {
          candidatesSeen:
            cleanupCandidates.drainedJobIds.length
            + cleanupCandidates.drainingJobIds.length
            + cleanupCandidates.missingLocalSqliteDrainingJobIds.length
            + cleanupCandidates.recoverableOomQuarantinedJobIds.length
            + cleanupCandidates.sqliteJobIds.length
            + cleanupCandidates.transientLockedQuarantinedJobIds.length,
          jobsHandled: 0,
        }
      },
      duckdbSteps: 5,
    })

    if (shouldStopCleanupAfterStep(candidateStep)) return finishResult()

    const transientLockedStep = await runCleanupStaleStep({
      budget,
      name: 'recover-transient-locked-quarantined-jobs',
      result,
      run: () => {
        return recoverTransientLockedQuarantinedJobs({
          budget,
          jobIds: cleanupCandidates.transientLockedQuarantinedJobIds,
          result,
        })
      },
    })

    if (shouldStopCleanupAfterStep(transientLockedStep)) return finishResult()

    const oomRecoveryStep = await runCleanupStaleStep({
      budget,
      name: 'recover-oom-quarantined-jobs',
      result,
      run: () => {
        return recoverOomQuarantinedJobs({budget, jobIds: cleanupCandidates.recoverableOomQuarantinedJobIds, result})
      },
    })

    if (shouldStopCleanupAfterStep(oomRecoveryStep)) return finishResult()

    const reapOutboxStep = await runCleanupStaleStep({
      budget,
      name: 'reap-stale-outbox-claims',
      result,
      run: () => {
        return reapStaleOutboxClaimsForJobs({
          budget,
          jobIds: cleanupCandidates.sqliteJobIds,
          result,
          staleBefore: sixteenMinutesAgo,
        })
      },
    })

    if (shouldStopCleanupAfterStep(reapOutboxStep)) return finishResult()

    const drainingRecoveryStep = await runCleanupStaleStep({
      budget,
      name: 'recover-draining-queue-rows',
      result,
      run: () => {
        return recoverDrainingQueueRows({
          budget,
          jobIds: cleanupCandidates.drainingJobIds,
          result,
          staleBefore: abandonedSentPromptStaleBefore,
        })
      },
    })

    if (shouldStopCleanupAfterStep(drainingRecoveryStep)) return finishResult()

    const retentionJobIds = getCleanupRetentionJobIds({
      drainingJobIds: cleanupCandidates.drainingJobIds,
      maxJobIds: budget.maxSqliteJobActions,
      sqliteJobIds: cleanupCandidates.sqliteJobIds,
    })
    const retentionStep = await runCleanupStaleStep({
      budget,
      name: 'prune-visibility-acked-retention',
      result,
      run: () => {
        return pruneVisibilityAckedRetentionBatches({budget, jobIds: retentionJobIds, result})
      },
    })

    if (shouldStopCleanupAfterStep(retentionStep)) return finishResult()

    let orphanedDrainingJobIds: string[] = []
    const orphanScanStep = await runCleanupStaleStep({
      budget,
      name: 'scan-orphaned-draining-jobs',
      result,
      run: async () => {
        const scanResult = await getOrphanedDrainingJobIds({budget, jobIds: cleanupCandidates.drainingJobIds, result})
        orphanedDrainingJobIds = scanResult.jobIds
        return {...scanResult, candidatesSeen: cleanupCandidates.drainingJobIds.length}
      },
    })

    if (shouldStopCleanupAfterStep(orphanScanStep)) return finishResult()

    const orphanRepairStep = await runCleanupStaleStep({
      budget,
      name: 'repair-orphaned-draining-jobs',
      result,
      run: () => {
        return repairOrphanedDrainingJobs({budget, jobIds: orphanedDrainingJobIds, result})
      },
    })

    if (shouldStopCleanupAfterStep(orphanRepairStep)) return finishResult()

    const unavailableDiagnosticsStep = await runCleanupStaleStep({
      budget,
      name: 'repair-unavailable-request-attempt-diagnostics',
      result,
      run: () => {
        return repairUnavailableRequestAttemptDiagnostics({
          budget,
          jobIds: cleanupCandidates.sqliteJobIds,
          result,
          staleBefore: sixteenMinutesAgo,
        })
      },
    })

    if (shouldStopCleanupAfterStep(unavailableDiagnosticsStep)) return finishResult()

    const missingLocalStep = await runCleanupStaleStep({
      budget,
      name: 'finalize-missing-local-sqlite-draining-jobs',
      result,
      run: async () => {
        await finalizeMissingLocalSqliteDrainingJobs(cleanupCandidates.missingLocalSqliteDrainingJobIds)
        return {
          jobsHandled: cleanupCandidates.missingLocalSqliteDrainingJobIds.length,
          rowsChanged: cleanupCandidates.missingLocalSqliteDrainingJobIds.length,
        }
      },
      usesDuckdbStep: true,
    })

    if (shouldStopCleanupAfterStep(missingLocalStep)) return finishResult()

    const telemetryPruneStep = await runCleanupStaleStep({
      budget,
      name: 'prune-provider-telemetry-history',
      result,
      run: async () => {
        const rowsChanged = await pruneJudgmentProviderTelemetryHistorySamples({
          maxRows: judgmentProviderTelemetryHistoryPruneBatchSize,
        })
        return {
          rowsChanged,
          skippedReason:
            rowsChanged >= judgmentProviderTelemetryHistoryPruneBatchSize
              ? 'provider-telemetry-prune-row-budget-exhausted'
              : undefined,
          status: rowsChanged >= judgmentProviderTelemetryHistoryPruneBatchSize ? 'partial' : 'completed',
        }
      },
      usesDuckdbStep: true,
    })

    if (shouldStopCleanupAfterStep(telemetryPruneStep)) return finishResult()

    const finalizeDrainingStep = await runCleanupStaleStep({
      budget,
      name: 'finalize-draining-sqlite-jobs',
      result,
      run: () => {
        return finalizeDrainingSqliteJobs({budget, jobIds: cleanupCandidates.drainingJobIds, result})
      },
    })

    cleanupCandidates.drainedJobIds = getUniqueJobIds([
      ...cleanupCandidates.drainedJobIds,
      ...(finalizeDrainingStep?.drainedJobIds ?? []),
    ])

    if (shouldStopCleanupAfterStep(finalizeDrainingStep)) return finishResult()

    const reconcileLeasesStep = await runCleanupStaleStep({
      budget,
      name: 'reconcile-provider-admission-leases',
      result,
      run: async () => {
        if (!consumeDuckdbStep({budget, result, steps: 1})) {
          return {skippedReason: result.partialReason ?? undefined, status: 'partial'}
        }

        const maxProviderKeys = Math.min(
          duckdbProviderAdmissionLeaseProviderBatchSize,
          Math.max(0, getDuckdbStepsRemaining(budget) - 1),
        )

        if (maxProviderKeys <= 0) {
          markCleanupStalePartial({budget, reason: 'duckdb-step-budget-exhausted', result})
          return {skippedReason: result.partialReason ?? undefined, status: 'partial'}
        }

        if (!consumeDuckdbStep({budget, result, steps: 1 + maxProviderKeys})) {
          return {skippedReason: result.partialReason ?? undefined, status: 'partial'}
        }

        const reconciliationResult = await reconcileProviderAdmissionLeasesForDurableCloseout({
          jobIds: cleanupCandidates.sqliteJobIds,
          maxExpiredLeaseDeletes: duckdbProviderAdmissionLeaseExpireBatchSize,
          maxProviderKeys,
          maxProjectionCloseoutProbes: Math.min(
            duckdbProjectedCloseoutProbeBatchSize,
            Math.max(1, budget.maxSqliteJobActions * 10),
          ),
          maxSqliteCloseouts: budget.maxSqliteRowsPerJob,
        })

        return {
          jobsHandled: cleanupCandidates.sqliteJobIds.length,
          rowsChanged: reconciliationResult.rowsChanged,
          skippedReason: reconciliationResult.limited
            ? 'provider-admission-reconciliation-budget-exhausted'
            : undefined,
          status: reconciliationResult.limited ? 'partial' : 'completed',
        }
      },
    })

    if (shouldStopCleanupAfterStep(reconcileLeasesStep)) return finishResult()

    await runCleanupStaleStep({
      budget,
      name: 'delete-drained-sqlite-jobs',
      result,
      run: () => {
        return deleteDrainedSqliteJobs({budget, jobIds: cleanupCandidates.drainedJobIds, result})
      },
    })

    return finishResult()
  } catch (error) {
    failJudgmentsCleanupStaleCronRun({error, runId: budget.runId})
    throw error
  }
}
