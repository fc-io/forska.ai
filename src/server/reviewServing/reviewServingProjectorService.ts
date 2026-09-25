import {Effect} from 'effect'

import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {createRateLimitedLogger} from '../utils/rateLimitedLogger.ts'
import {countReadyReviewServingComponents, type ReviewServingProjectionComponent} from './reviewServingContracts.ts'
import {
  blockReviewServingDirtyWorkClaimsForRebuild,
  claimReviewServingDirtyWork,
  type ClaimReviewServingDirtyWorkParams,
  completeReviewServingDirtyWorkClaims,
  defaultReviewServingDirtyWorkBlockedByRebuildRequeueSeconds,
  failReviewServingDirtyWorkClaims,
  releaseReviewServingDirtyWorkClaims,
  type ReviewServingDirtyWorkClaim,
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
import {requestReviewServingV4RebuildEffect} from './reviewServingV4RebuildRequestService.ts'

export type ReviewServingProjectorRunContext = {
  claims: readonly ReviewServingDirtyWorkClaim[]
  component: ReviewServingProjectionComponent
  wakeId: string
}

export type ReviewServingProjectorRunResult = {
  candidateSnapshots?: readonly PromoteReviewServingProjectorSnapshotInput[]
  processedCount?: number
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
const incrementalArticleDirtyWorkComponents = new Set<ReviewServingProjectionComponent>(['payload', 'posting'])

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
  batchSize: number
  componentOrder?: readonly ReviewServingProjectionComponent[]
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
}

const defaultComponentOrder: readonly ReviewServingProjectionComponent[] = [
  'projectScope',
  'selectedImport',
  'display',
  'llmStatus',
  'humanStatus',
  'queue',
  'payload',
  'posting',
  'summary',
  'judgmentInputContent',
  'search',
]
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

const isClaimCoveredByRebuildRequest = (claim: ReviewServingDirtyWorkClaim, request: ReviewServingRebuildRequest) => {
  if (claim.projectId === null || request.projectId !== claim.projectId) {
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

const areClaimsCoveredByRebuildRequests = (
  claims: readonly ReviewServingDirtyWorkClaim[],
  requests: readonly ReviewServingRebuildRequest[],
) => {
  return claims.every((claim) => {
    return requests.some((request) => {
      return isClaimCoveredByRebuildRequest(claim, request)
    })
  })
}

const getNormalizedBudget = (input: WakeReviewServingProjectorServiceInput) => {
  const batchSize = Math.max(0, Math.floor(input.batchSize))
  const maxRowsPerWake = Math.max(0, Math.floor(input.maxRowsPerWake))
  const maxRetries = Math.max(0, Math.floor(input.maxRetries ?? 1))

  return {batchSize, maxRetries, maxRowsPerWake}
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
      {projectId, projectionComponent: input.component, projectionIdentity, reviewConfigHash},
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

const settleBootstrapRoutedArticleDirtyWork = async (input: {
  blockDirtyWorkForRebuild: typeof blockReviewServingDirtyWorkClaimsForRebuild
  claims: readonly ReviewServingDirtyWorkClaim[]
  completeDirtyWork: typeof completeReviewServingDirtyWorkClaims
  component: ReviewServingProjectionComponent
  database: ReviewServingProjectorServiceDatabase
  requests: readonly ReviewServingRebuildRequest[]
  state: WakeReviewServingProjectorState
}): Promise<WakeReviewServingProjectorState> => {
  const coveredClaims = input.claims.filter((claim) => {
    return input.requests.some((request) => {
      return isClaimCoveredByRebuildRequest(claim, request)
    })
  })
  const waitingClaims = input.claims.filter((claim) => {
    return !coveredClaims.includes(claim)
  })

  if (coveredClaims.length > 0) {
    await input.completeDirtyWork(coveredClaims, input.database)
  }

  const completedState =
    coveredClaims.length === 0
      ? input.state
      : {
          ...input.state,
          processedRows: input.state.processedRows + coveredClaims.length,
          runs: [
            ...input.state.runs,
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
    input.componentOrder ?? getRotatedComponentOrder(defaultComponentOrder, input.componentRotationOffset)
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

  const wakeState = await componentOrder.reduce<Promise<WakeReviewServingProjectorState>>(
    async (previousState, component) => {
      const state = await previousState
      const runner = dependencies.runners[component]
      const remainingRows = budget.maxRowsPerWake - state.processedRows
      const elapsedMs = nowMs() - startedAt
      const blocked = await shouldBlockWake(input, dependencies)

      if (runner === undefined || remainingRows <= 0 || elapsedMs >= input.maxWakeMs || blocked) {
        return state
      }

      const claims = await claimDirtyWork(
        {limit: Math.min(budget.batchSize, remainingRows), projectionComponent: component},
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
        const rebuildResult = await Effect.runPromise(
          Effect.either(
            Effect.forEach(
              chunkedDirtyWorkProjectIds,
              (projectId) => {
                return requestRebuild(
                  {
                    components: [component],
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
          await failDirtyWork(claimIds, database)
          logDirtyWorkProjectorFailure({claimIds, claims, component, diagnostic: rebuildDiagnostic})

          return {
            ...state,
            failures: [
              ...state.failures,
              {attempts: 1, claimIds, component, diagnostic: rebuildDiagnostic, status: 'failed' as const},
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

        if (articleDirtyWorkRoute === 'bootstrap') {
          return settleBootstrapRoutedArticleDirtyWork({
            blockDirtyWorkForRebuild,
            claims,
            completeDirtyWork,
            component,
            database,
            requests: rebuildResult.right,
            state,
          })
        }

        if (!areClaimsCoveredByRebuildRequests(claims, rebuildResult.right)) {
          await releaseDirtyWork(claimIds, database)

          return {...state, releasedClaimIds: [...state.releasedClaimIds, ...claimIds]}
        }

        await completeDirtyWork(claims, database)

        return {
          ...state,
          processedRows: state.processedRows + claims.length,
          runs: [
            ...state.runs,
            {attempts: 1, claimCount: claims.length, component, processedCount: 0, status: 'completed' as const},
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

        return {
          ...state,
          processedRows: state.processedRows + claims.length,
          promotions: [...state.promotions, ...promotions],
          runs: [
            ...state.runs,
            {
              attempts: result.attempts,
              claimCount: claims.length,
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
    },
    Promise.resolve({
      blockedRebuilds: [],
      failures: [],
      processedRows: 0,
      promotions: [],
      releasedClaimIds: [],
      runs: [],
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
