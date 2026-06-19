import {hostname} from 'node:os'

import {sleep} from '../../utils/sleep.ts'
import {getReviewServingTitleSearchTokens} from '../reviewServing/reviewServingTitleSearchProjector.ts'
import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getJsonValue, getSqlLiteral} from '../services/appQueryHelpers.ts'
import {insertArticlesIntoProject} from '../services/insertArticlesIntoProject.ts'
import {type PdfFetchBatchStats, processPdfFetchArticleIds} from '../services/pdfFetchJobs.ts'
import type {DuckdbWorkloadContext} from '../utils/duckdbService.ts'

type ReviewBulkOperationWorkerDatabase = {
  queryJson: <T>(statement: string, workloadContext?: DuckdbWorkloadContext) => Promise<T[]>
  run: (statement: string, workloadContext?: DuckdbWorkloadContext) => Promise<void>
  transaction: <T>(
    operation: (tx: ReviewBulkOperationWorkerTransaction) => Promise<T>,
    workloadContext?: DuckdbWorkloadContext,
  ) => Promise<T>
}

type ReviewBulkOperationWorkerTransaction = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
}

type ReviewBulkOperationJobRow = {
  batchSize: number
  cancelRequested: boolean
  criteriaJson: unknown
  cursorJson: unknown
  jobId: string
  jobKind: string
  latestSnapshotSemantics: boolean
  processedCount: number
  projectId: string
  retryCount: number
  reviewConfigHash: string | null
  snapshotId: string | null
  status: string
  totalEstimate: number | null
}

type ReviewBulkOperationCriteria = {
  articleIds?: readonly string[]
  concurrency?: number
  exportContract?: unknown
  forceRefetch?: boolean
  from?: string
  hasDuplicateStudyRecords?: boolean
  hasStudyDecisionConflict?: boolean
  humanStatus?: string
  listType?: string
  llmStatus?: string
  operation?: string
  prompts?: Record<string, readonly string[]>
  requestId?: string
  search?: string
  sourceProjectIds?: readonly string[]
  targetProjectId?: string
  to?: string
}

type ReviewBulkOperationCursor = {cursor?: string | null; limit?: number}

type ReviewBulkOperationBatchRow = {articleId: string}

type ReviewBulkOperationWorkerOptions = {batchSize?: number; maxRetries?: number; now?: Date; workerId?: string}

type ReviewBulkOperationBatchResult = {exportArticleIds?: readonly string[]; pdfStats?: PdfFetchBatchStats} | undefined

type ReviewBulkOperationWorkerLoopOptions = ReviewBulkOperationWorkerOptions & {
  errorBackoffMs?: number
  pollIntervalMs?: number
  signal?: AbortSignal
}

export type ReviewBulkOperationWorkerDependencies = {
  executeBatch?: (input: {
    articleIds: readonly string[]
    database: ReviewBulkOperationWorkerDatabase
    insertArticles?: typeof insertArticlesIntoProject
    job: ReviewBulkOperationJobRow
  }) => Promise<ReviewBulkOperationBatchResult>
  getDatabase?: () => ReviewBulkOperationWorkerDatabase
  insertArticles?: typeof insertArticlesIntoProject
  sleep?: typeof sleep
}

type ReviewBulkOperationWorkerResult =
  | {jobId: null; status: 'idle'; workerId: string}
  | {jobId: string; processedCount: number; status: 'cancelled' | 'completed' | 'failed' | 'partial'; workerId: string}

const defaultBatchSize = 500
const defaultMaxRetries = 3
const defaultPollIntervalMs = 2_000
const defaultErrorBackoffMs = 10_000
const routeOrJobKey = 'reviewBulkOperation.worker'

const getDatabase = () => {
  return getAppDatabaseService() as ReviewBulkOperationWorkerDatabase
}

const getWorkerId = (workerId: string | undefined) => {
  return workerId ?? `review-bulk-operation:${hostname()}:${process.pid}`
}

const getWorkloadContext = (workerId: string): DuckdbWorkloadContext => {
  return {fallbackIntent: 'reject', routeOrJobKey: `${routeOrJobKey}:${workerId}`, workloadClass: 'bulkReviewJob'}
}

const getNumber = (value: unknown, fallback: number) => {
  const number = Number(value)

  return Number.isFinite(number) ? number : fallback
}

const getCriteria = (job: ReviewBulkOperationJobRow): ReviewBulkOperationCriteria => {
  const value = getJsonValue(job.criteriaJson)

  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

const getCursor = (job: ReviewBulkOperationJobRow): ReviewBulkOperationCursor => {
  const value = getJsonValue(job.cursorJson)

  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

const getBatchLimit = (job: ReviewBulkOperationJobRow, options: ReviewBulkOperationWorkerOptions) => {
  return Math.max(1, Math.min(getNumber(options.batchSize ?? job.batchSize, defaultBatchSize), defaultBatchSize))
}

const getClaimableJob = async (
  database: ReviewBulkOperationWorkerDatabase,
  workerId: string,
): Promise<ReviewBulkOperationJobRow | null> => {
  const workloadContext = getWorkloadContext(workerId)

  return database.transaction(async (tx) => {
    const [candidate] = await tx.queryJson<{jobId: string}>(`
      SELECT job_id AS jobId
      FROM app.review_bulk_operation_job
      WHERE status = 'pending'
        AND completed_at IS NULL
      ORDER BY updated_at ASC, job_id ASC
      LIMIT 1
    `)

    if (!candidate) {
      return null
    }

    await tx.run(`
      UPDATE app.review_bulk_operation_job
      SET status = 'running', updated_at = current_timestamp
      WHERE job_id = ${getSqlLiteral(candidate.jobId)}
        AND status = 'pending'
        AND completed_at IS NULL
    `)

    const [job] = await tx.queryJson<ReviewBulkOperationJobRow>(`
      SELECT
        job_id AS jobId,
        job_kind AS jobKind,
        project_id AS projectId,
        snapshot_id AS snapshotId,
        latest_snapshot_semantics AS latestSnapshotSemantics,
        review_config_hash AS reviewConfigHash,
        criteria_json AS criteriaJson,
        cursor_json AS cursorJson,
        batch_size AS batchSize,
        status,
        processed_count AS processedCount,
        total_estimate AS totalEstimate,
        cancel_requested AS cancelRequested,
        retry_count AS retryCount
      FROM app.review_bulk_operation_job
      WHERE job_id = ${getSqlLiteral(candidate.jobId)}
      LIMIT 1
    `)

    return job ?? null
  }, workloadContext)
}

const getExplicitArticleBatchSql = (job: ReviewBulkOperationJobRow, cursor: string | null, limit: number) => {
  const cursorPredicate = cursor ? `WHERE article_id > ${getSqlLiteral(cursor)}` : ''

  return `
    SELECT article_id AS articleId
    FROM (
      SELECT CAST(unnest(json_extract(criteria_json, '$.articleIds')::VARCHAR[]) AS VARCHAR) AS article_id
      FROM app.review_bulk_operation_job
      WHERE job_id = ${getSqlLiteral(job.jobId)}
    ) article_ids
    ${cursorPredicate}
    ORDER BY article_id ASC
    LIMIT ${getSqlLiteral(limit)}
  `
}

const getListModeKey = (criteria: ReviewBulkOperationCriteria) => {
  return criteria.listType ?? 'llm'
}

const getSourceProjectIds = (job: ReviewBulkOperationJobRow, criteria: ReviewBulkOperationCriteria) => {
  return criteria.sourceProjectIds && criteria.sourceProjectIds.length > 0 ? criteria.sourceProjectIds : [job.projectId]
}

const getTabStatusPredicates = (criteria: ReviewBulkOperationCriteria) => {
  const listMode = getListModeKey(criteria)
  const humanStatusPredicate =
    listMode === 'human' || listMode === 'both'
      ? `AND s.human_status_key = ${getSqlLiteral(criteria.humanStatus ?? 'answered')}`
      : ''
  const llmStatusPredicate =
    listMode === 'both'
      ? `AND s.llm_status_key = ${getSqlLiteral('answered')}`
      : criteria.llmStatus === 'complete'
        ? `AND s.llm_status_key = ${getSqlLiteral('answered')}`
        : criteria.llmStatus === 'partial'
          ? `AND s.llm_status_key = ${getSqlLiteral('unanswered')}`
          : ''
  const queuePredicate =
    listMode === 'unassessed'
      ? `AND EXISTS (
        SELECT 1
        FROM mart.review_unassessed_queue_serving_v4 queue
        WHERE queue.project_id = s.project_id
          AND queue.review_config_hash IS NOT DISTINCT FROM s.review_config_hash
          AND queue.snapshot_id = s.snapshot_id
          AND queue.queue_kind = ${getSqlLiteral('unassessed')}
          AND queue.article_id = s.article_id
      )`
      : ''

  return [humanStatusPredicate, llmStatusPredicate, queuePredicate].filter(Boolean).join('\n')
}

const getExclusiveDateToFilter = (value: string) => {
  if (!isDateOnlyFilter(value)) {
    return value
  }

  const date = new Date(`${value}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + 1)

  return date.toISOString().slice(0, 10)
}

const isDateOnlyFilter = (value: string) => {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
}

const getDateToPredicate = (column: string, value: string | undefined) => {
  return value
    ? `AND ${column} ${isDateOnlyFilter(value) ? '<' : '<='} TIMESTAMPTZ ${getSqlLiteral(getExclusiveDateToFilter(value))}`
    : ''
}

const getPromptAnswerPredicates = (criteria: ReviewBulkOperationCriteria) => {
  const promptPrefix = getListModeKey(criteria) === 'human' ? 'human:promptAnswer:' : 'review:promptAnswer:'

  return Object.entries(criteria.prompts ?? {})
    .filter(([, values]) => {
      return values.length > 0
    })
    .map(([promptId, values], index) => {
      const filterValues = values.map((value) => {
        return `${promptPrefix}${promptId}:${value}`
      })

      return `AND EXISTS (
        SELECT 1
        FROM mart.review_article_filter_posting_serving_v4 prompt_filter_${index}
        WHERE prompt_filter_${index}.project_id = s.project_id
          AND prompt_filter_${index}.snapshot_id = s.snapshot_id
          AND prompt_filter_${index}.review_config_hash = s.review_config_hash
          AND prompt_filter_${index}.list_mode_key = s.list_mode_key
          AND prompt_filter_${index}.article_id = s.article_id
          AND prompt_filter_${index}.filter_kind = 'promptAnswer'
          AND prompt_filter_${index}.filter_value IN (SELECT unnest(${getSqlLiteral(filterValues)}::VARCHAR[]))
      )`
    })
}

const getPostingFilterPredicates = (criteria: ReviewBulkOperationCriteria) => {
  const simpleFilters = [
    criteria.hasDuplicateStudyRecords ? {kind: 'duplicateFlag', value: 'true'} : null,
    criteria.hasStudyDecisionConflict ? {kind: 'conflictFlag', value: 'true'} : null,
  ].filter((filter): filter is {kind: string; value: string} => {
    return filter !== null
  })
  const simplePredicates = simpleFilters.map((filter, index) => {
    return `AND EXISTS (
      SELECT 1
      FROM mart.review_article_filter_posting_serving_v4 filter_${index}
      WHERE filter_${index}.project_id = s.project_id
        AND filter_${index}.snapshot_id = s.snapshot_id
        AND filter_${index}.review_config_hash = s.review_config_hash
        AND filter_${index}.list_mode_key = s.list_mode_key
        AND filter_${index}.article_id = s.article_id
        AND filter_${index}.filter_kind = ${getSqlLiteral(filter.kind)}
        AND filter_${index}.filter_value = ${getSqlLiteral(filter.value)}
    )`
  })
  const datePredicate =
    criteria.from || criteria.to
      ? `${criteria.from ? `AND s.sort_key >= TIMESTAMPTZ ${getSqlLiteral(criteria.from)}` : ''}
         ${getDateToPredicate('s.sort_key', criteria.to)}`
      : ''

  return [...simplePredicates, datePredicate, ...getPromptAnswerPredicates(criteria)].join('\n')
}

const getServingArticleBatchSql = (job: ReviewBulkOperationJobRow, cursor: string | null, limit: number) => {
  const criteria = getCriteria(job)
  const sourceProjectIds = getSourceProjectIds(job, criteria)
  const searchTokens = getReviewServingTitleSearchTokens(criteria.search ?? null)
  const searchIdentitySql = job.latestSnapshotSemantics
    ? `(SELECT json_extract_string(component_state_json, '$.optional[0].projectionIdentity') FROM app.review_serving_snapshot_manifest WHERE project_id = s.project_id AND review_config_hash IS NOT DISTINCT FROM ${getSqlLiteral(job.reviewConfigHash)} AND snapshot_status = 'active' ORDER BY updated_at DESC, snapshot_id DESC LIMIT 1)`
    : `(SELECT json_extract_string(component_state_json, '$.optional[0].projectionIdentity') FROM app.review_serving_snapshot_manifest WHERE project_id = s.project_id AND snapshot_id = ${getSqlLiteral(job.snapshotId)} LIMIT 1)`
  const snapshotPredicate = job.latestSnapshotSemantics
    ? `s.snapshot_id = (SELECT snapshot_id FROM app.review_serving_snapshot_manifest WHERE project_id = s.project_id AND review_config_hash IS NOT DISTINCT FROM ${getSqlLiteral(job.reviewConfigHash)} AND snapshot_status = 'active' ORDER BY updated_at DESC, snapshot_id DESC LIMIT 1)`
    : `s.snapshot_id = ${getSqlLiteral(job.snapshotId)}`
  const searchPredicate = searchTokens
    .map((token, index) => {
      return `AND EXISTS (
        SELECT 1
        FROM mart.review_title_search_serving_v4 search_${index}
        WHERE search_${index}.project_id = s.project_id
          AND search_${index}.search_identity = ${searchIdentitySql}
          AND search_${index}.project_scope_identity = s.project_scope_identity
          AND search_${index}.snapshot_id = s.snapshot_id
          AND search_${index}.article_id = s.article_id
          AND starts_with(search_${index}.token, ${getSqlLiteral(token)})
      )`
    })
    .join('\n')

  return `
    SELECT DISTINCT s.article_id AS articleId
    FROM mart.review_article_serving_v4 s
    WHERE s.project_id IN (SELECT unnest(${getSqlLiteral(sourceProjectIds)}::VARCHAR[]))
      AND ${snapshotPredicate}
      AND s.review_config_hash IS NOT DISTINCT FROM ${getSqlLiteral(job.reviewConfigHash)}
      AND s.list_mode_key = ${getSqlLiteral(getListModeKey(criteria))}
      ${getTabStatusPredicates(criteria)}
      ${cursor ? `AND s.article_id > ${getSqlLiteral(cursor)}` : ''}
      ${getPostingFilterPredicates(criteria)}
      ${searchPredicate}
    ORDER BY s.article_id ASC
    LIMIT ${getSqlLiteral(limit)}
  `
}

const getArticleBatch = async (
  job: ReviewBulkOperationJobRow,
  database: ReviewBulkOperationWorkerDatabase,
  options: ReviewBulkOperationWorkerOptions,
  workerId: string,
) => {
  const criteria = getCriteria(job)
  const cursor = getCursor(job).cursor ?? null
  const limit = getBatchLimit(job, options)

  if (job.jobKind === 'review.bulk.substringSelection') {
    throw new Error('Substring bulk selection is waiting for async search results')
  }

  const sql = Array.isArray(criteria.articleIds)
    ? getExplicitArticleBatchSql(job, cursor, limit)
    : getServingArticleBatchSql(job, cursor, limit)

  return database.queryJson<ReviewBulkOperationBatchRow>(sql, getWorkloadContext(workerId))
}

const markCancelled = async (jobId: string, database: ReviewBulkOperationWorkerDatabase, workerId: string) => {
  await database.run(
    `
      UPDATE app.review_bulk_operation_job
      SET status = 'cancelled', completed_at = current_timestamp, updated_at = current_timestamp
      WHERE job_id = ${getSqlLiteral(jobId)}
    `,
    getWorkloadContext(workerId),
  )
}

const markCompleted = async (jobId: string, database: ReviewBulkOperationWorkerDatabase, workerId: string) => {
  await database.run(
    `
      UPDATE app.review_bulk_operation_job
      SET status = 'completed', completed_at = current_timestamp, updated_at = current_timestamp, last_error = NULL
      WHERE job_id = ${getSqlLiteral(jobId)}
    `,
    getWorkloadContext(workerId),
  )
}

const markPending = async (jobId: string, database: ReviewBulkOperationWorkerDatabase, workerId: string) => {
  await database.run(
    `
      UPDATE app.review_bulk_operation_job
      SET status = 'pending', updated_at = current_timestamp, last_error = NULL
      WHERE job_id = ${getSqlLiteral(jobId)}
    `,
    getWorkloadContext(workerId),
  )
}

const markProgress = async (input: {
  articleIds: readonly string[]
  database: ReviewBulkOperationWorkerDatabase
  job: ReviewBulkOperationJobRow
  exportArticleIds?: readonly string[]
  pdfStats?: PdfFetchBatchStats
  workerId: string
}) => {
  const lastArticleId = input.articleIds[input.articleIds.length - 1] ?? null
  const manifestSql = input.pdfStats
    ? `json_object(
        'attempted', COALESCE(TRY_CAST(json_extract_string(result_manifest_json, '$.attempted') AS BIGINT), 0) + ${getSqlLiteral(input.pdfStats.attempted)},
        'failed', COALESCE(TRY_CAST(json_extract_string(result_manifest_json, '$.failed') AS BIGINT), 0) + ${getSqlLiteral(input.pdfStats.failed)},
        'noPdf', COALESCE(TRY_CAST(json_extract_string(result_manifest_json, '$.noPdf') AS BIGINT), 0) + ${getSqlLiteral(input.pdfStats.noPdf)},
        'skipped', COALESCE(TRY_CAST(json_extract_string(result_manifest_json, '$.skipped') AS BIGINT), 0) + ${getSqlLiteral(input.pdfStats.skipped)},
        'succeeded', COALESCE(TRY_CAST(json_extract_string(result_manifest_json, '$.succeeded') AS BIGINT), 0) + ${getSqlLiteral(input.pdfStats.succeeded)},
        'lastArticleId', ${getSqlLiteral(lastArticleId)},
        'lastBatchSize', ${getSqlLiteral(input.articleIds.length)}
      )`
    : input.exportArticleIds
      ? `json_object(
        'batches', json_merge_patch(
          COALESCE(json_extract(result_manifest_json, '$.batches'), '{}'::JSON),
          json_object(${getSqlLiteral(lastArticleId ?? 'empty')}, ${getSqlLiteral(input.exportArticleIds)}::JSON)
        ),
        'lastArticleId', ${getSqlLiteral(lastArticleId)},
        'lastBatchSize', ${getSqlLiteral(input.articleIds.length)}
      )`
      : `${getSqlLiteral({lastArticleId, lastBatchSize: input.articleIds.length})}::JSON`

  await input.database.run(
    `
      UPDATE app.review_bulk_operation_job
      SET
        cursor_json = ${getSqlLiteral({cursor: lastArticleId, jobId: input.job.jobId, limit: input.job.batchSize})}::JSON,
        processed_count = processed_count + ${getSqlLiteral(input.articleIds.length)},
        result_manifest_json = ${manifestSql},
        updated_at = current_timestamp,
        last_error = NULL
      WHERE job_id = ${getSqlLiteral(input.job.jobId)}
    `,
    getWorkloadContext(input.workerId),
  )
}

const markFailed = async (input: {
  database: ReviewBulkOperationWorkerDatabase
  error: unknown
  job: ReviewBulkOperationJobRow
  maxRetries: number
  workerId: string
}) => {
  const message = input.error instanceof Error ? input.error.message : String(input.error)
  const retryable = input.job.retryCount < input.maxRetries
  const status = retryable ? 'pending' : 'failed'
  const completedAt = retryable ? 'NULL' : 'current_timestamp'

  await input.database.run(
    `
      UPDATE app.review_bulk_operation_job
      SET
        status = ${getSqlLiteral(status)},
        retry_count = retry_count + 1,
        last_error = ${getSqlLiteral(message)},
        completed_at = ${completedAt},
        updated_at = current_timestamp
      WHERE job_id = ${getSqlLiteral(input.job.jobId)}
    `,
    getWorkloadContext(input.workerId),
  )

  return retryable ? 'partial' : 'failed'
}

const executeDefaultBatch = async (input: {
  articleIds: readonly string[]
  database: ReviewBulkOperationWorkerDatabase
  insertArticles?: typeof insertArticlesIntoProject
  job: ReviewBulkOperationJobRow
}): Promise<ReviewBulkOperationBatchResult> => {
  const criteria = getCriteria(input.job)

  if (criteria.operation === 'pdfFetch') {
    const pdfStats = await processPdfFetchArticleIds({
      articleIds: input.articleIds,
      concurrency: criteria.concurrency,
      forceRefetch: criteria.forceRefetch,
    })

    return {pdfStats}
  }

  if (criteria.operation === 'export') {
    return {exportArticleIds: input.articleIds}
  }

  if (criteria.operation !== 'addToProject' || !criteria.targetProjectId || input.articleIds.length === 0) {
    return
  }

  await (input.insertArticles ?? insertArticlesIntoProject)(
    criteria.targetProjectId,
    [...input.articleIds],
    input.job.projectId,
  )
}

export const runReviewBulkOperationWorkerOnce = async (
  options: ReviewBulkOperationWorkerOptions = {},
  dependencies: ReviewBulkOperationWorkerDependencies = {},
): Promise<ReviewBulkOperationWorkerResult> => {
  const workerId = getWorkerId(options.workerId)
  const database = dependencies.getDatabase?.() ?? getDatabase()
  const job = await getClaimableJob(database, workerId)

  if (!job) {
    return {jobId: null, status: 'idle', workerId}
  }

  if (job.cancelRequested) {
    await markCancelled(job.jobId, database, workerId)
    return {jobId: job.jobId, processedCount: job.processedCount, status: 'cancelled', workerId}
  }

  try {
    const rows = await getArticleBatch(job, database, options, workerId)
    const articleIds = rows.map((row) => {
      return row.articleId
    })
    const executeBatch = dependencies.executeBatch ?? executeDefaultBatch

    const batchResult = await executeBatch({articleIds, database, insertArticles: dependencies.insertArticles, job})
    const pdfStats = batchResult && 'pdfStats' in batchResult ? batchResult.pdfStats : undefined
    const exportArticleIds = batchResult && 'exportArticleIds' in batchResult ? batchResult.exportArticleIds : undefined
    await markProgress({articleIds, database, exportArticleIds, job, pdfStats, workerId})

    if (articleIds.length < getBatchLimit(job, options)) {
      await markCompleted(job.jobId, database, workerId)
      return {jobId: job.jobId, processedCount: job.processedCount + articleIds.length, status: 'completed', workerId}
    }

    await markPending(job.jobId, database, workerId)
    return {jobId: job.jobId, processedCount: job.processedCount + articleIds.length, status: 'partial', workerId}
  } catch (error) {
    const status = await markFailed({
      database,
      error,
      job,
      maxRetries: options.maxRetries ?? defaultMaxRetries,
      workerId,
    })

    return {jobId: job.jobId, processedCount: job.processedCount, status, workerId}
  }
}

export const runReviewBulkOperationWorker = async (
  options: ReviewBulkOperationWorkerLoopOptions = {},
  dependencies: ReviewBulkOperationWorkerDependencies = {},
): Promise<void> => {
  const pollIntervalMs = options.pollIntervalMs ?? defaultPollIntervalMs
  const errorBackoffMs = options.errorBackoffMs ?? defaultErrorBackoffMs
  const sleepFn = dependencies.sleep ?? sleep

  if (options.signal?.aborted) {
    return
  }

  const result = await runReviewBulkOperationWorkerOnce(options, dependencies).catch(async (error) => {
    await sleepFn(errorBackoffMs)
    return Promise.reject(error)
  })

  await sleepFn(result.status === 'idle' ? pollIntervalMs : 0)

  return runReviewBulkOperationWorker(options, dependencies)
}
