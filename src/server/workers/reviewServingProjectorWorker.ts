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
  projectReviewServingDisplayBaseRows,
  projectReviewServingDisplayPatches,
  projectReviewServingPayloadRows,
} from '../reviewServing/reviewServingDisplayPayloadProjector.ts'
import {
  getReviewServingFilterOptionIdentity,
  projectReviewServingFilterOptions,
} from '../reviewServing/reviewServingFilterOptionProjector.ts'
import {projectReviewServingFilterPostings} from '../reviewServing/reviewServingFilterPostingProjector.ts'
import {projectReviewServingHumanStatusPatches} from '../reviewServing/reviewServingHumanStatusProjector.ts'
import {projectReviewServingJudgmentPayloadRows} from '../reviewServing/reviewServingJudgmentPayloadProjector.ts'
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
  projectReviewServingQueueRebuildRows,
} from '../reviewServing/reviewServingQueueProjector.ts'
import {
  cleanupReviewServingRetentionState,
  getReviewServingRetentionCleanupTargets,
  type ReviewServingRetentionCleanupInput,
  type ReviewServingRetentionServiceDatabase,
} from '../reviewServing/reviewServingRetentionService.ts'
import {
  projectReviewServingSelectedImportPatches,
  type ProjectReviewServingSelectedImportPatchInput,
  resetReviewServingSelectedImportPatchArticleRange,
} from '../reviewServing/reviewServingSelectedImportPatchProjector.ts'
import {
  projectReviewServingSelectedImportArticleRange,
  projectReviewServingSelectedImportBatch,
} from '../reviewServing/reviewServingSelectedImportProjector.ts'
import {composeReviewServingCandidateSnapshotManifest} from '../reviewServing/reviewServingSnapshotPromotionService.ts'
import {projectReviewServingSummaries} from '../reviewServing/reviewServingSummaryProjector.ts'
import {
  projectReviewServingTitleSearchRebuildRows,
  projectReviewServingTitleSearchRows,
} from '../reviewServing/reviewServingTitleSearchProjector.ts'
import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getJsonValue, getSqlLiteral} from '../services/appQueryHelpers.ts'
import type {DuckdbWorkloadContext} from '../utils/duckdbService.ts'
import {createRateLimitedLogger} from '../utils/rateLimitedLogger.ts'

type ReviewServingProjectorWorkerDatabase = NonNullable<ReviewServingProjectorServiceDependencies['database']>

type ReviewServingProjectorWorkerCleanupTarget = ReviewServingRetentionCleanupInput

type ReviewServingProjectorWorkerChunkInput = ReviewServingRebuildChunkIdentity & {checksum?: string | null}

type RebuildChunkSplitRangeRow = {articleCount: number; chunkEndKey: string; chunkStartKey: string}
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
  heartbeatChunk: typeof heartbeatReviewServingRebuildChunkLease
  isChunkComplete: typeof isReviewServingRebuildChunkComplete
  runClaimedChunk: (input: {
    chunk: ReviewServingRebuildChunkManifest
    database: ReviewServingChunkManifestRepositoryDatabase & ReviewServingProjectorWorkerDatabase
    leaseOwner: string
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
  intakeImportDeltas?: typeof intakeReviewImportDeltasToDirtyWork
  intakeReviewChangeDeltas?: typeof intakeReviewChangeDeltasToDirtyWork
  nowMs?: () => number
  projectorServiceDependencies?: Omit<ReviewServingProjectorServiceDependencies, 'database' | 'nowMs'>
  rebuildChunkService?: ReviewServingProjectorWorkerRebuildChunkService
  sleep: typeof sleep
  wakeProjectors: typeof wakeReviewServingProjectorService
}

const reviewServingProjectorWorkerCycleLogger = createRateLimitedLogger({sink: 'file-only', windowMs: 30_000})

type ReviewServingProjectorWorkerCycleOptions = {
  batchSize?: number
  cleanupIntervalMs?: number
  foregroundRebuildDrainChunkBudget?: number
  foregroundRebuildDrainCompletedCount?: number
  foregroundRebuildDrainStartedAtMs?: number | null
  foregroundRebuildDrainTtlMs?: number
  heartbeatMs?: number
  lastCleanupAtMs?: number | null
  leaseMs?: number
  maxActiveImportCount?: number
  maxPendingDirtyWorkCount?: number
  maxRetries?: number
  maxRowsPerWake?: number
  maxWakeMs?: number
  now?: Date
  rebuildProjectId?: string | null
  workerId?: string
}

type ReviewServingProjectorWorkerLoopOptions = ReviewServingProjectorWorkerCycleOptions & {
  errorBackoffMs?: number
  pollIntervalMs?: number
  signal?: AbortSignal
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
type RebuildRequestSnapshotPromotionRow = {projectId: string; reviewConfigHash: string | null; snapshotId: string}

const defaultReviewServingProjectorWorkerBatchSize = 64
const defaultReviewServingProjectorWorkerCleanupIntervalMs = 60_000
const defaultReviewServingProjectorWorkerHeartbeatMs = 10_000
const defaultReviewServingProjectorWorkerLeaseMs = 30_000
const defaultReviewServingProjectorWorkerMaxRetries = 1
const defaultReviewServingProjectorWorkerMaxRowsPerWake = 512
const defaultReviewServingProjectorWorkerMaxWakeMs = 5_000
const defaultReviewServingProjectorWorkerPollIntervalMs = 2_000
const defaultReviewServingProjectorWorkerProgressYieldMs = 100
const defaultReviewServingProjectorWorkerErrorBackoffMs = 10_000
const defaultReviewServingProjectorWorkerForegroundRebuildDrainChunkBudget = 4
const defaultReviewServingProjectorWorkerForegroundRebuildDrainTtlMs = 5_000
const defaultReviewServingSelectedImportBaseBatchSize = 512
const reviewServingProjectorWorkerRouteOrJobKey = 'reviewServing.projector.worker'
const defaultReviewServingLlmListModeKeys = ['llm', 'both'] as const
const defaultReviewServingHumanListModeKeys = ['human', 'both'] as const
const reviewServingCriticalRebuildComponents = [
  'projectScope',
  'selectedImport',
  'display',
  'judgmentInputContent',
  'llmStatus',
  'humanStatus',
  'queue',
  'summary',
  'payload',
] as const satisfies readonly ReviewServingProjectionComponent[]
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

const canSplitRebuildChunk = (chunk: ReviewServingRebuildChunkManifest) => {
  return chunk.chunkStartKey < chunk.chunkEndKey && (chunk.splitDepth ?? 0) < 12
}

const articleRangeRebuildChunkPresplitInputRowLimit = 50_000
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

const getArticleRangeRebuildChunkEstimatedInputRows = (chunk: ReviewServingRebuildChunkManifest) => {
  return chunk.estimatedInputRows ?? chunk.estimatedOutputRows ?? null
}

const getArticleRangeRebuildChunkSplitBucketCount = (chunk: ReviewServingRebuildChunkManifest) => {
  const estimatedInputRows = getArticleRangeRebuildChunkEstimatedInputRows(chunk)

  if (estimatedInputRows === null) {
    return 2
  }

  return Math.min(16, Math.max(2, Math.ceil(estimatedInputRows / articleRangeRebuildChunkPresplitInputRowLimit)))
}

const shouldPresplitArticleRangeRebuildChunk = (chunk: ReviewServingRebuildChunkManifest) => {
  const estimatedInputRows = getArticleRangeRebuildChunkEstimatedInputRows(chunk)

  return (
    splittableArticleRangeRebuildComponents.has(chunk.projectionComponent)
    && estimatedInputRows !== null
    && estimatedInputRows > articleRangeRebuildChunkPresplitInputRowLimit
  )
}

const getArticleRangeRebuildChunkSplitRanges = async (
  input: {chunk: ReviewServingRebuildChunkManifest; projectId: string},
  database: ReviewServingChunkManifestRepositoryTransaction,
) => {
  const splitBucketCount = getArticleRangeRebuildChunkSplitBucketCount(input.chunk)
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
      COALESCE(previous_scoped_end_key, ${getSqlLiteral(input.chunk.chunkStartKey)}) AS chunkStartKey,
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
  tx: ReviewServingChunkManifestRepositoryTransaction,
): ReviewServingProjectorWorkerDatabase => {
  return {
    ...tx,
    transaction: async (operation) => {
      return operation(tx)
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
    writeOutput: (tx: ReviewServingChunkManifestRepositoryTransaction) => Promise<void>
  },
  database: ReviewServingChunkManifestRepositoryDatabase,
) => {
  const completedChunk = await writeReviewServingRebuildChunkOutput(
    {
      ...input.chunk,
      leaseOwner: input.leaseOwner,
      validateOutput: input.validateOutput,
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

        await snapshots.reduce<Promise<void>>(async (previous, snapshot) => {
          await previous
          await projectReviewServingDisplayBaseRows(
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
        }, Promise.resolve())
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

        await snapshots.reduce<Promise<void>>(async (previous, snapshot) => {
          await previous
          await projectReviewServingPayloadRows(
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
            chunkDatabase,
          )
        }, Promise.resolve())
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

        await snapshots.reduce<Promise<void>>(async (previous, snapshot) => {
          await previous
          await projectReviewServingTitleSearchRebuildRows(
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
        }, Promise.resolve())
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
        await projectReviewServingLlmStatusPatches(
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
        await projectReviewServingHumanStatusPatches(
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

        await snapshots.reduce<Promise<void>>(async (previous, snapshot) => {
          await previous
          await projectReviewServingQueueRebuildRows(
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
        }, Promise.resolve())
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

  return runValidatedRebuildChunkOutput(
    {
      ...input,
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

        await snapshots.reduce<Promise<void>>(async (previous, snapshot) => {
          await previous
          await projectReviewServingFilterPostings(
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
              reviewConfigHash: requireReviewConfigHash(snapshot),
              selectedImportSnapshotId: requireSelectedImportSnapshotId(snapshot),
              snapshotId: snapshot.snapshotId,
            },
            chunkDatabase,
          )
        }, Promise.resolve())
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
  const manifest = await requireRebuildChunkProjectionManifest(input.chunk, database)
  const snapshots = await getRebuildChunkSnapshots(input.chunk, database)
  const snapshotIds = getRebuildSnapshotIds(snapshots)

  return runValidatedRebuildChunkOutput(
    {
      ...input,
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

        await snapshots.reduce<Promise<void>>(async (previous, snapshot) => {
          await previous
          const searchIdentity = getSnapshotComponentState(snapshot, 'search')?.projectionIdentity ?? ''

          await projectReviewServingSummaries(
            {
              acknowledgeClaims: false,
              baseGeneration: input.chunk.outputBaseGeneration,
              chunkEndArticleId: input.chunk.chunkEndKey,
              chunkStartArticleId: input.chunk.chunkStartKey,
              claims: [],
              listModeKeys: reviewServingListModes,
              projectId,
              projectScopeIdentity: requireSnapshotComponentIdentity(snapshot, 'projectScope'),
              projectionIdentity: input.chunk.projectionIdentity,
              reviewConfigHash: requireReviewConfigHash(snapshot),
              selectedImportSnapshotId: requireSelectedImportSnapshotId(snapshot),
              snapshotId: snapshot.snapshotId,
            },
            chunkDatabase,
          )
          await projectReviewServingFilterOptions(
            {
              acknowledgeClaims: false,
              baseGeneration: input.chunk.outputBaseGeneration,
              claims: [],
              definitionVersion: manifest.definitionVersion,
              filterOptionIdentity: getReviewServingFilterOptionIdentity({
                filterKeys: defaultReviewFilterOptionKeys,
                listModeKeys: reviewServingListModes,
                optionMode: 'review',
                searchIdentity,
              }),
              listModeKeys: reviewServingListModes,
              optionMode: 'review',
              projectId,
              projectionIdentity: input.chunk.projectionIdentity,
              reviewConfigHash: requireReviewConfigHash(snapshot),
              searchIdentity,
              snapshotId: snapshot.snapshotId,
            },
            chunkDatabase,
          )
          await projectReviewServingFilterOptions(
            {
              acknowledgeClaims: false,
              baseGeneration: input.chunk.outputBaseGeneration,
              claims: [],
              definitionVersion: manifest.definitionVersion,
              filterOptionIdentity: getReviewServingFilterOptionIdentity({
                filterKeys: defaultHumanFilterOptionKeys,
                listModeKeys: defaultReviewServingHumanListModeKeys,
                optionMode: 'human',
                searchIdentity,
              }),
              listModeKeys: defaultReviewServingHumanListModeKeys,
              optionMode: 'human',
              projectId,
              projectionIdentity: input.chunk.projectionIdentity,
              reviewConfigHash: requireReviewConfigHash(snapshot),
              searchIdentity,
              snapshotId: snapshot.snapshotId,
            },
            chunkDatabase,
          )
        }, Promise.resolve())
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
    splitReason: 'duckdb_oom' | 'input_row_budget'
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
        oom_category = ${getSqlLiteral(input.splitReason === 'duckdb_oom' ? 'duckdb_oom_split' : 'input_row_budget_split')},
        over_budget_reason = NULL,
        last_error = NULL,
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

  if (shouldPresplitArticleRangeRebuildChunk(input.chunk)) {
    const split = await splitClaimedArticleRangeRebuildChunk(
      {chunk: input.chunk, leaseOwner: input.leaseOwner, projectId, splitReason: 'input_row_budget'},
      database,
    )

    if (split) {
      return {status: 'completed' as const}
    }
  }

  try {
    return await runValidatedRebuildChunkOutput(
      {
        ...input,
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

          await payloadSnapshots.reduce<Promise<void>>(async (previous, snapshot) => {
            await previous
            const project = getSnapshotReviewSettings(snapshot, currentSettings)

            if (project !== null) {
              await projectReviewServingJudgmentPayloadRows(
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
            }
          }, Promise.resolve())
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

const getSelectedImportRebuildPatchSourceWatermarks = (sourceWatermarks: Record<string, number>) => {
  const importRunArticleWatermark = sourceWatermarks.importRunArticle ?? sourceWatermarks['import-run-article']
  const selectedImportWatermark =
    typeof importRunArticleWatermark === 'number' && Number.isFinite(importRunArticleWatermark)
      ? importRunArticleWatermark
      : 0

  return {importRunArticle: selectedImportWatermark}
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
        CAST(article_id AS VARCHAR) || ':' ||
        CAST(in_curated_scope AS VARCHAR) || ':' ||
        CAST(in_route_scope AS VARCHAR) || ':' ||
        COALESCE(CAST(article_created_at AS VARCHAR), '') || ':' ||
        COALESCE(CAST(article_updated_at AS VARCHAR), ''),
        '|' ORDER BY article_id
      ), '')) AS actualChecksum
    FROM mart.project_scope_article
    WHERE project_id = ${getSqlLiteral(projectId)}
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
    FROM mart.project_scope_article
    WHERE project_id = ${getSqlLiteral(projectId)}
  `)

  return row ?? {actualChecksum: '', actualCount: 0}
}

const writeProjectScopeRebuildChunkRows = async (
  input: {chunk: ReviewServingRebuildChunkManifest},
  database: ReviewServingChunkManifestRepositoryTransaction,
) => {
  const projectId = requireRebuildChunkProjectId(input.chunk)

  await database.run(`
    DELETE FROM mart.project_scope_article
    WHERE project_id = ${getSqlLiteral(projectId)};
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
    ),
    curated_scope AS (
      SELECT
        project_article.project_id,
        project_article.article_id,
        FALSE AS in_route_scope,
        TRUE AS in_curated_scope
      FROM app.project_article project_article
      WHERE project_article.project_id = ${getSqlLiteral(projectId)}
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
      UNION ALL
      SELECT
        'patch:' || CAST(selected_import_snapshot_id AS VARCHAR) || ':' || CAST(patch_watermark AS VARCHAR) || ':' || CAST(article_id AS VARCHAR) AS row_key,
        COALESCE(CAST(import_route_id AS VARCHAR), '') || ':' ||
        COALESCE(CAST(source_record_key AS VARCHAR), '') || ':' ||
        COALESCE(CAST(selected_rank_key AS VARCHAR), '') || ':' ||
        COALESCE(CAST(selected_rank_numeric AS VARCHAR), '') || ':' ||
        COALESCE(CAST(publication_year AS VARCHAR), '') || ':' ||
        COALESCE(CAST(article_title AS VARCHAR), '') || ':' ||
        COALESCE(CAST(journal_title AS VARCHAR), '') || ':' ||
        COALESCE(CAST(external_id AS VARCHAR), '') || ':' ||
        COALESCE(CAST(tombstone AS VARCHAR), '') AS row_value
      FROM mart.review_selected_import_patch_v4 patch
      WHERE project_id = ${getSqlLiteral(projectId)}
        AND ${getSelectedImportSnapshotIdPredicate(input.selectedImportSnapshotIds)}
        AND ${getChunkArticleRangePredicate({alias: 'patch', chunk: input.chunk})}
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
      UNION ALL
      SELECT 1
      FROM mart.review_selected_import_patch_v4 patch
      WHERE project_id = ${getSqlLiteral(projectId)}
        AND ${getSelectedImportSnapshotIdPredicate(input.selectedImportSnapshotIds)}
        AND ${getChunkArticleRangePredicate({alias: 'patch', chunk: input.chunk})}
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
      table: 'mart.review_selected_import_patch_v4',
    },
    database,
  )
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

const resetSelectedImportArticleRangeForClaimedRebuild = async (
  input: {
    chunk: ReviewServingRebuildChunkManifest
    includePatchRows?: boolean
    leaseOwner: string
    projectId: string
    projectScopeIdentity: string
    selectedImportSnapshotId: string
  },
  database: ReviewServingChunkManifestRepositoryDatabase & ReviewServingProjectorWorkerDatabase,
) => {
  await database.transaction(async (tx) => {
    await requireClaimedRebuildChunk(input, tx)

    if (input.includePatchRows !== false) {
      await resetReviewServingSelectedImportPatchArticleRange(
        {
          chunkEndArticleId: input.chunk.chunkEndKey,
          chunkStartArticleId: input.chunk.chunkStartKey,
          projectId: input.projectId,
          projectScopeIdentity: input.projectScopeIdentity,
          selectedImportSnapshotId: input.selectedImportSnapshotId,
        },
        tx,
      )
    }

    await deleteReviewServingProjectorRows(
      {
        predicates: {
          article_id: {end: input.chunk.chunkEndKey, start: input.chunk.chunkStartKey},
          project_id: input.projectId,
          project_scope_identity: input.projectScopeIdentity,
          selected_import_snapshot_id: input.selectedImportSnapshotId,
        },
        table: 'app.review_selected_article_import_v4',
      },
      tx,
    )
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
        selectedImportSnapshotId: input.selectedImportSnapshotId,
        sourceDeltaHighWater: input.sourceDeltaHighWater,
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

const projectSelectedImportPatchesForClaimedRebuild = async (
  input: ProjectReviewServingSelectedImportPatchInput & {chunk: ReviewServingRebuildChunkManifest; leaseOwner: string},
  database: ReviewServingChunkManifestRepositoryDatabase & ReviewServingProjectorWorkerDatabase,
) => {
  await database.transaction(async (tx) => {
    await requireClaimedRebuildChunk(input, tx)
    await projectReviewServingSelectedImportPatches(input, getChunkProjectorDatabase(tx))
  })
}

const runSelectedImportRebuildChunk = async (
  input: {chunk: ReviewServingRebuildChunkManifest; leaseOwner: string},
  database: ReviewServingChunkManifestRepositoryDatabase & ReviewServingProjectorWorkerDatabase,
) => {
  const projectId = requireRebuildChunkProjectId(input.chunk)
  const manifest = await requireRebuildChunkProjectionManifest(input.chunk, database)
  const snapshots = await getRebuildChunkSnapshots(input.chunk, database)
  const selectedImportSnapshotIds = snapshots.map((snapshot) => {
    return requireSelectedImportSnapshotId(snapshot)
  })
  const claims = getRebuildChunkProjectClaims({
    chunk: input.chunk,
    dirtyKind: 'selectedImport.rebuild',
    fallbackSourcePartition: `import-run-article:${projectId}`,
    sourceWatermarks: getSelectedImportRebuildPatchSourceWatermarks(manifest.inputWatermarks),
  })

  const completedChunk = await writeReviewServingRebuildChunkOutput(
    {
      ...input.chunk,
      leaseOwner: input.leaseOwner,
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

        await snapshots.reduce<Promise<void>>(async (previous, snapshot) => {
          await previous
          const selectedImportSnapshotId = requireSelectedImportSnapshotId(snapshot)
          const projectScopeIdentity = requireSnapshotComponentIdentity(snapshot, 'projectScope')
          const existingSnapshot = await getSelectedImportSnapshotStatus(selectedImportSnapshotId, projectorDatabase)
          const sourceDeltaHighWater = Number(existingSnapshot?.sourceDeltaHighWater ?? input.chunk.inputWatermark)

          if (shouldRunFullSelectedImportRebuildChunk(input.chunk)) {
            await resetSelectedImportSnapshotForClaimedRebuild(
              {...input, projectId, projectScopeIdentity, selectedImportSnapshotId},
              projectorDatabase,
            )
            await drainSelectedImportBaseProjectionForClaimedRebuild(
              {...input, projectId, projectScopeIdentity, selectedImportSnapshotId, sourceDeltaHighWater},
              projectorDatabase,
            )
          } else {
            await resetSelectedImportArticleRangeForClaimedRebuild(
              {
                ...input,
                includePatchRows: !isFreshReviewServingSnapshotRebuildChunk(input.chunk),
                projectId,
                projectScopeIdentity,
                selectedImportSnapshotId,
              },
              projectorDatabase,
            )
            await projectSelectedImportArticleRangeForClaimedRebuild(
              {...input, projectId, projectScopeIdentity, selectedImportSnapshotId, sourceDeltaHighWater},
              projectorDatabase,
            )
          }
          if (!isFreshReviewServingSnapshotRebuildChunk(input.chunk)) {
            await projectSelectedImportPatchesForClaimedRebuild(
              {
                ...input,
                acknowledgeClaims: false,
                baseGeneration: input.chunk.outputBaseGeneration,
                chunkEndArticleId: shouldRunFullSelectedImportRebuildChunk(input.chunk)
                  ? undefined
                  : input.chunk.chunkEndKey,
                chunkStartArticleId: shouldRunFullSelectedImportRebuildChunk(input.chunk)
                  ? undefined
                  : input.chunk.chunkStartKey,
                claims,
                definitionVersion: manifest.definitionVersion,
                manifestInputWatermarks: manifest.inputWatermarks,
                projectId,
                projectScopeIdentity,
                projectionIdentity: input.chunk.projectionIdentity,
                selectedImportSnapshotId,
              },
              projectorDatabase,
            )
          }
        }, Promise.resolve())
      },
    },
    database,
  )

  if (completedChunk === null) {
    throw new Error(`review serving rebuild chunk ${input.chunk.chunkId} is no longer claimed by ${input.leaseOwner}`)
  }

  return {status: 'completed' as const}
}

export const runReviewServingProjectorWorkerClaimedRebuildChunk = async (
  input: {chunk: ReviewServingRebuildChunkManifest; leaseOwner: string},
  database: ReviewServingChunkManifestRepositoryDatabase & ReviewServingProjectorWorkerDatabase,
) => {
  if (shouldPresplitArticleRangeRebuildChunk(input.chunk)) {
    const split = await splitClaimedArticleRangeRebuildChunk(
      {
        chunk: input.chunk,
        leaseOwner: input.leaseOwner,
        projectId: requireRebuildChunkProjectId(input.chunk),
        splitReason: 'input_row_budget',
      },
      database,
    )

    if (split) {
      return {status: 'completed' as const}
    }
  }

  try {
    if (input.chunk.projectionComponent === 'projectScope') {
      return await runProjectScopeRebuildChunk(input, database)
    }

    if (input.chunk.projectionComponent === 'selectedImport') {
      return await runSelectedImportRebuildChunk(input, database)
    }

    if (input.chunk.projectionComponent === 'display') {
      return await runDisplayRebuildChunk(input, database)
    }

    if (input.chunk.projectionComponent === 'payload') {
      return await runPayloadRebuildChunk(input, database)
    }

    if (input.chunk.projectionComponent === 'search') {
      return await runSearchRebuildChunk(input, database)
    }

    if (input.chunk.projectionComponent === 'llmStatus') {
      return await runLlmStatusRebuildChunk(input, database)
    }

    if (input.chunk.projectionComponent === 'humanStatus') {
      return await runHumanStatusRebuildChunk(input, database)
    }

    if (input.chunk.projectionComponent === 'queue') {
      return await runQueueRebuildChunk(input, database)
    }

    if (input.chunk.projectionComponent === 'posting') {
      return await runPostingRebuildChunk(input, database)
    }

    if (input.chunk.projectionComponent === 'summary') {
      return await runSummaryRebuildChunk(input, database)
    }

    if (input.chunk.projectionComponent === 'judgmentInputContent') {
      return await runJudgmentInputContentRebuildChunk(input, database)
    }
  } catch (error) {
    const split =
      isDuckDbOutOfMemoryError(error) && splittableArticleRangeRebuildComponents.has(input.chunk.projectionComponent)
        ? await splitClaimedArticleRangeRebuildChunk(
            {
              chunk: input.chunk,
              leaseOwner: input.leaseOwner,
              projectId: requireRebuildChunkProjectId(input.chunk),
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
    `review serving rebuild chunk executor is not registered for ${(input.chunk as {projectionComponent: string}).projectionComponent}`,
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
        return projectReviewServingSelectedImportPatches(
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
          return total + result.patchRowCount
        }, 0),
      }
    },
    summary: async (context) => {
      const {manifest, projectId, snapshots} = await getDefaultRunnerInputs(context, database)
      const results = await runSnapshotProjectors(snapshots, async (snapshot, acknowledgeClaims) => {
        const result = await projectReviewServingSummaries(
          {
            acknowledgeClaims: false,
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
            acknowledgeClaims,
            baseGeneration: manifest.baseGeneration,
            claims: context.claims,
            definitionVersion: manifest.definitionVersion,
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

const defaultReviewServingProjectorWorkerDependencies: ReviewServingProjectorWorkerDependencies = {
  cleanupRetentionState: cleanupReviewServingRetentionState,
  getDatabase: getAppDatabaseService as ReviewServingProjectorWorkerDependencies['getDatabase'],
  getCleanupTargets: (database) => {
    return getReviewServingRetentionCleanupTargets({}, database)
  },
  rebuildChunkService: {
    claimChunk: claimReviewServingRebuildChunk,
    failChunk: markReviewServingRebuildChunkFailed,
    getNextChunk: ({database, now, projectId}) => {
      return getNextClaimableReviewServingRebuildChunk({now, projectId}, database)
    },
    heartbeatChunk: heartbeatReviewServingRebuildChunkLease,
    isChunkComplete: isReviewServingRebuildChunkComplete,
    runClaimedChunk: async ({chunk, database, leaseOwner}) => {
      return runReviewServingProjectorWorkerClaimedRebuildChunk({chunk, leaseOwner}, database)
    },
  },
  sleep,
  wakeProjectors: wakeReviewServingProjectorService,
}

export const getReviewServingProjectorWorkerId = () => {
  return `review-serving-projector-worker:${hostname()}:${process.pid}`
}

export const getReviewServingProjectorWorkerWorkloadContext = (_workerId: string): DuckdbWorkloadContext => {
  return {
    allowsTempSpill: false,
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

const getErrorText = (error: unknown) => {
  return error instanceof Error ? error.message : String(error)
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

const getRebuildRequestSnapshotPromotions = async (
  requestId: string,
  database: ReviewServingChunkManifestRepositoryDatabase,
) => {
  return database.queryJson<RebuildRequestSnapshotPromotionRow>(`
    SELECT DISTINCT
      chunk.project_id AS projectId,
      chunk.snapshot_id AS snapshotId,
      snapshot.review_config_hash AS reviewConfigHash
    FROM app.review_rebuild_chunk_manifest chunk
    INNER JOIN app.review_serving_snapshot_manifest snapshot
      ON snapshot.project_id = chunk.project_id
      AND snapshot.snapshot_id = chunk.snapshot_id
    WHERE chunk.request_id = ${getSqlLiteral(requestId)}
      AND chunk.project_id IS NOT NULL
      AND chunk.snapshot_id IS NOT NULL
    ORDER BY chunk.project_id ASC, chunk.snapshot_id ASC
  `)
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
) => {
  if (chunk.requestId === null) {
    return
  }

  const pendingChunkCount = await getRebuildRequestPendingChunkCount(chunk.requestId, database)

  if (pendingChunkCount > 0) {
    return
  }

  const promotionRows = await getRebuildRequestSnapshotPromotions(chunk.requestId, database)
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
    ) => {
      return database.transaction(operation, workloadContext)
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

const getBlockedReviewServingProjectorWakeResult = (): WakeReviewServingProjectorServiceResult => {
  return {failures: [], promotions: [], releasedClaimIds: [], runs: [], status: 'blocked'}
}

const isCriticalRebuildChunkResult = (chunk: ReviewServingProjectorWorkerChunkResult) => {
  return (
    chunk.status === 'completed'
    && reviewServingCriticalRebuildComponents.some((component) => {
      return component === chunk.projectionComponent
    })
  )
}

const getForegroundRebuildDrainStartedAtMs = (input: {
  chunk: ReviewServingProjectorWorkerChunkResult
  nowMs: number
  options: ReviewServingProjectorWorkerCycleOptions
}) => {
  return isCriticalRebuildChunkResult(input.chunk)
    ? (input.options.foregroundRebuildDrainStartedAtMs ?? input.nowMs)
    : null
}

const shouldPrioritizeNextRebuildChunk = (input: {
  chunk: ReviewServingProjectorWorkerChunkResult
  nowMs: number
  options: ReviewServingProjectorWorkerCycleOptions
}) => {
  const budget = getPositiveInteger(
    input.options.foregroundRebuildDrainChunkBudget,
    defaultReviewServingProjectorWorkerForegroundRebuildDrainChunkBudget,
  )
  const ttlMs = getPositiveInteger(
    input.options.foregroundRebuildDrainTtlMs,
    defaultReviewServingProjectorWorkerForegroundRebuildDrainTtlMs,
  )
  const startedAtMs = getForegroundRebuildDrainStartedAtMs(input)
  const completedCount = (input.options.foregroundRebuildDrainCompletedCount ?? 0) + 1

  return (
    input.chunk.status === 'completed'
    && input.chunk.requestId !== null
    && isCriticalRebuildChunkResult(input.chunk)
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
  return shouldPrioritizeNextRebuildChunk(input)
}

const getNextForegroundRebuildDrainOptions = (input: {
  chunk: ReviewServingProjectorWorkerChunkResult
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
      projectorStatus: result.projector.status,
      status: result.status,
      wakeId: result.wakeId,
      workerId: result.workerId,
    },
  )
}

const runReviewServingProjectorWorkerRebuildChunk = async ({
  database,
  dependencies,
  options,
  workloadContext,
  workerId,
}: {
  database: ReviewServingChunkManifestRepositoryDatabase
  dependencies: ReviewServingProjectorWorkerDependencies
  options: ReviewServingProjectorWorkerCycleOptions
  workloadContext: DuckdbWorkloadContext
  workerId: string
}): Promise<ReviewServingProjectorWorkerChunkResult> => {
  const service = dependencies.rebuildChunkService
  const chunkInput = await service?.getNextChunk({
    database,
    now: getWorkerNow(options),
    projectId: options.rebuildProjectId,
  })

  if (!service || chunkInput === null || chunkInput === undefined) {
    return {chunkId: null, status: 'idle'}
  }

  const completed = await service.isChunkComplete(chunkInput, database)
  const claimedChunk = completed
    ? null
    : await service.claimChunk(
        {...chunkInput, leaseExpiresAt: getLeaseExpiresAt(options), leaseOwner: workerId, now: getWorkerNow(options)},
        database,
      )

  if (completed) {
    return {chunkId: 'completed-manifest', requestId: chunkInput.requestId ?? null, status: 'skipped'}
  }

  if (claimedChunk === null) {
    return {chunkId: null, status: 'idle'}
  }

  const stopHeartbeat = startClaimedRebuildChunkHeartbeat({
    chunk: claimedChunk,
    database,
    dependencies,
    options,
    service,
    workerId,
  })

  try {
    await heartbeatClaimedRebuildChunkLease({chunk: claimedChunk, database, dependencies, options, service, workerId})
    await service.runClaimedChunk({chunk: claimedChunk, database, leaseOwner: workerId, workloadContext})
    stopHeartbeat()
  } catch (error) {
    stopHeartbeat()
    const failedChunk = await service.failChunk(
      {chunkId: claimedChunk.chunkId, error: getErrorText(error), leaseOwner: workerId},
      database,
    )
    await finalizeFailedReviewServingRebuildRequest(failedChunk, database)

    return {chunkId: claimedChunk.chunkId, requestId: claimedChunk.requestId, status: 'failed'}
  }

  try {
    await finalizeCompletedReviewServingRebuildRequest(claimedChunk, database)

    return {
      chunkId: claimedChunk.chunkId,
      projectionComponent: claimedChunk.projectionComponent,
      requestId: claimedChunk.requestId,
      status: 'completed',
    }
  } catch (error) {
    await finalizeErroredCompletedReviewServingRebuildRequest({chunk: claimedChunk, error}, database)

    return {chunkId: claimedChunk.chunkId, requestId: claimedChunk.requestId, status: 'failed'}
  }
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
  const chunk = await runReviewServingProjectorWorkerRebuildChunk({
    database,
    dependencies,
    options,
    workloadContext,
    workerId,
  })
  const nowMs = getWorkerNowMs(dependencies, options)
  const shouldRunOnlyRebuildChunk = shouldPrioritizeNextRebuildChunk({chunk, nowMs, options})
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

export const runReviewServingProjectorWorker = async (
  options: ReviewServingProjectorWorkerLoopOptions = {},
  dependencies: ReviewServingProjectorWorkerDependencies = defaultReviewServingProjectorWorkerDependencies,
): Promise<void> => {
  if (options.signal?.aborted) {
    return
  }

  const cycleResult = await runReviewServingProjectorWorkerOnce(options, dependencies)
  logReviewServingProjectorWorkerCycle(cycleResult)
  const nowMs = getWorkerNowMs(dependencies, options)

  if (options.signal?.aborted) {
    return
  }

  const delayMs =
    cycleResult.status === 'failed'
      ? (options.errorBackoffMs ?? defaultReviewServingProjectorWorkerErrorBackoffMs)
      : shouldYieldToForegroundRebuildReader({chunk: cycleResult.chunk, nowMs, options})
        ? defaultReviewServingProjectorWorkerProgressYieldMs
        : cycleResult.status === 'idle'
          ? (options.pollIntervalMs ?? defaultReviewServingProjectorWorkerPollIntervalMs)
          : 0
  const nextOptions = {
    ...options,
    ...getNextForegroundRebuildDrainOptions({chunk: cycleResult.chunk, nowMs, options}),
    lastCleanupAtMs: cycleResult.nextCleanupAtMs,
  }

  return delayMs > 0
    ? dependencies.sleep(delayMs).then(() => {
        if (options.signal?.aborted) {
          return
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
}

export type {
  ReviewServingProjectorWorkerChunkResult,
  ReviewServingProjectorWorkerCleanupResult,
  ReviewServingProjectorWorkerCycleOptions,
  ReviewServingProjectorWorkerCycleResult,
  ReviewServingProjectorWorkerDependencies,
  ReviewServingProjectorWorkerLoopOptions,
  ReviewServingProjectorWorkerRebuildChunkService,
}
