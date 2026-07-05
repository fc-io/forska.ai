import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'

import {expect, mock, test} from 'bun:test'

import {buildReviewConfigHash} from '../reviewServing/reviewProjectionIdentity.ts'
import type {ReviewServingRebuildChunkManifest} from '../reviewServing/reviewServingChunkManifestRepository.ts'
import type {ReviewServingDirtyWorkClaim} from '../reviewServing/reviewServingDirtyWorkService.ts'
import type {DuckdbWorkloadContext} from '../utils/duckdbService.ts'
import {
  defaultReviewServingProjectorWorkerErrorBackoffMs,
  defaultReviewServingProjectorWorkerProgressYieldMs,
  getDefaultReviewServingProjectorRunners,
  getReviewServingProjectorWorkerWorkloadContext,
  nativeHeavyReviewServingProjectorWorkerProgressYieldMs,
  type ReviewServingProjectorWorkerDependencies,
  runReviewServingProjectorWorker,
  runReviewServingProjectorWorkerClaimedRebuildChunk,
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

type DeltaIntakeParams = Parameters<
  NonNullable<ReviewServingProjectorWorkerDependencies['intakeReviewChangeDeltas']>
>[0]

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
  requestId: null,
  startedAt: '2026-06-16T10:00:00.000Z',
  status: 'running',
  updatedAt: '2026-06-16T10:00:00.000Z',
} satisfies ReviewServingRebuildChunkManifest

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

  return `requestless-summary:${digest}`
}

const createWorkerHarness = (input?: {
  chunkComplete?: boolean
  cleanupTargets?: Array<{batchSize: number; now: Date | string; projectId: string; reviewConfigHash?: string | null}>
  nowMs?: number
  runChunkThrows?: boolean
  wakeStatus?: 'blocked' | 'completed' | 'failed' | 'partial'
}) => {
  const workloadContexts: DuckdbWorkloadContext[] = []
  const runStatements: string[] = []
  const database: TestDatabase = {
    queryJson: async <T>(_statement: string, workloadContext?: DuckdbWorkloadContext) => {
      if (workloadContext) {
        workloadContexts.push(workloadContext)
      }

      return [] as T[]
    },
    run: async (_statement: string, workloadContext?: DuckdbWorkloadContext) => {
      runStatements.push(_statement)

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
  const garbageCollectedChunks: ReviewServingRebuildChunkManifest[] = []
  const getNextChunkInputs: unknown[] = []
  const heartbeatInputs: unknown[] = []
  const recycledChunks: ReviewServingRebuildChunkManifest[] = []
  const runChunkInputs: ReviewServingRebuildChunkManifest[] = []
  const wakeStatus = input?.wakeStatus ?? 'blocked'
  const dependencies: ReviewServingProjectorWorkerDependencies = {
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
      getNextChunk: async (getNextInput) => {
        getNextChunkInputs.push(getNextInput)

        return chunkInput
      },
      heartbeatChunk: async (heartbeatInput) => {
        heartbeatInputs.push(heartbeatInput)

        return {...chunkManifest, leaseExpiresAt: new Date().toISOString()}
      },
      isChunkComplete: async () => {
        return input?.chunkComplete ?? false
      },
      runClaimedChunk: async ({chunk}) => {
        runChunkInputs.push(chunk)

        if (input?.runChunkThrows) {
          throw new Error('chunk executor failed')
        }

        return {status: 'completed' as const}
      },
    },
    collectGarbageAfterCompletedRebuildChunk: (chunk) => {
      garbageCollectedChunks.push(chunk)
    },
    recycleDuckdbAfterCompletedRebuildChunk: async (chunk) => {
      recycledChunks.push(chunk)
    },
    sleep: async (_delayMs: number) => {},
    wakeProjectors: async (wakeInput, serviceDependencies) => {
      wakeInputs.push(wakeInput)
      await serviceDependencies.database?.run('SELECT 1')

      return {failures: [], promotions: [], releasedClaimIds: [], runs: [], status: wakeStatus}
    },
  }

  return {
    claimInputs,
    cleanupInputs,
    database,
    dependencies,
    failedChunks,
    garbageCollectedChunks,
    getNextChunkInputs,
    heartbeatInputs,
    recycledChunks,
    runChunkInputs,
    runStatements,
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
      rebuildProjectId: 'project-1',
      workerId: 'worker-1',
    },
    harness.dependencies,
  )

  expect(result.status).toBe('completed')
  expect(harness.wakeInputs[0]).toMatchObject({batchSize: 3, maxRetries: 2, maxRowsPerWake: 5, maxWakeMs: 250})
  expect(harness.getNextChunkInputs[0]).toMatchObject({projectId: 'project-1'})
  expect(harness.claimInputs[0]).toMatchObject({leaseOwner: 'worker-1', now: new Date('2026-06-16T10:00:00.000Z')})
  expect(harness.workloadContexts).toContainEqual(getReviewServingProjectorWorkerWorkloadContext('worker-1'))
})

test('worker can drain multiple rebuild chunks in one opt-in batch', async () => {
  const harness = createWorkerHarness({wakeStatus: 'completed'})
  const firstChunkInput = {
    ...chunkInput,
    chunkEndKey: 'article-050',
    chunkStartKey: 'article-001',
    projectionComponent: 'projectScope' as const,
    projectionIdentity: 'projectScope:project-1',
  }
  const secondChunkInput = {...firstChunkInput, chunkEndKey: 'article-099', chunkStartKey: 'article-051'}
  const firstChunk = {...chunkManifest, ...firstChunkInput, chunkId: 'chunk-batch-1'}
  const secondChunk = {...chunkManifest, ...secondChunkInput, chunkId: 'chunk-batch-2'}
  const chunkInputs = [firstChunkInput, secondChunkInput]
  const chunksByStartKey = new Map<string, ReviewServingRebuildChunkManifest>([
    [firstChunkInput.chunkStartKey, firstChunk],
    [secondChunkInput.chunkStartKey, secondChunk],
  ])
  const chunksById = new Map([
    [firstChunk.chunkId, firstChunk],
    [secondChunk.chunkId, secondChunk],
  ])
  const claimCountsAtRun: number[] = []
  let nextIndex = 0

  harness.dependencies.rebuildChunkService = {
    ...harness.dependencies.rebuildChunkService,
    claimChunk: async (claimInput) => {
      harness.claimInputs.push(claimInput)

      return chunksByStartKey.get(claimInput.chunkStartKey) ?? null
    },
    getNextChunk: async (getNextInput) => {
      harness.getNextChunkInputs.push(getNextInput)

      return chunkInputs[nextIndex++] ?? null
    },
    heartbeatChunk: async (heartbeatInput) => {
      harness.heartbeatInputs.push(heartbeatInput)

      return chunksById.get(heartbeatInput.chunkId) ?? null
    },
    runClaimedChunk: async ({chunk}) => {
      claimCountsAtRun.push(harness.claimInputs.length)
      harness.runChunkInputs.push(chunk)

      return {status: 'completed' as const}
    },
  } as ReviewServingProjectorWorkerDependencies['rebuildChunkService']

  const result = await runReviewServingProjectorWorkerOnce(
    {rebuildChunkBatchSize: 2, workerId: 'worker-1'},
    harness.dependencies,
  )

  expect(result.chunk).toMatchObject({chunkId: 'chunk-batch-2', status: 'completed'})
  expect(result.chunkBatchCount).toBe(2)
  expect(harness.claimInputs).toHaveLength(2)
  expect(
    harness.runChunkInputs.map((chunk) => {
      return chunk.chunkId
    }),
  ).toEqual(['chunk-batch-1', 'chunk-batch-2'])
  expect(claimCountsAtRun).toEqual([2, 2])
  expect(harness.wakeInputs).toHaveLength(1)
})

test('worker does not preclaim incompatible rebuild chunks in one batch', async () => {
  const harness = createWorkerHarness({wakeStatus: 'completed'})
  const firstChunkInput = {...chunkInput, chunkEndKey: 'article-050', chunkStartKey: 'article-001'}
  const secondChunkInput = {
    ...chunkInput,
    chunkEndKey: 'article-099',
    chunkStartKey: 'article-051',
    projectionComponent: 'payload' as const,
    projectionIdentity: 'payload:project-1',
  }
  const firstChunk = {...chunkManifest, ...firstChunkInput, chunkId: 'chunk-batch-1'}
  const secondChunk = {...chunkManifest, ...secondChunkInput, chunkId: 'chunk-batch-2'}
  const chunkInputs = [firstChunkInput, secondChunkInput]
  const chunksByStartKey = new Map<string, ReviewServingRebuildChunkManifest>([
    [firstChunkInput.chunkStartKey, firstChunk],
    [secondChunkInput.chunkStartKey, secondChunk],
  ])
  let nextIndex = 0

  harness.dependencies.rebuildChunkService = {
    ...harness.dependencies.rebuildChunkService,
    claimChunk: async (claimInput) => {
      harness.claimInputs.push(claimInput)

      return chunksByStartKey.get(claimInput.chunkStartKey) ?? null
    },
    getNextChunk: async (getNextInput) => {
      harness.getNextChunkInputs.push(getNextInput)

      return chunkInputs[nextIndex++] ?? null
    },
  } as ReviewServingProjectorWorkerDependencies['rebuildChunkService']

  const result = await runReviewServingProjectorWorkerOnce(
    {rebuildChunkBatchSize: 2, workerId: 'worker-1'},
    harness.dependencies,
  )

  expect(result.chunk).toMatchObject({chunkId: 'chunk-batch-1', status: 'completed'})
  expect(result.chunkBatchCount).toBe(1)
  expect(harness.getNextChunkInputs).toHaveLength(2)
  expect(harness.claimInputs).toHaveLength(1)
  expect(harness.runChunkInputs).toEqual([firstChunk])
})

test('worker excludes requestless summary chunks from component batch preclaiming', async () => {
  const harness = createWorkerHarness({wakeStatus: 'completed'})
  const statements: string[] = []
  const firstChunkInput = {
    ...chunkInput,
    chunkEndKey: 'article-050',
    chunkStartKey: 'article-001',
    outputBaseGeneration: 7,
    projectionComponent: 'summary' as const,
    projectionIdentity: 'summary:project-1',
    requestId: null,
  }
  const secondChunkInput = {...firstChunkInput, chunkEndKey: 'article-099', chunkStartKey: 'article-051'}
  const firstChunk = {...chunkManifest, ...firstChunkInput, chunkId: 'chunk-summary-batch-1', requestId: null}
  const secondChunk = {...chunkManifest, ...secondChunkInput, chunkId: 'chunk-summary-batch-2', requestId: null}
  const requestId = getRequestlessSummaryRangeRebuildRequestId(firstChunk)
  const adoptedFirstChunk = {...firstChunk, requestId}
  const chunkInputs = [firstChunkInput, secondChunkInput]
  const chunksByStartKey = new Map([
    [firstChunkInput.chunkStartKey, firstChunk],
    [secondChunkInput.chunkStartKey, secondChunk],
  ])
  let adopted = false
  let nextIndex = 0

  harness.database.queryJson = async <T>(statement: string) => {
    statements.push(statement)

    if (statement.includes('pendingChunkCount')) {
      return [{pendingChunkCount: 1}] as T[]
    }

    if (statement.includes('FROM app.review_rebuild_chunk_manifest')) {
      return [adopted ? adoptedFirstChunk : firstChunk] as T[]
    }

    return [] as T[]
  }
  harness.database.run = async (statement: string) => {
    statements.push(statement)

    if (statement.includes('UPDATE app.review_rebuild_chunk_manifest') && statement.includes('request_id =')) {
      adopted = true
    }
  }
  harness.dependencies.rebuildChunkService = {
    ...harness.dependencies.rebuildChunkService,
    claimChunk: async (claimInput) => {
      harness.claimInputs.push(claimInput)

      return chunksByStartKey.get(claimInput.chunkStartKey) ?? null
    },
    getNextChunk: async (getNextInput) => {
      harness.getNextChunkInputs.push(getNextInput)

      return chunkInputs[nextIndex++] ?? null
    },
  } as ReviewServingProjectorWorkerDependencies['rebuildChunkService']

  const result = await runReviewServingProjectorWorkerOnce(
    {rebuildChunkBatchSize: 2, workerId: 'worker-1'},
    harness.dependencies,
  )

  expect(result.chunk).toMatchObject({chunkId: firstChunk.chunkId, requestId, status: 'completed'})
  expect(result.chunkBatchCount).toBe(1)
  expect(harness.getNextChunkInputs).toHaveLength(2)
  expect(harness.claimInputs).toHaveLength(1)
  expect(harness.runChunkInputs).toHaveLength(1)
  expect(harness.runChunkInputs[0]).toMatchObject(adoptedFirstChunk)
})

test('worker writes compatible fresh project scope rebuild chunks through one batch writer', async () => {
  const harness = createWorkerHarness({wakeStatus: 'completed'})
  const statements: string[] = []
  const firstChunkInput = {
    ...chunkInput,
    chunkEndKey: 'article-050',
    chunkStartKey: 'article-001',
    inputDigest: 'freshReviewServingSnapshot',
    projectionComponent: 'projectScope' as const,
    projectionIdentity: 'projectScope:project-1',
  }
  const secondChunkInput = {...firstChunkInput, chunkEndKey: 'article-099', chunkStartKey: 'article-051'}
  const firstChunk = {
    ...chunkManifest,
    ...firstChunkInput,
    chunkId: 'chunk-project-scope-batch-1',
    parentChunkId: 'chunk-project-scope-parent',
    splitDepth: 1,
  }
  const secondChunk = {
    ...chunkManifest,
    ...secondChunkInput,
    chunkId: 'chunk-project-scope-batch-2',
    parentChunkId: 'chunk-project-scope-parent',
    splitDepth: 1,
  }
  const chunkInputs = [firstChunkInput, secondChunkInput]
  const chunksByStartKey = new Map<string, ReviewServingRebuildChunkManifest>([
    [firstChunkInput.chunkStartKey, firstChunk],
    [secondChunkInput.chunkStartKey, secondChunk],
  ])
  const chunksById = new Map<string, ReviewServingRebuildChunkManifest>([
    [firstChunk.chunkId, firstChunk],
    [secondChunk.chunkId, secondChunk],
  ])
  let nextIndex = 0

  harness.database.queryJson = async <T>(statement: string) => {
    statements.push(statement)

    if (statement.includes('FROM app.review_rebuild_chunk_manifest')) {
      const chunkId = [...chunksById.keys()].find((id) => {
        return statement.includes(id)
      })

      return [chunksById.get(chunkId ?? firstChunk.chunkId) ?? firstChunk] as T[]
    }

    if (statement.includes('FROM mart.project_scope_article scope')) {
      return [{actualChecksum: 'checksum-project-scope-batch', actualCount: 1}] as T[]
    }

    return [] as T[]
  }
  harness.database.run = async (statement: string) => {
    statements.push(statement)
  }
  harness.dependencies.rebuildChunkService = {
    ...harness.dependencies.rebuildChunkService,
    claimChunk: async (claimInput) => {
      harness.claimInputs.push(claimInput)

      return chunksByStartKey.get(claimInput.chunkStartKey) ?? null
    },
    getNextChunk: async (getNextInput) => {
      harness.getNextChunkInputs.push(getNextInput)

      return chunkInputs[nextIndex++] ?? null
    },
    heartbeatChunk: async (heartbeatInput) => {
      harness.heartbeatInputs.push(heartbeatInput)

      return chunksById.get(heartbeatInput.chunkId) ?? null
    },
    runClaimedChunk: async ({chunk}) => {
      harness.runChunkInputs.push(chunk)

      return {status: 'completed' as const}
    },
  } as ReviewServingProjectorWorkerDependencies['rebuildChunkService']

  const result = await runReviewServingProjectorWorkerOnce(
    {rebuildChunkBatchSize: 2, workerId: 'worker-1'},
    harness.dependencies,
  )
  const joined = statements.join('\n')

  expect(result.chunk).toMatchObject({chunkId: secondChunk.chunkId, status: 'completed'})
  expect(result.chunkBatchCount).toBe(2)
  expect(harness.claimInputs).toHaveLength(2)
  expect(harness.runChunkInputs).toEqual([])
  expect(joined).toContain("aggregated_scope.article_id >= 'article-001'")
  expect(joined).toContain("aggregated_scope.article_id <= 'article-050'")
  expect(joined).toContain("aggregated_scope.article_id >= 'article-051'")
  expect(joined).toContain("aggregated_scope.article_id <= 'article-099'")
  expect(joined).toContain('INSERT INTO mart.project_scope_article')
  expect(joined).toContain('projectScopeBatchWriter')
})

test('worker writes compatible selected import rebuild chunks through one batch writer', async () => {
  const harness = createWorkerHarness({wakeStatus: 'completed'})
  const statements: string[] = []
  const firstChunkInput = {
    ...chunkInput,
    chunkEndKey: 'article-050',
    chunkStartKey: 'article-001',
    projectionComponent: 'selectedImport' as const,
    projectionIdentity: 'selectedImport:project-1',
  }
  const secondChunkInput = {...firstChunkInput, chunkEndKey: 'article-099', chunkStartKey: 'article-051'}
  const firstChunk = {
    ...chunkManifest,
    ...firstChunkInput,
    chunkId: 'chunk-selected-import-batch-1',
    parentChunkId: 'chunk-selected-import-parent',
    splitDepth: 1,
  }
  const secondChunk = {
    ...chunkManifest,
    ...secondChunkInput,
    chunkId: 'chunk-selected-import-batch-2',
    parentChunkId: 'chunk-selected-import-parent',
    splitDepth: 1,
  }
  const chunkInputs = [firstChunkInput, secondChunkInput]
  const chunksByStartKey = new Map<string, ReviewServingRebuildChunkManifest>([
    [firstChunkInput.chunkStartKey, firstChunk],
    [secondChunkInput.chunkStartKey, secondChunk],
  ])
  const chunksById = new Map<string, ReviewServingRebuildChunkManifest>([
    [firstChunk.chunkId, firstChunk],
    [secondChunk.chunkId, secondChunk],
  ])
  const componentState = {
    optional: [],
    required: [
      {
        baseGeneration: '7',
        component: 'projectScope',
        patchWatermark: '9',
        projectionIdentity: 'projectScope:project-1',
      },
      {
        baseGeneration: '2',
        component: 'selectedImport',
        patchWatermark: '9',
        projectionIdentity: 'selectedImport:project-1',
      },
    ],
  }
  let nextIndex = 0

  harness.database.queryJson = async <T>(statement: string) => {
    statements.push(statement)

    if (statement.includes('FROM app.review_rebuild_chunk_manifest')) {
      const chunkId = [...chunksById.keys()].find((id) => {
        return statement.includes(id)
      })

      return [chunksById.get(chunkId ?? firstChunk.chunkId) ?? firstChunk] as T[]
    }

    if (statement.includes('FROM app.review_serving_snapshot_manifest')) {
      return [
        {
          componentStateJson: componentState,
          reviewConfigHash: 'review-config-1',
          selectedImportSnapshotId: 'selected-import-snapshot-1',
          snapshotId: 'snapshot-selected-import-batch-1',
        },
      ] as T[]
    }

    if (statement.includes('FROM app.review_selected_import_snapshot')) {
      return [{cursorJson: null, sourceDeltaHighWater: 9, status: 'completed'}] as T[]
    }

    if (statement.includes('WITH output_row')) {
      return [{actualChecksum: 'checksum-selected-import-batch', actualCount: 1}] as T[]
    }

    return [] as T[]
  }
  harness.database.run = async (statement: string) => {
    statements.push(statement)
  }
  harness.dependencies.rebuildChunkService = {
    ...harness.dependencies.rebuildChunkService,
    claimChunk: async (claimInput) => {
      harness.claimInputs.push(claimInput)

      return chunksByStartKey.get(claimInput.chunkStartKey) ?? null
    },
    getNextChunk: async (getNextInput) => {
      harness.getNextChunkInputs.push(getNextInput)

      return chunkInputs[nextIndex++] ?? null
    },
    heartbeatChunk: async (heartbeatInput) => {
      harness.heartbeatInputs.push(heartbeatInput)

      return chunksById.get(heartbeatInput.chunkId) ?? null
    },
    runClaimedChunk: async ({chunk}) => {
      harness.runChunkInputs.push(chunk)

      return {status: 'completed' as const}
    },
  } as ReviewServingProjectorWorkerDependencies['rebuildChunkService']

  const result = await runReviewServingProjectorWorkerOnce(
    {rebuildChunkBatchSize: 2, workerId: 'worker-1'},
    harness.dependencies,
  )
  const joined = statements.join('\n')

  expect(result.chunk).toMatchObject({chunkId: secondChunk.chunkId, status: 'completed'})
  expect(result.chunkBatchCount).toBe(2)
  expect(harness.claimInputs).toHaveLength(2)
  expect(
    new Set(
      harness.heartbeatInputs.map((input) => {
        return (input as {chunkId: string}).chunkId
      }),
    ),
  ).toEqual(new Set([firstChunk.chunkId, secondChunk.chunkId]))
  expect(harness.runChunkInputs).toEqual([])
  expect(joined).toContain("article_id >= 'article-001'")
  expect(joined).toContain("article_id <= 'article-050'")
  expect(joined).toContain("article_id >= 'article-051'")
  expect(joined).toContain("article_id <= 'article-099'")
  expect(joined).toContain('selectedImportBatchWriter')
})

test('worker writes compatible display rebuild chunks through one batch writer', async () => {
  const harness = createWorkerHarness({wakeStatus: 'completed'})
  const statements: string[] = []
  const firstChunkInput = {
    ...chunkInput,
    chunkEndKey: 'article-050',
    chunkStartKey: 'article-001',
    projectionComponent: 'display' as const,
    projectionIdentity: 'display:project-1',
  }
  const secondChunkInput = {...firstChunkInput, chunkEndKey: 'article-099', chunkStartKey: 'article-051'}
  const firstChunk = {
    ...chunkManifest,
    ...firstChunkInput,
    chunkId: 'chunk-display-batch-1',
    parentChunkId: 'chunk-display-parent',
    splitDepth: 1,
  }
  const secondChunk = {
    ...chunkManifest,
    ...secondChunkInput,
    chunkId: 'chunk-display-batch-2',
    parentChunkId: 'chunk-display-parent',
    splitDepth: 1,
  }
  const chunkInputs = [firstChunkInput, secondChunkInput]
  const chunksByStartKey = new Map<string, ReviewServingRebuildChunkManifest>([
    [firstChunkInput.chunkStartKey, firstChunk],
    [secondChunkInput.chunkStartKey, secondChunk],
  ])
  const chunksById = new Map<string, ReviewServingRebuildChunkManifest>([
    [firstChunk.chunkId, firstChunk],
    [secondChunk.chunkId, secondChunk],
  ])
  const componentState = {
    optional: [],
    required: [
      {baseGeneration: '2', component: 'projectScope', projectionIdentity: 'projectScope:project-1'},
      {baseGeneration: '2', component: 'selectedImport', projectionIdentity: 'selectedImport:project-1'},
      {baseGeneration: '2', component: 'display', projectionIdentity: 'display:project-1'},
      {baseGeneration: '2', component: 'llmStatus', projectionIdentity: 'llmStatus:project-1'},
      {baseGeneration: '2', component: 'humanStatus', projectionIdentity: 'humanStatus:project-1'},
      {baseGeneration: '2', component: 'payload', projectionIdentity: 'payload:project-1'},
      {baseGeneration: '2', component: 'posting', projectionIdentity: 'posting:project-1'},
      {baseGeneration: '2', component: 'summary', projectionIdentity: 'summary:project-1'},
    ],
  }
  let nextIndex = 0

  harness.database.queryJson = async <T>(statement: string) => {
    statements.push(statement)

    if (statement.includes('FROM app.review_rebuild_chunk_manifest')) {
      const chunkId = [...chunksById.keys()].find((id) => {
        return statement.includes(id)
      })

      return [chunksById.get(chunkId ?? firstChunk.chunkId) ?? firstChunk] as T[]
    }

    if (statement.includes('FROM app.review_serving_snapshot_manifest')) {
      return [
        {
          componentStateJson: componentState,
          reviewConfigHash: 'review-config-1',
          selectedImportSnapshotId: 'selected-import-snapshot-1',
          snapshotId: 'snapshot-display-batch-1',
        },
      ] as T[]
    }

    if (statement.includes('FROM mart.review_article_serving_v4 serving')) {
      return [{actualChecksum: 'checksum-display-batch', actualCount: 2}] as T[]
    }

    return [] as T[]
  }
  harness.database.run = async (statement: string) => {
    statements.push(statement)
  }
  harness.dependencies.rebuildChunkService = {
    ...harness.dependencies.rebuildChunkService,
    claimChunk: async (claimInput) => {
      harness.claimInputs.push(claimInput)

      return chunksByStartKey.get(claimInput.chunkStartKey) ?? null
    },
    getNextChunk: async (getNextInput) => {
      harness.getNextChunkInputs.push(getNextInput)

      return chunkInputs[nextIndex++] ?? null
    },
    heartbeatChunk: async (heartbeatInput) => {
      harness.heartbeatInputs.push(heartbeatInput)

      return chunksById.get(heartbeatInput.chunkId) ?? null
    },
    runClaimedChunk: async ({chunk}) => {
      harness.runChunkInputs.push(chunk)

      return {status: 'completed' as const}
    },
  } as ReviewServingProjectorWorkerDependencies['rebuildChunkService']

  const result = await runReviewServingProjectorWorkerOnce(
    {rebuildChunkBatchSize: 2, workerId: 'worker-1'},
    harness.dependencies,
  )
  const joined = statements.join('\n')

  expect(result.chunk).toMatchObject({chunkId: secondChunk.chunkId, status: 'completed'})
  expect(result.chunkBatchCount).toBe(2)
  expect(harness.claimInputs).toHaveLength(2)
  expect(harness.runChunkInputs).toEqual([])
  expect(joined).toContain("scope.article_id >= 'article-001'")
  expect(joined).toContain("scope.article_id <= 'article-050'")
  expect(joined).toContain("scope.article_id >= 'article-051'")
  expect(joined).toContain("scope.article_id <= 'article-099'")
  expect(joined).toContain('INSERT INTO mart.review_article_serving_v4')
  expect(joined).toContain('displayBatchWriter')
})

test('worker writes compatible payload rebuild chunks through one batch writer', async () => {
  const harness = createWorkerHarness({wakeStatus: 'completed'})
  const statements: string[] = []
  const firstChunkInput = {
    ...chunkInput,
    chunkEndKey: 'article-050',
    chunkStartKey: 'article-001',
    projectionComponent: 'payload' as const,
    projectionIdentity: 'payload:project-1',
  }
  const secondChunkInput = {...firstChunkInput, chunkEndKey: 'article-099', chunkStartKey: 'article-051'}
  const firstChunk = {
    ...chunkManifest,
    ...firstChunkInput,
    chunkId: 'chunk-payload-batch-1',
    parentChunkId: 'chunk-payload-parent',
    splitDepth: 1,
  }
  const secondChunk = {
    ...chunkManifest,
    ...secondChunkInput,
    chunkId: 'chunk-payload-batch-2',
    parentChunkId: 'chunk-payload-parent',
    splitDepth: 1,
  }
  const chunkInputs = [firstChunkInput, secondChunkInput]
  const chunksByStartKey = new Map<string, ReviewServingRebuildChunkManifest>([
    [firstChunkInput.chunkStartKey, firstChunk],
    [secondChunkInput.chunkStartKey, secondChunk],
  ])
  const chunksById = new Map<string, ReviewServingRebuildChunkManifest>([
    [firstChunk.chunkId, firstChunk],
    [secondChunk.chunkId, secondChunk],
  ])
  const componentState = {
    optional: [],
    required: [
      {baseGeneration: '2', component: 'projectScope', projectionIdentity: 'projectScope:project-1'},
      {baseGeneration: '2', component: 'selectedImport', projectionIdentity: 'selectedImport:project-1'},
      {baseGeneration: '2', component: 'display', projectionIdentity: 'display:project-1'},
      {baseGeneration: '2', component: 'payload', projectionIdentity: 'payload:project-1'},
    ],
  }
  let nextIndex = 0

  harness.database.queryJson = async <T>(statement: string) => {
    statements.push(statement)

    if (statement.includes('FROM app.review_rebuild_chunk_manifest')) {
      const chunkId = [...chunksById.keys()].find((id) => {
        return statement.includes(id)
      })

      return [chunksById.get(chunkId ?? firstChunk.chunkId) ?? firstChunk] as T[]
    }

    if (statement.includes('FROM app.review_serving_snapshot_manifest')) {
      return [
        {
          componentStateJson: componentState,
          reviewConfigHash: 'review-config-1',
          selectedImportSnapshotId: 'selected-import-snapshot-1',
          snapshotId: 'snapshot-payload-batch-1',
        },
      ] as T[]
    }

    if (statement.includes('FROM mart.review_article_serving_payload_v4 payload')) {
      return [{actualChecksum: 'checksum-payload-batch', actualCount: 2, actualPayloadBytes: 12}] as T[]
    }

    return [] as T[]
  }
  harness.database.run = async (statement: string) => {
    statements.push(statement)
  }
  harness.dependencies.rebuildChunkService = {
    ...harness.dependencies.rebuildChunkService,
    claimChunk: async (claimInput) => {
      harness.claimInputs.push(claimInput)

      return chunksByStartKey.get(claimInput.chunkStartKey) ?? null
    },
    getNextChunk: async (getNextInput) => {
      harness.getNextChunkInputs.push(getNextInput)

      return chunkInputs[nextIndex++] ?? null
    },
    heartbeatChunk: async (heartbeatInput) => {
      harness.heartbeatInputs.push(heartbeatInput)

      return chunksById.get(heartbeatInput.chunkId) ?? null
    },
    runClaimedChunk: async ({chunk}) => {
      harness.runChunkInputs.push(chunk)

      return {status: 'completed' as const}
    },
  } as ReviewServingProjectorWorkerDependencies['rebuildChunkService']

  const result = await runReviewServingProjectorWorkerOnce(
    {rebuildChunkBatchSize: 2, workerId: 'worker-1'},
    harness.dependencies,
  )
  const joined = statements.join('\n')

  expect(result.chunk).toMatchObject({chunkId: secondChunk.chunkId, status: 'completed'})
  expect(result.chunkBatchCount).toBe(2)
  expect(harness.claimInputs).toHaveLength(2)
  expect(harness.runChunkInputs).toEqual([])
  expect(joined).toContain("scope.article_id >= 'article-001'")
  expect(joined).toContain("scope.article_id <= 'article-050'")
  expect(joined).toContain("scope.article_id >= 'article-051'")
  expect(joined).toContain("scope.article_id <= 'article-099'")
  expect(joined).toContain('INSERT INTO mart.review_article_serving_payload_v4')
  expect(joined).toContain('payloadBatchWriter')
})

test('worker writes compatible search rebuild chunks through one batch writer', async () => {
  const harness = createWorkerHarness({wakeStatus: 'completed'})
  const statements: string[] = []
  const firstChunkInput = {
    ...chunkInput,
    chunkEndKey: 'article-050',
    chunkStartKey: 'article-001',
    projectionComponent: 'search' as const,
    projectionIdentity: 'search:project-1',
  }
  const secondChunkInput = {...firstChunkInput, chunkEndKey: 'article-099', chunkStartKey: 'article-051'}
  const firstChunk = {
    ...chunkManifest,
    ...firstChunkInput,
    chunkId: 'chunk-search-batch-1',
    parentChunkId: 'chunk-search-parent',
    splitDepth: 1,
  }
  const secondChunk = {
    ...chunkManifest,
    ...secondChunkInput,
    chunkId: 'chunk-search-batch-2',
    parentChunkId: 'chunk-search-parent',
    splitDepth: 1,
  }
  const chunkInputs = [firstChunkInput, secondChunkInput]
  const chunksByStartKey = new Map<string, ReviewServingRebuildChunkManifest>([
    [firstChunkInput.chunkStartKey, firstChunk],
    [secondChunkInput.chunkStartKey, secondChunk],
  ])
  const chunksById = new Map<string, ReviewServingRebuildChunkManifest>([
    [firstChunk.chunkId, firstChunk],
    [secondChunk.chunkId, secondChunk],
  ])
  const componentState = {
    optional: [{baseGeneration: '2', component: 'search', projectionIdentity: 'search:project-1'}],
    required: [
      {baseGeneration: '2', component: 'projectScope', projectionIdentity: 'projectScope:project-1'},
      {baseGeneration: '2', component: 'selectedImport', projectionIdentity: 'selectedImport:project-1'},
    ],
  }
  let nextIndex = 0

  harness.database.queryJson = async <T>(statement: string) => {
    statements.push(statement)

    if (statement.includes('FROM app.review_rebuild_chunk_manifest')) {
      const chunkId = [...chunksById.keys()].find((id) => {
        return statement.includes(id)
      })

      return [chunksById.get(chunkId ?? firstChunk.chunkId) ?? firstChunk] as T[]
    }

    if (statement.includes('FROM app.review_serving_snapshot_manifest')) {
      return [
        {
          componentStateJson: componentState,
          reviewConfigHash: 'review-config-1',
          selectedImportSnapshotId: 'selected-import-snapshot-1',
          snapshotId: 'snapshot-search-batch-1',
        },
      ] as T[]
    }

    if (statement.includes('FROM mart.review_title_search_serving_v4 search')) {
      return [{actualChecksum: 'checksum-search-batch', actualCount: 2}] as T[]
    }

    return [] as T[]
  }
  harness.database.run = async (statement: string) => {
    statements.push(statement)
  }
  harness.dependencies.rebuildChunkService = {
    ...harness.dependencies.rebuildChunkService,
    claimChunk: async (claimInput) => {
      harness.claimInputs.push(claimInput)

      return chunksByStartKey.get(claimInput.chunkStartKey) ?? null
    },
    getNextChunk: async (getNextInput) => {
      harness.getNextChunkInputs.push(getNextInput)

      return chunkInputs[nextIndex++] ?? null
    },
    heartbeatChunk: async (heartbeatInput) => {
      harness.heartbeatInputs.push(heartbeatInput)

      return chunksById.get(heartbeatInput.chunkId) ?? null
    },
    runClaimedChunk: async ({chunk}) => {
      harness.runChunkInputs.push(chunk)

      return {status: 'completed' as const}
    },
  } as ReviewServingProjectorWorkerDependencies['rebuildChunkService']

  const result = await runReviewServingProjectorWorkerOnce(
    {rebuildChunkBatchSize: 2, workerId: 'worker-1'},
    harness.dependencies,
  )
  const joined = statements.join('\n')

  expect(result.chunk).toMatchObject({chunkId: secondChunk.chunkId, status: 'completed'})
  expect(result.chunkBatchCount).toBe(2)
  expect(harness.claimInputs).toHaveLength(2)
  expect(harness.runChunkInputs).toEqual([])
  expect(joined).toContain("scope.article_id >= 'article-001'")
  expect(joined).toContain("scope.article_id <= 'article-050'")
  expect(joined).toContain("scope.article_id >= 'article-051'")
  expect(joined).toContain("scope.article_id <= 'article-099'")
  expect(joined).toContain('CROSS JOIN unnest(regexp_split_to_array')
  expect(joined).toContain('searchBatchWriter')
})

test('worker writes compatible queue rebuild chunks through one batch writer', async () => {
  const harness = createWorkerHarness({wakeStatus: 'completed'})
  const statements: string[] = []
  const firstChunkInput = {
    ...chunkInput,
    chunkEndKey: 'article-050',
    chunkStartKey: 'article-001',
    projectionComponent: 'queue' as const,
    projectionIdentity: 'queue:project-1',
  }
  const secondChunkInput = {...firstChunkInput, chunkEndKey: 'article-099', chunkStartKey: 'article-051'}
  const firstChunk = {
    ...chunkManifest,
    ...firstChunkInput,
    chunkId: 'chunk-queue-batch-1',
    parentChunkId: 'chunk-queue-parent',
    splitDepth: 1,
  }
  const secondChunk = {
    ...chunkManifest,
    ...secondChunkInput,
    chunkId: 'chunk-queue-batch-2',
    parentChunkId: 'chunk-queue-parent',
    splitDepth: 1,
  }
  const chunkInputs = [firstChunkInput, secondChunkInput]
  const chunksByStartKey = new Map<string, ReviewServingRebuildChunkManifest>([
    [firstChunkInput.chunkStartKey, firstChunk],
    [secondChunkInput.chunkStartKey, secondChunk],
  ])
  const chunksById = new Map<string, ReviewServingRebuildChunkManifest>([
    [firstChunk.chunkId, firstChunk],
    [secondChunk.chunkId, secondChunk],
  ])
  const componentState = {
    optional: [],
    required: [
      {baseGeneration: '2', component: 'projectScope', projectionIdentity: 'projectScope:project-1'},
      {baseGeneration: '2', component: 'selectedImport', projectionIdentity: 'selectedImport:project-1'},
      {baseGeneration: '2', component: 'queue', projectionIdentity: 'queue:project-1'},
    ],
  }
  let nextIndex = 0

  harness.database.queryJson = async <T>(statement: string) => {
    statements.push(statement)

    if (statement.includes('FROM app.review_rebuild_chunk_manifest')) {
      const chunkId = [...chunksById.keys()].find((id) => {
        return statement.includes(id)
      })

      return [chunksById.get(chunkId ?? firstChunk.chunkId) ?? firstChunk] as T[]
    }

    if (statement.includes('FROM app.review_serving_snapshot_manifest')) {
      return [
        {
          componentStateJson: componentState,
          reviewConfigHash: 'review-config-1',
          selectedImportSnapshotId: 'selected-import-snapshot-1',
          snapshotId: 'snapshot-queue-batch-1',
        },
      ] as T[]
    }

    if (statement.includes('FROM mart.review_unassessed_queue_serving_v4 serving')) {
      return [{actualChecksum: 'checksum-queue-batch', actualCount: 2}] as T[]
    }

    return [] as T[]
  }
  harness.database.run = async (statement: string) => {
    statements.push(statement)
  }
  harness.dependencies.rebuildChunkService = {
    ...harness.dependencies.rebuildChunkService,
    claimChunk: async (claimInput) => {
      harness.claimInputs.push(claimInput)

      return chunksByStartKey.get(claimInput.chunkStartKey) ?? null
    },
    getNextChunk: async (getNextInput) => {
      harness.getNextChunkInputs.push(getNextInput)

      return chunkInputs[nextIndex++] ?? null
    },
    heartbeatChunk: async (heartbeatInput) => {
      harness.heartbeatInputs.push(heartbeatInput)

      return chunksById.get(heartbeatInput.chunkId) ?? null
    },
    runClaimedChunk: async ({chunk}) => {
      harness.runChunkInputs.push(chunk)

      return {status: 'completed' as const}
    },
  } as ReviewServingProjectorWorkerDependencies['rebuildChunkService']

  const result = await runReviewServingProjectorWorkerOnce(
    {rebuildChunkBatchSize: 2, workerId: 'worker-1'},
    harness.dependencies,
  )
  const joined = statements.join('\n')

  expect(result.chunk).toMatchObject({chunkId: secondChunk.chunkId, status: 'completed'})
  expect(result.chunkBatchCount).toBe(2)
  expect(harness.claimInputs).toHaveLength(2)
  expect(harness.runChunkInputs).toEqual([])
  expect(joined).toContain("serving.article_id >= 'article-001'")
  expect(joined).toContain("serving.article_id <= 'article-050'")
  expect(joined).toContain("serving.article_id >= 'article-051'")
  expect(joined).toContain("serving.article_id <= 'article-099'")
  expect(joined).toContain('INSERT INTO mart.review_unassessed_queue_serving_v4')
  expect(joined).toContain('queueBatchWriter')
})

test('worker writes compatible judgment input content rebuild chunks through one batch writer', async () => {
  const harness = createWorkerHarness({wakeStatus: 'completed'})
  const statements: string[] = []
  const reviewConfigHash = buildReviewConfigHash({
    humanJudgmentMode: 'prompt',
    modelExecutionIdentity: {
      modelExecutionOptions: null,
      modelId: 'model-1',
      providerBaseUrl: null,
      providerConnectionId: null,
      providerKind: null,
      remoteModelId: null,
      variant: null,
    },
    modelId: 'model-1',
    promptConfigs: [],
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  })
  const firstChunkInput = {
    ...chunkInput,
    chunkEndKey: 'article-050',
    chunkStartKey: 'article-001',
    projectionComponent: 'judgmentInputContent' as const,
    projectionIdentity: 'judgmentInputContent:project-1',
  }
  const secondChunkInput = {...firstChunkInput, chunkEndKey: 'article-099', chunkStartKey: 'article-051'}
  const firstChunk = {
    ...chunkManifest,
    ...firstChunkInput,
    chunkId: 'chunk-judgment-input-content-batch-1',
    parentChunkId: 'chunk-judgment-input-content-parent',
    splitDepth: 1,
  }
  const secondChunk = {
    ...chunkManifest,
    ...secondChunkInput,
    chunkId: 'chunk-judgment-input-content-batch-2',
    parentChunkId: 'chunk-judgment-input-content-parent',
    splitDepth: 1,
  }
  const chunkInputs = [firstChunkInput, secondChunkInput]
  const chunksByStartKey = new Map<string, ReviewServingRebuildChunkManifest>([
    [firstChunkInput.chunkStartKey, firstChunk],
    [secondChunkInput.chunkStartKey, secondChunk],
  ])
  const chunksById = new Map<string, ReviewServingRebuildChunkManifest>([
    [firstChunk.chunkId, firstChunk],
    [secondChunk.chunkId, secondChunk],
  ])
  const componentState = {
    optional: [],
    required: [
      {baseGeneration: '7', component: 'projectScope', projectionIdentity: 'projectScope:project-1'},
      {baseGeneration: '2', component: 'judgmentInputContent', projectionIdentity: 'judgmentInputContent:project-1'},
    ],
  }
  let nextIndex = 0

  harness.database.queryJson = async <T>(statement: string) => {
    statements.push(statement)

    if (statement.includes('FROM app.review_rebuild_chunk_manifest')) {
      const chunkId = [...chunksById.keys()].find((id) => {
        return statement.includes(id)
      })

      return [chunksById.get(chunkId ?? firstChunk.chunkId) ?? firstChunk] as T[]
    }

    if (statement.includes('FROM app.review_projection_identity_manifest')) {
      return [
        {
          baseGeneration: 7,
          definitionVersion: 'judgmentInputContent:v1',
          inputDigest: firstChunk.inputDigest,
          inputWatermark: firstChunk.inputWatermark,
          inputWatermarksJson: {reviewChange: 9},
          invalidationReason: firstChunk.inputDigest,
          manifestId: 'manifest-judgment-input-content',
          patchRangeEnd: firstChunk.inputWatermark,
          patchRangeStart: firstChunk.inputWatermark,
          patchWatermark: firstChunk.inputWatermark,
          projectId: firstChunk.projectId,
          projectionComponent: firstChunk.projectionComponent,
          projectionIdentity: firstChunk.projectionIdentity,
          promptConfigHash: null,
          reviewConfigHash,
          status: 'candidate',
        },
      ] as T[]
    }

    if (statement.includes('FROM app.review_serving_snapshot_manifest')) {
      return [
        {
          componentStateJson: componentState,
          reviewConfigHash,
          selectedImportSnapshotId: 'selected-import-snapshot-1',
          snapshotId: 'snapshot-judgment-input-content-batch-1',
        },
      ] as T[]
    }

    if (statement.includes('FROM app.project project') && statement.includes('LIMIT 1')) {
      return [
        {
          humanJudgmentMode: 'prompt',
          modelExecutionOptions: null,
          modelId: 'model-1',
          modelProviderBaseUrl: null,
          modelProviderConnectionId: null,
          modelProviderKind: null,
          modelRemoteModelId: null,
          modelVariant: null,
          useAbstract: true,
          useFulltext: false,
          useFulltextNoImages: false,
          useTitle: true,
        },
      ] as T[]
    }

    if (statement.includes('FROM mart.review_article_judgment_detail_serving_v4 detail')) {
      return [{actualChecksum: 'checksum-judgment-input-content-batch', actualCount: 1}] as T[]
    }

    return [] as T[]
  }
  harness.database.run = async (statement: string) => {
    statements.push(statement)
  }
  harness.dependencies.rebuildChunkService = {
    ...harness.dependencies.rebuildChunkService,
    claimChunk: async (claimInput) => {
      harness.claimInputs.push(claimInput)

      return chunksByStartKey.get(claimInput.chunkStartKey) ?? null
    },
    getNextChunk: async (getNextInput) => {
      harness.getNextChunkInputs.push(getNextInput)

      return chunkInputs[nextIndex++] ?? null
    },
    heartbeatChunk: async (heartbeatInput) => {
      harness.heartbeatInputs.push(heartbeatInput)

      return chunksById.get(heartbeatInput.chunkId) ?? null
    },
    runClaimedChunk: async ({chunk}) => {
      harness.runChunkInputs.push(chunk)

      return {status: 'completed' as const}
    },
  } as ReviewServingProjectorWorkerDependencies['rebuildChunkService']

  const result = await runReviewServingProjectorWorkerOnce(
    {rebuildChunkBatchSize: 2, workerId: 'worker-1'},
    harness.dependencies,
  )
  const joined = statements.join('\n')

  expect(result.chunk).toMatchObject({chunkId: secondChunk.chunkId, status: 'completed'})
  expect(result.chunkBatchCount).toBe(2)
  expect(harness.claimInputs).toHaveLength(2)
  expect(harness.runChunkInputs).toEqual([])
  expect(joined).toContain("article_id >= 'article-001'")
  expect(joined).toContain("article_id <= 'article-050'")
  expect(joined).toContain("article_id >= 'article-051'")
  expect(joined).toContain("article_id <= 'article-099'")
  expect(joined).toContain('judgmentInputContentBatchWriter')
})

test('worker writes compatible status and posting rebuild chunks through component batch writers', async () => {
  const cases = [
    {
      component: 'llmStatus',
      identity: 'llmStatus:project-1',
      validationTable: 'FROM mart.review_article_serving_v4 serving',
      writerName: 'llmStatusBatchWriter',
    },
    {
      component: 'humanStatus',
      identity: 'humanStatus:project-1',
      validationTable: 'FROM mart.review_article_serving_v4 serving',
      writerName: 'humanStatusBatchWriter',
    },
    {
      component: 'posting',
      identity: 'posting:project-1',
      validationTable: 'FROM mart.review_article_filter_posting_serving_v4 serving',
      writerName: 'postingBatchWriter',
    },
  ] as const

  for (const batchCase of cases) {
    const harness = createWorkerHarness({wakeStatus: 'completed'})
    const statements: string[] = []
    const firstChunkInput = {
      ...chunkInput,
      chunkEndKey: 'article-050',
      chunkStartKey: 'article-001',
      projectionComponent: batchCase.component,
      projectionIdentity: batchCase.identity,
    }
    const secondChunkInput = {...firstChunkInput, chunkEndKey: 'article-099', chunkStartKey: 'article-051'}
    const firstChunk = {
      ...chunkManifest,
      ...firstChunkInput,
      chunkId: `chunk-${batchCase.component}-batch-1`,
      parentChunkId: `chunk-${batchCase.component}-parent`,
      splitDepth: 1,
    }
    const secondChunk = {
      ...chunkManifest,
      ...secondChunkInput,
      chunkId: `chunk-${batchCase.component}-batch-2`,
      parentChunkId: `chunk-${batchCase.component}-parent`,
      splitDepth: 1,
    }
    const chunkInputs = [firstChunkInput, secondChunkInput]
    const chunksByStartKey = new Map<string, ReviewServingRebuildChunkManifest>([
      [firstChunkInput.chunkStartKey, firstChunk],
      [secondChunkInput.chunkStartKey, secondChunk],
    ])
    const chunksById = new Map<string, ReviewServingRebuildChunkManifest>([
      [firstChunk.chunkId, firstChunk],
      [secondChunk.chunkId, secondChunk],
    ])
    const componentState = {
      optional: [],
      required: [
        {baseGeneration: '2', component: 'projectScope', projectionIdentity: 'projectScope:project-1'},
        {baseGeneration: '2', component: 'selectedImport', projectionIdentity: 'selectedImport:project-1'},
        {baseGeneration: '2', component: batchCase.component, projectionIdentity: batchCase.identity},
      ],
    }
    let nextIndex = 0

    harness.database.queryJson = async <T>(statement: string) => {
      statements.push(statement)

      if (statement.includes('FROM app.review_rebuild_chunk_manifest')) {
        const chunkId = [...chunksById.keys()].find((id) => {
          return statement.includes(id)
        })

        return [chunksById.get(chunkId ?? firstChunk.chunkId) ?? firstChunk] as T[]
      }

      if (statement.includes('FROM app.review_projection_identity_manifest')) {
        return [
          {
            baseGeneration: firstChunk.outputBaseGeneration,
            definitionVersion: `${batchCase.component}:v1`,
            inputDigest: firstChunk.inputDigest,
            inputWatermark: firstChunk.inputWatermark,
            inputWatermarksJson: {reviewChange: firstChunk.inputWatermark},
            invalidationReason: firstChunk.inputDigest,
            manifestId: `manifest-${batchCase.component}`,
            patchRangeEnd: firstChunk.inputWatermark,
            patchRangeStart: firstChunk.inputWatermark,
            patchWatermark: firstChunk.inputWatermark,
            projectId: firstChunk.projectId,
            projectionComponent: firstChunk.projectionComponent,
            projectionIdentity: firstChunk.projectionIdentity,
            promptConfigHash: null,
            reviewConfigHash: 'review-config-1',
            status: 'candidate',
          },
        ] as T[]
      }

      if (statement.includes('FROM app.review_serving_snapshot_manifest')) {
        return [
          {
            componentStateJson: componentState,
            reviewConfigHash: 'review-config-1',
            selectedImportSnapshotId: 'selected-import-snapshot-1',
            snapshotId: `snapshot-${batchCase.component}-batch-1`,
          },
        ] as T[]
      }

      if (statement.includes(batchCase.validationTable) && statement.includes('AS actualCount')) {
        return [{actualChecksum: `checksum-${batchCase.component}-batch`, actualCount: 2}] as T[]
      }

      return [] as T[]
    }
    harness.database.run = async (statement: string) => {
      statements.push(statement)
    }
    harness.dependencies.rebuildChunkService = {
      ...harness.dependencies.rebuildChunkService,
      claimChunk: async (claimInput) => {
        harness.claimInputs.push(claimInput)

        return chunksByStartKey.get(claimInput.chunkStartKey) ?? null
      },
      getNextChunk: async (getNextInput) => {
        harness.getNextChunkInputs.push(getNextInput)

        return chunkInputs[nextIndex++] ?? null
      },
      heartbeatChunk: async (heartbeatInput) => {
        harness.heartbeatInputs.push(heartbeatInput)

        return chunksById.get(heartbeatInput.chunkId) ?? null
      },
      runClaimedChunk: async ({chunk}) => {
        harness.runChunkInputs.push(chunk)

        return {status: 'completed' as const}
      },
    } as ReviewServingProjectorWorkerDependencies['rebuildChunkService']

    const result = await runReviewServingProjectorWorkerOnce(
      {rebuildChunkBatchSize: 2, workerId: 'worker-1'},
      harness.dependencies,
    )
    const joined = statements.join('\n')

    expect(result.chunk).toMatchObject({chunkId: secondChunk.chunkId, status: 'completed'})
    expect(result.chunkBatchCount).toBe(2)
    expect(harness.claimInputs).toHaveLength(2)
    expect(harness.runChunkInputs).toEqual([])
    expect(joined).toContain("article_id >= 'article-001'")
    expect(joined).toContain("article_id <= 'article-050'")
    expect(joined).toContain("article_id >= 'article-051'")
    expect(joined).toContain("article_id <= 'article-099'")
    expect(joined).toContain(batchCase.writerName)
  }
})

test('worker keeps opt-in rebuild chunk batches below the RSS cap', async () => {
  const harness = createWorkerHarness({wakeStatus: 'completed'})
  const firstChunkInput = {
    ...chunkInput,
    chunkEndKey: 'article-050',
    chunkStartKey: 'article-001',
    projectionComponent: 'projectScope' as const,
    projectionIdentity: 'projectScope:project-1',
  }
  const secondChunkInput = {...firstChunkInput, chunkEndKey: 'article-099', chunkStartKey: 'article-051'}
  const firstChunk = {...chunkManifest, ...firstChunkInput, chunkId: 'chunk-batch-1'}
  const secondChunk = {...chunkManifest, ...secondChunkInput, chunkId: 'chunk-batch-2'}
  const chunkInputs = [firstChunkInput, secondChunkInput]
  const chunksByStartKey = new Map([
    [firstChunkInput.chunkStartKey, firstChunk],
    [secondChunkInput.chunkStartKey, secondChunk],
  ])
  let nextIndex = 0

  harness.dependencies.getMemoryUsage = () => {
    return {rss: 50}
  }
  harness.dependencies.rebuildChunkService = {
    ...harness.dependencies.rebuildChunkService,
    claimChunk: async (claimInput) => {
      harness.claimInputs.push(claimInput)

      return chunksByStartKey.get(claimInput.chunkStartKey) ?? null
    },
    getNextChunk: async (getNextInput) => {
      harness.getNextChunkInputs.push(getNextInput)

      return chunkInputs[nextIndex++] ?? null
    },
  } as ReviewServingProjectorWorkerDependencies['rebuildChunkService']

  const result = await runReviewServingProjectorWorkerOnce(
    {rebuildChunkBatchMaxRssBytes: 100, rebuildChunkBatchSize: 2, workerId: 'worker-1'},
    harness.dependencies,
  )

  expect(result.chunk).toMatchObject({chunkId: 'chunk-batch-2', status: 'completed'})
  expect(result.chunkBatchCount).toBe(2)
  expect(harness.claimInputs).toHaveLength(2)
})

test('worker limits opt-in rebuild chunk batches to one chunk when RSS cap is reached', async () => {
  const harness = createWorkerHarness({wakeStatus: 'completed'})
  const firstChunkInput = {
    ...chunkInput,
    chunkEndKey: 'article-050',
    chunkStartKey: 'article-001',
    projectionComponent: 'projectScope' as const,
    projectionIdentity: 'projectScope:project-1',
  }
  const secondChunkInput = {...firstChunkInput, chunkEndKey: 'article-099', chunkStartKey: 'article-051'}
  const firstChunk = {...chunkManifest, ...firstChunkInput, chunkId: 'chunk-batch-1'}
  const secondChunk = {...chunkManifest, ...secondChunkInput, chunkId: 'chunk-batch-2'}
  const chunkInputs = [firstChunkInput, secondChunkInput]
  const chunksByStartKey = new Map([
    [firstChunkInput.chunkStartKey, firstChunk],
    [secondChunkInput.chunkStartKey, secondChunk],
  ])
  let nextIndex = 0

  harness.dependencies.getMemoryUsage = () => {
    return {rss: 100}
  }
  harness.dependencies.rebuildChunkService = {
    ...harness.dependencies.rebuildChunkService,
    claimChunk: async (claimInput) => {
      harness.claimInputs.push(claimInput)

      return chunksByStartKey.get(claimInput.chunkStartKey) ?? null
    },
    getNextChunk: async (getNextInput) => {
      harness.getNextChunkInputs.push(getNextInput)

      return chunkInputs[nextIndex++] ?? null
    },
  } as ReviewServingProjectorWorkerDependencies['rebuildChunkService']

  const result = await runReviewServingProjectorWorkerOnce(
    {rebuildChunkBatchMaxRssBytes: 100, rebuildChunkBatchSize: 2, workerId: 'worker-1'},
    harness.dependencies,
  )

  expect(result.chunk).toMatchObject({chunkId: 'chunk-batch-1', status: 'completed'})
  expect(result.chunkBatchCount).toBe(1)
  expect(harness.claimInputs).toHaveLength(1)
  expect(harness.runChunkInputs).toEqual([firstChunk])
})

test('worker returns a failed chunk from a rebuild chunk batch', async () => {
  const harness = createWorkerHarness({wakeStatus: 'completed'})
  const firstChunkInput = {
    ...chunkInput,
    chunkEndKey: 'article-050',
    chunkStartKey: 'article-001',
    projectionComponent: 'projectScope' as const,
    projectionIdentity: 'projectScope:project-1',
  }
  const secondChunkInput = {...firstChunkInput, chunkEndKey: 'article-099', chunkStartKey: 'article-051'}
  const firstChunk = {...chunkManifest, ...firstChunkInput, chunkId: 'chunk-batch-1'}
  const secondChunk = {...chunkManifest, ...secondChunkInput, chunkId: 'chunk-batch-2'}
  const chunkInputs = [firstChunkInput, secondChunkInput]
  const chunksByStartKey = new Map([
    [firstChunkInput.chunkStartKey, firstChunk],
    [secondChunkInput.chunkStartKey, secondChunk],
  ])
  let nextIndex = 0

  harness.dependencies.rebuildChunkService = {
    ...harness.dependencies.rebuildChunkService,
    claimChunk: async (claimInput) => {
      harness.claimInputs.push(claimInput)

      return chunksByStartKey.get(claimInput.chunkStartKey) ?? null
    },
    failChunk: async (failure) => {
      harness.failedChunks.push(failure)

      return {...secondChunk, status: 'failed' as const}
    },
    getNextChunk: async (getNextInput) => {
      harness.getNextChunkInputs.push(getNextInput)

      return chunkInputs[nextIndex++] ?? null
    },
    runClaimedChunk: async ({chunk}) => {
      harness.runChunkInputs.push(chunk)

      if (chunk.chunkId === secondChunk.chunkId) {
        throw new Error('second chunk failed')
      }

      return {status: 'completed' as const}
    },
  } as ReviewServingProjectorWorkerDependencies['rebuildChunkService']

  const result = await runReviewServingProjectorWorkerOnce(
    {rebuildChunkBatchSize: 2, workerId: 'worker-1'},
    harness.dependencies,
  )

  expect(result.status).toBe('failed')
  expect(result.chunk).toMatchObject({chunkId: 'chunk-batch-2', status: 'failed'})
  expect(result.chunkBatchCount).toBe(1)
  expect(harness.failedChunks).toEqual([
    {chunkId: 'chunk-batch-2', error: 'second chunk failed', leaseOwner: 'worker-1'},
  ])
})

test('worker fails every preclaimed component batch chunk when a batch writer throws', async () => {
  const harness = createWorkerHarness({wakeStatus: 'completed'})
  const statements: string[] = []
  const firstChunkInput = {
    ...chunkInput,
    chunkEndKey: 'article-050',
    chunkStartKey: 'article-001',
    inputDigest: 'freshReviewServingSnapshot',
    projectionComponent: 'projectScope' as const,
    projectionIdentity: 'projectScope:project-1',
  }
  const secondChunkInput = {...firstChunkInput, chunkEndKey: 'article-099', chunkStartKey: 'article-051'}
  const firstChunk = {...chunkManifest, ...firstChunkInput, chunkId: 'chunk-batch-1'}
  const secondChunk = {...chunkManifest, ...secondChunkInput, chunkId: 'chunk-batch-2'}
  const chunkInputs = [firstChunkInput, secondChunkInput]
  const chunksByStartKey = new Map([
    [firstChunkInput.chunkStartKey, firstChunk],
    [secondChunkInput.chunkStartKey, secondChunk],
  ])
  const chunksById = new Map<string, ReviewServingRebuildChunkManifest>([
    [firstChunk.chunkId, firstChunk],
    [secondChunk.chunkId, secondChunk],
  ])
  let nextIndex = 0

  harness.database.queryJson = async <T>(statement: string) => {
    statements.push(statement)

    if (statement.includes('FROM app.review_rebuild_chunk_manifest')) {
      const chunkId = [...chunksById.keys()].find((id) => {
        return statement.includes(id)
      })

      return [chunksById.get(chunkId ?? firstChunk.chunkId) ?? firstChunk] as T[]
    }

    return [] as T[]
  }
  harness.database.run = async (statement: string) => {
    statements.push(statement)

    if (statement.includes('INSERT INTO mart.project_scope_article')) {
      throw new Error('project scope batch writer failed')
    }
  }
  harness.dependencies.rebuildChunkService = {
    ...harness.dependencies.rebuildChunkService,
    claimChunk: async (claimInput) => {
      harness.claimInputs.push(claimInput)

      return chunksByStartKey.get(claimInput.chunkStartKey) ?? null
    },
    failChunk: async (failure) => {
      harness.failedChunks.push(failure)

      return {...(chunksById.get(failure.chunkId) ?? firstChunk), lastError: failure.error, status: 'failed' as const}
    },
    getNextChunk: async (getNextInput) => {
      harness.getNextChunkInputs.push(getNextInput)

      return chunkInputs[nextIndex++] ?? null
    },
    heartbeatChunk: async (heartbeatInput) => {
      harness.heartbeatInputs.push(heartbeatInput)

      return chunksById.get(heartbeatInput.chunkId) ?? null
    },
    runClaimedChunk: async ({chunk}) => {
      harness.runChunkInputs.push(chunk)

      return {status: 'completed' as const}
    },
  } as ReviewServingProjectorWorkerDependencies['rebuildChunkService']

  const result = await runReviewServingProjectorWorkerOnce(
    {rebuildChunkBatchSize: 2, workerId: 'worker-1'},
    harness.dependencies,
  )

  expect(result.status).toBe('failed')
  expect(result.chunk).toMatchObject({chunkId: firstChunk.chunkId, status: 'failed'})
  expect(result.chunkBatchCount).toBe(0)
  expect(harness.claimInputs).toHaveLength(2)
  expect(harness.runChunkInputs).toEqual([])
  expect(harness.failedChunks).toEqual([
    {chunkId: firstChunk.chunkId, error: 'project scope batch writer failed', leaseOwner: 'worker-1'},
    {chunkId: secondChunk.chunkId, error: 'project scope batch writer failed', leaseOwner: 'worker-1'},
  ])
})

test('worker stops a rebuild chunk batch after a foreground request chunk completes', async () => {
  const harness = createWorkerHarness({wakeStatus: 'completed'})
  const firstChunkInput = {
    ...chunkInput,
    chunkEndKey: 'article-050',
    chunkStartKey: 'article-001',
    requestId: 'rebuild:foreground',
  }
  const secondChunkInput = {
    ...chunkInput,
    chunkEndKey: 'article-099',
    chunkStartKey: 'article-051',
    requestId: 'rebuild:foreground',
  }
  const firstChunk = {...chunkManifest, ...firstChunkInput, chunkId: 'chunk-batch-foreground-1'}
  const secondChunk = {...chunkManifest, ...secondChunkInput, chunkId: 'chunk-batch-foreground-2'}
  const chunkInputs = [firstChunkInput, secondChunkInput]
  const chunksByStartKey = new Map([
    [firstChunkInput.chunkStartKey, firstChunk],
    [secondChunkInput.chunkStartKey, secondChunk],
  ])
  let nextIndex = 0

  harness.dependencies.rebuildChunkService = {
    ...harness.dependencies.rebuildChunkService,
    claimChunk: async (claimInput) => {
      harness.claimInputs.push(claimInput)

      return chunksByStartKey.get(claimInput.chunkStartKey) ?? null
    },
    getNextChunk: async (getNextInput) => {
      harness.getNextChunkInputs.push(getNextInput)

      return chunkInputs[nextIndex++] ?? null
    },
  } as ReviewServingProjectorWorkerDependencies['rebuildChunkService']

  const result = await runReviewServingProjectorWorkerOnce(
    {rebuildChunkBatchSize: 2, workerId: 'worker-1'},
    harness.dependencies,
  )

  expect(result.chunk).toMatchObject({chunkId: 'chunk-batch-foreground-1', status: 'completed'})
  expect(result.chunkBatchCount).toBe(1)
  expect(harness.claimInputs).toHaveLength(1)
  expect(harness.runChunkInputs).toEqual([firstChunk])
  expect(harness.wakeInputs).toEqual([])
})

test('worker drains foreground critical rebuild chunks within a bounded chunk budget', async () => {
  const harness = createWorkerHarness({wakeStatus: 'completed'})
  const foregroundChunkInput = {...chunkInput, requestId: 'rebuild:foreground'}
  const foregroundChunk = {...chunkManifest, requestId: 'rebuild:foreground'}

  harness.dependencies.rebuildChunkService = {
    ...harness.dependencies.rebuildChunkService,
    claimChunk: async (claimInput) => {
      harness.claimInputs.push(claimInput)

      return foregroundChunk
    },
    getNextChunk: async (getNextInput) => {
      harness.getNextChunkInputs.push(getNextInput)

      return foregroundChunkInput
    },
  } as ReviewServingProjectorWorkerDependencies['rebuildChunkService']

  const result = await runReviewServingProjectorWorkerOnce(
    {
      foregroundRebuildDrainChunkBudget: 2,
      foregroundRebuildDrainCompletedCount: 1,
      foregroundRebuildDrainStartedAtMs: 1_000,
      foregroundRebuildDrainTtlMs: 10_000,
      workerId: 'worker-1',
    },
    harness.dependencies,
  )

  expect(result.chunk).toMatchObject({requestId: 'rebuild:foreground', status: 'completed'})
  expect(result.deltaIntake).toEqual({convertedPartitions: 0, dirtyWorkCount: 0, status: 'idle'})
  expect(result.projector).toMatchObject({status: 'blocked'})
  expect(harness.wakeInputs).toEqual([])
})

test('worker yields to normal projector fairness after foreground rebuild drain budget is exhausted', async () => {
  const harness = createWorkerHarness({wakeStatus: 'completed'})
  const foregroundChunkInput = {...chunkInput, requestId: 'rebuild:foreground'}
  const foregroundChunk = {...chunkManifest, requestId: 'rebuild:foreground'}

  harness.dependencies.rebuildChunkService = {
    ...harness.dependencies.rebuildChunkService,
    claimChunk: async (claimInput) => {
      harness.claimInputs.push(claimInput)

      return foregroundChunk
    },
    getNextChunk: async (getNextInput) => {
      harness.getNextChunkInputs.push(getNextInput)

      return foregroundChunkInput
    },
  } as ReviewServingProjectorWorkerDependencies['rebuildChunkService']

  const result = await runReviewServingProjectorWorkerOnce(
    {
      foregroundRebuildDrainChunkBudget: 2,
      foregroundRebuildDrainCompletedCount: 2,
      foregroundRebuildDrainStartedAtMs: 1_000,
      foregroundRebuildDrainTtlMs: 10_000,
      workerId: 'worker-1',
    },
    harness.dependencies,
  )

  expect(result.chunk).toMatchObject({requestId: 'rebuild:foreground', status: 'completed'})
  expect(result.projector).toMatchObject({status: 'completed'})
  expect(harness.wakeInputs).toHaveLength(1)
})

test('worker measures foreground rebuild drain TTL after a critical chunk completes', async () => {
  let nowMs = 1_000
  const harness = createWorkerHarness({wakeStatus: 'completed'})
  const foregroundChunkInput = {...chunkInput, requestId: 'rebuild:foreground'}
  const foregroundChunk = {...chunkManifest, requestId: 'rebuild:foreground'}

  harness.dependencies.nowMs = () => {
    return nowMs
  }
  harness.dependencies.rebuildChunkService = {
    ...harness.dependencies.rebuildChunkService,
    claimChunk: async (claimInput) => {
      harness.claimInputs.push(claimInput)

      return foregroundChunk
    },
    getNextChunk: async (getNextInput) => {
      harness.getNextChunkInputs.push(getNextInput)

      return foregroundChunkInput
    },
    runClaimedChunk: async ({chunk}) => {
      harness.runChunkInputs.push(chunk)
      nowMs = 12_001

      return {status: 'completed' as const}
    },
  } as ReviewServingProjectorWorkerDependencies['rebuildChunkService']

  const result = await runReviewServingProjectorWorkerOnce(
    {
      foregroundRebuildDrainChunkBudget: 2,
      foregroundRebuildDrainCompletedCount: 1,
      foregroundRebuildDrainStartedAtMs: 1_000,
      foregroundRebuildDrainTtlMs: 10_000,
      workerId: 'worker-1',
    },
    harness.dependencies,
  )

  expect(result.chunk).toMatchObject({requestId: 'rebuild:foreground', status: 'completed'})
  expect(result.projector).toMatchObject({status: 'completed'})
  expect(harness.wakeInputs).toHaveLength(1)
})

test('worker runs delta intake before waking projectors', async () => {
  const harness = createWorkerHarness({wakeStatus: 'completed'})
  const intakeCalls: Array<{kind: 'import' | 'review'; params: DeltaIntakeParams}> = []

  harness.database.queryJson = async <T>(statement: string, workloadContext?: DuckdbWorkloadContext) => {
    if (workloadContext) {
      harness.workloadContexts.push(workloadContext)
    }

    if (statement.includes('FROM app.review_change_delta')) {
      return [
        {endSourceHighWaterMark: 7, sourcePartition: 'review_change_delta:project-1', startSourceHighWaterMark: 3},
      ] as T[]
    }

    if (statement.includes('FROM app.import_run_article_delta')) {
      return [
        {
          endSourceHighWaterMark: 11,
          sourcePartition: 'import_run_article_delta:project-1',
          startSourceHighWaterMark: 10,
        },
      ] as T[]
    }

    return [] as T[]
  }
  harness.dependencies.intakeReviewChangeDeltas = async (params: DeltaIntakeParams) => {
    intakeCalls.push({kind: 'review', params})

    return {dirtyWorkCount: 2, maxSourceHighWaterMark: 7, status: 'converted'}
  }
  harness.dependencies.intakeImportDeltas = async (params: DeltaIntakeParams) => {
    intakeCalls.push({kind: 'import', params})

    return {dirtyWorkCount: 1, maxSourceHighWaterMark: 11, status: 'converted'}
  }

  const result = await runReviewServingProjectorWorkerOnce(
    {maxRowsPerWake: 25, workerId: 'worker-1'},
    harness.dependencies,
  )

  expect(result.deltaIntake).toEqual({convertedPartitions: 2, dirtyWorkCount: 3, status: 'completed'})
  expect(intakeCalls).toEqual([
    {
      kind: 'review',
      params: {
        endSourceHighWaterMark: 7,
        limit: 25,
        sourcePartition: 'review_change_delta:project-1',
        startSourceHighWaterMark: 3,
      },
    },
    {
      kind: 'import',
      params: {
        endSourceHighWaterMark: 11,
        limit: 25,
        sourcePartition: 'import_run_article_delta:project-1',
        startSourceHighWaterMark: 10,
      },
    },
  ])
  expect(harness.wakeInputs).toHaveLength(1)
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

test('worker heartbeats claimed rebuild chunks before running long executors', async () => {
  const harness = createWorkerHarness({wakeStatus: 'completed'})

  const result = await runReviewServingProjectorWorkerOnce(
    {heartbeatMs: 1_000, leaseMs: 5_000, now: new Date('2026-06-16T10:00:00.000Z'), workerId: 'worker-heartbeat'},
    harness.dependencies,
  )

  expect(result.chunk.status).toBe('completed')
  const [heartbeatInput] = harness.heartbeatInputs as Array<{chunkId: string; leaseExpiresAt: Date; leaseOwner: string}>

  expect(harness.heartbeatInputs).toHaveLength(1)
  expect(heartbeatInput).toMatchObject({chunkId: 'chunk-1', leaseOwner: 'worker-heartbeat'})
  expect(heartbeatInput?.leaseExpiresAt).toBeInstanceOf(Date)
  expect(harness.runChunkInputs).toEqual([chunkManifest])
})

test('worker marks rebuild requests completed after their final chunk completes', async () => {
  const harness = createWorkerHarness({wakeStatus: 'completed'})
  const requestChunk = {...chunkManifest, requestId: 'rebuild-1'} satisfies ReviewServingRebuildChunkManifest

  harness.dependencies.rebuildChunkService = {
    ...harness.dependencies.rebuildChunkService,
    claimChunk: async () => {
      return requestChunk
    },
    heartbeatChunk: async () => {
      return requestChunk
    },
    runClaimedChunk: async ({chunk}) => {
      harness.runChunkInputs.push(chunk)

      return {status: 'completed' as const}
    },
  } as ReviewServingProjectorWorkerDependencies['rebuildChunkService']

  const result = await runReviewServingProjectorWorkerOnce({workerId: 'worker-1'}, harness.dependencies)
  const joined = harness.runStatements.join('\n')

  expect(result.chunk.status).toBe('completed')
  expect(result.deltaIntake.status).toBe('idle')
  expect(result.projector.status).toBe('blocked')
  expect(harness.wakeInputs).toEqual([])
  expect(joined).toContain('UPDATE app.review_rebuild_request')
  expect(joined).toContain("status = 'completed'")
  expect(joined).toContain("request_id = 'rebuild-1'")
})

test('worker recycles DuckDB and collects garbage after completed status rebuild chunks', async () => {
  const harness = createWorkerHarness({wakeStatus: 'completed'})
  const llmChunkInput = {
    ...chunkInput,
    projectionComponent: 'llmStatus' as const,
    projectionIdentity: 'llmStatus:project-1',
  }
  const llmChunk = {
    ...chunkManifest,
    ...llmChunkInput,
    requestId: 'rebuild-status',
  } satisfies ReviewServingRebuildChunkManifest

  harness.dependencies.rebuildChunkService = {
    ...harness.dependencies.rebuildChunkService,
    claimChunk: async () => {
      return llmChunk
    },
    getNextChunk: async () => {
      return llmChunkInput
    },
    heartbeatChunk: async () => {
      return llmChunk
    },
    runClaimedChunk: async ({chunk}) => {
      harness.runChunkInputs.push(chunk)

      return {status: 'completed' as const}
    },
  } as ReviewServingProjectorWorkerDependencies['rebuildChunkService']

  const result = await runReviewServingProjectorWorkerOnce({workerId: 'worker-1'}, harness.dependencies)

  expect(result.chunk).toMatchObject({
    projectionComponent: 'llmStatus',
    requestId: 'rebuild-status',
    status: 'completed',
  })
  expect(harness.recycledChunks).toEqual([llmChunk])
  expect(harness.garbageCollectedChunks).toEqual([llmChunk])
})

test('worker recycles DuckDB after completed summary rebuild chunks', async () => {
  const harness = createWorkerHarness({wakeStatus: 'completed'})
  const summaryChunkInput = {
    ...chunkInput,
    projectionComponent: 'summary' as const,
    projectionIdentity: 'summary:project-1',
  }
  const summaryChunk = {
    ...chunkManifest,
    ...summaryChunkInput,
    requestId: 'rebuild-summary',
  } satisfies ReviewServingRebuildChunkManifest

  harness.dependencies.rebuildChunkService = {
    ...harness.dependencies.rebuildChunkService,
    claimChunk: async () => {
      return summaryChunk
    },
    getNextChunk: async () => {
      return summaryChunkInput
    },
    heartbeatChunk: async () => {
      return summaryChunk
    },
    runClaimedChunk: async ({chunk}) => {
      harness.runChunkInputs.push(chunk)

      return {status: 'completed' as const}
    },
  } as ReviewServingProjectorWorkerDependencies['rebuildChunkService']

  const result = await runReviewServingProjectorWorkerOnce({workerId: 'worker-1'}, harness.dependencies)

  expect(result.chunk).toMatchObject({
    projectionComponent: 'summary',
    requestId: 'rebuild-summary',
    status: 'completed',
  })
  expect(harness.recycledChunks).toEqual([summaryChunk])
  expect(harness.garbageCollectedChunks).toEqual([summaryChunk])
})

test('worker recycles DuckDB after completed posting rebuild chunks', async () => {
  const harness = createWorkerHarness({wakeStatus: 'completed'})
  const postingChunkInput = {
    ...chunkInput,
    projectionComponent: 'posting' as const,
    projectionIdentity: 'posting:project-1',
  }
  const postingChunk = {
    ...chunkManifest,
    ...postingChunkInput,
    requestId: 'rebuild-posting',
  } satisfies ReviewServingRebuildChunkManifest

  harness.dependencies.rebuildChunkService = {
    ...harness.dependencies.rebuildChunkService,
    claimChunk: async () => {
      return postingChunk
    },
    getNextChunk: async () => {
      return postingChunkInput
    },
    heartbeatChunk: async () => {
      return postingChunk
    },
    runClaimedChunk: async ({chunk}) => {
      harness.runChunkInputs.push(chunk)

      return {status: 'completed' as const}
    },
  } as ReviewServingProjectorWorkerDependencies['rebuildChunkService']

  const result = await runReviewServingProjectorWorkerOnce({workerId: 'worker-1'}, harness.dependencies)

  expect(result.chunk).toMatchObject({
    projectionComponent: 'posting',
    requestId: 'rebuild-posting',
    status: 'completed',
  })
  expect(harness.recycledChunks).toEqual([postingChunk])
  expect(harness.garbageCollectedChunks).toEqual([postingChunk])
})

test('worker yields and collects garbage after each completed status chunk in a long loop', async () => {
  const harness = createWorkerHarness({wakeStatus: 'completed'})
  const controller = new AbortController()
  const sleepCalls: number[] = []
  const statusChunks = [
    {
      ...chunkManifest,
      chunkId: 'chunk-llm-status-loop-1',
      projectionComponent: 'llmStatus' as const,
      projectionIdentity: 'llmStatus:project-1',
      requestId: 'rebuild-status-loop',
    },
    {
      ...chunkManifest,
      chunkId: 'chunk-llm-status-loop-2',
      projectionComponent: 'llmStatus' as const,
      projectionIdentity: 'llmStatus:project-1',
      requestId: 'rebuild-status-loop',
    },
  ] satisfies ReviewServingRebuildChunkManifest[]
  let claimIndex = 0

  harness.dependencies.rebuildChunkService = {
    ...harness.dependencies.rebuildChunkService,
    claimChunk: async () => {
      return statusChunks[Math.min(claimIndex, statusChunks.length - 1)]
    },
    getNextChunk: async () => {
      const chunk = statusChunks[Math.min(claimIndex, statusChunks.length - 1)]

      if (chunk === undefined) {
        throw new Error('expected status loop test chunk')
      }

      return {
        ...chunkInput,
        projectionComponent: chunk.projectionComponent,
        projectionIdentity: chunk.projectionIdentity,
        requestId: chunk.requestId,
      }
    },
    heartbeatChunk: async () => {
      return statusChunks[Math.min(claimIndex, statusChunks.length - 1)]
    },
    runClaimedChunk: async ({chunk}) => {
      harness.runChunkInputs.push(chunk)
      claimIndex += 1

      return {status: 'completed' as const}
    },
  } as ReviewServingProjectorWorkerDependencies['rebuildChunkService']
  harness.dependencies.sleep = async (delayMs: number) => {
    sleepCalls.push(delayMs)

    if (sleepCalls.length >= statusChunks.length) {
      controller.abort()
    }
  }

  await runReviewServingProjectorWorker({signal: controller.signal, workerId: 'worker-1'}, harness.dependencies)

  expect(harness.runChunkInputs).toEqual(statusChunks)
  expect(harness.recycledChunks).toEqual(statusChunks)
  expect(harness.garbageCollectedChunks).toEqual(statusChunks)
  expect(sleepCalls).toEqual([
    nativeHeavyReviewServingProjectorWorkerProgressYieldMs,
    nativeHeavyReviewServingProjectorWorkerProgressYieldMs,
  ])
})

test('worker does not fail completed summary chunks when DuckDB recycle fails', async () => {
  const harness = createWorkerHarness({wakeStatus: 'completed'})
  const summaryChunkInput = {
    ...chunkInput,
    projectionComponent: 'summary' as const,
    projectionIdentity: 'summary:project-1',
  }
  const summaryChunk = {
    ...chunkManifest,
    ...summaryChunkInput,
    requestId: 'rebuild-summary',
  } satisfies ReviewServingRebuildChunkManifest

  harness.dependencies.rebuildChunkService = {
    ...harness.dependencies.rebuildChunkService,
    claimChunk: async () => {
      return summaryChunk
    },
    getNextChunk: async () => {
      return summaryChunkInput
    },
    heartbeatChunk: async () => {
      return summaryChunk
    },
    runClaimedChunk: async ({chunk}) => {
      harness.runChunkInputs.push(chunk)

      return {status: 'completed' as const}
    },
  } as ReviewServingProjectorWorkerDependencies['rebuildChunkService']
  harness.dependencies.recycleDuckdbAfterCompletedRebuildChunk = async () => {
    throw new Error('recycle failed')
  }

  const result = await runReviewServingProjectorWorkerOnce({workerId: 'worker-1'}, harness.dependencies)

  expect(result.chunk).toMatchObject({
    projectionComponent: 'summary',
    requestId: 'rebuild-summary',
    status: 'completed',
  })
  expect(harness.failedChunks).toEqual([])
})

test('worker marks rebuild requests failed after terminal chunk failure', async () => {
  const harness = createWorkerHarness({runChunkThrows: true, wakeStatus: 'completed'})
  const requestChunk = {...chunkManifest, requestId: 'rebuild-terminal'} satisfies ReviewServingRebuildChunkManifest

  harness.dependencies.rebuildChunkService = {
    ...harness.dependencies.rebuildChunkService,
    claimChunk: async () => {
      return requestChunk
    },
    failChunk: async () => {
      return {
        ...requestChunk,
        lastError: 'chunk executor failed',
        leaseOwner: null,
        status: 'blocked_over_budget' as const,
      }
    },
    heartbeatChunk: async () => {
      return requestChunk
    },
    runClaimedChunk: async ({chunk}) => {
      harness.runChunkInputs.push(chunk)
      throw new Error('chunk executor failed')
    },
  } as ReviewServingProjectorWorkerDependencies['rebuildChunkService']

  const result = await runReviewServingProjectorWorkerOnce({workerId: 'worker-1'}, harness.dependencies)
  const joined = harness.runStatements.join('\n')

  expect(result.chunk).toEqual({chunkId: 'chunk-1', requestId: 'rebuild-terminal', status: 'failed'})
  expect(joined).toContain('UPDATE app.review_rebuild_request')
  expect(joined).toContain("status = 'failed'")
  expect(joined).toContain("last_error = 'chunk executor failed'")
  expect(joined).toContain("request_id = 'rebuild-terminal'")
})

test('worker marks rebuild requests failed when completion finalization throws', async () => {
  const harness = createWorkerHarness({wakeStatus: 'completed'})
  const requestChunk = {...chunkManifest, requestId: 'rebuild-finalizer'} satisfies ReviewServingRebuildChunkManifest

  harness.database.queryJson = async <T>(statement: string, workloadContext?: DuckdbWorkloadContext) => {
    if (workloadContext) {
      harness.workloadContexts.push(workloadContext)
    }

    if (statement.includes('CAST(COUNT(*) AS INTEGER) AS pendingChunkCount')) {
      throw new Error('request finalizer failed')
    }

    return [] as T[]
  }
  harness.dependencies.rebuildChunkService = {
    ...harness.dependencies.rebuildChunkService,
    claimChunk: async () => {
      return requestChunk
    },
    failChunk: async () => {
      throw new Error('completed chunk should not be failed')
    },
    heartbeatChunk: async () => {
      return requestChunk
    },
    runClaimedChunk: async ({chunk}) => {
      harness.runChunkInputs.push(chunk)

      return {status: 'completed' as const}
    },
  } as ReviewServingProjectorWorkerDependencies['rebuildChunkService']

  const result = await runReviewServingProjectorWorkerOnce({workerId: 'worker-1'}, harness.dependencies)
  const joined = harness.runStatements.join('\n')

  expect(result.chunk).toEqual({chunkId: 'chunk-1', requestId: 'rebuild-finalizer', status: 'failed'})
  expect(harness.failedChunks).toEqual([])
  expect(joined).toContain('UPDATE app.review_rebuild_request')
  expect(joined).toContain("status = 'failed'")
  expect(joined).toContain("last_error = 'request finalizer failed'")
  expect(joined).toContain("request_id = 'rebuild-finalizer'")
})

test('worker refreshes request candidate snapshot state before promotion', async () => {
  const harness = createWorkerHarness({wakeStatus: 'completed'})
  const requestChunk = {
    ...chunkManifest,
    requestId: 'rebuild-refresh-candidate',
    snapshotId: 'snapshot-refresh-candidate',
  } satisfies ReviewServingRebuildChunkManifest
  const staleComponentState = {
    optional: [],
    required: [
      {
        baseGeneration: '0',
        component: 'projectScope',
        patchWatermark: '0',
        projectionIdentity: 'projectScope:identity-1',
        requirement: 'required',
      },
    ],
  }
  const freshComponentState = {optional: [], required: [{...staleComponentState.required[0], patchWatermark: '14'}]}
  let snapshotManifestReads = 0

  harness.database.queryJson = async <T>(statement: string) => {
    if (statement.includes('COUNT(*) AS pendingChunkCount')) {
      return [{pendingChunkCount: 0}] as T[]
    }

    if (statement.includes('SELECT DISTINCT') && statement.includes('FROM app.review_rebuild_chunk_manifest chunk')) {
      return [
        {projectId: 'project-1', reviewConfigHash: 'review-config-1', snapshotId: 'snapshot-refresh-candidate'},
      ] as T[]
    }

    if (statement.includes('FROM app.review_projection_identity_manifest')) {
      return [
        {
          baseGeneration: 0,
          definitionVersion: 'project-scope-v4-test',
          inputDigest: 'digest-1',
          inputWatermark: 14,
          inputWatermarksJson: JSON.stringify({projectScope: 14}),
          invalidationReason: null,
          manifestId: 'manifest-project-scope-1',
          patchRangeEnd: 14,
          patchRangeStart: 1,
          patchWatermark: 14,
          projectId: 'project-1',
          projectionComponent: 'projectScope',
          projectionIdentity: 'projectScope:identity-1',
          promptConfigHash: null,
          reviewConfigHash: null,
          status: 'candidate',
        },
      ] as T[]
    }

    if (statement.includes('FROM app.review_selected_import_snapshot')) {
      return [{status: 'completed'}] as T[]
    }

    if (
      statement.includes('FROM app.review_serving_snapshot_manifest')
      && statement.includes("snapshot_status = 'active'")
    ) {
      return [] as T[]
    }

    if (statement.includes('FROM app.review_serving_snapshot_manifest')) {
      snapshotManifestReads += 1

      return [
        {
          componentStateJson: JSON.stringify(snapshotManifestReads === 1 ? staleComponentState : freshComponentState),
          composedIdentityJson: JSON.stringify({projectId: 'project-1'}),
          lastError: null,
          lastKnownGoodSnapshotId: null,
          optionalComponentsJson: JSON.stringify([]),
          projectId: 'project-1',
          requiredComponentsJson: JSON.stringify(['projectScope']),
          reviewConfigHash: 'review-config-1',
          selectedImportSnapshotId: 'selected-import-snapshot-1',
          snapshotId: 'snapshot-refresh-candidate',
          snapshotStatus: 'candidate',
          sourceWatermarksJson: JSON.stringify({projectScope: 14}),
          validationResultJson: null,
        },
      ] as T[]
    }

    return [] as T[]
  }
  harness.dependencies.rebuildChunkService = {
    ...harness.dependencies.rebuildChunkService,
    claimChunk: async () => {
      return requestChunk
    },
    heartbeatChunk: async () => {
      return requestChunk
    },
    runClaimedChunk: async ({chunk}) => {
      harness.runChunkInputs.push(chunk)

      return {status: 'completed' as const}
    },
  } as ReviewServingProjectorWorkerDependencies['rebuildChunkService']

  const result = await runReviewServingProjectorWorkerOnce({workerId: 'worker-1'}, harness.dependencies)
  const joined = harness.runStatements.join('\n')

  expect(result.chunk.status).toBe('completed')
  expect(joined).toContain('INSERT INTO app.review_serving_snapshot_manifest')
  expect(joined).toContain('UPDATE app.review_rebuild_request')
  expect(joined).toContain("status = 'completed'")
})

test('worker schedules cleanup only after its cleanup interval elapses', async () => {
  const cleanupTarget = {batchSize: 10, now: new Date('2026-06-16T10:00:00.000Z'), projectId: 'project-1'}
  const skippedHarness = createWorkerHarness({cleanupTargets: [cleanupTarget], nowMs: 1_000})
  const completedHarness = createWorkerHarness({cleanupTargets: [cleanupTarget], nowMs: 62_000})

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
  expect(harness.claimInputs).toHaveLength(1)
})

test('worker yields after completed request chunks so progress readers can run', async () => {
  const harness = createWorkerHarness()
  const controller = new AbortController()
  const sleepCalls: number[] = []
  const requestChunk = {...chunkManifest, requestId: 'rebuild-1'} satisfies ReviewServingRebuildChunkManifest

  harness.dependencies.rebuildChunkService = {
    ...harness.dependencies.rebuildChunkService,
    claimChunk: async () => {
      return requestChunk
    },
  } as ReviewServingProjectorWorkerDependencies['rebuildChunkService']
  harness.dependencies.sleep = mock(async (delayMs: number) => {
    sleepCalls.push(delayMs)
    controller.abort()
  })

  await runReviewServingProjectorWorker({signal: controller.signal, workerId: 'worker-1'}, harness.dependencies)

  expect(sleepCalls).toEqual([defaultReviewServingProjectorWorkerProgressYieldMs])
  expect(harness.runChunkInputs).toEqual([requestChunk])
})

test('worker yields after background request chunks before continuing maintenance work', async () => {
  const harness = createWorkerHarness()
  const controller = new AbortController()
  const sleepCalls: number[] = []
  const requestChunk = {...chunkManifest, requestId: 'rebuild-1'} satisfies ReviewServingRebuildChunkManifest
  let claimCount = 0

  harness.dependencies.rebuildChunkService = {
    ...harness.dependencies.rebuildChunkService,
    claimChunk: async () => {
      claimCount += 1

      return claimCount === 1 ? requestChunk : null
    },
  } as ReviewServingProjectorWorkerDependencies['rebuildChunkService']
  harness.dependencies.sleep = mock(async (delayMs: number) => {
    sleepCalls.push(delayMs)
    controller.abort()
  })
  harness.dependencies.wakeProjectors = async () => {
    controller.abort()

    return {failures: [], promotions: [], releasedClaimIds: [], runs: [], status: 'blocked'}
  }

  await runReviewServingProjectorWorker({signal: controller.signal, workerId: 'worker-1'}, harness.dependencies)

  expect(sleepCalls).toEqual([defaultReviewServingProjectorWorkerProgressYieldMs])
  expect(harness.runChunkInputs).toEqual([requestChunk])
})

test('worker keeps yielding after foreground rebuild drain budget is exhausted', async () => {
  const harness = createWorkerHarness({wakeStatus: 'completed'})
  const controller = new AbortController()
  const sleepCalls: number[] = []
  const requestChunk = {...chunkManifest, requestId: 'rebuild-1'} satisfies ReviewServingRebuildChunkManifest

  harness.dependencies.rebuildChunkService = {
    ...harness.dependencies.rebuildChunkService,
    claimChunk: async () => {
      return requestChunk
    },
  } as ReviewServingProjectorWorkerDependencies['rebuildChunkService']
  harness.dependencies.sleep = mock(async (delayMs: number) => {
    sleepCalls.push(delayMs)
    controller.abort()
  })

  await runReviewServingProjectorWorker(
    {
      foregroundRebuildDrainChunkBudget: 2,
      foregroundRebuildDrainCompletedCount: 2,
      foregroundRebuildDrainStartedAtMs: 1_000,
      foregroundRebuildDrainTtlMs: 10_000,
      signal: controller.signal,
      workerId: 'worker-1',
    },
    harness.dependencies,
  )

  expect(harness.wakeInputs).toHaveLength(1)
  expect(sleepCalls).toEqual([defaultReviewServingProjectorWorkerProgressYieldMs])
  expect(harness.runChunkInputs).toEqual([requestChunk])
})

test('worker does not start a cycle when already aborted', async () => {
  const harness = createWorkerHarness()
  const controller = new AbortController()

  controller.abort()

  await runReviewServingProjectorWorker({signal: controller.signal, workerId: 'worker-1'}, harness.dependencies)

  expect(harness.claimInputs).toEqual([])
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
  expect(source).toContain('projectReviewServingSelectedImportBatch')
  expect(source).toContain('projectReviewServingSelectedImportPatches')
  expect(source).toContain('projectReviewServingQueuePatches')
  expect(source).toContain('projectReviewServingFilterPostings')
  expect(source).toContain('projectReviewServingSummaries')
  expect(source).toContain('projectReviewServingPayloadRanges')
  expect(source).toContain('projectReviewServingPayloadRows')
  expect(source).toContain('projectReviewServingJudgmentPayloadRows')
  expect(source).toContain('projectReviewServingDisplayPatches')
  expect(source).toContain('projectReviewServingTitleSearchRows')
  expect(source).toContain("component: 'judgmentInputContent'")
})

test('high-fanout rebuild chunks commit idempotent output separately from completion', () => {
  const source = readFileSync(join(import.meta.dir, 'reviewServingProjectorWorker.ts'), 'utf8')
  const getFunctionSource = (functionName: string) => {
    const start = source.indexOf(`const ${functionName} = async`)
    const end = source.indexOf('\nconst ', start + 1)

    expect(start).toBeGreaterThanOrEqual(0)

    return source.slice(start, end === -1 ? undefined : end)
  }

  for (const functionName of [
    'runLlmStatusRebuildChunk',
    'runHumanStatusRebuildChunk',
    'runQueueRebuildChunk',
    'runPostingRebuildChunk',
    'runSummaryRebuildChunk',
  ]) {
    expect(getFunctionSource(functionName)).toContain("writeMode: 'idempotent-output'")
  }
})

test('status rebuild chunks update serving rows without emitting patch rows', () => {
  const source = readFileSync(join(import.meta.dir, 'reviewServingProjectorWorker.ts'), 'utf8')
  const getFunctionSource = (functionName: string) => {
    const start = source.indexOf(`const ${functionName} = async`)
    const end = source.indexOf('\nconst ', start + 1)

    expect(start).toBeGreaterThanOrEqual(0)

    return source.slice(start, end === -1 ? undefined : end)
  }

  expect(getFunctionSource('runLlmStatusRebuildChunk')).toContain('emitPatchRows: false')
  expect(getFunctionSource('runHumanStatusRebuildChunk')).toContain('emitPatchRows: false')
})

test('selected import runner releases dirty work while base projection is still batching', async () => {
  const runStatements: string[] = []
  const selectedImportRows = new Array(512).fill(null).map((_, index) => {
    return {
      articleId: `article-${index}`,
      articleTitle: `Article ${index}`,
      conflictFlag: false,
      duplicateFlag: false,
      externalId: `external-${index}`,
      importRouteId: 'route-1',
      journalTitle: 'Journal',
      publicationYear: 2026,
      rankKeySort: `rank-${index}`,
      rankNumericSort: index,
      selectedRankKey: `rank-${index}`,
      selectedRankNumeric: index,
      sourceRecordKey: `source-${index}`,
      tombstone: false,
    }
  })
  const database: TestDatabase = {
    queryJson: async <T>(statement: string) => {
      if (statement.includes('FROM app.review_projection_identity_manifest')) {
        return [
          {
            baseGeneration: 3,
            definitionVersion: 'selected-import-v1',
            inputDigest: 'digest-1',
            inputWatermark: 7,
            inputWatermarksJson: {importRunArticle: 7},
            invalidationReason: 'import',
            manifestId: 'manifest-1',
            patchRangeEnd: 7,
            patchRangeStart: 4,
            patchWatermark: 7,
            projectId: 'project-1',
            projectionComponent: 'selectedImport',
            projectionIdentity: 'selectedImport:project-1',
            promptConfigHash: null,
            reviewConfigHash: 'review-config-1',
            status: 'candidate',
          },
        ] as T[]
      }

      if (statement.includes('FROM app.review_serving_snapshot_manifest')) {
        return [
          {
            componentStateJson: {
              optional: [],
              required: [
                {
                  baseGeneration: '3',
                  component: 'projectScope',
                  patchWatermark: '7',
                  projectionIdentity: 'projectScope:project-1',
                },
                {
                  baseGeneration: '3',
                  component: 'selectedImport',
                  patchWatermark: '7',
                  projectionIdentity: 'selectedImport:project-1',
                },
              ],
            },
            reviewConfigHash: 'review-config-1',
            selectedImportSnapshotId: 'selected-import-snapshot-1',
            snapshotId: 'snapshot-1',
          },
        ] as T[]
      }

      if (statement.includes('WITH selected_import_candidates')) {
        return selectedImportRows as T[]
      }

      if (statement.includes('FROM app.review_selected_import_snapshot')) {
        return [{cursorJson: null, sourceDeltaHighWater: 7, status: 'candidate'}] as T[]
      }

      return [] as T[]
    },
    run: async (statement: string) => {
      runStatements.push(statement)
    },
    transaction: async <T>(operation: (tx: TestDatabase) => Promise<T>) => {
      return operation(database)
    },
  }
  const claims: ReviewServingDirtyWorkClaim[] = [
    {
      articleId: null,
      dirtyKind: 'importRunArticleDelta',
      dirtyRangeEnd: null,
      dirtyRangeStart: null,
      dirtyWorkId: 'dirty-work-1',
      firstSourceHighWaterMark: 4,
      latestDeltaId: 'delta-7',
      latestSourceHighWaterMark: 7,
      projectId: 'project-1',
      projectionComponent: 'selectedImport',
      projectionIdentity: 'selectedImport:project-1',
      scopeId: 'project-1',
      scopeKind: 'project',
      sourcePartition: 'import_run_article_delta:project-1',
      status: 'running',
    },
  ]
  const runner = getDefaultReviewServingProjectorRunners(database).selectedImport
  const result = await runner?.({claims, component: 'selectedImport', wakeId: 'wake-1'})

  expect(result).toEqual({processedCount: 512})
  expect(
    runStatements.some((statement) => {
      return statement.includes('INSERT INTO app.review_selected_article_import_v4')
    }),
  ).toBe(true)
  expect(
    runStatements.some((statement) => {
      return (
        statement.includes('INSERT INTO app.review_selected_import_snapshot')
        || statement.includes('UPDATE app.review_selected_import_snapshot')
      )
    }),
  ).toBe(true)
  expect(
    runStatements.some((statement) => {
      return statement.includes('UPDATE app.review_serving_dirty_work') && statement.includes("SET status = 'pending'")
    }),
  ).toBe(true)
  expect(
    runStatements.some((statement) => {
      return statement.includes('mart.review_selected_import_patch_v4')
    }),
  ).toBe(false)
})

test('worker default dependencies discover chunks and cleanup targets instead of no-op defaults', () => {
  const source = readFileSync(join(import.meta.dir, 'reviewServingProjectorWorker.ts'), 'utf8')

  expect(source).toContain('getNextClaimableReviewServingRebuildChunk')
  expect(source).toContain('getReviewServingRetentionCleanupTargets')
  expect(source).toContain('runReviewServingProjectorWorkerClaimedRebuildChunk')
  expect(source).not.toContain('getNextChunk: async () => {\n      return null')
  expect(source).not.toContain("runClaimedChunk: async () => {\n      return {status: 'completed'}")
})

test('DuckDB OOM split chunks do not reuse inclusive boundary starts', () => {
  const source = readFileSync(join(import.meta.dir, 'reviewServingProjectorWorker.ts'), 'utf8')

  expect(source).toContain('chunkStartKey: formatUuidArticleId(index === 0 ? start : previousEnd + 1n)')
  expect(source).toContain("previous_scoped_end_key || ' '")
  expect(source).not.toContain('COALESCE(previous_scoped_end_key')
})

test('request snapshot targets match null-snapshot chunks by component generation', () => {
  const source = readFileSync(join(import.meta.dir, 'reviewServingProjectorWorker.ts'), 'utf8')
  const start = source.indexOf('const getRebuildRequestSnapshotTargets = async')
  const end = source.indexOf('\nconst getRebuildRequestSnapshotReductionTargets', start)
  const targetSource = source.slice(start, end)

  expect(targetSource).toContain(
    "CAST(json_extract_string(state.value, '$.baseGeneration') AS BIGINT) = chunk.output_base_generation",
  )
  expect(targetSource).toContain('AS hasSummaryRebuildChunks')
  expect(targetSource).toContain('AS hasPostingRebuildChunks')
  expect(targetSource).toContain("summary_chunk.projection_component = 'summary'")
  expect(targetSource).toContain("posting_chunk.projection_component = 'posting'")
  expect(targetSource).toContain(
    "CAST(json_extract_string(summary_state.value, '$.baseGeneration') AS BIGINT) = summary_chunk.output_base_generation",
  )
  expect(targetSource).toContain(
    "CAST(json_extract_string(posting_state.value, '$.baseGeneration') AS BIGINT) = posting_chunk.output_base_generation",
  )
})

test('display rebuild chunk executor writes bounded base rows and completes the chunk', async () => {
  const statements: string[] = []
  const displayChunk = {
    ...chunkManifest,
    chunkEndKey: 'article-099',
    chunkStartKey: 'article-001',
    outputBaseGeneration: 7,
    projectionComponent: 'display' as const,
    projectionIdentity: 'display:project-1',
  }
  const componentState = {
    optional: [],
    required: [
      {baseGeneration: '7', component: 'projectScope', projectionIdentity: 'projectScope:project-1'},
      {baseGeneration: '7', component: 'selectedImport', projectionIdentity: 'selectedImport:project-1'},
      {baseGeneration: '7', component: 'display', projectionIdentity: 'display:project-1'},
      {baseGeneration: '7', component: 'llmStatus', projectionIdentity: 'llmStatus:project-1'},
      {baseGeneration: '7', component: 'humanStatus', projectionIdentity: 'humanStatus:project-1'},
      {baseGeneration: '7', component: 'posting', projectionIdentity: 'posting:project-1'},
      {baseGeneration: '7', component: 'summary', projectionIdentity: 'summary:project-1'},
      {baseGeneration: '7', component: 'payload', projectionIdentity: 'payload:project-1'},
    ],
  }
  const database: TestDatabase = {
    queryJson: async <T>(statement: string) => {
      statements.push(statement)

      if (statement.includes('FROM app.review_rebuild_chunk_manifest')) {
        return [displayChunk] as T[]
      }

      if (statement.includes('FROM app.review_serving_snapshot_manifest')) {
        return [
          {
            componentStateJson: componentState,
            reviewConfigHash: 'review-config-1',
            selectedImportSnapshotId: 'selected-import-snapshot-1',
            snapshotId: 'snapshot-display-1',
          },
        ] as T[]
      }

      if (statement.includes('FROM mart.project_scope_article scope')) {
        return [
          {
            activitySortAt: '2026-06-16T10:00:00.000Z',
            articleExternalId: 'external-1',
            articleId: 'article-050',
            articleTitle: 'Article 50',
            conflictFlag: false,
            duplicateFlag: false,
            fullTextPdf: null,
            journalTitle: 'Journal',
            publicationYear: 2026,
            selectedImportRouteId: 'route-1',
            selectedRankKey: 'rank-1',
            sortKey: '2026-06-16T10:00:00.000Z',
            url: null,
          },
        ] as T[]
      }

      if (statement.includes('FROM mart.review_article_serving_v4 serving')) {
        return [{actualChecksum: 'checksum-display-1', actualCount: 4}] as T[]
      }

      return [] as T[]
    },
    run: async (statement: string) => {
      statements.push(statement)
    },
    transaction: async <T>(operation: (tx: TestDatabase) => Promise<T>) => {
      return operation(database)
    },
  }

  const result = await runReviewServingProjectorWorkerClaimedRebuildChunk(
    {chunk: displayChunk, leaseOwner: 'worker-1'},
    database,
  )
  const joined = statements.join('\n')

  expect(result).toEqual({status: 'completed'})
  expect(joined).toContain('INSERT INTO mart.review_article_serving_v4')
  expect(joined).toContain("scope.article_id >= 'article-001'")
  expect(joined).toContain("scope.article_id <= 'article-099'")
  expect(joined).toContain('FROM mart.review_article_serving_v4 serving')
  expect(joined).toContain("checksum = 'checksum-display-1'")
  expect(joined).not.toContain('string_agg(')
  expect(joined).toContain('actual_output_rows = 4')
  expect(joined).toContain('duration_ms =')
  expect(joined).toContain('"validationMode":"cheap-count"')
})

test('debug rebuild validation mode forces full checksum for chunks without expected checksums', async () => {
  const previousValue = process.env.FORSKA_REVIEW_SERVING_REBUILD_STRICT_VALIDATION
  const statements: string[] = []
  const displayChunk = {
    ...chunkManifest,
    chunkEndKey: 'article-099',
    chunkStartKey: 'article-001',
    outputBaseGeneration: 7,
    projectionComponent: 'display' as const,
    projectionIdentity: 'display:project-1',
  }
  const componentState = {
    optional: [],
    required: [
      {baseGeneration: '7', component: 'projectScope', projectionIdentity: 'projectScope:project-1'},
      {baseGeneration: '7', component: 'selectedImport', projectionIdentity: 'selectedImport:project-1'},
      {baseGeneration: '7', component: 'display', projectionIdentity: 'display:project-1'},
      {baseGeneration: '7', component: 'llmStatus', projectionIdentity: 'llmStatus:project-1'},
      {baseGeneration: '7', component: 'humanStatus', projectionIdentity: 'humanStatus:project-1'},
      {baseGeneration: '7', component: 'posting', projectionIdentity: 'posting:project-1'},
      {baseGeneration: '7', component: 'summary', projectionIdentity: 'summary:project-1'},
      {baseGeneration: '7', component: 'payload', projectionIdentity: 'payload:project-1'},
    ],
  }
  const database: TestDatabase = {
    queryJson: async <T>(statement: string) => {
      statements.push(statement)

      if (statement.includes('FROM app.review_rebuild_chunk_manifest')) {
        return [displayChunk] as T[]
      }

      if (statement.includes('FROM app.review_serving_snapshot_manifest')) {
        return [
          {
            componentStateJson: componentState,
            reviewConfigHash: 'review-config-1',
            selectedImportSnapshotId: 'selected-import-snapshot-1',
            snapshotId: 'snapshot-display-1',
          },
        ] as T[]
      }

      if (statement.includes('FROM mart.project_scope_article scope')) {
        return [] as T[]
      }

      if (statement.includes('FROM mart.review_article_serving_v4 serving')) {
        expect(statement).toContain('string_agg(')

        return [{actualChecksum: 'checksum-display-debug', actualCount: 4}] as T[]
      }

      return [] as T[]
    },
    run: async (statement: string) => {
      statements.push(statement)
    },
    transaction: async <T>(operation: (tx: TestDatabase) => Promise<T>) => {
      return operation(database)
    },
  }

  try {
    process.env.FORSKA_REVIEW_SERVING_REBUILD_STRICT_VALIDATION = 'true'

    const result = await runReviewServingProjectorWorkerClaimedRebuildChunk(
      {chunk: displayChunk, leaseOwner: 'worker-1'},
      database,
    )
    const joined = statements.join('\n')

    expect(result).toEqual({status: 'completed'})
    expect(joined).toContain('string_agg(')
    expect(joined).not.toContain("sha256('cheap-count:'")
    expect(joined).toContain("checksum = 'checksum-display-debug'")
    expect(joined).toContain('"validationMode":"debug-strict-checksum"')
  } finally {
    if (previousValue === undefined) {
      delete process.env.FORSKA_REVIEW_SERVING_REBUILD_STRICT_VALIDATION
    } else {
      process.env.FORSKA_REVIEW_SERVING_REBUILD_STRICT_VALIDATION = previousValue
    }
  }
})

test('expected-checksum rebuild chunk keeps strict checksum validation', async () => {
  const statements: string[] = []
  const displayChunk: ReviewServingRebuildChunkManifest = {
    ...chunkManifest,
    checksum: 'expected-display-checksum',
    outputBaseGeneration: 7,
    projectionComponent: 'display',
    projectionIdentity: 'display:project-1',
  }
  const componentState = {
    optional: [],
    required: [
      {baseGeneration: '7', component: 'projectScope', projectionIdentity: 'projectScope:project-1'},
      {baseGeneration: '7', component: 'selectedImport', projectionIdentity: 'selectedImport:project-1'},
      {baseGeneration: '7', component: 'display', projectionIdentity: 'display:project-1'},
      {baseGeneration: '7', component: 'llmStatus', projectionIdentity: 'llmStatus:project-1'},
      {baseGeneration: '7', component: 'humanStatus', projectionIdentity: 'humanStatus:project-1'},
      {baseGeneration: '7', component: 'posting', projectionIdentity: 'posting:project-1'},
      {baseGeneration: '7', component: 'summary', projectionIdentity: 'summary:project-1'},
      {baseGeneration: '7', component: 'payload', projectionIdentity: 'payload:project-1'},
    ],
  }
  const database: TestDatabase = {
    queryJson: async <T>(statement: string) => {
      statements.push(statement)

      if (statement.includes('FROM app.review_rebuild_chunk_manifest')) {
        return [displayChunk] as T[]
      }

      if (statement.includes('FROM app.review_serving_snapshot_manifest')) {
        return [
          {
            componentStateJson: componentState,
            reviewConfigHash: 'review-config-1',
            selectedImportSnapshotId: 'selected-import-snapshot-1',
            snapshotId: 'snapshot-display-1',
          },
        ] as T[]
      }

      if (statement.includes('FROM mart.project_scope_article scope')) {
        return [] as T[]
      }

      if (statement.includes('FROM mart.review_article_serving_v4 serving')) {
        expect(statement).toContain('string_agg(')

        return [{actualChecksum: 'expected-display-checksum', actualCount: 4}] as T[]
      }

      return [] as T[]
    },
    run: async (statement: string) => {
      statements.push(statement)
    },
    transaction: async <T>(operation: (tx: TestDatabase) => Promise<T>) => {
      return operation(database)
    },
  }

  const result = await runReviewServingProjectorWorkerClaimedRebuildChunk(
    {chunk: displayChunk, leaseOwner: 'worker-1'},
    database,
  )
  const joined = statements.join('\n')

  expect(result).toEqual({status: 'completed'})
  expect(joined).toContain('string_agg(')
  expect(joined).not.toContain("sha256('cheap-count:'")
  expect(joined).toContain('"validationMode":"strict-checksum"')
})

test('strict posting rebuild validation rescans output instead of reusing projector checksum', async () => {
  const previousValue = process.env.FORSKA_REVIEW_SERVING_REBUILD_STRICT_VALIDATION
  const statements: string[] = []
  const postingChunk: ReviewServingRebuildChunkManifest = {
    ...chunkManifest,
    outputBaseGeneration: 7,
    projectionComponent: 'posting',
    projectionIdentity: 'posting:project-1',
  }
  const componentState = {
    optional: [],
    required: [
      {baseGeneration: '7', component: 'projectScope', projectionIdentity: 'projectScope:project-1'},
      {baseGeneration: '7', component: 'selectedImport', projectionIdentity: 'selectedImport:project-1'},
      {baseGeneration: '7', component: 'posting', projectionIdentity: 'posting:project-1'},
    ],
  }
  const database: TestDatabase = {
    queryJson: async <T>(statement: string) => {
      statements.push(statement)

      if (statement.includes('FROM app.review_rebuild_chunk_manifest')) {
        return [postingChunk] as T[]
      }

      if (statement.includes('FROM app.review_projection_identity_manifest')) {
        return [
          {
            baseGeneration: postingChunk.outputBaseGeneration,
            definitionVersion: 'posting-v1',
            inputDigest: postingChunk.inputDigest,
            inputWatermark: postingChunk.inputWatermark,
            inputWatermarksJson: {reviewChange: 9},
            invalidationReason: postingChunk.inputDigest,
            manifestId: 'manifest-posting',
            patchRangeEnd: postingChunk.inputWatermark,
            patchRangeStart: postingChunk.inputWatermark,
            patchWatermark: postingChunk.inputWatermark,
            projectId: postingChunk.projectId,
            projectionComponent: postingChunk.projectionComponent,
            projectionIdentity: postingChunk.projectionIdentity,
            promptConfigHash: null,
            reviewConfigHash: 'review-config-1',
            status: 'candidate',
          },
        ] as T[]
      }

      if (statement.includes('FROM app.review_serving_snapshot_manifest')) {
        return [
          {
            componentStateJson: componentState,
            reviewConfigHash: 'review-config-1',
            selectedImportSnapshotId: 'selected-import-snapshot-1',
            snapshotId: 'snapshot-posting-1',
          },
        ] as T[]
      }

      if (
        statement.includes('AS actualChecksum')
        && statement.includes('FROM mart.review_article_filter_posting_serving_v4 serving')
      ) {
        if (statement.includes("sha256('cheap-count:'")) {
          return [{actualChecksum: 'checksum-posting-count', actualCount: 1}] as T[]
        }

        expect(statement).toContain('string_agg(')

        return [{actualChecksum: 'checksum-posting-strict', actualCount: 1}] as T[]
      }

      return [] as T[]
    },
    run: async (statement: string) => {
      statements.push(statement)
    },
    transaction: async <T>(operation: (tx: TestDatabase) => Promise<T>) => {
      return operation(database)
    },
  }

  try {
    process.env.FORSKA_REVIEW_SERVING_REBUILD_STRICT_VALIDATION = 'true'

    const result = await runReviewServingProjectorWorkerClaimedRebuildChunk(
      {chunk: postingChunk, leaseOwner: 'worker-1'},
      database,
    )
    const joined = statements.join('\n')

    expect(result).toEqual({status: 'completed'})
    expect(postingChunk.requestId).toBeNull()
    expect(joined).toContain('string_agg(')
    expect(joined).toContain('DELETE FROM mart.review_filter_posting_stats_v4 stats')
    expect(joined).toContain('INSERT INTO mart.review_filter_posting_stats_v4')
    expect(joined).toContain('"validationMode":"debug-strict-checksum"')
    expect(joined).not.toContain('"validationMode":"reused-source-posting-checksum"')
  } finally {
    if (previousValue === undefined) {
      delete process.env.FORSKA_REVIEW_SERVING_REBUILD_STRICT_VALIDATION
    } else {
      process.env.FORSKA_REVIEW_SERVING_REBUILD_STRICT_VALIDATION = previousValue
    }
  }
})

test('payload and search rebuild chunk executors write bounded base rows and complete chunks', async () => {
  const statements: string[] = []
  const queryStatements: string[] = []
  const runStatements: string[] = []
  const payloadChunk: ReviewServingRebuildChunkManifest = {
    ...chunkManifest,
    chunkEndKey: 'article-099',
    chunkStartKey: 'article-001',
    outputBaseGeneration: 7,
    projectionComponent: 'payload',
    projectionIdentity: 'payload:project-1',
  }
  const searchChunk: ReviewServingRebuildChunkManifest = {
    ...chunkManifest,
    chunkEndKey: 'article-099',
    chunkStartKey: 'article-001',
    outputBaseGeneration: 7,
    projectionComponent: 'search',
    projectionIdentity: 'search:project-1',
  }
  const componentState = {
    optional: [{baseGeneration: '7', component: 'search', projectionIdentity: 'search:project-1'}],
    required: [
      {baseGeneration: '7', component: 'projectScope', projectionIdentity: 'projectScope:project-1'},
      {baseGeneration: '7', component: 'selectedImport', projectionIdentity: 'selectedImport:project-1'},
      {baseGeneration: '7', component: 'display', projectionIdentity: 'display:project-1'},
      {baseGeneration: '7', component: 'llmStatus', projectionIdentity: 'llmStatus:project-1'},
      {baseGeneration: '7', component: 'humanStatus', projectionIdentity: 'humanStatus:project-1'},
      {baseGeneration: '7', component: 'posting', projectionIdentity: 'posting:project-1'},
      {baseGeneration: '7', component: 'summary', projectionIdentity: 'summary:project-1'},
      {baseGeneration: '7', component: 'payload', projectionIdentity: 'payload:project-1'},
    ],
  }
  let activeChunk = payloadChunk
  const database: TestDatabase = {
    queryJson: async <T>(statement: string) => {
      statements.push(statement)
      queryStatements.push(statement)

      if (statement.includes('FROM app.review_rebuild_chunk_manifest')) {
        return [activeChunk] as T[]
      }

      if (statement.includes('FROM app.review_serving_snapshot_manifest')) {
        return [
          {
            componentStateJson: componentState,
            reviewConfigHash: 'review-config-1',
            selectedImportSnapshotId: 'selected-import-snapshot-1',
            snapshotId: 'snapshot-rebuild-1',
          },
        ] as T[]
      }

      if (statement.includes('LEFT(article.article_summary')) {
        return [
          {
            abstractText: 'Abstract',
            articleCreatedAt: '2026-06-16T10:00:00.000Z',
            articleId: 'article-050',
            fullTextPreview: 'Full text',
            payloadBytes: 15,
            sourceMetadata: null,
          },
        ] as T[]
      }

      if (statement.includes('article.id IS NULL OR NOT')) {
        return [
          {
            activitySortAt: '2026-06-16T10:00:00.000Z',
            articleId: 'article-050',
            articleTitle: 'Search Title',
            tombstone: false,
          },
        ] as T[]
      }

      if (statement.includes('FROM mart.review_article_serving_payload_v4 payload')) {
        return [{actualChecksum: 'checksum-payload-1', actualCount: 1}] as T[]
      }

      if (statement.includes('FROM mart.review_title_search_serving_v4 search')) {
        return [{actualChecksum: 'checksum-search-1', actualCount: 2}] as T[]
      }

      return [] as T[]
    },
    run: async (statement: string) => {
      statements.push(statement)
      runStatements.push(statement)
    },
    transaction: async <T>(operation: (tx: TestDatabase) => Promise<T>) => {
      return operation(database)
    },
  }

  const payloadResult = await runReviewServingProjectorWorkerClaimedRebuildChunk(
    {chunk: payloadChunk, leaseOwner: 'worker-1'},
    database,
  )
  activeChunk = searchChunk
  const searchResult = await runReviewServingProjectorWorkerClaimedRebuildChunk(
    {chunk: searchChunk, leaseOwner: 'worker-1'},
    database,
  )
  const joined = statements.join('\n')
  const joinedQueries = queryStatements.join('\n')
  const joinedRuns = runStatements.join('\n')

  expect(payloadResult).toEqual({status: 'completed'})
  expect(searchResult).toEqual({status: 'completed'})
  expect(joined).toContain('INSERT INTO mart.review_article_serving_payload_v4')
  expect(joined).toContain('INSERT INTO mart.review_title_search_serving_v4')
  expect(joined).toContain("scope.article_id >= 'article-001'")
  expect(joined).toContain("scope.article_id <= 'article-099'")
  expect(joinedRuns).toContain('CROSS JOIN unnest(regexp_split_to_array')
  expect(joinedRuns).toContain('INSERT INTO mart.review_title_search_serving_v4')
  expect(joinedQueries).not.toContain('article.id IS NULL OR NOT (scope.in_curated_scope OR scope.in_route_scope)')
  expect(joined).toContain("checksum = 'checksum-payload-1'")
  expect(joined).toContain("checksum = 'checksum-search-1'")
})

test('fresh project scope rebuild writes base scope without synthetic dirty patch fanout', async () => {
  const statements: string[] = []
  const projectScopeChunk: ReviewServingRebuildChunkManifest = {
    ...chunkManifest,
    chunkId: 'chunk-project-scope-bootstrap',
    inputDigest: 'freshReviewServingSnapshot',
    inputWatermark: 9,
    outputBaseGeneration: 0,
    projectionComponent: 'projectScope',
    projectionIdentity: 'projectScope:project-1',
  }
  const database: TestDatabase = {
    queryJson: async <T>(statement: string) => {
      statements.push(statement)

      if (statement.includes('FROM app.review_rebuild_chunk_manifest')) {
        return [projectScopeChunk] as T[]
      }

      if (statement.includes('FROM app.review_projection_identity_manifest')) {
        return [
          {
            baseGeneration: projectScopeChunk.outputBaseGeneration,
            definitionVersion: 'projectScope:dirty-claim-seed-v1',
            inputDigest: projectScopeChunk.inputDigest,
            inputWatermark: projectScopeChunk.inputWatermark,
            inputWatermarksJson: {reviewChange: 9},
            invalidationReason: 'missingReviewServingSnapshot',
            manifestId: 'manifest-project-scope-bootstrap',
            patchRangeEnd: projectScopeChunk.inputWatermark,
            patchRangeStart: 0,
            patchWatermark: 0,
            projectId: projectScopeChunk.projectId,
            projectionComponent: projectScopeChunk.projectionComponent,
            projectionIdentity: projectScopeChunk.projectionIdentity,
            promptConfigHash: null,
            reviewConfigHash: 'review-config-1',
            status: 'candidate',
          },
        ] as T[]
      }

      if (statement.includes('FROM mart.project_scope_article')) {
        return [{actualChecksum: 'checksum-project-scope-bootstrap', actualCount: 1}] as T[]
      }

      return [] as T[]
    },
    run: async (statement: string) => {
      statements.push(statement)
    },
    transaction: async <T>(operation: (tx: TestDatabase) => Promise<T>) => {
      return operation(database)
    },
  }

  const result = await runReviewServingProjectorWorkerClaimedRebuildChunk(
    {chunk: projectScopeChunk, leaseOwner: 'worker-1'},
    database,
  )
  const joined = statements.join('\n')
  const projectScopeWriteStatement =
    statements.find((statement) => {
      return statement.includes('DELETE FROM mart.project_scope_article')
    }) ?? ''
  const projectScopeValidationStatement =
    statements.find((statement) => {
      return statement.includes('FROM mart.project_scope_article scope')
    }) ?? ''

  expect(result).toEqual({status: 'completed'})
  expect(joined).toContain('DELETE FROM mart.project_scope_article')
  expect(joined).toContain('INSERT INTO mart.project_scope_article')
  expect(projectScopeWriteStatement).toContain("scope.article_id >= 'article-001'")
  expect(projectScopeWriteStatement).toContain("scope.article_id <= 'article-099'")
  expect(projectScopeWriteStatement).toContain("article_import_route.article_id >= 'article-001'")
  expect(projectScopeWriteStatement).toContain("article_import_route.article_id <= 'article-099'")
  expect(projectScopeWriteStatement).toContain("project_article.article_id >= 'article-001'")
  expect(projectScopeWriteStatement).toContain("project_article.article_id <= 'article-099'")
  expect(projectScopeWriteStatement).toContain("aggregated_scope.article_id >= 'article-001'")
  expect(projectScopeWriteStatement).toContain("aggregated_scope.article_id <= 'article-099'")
  expect(projectScopeValidationStatement).toContain("scope.article_id >= 'article-001'")
  expect(projectScopeValidationStatement).toContain("scope.article_id <= 'article-099'")
  expect(joined).not.toContain('INSERT INTO app.review_projection_identity_manifest')
  expect(joined).not.toContain('UPDATE app.review_serving_dirty_work')
  expect(joined).toContain("checksum = 'checksum-project-scope-bootstrap'")
})

test('status queue posting summary and judgment detail rebuild chunk executors complete bounded chunks', async () => {
  const statements: string[] = []
  const components = ['llmStatus', 'humanStatus', 'queue', 'posting', 'summary', 'judgmentInputContent'] as const
  const componentState = {
    optional: [{baseGeneration: '7', component: 'search', projectionIdentity: 'search:project-1'}],
    required: [
      {baseGeneration: '7', component: 'projectScope', projectionIdentity: 'projectScope:project-1'},
      {baseGeneration: '7', component: 'selectedImport', projectionIdentity: 'selectedImport:project-1'},
      {baseGeneration: '7', component: 'display', projectionIdentity: 'display:project-1'},
      {baseGeneration: '7', component: 'judgmentInputContent', projectionIdentity: 'judgmentInputContent:project-1'},
      {baseGeneration: '7', component: 'llmStatus', projectionIdentity: 'llmStatus:project-1'},
      {baseGeneration: '7', component: 'humanStatus', projectionIdentity: 'humanStatus:project-1'},
      {baseGeneration: '7', component: 'queue', projectionIdentity: 'queue:project-1'},
      {baseGeneration: '7', component: 'posting', projectionIdentity: 'posting:project-1'},
      {baseGeneration: '7', component: 'summary', projectionIdentity: 'summary:project-1'},
      {baseGeneration: '7', component: 'payload', projectionIdentity: 'payload:project-1'},
    ],
  }
  const chunks = components.map((component) => {
    return {
      ...chunkManifest,
      chunkId: `chunk-${component}`,
      outputBaseGeneration: 7,
      projectionComponent: component,
      projectionIdentity: `${component}:project-1`,
      requestId: component === 'summary' ? 'rebuild-summary-executor' : chunkManifest.requestId,
    } satisfies ReviewServingRebuildChunkManifest
  })
  let activeChunk: ReviewServingRebuildChunkManifest = chunks[0] ?? chunkManifest
  const projectSettings = {
    humanJudgmentMode: 'prompt' as const,
    modelExecutionOptions: null,
    modelId: 'model-1',
    modelProviderBaseUrl: null,
    modelProviderConnectionId: null,
    modelProviderKind: null,
    modelRemoteModelId: null,
    modelVariant: null,
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  }
  const reviewConfigHash = buildReviewConfigHash({
    humanJudgmentMode: projectSettings.humanJudgmentMode,
    modelExecutionIdentity: {
      modelExecutionOptions: null,
      modelId: projectSettings.modelId,
      providerBaseUrl: projectSettings.modelProviderBaseUrl,
      providerConnectionId: projectSettings.modelProviderConnectionId,
      providerKind: projectSettings.modelProviderKind,
      remoteModelId: projectSettings.modelRemoteModelId,
      variant: projectSettings.modelVariant,
    },
    modelId: projectSettings.modelId,
    promptConfigs: [],
    useAbstract: projectSettings.useAbstract,
    useFulltext: projectSettings.useFulltext,
    useFulltextNoImages: projectSettings.useFulltextNoImages,
    useTitle: projectSettings.useTitle,
  })
  const database: TestDatabase = {
    queryJson: async <T>(statement: string) => {
      statements.push(statement)

      if (statement.includes('FROM app.review_rebuild_chunk_manifest')) {
        return [activeChunk] as T[]
      }

      if (statement.includes('FROM app.review_projection_identity_manifest')) {
        return [
          {
            baseGeneration: activeChunk.outputBaseGeneration,
            definitionVersion: `${activeChunk.projectionComponent}-v1`,
            inputDigest: activeChunk.inputDigest,
            inputWatermark: activeChunk.inputWatermark,
            inputWatermarksJson: {importRunArticle: 7, reviewChange: 9},
            invalidationReason: activeChunk.inputDigest,
            manifestId: `manifest-${activeChunk.projectionComponent}`,
            patchRangeEnd: activeChunk.inputWatermark,
            patchRangeStart: activeChunk.inputWatermark,
            patchWatermark: activeChunk.inputWatermark,
            projectId: activeChunk.projectId,
            projectionComponent: activeChunk.projectionComponent,
            projectionIdentity: activeChunk.projectionIdentity,
            promptConfigHash: null,
            reviewConfigHash,
            status: 'candidate',
          },
        ] as T[]
      }

      if (statement.includes('FROM app.review_serving_snapshot_manifest')) {
        return [
          {
            componentStateJson: componentState,
            reviewConfigHash,
            selectedImportSnapshotId: 'selected-import-snapshot-1',
            snapshotId: 'snapshot-rebuild-1',
          },
        ] as T[]
      }

      if (statement.includes('AS actualChecksum') && statement.includes('llm_status_identity')) {
        return [{actualChecksum: 'checksum-llm-status', actualCount: 1}] as T[]
      }

      if (statement.includes('AS actualChecksum') && statement.includes('human_status_identity')) {
        return [{actualChecksum: 'checksum-human-status', actualCount: 1}] as T[]
      }

      if (
        statement.includes('AS actualChecksum')
        && statement.includes('FROM mart.review_unassessed_queue_serving_v4 serving')
      ) {
        return [{actualChecksum: 'checksum-queue', actualCount: 1}] as T[]
      }

      if (
        statement.includes('AS actualChecksum')
        && statement.includes('FROM mart.review_article_filter_posting_serving_v4 serving')
      ) {
        return [{actualChecksum: 'checksum-posting', actualCount: 1}] as T[]
      }

      if (statement.includes('AS actualChecksum') && statement.includes('WITH output_row')) {
        return [{actualChecksum: 'checksum-summary', actualCount: 1}] as T[]
      }

      if (
        statement.includes('AS actualChecksum')
        && statement.includes('FROM mart.review_article_judgment_detail_serving_v4 detail')
      ) {
        return [{actualChecksum: 'checksum-judgment-detail', actualCount: 1}] as T[]
      }

      if (statement.includes('FROM app.project project') && statement.includes('LIMIT 1')) {
        return [projectSettings] as T[]
      }

      return [] as T[]
    },
    run: async (statement: string) => {
      statements.push(statement)
    },
    transaction: async <T>(operation: (tx: TestDatabase) => Promise<T>) => {
      statements.push(`BEGIN ${activeChunk.projectionComponent}`)

      return operation(database)
    },
  }

  const results = await chunks.reduce<Promise<Array<{status: 'completed'}>>>(async (previous, chunk) => {
    const priorResults = await previous
    activeChunk = chunk
    const result = await runReviewServingProjectorWorkerClaimedRebuildChunk({chunk, leaseOwner: 'worker-1'}, database)

    return [...priorResults, result]
  }, Promise.resolve([]))
  const joined = statements.join('\n')
  const filterOptionDeletes = statements.filter((statement) => {
    return statement.includes('DELETE FROM mart.review_filter_option_serving_v4')
  })

  expect(results).toEqual(
    components.map(() => {
      return {status: 'completed'}
    }),
  )
  expect(joined).toContain('llm_status_identity')
  expect(joined).toContain('human_status_identity')
  expect(joined).toContain('DELETE FROM mart.review_unassessed_queue_serving_v4')
  expect(joined).toContain('DELETE FROM mart.review_article_filter_posting_serving_v4 serving')
  expect(filterOptionDeletes).toHaveLength(0)
  expect(joined).toContain('"summaryProjectorSnapshots"')
  expect(joined).toContain('DELETE FROM mart.review_article_judgment_detail_serving_v4')
  expect(joined).toContain('"judgmentPayloadProjectorSnapshots"')
  expect(joined).toContain("article_id >= 'article-001'")
  expect(joined).toContain("article_id <= 'article-099'")
  expect(
    statements.filter((statement) => {
      return statement === 'BEGIN judgmentInputContent'
    }).length,
  ).toBe(3)
})

test('worker refreshes summary filter options when an active-snapshot summary request is finalized', async () => {
  const harness = createWorkerHarness()
  const statements: string[] = []
  const requestId = 'rebuild-summary-finalize'
  const summaryChunkInput = {
    ...chunkInput,
    outputBaseGeneration: 7,
    projectionComponent: 'summary' as const,
    projectionIdentity: 'summary:project-1',
    requestId,
  }
  const summaryChunk = {
    ...chunkManifest,
    ...summaryChunkInput,
    chunkId: 'chunk-summary-finalize',
    requestId,
  } satisfies ReviewServingRebuildChunkManifest
  const componentState = {
    optional: [{baseGeneration: '7', component: 'search', projectionIdentity: 'search:project-1'}],
    required: [
      {baseGeneration: '7', component: 'projectScope', projectionIdentity: 'projectScope:project-1'},
      {baseGeneration: '7', component: 'selectedImport', projectionIdentity: 'selectedImport:project-1'},
      {baseGeneration: '7', component: 'summary', projectionIdentity: 'summary:project-1'},
    ],
  }

  harness.dependencies.rebuildChunkService = {
    ...harness.dependencies.rebuildChunkService,
    claimChunk: async (claimInput) => {
      harness.claimInputs.push(claimInput)

      return summaryChunk
    },
    getNextChunk: async (getNextInput) => {
      harness.getNextChunkInputs.push(getNextInput)

      return summaryChunkInput
    },
    runClaimedChunk: async ({chunk}) => {
      harness.runChunkInputs.push(chunk)

      return {status: 'completed' as const}
    },
  } as ReviewServingProjectorWorkerDependencies['rebuildChunkService']
  harness.database.queryJson = async <T>(statement: string) => {
    statements.push(statement)

    if (statement.includes('COUNT(*) AS pendingChunkCount')) {
      return [{pendingChunkCount: 0}] as T[]
    }

    if (statement.includes('output_base_generation AS outputBaseGeneration')) {
      return [
        {
          outputBaseGeneration: summaryChunk.outputBaseGeneration,
          projectId: summaryChunk.projectId,
          projectionIdentity: summaryChunk.projectionIdentity,
        },
      ] as T[]
    }

    if (statement.includes('FROM app.review_projection_identity_manifest')) {
      return [
        {
          baseGeneration: summaryChunk.outputBaseGeneration,
          definitionVersion: 'summary-v1',
          inputDigest: summaryChunk.inputDigest,
          inputWatermark: summaryChunk.inputWatermark,
          inputWatermarksJson: {reviewChange: 9},
          invalidationReason: summaryChunk.inputDigest,
          manifestId: 'manifest-summary',
          patchRangeEnd: summaryChunk.inputWatermark,
          patchRangeStart: summaryChunk.inputWatermark,
          patchWatermark: summaryChunk.inputWatermark,
          projectId: summaryChunk.projectId,
          projectionComponent: summaryChunk.projectionComponent,
          projectionIdentity: summaryChunk.projectionIdentity,
          promptConfigHash: null,
          reviewConfigHash: 'review-config-1',
          status: 'candidate',
        },
      ] as T[]
    }

    if (statement.includes('chunk_snapshot.snapshot_id AS snapshotId') && statement.includes("'candidate', 'active'")) {
      return [
        {projectId: 'project-1', reviewConfigHash: 'review-config-1', snapshotId: 'snapshot-summary-finalize'},
      ] as T[]
    }

    if (statement.includes('chunk_snapshot.snapshot_id AS snapshotId') && statement.includes("'candidate'")) {
      return [] as T[]
    }

    if (statement.includes('FROM app.review_serving_snapshot_manifest')) {
      return [
        {
          componentStateJson: componentState,
          reviewConfigHash: 'review-config-1',
          selectedImportSnapshotId: 'selected-import-snapshot-1',
          snapshotId: 'snapshot-summary-finalize',
        },
      ] as T[]
    }

    if (statement.includes('FROM mart.review_article_serving_v4 serving')) {
      return [] as T[]
    }

    return [] as T[]
  }
  harness.database.run = async (statement: string) => {
    statements.push(statement)
  }

  const result = await runReviewServingProjectorWorkerOnce({workerId: 'worker-1'}, harness.dependencies)
  const filterOptionDeletes = statements.filter((statement) => {
    return statement.includes('DELETE FROM mart.review_filter_option_serving_v4')
  })

  expect(result.chunk).toMatchObject({chunkId: summaryChunk.chunkId, status: 'completed'})
  expect(harness.runChunkInputs).toEqual([summaryChunk])
  expect(filterOptionDeletes).toHaveLength(2)
  expect(statements.join('\n')).toContain('FROM mart.review_article_summary_rebuild_partial_v4')
  expect(statements.join('\n')).toContain('FROM app.review_projection_identity_manifest')
  expect(statements.join('\n')).toContain("status = 'completed'")
})

test('worker refreshes summary filter options before promoting request snapshots', () => {
  const source = readFileSync(join(import.meta.dir, 'reviewServingProjectorWorker.ts'), 'utf8')
  const start = source.indexOf('const finalizeCompletedReviewServingRebuildRequest = async')
  const end = source.indexOf('\nconst getReviewServingProjectorWorkerDatabase', start)
  const finalizerSource = source.slice(start, end)
  const refreshIndex = finalizerSource.indexOf('await refreshSummaryFilterOptionsForProjections')
  const promoteIndex = finalizerSource.indexOf('await promoteReviewServingProjectorSnapshot')

  expect(refreshIndex).toBeGreaterThanOrEqual(0)
  expect(promoteIndex).toBeGreaterThanOrEqual(0)
  expect(refreshIndex).toBeLessThan(promoteIndex)
})

test('worker refreshes posting stats once when a posting rebuild request is finalized', async () => {
  const harness = createWorkerHarness()
  const statements: string[] = []
  const requestId = 'rebuild-posting-finalize'
  const postingChunkInput = {
    ...chunkInput,
    outputBaseGeneration: 7,
    projectionComponent: 'posting' as const,
    projectionIdentity: 'posting:project-1',
    requestId,
    snapshotId: 'snapshot-posting-finalize',
  }
  const postingChunk = {
    ...chunkManifest,
    ...postingChunkInput,
    chunkId: 'chunk-posting-finalize',
    requestId,
  } satisfies ReviewServingRebuildChunkManifest

  harness.dependencies.rebuildChunkService = {
    ...harness.dependencies.rebuildChunkService,
    claimChunk: async (claimInput) => {
      harness.claimInputs.push(claimInput)

      return postingChunk
    },
    getNextChunk: async (getNextInput) => {
      harness.getNextChunkInputs.push(getNextInput)

      return postingChunkInput
    },
    runClaimedChunk: async ({chunk}) => {
      harness.runChunkInputs.push(chunk)

      return {status: 'completed' as const}
    },
  } as ReviewServingProjectorWorkerDependencies['rebuildChunkService']
  harness.database.queryJson = async <T>(statement: string) => {
    statements.push(statement)

    if (statement.includes('COUNT(*) AS pendingChunkCount')) {
      return [{pendingChunkCount: 0}] as T[]
    }

    if (statement.includes('postingChunkCount')) {
      return [{postingChunkCount: 2}] as T[]
    }

    if (statement.includes('chunk_snapshot.snapshot_id AS snapshotId') && statement.includes("'candidate', 'active'")) {
      return [
        {
          hasPostingRebuildChunks: true,
          hasSummaryRebuildChunks: false,
          projectId: postingChunk.projectId,
          reviewConfigHash: 'review-config-1',
          snapshotId: postingChunk.snapshotId,
        },
        {
          hasPostingRebuildChunks: false,
          hasSummaryRebuildChunks: false,
          projectId: postingChunk.projectId,
          reviewConfigHash: null,
          snapshotId: 'snapshot-non-posting-null-config',
        },
      ] as T[]
    }

    if (statement.includes('chunk_snapshot.snapshot_id AS snapshotId') && statement.includes("'candidate'")) {
      return [
        {
          hasPostingRebuildChunks: true,
          hasSummaryRebuildChunks: false,
          projectId: postingChunk.projectId,
          reviewConfigHash: 'review-config-1',
          snapshotId: postingChunk.snapshotId,
        },
      ] as T[]
    }

    return [] as T[]
  }
  harness.database.run = async (statement: string) => {
    statements.push(statement)
  }

  const result = await runReviewServingProjectorWorkerOnce({workerId: 'worker-1'}, harness.dependencies)
  const joined = statements.join('\n')

  expect(result.chunk).toMatchObject({chunkId: postingChunk.chunkId, status: 'completed'})
  expect(joined).toContain('DELETE FROM mart.review_filter_posting_stats_v4 stats')
  expect(joined).toContain('INSERT INTO mart.review_filter_posting_stats_v4')
  expect(joined).toContain('FROM mart.review_article_filter_posting_serving_v4 serving')
  expect(joined).not.toContain('snapshot-non-posting-null-config')
})

test('worker finalizes active-snapshot rebuild requests without promoting active snapshots', async () => {
  const harness = createWorkerHarness()
  const statements: string[] = []
  const requestId = 'rebuild-active-snapshot-finalize'
  const activeChunkInput = {
    ...chunkInput,
    outputBaseGeneration: 7,
    projectionComponent: 'display' as const,
    projectionIdentity: 'display:project-1',
    requestId,
    snapshotId: null,
  }
  const activeChunk = {
    ...chunkManifest,
    ...activeChunkInput,
    chunkId: 'chunk-active-snapshot-finalize',
    requestId,
  } satisfies ReviewServingRebuildChunkManifest

  harness.dependencies.rebuildChunkService = {
    ...harness.dependencies.rebuildChunkService,
    claimChunk: async (claimInput) => {
      harness.claimInputs.push(claimInput)

      return activeChunk
    },
    getNextChunk: async (getNextInput) => {
      harness.getNextChunkInputs.push(getNextInput)

      return activeChunkInput
    },
    runClaimedChunk: async ({chunk}) => {
      harness.runChunkInputs.push(chunk)

      return {status: 'completed' as const}
    },
  } as ReviewServingProjectorWorkerDependencies['rebuildChunkService']
  harness.database.queryJson = async <T>(statement: string) => {
    statements.push(statement)

    if (statement.includes('COUNT(*) AS pendingChunkCount')) {
      return [{pendingChunkCount: 0}] as T[]
    }

    if (statement.includes('chunk_snapshot.snapshot_id AS snapshotId') && statement.includes("'candidate', 'active'")) {
      return [
        {projectId: activeChunk.projectId, reviewConfigHash: 'review-config-1', snapshotId: 'active-snapshot-1'},
      ] as T[]
    }

    if (statement.includes('chunk_snapshot.snapshot_id AS snapshotId') && statement.includes("'candidate'")) {
      return [] as T[]
    }

    return [] as T[]
  }
  harness.database.run = async (statement: string) => {
    statements.push(statement)
  }

  const result = await runReviewServingProjectorWorkerOnce({workerId: 'worker-1'}, harness.dependencies)
  const joined = statements.join('\n')

  expect(result.chunk).toMatchObject({chunkId: activeChunk.chunkId, status: 'completed'})
  expect(joined).toContain("status = 'completed'")
  expect(joined).not.toContain('FROM app.review_serving_snapshot_manifest\n    WHERE project_id')
  expect(joined).not.toContain('candidate snapshot manifest is missing')
})

test('worker adopts requestless summary chunks into request finalization before projection', async () => {
  const harness = createWorkerHarness()
  const statements: string[] = []
  const originalSetInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  const intervalToken = {unref: mock(() => {})}
  const setIntervalMock = mock(() => {
    return intervalToken
  })
  const clearIntervalMock = mock((_token: unknown) => {})
  const summaryChunkInput = {
    ...chunkInput,
    outputBaseGeneration: 7,
    projectionComponent: 'summary' as const,
    projectionIdentity: 'summary:project-1',
    requestId: null,
  }
  const summaryChunk = {
    ...chunkManifest,
    ...summaryChunkInput,
    chunkId: 'chunk-summary-requestless',
    requestId: null,
  } satisfies ReviewServingRebuildChunkManifest
  const requestId = getRequestlessSummaryRangeRebuildRequestId(summaryChunk)
  const adoptedSummaryChunk = {...summaryChunk, requestId}
  let adopted = false
  harness.dependencies.rebuildChunkService = {
    ...harness.dependencies.rebuildChunkService,
    claimChunk: async (claimInput) => {
      harness.claimInputs.push(claimInput)

      return summaryChunk
    },
    getNextChunk: async (getNextInput) => {
      harness.getNextChunkInputs.push(getNextInput)

      return summaryChunkInput
    },
  } as ReviewServingProjectorWorkerDependencies['rebuildChunkService']
  harness.database.queryJson = async <T>(statement: string) => {
    statements.push(statement)

    if (statement.includes('pendingChunkCount')) {
      return [{pendingChunkCount: 1}] as T[]
    }

    if (statement.includes('FROM app.review_rebuild_chunk_manifest')) {
      return [adopted ? adoptedSummaryChunk : summaryChunk] as T[]
    }

    return [] as T[]
  }
  harness.database.run = async (statement: string) => {
    statements.push(statement)
    if (statement.includes('UPDATE app.review_rebuild_chunk_manifest') && statement.includes('request_id =')) {
      adopted = true
    }
  }

  globalThis.setInterval = setIntervalMock as unknown as typeof setInterval
  globalThis.clearInterval = clearIntervalMock as unknown as typeof clearInterval

  const result = await runReviewServingProjectorWorkerOnce({workerId: 'worker-1'}, harness.dependencies).finally(() => {
    globalThis.setInterval = originalSetInterval
    globalThis.clearInterval = originalClearInterval
  })
  const joined = statements.join('\n')

  expect(result.chunk).toMatchObject({chunkId: summaryChunk.chunkId, requestId, status: 'completed'})
  expect(harness.runChunkInputs).toHaveLength(1)
  expect(harness.runChunkInputs[0]).toMatchObject(adoptedSummaryChunk)
  expect(harness.failedChunks).toEqual([])
  expect(joined).toContain('INSERT INTO app.review_rebuild_request')
  expect(joined).toContain('requestless_summary_range_rebuild')
  expect(joined).toContain(`request_id = '${requestId}'`)
  expect(joined).not.toContain("status = 'quarantined'")
  expect(setIntervalMock).toHaveBeenCalledTimes(1)
  expect(clearIntervalMock).toHaveBeenCalledWith(intervalToken)
})

test('claimed requestless summary chunks stage partials through an adopted request', async () => {
  const statements: string[] = []
  const summaryChunk = {
    ...chunkManifest,
    chunkId: 'chunk-summary-requestless-claimed',
    outputBaseGeneration: 7,
    projectionComponent: 'summary' as const,
    projectionIdentity: 'summary:project-1',
    requestId: null,
  } satisfies ReviewServingRebuildChunkManifest
  const requestId = getRequestlessSummaryRangeRebuildRequestId(summaryChunk)
  const adoptedSummaryChunk = {...summaryChunk, requestId}
  const componentState = {
    optional: [{baseGeneration: '7', component: 'search', projectionIdentity: 'search:project-1'}],
    required: [
      {baseGeneration: '7', component: 'projectScope', projectionIdentity: 'projectScope:project-1'},
      {baseGeneration: '7', component: 'selectedImport', projectionIdentity: 'selectedImport:project-1'},
      {baseGeneration: '7', component: 'summary', projectionIdentity: 'summary:project-1'},
    ],
  }
  let adopted = false
  const database: TestDatabase = {
    queryJson: async <T>(statement: string) => {
      statements.push(statement)

      if (statement.includes('FROM app.review_rebuild_chunk_manifest')) {
        return [adopted ? adoptedSummaryChunk : summaryChunk] as T[]
      }

      if (statement.includes('FROM app.review_serving_snapshot_manifest')) {
        return [
          {
            componentStateJson: componentState,
            reviewConfigHash: 'review-config-1',
            selectedImportSnapshotId: 'selected-import-snapshot-1',
            snapshotId: 'snapshot-summary-requestless',
          },
        ] as T[]
      }

      return [] as T[]
    },
    run: async (statement: string) => {
      statements.push(statement)
      if (statement.includes('UPDATE app.review_rebuild_chunk_manifest') && statement.includes('request_id =')) {
        adopted = true
      }
    },
    transaction: async <T>(operation: (tx: TestDatabase) => Promise<T>) => {
      statements.push('BEGIN requestless summary claimed')

      return operation(database)
    },
  }

  const result = await runReviewServingProjectorWorkerClaimedRebuildChunk(
    {chunk: summaryChunk, leaseOwner: 'worker-1'},
    database,
  )

  expect(result).toEqual({status: 'completed'})
  expect(statements.join('\n')).toContain('INSERT INTO app.review_rebuild_request')
  expect(statements.join('\n')).toContain('mart.review_article_summary_rebuild_partial_v4')
  expect(statements.join('\n')).toContain(`request_id = '${requestId}'`)
  expect(statements.join('\n')).not.toContain("status = 'quarantined'")
})

test('request-associated summary chunks stage partials without refreshing filter options', async () => {
  const statements: string[] = []
  const summaryChunk = {
    ...chunkManifest,
    chunkId: 'chunk-summary-request-staged-options',
    outputBaseGeneration: 7,
    projectionComponent: 'summary' as const,
    projectionIdentity: 'summary:project-1',
    requestId: 'rebuild-summary-request',
  } satisfies ReviewServingRebuildChunkManifest
  const componentState = {
    optional: [{baseGeneration: '7', component: 'search', projectionIdentity: 'search:project-1'}],
    required: [
      {baseGeneration: '7', component: 'projectScope', projectionIdentity: 'projectScope:project-1'},
      {baseGeneration: '7', component: 'selectedImport', projectionIdentity: 'selectedImport:project-1'},
      {baseGeneration: '7', component: 'summary', projectionIdentity: 'summary:project-1'},
    ],
  }
  const database: TestDatabase = {
    queryJson: async <T>(statement: string) => {
      statements.push(statement)

      if (statement.includes('FROM app.review_rebuild_chunk_manifest')) {
        return [summaryChunk] as T[]
      }

      if (statement.includes('FROM app.review_serving_snapshot_manifest')) {
        return [
          {
            componentStateJson: componentState,
            reviewConfigHash: 'review-config-1',
            selectedImportSnapshotId: 'selected-import-snapshot-1',
            snapshotId: 'snapshot-summary-request-refresh',
          },
        ] as T[]
      }

      return [] as T[]
    },
    run: async (statement: string) => {
      statements.push(statement)
    },
    transaction: async <T>(operation: (tx: TestDatabase) => Promise<T>) => {
      return operation(database)
    },
  }

  const result = await runReviewServingProjectorWorkerClaimedRebuildChunk(
    {chunk: summaryChunk, leaseOwner: 'worker-1'},
    database,
  )

  expect(result).toEqual({status: 'completed'})
  expect(statements.join('\n')).toContain('mart.review_article_summary_rebuild_partial_v4')
  expect(statements.join('\n')).not.toContain('FROM app.review_projection_identity_manifest')
  expect(statements.join('\n')).not.toContain('DELETE FROM mart.review_filter_option_serving_v4')
  expect(statements.join('\n')).not.toContain('INSERT INTO mart.review_filter_option_serving_v4')
})

test('admission-presplit posting rebuild chunk executes directly above the old runtime row budget', async () => {
  const statements: string[] = []
  const postingChunk: ReviewServingRebuildChunkManifest = {
    ...chunkManifest,
    chunkId: 'chunk-posting-runtime-oom',
    diagnosticsJson: {admissionPresplit: true},
    estimatedInputRows: 49_000,
    estimatedOutputRows: 49_000,
    inputWatermark: 9,
    outputBaseGeneration: 7,
    projectionComponent: 'posting',
    projectionIdentity: 'posting:project-1',
    splitDepth: 1,
  }
  const componentState = {
    optional: [],
    required: [
      {baseGeneration: '7', component: 'projectScope', projectionIdentity: 'projectScope:project-1'},
      {baseGeneration: '7', component: 'selectedImport', projectionIdentity: 'selectedImport:project-1'},
      {baseGeneration: '7', component: 'posting', projectionIdentity: 'posting:project-1'},
    ],
  }
  const database: TestDatabase = {
    queryJson: async <T>(statement: string) => {
      statements.push(statement)

      if (statement.includes('FROM app.review_rebuild_chunk_manifest')) {
        return [postingChunk] as T[]
      }

      if (statement.includes('FROM app.review_projection_identity_manifest')) {
        return [
          {
            baseGeneration: postingChunk.outputBaseGeneration,
            definitionVersion: 'posting-v1',
            inputDigest: postingChunk.inputDigest,
            inputWatermark: postingChunk.inputWatermark,
            inputWatermarksJson: {reviewChange: 9},
            invalidationReason: postingChunk.inputDigest,
            manifestId: 'manifest-posting',
            patchRangeEnd: postingChunk.inputWatermark,
            patchRangeStart: postingChunk.inputWatermark,
            patchWatermark: postingChunk.inputWatermark,
            projectId: postingChunk.projectId,
            projectionComponent: postingChunk.projectionComponent,
            projectionIdentity: postingChunk.projectionIdentity,
            promptConfigHash: null,
            reviewConfigHash: 'review-config-1',
            status: 'candidate',
          },
        ] as T[]
      }

      if (statement.includes('FROM app.review_serving_snapshot_manifest')) {
        return [
          {
            componentStateJson: componentState,
            reviewConfigHash: 'review-config-1',
            selectedImportSnapshotId: 'selected-import-snapshot-1',
            snapshotId: 'snapshot-posting-oom',
          },
        ] as T[]
      }

      if (statement.includes('FROM posting_union')) {
        return [
          {
            articleId: 'article-050',
            filterKind: 'promptAnswer',
            filterValue: 'review:promptAnswer:prompt-1:yes',
            listModeKey: 'llm',
            sortKey: '2026-06-16T10:00:00.000Z',
            tombstone: false,
          },
        ] as T[]
      }

      if (statement.includes('AS totalArticleCount')) {
        return [{listModeKey: 'llm', totalArticleCount: 10}] as T[]
      }

      return [] as T[]
    },
    run: async (statement: string) => {
      statements.push(statement)
    },
    transaction: async <T>(operation: (tx: TestDatabase) => Promise<T>) => {
      return operation(database)
    },
  }

  const result = await runReviewServingProjectorWorkerClaimedRebuildChunk(
    {chunk: postingChunk, leaseOwner: 'worker-1'},
    database,
  )
  const joined = statements.join('\n')
  const childInserts = statements.filter((statement) => {
    return statement.includes('INSERT INTO app.review_rebuild_chunk_manifest')
  })

  expect(result).toEqual({status: 'completed'})
  expect(joined).toContain('DELETE FROM mart.review_article_filter_posting_serving_v4 serving')
  expect(joined).not.toContain('NTILE(')
  expect(childInserts).toHaveLength(0)
  expect(joined).toContain('"admissionPresplit":true')
  expect(joined).not.toContain('"splitReason":"input_row_budget"')
  expect(joined).not.toContain("oom_category = 'duckdb_oom_split'")
  expect(joined).not.toContain("status = 'failed'")
  expect(joined).not.toContain("status = 'blocked_over_budget'")
})

test('judgment input content rebuild chunk splits only after DuckDB OOM', async () => {
  const statements: string[] = []
  const judgmentChunk: ReviewServingRebuildChunkManifest = {
    ...chunkManifest,
    budgetJson: {maxInputRows: 250_000},
    chunkId: 'chunk-judgment-input-content-oom',
    diagnosticsJson: {source: 'test'},
    estimatedInputRows: 240_000,
    estimatedOutputBytes: 96_000_000,
    estimatedOutputRows: 240_000,
    inputWatermark: 9,
    maxInputRows: 250_000,
    maxOutputBytes: 128_000_000,
    maxOutputRows: 250_000,
    outputBaseGeneration: 7,
    parentChunkId: null,
    projectionComponent: 'judgmentInputContent',
    projectionIdentity: 'judgmentInputContent:project-1',
    requestId: 'request-1',
    snapshotCount: 1,
    splitDepth: 0,
  }
  const reviewConfigHash = buildReviewConfigHash({
    humanJudgmentMode: 'prompt',
    modelExecutionIdentity: {
      modelExecutionOptions: null,
      modelId: 'model-1',
      providerBaseUrl: null,
      providerConnectionId: null,
      providerKind: null,
      remoteModelId: null,
      variant: null,
    },
    modelId: 'model-1',
    promptConfigs: [],
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  })
  const componentState = {
    optional: [],
    required: [
      {baseGeneration: '7', component: 'projectScope', projectionIdentity: 'projectScope:project-1'},
      {baseGeneration: '7', component: 'judgmentInputContent', projectionIdentity: 'judgmentInputContent:project-1'},
    ],
  }
  const database: TestDatabase = {
    queryJson: async <T>(statement: string) => {
      statements.push(statement)

      if (statement.includes('FROM app.review_rebuild_chunk_manifest')) {
        return [judgmentChunk] as T[]
      }

      if (statement.includes('FROM app.review_projection_identity_manifest')) {
        return [
          {
            baseGeneration: 7,
            definitionVersion: 'judgmentInputContent:v1',
            inputDigest: judgmentChunk.inputDigest,
            inputWatermark: judgmentChunk.inputWatermark,
            inputWatermarksJson: {reviewChange: 9},
            invalidationReason: judgmentChunk.inputDigest,
            manifestId: 'manifest-judgment-input-content',
            patchRangeEnd: judgmentChunk.inputWatermark,
            patchRangeStart: judgmentChunk.inputWatermark,
            patchWatermark: judgmentChunk.inputWatermark,
            projectId: judgmentChunk.projectId,
            projectionComponent: judgmentChunk.projectionComponent,
            projectionIdentity: judgmentChunk.projectionIdentity,
            promptConfigHash: null,
            reviewConfigHash,
            status: 'candidate',
          },
        ] as T[]
      }

      if (statement.includes('FROM app.review_serving_snapshot_manifest')) {
        return [
          {
            componentStateJson: componentState,
            reviewConfigHash,
            selectedImportSnapshotId: 'selected-import-snapshot-1',
            snapshotId: 'snapshot-rebuild-1',
          },
        ] as T[]
      }

      if (statement.includes('FROM app.project project') && statement.includes('LIMIT 1')) {
        return [
          {
            humanJudgmentMode: 'prompt',
            modelExecutionOptions: null,
            modelId: 'model-1',
            modelProviderBaseUrl: null,
            modelProviderConnectionId: null,
            modelProviderKind: null,
            modelRemoteModelId: null,
            modelVariant: null,
            useAbstract: true,
            useFulltext: false,
            useFulltextNoImages: false,
            useTitle: true,
          },
        ] as T[]
      }

      if (statement.includes('NTILE(48)') && statement.includes('FROM mart.project_scope_article scope')) {
        return [
          {articleCount: 50, chunkEndKey: 'article-060', chunkStartKey: 'article-001'},
          {articleCount: 49, chunkEndKey: 'article-099', chunkStartKey: 'article-050'},
        ] as T[]
      }

      if (statement.includes('UPDATE app.review_rebuild_chunk_manifest') && statement.includes('RETURNING chunk_id')) {
        return [{chunkId: 'chunk-judgment-input-content-oom'}] as T[]
      }

      return [] as T[]
    },
    run: async (statement: string) => {
      statements.push(statement)

      if (statement.includes('DELETE FROM mart.review_article_judgment_detail_serving_v4')) {
        throw new Error('DuckDB Out of Memory Error: failed to allocate 32KiB (18.6 GiB/18.6 GiB used)')
      }
    },
    transaction: async <T>(operation: (tx: TestDatabase) => Promise<T>) => {
      return operation(database)
    },
  }

  const result = await runReviewServingProjectorWorkerClaimedRebuildChunk(
    {chunk: judgmentChunk, leaseOwner: 'worker-1'},
    database,
  )
  const joined = statements.join('\n')
  const childInserts = statements.filter((statement) => {
    return statement.includes('INSERT INTO app.review_rebuild_chunk_manifest')
  })

  expect(result).toEqual({status: 'completed'})
  expect(joined).toContain('NTILE(48)')
  expect(joined).not.toContain('scope.project_scope_identity')
  expect(joined).toContain('DELETE FROM mart.review_article_judgment_detail_serving_v4')
  expect(joined).toContain('lease_expires_at > current_timestamp')
  expect(joined).toContain('RETURNING chunk_id AS chunkId')
  expect(childInserts).toHaveLength(2)
  expect(childInserts[0]).toContain("'chunk-judgment-input-content-oom'")
  expect(childInserts[0]).toContain("'article-001'")
  expect(childInserts[0]).toContain("'article-060'")
  expect(childInserts[1]).toContain("'article-050'")
  expect(childInserts[1]).toContain("'article-099'")
  expect(joined).toContain("status = 'completed'")
  expect(joined).toContain("oom_category = 'duckdb_oom_split'")
  expect(joined).not.toContain("status = 'failed'")
})

test('queue rebuild chunk writes serving rows with SQL-native article range statements', async () => {
  const statements: string[] = []
  const queueChunk: ReviewServingRebuildChunkManifest = {
    ...chunkManifest,
    checksum: null,
    chunkEndKey: 'article-099',
    chunkId: 'chunk-queue-range',
    chunkStartKey: 'article-050',
    inputWatermark: 9,
    outputBaseGeneration: 7,
    projectionComponent: 'queue',
    projectionIdentity: 'queue:project-1',
    requestId: 'request-queue-range',
  }
  const componentState = {
    optional: [],
    required: [
      {baseGeneration: '7', component: 'projectScope', projectionIdentity: 'projectScope:project-1'},
      {baseGeneration: '7', component: 'selectedImport', projectionIdentity: 'selectedImport:project-1'},
      {baseGeneration: '7', component: 'queue', projectionIdentity: 'queue:project-1'},
    ],
  }
  const database: TestDatabase = {
    queryJson: async <T>(statement: string) => {
      statements.push(statement)

      if (statement.includes('FROM app.review_rebuild_chunk_manifest')) {
        return [queueChunk] as T[]
      }

      if (statement.includes('FROM app.review_serving_snapshot_manifest')) {
        return [
          {
            componentStateJson: componentState,
            reviewConfigHash: 'review-config-1',
            selectedImportSnapshotId: 'selected-import-snapshot-1',
            snapshotId: 'snapshot-queue-range-1',
          },
        ] as T[]
      }

      if (statement.includes('FROM mart.review_unassessed_queue_serving_v4 serving')) {
        return [{actualChecksum: 'checksum-queue-range', actualCount: 2}] as T[]
      }

      return [] as T[]
    },
    run: async (statement: string) => {
      statements.push(statement)
    },
    transaction: async <T>(operation: (tx: TestDatabase) => Promise<T>) => {
      return operation(database)
    },
  }

  const result = await runReviewServingProjectorWorkerClaimedRebuildChunk(
    {chunk: queueChunk, leaseOwner: 'worker-1'},
    database,
  )
  const joined = statements.join('\n')

  expect(result).toEqual({status: 'completed'})
  expect(joined).toContain('DELETE FROM mart.review_unassessed_queue_serving_v4')
  expect(joined).toContain('INSERT INTO mart.review_unassessed_queue_serving_v4')
  expect(joined).toContain('WITH scoped_article AS')
  expect(joined).toContain('LEFT JOIN latest_judgment judgment')
  expect(joined).toContain('LEFT JOIN app."judgment_human" judgment_human')
  expect(joined).toContain('LEFT JOIN app."judgment_human_summary" judgment_human_summary')
  expect(joined).not.toContain('INNER JOIN mart.review_llm_status_patch_v4 llm')
  expect(joined).not.toContain('INNER JOIN mart.review_human_status_patch_v4 human')
  expect(joined).toContain("scope.article_id >= 'article-050'")
  expect(joined).toContain("scope.article_id <= 'article-099'")
  expect(joined).toContain("article_id >= 'article-050'")
  expect(joined).toContain("article_id <= 'article-099'")
  expect(joined).toContain("checksum = 'checksum-queue-range'")
  expect(joined).not.toContain('INSERT INTO mart.review_queue_patch_v4')
  expect(joined).not.toContain('INSERT INTO app.review_serving_dirty_work_ack')
})

test('base rebuild chunks regenerate project scope and selected import state before completion', async () => {
  const statements: string[] = []
  const projectScopeChunk: ReviewServingRebuildChunkManifest = {
    ...chunkManifest,
    chunkId: 'chunk-project-scope',
    checksum: null,
    inputWatermark: 9,
    outputBaseGeneration: 7,
    projectionComponent: 'projectScope',
    projectionIdentity: 'projectScope:project-1',
  }
  const selectedImportChunk: ReviewServingRebuildChunkManifest = {
    ...chunkManifest,
    chunkId: 'chunk-selected-import',
    checksum: null,
    inputWatermark: 9,
    outputBaseGeneration: 7,
    projectionComponent: 'selectedImport',
    projectionIdentity: 'selectedImport:project-1',
  }
  const componentState = {
    optional: [],
    required: [
      {
        baseGeneration: '7',
        component: 'projectScope',
        patchWatermark: '9',
        projectionIdentity: 'projectScope:project-1',
      },
      {
        baseGeneration: '7',
        component: 'selectedImport',
        patchWatermark: '9',
        projectionIdentity: 'selectedImport:project-1',
      },
      {baseGeneration: '7', component: 'display', patchWatermark: '9', projectionIdentity: 'display:project-1'},
      {baseGeneration: '7', component: 'llmStatus', patchWatermark: '9', projectionIdentity: 'llmStatus:project-1'},
      {baseGeneration: '7', component: 'humanStatus', patchWatermark: '9', projectionIdentity: 'humanStatus:project-1'},
      {baseGeneration: '7', component: 'posting', patchWatermark: '9', projectionIdentity: 'posting:project-1'},
      {baseGeneration: '7', component: 'summary', patchWatermark: '9', projectionIdentity: 'summary:project-1'},
      {baseGeneration: '7', component: 'payload', patchWatermark: '9', projectionIdentity: 'payload:project-1'},
    ],
  }
  let activeChunk = projectScopeChunk
  const database: TestDatabase = {
    queryJson: async <T>(statement: string) => {
      statements.push(statement)

      if (statement.includes('FROM app.review_rebuild_chunk_manifest')) {
        return [activeChunk] as T[]
      }

      if (statement.includes('FROM app.review_projection_identity_manifest')) {
        return [
          {
            baseGeneration: activeChunk.outputBaseGeneration,
            definitionVersion: `${activeChunk.projectionComponent}-v1`,
            inputDigest: activeChunk.inputDigest,
            inputWatermark: activeChunk.inputWatermark,
            inputWatermarksJson: {importRunArticle: 7, reviewChange: 9},
            invalidationReason: activeChunk.inputDigest,
            manifestId: `manifest-${activeChunk.projectionComponent}`,
            patchRangeEnd: activeChunk.inputWatermark,
            patchRangeStart: activeChunk.inputWatermark,
            patchWatermark: activeChunk.inputWatermark,
            projectId: activeChunk.projectId,
            projectionComponent: activeChunk.projectionComponent,
            projectionIdentity: activeChunk.projectionIdentity,
            promptConfigHash: null,
            reviewConfigHash: 'review-config-1',
            status: 'candidate',
          },
        ] as T[]
      }

      if (statement.includes('FROM app.review_serving_snapshot_manifest')) {
        return [
          {
            componentStateJson: componentState,
            reviewConfigHash: 'review-config-1',
            selectedImportSnapshotId: 'selected-import-snapshot-1',
            snapshotId: 'snapshot-base-rebuild-1',
          },
        ] as T[]
      }

      if (statement.includes('FROM app.review_selected_import_snapshot')) {
        return [{cursorJson: null, sourceDeltaHighWater: 9, status: 'completed'}] as T[]
      }

      if (statement.includes('WITH selected_import_candidates')) {
        return [] as T[]
      }

      if (statement.includes('FROM mart.project_scope_article')) {
        return [{actualChecksum: 'checksum-project-scope', actualCount: 1}] as T[]
      }

      if (statement.includes('WITH output_row')) {
        return [{actualChecksum: 'checksum-selected-import', actualCount: 1}] as T[]
      }

      return [] as T[]
    },
    run: async (statement: string) => {
      statements.push(statement)
    },
    transaction: async <T>(operation: (tx: TestDatabase) => Promise<T>) => {
      statements.push(`BEGIN ${activeChunk.projectionComponent}`)

      return operation(database)
    },
  }
  const projectScopeResult = await runReviewServingProjectorWorkerClaimedRebuildChunk(
    {chunk: projectScopeChunk, leaseOwner: 'worker-1'},
    database,
  )
  activeChunk = selectedImportChunk
  const selectedImportResult = await runReviewServingProjectorWorkerClaimedRebuildChunk(
    {chunk: selectedImportChunk, leaseOwner: 'worker-1'},
    database,
  )
  const joined = statements.join('\n')

  expect(projectScopeResult).toEqual({status: 'completed'})
  expect(selectedImportResult).toEqual({status: 'completed'})
  expect(
    statements.filter((statement) => {
      return statement === 'BEGIN selectedImport'
    }).length,
  ).toBe(5)
  expect(joined).toContain('DELETE FROM mart.project_scope_article')
  expect(joined).toContain("scope.article_id >= 'article-001'")
  expect(joined).toContain("scope.article_id <= 'article-099'")
  expect(joined).toContain('INSERT INTO mart.project_scope_article')
  expect(joined).toContain('projectScope.rebuild')
  expect(joined).toContain('reviewChange')
  expect(joined).not.toContain('DELETE FROM mart.review_selected_import_patch_v4')
  expect(joined).toContain('DELETE FROM app.review_selected_article_import_v4')
  expect(joined).not.toContain('INSERT INTO mart.review_selected_import_patch_v4')
  expect(joined).not.toContain('article_id IS NOT DISTINCT FROM')
  expect(joined).toContain("article_id >= 'article-001'")
  expect(joined).toContain("article_id <= 'article-099'")
  expect(joined).toContain('DELETE FROM app.review_selected_import_snapshot')
  expect(joined).toContain('WITH selected_import_candidates')
  expect(joined).toContain('CREATE OR REPLACE TEMP TABLE review_selected_import_serving_rebuild_v4 AS')
  expect(joined).toContain('LEFT JOIN app.review_selected_article_import_v4 selected')
  expect(joined).not.toContain('selectedImport.rebuild')
  expect(joined).toContain("checksum = 'checksum-project-scope'")
  expect(joined).toContain("checksum = 'checksum-selected-import'")
})

test('selected import bootstrap rebuild chunk writes article range and completed snapshot state without patch fanout', async () => {
  const statements: string[] = []
  const selectedImportChunk: ReviewServingRebuildChunkManifest = {
    ...chunkManifest,
    checksum: null,
    chunkEndKey: 'article-099',
    chunkId: 'chunk-selected-import-bootstrap-range',
    chunkStartKey: 'article-050',
    inputDigest: 'freshReviewServingSnapshot',
    inputWatermark: 9,
    outputBaseGeneration: 7,
    projectionComponent: 'selectedImport',
    projectionIdentity: 'selectedImport:project-1',
    requestId: 'request-bootstrap-range',
  }
  const componentState = {
    optional: [],
    required: [
      {
        baseGeneration: '7',
        component: 'projectScope',
        patchWatermark: '9',
        projectionIdentity: 'projectScope:project-1',
      },
      {
        baseGeneration: '7',
        component: 'selectedImport',
        patchWatermark: '9',
        projectionIdentity: 'selectedImport:project-1',
      },
      {baseGeneration: '7', component: 'display', patchWatermark: '9', projectionIdentity: 'display:project-1'},
      {baseGeneration: '7', component: 'llmStatus', patchWatermark: '9', projectionIdentity: 'llmStatus:project-1'},
      {baseGeneration: '7', component: 'humanStatus', patchWatermark: '9', projectionIdentity: 'humanStatus:project-1'},
      {baseGeneration: '7', component: 'posting', patchWatermark: '9', projectionIdentity: 'posting:project-1'},
      {baseGeneration: '7', component: 'summary', patchWatermark: '9', projectionIdentity: 'summary:project-1'},
      {baseGeneration: '7', component: 'payload', patchWatermark: '9', projectionIdentity: 'payload:project-1'},
    ],
  }
  const database: TestDatabase = {
    queryJson: async <T>(statement: string) => {
      statements.push(statement)

      if (statement.includes('FROM app.review_rebuild_chunk_manifest')) {
        return [selectedImportChunk] as T[]
      }

      if (statement.includes('FROM app.review_projection_identity_manifest')) {
        return [
          {
            baseGeneration: selectedImportChunk.outputBaseGeneration,
            definitionVersion: 'selectedImport-v1',
            inputDigest: selectedImportChunk.inputDigest,
            inputWatermark: selectedImportChunk.inputWatermark,
            inputWatermarksJson: {importRunArticle: 9},
            invalidationReason: selectedImportChunk.inputDigest,
            manifestId: 'manifest-selectedImport-bootstrap-range',
            patchRangeEnd: selectedImportChunk.inputWatermark,
            patchRangeStart: selectedImportChunk.inputWatermark,
            patchWatermark: selectedImportChunk.inputWatermark,
            projectId: selectedImportChunk.projectId,
            projectionComponent: selectedImportChunk.projectionComponent,
            projectionIdentity: selectedImportChunk.projectionIdentity,
            promptConfigHash: null,
            reviewConfigHash: 'review-config-1',
            status: 'candidate',
          },
        ] as T[]
      }

      if (statement.includes('FROM app.review_serving_snapshot_manifest')) {
        return [
          {
            componentStateJson: componentState,
            reviewConfigHash: 'review-config-1',
            selectedImportSnapshotId: 'selected-import-snapshot-1',
            snapshotId: 'snapshot-bootstrap-range-1',
          },
        ] as T[]
      }

      if (statement.includes('WITH selected_import_candidates')) {
        return [] as T[]
      }

      if (statement.includes('WITH output_row')) {
        return [{actualChecksum: 'checksum-selected-import-range', actualCount: 0}] as T[]
      }

      return [] as T[]
    },
    run: async (statement: string) => {
      statements.push(statement)
    },
    transaction: async <T>(operation: (tx: TestDatabase) => Promise<T>) => {
      return operation(database)
    },
  }

  const result = await runReviewServingProjectorWorkerClaimedRebuildChunk(
    {chunk: selectedImportChunk, leaseOwner: 'worker-1'},
    database,
  )
  const joined = statements.join('\n')

  expect(result).toEqual({status: 'completed'})
  expect(joined).not.toContain('DELETE FROM mart.review_selected_import_patch_v4')
  expect(joined).not.toContain('INSERT INTO mart.review_selected_import_patch_v4')
  expect(joined).not.toContain('DELETE FROM app.review_selected_article_import_v4')
  expect(joined).not.toContain('article_id IS NOT DISTINCT FROM')
  expect(joined).not.toContain('DELETE FROM app.review_selected_import_snapshot')
  expect(joined).toContain('INSERT INTO app.review_selected_import_snapshot')
  expect(joined).toContain("'completed'")
  expect(joined).toContain('UPDATE app.review_projection_identity_manifest')
  expect(joined).toContain("article_id >= 'article-050'")
  expect(joined).toContain("article_id <= 'article-099'")
  expect(joined).toContain("scope.article_id >= 'article-050'")
  expect(joined).toContain("serving.article_id >= 'article-050'")
  expect(joined).toContain("checksum = 'checksum-selected-import-range'")
})
