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

const countOccurrences = (value: string, search: string) => {
  return value.split(search).length - 1
}

const createWorkerHarness = (input?: {
  batchRows?: readonly {articleId: string}[]
  cancelRequested?: boolean
  claimed?: boolean
  criteriaJson?: unknown
  cursorJson?: unknown
  executeThrows?: boolean
  jobKind?: string
  latestSnapshotSemantics?: boolean
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
        if (input?.claimed === false) {
          return []
        }

        return [
          {
            ...jobRow,
            cancelRequested: input?.cancelRequested ?? false,
            criteriaJson: input?.criteriaJson ?? jobRow.criteriaJson,
            cursorJson: input?.cursorJson ?? jobRow.cursorJson,
            jobKind: input?.jobKind ?? jobRow.jobKind,
            latestSnapshotSemantics: input?.latestSnapshotSemantics ?? jobRow.latestSnapshotSemantics,
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
  expect(joined).toContain("status = 'running' AND updated_at < current_timestamp - INTERVAL 15 MINUTE")
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

test('review bulk operation worker skips a job when the conditional claim loses a race', async () => {
  const harness = createWorkerHarness({claimed: false})
  const result = await runReviewBulkOperationWorkerOnce({workerId: 'worker-1'}, harness.dependencies)
  const joined = harness.statements.join('\n')

  expect(result).toEqual({jobId: null, status: 'idle', workerId: 'worker-1'})
  expect(harness.executedBatches).toEqual([])
  expect(joined).toContain('UPDATE app.review_bulk_operation_job')
  expect(joined).toContain('RETURNING')
  expect(joined).not.toContain('processed_count = processed_count + 2')
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
      prompts: {'prompt-1': ['yes', 'maybe'], 'prompt-2': ['no']},
      targetProjectId: 'target-project-1',
      to: '2020',
    },
  })

  await runReviewBulkOperationWorkerOnce({workerId: 'worker-1'}, harness.dependencies)

  const joined = harness.statements.join('\n')

  expect(joined).toContain('FROM mart.review_article_serving_base_v4 s')
  expect(joined).toContain('INNER JOIN mart.review_article_serving_list_mode_state_v4 list_mode_state')
  expect(joined).toContain('list_mode_state.has_both_list_mode IS TRUE')
  expect(joined).toContain("list_mode_state.human_status = 'answered'")
  expect(joined).toContain("list_mode_state.llm_status = 'answered'")
  expect(joined).not.toContain('review_article_filter_state_serving_v4')
  expect(joined).not.toContain('humanStatusFilter.article_ids')
  expect(joined).not.toContain('llmStatusFilter.article_ids')
  expect(joined).not.toContain('s.human_status_key')
  expect(joined).not.toContain('s.llm_status_key')
  expect(joined).toContain('list_mode_state.duplicate_flag IS TRUE')
  expect(joined).toContain('list_mode_state.conflict_flag IS TRUE')
  expect(joined).toContain("s.article_created_at >= TIMESTAMPTZ '2010'")
  expect(joined).toContain("s.article_created_at <= TIMESTAMPTZ '2020'")
  expect(joined).not.toContain('s.sort_key')
  expect(joined).toContain('prompt_filter_values(prompt_filter_index, filter_value) AS')
  expect(joined).toContain('prompt_filter_article_ids AS')
  expect(joined).toContain('CROSS JOIN UNNEST(prompt_filter.article_ids) AS prompt_filter_article(article_id)')
  expect(joined).toContain('INNER JOIN prompt_filtered_article_ids prompt_filter_ids')
  expect(joined).toContain('prompt_filter_ids.article_id = s.article_id')
  expect(joined).toContain("prompt_filter.filter_kind = 'promptAnswer'")
  expect(joined).toContain('review:promptAnswer:prompt-1:yes')
  expect(joined).toContain('review:promptAnswer:prompt-1:maybe')
  expect(joined).toContain('review:promptAnswer:prompt-2:no')
  expect(joined).toContain('HAVING COUNT(DISTINCT prompt_filter_index) = 2')
  expect(joined).not.toMatch(/list_contains\(prompt_filter_\d+\.article_ids,\s*s\.article_id\)/)
  expect(joined).toContain('ORDER BY s.article_id ASC')
  expect(joined).toContain('LIMIT 2')
  expect(joined).not.toContain('FROM app.article')
})

test('review bulk operation worker applies unassessed queue scope for filter criteria', async () => {
  const harness = createWorkerHarness({criteriaJson: {listType: 'unassessed', operation: 'export'}})

  await runReviewBulkOperationWorkerOnce({workerId: 'worker-1'}, harness.dependencies)

  const joined = harness.statements.join('\n')

  expect(joined).toContain('list_mode_state.has_unassessed_list_mode IS TRUE')
  expect(joined).toContain('FROM mart.review_unassessed_queue_serving_v4 queue')
  expect(joined).toContain("queue.queue_kind = 'unassessed'")
})

test('review bulk operation worker does not fall back to LLM membership for unknown persisted list types', async () => {
  const harness = createWorkerHarness({criteriaJson: {listType: 'retired-list-mode', operation: 'export'}})

  await runReviewBulkOperationWorkerOnce({workerId: 'worker-1'}, harness.dependencies)

  const joined = harness.statements.join('\n')

  expect(joined).toContain('AND FALSE')
  expect(joined).not.toContain('list_mode_state.has_llm_list_mode IS TRUE')
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

test('review bulk operation worker keeps project PDF jobs out of review-tab defaults', async () => {
  const harness = createWorkerHarness({
    criteriaJson: {operation: 'pdfFetch', selectionScope: 'project', sourceProjectId: 'project-1'},
    jobKind: 'review.pdf.selection',
  })

  await runReviewBulkOperationWorkerOnce({workerId: 'worker-1'}, harness.dependencies)

  const joined = harness.statements.join('\n')

  expect(joined).toContain('FROM mart.review_article_serving_base_v4 s')
  expect(joined).toContain('list_mode_state.has_llm_list_mode IS TRUE')
  expect(joined).not.toContain('s.llm_judged_prompt_count > 0')
  expect(joined).not.toContain('s.llm_status_key')
  expect(joined).not.toContain('s.human_status_key')
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
  expect(joined).toContain('FROM mart.review_article_serving_base_v4 s')
  expect(joined).toContain('list_mode_state.has_llm_list_mode IS TRUE')
  expect(joined).toContain('list_mode_state.llm_has_judgment IS TRUE')
  expect(joined).not.toContain('FROM mart.review_article_judgment_detail_serving_v4 llm_judgment_detail')
  expect(joined).not.toContain('s.llm_judged_prompt_count > 0')
  expect(joined).toContain('ORDER BY s.article_id ASC')
  expect(joined).toContain('LIMIT 2')
  expect(joined).toContain('processed_count = processed_count + 2')
  expect(joined).not.toContain('FROM app.judgment')
  expect(joined).not.toContain('OFFSET')
})

test('review bulk operation worker scopes mixed-source metadata exports by source review config hash', async () => {
  const harness = createWorkerHarness({
    criteriaJson: {
      exportContract: {
        payloadBudgetBytes: 10_000_000,
        selectedMetadata: {includeArticleId: true},
        snapshotCursor: {mode: 'keyset', orderBy: ['article_id']},
      },
      operation: 'export',
      selectionScope: 'project',
      sourceProjectIds: ['project-1', 'project-2'],
      sourceProjectReviewConfigHashes: {'project-1': 'config-1', 'project-2': 'config-2'},
    },
    jobKind: 'review.export.selection',
  })

  await runReviewBulkOperationWorkerOnce({workerId: 'worker-1'}, harness.dependencies)

  const joined = harness.statements.join('\n')

  expect(joined).toContain(
    "CASE source_project.project_id WHEN 'project-1' THEN 'config-1' WHEN 'project-2' THEN 'config-2'",
  )
  expect(joined).toContain('snapshot_scope.review_config_hash IS NOT DISTINCT FROM s.review_config_hash')
  expect(joined).not.toContain('s.review_config_hash IS NOT DISTINCT FROM NULL')
})

test('review bulk operation worker tokenizes title search criteria for durable jobs', async () => {
  const harness = createWorkerHarness({
    criteriaJson: {
      listType: 'llm',
      operation: 'export',
      search: 'COVID-19 heart failure',
      selectionScope: 'project',
      sourceProjectIds: ['project-1'],
    },
    cursorJson: {},
    jobKind: 'review.export.selection',
  })

  await runReviewBulkOperationWorkerOnce({workerId: 'worker-1'}, harness.dependencies)

  const joined = harness.statements.join('\n')

  expect(joined).toContain('search_prefixes AS')
  expect(joined).toContain("SELECT unnest(['covid', '19', 'heart', 'failure']::VARCHAR[]) AS token_prefix")
  expect(joined).not.toContain('search_candidate_article_ids AS')
  expect(joined).toContain('search_filtered_article_ids AS')
  expect(joined).toContain('INNER JOIN search_prefixes search_prefix')
  expect(joined).toContain('ON starts_with(search.token, search_prefix.token_prefix)')
  expect(joined.indexOf('ON starts_with(search.token, search_prefix.token_prefix)')).toBeLessThan(
    joined.indexOf('CROSS JOIN UNNEST(search.article_ids) AS search_article(article_id)'),
  )
  expect(joined).toContain('HAVING COUNT(DISTINCT search_prefix.token_prefix) = 4')
  expect(joined).toContain('INNER JOIN search_filtered_article_ids search_filter_ids')
  expect(joined).toContain('search_filter_ids.article_id = s.article_id')
  expect(joined).toContain('snapshot_scope AS')
  expect(joined).toContain("json_extract_string(search_component.value, '$.component') = 'search'")
  expect(joined).toContain('snapshot_scope.search_identity')
  expect(joined).toContain('snapshot_scope.project_scope_identity')
  expect(countOccurrences(joined, "json_extract(manifest.component_state_json, '$.optional')")).toBe(1)
  expect(countOccurrences(joined, '$.projectScope.projectionIdentity')).toBe(1)
  expect(joined).not.toContain('list_contains(search.article_ids, s.article_id)')
  expect(joined).not.toMatch(/list_contains\(search_\d+\.article_ids,\s*s\.article_id\)/)
  expect(joined).not.toContain('$.optional[0].projectionIdentity')
  expect(joined).not.toContain("starts_with(search.token, 'covid-19 heart failure')")
})

test('review bulk operation worker bounds title search by narrowed prompt candidates', async () => {
  const harness = createWorkerHarness({
    criteriaJson: {
      listType: 'llm',
      operation: 'export',
      prompts: {'prompt-1': ['yes']},
      search: 'heart failure',
      sourceProjectIds: ['project-1'],
    },
    jobKind: 'review.export.selection',
  })

  await runReviewBulkOperationWorkerOnce({workerId: 'worker-1'}, harness.dependencies)

  const joined = harness.statements.join('\n')

  expect(joined).toContain('prompt_filtered_article_ids AS')
  expect(joined).toContain('search_candidate_article_ids AS')
  expect(joined).toContain('INNER JOIN prompt_filtered_article_ids prompt_filter_ids')
  expect(joined).toContain('prompt_filter_ids.article_id = s.article_id')
  expect(joined).toContain('list_mode_state.llm_has_judgment IS TRUE')
  expect(joined).toContain('FROM search_candidate_article_ids c')
  expect(joined).toContain('INNER JOIN search_candidate_article_ids search_candidate')
  expect(joined).toContain('AND search_candidate.article_id = search_article.article_id')
  expect(joined).toContain('expanded_search_article_ids.article_id AS article_id')
  expect(joined).toContain('CROSS JOIN UNNEST(search.article_ids) AS search_article(article_id)')
  expect(joined).not.toContain('list_contains(search.article_ids, search_candidate.article_id)')
  expect(joined.indexOf('search_candidate_article_ids AS')).toBeLessThan(
    joined.indexOf('search_filtered_article_ids AS'),
  )
})

test('review bulk operation worker keeps latest-snapshot source review configs in candidate-bound search', async () => {
  const harness = createWorkerHarness({
    criteriaJson: {
      from: '2020-01-01',
      operation: 'export',
      search: 'heart failure',
      selectionScope: 'project',
      sourceProjectIds: ['project-1', 'project-2'],
      sourceProjectReviewConfigHashes: {'project-1': 'config-1', 'project-2': 'config-2'},
    },
    jobKind: 'review.export.selection',
    latestSnapshotSemantics: true,
  })

  await runReviewBulkOperationWorkerOnce({workerId: 'worker-1'}, harness.dependencies)

  const joined = harness.statements.join('\n')

  expect(joined).toContain('search_candidate_article_ids AS')
  expect(joined).toContain(
    "CASE source_project.project_id WHEN 'project-1' THEN 'config-1' WHEN 'project-2' THEN 'config-2'",
  )
  expect(joined).toContain('snapshot_scope.review_config_hash IS NOT DISTINCT FROM s.review_config_hash')
  expect(joined).toContain('FROM search_candidate_article_ids c')
  expect(joined).toContain('snapshot_scope AS')
  expect(joined).toContain('manifest.project_id = source_project.project_id')
  expect(joined).toContain('manifest.review_config_hash IS NOT DISTINCT FROM CASE source_project.project_id')
  expect(joined).toContain("manifest.snapshot_status = 'active'")
  expect(joined).toContain("json_extract_string(search_component.value, '$.component') = 'search'")
  expect(joined).toContain('snapshot_scope.search_identity')
  expect(joined).toContain('snapshot_scope.project_scope_identity')
  expect(countOccurrences(joined, "json_extract(manifest.component_state_json, '$.optional')")).toBe(1)
  expect(countOccurrences(joined, '$.projectScope.projectionIdentity')).toBe(1)
  expect(joined).not.toContain('s.review_config_hash IS NOT DISTINCT FROM NULL')
})

test('review bulk operation worker heartbeats running jobs while executing batches', async () => {
  const harness = createWorkerHarness()

  await runReviewBulkOperationWorkerOnce({workerId: 'worker-1'}, harness.dependencies)

  const joined = harness.statements.join('\n')

  expect(joined).toContain('SET updated_at = current_timestamp')
  expect(joined).toContain("AND status = 'running'")
  expect(joined).toContain('AND completed_at IS NULL')
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
