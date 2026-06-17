import {hostname} from 'node:os'

import {sleep} from '../../utils/sleep.ts'
import {
  claimReviewServingRebuildChunk,
  isReviewServingRebuildChunkComplete,
  markReviewServingRebuildChunkFailed,
  type ReviewServingChunkManifestRepositoryDatabase,
  type ReviewServingRebuildChunkIdentity,
  type ReviewServingRebuildChunkManifest,
} from '../reviewServing/reviewServingChunkManifestRepository.ts'
import {projectReviewServingHumanStatusPatches} from '../reviewServing/reviewServingHumanStatusProjector.ts'
import {projectReviewServingLlmStatusPatches} from '../reviewServing/reviewServingLlmStatusProjector.ts'
import {getReviewServingProjectionIdentityManifest} from '../reviewServing/reviewServingManifestRepository.ts'
import {projectReviewServingProjectScopePatches} from '../reviewServing/reviewServingProjectScopeProjector.ts'
import {
  type ReviewServingProjectorRunner,
  type ReviewServingProjectorServiceDependencies,
  wakeReviewServingProjectorService,
  type WakeReviewServingProjectorServiceInput,
  type WakeReviewServingProjectorServiceResult,
} from '../reviewServing/reviewServingProjectorService.ts'
import {
  cleanupReviewServingRetentionState,
  type ReviewServingRetentionCleanupInput,
  type ReviewServingRetentionServiceDatabase,
} from '../reviewServing/reviewServingRetentionService.ts'
import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import type {DuckdbWorkloadContext} from '../utils/duckdbService.ts'

type ReviewServingProjectorWorkerDatabase = ReviewServingProjectorServiceDependencies['database']

type ReviewServingProjectorWorkerCleanupTarget = ReviewServingRetentionCleanupInput

type ReviewServingProjectorWorkerChunkInput = ReviewServingRebuildChunkIdentity & {checksum?: string | null}

type ReviewServingProjectorWorkerRebuildChunkService = {
  claimChunk: typeof claimReviewServingRebuildChunk
  failChunk: typeof markReviewServingRebuildChunkFailed
  getNextChunk: () => Promise<ReviewServingProjectorWorkerChunkInput | null>
  isChunkComplete: typeof isReviewServingRebuildChunkComplete
  runClaimedChunk: (input: {
    chunk: ReviewServingRebuildChunkManifest
    leaseOwner: string
    workloadContext: DuckdbWorkloadContext
  }) => Promise<{status: 'completed'}>
}

type ReviewServingProjectorWorkerDependencies = {
  cleanupRetentionState?: typeof cleanupReviewServingRetentionState
  getCleanupTargets?: () => Promise<readonly ReviewServingProjectorWorkerCleanupTarget[]>
  getDatabase?: () => ReviewServingProjectorWorkerDatabase
    & ReviewServingChunkManifestRepositoryDatabase
    & ReviewServingRetentionServiceDatabase
  nowMs?: () => number
  projectorServiceDependencies?: Omit<ReviewServingProjectorServiceDependencies, 'database' | 'nowMs'>
  rebuildChunkService?: ReviewServingProjectorWorkerRebuildChunkService
  sleep: typeof sleep
  wakeProjectors: typeof wakeReviewServingProjectorService
}

type ReviewServingProjectorWorkerCycleOptions = {
  batchSize?: number
  cleanupIntervalMs?: number
  lastCleanupAtMs?: number | null
  leaseMs?: number
  maxActiveImportCount?: number
  maxPendingDirtyWorkCount?: number
  maxRetries?: number
  maxRowsPerWake?: number
  maxWakeMs?: number
  now?: Date
  workerId?: string
}

type ReviewServingProjectorWorkerLoopOptions = ReviewServingProjectorWorkerCycleOptions & {
  errorBackoffMs?: number
  pollIntervalMs?: number
  signal?: AbortSignal
}

type ReviewServingProjectorWorkerChunkResult =
  | {chunkId: null; status: 'idle'}
  | {chunkId: string; status: 'completed'}
  | {chunkId: string; status: 'failed'}
  | {chunkId: string; status: 'skipped'}

type ReviewServingProjectorWorkerCleanupResult =
  | {retentionScopes: readonly string[]; status: 'completed'}
  | {retentionScopes: readonly string[]; status: 'skipped'}

type ReviewServingProjectorWorkerCycleResult = {
  chunk: ReviewServingProjectorWorkerChunkResult
  cleanup: ReviewServingProjectorWorkerCleanupResult
  nextCleanupAtMs: number | null
  projector: WakeReviewServingProjectorServiceResult
  status: 'completed' | 'failed' | 'idle' | 'partial'
  wakeId: string
  workerId: string
}

const defaultReviewServingProjectorWorkerBatchSize = 64
const defaultReviewServingProjectorWorkerCleanupIntervalMs = 60_000
const defaultReviewServingProjectorWorkerLeaseMs = 30_000
const defaultReviewServingProjectorWorkerMaxRetries = 1
const defaultReviewServingProjectorWorkerMaxRowsPerWake = 512
const defaultReviewServingProjectorWorkerMaxWakeMs = 5_000
const defaultReviewServingProjectorWorkerPollIntervalMs = 2_000
const defaultReviewServingProjectorWorkerErrorBackoffMs = 10_000
const reviewServingProjectorWorkerRouteOrJobKey = 'reviewServing.projector.worker'

const getClaimProjectId = (claims: readonly {projectId: string | null}[]) => {
  return claims.find((claim) => {
    return claim.projectId !== null
  })?.projectId ?? null
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

const getDefaultReviewServingProjectorRunners = (
  database: ReviewServingProjectorWorkerDatabase,
): ReviewServingProjectorServiceDependencies['runners'] => {
  return {
    humanStatus: async (context) => {
      const {manifest, projectId} = await getDefaultClaimManifestInput(context, database)
      const result = await projectReviewServingHumanStatusPatches(
        {
          baseGeneration: manifest.baseGeneration,
          claims: context.claims,
          definitionVersion: manifest.definitionVersion,
          listModeKeys: ['global'],
          projectId,
          projectionIdentity: manifest.projectionIdentity,
        },
        database,
      )

      return {processedCount: result.patchRowCount}
    },
    llmStatus: async (context) => {
      const {manifest, projectId} = await getDefaultClaimManifestInput(context, database)
      const result = await projectReviewServingLlmStatusPatches(
        {
          baseGeneration: manifest.baseGeneration,
          claims: context.claims,
          definitionVersion: manifest.definitionVersion,
          listModeKeys: ['global'],
          projectId,
          projectionIdentity: manifest.projectionIdentity,
        },
        database,
      )

      return {processedCount: result.patchRowCount}
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
  }
}

const defaultReviewServingProjectorWorkerDependencies: ReviewServingProjectorWorkerDependencies = {
  cleanupRetentionState: cleanupReviewServingRetentionState,
  getDatabase: getAppDatabaseService as ReviewServingProjectorWorkerDependencies['getDatabase'],
  getCleanupTargets: async () => {
    return []
  },
  rebuildChunkService: {
    claimChunk: claimReviewServingRebuildChunk,
    failChunk: markReviewServingRebuildChunkFailed,
    getNextChunk: async () => {
      return null
    },
    isChunkComplete: isReviewServingRebuildChunkComplete,
    runClaimedChunk: async () => {
      return {status: 'completed'}
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
  return Number.isInteger(value) && value > 0 ? Math.trunc(value) : fallback
}

const getLeaseExpiresAt = (options: ReviewServingProjectorWorkerCycleOptions) => {
  return new Date(
    getWorkerNow(options).getTime() + getPositiveInteger(options.leaseMs, defaultReviewServingProjectorWorkerLeaseMs),
  )
}

const getErrorText = (error: unknown) => {
  return error instanceof Error ? error.message : String(error)
}

const getReviewServingProjectorWorkerDatabase = (
  dependencies: ReviewServingProjectorWorkerDependencies,
  workloadContext: DuckdbWorkloadContext,
) => {
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
  }
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
  projector: WakeReviewServingProjectorServiceResult
}): ReviewServingProjectorWorkerCycleResult['status'] => {
  if (input.projector.status === 'failed' || input.chunk.status === 'failed') {
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

const shouldRunCleanup = (input: {cleanupIntervalMs: number; lastCleanupAtMs: number | null; nowMs: number}) => {
  return input.lastCleanupAtMs === null || input.nowMs - input.lastCleanupAtMs >= input.cleanupIntervalMs
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
  const chunkInput = await service?.getNextChunk()

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
    return {chunkId: 'completed-manifest', status: 'skipped'}
  }

  if (claimedChunk === null) {
    return {chunkId: null, status: 'idle'}
  }

  try {
    await service.runClaimedChunk({chunk: claimedChunk, leaseOwner: workerId, workloadContext})

    return {chunkId: claimedChunk.chunkId, status: 'completed'}
  } catch (error) {
    await service.failChunk({chunkId: claimedChunk.chunkId, error: getErrorText(error), leaseOwner: workerId}, database)

    return {chunkId: claimedChunk.chunkId, status: 'failed'}
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

  const cleanupTargets = await dependencies.getCleanupTargets?.()
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
  const projector = await dependencies.wakeProjectors(getWakeInput(options, wakeId), {
    ...(dependencies.projectorServiceDependencies ?? {runners: getDefaultReviewServingProjectorRunners(database)}),
    database,
    nowMs: () => {
      return getWorkerNowMs(dependencies, options)
    },
  })
  const cleanup = await runReviewServingProjectorWorkerCleanup({database, dependencies, options})
  const nextCleanupAtMs =
    cleanup.status === 'completed' ? getWorkerNowMs(dependencies, options) : (options.lastCleanupAtMs ?? null)

  return {
    chunk,
    cleanup,
    nextCleanupAtMs,
    projector,
    status: getCycleStatus({chunk, cleanup, projector}),
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
  const cycleResult = await runReviewServingProjectorWorkerOnce(options, dependencies)

  if (options.signal?.aborted) {
    return
  }

  const delayMs =
    cycleResult.status === 'failed'
      ? (options.errorBackoffMs ?? defaultReviewServingProjectorWorkerErrorBackoffMs)
      : cycleResult.status === 'idle'
        ? (options.pollIntervalMs ?? defaultReviewServingProjectorWorkerPollIntervalMs)
        : 0
  const nextOptions = {...options, lastCleanupAtMs: cycleResult.nextCleanupAtMs}

  return delayMs > 0
    ? dependencies.sleep(delayMs).then(() => {
        return runReviewServingProjectorWorker(nextOptions, dependencies)
      })
    : runReviewServingProjectorWorker(nextOptions, dependencies)
}

export {
  defaultReviewServingProjectorWorkerBatchSize,
  defaultReviewServingProjectorWorkerCleanupIntervalMs,
  defaultReviewServingProjectorWorkerErrorBackoffMs,
  defaultReviewServingProjectorWorkerLeaseMs,
  defaultReviewServingProjectorWorkerMaxRetries,
  defaultReviewServingProjectorWorkerMaxRowsPerWake,
  defaultReviewServingProjectorWorkerMaxWakeMs,
  defaultReviewServingProjectorWorkerPollIntervalMs,
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
