import {readFileSync} from 'node:fs'
import {join} from 'node:path'

import {expect, mock, test} from 'bun:test'

import {buildReviewConfigHash} from '../reviewServing/reviewProjectionIdentity.ts'
import type {ReviewServingRebuildChunkManifest} from '../reviewServing/reviewServingChunkManifestRepository.ts'
import type {ReviewServingDirtyWorkClaim} from '../reviewServing/reviewServingDirtyWorkService.ts'
import type {DuckdbWorkloadContext} from '../utils/duckdbService.ts'
import {
  defaultReviewServingProjectorWorkerErrorBackoffMs,
  getDefaultReviewServingProjectorRunners,
  getReviewServingProjectorWorkerWorkloadContext,
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
  startedAt: '2026-06-16T10:00:00.000Z',
  status: 'running',
  updatedAt: '2026-06-16T10:00:00.000Z',
} satisfies ReviewServingRebuildChunkManifest

const createWorkerHarness = (input?: {
  chunkComplete?: boolean
  cleanupTargets?: Array<{batchSize: number; now: Date | string; projectId: string; reviewConfigHash?: string | null}>
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
      getNextChunk: async () => {
        return chunkInput
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
  expect(source).toContain('projectReviewServingPayloadRows')
  expect(source).toContain('projectReviewServingJudgmentPayloadRows')
  expect(source).toContain('projectReviewServingDisplayPatches')
  expect(source).toContain('projectReviewServingTitleSearchRows')
  expect(source).toContain("component: 'judgmentInputContent'")
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
      return statement.includes('INSERT INTO app.review_selected_import_snapshot')
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
  expect(joined).toContain('SAVEPOINT review_serving_rebuild_chunk_output')
  expect(joined).toContain('INSERT INTO mart.review_article_serving_v4')
  expect(joined).toContain("scope.article_id >= 'article-001'")
  expect(joined).toContain("scope.article_id <= 'article-099'")
  expect(joined).toContain('FROM mart.review_article_serving_v4 serving')
  expect(joined).toContain("checksum = 'checksum-display-1'")
})

test('payload and search rebuild chunk executors write bounded base rows and complete chunks', async () => {
  const statements: string[] = []
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

  expect(payloadResult).toEqual({status: 'completed'})
  expect(searchResult).toEqual({status: 'completed'})
  expect(joined).toContain('INSERT INTO mart.review_article_serving_payload_v4')
  expect(joined).toContain('INSERT INTO mart.review_title_search_serving_v4')
  expect(joined).toContain("scope.article_id >= 'article-001'")
  expect(joined).toContain("scope.article_id <= 'article-099'")
  expect(joined).toContain("checksum = 'checksum-payload-1'")
  expect(joined).toContain("checksum = 'checksum-search-1'")
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
            inputWatermarksJson: {},
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

  expect(results).toEqual(
    components.map(() => {
      return {status: 'completed'}
    }),
  )
  expect(joined).toContain('llm_status_identity')
  expect(joined).toContain('human_status_identity')
  expect(joined).toContain('DELETE FROM mart.review_unassessed_queue_serving_v4')
  expect(joined).toContain('DELETE FROM mart.review_article_filter_posting_serving_v4 serving')
  expect(joined).toContain('DELETE FROM mart.review_filter_option_serving_v4')
  expect(joined).toContain('DELETE FROM mart.review_article_judgment_detail_serving_v4')
  expect(joined).toContain("article_id >= 'article-001'")
  expect(joined).toContain("article_id <= 'article-099'")
})

test('unsupported rebuild chunk executors fail explicitly', async () => {
  const harness = createWorkerHarness()
  const unsupportedChunk = {...chunkManifest, projectionComponent: 'projectScope' as const}
  const result = runReviewServingProjectorWorkerClaimedRebuildChunk(
    {chunk: unsupportedChunk, leaseOwner: 'worker-1'},
    harness.database,
  )

  await result.then(
    () => {
      expect(true).toBe(false)
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(Error)
      expect(String(error)).toContain('review serving rebuild chunk executor is not registered for projectScope')
    },
  )
})
