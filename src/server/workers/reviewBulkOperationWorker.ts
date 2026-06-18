import {hostname} from 'node:os'

import {sleep} from '../../utils/sleep.ts'
import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getJsonValue, getSqlLiteral} from '../services/appQueryHelpers.ts'
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
  forceRefetch?: boolean
  from?: string
  hasDuplicateStudyRecords?: boolean
  hasStudyDecisionConflict?: boolean
  listType?: string
  llmStatus?: string
  operation?: string
  prompts?: Record<string, readonly string[]>
  requestId?: string
  search?: string
  targetProjectId?: string
  to?: string
}

type ReviewBulkOperationCursor = {cursor?: string | null; limit?: number}

type ReviewBulkOperationBatchRow = {articleId: string}

type ReviewBulkOperationWorkerOptions = {batchSize?: number; maxRetries?: number; now?: Date; workerId?: string}

type ReviewBulkOperationBatchResult = {pdfStats?: PdfFetchBatchStats} | undefined

type ReviewBulkOperationWorkerLoopOptions = ReviewBulkOperationWorkerOptions & {
  errorBackoffMs?: number
  pollIntervalMs?: number
  signal?: AbortSignal
}

export type ReviewBulkOperationWorkerDependencies = {
  executeBatch?: (input: {
    articleIds: readonly string[]
    database: ReviewBulkOperationWorkerDatabase
    job: ReviewBulkOperationJobRow
  }) => Promise<ReviewBulkOperationBatchResult>
  getDatabase?: () => ReviewBulkOperationWorkerDatabase
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
      WHERE status IN ('pending', 'running')
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
        AND status IN ('pending', 'running')
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

const getPromptAnswerPredicates = (criteria: ReviewBulkOperationCriteria) => {
  return Object.entries(criteria.prompts ?? {})
    .filter(([, values]) => {
      return values.length > 0
    })
    .map(([promptId, values], index) => {
      const filterValues = values.map((value) => {
        return `review:promptAnswer:${promptId}:${value}`
      })

      return `AND EXISTS (
        SELECT 1
        FROM mart.review_article_filter_posting_serving_v4 prompt_filter_${index}
        WHERE prompt_filter_${index}.project_id = p.project_id
          AND prompt_filter_${index}.snapshot_id = p.snapshot_id
          AND prompt_filter_${index}.review_config_hash = p.review_config_hash
          AND prompt_filter_${index}.list_mode_key = p.list_mode_key
          AND prompt_filter_${index}.article_id = p.article_id
          AND prompt_filter_${index}.filter_kind = 'promptAnswer'
          AND prompt_filter_${index}.filter_value IN (SELECT unnest(${getSqlLiteral(filterValues)}::VARCHAR[]))
      )`
    })
}

const getPostingFilterPredicates = (criteria: ReviewBulkOperationCriteria) => {
  const llmStatusValue =
    criteria.llmStatus === 'complete' ? 'answered' : criteria.llmStatus === 'partial' ? 'unanswered' : null
  const simpleFilters = [
    criteria.hasDuplicateStudyRecords ? {kind: 'duplicateFlag', value: 'true'} : null,
    criteria.hasStudyDecisionConflict ? {kind: 'conflictFlag', value: 'true'} : null,
    llmStatusValue ? {kind: 'llmStatus', value: llmStatusValue} : null,
  ].filter((filter): filter is {kind: string; value: string} => {
    return filter !== null
  })
  const simplePredicates = simpleFilters.map((filter, index) => {
    return `AND EXISTS (
      SELECT 1
      FROM mart.review_article_filter_posting_serving_v4 filter_${index}
      WHERE filter_${index}.project_id = p.project_id
        AND filter_${index}.snapshot_id = p.snapshot_id
        AND filter_${index}.review_config_hash = p.review_config_hash
        AND filter_${index}.list_mode_key = p.list_mode_key
        AND filter_${index}.article_id = p.article_id
        AND filter_${index}.filter_kind = ${getSqlLiteral(filter.kind)}
        AND filter_${index}.filter_value = ${getSqlLiteral(filter.value)}
    )`
  })
  const publicationYearPredicate =
    criteria.from || criteria.to
      ? `AND EXISTS (
        SELECT 1
        FROM mart.review_article_filter_posting_serving_v4 year_filter
        WHERE year_filter.project_id = p.project_id
          AND year_filter.snapshot_id = p.snapshot_id
          AND year_filter.review_config_hash = p.review_config_hash
          AND year_filter.list_mode_key = p.list_mode_key
          AND year_filter.article_id = p.article_id
          AND year_filter.filter_kind = 'publicationYear'
          ${criteria.from ? `AND TRY_CAST(year_filter.filter_value AS INTEGER) >= TRY_CAST(${getSqlLiteral(criteria.from)} AS INTEGER)` : ''}
          ${criteria.to ? `AND TRY_CAST(year_filter.filter_value AS INTEGER) <= TRY_CAST(${getSqlLiteral(criteria.to)} AS INTEGER)` : ''}
      )`
      : ''

  return [...simplePredicates, publicationYearPredicate, ...getPromptAnswerPredicates(criteria)].join('\n')
}

const getServingArticleBatchSql = (job: ReviewBulkOperationJobRow, cursor: string | null, limit: number) => {
  const criteria = getCriteria(job)
  const snapshotPredicate = job.latestSnapshotSemantics
    ? `p.snapshot_id = (SELECT snapshot_id FROM app.review_serving_snapshot_manifest WHERE project_id = ${getSqlLiteral(job.projectId)} AND snapshot_status = 'active' ORDER BY updated_at DESC, snapshot_id DESC LIMIT 1)`
    : `p.snapshot_id = ${getSqlLiteral(job.snapshotId)}`

  return `
    SELECT DISTINCT p.article_id AS articleId
    FROM mart.review_article_filter_posting_serving_v4 p
    WHERE p.project_id = ${getSqlLiteral(job.projectId)}
      AND ${snapshotPredicate}
      AND p.list_mode_key = ${getSqlLiteral(getListModeKey(criteria))}
      ${cursor ? `AND p.article_id > ${getSqlLiteral(cursor)}` : ''}
      ${getPostingFilterPredicates(criteria)}
    ORDER BY p.article_id ASC
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

  if (job.jobKind === 'review.bulk.substringSelection' || criteria.search) {
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

const markProgress = async (input: {
  articleIds: readonly string[]
  database: ReviewBulkOperationWorkerDatabase
  job: ReviewBulkOperationJobRow
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
  job: ReviewBulkOperationJobRow
}): Promise<ReviewBulkOperationBatchResult> => {
  const criteria = getCriteria(input.job)

  if (criteria.operation === 'pdfFetch') {
    const pdfStats = await processPdfFetchArticleIds({
      articleIds: input.articleIds,
      forceRefetch: criteria.forceRefetch,
    })

    return {pdfStats}
  }

  if (criteria.operation !== 'addToProject' || !criteria.targetProjectId || input.articleIds.length === 0) {
    return
  }

  await input.database.run(`
    INSERT INTO app.project_article (id, project_id, article_id, imported_from_project_id)
    SELECT
      'review-bulk:' || ${getSqlLiteral(input.job.jobId)} || ':' || article_id,
      ${getSqlLiteral(criteria.targetProjectId)},
      article_id,
      ${getSqlLiteral(input.job.projectId)}
    FROM (SELECT unnest(${getSqlLiteral(input.articleIds)}::VARCHAR[]) AS article_id)
    ON CONFLICT(project_id, article_id) DO NOTHING
  `)
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

    const batchResult = await executeBatch({articleIds, database, job})
    const pdfStats = batchResult && 'pdfStats' in batchResult ? batchResult.pdfStats : undefined
    await markProgress({articleIds, database, job, pdfStats, workerId})

    if (articleIds.length < getBatchLimit(job, options)) {
      await markCompleted(job.jobId, database, workerId)
      return {jobId: job.jobId, processedCount: job.processedCount + articleIds.length, status: 'completed', workerId}
    }

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
