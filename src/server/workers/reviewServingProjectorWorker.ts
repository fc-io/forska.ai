import {createHash} from 'node:crypto'
import {hostname} from 'node:os'

import {sleep} from '../../utils/sleep.ts'
import {intakeReviewChangeDeltasToDirtyWork} from '../reviewServing/reviewChangeDeltaDirtyIntakeService.ts'
import {intakeReviewImportDeltasToDirtyWork} from '../reviewServing/reviewImportDeltaDirtyIntakeService.ts'
import {
  buildPromptConfigHash,
  buildReviewConfigHash,
  type ReviewServingIdentityValue,
} from '../reviewServing/reviewProjectionIdentity.ts'
import {
  claimReviewServingRebuildChunk,
  getNextClaimableReviewServingRebuildChunk,
  getReviewServingRebuildChunkClaimWhere,
  getReviewServingRebuildChunkManifest,
  heartbeatReviewServingRebuildChunkLease,
  isReviewServingRebuildChunkComplete,
  markReviewServingRebuildChunkFailed,
  type ReviewServingChunkManifestRepositoryDatabase,
  type ReviewServingChunkManifestRepositoryTransaction,
  type ReviewServingRebuildChunkIdentity,
  type ReviewServingRebuildChunkManifest,
  type ReviewServingRebuildChunkValidationResult,
  upsertReviewServingRebuildChunkManifests,
  writeReviewServingRebuildChunkOutput,
} from '../reviewServing/reviewServingChunkManifestRepository.ts'
import {reviewServingListModes, type ReviewServingProjectionComponent} from '../reviewServing/reviewServingContracts.ts'
import {
  completeReviewServingDirtyWorkClaims,
  releaseReviewServingDirtyWorkClaims,
  type ReviewServingDirtyWorkClaim,
} from '../reviewServing/reviewServingDirtyWorkService.ts'
import {
  projectReviewServingDisplayBaseRanges,
  projectReviewServingDisplayBaseRows,
  projectReviewServingDisplayPatches,
  projectReviewServingPayloadRanges,
  projectReviewServingPayloadRows,
} from '../reviewServing/reviewServingDisplayPayloadProjector.ts'
import {
  getReviewServingFilterOptionIdentity,
  projectReviewServingFilterOptions,
} from '../reviewServing/reviewServingFilterOptionProjector.ts'
import {
  projectReviewServingFilterPostings,
  refreshReviewServingFilterPostingStats,
} from '../reviewServing/reviewServingFilterPostingProjector.ts'
import {projectReviewServingHumanStatusPatches} from '../reviewServing/reviewServingHumanStatusProjector.ts'
import {
  projectReviewServingJudgmentPayloadArticleRanges,
  projectReviewServingJudgmentPayloadRows,
} from '../reviewServing/reviewServingJudgmentPayloadProjector.ts'
import {projectReviewServingLlmStatusPatches} from '../reviewServing/reviewServingLlmStatusProjector.ts'
import {
  createCandidateReviewServingSnapshotManifest,
  getReviewServingProjectionIdentityManifest,
  getReviewServingSnapshotManifest,
  type ReviewServingSnapshotManifest,
} from '../reviewServing/reviewServingManifestRepository.ts'
import {getReviewServingSourcePartitionWatermarks} from '../reviewServing/reviewServingProjectorDomain.ts'
import {
  type ReviewServingProjectorRunner,
  type ReviewServingProjectorServiceDependencies,
  wakeReviewServingProjectorService,
  type WakeReviewServingProjectorServiceInput,
  type WakeReviewServingProjectorServiceResult,
} from '../reviewServing/reviewServingProjectorService.ts'
import {
  deleteReviewServingProjectorRows,
  promoteReviewServingProjectorSnapshot,
  writeReviewServingProjectorComponent,
} from '../reviewServing/reviewServingProjectorWriter.ts'
import {projectReviewServingProjectScopePatches} from '../reviewServing/reviewServingProjectScopeProjector.ts'
import {
  projectReviewServingQueuePatches,
  projectReviewServingQueueRebuildRanges,
  projectReviewServingQueueRebuildRows,
} from '../reviewServing/reviewServingQueueProjector.ts'
import {
  cleanupReviewServingRetentionState,
  getReviewServingRetentionCleanupTargets,
  type ReviewServingRetentionCleanupInput,
  type ReviewServingRetentionServiceDatabase,
} from '../reviewServing/reviewServingRetentionService.ts'
import {projectReviewServingSelectedImportDirty} from '../reviewServing/reviewServingSelectedImportDirtyProjector.ts'
import {
  projectReviewServingSelectedImportArticleRange,
  type ProjectReviewServingSelectedImportArticleRangeInput,
  projectReviewServingSelectedImportArticleRanges,
  projectReviewServingSelectedImportBatch,
  refreshReviewServingSelectedImportServingArticleRange,
} from '../reviewServing/reviewServingSelectedImportProjector.ts'
import {composeReviewServingCandidateSnapshotManifest} from '../reviewServing/reviewServingSnapshotPromotionService.ts'
import {
  projectReviewServingSummaries,
  reduceReviewServingSummaryRebuildPartialsForRequestSnapshots,
} from '../reviewServing/reviewServingSummaryProjector.ts'
import {
  projectReviewServingTitleSearchRebuildRanges,
  projectReviewServingTitleSearchRebuildRows,
  projectReviewServingTitleSearchRows,
} from '../reviewServing/reviewServingTitleSearchProjector.ts'
import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getJsonValue, getSqlLiteral} from '../services/appQueryHelpers.ts'
import {parseDuckdbMemoryLimitToMiB} from '../utils/duckdbMemoryLimit.ts'
import {
  closeDuckdbService,
  type DuckdbWorkloadContext,
  getDuckdbAppendRuntimeMetrics,
  getDuckdbQueueRuntimeMetricsSnapshot,
  recoverDuckdbServiceAfterFatalError,
} from '../utils/duckdbService.ts'
import {createRateLimitedLogger} from '../utils/rateLimitedLogger.ts'

type ReviewServingProjectorWorkerDatabase = NonNullable<ReviewServingProjectorServiceDependencies['database']>

type ReviewServingProjectorWorkerCleanupTarget = ReviewServingRetentionCleanupInput

type ReviewServingProjectorWorkerChunkInput = ReviewServingRebuildChunkIdentity & {checksum?: string | null}
type ReviewServingProjectorWorkerMemoryUsage = {rss: number}

type ClaimedReviewServingProjectorWorkerRebuildChunk = {
  chunk: ReviewServingRebuildChunkManifest
  service: ReviewServingProjectorWorkerRebuildChunkService
  timings: Record<string, number>
}

type ClaimReviewServingProjectorWorkerRebuildChunkResult =
  | {chunk: ReviewServingProjectorWorkerChunkResult; status: 'not-claimed'}
  | (ClaimedReviewServingProjectorWorkerRebuildChunk & {status: 'claimed'})

type RebuildChunkSplitRangeRow = {articleCount: number; chunkEndKey: string; chunkStartKey: string}
type CompletedUnfinalizedRebuildRequestChunkRow = {chunkId: string}
type TerminalFailedRebuildRequestChunkRow = {chunkId: string}
type RebuildChunkOutputValidationInput = {
  chunk: ReviewServingRebuildChunkManifest
  getChecksum: () => Promise<RebuildChunkOutputChecksumRow>
  getCount: () => Promise<RebuildChunkOutputChecksumRow>
}

type DeltaIntakePartitionRow = {
  endSourceHighWaterMark: number
  sourcePartition: string
  startSourceHighWaterMark: number
}

type ReviewServingProjectorWorkerRebuildChunkService = {
  claimChunk: typeof claimReviewServingRebuildChunk
  failChunk: typeof markReviewServingRebuildChunkFailed
  getNextChunk: (input: {
    database: ReviewServingChunkManifestRepositoryDatabase
    now: Date
    projectId?: string | null
  }) => Promise<ReviewServingProjectorWorkerChunkInput | null>
  getCompatibleStatusChunks?: (input: {
    database: ReviewServingChunkManifestRepositoryDatabase
    excludeChunkIds: readonly string[]
    firstChunk: ReviewServingRebuildChunkManifest
    limit: number
    now: Date
    projectId?: string | null
  }) => Promise<readonly ReviewServingProjectorWorkerChunkInput[]>
  heartbeatChunk: typeof heartbeatReviewServingRebuildChunkLease
  isChunkComplete: typeof isReviewServingRebuildChunkComplete
  prepareClaimedChunk?: (input: {
    chunk: ReviewServingRebuildChunkManifest
    database: ReviewServingChunkManifestRepositoryDatabase & ReviewServingProjectorWorkerDatabase
    leaseOwner: string
    workloadContext: DuckdbWorkloadContext
  }) => Promise<unknown>
  runClaimedChunk: (input: {
    chunk: ReviewServingRebuildChunkManifest
    database: ReviewServingChunkManifestRepositoryDatabase & ReviewServingProjectorWorkerDatabase
    leaseOwner: string
    preparedOutput?: unknown
    workloadContext: DuckdbWorkloadContext
  }) => Promise<{status: 'completed'}>
}

type ReviewServingProjectorWorkerDependencies = {
  cleanupRetentionState?: typeof cleanupReviewServingRetentionState
  getCleanupTargets?: (
    database: ReviewServingRetentionServiceDatabase,
  ) => Promise<readonly ReviewServingProjectorWorkerCleanupTarget[]>
  getDatabase?: () => ReviewServingProjectorWorkerDatabase
    & ReviewServingChunkManifestRepositoryDatabase
    & ReviewServingRetentionServiceDatabase
  getMemoryUsage?: () => ReviewServingProjectorWorkerMemoryUsage
  getAppendQueueDepth?: () => number
  getForegroundQueueDepth?: () => number
  intakeImportDeltas?: typeof intakeReviewImportDeltasToDirtyWork
  intakeReviewChangeDeltas?: typeof intakeReviewChangeDeltasToDirtyWork
  nowMs?: () => number
  projectorServiceDependencies?: Omit<ReviewServingProjectorServiceDependencies, 'database' | 'nowMs'>
  rebuildChunkService?: ReviewServingProjectorWorkerRebuildChunkService
  collectGarbageAfterCompletedRebuildChunk?: (chunk: ReviewServingRebuildChunkManifest) => Promise<void> | void
  recycleDuckdbAfterCompletedRebuildChunk?: (chunk: ReviewServingRebuildChunkManifest) => Promise<void>
  recycleDuckdbAfterFatalRebuildChunkError?: (input: {
    chunk: ReviewServingRebuildChunkManifest
    error: unknown
  }) => Promise<void>
  sleep: typeof sleep
  wakeProjectors: typeof wakeReviewServingProjectorService
}

const reviewServingProjectorWorkerCycleLogger = createRateLimitedLogger({sink: 'file-only', windowMs: 30_000})

const getNonNegativeElapsedMs = (startedAtMs: number) => {
  return Math.max(0, Date.now() - startedAtMs)
}

const getProjectorResultDiagnosticsJson = (result: object) => {
  return (result as {diagnosticsJson?: unknown}).diagnosticsJson ?? {}
}

type ReviewServingProjectorWorkerCycleOptions = {
  batchSize?: number
  cleanupIntervalMs?: number
  completedRebuildChunksInRun?: number
  foregroundRebuildDrainChunkBudget?: number
  foregroundRebuildDrainCompletedCount?: number
  foregroundRebuildDrainStartedAtMs?: number | null
  foregroundRebuildDrainTtlMs?: number
  heartbeatMs?: number
  lastCleanupAtMs?: number | null
  leaseMs?: number
  maxActiveImportCount?: number
  maxPendingDirtyWorkCount?: number
  maxCompletedRebuildChunksPerRun?: number | null
  maxRetries?: number
  maxRowsPerWake?: number
  maxWakeMs?: number
  now?: Date
  rebuildChunkBatchMaxRssBytes?: number
  rebuildChunkBatchSize?: number
  rebuildProjectId?: string | null
  workerId?: string
}

type ReviewServingProjectorWorkerLoopOptions = ReviewServingProjectorWorkerCycleOptions & {
  errorBackoffMs?: number
  pollIntervalMs?: number
  signal?: AbortSignal
}

type ReviewServingProjectorWorkerRunResult =
  | {reason: 'aborted'}
  | {reason: 'completedChunkLimit'}
  | {reason: 'nativeHeavyChunkCompleted'}

const getMaxCompletedRebuildChunksPerRun = (value: number | null | undefined) => {
  return value === null ? 0 : getPositiveInteger(value, getDefaultMaxCompletedRebuildChunksPerRun())
}

type ReviewServingProjectorWorkerChunkResult =
  | {chunkId: null; status: 'idle'}
  | {
      chunkId: string
      projectionComponent: ReviewServingProjectionComponent
      requestId: string | null
      status: 'completed'
    }
  | {chunkId: string; requestId: string | null; status: 'failed'}
  | {chunkId: string; requestId: string | null; status: 'skipped'}

type ReviewServingProjectorWorkerCleanupResult =
  | {retentionScopes: readonly string[]; status: 'completed'}
  | {retentionScopes: readonly string[]; status: 'skipped'}

type ReviewServingProjectorWorkerDeltaIntakeResult = {
  convertedPartitions: number
  dirtyWorkCount: number
  status: 'completed' | 'failed' | 'idle'
}

type ReviewServingProjectorWorkerCycleResult = {
  chunk: ReviewServingProjectorWorkerChunkResult
  chunkBatchCount: number
  cleanup: ReviewServingProjectorWorkerCleanupResult
  deltaIntake: ReviewServingProjectorWorkerDeltaIntakeResult
  nextCleanupAtMs: number | null
  projector: WakeReviewServingProjectorServiceResult
  status: 'completed' | 'failed' | 'idle' | 'partial'
  wakeId: string
  workerId: string
}

type ReviewServingSnapshotContextRow = {
  componentStateJson: unknown
  reviewConfigHash: string | null
  selectedImportSnapshotId: string | null
  snapshotId: string
}

type ReviewServingSnapshotComponentState = {
  baseGeneration: string
  component: ReviewServingProjectionComponent
  patchWatermark: string
  projectionIdentity: string
}

type ReviewServingSnapshotComponentStateJson = {
  optional?: readonly ReviewServingSnapshotComponentState[]
  required?: readonly ReviewServingSnapshotComponentState[]
}

type ReviewServingSnapshotContext = ReviewServingSnapshotContextRow & {
  componentState: ReviewServingSnapshotComponentStateJson
}

type ProjectReviewSettingsRow = {
  humanJudgmentMode: 'prompt' | 'summary'
  modelExecutionOptions: unknown
  modelId: string
  modelProviderBaseUrl: string | null
  modelProviderConnectionId: string | null
  modelProviderKind: string | null
  modelRemoteModelId: string | null
  modelVariant: string | null
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useTitle: boolean
}

type ProjectPromptConfigRow = {
  answerSchemaHash: string | null
  promptId: string
  promptOrder: number | null
  promptTextHash: string | null
  settingsVersion: string | null
  thresholdVersion: string | null
}

type ProjectReviewSnapshotSettings = ProjectReviewSettingsRow & {reviewConfigHash: string}

type SelectedImportSnapshotStatusRow = {sourceDeltaHighWater: number; status: string}

type RebuildChunkOutputChecksumRow = {
  actualChecksum: string
  actualCount: number
  actualOutputBytes?: number | null
  actualPayloadBytes?: number | null
}
type RebuildRequestPendingChunkCountRow = {pendingChunkCount: number}
type RebuildRequestPostingChunkCountRow = {postingChunkCount: number}
type SummaryFilterOptionProjectionRow = {outputBaseGeneration: number; projectId: string; projectionIdentity: string}
type RebuildRequestSnapshotPromotionRow = {
  hasPostingRebuildChunks: boolean
  hasSummaryRebuildChunks: boolean
  projectId: string
  reviewConfigHash: string | null
  snapshotId: string
}

const defaultReviewServingProjectorWorkerBatchSize = 64
const defaultReviewServingProjectorWorkerCleanupIntervalMs = 60_000
const defaultReviewServingProjectorWorkerHeartbeatMs = 10_000
const defaultReviewServingProjectorWorkerLeaseMs = 120_000
const defaultReviewServingProjectorWorkerMaxRetries = 1
const defaultReviewServingProjectorWorkerMaxRowsPerWake = 512
const defaultReviewServingProjectorWorkerMaxWakeMs = 5_000
const defaultReviewServingProjectorWorkerPollIntervalMs = 2_000
const defaultReviewServingProjectorWorkerProgressYieldMs = 100
const defaultReviewServingProjectorWorkerRebuildChunkBatchMaxRssBytes = 0
const defaultReviewServingProjectorWorkerRebuildChunkBatchSize = 1
const foregroundHumanStatusRebuildChunkBatchSize = 4
const foregroundLlmStatusRebuildChunkBatchSize = 8
const foregroundStatusRebuildDrainBatchBudget = 16
const foregroundLightweightNativeHeavyRebuildDrainBatchBudget = 32
const foregroundStatusReviewServingProjectorWorkerProgressYieldMs = 100
const lightweightNativeHeavyReviewServingProjectorWorkerProgressYieldMs = 25
const lowMemoryMaintenanceDuckdbLimitMiB = 6400
const lowMemoryReviewServingProjectorWorkerMaxCompletedChunksPerRun = 16
const nativeHeavyReviewServingProjectorWorkerProgressYieldMs = 1_000
const defaultReviewServingProjectorWorkerErrorBackoffMs = 10_000
const defaultReviewServingProjectorWorkerForegroundRebuildDrainChunkBudget = 4
const defaultReviewServingProjectorWorkerForegroundRebuildDrainTtlMs = 5_000
const defaultReviewServingSelectedImportBaseBatchSize = 512
const reviewServingProjectorWorkerRouteOrJobKey = 'reviewServing.projector.worker'
const defaultReviewServingLlmListModeKeys = ['llm', 'both'] as const
const defaultReviewServingHumanListModeKeys = ['human', 'both'] as const
const foregroundBatchableStatusRebuildComponents = new Set<ReviewServingProjectionComponent>([
  'humanStatus',
  'llmStatus',
])
const foregroundBatchableRangeRebuildComponents = new Set<ReviewServingProjectionComponent>([
  'posting',
  'queue',
  'search',
])
// Keep status chunks out of this set: they are small SQL-native updates, and per-chunk forced GC is unnecessary.
const reviewServingNativeHeavyRebuildComponents = new Set<ReviewServingProjectionComponent>(['posting', 'summary'])
const reviewServingDuckdbRecycleAfterRebuildComponents = new Set<ReviewServingProjectionComponent>([
  'posting',
  'summary',
])
const defaultReviewFilterOptionKeys = [
  'conflictFlag',
  'duplicateFlag',
  'humanStatus',
  'importRoute',
  'llmStatus',
  'promptAnswer',
  'publicationYear',
  'searchTokenPrefix',
] as const
const defaultHumanFilterOptionKeys = [
  'conflictFlag',
  'duplicateFlag',
  'humanStatus',
  'importRoute',
  'promptAnswer',
  'publicationYear',
  'searchTokenPrefix',
] as const

const getClaimProjectId = (claims: readonly {projectId: string | null}[]) => {
  return (
    claims.find((claim) => {
      return claim.projectId !== null
    })?.projectId ?? null
  )
}

const getDefaultClaimManifestInput = async (
  context: Parameters<ReviewServingProjectorRunner>[0],
  database: ReviewServingProjectorWorkerDatabase,
) => {
  const projectId = getClaimProjectId(context.claims)

  if (projectId === null) {
    throw new Error(`cannot run ${context.component} projector without a project id`)
  }

  const manifest = await getReviewServingProjectionIdentityManifest(
    {
      projectId,
      projectionComponent: context.component,
      projectionIdentity: context.claims[0]?.projectionIdentity ?? '',
    },
    database,
  )

  if (manifest === null) {
    throw new Error(`cannot run ${context.component} projector without an identity manifest`)
  }

  return {manifest, projectId}
}

const getSnapshotContexts = async (
  input: {
    component: ReviewServingProjectionComponent
    projectId: string
    projectionIdentity: string
    reviewConfigHash: string | null
  },
  database: ReviewServingProjectorWorkerDatabase,
) => {
  const rows = await database.queryJson<ReviewServingSnapshotContextRow>(`
    SELECT
      snapshot_id AS snapshotId,
      review_config_hash AS reviewConfigHash,
      selected_import_snapshot_id AS selectedImportSnapshotId,
      component_state_json AS componentStateJson
    FROM app.review_serving_snapshot_manifest
    WHERE project_id = ${getSqlLiteral(input.projectId)}
      ${input.reviewConfigHash === null ? '' : `AND review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}`}
      AND snapshot_status IN ('candidate', 'active')
    ORDER BY CASE WHEN snapshot_status = 'candidate' THEN 0 ELSE 1 END, updated_at DESC
  `)
  const snapshots = rows.map((row) => {
    return {...row, componentState: getJsonValue(row.componentStateJson) as ReviewServingSnapshotComponentStateJson}
  })

  return snapshots.filter((snapshot) => {
    return getSnapshotComponentState(snapshot, input.component)?.projectionIdentity === input.projectionIdentity
  })
}

const requireSnapshotContexts = async (
  input: {
    component: ReviewServingProjectionComponent
    projectId: string
    projectionIdentity: string
    reviewConfigHash: string | null
  },
  database: ReviewServingProjectorWorkerDatabase,
) => {
  const contexts = await getSnapshotContexts(input, database)

  if (contexts.length === 0) {
    throw new Error(`cannot run projector without a candidate or active snapshot for project ${input.projectId}`)
  }

  return contexts
}

const getSnapshotComponentState = (
  snapshot: ReviewServingSnapshotContext,
  component: ReviewServingProjectionComponent,
) => {
  return (
    [...(snapshot.componentState.required ?? []), ...(snapshot.componentState.optional ?? [])].find((state) => {
      return state.component === component
    }) ?? null
  )
}

const requireSnapshotComponentIdentity = (
  snapshot: ReviewServingSnapshotContext,
  component: ReviewServingProjectionComponent,
) => {
  const projectionIdentity = getSnapshotComponentState(snapshot, component)?.projectionIdentity ?? null

  if (projectionIdentity === null) {
    throw new Error(`cannot run projector without ${component} identity in snapshot ${snapshot.snapshotId}`)
  }

  return projectionIdentity
}

const getSnapshotComponentBaseGeneration = (
  snapshot: ReviewServingSnapshotContext,
  component: ReviewServingProjectionComponent,
) => {
  return Number(getSnapshotComponentState(snapshot, component)?.baseGeneration ?? Number.NaN)
}

const requireRebuildChunkProjectId = (chunk: ReviewServingRebuildChunkManifest) => {
  if (chunk.projectId === null) {
    throw new Error(`cannot run ${chunk.projectionComponent} rebuild chunk without a project id`)
  }

  return chunk.projectId
}

const getChunkArticleRangePredicate = (input: {alias: string; chunk: ReviewServingRebuildChunkManifest}) => {
  return `${input.alias}.article_id >= ${getSqlLiteral(input.chunk.chunkStartKey)}
    AND ${input.alias}.article_id <= ${getSqlLiteral(input.chunk.chunkEndKey)}`
}

const isDuckDbOutOfMemoryError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)

  return (
    message.includes('Out of Memory Error')
    || message.includes('failed to allocate')
    || message.includes('failed to pin block')
  )
}

const isDuckDbFatalRuntimeError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)

  return (
    message.includes('FatalException')
    || message.includes('Database has been invalidated')
    || message.includes('database has been invalidated')
    || message.includes('Invalid Input Error: Attempting to execute an unsuccessful or closed pending query result')
  )
}

const canSplitRebuildChunk = (chunk: ReviewServingRebuildChunkManifest) => {
  return chunk.chunkStartKey < chunk.chunkEndKey && (chunk.splitDepth ?? 0) < 12
}

const articleRangeRebuildChunkPresplitInputRowLimit = 50_000
const highFanoutArticleRangeRebuildChunkPresplitRowLimit = 5_000
const summaryArticleRangeRebuildChunkPresplitRowLimit = 512
const statusArticleRangeRebuildChunkPresplitRowLimit = 512
const searchArticleRangeRebuildRuntimeRowLimit = 512
const articleRangeRebuildChunkPresplitMaxBucketCount = 16
const highFanoutArticleRangeRebuildChunkPresplitMaxBucketCount = 64
const summaryArticleRangeRebuildChunkPresplitMaxBucketCount = 512
const statusArticleRangeRebuildChunkPresplitMaxBucketCount = 512
const admittedOversizedRebuildChunkInputRowLimits: Partial<Record<ReviewServingProjectionComponent, number>> = {
  payload: 10_000,
  posting: 512,
  search: searchArticleRangeRebuildRuntimeRowLimit,
  summary: 512,
}
const splittableArticleRangeRebuildComponents: ReadonlySet<ReviewServingProjectionComponent> = new Set([
  'projectScope',
  'display',
  'payload',
  'search',
  'llmStatus',
  'humanStatus',
  'queue',
  'posting',
  'judgmentInputContent',
  'selectedImport',
  'summary',
])
const highFanoutArticleRangeRebuildComponents: ReadonlySet<ReviewServingProjectionComponent> = new Set([
  'humanStatus',
  'judgmentInputContent',
  'llmStatus',
  'payload',
  'posting',
  'search',
  'selectedImport',
  'summary',
])
const statusArticleRangeRebuildComponents: ReadonlySet<ReviewServingProjectionComponent> = new Set([
  'humanStatus',
  'llmStatus',
])
const requestlessSummaryRangeRebuildRequestPrefix = 'requestless-summary'
const requestlessBootstrapRebuildRequestPrefix = 'requestless-bootstrap'

const isRequestlessSummaryRangeRebuildChunk = (chunk: ReviewServingRebuildChunkManifest) => {
  return chunk.projectionComponent === 'summary' && chunk.requestId === null
}

const isRequestlessRebuildChunk = (chunk: ReviewServingRebuildChunkManifest) => {
  return chunk.requestId === null
}

const getRequestlessSummaryRangeRebuildRequestId = (chunk: ReviewServingRebuildChunkManifest) => {
  const digest = createHash('sha256')
    .update(
      [
        chunk.projectId ?? '',
        chunk.projectionComponent,
        chunk.projectionIdentity,
        chunk.outputBaseGeneration,
        chunk.inputWatermark,
        chunk.snapshotId ?? '',
      ].join('\0'),
    )
    .digest('hex')
    .slice(0, 24)

  return `${requestlessSummaryRangeRebuildRequestPrefix}:${digest}`
}

const getRequestlessBootstrapRebuildRequestId = (chunk: ReviewServingRebuildChunkManifest) => {
  const digest = createHash('sha256')
    .update(
      [
        chunk.projectId ?? '',
        chunk.snapshotId ?? '',
        chunk.outputBaseGeneration,
        chunk.inputWatermark,
        chunk.inputDigest,
      ].join('\0'),
    )
    .digest('hex')
    .slice(0, 24)

  return `${requestlessBootstrapRebuildRequestPrefix}:${digest}`
}

const getArticleRangeRebuildChunkPresplitRowLimit = (chunk: ReviewServingRebuildChunkManifest) => {
  if (chunk.projectionComponent === 'summary') {
    return summaryArticleRangeRebuildChunkPresplitRowLimit
  }

  if (statusArticleRangeRebuildComponents.has(chunk.projectionComponent)) {
    return statusArticleRangeRebuildChunkPresplitRowLimit
  }

  return highFanoutArticleRangeRebuildComponents.has(chunk.projectionComponent)
    ? highFanoutArticleRangeRebuildChunkPresplitRowLimit
    : articleRangeRebuildChunkPresplitInputRowLimit
}

const getPositiveFiniteNumber = (value: unknown) => {
  const numericValue =
    typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN

  return Number.isFinite(numericValue) && numericValue > 0 ? numericValue : null
}

const getArticleRangeRebuildChunkEstimatedRows = (
  chunk: Pick<ReviewServingRebuildChunkManifest, 'estimatedInputRows' | 'estimatedOutputRows'>,
) => {
  const estimates = [chunk.estimatedInputRows, chunk.estimatedOutputRows].flatMap((estimate) => {
    const numericEstimate = getPositiveFiniteNumber(estimate)

    return numericEstimate === null ? [] : [numericEstimate]
  })

  return estimates.length === 0 ? null : Math.max(...estimates)
}

const isAdmittedOversizedRebuildChunk = (chunk: ReviewServingRebuildChunkManifest) => {
  const inputRowLimit = admittedOversizedRebuildChunkInputRowLimits[chunk.projectionComponent]
  const estimatedInputRows = getPositiveFiniteNumber(chunk.estimatedInputRows)

  return chunk.requestId !== null && inputRowLimit !== undefined && estimatedInputRows !== null
    ? estimatedInputRows > inputRowLimit
    : false
}

const getArticleRangeRebuildChunkSplitBucketCount = (
  chunk: ReviewServingRebuildChunkManifest,
  input: {splitReason?: 'admitted_oversized' | 'duckdb_oom'} = {},
) => {
  const estimatedRows = getArticleRangeRebuildChunkEstimatedRows(chunk)
  const admittedOversizedInputRowLimit =
    input.splitReason === 'admitted_oversized'
      ? admittedOversizedRebuildChunkInputRowLimits[chunk.projectionComponent]
      : undefined
  const presplitRowLimit = admittedOversizedInputRowLimit ?? getArticleRangeRebuildChunkPresplitRowLimit(chunk)
  const maxBucketCount =
    chunk.projectionComponent === 'summary'
      ? summaryArticleRangeRebuildChunkPresplitMaxBucketCount
      : statusArticleRangeRebuildComponents.has(chunk.projectionComponent)
        ? statusArticleRangeRebuildChunkPresplitMaxBucketCount
        : highFanoutArticleRangeRebuildComponents.has(chunk.projectionComponent)
          ? highFanoutArticleRangeRebuildChunkPresplitMaxBucketCount
          : articleRangeRebuildChunkPresplitMaxBucketCount

  if (estimatedRows === null) {
    return 2
  }

  return Math.min(maxBucketCount, Math.max(2, Math.ceil(estimatedRows / presplitRowLimit)))
}

const uuidArticleIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

const parseUuidArticleId = (articleId: string) => {
  return uuidArticleIdPattern.test(articleId) ? BigInt(`0x${articleId.replaceAll('-', '').toLowerCase()}`) : null
}

const formatUuidArticleId = (value: bigint) => {
  const hex = value.toString(16).padStart(32, '0')

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const getUuidArticleRangeRebuildChunkSplitRanges = (
  chunk: ReviewServingRebuildChunkManifest,
  input: {splitReason?: 'admitted_oversized' | 'duckdb_oom'} = {},
): RebuildChunkSplitRangeRow[] | null => {
  const splitBucketCount = getArticleRangeRebuildChunkSplitBucketCount(chunk, input)
  const start = parseUuidArticleId(chunk.chunkStartKey)
  const end = parseUuidArticleId(chunk.chunkEndKey)

  if (start === null || end === null || start >= end) {
    return null
  }

  const span = end - start
  const bucketCount = BigInt(splitBucketCount)
  const estimatedRows = getArticleRangeRebuildChunkEstimatedRows(chunk) ?? splitBucketCount
  const ranges: RebuildChunkSplitRangeRow[] = []
  let previousEnd = start

  for (let index = 0; index < splitBucketCount; index += 1) {
    const rangeEnd = index === splitBucketCount - 1 ? end : start + (span * BigInt(index + 1)) / bucketCount

    if (rangeEnd <= previousEnd) {
      return null
    }

    ranges.push({
      articleCount: Math.ceil(estimatedRows / splitBucketCount),
      chunkEndKey: formatUuidArticleId(rangeEnd),
      chunkStartKey: formatUuidArticleId(index === 0 ? start : previousEnd + 1n),
    })
    previousEnd = rangeEnd
  }

  return ranges.length < 2 ? null : ranges
}

const getArticleRangeRebuildChunkSplitRanges = async (
  input: {
    chunk: ReviewServingRebuildChunkManifest
    projectId: string
    splitReason?: 'admitted_oversized' | 'duckdb_oom'
  },
  database: ReviewServingChunkManifestRepositoryTransaction,
) => {
  const splitBucketCount = getArticleRangeRebuildChunkSplitBucketCount(input.chunk, {splitReason: input.splitReason})
  const uuidRanges = getUuidArticleRangeRebuildChunkSplitRanges(input.chunk, {splitReason: input.splitReason})

  if (uuidRanges !== null) {
    return uuidRanges
  }

  const rows = await database.queryJson<RebuildChunkSplitRangeRow>(`
    WITH scoped_article AS (
      SELECT
        scope.article_id,
        NTILE(${splitBucketCount}) OVER (ORDER BY scope.article_id) AS split_bucket
      FROM mart.project_scope_article scope
      WHERE scope.project_id = ${getSqlLiteral(input.projectId)}
        AND ${getChunkArticleRangePredicate({alias: 'scope', chunk: input.chunk})}
    ), bucket_range AS (
      SELECT
        split_bucket,
        CAST(COUNT(*) AS INTEGER) AS article_count,
        MIN(article_id) AS scoped_start_key,
        MAX(article_id) AS scoped_end_key
      FROM scoped_article
      GROUP BY split_bucket
      HAVING COUNT(*) > 0
    ), bucket_range_with_neighbors AS (
      SELECT
        article_count,
        scoped_start_key,
        scoped_end_key,
        LAG(scoped_end_key) OVER (ORDER BY split_bucket) AS previous_scoped_end_key,
        LEAD(scoped_start_key) OVER (ORDER BY split_bucket) AS next_scoped_start_key
      FROM bucket_range
    )
    SELECT
      article_count AS articleCount,
      CASE
        WHEN previous_scoped_end_key IS NULL THEN ${getSqlLiteral(input.chunk.chunkStartKey)}
        ELSE previous_scoped_end_key || ' '
      END AS chunkStartKey,
      CASE
        WHEN next_scoped_start_key IS NULL THEN ${getSqlLiteral(input.chunk.chunkEndKey)}
        ELSE scoped_end_key
      END AS chunkEndKey
    FROM bucket_range_with_neighbors
    ORDER BY scoped_start_key
  `)

  return rows.filter((row) => {
    return row.articleCount > 0
  })
}

const getSnapshotIdPredicate = (snapshotIds: readonly string[]) => {
  return snapshotIds.length === 0
    ? 'FALSE'
    : `snapshot_id IN (${snapshotIds
        .map((snapshotId) => {
          return getSqlLiteral(snapshotId)
        })
        .join(', ')})`
}

const getSelectedImportSnapshotIdPredicate = (snapshotIds: readonly string[]) => {
  return snapshotIds.length === 0
    ? 'FALSE'
    : `selected_import_snapshot_id IN (${snapshotIds
        .map((snapshotId) => {
          return getSqlLiteral(snapshotId)
        })
        .join(', ')})`
}

const getChunkProjectorDatabase = (
  database: ReviewServingChunkManifestRepositoryDatabase | ReviewServingChunkManifestRepositoryTransaction,
): ReviewServingProjectorWorkerDatabase => {
  return {
    ...database,
    transaction:
      'transaction' in database
        ? database.transaction.bind(database)
        : async (operation) => {
            return operation(database)
          },
  } as ReviewServingProjectorWorkerDatabase
}

const getRebuildChunkSnapshots = async (
  chunk: ReviewServingRebuildChunkManifest,
  database: ReviewServingProjectorWorkerDatabase,
) => {
  const projectId = requireRebuildChunkProjectId(chunk)
  const snapshots = await requireSnapshotContexts(
    {
      component: chunk.projectionComponent,
      projectId,
      projectionIdentity: chunk.projectionIdentity,
      reviewConfigHash: null,
    },
    database,
  )
  const matchingSnapshots = snapshots.filter((snapshot) => {
    return getSnapshotComponentBaseGeneration(snapshot, chunk.projectionComponent) === chunk.outputBaseGeneration
  })

  if (matchingSnapshots.length === 0) {
    throw new Error(
      `cannot run ${chunk.projectionComponent} rebuild chunk without snapshot state for base generation ${chunk.outputBaseGeneration}`,
    )
  }

  return matchingSnapshots
}

const getRebuildSnapshotIds = (snapshots: readonly ReviewServingSnapshotContext[]) => {
  return snapshots.map((snapshot) => {
    return snapshot.snapshotId
  })
}

const requireRebuildChunkProjectionManifest = async (
  chunk: ReviewServingRebuildChunkManifest,
  database: ReviewServingProjectorWorkerDatabase,
) => {
  const manifest = await getReviewServingProjectionIdentityManifest(
    {
      projectId: requireRebuildChunkProjectId(chunk),
      projectionComponent: chunk.projectionComponent,
      projectionIdentity: chunk.projectionIdentity,
    },
    database,
  )

  if (manifest === null) {
    throw new Error(`cannot run ${chunk.projectionComponent} rebuild chunk without an identity manifest`)
  }

  return manifest
}

const getCheapRebuildChunkOutputChecksumSelect = () => {
  return `
      CAST(COUNT(*) AS INTEGER) AS actualCount,
      sha256('cheap-count:' || CAST(COUNT(*) AS VARCHAR)) AS actualChecksum
  `
}

const shouldUseStrictRebuildValidationWithoutExpectedChecksum = () => {
  return process.env.FORSKA_REVIEW_SERVING_REBUILD_STRICT_VALIDATION === 'true'
}

const getRebuildChunkOutputValidation = async (
  input: RebuildChunkOutputValidationInput,
): Promise<ReviewServingRebuildChunkValidationResult> => {
  if (input.chunk.checksum !== null) {
    const checksum = await input.getChecksum()

    return {
      actualChecksum: checksum.actualChecksum,
      actualCount: checksum.actualCount,
      actualOutputBytes: checksum.actualOutputBytes,
      actualPayloadBytes: checksum.actualPayloadBytes,
      diagnosticsJson: {validationMode: 'strict-checksum'},
      expectedChecksum: input.chunk.checksum,
    }
  }

  if (shouldUseStrictRebuildValidationWithoutExpectedChecksum()) {
    const checksum = await input.getChecksum()

    return {
      actualChecksum: checksum.actualChecksum,
      actualCount: checksum.actualCount,
      actualOutputBytes: checksum.actualOutputBytes,
      actualPayloadBytes: checksum.actualPayloadBytes,
      diagnosticsJson: {validationMode: 'debug-strict-checksum'},
      expectedChecksum: checksum.actualChecksum,
    }
  }

  const count = await input.getCount()

  return {
    actualChecksum: count.actualChecksum,
    actualCount: count.actualCount,
    actualOutputBytes: count.actualOutputBytes,
    actualPayloadBytes: count.actualPayloadBytes,
    diagnosticsJson: {validationMode: 'cheap-count'},
    expectedChecksum: count.actualChecksum,
  }
}

const getDisplayRebuildChunkOutputChecksum = async (
  input: {chunk: ReviewServingRebuildChunkManifest; snapshotIds: readonly string[]},
  database: ReviewServingChunkManifestRepositoryTransaction,
) => {
  const projectId = requireRebuildChunkProjectId(input.chunk)
  const [row] = await database.queryJson<RebuildChunkOutputChecksumRow>(`
    SELECT
      CAST(COUNT(*) AS INTEGER) AS actualCount,
      sha256(COALESCE(string_agg(
        CAST(snapshot_id AS VARCHAR) || ':' ||
        CAST(list_mode_key AS VARCHAR) || ':' ||
        CAST(article_id AS VARCHAR) || ':' ||
        COALESCE(CAST(sort_key AS VARCHAR), '') || ':' ||
        COALESCE(article_title, ''),
        '|' ORDER BY snapshot_id, list_mode_key, article_id
      ), '')) AS actualChecksum
    FROM mart.review_article_serving_v4 serving
    WHERE project_id = ${getSqlLiteral(projectId)}
      AND display_identity = ${getSqlLiteral(input.chunk.projectionIdentity)}
      AND base_generation = ${getSqlLiteral(input.chunk.outputBaseGeneration)}
      AND ${getSnapshotIdPredicate(input.snapshotIds)}
      AND ${getChunkArticleRangePredicate({alias: 'serving', chunk: input.chunk})}
  `)

  return row ?? {actualChecksum: '', actualCount: 0}
}

const getDisplayRebuildChunkOutputCount = async (
  input: {chunk: ReviewServingRebuildChunkManifest; snapshotIds: readonly string[]},
  database: ReviewServingChunkManifestRepositoryTransaction,
) => {
  const projectId = requireRebuildChunkProjectId(input.chunk)
  const [row] = await database.queryJson<RebuildChunkOutputChecksumRow>(`
    SELECT
      ${getCheapRebuildChunkOutputChecksumSelect()}
    FROM mart.review_article_serving_v4 serving
    WHERE project_id = ${getSqlLiteral(projectId)}
      AND display_identity = ${getSqlLiteral(input.chunk.projectionIdentity)}
      AND base_generation = ${getSqlLiteral(input.chunk.outputBaseGeneration)}
      AND ${getSnapshotIdPredicate(input.snapshotIds)}
      AND ${getChunkArticleRangePredicate({alias: 'serving', chunk: input.chunk})}
  `)

  return row ?? {actualChecksum: '', actualCount: 0}
}

const getPayloadRebuildChunkOutputChecksum = async (
  input: {chunk: ReviewServingRebuildChunkManifest; snapshotIds: readonly string[]},
  database: ReviewServingChunkManifestRepositoryTransaction,
) => {
  const projectId = requireRebuildChunkProjectId(input.chunk)
  const [row] = await database.queryJson<RebuildChunkOutputChecksumRow>(`
    SELECT
      CAST(COUNT(*) AS INTEGER) AS actualCount,
      sha256(COALESCE(string_agg(
        CAST(snapshot_id AS VARCHAR) || ':' ||
        CAST(display_identity AS VARCHAR) || ':' ||
        CAST(article_id AS VARCHAR) || ':' ||
        COALESCE(CAST(article_created_at AS VARCHAR), '') || ':' ||
        COALESCE(CAST(payload_bytes AS VARCHAR), ''),
        '|' ORDER BY snapshot_id, display_identity, article_id
      ), '')) AS actualChecksum
    FROM mart.review_article_serving_payload_v4 payload
    WHERE project_id = ${getSqlLiteral(projectId)}
      AND payload_identity = ${getSqlLiteral(input.chunk.projectionIdentity)}
      AND ${getSnapshotIdPredicate(input.snapshotIds)}
      AND ${getChunkArticleRangePredicate({alias: 'payload', chunk: input.chunk})}
  `)

  return row ?? {actualChecksum: '', actualCount: 0}
}

const getPayloadRebuildChunkOutputCount = async (
  input: {chunk: ReviewServingRebuildChunkManifest; snapshotIds: readonly string[]},
  database: ReviewServingChunkManifestRepositoryTransaction,
) => {
  const projectId = requireRebuildChunkProjectId(input.chunk)
  const [row] = await database.queryJson<RebuildChunkOutputChecksumRow>(`
    SELECT
      ${getCheapRebuildChunkOutputChecksumSelect()},
      CAST(COALESCE(SUM(payload_bytes), 0) AS INTEGER) AS actualPayloadBytes
    FROM mart.review_article_serving_payload_v4 payload
    WHERE project_id = ${getSqlLiteral(projectId)}
      AND payload_identity = ${getSqlLiteral(input.chunk.projectionIdentity)}
      AND ${getSnapshotIdPredicate(input.snapshotIds)}
      AND ${getChunkArticleRangePredicate({alias: 'payload', chunk: input.chunk})}
  `)

  return row ?? {actualChecksum: '', actualCount: 0}
}

const getSearchRebuildChunkOutputChecksum = async (
  input: {chunk: ReviewServingRebuildChunkManifest; snapshotIds: readonly string[]},
  database: ReviewServingChunkManifestRepositoryTransaction,
) => {
  const projectId = requireRebuildChunkProjectId(input.chunk)
  const [row] = await database.queryJson<RebuildChunkOutputChecksumRow>(`
    SELECT
      CAST(COUNT(*) AS INTEGER) AS actualCount,
      sha256(COALESCE(string_agg(
        CAST(snapshot_id AS VARCHAR) || ':' ||
        CAST(project_scope_identity AS VARCHAR) || ':' ||
        CAST(article_id AS VARCHAR) || ':' ||
        CAST(token AS VARCHAR) || ':' ||
        COALESCE(title_prefix, ''),
        '|' ORDER BY snapshot_id, project_scope_identity, article_id, token
      ), '')) AS actualChecksum
    FROM mart.review_title_search_serving_v4 search
    WHERE project_id = ${getSqlLiteral(projectId)}
      AND search_identity = ${getSqlLiteral(input.chunk.projectionIdentity)}
      AND ${getSnapshotIdPredicate(input.snapshotIds)}
      AND ${getChunkArticleRangePredicate({alias: 'search', chunk: input.chunk})}
  `)

  return row ?? {actualChecksum: '', actualCount: 0}
}

const getSearchRebuildChunkOutputCount = async (
  input: {chunk: ReviewServingRebuildChunkManifest; snapshotIds: readonly string[]},
  database: ReviewServingChunkManifestRepositoryTransaction,
) => {
  const projectId = requireRebuildChunkProjectId(input.chunk)
  const [row] = await database.queryJson<RebuildChunkOutputChecksumRow>(`
    SELECT
      ${getCheapRebuildChunkOutputChecksumSelect()}
    FROM mart.review_title_search_serving_v4 search
    WHERE project_id = ${getSqlLiteral(projectId)}
      AND search_identity = ${getSqlLiteral(input.chunk.projectionIdentity)}
      AND ${getSnapshotIdPredicate(input.snapshotIds)}
      AND ${getChunkArticleRangePredicate({alias: 'search', chunk: input.chunk})}
  `)

  return row ?? {actualChecksum: '', actualCount: 0}
}

const getLlmStatusRebuildChunkOutputChecksum = async (
  input: {chunk: ReviewServingRebuildChunkManifest; snapshotIds: readonly string[]},
  database: ReviewServingChunkManifestRepositoryTransaction,
) => {
  const projectId = requireRebuildChunkProjectId(input.chunk)
  const [row] = await database.queryJson<RebuildChunkOutputChecksumRow>(`
    SELECT
      CAST(COUNT(*) AS INTEGER) AS actualCount,
      sha256(COALESCE(string_agg(
        CAST(snapshot_id AS VARCHAR) || ':' ||
        CAST(review_config_hash AS VARCHAR) || ':' ||
        CAST(list_mode_key AS VARCHAR) || ':' ||
        CAST(article_id AS VARCHAR) || ':' ||
        COALESCE(CAST(enabled_prompt_count AS VARCHAR), '') || ':' ||
        COALESCE(CAST(llm_judged_prompt_count AS VARCHAR), '') || ':' ||
        COALESCE(llm_status_key, ''),
        '|' ORDER BY snapshot_id, review_config_hash, list_mode_key, article_id
      ), '')) AS actualChecksum
    FROM mart.review_article_serving_v4 serving
    WHERE project_id = ${getSqlLiteral(projectId)}
      AND llm_status_identity = ${getSqlLiteral(input.chunk.projectionIdentity)}
      AND base_generation = ${getSqlLiteral(input.chunk.outputBaseGeneration)}
      AND ${getSnapshotIdPredicate(input.snapshotIds)}
      AND ${getChunkArticleRangePredicate({alias: 'serving', chunk: input.chunk})}
  `)

  return row ?? {actualChecksum: '', actualCount: 0}
}

const getLlmStatusRebuildChunkOutputCount = async (
  input: {chunk: ReviewServingRebuildChunkManifest; snapshotIds: readonly string[]},
  database: ReviewServingChunkManifestRepositoryTransaction,
) => {
  const projectId = requireRebuildChunkProjectId(input.chunk)
  const [row] = await database.queryJson<RebuildChunkOutputChecksumRow>(`
    SELECT
      ${getCheapRebuildChunkOutputChecksumSelect()}
    FROM mart.review_article_serving_v4 serving
    WHERE project_id = ${getSqlLiteral(projectId)}
      AND llm_status_identity = ${getSqlLiteral(input.chunk.projectionIdentity)}
      AND base_generation = ${getSqlLiteral(input.chunk.outputBaseGeneration)}
      AND ${getSnapshotIdPredicate(input.snapshotIds)}
      AND ${getChunkArticleRangePredicate({alias: 'serving', chunk: input.chunk})}
  `)

  return row ?? {actualChecksum: '', actualCount: 0}
}

const getHumanStatusRebuildChunkOutputChecksum = async (
  input: {chunk: ReviewServingRebuildChunkManifest; snapshotIds: readonly string[]},
  database: ReviewServingChunkManifestRepositoryTransaction,
) => {
  const projectId = requireRebuildChunkProjectId(input.chunk)
  const [row] = await database.queryJson<RebuildChunkOutputChecksumRow>(`
    SELECT
      CAST(COUNT(*) AS INTEGER) AS actualCount,
      sha256(COALESCE(string_agg(
        CAST(snapshot_id AS VARCHAR) || ':' ||
        CAST(review_config_hash AS VARCHAR) || ':' ||
        CAST(list_mode_key AS VARCHAR) || ':' ||
        CAST(article_id AS VARCHAR) || ':' ||
        COALESCE(CAST(human_answered_prompt_count AS VARCHAR), '') || ':' ||
        COALESCE(human_status_key, ''),
        '|' ORDER BY snapshot_id, review_config_hash, list_mode_key, article_id
      ), '')) AS actualChecksum
    FROM mart.review_article_serving_v4 serving
    WHERE project_id = ${getSqlLiteral(projectId)}
      AND human_status_identity = ${getSqlLiteral(input.chunk.projectionIdentity)}
      AND base_generation = ${getSqlLiteral(input.chunk.outputBaseGeneration)}
      AND ${getSnapshotIdPredicate(input.snapshotIds)}
      AND ${getChunkArticleRangePredicate({alias: 'serving', chunk: input.chunk})}
  `)

  return row ?? {actualChecksum: '', actualCount: 0}
}

const getHumanStatusRebuildChunkOutputCount = async (
  input: {chunk: ReviewServingRebuildChunkManifest; snapshotIds: readonly string[]},
  database: ReviewServingChunkManifestRepositoryTransaction,
) => {
  const projectId = requireRebuildChunkProjectId(input.chunk)
  const [row] = await database.queryJson<RebuildChunkOutputChecksumRow>(`
    SELECT
      ${getCheapRebuildChunkOutputChecksumSelect()}
    FROM mart.review_article_serving_v4 serving
    WHERE project_id = ${getSqlLiteral(projectId)}
      AND human_status_identity = ${getSqlLiteral(input.chunk.projectionIdentity)}
      AND base_generation = ${getSqlLiteral(input.chunk.outputBaseGeneration)}
      AND ${getSnapshotIdPredicate(input.snapshotIds)}
      AND ${getChunkArticleRangePredicate({alias: 'serving', chunk: input.chunk})}
  `)

  return row ?? {actualChecksum: '', actualCount: 0}
}

const getQueueRebuildChunkOutputChecksum = async (
  input: {chunk: ReviewServingRebuildChunkManifest; snapshotIds: readonly string[]},
  database: ReviewServingChunkManifestRepositoryTransaction,
) => {
  const projectId = requireRebuildChunkProjectId(input.chunk)
  const [row] = await database.queryJson<RebuildChunkOutputChecksumRow>(`
    SELECT
      CAST(COUNT(*) AS INTEGER) AS actualCount,
      sha256(COALESCE(string_agg(
        CAST(snapshot_id AS VARCHAR) || ':' ||
        CAST(review_config_hash AS VARCHAR) || ':' ||
        CAST(queue_kind AS VARCHAR) || ':' ||
        CAST(priority_bucket AS VARCHAR) || ':' ||
        CAST(article_id AS VARCHAR) || ':' ||
        COALESCE(CAST(prompt_id AS VARCHAR), '') || ':' ||
        CAST(queue_identity AS VARCHAR),
        '|' ORDER BY snapshot_id, review_config_hash, queue_kind, priority_bucket, article_id, prompt_id
      ), '')) AS actualChecksum
    FROM mart.review_unassessed_queue_serving_v4 serving
    WHERE project_id = ${getSqlLiteral(projectId)}
      AND ${getSnapshotIdPredicate(input.snapshotIds)}
      AND ${getChunkArticleRangePredicate({alias: 'serving', chunk: input.chunk})}
  `)

  return row ?? {actualChecksum: '', actualCount: 0}
}

const getQueueRebuildChunkOutputCount = async (
  input: {chunk: ReviewServingRebuildChunkManifest; snapshotIds: readonly string[]},
  database: ReviewServingChunkManifestRepositoryTransaction,
) => {
  const projectId = requireRebuildChunkProjectId(input.chunk)
  const [row] = await database.queryJson<RebuildChunkOutputChecksumRow>(`
    SELECT
      ${getCheapRebuildChunkOutputChecksumSelect()}
    FROM mart.review_unassessed_queue_serving_v4 serving
    WHERE project_id = ${getSqlLiteral(projectId)}
      AND ${getSnapshotIdPredicate(input.snapshotIds)}
      AND ${getChunkArticleRangePredicate({alias: 'serving', chunk: input.chunk})}
  `)

  return row ?? {actualChecksum: '', actualCount: 0}
}

const getPostingRebuildChunkOutputChecksum = async (
  input: {chunk: ReviewServingRebuildChunkManifest; snapshotIds: readonly string[]},
  database: ReviewServingChunkManifestRepositoryTransaction,
) => {
  const projectId = requireRebuildChunkProjectId(input.chunk)
  const [row] = await database.queryJson<RebuildChunkOutputChecksumRow>(`
    SELECT
      CAST(COUNT(*) AS INTEGER) AS actualCount,
      sha256(COALESCE(string_agg(
        CAST(snapshot_id AS VARCHAR) || ':' ||
        CAST(review_config_hash AS VARCHAR) || ':' ||
        CAST(list_mode_key AS VARCHAR) || ':' ||
        CAST(filter_kind AS VARCHAR) || ':' ||
        CAST(filter_value AS VARCHAR) || ':' ||
        CAST(article_id AS VARCHAR) || ':' ||
        COALESCE(CAST(sort_key AS VARCHAR), ''),
        '|' ORDER BY snapshot_id, review_config_hash, list_mode_key, filter_kind, filter_value, article_id
      ), '')) AS actualChecksum
    FROM mart.review_article_filter_posting_serving_v4 serving
    WHERE project_id = ${getSqlLiteral(projectId)}
      AND ${getSnapshotIdPredicate(input.snapshotIds)}
      AND ${getChunkArticleRangePredicate({alias: 'serving', chunk: input.chunk})}
  `)

  return row ?? {actualChecksum: '', actualCount: 0}
}

const getPostingRebuildChunkOutputCount = async (
  input: {chunk: ReviewServingRebuildChunkManifest; snapshotIds: readonly string[]},
  database: ReviewServingChunkManifestRepositoryTransaction,
) => {
  const projectId = requireRebuildChunkProjectId(input.chunk)
  const [row] = await database.queryJson<RebuildChunkOutputChecksumRow>(`
    SELECT
      ${getCheapRebuildChunkOutputChecksumSelect()}
    FROM mart.review_article_filter_posting_serving_v4 serving
    WHERE project_id = ${getSqlLiteral(projectId)}
      AND ${getSnapshotIdPredicate(input.snapshotIds)}
      AND ${getChunkArticleRangePredicate({alias: 'serving', chunk: input.chunk})}
  `)

  return row ?? {actualChecksum: '', actualCount: 0}
}

const getSummaryRebuildChunkOutputChecksum = async (
  input: {chunk: ReviewServingRebuildChunkManifest; snapshotIds: readonly string[]},
  database: ReviewServingChunkManifestRepositoryTransaction,
) => {
  const projectId = requireRebuildChunkProjectId(input.chunk)
  const [row] = await database.queryJson<RebuildChunkOutputChecksumRow>(`
    WITH output_row(row_key, row_value) AS (
      SELECT
        'count:' || CAST(snapshot_id AS VARCHAR) || ':' || CAST(list_mode_key AS VARCHAR) || ':' || CAST(count_kind AS VARCHAR) || ':' || CAST(filter_key AS VARCHAR) || ':' || CAST(summary_definition_version AS VARCHAR) AS row_key,
        COALESCE(CAST(count_value AS VARCHAR), '') || ':' || COALESCE(availability, '')
      FROM mart.review_article_count_serving_v4
      WHERE project_id = ${getSqlLiteral(projectId)}
        AND ${getSnapshotIdPredicate(input.snapshotIds)}
      UNION ALL
      SELECT
        'facet:' || CAST(snapshot_id AS VARCHAR) || ':' || CAST(summary_identity AS VARCHAR) || ':' || CAST(facet_kind AS VARCHAR) || ':' || CAST(facet_key AS VARCHAR) || ':' || CAST(facet_value AS VARCHAR) || ':' || CAST(summary_definition_version AS VARCHAR) AS row_key,
        COALESCE(CAST(count_value AS VARCHAR), '') || ':' || COALESCE(availability, '')
      FROM mart.review_filter_facet_serving_v4
      WHERE project_id = ${getSqlLiteral(projectId)}
        AND ${getSnapshotIdPredicate(input.snapshotIds)}
      UNION ALL
      SELECT
        'option:' || CAST(snapshot_id AS VARCHAR) || ':' || CAST(search_identity AS VARCHAR) || ':' || CAST(filter_option_identity AS VARCHAR) || ':' || CAST(filter_kind AS VARCHAR) || ':' || CAST(facet_key AS VARCHAR) || ':' || CAST(option_value_key AS VARCHAR) AS row_key,
        COALESCE(CAST(count_value AS VARCHAR), '') || ':' || COALESCE(CAST(numeric_min AS VARCHAR), '') || ':' || COALESCE(CAST(numeric_max AS VARCHAR), '') || ':' || COALESCE(CAST(facet_value AS VARCHAR), '')
      FROM mart.review_filter_option_serving_v4
      WHERE project_id = ${getSqlLiteral(projectId)}
        AND ${getSnapshotIdPredicate(input.snapshotIds)}
    )
    SELECT
      CAST(COUNT(*) AS INTEGER) AS actualCount,
      sha256(COALESCE(string_agg(row_key || ':' || row_value, '|' ORDER BY row_key), '')) AS actualChecksum
    FROM output_row
  `)

  return row ?? {actualChecksum: '', actualCount: 0}
}

const getSummaryRebuildChunkOutputCount = async (
  input: {chunk: ReviewServingRebuildChunkManifest; snapshotIds: readonly string[]},
  database: ReviewServingChunkManifestRepositoryTransaction,
) => {
  const projectId = requireRebuildChunkProjectId(input.chunk)
  const [row] = await database.queryJson<RebuildChunkOutputChecksumRow>(`
    WITH output_row(row_key) AS (
      SELECT 'count'
      FROM mart.review_article_count_serving_v4
      WHERE project_id = ${getSqlLiteral(projectId)}
        AND ${getSnapshotIdPredicate(input.snapshotIds)}
      UNION ALL
      SELECT 'facet'
      FROM mart.review_filter_facet_serving_v4
      WHERE project_id = ${getSqlLiteral(projectId)}
        AND ${getSnapshotIdPredicate(input.snapshotIds)}
      UNION ALL
      SELECT 'option'
      FROM mart.review_filter_option_serving_v4
      WHERE project_id = ${getSqlLiteral(projectId)}
        AND ${getSnapshotIdPredicate(input.snapshotIds)}
      UNION ALL
      SELECT 'partial'
      FROM mart.review_article_summary_rebuild_partial_v4
      WHERE project_id = ${getSqlLiteral(projectId)}
        AND request_id = ${getSqlLiteral(input.chunk.requestId)}
        AND chunk_id = ${getSqlLiteral(input.chunk.chunkId)}
        AND ${getSnapshotIdPredicate(input.snapshotIds)}
    )
    SELECT
      ${getCheapRebuildChunkOutputChecksumSelect()}
    FROM output_row
  `)

  return row ?? {actualChecksum: '', actualCount: 0}
}

const getJudgmentInputContentRebuildChunkOutputChecksum = async (
  input: {chunk: ReviewServingRebuildChunkManifest; snapshotIds: readonly string[]},
  database: ReviewServingChunkManifestRepositoryTransaction,
) => {
  const projectId = requireRebuildChunkProjectId(input.chunk)
  const [row] = await database.queryJson<RebuildChunkOutputChecksumRow>(`
    SELECT
      CAST(COUNT(*) AS INTEGER) AS actualCount,
      sha256(COALESCE(string_agg(
        CAST(snapshot_id AS VARCHAR) || ':' ||
        CAST(review_config_hash AS VARCHAR) || ':' ||
        CAST(list_mode_key AS VARCHAR) || ':' ||
        CAST(payload_kind AS VARCHAR) || ':' ||
        CAST(article_id AS VARCHAR) || ':' ||
        CAST(prompt_id AS VARCHAR) || ':' ||
        COALESCE(CAST(judgment_id AS VARCHAR), '') || ':' ||
        COALESCE(CAST(placeholder_kind AS VARCHAR), '') || ':' ||
        COALESCE(CAST(answered_original AS VARCHAR), '') || ':' ||
        COALESCE(CAST(answered_original_as_array AS VARCHAR), '') || ':' ||
        COALESCE(CAST(judgment_payload_json AS VARCHAR), ''),
        '|' ORDER BY snapshot_id, review_config_hash, list_mode_key, payload_kind, article_id, prompt_id
      ), '')) AS actualChecksum
    FROM mart.review_article_judgment_detail_serving_v4 detail
    WHERE project_id = ${getSqlLiteral(projectId)}
      AND ${getSnapshotIdPredicate(input.snapshotIds)}
      AND ${getChunkArticleRangePredicate({alias: 'detail', chunk: input.chunk})}
  `)

  return row ?? {actualChecksum: '', actualCount: 0}
}

const getJudgmentInputContentRebuildChunkOutputCount = async (
  input: {chunk: ReviewServingRebuildChunkManifest; snapshotIds: readonly string[]},
  database: ReviewServingChunkManifestRepositoryTransaction,
) => {
  const projectId = requireRebuildChunkProjectId(input.chunk)
  const [row] = await database.queryJson<RebuildChunkOutputChecksumRow>(`
    SELECT
      ${getCheapRebuildChunkOutputChecksumSelect()}
    FROM mart.review_article_judgment_detail_serving_v4 detail
    WHERE project_id = ${getSqlLiteral(projectId)}
      AND ${getSnapshotIdPredicate(input.snapshotIds)}
      AND ${getChunkArticleRangePredicate({alias: 'detail', chunk: input.chunk})}
  `)

  return row ?? {actualChecksum: '', actualCount: 0}
}

const runValidatedRebuildChunkOutput = async (
  input: {
    chunk: ReviewServingRebuildChunkManifest
    leaseOwner: string
    validateOutput: (
      tx: ReviewServingChunkManifestRepositoryTransaction,
    ) => Promise<{actualChecksum: string; actualCount?: number; expectedChecksum: string; expectedCount?: number}>
    writeMode?: 'atomic' | 'idempotent-output'
    writeOutput: (tx: ReviewServingChunkManifestRepositoryTransaction) => Promise<unknown>
  },
  database: ReviewServingChunkManifestRepositoryDatabase,
) => {
  const completedChunk = await writeReviewServingRebuildChunkOutput(
    {
      ...input.chunk,
      leaseOwner: input.leaseOwner,
      validateOutput: input.validateOutput,
      writeMode: input.writeMode,
      writeOutput: input.writeOutput,
    },
    database,
  )

  if (completedChunk === null) {
    throw new Error(`review serving rebuild chunk ${input.chunk.chunkId} is no longer claimed by ${input.leaseOwner}`)
  }

  return {status: 'completed' as const}
}

const runDisplayRebuildChunk = async (
  input: {chunk: ReviewServingRebuildChunkManifest; leaseOwner: string},
  database: ReviewServingChunkManifestRepositoryDatabase & ReviewServingProjectorWorkerDatabase,
) => {
  const projectId = requireRebuildChunkProjectId(input.chunk)
  const snapshots = await getRebuildChunkSnapshots(input.chunk, database)
  const snapshotIds = snapshots.map((snapshot) => {
    return snapshot.snapshotId
  })
  const completedChunk = await writeReviewServingRebuildChunkOutput(
    {
      ...input.chunk,
      leaseOwner: input.leaseOwner,
      writeMode: 'idempotent-output',
      validateOutput: async (tx) => {
        return getRebuildChunkOutputValidation({
          chunk: input.chunk,
          getChecksum: () => {
            return getDisplayRebuildChunkOutputChecksum({chunk: input.chunk, snapshotIds}, tx)
          },
          getCount: () => {
            return getDisplayRebuildChunkOutputCount({chunk: input.chunk, snapshotIds}, tx)
          },
        })
      },
      writeOutput: async (tx) => {
        const chunkDatabase = getChunkProjectorDatabase(tx)

        const snapshotDiagnostics = await snapshots.reduce<Promise<unknown[]>>(async (previous, snapshot) => {
          const diagnostics = await previous
          const result = await projectReviewServingDisplayBaseRows(
            {
              baseGeneration: input.chunk.outputBaseGeneration,
              chunkEndArticleId: input.chunk.chunkEndKey,
              chunkStartArticleId: input.chunk.chunkStartKey,
              displayIdentity: input.chunk.projectionIdentity,
              humanStatusIdentity: requireSnapshotComponentIdentity(snapshot, 'humanStatus'),
              listModeKeys: reviewServingListModes,
              llmStatusIdentity: requireSnapshotComponentIdentity(snapshot, 'llmStatus'),
              payloadIdentity: requireSnapshotComponentIdentity(snapshot, 'payload'),
              postingIdentity: requireSnapshotComponentIdentity(snapshot, 'posting'),
              projectId,
              projectScopeIdentity: requireSnapshotComponentIdentity(snapshot, 'projectScope'),
              reviewConfigHash: requireReviewConfigHash(snapshot),
              selectedImportIdentity: requireSnapshotComponentIdentity(snapshot, 'selectedImport'),
              selectedImportSnapshotId: requireSelectedImportSnapshotId(snapshot),
              snapshotId: snapshot.snapshotId,
              summaryIdentity: requireSnapshotComponentIdentity(snapshot, 'summary'),
            },
            chunkDatabase,
          )

          return [...diagnostics, {snapshotId: snapshot.snapshotId, ...getProjectorResultDiagnosticsJson(result)}]
        }, Promise.resolve([]))

        return {diagnosticsJson: {displayProjectorSnapshots: snapshotDiagnostics}}
      },
    },
    database,
  )

  if (completedChunk === null) {
    throw new Error(`review serving rebuild chunk ${input.chunk.chunkId} is no longer claimed by ${input.leaseOwner}`)
  }

  return {status: 'completed' as const}
}

const runPayloadRebuildChunk = async (
  input: {chunk: ReviewServingRebuildChunkManifest; leaseOwner: string},
  database: ReviewServingChunkManifestRepositoryDatabase & ReviewServingProjectorWorkerDatabase,
) => {
  const projectId = requireRebuildChunkProjectId(input.chunk)
  const snapshots = await getRebuildChunkSnapshots(input.chunk, database)
  const snapshotIds = snapshots.map((snapshot) => {
    return snapshot.snapshotId
  })
  const completedChunk = await writeReviewServingRebuildChunkOutput(
    {
      ...input.chunk,
      leaseOwner: input.leaseOwner,
      writeMode: 'idempotent-output',
      validateOutput: async (tx) => {
        return getRebuildChunkOutputValidation({
          chunk: input.chunk,
          getChecksum: () => {
            return getPayloadRebuildChunkOutputChecksum({chunk: input.chunk, snapshotIds}, tx)
          },
          getCount: () => {
            return getPayloadRebuildChunkOutputCount({chunk: input.chunk, snapshotIds}, tx)
          },
        })
      },
      writeOutput: async (tx) => {
        const chunkDatabase = getChunkProjectorDatabase(tx)

        const snapshotDiagnostics = await snapshots.reduce<Promise<unknown[]>>(async (previous, snapshot) => {
          const diagnostics = await previous
          const result = await projectReviewServingPayloadRanges(
            {
              ranges: [
                {
                  baseGeneration: input.chunk.outputBaseGeneration,
                  chunkEndArticleId: input.chunk.chunkEndKey,
                  chunkStartArticleId: input.chunk.chunkStartKey,
                  displayIdentity: requireSnapshotComponentIdentity(snapshot, 'display'),
                  payloadIdentity: input.chunk.projectionIdentity,
                  projectId,
                  selectedImportSnapshotId: requireSelectedImportSnapshotId(snapshot),
                  snapshotId: snapshot.snapshotId,
                },
              ],
            },
            chunkDatabase,
          )

          return [...diagnostics, {snapshotId: snapshot.snapshotId, ...getProjectorResultDiagnosticsJson(result)}]
        }, Promise.resolve([]))

        return {diagnosticsJson: {payloadProjectorSnapshots: snapshotDiagnostics}}
      },
    },
    database,
  )

  if (completedChunk === null) {
    throw new Error(`review serving rebuild chunk ${input.chunk.chunkId} is no longer claimed by ${input.leaseOwner}`)
  }

  return {status: 'completed' as const}
}

const runSearchRebuildChunk = async (
  input: {chunk: ReviewServingRebuildChunkManifest; leaseOwner: string},
  database: ReviewServingChunkManifestRepositoryDatabase & ReviewServingProjectorWorkerDatabase,
) => {
  const projectId = requireRebuildChunkProjectId(input.chunk)
  const snapshots = await getRebuildChunkSnapshots(input.chunk, database)
  const snapshotIds = snapshots.map((snapshot) => {
    return snapshot.snapshotId
  })
  const completedChunk = await writeReviewServingRebuildChunkOutput(
    {
      ...input.chunk,
      leaseOwner: input.leaseOwner,
      writeMode: 'idempotent-output',
      validateOutput: async (tx) => {
        return getRebuildChunkOutputValidation({
          chunk: input.chunk,
          getChecksum: () => {
            return getSearchRebuildChunkOutputChecksum({chunk: input.chunk, snapshotIds}, tx)
          },
          getCount: () => {
            return getSearchRebuildChunkOutputCount({chunk: input.chunk, snapshotIds}, tx)
          },
        })
      },
      writeOutput: async (tx) => {
        const chunkDatabase = getChunkProjectorDatabase(tx)

        const snapshotDiagnostics = await snapshots.reduce<Promise<unknown[]>>(async (previous, snapshot) => {
          const diagnostics = await previous
          const result = await projectReviewServingTitleSearchRebuildRows(
            {
              baseGeneration: input.chunk.outputBaseGeneration,
              chunkEndArticleId: input.chunk.chunkEndKey,
              chunkStartArticleId: input.chunk.chunkStartKey,
              projectId,
              projectScopeIdentity: requireSnapshotComponentIdentity(snapshot, 'projectScope'),
              searchIdentity: input.chunk.projectionIdentity,
              selectedImportSnapshotId: requireSelectedImportSnapshotId(snapshot),
              snapshotId: snapshot.snapshotId,
            },
            chunkDatabase,
          )

          return [...diagnostics, {snapshotId: snapshot.snapshotId, ...getProjectorResultDiagnosticsJson(result)}]
        }, Promise.resolve([]))

        return {diagnosticsJson: {titleSearchProjectorSnapshots: snapshotDiagnostics}}
      },
    },
    database,
  )

  if (completedChunk === null) {
    throw new Error(`review serving rebuild chunk ${input.chunk.chunkId} is no longer claimed by ${input.leaseOwner}`)
  }

  return {status: 'completed' as const}
}

const runLlmStatusRebuildChunk = async (
  input: {chunk: ReviewServingRebuildChunkManifest; leaseOwner: string},
  database: ReviewServingChunkManifestRepositoryDatabase & ReviewServingProjectorWorkerDatabase,
) => {
  const projectId = requireRebuildChunkProjectId(input.chunk)
  const manifest = await requireRebuildChunkProjectionManifest(input.chunk, database)
  const snapshots = await getRebuildChunkSnapshots(input.chunk, database)
  const snapshotIds = getRebuildSnapshotIds(snapshots)

  return runValidatedRebuildChunkOutput(
    {
      ...input,
      writeMode: 'idempotent-output',
      validateOutput: async (tx) => {
        return getRebuildChunkOutputValidation({
          chunk: input.chunk,
          getChecksum: () => {
            return getLlmStatusRebuildChunkOutputChecksum({chunk: input.chunk, snapshotIds}, tx)
          },
          getCount: () => {
            return getLlmStatusRebuildChunkOutputCount({chunk: input.chunk, snapshotIds}, tx)
          },
        })
      },
      writeOutput: async (tx) => {
        const result = await projectReviewServingLlmStatusPatches(
          {
            baseGeneration: input.chunk.outputBaseGeneration,
            chunkEndArticleId: input.chunk.chunkEndKey,
            chunkStartArticleId: input.chunk.chunkStartKey,
            claims: [],
            definitionVersion: manifest.definitionVersion,
            listModeKeys: defaultReviewServingLlmListModeKeys,
            projectId,
            projectionIdentity: input.chunk.projectionIdentity,
          },
          getChunkProjectorDatabase(tx),
        )

        return {diagnosticsJson: getProjectorResultDiagnosticsJson(result)}
      },
    },
    database,
  )
}

const runHumanStatusRebuildChunk = async (
  input: {chunk: ReviewServingRebuildChunkManifest; leaseOwner: string},
  database: ReviewServingChunkManifestRepositoryDatabase & ReviewServingProjectorWorkerDatabase,
) => {
  const projectId = requireRebuildChunkProjectId(input.chunk)
  const manifest = await requireRebuildChunkProjectionManifest(input.chunk, database)
  const snapshots = await getRebuildChunkSnapshots(input.chunk, database)
  const snapshotIds = getRebuildSnapshotIds(snapshots)

  return runValidatedRebuildChunkOutput(
    {
      ...input,
      writeMode: 'idempotent-output',
      validateOutput: async (tx) => {
        return getRebuildChunkOutputValidation({
          chunk: input.chunk,
          getChecksum: () => {
            return getHumanStatusRebuildChunkOutputChecksum({chunk: input.chunk, snapshotIds}, tx)
          },
          getCount: () => {
            return getHumanStatusRebuildChunkOutputCount({chunk: input.chunk, snapshotIds}, tx)
          },
        })
      },
      writeOutput: async (tx) => {
        const result = await projectReviewServingHumanStatusPatches(
          {
            acknowledgeClaims: false,
            baseGeneration: input.chunk.outputBaseGeneration,
            chunkEndArticleId: input.chunk.chunkEndKey,
            chunkStartArticleId: input.chunk.chunkStartKey,
            claims: [],
            definitionVersion: manifest.definitionVersion,
            listModeKeys: defaultReviewServingHumanListModeKeys,
            projectId,
            projectionIdentity: input.chunk.projectionIdentity,
          },
          getChunkProjectorDatabase(tx),
        )

        return {diagnosticsJson: getProjectorResultDiagnosticsJson(result)}
      },
    },
    database,
  )
}

const runQueueRebuildChunk = async (
  input: {chunk: ReviewServingRebuildChunkManifest; leaseOwner: string},
  database: ReviewServingChunkManifestRepositoryDatabase & ReviewServingProjectorWorkerDatabase,
) => {
  const projectId = requireRebuildChunkProjectId(input.chunk)
  const snapshots = await getRebuildChunkSnapshots(input.chunk, database)
  const snapshotIds = getRebuildSnapshotIds(snapshots)

  return runValidatedRebuildChunkOutput(
    {
      ...input,
      writeMode: 'idempotent-output',
      validateOutput: async (tx) => {
        return getRebuildChunkOutputValidation({
          chunk: input.chunk,
          getChecksum: () => {
            return getQueueRebuildChunkOutputChecksum({chunk: input.chunk, snapshotIds}, tx)
          },
          getCount: () => {
            return getQueueRebuildChunkOutputCount({chunk: input.chunk, snapshotIds}, tx)
          },
        })
      },
      writeOutput: async (tx) => {
        const chunkDatabase = getChunkProjectorDatabase(tx)

        const snapshotDiagnostics = await snapshots.reduce<Promise<unknown[]>>(async (previous, snapshot) => {
          const diagnostics = await previous
          const result = await projectReviewServingQueueRebuildRows(
            {
              baseGeneration: input.chunk.outputBaseGeneration,
              chunkEndArticleId: input.chunk.chunkEndKey,
              chunkStartArticleId: input.chunk.chunkStartKey,
              projectId,
              projectScopeIdentity: requireSnapshotComponentIdentity(snapshot, 'projectScope'),
              reviewConfigHash: requireReviewConfigHash(snapshot),
              selectedImportSnapshotId: requireSelectedImportSnapshotId(snapshot),
              snapshotId: snapshot.snapshotId,
            },
            chunkDatabase,
          )

          return [...diagnostics, {snapshotId: snapshot.snapshotId, ...getProjectorResultDiagnosticsJson(result)}]
        }, Promise.resolve([]))

        return {diagnosticsJson: {queueProjectorSnapshots: snapshotDiagnostics}}
      },
    },
    database,
  )
}

const runPostingRebuildChunk = async (
  input: {chunk: ReviewServingRebuildChunkManifest; leaseOwner: string},
  database: ReviewServingChunkManifestRepositoryDatabase & ReviewServingProjectorWorkerDatabase,
) => {
  const projectId = requireRebuildChunkProjectId(input.chunk)
  const manifest = await requireRebuildChunkProjectionManifest(input.chunk, database)
  const snapshots = await getRebuildChunkSnapshots(input.chunk, database)
  const snapshotIds = getRebuildSnapshotIds(snapshots)
  const shouldReuseProjectorValidation =
    input.chunk.checksum === null && !shouldUseStrictRebuildValidationWithoutExpectedChecksum()

  return runValidatedRebuildChunkOutput(
    {
      ...input,
      writeMode: 'idempotent-output',
      validateOutput: async (tx) => {
        return getRebuildChunkOutputValidation({
          chunk: input.chunk,
          getChecksum: () => {
            return getPostingRebuildChunkOutputChecksum({chunk: input.chunk, snapshotIds}, tx)
          },
          getCount: () => {
            return getPostingRebuildChunkOutputCount({chunk: input.chunk, snapshotIds}, tx)
          },
        })
      },
      writeOutput: async (tx) => {
        const chunkDatabase = getChunkProjectorDatabase(tx)

        const snapshotResults = await snapshots.reduce<
          Promise<Array<{diagnosticsJson?: unknown; validationResult?: ReviewServingRebuildChunkValidationResult}>>
        >(async (previous, snapshot) => {
          const results = await previous
          const result = await projectReviewServingFilterPostings(
            {
              acknowledgeClaims: false,
              baseGeneration: input.chunk.outputBaseGeneration,
              chunkEndArticleId: input.chunk.chunkEndKey,
              chunkStartArticleId: input.chunk.chunkStartKey,
              claims: [],
              definitionVersion: manifest.definitionVersion,
              listModeKeys: reviewServingListModes,
              projectId,
              projectScopeIdentity: requireSnapshotComponentIdentity(snapshot, 'projectScope'),
              projectionIdentity: input.chunk.projectionIdentity,
              refreshFullRebuildStats: input.chunk.requestId === null,
              reviewConfigHash: requireReviewConfigHash(snapshot),
              selectedImportSnapshotId: requireSelectedImportSnapshotId(snapshot),
              snapshotId: snapshot.snapshotId,
            },
            chunkDatabase,
          )

          return [
            ...results,
            {
              diagnosticsJson: {snapshotId: snapshot.snapshotId, ...result.diagnosticsJson},
              validationResult: shouldReuseProjectorValidation ? result.validationResult : undefined,
            },
          ]
        }, Promise.resolve([]))
        const reusableValidationResults = snapshotResults.flatMap((result) => {
          return result.validationResult === undefined ? [] : [result.validationResult]
        })
        const [reusableValidationResult] = reusableValidationResults

        return {
          diagnosticsJson: {
            postingProjectorSnapshots: snapshotResults.map((result) => {
              return result.diagnosticsJson
            }),
          },
          validationResult: reusableValidationResults.length === 1 ? reusableValidationResult : undefined,
        }
      },
    },
    database,
  )
}

const runSummaryRebuildChunk = async (
  input: {chunk: ReviewServingRebuildChunkManifest; leaseOwner: string},
  database: ReviewServingChunkManifestRepositoryDatabase & ReviewServingProjectorWorkerDatabase,
) => {
  const projectId = requireRebuildChunkProjectId(input.chunk)
  const snapshots = await getRebuildChunkSnapshots(input.chunk, database)
  const snapshotIds = getRebuildSnapshotIds(snapshots)

  return runValidatedRebuildChunkOutput(
    {
      ...input,
      writeMode: 'idempotent-output',
      validateOutput: async (tx) => {
        return getRebuildChunkOutputValidation({
          chunk: input.chunk,
          getChecksum: () => {
            return getSummaryRebuildChunkOutputChecksum({chunk: input.chunk, snapshotIds}, tx)
          },
          getCount: () => {
            return getSummaryRebuildChunkOutputCount({chunk: input.chunk, snapshotIds}, tx)
          },
        })
      },
      writeOutput: async (tx) => {
        const chunkDatabase = getChunkProjectorDatabase(tx)

        const snapshotDiagnostics = await snapshots.reduce<Promise<unknown[]>>(
          async (previous, snapshot) => {
            const diagnostics = await previous

            const result = await projectReviewServingSummaries(
              {
                acknowledgeClaims: false,
                baseGeneration: input.chunk.outputBaseGeneration,
                chunkId: input.chunk.chunkId,
                chunkEndArticleId: input.chunk.chunkEndKey,
                chunkStartArticleId: input.chunk.chunkStartKey,
                claims: [],
                listModeKeys: reviewServingListModes,
                projectId,
                projectScopeIdentity: requireSnapshotComponentIdentity(snapshot, 'projectScope'),
                projectionIdentity: input.chunk.projectionIdentity,
                requestId: input.chunk.requestId,
                reviewConfigHash: requireReviewConfigHash(snapshot),
                selectedImportSnapshotId: requireSelectedImportSnapshotId(snapshot),
                snapshotId: snapshot.snapshotId,
              },
              chunkDatabase,
            )

            return [...diagnostics, {snapshotId: snapshot.snapshotId, ...result.diagnosticsJson}]
          },
          Promise.resolve([] as unknown[]),
        )

        return {diagnosticsJson: {summaryProjectorSnapshots: snapshotDiagnostics}}
      },
    },
    database,
  )
}

const splitClaimedArticleRangeRebuildChunk = async (
  input: {
    chunk: ReviewServingRebuildChunkManifest
    leaseOwner: string
    projectId: string
    splitReason: 'admitted_oversized' | 'duckdb_oom'
  },
  database: ReviewServingChunkManifestRepositoryDatabase,
) => {
  if (!canSplitRebuildChunk(input.chunk)) {
    return false
  }

  return database.transaction(async (tx) => {
    const ranges = await getArticleRangeRebuildChunkSplitRanges(input, tx)
    const splittableRanges = ranges.filter((range) => {
      return range.chunkStartKey !== null && range.chunkEndKey !== null
    })

    if (splittableRanges.length < 2) {
      return false
    }

    const acceptedParentRows = await tx.queryJson<{chunkId: string}>(`
      UPDATE app.review_rebuild_chunk_manifest
      SET
        status = 'completed',
        checksum = ${getSqlLiteral(`split:${input.chunk.chunkId}`)},
        oom_category = ${input.splitReason === 'duckdb_oom' ? "'duckdb_oom_split'" : 'NULL'},
        over_budget_reason = NULL,
        last_error = ${input.splitReason === 'duckdb_oom' ? 'NULL' : 'last_error'},
        lease_owner = NULL,
        lease_expires_at = NULL,
        completed_at = current_timestamp,
        updated_at = current_timestamp
      WHERE chunk_id = ${getSqlLiteral(input.chunk.chunkId)}
        AND status = 'running'
        AND lease_owner = ${getSqlLiteral(input.leaseOwner)}
        AND (lease_expires_at IS NULL OR lease_expires_at > current_timestamp)
      RETURNING chunk_id AS chunkId
    `)

    if (acceptedParentRows.length !== 1) {
      throw new Error(`review serving rebuild chunk ${input.chunk.chunkId} is no longer claimed by ${input.leaseOwner}`)
    }

    await upsertReviewServingRebuildChunkManifests(
      splittableRanges.map((range) => {
        return {
          actualInputRows: null,
          actualOutputBytes: null,
          actualOutputRows: null,
          actualPayloadBytes: null,
          actualPromptCount: null,
          actualTempBytes: null,
          admissionState: 'admitted' as const,
          budgetJson: input.chunk.budgetJson,
          checksum: null,
          chunkEndKey: range.chunkEndKey ?? input.chunk.chunkEndKey,
          chunkStartKey: range.chunkStartKey ?? input.chunk.chunkStartKey,
          diagnosticsJson: {
            ...(input.chunk.diagnosticsJson && typeof input.chunk.diagnosticsJson === 'object'
              ? input.chunk.diagnosticsJson
              : {}),
            parentChunkId: input.chunk.chunkId,
            parentLastError: input.chunk.lastError,
            parentRetryCount: input.chunk.retryCount,
            splitReason: input.splitReason,
          },
          estimatedInputRows: Math.ceil((input.chunk.estimatedInputRows ?? 0) / splittableRanges.length),
          estimatedOutputBytes: Math.ceil((input.chunk.estimatedOutputBytes ?? 0) / splittableRanges.length),
          estimatedOutputRows: Math.ceil((input.chunk.estimatedOutputRows ?? 0) / splittableRanges.length),
          estimatedPayloadBytes: Math.ceil((input.chunk.estimatedPayloadBytes ?? 0) / splittableRanges.length),
          estimatedPromptCount: input.chunk.estimatedPromptCount,
          estimatedTempBytes: input.chunk.estimatedTempBytes,
          inputDigest: input.chunk.inputDigest,
          inputWatermark: input.chunk.inputWatermark,
          maxInputRows: input.chunk.maxInputRows,
          maxOutputBytes: input.chunk.maxOutputBytes,
          maxOutputRows: input.chunk.maxOutputRows,
          maxPayloadBytes: input.chunk.maxPayloadBytes,
          maxPromptCount: input.chunk.maxPromptCount,
          maxTempBytes: input.chunk.maxTempBytes,
          oomCategory: null,
          outputBaseGeneration: input.chunk.outputBaseGeneration,
          overBudgetReason: null,
          parentChunkId: input.chunk.chunkId,
          projectId: input.chunk.projectId,
          projectionComponent: input.chunk.projectionComponent,
          projectionIdentity: input.chunk.projectionIdentity,
          requestId: input.chunk.requestId,
          retryAfter: null,
          retryCount: 0,
          snapshotCount: input.chunk.snapshotCount,
          snapshotId: input.chunk.snapshotId,
          splitDepth: (input.chunk.splitDepth ?? 0) + 1,
          status: 'pending' as const,
          workloadClass: input.chunk.workloadClass,
        }
      }),
      tx,
    )

    return true
  })
}

const recoverAdmittedOversizedRebuildChunk = async (
  input: {chunk: ReviewServingRebuildChunkManifest; leaseOwner: string},
  database: ReviewServingChunkManifestRepositoryDatabase & ReviewServingProjectorWorkerDatabase,
) => {
  if (!isAdmittedOversizedRebuildChunk(input.chunk)) {
    return false
  }

  const estimatedInputRows = getPositiveFiniteNumber(input.chunk.estimatedInputRows)
  const inputRowLimit = admittedOversizedRebuildChunkInputRowLimits[input.chunk.projectionComponent]
  const diagnostic = `cannot safely recover admitted oversized ${input.chunk.projectionComponent} rebuild chunk ${input.chunk.chunkId}: estimated input rows ${estimatedInputRows} exceed component limit ${inputRowLimit}`

  if (!canSplitRebuildChunk(input.chunk)) {
    throw new Error(`${diagnostic}; bounded article range is not splittable`)
  }

  const split = await splitClaimedArticleRangeRebuildChunk(
    {
      chunk: input.chunk,
      leaseOwner: input.leaseOwner,
      projectId: requireRebuildChunkProjectId(input.chunk),
      splitReason: 'admitted_oversized',
    },
    database,
  )

  if (!split) {
    throw new Error(`${diagnostic}; fewer than two non-empty child ranges were available`)
  }

  return true
}

const runJudgmentInputContentRebuildChunk = async (
  input: {chunk: ReviewServingRebuildChunkManifest; leaseOwner: string},
  database: ReviewServingChunkManifestRepositoryDatabase & ReviewServingProjectorWorkerDatabase,
) => {
  const projectId = requireRebuildChunkProjectId(input.chunk)
  const manifest = await requireRebuildChunkProjectionManifest(input.chunk, database)
  const snapshots = await getRebuildChunkSnapshots(input.chunk, database)
  const snapshotIds = getRebuildSnapshotIds(snapshots)
  const currentSettings = await getCurrentProjectReviewSnapshotSettings(projectId, database)
  const payloadSnapshots = snapshots.filter((snapshot) => {
    return getSnapshotReviewSettings(snapshot, currentSettings) !== null
  })

  try {
    return await runValidatedRebuildChunkOutput(
      {
        ...input,
        writeMode: 'idempotent-output',
        validateOutput: async (tx) => {
          return getRebuildChunkOutputValidation({
            chunk: input.chunk,
            getChecksum: () => {
              return getJudgmentInputContentRebuildChunkOutputChecksum({chunk: input.chunk, snapshotIds}, tx)
            },
            getCount: () => {
              return getJudgmentInputContentRebuildChunkOutputCount({chunk: input.chunk, snapshotIds}, tx)
            },
          })
        },
        writeOutput: async (tx) => {
          const chunkDatabase = getChunkProjectorDatabase(tx)

          const snapshotDiagnostics = await payloadSnapshots.reduce<Promise<unknown[]>>(
            async (previous, snapshot) => {
              const diagnostics = await previous
              const project = getSnapshotReviewSettings(snapshot, currentSettings)

              if (project !== null) {
                const result = await projectReviewServingJudgmentPayloadRows(
                  {
                    acknowledgeClaims: false,
                    baseGeneration: input.chunk.outputBaseGeneration,
                    chunkEndArticleId: input.chunk.chunkEndKey,
                    chunkStartArticleId: input.chunk.chunkStartKey,
                    claims: [],
                    definitionVersion: manifest.definitionVersion,
                    listModeKeys: reviewServingListModes,
                    modelId: project.modelId,
                    projectId,
                    projectionIdentity: input.chunk.projectionIdentity,
                    reviewConfigHash: requireReviewConfigHash(snapshot),
                    snapshotId: snapshot.snapshotId,
                    useAbstract: project.useAbstract,
                    useFulltext: project.useFulltext,
                    useFulltextNoImages: project.useFulltextNoImages,
                    useTitle: project.useTitle,
                  },
                  chunkDatabase,
                )

                return [...diagnostics, {snapshotId: snapshot.snapshotId, ...result.diagnosticsJson}]
              }

              return diagnostics
            },
            Promise.resolve([] as unknown[]),
          )

          return {diagnosticsJson: {judgmentPayloadProjectorSnapshots: snapshotDiagnostics}}
        },
      },
      database,
    )
  } catch (error) {
    const splitSnapshot = payloadSnapshots[0]
    const split =
      isDuckDbOutOfMemoryError(error) && splitSnapshot !== undefined
        ? await splitClaimedArticleRangeRebuildChunk(
            {chunk: input.chunk, leaseOwner: input.leaseOwner, projectId, splitReason: 'duckdb_oom'},
            database,
          )
        : false

    if (split) {
      return {status: 'completed' as const}
    }

    throw error
  }
}

const getRebuildChunkProjectClaim = (input: {
  chunk: ReviewServingRebuildChunkManifest
  dirtyKind: string
  sourcePartition: string
  sourceWatermark?: number
}): ReviewServingDirtyWorkClaim => {
  const projectId = requireRebuildChunkProjectId(input.chunk)
  const sourceWatermark = input.sourceWatermark ?? input.chunk.inputWatermark

  return {
    articleId: null,
    dirtyKind: input.dirtyKind,
    dirtyRangeEnd: null,
    dirtyRangeStart: null,
    dirtyWorkId: `rebuild:${input.chunk.chunkId}`,
    firstSourceHighWaterMark: sourceWatermark,
    latestDeltaId: input.chunk.chunkId,
    latestSourceHighWaterMark: sourceWatermark,
    projectId,
    projectionComponent: input.chunk.projectionComponent,
    projectionIdentity: input.chunk.projectionIdentity,
    scopeId: projectId,
    scopeKind: 'project',
    sourcePartition: input.sourcePartition,
    status: 'running',
  }
}

const getRebuildChunkProjectClaims = (input: {
  chunk: ReviewServingRebuildChunkManifest
  dirtyKind: string
  fallbackSourcePartition: string
  sourceWatermarks: Record<string, number>
}) => {
  const sourceWatermarkEntries = Object.entries(input.sourceWatermarks).filter((entry) => {
    return Number.isFinite(entry[1])
  })

  return sourceWatermarkEntries.length === 0
    ? [
        getRebuildChunkProjectClaim({
          chunk: input.chunk,
          dirtyKind: input.dirtyKind,
          sourcePartition: input.fallbackSourcePartition,
        }),
      ]
    : sourceWatermarkEntries.map(([sourcePartition, sourceWatermark]) => {
        return getRebuildChunkProjectClaim({
          chunk: input.chunk,
          dirtyKind: input.dirtyKind,
          sourcePartition,
          sourceWatermark,
        })
      })
}

const isFreshReviewServingSnapshotRebuildChunk = (chunk: ReviewServingRebuildChunkManifest) => {
  return chunk.inputDigest === 'freshReviewServingSnapshot'
}

const getProjectScopeRebuildChunkOutputChecksum = async (
  input: {chunk: ReviewServingRebuildChunkManifest},
  database: ReviewServingChunkManifestRepositoryTransaction,
) => {
  const projectId = requireRebuildChunkProjectId(input.chunk)
  const [row] = await database.queryJson<RebuildChunkOutputChecksumRow>(`
    SELECT
      CAST(COUNT(*) AS INTEGER) AS actualCount,
      sha256(COALESCE(string_agg(
        CAST(scope.article_id AS VARCHAR) || ':' ||
        CAST(scope.in_curated_scope AS VARCHAR) || ':' ||
        CAST(scope.in_route_scope AS VARCHAR) || ':' ||
        COALESCE(CAST(scope.article_created_at AS VARCHAR), '') || ':' ||
        COALESCE(CAST(scope.article_updated_at AS VARCHAR), ''),
        '|' ORDER BY scope.article_id
      ), '')) AS actualChecksum
    FROM mart.project_scope_article scope
    WHERE scope.project_id = ${getSqlLiteral(projectId)}
      AND ${getChunkArticleRangePredicate({alias: 'scope', chunk: input.chunk})}
  `)

  return row ?? {actualChecksum: '', actualCount: 0}
}

const getProjectScopeRebuildChunkOutputCount = async (
  input: {chunk: ReviewServingRebuildChunkManifest},
  database: ReviewServingChunkManifestRepositoryTransaction,
) => {
  const projectId = requireRebuildChunkProjectId(input.chunk)
  const [row] = await database.queryJson<RebuildChunkOutputChecksumRow>(`
    SELECT
      ${getCheapRebuildChunkOutputChecksumSelect()}
    FROM mart.project_scope_article scope
    WHERE scope.project_id = ${getSqlLiteral(projectId)}
      AND ${getChunkArticleRangePredicate({alias: 'scope', chunk: input.chunk})}
  `)

  return row ?? {actualChecksum: '', actualCount: 0}
}

const writeProjectScopeRebuildChunkRows = async (
  input: {chunk: ReviewServingRebuildChunkManifest},
  database: ReviewServingChunkManifestRepositoryTransaction,
) => {
  const projectId = requireRebuildChunkProjectId(input.chunk)

  await database.run(`
    DELETE FROM mart.project_scope_article scope
    WHERE scope.project_id = ${getSqlLiteral(projectId)}
      AND ${getChunkArticleRangePredicate({alias: 'scope', chunk: input.chunk})};
    INSERT INTO mart.project_scope_article (
      project_id,
      article_id,
      in_curated_scope,
      in_route_scope,
      article_created_at,
      article_updated_at
    )
    WITH route_scope AS (
      SELECT
        project_import_route.project_id,
        article_import_route.article_id,
        TRUE AS in_route_scope,
        FALSE AS in_curated_scope
      FROM app.project_import_route project_import_route
      INNER JOIN app.article_import_route article_import_route
        ON article_import_route.import_route_id = project_import_route.import_route_id
      WHERE project_import_route.project_id = ${getSqlLiteral(projectId)}
        AND ${getChunkArticleRangePredicate({alias: 'article_import_route', chunk: input.chunk})}
    ),
    curated_scope AS (
      SELECT
        project_article.project_id,
        project_article.article_id,
        FALSE AS in_route_scope,
        TRUE AS in_curated_scope
      FROM app.project_article project_article
      WHERE project_article.project_id = ${getSqlLiteral(projectId)}
        AND ${getChunkArticleRangePredicate({alias: 'project_article', chunk: input.chunk})}
    ),
    combined_scope AS (
      SELECT * FROM route_scope
      UNION ALL
      SELECT * FROM curated_scope
    ),
    aggregated_scope AS (
      SELECT
        project_id,
        article_id,
        COALESCE(BOOL_OR(in_curated_scope), FALSE) AS in_curated_scope,
        COALESCE(BOOL_OR(in_route_scope), FALSE) AS in_route_scope
      FROM combined_scope
      GROUP BY project_id, article_id
    )
    SELECT
      aggregated_scope.project_id,
      aggregated_scope.article_id,
      aggregated_scope.in_curated_scope,
      aggregated_scope.in_route_scope,
      article.article_created_at,
      article.article_updated_at
    FROM aggregated_scope
    INNER JOIN app.project project
      ON project.id = aggregated_scope.project_id
      AND project.archived = FALSE
    INNER JOIN app.article article ON article.id = aggregated_scope.article_id
    WHERE aggregated_scope.project_id = ${getSqlLiteral(projectId)}
      AND ${getChunkArticleRangePredicate({alias: 'aggregated_scope', chunk: input.chunk})}
      AND (project.date_from IS NULL OR article.article_created_at >= project.date_from)
      AND (project.date_to IS NULL OR article.article_created_at <= project.date_to)
  `)
}

const runProjectScopeRebuildChunk = async (
  input: {chunk: ReviewServingRebuildChunkManifest; leaseOwner: string},
  database: ReviewServingChunkManifestRepositoryDatabase & ReviewServingProjectorWorkerDatabase,
) => {
  const projectId = requireRebuildChunkProjectId(input.chunk)
  const manifest = await requireRebuildChunkProjectionManifest(input.chunk, database)
  const claims = getRebuildChunkProjectClaims({
    chunk: input.chunk,
    dirtyKind: 'projectScope.rebuild',
    fallbackSourcePartition: `projectScope:${projectId}`,
    sourceWatermarks: manifest.inputWatermarks,
  })

  return runValidatedRebuildChunkOutput(
    {
      ...input,
      validateOutput: async (tx) => {
        return getRebuildChunkOutputValidation({
          chunk: input.chunk,
          getChecksum: () => {
            return getProjectScopeRebuildChunkOutputChecksum({chunk: input.chunk}, tx)
          },
          getCount: () => {
            return getProjectScopeRebuildChunkOutputCount({chunk: input.chunk}, tx)
          },
        })
      },
      writeOutput: async (tx) => {
        await writeProjectScopeRebuildChunkRows({chunk: input.chunk}, tx)

        if (!isFreshReviewServingSnapshotRebuildChunk(input.chunk)) {
          await projectReviewServingProjectScopePatches(
            {
              baseGeneration: input.chunk.outputBaseGeneration,
              claims,
              definitionVersion: manifest.definitionVersion,
              projectId,
              projectionIdentity: input.chunk.projectionIdentity,
            },
            getChunkProjectorDatabase(tx),
          )
        }
      },
    },
    database,
  )
}

const canRunProjectScopeRebuildChunkBatch = (chunks: readonly ReviewServingRebuildChunkManifest[]) => {
  return (
    chunks.length > 1
    && chunks.every((chunk) => {
      return (
        chunk.projectionComponent === 'projectScope'
        && chunk.requestId === null
        && isFreshReviewServingSnapshotRebuildChunk(chunk)
      )
    })
  )
}

const completeProjectScopeRebuildChunkAfterBatchWrite = async (
  input: {batchRangeCount: number; chunk: ReviewServingRebuildChunkManifest; leaseOwner: string},
  database: ReviewServingChunkManifestRepositoryDatabase,
) => {
  const completedChunk = await writeReviewServingRebuildChunkOutput(
    {
      ...input.chunk,
      diagnosticsJson: {projectScopeBatchWriter: {rangeCount: input.batchRangeCount}},
      leaseOwner: input.leaseOwner,
      validateOutput: async (tx) => {
        return getRebuildChunkOutputValidation({
          chunk: input.chunk,
          getChecksum: () => {
            return getProjectScopeRebuildChunkOutputChecksum({chunk: input.chunk}, tx)
          },
          getCount: () => {
            return getProjectScopeRebuildChunkOutputCount({chunk: input.chunk}, tx)
          },
        })
      },
      writeOutput: async () => {
        return {diagnosticsJson: {projectScopeBatchWriter: {writeOutputAlreadyCompleted: true}}}
      },
    },
    database,
  )

  if (completedChunk === null) {
    throw new Error(`review serving rebuild chunk ${input.chunk.chunkId} is no longer claimed by ${input.leaseOwner}`)
  }
}

const runProjectScopeRebuildChunkBatch = async (
  input: {chunks: readonly ReviewServingRebuildChunkManifest[]; leaseOwner: string},
  database: ReviewServingChunkManifestRepositoryDatabase & ReviewServingProjectorWorkerDatabase,
) => {
  if (!canRunProjectScopeRebuildChunkBatch(input.chunks)) {
    return null
  }

  await database.transaction(async (tx) => {
    await input.chunks.reduce<Promise<void>>(async (previous, chunk) => {
      await previous
      await requireClaimedRebuildChunk({chunk, leaseOwner: input.leaseOwner}, tx)
      await writeProjectScopeRebuildChunkRows({chunk}, tx)
    }, Promise.resolve())
  })

  await input.chunks.reduce<Promise<void>>(async (previous, chunk) => {
    await previous
    await completeProjectScopeRebuildChunkAfterBatchWrite(
      {batchRangeCount: input.chunks.length, chunk, leaseOwner: input.leaseOwner},
      database,
    )
  }, Promise.resolve())

  return input.chunks.map((chunk) => {
    return {
      chunkId: chunk.chunkId,
      projectionComponent: chunk.projectionComponent,
      requestId: chunk.requestId,
      status: 'completed' as const,
    }
  })
}

const getSelectedImportRebuildChunkOutputChecksum = async (
  input: {chunk: ReviewServingRebuildChunkManifest; selectedImportSnapshotIds: readonly string[]},
  database: ReviewServingChunkManifestRepositoryTransaction,
) => {
  const projectId = requireRebuildChunkProjectId(input.chunk)
  const [row] = await database.queryJson<RebuildChunkOutputChecksumRow>(`
    WITH output_row AS (
      SELECT
        'base:' || CAST(selected_import_snapshot_id AS VARCHAR) || ':' || CAST(article_id AS VARCHAR) AS row_key,
        COALESCE(CAST(import_route_id AS VARCHAR), '') || ':' ||
        COALESCE(CAST(source_record_key AS VARCHAR), '') || ':' ||
        COALESCE(CAST(selected_rank_key AS VARCHAR), '') || ':' ||
        COALESCE(CAST(selected_rank_numeric AS VARCHAR), '') || ':' ||
        COALESCE(CAST(publication_year AS VARCHAR), '') || ':' ||
        COALESCE(CAST(article_title AS VARCHAR), '') || ':' ||
        COALESCE(CAST(journal_title AS VARCHAR), '') || ':' ||
        COALESCE(CAST(external_id AS VARCHAR), '') || ':' ||
        COALESCE(CAST(tombstone AS VARCHAR), '') AS row_value
      FROM app.review_selected_article_import_v4 base
      WHERE project_id = ${getSqlLiteral(projectId)}
        AND ${getSelectedImportSnapshotIdPredicate(input.selectedImportSnapshotIds)}
        AND ${getChunkArticleRangePredicate({alias: 'base', chunk: input.chunk})}
    )
    SELECT
      CAST(COUNT(*) AS INTEGER) AS actualCount,
      sha256(COALESCE(string_agg(row_key || ':' || row_value, '|' ORDER BY row_key), '')) AS actualChecksum
    FROM output_row
  `)

  return row ?? {actualChecksum: '', actualCount: 0}
}

const getSelectedImportRebuildChunkOutputCount = async (
  input: {chunk: ReviewServingRebuildChunkManifest; selectedImportSnapshotIds: readonly string[]},
  database: ReviewServingChunkManifestRepositoryTransaction,
) => {
  const projectId = requireRebuildChunkProjectId(input.chunk)
  const [row] = await database.queryJson<RebuildChunkOutputChecksumRow>(`
    WITH output_row AS (
      SELECT 1
      FROM app.review_selected_article_import_v4 base
      WHERE project_id = ${getSqlLiteral(projectId)}
        AND ${getSelectedImportSnapshotIdPredicate(input.selectedImportSnapshotIds)}
        AND ${getChunkArticleRangePredicate({alias: 'base', chunk: input.chunk})}
    )
    SELECT
      ${getCheapRebuildChunkOutputChecksumSelect()}
    FROM output_row
  `)

  return row ?? {actualChecksum: '', actualCount: 0}
}

const resetSelectedImportSnapshotForRebuild = async (
  input: {projectId: string; projectScopeIdentity: string; selectedImportSnapshotId: string},
  database: ReviewServingChunkManifestRepositoryTransaction,
) => {
  await deleteReviewServingProjectorRows(
    {
      predicates: {
        project_id: input.projectId,
        project_scope_identity: input.projectScopeIdentity,
        selected_import_snapshot_id: input.selectedImportSnapshotId,
      },
      table: 'app.review_selected_article_import_v4',
    },
    database,
  )
  await database.run(`
    DELETE FROM app.review_selected_import_snapshot
    WHERE project_id = ${getSqlLiteral(input.projectId)}
      AND project_scope_identity = ${getSqlLiteral(input.projectScopeIdentity)}
      AND selected_import_snapshot_id = ${getSqlLiteral(input.selectedImportSnapshotId)}
  `)
}

const drainSelectedImportBaseProjection = async (
  input: {
    beforeBatch?: () => Promise<void>
    projectId: string
    projectScopeIdentity: string
    selectedImportSnapshotId: string
    sourceDeltaHighWater: number
  },
  database: ReviewServingProjectorWorkerDatabase,
): Promise<number> => {
  await input.beforeBatch?.()
  const result = await projectReviewServingSelectedImportBatch(
    {
      limit: defaultReviewServingSelectedImportBaseBatchSize,
      projectId: input.projectId,
      projectScopeIdentity: input.projectScopeIdentity,
      selectedImportSnapshotId: input.selectedImportSnapshotId,
      sourceDeltaHighWater: input.sourceDeltaHighWater,
    },
    database,
  )

  return result.status === 'completed'
    ? result.insertedRowCount
    : result.insertedRowCount + (await drainSelectedImportBaseProjection(input, database))
}

const requireClaimedRebuildChunk = async (
  input: {chunk: ReviewServingRebuildChunkManifest; leaseOwner: string},
  database: ReviewServingChunkManifestRepositoryTransaction,
) => {
  const claimed = await getReviewServingRebuildChunkManifest({chunkId: input.chunk.chunkId}, database)
  const canWrite = claimed?.status === 'running' && claimed.leaseOwner === input.leaseOwner

  if (!canWrite) {
    throw new Error(`review serving rebuild chunk ${input.chunk.chunkId} is no longer claimed by ${input.leaseOwner}`)
  }
}

const resetSelectedImportSnapshotForClaimedRebuild = async (
  input: {
    chunk: ReviewServingRebuildChunkManifest
    leaseOwner: string
    projectId: string
    projectScopeIdentity: string
    selectedImportSnapshotId: string
  },
  database: ReviewServingChunkManifestRepositoryDatabase & ReviewServingProjectorWorkerDatabase,
) => {
  await database.transaction(async (tx) => {
    await requireClaimedRebuildChunk(input, tx)
    await resetSelectedImportSnapshotForRebuild(input, tx)
  })
}

const projectSelectedImportArticleRangeForClaimedRebuild = async (
  input: {
    chunk: ReviewServingRebuildChunkManifest
    leaseOwner: string
    projectId: string
    projectScopeIdentity: string
    selectedImportSnapshotId: string
    sourceDeltaHighWater: number
  },
  database: ReviewServingChunkManifestRepositoryDatabase & ReviewServingProjectorWorkerDatabase,
) => {
  await database.transaction(async (tx) => {
    await requireClaimedRebuildChunk(input, tx)
    await projectReviewServingSelectedImportArticleRange(
      {
        chunkEndArticleId: input.chunk.chunkEndKey,
        chunkStartArticleId: input.chunk.chunkStartKey,
        projectId: input.projectId,
        projectScopeIdentity: input.projectScopeIdentity,
        replaceExistingRows: !isFreshReviewServingSnapshotRebuildChunk(input.chunk),
        selectedImportSnapshotId: input.selectedImportSnapshotId,
        servingBaseGeneration: input.chunk.outputBaseGeneration,
        servingProjectionIdentity: input.chunk.projectionIdentity,
        sourceDeltaHighWater: input.sourceDeltaHighWater,
        writeProjectionState: true,
      },
      getChunkProjectorDatabase(tx),
    )
  })
}

const shouldRunFullSelectedImportRebuildChunk = (chunk: ReviewServingRebuildChunkManifest) => {
  return (
    !isFreshReviewServingSnapshotRebuildChunk(chunk) && chunk.parentChunkId == null && (chunk.splitDepth ?? 0) === 0
  )
}

const drainSelectedImportBaseProjectionForClaimedRebuild = async (
  input: {
    chunk: ReviewServingRebuildChunkManifest
    leaseOwner: string
    projectId: string
    projectScopeIdentity: string
    selectedImportSnapshotId: string
    sourceDeltaHighWater: number
  },
  database: ReviewServingChunkManifestRepositoryDatabase & ReviewServingProjectorWorkerDatabase,
) => {
  await drainSelectedImportBaseProjection(
    {
      ...input,
      beforeBatch: async () => {
        await requireClaimedRebuildChunk(input, database)
      },
    },
    database,
  )
}

const runSelectedImportRebuildChunk = async (
  input: {chunk: ReviewServingRebuildChunkManifest; leaseOwner: string},
  database: ReviewServingChunkManifestRepositoryDatabase & ReviewServingProjectorWorkerDatabase,
) => {
  const projectId = requireRebuildChunkProjectId(input.chunk)
  const snapshots = await getRebuildChunkSnapshots(input.chunk, database)
  const selectedImportSnapshotIds = snapshots.map((snapshot) => {
    return requireSelectedImportSnapshotId(snapshot)
  })

  const completedChunk = await writeReviewServingRebuildChunkOutput(
    {
      ...input.chunk,
      leaseOwner: input.leaseOwner,
      writeMode: 'idempotent-output',
      validateOutput: async (tx) => {
        return getRebuildChunkOutputValidation({
          chunk: input.chunk,
          getChecksum: () => {
            return getSelectedImportRebuildChunkOutputChecksum({chunk: input.chunk, selectedImportSnapshotIds}, tx)
          },
          getCount: () => {
            return getSelectedImportRebuildChunkOutputCount({chunk: input.chunk, selectedImportSnapshotIds}, tx)
          },
        })
      },
      writeOutput: async (tx) => {
        const projectorDatabase = getChunkProjectorDatabase(tx)

        const snapshotDiagnostics = await snapshots.reduce<Promise<unknown[]>>(async (previous, snapshot) => {
          const diagnostics = await previous
          const selectedImportSnapshotId = requireSelectedImportSnapshotId(snapshot)
          const projectScopeIdentity = requireSnapshotComponentIdentity(snapshot, 'projectScope')
          const existingSnapshot = await getSelectedImportSnapshotStatus(selectedImportSnapshotId, projectorDatabase)
          const sourceDeltaHighWater = Number(existingSnapshot?.sourceDeltaHighWater ?? input.chunk.inputWatermark)

          if (shouldRunFullSelectedImportRebuildChunk(input.chunk)) {
            const deleteResetStartedAtMs = Date.now()
            await resetSelectedImportSnapshotForClaimedRebuild(
              {...input, projectId, projectScopeIdentity, selectedImportSnapshotId},
              projectorDatabase,
            )
            const deleteResetMs = getNonNegativeElapsedMs(deleteResetStartedAtMs)
            const sourceQueryStartedAtMs = Date.now()
            await drainSelectedImportBaseProjectionForClaimedRebuild(
              {...input, projectId, projectScopeIdentity, selectedImportSnapshotId, sourceDeltaHighWater},
              projectorDatabase,
            )
            const sourceQueryMs = getNonNegativeElapsedMs(sourceQueryStartedAtMs)
            const refreshResult = await refreshReviewServingSelectedImportServingArticleRange(
              {
                chunkEndArticleId: input.chunk.chunkEndKey,
                chunkStartArticleId: input.chunk.chunkStartKey,
                projectId,
                projectScopeIdentity,
                selectedImportSnapshotId,
                servingBaseGeneration: input.chunk.outputBaseGeneration,
                servingProjectionIdentity: input.chunk.projectionIdentity,
                sourceDeltaHighWater,
              },
              projectorDatabase,
            )

            const refreshDiagnostics = getProjectorResultDiagnosticsJson(refreshResult) as {
              phaseTimings?: Record<string, number>
            }

            return [
              ...diagnostics,
              {
                snapshotId: snapshot.snapshotId,
                ...refreshDiagnostics,
                phaseTimings: {...(refreshDiagnostics.phaseTimings ?? {}), deleteResetMs, sourceQueryMs},
              },
            ]
          } else {
            const rangeStartedAtMs = Date.now()
            await projectSelectedImportArticleRangeForClaimedRebuild(
              {...input, projectId, projectScopeIdentity, selectedImportSnapshotId, sourceDeltaHighWater},
              projectorDatabase,
            )

            return [
              ...diagnostics,
              {snapshotId: snapshot.snapshotId, phaseTimings: {writerMs: getNonNegativeElapsedMs(rangeStartedAtMs)}},
            ]
          }
        }, Promise.resolve([]))

        return {diagnosticsJson: {selectedImportProjectorSnapshots: snapshotDiagnostics}}
      },
    },
    database,
  )

  if (completedChunk === null) {
    throw new Error(`review serving rebuild chunk ${input.chunk.chunkId} is no longer claimed by ${input.leaseOwner}`)
  }

  return {status: 'completed' as const}
}

const canRunSelectedImportRebuildChunkBatch = (chunks: readonly ReviewServingRebuildChunkManifest[]) => {
  return (
    chunks.length > 1
    && chunks.every((chunk) => {
      return (
        chunk.projectionComponent === 'selectedImport'
        && chunk.requestId === null
        && !shouldRunFullSelectedImportRebuildChunk(chunk)
      )
    })
  )
}

const getSelectedImportRebuildChunkBatchRange = (input: {
  chunk: ReviewServingRebuildChunkManifest
  projectId: string
  projectScopeIdentity: string
  selectedImportSnapshotId: string
  sourceDeltaHighWater: number
}): ProjectReviewServingSelectedImportArticleRangeInput => {
  return {
    chunkEndArticleId: input.chunk.chunkEndKey,
    chunkStartArticleId: input.chunk.chunkStartKey,
    projectId: input.projectId,
    projectScopeIdentity: input.projectScopeIdentity,
    replaceExistingRows: !isFreshReviewServingSnapshotRebuildChunk(input.chunk),
    selectedImportSnapshotId: input.selectedImportSnapshotId,
    servingBaseGeneration: input.chunk.outputBaseGeneration,
    servingProjectionIdentity: input.chunk.projectionIdentity,
    sourceDeltaHighWater: input.sourceDeltaHighWater,
    writeProjectionState: true,
  }
}

const completeSelectedImportRebuildChunkAfterBatchWrite = async (
  input: {
    batchRangeCount: number
    batchWriteMs: number
    chunk: ReviewServingRebuildChunkManifest
    leaseOwner: string
    selectedImportSnapshotIds: readonly string[]
  },
  database: ReviewServingChunkManifestRepositoryDatabase,
) => {
  const completedChunk = await writeReviewServingRebuildChunkOutput(
    {
      ...input.chunk,
      diagnosticsJson: {
        phaseTimings: {batchWriteMs: input.batchWriteMs},
        selectedImportBatchWriter: {rangeCount: input.batchRangeCount},
      },
      leaseOwner: input.leaseOwner,
      validateOutput: async (tx) => {
        return getRebuildChunkOutputValidation({
          chunk: input.chunk,
          getChecksum: () => {
            return getSelectedImportRebuildChunkOutputChecksum(
              {chunk: input.chunk, selectedImportSnapshotIds: input.selectedImportSnapshotIds},
              tx,
            )
          },
          getCount: () => {
            return getSelectedImportRebuildChunkOutputCount(
              {chunk: input.chunk, selectedImportSnapshotIds: input.selectedImportSnapshotIds},
              tx,
            )
          },
        })
      },
      writeOutput: async () => {
        return {diagnosticsJson: {selectedImportBatchWriter: {writeOutputAlreadyCompleted: true}}}
      },
    },
    database,
  )

  if (completedChunk === null) {
    throw new Error(`review serving rebuild chunk ${input.chunk.chunkId} is no longer claimed by ${input.leaseOwner}`)
  }
}

const runSelectedImportRebuildChunkBatch = async (
  input: {chunks: readonly ReviewServingRebuildChunkManifest[]; leaseOwner: string},
  database: ReviewServingChunkManifestRepositoryDatabase & ReviewServingProjectorWorkerDatabase,
) => {
  if (!canRunSelectedImportRebuildChunkBatch(input.chunks)) {
    return null
  }

  const [firstChunk] = input.chunks
  if (firstChunk === undefined) {
    return null
  }
  const projectId = requireRebuildChunkProjectId(firstChunk)
  const snapshots = await getRebuildChunkSnapshots(firstChunk, database)
  const selectedImportSnapshotIds = snapshots.map((snapshot) => {
    return requireSelectedImportSnapshotId(snapshot)
  })

  const batchWriteStartedAtMs = Date.now()
  await database.transaction(async (tx) => {
    await input.chunks.reduce<Promise<void>>(async (previous, chunk) => {
      await previous
      await requireClaimedRebuildChunk({chunk, leaseOwner: input.leaseOwner}, tx)
    }, Promise.resolve())

    const projectorDatabase = getChunkProjectorDatabase(tx)

    await snapshots.reduce<Promise<void>>(async (previous, snapshot) => {
      await previous
      const selectedImportSnapshotId = requireSelectedImportSnapshotId(snapshot)
      const projectScopeIdentity = requireSnapshotComponentIdentity(snapshot, 'projectScope')
      const existingSnapshot = await getSelectedImportSnapshotStatus(selectedImportSnapshotId, projectorDatabase)
      const sourceDeltaHighWater = Number(existingSnapshot?.sourceDeltaHighWater ?? firstChunk.inputWatermark)
      const ranges = input.chunks.map((chunk) => {
        return getSelectedImportRebuildChunkBatchRange({
          chunk,
          projectId,
          projectScopeIdentity,
          selectedImportSnapshotId,
          sourceDeltaHighWater,
        })
      })

      await projectReviewServingSelectedImportArticleRanges({ranges}, projectorDatabase)
    }, Promise.resolve())
  })
  const batchWriteMs = getNonNegativeElapsedMs(batchWriteStartedAtMs)

  await input.chunks.reduce<Promise<void>>(async (previous, chunk) => {
    await previous
    await completeSelectedImportRebuildChunkAfterBatchWrite(
      {
        batchRangeCount: input.chunks.length,
        batchWriteMs,
        chunk,
        leaseOwner: input.leaseOwner,
        selectedImportSnapshotIds,
      },
      database,
    )
  }, Promise.resolve())

  return input.chunks.map((chunk) => {
    return {
      chunkId: chunk.chunkId,
      projectionComponent: chunk.projectionComponent,
      requestId: chunk.requestId,
      status: 'completed' as const,
    }
  })
}

const canRunDisplayRebuildChunkBatch = (chunks: readonly ReviewServingRebuildChunkManifest[]) => {
  return (
    chunks.length > 1
    && chunks.every((chunk) => {
      return chunk.projectionComponent === 'display' && chunk.requestId === null
    })
  )
}

const completeDisplayRebuildChunkAfterBatchWrite = async (
  input: {
    batchRangeCount: number
    batchWriteMs: number
    chunk: ReviewServingRebuildChunkManifest
    leaseOwner: string
    snapshotIds: readonly string[]
  },
  database: ReviewServingChunkManifestRepositoryDatabase,
) => {
  const completedChunk = await writeReviewServingRebuildChunkOutput(
    {
      ...input.chunk,
      diagnosticsJson: {
        displayBatchWriter: {rangeCount: input.batchRangeCount},
        phaseTimings: {batchWriteMs: input.batchWriteMs},
      },
      leaseOwner: input.leaseOwner,
      validateOutput: async (tx) => {
        return getRebuildChunkOutputValidation({
          chunk: input.chunk,
          getChecksum: () => {
            return getDisplayRebuildChunkOutputChecksum({chunk: input.chunk, snapshotIds: input.snapshotIds}, tx)
          },
          getCount: () => {
            return getDisplayRebuildChunkOutputCount({chunk: input.chunk, snapshotIds: input.snapshotIds}, tx)
          },
        })
      },
      writeOutput: async () => {
        return {diagnosticsJson: {displayBatchWriter: {writeOutputAlreadyCompleted: true}}}
      },
    },
    database,
  )

  if (completedChunk === null) {
    throw new Error(`review serving rebuild chunk ${input.chunk.chunkId} is no longer claimed by ${input.leaseOwner}`)
  }
}

const runDisplayRebuildChunkBatch = async (
  input: {chunks: readonly ReviewServingRebuildChunkManifest[]; leaseOwner: string},
  database: ReviewServingChunkManifestRepositoryDatabase & ReviewServingProjectorWorkerDatabase,
) => {
  if (!canRunDisplayRebuildChunkBatch(input.chunks)) {
    return null
  }

  const [firstChunk] = input.chunks
  if (firstChunk === undefined) {
    return null
  }

  const projectId = requireRebuildChunkProjectId(firstChunk)
  const snapshots = await getRebuildChunkSnapshots(firstChunk, database)
  const snapshotIds = snapshots.map((snapshot) => {
    return snapshot.snapshotId
  })

  const batchWriteStartedAtMs = Date.now()
  await database.transaction(async (tx) => {
    await input.chunks.reduce<Promise<void>>(async (previous, chunk) => {
      await previous
      await requireClaimedRebuildChunk({chunk, leaseOwner: input.leaseOwner}, tx)
    }, Promise.resolve())

    const chunkDatabase = getChunkProjectorDatabase(tx)

    await snapshots.reduce<Promise<void>>(async (previous, snapshot) => {
      await previous
      await projectReviewServingDisplayBaseRanges(
        {
          ranges: input.chunks.map((chunk) => {
            return {
              baseGeneration: chunk.outputBaseGeneration,
              chunkEndArticleId: chunk.chunkEndKey,
              chunkStartArticleId: chunk.chunkStartKey,
              displayIdentity: chunk.projectionIdentity,
              humanStatusIdentity: requireSnapshotComponentIdentity(snapshot, 'humanStatus'),
              listModeKeys: reviewServingListModes,
              llmStatusIdentity: requireSnapshotComponentIdentity(snapshot, 'llmStatus'),
              payloadIdentity: requireSnapshotComponentIdentity(snapshot, 'payload'),
              postingIdentity: requireSnapshotComponentIdentity(snapshot, 'posting'),
              projectId,
              projectScopeIdentity: requireSnapshotComponentIdentity(snapshot, 'projectScope'),
              reviewConfigHash: requireReviewConfigHash(snapshot),
              selectedImportIdentity: requireSnapshotComponentIdentity(snapshot, 'selectedImport'),
              selectedImportSnapshotId: requireSelectedImportSnapshotId(snapshot),
              snapshotId: snapshot.snapshotId,
              summaryIdentity: requireSnapshotComponentIdentity(snapshot, 'summary'),
            }
          }),
        },
        chunkDatabase,
      )
    }, Promise.resolve())
  })
  const batchWriteMs = getNonNegativeElapsedMs(batchWriteStartedAtMs)

  await input.chunks.reduce<Promise<void>>(async (previous, chunk) => {
    await previous
    await completeDisplayRebuildChunkAfterBatchWrite(
      {batchRangeCount: input.chunks.length, batchWriteMs, chunk, leaseOwner: input.leaseOwner, snapshotIds},
      database,
    )
  }, Promise.resolve())

  return input.chunks.map((chunk) => {
    return {
      chunkId: chunk.chunkId,
      projectionComponent: chunk.projectionComponent,
      requestId: chunk.requestId,
      status: 'completed' as const,
    }
  })
}

const canRunPayloadRebuildChunkBatch = (chunks: readonly ReviewServingRebuildChunkManifest[]) => {
  return (
    chunks.length > 1
    && chunks.every((chunk) => {
      return chunk.projectionComponent === 'payload' && chunk.requestId === null
    })
  )
}

const completePayloadRebuildChunkAfterBatchWrite = async (
  input: {
    batchRangeCount: number
    batchWriteMs: number
    chunk: ReviewServingRebuildChunkManifest
    leaseOwner: string
    snapshotIds: readonly string[]
  },
  database: ReviewServingChunkManifestRepositoryDatabase,
) => {
  const completedChunk = await writeReviewServingRebuildChunkOutput(
    {
      ...input.chunk,
      diagnosticsJson: {
        payloadBatchWriter: {rangeCount: input.batchRangeCount},
        phaseTimings: {batchWriteMs: input.batchWriteMs},
      },
      leaseOwner: input.leaseOwner,
      validateOutput: async (tx) => {
        return getRebuildChunkOutputValidation({
          chunk: input.chunk,
          getChecksum: () => {
            return getPayloadRebuildChunkOutputChecksum({chunk: input.chunk, snapshotIds: input.snapshotIds}, tx)
          },
          getCount: () => {
            return getPayloadRebuildChunkOutputCount({chunk: input.chunk, snapshotIds: input.snapshotIds}, tx)
          },
        })
      },
      writeOutput: async () => {
        return {diagnosticsJson: {payloadBatchWriter: {writeOutputAlreadyCompleted: true}}}
      },
    },
    database,
  )

  if (completedChunk === null) {
    throw new Error(`review serving rebuild chunk ${input.chunk.chunkId} is no longer claimed by ${input.leaseOwner}`)
  }
}

const runPayloadRebuildChunkBatch = async (
  input: {chunks: readonly ReviewServingRebuildChunkManifest[]; leaseOwner: string},
  database: ReviewServingChunkManifestRepositoryDatabase & ReviewServingProjectorWorkerDatabase,
) => {
  if (!canRunPayloadRebuildChunkBatch(input.chunks)) {
    return null
  }

  const [firstChunk] = input.chunks
  if (firstChunk === undefined) {
    return null
  }

  const projectId = requireRebuildChunkProjectId(firstChunk)
  const snapshots = await getRebuildChunkSnapshots(firstChunk, database)
  const snapshotIds = getRebuildSnapshotIds(snapshots)

  const batchWriteStartedAtMs = Date.now()
  await database.transaction(async (tx) => {
    await input.chunks.reduce<Promise<void>>(async (previous, chunk) => {
      await previous
      await requireClaimedRebuildChunk({chunk, leaseOwner: input.leaseOwner}, tx)
    }, Promise.resolve())

    const chunkDatabase = getChunkProjectorDatabase(tx)

    await snapshots.reduce<Promise<void>>(async (previous, snapshot) => {
      await previous
      await projectReviewServingPayloadRanges(
        {
          ranges: input.chunks.map((chunk) => {
            return {
              baseGeneration: chunk.outputBaseGeneration,
              chunkEndArticleId: chunk.chunkEndKey,
              chunkStartArticleId: chunk.chunkStartKey,
              displayIdentity: requireSnapshotComponentIdentity(snapshot, 'display'),
              payloadIdentity: chunk.projectionIdentity,
              projectId,
              selectedImportSnapshotId: requireSelectedImportSnapshotId(snapshot),
              snapshotId: snapshot.snapshotId,
            }
          }),
        },
        chunkDatabase,
      )
    }, Promise.resolve())
  })
  const batchWriteMs = getNonNegativeElapsedMs(batchWriteStartedAtMs)

  await input.chunks.reduce<Promise<void>>(async (previous, chunk) => {
    await previous
    await completePayloadRebuildChunkAfterBatchWrite(
      {batchRangeCount: input.chunks.length, batchWriteMs, chunk, leaseOwner: input.leaseOwner, snapshotIds},
      database,
    )
  }, Promise.resolve())

  return input.chunks.map((chunk) => {
    return {
      chunkId: chunk.chunkId,
      projectionComponent: chunk.projectionComponent,
      requestId: chunk.requestId,
      status: 'completed' as const,
    }
  })
}

const canRunSearchRebuildChunkBatch = (chunks: readonly ReviewServingRebuildChunkManifest[]) => {
  return (
    chunks.length > 1
    && chunks.every((chunk) => {
      return chunk.projectionComponent === 'search' && chunk.requestId === chunks[0]?.requestId
    })
  )
}

const completeSearchRebuildChunkAfterBatchWrite = async (
  input: {
    batchRangeCount: number
    batchWriteMs: number
    chunk: ReviewServingRebuildChunkManifest
    leaseOwner: string
    snapshotIds: readonly string[]
  },
  database: ReviewServingChunkManifestRepositoryDatabase,
) => {
  const completedChunk = await writeReviewServingRebuildChunkOutput(
    {
      ...input.chunk,
      diagnosticsJson: {
        phaseTimings: {batchWriteMs: input.batchWriteMs},
        searchBatchWriter: {rangeCount: input.batchRangeCount},
      },
      leaseOwner: input.leaseOwner,
      validateOutput: async (tx) => {
        return getRebuildChunkOutputValidation({
          chunk: input.chunk,
          getChecksum: () => {
            return getSearchRebuildChunkOutputChecksum({chunk: input.chunk, snapshotIds: input.snapshotIds}, tx)
          },
          getCount: () => {
            return getSearchRebuildChunkOutputCount({chunk: input.chunk, snapshotIds: input.snapshotIds}, tx)
          },
        })
      },
      writeOutput: async () => {
        return {diagnosticsJson: {searchBatchWriter: {writeOutputAlreadyCompleted: true}}}
      },
    },
    database,
  )

  if (completedChunk === null) {
    throw new Error(`review serving rebuild chunk ${input.chunk.chunkId} is no longer claimed by ${input.leaseOwner}`)
  }
}

const runSearchRebuildChunkBatch = async (
  input: {chunks: readonly ReviewServingRebuildChunkManifest[]; leaseOwner: string},
  database: ReviewServingChunkManifestRepositoryDatabase & ReviewServingProjectorWorkerDatabase,
) => {
  if (!canRunSearchRebuildChunkBatch(input.chunks)) {
    return null
  }

  const [firstChunk] = input.chunks
  if (firstChunk === undefined) {
    return null
  }

  const projectId = requireRebuildChunkProjectId(firstChunk)
  const snapshots = await getRebuildChunkSnapshots(firstChunk, database)
  const snapshotIds = snapshots.map((snapshot) => {
    return snapshot.snapshotId
  })

  const batchWriteStartedAtMs = Date.now()
  await snapshots.reduce<Promise<void>>(async (previousSnapshot, snapshot) => {
    await previousSnapshot
    await input.chunks.reduce<Promise<void>>(async (previousChunk, chunk) => {
      await previousChunk
      await database.transaction(async (tx) => {
        await requireClaimedRebuildChunk({chunk, leaseOwner: input.leaseOwner}, tx)
        await projectReviewServingTitleSearchRebuildRanges(
          {
            ranges: [
              {
                baseGeneration: chunk.outputBaseGeneration,
                chunkEndArticleId: chunk.chunkEndKey,
                chunkStartArticleId: chunk.chunkStartKey,
                projectId,
                projectScopeIdentity: requireSnapshotComponentIdentity(snapshot, 'projectScope'),
                searchIdentity: chunk.projectionIdentity,
                selectedImportSnapshotId: requireSelectedImportSnapshotId(snapshot),
                snapshotId: snapshot.snapshotId,
              },
            ],
          },
          getChunkProjectorDatabase(tx),
        )
      })
    }, Promise.resolve())
  }, Promise.resolve())
  const batchWriteMs = getNonNegativeElapsedMs(batchWriteStartedAtMs)

  await input.chunks.reduce<Promise<void>>(async (previous, chunk) => {
    await previous
    await completeSearchRebuildChunkAfterBatchWrite(
      {batchRangeCount: input.chunks.length, batchWriteMs, chunk, leaseOwner: input.leaseOwner, snapshotIds},
      database,
    )
  }, Promise.resolve())

  return input.chunks.map((chunk) => {
    return {
      chunkId: chunk.chunkId,
      projectionComponent: chunk.projectionComponent,
      requestId: chunk.requestId,
      status: 'completed' as const,
    }
  })
}

const canRunQueueRebuildChunkBatch = (chunks: readonly ReviewServingRebuildChunkManifest[]) => {
  return (
    chunks.length > 1
    && chunks.every((chunk) => {
      return chunk.projectionComponent === 'queue' && chunk.requestId === chunks[0]?.requestId
    })
  )
}

const completeQueueRebuildChunkAfterBatchWrite = async (
  input: {
    batchRangeCount: number
    batchWriteMs: number
    chunk: ReviewServingRebuildChunkManifest
    leaseOwner: string
    snapshotIds: readonly string[]
  },
  database: ReviewServingChunkManifestRepositoryDatabase,
) => {
  const completedChunk = await writeReviewServingRebuildChunkOutput(
    {
      ...input.chunk,
      diagnosticsJson: {
        phaseTimings: {batchWriteMs: input.batchWriteMs},
        queueBatchWriter: {rangeCount: input.batchRangeCount},
      },
      leaseOwner: input.leaseOwner,
      validateOutput: async (tx) => {
        return getRebuildChunkOutputValidation({
          chunk: input.chunk,
          getChecksum: () => {
            return getQueueRebuildChunkOutputChecksum({chunk: input.chunk, snapshotIds: input.snapshotIds}, tx)
          },
          getCount: () => {
            return getQueueRebuildChunkOutputCount({chunk: input.chunk, snapshotIds: input.snapshotIds}, tx)
          },
        })
      },
      writeOutput: async () => {
        return {diagnosticsJson: {queueBatchWriter: {writeOutputAlreadyCompleted: true}}}
      },
    },
    database,
  )

  if (completedChunk === null) {
    throw new Error(`review serving rebuild chunk ${input.chunk.chunkId} is no longer claimed by ${input.leaseOwner}`)
  }
}

const runQueueRebuildChunkBatch = async (
  input: {chunks: readonly ReviewServingRebuildChunkManifest[]; leaseOwner: string},
  database: ReviewServingChunkManifestRepositoryDatabase & ReviewServingProjectorWorkerDatabase,
) => {
  if (!canRunQueueRebuildChunkBatch(input.chunks)) {
    return null
  }

  const [firstChunk] = input.chunks
  if (firstChunk === undefined) {
    return null
  }

  const projectId = requireRebuildChunkProjectId(firstChunk)
  const snapshots = await getRebuildChunkSnapshots(firstChunk, database)
  const snapshotIds = getRebuildSnapshotIds(snapshots)

  const batchWriteStartedAtMs = Date.now()
  await database.transaction(async (tx) => {
    await input.chunks.reduce<Promise<void>>(async (previous, chunk) => {
      await previous
      await requireClaimedRebuildChunk({chunk, leaseOwner: input.leaseOwner}, tx)
    }, Promise.resolve())

    const chunkDatabase = getChunkProjectorDatabase(tx)

    await snapshots.reduce<Promise<void>>(async (previous, snapshot) => {
      await previous
      await projectReviewServingQueueRebuildRanges(
        {
          ranges: input.chunks.map((chunk) => {
            return {
              baseGeneration: chunk.outputBaseGeneration,
              chunkEndArticleId: chunk.chunkEndKey,
              chunkStartArticleId: chunk.chunkStartKey,
              projectId,
              projectScopeIdentity: requireSnapshotComponentIdentity(snapshot, 'projectScope'),
              reviewConfigHash: requireReviewConfigHash(snapshot),
              selectedImportSnapshotId: requireSelectedImportSnapshotId(snapshot),
              snapshotId: snapshot.snapshotId,
            }
          }),
        },
        chunkDatabase,
      )
    }, Promise.resolve())
  })
  const batchWriteMs = getNonNegativeElapsedMs(batchWriteStartedAtMs)

  await input.chunks.reduce<Promise<void>>(async (previous, chunk) => {
    await previous
    await completeQueueRebuildChunkAfterBatchWrite(
      {batchRangeCount: input.chunks.length, batchWriteMs, chunk, leaseOwner: input.leaseOwner, snapshotIds},
      database,
    )
  }, Promise.resolve())

  return input.chunks.map((chunk) => {
    return {
      chunkId: chunk.chunkId,
      projectionComponent: chunk.projectionComponent,
      requestId: chunk.requestId,
      status: 'completed' as const,
    }
  })
}

const canRunJudgmentInputContentRebuildChunkBatch = (chunks: readonly ReviewServingRebuildChunkManifest[]) => {
  return (
    chunks.length > 1
    && chunks.every((chunk) => {
      return chunk.projectionComponent === 'judgmentInputContent' && chunk.requestId === null
    })
  )
}

const completeJudgmentInputContentRebuildChunkAfterBatchWrite = async (
  input: {
    batchRangeCount: number
    chunk: ReviewServingRebuildChunkManifest
    leaseOwner: string
    snapshotIds: readonly string[]
  },
  database: ReviewServingChunkManifestRepositoryDatabase,
) => {
  const completedChunk = await writeReviewServingRebuildChunkOutput(
    {
      ...input.chunk,
      diagnosticsJson: {judgmentInputContentBatchWriter: {rangeCount: input.batchRangeCount}},
      leaseOwner: input.leaseOwner,
      validateOutput: async (tx) => {
        return getRebuildChunkOutputValidation({
          chunk: input.chunk,
          getChecksum: () => {
            return getJudgmentInputContentRebuildChunkOutputChecksum(
              {chunk: input.chunk, snapshotIds: input.snapshotIds},
              tx,
            )
          },
          getCount: () => {
            return getJudgmentInputContentRebuildChunkOutputCount(
              {chunk: input.chunk, snapshotIds: input.snapshotIds},
              tx,
            )
          },
        })
      },
      writeOutput: async () => {
        return {diagnosticsJson: {judgmentInputContentBatchWriter: {writeOutputAlreadyCompleted: true}}}
      },
    },
    database,
  )

  if (completedChunk === null) {
    throw new Error(`review serving rebuild chunk ${input.chunk.chunkId} is no longer claimed by ${input.leaseOwner}`)
  }
}

const runJudgmentInputContentRebuildChunkBatch = async (
  input: {chunks: readonly ReviewServingRebuildChunkManifest[]; leaseOwner: string},
  database: ReviewServingChunkManifestRepositoryDatabase & ReviewServingProjectorWorkerDatabase,
) => {
  if (!canRunJudgmentInputContentRebuildChunkBatch(input.chunks)) {
    return null
  }

  const [firstChunk] = input.chunks
  if (firstChunk === undefined) {
    return null
  }

  const projectId = requireRebuildChunkProjectId(firstChunk)
  const manifest = await requireRebuildChunkProjectionManifest(firstChunk, database)
  const snapshots = await getRebuildChunkSnapshots(firstChunk, database)
  const snapshotIds = getRebuildSnapshotIds(snapshots)
  const currentSettings = await getCurrentProjectReviewSnapshotSettings(projectId, database)
  const payloadSnapshots = snapshots.filter((snapshot) => {
    return getSnapshotReviewSettings(snapshot, currentSettings) !== null
  })

  await database.transaction(async (tx) => {
    await input.chunks.reduce<Promise<void>>(async (previous, chunk) => {
      await previous
      await requireClaimedRebuildChunk({chunk, leaseOwner: input.leaseOwner}, tx)
    }, Promise.resolve())

    const chunkDatabase = getChunkProjectorDatabase(tx)

    await payloadSnapshots.reduce<Promise<void>>(async (previous, snapshot) => {
      await previous
      const project = getSnapshotReviewSettings(snapshot, currentSettings)

      if (project === null) {
        return
      }

      await projectReviewServingJudgmentPayloadArticleRanges(
        {
          ranges: input.chunks.map((chunk) => {
            return {
              acknowledgeClaims: false,
              baseGeneration: chunk.outputBaseGeneration,
              chunkEndArticleId: chunk.chunkEndKey,
              chunkStartArticleId: chunk.chunkStartKey,
              claims: [],
              definitionVersion: manifest.definitionVersion,
              listModeKeys: reviewServingListModes,
              modelId: project.modelId,
              projectId,
              projectionIdentity: chunk.projectionIdentity,
              reviewConfigHash: requireReviewConfigHash(snapshot),
              snapshotId: snapshot.snapshotId,
              useAbstract: project.useAbstract,
              useFulltext: project.useFulltext,
              useFulltextNoImages: project.useFulltextNoImages,
              useTitle: project.useTitle,
            }
          }),
        },
        chunkDatabase,
      )
    }, Promise.resolve())
  })

  await input.chunks.reduce<Promise<void>>(async (previous, chunk) => {
    await previous
    await completeJudgmentInputContentRebuildChunkAfterBatchWrite(
      {batchRangeCount: input.chunks.length, chunk, leaseOwner: input.leaseOwner, snapshotIds},
      database,
    )
  }, Promise.resolve())

  return input.chunks.map((chunk) => {
    return {
      chunkId: chunk.chunkId,
      projectionComponent: chunk.projectionComponent,
      requestId: chunk.requestId,
      status: 'completed' as const,
    }
  })
}

const canRunLlmStatusRebuildChunkBatch = (chunks: readonly ReviewServingRebuildChunkManifest[]) => {
  return (
    chunks.length > 1
    && chunks.every((chunk) => {
      return chunk.projectionComponent === 'llmStatus'
    })
    && chunks.every((chunk) => {
      return chunk.requestId === chunks[0]?.requestId
    })
  )
}

const completeLlmStatusRebuildChunkAfterBatchWrite = async (
  input: {
    batchRangeCount: number
    batchWriteMs: number
    chunk: ReviewServingRebuildChunkManifest
    leaseOwner: string
    snapshotIds: readonly string[]
  },
  database: ReviewServingChunkManifestRepositoryDatabase,
) => {
  const completedChunk = await writeReviewServingRebuildChunkOutput(
    {
      ...input.chunk,
      diagnosticsJson: {
        llmStatusBatchWriter: {rangeCount: input.batchRangeCount},
        phaseTimings: {batchWriteMs: input.batchWriteMs},
      },
      leaseOwner: input.leaseOwner,
      validateOutput: async (tx) => {
        return getRebuildChunkOutputValidation({
          chunk: input.chunk,
          getChecksum: () => {
            return getLlmStatusRebuildChunkOutputChecksum({chunk: input.chunk, snapshotIds: input.snapshotIds}, tx)
          },
          getCount: () => {
            return getLlmStatusRebuildChunkOutputCount({chunk: input.chunk, snapshotIds: input.snapshotIds}, tx)
          },
        })
      },
      writeOutput: async () => {
        return {diagnosticsJson: {llmStatusBatchWriter: {writeOutputAlreadyCompleted: true}}}
      },
    },
    database,
  )

  if (completedChunk === null) {
    throw new Error(`review serving rebuild chunk ${input.chunk.chunkId} is no longer claimed by ${input.leaseOwner}`)
  }
}

const runLlmStatusRebuildChunkBatch = async (
  input: {chunks: readonly ReviewServingRebuildChunkManifest[]; leaseOwner: string},
  database: ReviewServingChunkManifestRepositoryDatabase & ReviewServingProjectorWorkerDatabase,
) => {
  if (!canRunLlmStatusRebuildChunkBatch(input.chunks)) {
    return null
  }

  const [firstChunk] = input.chunks
  if (firstChunk === undefined) {
    return null
  }

  const projectId = requireRebuildChunkProjectId(firstChunk)
  const manifest = await requireRebuildChunkProjectionManifest(firstChunk, database)
  const snapshots = await getRebuildChunkSnapshots(firstChunk, database)
  const snapshotIds = getRebuildSnapshotIds(snapshots)

  const batchWriteStartedAtMs = Date.now()
  await database.transaction(async (tx) => {
    await input.chunks.reduce<Promise<void>>(async (previous, chunk) => {
      await previous
      await requireClaimedRebuildChunk({chunk, leaseOwner: input.leaseOwner}, tx)
    }, Promise.resolve())

    const chunkDatabase = getChunkProjectorDatabase(tx)

    await input.chunks.reduce<Promise<void>>(async (previous, chunk) => {
      await previous
      await projectReviewServingLlmStatusPatches(
        {
          baseGeneration: chunk.outputBaseGeneration,
          chunkEndArticleId: chunk.chunkEndKey,
          chunkStartArticleId: chunk.chunkStartKey,
          claims: [],
          definitionVersion: manifest.definitionVersion,
          listModeKeys: defaultReviewServingLlmListModeKeys,
          projectId,
          projectionIdentity: chunk.projectionIdentity,
        },
        chunkDatabase,
      )
    }, Promise.resolve())
  })
  const batchWriteMs = getNonNegativeElapsedMs(batchWriteStartedAtMs)

  await input.chunks.reduce<Promise<void>>(async (previous, chunk) => {
    await previous
    await completeLlmStatusRebuildChunkAfterBatchWrite(
      {batchRangeCount: input.chunks.length, batchWriteMs, chunk, leaseOwner: input.leaseOwner, snapshotIds},
      database,
    )
  }, Promise.resolve())

  return input.chunks.map((chunk) => {
    return {
      chunkId: chunk.chunkId,
      projectionComponent: chunk.projectionComponent,
      requestId: chunk.requestId,
      status: 'completed' as const,
    }
  })
}

const canRunHumanStatusRebuildChunkBatch = (chunks: readonly ReviewServingRebuildChunkManifest[]) => {
  return (
    chunks.length > 1
    && chunks.every((chunk) => {
      return chunk.projectionComponent === 'humanStatus'
    })
    && chunks.every((chunk) => {
      return chunk.requestId === chunks[0]?.requestId
    })
  )
}

const completeHumanStatusRebuildChunkAfterBatchWrite = async (
  input: {
    batchRangeCount: number
    batchWriteMs: number
    chunk: ReviewServingRebuildChunkManifest
    leaseOwner: string
    snapshotIds: readonly string[]
  },
  database: ReviewServingChunkManifestRepositoryDatabase,
) => {
  const completedChunk = await writeReviewServingRebuildChunkOutput(
    {
      ...input.chunk,
      diagnosticsJson: {
        humanStatusBatchWriter: {rangeCount: input.batchRangeCount},
        phaseTimings: {batchWriteMs: input.batchWriteMs},
      },
      leaseOwner: input.leaseOwner,
      validateOutput: async (tx) => {
        return getRebuildChunkOutputValidation({
          chunk: input.chunk,
          getChecksum: () => {
            return getHumanStatusRebuildChunkOutputChecksum({chunk: input.chunk, snapshotIds: input.snapshotIds}, tx)
          },
          getCount: () => {
            return getHumanStatusRebuildChunkOutputCount({chunk: input.chunk, snapshotIds: input.snapshotIds}, tx)
          },
        })
      },
      writeOutput: async () => {
        return {diagnosticsJson: {humanStatusBatchWriter: {writeOutputAlreadyCompleted: true}}}
      },
    },
    database,
  )

  if (completedChunk === null) {
    throw new Error(`review serving rebuild chunk ${input.chunk.chunkId} is no longer claimed by ${input.leaseOwner}`)
  }
}

const runHumanStatusRebuildChunkBatch = async (
  input: {chunks: readonly ReviewServingRebuildChunkManifest[]; leaseOwner: string},
  database: ReviewServingChunkManifestRepositoryDatabase & ReviewServingProjectorWorkerDatabase,
) => {
  if (!canRunHumanStatusRebuildChunkBatch(input.chunks)) {
    return null
  }

  const [firstChunk] = input.chunks
  if (firstChunk === undefined) {
    return null
  }

  const projectId = requireRebuildChunkProjectId(firstChunk)
  const manifest = await requireRebuildChunkProjectionManifest(firstChunk, database)
  const snapshots = await getRebuildChunkSnapshots(firstChunk, database)
  const snapshotIds = getRebuildSnapshotIds(snapshots)

  const batchWriteStartedAtMs = Date.now()
  await database.transaction(async (tx) => {
    await input.chunks.reduce<Promise<void>>(async (previous, chunk) => {
      await previous
      await requireClaimedRebuildChunk({chunk, leaseOwner: input.leaseOwner}, tx)
    }, Promise.resolve())

    const chunkDatabase = getChunkProjectorDatabase(tx)

    await input.chunks.reduce<Promise<void>>(async (previous, chunk) => {
      await previous
      await projectReviewServingHumanStatusPatches(
        {
          acknowledgeClaims: false,
          baseGeneration: chunk.outputBaseGeneration,
          chunkEndArticleId: chunk.chunkEndKey,
          chunkStartArticleId: chunk.chunkStartKey,
          claims: [],
          definitionVersion: manifest.definitionVersion,
          listModeKeys: defaultReviewServingHumanListModeKeys,
          projectId,
          projectionIdentity: chunk.projectionIdentity,
        },
        chunkDatabase,
      )
    }, Promise.resolve())
  })
  const batchWriteMs = getNonNegativeElapsedMs(batchWriteStartedAtMs)

  await input.chunks.reduce<Promise<void>>(async (previous, chunk) => {
    await previous
    await completeHumanStatusRebuildChunkAfterBatchWrite(
      {batchRangeCount: input.chunks.length, batchWriteMs, chunk, leaseOwner: input.leaseOwner, snapshotIds},
      database,
    )
  }, Promise.resolve())

  return input.chunks.map((chunk) => {
    return {
      chunkId: chunk.chunkId,
      projectionComponent: chunk.projectionComponent,
      requestId: chunk.requestId,
      status: 'completed' as const,
    }
  })
}

const canRunPostingRebuildChunkBatch = (chunks: readonly ReviewServingRebuildChunkManifest[]) => {
  return (
    chunks.length > 1
    && chunks.every((chunk) => {
      return chunk.projectionComponent === 'posting' && chunk.requestId === chunks[0]?.requestId
    })
  )
}

const completePostingRebuildChunkAfterBatchWrite = async (
  input: {
    batchRangeCount: number
    chunk: ReviewServingRebuildChunkManifest
    leaseOwner: string
    snapshotIds: readonly string[]
  },
  database: ReviewServingChunkManifestRepositoryDatabase,
) => {
  const completedChunk = await writeReviewServingRebuildChunkOutput(
    {
      ...input.chunk,
      diagnosticsJson: {postingBatchWriter: {rangeCount: input.batchRangeCount}},
      leaseOwner: input.leaseOwner,
      validateOutput: async (tx) => {
        return getRebuildChunkOutputValidation({
          chunk: input.chunk,
          getChecksum: () => {
            return getPostingRebuildChunkOutputChecksum({chunk: input.chunk, snapshotIds: input.snapshotIds}, tx)
          },
          getCount: () => {
            return getPostingRebuildChunkOutputCount({chunk: input.chunk, snapshotIds: input.snapshotIds}, tx)
          },
        })
      },
      writeOutput: async () => {
        return {diagnosticsJson: {postingBatchWriter: {writeOutputAlreadyCompleted: true}}}
      },
    },
    database,
  )

  if (completedChunk === null) {
    throw new Error(`review serving rebuild chunk ${input.chunk.chunkId} is no longer claimed by ${input.leaseOwner}`)
  }
}

const runPostingRebuildChunkBatch = async (
  input: {chunks: readonly ReviewServingRebuildChunkManifest[]; leaseOwner: string},
  database: ReviewServingChunkManifestRepositoryDatabase & ReviewServingProjectorWorkerDatabase,
) => {
  if (!canRunPostingRebuildChunkBatch(input.chunks)) {
    return null
  }

  const [firstChunk] = input.chunks
  if (firstChunk === undefined) {
    return null
  }

  const projectId = requireRebuildChunkProjectId(firstChunk)
  const manifest = await requireRebuildChunkProjectionManifest(firstChunk, database)
  const snapshots = await getRebuildChunkSnapshots(firstChunk, database)
  const snapshotIds = getRebuildSnapshotIds(snapshots)

  await database.transaction(async (tx) => {
    await input.chunks.reduce<Promise<void>>(async (previous, chunk) => {
      await previous
      await requireClaimedRebuildChunk({chunk, leaseOwner: input.leaseOwner}, tx)
    }, Promise.resolve())

    const chunkDatabase = getChunkProjectorDatabase(tx)

    await snapshots.reduce<Promise<void>>(async (previousSnapshot, snapshot) => {
      await previousSnapshot
      await input.chunks.reduce<Promise<void>>(async (previousChunk, chunk) => {
        await previousChunk
        await projectReviewServingFilterPostings(
          {
            acknowledgeClaims: false,
            baseGeneration: chunk.outputBaseGeneration,
            chunkEndArticleId: chunk.chunkEndKey,
            chunkStartArticleId: chunk.chunkStartKey,
            claims: [],
            definitionVersion: manifest.definitionVersion,
            listModeKeys: reviewServingListModes,
            projectId,
            projectScopeIdentity: requireSnapshotComponentIdentity(snapshot, 'projectScope'),
            projectionIdentity: chunk.projectionIdentity,
            refreshFullRebuildStats: false,
            reviewConfigHash: requireReviewConfigHash(snapshot),
            selectedImportSnapshotId: requireSelectedImportSnapshotId(snapshot),
            snapshotId: snapshot.snapshotId,
          },
          chunkDatabase,
        )
      }, Promise.resolve())
      await refreshReviewServingFilterPostingStats(
        {projectId, reviewConfigHash: requireReviewConfigHash(snapshot), snapshotId: snapshot.snapshotId},
        chunkDatabase,
      )
    }, Promise.resolve())
  })

  await input.chunks.reduce<Promise<void>>(async (previous, chunk) => {
    await previous
    await completePostingRebuildChunkAfterBatchWrite(
      {batchRangeCount: input.chunks.length, chunk, leaseOwner: input.leaseOwner, snapshotIds},
      database,
    )
  }, Promise.resolve())

  return input.chunks.map((chunk) => {
    return {
      chunkId: chunk.chunkId,
      projectionComponent: chunk.projectionComponent,
      requestId: chunk.requestId,
      status: 'completed' as const,
    }
  })
}

export const runReviewServingProjectorWorkerClaimedRebuildChunk = async (
  input: {chunk: ReviewServingRebuildChunkManifest; leaseOwner: string},
  database: ReviewServingChunkManifestRepositoryDatabase & ReviewServingProjectorWorkerDatabase,
) => {
  const effectiveInput = isRequestlessSummaryRangeRebuildChunk(input.chunk)
    ? {...input, chunk: await adoptRequestlessRebuildChunk(input, database)}
    : input

  try {
    if (effectiveInput.chunk.projectionComponent === 'projectScope') {
      return await runProjectScopeRebuildChunk(effectiveInput, database)
    }

    if (effectiveInput.chunk.projectionComponent === 'selectedImport') {
      return await runSelectedImportRebuildChunk(effectiveInput, database)
    }

    if (effectiveInput.chunk.projectionComponent === 'display') {
      return await runDisplayRebuildChunk(effectiveInput, database)
    }

    if (effectiveInput.chunk.projectionComponent === 'payload') {
      return await runPayloadRebuildChunk(effectiveInput, database)
    }

    if (effectiveInput.chunk.projectionComponent === 'search') {
      return await runSearchRebuildChunk(effectiveInput, database)
    }

    if (effectiveInput.chunk.projectionComponent === 'llmStatus') {
      return await runLlmStatusRebuildChunk(effectiveInput, database)
    }

    if (effectiveInput.chunk.projectionComponent === 'humanStatus') {
      return await runHumanStatusRebuildChunk(effectiveInput, database)
    }

    if (effectiveInput.chunk.projectionComponent === 'queue') {
      return await runQueueRebuildChunk(effectiveInput, database)
    }

    if (effectiveInput.chunk.projectionComponent === 'posting') {
      return await runPostingRebuildChunk(effectiveInput, database)
    }

    if (effectiveInput.chunk.projectionComponent === 'summary') {
      return await runSummaryRebuildChunk(effectiveInput, database)
    }

    if (effectiveInput.chunk.projectionComponent === 'judgmentInputContent') {
      return await runJudgmentInputContentRebuildChunk(effectiveInput, database)
    }
  } catch (error) {
    const split =
      isDuckDbOutOfMemoryError(error)
      && splittableArticleRangeRebuildComponents.has(effectiveInput.chunk.projectionComponent)
        ? await splitClaimedArticleRangeRebuildChunk(
            {
              chunk: effectiveInput.chunk,
              leaseOwner: effectiveInput.leaseOwner,
              projectId: requireRebuildChunkProjectId(effectiveInput.chunk),
              splitReason: 'duckdb_oom',
            },
            database,
          )
        : false

    if (split) {
      return {status: 'completed' as const}
    }

    throw error
  }

  throw new Error(
    `review serving rebuild chunk executor is not registered for ${(effectiveInput.chunk as {projectionComponent: string}).projectionComponent}`,
  )
}

const requireReviewConfigHash = (snapshot: ReviewServingSnapshotContext) => {
  if (snapshot.reviewConfigHash === null) {
    throw new Error(`cannot run projector without review config hash in snapshot ${snapshot.snapshotId}`)
  }

  return snapshot.reviewConfigHash
}

const requireSelectedImportSnapshotId = (snapshot: ReviewServingSnapshotContext) => {
  if (snapshot.selectedImportSnapshotId === null) {
    throw new Error(`cannot run projector without selected import snapshot id in snapshot ${snapshot.snapshotId}`)
  }

  return snapshot.selectedImportSnapshotId
}

const getSelectedImportSnapshotStatus = async (
  selectedImportSnapshotId: string,
  database: ReviewServingProjectorWorkerDatabase,
) => {
  const [row] = await database.queryJson<SelectedImportSnapshotStatusRow>(`
    SELECT
      source_delta_high_water AS sourceDeltaHighWater,
      status
    FROM app.review_selected_import_snapshot
    WHERE selected_import_snapshot_id = ${getSqlLiteral(selectedImportSnapshotId)}
    LIMIT 1
  `)

  return row ?? null
}

const getPatchWatermark = (claims: readonly {latestSourceHighWaterMark: number}[]) => {
  return Math.max(
    0,
    ...claims.map((claim) => {
      return claim.latestSourceHighWaterMark
    }),
  )
}

const getSelectedImportBaseProjectionResult = async (
  input: {
    claims: Parameters<ReviewServingProjectorRunner>[0]['claims']
    projectId: string
    projectScopeIdentity: string
    selectedImportSnapshotId: string
  },
  database: ReviewServingProjectorWorkerDatabase,
) => {
  const existingSnapshot = await getSelectedImportSnapshotStatus(input.selectedImportSnapshotId, database)

  return existingSnapshot?.status === 'completed'
    ? {insertedRowCount: 0, selectedImportSnapshotId: input.selectedImportSnapshotId, status: 'completed' as const}
    : projectReviewServingSelectedImportBatch(
        {
          limit: defaultReviewServingSelectedImportBaseBatchSize,
          projectId: input.projectId,
          projectScopeIdentity: input.projectScopeIdentity,
          selectedImportSnapshotId: input.selectedImportSnapshotId,
          sourceDeltaHighWater: Number(existingSnapshot?.sourceDeltaHighWater ?? getPatchWatermark(input.claims)),
        },
        database,
      )
}

const getProjectReviewSettings = async (projectId: string, database: ReviewServingProjectorWorkerDatabase) => {
  const rows = await database.queryJson<ProjectReviewSettingsRow>(`
    SELECT
      COALESCE(project.human_judgment_mode, 'prompt') AS humanJudgmentMode,
      project.model_id AS modelId,
      model.provider_connection_id AS modelProviderConnectionId,
      provider_connection.provider_kind AS modelProviderKind,
      provider_connection.base_url AS modelProviderBaseUrl,
      model.remote_model_id AS modelRemoteModelId,
      model.variant AS modelVariant,
      TO_JSON(json_extract(model.metadata_json, '$.options')) AS modelExecutionOptions,
      project.use_title AS useTitle,
      project.use_abstract AS useAbstract,
      project.use_fulltext AS useFulltext,
      project.use_fulltext_no_images AS useFulltextNoImages
    FROM app.project project
    LEFT JOIN app.model model
      ON model.id = project.model_id
    LEFT JOIN app.provider_connection provider_connection
      ON provider_connection.id = model.provider_connection_id
    WHERE project.id = ${getSqlLiteral(projectId)}
    LIMIT 1
  `)
  const row = rows[0]

  if (row === undefined) {
    throw new Error(`cannot run projector without review settings for project ${projectId}`)
  }

  return row
}

const getProjectPromptConfigRows = async (projectId: string, database: ReviewServingProjectorWorkerDatabase) => {
  return database.queryJson<ProjectPromptConfigRow>(`
    SELECT
      prompt.id AS promptId,
      project_prompt.prompt_order AS promptOrder,
      COALESCE(prompt.content_hash, sha256(prompt.original_text)) AS promptTextHash,
      NULL AS answerSchemaHash,
      'prompt-v1' AS settingsVersion,
      NULL AS thresholdVersion
    FROM app.project_prompt project_prompt
    INNER JOIN app.prompt prompt
      ON prompt.id = project_prompt.prompt_id
    WHERE project_prompt.project_id = ${getSqlLiteral(projectId)}
      AND project_prompt.enabled
      AND NOT project_prompt.archived
      AND COALESCE(prompt.archived, FALSE) = FALSE
    ORDER BY COALESCE(project_prompt.prompt_order, 0) ASC, prompt.id ASC
  `)
}

const getPromptConfigHash = (row: ProjectPromptConfigRow) => {
  return buildPromptConfigHash({
    answerSchemaHash: row.answerSchemaHash,
    promptId: row.promptId,
    promptTextHash: row.promptTextHash ?? row.promptId,
    settingsVersion: row.settingsVersion ?? 'prompt-v1',
    thresholdVersion: row.thresholdVersion,
  })
}

const getReviewConfigHash = (
  input: ProjectReviewSettingsRow & {promptConfigRows: readonly ProjectPromptConfigRow[]},
) => {
  return buildReviewConfigHash({
    humanJudgmentMode: input.humanJudgmentMode,
    modelExecutionIdentity: {
      modelExecutionOptions: getJsonValue(input.modelExecutionOptions) as ReviewServingIdentityValue,
      modelId: input.modelId,
      providerBaseUrl: input.modelProviderBaseUrl,
      providerConnectionId: input.modelProviderConnectionId,
      providerKind: input.modelProviderKind,
      remoteModelId: input.modelRemoteModelId,
      variant: input.modelVariant,
    },
    modelId: input.modelId,
    promptConfigs: input.promptConfigRows.map((row, index) => {
      return {promptConfigHash: getPromptConfigHash(row), promptId: row.promptId, promptOrder: row.promptOrder ?? index}
    }),
    useAbstract: input.useAbstract,
    useFulltext: input.useFulltext,
    useFulltextNoImages: input.useFulltextNoImages,
    useTitle: input.useTitle,
  })
}

const getCurrentProjectReviewSnapshotSettings = async (
  projectId: string,
  database: ReviewServingProjectorWorkerDatabase,
): Promise<ProjectReviewSnapshotSettings> => {
  const project = await getProjectReviewSettings(projectId, database)
  const promptConfigRows = await getProjectPromptConfigRows(projectId, database)
  const reviewConfigHash = getReviewConfigHash({...project, promptConfigRows})

  return {...project, reviewConfigHash}
}

const getSnapshotReviewSettings = (
  snapshot: ReviewServingSnapshotContext,
  currentSettings: ProjectReviewSnapshotSettings,
) => {
  return snapshot.reviewConfigHash === currentSettings.reviewConfigHash ? currentSettings : null
}

const getDefaultRunnerInputs = async (
  context: Parameters<ReviewServingProjectorRunner>[0],
  database: ReviewServingProjectorWorkerDatabase,
) => {
  const {manifest, projectId} = await getDefaultClaimManifestInput(context, database)
  const snapshots = await requireSnapshotContexts(
    {
      component: context.component,
      projectId,
      projectionIdentity: manifest.projectionIdentity,
      reviewConfigHash: manifest.reviewConfigHash,
    },
    database,
  )

  return {manifest, projectId, snapshots}
}

const runSnapshotProjectors = async <T>(
  snapshots: readonly ReviewServingSnapshotContext[],
  runSnapshot: (snapshot: ReviewServingSnapshotContext, acknowledgeClaims: boolean) => Promise<T>,
) => {
  const resultsWithoutAcknowledgement = await Promise.all(
    snapshots.slice(0, -1).map((snapshot) => {
      return runSnapshot(snapshot, false)
    }),
  )
  const finalSnapshot = snapshots.at(-1)

  return finalSnapshot === undefined
    ? resultsWithoutAcknowledgement
    : [...resultsWithoutAcknowledgement, await runSnapshot(finalSnapshot, true)]
}

export const getDefaultReviewServingProjectorRunners = (
  database: ReviewServingProjectorWorkerDatabase,
): ReviewServingProjectorServiceDependencies['runners'] => {
  return {
    display: async (context) => {
      const {manifest, projectId} = await getDefaultClaimManifestInput(context, database)
      const snapshots = await requireSnapshotContexts(
        {
          component: context.component,
          projectId,
          projectionIdentity: manifest.projectionIdentity,
          reviewConfigHash: manifest.reviewConfigHash,
        },
        database,
      )
      const patchSnapshot = (snapshot: ReviewServingSnapshotContext, acknowledgeClaims: boolean) => {
        return projectReviewServingDisplayPatches(
          {
            acknowledgeClaims,
            baseGeneration: manifest.baseGeneration,
            claims: context.claims,
            definitionVersion: manifest.definitionVersion,
            displayIdentity: manifest.projectionIdentity,
            projectId,
            projectScopeIdentity: requireSnapshotComponentIdentity(snapshot, 'projectScope'),
            projectionIdentity: manifest.projectionIdentity,
            selectedImportSnapshotId: requireSelectedImportSnapshotId(snapshot),
            snapshotId: snapshot.snapshotId,
          },
          database,
        )
      }
      const patchSnapshotsWithoutAcknowledgement = await Promise.all(
        snapshots.slice(0, -1).map((snapshot) => {
          return patchSnapshot(snapshot, false)
        }),
      )
      const finalPatchSnapshot = snapshots.at(-1)
      const results =
        finalPatchSnapshot === undefined
          ? patchSnapshotsWithoutAcknowledgement
          : [...patchSnapshotsWithoutAcknowledgement, await patchSnapshot(finalPatchSnapshot, true)]

      return {
        processedCount: results.reduce((total, result) => {
          return total + result.patchRowCount
        }, 0),
      }
    },
    humanStatus: async (context) => {
      const {manifest, projectId} = await getDefaultClaimManifestInput(context, database)
      const result = await projectReviewServingHumanStatusPatches(
        {
          baseGeneration: manifest.baseGeneration,
          claims: context.claims,
          definitionVersion: manifest.definitionVersion,
          listModeKeys: defaultReviewServingHumanListModeKeys,
          projectId,
          projectionIdentity: manifest.projectionIdentity,
        },
        database,
      )

      return {processedCount: result.patchRowCount}
    },
    judgmentInputContent: async (context) => {
      const {manifest, projectId} = await getDefaultClaimManifestInput(context, database)
      const patchWatermark = Math.max(
        0,
        ...context.claims.map((claim) => {
          return claim.latestSourceHighWaterMark
        }),
      )
      const patchRangeStart = Math.min(
        ...context.claims.map((claim) => {
          return claim.firstSourceHighWaterMark
        }),
      )
      const inputDigest = [
        ...new Set(
          context.claims.map((claim) => {
            return claim.dirtyKind
          }),
        ),
      ].join(',')

      await writeReviewServingProjectorComponent(
        {
          acknowledgements: context.claims,
          component: 'judgmentInputContent',
          projectionManifests:
            context.claims.length === 0
              ? []
              : [
                  {
                    baseGeneration: manifest.baseGeneration,
                    definitionVersion: manifest.definitionVersion,
                    inputDigest,
                    inputWatermark: patchWatermark,
                    inputWatermarks: getReviewServingSourcePartitionWatermarks(context.claims),
                    invalidationReason: inputDigest,
                    patchRangeEnd: patchWatermark,
                    patchRangeStart,
                    patchWatermark,
                    projectId,
                    projectionComponent: 'judgmentInputContent',
                    projectionIdentity: manifest.projectionIdentity,
                    reviewConfigHash: manifest.reviewConfigHash,
                    status: 'candidate',
                  },
                ],
          watermark:
            context.claims.length === 0
              ? undefined
              : {
                  projectId,
                  projectionComponent: 'judgmentInputContent',
                  projectorName: 'judgment-input-content-projector',
                  sourceHighWaterMark: patchWatermark,
                  sourcePartition: context.claims[0]?.sourcePartition ?? 'review-change',
                },
        },
        database,
      )

      return {processedCount: context.claims.length}
    },
    llmStatus: async (context) => {
      const {manifest, projectId} = await getDefaultClaimManifestInput(context, database)
      const result = await projectReviewServingLlmStatusPatches(
        {
          baseGeneration: manifest.baseGeneration,
          claims: context.claims,
          definitionVersion: manifest.definitionVersion,
          listModeKeys: defaultReviewServingLlmListModeKeys,
          projectId,
          projectionIdentity: manifest.projectionIdentity,
        },
        database,
      )

      return {processedCount: result.patchRowCount}
    },
    payload: async (context) => {
      const {manifest, projectId, snapshots} = await getDefaultRunnerInputs(context, database)
      const currentSettings = await getCurrentProjectReviewSnapshotSettings(projectId, database)
      const payloadSnapshots = snapshots.filter((snapshot) => {
        return getSnapshotReviewSettings(snapshot, currentSettings) !== null
      })

      if (payloadSnapshots.length === 0) {
        await completeReviewServingDirtyWorkClaims(context.claims, database)

        return {processedCount: 0}
      }

      const results = await runSnapshotProjectors(payloadSnapshots, async (snapshot, acknowledgeClaims) => {
        const project = getSnapshotReviewSettings(snapshot, currentSettings)

        if (project === null) {
          return 0
        }

        const articlePayloadResult = await projectReviewServingPayloadRows(
          {
            acknowledgeClaims: false,
            baseGeneration: manifest.baseGeneration,
            claims: context.claims,
            definitionVersion: manifest.definitionVersion,
            displayIdentity: requireSnapshotComponentIdentity(snapshot, 'display'),
            payloadIdentity: manifest.projectionIdentity,
            projectId,
            projectionIdentity: manifest.projectionIdentity,
            selectedImportSnapshotId: requireSelectedImportSnapshotId(snapshot),
            snapshotId: snapshot.snapshotId,
          },
          database,
        )
        const judgmentPayloadResult = await projectReviewServingJudgmentPayloadRows(
          {
            acknowledgeClaims,
            baseGeneration: manifest.baseGeneration,
            claims: context.claims,
            definitionVersion: manifest.definitionVersion,
            listModeKeys: reviewServingListModes,
            modelId: project.modelId,
            projectId,
            projectionIdentity: manifest.projectionIdentity,
            reviewConfigHash: requireReviewConfigHash(snapshot),
            snapshotId: snapshot.snapshotId,
            useAbstract: project.useAbstract,
            useFulltext: project.useFulltext,
            useFulltextNoImages: project.useFulltextNoImages,
            useTitle: project.useTitle,
          },
          database,
        )

        return (
          articlePayloadResult.payloadRowCount + judgmentPayloadResult.humanRowCount + judgmentPayloadResult.llmRowCount
        )
      })

      return {
        processedCount: results.reduce((total, count) => {
          return total + count
        }, 0),
      }
    },
    posting: async (context) => {
      const {manifest, projectId, snapshots} = await getDefaultRunnerInputs(context, database)
      const results = await runSnapshotProjectors(snapshots, (snapshot, acknowledgeClaims) => {
        return projectReviewServingFilterPostings(
          {
            acknowledgeClaims,
            baseGeneration: manifest.baseGeneration,
            claims: context.claims,
            definitionVersion: manifest.definitionVersion,
            listModeKeys: reviewServingListModes,
            projectId,
            projectScopeIdentity: requireSnapshotComponentIdentity(snapshot, 'projectScope'),
            projectionIdentity: manifest.projectionIdentity,
            reviewConfigHash: requireReviewConfigHash(snapshot),
            selectedImportSnapshotId: requireSelectedImportSnapshotId(snapshot),
            snapshotId: snapshot.snapshotId,
          },
          database,
        )
      })

      return {
        processedCount: results.reduce((total, result) => {
          return total + result.servingRowCount
        }, 0),
      }
    },
    projectScope: async (context) => {
      const {manifest, projectId} = await getDefaultClaimManifestInput(context, database)
      await projectReviewServingProjectScopePatches(
        {
          baseGeneration: manifest.baseGeneration,
          claims: context.claims,
          definitionVersion: manifest.definitionVersion,
          projectId,
          projectionIdentity: manifest.projectionIdentity,
        },
        database,
      )

      return {processedCount: context.claims.length}
    },
    queue: async (context) => {
      const {manifest, projectId, snapshots} = await getDefaultRunnerInputs(context, database)
      const results = await runSnapshotProjectors(snapshots, (snapshot, acknowledgeClaims) => {
        return projectReviewServingQueuePatches(
          {
            acknowledgeClaims,
            baseGeneration: manifest.baseGeneration,
            claims: context.claims,
            definitionVersion: manifest.definitionVersion,
            projectId,
            projectScopeIdentity: requireSnapshotComponentIdentity(snapshot, 'projectScope'),
            projectionIdentity: manifest.projectionIdentity,
            selectedImportSnapshotId: requireSelectedImportSnapshotId(snapshot),
            snapshotId: snapshot.snapshotId,
          },
          database,
        )
      })

      return {
        processedCount: results.reduce((total, result) => {
          return total + result.servingRowCount
        }, 0),
      }
    },
    search: async (context) => {
      const {manifest, projectId, snapshots} = await getDefaultRunnerInputs(context, database)
      const results = await runSnapshotProjectors(snapshots, (snapshot, acknowledgeClaims) => {
        return projectReviewServingTitleSearchRows(
          {
            acknowledgeClaims,
            baseGeneration: manifest.baseGeneration,
            claims: context.claims,
            definitionVersion: manifest.definitionVersion,
            projectId,
            projectScopeIdentity: requireSnapshotComponentIdentity(snapshot, 'projectScope'),
            projectionIdentity: manifest.projectionIdentity,
            searchIdentity: manifest.projectionIdentity,
            selectedImportSnapshotId: snapshot.selectedImportSnapshotId,
            snapshotId: snapshot.snapshotId,
          },
          database,
        )
      })

      return {
        processedCount: results.reduce((total, result) => {
          return total + result.searchRowCount
        }, 0),
      }
    },
    selectedImport: async (context) => {
      const {manifest, projectId, snapshots} = await getDefaultRunnerInputs(context, database)
      const baseResults = await Promise.all(
        snapshots.map((snapshot) => {
          return getSelectedImportBaseProjectionResult(
            {
              claims: context.claims,
              projectId,
              projectScopeIdentity: requireSnapshotComponentIdentity(snapshot, 'projectScope'),
              selectedImportSnapshotId: requireSelectedImportSnapshotId(snapshot),
            },
            database,
          )
        }),
      )
      const baseProjectionIncomplete = baseResults.some((result) => {
        return result.status !== 'completed'
      })

      if (baseProjectionIncomplete) {
        await releaseReviewServingDirtyWorkClaims(
          context.claims.map((claim) => {
            return claim.dirtyWorkId
          }),
          database,
        )

        return {
          processedCount: baseResults.reduce((total, result) => {
            return total + result.insertedRowCount
          }, 0),
        }
      }

      const results = await runSnapshotProjectors(snapshots, (snapshot, acknowledgeClaims) => {
        return projectReviewServingSelectedImportDirty(
          {
            acknowledgeClaims,
            baseGeneration: manifest.baseGeneration,
            claims: context.claims,
            definitionVersion: manifest.definitionVersion,
            projectId,
            projectScopeIdentity: requireSnapshotComponentIdentity(snapshot, 'projectScope'),
            projectionIdentity: manifest.projectionIdentity,
            selectedImportSnapshotId: requireSelectedImportSnapshotId(snapshot),
          },
          database,
        )
      })

      return {
        processedCount: results.reduce((total, result) => {
          return total + result.dirtyRowCount
        }, 0),
      }
    },
    summary: async (context) => {
      const {manifest, projectId, snapshots} = await getDefaultRunnerInputs(context, database)
      const results = await runSnapshotProjectors(snapshots, async (snapshot, acknowledgeClaims) => {
        const result = await projectReviewServingSummaries(
          {
            acknowledgeClaims,
            baseGeneration: manifest.baseGeneration,
            claims: context.claims,
            listModeKeys: reviewServingListModes,
            projectId,
            projectScopeIdentity: requireSnapshotComponentIdentity(snapshot, 'projectScope'),
            projectionIdentity: manifest.projectionIdentity,
            reviewConfigHash: requireReviewConfigHash(snapshot),
            selectedImportSnapshotId: requireSelectedImportSnapshotId(snapshot),
            snapshotId: snapshot.snapshotId,
          },
          database,
        )
        const searchIdentity = getSnapshotComponentState(snapshot, 'search')?.projectionIdentity ?? ''
        const reviewFilterOptionsResult = await projectReviewServingFilterOptions(
          {
            acknowledgeClaims: false,
            baseGeneration: manifest.baseGeneration,
            claims: context.claims,
            definitionVersion: manifest.definitionVersion,
            deleteExisting: false,
            filterOptionIdentity: getReviewServingFilterOptionIdentity({
              filterKeys: defaultReviewFilterOptionKeys,
              listModeKeys: reviewServingListModes,
              optionMode: 'review',
              searchIdentity,
            }),
            listModeKeys: reviewServingListModes,
            optionMode: 'review',
            projectId,
            projectionIdentity: manifest.projectionIdentity,
            reviewConfigHash: requireReviewConfigHash(snapshot),
            searchIdentity,
            snapshotId: snapshot.snapshotId,
          },
          database,
        )
        const humanFilterOptionsResult = await projectReviewServingFilterOptions(
          {
            acknowledgeClaims: false,
            baseGeneration: manifest.baseGeneration,
            claims: context.claims,
            definitionVersion: manifest.definitionVersion,
            deleteExisting: false,
            filterOptionIdentity: getReviewServingFilterOptionIdentity({
              filterKeys: defaultHumanFilterOptionKeys,
              listModeKeys: defaultReviewServingHumanListModeKeys,
              optionMode: 'human',
              searchIdentity,
            }),
            listModeKeys: defaultReviewServingHumanListModeKeys,
            optionMode: 'human',
            projectId,
            projectionIdentity: manifest.projectionIdentity,
            reviewConfigHash: requireReviewConfigHash(snapshot),
            searchIdentity,
            snapshotId: snapshot.snapshotId,
          },
          database,
        )

        return (
          result.summaryRowCount + reviewFilterOptionsResult.optionRowCount + humanFilterOptionsResult.optionRowCount
        )
      })

      return {
        processedCount: results.reduce((total, count) => {
          return total + count
        }, 0),
      }
    },
  }
}

const shouldRunNativeHeavyCleanupAfterCompletedRebuildChunk = (input: {
  chunk: Pick<ReviewServingRebuildChunkManifest, 'projectionComponent' | 'requestId'>
}) => {
  return reviewServingNativeHeavyRebuildComponents.has(input.chunk.projectionComponent)
}

const hasRequestAssociatedNativeHeavyChunkReachedRssCap = (input: {
  chunk: Pick<ReviewServingRebuildChunkManifest, 'projectionComponent' | 'requestId'>
  dependencies: ReviewServingProjectorWorkerDependencies
  options: ReviewServingProjectorWorkerCycleOptions
}) => {
  return (
    input.chunk.requestId !== null
    && reviewServingNativeHeavyRebuildComponents.has(input.chunk.projectionComponent)
    && hasReviewServingProjectorWorkerReachedRssCap(input)
  )
}

const shouldRecycleDuckdbAfterCompletedRebuildChunk = (input: {
  chunk: ReviewServingRebuildChunkManifest
  dependencies: ReviewServingProjectorWorkerDependencies
  options: ReviewServingProjectorWorkerCycleOptions
}) => {
  return (
    reviewServingDuckdbRecycleAfterRebuildComponents.has(input.chunk.projectionComponent)
    && input.chunk.requestId === null
  )
}

const shouldCollectGarbageAfterCompletedRebuildChunk = (input: {
  chunk: ReviewServingRebuildChunkManifest
  dependencies: ReviewServingProjectorWorkerDependencies
  options: ReviewServingProjectorWorkerCycleOptions
}) => {
  return shouldRunNativeHeavyCleanupAfterCompletedRebuildChunk(input)
}

const closeDuckdbAfterCompletedRebuildChunk = async () => {
  await closeDuckdbService({checkpointBeforeClose: false, releaseOwnerLease: false})
}

const closeDuckdbAfterFatalRebuildChunkError = async (input: {error: unknown}) => {
  await recoverDuckdbServiceAfterFatalError(input.error, {releaseOwnerLease: false})
}

const collectGarbageAfterCompletedRebuildChunk = () => {
  globalThis.Bun.gc(true)
}

const defaultReviewServingProjectorWorkerDependencies: ReviewServingProjectorWorkerDependencies = {
  collectGarbageAfterCompletedRebuildChunk,
  cleanupRetentionState: cleanupReviewServingRetentionState,
  getDatabase: getAppDatabaseService as ReviewServingProjectorWorkerDependencies['getDatabase'],
  getAppendQueueDepth: () => {
    return getDuckdbAppendRuntimeMetrics().queueDepth
  },
  getCleanupTargets: (database) => {
    return getReviewServingRetentionCleanupTargets({}, database)
  },
  getForegroundQueueDepth: () => {
    return getDuckdbQueueRuntimeMetricsSnapshot().main.queueDepth
  },
  rebuildChunkService: {
    claimChunk: claimReviewServingRebuildChunk,
    failChunk: markReviewServingRebuildChunkFailed,
    getNextChunk: ({database, now, projectId}) => {
      return getNextClaimableReviewServingRebuildChunk({now, projectId}, database)
    },
    getCompatibleStatusChunks: ({database, excludeChunkIds, firstChunk, limit, now, projectId}) => {
      return getCompatibleStatusRebuildChunkBatchInputs({database, excludeChunkIds, firstChunk, limit, now, projectId})
    },
    heartbeatChunk: heartbeatReviewServingRebuildChunkLease,
    isChunkComplete: isReviewServingRebuildChunkComplete,
    runClaimedChunk: async ({chunk, database, leaseOwner}) => {
      return runReviewServingProjectorWorkerClaimedRebuildChunk({chunk, leaseOwner}, database)
    },
  },
  recycleDuckdbAfterCompletedRebuildChunk: closeDuckdbAfterCompletedRebuildChunk,
  recycleDuckdbAfterFatalRebuildChunkError: closeDuckdbAfterFatalRebuildChunkError,
  sleep,
  wakeProjectors: wakeReviewServingProjectorService,
}

export const getReviewServingProjectorWorkerId = () => {
  return `review-serving-projector-worker:${hostname()}:${process.pid}`
}

export const getReviewServingProjectorWorkerWorkloadContext = (_workerId: string): DuckdbWorkloadContext => {
  return {
    allowsTempSpill: true,
    fallbackIntent: 'reject',
    routeOrJobKey: reviewServingProjectorWorkerRouteOrJobKey,
    searchMode: 'none',
    workloadClass: 'reviewProjector',
  }
}

const getWorkerNow = (options: ReviewServingProjectorWorkerCycleOptions) => {
  return options.now ?? new Date()
}

const getWorkerNowMs = (
  dependencies: ReviewServingProjectorWorkerDependencies,
  options: ReviewServingProjectorWorkerCycleOptions,
) => {
  return options.now?.getTime() ?? dependencies.nowMs?.() ?? Date.now()
}

const getPositiveInteger = (value: number | null | undefined, fallback: number) => {
  return value !== null && value !== undefined && Number.isInteger(value) && value > 0 ? Math.trunc(value) : fallback
}

const getDefaultMaxCompletedRebuildChunksPerRun = () => {
  const duckdbLimitMiB = parseDuckdbMemoryLimitToMiB(process.env.DUCKDB_MEMORY_LIMIT)

  return duckdbLimitMiB !== null && duckdbLimitMiB <= lowMemoryMaintenanceDuckdbLimitMiB
    ? lowMemoryReviewServingProjectorWorkerMaxCompletedChunksPerRun
    : 0
}

const getReviewServingProjectorWorkerMemoryUsage = (
  dependencies: ReviewServingProjectorWorkerDependencies,
): ReviewServingProjectorWorkerMemoryUsage => {
  return dependencies.getMemoryUsage?.() ?? process.memoryUsage()
}

const getReviewServingProjectorWorkerRebuildChunkBatchMaxRssBytes = (
  options: ReviewServingProjectorWorkerCycleOptions,
) => {
  return getPositiveInteger(
    options.rebuildChunkBatchMaxRssBytes,
    defaultReviewServingProjectorWorkerRebuildChunkBatchMaxRssBytes,
  )
}

const hasReviewServingProjectorWorkerReachedRssCap = (input: {
  dependencies: ReviewServingProjectorWorkerDependencies
  options: ReviewServingProjectorWorkerCycleOptions
}) => {
  const maxRssBytes = getReviewServingProjectorWorkerRebuildChunkBatchMaxRssBytes(input.options)

  return maxRssBytes > 0 && getReviewServingProjectorWorkerMemoryUsage(input.dependencies).rss >= maxRssBytes
}

const getEffectiveReviewServingProjectorWorkerRebuildChunkBatchSize = (input: {
  dependencies: ReviewServingProjectorWorkerDependencies
  options: ReviewServingProjectorWorkerCycleOptions
}) => {
  const batchSize = getPositiveInteger(
    input.options.rebuildChunkBatchSize,
    defaultReviewServingProjectorWorkerRebuildChunkBatchSize,
  )
  const maxRssBytes = getReviewServingProjectorWorkerRebuildChunkBatchMaxRssBytes(input.options)
  const shouldApplyRssCap = batchSize > 1 && maxRssBytes > 0
  const rssBytes = shouldApplyRssCap ? getReviewServingProjectorWorkerMemoryUsage(input.dependencies).rss : 0

  if (shouldApplyRssCap && rssBytes >= maxRssBytes) {
    reviewServingProjectorWorkerCycleLogger.warn(
      'review-serving-projector-worker:rebuild-chunk-batch-rss-cap',
      '[reviewServingProjectorWorker] limiting rebuild chunk batch size due to RSS cap',
      {batchSize, effectiveBatchSize: 1, maxRssBytes, rssBytes},
    )

    return 1
  }

  return batchSize
}

const getLeaseExpiresAt = (options: ReviewServingProjectorWorkerCycleOptions) => {
  return new Date(
    getWorkerNow(options).getTime() + getPositiveInteger(options.leaseMs, defaultReviewServingProjectorWorkerLeaseMs),
  )
}

const getRebuildChunkHeartbeatLeaseExpiresAt = (
  dependencies: ReviewServingProjectorWorkerDependencies,
  options: ReviewServingProjectorWorkerCycleOptions,
) => {
  return new Date(
    (dependencies.nowMs?.() ?? Date.now())
      + getPositiveInteger(options.leaseMs, defaultReviewServingProjectorWorkerLeaseMs),
  )
}

const heartbeatClaimedRebuildChunkLease = async (input: {
  chunk: ReviewServingRebuildChunkManifest
  database: ReviewServingChunkManifestRepositoryDatabase
  dependencies: ReviewServingProjectorWorkerDependencies
  options: ReviewServingProjectorWorkerCycleOptions
  service: ReviewServingProjectorWorkerRebuildChunkService
  workerId: string
}) => {
  const chunk = await input.service.heartbeatChunk(
    {
      chunkId: input.chunk.chunkId,
      leaseExpiresAt: getRebuildChunkHeartbeatLeaseExpiresAt(input.dependencies, input.options),
      leaseOwner: input.workerId,
    },
    input.database,
  )

  if (chunk === null) {
    throw new Error(`review serving rebuild chunk ${input.chunk.chunkId} is no longer claimed by ${input.workerId}`)
  }
}

const startClaimedRebuildChunkHeartbeat = (input: {
  chunk: ReviewServingRebuildChunkManifest
  database: ReviewServingChunkManifestRepositoryDatabase
  dependencies: ReviewServingProjectorWorkerDependencies
  options: ReviewServingProjectorWorkerCycleOptions
  service: ReviewServingProjectorWorkerRebuildChunkService
  workerId: string
}) => {
  const interval = setInterval(
    () => {
      return void heartbeatClaimedRebuildChunkLease(input).catch(() => {
        return undefined
      })
    },
    getPositiveInteger(input.options.heartbeatMs, defaultReviewServingProjectorWorkerHeartbeatMs),
  )

  interval.unref()

  return () => {
    clearInterval(interval)
  }
}

const startClaimedRebuildChunkBatchHeartbeats = (input: {
  claimedChunks: readonly ClaimedReviewServingProjectorWorkerRebuildChunk[]
  database: ReviewServingChunkManifestRepositoryDatabase
  dependencies: ReviewServingProjectorWorkerDependencies
  options: ReviewServingProjectorWorkerCycleOptions
  workerId: string
}) => {
  const stopHeartbeats = input.claimedChunks.map((claimed) => {
    return startClaimedRebuildChunkHeartbeat({
      chunk: claimed.chunk,
      database: input.database,
      dependencies: input.dependencies,
      options: input.options,
      service: claimed.service,
      workerId: input.workerId,
    })
  })

  return () => {
    stopHeartbeats.reduce<undefined>((_previous, stopHeartbeat) => {
      stopHeartbeat()

      return undefined
    }, undefined)
  }
}

const heartbeatClaimedRebuildChunkBatchLeases = async (input: {
  claimedChunks: readonly ClaimedReviewServingProjectorWorkerRebuildChunk[]
  database: ReviewServingChunkManifestRepositoryDatabase
  dependencies: ReviewServingProjectorWorkerDependencies
  options: ReviewServingProjectorWorkerCycleOptions
  workerId: string
}) => {
  await input.claimedChunks.reduce<Promise<void>>(async (previous, claimed) => {
    await previous
    await measureReviewServingProjectorWorkerPhase(claimed.timings, 'heartbeatMs', async () => {
      await heartbeatClaimedRebuildChunkLease({
        chunk: claimed.chunk,
        database: input.database,
        dependencies: input.dependencies,
        options: input.options,
        service: claimed.service,
        workerId: input.workerId,
      })
    })
  }, Promise.resolve())
}

const getErrorText = (error: unknown) => {
  return error instanceof Error ? error.message : String(error)
}

const readmitRetryableFailedRebuildRequests = async (input: {
  database: ReviewServingChunkManifestRepositoryDatabase
  projectId?: string | null
}) => {
  const projectCondition = input.projectId ? `AND request.project_id = ${getSqlLiteral(input.projectId)}` : ''

  await input.database.run(`
    UPDATE app.review_rebuild_request AS request
    SET
      status = 'admitted',
      retry_after = NULL,
      failed_at = NULL,
      last_error = NULL,
      lease_owner = NULL,
      lease_expires_at = NULL,
      updated_at = current_timestamp
    WHERE request.status = 'failed'
      AND request.admission_state = 'admitted'
      ${projectCondition}
      AND EXISTS (
        SELECT 1
        FROM app.review_rebuild_chunk_manifest chunk
        WHERE chunk.request_id = request.request_id
          AND (
            chunk.status IN ('pending', 'running')
            OR (
              chunk.status = 'failed'
              AND COALESCE(chunk.retry_count, 0) < COALESCE(
                GREATEST(
                  1,
                  TRY_CAST(json_extract_string(request.retry_policy_json, '$.maxAttempts') AS INTEGER)
                ),
                3
              )
            )
          )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM app.review_rebuild_chunk_manifest chunk
        WHERE chunk.request_id = request.request_id
          AND chunk.status IN ('blocked_over_budget', 'quarantined')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM app.review_rebuild_request active_request
        WHERE active_request.project_id = request.project_id
          AND active_request.request_id <> request.request_id
          AND active_request.status IN ('admitted', 'running')
          AND active_request.admission_state = 'admitted'
      )
  `)
}

const getRebuildRequestPendingChunkCount = async (
  requestId: string,
  database: ReviewServingChunkManifestRepositoryDatabase,
) => {
  const [row] = await database.queryJson<RebuildRequestPendingChunkCountRow>(`
    SELECT CAST(COUNT(*) AS INTEGER) AS pendingChunkCount
    FROM app.review_rebuild_chunk_manifest
    WHERE request_id = ${getSqlLiteral(requestId)}
      AND status <> 'completed'
  `)

  return Number(row?.pendingChunkCount ?? 0)
}

const getNextCompletedUnfinalizedRebuildRequestChunk = async (input: {
  database: ReviewServingChunkManifestRepositoryDatabase
  projectId?: string | null
}) => {
  const projectCondition = input.projectId ? `AND request.project_id = ${getSqlLiteral(input.projectId)}` : ''

  const [row] = await input.database.queryJson<CompletedUnfinalizedRebuildRequestChunkRow>(`
    WITH active_request AS (
      SELECT request.request_id
      FROM app.review_rebuild_request request
      WHERE request.status IN ('admitted', 'running')
        AND request.admission_state = 'admitted'
        ${projectCondition}
    ),
    request_chunk_state AS (
      SELECT
        request.request_id,
        CAST(COUNT(*) FILTER (WHERE chunk.status = 'completed') AS INTEGER) AS completed_chunk_count,
        CAST(COUNT(*) FILTER (WHERE chunk.status <> 'completed') AS INTEGER) AS pending_chunk_count
      FROM active_request request
      INNER JOIN app.review_rebuild_chunk_manifest chunk
        ON chunk.request_id = request.request_id
      GROUP BY request.request_id
    ),
    eligible_request AS (
      SELECT request.request_id
      FROM app.review_rebuild_request request
      INNER JOIN request_chunk_state chunk_state
        ON chunk_state.request_id = request.request_id
      WHERE chunk_state.completed_chunk_count > 0
        AND chunk_state.pending_chunk_count = 0
      ORDER BY
        request.priority DESC,
        request.updated_at ASC,
        request.request_id ASC
      LIMIT 1
    )
    SELECT chunk.chunk_id AS chunkId
    FROM app.review_rebuild_chunk_manifest chunk
    INNER JOIN eligible_request
      ON eligible_request.request_id = chunk.request_id
    WHERE chunk.status = 'completed'
    ORDER BY
      chunk.updated_at DESC,
      chunk.chunk_id ASC
    LIMIT 1
  `)

  return row === undefined ? null : getReviewServingRebuildChunkManifest({chunkId: row.chunkId}, input.database)
}

const getRebuildRequestHasPostingChunks = async (
  requestId: string,
  database: ReviewServingChunkManifestRepositoryDatabase,
) => {
  const [row] = await database.queryJson<RebuildRequestPostingChunkCountRow>(`
    SELECT CAST(COUNT(*) AS INTEGER) AS postingChunkCount
    FROM app.review_rebuild_chunk_manifest
    WHERE request_id = ${getSqlLiteral(requestId)}
      AND projection_component = 'posting'
  `)

  return Number(row?.postingChunkCount ?? 0) > 0
}

const getRebuildRequestSummaryFilterOptionProjections = async (
  requestId: string,
  database: ReviewServingChunkManifestRepositoryDatabase,
) => {
  return database.queryJson<SummaryFilterOptionProjectionRow>(`
    SELECT DISTINCT
      output_base_generation AS outputBaseGeneration,
      project_id AS projectId,
      projection_identity AS projectionIdentity
    FROM app.review_rebuild_chunk_manifest
    WHERE request_id = ${getSqlLiteral(requestId)}
      AND project_id IS NOT NULL
      AND projection_component = 'summary'
      AND status = 'completed'
    ORDER BY project_id ASC, projection_identity ASC, output_base_generation ASC
  `)
}

const refreshPostingStatsForRebuildRequestSnapshots = async (
  promotionRows: readonly RebuildRequestSnapshotPromotionRow[],
  database: ReviewServingProjectorWorkerDatabase,
) => {
  await promotionRows.reduce<Promise<void>>(async (previous, row) => {
    await previous

    if (row.reviewConfigHash === null) {
      throw new Error(`cannot refresh posting stats without review config hash for snapshot ${row.snapshotId}`)
    }

    await refreshReviewServingFilterPostingStats(
      {projectId: row.projectId, reviewConfigHash: row.reviewConfigHash, snapshotId: row.snapshotId},
      database,
    )
  }, Promise.resolve())
}

const refreshSummaryFilterOptionsForProjections = async (
  summaryProjections: readonly SummaryFilterOptionProjectionRow[],
  database: ReviewServingChunkManifestRepositoryDatabase & ReviewServingProjectorWorkerDatabase,
  options: {deleteExisting?: boolean} = {},
) => {
  await summaryProjections.reduce<Promise<void>>(async (previous, row) => {
    await previous
    const manifest = await getReviewServingProjectionIdentityManifest(
      {projectId: row.projectId, projectionComponent: 'summary', projectionIdentity: row.projectionIdentity},
      database,
    )

    if (manifest === null) {
      throw new Error(`cannot refresh summary filter options without an identity manifest for ${row.projectId}`)
    }

    const snapshots = await requireSnapshotContexts(
      {
        component: 'summary',
        projectId: row.projectId,
        projectionIdentity: row.projectionIdentity,
        reviewConfigHash: null,
      },
      database,
    )
    const matchingSnapshots = snapshots.filter((snapshot) => {
      return getSnapshotComponentBaseGeneration(snapshot, 'summary') === Number(row.outputBaseGeneration)
    })

    if (matchingSnapshots.length === 0) {
      throw new Error(
        `cannot refresh summary filter options without snapshot state for base generation ${row.outputBaseGeneration}`,
      )
    }

    await matchingSnapshots.reduce<Promise<void>>(async (previousSnapshot, snapshot) => {
      await previousSnapshot
      const searchIdentity = getSnapshotComponentState(snapshot, 'search')?.projectionIdentity ?? ''

      await projectReviewServingFilterOptions(
        {
          acknowledgeClaims: false,
          baseGeneration: Number(row.outputBaseGeneration),
          claims: [],
          definitionVersion: manifest.definitionVersion,
          deleteExisting: options.deleteExisting,
          filterOptionIdentity: getReviewServingFilterOptionIdentity({
            filterKeys: defaultReviewFilterOptionKeys,
            listModeKeys: reviewServingListModes,
            optionMode: 'review',
            searchIdentity,
          }),
          listModeKeys: reviewServingListModes,
          optionMode: 'review',
          projectId: row.projectId,
          projectionIdentity: row.projectionIdentity,
          reviewConfigHash: requireReviewConfigHash(snapshot),
          searchIdentity,
          snapshotId: snapshot.snapshotId,
        },
        database,
      )
      await projectReviewServingFilterOptions(
        {
          acknowledgeClaims: false,
          baseGeneration: Number(row.outputBaseGeneration),
          claims: [],
          definitionVersion: manifest.definitionVersion,
          deleteExisting: options.deleteExisting,
          filterOptionIdentity: getReviewServingFilterOptionIdentity({
            filterKeys: defaultHumanFilterOptionKeys,
            listModeKeys: defaultReviewServingHumanListModeKeys,
            optionMode: 'human',
            searchIdentity,
          }),
          listModeKeys: defaultReviewServingHumanListModeKeys,
          optionMode: 'human',
          projectId: row.projectId,
          projectionIdentity: row.projectionIdentity,
          reviewConfigHash: requireReviewConfigHash(snapshot),
          searchIdentity,
          snapshotId: snapshot.snapshotId,
        },
        database,
      )
    }, Promise.resolve())
  }, Promise.resolve())
}

const getRebuildRequestSnapshotTargets = async (
  input: {requestId: string; snapshotStatuses: readonly ['candidate'] | readonly ['candidate', 'active']},
  database: ReviewServingChunkManifestRepositoryDatabase,
) => {
  const snapshotStatusPredicate = `snapshot.snapshot_status IN (${input.snapshotStatuses
    .map((status) => {
      return getSqlLiteral(status)
    })
    .join(', ')})`

  return database.queryJson<RebuildRequestSnapshotPromotionRow>(`
    WITH chunk_snapshot AS (
      SELECT
        chunk.project_id,
        chunk.snapshot_id
      FROM app.review_rebuild_chunk_manifest chunk
      INNER JOIN app.review_serving_snapshot_manifest snapshot
        ON snapshot.project_id = chunk.project_id
        AND snapshot.snapshot_id = chunk.snapshot_id
        AND ${snapshotStatusPredicate}
      WHERE chunk.request_id = ${getSqlLiteral(input.requestId)}
        AND chunk.project_id IS NOT NULL
        AND chunk.snapshot_id IS NOT NULL
      UNION
      SELECT
        chunk.project_id,
        snapshot.snapshot_id
      FROM app.review_rebuild_chunk_manifest chunk
      INNER JOIN app.review_serving_snapshot_manifest snapshot
        ON snapshot.project_id = chunk.project_id
        AND ${snapshotStatusPredicate}
      CROSS JOIN json_each(json_extract(snapshot.component_state_json, '$.required')) state
      WHERE chunk.request_id = ${getSqlLiteral(input.requestId)}
        AND chunk.project_id IS NOT NULL
        AND chunk.snapshot_id IS NULL
        AND json_extract_string(state.value, '$.component') = chunk.projection_component
        AND json_extract_string(state.value, '$.projectionIdentity') = chunk.projection_identity
        AND CAST(json_extract_string(state.value, '$.baseGeneration') AS BIGINT) = chunk.output_base_generation
      UNION
      SELECT
        chunk.project_id,
        snapshot.snapshot_id
      FROM app.review_rebuild_chunk_manifest chunk
      INNER JOIN app.review_serving_snapshot_manifest snapshot
        ON snapshot.project_id = chunk.project_id
        AND ${snapshotStatusPredicate}
      CROSS JOIN json_each(json_extract(snapshot.component_state_json, '$.optional')) state
      WHERE chunk.request_id = ${getSqlLiteral(input.requestId)}
        AND chunk.project_id IS NOT NULL
        AND chunk.snapshot_id IS NULL
        AND json_extract_string(state.value, '$.component') = chunk.projection_component
        AND json_extract_string(state.value, '$.projectionIdentity') = chunk.projection_identity
        AND CAST(json_extract_string(state.value, '$.baseGeneration') AS BIGINT) = chunk.output_base_generation
    )
    SELECT DISTINCT
      EXISTS (
        SELECT 1
        FROM app.review_rebuild_chunk_manifest summary_chunk
        WHERE summary_chunk.request_id = ${getSqlLiteral(input.requestId)}
          AND summary_chunk.project_id = chunk_snapshot.project_id
          AND summary_chunk.projection_component = 'summary'
          AND (
            summary_chunk.snapshot_id = chunk_snapshot.snapshot_id
            OR (
              summary_chunk.snapshot_id IS NULL
              AND (
                EXISTS (
                  SELECT 1
                  FROM json_each(json_extract(snapshot.component_state_json, '$.required')) summary_state
                  WHERE json_extract_string(summary_state.value, '$.component') = summary_chunk.projection_component
                    AND json_extract_string(summary_state.value, '$.projectionIdentity') = summary_chunk.projection_identity
                    AND CAST(json_extract_string(summary_state.value, '$.baseGeneration') AS BIGINT) = summary_chunk.output_base_generation
                )
                OR EXISTS (
                  SELECT 1
                  FROM json_each(json_extract(snapshot.component_state_json, '$.optional')) summary_state
                  WHERE json_extract_string(summary_state.value, '$.component') = summary_chunk.projection_component
                    AND json_extract_string(summary_state.value, '$.projectionIdentity') = summary_chunk.projection_identity
                    AND CAST(json_extract_string(summary_state.value, '$.baseGeneration') AS BIGINT) = summary_chunk.output_base_generation
                )
              )
            )
          )
      ) AS hasSummaryRebuildChunks,
      EXISTS (
        SELECT 1
        FROM app.review_rebuild_chunk_manifest posting_chunk
        WHERE posting_chunk.request_id = ${getSqlLiteral(input.requestId)}
          AND posting_chunk.project_id = chunk_snapshot.project_id
          AND posting_chunk.projection_component = 'posting'
          AND (
            posting_chunk.snapshot_id = chunk_snapshot.snapshot_id
            OR (
              posting_chunk.snapshot_id IS NULL
              AND (
                EXISTS (
                  SELECT 1
                  FROM json_each(json_extract(snapshot.component_state_json, '$.required')) posting_state
                  WHERE json_extract_string(posting_state.value, '$.component') = posting_chunk.projection_component
                    AND json_extract_string(posting_state.value, '$.projectionIdentity') = posting_chunk.projection_identity
                    AND CAST(json_extract_string(posting_state.value, '$.baseGeneration') AS BIGINT) = posting_chunk.output_base_generation
                )
                OR EXISTS (
                  SELECT 1
                  FROM json_each(json_extract(snapshot.component_state_json, '$.optional')) posting_state
                  WHERE json_extract_string(posting_state.value, '$.component') = posting_chunk.projection_component
                    AND json_extract_string(posting_state.value, '$.projectionIdentity') = posting_chunk.projection_identity
                    AND CAST(json_extract_string(posting_state.value, '$.baseGeneration') AS BIGINT) = posting_chunk.output_base_generation
                )
              )
            )
          )
      ) AS hasPostingRebuildChunks,
      chunk_snapshot.project_id AS projectId,
      chunk_snapshot.snapshot_id AS snapshotId,
      snapshot.review_config_hash AS reviewConfigHash
    FROM chunk_snapshot
    INNER JOIN app.review_serving_snapshot_manifest snapshot
      ON snapshot.project_id = chunk_snapshot.project_id
      AND snapshot.snapshot_id = chunk_snapshot.snapshot_id
    ORDER BY chunk_snapshot.project_id ASC, chunk_snapshot.snapshot_id ASC
  `)
}

const getRebuildRequestSnapshotReductionTargets = async (
  requestId: string,
  database: ReviewServingChunkManifestRepositoryDatabase,
) => {
  return getRebuildRequestSnapshotTargets({requestId, snapshotStatuses: ['candidate', 'active']}, database)
}

const getRebuildRequestSnapshotPromotions = async (
  requestId: string,
  database: ReviewServingChunkManifestRepositoryDatabase,
) => {
  return getRebuildRequestSnapshotTargets({requestId, snapshotStatuses: ['candidate']}, database)
}

const getCandidateSnapshotComponentIdentities = (candidate: ReviewServingSnapshotManifest) => {
  const states = [...(candidate.componentState.required ?? []), ...(candidate.componentState.optional ?? [])]

  return Object.fromEntries(
    states.map((state) => {
      return [
        state.component,
        {
          projectId: candidate.projectId,
          projectionComponent: state.component,
          projectionIdentity: state.projectionIdentity,
        },
      ]
    }),
  )
}

const refreshRebuildRequestCandidateSnapshot = async (
  input: {projectId: string; snapshotId: string},
  database: ReviewServingChunkManifestRepositoryDatabase & ReviewServingProjectorWorkerDatabase,
) => {
  const candidate = await getReviewServingSnapshotManifest(input, database)

  if (candidate === null || candidate.status !== 'candidate' || candidate.selectedImportSnapshotId === null) {
    return
  }

  const refreshedCandidate = await composeReviewServingCandidateSnapshotManifest(
    {
      componentIdentities: getCandidateSnapshotComponentIdentities(candidate),
      componentRequirements: {
        optionalComponents: candidate.optionalComponents,
        requiredComponents: candidate.requiredComponents,
      },
      composedIdentity: candidate.composedIdentity,
      projectId: candidate.projectId,
      reviewConfigHash: candidate.reviewConfigHash,
      selectedImportSnapshotId: candidate.selectedImportSnapshotId,
      snapshotId: candidate.snapshotId,
      sourceWatermarks: candidate.sourceWatermarks,
    },
    database,
  )

  await createCandidateReviewServingSnapshotManifest(refreshedCandidate, database)
}

const markCompletedRebuildRequestFinalized = async (
  input: {lastError: string | null; requestId: string; status: 'completed' | 'failed'},
  database: ReviewServingChunkManifestRepositoryDatabase,
) => {
  await database.run(`
    UPDATE app.review_rebuild_request
    SET
      status = ${getSqlLiteral(input.status)},
      completed_at = CASE WHEN ${getSqlLiteral(input.status)} = 'completed' THEN current_timestamp ELSE completed_at END,
      failed_at = CASE WHEN ${getSqlLiteral(input.status)} = 'failed' THEN current_timestamp ELSE failed_at END,
      last_error = ${getSqlLiteral(input.lastError)},
      updated_at = current_timestamp
    WHERE request_id = ${getSqlLiteral(input.requestId)}
      AND NOT EXISTS (
        SELECT 1
        FROM app.review_rebuild_chunk_manifest chunk
        WHERE chunk.request_id = ${getSqlLiteral(input.requestId)}
          AND chunk.status <> 'completed'
      )
  `)
}

const markCompletedRebuildRequestMetadataFinalized = async (
  input: {requestId: string},
  database: ReviewServingChunkManifestRepositoryDatabase,
) => {
  await database.run(`
    UPDATE app.review_rebuild_request
    SET
      status = 'completed',
      completed_at = current_timestamp,
      failed_at = failed_at,
      last_error = NULL,
      updated_at = current_timestamp
    WHERE request_id = ${getSqlLiteral(input.requestId)}
      AND status IN ('admitted', 'running')
      AND admission_state = 'admitted'
  `)
}

const isTerminalRebuildChunkFailure = (chunk: ReviewServingRebuildChunkManifest | null) => {
  return chunk?.status === 'blocked_over_budget' || chunk?.status === 'quarantined'
}

const markFailedRebuildRequestFinalized = async (
  input: {chunkId: string; lastError: string | null; requestId: string; status: string},
  database: ReviewServingChunkManifestRepositoryDatabase,
) => {
  await database.run(`
    UPDATE app.review_rebuild_request
    SET
      status = 'failed',
      failed_at = current_timestamp,
      last_error = ${getSqlLiteral(
        input.lastError ?? `review rebuild chunk ${input.chunkId} reached terminal status ${input.status}`,
      )},
      updated_at = current_timestamp
    WHERE request_id = ${getSqlLiteral(input.requestId)}
      AND status IN ('admitted', 'running')
  `)
}

const finalizeFailedReviewServingRebuildRequest = async (
  chunk: ReviewServingRebuildChunkManifest | null,
  database: ReviewServingChunkManifestRepositoryDatabase,
) => {
  if (chunk?.requestId === null || chunk?.requestId === undefined || !isTerminalRebuildChunkFailure(chunk)) {
    return
  }

  await markFailedRebuildRequestFinalized(
    {chunkId: chunk.chunkId, lastError: chunk.lastError, requestId: chunk.requestId, status: chunk.status},
    database,
  )
}

const getTerminalFailedRebuildRequestChunks = async (input: {
  database: ReviewServingChunkManifestRepositoryDatabase
  projectId?: string | null
}) => {
  const projectCondition = input.projectId ? `AND request.project_id = ${getSqlLiteral(input.projectId)}` : ''

  return input.database.queryJson<TerminalFailedRebuildRequestChunkRow>(`
    WITH active_request AS (
      SELECT request.request_id
      FROM app.review_rebuild_request request
      WHERE request.status IN ('admitted', 'running')
        AND request.admission_state = 'admitted'
        ${projectCondition}
    ),
    terminal_failed_rebuild_chunk AS (
      SELECT
        chunk.chunk_id AS chunkId,
        chunk.request_id AS requestId,
        chunk.updated_at AS updatedAt
      FROM app.review_rebuild_chunk_manifest chunk
      INNER JOIN active_request request
        ON request.request_id = chunk.request_id
      WHERE chunk.status IN ('blocked_over_budget', 'quarantined')
    )
    SELECT chunkId
    FROM terminal_failed_rebuild_chunk
    ORDER BY updatedAt ASC, requestId ASC, chunkId ASC
    LIMIT 50
  `)
}

const finalizeTerminalFailedRebuildRequests = async (input: {
  database: ReviewServingChunkManifestRepositoryDatabase
  projectId?: string | null
}): Promise<ReviewServingProjectorWorkerChunkResult | null> => {
  const terminalChunks = await getTerminalFailedRebuildRequestChunks(input)
  let firstFinalizedResult: ReviewServingProjectorWorkerChunkResult | null = null

  await terminalChunks.reduce<Promise<void>>(async (previous, row) => {
    await previous

    const chunk = await getReviewServingRebuildChunkManifest({chunkId: row.chunkId}, input.database)

    if (chunk === null || !isTerminalRebuildChunkFailure(chunk)) {
      return
    }

    if (firstFinalizedResult === null) {
      firstFinalizedResult = {chunkId: chunk.chunkId, requestId: chunk.requestId, status: 'failed'}
    }
    await finalizeFailedReviewServingRebuildRequest(chunk, input.database)
  }, Promise.resolve())

  return firstFinalizedResult
}

const finalizeErroredCompletedReviewServingRebuildRequest = async (
  input: {chunk: ReviewServingRebuildChunkManifest; error: unknown},
  database: ReviewServingChunkManifestRepositoryDatabase,
) => {
  if (input.chunk.requestId === null) {
    return
  }

  await markFailedRebuildRequestFinalized(
    {
      chunkId: input.chunk.chunkId,
      lastError: getErrorText(input.error),
      requestId: input.chunk.requestId,
      status: 'finalization_failed',
    },
    database,
  )
}

const finalizeCompletedReviewServingRebuildRequest = async (
  chunk: ReviewServingRebuildChunkManifest,
  database: ReviewServingChunkManifestRepositoryDatabase & ReviewServingProjectorWorkerDatabase,
  options: {deleteSummaryFilterOptions?: boolean; refreshDerivedOutputs?: boolean; refreshPostingStats?: boolean} = {},
) => {
  if (chunk.requestId === null) {
    return
  }

  const pendingChunkCount = await getRebuildRequestPendingChunkCount(chunk.requestId, database)

  if (pendingChunkCount > 0) {
    return
  }

  if (options.refreshDerivedOutputs === false) {
    await markCompletedRebuildRequestMetadataFinalized({requestId: chunk.requestId}, database)
    return
  }

  const hasPostingChunks = await getRebuildRequestHasPostingChunks(chunk.requestId, database)
  const reductionRows = await getRebuildRequestSnapshotReductionTargets(chunk.requestId, database)
  const promotionRows = await getRebuildRequestSnapshotPromotions(chunk.requestId, database)
  const summaryFilterOptionProjections = await getRebuildRequestSummaryFilterOptionProjections(
    chunk.requestId,
    database,
  )

  if (hasPostingChunks && options.refreshPostingStats !== false) {
    await refreshPostingStatsForRebuildRequestSnapshots(
      reductionRows.filter((row) => {
        return row.hasPostingRebuildChunks
      }),
      database,
    )
  }

  await reduceReviewServingSummaryRebuildPartialsForRequestSnapshots(
    {requestId: chunk.requestId, snapshots: reductionRows},
    database,
  )

  await refreshSummaryFilterOptionsForProjections(summaryFilterOptionProjections, database, {
    deleteExisting: options.deleteSummaryFilterOptions,
  })

  const promotions = await promotionRows.reduce<
    Promise<Awaited<ReturnType<typeof promoteReviewServingProjectorSnapshot>>[]>
  >(async (previousPromotions, row) => {
    const previous = await previousPromotions
    await refreshRebuildRequestCandidateSnapshot({projectId: row.projectId, snapshotId: row.snapshotId}, database)
    const promotion = await promoteReviewServingProjectorSnapshot(
      {projectId: row.projectId, reviewConfigHash: row.reviewConfigHash, snapshotId: row.snapshotId},
      database,
    )

    return [...previous, promotion]
  }, Promise.resolve([]))
  const failedPromotion = promotions.find((promotion) => {
    return !promotion.promoted
  })

  await markCompletedRebuildRequestFinalized(
    {
      lastError: failedPromotion?.promoted === false ? failedPromotion.error : null,
      requestId: chunk.requestId,
      status: failedPromotion === undefined ? 'completed' : 'failed',
    },
    database,
  )
}

const finalizeCompletedReviewServingRebuildRequestOnce = async (input: {
  chunk: ReviewServingRebuildChunkManifest
  database: ReviewServingChunkManifestRepositoryDatabase & ReviewServingProjectorWorkerDatabase
  finalizedRequestIds: Set<string>
}) => {
  if (input.chunk.requestId !== null) {
    if (input.finalizedRequestIds.has(input.chunk.requestId)) {
      return
    }

    input.finalizedRequestIds.add(input.chunk.requestId)
  }

  await finalizeCompletedReviewServingRebuildRequest(input.chunk, input.database)
}

const finalizeCompletedReviewServingRebuildRequestOnceForBatch = async (input: {
  chunk: ReviewServingRebuildChunkManifest
  completedCount: number
  database: ReviewServingChunkManifestRepositoryDatabase & ReviewServingProjectorWorkerDatabase
  finalizedRequestIds: Set<string>
  timings: Record<string, number>
}): Promise<{chunk: ReviewServingProjectorWorkerChunkResult; completedCount: number} | null> => {
  try {
    await measureReviewServingProjectorWorkerPhase(input.timings, 'finalizeRequestMs', async () => {
      await finalizeCompletedReviewServingRebuildRequestOnce({
        chunk: input.chunk,
        database: input.database,
        finalizedRequestIds: input.finalizedRequestIds,
      })
    })

    return null
  } catch (error) {
    await measureReviewServingProjectorWorkerPhase(input.timings, 'finalizeFailedRequestMs', async () => {
      await finalizeErroredCompletedReviewServingRebuildRequest({chunk: input.chunk, error}, input.database)
    })

    return {
      chunk: {chunkId: input.chunk.chunkId, requestId: input.chunk.requestId, status: 'failed'},
      completedCount: input.completedCount + 1,
    }
  }
}

const finalizeNextCompletedUnfinalizedRebuildRequest = async (input: {
  database: ReviewServingChunkManifestRepositoryDatabase & ReviewServingProjectorWorkerDatabase
  projectId?: string | null
}): Promise<{chunk: ReviewServingProjectorWorkerChunkResult; completedCount: number} | null> => {
  const chunk = await getNextCompletedUnfinalizedRebuildRequestChunk({
    database: input.database,
    projectId: input.projectId,
  })

  if (chunk === null) {
    return null
  }

  try {
    await finalizeCompletedReviewServingRebuildRequest(chunk, input.database, {deleteSummaryFilterOptions: false})

    return {
      chunk: {
        chunkId: chunk.chunkId,
        projectionComponent: chunk.projectionComponent,
        requestId: chunk.requestId,
        status: 'completed',
      },
      completedCount: 1,
    }
  } catch (error) {
    await finalizeErroredCompletedReviewServingRebuildRequest({chunk, error}, input.database)

    return {chunk: {chunkId: chunk.chunkId, requestId: chunk.requestId, status: 'failed'}, completedCount: 1}
  }
}

const getReviewServingProjectorWorkerDatabase = (
  dependencies: ReviewServingProjectorWorkerDependencies,
  workloadContext: DuckdbWorkloadContext,
): ReviewServingProjectorWorkerDatabase
  & ReviewServingChunkManifestRepositoryDatabase
  & ReviewServingRetentionServiceDatabase => {
  const database = dependencies.getDatabase?.() ?? getAppDatabaseService()

  return {
    ...database,
    queryJson: <T>(statement: string) => {
      return database.queryJson<T>(statement, workloadContext)
    },
    run: (statement: string) => {
      return database.run(statement, workloadContext)
    },
    transaction: <T>(
      operation: (tx: {
        queryJson: <T>(statement: string) => Promise<T[]>
        run: (statement: string) => Promise<void>
      }) => Promise<T>,
      transactionWorkloadContext?: DuckdbWorkloadContext,
    ) => {
      return database.transaction(operation, transactionWorkloadContext ?? workloadContext)
    },
  } as ReviewServingProjectorWorkerDatabase
    & ReviewServingChunkManifestRepositoryDatabase
    & ReviewServingRetentionServiceDatabase
}

const getWakeInput = (
  options: ReviewServingProjectorWorkerCycleOptions,
  wakeId: string,
): WakeReviewServingProjectorServiceInput => {
  return {
    batchSize: getPositiveInteger(options.batchSize, defaultReviewServingProjectorWorkerBatchSize),
    maxActiveImportCount: options.maxActiveImportCount,
    maxPendingDirtyWorkCount: options.maxPendingDirtyWorkCount,
    maxRetries: getPositiveInteger(options.maxRetries, defaultReviewServingProjectorWorkerMaxRetries),
    maxRowsPerWake: getPositiveInteger(options.maxRowsPerWake, defaultReviewServingProjectorWorkerMaxRowsPerWake),
    maxWakeMs: getPositiveInteger(options.maxWakeMs, defaultReviewServingProjectorWorkerMaxWakeMs),
    wakeId,
  }
}

const getCycleStatus = (input: {
  chunk: ReviewServingProjectorWorkerChunkResult
  cleanup: ReviewServingProjectorWorkerCleanupResult
  deltaIntake: ReviewServingProjectorWorkerDeltaIntakeResult
  projector: WakeReviewServingProjectorServiceResult
}): ReviewServingProjectorWorkerCycleResult['status'] => {
  if (input.projector.status === 'failed' || input.chunk.status === 'failed' || input.deltaIntake.status === 'failed') {
    return 'failed'
  }

  if (input.projector.status === 'partial') {
    return 'partial'
  }

  if (input.projector.status === 'blocked' && input.chunk.status === 'idle' && input.cleanup.status === 'skipped') {
    return 'idle'
  }

  return 'completed'
}

const getIdleReviewServingProjectorWorkerDeltaIntakeResult = (): ReviewServingProjectorWorkerDeltaIntakeResult => {
  return {convertedPartitions: 0, dirtyWorkCount: 0, status: 'idle'}
}

const getIdleReviewServingProjectorWorkerCycleChunkResult = (): {
  chunk: ReviewServingProjectorWorkerChunkResult
  completedCount: number
} => {
  return {chunk: {chunkId: null, status: 'idle'}, completedCount: 0}
}

const getBlockedReviewServingProjectorWakeResult = (): WakeReviewServingProjectorServiceResult => {
  return {failures: [], promotions: [], releasedClaimIds: [], runs: [], status: 'blocked'}
}

const hasForegroundDuckdbWorkQueuedForReviewServingProjectorWorker = (
  dependencies: ReviewServingProjectorWorkerDependencies,
) => {
  return (dependencies.getForegroundQueueDepth?.() ?? 0) > 0 || (dependencies.getAppendQueueDepth?.() ?? 0) > 0
}

const getForegroundRebuildDrainStartedAtMs = (input: {
  chunk: ReviewServingProjectorWorkerChunkResult
  nowMs: number
  options: ReviewServingProjectorWorkerCycleOptions
}) => {
  return input.chunk.status === 'completed' && input.chunk.requestId !== null
    ? (input.options.foregroundRebuildDrainStartedAtMs ?? input.nowMs)
    : null
}

const shouldPrioritizeNextRebuildChunk = (input: {
  chunk: ReviewServingProjectorWorkerChunkResult
  dependencies: ReviewServingProjectorWorkerDependencies
  nowMs: number
  options: ReviewServingProjectorWorkerCycleOptions
}) => {
  const defaultDrainBudget =
    input.chunk.status === 'completed' && isForegroundBatchableStatusRebuildChunk(input.chunk)
      ? foregroundStatusRebuildDrainBatchBudget
      : shouldUseExtendedForegroundRebuildDrainBudget(input)
        ? foregroundLightweightNativeHeavyRebuildDrainBatchBudget
        : defaultReviewServingProjectorWorkerForegroundRebuildDrainChunkBudget
  const budget = getPositiveInteger(input.options.foregroundRebuildDrainChunkBudget, defaultDrainBudget)
  const ttlMs = getPositiveInteger(
    input.options.foregroundRebuildDrainTtlMs,
    defaultReviewServingProjectorWorkerForegroundRebuildDrainTtlMs,
  )
  const startedAtMs = getForegroundRebuildDrainStartedAtMs(input)
  const completedCount = (input.options.foregroundRebuildDrainCompletedCount ?? 0) + 1

  return (
    input.chunk.status === 'completed'
    && input.chunk.requestId !== null
    && startedAtMs !== null
    && completedCount <= budget
    && input.nowMs - startedAtMs <= ttlMs
  )
}

const shouldYieldToForegroundRebuildReader = (input: {
  chunk: ReviewServingProjectorWorkerChunkResult
  nowMs: number
  options: ReviewServingProjectorWorkerCycleOptions
}) => {
  return input.chunk.status === 'completed' && input.chunk.requestId !== null
}

const getReviewServingProjectorWorkerProgressYieldMs = (input: {
  chunk: ReviewServingProjectorWorkerChunkResult
  dependencies: ReviewServingProjectorWorkerDependencies
  options: ReviewServingProjectorWorkerCycleOptions
}) => {
  if (input.chunk.status !== 'completed' || input.chunk.requestId === null) {
    return defaultReviewServingProjectorWorkerProgressYieldMs
  }

  if (isForegroundBatchableStatusRebuildChunk(input.chunk)) {
    return foregroundStatusReviewServingProjectorWorkerProgressYieldMs
  }

  if (!reviewServingNativeHeavyRebuildComponents.has(input.chunk.projectionComponent)) {
    return defaultReviewServingProjectorWorkerProgressYieldMs
  }

  return hasRequestAssociatedNativeHeavyChunkReachedRssCap({
    chunk: input.chunk,
    dependencies: input.dependencies,
    options: input.options,
  })
    ? nativeHeavyReviewServingProjectorWorkerProgressYieldMs
    : lightweightNativeHeavyReviewServingProjectorWorkerProgressYieldMs
}

const shouldUseExtendedForegroundRebuildDrainBudget = (input: {
  chunk: ReviewServingProjectorWorkerChunkResult
  dependencies: ReviewServingProjectorWorkerDependencies
  options: ReviewServingProjectorWorkerCycleOptions
}) => {
  if (input.chunk.status !== 'completed' || input.chunk.requestId === null) {
    return false
  }

  if (isForegroundBatchableStatusRebuildChunk(input.chunk)) {
    return true
  }

  return (
    reviewServingNativeHeavyRebuildComponents.has(input.chunk.projectionComponent)
    && !hasReviewServingProjectorWorkerReachedRssCap(input)
  )
}

const getNextForegroundRebuildDrainOptions = (input: {
  chunk: ReviewServingProjectorWorkerChunkResult
  dependencies: ReviewServingProjectorWorkerDependencies
  nowMs: number
  options: ReviewServingProjectorWorkerCycleOptions
}) => {
  const shouldContinue = shouldPrioritizeNextRebuildChunk(input)

  return shouldContinue
    ? {
        foregroundRebuildDrainCompletedCount: (input.options.foregroundRebuildDrainCompletedCount ?? 0) + 1,
        foregroundRebuildDrainStartedAtMs: getForegroundRebuildDrainStartedAtMs(input),
      }
    : {foregroundRebuildDrainCompletedCount: 0, foregroundRebuildDrainStartedAtMs: null}
}

const measureReviewServingProjectorWorkerPhase = async <T>(
  timings: Record<string, number>,
  phase: string,
  operation: () => Promise<T>,
) => {
  const startedAtMs = Date.now()

  try {
    return await operation()
  } finally {
    timings[phase] = Math.max(0, Date.now() - startedAtMs)
  }
}

const shouldRunCleanup = (input: {cleanupIntervalMs: number; lastCleanupAtMs: number | null; nowMs: number}) => {
  return input.lastCleanupAtMs === null || input.nowMs - input.lastCleanupAtMs >= input.cleanupIntervalMs
}

const logReviewServingProjectorWorkerCycle = (result: ReviewServingProjectorWorkerCycleResult) => {
  reviewServingProjectorWorkerCycleLogger.log(
    'review-serving-projector-worker:cycle',
    '[reviewServingProjectorWorker] background loop cycle',
    {
      chunkId: result.chunk.chunkId,
      chunkRequestId: 'requestId' in result.chunk ? result.chunk.requestId : null,
      chunkStatus: result.chunk.status,
      cleanupStatus: result.cleanup.status,
      component: 'reviewServingProjectorWorker',
      deltaIntakeStatus: result.deltaIntake.status,
      event: 'cycle',
      rebuildChunkBatchCount: result.chunkBatchCount,
      projectorStatus: result.projector.status,
      status: result.status,
      wakeId: result.wakeId,
      workerId: result.workerId,
    },
  )
}

const logReviewServingProjectorWorkerRebuildChunkProgress = (input: {
  chunk: ReviewServingRebuildChunkManifest
  status: 'completed' | 'failed'
  timings: Record<string, number>
  workerId: string
}) => {
  reviewServingProjectorWorkerCycleLogger.log(
    `review-serving-projector-worker:rebuild-chunk:${input.chunk.requestId ?? 'no-request'}:${input.chunk.projectionComponent}`,
    '[reviewServingProjectorWorker] rebuild chunk progress',
    {
      chunkId: input.chunk.chunkId,
      component: input.chunk.projectionComponent,
      estimatedInputRows: input.chunk.estimatedInputRows,
      estimatedOutputRows: input.chunk.estimatedOutputRows,
      event: 'rebuildChunkProgress',
      requestId: input.chunk.requestId,
      splitDepth: input.chunk.splitDepth,
      status: input.status,
      timings: input.timings,
      workerId: input.workerId,
    },
  )
}

const isRangeDisjointReviewServingProjectorWorkerRebuildChunk = (
  claimedChunk: ReviewServingRebuildChunkManifest,
  nextChunk: ReviewServingProjectorWorkerChunkInput,
) => {
  return nextChunk.chunkEndKey < claimedChunk.chunkStartKey || nextChunk.chunkStartKey > claimedChunk.chunkEndKey
}

const isRangeBatchableStatusBoundaryReviewServingProjectorWorkerRebuildChunk = (
  claimedChunk: ReviewServingRebuildChunkManifest,
  nextChunk: ReviewServingProjectorWorkerChunkInput,
) => {
  return nextChunk.chunkEndKey <= claimedChunk.chunkStartKey || nextChunk.chunkStartKey >= claimedChunk.chunkEndKey
}

const isForegroundBatchableStatusRebuildChunk = (
  chunk: Pick<ReviewServingProjectorWorkerChunkInput, 'projectionComponent' | 'requestId'>,
) => {
  return (chunk.requestId ?? null) !== null && foregroundBatchableStatusRebuildComponents.has(chunk.projectionComponent)
}

const isForegroundBatchableRangeRebuildChunk = (
  chunk: Pick<ReviewServingProjectorWorkerChunkInput, 'projectionComponent' | 'requestId'>,
) => {
  return (chunk.requestId ?? null) !== null && foregroundBatchableRangeRebuildComponents.has(chunk.projectionComponent)
}

const isForegroundBatchableRebuildChunk = (
  chunk: Pick<ReviewServingProjectorWorkerChunkInput, 'projectionComponent' | 'requestId'>,
) => {
  return isForegroundBatchableStatusRebuildChunk(chunk) || isForegroundBatchableRangeRebuildChunk(chunk)
}

const getForegroundRebuildChunkBatchSize = (chunk: {
  estimatedInputRows?: number | null
  estimatedOutputRows?: number | null
  projectionComponent: ReviewServingProjectionComponent
}) => {
  if (chunk.projectionComponent === 'humanStatus') {
    return foregroundHumanStatusRebuildChunkBatchSize
  }

  if (chunk.projectionComponent === 'llmStatus') {
    return foregroundLlmStatusRebuildChunkBatchSize
  }

  if (chunk.projectionComponent === 'posting') {
    const estimatedRows = getArticleRangeRebuildChunkEstimatedRows(chunk)

    return estimatedRows !== null && estimatedRows <= 10_000 ? 8 : 2
  }

  if (chunk.projectionComponent === 'queue') {
    return 32
  }

  return 16
}

const isCompatibleReviewServingProjectorWorkerRebuildRequestBatch = (
  firstChunk: ReviewServingRebuildChunkManifest,
  nextChunk: ReviewServingProjectorWorkerChunkInput,
) => {
  const firstRequestId = firstChunk.requestId ?? null
  const nextRequestId = nextChunk.requestId ?? null

  return (
    (firstRequestId === null && nextRequestId === null)
    || (firstRequestId !== null
      && firstRequestId === nextRequestId
      && isForegroundBatchableRebuildChunk(firstChunk)
      && isForegroundBatchableRebuildChunk(nextChunk))
  )
}

const isCompatibleReviewServingProjectorWorkerRebuildChunkBatchInput = (
  claimedChunks: readonly ReviewServingRebuildChunkManifest[],
  nextChunk: ReviewServingProjectorWorkerChunkInput,
) => {
  const firstChunk = claimedChunks[0]
  const isBatchableBoundaryRequest =
    firstChunk !== undefined
    && isForegroundBatchableStatusRebuildChunk(firstChunk)
    && isForegroundBatchableStatusRebuildChunk(nextChunk)

  return (
    firstChunk !== undefined
    && isCompatibleReviewServingProjectorWorkerRebuildRequestBatch(firstChunk, nextChunk)
    && nextChunk.projectId === firstChunk.projectId
    && nextChunk.projectionComponent === firstChunk.projectionComponent
    && nextChunk.projectionComponent !== 'summary'
    && nextChunk.projectionIdentity === firstChunk.projectionIdentity
    && nextChunk.outputBaseGeneration === firstChunk.outputBaseGeneration
    && nextChunk.inputWatermark === firstChunk.inputWatermark
    && claimedChunks.every((claimedChunk) => {
      return isBatchableBoundaryRequest
        ? isRangeBatchableStatusBoundaryReviewServingProjectorWorkerRebuildChunk(claimedChunk, nextChunk)
        : isRangeDisjointReviewServingProjectorWorkerRebuildChunk(claimedChunk, nextChunk)
    })
  )
}

const getReviewServingProjectorWorkerRebuildChunkPreclaimLimit = (input: {
  batchSize: number
  claimedChunks: readonly ClaimedReviewServingProjectorWorkerRebuildChunk[]
  options: ReviewServingProjectorWorkerCycleOptions
}) => {
  const firstClaimedChunk = input.claimedChunks[0]?.chunk
  const maxCompletedRebuildChunksPerRun = getMaxCompletedRebuildChunksPerRun(
    input.options.maxCompletedRebuildChunksPerRun,
  )
  const remainingCompletedChunkRunBudget =
    maxCompletedRebuildChunksPerRun > 0
      ? Math.max(1, maxCompletedRebuildChunksPerRun - getPositiveInteger(input.options.completedRebuildChunksInRun, 0))
      : Number.POSITIVE_INFINITY

  if (
    maxCompletedRebuildChunksPerRun > 0
    && firstClaimedChunk !== undefined
    && firstClaimedChunk.requestId !== null
    && reviewServingNativeHeavyRebuildComponents.has(firstClaimedChunk.projectionComponent)
  ) {
    return 1
  }

  if (firstClaimedChunk !== undefined && isForegroundBatchableRebuildChunk(firstClaimedChunk)) {
    return Math.min(getForegroundRebuildChunkBatchSize(firstClaimedChunk), remainingCompletedChunkRunBudget)
  }

  return Math.min(input.batchSize, remainingCompletedChunkRunBudget)
}

const shouldContinueClaimingReviewServingProjectorWorkerRebuildChunkBatch = (input: {
  batchSize: number
  claimedChunks: readonly ClaimedReviewServingProjectorWorkerRebuildChunk[]
  options: ReviewServingProjectorWorkerCycleOptions
}) => {
  return input.claimedChunks.length < getReviewServingProjectorWorkerRebuildChunkPreclaimLimit(input)
}

const shouldStopReviewServingProjectorWorkerRebuildChunkBatchAfterClaim = (
  chunk: ReviewServingRebuildChunkManifest,
) => {
  return chunk.requestId !== null && !isForegroundBatchableRebuildChunk(chunk)
}

type CompatibleStatusRebuildChunkBatchInputRow = {
  checksum: string | null
  chunkEndKey: string
  chunkStartKey: string
  inputDigest: string | null
  inputWatermark: number
  outputBaseGeneration: number
  projectId: string | null
  projectionComponent: ReviewServingProjectionComponent
  projectionIdentity: string
  requestId: string | null
}

const getCompatibleStatusRebuildChunkBatchInputs = async (input: {
  database: ReviewServingChunkManifestRepositoryTransaction
  excludeChunkIds: readonly string[]
  firstChunk: ReviewServingRebuildChunkManifest
  limit: number
  now: Date
  projectId?: string | null
}): Promise<readonly ReviewServingProjectorWorkerChunkInput[]> => {
  if (!isForegroundBatchableRebuildChunk(input.firstChunk) || input.limit <= 0) {
    return []
  }

  const excludePredicate =
    input.excludeChunkIds.length === 0
      ? ''
      : `AND candidate.chunk_id NOT IN (${input.excludeChunkIds.map(getSqlLiteral).join(', ')})`
  const rows = await input.database.queryJson<CompatibleStatusRebuildChunkBatchInputRow>(`
    SELECT
      candidate.checksum AS checksum,
      candidate.chunk_end_key AS chunkEndKey,
      candidate.chunk_start_key AS chunkStartKey,
      candidate.input_digest AS inputDigest,
      candidate.input_watermark AS inputWatermark,
      candidate.output_base_generation AS outputBaseGeneration,
      candidate.project_id AS projectId,
      candidate.projection_component AS projectionComponent,
      candidate.projection_identity AS projectionIdentity,
      candidate.request_id AS requestId
    FROM app.review_rebuild_chunk_manifest candidate
    WHERE ${getReviewServingRebuildChunkClaimWhere(
      {now: input.now, projectId: input.projectId, projectionComponent: input.firstChunk.projectionComponent},
      'candidate',
    )}
      AND candidate.request_id = ${getSqlLiteral(input.firstChunk.requestId)}
      AND candidate.project_id IS NOT DISTINCT FROM ${getSqlLiteral(input.firstChunk.projectId)}
      AND candidate.projection_identity = ${getSqlLiteral(input.firstChunk.projectionIdentity)}
      AND candidate.output_base_generation = ${getSqlLiteral(input.firstChunk.outputBaseGeneration)}
      AND candidate.input_watermark = ${getSqlLiteral(input.firstChunk.inputWatermark)}
      ${excludePredicate}
    ORDER BY
      candidate.chunk_start_key ASC,
      candidate.updated_at ASC,
      candidate.created_at ASC,
      candidate.chunk_id ASC
    LIMIT ${Math.max(0, Math.trunc(input.limit))}
  `)

  return rows.map((row) => {
    return {
      checksum: row.checksum,
      chunkEndKey: row.chunkEndKey,
      chunkStartKey: row.chunkStartKey,
      inputDigest: row.inputDigest,
      inputWatermark: Number(row.inputWatermark),
      outputBaseGeneration: Number(row.outputBaseGeneration),
      projectId: row.projectId,
      projectionComponent: row.projectionComponent,
      projectionIdentity: row.projectionIdentity,
      requestId: row.requestId ?? null,
    }
  })
}

const shouldClaimNextReviewServingProjectorWorkerRebuildChunkForBatch = (
  claimedChunks: readonly ReviewServingRebuildChunkManifest[],
  nextChunk: ReviewServingProjectorWorkerChunkInput,
) => {
  return (
    claimedChunks.length === 0
    || isCompatibleReviewServingProjectorWorkerRebuildChunkBatchInput(claimedChunks, nextChunk)
  )
}

const getRequestlessRebuildChunkAdoption = async (
  input: {chunk: ReviewServingRebuildChunkManifest; leaseOwner: string},
  database: ReviewServingChunkManifestRepositoryDatabase,
) => {
  const projectId = requireRebuildChunkProjectId(input.chunk)
  const components = await database.queryJson<{projectionComponent: ReviewServingProjectionComponent}>(`
    SELECT DISTINCT projection_component AS "projectionComponent"
    FROM app.review_rebuild_chunk_manifest
    WHERE request_id IS NULL
      AND project_id IS NOT DISTINCT FROM ${getSqlLiteral(projectId)}
      AND snapshot_id IS NOT DISTINCT FROM ${getSqlLiteral(input.chunk.snapshotId)}
      AND output_base_generation = ${getSqlLiteral(input.chunk.outputBaseGeneration)}
      AND input_watermark = ${getSqlLiteral(input.chunk.inputWatermark)}
      AND input_digest IS NOT DISTINCT FROM ${getSqlLiteral(input.chunk.inputDigest)}
      AND status NOT IN ('completed', 'blocked_over_budget', 'quarantined')
    ORDER BY projection_component
  `)
  const requestedComponents = components.map((component) => {
    return component.projectionComponent
  })

  if (requestedComponents.length === 0) {
    return null
  }

  if (
    requestedComponents.length === 1
    && requestedComponents[0] === 'summary'
    && isRequestlessSummaryRangeRebuildChunk(input.chunk)
  ) {
    return {
      diagnostics: {adoptedRequestlessSummaryChunks: true},
      reason: 'requestless_summary_range_rebuild',
      requestId: getRequestlessSummaryRangeRebuildRequestId(input.chunk),
      requestedComponents,
    }
  }

  return {
    diagnostics: {adoptedRequestlessBootstrapChunks: true},
    reason: 'requestless_bootstrap_rebuild',
    requestId: getRequestlessBootstrapRebuildRequestId(input.chunk),
    requestedComponents,
  }
}

const adoptRequestlessRebuildChunk = async (
  input: {chunk: ReviewServingRebuildChunkManifest; leaseOwner: string},
  database: ReviewServingChunkManifestRepositoryDatabase,
) => {
  if (!isRequestlessRebuildChunk(input.chunk)) {
    return input.chunk
  }

  const projectId = requireRebuildChunkProjectId(input.chunk)

  return database.transaction(async (tx) => {
    const adoption = await getRequestlessRebuildChunkAdoption(input, tx)
    if (adoption === null) {
      return input.chunk
    }
    await requireClaimedRebuildChunk(input, tx)
    await tx.run(`
      INSERT INTO app.review_rebuild_request (
        request_id,
        project_id,
        reason,
        requested_components_json,
        source_watermarks_json,
        identity_json,
        priority,
        status,
        admission_state,
        retry_policy_json,
        diagnostics_json,
        admitted_at,
        updated_at
      ) VALUES (
        ${getSqlLiteral(adoption.requestId)},
        ${getSqlLiteral(projectId)},
        ${getSqlLiteral(adoption.reason)},
        ${getSqlLiteral(JSON.stringify(adoption.requestedComponents))}::JSON,
        '{}'::JSON,
        ${getSqlLiteral(
          JSON.stringify({
            inputDigest: input.chunk.inputDigest,
            inputWatermark: input.chunk.inputWatermark,
            outputBaseGeneration: input.chunk.outputBaseGeneration,
            projectionIdentity: input.chunk.projectionIdentity,
            snapshotId: input.chunk.snapshotId,
          }),
        )}::JSON,
        100,
        'admitted',
        'admitted',
        '{}'::JSON,
        ${getSqlLiteral(JSON.stringify(adoption.diagnostics))}::JSON,
        now(),
        now()
      )
      ON CONFLICT(request_id) DO UPDATE SET
        status = CASE
          WHEN app.review_rebuild_request.status IN ('completed', 'failed') THEN app.review_rebuild_request.status
          ELSE 'admitted'
        END,
        admission_state = CASE
          WHEN app.review_rebuild_request.admission_state = 'blocked_over_budget' THEN app.review_rebuild_request.admission_state
          ELSE 'admitted'
        END,
        updated_at = now()
    `)
    await tx.run(`
      UPDATE app.review_rebuild_chunk_manifest
      SET
        request_id = ${getSqlLiteral(adoption.requestId)},
        updated_at = now()
      WHERE request_id IS NULL
        AND project_id IS NOT DISTINCT FROM ${getSqlLiteral(projectId)}
        AND snapshot_id IS NOT DISTINCT FROM ${getSqlLiteral(input.chunk.snapshotId)}
        AND output_base_generation = ${getSqlLiteral(input.chunk.outputBaseGeneration)}
        AND input_watermark = ${getSqlLiteral(input.chunk.inputWatermark)}
        AND input_digest IS NOT DISTINCT FROM ${getSqlLiteral(input.chunk.inputDigest)}
        AND status NOT IN ('completed', 'blocked_over_budget', 'quarantined')
    `)

    const adoptedChunk = await getReviewServingRebuildChunkManifest({chunkId: input.chunk.chunkId}, tx)

    if (adoptedChunk === null || adoptedChunk.requestId !== adoption.requestId) {
      throw new Error(`failed to adopt requestless rebuild chunk ${input.chunk.chunkId}`)
    }

    return adoptedChunk
  })
}

const claimReviewServingProjectorWorkerRebuildChunkInput = async ({
  chunkInput,
  database,
  options,
  service,
  timings,
  workerId,
}: {
  chunkInput: ReviewServingProjectorWorkerChunkInput
  database: ReviewServingChunkManifestRepositoryDatabase
  options: ReviewServingProjectorWorkerCycleOptions
  service: ReviewServingProjectorWorkerRebuildChunkService
  timings: Record<string, number>
  workerId: string
}): Promise<ClaimReviewServingProjectorWorkerRebuildChunkResult> => {
  const completed = await measureReviewServingProjectorWorkerPhase(timings, 'claimCompletionCheckMs', async () => {
    return service.isChunkComplete(chunkInput, database)
  })
  const claimedChunk = completed
    ? null
    : await measureReviewServingProjectorWorkerPhase(timings, 'claimUpdateMs', async () => {
        return service.claimChunk(
          {...chunkInput, leaseExpiresAt: getLeaseExpiresAt(options), leaseOwner: workerId, now: getWorkerNow(options)},
          database,
        )
      })

  if (completed) {
    return {
      chunk: {chunkId: 'completed-manifest', requestId: chunkInput.requestId ?? null, status: 'skipped'},
      status: 'not-claimed',
    }
  }

  if (claimedChunk === null) {
    return {chunk: {chunkId: null, status: 'idle'}, status: 'not-claimed'}
  }

  return {chunk: claimedChunk, service, status: 'claimed', timings}
}

const claimNextReviewServingProjectorWorkerRebuildChunk = async ({
  database,
  dependencies,
  options,
  workerId,
}: {
  database: ReviewServingChunkManifestRepositoryDatabase
  dependencies: ReviewServingProjectorWorkerDependencies
  options: ReviewServingProjectorWorkerCycleOptions
  workerId: string
}): Promise<ClaimReviewServingProjectorWorkerRebuildChunkResult> => {
  const service = dependencies.rebuildChunkService
  const timings: Record<string, number> = {}
  const chunkInput = await measureReviewServingProjectorWorkerPhase(timings, 'claimSelectMs', async () => {
    return service?.getNextChunk({database, now: getWorkerNow(options), projectId: options.rebuildProjectId})
  })

  return !service || chunkInput === null || chunkInput === undefined
    ? {chunk: {chunkId: null, status: 'idle'}, status: 'not-claimed'}
    : claimReviewServingProjectorWorkerRebuildChunkInput({chunkInput, database, options, service, timings, workerId})
}

const runClaimedReviewServingProjectorWorkerRebuildChunk = async ({
  claimedChunk,
  database,
  dependencies,
  options,
  service,
  timings,
  workloadContext,
  workerId,
}: {
  claimedChunk: ReviewServingRebuildChunkManifest
  database: ReviewServingChunkManifestRepositoryDatabase & ReviewServingProjectorWorkerDatabase
  dependencies: ReviewServingProjectorWorkerDependencies
  options: ReviewServingProjectorWorkerCycleOptions
  service: ReviewServingProjectorWorkerRebuildChunkService
  timings: Record<string, number>
  workloadContext: DuckdbWorkloadContext
  workerId: string
}): Promise<ReviewServingProjectorWorkerChunkResult> => {
  const stopHeartbeat = startClaimedRebuildChunkHeartbeat({
    chunk: claimedChunk,
    database,
    dependencies,
    options,
    service,
    workerId,
  })
  let effectiveClaimedChunk = claimedChunk

  try {
    await measureReviewServingProjectorWorkerPhase(timings, 'heartbeatMs', async () => {
      await heartbeatClaimedRebuildChunkLease({chunk: claimedChunk, database, dependencies, options, service, workerId})
    })
    if (isRequestlessRebuildChunk(effectiveClaimedChunk)) {
      effectiveClaimedChunk = await measureReviewServingProjectorWorkerPhase(
        timings,
        'adoptRequestlessMs',
        async () => {
          return adoptRequestlessRebuildChunk({chunk: effectiveClaimedChunk, leaseOwner: workerId}, database)
        },
      )
    }
    const recovered = await measureReviewServingProjectorWorkerPhase(timings, 'recoverOversizedMs', async () => {
      return recoverAdmittedOversizedRebuildChunk({chunk: effectiveClaimedChunk, leaseOwner: workerId}, database)
    })
    if (!recovered) {
      await measureReviewServingProjectorWorkerPhase(timings, 'executeMs', async () => {
        const preparedOutput = await service.prepareClaimedChunk?.({
          chunk: effectiveClaimedChunk,
          database,
          leaseOwner: workerId,
          workloadContext,
        })
        await service.runClaimedChunk({
          chunk: effectiveClaimedChunk,
          database,
          leaseOwner: workerId,
          preparedOutput,
          workloadContext,
        })
      })
    }
    stopHeartbeat()
  } catch (error) {
    stopHeartbeat()
    await recycleDuckdbAfterFatalRebuildChunkError({chunk: effectiveClaimedChunk, dependencies, error})
    const failedChunk = await measureReviewServingProjectorWorkerPhase(timings, 'failUpdateMs', async () => {
      return service.failChunk(
        {chunkId: effectiveClaimedChunk.chunkId, error: getErrorText(error), leaseOwner: workerId},
        database,
      )
    })
    await measureReviewServingProjectorWorkerPhase(timings, 'finalizeFailedRequestMs', async () => {
      await finalizeFailedReviewServingRebuildRequest(failedChunk, database)
    })
    logReviewServingProjectorWorkerRebuildChunkProgress({
      chunk: effectiveClaimedChunk,
      status: 'failed',
      timings,
      workerId,
    })

    return {chunkId: effectiveClaimedChunk.chunkId, requestId: effectiveClaimedChunk.requestId, status: 'failed'}
  }

  try {
    await measureReviewServingProjectorWorkerPhase(timings, 'finalizeRequestMs', async () => {
      await finalizeCompletedReviewServingRebuildRequest(effectiveClaimedChunk, database)
    })
    const cleanupInput = {chunk: effectiveClaimedChunk, dependencies, options}

    if (
      shouldRecycleDuckdbAfterCompletedRebuildChunk(cleanupInput)
      || shouldCollectGarbageAfterCompletedRebuildChunk(cleanupInput)
    ) {
      try {
        if (shouldRecycleDuckdbAfterCompletedRebuildChunk(cleanupInput)) {
          await measureReviewServingProjectorWorkerPhase(timings, 'duckdbRecycleMs', async () => {
            await dependencies.recycleDuckdbAfterCompletedRebuildChunk?.(effectiveClaimedChunk)
          })
        }
        await measureReviewServingProjectorWorkerPhase(timings, 'garbageCollectionMs', async () => {
          await dependencies.collectGarbageAfterCompletedRebuildChunk?.(effectiveClaimedChunk)
        })
      } catch (error) {
        reviewServingProjectorWorkerCycleLogger.warn(
          'review-serving-projector-worker:duckdb-recycle-failed',
          '[reviewServingProjectorWorker] failed to recycle DuckDB after rebuild chunk',
          {
            chunkId: effectiveClaimedChunk.chunkId,
            component: effectiveClaimedChunk.projectionComponent,
            error,
            requestId: effectiveClaimedChunk.requestId,
          },
        )
      }
    }
    logReviewServingProjectorWorkerRebuildChunkProgress({
      chunk: effectiveClaimedChunk,
      status: 'completed',
      timings,
      workerId,
    })

    return {
      chunkId: effectiveClaimedChunk.chunkId,
      projectionComponent: effectiveClaimedChunk.projectionComponent,
      requestId: effectiveClaimedChunk.requestId,
      status: 'completed',
    }
  } catch (error) {
    await finalizeErroredCompletedReviewServingRebuildRequest({chunk: effectiveClaimedChunk, error}, database)

    return {chunkId: effectiveClaimedChunk.chunkId, requestId: effectiveClaimedChunk.requestId, status: 'failed'}
  }
}

const recycleDuckdbAfterFatalRebuildChunkError = async (input: {
  chunk: ReviewServingRebuildChunkManifest
  dependencies: ReviewServingProjectorWorkerDependencies
  error: unknown
}) => {
  if (!isDuckDbFatalRuntimeError(input.error)) {
    return
  }

  try {
    await input.dependencies.recycleDuckdbAfterFatalRebuildChunkError?.({chunk: input.chunk, error: input.error})
  } catch (error) {
    reviewServingProjectorWorkerCycleLogger.warn(
      'review-serving-projector-worker:duckdb-fatal-error-recycle-failed',
      '[reviewServingProjectorWorker] failed to recycle DuckDB after fatal rebuild chunk error',
      {
        chunkId: input.chunk.chunkId,
        component: input.chunk.projectionComponent,
        error,
        requestId: input.chunk.requestId,
      },
    )
  }
}

const runReviewServingProjectorWorkerRebuildChunk = async ({
  database,
  dependencies,
  options,
  workloadContext,
  workerId,
}: {
  database: ReviewServingChunkManifestRepositoryDatabase & ReviewServingProjectorWorkerDatabase
  dependencies: ReviewServingProjectorWorkerDependencies
  options: ReviewServingProjectorWorkerCycleOptions
  workloadContext: DuckdbWorkloadContext
  workerId: string
}): Promise<ReviewServingProjectorWorkerChunkResult> => {
  const claimed = await claimNextReviewServingProjectorWorkerRebuildChunk({database, dependencies, options, workerId})

  return claimed.status === 'claimed'
    ? runClaimedReviewServingProjectorWorkerRebuildChunk({
        claimedChunk: claimed.chunk,
        database,
        dependencies,
        options,
        service: claimed.service,
        timings: claimed.timings,
        workloadContext,
        workerId,
      })
    : claimed.chunk
}

const claimCompatibleReviewServingProjectorWorkerStatusBatchTail = async (input: {
  batchSize: number
  claimedChunks: ClaimedReviewServingProjectorWorkerRebuildChunk[]
  database: ReviewServingChunkManifestRepositoryDatabase
  options: ReviewServingProjectorWorkerCycleOptions
  service: ReviewServingProjectorWorkerRebuildChunkService
  workerId: string
}) => {
  const firstClaimedChunk = input.claimedChunks[0]?.chunk
  const getCompatibleStatusChunks = input.service.getCompatibleStatusChunks

  if (firstClaimedChunk === undefined || getCompatibleStatusChunks === undefined) {
    return false
  }

  const preclaimLimit = getReviewServingProjectorWorkerRebuildChunkPreclaimLimit({
    batchSize: input.batchSize,
    claimedChunks: input.claimedChunks,
    options: input.options,
  })
  const remainingLimit = preclaimLimit - input.claimedChunks.length

  if (remainingLimit <= 0 || !isForegroundBatchableRebuildChunk(firstClaimedChunk)) {
    return false
  }

  const candidateChunks = await getCompatibleStatusChunks({
    database: input.database,
    excludeChunkIds: input.claimedChunks.map((claimed) => {
      return claimed.chunk.chunkId
    }),
    firstChunk: firstClaimedChunk,
    limit: remainingLimit,
    now: getWorkerNow(input.options),
    projectId: input.options.rebuildProjectId,
  })
  const exhaustedCandidateSearch = candidateChunks.length < remainingLimit

  for (const chunkInput of candidateChunks) {
    if (
      !shouldContinueClaimingReviewServingProjectorWorkerRebuildChunkBatch({
        batchSize: input.batchSize,
        claimedChunks: input.claimedChunks,
        options: input.options,
      })
      || !shouldClaimNextReviewServingProjectorWorkerRebuildChunkForBatch(
        input.claimedChunks.map((claimed) => {
          return claimed.chunk
        }),
        chunkInput,
      )
    ) {
      break
    }

    const timings: Record<string, number> = {claimSelectMs: 0}
    const claimed = await claimReviewServingProjectorWorkerRebuildChunkInput({
      chunkInput,
      database: input.database,
      options: input.options,
      service: input.service,
      timings,
      workerId: input.workerId,
    })

    if (claimed.status !== 'claimed') {
      break
    }

    input.claimedChunks.push({chunk: claimed.chunk, service: claimed.service, timings: claimed.timings})
  }

  return exhaustedCandidateSearch
}

const claimCompatibleReviewServingProjectorWorkerRebuildChunkBatch = async (
  input: Parameters<typeof runReviewServingProjectorWorkerRebuildChunk>[0] & {batchSize: number},
): Promise<
  | {claimedChunks: readonly ClaimedReviewServingProjectorWorkerRebuildChunk[]; status: 'claimed'}
  | {chunk: ReviewServingProjectorWorkerChunkResult; status: 'not-claimed'}
> => {
  const service = input.dependencies.rebuildChunkService
  const claimedChunks: ClaimedReviewServingProjectorWorkerRebuildChunk[] = []

  if (!service) {
    return {chunk: {chunkId: null, status: 'idle'}, status: 'not-claimed'}
  }

  while (
    shouldContinueClaimingReviewServingProjectorWorkerRebuildChunkBatch({
      batchSize: input.batchSize,
      claimedChunks,
      options: input.options,
    })
  ) {
    const timings: Record<string, number> = {}
    const chunkInput = await measureReviewServingProjectorWorkerPhase(timings, 'claimSelectMs', async () => {
      return service.getNextChunk({
        database: input.database,
        now: getWorkerNow(input.options),
        projectId: input.options.rebuildProjectId,
      })
    })

    if (chunkInput === null) {
      break
    }

    if (
      !shouldClaimNextReviewServingProjectorWorkerRebuildChunkForBatch(
        claimedChunks.map((chunk) => {
          return chunk.chunk
        }),
        chunkInput,
      )
    ) {
      break
    }

    const claimed = await claimReviewServingProjectorWorkerRebuildChunkInput({
      chunkInput,
      database: input.database,
      options: input.options,
      service,
      timings,
      workerId: input.workerId,
    })

    if (claimed.status !== 'claimed') {
      return claimedChunks.length === 0 ? claimed : {claimedChunks, status: 'claimed'}
    }

    claimedChunks.push({chunk: claimed.chunk, service: claimed.service, timings: claimed.timings})

    if (shouldStopReviewServingProjectorWorkerRebuildChunkBatchAfterClaim(claimed.chunk)) {
      break
    }

    if (claimedChunks.length === 1 && isForegroundBatchableRebuildChunk(claimed.chunk)) {
      const exhaustedStatusBatch = await claimCompatibleReviewServingProjectorWorkerStatusBatchTail({
        batchSize: input.batchSize,
        claimedChunks,
        database: input.database,
        options: input.options,
        service,
        workerId: input.workerId,
      })
      if (exhaustedStatusBatch) {
        break
      }
    }
  }

  return claimedChunks.length === 0
    ? {chunk: {chunkId: null, status: 'idle'}, status: 'not-claimed'}
    : {claimedChunks, status: 'claimed'}
}

const failClaimedReviewServingProjectorWorkerRebuildChunkBatch = async (input: {
  claimedChunks: readonly ClaimedReviewServingProjectorWorkerRebuildChunk[]
  completedCount: number
  database: ReviewServingChunkManifestRepositoryDatabase & ReviewServingProjectorWorkerDatabase
  dependencies: ReviewServingProjectorWorkerDependencies
  error: unknown
  workerId: string
}): Promise<{chunk: ReviewServingProjectorWorkerChunkResult; completedCount: number}> => {
  const failedResults = await input.claimedChunks.reduce<Promise<ReviewServingProjectorWorkerChunkResult[]>>(
    async (previous, claimed) => {
      const results = await previous
      await recycleDuckdbAfterFatalRebuildChunkError({
        chunk: claimed.chunk,
        dependencies: input.dependencies,
        error: input.error,
      })
      const failedChunk = await measureReviewServingProjectorWorkerPhase(claimed.timings, 'failUpdateMs', async () => {
        return claimed.service.failChunk(
          {chunkId: claimed.chunk.chunkId, error: getErrorText(input.error), leaseOwner: input.workerId},
          input.database,
        )
      })

      await measureReviewServingProjectorWorkerPhase(claimed.timings, 'finalizeFailedRequestMs', async () => {
        await finalizeFailedReviewServingRebuildRequest(failedChunk, input.database)
      })
      logReviewServingProjectorWorkerRebuildChunkProgress({
        chunk: claimed.chunk,
        status: 'failed',
        timings: claimed.timings,
        workerId: input.workerId,
      })

      return [
        ...results,
        {chunkId: claimed.chunk.chunkId, requestId: claimed.chunk.requestId, status: 'failed' as const},
      ]
    },
    Promise.resolve([]),
  )
  const [firstFailedResult] = failedResults

  if (firstFailedResult === undefined) {
    throw input.error
  }

  return {chunk: firstFailedResult, completedCount: input.completedCount}
}

const prepareClaimedReviewServingProjectorWorkerRebuildChunkBatch = async (input: {
  claimedChunks: readonly ClaimedReviewServingProjectorWorkerRebuildChunk[]
  database: ReviewServingChunkManifestRepositoryDatabase & ReviewServingProjectorWorkerDatabase
  dependencies: ReviewServingProjectorWorkerDependencies
  options: ReviewServingProjectorWorkerCycleOptions
  workloadContext: DuckdbWorkloadContext
  workerId: string
}) => {
  await heartbeatClaimedRebuildChunkBatchLeases(input)
  const stopHeartbeat = startClaimedRebuildChunkBatchHeartbeats(input)

  try {
    return await Promise.all(
      input.claimedChunks.map((claimed) => {
        return measureReviewServingProjectorWorkerPhase(claimed.timings, 'prepareMs', async () => {
          return claimed.service.prepareClaimedChunk?.({
            chunk: claimed.chunk,
            database: input.database,
            leaseOwner: input.workerId,
            workloadContext: input.workloadContext,
          })
        })
      }),
    )
  } finally {
    stopHeartbeat()
  }
}

const runPreparedClaimedReviewServingProjectorWorkerRebuildChunk = async (input: {
  claimed: ClaimedReviewServingProjectorWorkerRebuildChunk
  database: ReviewServingChunkManifestRepositoryDatabase & ReviewServingProjectorWorkerDatabase
  preparedOutput: unknown
  workloadContext: DuckdbWorkloadContext
  workerId: string
}) => {
  return measureReviewServingProjectorWorkerPhase(input.claimed.timings, 'executeMs', async () => {
    await input.claimed.service.runClaimedChunk({
      chunk: input.claimed.chunk,
      database: input.database,
      leaseOwner: input.workerId,
      preparedOutput: input.preparedOutput,
      workloadContext: input.workloadContext,
    })
    await measureReviewServingProjectorWorkerPhase(input.claimed.timings, 'finalizeRequestMs', async () => {
      await finalizeCompletedReviewServingRebuildRequest(input.claimed.chunk, input.database)
    })

    return {
      chunkId: input.claimed.chunk.chunkId,
      projectionComponent: input.claimed.chunk.projectionComponent,
      requestId: input.claimed.chunk.requestId,
      status: 'completed' as const,
    }
  })
}

const runProjectScopeReviewServingProjectorWorkerRebuildChunkBatch = async (input: {
  claimedChunks: readonly ClaimedReviewServingProjectorWorkerRebuildChunk[]
  database: ReviewServingChunkManifestRepositoryDatabase & ReviewServingProjectorWorkerDatabase
  dependencies: ReviewServingProjectorWorkerDependencies
  options: ReviewServingProjectorWorkerCycleOptions
  workerId: string
}): Promise<{chunk: ReviewServingProjectorWorkerChunkResult; completedCount: number} | null> => {
  const chunks = input.claimedChunks.map((claimed) => {
    return claimed.chunk
  })
  let completedCount = 0
  let lastCompletedChunk: ReviewServingProjectorWorkerChunkResult | null = null
  let batchResults: Awaited<ReturnType<typeof runProjectScopeRebuildChunkBatch>>

  try {
    await heartbeatClaimedRebuildChunkBatchLeases(input)
    const stopHeartbeat = startClaimedRebuildChunkBatchHeartbeats(input)

    try {
      batchResults = await runProjectScopeRebuildChunkBatch({chunks, leaseOwner: input.workerId}, input.database)
    } finally {
      stopHeartbeat()
    }
  } catch (error) {
    return failClaimedReviewServingProjectorWorkerRebuildChunkBatch({
      claimedChunks: input.claimedChunks,
      completedCount,
      database: input.database,
      dependencies: input.dependencies,
      error,
      workerId: input.workerId,
    })
  }

  if (batchResults === null) {
    return null
  }

  const finalizedRequestIds = new Set<string>()

  for (const result of batchResults) {
    const claimed = input.claimedChunks.find((candidate) => {
      return candidate.chunk.chunkId === result.chunkId
    })

    if (claimed === undefined) {
      continue
    }

    const finalizationFailure = await finalizeCompletedReviewServingRebuildRequestOnceForBatch({
      chunk: claimed.chunk,
      completedCount,
      database: input.database,
      finalizedRequestIds,
      timings: claimed.timings,
    })

    if (finalizationFailure !== null) {
      return finalizationFailure
    }
    logReviewServingProjectorWorkerRebuildChunkProgress({
      chunk: claimed.chunk,
      status: 'completed',
      timings: claimed.timings,
      workerId: input.workerId,
    })
    completedCount += 1
    lastCompletedChunk = result
  }

  return {chunk: lastCompletedChunk ?? {chunkId: null, status: 'idle'}, completedCount}
}

const runSelectedImportReviewServingProjectorWorkerRebuildChunkBatch = async (input: {
  claimedChunks: readonly ClaimedReviewServingProjectorWorkerRebuildChunk[]
  database: ReviewServingChunkManifestRepositoryDatabase & ReviewServingProjectorWorkerDatabase
  dependencies: ReviewServingProjectorWorkerDependencies
  options: ReviewServingProjectorWorkerCycleOptions
  workerId: string
}): Promise<{chunk: ReviewServingProjectorWorkerChunkResult; completedCount: number} | null> => {
  const chunks = input.claimedChunks.map((claimed) => {
    return claimed.chunk
  })
  let completedCount = 0
  let lastCompletedChunk: ReviewServingProjectorWorkerChunkResult | null = null
  let batchResults: Awaited<ReturnType<typeof runSelectedImportRebuildChunkBatch>>

  try {
    await heartbeatClaimedRebuildChunkBatchLeases(input)
    const stopHeartbeat = startClaimedRebuildChunkBatchHeartbeats(input)

    try {
      batchResults = await runSelectedImportRebuildChunkBatch({chunks, leaseOwner: input.workerId}, input.database)
    } finally {
      stopHeartbeat()
    }
  } catch (error) {
    return failClaimedReviewServingProjectorWorkerRebuildChunkBatch({
      claimedChunks: input.claimedChunks,
      completedCount,
      database: input.database,
      dependencies: input.dependencies,
      error,
      workerId: input.workerId,
    })
  }

  if (batchResults === null) {
    return null
  }

  const finalizedRequestIds = new Set<string>()

  for (const result of batchResults) {
    const claimed = input.claimedChunks.find((candidate) => {
      return candidate.chunk.chunkId === result.chunkId
    })

    if (claimed === undefined) {
      continue
    }

    const finalizationFailure = await finalizeCompletedReviewServingRebuildRequestOnceForBatch({
      chunk: claimed.chunk,
      completedCount,
      database: input.database,
      finalizedRequestIds,
      timings: claimed.timings,
    })

    if (finalizationFailure !== null) {
      return finalizationFailure
    }
    logReviewServingProjectorWorkerRebuildChunkProgress({
      chunk: claimed.chunk,
      status: 'completed',
      timings: claimed.timings,
      workerId: input.workerId,
    })
    completedCount += 1
    lastCompletedChunk = result
  }

  return {chunk: lastCompletedChunk ?? {chunkId: null, status: 'idle'}, completedCount}
}

const runDisplayReviewServingProjectorWorkerRebuildChunkBatch = async (input: {
  claimedChunks: readonly ClaimedReviewServingProjectorWorkerRebuildChunk[]
  database: ReviewServingChunkManifestRepositoryDatabase & ReviewServingProjectorWorkerDatabase
  dependencies: ReviewServingProjectorWorkerDependencies
  options: ReviewServingProjectorWorkerCycleOptions
  workerId: string
}): Promise<{chunk: ReviewServingProjectorWorkerChunkResult; completedCount: number} | null> => {
  const chunks = input.claimedChunks.map((claimed) => {
    return claimed.chunk
  })
  let completedCount = 0
  let lastCompletedChunk: ReviewServingProjectorWorkerChunkResult | null = null
  let batchResults: Awaited<ReturnType<typeof runDisplayRebuildChunkBatch>>

  try {
    await heartbeatClaimedRebuildChunkBatchLeases(input)
    const stopHeartbeat = startClaimedRebuildChunkBatchHeartbeats(input)

    try {
      batchResults = await runDisplayRebuildChunkBatch({chunks, leaseOwner: input.workerId}, input.database)
    } finally {
      stopHeartbeat()
    }
  } catch (error) {
    return failClaimedReviewServingProjectorWorkerRebuildChunkBatch({
      claimedChunks: input.claimedChunks,
      completedCount,
      database: input.database,
      dependencies: input.dependencies,
      error,
      workerId: input.workerId,
    })
  }

  if (batchResults === null) {
    return null
  }

  const finalizedRequestIds = new Set<string>()

  for (const result of batchResults) {
    const claimed = input.claimedChunks.find((candidate) => {
      return candidate.chunk.chunkId === result.chunkId
    })

    if (claimed === undefined) {
      continue
    }

    const finalizationFailure = await finalizeCompletedReviewServingRebuildRequestOnceForBatch({
      chunk: claimed.chunk,
      completedCount,
      database: input.database,
      finalizedRequestIds,
      timings: claimed.timings,
    })

    if (finalizationFailure !== null) {
      return finalizationFailure
    }
    logReviewServingProjectorWorkerRebuildChunkProgress({
      chunk: claimed.chunk,
      status: 'completed',
      timings: claimed.timings,
      workerId: input.workerId,
    })
    completedCount += 1
    lastCompletedChunk = result
  }

  return {chunk: lastCompletedChunk ?? {chunkId: null, status: 'idle'}, completedCount}
}

const runPayloadReviewServingProjectorWorkerRebuildChunkBatch = async (input: {
  claimedChunks: readonly ClaimedReviewServingProjectorWorkerRebuildChunk[]
  database: ReviewServingChunkManifestRepositoryDatabase & ReviewServingProjectorWorkerDatabase
  dependencies: ReviewServingProjectorWorkerDependencies
  options: ReviewServingProjectorWorkerCycleOptions
  workerId: string
}): Promise<{chunk: ReviewServingProjectorWorkerChunkResult; completedCount: number} | null> => {
  const chunks = input.claimedChunks.map((claimed) => {
    return claimed.chunk
  })
  let completedCount = 0
  let lastCompletedChunk: ReviewServingProjectorWorkerChunkResult | null = null
  let batchResults: Awaited<ReturnType<typeof runPayloadRebuildChunkBatch>>

  try {
    await heartbeatClaimedRebuildChunkBatchLeases(input)
    const stopHeartbeat = startClaimedRebuildChunkBatchHeartbeats(input)

    try {
      batchResults = await runPayloadRebuildChunkBatch({chunks, leaseOwner: input.workerId}, input.database)
    } finally {
      stopHeartbeat()
    }
  } catch (error) {
    return failClaimedReviewServingProjectorWorkerRebuildChunkBatch({
      claimedChunks: input.claimedChunks,
      completedCount,
      database: input.database,
      dependencies: input.dependencies,
      error,
      workerId: input.workerId,
    })
  }

  if (batchResults === null) {
    return null
  }

  const finalizedRequestIds = new Set<string>()

  for (const result of batchResults) {
    const claimed = input.claimedChunks.find((candidate) => {
      return candidate.chunk.chunkId === result.chunkId
    })

    if (claimed === undefined) {
      continue
    }

    const finalizationFailure = await finalizeCompletedReviewServingRebuildRequestOnceForBatch({
      chunk: claimed.chunk,
      completedCount,
      database: input.database,
      finalizedRequestIds,
      timings: claimed.timings,
    })

    if (finalizationFailure !== null) {
      return finalizationFailure
    }
    logReviewServingProjectorWorkerRebuildChunkProgress({
      chunk: claimed.chunk,
      status: 'completed',
      timings: claimed.timings,
      workerId: input.workerId,
    })
    completedCount += 1
    lastCompletedChunk = result
  }

  return {chunk: lastCompletedChunk ?? {chunkId: null, status: 'idle'}, completedCount}
}

const runSearchReviewServingProjectorWorkerRebuildChunkBatch = async (input: {
  claimedChunks: readonly ClaimedReviewServingProjectorWorkerRebuildChunk[]
  database: ReviewServingChunkManifestRepositoryDatabase & ReviewServingProjectorWorkerDatabase
  dependencies: ReviewServingProjectorWorkerDependencies
  options: ReviewServingProjectorWorkerCycleOptions
  workerId: string
}): Promise<{chunk: ReviewServingProjectorWorkerChunkResult; completedCount: number} | null> => {
  const chunks = input.claimedChunks.map((claimed) => {
    return claimed.chunk
  })
  let completedCount = 0
  let lastCompletedChunk: ReviewServingProjectorWorkerChunkResult | null = null
  let batchResults: Awaited<ReturnType<typeof runSearchRebuildChunkBatch>>

  try {
    await heartbeatClaimedRebuildChunkBatchLeases(input)
    const stopHeartbeat = startClaimedRebuildChunkBatchHeartbeats(input)

    try {
      batchResults = await runSearchRebuildChunkBatch({chunks, leaseOwner: input.workerId}, input.database)
    } finally {
      stopHeartbeat()
    }
  } catch (error) {
    return failClaimedReviewServingProjectorWorkerRebuildChunkBatch({
      claimedChunks: input.claimedChunks,
      completedCount,
      database: input.database,
      dependencies: input.dependencies,
      error,
      workerId: input.workerId,
    })
  }

  if (batchResults === null) {
    return null
  }

  const finalizedRequestIds = new Set<string>()

  for (const result of batchResults) {
    const claimed = input.claimedChunks.find((candidate) => {
      return candidate.chunk.chunkId === result.chunkId
    })

    if (claimed === undefined) {
      continue
    }

    const finalizationFailure = await finalizeCompletedReviewServingRebuildRequestOnceForBatch({
      chunk: claimed.chunk,
      completedCount,
      database: input.database,
      finalizedRequestIds,
      timings: claimed.timings,
    })

    if (finalizationFailure !== null) {
      return finalizationFailure
    }
    logReviewServingProjectorWorkerRebuildChunkProgress({
      chunk: claimed.chunk,
      status: 'completed',
      timings: claimed.timings,
      workerId: input.workerId,
    })
    completedCount += 1
    lastCompletedChunk = result
  }

  return {chunk: lastCompletedChunk ?? {chunkId: null, status: 'idle'}, completedCount}
}

const runQueueReviewServingProjectorWorkerRebuildChunkBatch = async (input: {
  claimedChunks: readonly ClaimedReviewServingProjectorWorkerRebuildChunk[]
  database: ReviewServingChunkManifestRepositoryDatabase & ReviewServingProjectorWorkerDatabase
  dependencies: ReviewServingProjectorWorkerDependencies
  options: ReviewServingProjectorWorkerCycleOptions
  workerId: string
}): Promise<{chunk: ReviewServingProjectorWorkerChunkResult; completedCount: number} | null> => {
  const chunks = input.claimedChunks.map((claimed) => {
    return claimed.chunk
  })
  let completedCount = 0
  let lastCompletedChunk: ReviewServingProjectorWorkerChunkResult | null = null
  let batchResults: Awaited<ReturnType<typeof runQueueRebuildChunkBatch>>

  try {
    await heartbeatClaimedRebuildChunkBatchLeases(input)
    const stopHeartbeat = startClaimedRebuildChunkBatchHeartbeats(input)

    try {
      batchResults = await runQueueRebuildChunkBatch({chunks, leaseOwner: input.workerId}, input.database)
    } finally {
      stopHeartbeat()
    }
  } catch (error) {
    return failClaimedReviewServingProjectorWorkerRebuildChunkBatch({
      claimedChunks: input.claimedChunks,
      completedCount,
      database: input.database,
      dependencies: input.dependencies,
      error,
      workerId: input.workerId,
    })
  }

  if (batchResults === null) {
    return null
  }

  const finalizedRequestIds = new Set<string>()

  for (const result of batchResults) {
    const claimed = input.claimedChunks.find((candidate) => {
      return candidate.chunk.chunkId === result.chunkId
    })

    if (claimed === undefined) {
      continue
    }

    const finalizationFailure = await finalizeCompletedReviewServingRebuildRequestOnceForBatch({
      chunk: claimed.chunk,
      completedCount,
      database: input.database,
      finalizedRequestIds,
      timings: claimed.timings,
    })

    if (finalizationFailure !== null) {
      return finalizationFailure
    }
    logReviewServingProjectorWorkerRebuildChunkProgress({
      chunk: claimed.chunk,
      status: 'completed',
      timings: claimed.timings,
      workerId: input.workerId,
    })
    completedCount += 1
    lastCompletedChunk = result
  }

  return {chunk: lastCompletedChunk ?? {chunkId: null, status: 'idle'}, completedCount}
}

const runJudgmentInputContentReviewServingProjectorWorkerRebuildChunkBatch = async (input: {
  claimedChunks: readonly ClaimedReviewServingProjectorWorkerRebuildChunk[]
  database: ReviewServingChunkManifestRepositoryDatabase & ReviewServingProjectorWorkerDatabase
  dependencies: ReviewServingProjectorWorkerDependencies
  options: ReviewServingProjectorWorkerCycleOptions
  workerId: string
}): Promise<{chunk: ReviewServingProjectorWorkerChunkResult; completedCount: number} | null> => {
  const chunks = input.claimedChunks.map((claimed) => {
    return claimed.chunk
  })
  let completedCount = 0
  let lastCompletedChunk: ReviewServingProjectorWorkerChunkResult | null = null
  let batchResults: Awaited<ReturnType<typeof runJudgmentInputContentRebuildChunkBatch>>

  try {
    await heartbeatClaimedRebuildChunkBatchLeases(input)
    const stopHeartbeat = startClaimedRebuildChunkBatchHeartbeats(input)

    try {
      batchResults = await runJudgmentInputContentRebuildChunkBatch(
        {chunks, leaseOwner: input.workerId},
        input.database,
      )
    } finally {
      stopHeartbeat()
    }
  } catch (error) {
    return failClaimedReviewServingProjectorWorkerRebuildChunkBatch({
      claimedChunks: input.claimedChunks,
      completedCount,
      database: input.database,
      dependencies: input.dependencies,
      error,
      workerId: input.workerId,
    })
  }

  if (batchResults === null) {
    return null
  }

  const finalizedRequestIds = new Set<string>()

  for (const result of batchResults) {
    const claimed = input.claimedChunks.find((candidate) => {
      return candidate.chunk.chunkId === result.chunkId
    })

    if (claimed === undefined) {
      continue
    }

    const finalizationFailure = await finalizeCompletedReviewServingRebuildRequestOnceForBatch({
      chunk: claimed.chunk,
      completedCount,
      database: input.database,
      finalizedRequestIds,
      timings: claimed.timings,
    })

    if (finalizationFailure !== null) {
      return finalizationFailure
    }
    logReviewServingProjectorWorkerRebuildChunkProgress({
      chunk: claimed.chunk,
      status: 'completed',
      timings: claimed.timings,
      workerId: input.workerId,
    })
    completedCount += 1
    lastCompletedChunk = result
  }

  return {chunk: lastCompletedChunk ?? {chunkId: null, status: 'idle'}, completedCount}
}

const runReviewServingProjectorWorkerRebuildChunkBatchWith = async (
  input: {
    claimedChunks: readonly ClaimedReviewServingProjectorWorkerRebuildChunk[]
    database: ReviewServingChunkManifestRepositoryDatabase & ReviewServingProjectorWorkerDatabase
    dependencies: ReviewServingProjectorWorkerDependencies
    options: ReviewServingProjectorWorkerCycleOptions
    workerId: string
  },
  runBatch: (
    input: {chunks: readonly ReviewServingRebuildChunkManifest[]; leaseOwner: string},
    database: ReviewServingChunkManifestRepositoryDatabase & ReviewServingProjectorWorkerDatabase,
  ) => Promise<readonly Extract<ReviewServingProjectorWorkerChunkResult, {status: 'completed'}>[] | null>,
): Promise<{chunk: ReviewServingProjectorWorkerChunkResult; completedCount: number} | null> => {
  const chunks = input.claimedChunks.map((claimed) => {
    return claimed.chunk
  })
  let completedCount = 0
  let lastCompletedChunk: ReviewServingProjectorWorkerChunkResult | null = null
  let batchResults: Awaited<ReturnType<typeof runBatch>>

  try {
    await heartbeatClaimedRebuildChunkBatchLeases(input)
    const stopHeartbeat = startClaimedRebuildChunkBatchHeartbeats(input)

    try {
      batchResults = await runBatch({chunks, leaseOwner: input.workerId}, input.database)
    } finally {
      stopHeartbeat()
    }
  } catch (error) {
    return failClaimedReviewServingProjectorWorkerRebuildChunkBatch({
      claimedChunks: input.claimedChunks,
      completedCount,
      database: input.database,
      dependencies: input.dependencies,
      error,
      workerId: input.workerId,
    })
  }

  if (batchResults === null) {
    return null
  }

  const finalizedRequestIds = new Set<string>()

  for (const result of batchResults) {
    const claimed = input.claimedChunks.find((candidate) => {
      return candidate.chunk.chunkId === result.chunkId
    })

    if (claimed === undefined) {
      continue
    }

    const finalizationFailure = await finalizeCompletedReviewServingRebuildRequestOnceForBatch({
      chunk: claimed.chunk,
      completedCount,
      database: input.database,
      finalizedRequestIds,
      timings: claimed.timings,
    })

    if (finalizationFailure !== null) {
      return finalizationFailure
    }
    logReviewServingProjectorWorkerRebuildChunkProgress({
      chunk: claimed.chunk,
      status: 'completed',
      timings: claimed.timings,
      workerId: input.workerId,
    })
    completedCount += 1
    lastCompletedChunk = result
  }

  const recycledChunk = input.claimedChunks.at(-1)

  const cleanupInput =
    recycledChunk === undefined
      ? null
      : {chunk: recycledChunk.chunk, dependencies: input.dependencies, options: input.options}

  if (
    recycledChunk !== undefined
    && cleanupInput !== null
    && (shouldRecycleDuckdbAfterCompletedRebuildChunk(cleanupInput)
      || shouldCollectGarbageAfterCompletedRebuildChunk(cleanupInput))
  ) {
    try {
      if (shouldRecycleDuckdbAfterCompletedRebuildChunk(cleanupInput)) {
        await measureReviewServingProjectorWorkerPhase(recycledChunk.timings, 'duckdbRecycleMs', async () => {
          await input.dependencies.recycleDuckdbAfterCompletedRebuildChunk?.(recycledChunk.chunk)
        })
      }
      await measureReviewServingProjectorWorkerPhase(recycledChunk.timings, 'garbageCollectionMs', async () => {
        await input.dependencies.collectGarbageAfterCompletedRebuildChunk?.(recycledChunk.chunk)
      })
    } catch (error) {
      reviewServingProjectorWorkerCycleLogger.warn(
        'review-serving-projector-worker:duckdb-recycle-failed',
        '[reviewServingProjectorWorker] failed to recycle DuckDB after rebuild chunk batch',
        {
          chunkId: recycledChunk.chunk.chunkId,
          component: recycledChunk.chunk.projectionComponent,
          error,
          requestId: recycledChunk.chunk.requestId,
        },
      )
    }
  }

  return {chunk: lastCompletedChunk ?? {chunkId: null, status: 'idle'}, completedCount}
}

const runLlmStatusReviewServingProjectorWorkerRebuildChunkBatch = async (input: {
  claimedChunks: readonly ClaimedReviewServingProjectorWorkerRebuildChunk[]
  database: ReviewServingChunkManifestRepositoryDatabase & ReviewServingProjectorWorkerDatabase
  dependencies: ReviewServingProjectorWorkerDependencies
  options: ReviewServingProjectorWorkerCycleOptions
  workerId: string
}) => {
  return runReviewServingProjectorWorkerRebuildChunkBatchWith(input, runLlmStatusRebuildChunkBatch)
}

const runHumanStatusReviewServingProjectorWorkerRebuildChunkBatch = async (input: {
  claimedChunks: readonly ClaimedReviewServingProjectorWorkerRebuildChunk[]
  database: ReviewServingChunkManifestRepositoryDatabase & ReviewServingProjectorWorkerDatabase
  dependencies: ReviewServingProjectorWorkerDependencies
  options: ReviewServingProjectorWorkerCycleOptions
  workerId: string
}) => {
  return runReviewServingProjectorWorkerRebuildChunkBatchWith(input, runHumanStatusRebuildChunkBatch)
}

const runPostingReviewServingProjectorWorkerRebuildChunkBatch = async (input: {
  claimedChunks: readonly ClaimedReviewServingProjectorWorkerRebuildChunk[]
  database: ReviewServingChunkManifestRepositoryDatabase & ReviewServingProjectorWorkerDatabase
  dependencies: ReviewServingProjectorWorkerDependencies
  options: ReviewServingProjectorWorkerCycleOptions
  workerId: string
}) => {
  return runReviewServingProjectorWorkerRebuildChunkBatchWith(input, runPostingRebuildChunkBatch)
}

const runReviewServingProjectorWorkerRebuildChunkBatch = async (
  input: Parameters<typeof runReviewServingProjectorWorkerRebuildChunk>[0],
): Promise<{chunk: ReviewServingProjectorWorkerChunkResult; completedCount: number}> => {
  const batchSize = getEffectiveReviewServingProjectorWorkerRebuildChunkBatchSize(input)
  let completedCount = 0
  let lastCompletedChunk: ReviewServingProjectorWorkerChunkResult | null = null

  if (batchSize > 1) {
    const claimedBatch = await claimCompatibleReviewServingProjectorWorkerRebuildChunkBatch({...input, batchSize})

    if (claimedBatch.status === 'not-claimed') {
      return {chunk: claimedBatch.chunk, completedCount}
    }

    const projectScopeBatch = await runProjectScopeReviewServingProjectorWorkerRebuildChunkBatch({
      claimedChunks: claimedBatch.claimedChunks,
      database: input.database,
      dependencies: input.dependencies,
      options: input.options,
      workerId: input.workerId,
    })

    if (projectScopeBatch !== null) {
      return projectScopeBatch
    }

    const selectedImportBatch = await runSelectedImportReviewServingProjectorWorkerRebuildChunkBatch({
      claimedChunks: claimedBatch.claimedChunks,
      database: input.database,
      dependencies: input.dependencies,
      options: input.options,
      workerId: input.workerId,
    })

    if (selectedImportBatch !== null) {
      return selectedImportBatch
    }

    const displayBatch = await runDisplayReviewServingProjectorWorkerRebuildChunkBatch({
      claimedChunks: claimedBatch.claimedChunks,
      database: input.database,
      dependencies: input.dependencies,
      options: input.options,
      workerId: input.workerId,
    })

    if (displayBatch !== null) {
      return displayBatch
    }

    const payloadBatch = await runPayloadReviewServingProjectorWorkerRebuildChunkBatch({
      claimedChunks: claimedBatch.claimedChunks,
      database: input.database,
      dependencies: input.dependencies,
      options: input.options,
      workerId: input.workerId,
    })

    if (payloadBatch !== null) {
      return payloadBatch
    }

    const searchBatch = await runSearchReviewServingProjectorWorkerRebuildChunkBatch({
      claimedChunks: claimedBatch.claimedChunks,
      database: input.database,
      dependencies: input.dependencies,
      options: input.options,
      workerId: input.workerId,
    })

    if (searchBatch !== null) {
      return searchBatch
    }

    const llmStatusBatch = await runLlmStatusReviewServingProjectorWorkerRebuildChunkBatch({
      claimedChunks: claimedBatch.claimedChunks,
      database: input.database,
      dependencies: input.dependencies,
      options: input.options,
      workerId: input.workerId,
    })

    if (llmStatusBatch !== null) {
      return llmStatusBatch
    }

    const humanStatusBatch = await runHumanStatusReviewServingProjectorWorkerRebuildChunkBatch({
      claimedChunks: claimedBatch.claimedChunks,
      database: input.database,
      dependencies: input.dependencies,
      options: input.options,
      workerId: input.workerId,
    })

    if (humanStatusBatch !== null) {
      return humanStatusBatch
    }

    const queueBatch = await runQueueReviewServingProjectorWorkerRebuildChunkBatch({
      claimedChunks: claimedBatch.claimedChunks,
      database: input.database,
      dependencies: input.dependencies,
      options: input.options,
      workerId: input.workerId,
    })

    if (queueBatch !== null) {
      return queueBatch
    }

    const judgmentInputContentBatch = await runJudgmentInputContentReviewServingProjectorWorkerRebuildChunkBatch({
      claimedChunks: claimedBatch.claimedChunks,
      database: input.database,
      dependencies: input.dependencies,
      options: input.options,
      workerId: input.workerId,
    })

    if (judgmentInputContentBatch !== null) {
      return judgmentInputContentBatch
    }

    const postingBatch = await runPostingReviewServingProjectorWorkerRebuildChunkBatch({
      claimedChunks: claimedBatch.claimedChunks,
      database: input.database,
      dependencies: input.dependencies,
      options: input.options,
      workerId: input.workerId,
    })

    if (postingBatch !== null) {
      return postingBatch
    }

    const hasPreparedBatch = claimedBatch.claimedChunks.every((claimed) => {
      return claimed.service.prepareClaimedChunk !== undefined
    })

    if (hasPreparedBatch) {
      try {
        const preparedOutputs = await prepareClaimedReviewServingProjectorWorkerRebuildChunkBatch({
          claimedChunks: claimedBatch.claimedChunks,
          database: input.database,
          dependencies: input.dependencies,
          options: input.options,
          workloadContext: input.workloadContext,
          workerId: input.workerId,
        })

        for (const [index, claimed] of claimedBatch.claimedChunks.entries()) {
          await heartbeatClaimedRebuildChunkBatchLeases({
            claimedChunks: claimedBatch.claimedChunks,
            database: input.database,
            dependencies: input.dependencies,
            options: input.options,
            workerId: input.workerId,
          })

          const chunk = await runPreparedClaimedReviewServingProjectorWorkerRebuildChunk({
            claimed,
            database: input.database,
            preparedOutput: preparedOutputs[index],
            workloadContext: input.workloadContext,
            workerId: input.workerId,
          })

          completedCount += 1
          lastCompletedChunk = chunk
        }

        return {chunk: lastCompletedChunk ?? {chunkId: null, status: 'idle'}, completedCount}
      } catch (error) {
        return failClaimedReviewServingProjectorWorkerRebuildChunkBatch({
          claimedChunks: claimedBatch.claimedChunks.slice(completedCount),
          completedCount,
          database: input.database,
          dependencies: input.dependencies,
          error,
          workerId: input.workerId,
        })
      }
    }

    for (const claimed of claimedBatch.claimedChunks) {
      await heartbeatClaimedRebuildChunkBatchLeases({
        claimedChunks: claimedBatch.claimedChunks,
        database: input.database,
        dependencies: input.dependencies,
        options: input.options,
        workerId: input.workerId,
      })

      const chunk = await runClaimedReviewServingProjectorWorkerRebuildChunk({
        claimedChunk: claimed.chunk,
        database: input.database,
        dependencies: input.dependencies,
        options: input.options,
        service: claimed.service,
        timings: claimed.timings,
        workloadContext: input.workloadContext,
        workerId: input.workerId,
      })

      if (chunk.status === 'completed') {
        completedCount += 1
        lastCompletedChunk = chunk

        if (chunk.requestId !== null) {
          return {chunk, completedCount}
        }

        continue
      }

      return {chunk, completedCount}
    }

    return {chunk: lastCompletedChunk ?? {chunkId: null, status: 'idle'}, completedCount}
  }

  for (let index = 0; index < batchSize; index += 1) {
    const chunk = await runReviewServingProjectorWorkerRebuildChunk(input)

    if (chunk.status === 'completed') {
      completedCount += 1
      lastCompletedChunk = chunk

      if (chunk.requestId !== null) {
        return {chunk, completedCount}
      }

      continue
    }

    return {chunk, completedCount}
  }

  return {chunk: lastCompletedChunk ?? {chunkId: null, status: 'idle'}, completedCount}
}

const runReviewServingProjectorWorkerCleanup = async ({
  database,
  dependencies,
  options,
}: {
  database: ReviewServingRetentionServiceDatabase
  dependencies: ReviewServingProjectorWorkerDependencies
  options: ReviewServingProjectorWorkerCycleOptions
}): Promise<ReviewServingProjectorWorkerCleanupResult> => {
  const cleanupIntervalMs = getPositiveInteger(
    options.cleanupIntervalMs,
    defaultReviewServingProjectorWorkerCleanupIntervalMs,
  )
  const nowMs = getWorkerNowMs(dependencies, options)
  const lastCleanupAtMs = options.lastCleanupAtMs ?? null

  if (!shouldRunCleanup({cleanupIntervalMs, lastCleanupAtMs, nowMs})) {
    return {retentionScopes: [], status: 'skipped'}
  }

  const cleanupTargets = await dependencies.getCleanupTargets?.(database)
  const cleanupRetentionState = dependencies.cleanupRetentionState

  if (!cleanupRetentionState || cleanupTargets === undefined || cleanupTargets.length === 0) {
    return {retentionScopes: [], status: 'skipped'}
  }

  const retentionScopes = await cleanupTargets.reduce<Promise<string[]>>(async (previousScopes, target) => {
    const scopes = await previousScopes
    const cleanup = await cleanupRetentionState(target, database)

    return [...scopes, cleanup.retentionScope]
  }, Promise.resolve([]))

  return {retentionScopes, status: 'completed'}
}

const getDeltaIntakePartitions = async (database: ReviewServingProjectorWorkerDatabase, tableName: string) => {
  return database.queryJson<DeltaIntakePartitionRow>(`
    SELECT
      source_partition AS sourcePartition,
      MIN(source_high_water_mark) AS startSourceHighWaterMark,
      MAX(source_high_water_mark) AS endSourceHighWaterMark
    FROM ${tableName}
    WHERE reconciled_at IS NULL
    GROUP BY source_partition
    ORDER BY MIN(source_high_water_mark) ASC, source_partition ASC
  `)
}

const runReviewServingProjectorWorkerDeltaIntake = async ({
  database,
  dependencies,
  options,
}: {
  database: ReviewServingProjectorWorkerDatabase
  dependencies: ReviewServingProjectorWorkerDependencies
  options: ReviewServingProjectorWorkerCycleOptions
}): Promise<ReviewServingProjectorWorkerDeltaIntakeResult> => {
  const limit = getPositiveInteger(options.maxRowsPerWake, defaultReviewServingProjectorWorkerMaxRowsPerWake)
  const intakeReviewChangeDeltas = dependencies.intakeReviewChangeDeltas ?? intakeReviewChangeDeltasToDirtyWork
  const intakeImportDeltas = dependencies.intakeImportDeltas ?? intakeReviewImportDeltasToDirtyWork
  const reviewChangePartitions = await getDeltaIntakePartitions(database, 'app.review_change_delta')
  const importPartitions = await getDeltaIntakePartitions(database, 'app.import_run_article_delta')
  const reviewChangeResults = await reviewChangePartitions.reduce<
    Promise<ReviewServingProjectorWorkerDeltaIntakeResult>
  >(
    async (previousResult, partition) => {
      const result = await previousResult

      if (result.status === 'failed') {
        return result
      }

      const intake = await intakeReviewChangeDeltas({...partition, limit}, database)

      return intake.status === 'failed'
        ? {...result, status: 'failed'}
        : {
            convertedPartitions: result.convertedPartitions + 1,
            dirtyWorkCount: result.dirtyWorkCount + intake.dirtyWorkCount,
            status: 'completed',
          }
    },
    Promise.resolve({convertedPartitions: 0, dirtyWorkCount: 0, status: 'idle'}),
  )

  return importPartitions.reduce<Promise<ReviewServingProjectorWorkerDeltaIntakeResult>>(
    async (previousResult, partition) => {
      const result = await previousResult

      if (result.status === 'failed') {
        return result
      }

      const intake = await intakeImportDeltas({...partition, limit}, database)

      return intake.status === 'failed'
        ? {...result, status: 'failed'}
        : {
            convertedPartitions: result.convertedPartitions + 1,
            dirtyWorkCount: result.dirtyWorkCount + intake.dirtyWorkCount,
            status: 'completed',
          }
    },
    Promise.resolve(reviewChangeResults),
  )
}

export const runReviewServingProjectorWorkerCycle = async (
  options: ReviewServingProjectorWorkerCycleOptions = {},
  dependencies: ReviewServingProjectorWorkerDependencies = defaultReviewServingProjectorWorkerDependencies,
): Promise<ReviewServingProjectorWorkerCycleResult> => {
  const workerId = options.workerId ?? getReviewServingProjectorWorkerId()
  const wakeId = `${workerId}:${getWorkerNowMs(dependencies, options)}`
  const workloadContext = getReviewServingProjectorWorkerWorkloadContext(workerId)
  const database = getReviewServingProjectorWorkerDatabase(dependencies, workloadContext)
  const terminalFailedChunk = await finalizeTerminalFailedRebuildRequests({
    database,
    projectId: options.rebuildProjectId,
  })
  if (terminalFailedChunk === null) {
    await readmitRetryableFailedRebuildRequests({database, projectId: options.rebuildProjectId})
  }
  const shouldDeferForForegroundDuckdbWork =
    terminalFailedChunk === null && hasForegroundDuckdbWorkQueuedForReviewServingProjectorWorker(dependencies)
  const chunkBatch = shouldDeferForForegroundDuckdbWork
    ? getIdleReviewServingProjectorWorkerCycleChunkResult()
    : terminalFailedChunk === null
      ? await runReviewServingProjectorWorkerRebuildChunkBatch({
          database,
          dependencies,
          options,
          workloadContext,
          workerId,
        })
      : {chunk: terminalFailedChunk, completedCount: 1}
  const finalizedChunkBatch =
    chunkBatch.chunk.status === 'idle'
      ? ((await finalizeNextCompletedUnfinalizedRebuildRequest({database, projectId: options.rebuildProjectId}))
        ?? chunkBatch)
      : chunkBatch
  const chunk = finalizedChunkBatch.chunk
  const nowMs = getWorkerNowMs(dependencies, options)
  const shouldRunOnlyRebuildChunk =
    shouldDeferForForegroundDuckdbWork
    || terminalFailedChunk !== null
    || chunk.status === 'failed'
    || shouldPrioritizeNextRebuildChunk({chunk, dependencies, nowMs, options})
  const deltaIntake = shouldRunOnlyRebuildChunk
    ? getIdleReviewServingProjectorWorkerDeltaIntakeResult()
    : await runReviewServingProjectorWorkerDeltaIntake({database, dependencies, options})
  const projector = shouldRunOnlyRebuildChunk
    ? getBlockedReviewServingProjectorWakeResult()
    : await dependencies.wakeProjectors(getWakeInput(options, wakeId), {
        ...(dependencies.projectorServiceDependencies ?? {runners: getDefaultReviewServingProjectorRunners(database)}),
        database,
        nowMs: () => {
          return getWorkerNowMs(dependencies, options)
        },
      })
  const cleanup = shouldRunOnlyRebuildChunk
    ? {retentionScopes: [], status: 'skipped' as const}
    : await runReviewServingProjectorWorkerCleanup({database, dependencies, options})
  const nextCleanupAtMs =
    cleanup.status === 'completed' ? getWorkerNowMs(dependencies, options) : (options.lastCleanupAtMs ?? null)

  return {
    chunk,
    chunkBatchCount: finalizedChunkBatch.completedCount,
    cleanup,
    deltaIntake,
    nextCleanupAtMs,
    projector,
    status: getCycleStatus({chunk, cleanup, deltaIntake, projector}),
    wakeId,
    workerId,
  }
}

export const runReviewServingProjectorWorkerOnce = async (
  options: ReviewServingProjectorWorkerCycleOptions = {},
  dependencies: ReviewServingProjectorWorkerDependencies = defaultReviewServingProjectorWorkerDependencies,
) => {
  return runReviewServingProjectorWorkerCycle(options, dependencies)
}

const shouldRestartAfterCompletedRebuildChunk = (
  chunk: ReviewServingProjectorWorkerChunkResult,
  maxCompletedRebuildChunksPerRun: number,
) => {
  return (
    maxCompletedRebuildChunksPerRun > 0
    && chunk.status === 'completed'
    && chunk.requestId !== null
    && reviewServingNativeHeavyRebuildComponents.has(chunk.projectionComponent)
  )
}

export const runReviewServingProjectorWorker = async (
  options: ReviewServingProjectorWorkerLoopOptions = {},
  dependencies: ReviewServingProjectorWorkerDependencies = defaultReviewServingProjectorWorkerDependencies,
): Promise<ReviewServingProjectorWorkerRunResult> => {
  if (options.signal?.aborted) {
    return {reason: 'aborted'}
  }

  const cycleResult = await runReviewServingProjectorWorkerOnce(options, dependencies)
  logReviewServingProjectorWorkerCycle(cycleResult)
  const nowMs = getWorkerNowMs(dependencies, options)
  const completedRebuildChunksInRun = (options.completedRebuildChunksInRun ?? 0) + cycleResult.chunkBatchCount
  const maxCompletedRebuildChunksPerRun = getMaxCompletedRebuildChunksPerRun(options.maxCompletedRebuildChunksPerRun)

  if (options.signal?.aborted) {
    return {reason: 'aborted'}
  }

  if (shouldRestartAfterCompletedRebuildChunk(cycleResult.chunk, maxCompletedRebuildChunksPerRun)) {
    return {reason: 'nativeHeavyChunkCompleted'}
  }

  if (maxCompletedRebuildChunksPerRun > 0 && completedRebuildChunksInRun >= maxCompletedRebuildChunksPerRun) {
    return {reason: 'completedChunkLimit'}
  }

  const delayMs =
    cycleResult.status === 'failed'
      ? (options.errorBackoffMs ?? defaultReviewServingProjectorWorkerErrorBackoffMs)
      : shouldYieldToForegroundRebuildReader({chunk: cycleResult.chunk, nowMs, options})
        ? getReviewServingProjectorWorkerProgressYieldMs({chunk: cycleResult.chunk, dependencies, options})
        : cycleResult.status === 'idle'
          ? (options.pollIntervalMs ?? defaultReviewServingProjectorWorkerPollIntervalMs)
          : 0
  const nextOptions = {
    ...options,
    completedRebuildChunksInRun,
    ...getNextForegroundRebuildDrainOptions({chunk: cycleResult.chunk, dependencies, nowMs, options}),
    lastCleanupAtMs: cycleResult.nextCleanupAtMs,
  }

  return delayMs > 0
    ? dependencies.sleep(delayMs).then(() => {
        if (options.signal?.aborted) {
          return {reason: 'aborted' as const}
        }

        return runReviewServingProjectorWorker(nextOptions, dependencies)
      })
    : runReviewServingProjectorWorker(nextOptions, dependencies)
}

export {
  defaultReviewServingProjectorWorkerBatchSize,
  defaultReviewServingProjectorWorkerCleanupIntervalMs,
  defaultReviewServingProjectorWorkerErrorBackoffMs,
  defaultReviewServingProjectorWorkerHeartbeatMs,
  defaultReviewServingProjectorWorkerLeaseMs,
  defaultReviewServingProjectorWorkerMaxRetries,
  defaultReviewServingProjectorWorkerMaxRowsPerWake,
  defaultReviewServingProjectorWorkerMaxWakeMs,
  defaultReviewServingProjectorWorkerPollIntervalMs,
  defaultReviewServingProjectorWorkerProgressYieldMs,
  defaultReviewServingProjectorWorkerRebuildChunkBatchMaxRssBytes,
  defaultReviewServingProjectorWorkerRebuildChunkBatchSize,
  lightweightNativeHeavyReviewServingProjectorWorkerProgressYieldMs,
  nativeHeavyReviewServingProjectorWorkerProgressYieldMs,
}

export type {
  ReviewServingProjectorWorkerChunkResult,
  ReviewServingProjectorWorkerCleanupResult,
  ReviewServingProjectorWorkerCycleOptions,
  ReviewServingProjectorWorkerCycleResult,
  ReviewServingProjectorWorkerDependencies,
  ReviewServingProjectorWorkerLoopOptions,
  ReviewServingProjectorWorkerRebuildChunkService,
  ReviewServingProjectorWorkerRunResult,
}
