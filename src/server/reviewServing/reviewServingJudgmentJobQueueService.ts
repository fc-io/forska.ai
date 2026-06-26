import type {
  PromptQueueEntry,
  UnassessedArticleRow,
  UnassessedPairsCursor,
  UnassessedPairsResult,
} from '../../services/olap/olapTypes.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {
  type AppReadOnlyDatabaseService,
  getApiReadOnlyAppDatabaseService,
  getJudgeWorkerReadOnlyAppDatabaseService,
} from '../services/appReadOnlyDatabaseService.ts'
import type {DuckdbWorkloadContext} from '../utils/duckdbService.ts'
import {getCurrentReviewServingReviewConfigHash} from './reviewServingReviewConfig.ts'

type JudgmentJobServingArticleRow = {
  articleCreatedAt: unknown
  articleId: string
  articleTitle: string | null
  articleUpdatedAt: unknown
}

type JudgmentJobServingCursorRow = {
  activitySortAt: unknown
  articleId: string
  priorityBucket: number
  promptId: string | null
}

type JudgmentJobServingPromptRow = JudgmentJobServingCursorRow

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

const getQueueActivitySortAtExpression = () => {
  return "date_trunc('millisecond', queue.activity_sort_at)"
}

const getIsUtcMidnight = (value: Date) => {
  return (
    value.getUTCHours() === 0
    && value.getUTCMinutes() === 0
    && value.getUTCSeconds() === 0
    && value.getUTCMilliseconds() === 0
  )
}

const getNextUtcDay = (value: Date) => {
  const nextDay = new Date(value)
  nextDay.setUTCDate(nextDay.getUTCDate() + 1)
  return nextDay
}

const getActiveServingScope = async (
  projectId: string,
  routeOrJobKey: string,
  database: AppReadOnlyDatabaseService,
) => {
  const currentReviewConfigHash = await getCurrentReviewServingReviewConfigHash(projectId, database)

  if (currentReviewConfigHash === null) {
    return null
  }

  const [scope] = await database.queryJson<JudgmentJobServingScope>(
    `
    SELECT project_id AS projectId, review_config_hash AS reviewConfigHash, snapshot_id AS snapshotId
    FROM app.review_serving_snapshot_manifest
    WHERE project_id = ${getSqlLiteral(projectId)}
      AND review_config_hash = ${getSqlLiteral(currentReviewConfigHash)}
      AND snapshot_status = 'active'
    ORDER BY activated_at DESC NULLS LAST, updated_at DESC, snapshot_id DESC
    LIMIT 1
  `,
    getJudgmentJobQueueWorkloadContext(routeOrJobKey, projectId, 1),
  )

  return scope ?? null
}

const getCursorPredicate = (cursor: UnassessedPairsCursor | null) => {
  const priorityBucket = Number(cursor?.priorityBucket ?? 0)
  const activitySortAtExpression = getQueueActivitySortAtExpression()
  const lastDateLiteral = cursor ? `TIMESTAMPTZ ${getSqlLiteral(cursor.lastDate.toISOString())}` : 'NULL'
  const promptPredicate = cursor?.lastPromptId
    ? `OR (
          queue.priority_bucket = ${priorityBucket}
          AND ${activitySortAtExpression} = ${lastDateLiteral}
          AND queue.article_id = ${getSqlLiteral(cursor.lastArticleId)}
          AND queue.prompt_id < ${getSqlLiteral(cursor.lastPromptId)}
        )`
    : `OR (
          queue.priority_bucket = ${priorityBucket}
          AND ${activitySortAtExpression} = ${lastDateLiteral}
          AND queue.article_id = ${getSqlLiteral(cursor?.lastArticleId)}
        )`

  return cursor === null
    ? ''
    : `AND (
        queue.priority_bucket < ${priorityBucket}
        OR (queue.priority_bucket = ${priorityBucket} AND ${activitySortAtExpression} < ${lastDateLiteral})
        OR (
          queue.priority_bucket = ${priorityBucket}
          AND ${activitySortAtExpression} = ${lastDateLiteral}
          AND queue.article_id < ${getSqlLiteral(cursor.lastArticleId)}
        )
        ${promptPredicate}
      )`
}

const getDatePredicate = (column: string, from: Date | null | undefined, to: Date | null | undefined) => {
  const fromPredicate = from ? `AND ${column} >= TIMESTAMPTZ ${getSqlLiteral(from.toISOString())}` : ''
  const dateOnlyUpperBound = to && getIsUtcMidnight(to) ? getNextUtcDay(to) : null
  const toPredicate = dateOnlyUpperBound
    ? `AND ${column} < TIMESTAMPTZ ${getSqlLiteral(dateOnlyUpperBound.toISOString())}`
    : to
      ? `AND ${column} <= TIMESTAMPTZ ${getSqlLiteral(to.toISOString())}`
      : ''

  return `${fromPredicate}\n${toPredicate}`
}

const getCurrentPromptJoin = () => {
  return `
    INNER JOIN app.project_prompt current_prompt
      ON current_prompt.project_id = queue.project_id
      AND current_prompt.prompt_id = queue.prompt_id
      AND current_prompt.enabled = TRUE
      AND NOT current_prompt.archived
    INNER JOIN app.prompt current_prompt_record
      ON current_prompt_record.id = current_prompt.prompt_id
      AND COALESCE(current_prompt_record.archived, FALSE) = FALSE
  `
}

const getProjectArticleMembershipPredicate = (input: {
  articleIdExpression: string
  projectArticleAlias: string
  projectIdExpression: string
}) => {
  return `EXISTS (
      SELECT 1
      FROM app.project_article ${input.projectArticleAlias}
      WHERE ${input.projectArticleAlias}.project_id = ${input.projectIdExpression}
        AND ${input.projectArticleAlias}.article_id = ${input.articleIdExpression}
    )`
}

const getConfiguredRouteMembershipPredicate = (input: {
  articleIdExpression: string
  articleRouteAlias: string
  importRouteIds: readonly string[]
}) => {
  return input.importRouteIds.length === 0
    ? null
    : `EXISTS (
      SELECT 1
      FROM app.article_import_route ${input.articleRouteAlias}
      WHERE ${input.articleRouteAlias}.article_id = ${input.articleIdExpression}
        AND ${input.articleRouteAlias}.import_route_id IN (${input.importRouteIds
          .map((routeId) => {
            return getSqlLiteral(routeId)
          })
          .join(', ')})
    )`
}

const getCurrentProjectRouteMembershipPredicate = (input: {
  articleIdExpression: string
  articleRouteAlias: string
  projectIdExpression: string
  projectRouteAlias: string
}) => {
  return `EXISTS (
      SELECT 1
      FROM app.project_import_route ${input.projectRouteAlias}
      INNER JOIN app.article_import_route ${input.articleRouteAlias}
        ON ${input.articleRouteAlias}.import_route_id = ${input.projectRouteAlias}.import_route_id
        AND ${input.articleRouteAlias}.article_id = ${input.articleIdExpression}
      WHERE ${input.projectRouteAlias}.project_id = ${input.projectIdExpression}
    )`
}

const getConfiguredArticleScopePredicate = (importRouteIds: readonly string[]) => {
  const routePredicate = getConfiguredRouteMembershipPredicate({
    articleIdExpression: 'article.article_id',
    articleRouteAlias: 'article_route_scope',
    importRouteIds,
  })
  const curatedPredicate = getProjectArticleMembershipPredicate({
    articleIdExpression: 'article.article_id',
    projectArticleAlias: 'project_article_scope',
    projectIdExpression: 'article.project_id',
  })

  return routePredicate === null ? `AND ${curatedPredicate}` : `AND (${routePredicate} OR ${curatedPredicate})`
}

const getCurrentProjectScopeJoin = () => {
  return `
    INNER JOIN app.project current_project
      ON current_project.id = queue.project_id
      AND current_project.archived = FALSE
    INNER JOIN app.article current_article
      ON current_article.id = queue.article_id
  `
}

const getCurrentProjectDateScopePredicate = () => {
  const dateToIsDateOnlyExpression = "current_project.date_to = date_trunc('day', current_project.date_to)"
  const dateToHasTimeExpression = "current_project.date_to != date_trunc('day', current_project.date_to)"

  return `
      AND (current_project.date_from IS NULL OR current_article.article_created_at >= current_project.date_from)
      AND (
        current_project.date_to IS NULL
        OR (${dateToIsDateOnlyExpression} AND current_article.article_created_at < current_project.date_to + INTERVAL 1 DAY)
        OR (${dateToHasTimeExpression} AND current_article.article_created_at <= current_project.date_to)
      )
  `
}

const getCurrentProjectArticleScopePredicate = () => {
  return `AND (
        ${getCurrentProjectRouteMembershipPredicate({
          articleIdExpression: 'queue.article_id',
          articleRouteAlias: 'current_article_route_scope',
          projectIdExpression: 'queue.project_id',
          projectRouteAlias: 'current_project_route_scope',
        })}
        OR ${getProjectArticleMembershipPredicate({
          articleIdExpression: 'queue.article_id',
          projectArticleAlias: 'current_project_article_scope',
          projectIdExpression: 'queue.project_id',
        })}
      )`
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
    ${getCurrentPromptJoin()}
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
      AND queue.prompt_id IS NOT NULL
      ${getDatePredicate('article.article_created_at', params.projectDateFrom, params.projectDateTo)}
      ${getConfiguredArticleScopePredicate(params.importRouteIds)}
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
    WITH eligible_queue AS (
      SELECT
        queue.article_id,
        queue.priority_bucket,
        queue.activity_sort_at,
        article.article_title,
        article.article_created_at,
        article.article_updated_at
      FROM mart.review_unassessed_queue_serving_v4 queue
      ${getCurrentPromptJoin()}
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
        AND queue.prompt_id IS NOT NULL
        ${getDatePredicate('article.article_created_at', params.projectDateFrom, params.projectDateTo)}
        ${getConfiguredArticleScopePredicate(params.importRouteIds)}
    ), article_queue AS (
      SELECT
        article_id,
        MAX(priority_bucket) AS priorityBucket
      FROM eligible_queue
      GROUP BY article_id
    )
    SELECT
      eligible.article_id AS articleId,
      any_value(eligible.article_title) AS articleTitle,
      any_value(eligible.article_created_at) AS articleCreatedAt,
      any_value(eligible.article_updated_at) AS articleUpdatedAt
    FROM eligible_queue eligible
    INNER JOIN article_queue
      ON article_queue.article_id = eligible.article_id
      AND article_queue.priorityBucket = eligible.priority_bucket
    GROUP BY eligible.article_id, article_queue.priorityBucket
    ORDER BY article_queue.priorityBucket DESC, MAX(eligible.activity_sort_at) DESC, eligible.article_id DESC
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
        lastPromptId: lastRow.promptId,
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
      ${getQueueActivitySortAtExpression()} AS activitySortAt
    FROM mart.review_unassessed_queue_serving_v4 queue
    ${getCurrentPromptJoin()}
    INNER JOIN app.judgment_job job
      ON job.id = ${getSqlLiteral(params.jobId)}
      AND job.project_id = queue.project_id
    ${getCurrentProjectScopeJoin()}
    WHERE queue.project_id = ${getSqlLiteral(scope.projectId)}
      AND queue.review_config_hash = ${getSqlLiteral(scope.reviewConfigHash)}
      AND queue.snapshot_id = ${getSqlLiteral(scope.snapshotId)}
      AND queue.queue_kind = 'unassessed'
      AND queue.prompt_id IS NOT NULL
      ${getCurrentProjectDateScopePredicate()}
      ${getCurrentProjectArticleScopePredicate()}
      ${getCursorPredicate(params.cursor)}
    ORDER BY queue.priority_bucket DESC, ${getQueueActivitySortAtExpression()} DESC, queue.article_id DESC, queue.prompt_id DESC
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
