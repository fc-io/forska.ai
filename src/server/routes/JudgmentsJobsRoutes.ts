import {Elysia, t} from 'elysia'

import type {OwnerBackedJudgmentJobInfo} from '../cron/judgmentsJobs/judgeWorkerCompletionJournal.ts'
import {
  getJudgmentEndpointAvailability,
  getJudgmentEndpointAvailabilityDiagnostics,
} from '../cron/judgmentsJobs/judgmentEndpointAvailability.ts'
import {
  runAutomaticOrphanedQueueRepairForJob,
  runJudgmentJobAutomaticOrphanedQueueRepairAction,
  runJudgmentJobRepairAction,
} from '../cron/judgmentsJobs/judgmentJobRepair.ts'
import {getDefaultJudgmentServerJobId} from '../cron/judgmentsJobs/judgmentJobServerIdentity.ts'
import {
  isJudgmentJobSqliteIsolatedImportLeaseConflict,
  runJudgmentJobSqliteIsolatedFlush,
} from '../cron/judgmentsJobs/judgmentJobSqliteIsolatedImport.ts'
import {flushJudgmentJobSqliteOutbox} from '../cron/judgmentsJobs/judgmentJobSqliteOutboxImport.ts'
import {assertJudgmentJobCanRunSqlitePreflight} from '../cron/judgmentsJobs/judgmentJobSqlitePreflight.ts'
import {
  getJudgmentJobSqliteService,
  JudgmentPromptClaimIdentityError,
} from '../cron/judgmentsJobs/judgmentJobSqliteService.ts'
import {isTransientJudgmentJobSqliteLockMessage} from '../cron/judgmentsJobs/judgmentJobSqliteTransientLock.ts'
import {
  getJudgmentJobRepairMode,
  getJudgmentJobStartupHandling,
  hasJudgmentJobLocalSqliteState,
} from '../cron/judgmentsJobs/judgmentJobStoragePolicy.ts'
import {getJudgmentJobStorageTransferRuntime} from '../cron/judgmentsJobs/judgmentJobStorageTransferRuntime.ts'
import {
  getEndpointIdentityFromAvailabilityKey,
  getJudgmentProviderTelemetryProviderSnapshot,
  getJudgmentProviderTelemetrySnapshot,
} from '../cron/judgmentsJobs/judgmentProviderTelemetrySnapshot.ts'
import {
  type JudgmentRequestAttemptJsonEntry,
  stringifyRequestAttempts,
  withDurableCloseoutRef,
} from '../cron/judgmentsJobs/judgmentRequestAttemptManifest.ts'
import {
  attachProviderBucketSnapshotToRunningJob,
  type RunningJudgmentJob,
} from '../cron/judgmentsJobs/judgmentsJobsGetRunningJobs.ts'
import {getProviderBucketSnapshot, type ProviderBucketSnapshot} from '../cron/judgmentsJobs/providerAdmissionLease.ts'
import {getProviderConnectionForStoredModel} from '../providers/providerConnectionRepository.ts'
import {getProviderConnectionConfigFromJson} from '../providers/providerDbUtils.ts'
import {resolveProviderConnectionRuntimeMatch} from '../providers/providerRuntimeMatchResolver.ts'
import {assertStoredProviderModelRuntimeMatch} from '../providers/providerRuntimeModelGuard.ts'
import {getProviderConnectionEffectiveBaseURL} from '../providers/providerRuntimeState.ts'
import {
  getJudgmentJobUnassessedArticlesFromServing,
  getJudgmentJobUnassessedCountFromServing,
} from '../reviewServing/reviewServingJudgmentJobQueueService.ts'
import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {
  escapeSqlString,
  getDateValue,
  getJsonValue,
  getQuotedStringList,
  getSqlLiteral,
} from '../services/appQueryHelpers.ts'
import {getApiReadOnlyAppDatabaseService} from '../services/appReadOnlyDatabaseService.ts'
import {
  getJudgmentExecutionSnapshot,
  isJudgmentExecutionSnapshotIdentityValid,
} from '../services/judgmentExecutionSnapshotService.ts'
import {
  deleteJudgmentJobSafelyTx,
  deletePendingJudgmentJobSqliteState,
  markJudgmentJobSqliteDeletePendingTx,
  retryPendingJudgmentJobSqliteDeletes,
} from '../services/judgmentJobDeleteService.ts'
import {
  getJudgmentJobSqliteHealthProjectionService,
  type JudgmentJobSqliteHealthProjectionReader,
  type JudgmentJobSqliteHealthProjectionRecord,
  type JudgmentJobSqliteHealthSnapshotForProjection,
} from '../services/judgmentJobSqliteHealthProjectionService.ts'
import {
  type JudgmentProviderTelemetryBucketedHistory,
  queryJudgmentProviderTelemetryBucketedHistory,
} from '../services/judgmentProviderTelemetryHistoryService.ts'
import {getTokenUseQueryService, TokenUseIdempotencyConflictError} from '../services/tokenUseQueryService.ts'
import {
  getDuckdbOwnerConnectionProxyHeaders,
  getDuckdbOwnerConnectionsOverview,
} from '../utils/duckdbOwnerConnections.ts'
import {HttpError} from '../utils/httpError.ts'
import {createRateLimitedLogger} from '../utils/rateLimitedLogger.ts'
import {withErrorHandler} from '../utils/routeErrorHandler'
import {probeDuckdbOwnerCutoverCompatibility} from '../utils/runtimeCutover.ts'
import {
  canCurrentServerOwnDuckdb,
  getCurrentServerDuckdbOwnerUrl,
  getCurrentServerRole,
  shouldCurrentServerProxyApiToOwner,
  shouldCurrentServerRunJudgingLoops,
} from '../utils/serverRuntimeRole.ts'
import {duckdbOwnerPrivateApiPrefix} from './apiRouteClassification.ts'

const judgmentJobServerId = getDefaultJudgmentServerJobId()
const judgmentsJobsLogger = createRateLimitedLogger({sink: 'both', windowMs: 30_000})

type JudgmentJobMutationState = {
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
  updatedAt: unknown
}
type JudgmentJobMutationQueryRunner = {queryJson: <T>(statement: string) => Promise<T[]>}
type JudgmentJobSqliteHealthSnapshot = JudgmentJobSqliteHealthSnapshotForProjection & {
  healthProjection?: {freshUntilAt: Date; projectedAt: Date; projectedBy: string | null; source: string}
}
type JudgmentJobSqliteHealthReadableJob = {id: string; storageState: string}
type JudgmentJobHealthAction =
  | 'none'
  | 'repair_offline_required'
  | 'repair_missing_sqlite'
  | 'repair_orphaned_queue'
  | 'wait_for_drain'
  | 'repair_quarantine'
  | 'resume_outbox_import'
  | 'retry_stale_import'
type JudgmentJobHealthBadge =
  | 'Healthy'
  | 'Draining'
  | 'Large WAL'
  | 'Offline Repair'
  | 'Orphaned Local Queue'
  | 'Quarantined'
  | 'Retained Outbox'
  | 'Stale Import'
type OwnerBackedRuntimeResolution = Pick<
  OwnerBackedJudgmentJobInfo,
  'resolvedRuntime' | 'runtimeMatchReason' | 'runtimeMatchStatus' | 'runtimeResolutionMode'
>
type OwnerBackedProviderSnapshot = ProviderBucketSnapshot
type UnassessedCountCacheValue = {value: number; expiresAt: number}
type ProjectMartFreshnessState = {
  dirtyToken: number | null
  failedMaterializationCount: number
  hasIncompleteDirtyMaterialization: boolean
  hasUnresolvedQuarantineBarrier: boolean
  isFresh: boolean
  lastCompletedDirtyToken: number | null
  pendingMaterializationCount: number
  refreshStatus: string | null
  runningMaterializationCount: number
  status: ProjectMartFreshnessStatus
  unresolvedQuarantineBarrierCount: number
  unreconciledMaterializationCount: number
}
type ProjectMartFreshnessStatus = 'fresh' | 'pending' | 'stale'
type FailedRequestDetailRecord = Record<string, unknown>
type FailedRequestSummary = {
  anthropicRefusalArticles: number
  anthropicRefusals: number
  persistedFailedRequests: number
}
type AnthropicRefusalSummary = Pick<FailedRequestSummary, 'anthropicRefusalArticles' | 'anthropicRefusals'>
type JudgmentJobBlockedReason =
  | 'endpoint_circuit_breaker'
  | 'endpoint_cooldown'
  | 'endpoint_misconfigured'
  | 'stale_import'
  | 'storage_repair_required'
  | 'waiting_for_judge_worker'
  | 'waiting_for_owner_ack'
  | null
type JudgmentJobProgressState =
  | 'active_import'
  | 'blocked_import'
  | 'completed'
  | 'cooldown'
  | 'idle'
  | 'processing'
  | 'queued'
  | 'repair_required'
  | 'waiting_for_owner_ack'
type JudgmentJobWorkIdentity = {
  modelId: string
  projectId: string
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useTitle: boolean
}
type JudgmentJobImportConsumerAvailability = {
  eligibleConsumerCount: number
  eligibleConsumerPresent: boolean
  freshConsumerCount: number
  freshConsumerPresent: boolean
  registeredConsumerCount: number
  requiredConsumerRole: 'judge-worker'
  staleConsumerCount: number
}
type JudgmentJobImportWorkLease = {
  consumerId: string | null
  freshUntilAt: string | null
  lastProgressedAt: string | null
  lastStartedAt: string | null
  recoveryContext: Record<string, unknown> | null
  recoveryMode: 'archived_project_mart_recovery' | 'none' | 'retry_backoff'
  retryAfterAt: string | null
}
type JudgmentJobEndpointHealth = {
  diagnostics:
    | (ReturnType<typeof getJudgmentEndpointAvailabilityDiagnostics> & {
        effectiveBaseURL: string | null
        endpointAvailabilityKey: string
        endpointIdentity: string | null
        localProbeState: string
        providerKey: string
      })
    | null
  providerDiagnostics: {
    endpointDiagnosticsByKey: Record<
      string,
      ReturnType<typeof getJudgmentEndpointAvailabilityDiagnostics> & {
        effectiveBaseURL: string | null
        endpointAvailabilityKey: string
        endpointIdentity: string | null
        localProbeState: string
        providerKey: string
      }
    >
    endpointDiagnosticsSummary: {
      blockedEndpointCount: number
      cooldownEndpointCount: number
      endpointCount: number
      hasHealthyEndpointOrEndpointlessPath: boolean
      healthyEndpointCount: number
      localProbeLiveCount: number
      misconfiguredEndpointCount: number
      observedAggregateProbeLiveCount: number | null
      probeInProgress: boolean
      providerKey: string
      probingEndpointCount: number
      unhealthyEndpointCount: number
    }
    providerKey: string
  }
  retryAfterAt: string | null
}
type JudgmentJobHealthProgress = {
  activeConsumerCount: number
  activeImportWorkCount: number
  blockedReason: JudgmentJobBlockedReason
  importBacklogCount: number
  importConsumer: JudgmentJobImportConsumerAvailability
  importWork: {
    activeConsumerCount: number
    activeWorkCount: number
    claimedOutboxCount: number
    hasBacklog: boolean
    outboxRowCount: number
    pendingCompletionAckCount: number
    workIdentity: JudgmentJobWorkIdentity
  }
  lastProgressedAt: string | null
  lastStartedAt: string | null
  progressState: JudgmentJobProgressState
  recoveryContext: Record<string, unknown> | null
  recoveryMode: 'archived_project_mart_recovery' | 'none' | 'retry_backoff'
  retryAfterAt: string | null
  runningWork: {
    activePromptCount: number
    claimedPromptCount: number
    judgedPromptCount: number
    readyPromptCount: number
    runningPromptCount: number
    skippedPromptCount: number
    workIdentity: JudgmentJobWorkIdentity
  }
  workIdentity: JudgmentJobWorkIdentity
}
type JudgmentCompletionIdentity = {
  articleId: string
  claimId: string
  executionSnapshotHash: string
  executionSnapshotId: string
  jobId: string
  modelId: string
  projectId: string
  promptId: string
  queueRecordId: string
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useTitle: boolean
}
type JudgmentCompletionBody = JudgmentCompletionIdentity & {
  answeredOriginal?: unknown
  answeredOriginalAsArray?: unknown
  chunkingStrategy?: string | null
  confidenceOriginal?: number
  explanation?: string | null
  isAnswered?: boolean
  judgment?: unknown
  judgmentId?: string
  quotes?: unknown
  rawResponseJson?: unknown
  requestAttempts?: JudgmentRequestAttemptJsonEntry[] | null
  retryAfterMs?: number | null
  skipReason?: 'conversion_failed' | 'fulltext_too_large' | 'no_fulltext'
  status?: 'completed' | 'failed' | 'judged' | 'retry' | 'skipped' | 'succeeded'
  tokenUse?: JudgmentCompletionTokenUseSummary | null
}
type JudgmentCompletionTokenUseSummary = {
  dpSize?: number | null
  duration?: number | null
  failedRequests: number
  failedRequestsDetails: unknown[]
  finishedAt?: string | null
  gpuGpusPerNode?: number | null
  gpuNnodes?: number | null
  gpuShape?: string | null
  gpuTotalGpus?: number | null
  hasFailedRequests: boolean
  modelName: string | null
  sglangMaxRunningRequests?: number | null
  startedAt?: string | null
  successfulRequests: number
  tpSize?: number | null
  totalCompletionTokens: number
  totalFailedCompletionTokens: number
  totalFailedPromptTokens: number
  totalFailedTokens: number
  totalPromptTokens: number
  totalRequests: number
  totalSuccessCompletionTokens: number
  totalSuccessPromptTokens: number
  totalSuccessTokens: number
  totalTokens: number
  requestAttempts?: JudgmentRequestAttemptJsonEntry[] | null
}
type JudgmentClaimRequestBody = {claimedBy?: string; limit?: number; protectedRecordIds?: string[]}
type JudgmentWorkerHeartbeatBody = {claimedBy?: string; jobIds?: string[]}
type JudgmentSnapshotQuery = {executionSnapshotHash?: string; hash?: string}
const unassessedCountTTLms = 10_000
const abandonedClaimGraceMs = 30_000
const ownerBackedClaimRecoveryIntervalMs = 15_000
const staleImportThresholdMs = 15 * 60 * 1_000
const largeWalThresholdBytes = 64 * 1_024 * 1_024
const unassessedCountCache = new Map<string, UnassessedCountCacheValue>()
const ownerBackedClaimRecoveryCheckedAt = new Map<string, number>()
const systemSqliteFallbackStepsSchema = t.Array(
  t.Union([t.Literal('checkpoint'), t.Literal('diagnostic'), t.Literal('export')]),
)
const judgmentClaimRequestSchema = t.Optional(
  t.Object({
    claimedBy: t.Optional(t.String()),
    limit: t.Optional(t.Number()),
    protectedRecordIds: t.Optional(t.Array(t.String())),
  }),
)
const judgmentWorkerHeartbeatBodySchema = t.Optional(
  t.Object({claimedBy: t.Optional(t.String()), jobIds: t.Optional(t.Array(t.String()))}),
)
const judgmentCompletionBodySchema = t.Object({
  articleId: t.String(),
  claimId: t.String(),
  executionSnapshotHash: t.String(),
  executionSnapshotId: t.String(),
  jobId: t.String(),
  modelId: t.String(),
  projectId: t.String(),
  promptId: t.String(),
  queueRecordId: t.String(),
  useAbstract: t.Boolean(),
  useFulltext: t.Boolean(),
  useFulltextNoImages: t.Boolean(),
  useTitle: t.Boolean(),
  answeredOriginal: t.Optional(t.Any()),
  answeredOriginalAsArray: t.Optional(t.Any()),
  chunkingStrategy: t.Optional(t.Union([t.String(), t.Null()])),
  confidenceOriginal: t.Optional(t.Number()),
  explanation: t.Optional(t.Union([t.String(), t.Null()])),
  isAnswered: t.Optional(t.Boolean()),
  judgment: t.Optional(t.Any()),
  judgmentId: t.Optional(t.String()),
  quotes: t.Optional(t.Any()),
  rawResponseJson: t.Optional(t.Any()),
  requestAttempts: t.Optional(t.Union([t.Array(t.Any()), t.Null()])),
  retryAfterMs: t.Optional(t.Union([t.Number(), t.Null()])),
  skipReason: t.Optional(
    t.Union([t.Literal('conversion_failed'), t.Literal('fulltext_too_large'), t.Literal('no_fulltext')]),
  ),
  status: t.Optional(
    t.Union([
      t.Literal('completed'),
      t.Literal('failed'),
      t.Literal('judged'),
      t.Literal('retry'),
      t.Literal('skipped'),
      t.Literal('succeeded'),
    ]),
  ),
  tokenUse: t.Optional(
    t.Union([
      t.Null(),
      t.Object({
        dpSize: t.Optional(t.Union([t.Number(), t.Null()])),
        duration: t.Optional(t.Union([t.Number(), t.Null()])),
        failedRequests: t.Number(),
        failedRequestsDetails: t.Array(t.Any()),
        finishedAt: t.Optional(t.Union([t.String(), t.Null()])),
        gpuGpusPerNode: t.Optional(t.Union([t.Number(), t.Null()])),
        gpuNnodes: t.Optional(t.Union([t.Number(), t.Null()])),
        gpuShape: t.Optional(t.Union([t.String(), t.Null()])),
        gpuTotalGpus: t.Optional(t.Union([t.Number(), t.Null()])),
        hasFailedRequests: t.Boolean(),
        modelName: t.Union([t.String(), t.Null()]),
        sglangMaxRunningRequests: t.Optional(t.Union([t.Number(), t.Null()])),
        startedAt: t.Optional(t.Union([t.String(), t.Null()])),
        successfulRequests: t.Number(),
        tpSize: t.Optional(t.Union([t.Number(), t.Null()])),
        totalCompletionTokens: t.Number(),
        totalFailedCompletionTokens: t.Number(),
        totalFailedPromptTokens: t.Number(),
        totalFailedTokens: t.Number(),
        totalPromptTokens: t.Number(),
        totalRequests: t.Number(),
        totalSuccessCompletionTokens: t.Number(),
        totalSuccessPromptTokens: t.Number(),
        totalSuccessTokens: t.Number(),
        totalTokens: t.Number(),
        requestAttempts: t.Optional(t.Union([t.Array(t.Any()), t.Null()])),
      }),
    ]),
  ),
})
const judgmentSnapshotQuerySchema = t.Object({
  executionSnapshotHash: t.Optional(t.String()),
  hash: t.Optional(t.String()),
})
const judgmentProviderTelemetryHistoryQuerySchema = t.Object({
  jobId: t.String(),
  providerKey: t.Optional(t.String()),
  range: t.Union([t.Literal('5m'), t.Literal('15m'), t.Literal('1h'), t.Literal('24h'), t.Literal('3d')]),
})

const getJudgmentJobsReadDatabase = (): JudgmentJobSqliteHealthProjectionReader => {
  return getCurrentServerRole() === 'api' ? getApiReadOnlyAppDatabaseService() : getAppDatabaseService()
}

const getMaintenanceUnavailableError = (message: string, cause?: unknown) => {
  return new HttpError(503, `maintenance-unavailable: ${message}`, {cause})
}

const getJudgmentJobsOwnerProxyData = async <T>(request: Request): Promise<T | null> => {
  if (getCurrentServerRole() !== 'api' || !shouldCurrentServerProxyApiToOwner()) {
    return null
  }

  const duckdbOwnerUrl = await getCurrentServerDuckdbOwnerUrl()

  if (duckdbOwnerUrl === null) {
    return null
  }

  const compatibility = await probeDuckdbOwnerCutoverCompatibility(duckdbOwnerUrl, 'DuckDB owner proxy target')

  if (compatibility.status === 'incompatible') {
    throw new HttpError(426, compatibility.message)
  }

  const requestUrl = new URL(request.url)
  const headers = new Headers({
    ...Object.fromEntries(request.headers.entries()),
    ...getDuckdbOwnerConnectionProxyHeaders(),
  })

  const response = await fetch(
    new Request(`${duckdbOwnerUrl}${duckdbOwnerPrivateApiPrefix}${requestUrl.pathname}${requestUrl.search}`, {
      headers,
      method: request.method,
    }),
  )
  const rawBody = await response.text()
  const body = (() => {
    if (rawBody.trim() === '') {
      return null
    }

    try {
      return JSON.parse(rawBody) as T
    } catch {
      return null
    }
  })()

  if (response.ok) {
    if (body !== null) {
      return body
    }

    throw new HttpError(502, 'DuckDB owner proxy target returned invalid JSON')
  }

  const errorMessage =
    typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string'
      ? body.error
      : rawBody.trim() !== ''
        ? rawBody.trim()
        : 'DuckDB owner proxy target unavailable'

  throw new HttpError(response.status, errorMessage)
}

const getNormalizedClaimLimit = (limit: number | null | undefined) => {
  return Number.isFinite(limit) ? Math.max(0, Math.floor(limit ?? 0)) : 1
}

const getOwnerBackedClaimRecoveryKey = (jobId: string, claimedBy: string) => {
  return `${jobId}:${claimedBy}`
}

const shouldRunOwnerBackedClaimRecovery = (jobId: string, claimedBy: string) => {
  const key = getOwnerBackedClaimRecoveryKey(jobId, claimedBy)
  const now = Date.now()
  const checkedAt = ownerBackedClaimRecoveryCheckedAt.get(key) ?? 0
  const shouldRun = now - checkedAt >= ownerBackedClaimRecoveryIntervalMs

  if (shouldRun) {
    ownerBackedClaimRecoveryCheckedAt.set(key, now)
  }

  return shouldRun
}

const getRouteErrorMessage = (error: unknown) => {
  return error instanceof Error ? error.message : String(error)
}

const getOwnerBackedClaimResponse = (
  claims: Awaited<ReturnType<ReturnType<typeof getJudgmentJobSqliteService>['claimReadyPrompts']>>,
) => {
  return claims.map(({executionSnapshotPayload: _executionSnapshotPayload, ...claim}) => {
    return claim
  })
}

const runOwnerBackedClaimRecovery = async ({
  claimedBy,
  jobId,
  protectedRecordIds,
}: {
  claimedBy: string
  jobId: string
  protectedRecordIds?: string[]
}): Promise<void> => {
  if (!shouldRunOwnerBackedClaimRecovery(jobId, claimedBy)) {
    return
  }

  await getJudgmentJobSqliteService()
    .requeueAbandonedSentPrompts({
      jobId,
      serverJobId: claimedBy,
      staleBefore: new Date(Date.now() - abandonedClaimGraceMs),
      ...(protectedRecordIds !== undefined ? {protectedRecordIds} : {}),
    })
    .catch((error) => {
      console.warn('[judgmentsJobs] owner-backed claim recovery failed', {
        claimedBy,
        error: getRouteErrorMessage(error),
        jobId,
      })
    })
}

const getOwnerBackedRunningJudgmentJobs = async (): Promise<RunningJudgmentJob[]> => {
  const rows = await getApiReadOnlyAppDatabaseService().queryJson<
    Omit<RunningJudgmentJob, 'providerName'> & {
      providerConnectionUpdatedAt: Date | string | null
      providerName: string | null
    }
  >(
    `
    SELECT
      jj.id AS id,
      jj.project_id AS projectId,
      pc.max_inflight_requests AS maxInflightRequests,
      pc.provider_kind AS modelProvider,
      pc.label AS providerName,
      pc.updated_at AS providerConnectionUpdatedAt,
      m.id AS modelId,
      m.remote_model_id AS modelName,
      jj.quarantine_reason AS quarantineReason,
      m.provider_connection_id AS providerConnectionId,
      jj.storage_state AS storageState
    FROM app.judgment_job jj
    INNER JOIN app.project p ON jj.project_id = p.id
    INNER JOIN app.model m ON p.model_id = m.id
    LEFT JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
    WHERE jj.status = 'running'
      AND jj.storage_state = 'active'
      AND p.archived = FALSE
      AND COALESCE(m.enabled, TRUE) = TRUE
      AND COALESCE(pc.enabled, TRUE) = TRUE
    ORDER BY jj.created_at ASC, jj.id ASC
  `,
    {maxResultRows: 500, routeOrJobKey: 'judgments.runningJobs', workloadClass: 'foreground-diagnostic'},
  )

  return rows.map((row) => {
    return attachProviderBucketSnapshotToRunningJob(row, true)
  })
}

const normalizeOwnerBackedProvider = (value: string | null | undefined): string => {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()

  return normalized.length > 0 ? normalized : 'unknown'
}

const getCodexOwnerBackedRuntime = (): OwnerBackedRuntimeResolution => {
  return {
    resolvedRuntime: {modelBaseUrl: 'codex://app-server', modelProvider: 'codex', modelWorkerUrls: []},
    runtimeMatchReason: 'manual-provider',
    runtimeMatchStatus: 'matched',
    runtimeResolutionMode: 'manual',
  }
}

const getOwnerBackedRuntimeMatch = async ({
  baseURL,
  modelName,
  providerConfigJson,
  providerKind,
}: {
  baseURL: string | null
  modelName: string
  providerConfigJson: unknown
  providerKind: string
}): Promise<OwnerBackedRuntimeResolution> => {
  if (providerKind === 'codex') {
    return getCodexOwnerBackedRuntime()
  }

  const config = getProviderConnectionConfigFromJson({providerKind, value: providerConfigJson})
  const runtimeMatch = await resolveProviderConnectionRuntimeMatch({
    baseURL,
    config,
    providerKind,
    savedModelIds: [modelName],
  })
  const shouldUseMatchedRuntime = runtimeMatch.resolutionMode === 'manual' || runtimeMatch.status === 'matched'
  const resolvedRuntime =
    shouldUseMatchedRuntime && runtimeMatch.effectiveBaseURL
      ? {
          modelBaseUrl: runtimeMatch.effectiveBaseURL,
          modelProvider: providerKind,
          modelWorkerUrls: runtimeMatch.effectiveWorkerUrls,
        }
      : null

  return {
    resolvedRuntime,
    runtimeMatchReason: runtimeMatch.reason,
    runtimeMatchStatus: runtimeMatch.status,
    runtimeResolutionMode: runtimeMatch.resolutionMode,
  }
}

const getOwnerBackedJudgmentJobRuntime = async (jobId: string): Promise<OwnerBackedJudgmentJobInfo | null> => {
  const [row] = await getAppDatabaseService().queryJson<{
    maxInflightRequests: number | null
    modelBaseUrl: string | null
    modelId: string | null
    modelMetadataJson: unknown
    modelName: string | null
    modelProvider: string | null
    modelSecretRef: string | null
    modelVersion: string | null
    projectId: string | null
    providerConfigJson: unknown
    providerConnectionId: string | null
    providerConnectionUpdatedAt: Date | string | null
    providerName: string | null
    useAbstract: boolean | null
    useFulltext: boolean | null
    useFulltextNoImages: boolean | null
    useTitle: boolean | null
  }>(`
    SELECT
      jj.project_id AS projectId,
      p.model_id AS modelId,
      pc.id AS providerConnectionId,
      pc.secret_ref AS modelSecretRef,
      COALESCE(pc.provider_kind, 'unknown') AS modelProvider,
      pc.label AS providerName,
      COALESCE(m.remote_model_id, m.name, m.display_name) AS modelName,
      m.variant AS modelVersion,
      TO_JSON(m.metadata_json) AS modelMetadataJson,
      pc.base_url AS modelBaseUrl,
      pc.max_inflight_requests AS maxInflightRequests,
      pc.updated_at AS providerConnectionUpdatedAt,
      TO_JSON(pc.config_json) AS providerConfigJson,
      p.use_title AS useTitle,
      p.use_abstract AS useAbstract,
      p.use_fulltext AS useFulltext,
      p.use_fulltext_no_images AS useFulltextNoImages
    FROM app.judgment_job jj
    INNER JOIN app.project p ON p.id = jj.project_id
    INNER JOIN app.model m ON m.id = p.model_id
    LEFT JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
    WHERE jj.id = ${getSqlLiteral(jobId)}
      AND jj.status = 'running'
      AND jj.storage_state = 'active'
    LIMIT 1
  `)

  if (!row?.projectId || !row.modelId || !row.modelName) {
    return null
  }

  const providerKind = normalizeOwnerBackedProvider(row.modelProvider)
  const providerConfigJson = getJsonValue(row.providerConfigJson)
  const providerSnapshot: OwnerBackedProviderSnapshot = getProviderBucketSnapshot({
    maxInflightRequests: row.maxInflightRequests ?? null,
    modelId: row.modelId,
    modelProvider: providerKind,
    providerConnectionId: row.providerConnectionId ?? null,
    providerConnectionUpdatedAt: row.providerConnectionUpdatedAt,
    providerName: row.providerName ?? row.modelName,
    useOwnerBackedSyntheticProviderId: true,
  })
  const runtimeMatch = await getOwnerBackedRuntimeMatch({
    baseURL: row.modelBaseUrl ?? null,
    modelName: row.modelName,
    providerConfigJson,
    providerKind,
  })

  return {
    modelBaseUrl: row.modelBaseUrl ?? null,
    modelId: row.modelId,
    modelMetadataJson: getJsonValue(row.modelMetadataJson),
    modelName: row.modelName,
    modelProvider: providerKind,
    modelSecretRef: row.modelSecretRef ?? null,
    modelVersion: row.modelVersion ?? null,
    projectId: row.projectId,
    ...providerSnapshot,
    providerConfigJson,
    ...runtimeMatch,
    useAbstract: row.useAbstract ?? true,
    useFulltext: row.useFulltext ?? false,
    useFulltextNoImages: row.useFulltextNoImages ?? false,
    useTitle: row.useTitle ?? true,
  }
}

const claimJudgmentJobPrompts = async (jobId: string, body: JudgmentClaimRequestBody | undefined) => {
  const claimedBy = body?.claimedBy ?? judgmentJobServerId
  await runOwnerBackedClaimRecovery({claimedBy, jobId, protectedRecordIds: body?.protectedRecordIds})

  try {
    const claims = await getJudgmentJobSqliteService().claimReadyPrompts(
      jobId,
      claimedBy,
      getNormalizedClaimLimit(body?.limit ?? 1),
    )

    return {data: {claims: getOwnerBackedClaimResponse(claims)}, error: null}
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)

    if (isTransientJudgmentJobSqliteLockMessage(errorMessage)) {
      throw getMaintenanceUnavailableError(errorMessage, error)
    }

    throw error
  }
}

const recordJudgmentJobWorkerHeartbeat = async (body: JudgmentWorkerHeartbeatBody | undefined) => {
  const claimedBy = body?.claimedBy ?? judgmentJobServerId
  const jobIds = Array.from(new Set(body?.jobIds ?? []))
  const recorded = await Promise.all(
    jobIds.map((jobId) => {
      return getJudgmentJobSqliteService().recordWorkerHeartbeat(jobId, claimedBy)
    }),
  )
  const recordedJobIds = jobIds.filter((_jobId, index) => {
    return recorded[index] === true
  })

  return {data: {jobIds: recordedJobIds}, error: null}
}

const getJudgmentValueRecord = (body: JudgmentCompletionBody): Record<string, unknown> => {
  return body.judgment && typeof body.judgment === 'object' && !Array.isArray(body.judgment)
    ? (body.judgment as Record<string, unknown>)
    : body
}

const getStringArray = (value: unknown): string[] => {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => {
        return typeof entry === 'string'
      })
    : []
}

const getCompletionAnsweredOriginal = (value: unknown): string | null => {
  return Array.isArray(value)
    ? JSON.stringify(getStringArray(value))
    : typeof value === 'string'
      ? value
      : value == null
        ? null
        : JSON.stringify(value)
}

const getCompletionAnsweredOriginalAsArray = (value: unknown, fallback: unknown): string[] => {
  const explicit = getStringArray(value)

  return explicit.length > 0
    ? explicit
    : Array.isArray(fallback)
      ? getStringArray(fallback)
      : typeof fallback === 'string'
        ? [fallback]
        : []
}

const assertCompletionSnapshotIdentity = async (identity: JudgmentCompletionIdentity) => {
  const snapshotValid = await isJudgmentExecutionSnapshotIdentityValid(identity)

  if (!snapshotValid) {
    throw new HttpError(409, 'snapshot identity mismatch for judgment completion')
  }
}

const assertCompletionClaimIdentity = async (
  identity: JudgmentCompletionIdentity,
  options: {allowUnclaimedReadyPrompt?: boolean} = {},
) => {
  try {
    await getJudgmentJobSqliteService().assertPromptClaimIdentity(identity, options)
  } catch (error) {
    if (error instanceof JudgmentPromptClaimIdentityError) {
      throw new HttpError(409, error.message)
    }

    throw error
  }
}

const getCompletionTokenUseId = (body: JudgmentCompletionBody) => {
  return `judgment-completion-token-use:${body.claimId}`
}

const getCompletionRequestAttempts = (body: JudgmentCompletionBody): JudgmentRequestAttemptJsonEntry[] => {
  return body.tokenUse?.requestAttempts ?? body.requestAttempts ?? []
}

const getCompletionRequestAttemptsJson = (
  body: JudgmentCompletionBody,
  closeoutKind: JudgmentRequestAttemptJsonEntry['closeoutKind'],
  id?: string | null,
) => {
  const requestAttempts = getCompletionRequestAttempts(body)

  return stringifyRequestAttempts(
    withDurableCloseoutRef({
      closeoutKind,
      ref: {claimId: body.claimId, id: id ?? null, jobId: body.jobId, queueRecordId: body.queueRecordId},
      requestAttempts,
    }),
  )
}

const getCompletionTokenUseIdOrNull = (body: JudgmentCompletionBody): string | null => {
  return body.tokenUse && body.tokenUse.totalRequests > 0 ? getCompletionTokenUseId(body) : null
}

const applyCompletionTokenUseOnce = async (body: JudgmentCompletionBody): Promise<string | null> => {
  const tokenUse = body.tokenUse

  if (!tokenUse || tokenUse.totalRequests <= 0) {
    return null
  }

  const tokenUseId = getCompletionTokenUseId(body)
  const startedAt = tokenUse.startedAt ? new Date(tokenUse.startedAt) : null
  const finishedAt = tokenUse.finishedAt ? new Date(tokenUse.finishedAt) : null

  await getTokenUseQueryService().insertTokenUseOnce({
    id: tokenUseId,
    judgment_job_id: body.jobId,
    gpu_nnodes: tokenUse.gpuNnodes ?? null,
    gpu_gpus_per_node: tokenUse.gpuGpusPerNode ?? null,
    gpu_total_gpus: tokenUse.gpuTotalGpus ?? null,
    tp_size: tokenUse.tpSize ?? null,
    dp_size: tokenUse.dpSize ?? null,
    gpu_shape: tokenUse.gpuShape ?? null,
    sglang_max_running_requests: tokenUse.sglangMaxRunningRequests ?? null,
    sglang_model: tokenUse.modelName,
    requests: tokenUse.totalRequests,
    total_prompt_tokens: tokenUse.totalPromptTokens,
    total_completion_tokens: tokenUse.totalCompletionTokens,
    total_tokens: tokenUse.totalTokens,
    successful_requests: tokenUse.successfulRequests,
    failed_requests: tokenUse.failedRequests,
    has_failed_requests: tokenUse.hasFailedRequests,
    failed_requests_details: tokenUse.failedRequestsDetails.length > 0 ? tokenUse.failedRequestsDetails : null,
    total_success_prompt_tokens: tokenUse.totalSuccessPromptTokens,
    total_success_completion_tokens: tokenUse.totalSuccessCompletionTokens,
    total_success_tokens: tokenUse.totalSuccessTokens,
    total_failed_prompt_tokens: tokenUse.totalFailedPromptTokens,
    total_failed_completion_tokens: tokenUse.totalFailedCompletionTokens,
    total_failed_tokens: tokenUse.totalFailedTokens,
    request_attempts_json: getCompletionRequestAttemptsJson(body, 'token_use', tokenUseId),
    started_at: startedAt,
    finished_at: finishedAt,
    duration: tokenUse.duration == null ? null : Math.round(tokenUse.duration),
  })

  return tokenUseId
}

const logAcceptedCompletionTokenUseConflict = (
  body: JudgmentCompletionBody,
  error: TokenUseIdempotencyConflictError,
): void => {
  judgmentsJobsLogger.warn(
    `judgmentsJobs:completion-token-use-conflict:${body.claimId}`,
    '[judgmentsJobs] completion token use replay conflict ignored after accepted completion',
    {
      claimId: body.claimId,
      jobId: body.jobId,
      mismatch: error.mismatch,
      queueRecordId: body.queueRecordId,
      tokenUseId: error.id,
    },
  )
}

const applyAcceptedCompletionTokenUseOnce = async (body: JudgmentCompletionBody): Promise<string | null> => {
  try {
    return await applyCompletionTokenUseOnce(body)
  } catch (error) {
    if (error instanceof TokenUseIdempotencyConflictError) {
      logAcceptedCompletionTokenUseConflict(body, error)
      return getCompletionTokenUseIdOrNull(body)
    }

    throw error
  }
}

const getExistingCompletionAckResponse = async (jobId: string, body: JudgmentCompletionBody) => {
  const existingAck = await getJudgmentJobSqliteService().getPromptCompletionAck(jobId, body.claimId)

  if (!existingAck) {
    return null
  }

  const snapshotValid = await isJudgmentExecutionSnapshotIdentityValid({...body, jobId})

  if (!snapshotValid || existingAck.queuePromptId !== body.queueRecordId) {
    throw new HttpError(409, 'snapshot identity mismatch for replayed judgment completion')
  }

  await applyAcceptedCompletionTokenUseOnce(body)

  return {
    data: {claimId: body.claimId, queueRecordId: existingAck.queuePromptId, status: existingAck.status},
    error: null,
  }
}

const completeJudgmentJobPrompt = async (jobId: string, body: JudgmentCompletionBody) => {
  if (body.jobId !== jobId) {
    throw new HttpError(409, 'jobId mismatch for judgment completion')
  }

  const existingAckResponse = await getExistingCompletionAckResponse(jobId, body)

  if (existingAckResponse) {
    return existingAckResponse
  }

  const identity = {...body, jobId}
  const allowUnclaimedReadyPrompt = !['failed', 'retry', 'skipped'].includes(body.status ?? '')

  await assertCompletionSnapshotIdentity(identity)
  await assertCompletionClaimIdentity(identity, {allowUnclaimedReadyPrompt})
  const tokenUseId = getCompletionTokenUseIdOrNull(body)
  const completionAckRequestAttemptsJson = getCompletionRequestAttemptsJson(body, 'completion_ack', tokenUseId)

  if (body.status === 'retry') {
    await getJudgmentJobSqliteService().markPromptAsRetry(jobId, body.queueRecordId, body.retryAfterMs ?? null, {
      claimId: body.claimId,
      queuePromptId: body.queueRecordId,
      status: 'retry',
      requestAttemptsJson: completionAckRequestAttemptsJson,
      tokenUseId,
    })
    await applyAcceptedCompletionTokenUseOnce(body)
    return {data: {claimId: body.claimId, queueRecordId: body.queueRecordId, status: 'retry'}, error: null}
  }

  if (body.status === 'skipped') {
    await getJudgmentJobSqliteService().markPromptAsSkipped(
      jobId,
      body.queueRecordId,
      body.skipReason ?? 'no_fulltext',
      {
        claimId: body.claimId,
        queuePromptId: body.queueRecordId,
        status: 'skipped',
        requestAttemptsJson: completionAckRequestAttemptsJson,
        tokenUseId,
      },
    )
    await applyAcceptedCompletionTokenUseOnce(body)
    return {data: {claimId: body.claimId, queueRecordId: body.queueRecordId, status: 'skipped'}, error: null}
  }

  if (body.status === 'failed') {
    await getJudgmentJobSqliteService().markPromptAsClosed(jobId, body.queueRecordId, 'ownerCompletionFailed', {
      claimId: body.claimId,
      queuePromptId: body.queueRecordId,
      status: 'failed',
      requestAttemptsJson: completionAckRequestAttemptsJson,
      tokenUseId,
    })
    await applyAcceptedCompletionTokenUseOnce(body)
    return {data: {claimId: body.claimId, queueRecordId: body.queueRecordId, status: 'failed'}, error: null}
  }

  const judgment = getJudgmentValueRecord(body)
  const answer = judgment.answer ?? body.answeredOriginal
  const now = new Date()
  const judgmentId = body.judgmentId ?? crypto.randomUUID()

  try {
    await getJudgmentJobSqliteService().recordJudgmentSuccess(
      jobId,
      {
        answeredOriginal: getCompletionAnsweredOriginal(body.answeredOriginal ?? answer),
        answeredOriginalAsArray: getCompletionAnsweredOriginalAsArray(body.answeredOriginalAsArray, answer),
        articleId: body.articleId,
        claimId: body.claimId,
        chunkingStrategy: body.chunkingStrategy ?? null,
        confidenceOriginal: body.confidenceOriginal ?? 50,
        createdAt: getDateValue(judgment.createdAt) ?? now,
        explanation: body.explanation ?? (typeof judgment.explanation === 'string' ? judgment.explanation : null),
        executionSnapshotHash: body.executionSnapshotHash,
        executionSnapshotId: body.executionSnapshotId,
        isAnswered: body.isAnswered ?? true,
        judgmentId,
        modelId: body.modelId,
        projectId: body.projectId,
        promptId: body.promptId,
        queuePromptId: body.queueRecordId,
        completionTokenUseId: tokenUseId,
        quotes: body.quotes ?? judgment.quotes ?? null,
        rawResponseJson: body.rawResponseJson ?? body.judgment ?? null,
        requestAttemptsJson: getCompletionRequestAttemptsJson(body, 'judgment_outbox', judgmentId),
        snapshotProjectId: body.projectId,
        snapshotProjectModelName: null,
        updatedAt: getDateValue(judgment.updatedAt) ?? now,
        useAbstract: body.useAbstract,
        useFulltext: body.useFulltext,
        useFulltextNoImages: body.useFulltextNoImages,
        useTitle: body.useTitle,
      },
      {allowUnclaimedReadyPrompt},
    )
  } catch (error) {
    if (error instanceof JudgmentPromptClaimIdentityError) {
      throw new HttpError(409, error.message)
    }

    throw error
  }
  await applyAcceptedCompletionTokenUseOnce(body)

  return {data: {claimId: body.claimId, queueRecordId: body.queueRecordId, status: 'judged'}, error: null}
}

const fetchJudgmentExecutionSnapshot = async (executionSnapshotId: string, query: JudgmentSnapshotQuery) => {
  const executionSnapshotHash = query.executionSnapshotHash ?? query.hash

  if (!executionSnapshotHash) {
    throw new HttpError(400, 'executionSnapshotHash is required')
  }

  const snapshot = await getJudgmentExecutionSnapshot({executionSnapshotHash, executionSnapshotId})

  if (!snapshot) {
    throw new HttpError(404, 'judgment execution snapshot not found')
  }

  return {data: snapshot, error: null}
}

const runJudgmentJobsRead = async <T>({
  operation,
  request,
}: {
  operation: () => Promise<T>
  request: Request
}): Promise<T> => {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof HttpError) {
      throw error
    }

    const proxyResponse = await getJudgmentJobsOwnerProxyData<T>(request)

    if (proxyResponse !== null) {
      return proxyResponse
    }

    if (getCurrentServerRole() === 'api') {
      throw getMaintenanceUnavailableError('judgment job read model is unavailable', error)
    }

    throw error
  }
}

const getUnassessedCountCacheKey = (
  projectId: string,
  projectModelId: string,
  projectDateFrom: Date | null | undefined,
  projectDateTo: Date | null | undefined,
  importRouteIds: string[],
  useTitle: boolean,
  useAbstract: boolean,
  useFulltext: boolean,
  useFulltextNoImages: boolean,
  dirtyToken: number | null,
  lastCompletedDirtyToken: number | null,
) => {
  const from = projectDateFrom ? projectDateFrom.toISOString() : ''
  const to = projectDateTo ? projectDateTo.toISOString() : ''
  const routes = importRouteIds.slice().sort().join(',')
  const content = `${useTitle}|${useAbstract}|${useFulltext}|${useFulltextNoImages}`
  return `${projectId}|${projectModelId}|${from}|${to}|${routes}|${content}|${dirtyToken ?? 'null'}|${lastCompletedDirtyToken ?? 'null'}`
}

const getProjectMartFreshnessStatus = (params: {
  failedMaterializationCount: number
  hasUnresolvedQuarantineBarrier: boolean
  isFresh: boolean
  refreshStatus: string | null
  unreconciledMaterializationCount: number
}): ProjectMartFreshnessStatus => {
  return params.isFresh
    ? 'fresh'
    : params.hasUnresolvedQuarantineBarrier
        || params.failedMaterializationCount > 0
        || params.unreconciledMaterializationCount > 0
        || params.refreshStatus === 'failed'
      ? 'stale'
      : 'pending'
}

const getProjectMartFreshnessPayload = (freshness: ProjectMartFreshnessState) => {
  return {
    dirtyToken: freshness.dirtyToken,
    failedMaterializationCount: freshness.failedMaterializationCount,
    hasIncompleteDirtyMaterialization: freshness.hasIncompleteDirtyMaterialization,
    hasUnresolvedQuarantineBarrier: freshness.hasUnresolvedQuarantineBarrier,
    isFresh: freshness.isFresh,
    lastCompletedDirtyToken: freshness.lastCompletedDirtyToken,
    pendingMaterializationCount: freshness.pendingMaterializationCount,
    refreshStatus: freshness.refreshStatus,
    runningMaterializationCount: freshness.runningMaterializationCount,
    status: freshness.status,
    unresolvedQuarantineBarrierCount: freshness.unresolvedQuarantineBarrierCount,
    unreconciledMaterializationCount: freshness.unreconciledMaterializationCount,
  }
}

export const getProjectMartFreshnessState = async (
  projectId: string,
  db: JudgmentJobSqliteHealthProjectionReader = getAppDatabaseService(),
): Promise<ProjectMartFreshnessState> => {
  const [row] = await db.queryJson<{
    dirtyToken: number | null
    failedMaterializationCount: number | null
    incompleteMaterializationCount: number | null
    lastCompletedDirtyToken: number | null
    pendingMaterializationCount: number | null
    refreshStatus: string | null
    runningMaterializationCount: number | null
    unresolvedQuarantineBarrierCount: number | null
    unreconciledMaterializationCount: number | null
  }>(`
    WITH refresh_state AS (
      SELECT
        project_id,
        dirty_token,
        last_completed_dirty_token,
        refresh_status
      FROM app.project_mart_refresh_state
      WHERE project_id = ${getSqlLiteral(projectId)}
      LIMIT 1
    ),
    materialization_summary AS (
      SELECT
        CAST(COUNT(*) FILTER (WHERE materialization.materialization_status <> 'completed') AS INTEGER) AS incompleteMaterializationCount,
        CAST(COUNT(*) FILTER (WHERE materialization.materialization_status = 'pending') AS INTEGER) AS pendingMaterializationCount,
        CAST(COUNT(*) FILTER (WHERE materialization.materialization_status = 'running') AS INTEGER) AS runningMaterializationCount,
        CAST(COUNT(*) FILTER (WHERE materialization.materialization_status = 'failed') AS INTEGER) AS failedMaterializationCount,
        CAST(COUNT(*) FILTER (WHERE materialization.materialization_status = 'unreconciled') AS INTEGER) AS unreconciledMaterializationCount
        FROM app.project_mart_dirty_materialization_state materialization
        INNER JOIN refresh_state state ON state.project_id = materialization.project_id
        WHERE state.dirty_token IS NOT NULL
          AND materialization.target_dirty_token <= state.dirty_token
    ),
    quarantine_summary AS (
      SELECT CAST(COUNT(*) AS INTEGER) AS unresolvedQuarantineBarrierCount
      FROM app.project_mart_dirty_refresh_article_quarantine quarantine
      INNER JOIN refresh_state state ON state.project_id = quarantine.project_id
      WHERE state.dirty_token IS NOT NULL
        AND quarantine.dirty_token <= state.dirty_token
        AND quarantine.resolved_at IS NULL
    )
    SELECT
      CAST(state.dirty_token AS INTEGER) AS dirtyToken,
      CAST(state.last_completed_dirty_token AS INTEGER) AS lastCompletedDirtyToken,
      state.refresh_status AS refreshStatus,
      COALESCE(materialization_summary.incompleteMaterializationCount, 0) AS incompleteMaterializationCount,
      COALESCE(materialization_summary.pendingMaterializationCount, 0) AS pendingMaterializationCount,
      COALESCE(materialization_summary.runningMaterializationCount, 0) AS runningMaterializationCount,
      COALESCE(materialization_summary.failedMaterializationCount, 0) AS failedMaterializationCount,
      COALESCE(materialization_summary.unreconciledMaterializationCount, 0) AS unreconciledMaterializationCount,
      COALESCE(quarantine_summary.unresolvedQuarantineBarrierCount, 0) AS unresolvedQuarantineBarrierCount
    FROM refresh_state state
    CROSS JOIN materialization_summary
    CROSS JOIN quarantine_summary
  `)
  const dirtyToken = row?.dirtyToken ?? null
  const failedMaterializationCount = Number(row?.failedMaterializationCount ?? 0)
  const incompleteMaterializationCount = Number(row?.incompleteMaterializationCount ?? 0)
  const lastCompletedDirtyToken = row?.lastCompletedDirtyToken ?? null
  const pendingMaterializationCount = Number(row?.pendingMaterializationCount ?? 0)
  const refreshStatus = row?.refreshStatus ?? null
  const runningMaterializationCount = Number(row?.runningMaterializationCount ?? 0)
  const unresolvedQuarantineBarrierCount = Number(row?.unresolvedQuarantineBarrierCount ?? 0)
  const unreconciledMaterializationCount = Number(row?.unreconciledMaterializationCount ?? 0)
  const hasIncompleteDirtyMaterialization = incompleteMaterializationCount > 0
  const hasUnresolvedQuarantineBarrier = unresolvedQuarantineBarrierCount > 0
  const isFresh =
    dirtyToken === null
    || (!hasIncompleteDirtyMaterialization
      && !hasUnresolvedQuarantineBarrier
      && lastCompletedDirtyToken !== null
      && lastCompletedDirtyToken >= dirtyToken)
  const status = getProjectMartFreshnessStatus({
    failedMaterializationCount,
    hasUnresolvedQuarantineBarrier,
    isFresh,
    refreshStatus,
    unreconciledMaterializationCount,
  })

  return {
    dirtyToken,
    failedMaterializationCount,
    hasIncompleteDirtyMaterialization,
    hasUnresolvedQuarantineBarrier,
    isFresh,
    lastCompletedDirtyToken,
    pendingMaterializationCount,
    refreshStatus,
    runningMaterializationCount,
    status,
    unresolvedQuarantineBarrierCount,
    unreconciledMaterializationCount,
  }
}

const getJobContext = async ({
  db = getAppDatabaseService(),
  jobId,
}: {
  db?: JudgmentJobSqliteHealthProjectionReader
  jobId: string
}): Promise<{
  job: {
    id: string
    createdAt: Date
    updatedAt: Date
    projectId: string
    status: string
    error: string[] | null
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
    projectName: string | null
    useTitle: boolean
    useAbstract: boolean
    useFulltext: boolean
    useFulltextNoImages: boolean
  }
  projectModelId: string
  projectDateFrom: Date | null
  projectDateTo: Date | null
  importRouteIds: string[]
}> => {
  const [jobWithProject, projectImportRoutes] = await Promise.all([
    db.queryJson<{
      id: string
      createdAt: unknown
      updatedAt: unknown
      projectId: string
      status: string
      error: unknown
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
      projectName: string | null
      projectModelId: string | null
      projectDateFrom: unknown
      projectDateTo: unknown
      projectUseTitle: boolean | null
      projectUseAbstract: boolean | null
      projectUseFulltext: boolean | null
      projectUseFulltextNoImages: boolean | null
    }>(`
      SELECT
        jj.id AS id,
        jj.created_at AS createdAt,
        jj.updated_at AS updatedAt,
        jj.project_id AS projectId,
        jj.status AS status,
        TO_JSON(jj.error) AS error,
        jj.storage_state AS storageState,
        jj.quarantined_at AS quarantinedAt,
        jj.quarantine_reason AS quarantineReason,
        jj.last_import_started_at AS lastImportStartedAt,
        jj.last_import_completed_at AS lastImportCompletedAt,
        jj.last_import_error_at AS lastImportErrorAt,
        jj.last_import_error AS lastImportError,
        jj.last_import_exit_code AS lastImportExitCode,
        jj.import_failure_count AS importFailureCount,
        jj.pause_requested_at AS pauseRequestedAt,
        p.name AS projectName,
        p.model_id AS projectModelId,
        p.date_from AS projectDateFrom,
        p.date_to AS projectDateTo,
        p.use_title AS projectUseTitle,
        p.use_abstract AS projectUseAbstract,
        p.use_fulltext AS projectUseFulltext,
        p.use_fulltext_no_images AS projectUseFulltextNoImages
      FROM app.judgment_job jj
      LEFT JOIN app.project p ON jj.project_id = p.id
      WHERE jj.id = '${escapeSqlString(jobId)}'
      LIMIT 1
    `),
    db.queryJson<{importRouteId: string}>(`
      SELECT pir.import_route_id AS importRouteId
      FROM app.project_import_route pir
      INNER JOIN app.judgment_job jj ON jj.project_id = pir.project_id
      WHERE jj.id = '${escapeSqlString(jobId)}'
    `),
  ]).then(([jobRows, routeRows]) => {
    return [jobRows[0], routeRows] as const
  })

  if (!jobWithProject) {
    throw new Error('Job not found')
  }

  const {
    projectDateFrom,
    projectDateTo,
    projectModelId,
    projectUseTitle,
    projectUseAbstract,
    projectUseFulltext,
    projectUseFulltextNoImages,
    ...rest
  } = jobWithProject

  const job = {
    ...rest,
    createdAt: getDateValue(rest.createdAt) ?? new Date(0),
    updatedAt: getDateValue(rest.updatedAt) ?? new Date(0),
    error: getJsonValue(rest.error) as string[] | null,
    storageState: rest.storageState,
    quarantinedAt: getDateValue(rest.quarantinedAt),
    quarantineReason: rest.quarantineReason,
    lastImportStartedAt: getDateValue(rest.lastImportStartedAt),
    lastImportCompletedAt: getDateValue(rest.lastImportCompletedAt),
    lastImportErrorAt: getDateValue(rest.lastImportErrorAt),
    lastImportError: rest.lastImportError,
    lastImportExitCode: rest.lastImportExitCode,
    importFailureCount: Number(rest.importFailureCount ?? 0),
    pauseRequestedAt: getDateValue(rest.pauseRequestedAt),
    useTitle: projectUseTitle ?? true,
    useAbstract: projectUseAbstract ?? true,
    useFulltext: projectUseFulltext ?? false,
    useFulltextNoImages: projectUseFulltextNoImages ?? false,
  }

  if (!projectModelId) {
    throw new Error('Project model ID not found')
  }

  return {
    job,
    projectModelId,
    projectDateFrom: getDateValue(projectDateFrom),
    projectDateTo: getDateValue(projectDateTo),
    importRouteIds: projectImportRoutes.map((r) => {
      return r.importRouteId
    }),
  }
}

const getTelemetryHistoryRoutePayload = (history: JudgmentProviderTelemetryBucketedHistory) => {
  return {
    bucketSizeSeconds: history.bucketSizeSeconds,
    buckets: history.buckets.map((bucket) => {
      return {...bucket, bucketEnd: bucket.bucketEnd.toISOString(), bucketStart: bucket.bucketStart.toISOString()}
    }),
    providerKey: history.providerKey,
    rangeEnd: history.rangeEnd.toISOString(),
    rangeStart: history.rangeStart.toISOString(),
  }
}

const getTrimmedProviderKey = (value: string | undefined) => {
  const trimmed = value?.trim() ?? ''

  return trimmed.length > 0 ? trimmed : null
}

const getProjectModelId = async (
  projectId: string,
  db: JudgmentJobSqliteHealthProjectionReader = getAppDatabaseService(),
): Promise<string> => {
  const [project] = await db.queryJson<{modelId: string | null}>(`
    SELECT model_id AS modelId
    FROM app.project
    WHERE id = ${getSqlLiteral(projectId)}
    LIMIT 1
  `)

  if (!project?.modelId) {
    throw new HttpError(400, 'Project model ID not found')
  }

  return project.modelId
}

const isImportInFlight = (job: {lastImportCompletedAt: Date | null; lastImportStartedAt: Date | null}) => {
  const startedAt = job.lastImportStartedAt
  const completedAt = job.lastImportCompletedAt

  return Boolean(startedAt && (!completedAt || completedAt < startedAt))
}

const isStaleImportJob = (
  job: {lastImportCompletedAt: Date | null; lastImportStartedAt: Date | null},
  now = Date.now(),
) => {
  const startedAt = job.lastImportStartedAt

  return Boolean(startedAt && isImportInFlight(job) && now - startedAt.getTime() >= staleImportThresholdMs)
}

const getProjectedSqliteHealth = (
  projection: JudgmentJobSqliteHealthProjectionRecord,
): JudgmentJobSqliteHealthSnapshot => {
  return {
    claimedOutboxCount: projection.claimedOutboxCount,
    hasOutboxRows: projection.hasOutboxRows,
    hasPendingCompletionAck: projection.hasPendingCompletionAck,
    hasQueueRows: projection.hasQueueRows,
    lastAckSeq: projection.lastAckSeq,
    oldestUnackedCompletionAgeMs: projection.oldestUnackedCompletionAgeMs,
    oldestUnexportedAgeMs: projection.oldestUnexportedAgeMs,
    orphanedJudgedRowCount: projection.orphanedJudgedRowCount,
    outboxRowCount: projection.outboxRowCount,
    pendingCompletionAckCount: projection.pendingCompletionAckCount,
    healthProjection: {
      freshUntilAt: projection.freshUntilAt,
      projectedAt: projection.projectedAt,
      projectedBy: projection.projectedBy,
      source: projection.projectionSource,
    },
    promptCounts: projection.promptCounts,
    retainedRowCount: projection.retainedRowCount,
    sqliteFileBytes: projection.sqliteFileBytes,
    walBytes: projection.walBytes,
  }
}

const getEmptySqliteHealthSnapshot = (): JudgmentJobSqliteHealthSnapshot => {
  return {
    claimedOutboxCount: 0,
    hasOutboxRows: false,
    hasPendingCompletionAck: false,
    hasQueueRows: false,
    lastAckSeq: null,
    oldestUnackedCompletionAgeMs: null,
    oldestUnexportedAgeMs: null,
    orphanedJudgedRowCount: 0,
    outboxRowCount: 0,
    pendingCompletionAckCount: 0,
    promptCounts: {claimed: 0, judged: 0, ready: 0, running: 0, skipped: 0},
    retainedRowCount: 0,
    sqliteFileBytes: null,
    walBytes: 0,
  }
}

const getReadableJobSqliteHealthFallback = (
  job: Pick<JudgmentJobSqliteHealthReadableJob, 'storageState'> | undefined,
) => {
  return job?.storageState === 'drained' ? getEmptySqliteHealthSnapshot() : null
}

const getReadableJobSqliteHealthFallbackEntries = (jobs: JudgmentJobSqliteHealthReadableJob[]) => {
  return jobs.flatMap((job) => {
    const fallback = getReadableJobSqliteHealthFallback(job)

    return fallback ? [[job.id, fallback] as const] : []
  })
}

const getSqliteHealthFromFreshProjection = async ({
  db,
  jobId,
}: {
  db: JudgmentJobSqliteHealthProjectionReader
  jobId: string
}): Promise<JudgmentJobSqliteHealthSnapshot> => {
  const projection = await getJudgmentJobSqliteHealthProjectionService().getFreshJudgmentJobSqliteHealthProjection({
    db,
    jobId,
  })

  if (!projection) {
    throw getMaintenanceUnavailableError(`fresh SQLite health projection is unavailable for judgment job ${jobId}`)
  }

  return getProjectedSqliteHealth(projection)
}

const getSqliteHealthForReadableRoute = async ({
  db,
  job,
  jobId,
}: {
  db: JudgmentJobSqliteHealthProjectionReader
  job?: Pick<JudgmentJobSqliteHealthReadableJob, 'storageState'>
  jobId: string
}): Promise<JudgmentJobSqliteHealthSnapshot> => {
  return shouldCurrentServerRunJudgingLoops()
    ? getJudgmentJobSqliteService().getHealthSnapshot(jobId)
    : getSqliteHealthFromFreshProjection({db, jobId}).catch((error: unknown) => {
        const fallback = getReadableJobSqliteHealthFallback(job)

        return canCurrentServerOwnDuckdb()
          ? getJudgmentJobSqliteService().getHealthSnapshot(jobId)
          : fallback
            ? Promise.resolve(fallback)
            : Promise.reject(error)
      })
}

const getSqliteHealthMapForReadableRoute = async ({
  db,
  jobs,
}: {
  db: JudgmentJobSqliteHealthProjectionReader
  jobs: JudgmentJobSqliteHealthReadableJob[]
}) => {
  const jobIds = jobs.map((job) => {
    return job.id
  })

  if (shouldCurrentServerRunJudgingLoops()) {
    const entries = await Promise.all(
      jobIds.map(async (jobId) => {
        return [jobId, await getJudgmentJobSqliteService().getHealthSnapshot(jobId)] as const
      }),
    )

    return new Map(entries)
  }

  const projections = await getJudgmentJobSqliteHealthProjectionService().getFreshJudgmentJobSqliteHealthProjections({
    db,
    jobIds,
  })
  const missingJobs = jobs.filter((job) => {
    return !projections.has(job.id)
  })

  if (missingJobs.length > 0) {
    if (!canCurrentServerOwnDuckdb()) {
      const fallbackEntries = getReadableJobSqliteHealthFallbackEntries(missingJobs)
      const fallbackJobIds = new Set(
        fallbackEntries.map(([jobId]) => {
          return jobId
        }),
      )
      const missingJobIds = missingJobs
        .filter((job) => {
          return !fallbackJobIds.has(job.id)
        })
        .map((job) => {
          return job.id
        })

      if (missingJobIds.length > 0) {
        throw getMaintenanceUnavailableError(
          `fresh SQLite health projection is unavailable for judgment jobs ${missingJobIds.join(', ')}`,
        )
      }

      return new Map([
        ...Array.from(projections.entries()).map(([jobId, projection]) => {
          return [jobId, getProjectedSqliteHealth(projection)] as const
        }),
        ...fallbackEntries,
      ])
    }

    const missingEntries = await Promise.all(
      missingJobs.map(async (job) => {
        const jobId = job.id

        return [jobId, await getJudgmentJobSqliteService().getHealthSnapshot(jobId)] as const
      }),
    )

    return new Map([
      ...Array.from(projections.entries()).map(([jobId, projection]) => {
        return [jobId, getProjectedSqliteHealth(projection)] as const
      }),
      ...missingEntries,
    ])
  }

  return new Map(
    Array.from(projections.entries()).map(([jobId, projection]) => {
      return [jobId, getProjectedSqliteHealth(projection)] as const
    }),
  )
}

const hasRetainedOutbox = (sqliteHealth: JudgmentJobSqliteHealthSnapshot) => {
  return sqliteHealth.outboxRowCount > 0 || sqliteHealth.claimedOutboxCount > 0
}

const hasOrphanedJudgedQueue = (sqliteHealth: JudgmentJobSqliteHealthSnapshot) => {
  return sqliteHealth.orphanedJudgedRowCount > 0
}

const hasLargeWal = (sqliteHealth: JudgmentJobSqliteHealthSnapshot) => {
  return sqliteHealth.walBytes >= largeWalThresholdBytes
}

const getStoragePolicy = ({
  job,
  sqliteHealth,
}: {
  job: {status: string; storageState: string}
  sqliteHealth: JudgmentJobSqliteHealthSnapshot
}) => {
  const hasLocalSqliteState = hasJudgmentJobLocalSqliteState(sqliteHealth)

  return {
    hasLocalSqliteState,
    repairMode: getJudgmentJobRepairMode({hasLocalSqliteState, job}),
    startupHandling: getJudgmentJobStartupHandling({hasLocalSqliteState, job}),
  }
}

const getJobHealthBadges = ({
  job,
  sqliteHealth,
}: {
  job: {status: string; storageState: string; lastImportCompletedAt: Date | null; lastImportStartedAt: Date | null}
  sqliteHealth: JudgmentJobSqliteHealthSnapshot
}): JudgmentJobHealthBadge[] => {
  const badges: JudgmentJobHealthBadge[] = []
  const storagePolicy = getStoragePolicy({job, sqliteHealth})

  if (storagePolicy.repairMode === 'offline_repair_required') {
    badges.push('Offline Repair')
  }

  if (job.storageState === 'quarantined') {
    badges.push('Quarantined')
  }

  if (job.storageState === 'draining') {
    badges.push('Draining')
  }

  if (isStaleImportJob(job)) {
    badges.push('Stale Import')
  }

  if (hasOrphanedJudgedQueue(sqliteHealth)) {
    badges.push('Orphaned Local Queue')
  }

  if (hasRetainedOutbox(sqliteHealth)) {
    badges.push('Retained Outbox')
  }

  if (hasLargeWal(sqliteHealth)) {
    badges.push('Large WAL')
  }

  return badges.length > 0 ? badges : ['Healthy']
}

const getRecommendedHealthAction = ({
  job,
  sqliteHealth,
}: {
  job: {status: string; storageState: string; lastImportCompletedAt: Date | null; lastImportStartedAt: Date | null}
  sqliteHealth: JudgmentJobSqliteHealthSnapshot
}): JudgmentJobHealthAction => {
  const storagePolicy = getStoragePolicy({job, sqliteHealth})

  if (storagePolicy.repairMode === 'offline_repair_required') {
    return 'repair_offline_required'
  }

  if (job.storageState === 'quarantined') {
    return 'repair_quarantine'
  }

  if (job.storageState === 'missing') {
    return 'repair_missing_sqlite'
  }

  if (isStaleImportJob(job)) {
    return 'retry_stale_import'
  }

  if (hasOrphanedJudgedQueue(sqliteHealth)) {
    return 'repair_orphaned_queue'
  }

  if (job.storageState === 'draining') {
    return 'wait_for_drain'
  }

  if (hasRetainedOutbox(sqliteHealth)) {
    return 'resume_outbox_import'
  }

  return 'none'
}

const isHealthyJob = ({action, job}: {action: JudgmentJobHealthAction; job: {storageState: string}}) => {
  return job.storageState === 'active' && action === 'none'
}

const assertProjectRuntimeModelMatch = async (projectId: string): Promise<void> => {
  const projectModelId = await getProjectModelId(projectId)

  return assertStoredProviderModelRuntimeMatch({modelId: projectModelId})
}

const getJudgingRuntimeReason = async (): Promise<string | null> => {
  if (shouldCurrentServerRunJudgingLoops()) {
    return null
  }

  const importConsumer = await getJudgmentImportConsumerAvailability()

  return importConsumer.eligibleConsumerPresent
    ? null
    : `No eligible ${importConsumer.requiredConsumerRole} is currently registered, so queued prompts cannot be processed.`
}

const getJudgingRuntime = async (): Promise<{enabled: boolean; reason: string | null}> => {
  const reason = await getJudgingRuntimeReason()
  return {enabled: reason === null, reason}
}

const assertJudgingRuntimeCanRun = async (): Promise<void> => {
  const reason = await getJudgingRuntimeReason()

  if (reason) {
    throw new HttpError(400, reason)
  }
}

const getIsoDateString = (value: unknown): string | null => {
  return getDateValue(value)?.toISOString() ?? null
}

const getJudgmentJobWorkIdentity = ({
  job,
  modelId,
}: {
  job: {projectId: string; useAbstract: boolean; useFulltext: boolean; useFulltextNoImages: boolean; useTitle: boolean}
  modelId: string
}): JudgmentJobWorkIdentity => {
  return {
    modelId,
    projectId: job.projectId,
    useAbstract: job.useAbstract,
    useFulltext: job.useFulltext,
    useFulltextNoImages: job.useFulltextNoImages,
    useTitle: job.useTitle,
  }
}

const getJudgmentImportConsumerAvailability = async (): Promise<JudgmentJobImportConsumerAvailability> => {
  const registry = (await getDuckdbOwnerConnectionsOverview()).registry
  const judging = registry.capabilities.find((capability) => {
    return capability.capability === 'judging'
  })
  const localJudgingConsumerCount = shouldCurrentServerRunJudgingLoops() ? 1 : 0
  const eligibleConsumerCount = Math.max(judging?.eligibleConsumerCount ?? 0, localJudgingConsumerCount)
  const freshConsumerCount = Math.max(judging?.freshConsumerCount ?? 0, localJudgingConsumerCount)
  const registeredConsumerCount = Math.max(judging?.registeredConsumerCount ?? 0, localJudgingConsumerCount)

  return {
    eligibleConsumerCount,
    eligibleConsumerPresent: eligibleConsumerCount > 0,
    freshConsumerCount,
    freshConsumerPresent: freshConsumerCount > 0,
    registeredConsumerCount,
    requiredConsumerRole: 'judge-worker',
    staleConsumerCount: judging?.staleConsumerCount ?? 0,
  }
}

const getJudgmentImportWorkLeasesByJobId = async ({
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

const getFreshImportWorkLeases = (leases: JudgmentJobImportWorkLease[], now: Date) => {
  return leases.filter((lease) => {
    const freshUntilAt = lease.freshUntilAt ? new Date(lease.freshUntilAt).getTime() : null
    return freshUntilAt !== null && freshUntilAt > now.getTime()
  })
}

const getImportRecoveryWorkLease = (
  leases: JudgmentJobImportWorkLease[],
  now: Date,
): JudgmentJobImportWorkLease | null => {
  return (
    leases.find((lease) => {
      const retryAfterAt = lease.retryAfterAt ? new Date(lease.retryAfterAt).getTime() : null
      return lease.recoveryMode !== 'none' || (retryAfterAt !== null && retryAfterAt > now.getTime())
    }) ?? null
  )
}

const getUniqueStringCount = (values: Array<string | null>) => {
  return new Set(
    values.filter((value): value is string => {
      return value !== null && value !== ''
    }),
  ).size
}

const getObservedAggregateProbeLiveCountForHealth = (
  diagnostics: NonNullable<JudgmentJobEndpointHealth['diagnostics']>[],
): number | null => {
  const observedCounts = diagnostics.flatMap((entry) => {
    return entry.observedAggregateProbeLiveCount === null ? [] : [entry.observedAggregateProbeLiveCount]
  })

  return observedCounts.length === 0
    ? null
    : observedCounts.reduce((sum, count) => {
        return sum + count
      }, 0)
}

const getEndpointDiagnosticsSummaryForHealth = ({
  diagnostics,
  hasHealthyEndpointOrEndpointlessPath,
  providerKey,
}: {
  diagnostics: NonNullable<JudgmentJobEndpointHealth['diagnostics']>[]
  hasHealthyEndpointOrEndpointlessPath: boolean
  providerKey: string
}): JudgmentJobEndpointHealth['providerDiagnostics']['endpointDiagnosticsSummary'] => {
  const getCountByState = (state: string) => {
    return diagnostics.filter((entry) => {
      return entry.status === state
    }).length
  }
  const localProbeLiveCount = diagnostics.reduce((sum, entry) => {
    return sum + entry.localProbeLiveCount
  }, 0)
  const cooldownEndpointCount = getCountByState('cooldown')
  const healthyEndpointCount = getCountByState('healthy')
  const misconfiguredEndpointCount = getCountByState('misconfigured')
  const probingEndpointCount = getCountByState('probing')
  const unhealthyEndpointCount =
    diagnostics.length
    - healthyEndpointCount
    - cooldownEndpointCount
    - misconfiguredEndpointCount
    - probingEndpointCount

  return {
    blockedEndpointCount:
      diagnostics.length === 0 ? 0 : diagnostics.length - healthyEndpointCount - probingEndpointCount,
    cooldownEndpointCount,
    endpointCount: diagnostics.length,
    hasHealthyEndpointOrEndpointlessPath,
    healthyEndpointCount,
    localProbeLiveCount,
    misconfiguredEndpointCount,
    observedAggregateProbeLiveCount: getObservedAggregateProbeLiveCountForHealth(diagnostics),
    probeInProgress: diagnostics.some((entry) => {
      return entry.probeInProgress
    }),
    providerKey,
    probingEndpointCount,
    unhealthyEndpointCount,
  }
}

const getEndpointProviderDiagnosticsForHealth = ({
  diagnostics,
  hasHealthyEndpointOrEndpointlessPath,
  providerKey,
}: {
  diagnostics: NonNullable<JudgmentJobEndpointHealth['diagnostics']>[]
  hasHealthyEndpointOrEndpointlessPath: boolean
  providerKey: string
}): JudgmentJobEndpointHealth['providerDiagnostics'] => {
  return {
    endpointDiagnosticsByKey: diagnostics.reduce<
      JudgmentJobEndpointHealth['providerDiagnostics']['endpointDiagnosticsByKey']
    >((byKey, entry) => {
      return {...byKey, [entry.endpointAvailabilityKey]: entry}
    }, {}),
    endpointDiagnosticsSummary: getEndpointDiagnosticsSummaryForHealth({
      diagnostics,
      hasHealthyEndpointOrEndpointlessPath,
      providerKey,
    }),
    providerKey,
  }
}

const getJudgmentJobEndpointHealth = async ({
  db,
  modelId,
}: {
  db: JudgmentJobSqliteHealthProjectionReader
  modelId: string
}): Promise<JudgmentJobEndpointHealth> => {
  const providerConnection = await getProviderConnectionForStoredModel(modelId, db)
  const effectiveBaseURL = providerConnection
    ? getProviderConnectionEffectiveBaseURL({
        baseURL: providerConnection.baseURL,
        config: providerConnection.config,
        providerKind: providerConnection.providerKind,
        savedModelIds: [modelId],
      })
    : null
  const providerSnapshot = getProviderBucketSnapshot({
    maxInflightRequests: providerConnection?.maxInflightRequests ?? null,
    modelId,
    modelProvider: providerConnection?.providerKind ?? null,
    providerConnectionId: providerConnection?.id ?? null,
    providerConnectionUpdatedAt: providerConnection?.updatedAt ?? null,
    providerName: providerConnection?.label ?? null,
    useOwnerBackedSyntheticProviderId: false,
  })
  const availability = effectiveBaseURL
    ? getJudgmentEndpointAvailability({
        effectiveBaseURL,
        modelId,
        modelProvider: providerConnection?.providerKind ?? null,
        providerConnectionId: providerConnection?.id ?? null,
      })
    : null
  const diagnostics = availability ? getJudgmentEndpointAvailabilityDiagnostics(availability) : null
  const endpointDiagnostics =
    diagnostics && availability
      ? {
          ...diagnostics,
          effectiveBaseURL,
          endpointAvailabilityKey: availability.endpointAvailabilityKey,
          endpointIdentity: getEndpointIdentityFromAvailabilityKey(availability.endpointAvailabilityKey),
          localProbeState: diagnostics.status,
          providerKey: providerSnapshot.providerKey,
        }
      : null
  const endpointDiagnosticsList = endpointDiagnostics ? [endpointDiagnostics] : []
  const hasHealthyEndpointOrEndpointlessPath = !endpointDiagnostics || endpointDiagnostics.status === 'healthy'

  return {
    diagnostics: endpointDiagnostics,
    providerDiagnostics: getEndpointProviderDiagnosticsForHealth({
      diagnostics: endpointDiagnosticsList,
      hasHealthyEndpointOrEndpointlessPath,
      providerKey: providerSnapshot.providerKey,
    }),
    retryAfterAt: availability?.cooldownExpiresAt?.toISOString() ?? null,
  }
}

const getEndpointBlockedReason = (endpointHealth: JudgmentJobEndpointHealth): JudgmentJobBlockedReason => {
  const diagnostics = endpointHealth.diagnostics
  const failureMessage = diagnostics?.lastFailureMessage?.toLowerCase() ?? ''

  return !diagnostics || diagnostics.status === 'healthy' || diagnostics.status === 'probing'
    ? null
    : diagnostics.status === 'misconfigured'
      ? 'endpoint_misconfigured'
      : diagnostics.lastFailureKind === 'circuit_open' || failureMessage.includes('circuit breaker')
        ? 'endpoint_circuit_breaker'
        : 'endpoint_cooldown'
}

const isRepairRequiredAction = (action: JudgmentJobHealthAction) => {
  return (
    action === 'repair_offline_required'
    || action === 'repair_missing_sqlite'
    || action === 'repair_orphaned_queue'
    || action === 'repair_quarantine'
  )
}

const getProgressState = ({
  activeImportWorkCount,
  endpointBlockedReason,
  hasActivePrompts,
  hasImportBacklog,
  hasQueuedPrompts,
  importConsumer,
  isCompletionAckBacklog,
  isStaleImport,
  job,
  repairRequired,
}: {
  activeImportWorkCount: number
  endpointBlockedReason: JudgmentJobBlockedReason
  hasActivePrompts: boolean
  hasImportBacklog: boolean
  hasQueuedPrompts: boolean
  importConsumer: JudgmentJobImportConsumerAvailability
  isCompletionAckBacklog: boolean
  isStaleImport: boolean
  job: {status: string}
  repairRequired: boolean
}): JudgmentJobProgressState => {
  return repairRequired
    ? 'repair_required'
    : activeImportWorkCount > 0
      ? 'active_import'
      : isCompletionAckBacklog
        ? 'waiting_for_owner_ack'
        : endpointBlockedReason
          ? 'cooldown'
          : isStaleImport || (hasImportBacklog && !importConsumer.eligibleConsumerPresent)
            ? 'blocked_import'
            : hasImportBacklog || hasQueuedPrompts
              ? 'queued'
              : hasActivePrompts
                ? 'processing'
                : job.status === 'completed'
                  ? 'completed'
                  : 'idle'
}

const getProgressBlockedReason = ({
  endpointBlockedReason,
  isStaleImport,
  progressState,
  repairRequired,
}: {
  endpointBlockedReason: JudgmentJobBlockedReason
  isStaleImport: boolean
  progressState: JudgmentJobProgressState
  repairRequired: boolean
}): JudgmentJobBlockedReason => {
  return repairRequired
    ? 'storage_repair_required'
    : progressState === 'waiting_for_owner_ack'
      ? 'waiting_for_owner_ack'
      : progressState === 'cooldown' && endpointBlockedReason
        ? endpointBlockedReason
        : progressState === 'blocked_import' && isStaleImport
          ? 'stale_import'
          : progressState === 'blocked_import'
            ? 'waiting_for_judge_worker'
            : null
}

const getJudgmentJobHealthProgress = ({
  endpointHealth,
  importConsumer,
  importWorkLeases,
  job,
  now,
  recommendedNextAction,
  sqliteHealth,
  workIdentity,
}: {
  endpointHealth: JudgmentJobEndpointHealth
  importConsumer: JudgmentJobImportConsumerAvailability
  importWorkLeases: JudgmentJobImportWorkLease[]
  job: {
    lastImportCompletedAt: Date | null
    lastImportErrorAt: Date | null
    lastImportStartedAt: Date | null
    status: string
  }
  now: Date
  recommendedNextAction: JudgmentJobHealthAction
  sqliteHealth: JudgmentJobSqliteHealthSnapshot
  workIdentity: JudgmentJobWorkIdentity
}): JudgmentJobHealthProgress => {
  const activeImportLeases = getFreshImportWorkLeases(importWorkLeases, now)
  const recoveryLease = getImportRecoveryWorkLease(importWorkLeases, now)
  const activeConsumerCount = getUniqueStringCount(
    activeImportLeases.map((lease) => {
      return lease.consumerId
    }),
  )
  const importBacklogCount = sqliteHealth.outboxRowCount + sqliteHealth.claimedOutboxCount
  const activePromptCount = sqliteHealth.promptCounts.claimed + sqliteHealth.promptCounts.running
  const endpointBlockedReason = getEndpointBlockedReason(endpointHealth)
  const repairRequired = isRepairRequiredAction(recommendedNextAction)
  const progressState = getProgressState({
    activeImportWorkCount: activeImportLeases.length,
    endpointBlockedReason,
    hasActivePrompts: activePromptCount > 0,
    hasImportBacklog: importBacklogCount > 0,
    hasQueuedPrompts: sqliteHealth.promptCounts.ready > 0 || sqliteHealth.hasQueueRows,
    importConsumer,
    isCompletionAckBacklog: sqliteHealth.hasPendingCompletionAck,
    isStaleImport: isStaleImportJob(job),
    job,
    repairRequired,
  })
  const blockedReason = getProgressBlockedReason({
    endpointBlockedReason,
    isStaleImport: isStaleImportJob(job),
    progressState,
    repairRequired,
  })
  const recoveryMode =
    recoveryLease?.recoveryMode ?? (endpointBlockedReason ? ('retry_backoff' as const) : ('none' as const))

  return {
    activeConsumerCount,
    activeImportWorkCount: activeImportLeases.length,
    blockedReason,
    importBacklogCount,
    importConsumer,
    importWork: {
      activeConsumerCount,
      activeWorkCount: activeImportLeases.length,
      claimedOutboxCount: sqliteHealth.claimedOutboxCount,
      hasBacklog: importBacklogCount > 0,
      outboxRowCount: sqliteHealth.outboxRowCount,
      pendingCompletionAckCount: sqliteHealth.pendingCompletionAckCount,
      workIdentity,
    },
    lastProgressedAt:
      activeImportLeases[0]?.lastProgressedAt
      ?? recoveryLease?.lastProgressedAt
      ?? getIsoDateString(job.lastImportCompletedAt)
      ?? getIsoDateString(job.lastImportErrorAt),
    lastStartedAt:
      activeImportLeases[0]?.lastStartedAt ?? recoveryLease?.lastStartedAt ?? getIsoDateString(job.lastImportStartedAt),
    progressState,
    recoveryContext: recoveryLease?.recoveryContext ?? null,
    recoveryMode,
    retryAfterAt: recoveryLease?.retryAfterAt ?? endpointHealth.retryAfterAt,
    runningWork: {
      activePromptCount,
      claimedPromptCount: sqliteHealth.promptCounts.claimed,
      judgedPromptCount: sqliteHealth.promptCounts.judged,
      readyPromptCount: sqliteHealth.promptCounts.ready,
      runningPromptCount: sqliteHealth.promptCounts.running,
      skippedPromptCount: sqliteHealth.promptCounts.skipped,
      workIdentity,
    },
    workIdentity,
  }
}

const getProgressStateCounts = (entries: Array<{progressState: JudgmentJobProgressState}>) => {
  return entries.reduce(
    (counts, entry) => {
      return entry.progressState === 'active_import'
        ? {...counts, activeImport: counts.activeImport + 1}
        : entry.progressState === 'blocked_import'
          ? {...counts, blockedImport: counts.blockedImport + 1}
          : entry.progressState === 'completed'
            ? {...counts, completed: counts.completed + 1}
            : entry.progressState === 'cooldown'
              ? {...counts, cooldown: counts.cooldown + 1}
              : entry.progressState === 'idle'
                ? {...counts, idle: counts.idle + 1}
                : entry.progressState === 'processing'
                  ? {...counts, processing: counts.processing + 1}
                  : entry.progressState === 'queued'
                    ? {...counts, queued: counts.queued + 1}
                    : entry.progressState === 'repair_required'
                      ? {...counts, repairRequired: counts.repairRequired + 1}
                      : {...counts, waitingForOwnerAck: counts.waitingForOwnerAck + 1}
    },
    {
      activeImport: 0,
      blockedImport: 0,
      completed: 0,
      cooldown: 0,
      idle: 0,
      processing: 0,
      queued: 0,
      repairRequired: 0,
      waitingForOwnerAck: 0,
    },
  )
}

const getJudgmentJobMutationState = async (
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
      updated_at AS updatedAt,
      TO_JSON(error) AS error
    FROM app.judgment_job
    WHERE id = '${escapeSqlString(jobId)}'
    LIMIT 1
  `)

  return job ?? null
}

const getJudgmentJobMutationStorageAssignments = ({
  clearTransientQuarantine,
  status,
}: {
  clearTransientQuarantine: boolean
  status?: string
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
  const assignments = [statusAssignments, quarantineAssignments].filter((assignment): assignment is string => {
    return assignment !== null
  })

  return assignments.length > 0 ? assignments.join(', ') : null
}

const getFailedRequestDetailRecords = (value: unknown): FailedRequestDetailRecord[] => {
  const parsed = getJsonValue(value)

  return Array.isArray(parsed)
    ? parsed.flatMap((entry) => {
        return entry && typeof entry === 'object' && !Array.isArray(entry) ? [entry as FailedRequestDetailRecord] : []
      })
    : []
}

const isAnthropicRefusalDetail = (detail: FailedRequestDetailRecord): boolean => {
  const error = typeof detail.error === 'string' ? detail.error : ''
  const failureCode = typeof detail.failureCode === 'string' ? detail.failureCode : ''
  const providerDiagnostics =
    detail.providerDiagnostics
    && typeof detail.providerDiagnostics === 'object'
    && !Array.isArray(detail.providerDiagnostics)
      ? (detail.providerDiagnostics as Record<string, unknown>)
      : null
  const initialStopReason =
    providerDiagnostics?.initial
    && typeof providerDiagnostics.initial === 'object'
    && !Array.isArray(providerDiagnostics.initial)
      ? (providerDiagnostics.initial as Record<string, unknown>).stopReason
      : null
  const fallbackStopReason =
    providerDiagnostics?.fallback
    && typeof providerDiagnostics.fallback === 'object'
    && !Array.isArray(providerDiagnostics.fallback)
      ? (providerDiagnostics.fallback as Record<string, unknown>).stopReason
      : null

  return (
    failureCode === 'anthropic_refusal_empty_response'
    || error.includes('failure_code=anthropic_refusal_empty_response')
    || ((failureCode === 'anthropic_empty_response' || error.includes('failure_code=anthropic_empty_response'))
      && (error.includes('stop_reason=refusal') || initialStopReason === 'refusal' || fallbackStopReason === 'refusal'))
  )
}

const getAnthropicRefusalSummary = (rows: Array<{failedRequestsDetails: unknown}>) => {
  const detailRecords = rows.flatMap((row) => {
    return getFailedRequestDetailRecords(row.failedRequestsDetails)
  })
  const refusalRecords = detailRecords.filter((detail) => {
    return isAnthropicRefusalDetail(detail)
  })
  const articleIds = new Set(
    refusalRecords.flatMap((detail) => {
      const articleId = typeof detail.articleId === 'string' ? detail.articleId : null
      return articleId ? [articleId] : []
    }),
  )

  return {anthropicRefusalArticles: articleIds.size, anthropicRefusals: refusalRecords.length}
}

const emptyAnthropicRefusalSummary: AnthropicRefusalSummary = {anthropicRefusalArticles: 0, anthropicRefusals: 0}

const getPersistedFailedRequestCountFromLegacyDetails = async ({
  db,
  jobId,
}: {
  db: JudgmentJobSqliteHealthProjectionReader
  jobId: string
}): Promise<number> => {
  const [row] = await db.queryJson<{persistedFailedRequests: number | string | null}>(`
    SELECT
      SUM(
        CASE
          WHEN json_type(failed_requests_details) = 'ARRAY' THEN json_array_length(failed_requests_details)
          ELSE 0
        END
      ) AS persistedFailedRequests
    FROM app.token_use
    WHERE judgment_job_id = ${getSqlLiteral(jobId)}
      AND has_failed_requests = TRUE
      AND failed_requests IS NULL
  `)

  return Number(row?.persistedFailedRequests ?? 0)
}

const getPersistedFailedRequestCount = async ({
  db,
  jobId,
}: {
  db: JudgmentJobSqliteHealthProjectionReader
  jobId: string
}): Promise<number> => {
  const [row] = await db.queryJson<{
    persistedFailedRequests: number | string | null
    legacyFailedRequestRows: number | string | null
  }>(`
    SELECT
      SUM(COALESCE(failed_requests, 0)) AS persistedFailedRequests,
      SUM(CASE WHEN failed_requests IS NULL THEN 1 ELSE 0 END) AS legacyFailedRequestRows
    FROM app.token_use
    WHERE judgment_job_id = ${getSqlLiteral(jobId)}
      AND has_failed_requests = TRUE
  `)
  const persistedFailedRequests = Number(row?.persistedFailedRequests ?? 0)
  const legacyFailedRequestRows = Number(row?.legacyFailedRequestRows ?? 0)
  const legacyPersistedFailedRequests =
    legacyFailedRequestRows > 0 ? await getPersistedFailedRequestCountFromLegacyDetails({db, jobId}) : 0

  return persistedFailedRequests + legacyPersistedFailedRequests
}

const getAnthropicRefusalSummaryFromDatabase = async ({
  db,
  jobId,
}: {
  db: JudgmentJobSqliteHealthProjectionReader
  jobId: string
}): Promise<AnthropicRefusalSummary> => {
  const rows = await db.queryJson<{failedRequestsDetails: unknown}>(`
    WITH failed_rows AS (
      SELECT
        failed_requests_details,
        CAST(failed_requests_details AS VARCHAR) AS detailText
      FROM app.token_use
      WHERE judgment_job_id = ${getSqlLiteral(jobId)}
        AND has_failed_requests = TRUE
    )
    SELECT TO_JSON(failed_requests_details) AS failedRequestsDetails
    FROM failed_rows
    WHERE contains(detailText, ${getSqlLiteral('anthropic_refusal_empty_response')})
      OR contains(detailText, ${getSqlLiteral('anthropic_empty_response')})
  `)

  return getAnthropicRefusalSummary(rows)
}

const getAnthropicRefusalSummaryForProvider = ({
  db,
  jobId,
  modelProvider,
}: {
  db: JudgmentJobSqliteHealthProjectionReader
  jobId: string
  modelProvider: string | null
}): Promise<AnthropicRefusalSummary> => {
  return modelProvider === 'anthropic'
    ? getAnthropicRefusalSummaryFromDatabase({db, jobId})
    : Promise.resolve(emptyAnthropicRefusalSummary)
}

const getFailedRequestSummaryFromDatabase = async ({
  db,
  jobId,
  modelProvider,
}: {
  db: JudgmentJobSqliteHealthProjectionReader
  jobId: string
  modelProvider: string | null
}): Promise<FailedRequestSummary> => {
  const [persistedFailedRequests, anthropicRefusalSummary] = await Promise.all([
    getPersistedFailedRequestCount({db, jobId}),
    getAnthropicRefusalSummaryForProvider({db, jobId, modelProvider}),
  ])

  return {...anthropicRefusalSummary, persistedFailedRequests}
}

const resetJudgmentJobLocalSqliteState = async ({jobId, storageState}: {jobId: string; storageState: string}) => {
  const sqliteService = getJudgmentJobSqliteService()

  if (!sqliteService.hasJob(jobId)) {
    return
  }

  const shouldUseCrashContainedDeleteFlush =
    getJudgmentJobRepairMode({hasLocalSqliteState: true, job: {status: 'failed', storageState}})
    === 'offline_repair_required'

  if (shouldUseCrashContainedDeleteFlush) {
    const flushResult = await runJudgmentJobSqliteIsolatedFlush({claimedBy: judgmentJobServerId, jobId})

    if (flushResult.errorMessage !== null) {
      if (
        !isJudgmentJobSqliteIsolatedImportLeaseConflict(flushResult.errorMessage)
        && !isTransientJudgmentJobSqliteLockMessage(flushResult.errorMessage)
      ) {
        await runJudgmentJobRepairAction({action: 'quarantine', jobId, reason: flushResult.errorMessage})
      }

      throw new HttpError(
        409,
        `Start Job Clean stopped safely for ${jobId}: ${flushResult.errorMessage} Local SQLite data was left in place.`,
      )
    }
  } else {
    await flushJudgmentJobSqliteOutbox({claimedBy: judgmentJobServerId, jobId})
  }

  await sqliteService.deleteJob(jobId)
}

export const judgmentsJobsRoutes = new Elysia()
  .use(withErrorHandler())
  .post(
    '/api/judgmentsjobs',
    async ({body}) => {
      console.log('Fetching judgmentsjobs')

      // Check if a job already exists for this project
      const existingJob = await getAppDatabaseService().queryJson<{id: string}>(`
        SELECT id
        FROM app.judgment_job
        WHERE project_id = '${escapeSqlString(body.projectId)}'
        LIMIT 1
      `)

      if (existingJob.length > 0) {
        return {error: 'A job already exists for this project', data: null}
      }

      await assertJudgingRuntimeCanRun()
      await assertProjectRuntimeModelMatch(body.projectId)

      const [job] = await getAppDatabaseService().queryJson<{
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
        createdAt: unknown
        projectId: string
      }>(`
        INSERT INTO app.judgment_job (id, project_id, status)
        VALUES (${getQuotedStringList([crypto.randomUUID(), body.projectId, 'running']).join(', ')})
        RETURNING
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
          created_at AS createdAt,
          project_id AS projectId
      `)

      if (!job) {
        throw new Error('Failed to create judgments job')
      }

      try {
        await getJudgmentJobSqliteService().initializeJob(job.id)
        await getJudgmentJobSqliteService().runIsolatedPreflight(job.id)
      } catch (error) {
        await getJudgmentJobSqliteService()
          .deleteJob(job.id)
          .catch(() => {
            return undefined
          })
        await getAppDatabaseService().transaction(async (tx) => {
          await deleteJudgmentJobSafelyTx({jobId: job.id, tx})
        })
        throw error
      }

      return {
        data: {
          jobId: job.id,
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
          createdAt: job.createdAt,
          projectId: job.projectId,
        },
        error: null,
      }
    },
    {body: t.Object({projectId: t.String(), agentConfig: t.Optional(t.Any())})},
  )
  .get(
    '/api/judgmentsjobs/:id/health',
    async ({params, request}) => {
      return runJudgmentJobsRead({
        operation: async () => {
          const db = getJudgmentJobsReadDatabase()
          const currentNow = new Date()
          const {job, projectModelId} = await getJobContext({db, jobId: params.id})
          const workIdentity = getJudgmentJobWorkIdentity({job, modelId: projectModelId})
          const [sqliteHealth, importConsumer, importWorkLeasesByJobId, endpointHealth] = await Promise.all([
            getSqliteHealthForReadableRoute({db, job, jobId: job.id}),
            getJudgmentImportConsumerAvailability(),
            getJudgmentImportWorkLeasesByJobId({db, jobIds: [job.id], now: currentNow}),
            getJudgmentJobEndpointHealth({db, modelId: projectModelId}),
          ])
          const storagePolicy = getStoragePolicy({job, sqliteHealth})
          const recommendedNextAction = getRecommendedHealthAction({job, sqliteHealth})
          const progress = getJudgmentJobHealthProgress({
            endpointHealth,
            importConsumer,
            importWorkLeases: importWorkLeasesByJobId.get(job.id) ?? [],
            job,
            now: currentNow,
            recommendedNextAction,
            sqliteHealth,
            workIdentity,
          })

          return {
            ...progress,
            jobId: job.id,
            storageState: job.storageState,
            storagePolicy,
            recommendedNextAction,
            endpointAvailability: endpointHealth.diagnostics,
            providerDiagnostics: endpointHealth.providerDiagnostics,
            importMetadata: {
              importFailureCount: job.importFailureCount,
              lastImportCompletedAt: job.lastImportCompletedAt,
              lastImportError: job.lastImportError,
              lastImportErrorAt: job.lastImportErrorAt,
              lastImportExitCode: job.lastImportExitCode,
              lastImportStartedAt: job.lastImportStartedAt,
              pauseRequestedAt: job.pauseRequestedAt,
            },
            quarantine: {quarantinedAt: job.quarantinedAt, quarantineReason: job.quarantineReason},
            liveSqlite: sqliteHealth,
          }
        },
        request,
      })
    },
    {params: t.Object({id: t.String()})},
  )
  .post(
    '/api/judgmentsjobs/:id/claims',
    async ({params, body}) => {
      return claimJudgmentJobPrompts(params.id, body)
    },
    {body: judgmentClaimRequestSchema, params: t.Object({id: t.String()})},
  )
  .post(
    '/api/judgmentsjobs/:id/claim',
    async ({params, body}) => {
      return claimJudgmentJobPrompts(params.id, body)
    },
    {body: judgmentClaimRequestSchema, params: t.Object({id: t.String()})},
  )
  .post(
    '/api/judgmentsjobs/:id/completions',
    async ({params, body}) => {
      return completeJudgmentJobPrompt(params.id, body)
    },
    {body: judgmentCompletionBodySchema, params: t.Object({id: t.String()})},
  )
  .post(
    '/api/judgmentsjobs/:id/complete',
    async ({params, body}) => {
      return completeJudgmentJobPrompt(params.id, body)
    },
    {body: judgmentCompletionBodySchema, params: t.Object({id: t.String()})},
  )
  .get('/api/judgmentsjobs-running', async ({request}) => {
    return runJudgmentJobsRead({
      operation: async () => {
        return {data: {jobs: await getOwnerBackedRunningJudgmentJobs()}, error: null}
      },
      request,
    })
  })
  .get(
    '/api/judgmentsjobs-provider-telemetry-history',
    async ({query, request}) => {
      return runJudgmentJobsRead({
        operation: async () => {
          const db = getJudgmentJobsReadDatabase()
          const {job, projectModelId} = await getJobContext({db, jobId: query.jobId})
          const requestedProviderKey = getTrimmedProviderKey(query.providerKey)
          const providerKey = requestedProviderKey
            ? requestedProviderKey
            : getJudgmentProviderTelemetryProviderSnapshot({
                job: {id: job.id, modelId: projectModelId},
                providerConnection: await getProviderConnectionForStoredModel(projectModelId, db),
              }).providerKey
          const history = await queryJudgmentProviderTelemetryBucketedHistory({
            jobId: job.id,
            providerKey,
            range: query.range,
            runner: db,
          })

          return getTelemetryHistoryRoutePayload(history)
        },
        request,
      })
    },
    {query: judgmentProviderTelemetryHistoryQuerySchema},
  )
  .post(
    '/api/judgmentsjobs-worker-heartbeats',
    async ({body}) => {
      return recordJudgmentJobWorkerHeartbeat(body)
    },
    {body: judgmentWorkerHeartbeatBodySchema},
  )
  .get(
    '/api/judgmentsjobs/:id/runtime',
    async ({params, request}) => {
      return runJudgmentJobsRead({
        operation: async () => {
          return {data: {job: await getOwnerBackedJudgmentJobRuntime(params.id)}, error: null}
        },
        request,
      })
    },
    {params: t.Object({id: t.String()})},
  )
  .get(
    '/api/judgmentsjobs/execution-snapshots/:executionSnapshotId',
    async ({params, query}) => {
      return fetchJudgmentExecutionSnapshot(params.executionSnapshotId, query)
    },
    {params: t.Object({executionSnapshotId: t.String()}), query: judgmentSnapshotQuerySchema},
  )
  .get(
    '/api/judgmentsjobs-execution-snapshots/:executionSnapshotId',
    async ({params, query}) => {
      return fetchJudgmentExecutionSnapshot(params.executionSnapshotId, query)
    },
    {params: t.Object({executionSnapshotId: t.String()}), query: judgmentSnapshotQuerySchema},
  )
  .get(
    '/api/judgmentsjobs/:id',
    async ({params, request}) => {
      return runJudgmentJobsRead({
        operation: async () => {
          const db = getJudgmentJobsReadDatabase()
          const {job, projectModelId} = await getJobContext({db, jobId: params.id})
          const sqliteService = getJudgmentJobSqliteService()
          const sqliteHealthPromise = getSqliteHealthForReadableRoute({db, job, jobId: job.id})
          const providerConnectionPromise = getProviderConnectionForStoredModel(projectModelId, db)
          const leaseMetadataPromise = shouldCurrentServerRunJudgingLoops()
            ? sqliteService.getJudgmentJobLeaseMetadata(job.id)
            : Promise.resolve(null)
          const failedRequestSummaryPromise = providerConnectionPromise.then((providerConnection) => {
            return getFailedRequestSummaryFromDatabase({
              db,
              jobId: job.id,
              modelProvider: providerConnection?.providerKind ?? null,
            })
          })

          const judgingRuntimePromise = getJudgingRuntime()
          const [
            sqliteHealth,
            leaseMetadata,
            totalTokenUsage,
            failedRequestSummary,
            judgingRuntime,
            providerConnection,
          ] = await Promise.all([
            sqliteHealthPromise,
            leaseMetadataPromise,
            db.queryJson<{
              totalTokens: number | null
              totalPromptTokens: number | null
              totalCompletionTokens: number | null
              totalRequests: number | null
            }>(`
          SELECT
            SUM(total_tokens) AS totalTokens,
            SUM(total_prompt_tokens) AS totalPromptTokens,
            SUM(total_completion_tokens) AS totalCompletionTokens,
            SUM(requests) AS totalRequests
          FROM app.token_use
          WHERE judgment_job_id = '${escapeSqlString(job.id)}'
        `),
            failedRequestSummaryPromise,
            judgingRuntimePromise,
            providerConnectionPromise,
          ])
          const storagePolicy = getStoragePolicy({job, sqliteHealth})
          const recentTransfer = getJudgmentJobStorageTransferRuntime(job.id)
          const providerTelemetry = await getJudgmentProviderTelemetrySnapshot({
            job: {
              id: job.id,
              maxInflightRequests: providerConnection?.maxInflightRequests ?? null,
              modelId: projectModelId,
              modelProvider: providerConnection?.providerKind ?? null,
              providerConnectionId: providerConnection?.id ?? null,
              providerName: providerConnection?.label ?? null,
            },
            providerConnection,
            readyCount: sqliteHealth.promptCounts.ready,
          })
          const dispatchTelemetry = providerTelemetry.dispatchTelemetry
          const endpointAvailability = providerTelemetry.endpointAvailability
          const dispatchStats = dispatchTelemetry.dispatch
          const requestRuntimeStats = dispatchTelemetry.request

          const activePromptsNotMarkedRunning = Math.max(
            0,
            dispatchStats.jobActivePrompts - sqliteHealth.promptCounts.running,
          )
          const promptStats = {
            claimed: Math.max(0, sqliteHealth.promptCounts.claimed - activePromptsNotMarkedRunning),
            judged: sqliteHealth.promptCounts.judged,
            ready: sqliteHealth.promptCounts.ready,
            running: Math.max(sqliteHealth.promptCounts.running, dispatchStats.jobActivePrompts),
            skipped: sqliteHealth.promptCounts.skipped,
          }
          const lifecycleCounters = {
            claimedPrompts: promptStats.claimed,
            liveLlmCalls: requestRuntimeStats.inFlight,
            providerKey: dispatchTelemetry.provider.providerKey,
            runningPrompts: promptStats.running,
            workerActivePrompts: dispatchStats.jobActivePrompts,
            workerQueuedPrompts: dispatchStats.jobQueuedPrompts,
          }
          const storageHealth = {...sqliteHealth, ...(recentTransfer ? {recentTransfer} : {})}

          return {
            ...job,
            leaseMetadata,
            promptStats,
            storagePolicy,
            storageHealth,
            judgingRuntime,
            totalTokenUsage: {
              totalTokens: Number(totalTokenUsage[0]?.totalTokens || 0),
              totalPromptTokens: Number(totalTokenUsage[0]?.totalPromptTokens || 0),
              totalCompletionTokens: Number(totalTokenUsage[0]?.totalCompletionTokens || 0),
            },
            requestStats: {
              dispatch: {
                jobActivePrompts: dispatchStats.jobActivePrompts,
                jobQueuedPrompts: dispatchStats.jobQueuedPrompts,
                providerDispatchActivePromptFillPct: dispatchStats.providerDispatchActivePromptFillPct,
                providerDispatchActivePromptLimit: dispatchStats.providerDispatchActivePromptLimit,
                providerDispatchActivePrompts: dispatchStats.providerDispatchActivePrompts,
                providerDispatchPrefetchFillPct: dispatchStats.providerDispatchPrefetchFillPct,
                providerDispatchQueueLimit: dispatchStats.providerDispatchQueueLimit,
                providerDispatchQueuedPrompts: dispatchStats.providerDispatchQueuedPrompts,
              },
              endpointAvailability,
              failures: failedRequestSummary,
              inFlight: requestRuntimeStats.inFlight,
              lifecycle: dispatchTelemetry.lifecycle,
              lifecycleCounters,
              liveLlmCalls: requestRuntimeStats.inFlight,
              providerTelemetry: dispatchTelemetry.provider,
              requestSlotWaiters: requestRuntimeStats.requestSlotWaiters,
              requestWorkBacklog: requestRuntimeStats.requestWorkBacklog,
              telemetrySource: dispatchTelemetry.source,
              waitingForRequestSlot: requestRuntimeStats.waitingForRequestSlot,
              attempts: Number(totalTokenUsage[0]?.totalRequests || 0) + requestRuntimeStats.pendingPersistedAttempts,
            },
          }
        },
        request,
      })
    },
    {params: t.Object({id: t.String()})},
  )
  .get(
    '/api/judgmentsjobs-unassessed-count',
    async ({query}) => {
      const {projectDateFrom, projectDateTo, importRouteIds, projectModelId, job} = await getJobContext({
        jobId: query.jobId,
      })
      const freshness = await getProjectMartFreshnessState(job.projectId)

      const cacheKey = getUnassessedCountCacheKey(
        job.projectId,
        projectModelId,
        projectDateFrom,
        projectDateTo,
        importRouteIds,
        job.useTitle,
        job.useAbstract,
        job.useFulltext,
        job.useFulltextNoImages,
        freshness.dirtyToken,
        freshness.lastCompletedDirtyToken,
      )
      const cached = unassessedCountCache.get(cacheKey)
      const now = Date.now()
      if (freshness.isFresh && cached && cached.expiresAt > now) {
        return {
          count: cached.value,
          freshness: getProjectMartFreshnessPayload(freshness),
          freshnessStatus: freshness.status,
        }
      }

      const count = await getJudgmentJobUnassessedCountFromServing({
        projectId: job.projectId,
        projectDateFrom,
        projectDateTo,
        importRouteIds,
      })

      if (freshness.isFresh) {
        unassessedCountCache.set(cacheKey, {value: count, expiresAt: now + unassessedCountTTLms})
      }

      return {count, freshness: getProjectMartFreshnessPayload(freshness), freshnessStatus: freshness.status}
    },
    {query: t.Object({jobId: t.String()})},
  )
  .get(
    '/api/judgmentsjobs-unassessed-articles',
    async ({query}) => {
      const {projectDateFrom, projectDateTo, importRouteIds, job} = await getJobContext({jobId: query.jobId})
      const freshness = await getProjectMartFreshnessState(job.projectId)

      const {articles} = await getJudgmentJobUnassessedArticlesFromServing({
        projectId: job.projectId,
        projectDateFrom,
        projectDateTo,
        importRouteIds,
        limit: 100,
      })

      const unassessedArticles = articles.map((a) => {
        return {
          id: a.id,
          articleId: a.articleId,
          articleTitle: a.articleTitle,
          articleAuthors: null,
          articleCreatedAt: a.articleCreatedAt,
          articleUpdatedAt: a.articleUpdatedAt,
          arxivId: null,
          biorxivId: null,
          doi: null,
          medrxivId: null,
          pubmedId: null,
          sourceMetadata: null,
          url: null,
        }
      })

      return {
        data: unassessedArticles,
        error: null,
        freshness: getProjectMartFreshnessPayload(freshness),
        freshnessStatus: freshness.status,
      }
    },
    {query: t.Object({jobId: t.String()})},
  )
  .get('/api/judgmentsjobs', async ({request}) => {
    return runJudgmentJobsRead({
      operation: async () => {
        const db = getJudgmentJobsReadDatabase()
        const jobs = await db.queryJson<{
          id: string
          createdAt: unknown
          updatedAt: unknown
          projectId: string
          status: string
          error: unknown
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
          projectName: string | null
        }>(`
        SELECT
          jj.id AS id,
          jj.created_at AS createdAt,
          jj.updated_at AS updatedAt,
          jj.project_id AS projectId,
          jj.status AS status,
          TO_JSON(jj.error) AS error,
          jj.storage_state AS storageState,
          jj.quarantined_at AS quarantinedAt,
          jj.quarantine_reason AS quarantineReason,
          jj.last_import_started_at AS lastImportStartedAt,
          jj.last_import_completed_at AS lastImportCompletedAt,
          jj.last_import_error_at AS lastImportErrorAt,
          jj.last_import_error AS lastImportError,
          jj.last_import_exit_code AS lastImportExitCode,
          jj.import_failure_count AS importFailureCount,
          jj.pause_requested_at AS pauseRequestedAt,
          p.name AS projectName
        FROM app.judgment_job jj
        INNER JOIN app.project p ON jj.project_id = p.id
        WHERE p.archived = FALSE
        ORDER BY jj.created_at ASC
      `)
        const sqliteHealthByJobId = await getSqliteHealthMapForReadableRoute({db, jobs})
        const jobsWithHealth = jobs.map((job) => {
          const normalizedJob = {
            ...job,
            createdAt: getDateValue(job.createdAt),
            updatedAt: getDateValue(job.updatedAt),
            error: getJsonValue(job.error) as string[] | null,
            quarantinedAt: getDateValue(job.quarantinedAt),
            lastImportStartedAt: getDateValue(job.lastImportStartedAt),
            lastImportCompletedAt: getDateValue(job.lastImportCompletedAt),
            lastImportErrorAt: getDateValue(job.lastImportErrorAt),
            importFailureCount: Number(job.importFailureCount ?? 0),
            pauseRequestedAt: getDateValue(job.pauseRequestedAt),
          }
          const sqliteHealth = sqliteHealthByJobId.get(job.id)

          if (!sqliteHealth) {
            throw getMaintenanceUnavailableError(
              `fresh SQLite health projection is unavailable for judgment job ${job.id}`,
            )
          }

          const badges = getJobHealthBadges({job: normalizedJob, sqliteHealth})

          return {...normalizedJob, health: {badges, isHealthy: badges.length === 1 && badges[0] === 'Healthy'}}
        })

        return {data: jobsWithHealth, error: null}
      },
      request,
    })
  })
  .get('/api/judgmentsjobs-health', async ({request}) => {
    return runJudgmentJobsRead({
      operation: async () => {
        const db = getJudgmentJobsReadDatabase()
        const currentNow = new Date()
        const jobs = await db.queryJson<{
          id: string
          status: string
          projectId: string
          projectModelId: string
          useTitle: boolean | null
          useAbstract: boolean | null
          useFulltext: boolean | null
          useFulltextNoImages: boolean | null
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
        }>(`
        SELECT
          jj.id AS id,
          jj.status AS status,
          jj.project_id AS projectId,
          COALESCE(p.model_id, '') AS projectModelId,
          p.use_title AS useTitle,
          p.use_abstract AS useAbstract,
          p.use_fulltext AS useFulltext,
          p.use_fulltext_no_images AS useFulltextNoImages,
          jj.storage_state AS storageState,
          jj.quarantined_at AS quarantinedAt,
          jj.quarantine_reason AS quarantineReason,
          jj.last_import_started_at AS lastImportStartedAt,
          jj.last_import_completed_at AS lastImportCompletedAt,
          jj.last_import_error_at AS lastImportErrorAt,
          jj.last_import_error AS lastImportError,
          jj.last_import_exit_code AS lastImportExitCode,
          jj.import_failure_count AS importFailureCount,
          jj.pause_requested_at AS pauseRequestedAt
        FROM app.judgment_job jj
        INNER JOIN app.project p ON jj.project_id = p.id
        ORDER BY jj.created_at ASC
      `)
        const jobIds = jobs.map((job) => {
          return job.id
        })
        const sqliteHealthByJobId = await getSqliteHealthMapForReadableRoute({db, jobs})
        const [importConsumer, importWorkLeasesByJobId] = await Promise.all([
          getJudgmentImportConsumerAvailability(),
          getJudgmentImportWorkLeasesByJobId({db, jobIds, now: currentNow}),
        ])
        const jobsWithHealth = await Promise.all(
          jobs.map(async (job) => {
            const normalizedJob = {
              ...job,
              importFailureCount: Number(job.importFailureCount ?? 0),
              lastImportCompletedAt: getDateValue(job.lastImportCompletedAt),
              lastImportErrorAt: getDateValue(job.lastImportErrorAt),
              lastImportStartedAt: getDateValue(job.lastImportStartedAt),
              pauseRequestedAt: getDateValue(job.pauseRequestedAt),
              quarantinedAt: getDateValue(job.quarantinedAt),
              useAbstract: job.useAbstract ?? true,
              useFulltext: job.useFulltext ?? false,
              useFulltextNoImages: job.useFulltextNoImages ?? false,
              useTitle: job.useTitle ?? true,
            }
            const sqliteHealth = sqliteHealthByJobId.get(job.id)
            const workIdentity = getJudgmentJobWorkIdentity({job: normalizedJob, modelId: job.projectModelId})
            const endpointHealth = await getJudgmentJobEndpointHealth({db, modelId: job.projectModelId})

            if (!sqliteHealth) {
              throw getMaintenanceUnavailableError(
                `fresh SQLite health projection is unavailable for judgment job ${job.id}`,
              )
            }

            const action = getRecommendedHealthAction({job: normalizedJob, sqliteHealth})
            const progress = getJudgmentJobHealthProgress({
              endpointHealth,
              importConsumer,
              importWorkLeases: importWorkLeasesByJobId.get(job.id) ?? [],
              job: normalizedJob,
              now: currentNow,
              recommendedNextAction: action,
              sqliteHealth,
              workIdentity,
            })

            return {
              ...progress,
              action,
              endpointAvailability: endpointHealth.diagnostics,
              job: normalizedJob,
              providerDiagnostics: endpointHealth.providerDiagnostics,
              sqliteHealth,
            }
          }),
        )
        const progressStates = getProgressStateCounts(jobsWithHealth)
        const jobsSummary = jobsWithHealth.map(
          ({action, endpointAvailability, job, providerDiagnostics, sqliteHealth, ...progress}) => {
            const normalizedJob = {
              id: job.id,
              projectId: job.projectId,
              status: job.status,
              storageState: job.storageState,
            }

            return {
              ...progress,
              action,
              endpointAvailability,
              job: normalizedJob,
              jobId: job.id,
              providerDiagnostics,
              sqliteHealth,
            }
          },
        )

        return {
          data: {
            activeImport: progressStates.activeImport,
            blockedImport: progressStates.blockedImport,
            completionAckBacklog: progressStates.waitingForOwnerAck,
            cooldown: progressStates.cooldown,
            healthy: jobsWithHealth.filter(({action, job}) => {
              return isHealthyJob({action, job})
            }).length,
            draining: jobsWithHealth.filter(({job}) => {
              return job.storageState === 'draining'
            }).length,
            offlineRepairRequired: jobsWithHealth.filter(({action}) => {
              return action === 'repair_offline_required'
            }).length,
            quarantined: jobsWithHealth.filter(({job}) => {
              return job.storageState === 'quarantined'
            }).length,
            orphanedLocalQueue: jobsWithHealth.filter(({sqliteHealth}) => {
              return hasOrphanedJudgedQueue(sqliteHealth)
            }).length,
            retainedOutbox: jobsWithHealth.filter(({sqliteHealth}) => {
              return hasRetainedOutbox(sqliteHealth)
            }).length,
            staleImport: jobsWithHealth.filter(({job}) => {
              return isStaleImportJob(job)
            }).length,
            importConsumer,
            jobs: jobsSummary,
            progressStates,
            repairRequired: progressStates.repairRequired,
          },
          error: null,
        }
      },
      request,
    })
  })
  .get('/api/judgmentsjobs-total-token-usage', async () => {
    const [totalUsage] = await getAppDatabaseService().queryJson<{
      totalTokens: number | null
      totalPromptTokens: number | null
      totalCompletionTokens: number | null
    }>(`
      SELECT
        SUM(total_tokens) AS totalTokens,
        SUM(total_prompt_tokens) AS totalPromptTokens,
        SUM(total_completion_tokens) AS totalCompletionTokens
      FROM app.token_use
    `)

    return {
      data: {
        totalTokens: Number(totalUsage?.totalTokens || 0),
        totalPromptTokens: Number(totalUsage?.totalPromptTokens || 0),
        totalCompletionTokens: Number(totalUsage?.totalCompletionTokens || 0),
      },
      error: null,
    }
  })
  .patch(
    '/api/judgmentsjobs/:id',
    async ({params, body}) => {
      const sqliteService = getJudgmentJobSqliteService()
      let clearTransientQuarantine = false

      if (body.status === 'running') {
        await assertJudgingRuntimeCanRun()
        const {job, projectModelId} = await getJobContext({jobId: params.id})
        await assertStoredProviderModelRuntimeMatch({modelId: projectModelId})

        if (!sqliteService.hasJob(params.id)) {
          await sqliteService.initializeJob(params.id)
        }

        if (job.storageState === 'active') {
          const preflightResult = await assertJudgmentJobCanRunSqlitePreflight({
            jobId: params.id,
            quarantineReason: job.quarantineReason,
            storageState: job.storageState,
          })

          clearTransientQuarantine = preflightResult.clearTransientQuarantine
        }

        if (job.storageState === 'active' || job.storageState === 'draining') {
          await runAutomaticOrphanedQueueRepairForJob({
            claimedBy: judgmentJobServerId,
            failOnIncomplete: true,
            jobId: params.id,
            preflightBeforeRepair: job.storageState === 'draining',
          })
        }

        const {job: repairedJob} = await getJobContext({jobId: params.id})
        const preflightResult = await assertJudgmentJobCanRunSqlitePreflight({
          jobId: params.id,
          quarantineReason: repairedJob.quarantineReason,
          storageState: repairedJob.storageState,
        })

        clearTransientQuarantine = clearTransientQuarantine || preflightResult.clearTransientQuarantine
      }

      const updatedJob = (await getAppDatabaseService().transaction(async (tx) => {
        const storageAssignments = getJudgmentJobMutationStorageAssignments({
          clearTransientQuarantine,
          status: body.status,
        })
        await tx.run(`
          UPDATE app.judgment_job
          SET status = ${getSqlLiteral(body.status)},
              error = ${getSqlLiteral(body.error ?? null)},
              ${storageAssignments ? `${storageAssignments},` : ''}
              updated_at = current_timestamp
          WHERE id = '${escapeSqlString(params.id)}'
        `)

        return getJudgmentJobMutationState(tx, params.id)
      })) as JudgmentJobMutationState | null

      if (body.status === 'paused') {
        await sqliteService.clearActiveQueue(params.id)
      }

      if (body.status && body.status !== 'running') {
        await sqliteService.releaseOwnedLease(params.id)
      }

      if (!updatedJob) {
        throw new Error('Job not found')
      }

      return {
        data: {
          jobId: updatedJob.id,
          status: updatedJob.status,
          storageState: updatedJob.storageState,
          quarantinedAt: getDateValue(updatedJob.quarantinedAt),
          quarantineReason: updatedJob.quarantineReason,
          lastImportStartedAt: getDateValue(updatedJob.lastImportStartedAt),
          lastImportCompletedAt: getDateValue(updatedJob.lastImportCompletedAt),
          lastImportErrorAt: getDateValue(updatedJob.lastImportErrorAt),
          lastImportError: updatedJob.lastImportError,
          lastImportExitCode: updatedJob.lastImportExitCode,
          importFailureCount: Number(updatedJob.importFailureCount ?? 0),
          pauseRequestedAt: getDateValue(updatedJob.pauseRequestedAt),
          updatedAt: getDateValue(updatedJob.updatedAt),
          error: getJsonValue(updatedJob.error) as string[] | null,
        },
        error: null,
      }
    },
    {
      params: t.Object({id: t.String()}),
      body: t.Object({
        status: t.Optional(
          t.Union([
            t.Literal('not_started'),
            t.Literal('waiting_on_llm_connection'),
            t.Literal('waiting_on_db_connection'),
            t.Literal('running'),
            t.Literal('paused'),
            t.Literal('failed'),
            t.Literal('completed'),
            t.Literal('project_removed'),
          ]),
        ),
        error: t.Optional(t.Array(t.String())),
      }),
    },
  )
  .post(
    '/api/judgmentsjobs/:id/start-clean',
    async ({params}) => {
      await assertJudgingRuntimeCanRun()

      const sqliteService = getJudgmentJobSqliteService()
      const {job, projectModelId} = await getJobContext({jobId: params.id})

      if (job.status === 'running') {
        throw new HttpError(409, `Pause job ${params.id} before starting it clean.`)
      }

      await assertStoredProviderModelRuntimeMatch({modelId: projectModelId})
      await resetJudgmentJobLocalSqliteState({jobId: params.id, storageState: job.storageState})
      await sqliteService.initializeJob(params.id)
      await assertJudgmentJobCanRunSqlitePreflight({jobId: params.id, quarantineReason: null, storageState: 'active'})

      const updatedJob = (await getAppDatabaseService().transaction(async (tx) => {
        await tx.run(`
          UPDATE app.judgment_job
          SET status = 'running',
              error = NULL,
              storage_state = 'active',
              pause_requested_at = NULL,
              quarantined_at = NULL,
              quarantine_reason = NULL,
              updated_at = current_timestamp
          WHERE id = '${escapeSqlString(params.id)}'
        `)

        return getJudgmentJobMutationState(tx, params.id)
      })) as JudgmentJobMutationState | null

      if (!updatedJob) {
        throw new Error('Job not found')
      }

      return {
        data: {
          jobId: updatedJob.id,
          status: updatedJob.status,
          storageState: updatedJob.storageState,
          quarantinedAt: getDateValue(updatedJob.quarantinedAt),
          quarantineReason: updatedJob.quarantineReason,
          lastImportStartedAt: getDateValue(updatedJob.lastImportStartedAt),
          lastImportCompletedAt: getDateValue(updatedJob.lastImportCompletedAt),
          lastImportErrorAt: getDateValue(updatedJob.lastImportErrorAt),
          lastImportError: updatedJob.lastImportError,
          lastImportExitCode: updatedJob.lastImportExitCode,
          importFailureCount: Number(updatedJob.importFailureCount ?? 0),
          pauseRequestedAt: getDateValue(updatedJob.pauseRequestedAt),
          updatedAt: getDateValue(updatedJob.updatedAt),
          error: getJsonValue(updatedJob.error) as string[] | null,
        },
        error: null,
      }
    },
    {params: t.Object({id: t.String()})},
  )
  .post(
    '/api/judgmentsjobs/:id/preflight',
    async ({params}) => {
      return {data: await runJudgmentJobRepairAction({action: 'preflight', jobId: params.id}), error: null}
    },
    {params: t.Object({id: t.String()})},
  )
  .post(
    '/api/judgmentsjobs/:id/drain',
    async ({params, body}) => {
      return {
        data: await runJudgmentJobRepairAction({
          action: 'drain',
          claimedBy: body?.claimedBy,
          jobId: params.id,
          systemSqliteFallbackSteps: body?.systemSqliteFallbackSteps,
        }),
        error: null,
      }
    },
    {
      params: t.Object({id: t.String()}),
      body: t.Optional(
        t.Object({
          claimedBy: t.Optional(t.String()),
          systemSqliteFallbackSteps: t.Optional(systemSqliteFallbackStepsSchema),
        }),
      ),
    },
  )
  .post(
    '/api/judgmentsjobs/:id/checkpoint',
    async ({params, body}) => {
      return {
        data: await runJudgmentJobRepairAction({
          action: 'checkpoint',
          claimedBy: body?.claimedBy,
          jobId: params.id,
          systemSqliteFallbackSteps: body?.systemSqliteFallbackSteps,
        }),
        error: null,
      }
    },
    {
      params: t.Object({id: t.String()}),
      body: t.Optional(
        t.Object({
          claimedBy: t.Optional(t.String()),
          systemSqliteFallbackSteps: t.Optional(systemSqliteFallbackStepsSchema),
        }),
      ),
    },
  )
  .post(
    '/api/judgmentsjobs/:id/quarantine',
    async ({params, body}) => {
      return {
        data: await runJudgmentJobRepairAction({action: 'quarantine', jobId: params.id, reason: body?.reason}),
        error: null,
      }
    },
    {params: t.Object({id: t.String()}), body: t.Optional(t.Object({reason: t.Optional(t.String())}))},
  )
  .post(
    '/api/judgmentsjobs/:id/unquarantine',
    async ({params}) => {
      return {data: await runJudgmentJobRepairAction({action: 'unquarantine', jobId: params.id}), error: null}
    },
    {params: t.Object({id: t.String()})},
  )
  .post(
    '/api/judgmentsjobs/:id/repair',
    async ({params, body}) => {
      return {
        data: await runJudgmentJobRepairAction({
          action: 'repair',
          claimedBy: body?.claimedBy,
          jobId: params.id,
          systemSqliteFallbackSteps: body?.systemSqliteFallbackSteps,
        }),
        error: null,
      }
    },
    {
      params: t.Object({id: t.String()}),
      body: t.Optional(
        t.Object({
          claimedBy: t.Optional(t.String()),
          systemSqliteFallbackSteps: t.Optional(systemSqliteFallbackStepsSchema),
        }),
      ),
    },
  )
  .post(
    '/api/judgmentsjobs/:id/repair-orphaned-queue',
    async ({params, body}) => {
      return {
        data: await runJudgmentJobAutomaticOrphanedQueueRepairAction({claimedBy: body?.claimedBy, jobId: params.id}),
        error: null,
      }
    },
    {
      params: t.Object({id: t.String()}),
      body: t.Optional(
        t.Object({
          claimedBy: t.Optional(t.String()),
          systemSqliteFallbackSteps: t.Optional(systemSqliteFallbackStepsSchema),
        }),
      ),
    },
  )
  .delete(
    '/api/judgmentsjobs/:id',
    async ({params}) => {
      const sqliteService = getJudgmentJobSqliteService()

      await retryPendingJudgmentJobSqliteDeletes({sqliteService})

      const [existingJob] = await getAppDatabaseService().queryJson<{
        id: string
        quarantineReason: string | null
        storageState: string
      }>(`
        SELECT id
             , storage_state AS storageState
             , quarantine_reason AS quarantineReason
        FROM app.judgment_job
        WHERE id = '${escapeSqlString(params.id)}'
        LIMIT 1
      `)

      if (!existingJob) {
        throw new Error('Job not found')
      }

      const shouldUseCrashContainedDeleteFlush =
        getJudgmentJobRepairMode({
          hasLocalSqliteState: sqliteService.hasJob(params.id),
          job: {status: 'failed', storageState: existingJob.storageState},
        }) === 'offline_repair_required'

      if (shouldUseCrashContainedDeleteFlush) {
        const flushResult = await runJudgmentJobSqliteIsolatedFlush({claimedBy: judgmentJobServerId, jobId: params.id})

        if (flushResult.errorMessage !== null) {
          if (
            !isJudgmentJobSqliteIsolatedImportLeaseConflict(flushResult.errorMessage)
            && !isTransientJudgmentJobSqliteLockMessage(flushResult.errorMessage)
          ) {
            await runJudgmentJobRepairAction({action: 'quarantine', jobId: params.id, reason: flushResult.errorMessage})
          }

          throw new HttpError(
            409,
            `Delete Job stopped safely for ${params.id}: ${flushResult.errorMessage} Local SQLite data was left in place.`,
          )
        }
      }

      if (sqliteService.hasJob(params.id) && !shouldUseCrashContainedDeleteFlush) {
        await flushJudgmentJobSqliteOutbox({claimedBy: judgmentJobServerId, jobId: params.id})
      }

      await getAppDatabaseService().transaction(async (tx) => {
        await markJudgmentJobSqliteDeletePendingTx({jobId: params.id, tx})
        await deleteJudgmentJobSafelyTx({jobId: params.id, tx})
      })

      const localCleanup = await deletePendingJudgmentJobSqliteState({jobId: params.id, sqliteService})

      return {data: {jobId: existingJob.id, ...localCleanup}, error: null}
    },
    {params: t.Object({id: t.String()})},
  )
