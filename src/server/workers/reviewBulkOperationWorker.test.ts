import {expect, test} from 'bun:test'

import type {DuckdbWorkloadContext} from '../utils/duckdbService.ts'
import {
  type ReviewBulkOperationWorkerDependencies,
  runReviewBulkOperationWorkerOnce,
} from './reviewBulkOperationWorker.ts'

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

const jobRow = {
  batchSize: 2,
  cancelRequested: false,
  criteriaJson: {operation: 'addToProject', targetProjectId: 'target-project-1'},
  cursorJson: {cursor: 'article-001', limit: 2},
  jobId: 'job-1',
  jobKind: 'review.bulk.selection',
  latestSnapshotSemantics: false,
  processedCount: 1,
  projectId: 'project-1',
  retryCount: 0,
  reviewConfigHash: 'config-1',
  snapshotId: 'snapshot-1',
  status: 'running',
  totalEstimate: null,
}

const createWorkerHarness = (input?: {
  batchRows?: readonly {articleId: string}[]
  cancelRequested?: boolean
  executeThrows?: boolean
  retryCount?: number
}) => {
  const statements: string[] = []
  const workloadContexts: DuckdbWorkloadContext[] = []
  const database: TestDatabase = {
    queryJson: async <T>(statement: string, workloadContext?: DuckdbWorkloadContext) => {
      statements.push(statement)

      if (workloadContext) {
        workloadContexts.push(workloadContext)
      }

      if (statement.includes('SELECT job_id AS jobId')) {
        return [{jobId: 'job-1'}] as T[]
      }

      if (
        statement.includes('FROM app.review_bulk_operation_job')
        && statement.includes('criteria_json AS criteriaJson')
      ) {
        return [
          {...jobRow, cancelRequested: input?.cancelRequested ?? false, retryCount: input?.retryCount ?? 0},
        ] as T[]
      }

      return (input?.batchRows ?? [{articleId: 'article-002'}, {articleId: 'article-003'}]) as T[]
    },
    run: async (statement: string, workloadContext?: DuckdbWorkloadContext) => {
      statements.push(statement)

      if (workloadContext) {
        workloadContexts.push(workloadContext)
      }
    },
    transaction: async (operation, workloadContext?: DuckdbWorkloadContext) => {
      if (workloadContext) {
        workloadContexts.push(workloadContext)
      }

      return operation(database)
    },
  }
  const executedBatches: string[][] = []
  const dependencies: ReviewBulkOperationWorkerDependencies = {
    executeBatch: async ({articleIds}) => {
      executedBatches.push([...articleIds])

      if (input?.executeThrows) {
        throw new Error('executor failed')
      }
    },
    getDatabase: () => {
      return database
    },
  }

  return {dependencies, executedBatches, statements, workloadContexts}
}

test('review bulk operation worker claims and advances bounded keyset progress durably', async () => {
  const harness = createWorkerHarness()
  const result = await runReviewBulkOperationWorkerOnce({workerId: 'worker-1'}, harness.dependencies)
  const joined = harness.statements.join('\n')

  expect(result).toEqual({jobId: 'job-1', processedCount: 3, status: 'partial', workerId: 'worker-1'})
  expect(harness.executedBatches).toEqual([['article-002', 'article-003']])
  expect(joined).toContain("status IN ('pending', 'running')")
  expect(joined).toContain("status = 'running'")
  expect(joined).toContain("article_id > 'article-001'")
  expect(joined).toContain('ORDER BY article_id ASC')
  expect(joined).toContain('LIMIT 2')
  expect(joined).toContain('processed_count = processed_count + 2')
  expect(joined).toContain('"cursor":"article-003"')
  expect(
    harness.workloadContexts.some((context) => {
      return context.fallbackIntent === 'reject' && context.workloadClass === 'bulkReviewJob'
    }),
  ).toBe(true)
})

test('review bulk operation worker completes terminally when the final batch is short', async () => {
  const harness = createWorkerHarness({batchRows: [{articleId: 'article-002'}]})
  const result = await runReviewBulkOperationWorkerOnce({workerId: 'worker-1'}, harness.dependencies)
  const joined = harness.statements.join('\n')

  expect(result.status).toBe('completed')
  expect(joined).toContain("status = 'completed'")
  expect(joined).toContain('completed_at = current_timestamp')
})

test('review bulk operation worker persists cancellation and terminal failure without local state', async () => {
  const cancelled = createWorkerHarness({cancelRequested: true})
  const cancelledResult = await runReviewBulkOperationWorkerOnce({workerId: 'worker-1'}, cancelled.dependencies)
  const failed = createWorkerHarness({executeThrows: true, retryCount: 3})
  const failedResult = await runReviewBulkOperationWorkerOnce(
    {maxRetries: 3, workerId: 'worker-1'},
    failed.dependencies,
  )

  expect(cancelledResult.status).toBe('cancelled')
  expect(cancelled.statements.join('\n')).toContain("status = 'cancelled'")
  expect(failedResult.status).toBe('failed')
  expect(failed.statements.join('\n')).toContain("status = 'failed'")
  expect(failed.statements.join('\n')).toContain('retry_count = retry_count + 1')
  expect(failed.statements.join('\n')).toContain('executor failed')
})
