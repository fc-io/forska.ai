import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import type {ReviewServingProjectionComponent} from './reviewServingContracts.ts'
import {
  claimReviewServingDirtyWork,
  failReviewServingDirtyWorkClaims,
  releaseReviewServingDirtyWorkClaims,
  type ReviewServingDirtyWorkClaim,
  type ReviewServingDirtyWorkDatabase,
  upsertReviewServingDirtyWork,
} from './reviewServingDirtyWorkService.ts'
import {getReviewServingInvalidationRuleOrNull} from './reviewServingInvalidationRegistry.ts'
import {
  getReviewServingProjectionIdentityManifest,
  type ReviewServingManifestRepositoryDatabase,
  type ReviewServingManifestRepositoryTransaction,
  upsertReviewServingProjectionIdentityManifest,
} from './reviewServingManifestRepository.ts'
import type {
  ReviewServingDirtyWorkScope,
  ReviewServingSourcePartitionWatermarks,
} from './reviewServingProjectorDomain.ts'
import {
  promoteReviewServingProjectorSnapshot,
  type PromoteReviewServingProjectorSnapshotInput,
  type PromoteReviewServingProjectorSnapshotResult,
} from './reviewServingProjectorWriter.ts'
import {getCurrentReviewServingReviewConfigHash} from './reviewServingReviewConfig.ts'

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

export type ReviewServingProjectorQueueState = {activeImportCount?: number; pendingDirtyWorkCount?: number}

export type ReviewServingProjectorServiceDependencies = {
  claimDirtyWork?: typeof claimReviewServingDirtyWork
  database?: ReviewServingProjectorServiceDatabase
  ensureClaimManifests?: ReviewServingClaimManifestEnsurer
  failDirtyWork?: typeof failReviewServingDirtyWorkClaims
  getQueueState?: () => Promise<ReviewServingProjectorQueueState>
  nowMs?: () => number
  promoteSnapshot?: typeof promoteReviewServingProjectorSnapshot
  releaseDirtyWork?: typeof releaseReviewServingDirtyWorkClaims
  runners: Partial<Record<ReviewServingProjectionComponent, ReviewServingProjectorRunner>>
  upsertDirtyWork?: typeof upsertReviewServingDirtyWork
}

type ReviewServingProjectorServiceDatabase = ReviewServingDirtyWorkDatabase & ReviewServingManifestRepositoryDatabase

type ReviewServingClaimManifestEnsurer = (
  claims: readonly ReviewServingDirtyWorkClaim[],
  database: ReviewServingManifestRepositoryTransaction,
) => Promise<void>

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

export type WakeReviewServingProjectorServiceResult = {
  failures: readonly ReviewServingProjectorFailure[]
  promotions: readonly PromoteReviewServingProjectorSnapshotResult[]
  releasedClaimIds: readonly string[]
  runs: readonly ReviewServingProjectorComponentRun[]
  status: 'blocked' | 'completed' | 'failed' | 'partial'
}

const defaultComponentOrder: readonly ReviewServingProjectionComponent[] = [
  'projectScope',
  'selectedImport',
  'display',
  'search',
  'judgmentInputContent',
  'llmStatus',
  'humanStatus',
  'queue',
  'posting',
  'payload',
  'summary',
]

const getDiagnostic = (error: unknown) => {
  return error instanceof Error ? error.message : String(error)
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

const getClaimInputWatermarks = (claim: ReviewServingDirtyWorkClaim): ReviewServingSourcePartitionWatermarks => {
  return {[claim.sourcePartition]: claim.latestSourceHighWaterMark}
}

const getClaimManifestInput = async (
  claim: ReviewServingDirtyWorkClaim,
  existing: Awaited<ReturnType<typeof getReviewServingProjectionIdentityManifest>>,
  database: ReviewServingManifestRepositoryTransaction,
) => {
  const reviewConfigHash =
    claim.projectId === null ? null : await getCurrentReviewServingReviewConfigHash(claim.projectId, database)

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

export const ensureReviewServingClaimManifests: ReviewServingClaimManifestEnsurer = async (claims, database) => {
  await claims.reduce<Promise<void>>(async (previousEnsure, claim) => {
    await previousEnsure

    if (claim.projectId === null) {
      return
    }

    const existing = await getReviewServingProjectionIdentityManifest(
      {
        projectId: claim.projectId,
        projectionComponent: claim.projectionComponent,
        projectionIdentity: claim.projectionIdentity,
      },
      database,
    )

    const manifestInput = await getClaimManifestInput(claim, existing, database)

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

  return input.runCount > 0 ? 'completed' : 'blocked'
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

const shouldBlockWake = async (
  input: WakeReviewServingProjectorServiceInput,
  dependencies: ReviewServingProjectorServiceDependencies,
) => {
  const queueState = await dependencies.getQueueState?.()
  const activeImportCount = queueState?.activeImportCount ?? 0
  const pendingDirtyWorkCount = queueState?.pendingDirtyWorkCount ?? 0
  const activeImportBlocked = input.maxActiveImportCount !== undefined && activeImportCount > input.maxActiveImportCount
  const queuePressureBlocked =
    input.maxPendingDirtyWorkCount !== undefined && pendingDirtyWorkCount > input.maxPendingDirtyWorkCount

  return activeImportBlocked || queuePressureBlocked
}

export const wakeReviewServingProjectorService = async (
  input: WakeReviewServingProjectorServiceInput,
  dependencies: ReviewServingProjectorServiceDependencies,
): Promise<WakeReviewServingProjectorServiceResult> => {
  const database = dependencies.database ?? getDefaultDatabase()
  const claimDirtyWork = dependencies.claimDirtyWork ?? claimReviewServingDirtyWork
  const releaseDirtyWork = dependencies.releaseDirtyWork ?? releaseReviewServingDirtyWorkClaims
  const failDirtyWork = dependencies.failDirtyWork ?? failReviewServingDirtyWorkClaims
  const ensureClaimManifests = dependencies.ensureClaimManifests ?? ensureReviewServingClaimManifests
  const promoteSnapshot = dependencies.promoteSnapshot ?? promoteReviewServingProjectorSnapshot
  const nowMs = dependencies.nowMs ?? Date.now
  const budget = getNormalizedBudget(input)
  const startedAt = nowMs()
  const componentOrder = input.componentOrder ?? defaultComponentOrder
  const initialBlocked = await shouldBlockWake(input, dependencies)

  if (initialBlocked || budget.batchSize === 0 || budget.maxRowsPerWake === 0 || input.maxWakeMs <= 0) {
    return {failures: [], promotions: [], releasedClaimIds: [], runs: [], status: 'blocked'}
  }

  const wakeState = await componentOrder.reduce<
    Promise<{
      failures: ReviewServingProjectorFailure[]
      processedRows: number
      promotions: PromoteReviewServingProjectorSnapshotResult[]
      releasedClaimIds: string[]
      runs: ReviewServingProjectorComponentRun[]
    }>
  >(
    async (previousState, component) => {
      const state = await previousState
      const runner = dependencies.runners[component]
      const remainingRows = budget.maxRowsPerWake - state.processedRows
      const elapsedMs = nowMs() - startedAt
      const blocked = await shouldBlockWake(input, dependencies)

      if (
        runner === undefined
        || remainingRows <= 0
        || elapsedMs >= input.maxWakeMs
        || blocked
        || state.failures.length > 0
      ) {
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
        await failDirtyWork(claimIds, database)

        return {
          ...state,
          failures: [
            ...state.failures,
            {
              attempts: budget.maxRetries + 1,
              claimIds,
              component,
              diagnostic: getDiagnostic(error),
              status: 'failed' as const,
            },
          ],
          processedRows: state.processedRows + claims.length,
        }
      }
    },
    Promise.resolve({failures: [], processedRows: 0, promotions: [], releasedClaimIds: [], runs: []}),
  )

  return {
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
