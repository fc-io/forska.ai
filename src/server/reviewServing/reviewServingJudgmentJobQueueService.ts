import type {
  PromptQueueEntry,
  UnassessedArticleRow,
  UnassessedPairsCursor,
  UnassessedPairsResult,
} from '../../services/olap/olapTypes.ts'
import {escapeSqlString, getSqlLiteral} from '../services/appQueryHelpers.ts'
import {
  type AppReadOnlyDatabaseService,
  getApiReadOnlyAppDatabaseService,
  getJudgeWorkerReadOnlyAppDatabaseService,
} from '../services/appReadOnlyDatabaseService.ts'
import type {DuckdbWorkloadContext} from '../utils/duckdbService.ts'

type JudgmentJobServingArticleRow = {
  articleCreatedAt: unknown
  articleId: string
  articleTitle: string | null
  articleUpdatedAt: unknown
}

type JudgmentJobServingCursorRow = {activitySortAt: unknown; articleId: string; priorityBucket: number}

type JudgmentJobServingPromptRow = JudgmentJobServingCursorRow & {promptId: string | null}

type JudgmentJobServingScope = {projectId: string; reviewConfigHash: string; snapshotId: string}

const getJudgmentJobQueueWorkloadContext = (
  routeOrJobKey: string,
  projectId: string,
  maxResultRows = 1_000,
): DuckdbWorkloadContext => {
  return {
    allowsTempSpill: false,
    fallbackIntent: 'serveStale',
    maxResultRows,
    projectId,
    routeOrJobKey,
    timeoutMs: 5_000,
    workloadClass: 'judgmentJobServingQueue',
  }
}

const getDateValue = (value: unknown) => {
  return value instanceof Date ? value : typeof value === 'string' || typeof value === 'number' ? new Date(value) : null
}

const getActiveServingScope = async (
  projectId: string,
  routeOrJobKey: string,
  database: AppReadOnlyDatabaseService,
) => {
  const [scope] = await database.queryJson<JudgmentJobServingScope>(
    `
    SELECT project_id AS projectId, review_config_hash AS reviewConfigHash, snapshot_id AS snapshotId
    FROM app.review_serving_snapshot_manifest
    WHERE project_id = ${getSqlLiteral(projectId)}
      AND snapshot_status = 'active'
    ORDER BY activated_at DESC NULLS LAST, updated_at DESC, snapshot_id DESC
    LIMIT 1
  `,
    getJudgmentJobQueueWorkloadContext(routeOrJobKey, projectId, 1),
  )

  return scope ?? null
}

const getCursorPredicate = (cursor: UnassessedPairsCursor | null) => {
  return cursor === null
    ? ''
    : `AND (
        queue.priority_bucket > ${Number(cursor.priorityBucket ?? 0)}
        OR (queue.priority_bucket = ${Number(cursor.priorityBucket ?? 0)} AND queue.activity_sort_at < ${getSqlLiteral(cursor.lastDate.toISOString())})
        OR (
          queue.priority_bucket = ${Number(cursor.priorityBucket ?? 0)}
          AND queue.activity_sort_at = ${getSqlLiteral(cursor.lastDate.toISOString())}
          AND queue.article_id < ${getSqlLiteral(cursor.lastArticleId)}
        )
      )`
}

const getDatePredicate = (column: string, from: Date | null | undefined, to: Date | null | undefined) => {
  const fromPredicate = from ? `AND ${column} >= TIMESTAMPTZ ${getSqlLiteral(from.toISOString())}` : ''
  const toPredicate = to ? `AND ${column} < TIMESTAMPTZ ${getSqlLiteral(to.toISOString())}` : ''

  return `${fromPredicate}\n${toPredicate}`
}

const getImportRoutePredicate = (importRouteIds: readonly string[]) => {
  return importRouteIds.length === 0
    ? ''
    : `AND article.selected_import_route_id IN (${importRouteIds
        .map((routeId) => {
          return getSqlLiteral(routeId)
        })
        .join(', ')})`
}

export const getJudgmentJobUnassessedCountFromServing = async (params: {
  importRouteIds: readonly string[]
  projectDateFrom: Date | null | undefined
  projectDateTo: Date | null | undefined
  projectId: string
}) => {
  const database = getApiReadOnlyAppDatabaseService()
  const scope = await getActiveServingScope(params.projectId, 'judgmentJobs.unassessedCount', database)

  if (scope === null) {
    return 0
  }

  const [row] = await database.queryJson<{count: number}>(
    `
    SELECT COUNT(DISTINCT queue.article_id) AS count
    FROM mart.review_unassessed_queue_serving_v4 queue
    INNER JOIN mart.review_article_serving_v4 article
      ON article.project_id = queue.project_id
      AND article.review_config_hash = queue.review_config_hash
      AND article.snapshot_id = queue.snapshot_id
      AND article.article_id = queue.article_id
      AND article.list_mode_key = 'unassessed'
    WHERE queue.project_id = ${getSqlLiteral(scope.projectId)}
      AND queue.review_config_hash = ${getSqlLiteral(scope.reviewConfigHash)}
      AND queue.snapshot_id = ${getSqlLiteral(scope.snapshotId)}
      AND queue.queue_kind = 'unassessed'
      ${getDatePredicate('article.article_created_at', params.projectDateFrom, params.projectDateTo)}
      ${getImportRoutePredicate(params.importRouteIds)}
  `,
    getJudgmentJobQueueWorkloadContext('judgmentJobs.unassessedCount', params.projectId, 1),
  )

  return Number(row?.count ?? 0)
}

export const getJudgmentJobUnassessedArticlesFromServing = async (params: {
  importRouteIds: readonly string[]
  limit: number
  projectDateFrom: Date | null | undefined
  projectDateTo: Date | null | undefined
  projectId: string
}): Promise<{articles: UnassessedArticleRow[]; totalCount: number}> => {
  const database = getApiReadOnlyAppDatabaseService()
  const limit = Math.max(0, Math.min(500, Math.trunc(params.limit)))
  const scope = await getActiveServingScope(params.projectId, 'judgmentJobs.unassessedArticles', database)

  if (scope === null) {
    return {articles: [], totalCount: 0}
  }

  const rows = await database.queryJson<JudgmentJobServingArticleRow>(
    `
    SELECT
      queue.article_id AS articleId,
      any_value(article.article_title) AS articleTitle,
      any_value(article.article_created_at) AS articleCreatedAt,
      any_value(article.article_updated_at) AS articleUpdatedAt
    FROM mart.review_unassessed_queue_serving_v4 queue
    INNER JOIN mart.review_article_serving_v4 article
      ON article.project_id = queue.project_id
      AND article.review_config_hash = queue.review_config_hash
      AND article.snapshot_id = queue.snapshot_id
      AND article.article_id = queue.article_id
      AND article.list_mode_key = 'unassessed'
    WHERE queue.project_id = ${getSqlLiteral(scope.projectId)}
      AND queue.review_config_hash = ${getSqlLiteral(scope.reviewConfigHash)}
      AND queue.snapshot_id = ${getSqlLiteral(scope.snapshotId)}
      AND queue.queue_kind = 'unassessed'
      ${getDatePredicate('article.article_created_at', params.projectDateFrom, params.projectDateTo)}
      ${getImportRoutePredicate(params.importRouteIds)}
    GROUP BY queue.article_id, queue.priority_bucket, queue.activity_sort_at
    ORDER BY queue.priority_bucket ASC, queue.activity_sort_at DESC, queue.article_id DESC
    LIMIT ${limit}
  `,
    getJudgmentJobQueueWorkloadContext('judgmentJobs.unassessedArticles', params.projectId, limit),
  )

  return {
    articles: rows.map((row) => {
      return {
        articleCreatedAt: getDateValue(row.articleCreatedAt),
        articleId: row.articleId,
        articleTitle: row.articleTitle ?? '',
        articleUpdatedAt: getDateValue(row.articleUpdatedAt),
        id: row.articleId,
      }
    }),
    totalCount: rows.length,
  }
}

const getNextCursor = (rows: readonly JudgmentJobServingCursorRow[], hasMore: boolean) => {
  const lastRow = rows.at(-1) ?? null

  return hasMore && lastRow !== null
    ? {
        lastArticleId: lastRow.articleId,
        lastDate: getDateValue(lastRow.activitySortAt) ?? new Date(0),
        priorityBucket: Number(lastRow.priorityBucket ?? 0),
      }
    : null
}

export const getJudgmentJobUnassessedPairsFromServing = async (params: {
  cursor: UnassessedPairsCursor | null
  jobId: string
  numberOfPromptsToGet: number
  projectId: string
}): Promise<UnassessedPairsResult> => {
  const limit = Math.max(0, Math.min(5_000, Math.trunc(params.numberOfPromptsToGet)))
  const database = getJudgeWorkerReadOnlyAppDatabaseService()
  const scope = await getActiveServingScope(params.projectId, `judgmentQueue.${params.jobId}.unassessedPairs`, database)

  if (scope === null || limit === 0) {
    return {nextCursor: null, promptEntries: []}
  }

  const rows = await database.queryJson<JudgmentJobServingPromptRow>(
    `
    SELECT
      queue.article_id AS articleId,
      queue.prompt_id AS promptId,
      queue.priority_bucket AS priorityBucket,
      queue.activity_sort_at AS activitySortAt
    FROM mart.review_unassessed_queue_serving_v4 queue
    WHERE queue.project_id = '${escapeSqlString(scope.projectId)}'
      AND queue.review_config_hash = '${escapeSqlString(scope.reviewConfigHash)}'
      AND queue.snapshot_id = '${escapeSqlString(scope.snapshotId)}'
      AND queue.queue_kind = 'unassessed'
      AND queue.prompt_id IS NOT NULL
      ${getCursorPredicate(params.cursor)}
    ORDER BY queue.priority_bucket ASC, queue.activity_sort_at DESC, queue.article_id DESC, queue.prompt_id ASC
    LIMIT ${limit + 1}
  `,
    getJudgmentJobQueueWorkloadContext(`judgmentQueue.${params.jobId}.unassessedPairs`, params.projectId, limit + 1),
  )
  const limitedRows = rows.slice(0, limit)
  const promptEntries = limitedRows.flatMap<PromptQueueEntry>((row) => {
    return row.promptId === null ? [] : [{articleId: row.articleId, promptId: row.promptId}]
  })

  return {nextCursor: getNextCursor(limitedRows, rows.length > limit), promptEntries}
}
