import {Effect} from 'effect'

import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {createRateLimitedLogger} from '../utils/rateLimitedLogger.ts'
import {
  countReadyReviewServingComponents,
  enrichmentReviewServingProjectionComponents,
  type ReviewServingProjectionComponent,
  visibilityReviewServingProjectionComponents,
} from './reviewServingContracts.ts'
import {
  blockReviewServingDirtyWorkClaimsForRebuild,
  claimReviewServingDirtyWork,
  type ClaimReviewServingDirtyWorkParams,
  completeReviewServingDirtyWorkClaims,
  defaultReviewServingDirtyWorkBlockedByRebuildRequeueSeconds,
  failReviewServingDirtyWorkClaims,
  releaseReviewServingDirtyWorkClaims,
  type ReviewServingDirtyWorkClaim,
  type ReviewServingDirtyWorkClaimOrder,
  type ReviewServingDirtyWorkDatabase,
  upsertReviewServingDirtyWork,
} from './reviewServingDirtyWorkService.ts'
import {getReviewServingInvalidationRuleOrNull} from './reviewServingInvalidationRegistry.ts'
import {
  getReviewServingProjectionIdentityManifest,
  hasReviewServingSnapshotComponentAtBaseGeneration,
  type ReviewServingManifestRepositoryDatabase,
  type ReviewServingManifestRepositoryTransaction,
  upsertReviewServingProjectionIdentityManifest,
} from './reviewServingManifestRepository.ts'
import {
  getReviewServingProjectionComponentIdentityKey,
  getReviewServingSourceWatermarkKeys,
  type ReviewServingDirtyWorkScope,
  type ReviewServingSourcePartitionWatermarks,
} from './reviewServingProjectorDomain.ts'
import {
  promoteReviewServingProjectorSnapshot,
  type PromoteReviewServingProjectorSnapshotInput,
  type PromoteReviewServingProjectorSnapshotResult,
} from './reviewServingProjectorWriter.ts'
import type {ReviewServingRebuildRequest} from './reviewServingRebuildRequestRepository.ts'
import {getCurrentReviewServingReviewConfigHash} from './reviewServingReviewConfig.ts'
import {getReviewServingSummaryLedgerSnapshotPredicateSql} from './reviewServingSummaryLedger.ts'
import {requestReviewServingV4RebuildEffect} from './reviewServingV4RebuildRequestService.ts'

export type ReviewServingProjectorRunContext = {
  claims: readonly ReviewServingDirtyWorkClaim[]
  component: ReviewServingProjectionComponent
  wakeId: string
}

export type ReviewServingProjectorRunResult = {
  candidateSnapshots?: readonly PromoteReviewServingProjectorSnapshotInput[]
  processedCount?: number
  // Claims the runner deferred and released back to pending: reported as released, not as projected.
  releasedClaimIds?: readonly string[]
}

export type ReviewServingProjectorRunner = (
  context: ReviewServingProjectorRunContext,
) => Promise<ReviewServingProjectorRunResult>

export type ReviewServingProjectorIdentityResolver = (input: {
  component: ReviewServingProjectionComponent
  scope: ReviewServingDirtyWorkScope
}) => string

export type ReviewServingProjectorWakeBlockedReason =
  | 'aborted'
  | 'appendQueue'
  | 'budget'
  | 'exclusiveWork'
  | 'failedChunk'
  | 'foregroundQueue'
  | 'projectTransfer'
  | 'terminalChunk'

export type ReviewServingProjectorQueueState = {
  activeImportCount?: number
  blocked?: boolean
  blockedReason?: ReviewServingProjectorWakeBlockedReason | null
  foregroundDuckdbQueueDepth?: number
  pendingDirtyWorkCount?: number
}

export type ReviewServingProjectorServiceDependencies = {
  claimDirtyWork?: (
    params: ClaimReviewServingDirtyWorkParams,
    database?: ReviewServingDirtyWorkDatabase,
  ) => Promise<ReviewServingDirtyWorkClaim[]>
  completeDirtyWork?: typeof completeReviewServingDirtyWorkClaims
  database?: ReviewServingProjectorServiceDatabase
  ensureClaimManifests?: ReviewServingClaimManifestEnsurer
  failDirtyWork?: typeof failReviewServingDirtyWorkClaims
  getQueueState?: () => Promise<ReviewServingProjectorQueueState>
  nowMs?: () => number
  blockDirtyWorkForRebuild?: typeof blockReviewServingDirtyWorkClaimsForRebuild
  promoteSnapshot?: typeof promoteReviewServingProjectorSnapshot
  releaseDirtyWork?: typeof releaseReviewServingDirtyWorkClaims
  requestRebuild?: typeof requestReviewServingV4RebuildEffect
  runners: Partial<Record<ReviewServingProjectionComponent, ReviewServingProjectorRunner>>
  upsertDirtyWork?: typeof upsertReviewServingDirtyWork
}

type ReviewServingProjectorServiceDatabase = ReviewServingDirtyWorkDatabase & ReviewServingManifestRepositoryDatabase

type ReviewServingClaimManifestEnsurer = (
  claims: readonly ReviewServingDirtyWorkClaim[],
  database: ReviewServingManifestRepositoryTransaction,
) => Promise<void>

const countReadyRepairComponents = new Set<ReviewServingProjectionComponent>(countReadyReviewServingComponents)
const detailReadinessRebuildComponents = new Set<ReviewServingProjectionComponent>(['judgmentInputContent', 'payload'])
export const activationReviewServingRebuildPriority = 10_000
export const detailReadinessReviewServingRebuildPriority = 100
export const searchReviewServingRebuildPriority = 75
export const facetEnrichmentReviewServingRebuildPriority = 50
// Only components with bounded article-range rebuild admission belong here; non-presplittable components stay direct.
const highFanoutDirtyWorkRebuildComponents = new Set<ReviewServingProjectionComponent>([
  'humanStatus',
  'llmStatus',
  'payload',
  'posting',
  'queue',
  'selectedImport',
  'summary',
])
const optionalDirtyWorkBootstrapComponents = new Set<ReviewServingProjectionComponent>([
  'payload',
  'posting',
  'summary',
  'judgmentInputContent',
  'search',
])
const articleRoutedDirtyWorkComponents = new Set<ReviewServingProjectionComponent>(['payload', 'posting', 'summary'])
const incrementalArticleDirtyWorkComponents = new Set<ReviewServingProjectionComponent>([
  'payload',
  'posting',
  'summary',
])

type ArticleDirtyWorkRoute = 'bootstrap' | 'incremental'

export type IntakeReviewServingProjectorDirtyWorkInput = {
  identityResolver: ReviewServingProjectorIdentityResolver
  latestDeltaId?: string | null
  scope: ReviewServingDirtyWorkScope
}

export type IntakeReviewServingProjectorDirtyWorkResult =
  | {reason: string; status: 'failed'}
  | {dirtyWorkCount: number; status: 'queued'}

export type WakeReviewServingProjectorServiceInput = {
  alternateClaimOrder?: boolean
  batchSize: number
  claimOrderOffset?: number
  componentBatchSizes?: Partial<Record<ReviewServingProjectionComponent, number>>
  componentOrder?: readonly ReviewServingProjectionComponent[]
  componentPasses?: number
  componentRotationOffset?: number
  maxActiveImportCount?: number
  maxPendingDirtyWorkCount?: number
  maxRetries?: number
  maxRowsPerWake: number
  maxWakeMs: number
  wakeId: string
}

export type ReviewServingProjectorComponentRun = {
  attempts: number
  claimCount: number
  component: ReviewServingProjectionComponent
  processedCount: number
  status: 'completed'
}

export type ReviewServingProjectorFailure = {
  attempts: number
  claimIds: readonly string[]
  component: ReviewServingProjectionComponent
  diagnostic: string
  status: 'failed'
}

export type ReviewServingProjectorBlockedRebuild = {
  claimIds: readonly string[]
  component: ReviewServingProjectionComponent
  diagnostic: string
  status: 'blocked_by_rebuild'
}

export type WakeReviewServingProjectorServiceResult = {
  blockedReason?: ReviewServingProjectorWakeBlockedReason | null
  blockedRebuilds: readonly ReviewServingProjectorBlockedRebuild[]
  failures: readonly ReviewServingProjectorFailure[]
  promotions: readonly PromoteReviewServingProjectorSnapshotResult[]
  releasedClaimIds: readonly string[]
  runs: readonly ReviewServingProjectorComponentRun[]
  status: 'blocked' | 'completed' | 'failed' | 'idle' | 'partial'
}

type WakeReviewServingProjectorState = {
  blockedRebuilds: ReviewServingProjectorBlockedRebuild[]
  failures: ReviewServingProjectorFailure[]
  processedRows: number
  promotions: PromoteReviewServingProjectorSnapshotResult[]
  releasedClaimIds: string[]
  runs: ReviewServingProjectorComponentRun[]
  settledVisits: string[]
}

type ReviewServingProjectorComponentVisit = {
  claimOrder?: ReviewServingDirtyWorkClaimOrder
  component: ReviewServingProjectionComponent
}

const projectorFailureLogger = createRateLimitedLogger({sink: 'file-only', windowMs: 30_000})
const blockedRebuildRequestReuseMs = defaultReviewServingDirtyWorkBlockedByRebuildRequeueSeconds * 1000

const getRotatedComponentOrder = (
  componentOrder: readonly ReviewServingProjectionComponent[],
  rotationOffset: number | undefined,
) => {
  const normalizedOffset =
    rotationOffset !== undefined && Number.isFinite(rotationOffset) ? Math.trunc(rotationOffset) : 0
  const startIndex =
    componentOrder.length === 0
      ? 0
      : ((normalizedOffset % componentOrder.length) + componentOrder.length) % componentOrder.length

  return [...componentOrder.slice(startIndex), ...componentOrder.slice(0, startIndex)]
}

export const getVisibilityFirstReviewServingComponentOrder = (
  rotationOffset: number | undefined,
  components?: readonly ReviewServingProjectionComponent[],
) => {
  const isIncluded = (component: ReviewServingProjectionComponent) => {
    return components === undefined || components.includes(component)
  }

  return [
    ...getRotatedComponentOrder(visibilityReviewServingProjectionComponents.filter(isIncluded), rotationOffset),
    ...getRotatedComponentOrder(enrichmentReviewServingProjectionComponents.filter(isIncluded), rotationOffset),
  ]
}

const getPassClaimOrder = (
  input: Pick<WakeReviewServingProjectorServiceInput, 'alternateClaimOrder' | 'claimOrderOffset'>,
  pass: number,
): ReviewServingDirtyWorkClaimOrder | undefined => {
  const firstPass =
    input.claimOrderOffset !== undefined && Number.isFinite(input.claimOrderOffset)
      ? Math.trunc(input.claimOrderOffset)
      : 0

  return input.alternateClaimOrder === true ? (Math.abs(pass + firstPass) % 2 === 0 ? 'oldest' : 'newest') : undefined
}

const getComponentVisits = (
  componentOrder: readonly ReviewServingProjectionComponent[],
  input: Pick<WakeReviewServingProjectorServiceInput, 'alternateClaimOrder' | 'claimOrderOffset' | 'componentPasses'>,
): ReviewServingProjectorComponentVisit[] => {
  const passes =
    input.componentPasses !== undefined && Number.isFinite(input.componentPasses)
      ? Math.max(1, Math.trunc(input.componentPasses))
      : 1

  return Array.from({length: passes}, (_, pass) => {
    const claimOrder = getPassClaimOrder(input, pass)

    return componentOrder.map((component) => {
      return claimOrder === undefined ? {component} : {claimOrder, component}
    })
  }).flat()
}

const getVisitKey = (visit: ReviewServingProjectorComponentVisit) => {
  return `${visit.component}:${visit.claimOrder ?? 'oldest'}`
}

const getSettledVisitsAfterVisit = (input: {
  limit: number
  next: WakeReviewServingProjectorState
  previous: WakeReviewServingProjectorState
  visit: ReviewServingProjectorComponentVisit
}) => {
  const visitRuns = input.next.runs.slice(input.previous.runs.length)
  const projectedFullBatch = visitRuns.some((run) => {
    return run.component === input.visit.component && run.claimCount >= input.limit
  })

  return projectedFullBatch ? input.next.settledVisits : [...input.next.settledVisits, getVisitKey(input.visit)]
}

const getDiagnosticCause = (error: unknown) => {
  if (typeof error !== 'object' || error === null) {
    return null
  }

  const cause = 'cause' in error ? (error as {cause?: unknown}).cause : null
  const nestedError = 'error' in error ? (error as {error?: unknown}).error : null

  return cause ?? nestedError
}

const getDiagnostic = (error: unknown): string => {
  const cause = getDiagnosticCause(error)
  const message = error instanceof Error ? error.message : String(error)

  return cause === null || cause === undefined ? message : `${message}: ${getDiagnostic(cause)}`
}

const getBlockedRebuildRequests = (requests: readonly ReviewServingRebuildRequest[]) => {
  return requests.filter((request) => {
    return request.status !== 'admitted' && request.status !== 'completed'
  })
}

const getBlockedRebuildRequestDiagnostic = (requests: readonly ReviewServingRebuildRequest[]) => {
  return requests
    .map((request) => {
      return (
        request.overBudgetReason
        ?? request.lastError
        ?? `review rebuild request ${request.requestId} was not admitted: ${request.status}`
      )
    })
    .join('; ')
}

const getObjectRecord = (value: unknown): Record<string, unknown> | null => {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      return getObjectRecord(parsed)
    } catch {
      return null
    }
  }

  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

const getNumericSourceWatermark = (watermarks: Record<string, unknown>, sourceKey: string) => {
  const value = watermarks[sourceKey]
  const numericValue = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN

  return Number.isFinite(numericValue) ? numericValue : null
}

const getSourceWatermarkCoverageRecords = (sourceWatermarks: Record<string, unknown>) => {
  const dirtySourceWatermarks = getObjectRecord(sourceWatermarks.dirtySourceWatermarks)

  return dirtySourceWatermarks === null ? [sourceWatermarks] : [sourceWatermarks, dirtySourceWatermarks]
}

// A request only covers claims of components it builds: its watermarks say nothing about the other components of the
// snapshot it builds into (an in-place rebuild of the active snapshot builds only a few of them).
const getRebuildRequestComponents = (request: ReviewServingRebuildRequest) => {
  const componentSet = getObjectRecord(request.identityJson)?.componentSet

  return new Set<string>([
    ...request.requestedComponents,
    ...(Array.isArray(componentSet)
      ? componentSet.filter((component): component is string => {
          return typeof component === 'string'
        })
      : []),
  ])
}

// Requests that build a component into an active snapshot (in place, or a bootstrap train whose snapshot was promoted
// meanwhile). Their chunks rewrite rows the snapshot is serving range by range, from inputs that may still be catching
// up, so a claim of that component is never completed just because such a request's watermarks reach it: the claim
// stays pending and is patched incrementally, or retired once a chunk that started after its change has completed.
// Only requests building fresh candidates, which nothing reads before activation, cover claims when they are created.
const getActiveSnapshotBuildingRequestIds = async (input: {
  component: ReviewServingProjectionComponent
  database: ReviewServingProjectorServiceDatabase
  requests: readonly ReviewServingRebuildRequest[]
}) => {
  if (input.requests.length === 0) {
    return new Set<string>()
  }

  const rows = await input.database.queryJson<{requestId: string}>(`
    SELECT DISTINCT chunk.request_id AS requestId
    FROM app.review_rebuild_chunk_manifest chunk
    INNER JOIN app.review_serving_snapshot_manifest snapshot
      ON snapshot.project_id = chunk.project_id
      AND snapshot.snapshot_id = chunk.snapshot_id
    WHERE chunk.request_id IN (${input.requests
      .map((request) => {
        return getSqlLiteral(request.requestId)
      })
      .join(', ')})
      AND chunk.projection_component = ${getSqlLiteral(input.component)}
      AND snapshot.snapshot_status = 'active'
  `)

  return new Set(
    rows.map((row) => {
      return row.requestId
    }),
  )
}

const isClaimCoveredByRebuildRequest = (
  claim: ReviewServingDirtyWorkClaim,
  request: ReviewServingRebuildRequest,
  activeSnapshotBuildingRequestIds: ReadonlySet<string> = new Set(),
) => {
  if (
    claim.projectId === null
    || request.projectId !== claim.projectId
    || !getRebuildRequestComponents(request).has(claim.projectionComponent)
    || activeSnapshotBuildingRequestIds.has(request.requestId)
  ) {
    return false
  }

  const sourceWatermarks = getObjectRecord(request.sourceWatermarksJson)

  if (sourceWatermarks === null) {
    return false
  }

  const coverageRecords = getSourceWatermarkCoverageRecords(sourceWatermarks)

  return [claim.sourcePartition, ...getReviewServingSourceWatermarkKeys(claim.sourcePartition)].some((sourceKey) => {
    return coverageRecords.some((watermarks) => {
      const sourceWatermark = getNumericSourceWatermark(watermarks, sourceKey)

      return sourceWatermark !== null && sourceWatermark >= claim.latestSourceHighWaterMark
    })
  })
}

const isClaimCoveredByRebuildRequests = (
  claim: ReviewServingDirtyWorkClaim,
  requests: readonly ReviewServingRebuildRequest[],
  activeSnapshotBuildingRequestIds: ReadonlySet<string>,
) => {
  return requests.some((request) => {
    return isClaimCoveredByRebuildRequest(claim, request, activeSnapshotBuildingRequestIds)
  })
}

const getNormalizedBudget = (input: WakeReviewServingProjectorServiceInput) => {
  const batchSize = Math.max(0, Math.floor(input.batchSize))
  const maxRowsPerWake = Math.max(0, Math.floor(input.maxRowsPerWake))
  const maxRetries = Math.max(0, Math.floor(input.maxRetries ?? 1))

  return {batchSize, componentBatchSizes: input.componentBatchSizes ?? {}, maxRetries, maxRowsPerWake}
}

const getComponentBatchSize = (
  budget: ReturnType<typeof getNormalizedBudget>,
  component: ReviewServingProjectionComponent,
) => {
  const componentBatchSize = budget.componentBatchSizes[component]

  return componentBatchSize !== undefined && Number.isFinite(componentBatchSize) && componentBatchSize >= 1
    ? Math.floor(componentBatchSize)
    : budget.batchSize
}

const getDefaultDatabase = (): ReviewServingProjectorServiceDatabase => {
  return getAppDatabaseService() as ReviewServingProjectorServiceDatabase
}

const getDirtyWorkIds = (claims: readonly ReviewServingDirtyWorkClaim[]) => {
  return claims.map((claim) => {
    return claim.dirtyWorkId
  })
}

const getMissingSnapshotRepairComponents = (
  component: ReviewServingProjectionComponent,
): ReviewServingProjectionComponent[] => {
  if (component === 'summary') {
    return [...new Set<ReviewServingProjectionComponent>([...countReadyReviewServingComponents, 'payload', component])]
  }

  return [...new Set<ReviewServingProjectionComponent>([...countReadyReviewServingComponents, component])]
}

const getOptionalComponentRebuildPriority = (component: ReviewServingProjectionComponent) => {
  if (detailReadinessRebuildComponents.has(component)) {
    return detailReadinessReviewServingRebuildPriority
  }

  return component === 'search' ? searchReviewServingRebuildPriority : facetEnrichmentReviewServingRebuildPriority
}

export const getMissingSnapshotRepairPriority = (component: ReviewServingProjectionComponent) => {
  return countReadyRepairComponents.has(component)
    ? activationReviewServingRebuildPriority
    : getOptionalComponentRebuildPriority(component)
}

const getClaimProjectIds = (claims: readonly ReviewServingDirtyWorkClaim[]) => {
  return [
    ...new Set(
      claims
        .map((claim) => {
          return claim.projectId
        })
        .filter((projectId): projectId is string => {
          return projectId !== null && projectId.trim().length > 0
        }),
    ),
  ]
}

const getDirtyWorkClaimLogEntries = (claims: readonly ReviewServingDirtyWorkClaim[]) => {
  return claims.map((claim) => {
    return {
      dirtyKind: claim.dirtyKind,
      dirtyWorkId: claim.dirtyWorkId,
      latestSourceHighWaterMark: claim.latestSourceHighWaterMark,
      projectId: claim.projectId,
      projectionIdentity: claim.projectionIdentity,
      scopeId: claim.scopeId,
      sourcePartition: claim.sourcePartition,
    }
  })
}

const logDirtyWorkProjectorFailure = (input: {
  claimIds: readonly string[]
  claims: readonly ReviewServingDirtyWorkClaim[]
  component: ReviewServingProjectionComponent
  diagnostic: string
}) => {
  return projectorFailureLogger.warn(
    `review-serving-projector:dirty-work-failed:${input.component}`,
    '[reviewServingProjector] dirty work projector failed; recorded claim outcome',
    {
      claimIds: input.claimIds,
      component: input.component,
      diagnostic: input.diagnostic,
      claims: getDirtyWorkClaimLogEntries(input.claims),
    },
  )
}

const logDirtyWorkProjectorBlockedByRebuild = (input: {
  claimIds: readonly string[]
  claims: readonly ReviewServingDirtyWorkClaim[]
  component: ReviewServingProjectionComponent
  diagnostic: string
}) => {
  return projectorFailureLogger.warn(
    `review-serving-projector:dirty-work-blocked-by-rebuild:${input.component}`,
    '[reviewServingProjector] dirty work parked until its rebuild request is admissible; recorded claim outcome',
    {
      claimIds: input.claimIds,
      component: input.component,
      diagnostic: input.diagnostic,
      claims: getDirtyWorkClaimLogEntries(input.claims),
      requeueAfterMs: blockedRebuildRequestReuseMs,
    },
  )
}

const parkDirtyWorkClaimsBlockedByRebuild = async (input: {
  blockDirtyWorkForRebuild: typeof blockReviewServingDirtyWorkClaimsForRebuild
  claims: readonly ReviewServingDirtyWorkClaim[]
  component: ReviewServingProjectionComponent
  database: ReviewServingProjectorServiceDatabase
  diagnostic: string
  state: WakeReviewServingProjectorState
}): Promise<WakeReviewServingProjectorState> => {
  const claimIds = getDirtyWorkIds(input.claims)

  await input.blockDirtyWorkForRebuild(claimIds, input.database)
  logDirtyWorkProjectorBlockedByRebuild({
    claimIds,
    claims: input.claims,
    component: input.component,
    diagnostic: input.diagnostic,
  })

  return {
    ...input.state,
    blockedRebuilds: [
      ...input.state.blockedRebuilds,
      {claimIds, component: input.component, diagnostic: input.diagnostic, status: 'blocked_by_rebuild' as const},
    ],
    processedRows: input.state.processedRows + input.claims.length,
    releasedClaimIds: [...input.state.releasedClaimIds, ...claimIds],
  }
}

const isMissingSnapshotDiagnostic = (diagnostic: string) => {
  return (
    diagnostic.includes('cannot run projector without a candidate or active snapshot')
    || diagnostic.includes('cannot run projector without selected import snapshot id')
    || diagnostic.includes('selected import snapshot is not completed')
    || /cannot run projector without [A-Za-z]+ identity in snapshot/u.test(diagnostic)
  )
}

const isSearchDirtyWorkClaim = (claim: ReviewServingDirtyWorkClaim) => {
  return claim.projectionComponent === 'search' && claim.projectId !== null
}

const isOptionalDirtyWorkBootstrapClaim = (claim: ReviewServingDirtyWorkClaim) => {
  return claim.projectId !== null && optionalDirtyWorkBootstrapComponents.has(claim.projectionComponent)
}

const isHighFanoutDirtyWorkClaim = (claim: ReviewServingDirtyWorkClaim) => {
  return (
    claim.projectId !== null
    && claim.scopeKind !== 'article'
    && highFanoutDirtyWorkRebuildComponents.has(claim.projectionComponent)
  )
}

const getChunkedDirtyWorkProjectIds = (
  component: ReviewServingProjectionComponent,
  claims: readonly ReviewServingDirtyWorkClaim[],
) => {
  if (component === 'search' && claims.some(isSearchDirtyWorkClaim)) {
    return getClaimProjectIds(claims)
  }

  if (optionalDirtyWorkBootstrapComponents.has(component) && claims.some(isOptionalDirtyWorkBootstrapClaim)) {
    return getClaimProjectIds(claims)
  }

  return highFanoutDirtyWorkRebuildComponents.has(component) && claims.some(isHighFanoutDirtyWorkClaim)
    ? getClaimProjectIds(claims)
    : []
}

const isArticleScopedDirtyWorkClaim = (claim: ReviewServingDirtyWorkClaim) => {
  return claim.projectId !== null && claim.scopeKind === 'article'
}

const getClaimProjectionIdentities = (claims: readonly ReviewServingDirtyWorkClaim[]) => {
  return [
    ...new Set(
      claims.map((claim) => {
        return claim.projectionIdentity
      }),
    ),
  ]
}

// Summary patches need the snapshot's bucket ledger; snapshots published before it existed keep the bootstrap route.
const getIncrementalSnapshotPredicateSql = (
  component: ReviewServingProjectionComponent,
  projectionIdentity: string,
) => {
  return component === 'summary'
    ? getReviewServingSummaryLedgerSnapshotPredicateSql({projectionIdentity, snapshotAlias: 'snapshot'})
    : undefined
}

const hasIncrementalArticleDirtyWorkSnapshot = async (input: {
  claims: readonly ReviewServingDirtyWorkClaim[]
  component: ReviewServingProjectionComponent
  database: ReviewServingProjectorServiceDatabase
}) => {
  const [projectId, ...otherProjectIds] = getClaimProjectIds(input.claims)
  const [projectionIdentity, ...otherProjectionIdentities] = getClaimProjectionIdentities(input.claims)
  const reviewConfigHash =
    projectId === undefined ? null : await getCurrentReviewServingReviewConfigHash(projectId, input.database)

  return (
    projectId !== undefined
    && projectionIdentity !== undefined
    && reviewConfigHash !== null
    && otherProjectIds.length === 0
    && otherProjectionIdentities.length === 0
    && (await hasReviewServingSnapshotComponentAtBaseGeneration(
      {
        projectId,
        projectionComponent: input.component,
        projectionIdentity,
        reviewConfigHash,
        snapshotPredicateSql: getIncrementalSnapshotPredicateSql(input.component, projectionIdentity),
      },
      input.database,
    ))
  )
}

// Article claims of these components are patched only into snapshots that carry the component at its current base
// generation and review config; otherwise they wait for a requested-only bootstrap instead of being released each wake.
const getArticleDirtyWorkRoute = async (input: {
  claims: readonly ReviewServingDirtyWorkClaim[]
  component: ReviewServingProjectionComponent
  database: ReviewServingProjectorServiceDatabase
}): Promise<ArticleDirtyWorkRoute | null> => {
  if (!articleRoutedDirtyWorkComponents.has(input.component) || !input.claims.every(isArticleScopedDirtyWorkClaim)) {
    return null
  }

  const hasIncrementalSnapshot =
    incrementalArticleDirtyWorkComponents.has(input.component)
    && (await hasIncrementalArticleDirtyWorkSnapshot(input).catch(() => {
      return false
    }))

  return hasIncrementalSnapshot ? 'incremental' : 'bootstrap'
}

const getAwaitedRebuildRequestDiagnostic = (requests: readonly ReviewServingRebuildRequest[]) => {
  return `waiting for review rebuild ${requests
    .map((request) => {
      return request.requestId
    })
    .join(', ')} to activate`
}

// Claims a fresh candidate build covers are complete; claims waiting for a build of the active snapshot go back to
// pending, since that snapshot now carries the component and their next pass patches it incrementally; other claims
// wait parked until the build they wait for is done.
const settleBootstrapRoutedArticleDirtyWork = async (input: {
  activeSnapshotBuildingRequestIds: ReadonlySet<string>
  blockDirtyWorkForRebuild: typeof blockReviewServingDirtyWorkClaimsForRebuild
  claims: readonly ReviewServingDirtyWorkClaim[]
  completeDirtyWork: typeof completeReviewServingDirtyWorkClaims
  component: ReviewServingProjectionComponent
  database: ReviewServingProjectorServiceDatabase
  releaseDirtyWork: typeof releaseReviewServingDirtyWorkClaims
  requests: readonly ReviewServingRebuildRequest[]
  state: WakeReviewServingProjectorState
}): Promise<WakeReviewServingProjectorState> => {
  const coveredClaims = input.claims.filter((claim) => {
    return isClaimCoveredByRebuildRequests(claim, input.requests, input.activeSnapshotBuildingRequestIds)
  })
  const buildsActiveSnapshot = input.requests.some((request) => {
    return input.activeSnapshotBuildingRequestIds.has(request.requestId)
  })
  const uncoveredClaims = input.claims.filter((claim) => {
    return !coveredClaims.includes(claim)
  })
  const releasedClaims = buildsActiveSnapshot ? uncoveredClaims : []
  const waitingClaims = buildsActiveSnapshot ? [] : uncoveredClaims

  if (coveredClaims.length > 0) {
    await input.completeDirtyWork(coveredClaims, input.database)
  }

  if (releasedClaims.length > 0) {
    await input.releaseDirtyWork(getDirtyWorkIds(releasedClaims), input.database)
  }

  const releasedState =
    releasedClaims.length === 0
      ? input.state
      : {...input.state, releasedClaimIds: [...input.state.releasedClaimIds, ...getDirtyWorkIds(releasedClaims)]}
  const completedState =
    coveredClaims.length === 0
      ? releasedState
      : {
          ...releasedState,
          processedRows: releasedState.processedRows + coveredClaims.length,
          runs: [
            ...releasedState.runs,
            {
              attempts: 1,
              claimCount: coveredClaims.length,
              component: input.component,
              processedCount: 0,
              status: 'completed' as const,
            },
          ],
        }

  return waitingClaims.length === 0
    ? completedState
    : parkDirtyWorkClaimsBlockedByRebuild({
        blockDirtyWorkForRebuild: input.blockDirtyWorkForRebuild,
        claims: waitingClaims,
        component: input.component,
        database: input.database,
        diagnostic: getAwaitedRebuildRequestDiagnostic(input.requests),
        state: completedState,
      })
}

export const getChunkedDirtyWorkRebuildPriority = (component: ReviewServingProjectionComponent) => {
  return countReadyRepairComponents.has(component)
    ? activationReviewServingRebuildPriority
    : getOptionalComponentRebuildPriority(component)
}

// Components whose rebuild chunks read the source, so a chunk that started after a row's change rebuilt it (posting and
// summary read their snapshot's own input rows and patch incrementally instead).
const sourceReadingChunkedComponents = new Set<ReviewServingProjectionComponent>([
  'judgmentInputContent',
  'payload',
  'search',
])

// Article claims whose article a completed chunk of the active snapshot rebuilt after the claim's change: the same test
// chunk-based retirement applies, run for the claims in hand so that they are not taken for a reason to rebuild again.
const getClaimsRebuiltByActiveSnapshotChunks = async (input: {
  claims: readonly ReviewServingDirtyWorkClaim[]
  component: ReviewServingProjectionComponent
  database: ReviewServingProjectorServiceDatabase
}) => {
  const articleClaims = input.claims.filter((claim) => {
    return claim.articleId !== null && claim.projectId !== null
  })

  if (!sourceReadingChunkedComponents.has(input.component) || articleClaims.length === 0) {
    return []
  }

  const rows = await input.database.queryJson<{dirtyWorkId: string}>(`
    WITH claimed(dirty_work_id) AS (
      VALUES ${articleClaims
        .map((claim) => {
          return `(${getSqlLiteral(claim.dirtyWorkId)})`
        })
        .join(', ')}
    )
    SELECT DISTINCT dirty_work.dirty_work_id AS dirtyWorkId
    FROM claimed
    INNER JOIN app.review_serving_dirty_work dirty_work
      ON dirty_work.dirty_work_id = claimed.dirty_work_id
    INNER JOIN app.review_rebuild_chunk_manifest chunk
      ON chunk.project_id = dirty_work.project_id
      AND chunk.projection_component = dirty_work.projection_component
      AND chunk.projection_identity = dirty_work.projection_identity
      AND dirty_work.article_id >= chunk.chunk_start_key
      AND dirty_work.article_id <= chunk.chunk_end_key
    INNER JOIN app.review_serving_snapshot_manifest snapshot
      ON snapshot.project_id = chunk.project_id
      AND snapshot.snapshot_id = chunk.snapshot_id
    WHERE snapshot.snapshot_status = 'active'
      AND chunk.status = 'completed'
      AND chunk.started_at IS NOT NULL
      AND COALESCE(chunk.checksum, '') NOT LIKE 'split:%'
      AND COALESCE(chunk.last_error, '') NOT LIKE 'superseded%'
      AND COALESCE(chunk.last_error, '') NOT LIKE 'coalesced%'
      AND COALESCE(dirty_work.source_changed_at, dirty_work.updated_at) < chunk.started_at
      AND NOT EXISTS (
        SELECT 1
        FROM app.review_serving_snapshot_manifest candidate
        WHERE candidate.project_id = dirty_work.project_id
          AND candidate.snapshot_status = 'candidate'
          AND (
            json_contains(candidate.required_components_json, to_json(dirty_work.projection_component))
            OR json_contains(candidate.optional_components_json, to_json(dirty_work.projection_component))
          )
      )
  `)
  const rebuiltClaimIds = new Set(
    rows.map((row) => {
      return row.dirtyWorkId
    }),
  )

  return articleClaims.filter((claim) => {
    return rebuiltClaimIds.has(claim.dirtyWorkId)
  })
}

const hasProjectWideClaim = (claims: readonly ReviewServingDirtyWorkClaim[], projectId: string) => {
  return claims.some((claim) => {
    return claim.projectId === projectId && claim.scopeKind !== 'article'
  })
}

const getChunkedDirtyWorkRebuildReason = (component: ReviewServingProjectionComponent) => {
  return `${component}DirtyWork`
}

const getClaimInputWatermarks = (claim: ReviewServingDirtyWorkClaim): ReviewServingSourcePartitionWatermarks => {
  return {[claim.sourcePartition]: claim.latestSourceHighWaterMark}
}

const getClaimManifestInput = (
  claim: ReviewServingDirtyWorkClaim,
  existing: Awaited<ReturnType<typeof getReviewServingProjectionIdentityManifest>>,
  reviewConfigHash: string | null,
) => {
  return existing === null
    ? {
        baseGeneration: 0,
        definitionVersion: `${claim.projectionComponent}:dirty-claim-seed-v1`,
        inputWatermark: claim.latestSourceHighWaterMark,
        inputWatermarks: getClaimInputWatermarks(claim),
        patchWatermark: 0,
        projectId: claim.projectId,
        projectionComponent: claim.projectionComponent,
        projectionIdentity: claim.projectionIdentity,
        reviewConfigHash,
        status: 'candidate' as const,
      }
    : {...existing, reviewConfigHash}
}

type ProjectClaim = ReviewServingDirtyWorkClaim & {projectId: string}

const isProjectClaim = (claim: ReviewServingDirtyWorkClaim): claim is ProjectClaim => {
  return claim.projectId !== null
}

const getFirstClaimPerProjectionManifest = (claims: readonly ReviewServingDirtyWorkClaim[]) => {
  const firstClaimByManifestId = claims.filter(isProjectClaim).reduce((firstClaims, claim) => {
    const manifestId = getReviewServingProjectionComponentIdentityKey(claim)

    return firstClaims.has(manifestId) ? firstClaims : firstClaims.set(manifestId, claim)
  }, new Map<string, ProjectClaim>())

  return [...firstClaimByManifestId.values()]
}

const getReviewConfigHashByProjectId = async (
  claims: readonly ProjectClaim[],
  database: ReviewServingManifestRepositoryTransaction,
) => {
  const projectIds = [
    ...new Set(
      claims.map((claim) => {
        return claim.projectId
      }),
    ),
  ]

  return projectIds.reduce<Promise<Map<string, string | null>>>(async (previousHashes, projectId) => {
    const hashes = await previousHashes

    return hashes.set(projectId, await getCurrentReviewServingReviewConfigHash(projectId, database))
  }, Promise.resolve(new Map<string, string | null>()))
}

// Claims sharing a projection manifest need one read and at most one write: once the first claim has seeded or
// refreshed the manifest, the per-claim check finds it at the current review config hash and skips the rest.
export const ensureReviewServingClaimManifests: ReviewServingClaimManifestEnsurer = async (claims, database) => {
  const manifestClaims = getFirstClaimPerProjectionManifest(claims)
  const reviewConfigHashByProjectId = await getReviewConfigHashByProjectId(manifestClaims, database)

  await manifestClaims.reduce<Promise<void>>(async (previousEnsure, claim) => {
    await previousEnsure

    const existing = await getReviewServingProjectionIdentityManifest(
      {
        projectId: claim.projectId,
        projectionComponent: claim.projectionComponent,
        projectionIdentity: claim.projectionIdentity,
      },
      database,
    )
    const manifestInput = getClaimManifestInput(
      claim,
      existing,
      reviewConfigHashByProjectId.get(claim.projectId) ?? null,
    )

    if (existing !== null && existing.reviewConfigHash === manifestInput.reviewConfigHash) {
      return
    }

    await upsertReviewServingProjectionIdentityManifest(manifestInput, database)
  }, Promise.resolve())
}

const getWakeStatus = (input: {
  failureCount: number
  releasedCount: number
  runCount: number
}): WakeReviewServingProjectorServiceResult['status'] => {
  if (input.failureCount > 0) {
    return 'failed'
  }

  if (input.releasedCount > 0) {
    return 'partial'
  }

  return input.runCount > 0 ? 'completed' : 'idle'
}

export const getReviewServingProjectorComponentRunPlan = (scope: ReviewServingDirtyWorkScope) => {
  const rule = getReviewServingInvalidationRuleOrNull(scope.dirtyKind)
  const firstAffectedIndex = rule?.affectedComponents.indexOf(scope.firstAffectedComponent) ?? -1

  return rule === null || firstAffectedIndex < 0 ? [] : rule.affectedComponents.slice(firstAffectedIndex)
}

export const intakeReviewServingProjectorDirtyWork = async (
  input: IntakeReviewServingProjectorDirtyWorkInput,
  dependencies: Pick<ReviewServingProjectorServiceDependencies, 'database' | 'upsertDirtyWork'> = {},
): Promise<IntakeReviewServingProjectorDirtyWorkResult> => {
  const database = dependencies.database ?? getDefaultDatabase()
  const upsertDirtyWork = dependencies.upsertDirtyWork ?? upsertReviewServingDirtyWork
  const components = getReviewServingProjectorComponentRunPlan(input.scope)

  if (components.length === 0) {
    return {reason: `unsupported dirty kind: ${input.scope.dirtyKind}`, status: 'failed'}
  }

  return database.transaction(async (tx) => {
    const results = await components.reduce<Promise<{skipped: boolean}[]>>(async (previousResults, component) => {
      const results = await previousResults
      const projectionIdentity = input.identityResolver({component, scope: input.scope})
      const result = await upsertDirtyWork(
        {
          latestDeltaId: input.latestDeltaId ?? null,
          projectionComponent: component,
          projectionIdentity,
          scope: input.scope,
        },
        tx,
      )

      return [...results, result]
    }, Promise.resolve([]))

    return {
      dirtyWorkCount: results.filter((result) => {
        return !result.skipped
      }).length,
      status: 'queued' as const,
    }
  })
}

const runProjectorWithRetry = async (input: {
  claims: readonly ReviewServingDirtyWorkClaim[]
  component: ReviewServingProjectionComponent
  maxRetries: number
  runner: ReviewServingProjectorRunner
  wakeId: string
}) => {
  const runAttempt = async (attempt: number): Promise<ReviewServingProjectorRunResult & {attempts: number}> => {
    try {
      const result = await input.runner({claims: input.claims, component: input.component, wakeId: input.wakeId})

      return {...result, attempts: attempt}
    } catch (error) {
      if (attempt >= input.maxRetries + 1) {
        throw error
      }

      return runAttempt(attempt + 1)
    }
  }

  return runAttempt(1)
}

const getWakeBlockedReason = async (
  input: WakeReviewServingProjectorServiceInput,
  dependencies: ReviewServingProjectorServiceDependencies,
): Promise<ReviewServingProjectorWakeBlockedReason | null> => {
  const queueState = await dependencies.getQueueState?.()
  const activeImportCount = queueState?.activeImportCount ?? 0
  const foregroundDuckdbQueueDepth = queueState?.foregroundDuckdbQueueDepth ?? 0
  const pendingDirtyWorkCount = queueState?.pendingDirtyWorkCount ?? 0
  const activeImportBlocked = input.maxActiveImportCount !== undefined && activeImportCount > input.maxActiveImportCount
  const foregroundDuckdbQueueBlocked = queueState?.blocked === undefined && foregroundDuckdbQueueDepth > 0
  const queuePressureBlocked =
    input.maxPendingDirtyWorkCount !== undefined && pendingDirtyWorkCount > input.maxPendingDirtyWorkCount

  if (queueState?.blocked === true) {
    return queueState.blockedReason ?? 'foregroundQueue'
  }

  if (foregroundDuckdbQueueBlocked) {
    return 'foregroundQueue'
  }

  return activeImportBlocked || queuePressureBlocked ? 'budget' : null
}

const shouldBlockWake = async (
  input: WakeReviewServingProjectorServiceInput,
  dependencies: ReviewServingProjectorServiceDependencies,
) => {
  return (await getWakeBlockedReason(input, dependencies)) !== null
}

export const wakeReviewServingProjectorService = async (
  input: WakeReviewServingProjectorServiceInput,
  dependencies: ReviewServingProjectorServiceDependencies,
): Promise<WakeReviewServingProjectorServiceResult> => {
  const database = dependencies.database ?? getDefaultDatabase()
  const claimDirtyWork = dependencies.claimDirtyWork ?? claimReviewServingDirtyWork
  const completeDirtyWork = dependencies.completeDirtyWork ?? completeReviewServingDirtyWorkClaims
  const failDirtyWork = dependencies.failDirtyWork ?? failReviewServingDirtyWorkClaims
  const releaseDirtyWork = dependencies.releaseDirtyWork ?? releaseReviewServingDirtyWorkClaims
  const blockDirtyWorkForRebuild = dependencies.blockDirtyWorkForRebuild ?? blockReviewServingDirtyWorkClaimsForRebuild
  const ensureClaimManifests = dependencies.ensureClaimManifests ?? ensureReviewServingClaimManifests
  const promoteSnapshot = dependencies.promoteSnapshot ?? promoteReviewServingProjectorSnapshot
  const requestRebuild = dependencies.requestRebuild ?? requestReviewServingV4RebuildEffect
  const nowMs = dependencies.nowMs ?? Date.now
  const budget = getNormalizedBudget(input)
  const startedAt = nowMs()
  const componentOrder =
    input.componentOrder ?? getVisibilityFirstReviewServingComponentOrder(input.componentRotationOffset)
  const initialBlockedReason = await getWakeBlockedReason(input, dependencies)
  const budgetExhausted = budget.batchSize === 0 || budget.maxRowsPerWake === 0 || input.maxWakeMs <= 0

  if (initialBlockedReason !== null || budgetExhausted) {
    return {
      blockedReason: initialBlockedReason ?? 'budget',
      blockedRebuilds: [],
      failures: [],
      promotions: [],
      releasedClaimIds: [],
      runs: [],
      status: 'blocked',
    }
  }

  const visitComponent = async (
    state: WakeReviewServingProjectorState,
    visit: ReviewServingProjectorComponentVisit,
  ): Promise<WakeReviewServingProjectorState> => {
    const {component} = visit
    const runner = dependencies.runners[component]
    const remainingRows = budget.maxRowsPerWake - state.processedRows
    const elapsedMs = nowMs() - startedAt
    const blocked = await shouldBlockWake(input, dependencies)

    if (runner === undefined || remainingRows <= 0 || elapsedMs >= input.maxWakeMs || blocked) {
      return state
    }

    const claims = await claimDirtyWork(
      {
        ...(visit.claimOrder === undefined ? {} : {claimOrder: visit.claimOrder}),
        limit: Math.min(getComponentBatchSize(budget, component), remainingRows),
        projectionComponent: component,
      },
      database,
    )
    const claimIds = getDirtyWorkIds(claims)
    const exhaustedAfterClaim = nowMs() - startedAt >= input.maxWakeMs || (await shouldBlockWake(input, dependencies))

    if (claims.length === 0) {
      return state
    }

    if (exhaustedAfterClaim) {
      await releaseDirtyWork(claimIds, database)

      return {...state, releasedClaimIds: [...state.releasedClaimIds, ...claimIds]}
    }

    const articleDirtyWorkRoute = await getArticleDirtyWorkRoute({claims, component, database})
    const chunkedDirtyWorkProjectIds =
      articleDirtyWorkRoute === 'incremental' ? [] : getChunkedDirtyWorkProjectIds(component, claims)

    if (chunkedDirtyWorkProjectIds.length > 0) {
      // Claims a completed chunk of the active snapshot already rebuilt are complete; only the rest need a rebuild.
      const rebuiltClaims = await getClaimsRebuiltByActiveSnapshotChunks({claims, component, database})
      const openClaims = claims.filter((claim) => {
        return !rebuiltClaims.includes(claim)
      })
      const openClaimIds = getDirtyWorkIds(openClaims)
      const openProjectIds = chunkedDirtyWorkProjectIds.filter((projectId) => {
        return openClaims.some((claim) => {
          return claim.projectId === projectId
        })
      })

      if (rebuiltClaims.length > 0) {
        await completeDirtyWork(rebuiltClaims, database)
      }

      const openState =
        rebuiltClaims.length === 0
          ? state
          : {
              ...state,
              processedRows: state.processedRows + rebuiltClaims.length,
              runs: [
                ...state.runs,
                {
                  attempts: 1,
                  claimCount: rebuiltClaims.length,
                  component,
                  processedCount: 0,
                  status: 'completed' as const,
                },
              ],
            }

      if (openClaims.length === 0) {
        return openState
      }

      const rebuildResult = await Effect.runPromise(
        Effect.either(
          Effect.forEach(
            openProjectIds,
            (projectId) => {
              return requestRebuild(
                {
                  components: [component],
                  // Claims not scoped to one article can neither patch incrementally nor be retired by the chunk
                  // that rebuilt their article, so they take a fresh snapshot, whose request covers them.
                  ...(hasProjectWideClaim(openClaims, projectId) ? {inPlace: false} : {}),
                  priority: getChunkedDirtyWorkRebuildPriority(component),
                  projectId,
                  reason: getChunkedDirtyWorkRebuildReason(component),
                  reuseBlockedRequestWithinMs: blockedRebuildRequestReuseMs,
                },
                database,
              )
            },
            {concurrency: 1},
          ),
        ),
      )

      if (rebuildResult._tag === 'Left') {
        const rebuildDiagnostic = getDiagnostic(rebuildResult.left)
        await failDirtyWork(openClaimIds, database)
        logDirtyWorkProjectorFailure({
          claimIds: openClaimIds,
          claims: openClaims,
          component,
          diagnostic: rebuildDiagnostic,
        })

        return {
          ...openState,
          failures: [
            ...openState.failures,
            {attempts: 1, claimIds: openClaimIds, component, diagnostic: rebuildDiagnostic, status: 'failed' as const},
          ],
          processedRows: openState.processedRows + openClaims.length,
        }
      }

      const blockedRebuildRequests = getBlockedRebuildRequests(rebuildResult.right)

      if (blockedRebuildRequests.length > 0) {
        return parkDirtyWorkClaimsBlockedByRebuild({
          blockDirtyWorkForRebuild,
          claims: openClaims,
          component,
          database,
          diagnostic: getBlockedRebuildRequestDiagnostic(blockedRebuildRequests),
          state: openState,
        })
      }

      const activeSnapshotBuildingRequestIds = await getActiveSnapshotBuildingRequestIds({
        component,
        database,
        requests: rebuildResult.right,
      })

      if (articleDirtyWorkRoute === 'bootstrap') {
        return settleBootstrapRoutedArticleDirtyWork({
          activeSnapshotBuildingRequestIds,
          blockDirtyWorkForRebuild,
          claims: openClaims,
          completeDirtyWork,
          component,
          database,
          releaseDirtyWork,
          requests: rebuildResult.right,
          state: openState,
        })
      }

      const coveredClaims = openClaims.filter((claim) => {
        return isClaimCoveredByRebuildRequests(claim, rebuildResult.right, activeSnapshotBuildingRequestIds)
      })
      const uncoveredClaimIds = getDirtyWorkIds(
        openClaims.filter((claim) => {
          return !coveredClaims.includes(claim)
        }),
      )

      if (uncoveredClaimIds.length > 0) {
        await releaseDirtyWork(uncoveredClaimIds, database)
      }

      if (coveredClaims.length > 0) {
        await completeDirtyWork(coveredClaims, database)
      }

      const releasedState =
        uncoveredClaimIds.length === 0
          ? openState
          : {...openState, releasedClaimIds: [...openState.releasedClaimIds, ...uncoveredClaimIds]}

      return coveredClaims.length === 0
        ? releasedState
        : {
            ...releasedState,
            processedRows: releasedState.processedRows + coveredClaims.length,
            runs: [
              ...releasedState.runs,
              {
                attempts: 1,
                claimCount: coveredClaims.length,
                component,
                processedCount: 0,
                status: 'completed' as const,
              },
            ],
          }
    }

    try {
      await ensureClaimManifests(claims, database)
      const result = await runProjectorWithRetry({
        claims,
        component,
        maxRetries: budget.maxRetries,
        runner,
        wakeId: input.wakeId,
      })
      const promotions = await (result.candidateSnapshots ?? []).reduce<
        Promise<PromoteReviewServingProjectorSnapshotResult[]>
      >(async (previousPromotions, candidateSnapshot) => {
        const promotions = await previousPromotions
        const promotion = await promoteSnapshot(candidateSnapshot, database)

        return [...promotions, promotion]
      }, Promise.resolve([]))
      const processedCount = result.processedCount ?? claims.length
      const runnerReleasedClaimIds = result.releasedClaimIds ?? []

      return {
        ...state,
        processedRows: state.processedRows + claims.length,
        promotions: [...state.promotions, ...promotions],
        releasedClaimIds: [...state.releasedClaimIds, ...runnerReleasedClaimIds],
        runs: [
          ...state.runs,
          {
            attempts: result.attempts,
            claimCount: claims.length - runnerReleasedClaimIds.length,
            component,
            processedCount,
            status: 'completed' as const,
          },
        ],
      }
    } catch (error) {
      const diagnostic = getDiagnostic(error)
      const missingSnapshotProjectIds = isMissingSnapshotDiagnostic(diagnostic) ? getClaimProjectIds(claims) : []

      if (missingSnapshotProjectIds.length > 0) {
        const rebuildResult = await Effect.runPromise(
          Effect.either(
            Effect.forEach(
              missingSnapshotProjectIds,
              (projectId) => {
                return requestRebuild(
                  {
                    components: getMissingSnapshotRepairComponents(component),
                    pageFirstOnly: true,
                    priority: getMissingSnapshotRepairPriority(component),
                    projectId,
                    reason: 'missingReviewServingSnapshot',
                    reuseBlockedRequestWithinMs: blockedRebuildRequestReuseMs,
                  },
                  database,
                )
              },
              {concurrency: 1},
            ),
          ),
        )

        if (rebuildResult._tag === 'Left') {
          const rebuildDiagnostic = getDiagnostic(rebuildResult.left)
          await failDirtyWork(claimIds, database)
          logDirtyWorkProjectorFailure({claimIds, claims, component, diagnostic: rebuildDiagnostic})

          return {
            ...state,
            failures: [
              ...state.failures,
              {
                attempts: budget.maxRetries + 1,
                claimIds,
                component,
                diagnostic: rebuildDiagnostic,
                status: 'failed' as const,
              },
            ],
            processedRows: state.processedRows + claims.length,
          }
        }

        const blockedRebuildRequests = getBlockedRebuildRequests(rebuildResult.right)

        if (blockedRebuildRequests.length > 0) {
          return parkDirtyWorkClaimsBlockedByRebuild({
            blockDirtyWorkForRebuild,
            claims,
            component,
            database,
            diagnostic: getBlockedRebuildRequestDiagnostic(blockedRebuildRequests),
            state,
          })
        }

        await blockDirtyWorkForRebuild(claimIds, database)

        return {...state, releasedClaimIds: [...state.releasedClaimIds, ...claimIds]}
      }

      await failDirtyWork(claimIds, database)
      logDirtyWorkProjectorFailure({claimIds, claims, component, diagnostic})

      return {
        ...state,
        failures: [
          ...state.failures,
          {attempts: budget.maxRetries + 1, claimIds, component, diagnostic, status: 'failed' as const},
        ],
        processedRows: state.processedRows + claims.length,
      }
    }
  }
  const wakeState = await getComponentVisits(componentOrder, input).reduce<Promise<WakeReviewServingProjectorState>>(
    async (previousState, visit) => {
      const state = await previousState
      const limit = Math.min(
        getComponentBatchSize(budget, visit.component),
        budget.maxRowsPerWake - state.processedRows,
      )

      if (state.settledVisits.includes(getVisitKey(visit))) {
        return state
      }

      const next = await visitComponent(state, visit)

      return {...next, settledVisits: getSettledVisitsAfterVisit({limit, next, previous: state, visit})}
    },
    Promise.resolve({
      blockedRebuilds: [],
      failures: [],
      processedRows: 0,
      promotions: [],
      releasedClaimIds: [],
      runs: [],
      settledVisits: [],
    }),
  )

  return {
    blockedReason: null,
    blockedRebuilds: wakeState.blockedRebuilds,
    failures: wakeState.failures,
    promotions: wakeState.promotions,
    releasedClaimIds: wakeState.releasedClaimIds,
    runs: wakeState.runs,
    status: getWakeStatus({
      failureCount: wakeState.failures.length,
      releasedCount: wakeState.releasedClaimIds.length,
      runCount: wakeState.runs.length,
    }),
  }
}
