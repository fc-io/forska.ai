import {expect, test} from 'bun:test'

import {getPdfFetchJobFromDatabase} from '../services/pdfFetchJobs.ts'
import type {DuckdbWorkloadContext} from '../utils/duckdbService.ts'
import {
  assertArticleIdOnlyBulkOperationCaps,
  createReviewBulkOperationJob,
  reviewBulkOperationArticleIdCap,
  reviewBulkOperationPayloadByteCap,
  type ReviewBulkOperationServiceDatabase,
} from './reviewBulkOperationService.ts'
import type {ReviewServingProjectionComponent, ReviewServingSnapshotStatus} from './reviewServingContracts.ts'
import type {ReviewServingManifestRepositoryDatabase} from './reviewServingManifestRepository.ts'

const getComponentState = (components: readonly ReviewServingProjectionComponent[]) => {
  return {
    optional: [],
    required: components.map((component) => {
      return {
        baseGeneration: '1',
        component,
        patchWatermark: '2',
        projectionIdentity: `${component}-identity`,
        requirement: 'required' as const,
      }
    }),
  }
}

const getSnapshotRow = (input: {
  components?: readonly ReviewServingProjectionComponent[]
  snapshotId?: string
  status: ReviewServingSnapshotStatus
}) => {
  const components = input.components ?? ['projectScope', 'posting', 'payload', 'summary', 'search']

  return {
    componentStateJson: getComponentState(components),
    composedIdentityJson: {snapshot: input.snapshotId ?? `${input.status}-snapshot`},
    lastError: null,
    lastKnownGoodSnapshotId: null,
    optionalComponentsJson: [],
    projectId: 'project-1',
    requiredComponentsJson: components,
    reviewConfigHash: 'config-1',
    selectedImportSnapshotId: 'selected-import-snapshot-1',
    snapshotId: input.snapshotId ?? `${input.status}-snapshot`,
    snapshotStatus: input.status,
    sourceWatermarksJson: {},
    validationResultJson: null,
  }
}

const getDiagnosticsRows = (statement: string) => {
  return statement.includes('GROUP BY snapshot_status') ? [{snapshotCount: 1, snapshotStatus: 'active'}] : []
}

const createManifestDatabase = (bySnapshot: Record<string, unknown>) => {
  const database: ReviewServingManifestRepositoryDatabase = {
    queryJson: async <T>(statement: string): Promise<T[]> => {
      if (!statement.includes('FROM app.review_serving_snapshot_manifest')) {
        return getDiagnosticsRows(statement) as T[]
      }

      const match = statement.match(/snapshot_id = '([^']+)'/u)
      const snapshot = match ? bySnapshot[match[1] ?? ''] : null

      return snapshot ? ([snapshot] as T[]) : []
    },
    run: async () => {},
    transaction: async (operation) => {
      return operation(database)
    },
  }

  return database
}

const createBulkOperationDatabase = () => {
  const runs: string[] = []
  const statements: string[] = []
  const workloads: unknown[] = []
  const database: ReviewBulkOperationServiceDatabase = {
    queryJson: async <T>(statement: string, workloadContext?: DuckdbWorkloadContext): Promise<T[]> => {
      statements.push(statement)
      workloads.push(workloadContext)

      if (statement.includes('FROM app.review_serving_snapshot_pin')) {
        return [
          {
            composedIdentityJson: {snapshot: 'active-snapshot'},
            createdAt: '2026-06-18T00:00:00.000Z',
            expiresAt: '2026-06-19T00:00:00.000Z',
            ownerId: 'job-1',
            ownerKind: 'reviewBulkOperationJob',
            pinId: 'pin-1',
            projectId: 'project-1',
            refCount: 1,
            releasedAt: null,
            snapshotId: 'active-snapshot',
            updatedAt: '2026-06-18T00:00:00.000Z',
          },
        ] as T[]
      }

      return statement.includes('FROM app.review_bulk_operation_job') ? ([{job_id: 'job-1'}] as T[]) : []
    },
    run: async (statement: string) => {
      runs.push(statement)
    },
    transaction: async (operation) => {
      return operation(database)
    },
  }

  return {database, runs, statements, workloads}
}

test('createReviewBulkOperationJob persists pinned PDF criteria and verifies through the job contract', async () => {
  const bulkDatabase = createBulkOperationDatabase()
  const manifestDatabase = createManifestDatabase({
    'active-snapshot': getSnapshotRow({snapshotId: 'active-snapshot', status: 'active'}),
  })
  const result = await createReviewBulkOperationJob(
    {
      criteria: {
        forceRefetch: true,
        from: '2026-01-01',
        operation: 'pdfFetch',
        search: 'heart failure',
        sourceProjectId: 'project-1',
      },
      filters: {from: '2026-01-01', search: 'heart failure'},
      jobKind: 'review.pdf.selection',
      projectId: 'project-1',
      reviewConfigHash: 'config-1',
      searchMode: 'tokenPrefix',
      searchText: 'heart failure',
      snapshot: {expiresAt: '2026-06-19T00:00:00.000Z', snapshotId: 'active-snapshot', type: 'pinned'},
    },
    {database: bulkDatabase.database, manifestDatabase},
  )

  expect(result).toMatchObject({
    jobKind: 'review.pdf.selection',
    latestSnapshotSemantics: false,
    projectId: 'project-1',
    snapshotId: 'active-snapshot',
    snapshotPinId: 'pin-1',
    status: 'pending',
  })
  expect(bulkDatabase.runs).toHaveLength(2)
  expect(bulkDatabase.runs[0]).toContain('INSERT INTO app.review_serving_snapshot_pin')
  expect(bulkDatabase.runs[1]).toContain('INSERT INTO app.review_bulk_operation_job')
  expect(bulkDatabase.runs[1]).toContain("'review.pdf.selection'")
  expect(bulkDatabase.runs[1]).toContain('heart failure')
  expect(bulkDatabase.runs[1]).toContain('FALSE')
  expect(bulkDatabase.runs[1]).toContain('"cursor":null')
  expect(
    bulkDatabase.statements.some((statement) => {
      return statement.includes('FROM app.review_bulk_operation_job')
    }),
  ).toBe(true)
  expect(
    bulkDatabase.statements.some((statement) => {
      return statement.includes("job_kind = 'review.pdf.selection'") && statement.includes('filter_signature')
    }),
  ).toBe(true)
  expect(bulkDatabase.workloads).toContainEqual(
    expect.objectContaining({fallbackIntent: 'reject', routeOrJobKey: 'review.pdf.selection'}),
  )
})

test('createReviewBulkOperationJob persists latest-snapshot add-by-filter criteria without selecting article ids', async () => {
  const bulkDatabase = createBulkOperationDatabase()
  const manifestDatabase = createManifestDatabase({})
  const result = await createReviewBulkOperationJob(
    {
      criteria: {
        listType: 'llm',
        operation: 'addToProject',
        sourceProjectId: 'project-1',
        targetProjectId: 'target-project-1',
      },
      filters: {listType: 'llm'},
      jobKind: 'review.bulk.selection',
      projectId: 'project-1',
      snapshot: {type: 'latest'},
    },
    {database: bulkDatabase.database, manifestDatabase},
  )

  expect(result).toMatchObject({
    jobKind: 'review.bulk.selection',
    latestSnapshotSemantics: true,
    snapshotId: null,
    snapshotPinId: null,
  })
  expect(bulkDatabase.runs).toHaveLength(1)
  expect(bulkDatabase.runs[0]).toContain('INSERT INTO app.review_bulk_operation_job')
  expect(bulkDatabase.runs[0]).toContain('TRUE')
  expect(bulkDatabase.runs[0]).toContain('addToProject')
  expect(
    bulkDatabase.statements.some((statement) => {
      return statement.includes('app.article')
    }),
  ).toBe(false)
})

test('article-id-only bulk operations enforce a foreground cap', () => {
  const ids = Array.from({length: reviewBulkOperationArticleIdCap + 1}, (_, index) => {
    return `article-${index}`
  })

  expect(() => {
    return assertArticleIdOnlyBulkOperationCaps(ids)
  }).toThrow('Bulk article ID operation exceeds cap')
})

test('article-id-only bulk operations enforce a payload cap', () => {
  const ids = Array.from({length: 100}, (_, index) => {
    return `article-${index}-${'x'.repeat(Math.ceil(reviewBulkOperationPayloadByteCap / 50))}`
  })

  expect(() => {
    return assertArticleIdOnlyBulkOperationCaps(ids)
  }).toThrow('Bulk article ID operation payload exceeds cap')
})

test('PDF fetch job lookup reads durable cursor progress from review bulk operation jobs', async () => {
  const statements: string[] = []
  const database = {
    queryJson: async <T>(statement: string): Promise<T[]> => {
      statements.push(statement)

      return [
        {
          batchSize: 25,
          cancelRequested: false,
          completedAt: null,
          createdAt: '2026-06-18T00:00:00.000Z',
          criteriaJson: {concurrency: 7, forceRefetch: true, operation: 'pdfFetch'},
          cursorJson: {cursor: 'article-010', limit: 25},
          jobId: 'job-1',
          lastError: null,
          processedCount: 10,
          resultManifestJson: {attempted: 9, failed: 1, noPdf: 2, skipped: 1, succeeded: 6},
          status: 'running',
          totalEstimate: 40,
        },
      ] as T[]
    },
  }

  const job = await getPdfFetchJobFromDatabase('job-1', database)
  const joined = statements.join('\n')

  expect(job).toMatchObject({
    attempted: 9,
    concurrency: 7,
    failed: 1,
    forceRefetch: true,
    jobId: 'job-1',
    noPdf: 2,
    processed: 10,
    skipped: 1,
    status: 'running',
    succeeded: 6,
    total: 40,
  })
  expect(joined).toContain('FROM app.review_bulk_operation_job')
  expect(joined).toContain('cursor_json AS cursorJson')
  expect(joined).toContain('processed_count AS processedCount')
  expect(joined).toContain("job_kind = 'review.pdf.selection'")
})
