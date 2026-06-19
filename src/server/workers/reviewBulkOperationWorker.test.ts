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
  criteriaJson?: unknown
  executeThrows?: boolean
  jobKind?: string
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
          {
            ...jobRow,
            cancelRequested: input?.cancelRequested ?? false,
            criteriaJson: input?.criteriaJson ?? jobRow.criteriaJson,
            jobKind: input?.jobKind ?? jobRow.jobKind,
            retryCount: input?.retryCount ?? 0,
          },
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

      return undefined
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
  expect(joined).toContain("status = 'pending'")
  expect(joined).toContain("status = 'running'")
  expect(joined).toContain("article_id > 'article-001'")
  expect(joined).toContain('ORDER BY s.article_id ASC')
  expect(joined).toContain('LIMIT 2')
  expect(joined).toContain('processed_count = processed_count + 2')
  expect(joined).toContain('"cursor":"article-003"')
  expect(joined).toContain('"jobId":"job-1"')
  expect(joined).toContain("SET status = 'pending'")
  expect(
    harness.workloadContexts.some((context) => {
      return context.fallbackIntent === 'reject' && context.workloadClass === 'bulkReviewJob'
    }),
  ).toBe(true)
})

test('review bulk operation worker uses insertion service side effects for add-to-project batches', async () => {
  const harness = createWorkerHarness()
  const inserted: Array<{articleIds: string[]; importedFromProjectId?: string | null; projectId: string}> = []
  const dependencies: ReviewBulkOperationWorkerDependencies = {
    getDatabase: harness.dependencies.getDatabase,
    insertArticles: async (projectId, articleIds, importedFromProjectId) => {
      inserted.push({articleIds, importedFromProjectId, projectId})
      return {
        existingAssociations: 0,
        insertedCount: articleIds.length,
        invalidIds: [],
        linkedPrompts: 0,
        projectId,
        totalProvided: articleIds.length,
        totalValid: articleIds.length,
      }
    },
  }

  const result = await runReviewBulkOperationWorkerOnce({workerId: 'worker-1'}, dependencies)

  expect(result.status).toBe('partial')
  expect(inserted).toEqual([
    {articleIds: ['article-002', 'article-003'], importedFromProjectId: 'project-1', projectId: 'target-project-1'},
  ])
  expect(harness.statements.join('\n')).not.toContain('INSERT INTO app.project_article')
})

test('review bulk operation worker selects add-to-project batches from persisted filter criteria', async () => {
  const harness = createWorkerHarness({
    criteriaJson: {
      from: '2010',
      hasDuplicateStudyRecords: true,
      hasStudyDecisionConflict: true,
      listType: 'both',
      llmStatus: 'complete',
      operation: 'addToProject',
      prompts: {'prompt-1': ['yes', 'maybe']},
      targetProjectId: 'target-project-1',
      to: '2020',
    },
  })

  await runReviewBulkOperationWorkerOnce({workerId: 'worker-1'}, harness.dependencies)

  const joined = harness.statements.join('\n')

  expect(joined).toContain('FROM mart.review_article_serving_v4 s')
  expect(joined).toContain("s.list_mode_key = 'both'")
  expect(joined).toContain("filter_0.filter_kind = 'duplicateFlag'")
  expect(joined).toContain("filter_1.filter_kind = 'conflictFlag'")
  expect(joined).toContain("filter_2.filter_kind = 'llmStatus'")
  expect(joined).toContain("s.sort_key >= TIMESTAMPTZ '2010'")
  expect(joined).toContain("s.sort_key <= TIMESTAMPTZ '2020'")
  expect(joined).toContain("prompt_filter_0.filter_kind = 'promptAnswer'")
  expect(joined).toContain('review:promptAnswer:prompt-1:yes')
  expect(joined).toContain('ORDER BY s.article_id ASC')
  expect(joined).toContain('LIMIT 2')
  expect(joined).not.toContain('FROM app.article')
})

test('review bulk operation worker leaves substring add-to-project jobs on async search semantics', async () => {
  const harness = createWorkerHarness({
    criteriaJson: {operation: 'addToProject', search: 'heart failure', targetProjectId: 'target-project-1'},
    jobKind: 'review.bulk.substringSelection',
  })

  const result = await runReviewBulkOperationWorkerOnce({workerId: 'worker-1'}, harness.dependencies)

  const joined = harness.statements.join('\n')

  expect(result.status).toBe('partial')
  expect(joined).toContain("status = 'pending'")
  expect(joined).toContain('Substring bulk selection is waiting for async search results')
  expect(joined).not.toContain('FROM mart.review_article_filter_posting_serving_v4 p')
  expect(joined).not.toContain('review_title_search_serving_v4')
})

test('review bulk operation worker advances PDF jobs with durable article-id criteria and counters', async () => {
  const harness = createWorkerHarness({
    criteriaJson: {
      articleIds: ['article-001', 'article-002', 'article-003'],
      forceRefetch: true,
      operation: 'pdfFetch',
      requestId: 'request-1',
    },
    jobKind: 'review.pdf.selection',
  })
  const dependencies: ReviewBulkOperationWorkerDependencies = {
    ...harness.dependencies,
    executeBatch: async ({articleIds}) => {
      harness.executedBatches.push([...articleIds])
      return {pdfStats: {attempted: 2, failed: 0, noPdf: 1, skipped: 0, succeeded: 1}}
    },
  }

  const result = await runReviewBulkOperationWorkerOnce({workerId: 'worker-1'}, dependencies)
  const joined = harness.statements.join('\n')

  expect(result.status).toBe('partial')
  expect(harness.executedBatches).toEqual([['article-002', 'article-003']])
  expect(joined).toContain('json_extract(criteria_json')
  expect(joined).toContain('processed_count = processed_count + 2')
  expect(joined).toContain("'attempted'")
  expect(joined).toContain("'succeeded'")
  expect(joined).toContain('json_extract_string(result_manifest_json')
  expect(joined).toContain('"jobId":"job-1"')
})

test('review bulk operation worker advances export jobs through bounded keyset selection', async () => {
  const harness = createWorkerHarness({
    criteriaJson: {
      exportContract: {
        payloadBudgetBytes: 10_000_000,
        promptOutput: {includeExplanation: true, includeQuotes: true, promptIds: ['prompt-1']},
        selectedMetadata: {includeArticleId: true, includeSummary: true},
        snapshotCursor: {mode: 'keyset', orderBy: ['article_id']},
      },
      listType: 'llm',
      operation: 'export',
      prompts: {'prompt-1': ['yes']},
      sourceProjectIds: ['project-1'],
    },
    jobKind: 'review.export.selection',
  })

  const result = await runReviewBulkOperationWorkerOnce({workerId: 'worker-1'}, harness.dependencies)
  const joined = harness.statements.join('\n')

  expect(result.status).toBe('partial')
  expect(harness.executedBatches).toEqual([['article-002', 'article-003']])
  expect(joined).toContain('FROM mart.review_article_serving_v4 s')
  expect(joined).toContain("s.list_mode_key = 'llm'")
  expect(joined).toContain('ORDER BY s.article_id ASC')
  expect(joined).toContain('LIMIT 2')
  expect(joined).toContain('processed_count = processed_count + 2')
  expect(joined).not.toContain('FROM app.judgment')
  expect(joined).not.toContain('OFFSET')
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
