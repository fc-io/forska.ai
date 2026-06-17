import {readFileSync} from 'node:fs'
import {join} from 'node:path'

import {expect, mock, test} from 'bun:test'

import type {ReviewServingRebuildChunkManifest} from '../reviewServing/reviewServingChunkManifestRepository.ts'
import type {DuckdbWorkloadContext} from '../utils/duckdbService.ts'
import {
  defaultReviewServingProjectorWorkerErrorBackoffMs,
  getReviewServingProjectorWorkerWorkloadContext,
  type ReviewServingProjectorWorkerDependencies,
  runReviewServingProjectorWorker,
  runReviewServingProjectorWorkerOnce,
} from './reviewServingProjectorWorker.ts'

type TestDatabase = {
  queryJson: <T>(statement: string, workloadContext?: DuckdbWorkloadContext) => Promise<T[]>
  run: (statement: string, workloadContext?: DuckdbWorkloadContext) => Promise<void>
  transaction: <T>(
    operation: (tx: {
      queryJson: <T>(statement: string) => Promise<T[]>
      run: (statement: string) => Promise<void>
    }) => Promise<T>,
    workloadContext?: DuckdbWorkloadContext,
  ) => Promise<T>
}

const chunkInput = {
  chunkEndKey: 'article-099',
  chunkStartKey: 'article-001',
  inputDigest: 'digest-1',
  inputWatermark: 42,
  outputBaseGeneration: 2,
  projectId: 'project-1',
  projectionComponent: 'display' as const,
  projectionIdentity: 'display:project-1',
}

const chunkManifest = {
  ...chunkInput,
  checksum: null,
  chunkId: 'chunk-1',
  completedAt: null,
  createdAt: '2026-06-16T10:00:00.000Z',
  lastError: null,
  leaseExpiresAt: '2026-06-16T10:00:30.000Z',
  leaseOwner: 'worker-1',
  startedAt: '2026-06-16T10:00:00.000Z',
  status: 'running',
  updatedAt: '2026-06-16T10:00:00.000Z',
} satisfies ReviewServingRebuildChunkManifest

const createWorkerHarness = (input?: {
  chunkComplete?: boolean
  cleanupTargets?: Array<{projectId: string; reviewConfigHash?: string | null}>
  nowMs?: number
  runChunkThrows?: boolean
  wakeStatus?: 'blocked' | 'completed' | 'failed' | 'partial'
}) => {
  const workloadContexts: DuckdbWorkloadContext[] = []
  const database: TestDatabase = {
    queryJson: async <T>(_statement: string, workloadContext?: DuckdbWorkloadContext) => {
      if (workloadContext) {
        workloadContexts.push(workloadContext)
      }

      return [] as T[]
    },
    run: async (_statement: string, workloadContext?: DuckdbWorkloadContext) => {
      if (workloadContext) {
        workloadContexts.push(workloadContext)
      }
    },
    transaction: async <T>(
      operation: (tx: {
        queryJson: <T>(statement: string) => Promise<T[]>
        run: (statement: string) => Promise<void>
      }) => Promise<T>,
      workloadContext?: DuckdbWorkloadContext,
    ) => {
      if (workloadContext) {
        workloadContexts.push(workloadContext)
      }

      return operation(database)
    },
  }
  const wakeInputs: unknown[] = []
  const claimInputs: unknown[] = []
  const cleanupInputs: unknown[] = []
  const failedChunks: unknown[] = []
  const runChunkInputs: ReviewServingRebuildChunkManifest[] = []
  const wakeStatus = input?.wakeStatus ?? 'blocked'
  const dependencies = {
    cleanupRetentionState: async (cleanupInput: {projectId: string; reviewConfigHash?: string | null}) => {
      cleanupInputs.push(cleanupInput)

      return {retentionScope: cleanupInput.projectId}
    },
    getCleanupTargets: async () => {
      return input?.cleanupTargets ?? []
    },
    getDatabase: () => {
      return database
    },
    nowMs: () => {
      return input?.nowMs ?? 1_000
    },
    rebuildChunkService: {
      claimChunk: async (claimInput) => {
        claimInputs.push(claimInput)

        return chunkManifest
      },
      failChunk: async (failure) => {
        failedChunks.push(failure)

        return {...chunkManifest, status: 'failed' as const}
      },
      getNextChunk: async () => {
        return chunkInput
      },
      isChunkComplete: async () => {
        return input?.chunkComplete ?? false
      },
      runClaimedChunk: async ({chunk}: {chunk: ReviewServingRebuildChunkManifest}) => {
        runChunkInputs.push(chunk)

        if (input?.runChunkThrows) {
          throw new Error('chunk executor failed')
        }

        return {status: 'completed' as const}
      },
    },
    sleep: async () => {},
    wakeProjectors: async (wakeInput, serviceDependencies) => {
      wakeInputs.push(wakeInput)
      await serviceDependencies.database?.run('SELECT 1')

      return {failures: [], promotions: [], releasedClaimIds: [], runs: [], status: wakeStatus}
    },
  } satisfies ReviewServingProjectorWorkerDependencies

  return {
    claimInputs,
    cleanupInputs,
    database,
    dependencies,
    failedChunks,
    runChunkInputs,
    wakeInputs,
    workloadContexts,
  }
}

test('worker calls projector orchestration with bounded wake budgets and reviewProjector workload context', async () => {
  const harness = createWorkerHarness({wakeStatus: 'completed'})

  const result = await runReviewServingProjectorWorkerOnce(
    {
      batchSize: 3,
      leaseMs: 2_000,
      maxRetries: 2,
      maxRowsPerWake: 5,
      maxWakeMs: 250,
      now: new Date('2026-06-16T10:00:00.000Z'),
      workerId: 'worker-1',
    },
    harness.dependencies,
  )

  expect(result.status).toBe('completed')
  expect(harness.wakeInputs[0]).toMatchObject({batchSize: 3, maxRetries: 2, maxRowsPerWake: 5, maxWakeMs: 250})
  expect(harness.claimInputs[0]).toMatchObject({leaseOwner: 'worker-1', now: new Date('2026-06-16T10:00:00.000Z')})
  expect(harness.workloadContexts).toContainEqual(getReviewServingProjectorWorkerWorkloadContext('worker-1'))
})

test('worker skips completed rebuild chunks whose maintained input digest still matches', async () => {
  const harness = createWorkerHarness({chunkComplete: true})

  const result = await runReviewServingProjectorWorkerOnce({workerId: 'worker-1'}, harness.dependencies)

  expect(result.chunk.status).toBe('skipped')
  expect(harness.claimInputs).toEqual([])
  expect(harness.runChunkInputs).toEqual([])
})

test('worker retries claimable failed or expired chunk leases and records executor failures', async () => {
  const harness = createWorkerHarness({runChunkThrows: true})

  const result = await runReviewServingProjectorWorkerOnce({leaseMs: 5_000, workerId: 'worker-2'}, harness.dependencies)

  expect(result.status).toBe('failed')
  expect(harness.claimInputs[0]).toMatchObject({leaseOwner: 'worker-2'})
  expect(harness.failedChunks).toEqual([{chunkId: 'chunk-1', error: 'chunk executor failed', leaseOwner: 'worker-2'}])
})

test('worker schedules cleanup only after its cleanup interval elapses', async () => {
  const skippedHarness = createWorkerHarness({cleanupTargets: [{projectId: 'project-1'}], nowMs: 1_000})
  const completedHarness = createWorkerHarness({cleanupTargets: [{projectId: 'project-1'}], nowMs: 62_000})

  const skipped = await runReviewServingProjectorWorkerOnce(
    {cleanupIntervalMs: 60_000, lastCleanupAtMs: 10_000, workerId: 'worker-1'},
    skippedHarness.dependencies,
  )
  const completed = await runReviewServingProjectorWorkerOnce(
    {cleanupIntervalMs: 60_000, lastCleanupAtMs: 1_000, workerId: 'worker-1'},
    completedHarness.dependencies,
  )

  expect(skipped.cleanup.status).toBe('skipped')
  expect(skippedHarness.cleanupInputs).toEqual([])
  expect(completed.cleanup).toEqual({retentionScopes: ['project-1'], status: 'completed'})
  expect(completed.nextCleanupAtMs).toBe(62_000)
})

test('worker backs off failed wakes and stops cleanly when aborted during sleep', async () => {
  const harness = createWorkerHarness({runChunkThrows: true})
  const controller = new AbortController()
  const sleepCalls: number[] = []

  harness.dependencies.sleep = mock(async (delayMs: number) => {
    sleepCalls.push(delayMs)
    controller.abort()
  })

  await runReviewServingProjectorWorker({signal: controller.signal, workerId: 'worker-1'}, harness.dependencies)

  expect(sleepCalls).toEqual([defaultReviewServingProjectorWorkerErrorBackoffMs])
})

test('worker source does not start product route migration or V4 route cutover', () => {
  const source = readFileSync(join(import.meta.dir, 'reviewServingProjectorWorker.ts'), 'utf8')

  expect(source).not.toContain('../routes/')
  expect(source).not.toContain('projectsRoutes')
  expect(source).not.toContain('legacy')
})

test('worker default dependencies wire real projector runners instead of an empty runner map', () => {
  const source = readFileSync(join(import.meta.dir, 'reviewServingProjectorWorker.ts'), 'utf8')

  expect(source).not.toContain('runners: {}}')
  expect(source).toContain('getDefaultReviewServingProjectorRunners(database)')
  expect(source).toContain('projectReviewServingLlmStatusPatches')
  expect(source).toContain('projectReviewServingHumanStatusPatches')
  expect(source).toContain('projectReviewServingSelectedImportPatches')
  expect(source).toContain('projectReviewServingQueuePatches')
  expect(source).toContain('projectReviewServingFilterPostings')
  expect(source).toContain('projectReviewServingSummaries')
  expect(source).toContain('projectReviewServingPayloadRows')
  expect(source).toContain('projectReviewServingJudgmentPayloadRows')
  expect(source).toContain('projectReviewServingDisplayPatches')
  expect(source).toContain('projectReviewServingTitleSearchRows')
  expect(source).toContain("component: 'judgmentInputContent'")
})
