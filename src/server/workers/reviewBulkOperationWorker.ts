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
  selectionScope?: 'project'
  sourceProjectIds?: readonly string[]
  sourceProjectReviewConfigHashes?: Record<string, string | null>
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
const staleRunningJobMinutes = 15
const runningJobHeartbeatMs = 5 * 60 * 1000
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
    const [job] = await tx.queryJson<ReviewBulkOperationJobRow>(`
      UPDATE app.review_bulk_operation_job
      SET status = 'running', updated_at = current_timestamp
      WHERE job_id = (
        SELECT job_id
        FROM app.review_bulk_operation_job
        WHERE (status = 'pending' OR (status = 'running' AND updated_at < current_timestamp - INTERVAL ${staleRunningJobMinutes} MINUTE))
          AND completed_at IS NULL
        ORDER BY updated_at ASC, job_id ASC
        LIMIT 1
      )
        AND (status = 'pending' OR (status = 'running' AND updated_at < current_timestamp - INTERVAL ${staleRunningJobMinutes} MINUTE))
        AND completed_at IS NULL
      RETURNING
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

const getServingReviewConfigHashSql = (
  job: ReviewBulkOperationJobRow,
  criteria: ReviewBulkOperationCriteria,
  tableAlias = 's',
) => {
  const hashEntries = Object.entries(criteria.sourceProjectReviewConfigHashes ?? {})

  return hashEntries.length === 0
    ? getSqlLiteral(job.reviewConfigHash)
    : `CASE ${tableAlias}.project_id ${hashEntries
        .map(([projectId, reviewConfigHash]) => {
          return `WHEN ${getSqlLiteral(projectId)} THEN ${getSqlLiteral(reviewConfigHash)}`
        })
        .join(' ')} ELSE ${getSqlLiteral(job.reviewConfigHash)} END`
}

const getTabStatusPredicates = (criteria: ReviewBulkOperationCriteria) => {
  if (criteria.selectionScope === 'project') {
    return ''
  }

  const listMode = getListModeKey(criteria)
  const getStatusStatePredicate = (filterKind: 'humanStatus' | 'llmStatus', filterValue: string) => {
    const columnName = filterKind === 'humanStatus' ? 'human_status' : 'llm_status'

    return `AND list_mode_state.${columnName} = ${getSqlLiteral(filterValue)}`
  }
  const shouldRequireLlmJudgment = shouldRequireTabLlmJudgment(criteria)
  const humanStatusPredicate =
    listMode === 'human' || listMode === 'both'
      ? getStatusStatePredicate('humanStatus', criteria.humanStatus ?? 'answered')
      : ''
  const llmStatusPredicate =
    listMode === 'both'
      ? getStatusStatePredicate('llmStatus', 'answered')
      : criteria.llmStatus === 'complete'
        ? getStatusStatePredicate('llmStatus', 'answered')
        : criteria.llmStatus === 'partial'
          ? getStatusStatePredicate('llmStatus', 'unanswered')
          : ''
  const llmHasJudgmentPredicate = shouldRequireLlmJudgment ? 'AND list_mode_state.llm_has_judgment IS TRUE' : ''
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

  return [humanStatusPredicate, llmStatusPredicate, llmHasJudgmentPredicate, queuePredicate].filter(Boolean).join('\n')
}

const shouldRequireTabLlmJudgment = (criteria: ReviewBulkOperationCriteria) => {
  if (criteria.selectionScope === 'project') {
    return false
  }

  const listMode = getListModeKey(criteria)

  return (
    listMode === 'llm' && (!criteria.llmStatus || criteria.llmStatus === 'both' || criteria.llmStatus === 'partial')
  )
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

const getPromptAnswerFilterEntries = (criteria: ReviewBulkOperationCriteria) => {
  const promptPrefix = getListModeKey(criteria) === 'human' ? 'human:promptAnswer:' : 'review:promptAnswer:'

  return Object.entries(criteria.prompts ?? {})
    .filter(([, values]) => {
      return values.length > 0
    })
    .map(([promptId, values], index) => {
      return {
        filterValues: values.map((value) => {
          return `${promptPrefix}${promptId}:${value}`
        }),
        index,
      }
    })
}

const getPromptFilteredArticleIdsCteSql = (input: {
  criteria: ReviewBulkOperationCriteria
  sourceProjectIds: readonly string[]
}) => {
  const promptFilters = getPromptAnswerFilterEntries(input.criteria)

  if (promptFilters.length === 0) {
    return ''
  }

  const promptFilterValues = promptFilters
    .map((promptFilter) => {
      return `SELECT ${getSqlLiteral(promptFilter.index)} AS prompt_filter_index, prompt_filter_value AS filter_value
      FROM (SELECT unnest(${getSqlLiteral(promptFilter.filterValues)}::VARCHAR[]) AS prompt_filter_value)`
    })
    .join('\n      UNION ALL\n      ')

  return `prompt_filter_values(prompt_filter_index, filter_value) AS (
      ${promptFilterValues}
    ),
    prompt_filter_article_ids AS (
      SELECT
        prompt_filter.project_id,
        prompt_filter.review_config_hash,
        prompt_filter.snapshot_id,
        prompt_filter_value.prompt_filter_index,
        prompt_filter_article.article_id
      FROM mart.review_article_filter_posting_serving_v4 prompt_filter
      INNER JOIN prompt_filter_values prompt_filter_value
        ON prompt_filter_value.filter_value = prompt_filter.filter_value
      INNER JOIN snapshot_scope
        ON snapshot_scope.project_id = prompt_filter.project_id
       AND snapshot_scope.review_config_hash IS NOT DISTINCT FROM prompt_filter.review_config_hash
       AND snapshot_scope.snapshot_id = prompt_filter.snapshot_id
      CROSS JOIN UNNEST(prompt_filter.article_ids) AS prompt_filter_article(article_id)
      WHERE prompt_filter.project_id IN (SELECT unnest(${getSqlLiteral(input.sourceProjectIds)}::VARCHAR[]))
        AND prompt_filter.list_mode_key = ${getSqlLiteral(getListModeKey(input.criteria))}
        AND prompt_filter.filter_kind = 'promptAnswer'
    ),
    prompt_filtered_article_ids AS (
      SELECT
        project_id,
        review_config_hash,
        snapshot_id,
        article_id
      FROM prompt_filter_article_ids
      GROUP BY project_id, review_config_hash, snapshot_id, article_id
      HAVING COUNT(DISTINCT prompt_filter_index) = ${getSqlLiteral(promptFilters.length)}
    )`
}

const getPostingFilterPredicates = (criteria: ReviewBulkOperationCriteria) => {
  const simpleFilters = [
    criteria.hasDuplicateStudyRecords ? {kind: 'duplicateFlag', value: 'true'} : null,
    criteria.hasStudyDecisionConflict ? {kind: 'conflictFlag', value: 'true'} : null,
  ].filter((filter): filter is {kind: string; value: string} => {
    return filter !== null
  })
  const simplePredicates = simpleFilters.map((filter) => {
    const columnName = filter.kind === 'duplicateFlag' ? 'duplicate_flag' : 'conflict_flag'

    return `AND list_mode_state.${columnName} IS TRUE`
  })
  const datePredicate =
    criteria.from || criteria.to
      ? `${criteria.from ? `AND s.article_created_at >= TIMESTAMPTZ ${getSqlLiteral(criteria.from)}` : ''}
         ${getDateToPredicate('s.article_created_at', criteria.to)}`
      : ''

  return [...simplePredicates, datePredicate].join('\n')
}

const getServingSnapshotScopeCteSql = (
  job: ReviewBulkOperationJobRow,
  criteria: ReviewBulkOperationCriteria,
  sourceProjectIds: readonly string[],
) => {
  const reviewConfigHashSql = getServingReviewConfigHashSql(job, criteria, 'source_project')
  const manifestPredicate = job.latestSnapshotSemantics
    ? `manifest.review_config_hash IS NOT DISTINCT FROM ${reviewConfigHashSql}
       AND manifest.snapshot_status = 'active'`
    : `manifest.snapshot_id = ${getSqlLiteral(job.snapshotId)}`
  const latestSnapshotQualifier = job.latestSnapshotSemantics
    ? `QUALIFY ROW_NUMBER() OVER (
        PARTITION BY source_project.project_id, ${reviewConfigHashSql}
        ORDER BY manifest.updated_at DESC, manifest.snapshot_id DESC
      ) = 1`
    : ''

  return `snapshot_scope AS (
      SELECT
        source_project.project_id,
        ${reviewConfigHashSql} AS review_config_hash,
        manifest.snapshot_id,
        json_extract_string(search_component.value, '$.projectionIdentity') AS search_identity,
        json_extract_string(manifest.composed_identity_json, '$.projectScope.projectionIdentity') AS project_scope_identity
      FROM (SELECT unnest(${getSqlLiteral(sourceProjectIds)}::VARCHAR[]) AS project_id) source_project
      INNER JOIN app.review_serving_snapshot_manifest manifest
        ON manifest.project_id = source_project.project_id
       AND ${manifestPredicate}
      LEFT JOIN json_each(json_extract(manifest.component_state_json, '$.optional')) search_component
        ON json_extract_string(search_component.value, '$.component') = 'search'
      ${latestSnapshotQualifier}
    )`
}

const shouldUseSearchCandidateArticleIds = (input: {
  criteria: ReviewBulkOperationCriteria
  cursor: string | null
  searchTokens: readonly string[]
}) => {
  if (input.searchTokens.length === 0) {
    return false
  }

  const tabStatusPredicates = getTabStatusPredicates(input.criteria).trim()

  return (
    getPromptAnswerFilterEntries(input.criteria).length > 0
    || tabStatusPredicates.length > 0
    || Boolean(input.criteria.from)
    || Boolean(input.criteria.to)
    || Boolean(input.criteria.hasDuplicateStudyRecords)
    || Boolean(input.criteria.hasStudyDecisionConflict)
    || Boolean(input.cursor)
  )
}

const getSearchCandidateArticleIdsCteSql = (input: {
  criteria: ReviewBulkOperationCriteria
  cursor: string | null
  sourceProjectIds: readonly string[]
}) => {
  const promptFilterJoinSql =
    getPromptAnswerFilterEntries(input.criteria).length === 0
      ? ''
      : `INNER JOIN prompt_filtered_article_ids prompt_filter_ids
      ON prompt_filter_ids.project_id = s.project_id
     AND prompt_filter_ids.review_config_hash IS NOT DISTINCT FROM s.review_config_hash
     AND prompt_filter_ids.snapshot_id = s.snapshot_id
     AND prompt_filter_ids.article_id = s.article_id`

  return `search_candidate_article_ids AS (
      SELECT DISTINCT
        s.project_id,
        s.review_config_hash,
        s.snapshot_id,
        s.article_id
      FROM mart.review_article_serving_base_v4 s
      INNER JOIN mart.review_article_serving_list_mode_state_v4 list_mode_state
        ON list_mode_state.project_id = s.project_id
       AND list_mode_state.review_config_hash IS NOT DISTINCT FROM s.review_config_hash
       AND list_mode_state.snapshot_id = s.snapshot_id
       AND list_mode_state.article_id = s.article_id
       AND list_contains(list_mode_state.list_mode_keys, ${getSqlLiteral(getListModeKey(input.criteria))})
      INNER JOIN snapshot_scope
        ON snapshot_scope.project_id = s.project_id
       AND snapshot_scope.review_config_hash IS NOT DISTINCT FROM s.review_config_hash
       AND snapshot_scope.snapshot_id = s.snapshot_id
      ${promptFilterJoinSql}
      WHERE s.project_id IN (SELECT unnest(${getSqlLiteral(input.sourceProjectIds)}::VARCHAR[]))
        ${getTabStatusPredicates(input.criteria)}
        ${input.cursor ? `AND s.article_id > ${getSqlLiteral(input.cursor)}` : ''}
        ${getPostingFilterPredicates(input.criteria)}
    )`
}

const getSearchFilteredArticleIdsCteSql = (input: {
  searchTokens: readonly string[]
  useCandidateArticleIds: boolean
}) => {
  if (input.searchTokens.length === 0) {
    return ''
  }

  const searchScopeSql = input.useCandidateArticleIds
    ? `SELECT DISTINCT
        c.project_id,
        c.review_config_hash,
        c.snapshot_id,
        snapshot_scope.search_identity,
        snapshot_scope.project_scope_identity
      FROM search_candidate_article_ids c
      INNER JOIN snapshot_scope
        ON snapshot_scope.project_id = c.project_id
       AND snapshot_scope.review_config_hash IS NOT DISTINCT FROM c.review_config_hash
       AND snapshot_scope.snapshot_id = c.snapshot_id`
    : `SELECT DISTINCT
        snapshot_scope.project_id,
        snapshot_scope.review_config_hash,
        snapshot_scope.snapshot_id,
        snapshot_scope.search_identity,
        snapshot_scope.project_scope_identity
      FROM snapshot_scope`
  if (!input.useCandidateArticleIds) {
    return `search_prefixes AS (
      SELECT DISTINCT token_prefix
      FROM (SELECT unnest(${getSqlLiteral(input.searchTokens)}::VARCHAR[]) AS token_prefix)
      WHERE token_prefix IS NOT NULL AND token_prefix <> ''
    ),
    search_scope AS (
      ${searchScopeSql}
    ),
    search_filtered_article_ids AS (
      SELECT
        search.project_id,
        search_scope.review_config_hash,
        search.snapshot_id,
        search_article.article_id AS article_id
      FROM search_scope
      INNER JOIN mart.review_title_search_serving_v4 search
        ON search.project_id = search_scope.project_id
       AND search.search_identity = search_scope.search_identity
       AND search.project_scope_identity = search_scope.project_scope_identity
       AND search.snapshot_id = search_scope.snapshot_id
      INNER JOIN search_prefixes search_prefix
        ON starts_with(search.token, search_prefix.token_prefix)
      CROSS JOIN UNNEST(search.article_ids) AS search_article(article_id)
      GROUP BY search.project_id, search_scope.review_config_hash, search.snapshot_id, search_article.article_id
      HAVING COUNT(DISTINCT search_prefix.token_prefix) = ${getSqlLiteral(input.searchTokens.length)}
    )`
  }

  return `search_prefixes AS (
      SELECT DISTINCT token_prefix
      FROM (SELECT unnest(${getSqlLiteral(input.searchTokens)}::VARCHAR[]) AS token_prefix)
      WHERE token_prefix IS NOT NULL AND token_prefix <> ''
    ),
    search_scope AS (
      ${searchScopeSql}
    ),
    expanded_search_article_ids AS (
      SELECT
        search.project_id,
        search_scope.review_config_hash,
        search.snapshot_id,
        search_prefix.token_prefix,
        search_article.article_id AS article_id
      FROM search_scope
      INNER JOIN mart.review_title_search_serving_v4 search
        ON search.project_id = search_scope.project_id
       AND search.search_identity = search_scope.search_identity
       AND search.project_scope_identity = search_scope.project_scope_identity
       AND search.snapshot_id = search_scope.snapshot_id
      INNER JOIN search_prefixes search_prefix
        ON starts_with(search.token, search_prefix.token_prefix)
      CROSS JOIN UNNEST(search.article_ids) AS search_article(article_id)
      INNER JOIN search_candidate_article_ids search_candidate
        ON search_candidate.project_id = search.project_id
       AND search_candidate.review_config_hash IS NOT DISTINCT FROM search_scope.review_config_hash
       AND search_candidate.snapshot_id = search.snapshot_id
       AND search_candidate.article_id = search_article.article_id
    ),
    search_filtered_article_ids AS (
      SELECT
        expanded_search_article_ids.project_id,
        expanded_search_article_ids.review_config_hash,
        expanded_search_article_ids.snapshot_id,
        expanded_search_article_ids.article_id AS article_id
      FROM expanded_search_article_ids
      GROUP BY expanded_search_article_ids.project_id, expanded_search_article_ids.review_config_hash, expanded_search_article_ids.snapshot_id, expanded_search_article_ids.article_id
      HAVING COUNT(DISTINCT expanded_search_article_ids.token_prefix) = ${getSqlLiteral(input.searchTokens.length)}
    )`
}

const getServingArticleBatchSql = (job: ReviewBulkOperationJobRow, cursor: string | null, limit: number) => {
  const criteria = getCriteria(job)
  const sourceProjectIds = getSourceProjectIds(job, criteria)
  const searchTokens = getReviewServingTitleSearchTokens(criteria.search ?? null)
  const useSearchCandidateArticleIds = shouldUseSearchCandidateArticleIds({criteria, cursor, searchTokens})
  const searchCandidateArticleIdsCteSql = useSearchCandidateArticleIds
    ? getSearchCandidateArticleIdsCteSql({criteria, cursor, sourceProjectIds})
    : ''
  const searchCteSql = getSearchFilteredArticleIdsCteSql({
    searchTokens,
    useCandidateArticleIds: useSearchCandidateArticleIds,
  })
  const promptFilterCteSql = getPromptFilteredArticleIdsCteSql({criteria, sourceProjectIds})
  const servingCteSqls = [
    getServingSnapshotScopeCteSql(job, criteria, sourceProjectIds),
    promptFilterCteSql,
    searchCandidateArticleIdsCteSql,
    searchCteSql,
  ].filter(Boolean)
  const searchJoinSql =
    searchTokens.length === 0
      ? ''
      : `INNER JOIN search_filtered_article_ids search_filter_ids
      ON search_filter_ids.project_id = s.project_id
     AND search_filter_ids.review_config_hash IS NOT DISTINCT FROM s.review_config_hash
     AND search_filter_ids.snapshot_id = s.snapshot_id
     AND search_filter_ids.article_id = s.article_id`
  const promptFilterJoinSql =
    getPromptAnswerFilterEntries(criteria).length === 0
      ? ''
      : `INNER JOIN prompt_filtered_article_ids prompt_filter_ids
      ON prompt_filter_ids.project_id = s.project_id
     AND prompt_filter_ids.review_config_hash IS NOT DISTINCT FROM s.review_config_hash
     AND prompt_filter_ids.snapshot_id = s.snapshot_id
     AND prompt_filter_ids.article_id = s.article_id`

  return `
    WITH ${servingCteSqls.join(',\n    ')}
    SELECT DISTINCT s.article_id AS articleId
    FROM mart.review_article_serving_base_v4 s
    INNER JOIN mart.review_article_serving_list_mode_state_v4 list_mode_state
      ON list_mode_state.project_id = s.project_id
     AND list_mode_state.review_config_hash IS NOT DISTINCT FROM s.review_config_hash
     AND list_mode_state.snapshot_id = s.snapshot_id
     AND list_mode_state.article_id = s.article_id
     AND list_contains(list_mode_state.list_mode_keys, ${getSqlLiteral(getListModeKey(criteria))})
    INNER JOIN snapshot_scope
      ON snapshot_scope.project_id = s.project_id
     AND snapshot_scope.review_config_hash IS NOT DISTINCT FROM s.review_config_hash
     AND snapshot_scope.snapshot_id = s.snapshot_id
    ${searchJoinSql}
    ${promptFilterJoinSql}
    WHERE s.project_id IN (SELECT unnest(${getSqlLiteral(sourceProjectIds)}::VARCHAR[]))
      ${getTabStatusPredicates(criteria)}
      ${cursor ? `AND s.article_id > ${getSqlLiteral(cursor)}` : ''}
      ${getPostingFilterPredicates(criteria)}
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

const markHeartbeat = async (jobId: string, database: ReviewBulkOperationWorkerDatabase, workerId: string) => {
  await database.run(
    `
      UPDATE app.review_bulk_operation_job
      SET updated_at = current_timestamp
      WHERE job_id = ${getSqlLiteral(jobId)}
        AND status = 'running'
        AND completed_at IS NULL
    `,
    getWorkloadContext(workerId),
  )
}

const runWithHeartbeat = async <T>(input: {
  database: ReviewBulkOperationWorkerDatabase
  jobId: string
  operation: () => Promise<T>
  workerId: string
}) => {
  const heartbeat = setInterval(() => {
    void markHeartbeat(input.jobId, input.database, input.workerId).catch(() => {})
  }, runningJobHeartbeatMs)
  heartbeat.unref?.()

  try {
    await markHeartbeat(input.jobId, input.database, input.workerId)
    return await input.operation()
  } finally {
    clearInterval(heartbeat)
  }
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

    const batchResult = await runWithHeartbeat({
      database,
      jobId: job.jobId,
      operation: () => {
        return executeBatch({articleIds, database, insertArticles: dependencies.insertArticles, job})
      },
      workerId,
    })
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
