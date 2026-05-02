import {hostname} from 'node:os'

import {getAppDatabaseService} from './appDatabaseService.ts'
import {getQuotedStringList, getSqlLiteral} from './appQueryHelpers.ts'
import {getMaintenanceWorkLeaseService} from './maintenanceWorkLeaseService.ts'
import {getProjectMartLargeRebuildStateService} from './projectMartLargeRebuildStateService.ts'
import {getProjectMartRefreshStateService, type MarkedProjectDirtyState} from './projectMartRefreshStateService.ts'
import {getProjectVisibleJudgmentScopeSql} from './projectVisibleJudgmentRule.ts'

type MartRefreshScope = 'judgment_article'

type MartRefreshTaskRow = {
  articleId: string | null
  id: string
  projectId: string | null
  refreshGeneration: number
  refreshScope: MartRefreshScope
}

type ProjectRefreshBatchCursor = {articleCreatedAt: Date | string | null; articleId: string}

type ProjectRefreshBatchRow = {articleCreatedAt: Date | string | null; articleId: string}

type ProjectPurgeBatchRow = {rowId: bigint | number | string}

type ArchivedProjectMartPurgeMode = 'delete_batches' | 'rewrite'

type ReviewArticleServingRewriteBatchCursor = {rowId: bigint | number | string}

type ProjectRefreshScopeBatchRow = ProjectRefreshBatchRow & {
  articleUpdatedAt: Date | string | null
  inCuratedScope: boolean
  inRouteScope: boolean
}

type QueueMartRefreshTask = {
  articleId?: string | null
  projectId?: string | null
  reason: string
  refreshScope: MartRefreshScope
}

type MartRefreshProgressSnapshot = {
  claimedQueuedArticleIds: string[]
  claimedQueuedProjectIds: string[]
  processingArticleIds: string[]
  processingProjectIds: string[]
}

type MartRefreshDebugSnapshot = {
  autoDrainEnabled: boolean
  drainPromiseActive: boolean
  drainTimerActive: boolean
  flushInvocationCount: number
  lastErrorAt: string | null
  lastErrorMessage: string | null
  lastFlushAt: string | null
  lastHasMoreQueuedTasks: boolean | null
  lastPassCompletedAt: string | null
  lastPassStartedAt: string | null
  lastQueuedTaskCount: number | null
  passCount: number
}

const getEmptyMartRefreshProgressSnapshot = (): MartRefreshProgressSnapshot => {
  return {claimedQueuedArticleIds: [], claimedQueuedProjectIds: [], processingArticleIds: [], processingProjectIds: []}
}

const copyMartRefreshProgressSnapshot = (snapshot: MartRefreshProgressSnapshot): MartRefreshProgressSnapshot => {
  return {
    claimedQueuedArticleIds: [...snapshot.claimedQueuedArticleIds],
    claimedQueuedProjectIds: [...snapshot.claimedQueuedProjectIds],
    processingArticleIds: [...snapshot.processingArticleIds],
    processingProjectIds: [...snapshot.processingProjectIds],
  }
}

const getEmptyMartRefreshDebugSnapshot = (): MartRefreshDebugSnapshot => {
  return {
    autoDrainEnabled: true,
    drainPromiseActive: false,
    drainTimerActive: false,
    flushInvocationCount: 0,
    lastErrorAt: null,
    lastErrorMessage: null,
    lastFlushAt: null,
    lastHasMoreQueuedTasks: null,
    lastPassCompletedAt: null,
    lastPassStartedAt: null,
    lastQueuedTaskCount: null,
    passCount: 0,
  }
}

let martRefreshDrainPromise: Promise<void> | null = null
let martRefreshDrainTimer: ReturnType<typeof setTimeout> | null = null
let martRefreshQueueCompletedAtColumnReady: Promise<void> | null = null
let martRefreshQueueCompletedAtColumnVerified = false
let martRefreshQueueGenerationColumnReady: Promise<void> | null = null
let martRefreshQueueGenerationColumnVerified = false
let martRefreshReviewArticleRollupReady: Promise<void> | null = null
let martRefreshReviewArticleRollupVerified = false
let martRefreshAutoDrainEnabled = true
let martRefreshDebugSnapshot = getEmptyMartRefreshDebugSnapshot()
let martRefreshProgressSnapshot = getEmptyMartRefreshProgressSnapshot()
let martRefreshArticleCompletionTimes: number[] = []
let martRefreshProjectCompletionTimes: number[] = []

const martRefreshArticleBatchLimit = 4
const martRefreshDrainBudgetMs = 100
const martRefreshProjectPurgeRowBatchSize = 10
const martRefreshProjectRebuildArticleBatchSize = 20_000
const martReviewArticleServingRewriteBatchSize = 1_000
const martRefreshRetryDelayMs = 5000
const martRefreshQueueLeaseMs = 30_000
const martRefreshScheduleDelayMs = 250
const martRefreshThroughputWindowMs = 15_000
const martRefreshYieldDelayMs = 0
const martRefreshBatchEpochSql = "TIMESTAMPTZ '1970-01-01T00:00:00.000Z'"
const martRefreshProjectPurgeRetryableErrorFragment = 'Failed to delete all rows from index'
const martPromptAnswerFactLookupIndexName = 'idx_mart_prompt_answer_fact_lookup'
const martPromptAnswerFactResetReplacementTableName = 'mart.prompt_answer_fact_project_refresh_rewrite'
const martReviewArticleServingPurgeReplacementTableName = 'mart.review_article_serving_project_purge_rewrite'
const martReviewArticleServingOrderIndexName = 'idx_mart_review_article_serving_order'
const martRefreshFatalInvalidationErrorFragments = [
  'database has been invalidated because of a previous fatal error',
  'must be restarted prior to being used again',
]

const getMartRefreshProgressSnapshot = (): MartRefreshProgressSnapshot => {
  return copyMartRefreshProgressSnapshot(martRefreshProgressSnapshot)
}

const setMartRefreshProgressSnapshot = (snapshot: MartRefreshProgressSnapshot) => {
  martRefreshProgressSnapshot = copyMartRefreshProgressSnapshot(snapshot)
}

const resetMartRefreshProgressSnapshot = () => {
  setMartRefreshProgressSnapshot(getEmptyMartRefreshProgressSnapshot())
}

const getRecentCompletionTimes = (completionTimes: number[], now: number) => {
  return completionTimes.filter((completedAt) => {
    return completedAt >= now - martRefreshThroughputWindowMs
  })
}

const getRefreshesPerMinute = (completionTimes: number[], now: number) => {
  const recentCompletionTimes = getRecentCompletionTimes(completionTimes, now)

  return recentCompletionTimes.length === 0
    ? null
    : (recentCompletionTimes.length / martRefreshThroughputWindowMs) * 60_000
}

const getMartRefreshThroughputSnapshot = () => {
  const now = Date.now()

  return {
    articleRefreshesPerMinute: getRefreshesPerMinute(martRefreshArticleCompletionTimes, now),
    projectRefreshesPerMinute: getRefreshesPerMinute(martRefreshProjectCompletionTimes, now),
  }
}

const recordArticleRefreshCompletion = (completedAt = Date.now()) => {
  martRefreshArticleCompletionTimes = [
    ...getRecentCompletionTimes(martRefreshArticleCompletionTimes, completedAt),
    completedAt,
  ]
}

const recordProjectRefreshCompletion = (completedAt = Date.now()) => {
  martRefreshProjectCompletionTimes = [
    ...getRecentCompletionTimes(martRefreshProjectCompletionTimes, completedAt),
    completedAt,
  ]
}

const resetMartRefreshThroughputSnapshot = () => {
  martRefreshArticleCompletionTimes = []
  martRefreshProjectCompletionTimes = []
}

const getMartRefreshDebugSnapshot = () => {
  return {
    ...martRefreshDebugSnapshot,
    autoDrainEnabled: martRefreshAutoDrainEnabled,
    drainPromiseActive: martRefreshDrainPromise !== null,
    drainTimerActive: martRefreshDrainTimer !== null,
  }
}

const updateMartRefreshDebugSnapshot = (updates: Partial<MartRefreshDebugSnapshot>) => {
  martRefreshDebugSnapshot = {...martRefreshDebugSnapshot, ...updates}
}

const resetMartRefreshDebugSnapshot = () => {
  martRefreshDebugSnapshot = getEmptyMartRefreshDebugSnapshot()
}

const isMartRefreshAutoDrainEnabled = () => {
  return martRefreshAutoDrainEnabled
}

const getMartRefreshQueueWorkerId = () => {
  return `mart-refresh-queue:${hostname()}:${process.pid}`
}

const setMartRefreshAutoDrainEnabled = (enabled: boolean) => {
  martRefreshAutoDrainEnabled = enabled
  updateMartRefreshDebugSnapshot({autoDrainEnabled: enabled})
}

const setClaimedQueuedRefreshes = (articleIds: string[], projectIds: string[]) => {
  setMartRefreshProgressSnapshot({
    claimedQueuedArticleIds: articleIds,
    claimedQueuedProjectIds: projectIds,
    processingArticleIds: articleIds,
    processingProjectIds: projectIds,
  })
}

const setProcessingArticleRefreshes = (articleIds: string[]) => {
  setMartRefreshProgressSnapshot({...martRefreshProgressSnapshot, processingArticleIds: articleIds})
}

const getHasMartRefreshQueueGenerationColumn = async (): Promise<boolean> => {
  const rows = await getAppDatabaseService().queryJson<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM information_schema.columns
    WHERE table_schema = 'app'
      AND table_name = 'mart_refresh_queue'
      AND column_name = 'refresh_generation'
  `)

  return Number(rows[0]?.count ?? 0) > 0
}

const getHasMartRefreshQueueCompletedAtColumn = async (): Promise<boolean> => {
  const rows = await getAppDatabaseService().queryJson<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM information_schema.columns
    WHERE table_schema = 'app'
      AND table_name = 'mart_refresh_queue'
      AND column_name = 'completed_at'
  `)

  return Number(rows[0]?.count ?? 0) > 0
}

const getHasNullMartRefreshQueueGenerationRows = async (): Promise<boolean> => {
  const rows = await getAppDatabaseService().queryJson<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.mart_refresh_queue
    WHERE refresh_generation IS NULL
  `)

  return Number(rows[0]?.count ?? 0) > 0
}

const repairMartRefreshQueueGenerationColumn = async () => {
  await getAppDatabaseService().run(`
    ALTER TABLE app.mart_refresh_queue ADD COLUMN IF NOT EXISTS refresh_generation BIGINT;
    UPDATE app.mart_refresh_queue
    SET refresh_generation = 0
    WHERE refresh_generation IS NULL;
  `)

  await getAppDatabaseService().maintenance('checkpoint')
}

const repairMartRefreshQueueCompletedAtColumn = async () => {
  await getAppDatabaseService().run(`
    ALTER TABLE app.mart_refresh_queue ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
  `)

  await getAppDatabaseService().maintenance('checkpoint')
}

const verifyMartRefreshQueueGenerationColumn = async () => {
  const hasGenerationColumn = await getHasMartRefreshQueueGenerationColumn()

  if (!hasGenerationColumn) {
    return repairMartRefreshQueueGenerationColumn()
  }

  return (await getHasNullMartRefreshQueueGenerationRows()) ? repairMartRefreshQueueGenerationColumn() : undefined
}

const verifyMartRefreshQueueCompletedAtColumn = async () => {
  return (await getHasMartRefreshQueueCompletedAtColumn()) ? undefined : repairMartRefreshQueueCompletedAtColumn()
}

const getQueuedArticleTasksSql = () => {
  return `
    SELECT
      id,
      refresh_scope AS refreshScope,
      project_id AS projectId,
      article_id AS articleId,
      COALESCE(refresh_generation, 0) AS refreshGeneration
    FROM app.mart_refresh_queue
    WHERE completed_at IS NULL
      AND refresh_scope = 'judgment_article'
    ORDER BY EPOCH(created_at) ASC, id ASC
    LIMIT ${martRefreshArticleBatchLimit}
  `
}

const ensureMartRefreshQueueGenerationColumn = async (): Promise<void> => {
  if (martRefreshQueueGenerationColumnVerified) {
    return
  }

  if (martRefreshQueueGenerationColumnReady) {
    return martRefreshQueueGenerationColumnReady
  }

  martRefreshQueueGenerationColumnReady = verifyMartRefreshQueueGenerationColumn()
    .then(() => {
      martRefreshQueueGenerationColumnVerified = true
    })
    .catch((error) => {
      martRefreshQueueGenerationColumnReady = null
      return Promise.reject(error)
    })

  return martRefreshQueueGenerationColumnReady
}

const ensureMartRefreshQueueCompletedAtColumn = async (): Promise<void> => {
  if (martRefreshQueueCompletedAtColumnVerified) {
    return
  }

  if (martRefreshQueueCompletedAtColumnReady) {
    return martRefreshQueueCompletedAtColumnReady
  }

  martRefreshQueueCompletedAtColumnReady = verifyMartRefreshQueueCompletedAtColumn()
    .then(() => {
      martRefreshQueueCompletedAtColumnVerified = true
    })
    .catch((error) => {
      martRefreshQueueCompletedAtColumnReady = null
      return Promise.reject(error)
    })

  return martRefreshQueueCompletedAtColumnReady
}

const ensureMartRefreshQueueSchema = async (): Promise<void> => {
  await ensureMartRefreshQueueGenerationColumn()
  return ensureMartRefreshQueueCompletedAtColumn()
}

const createReviewArticleRollupTable = async () => {
  await getAppDatabaseService().run(`
    CREATE TABLE IF NOT EXISTS mart.review_article_rollup (
      project_id VARCHAR NOT NULL,
      article_id VARCHAR NOT NULL,
      article_created_at TIMESTAMPTZ,
      article_updated_at TIMESTAMPTZ,
      enabled_prompt_count INTEGER NOT NULL,
      llm_judged_prompt_count INTEGER NOT NULL,
      human_answered_prompt_count INTEGER NOT NULL,
      llm_judged_prompt_ids VARCHAR[],
      human_answered_prompt_ids VARCHAR[],
      has_all_llm_judgments BOOLEAN NOT NULL,
      has_all_human_answers BOOLEAN NOT NULL,
      in_curated_scope BOOLEAN NOT NULL,
      in_route_scope BOOLEAN NOT NULL,
      review_opened BOOLEAN NOT NULL,
      review_sections_completed INTEGER NOT NULL,
      latest_llm_created_at TIMESTAMPTZ,
      latest_human_updated_at TIMESTAMPTZ,
      latest_review_updated_at TIMESTAMPTZ,
      rollup_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
      PRIMARY KEY(project_id, article_id)
    )
  `)
  await getAppDatabaseService().run(`
    CREATE INDEX IF NOT EXISTS idx_mart_review_article_rollup_project_id
    ON mart.review_article_rollup(project_id, has_all_llm_judgments, article_created_at, article_id)
  `)
}

const ensureReviewArticleRollupTable = async (): Promise<void> => {
  if (martRefreshReviewArticleRollupVerified) {
    return
  }

  if (martRefreshReviewArticleRollupReady) {
    return martRefreshReviewArticleRollupReady
  }

  martRefreshReviewArticleRollupReady = createReviewArticleRollupTable()
    .then(() => {
      martRefreshReviewArticleRollupVerified = true
    })
    .catch((error) => {
      martRefreshReviewArticleRollupReady = null
      return Promise.reject(error)
    })

  return martRefreshReviewArticleRollupReady
}

const getProjectRefreshBatchOrderSql = ({
  articleCreatedAtColumn,
  articleIdColumn,
}: {
  articleCreatedAtColumn: string
  articleIdColumn: string
}) => {
  return `COALESCE(${articleCreatedAtColumn}, ${martRefreshBatchEpochSql}) ASC, ${articleIdColumn} ASC`
}

const getProjectRefreshBatchCursorWhereSql = ({
  articleCreatedAtColumn,
  articleIdColumn,
  cursor,
}: {
  articleCreatedAtColumn: string
  articleIdColumn: string
  cursor: ProjectRefreshBatchCursor | null
}) => {
  if (cursor === null) {
    return ''
  }

  const cursorCreatedAt = getSqlLiteral(cursor.articleCreatedAt ?? new Date(0))

  return `
    AND (
      COALESCE(${articleCreatedAtColumn}, ${martRefreshBatchEpochSql}) > ${cursorCreatedAt}
      OR (
        COALESCE(${articleCreatedAtColumn}, ${martRefreshBatchEpochSql}) = ${cursorCreatedAt}
        AND ${articleIdColumn} > ${getSqlLiteral(cursor.articleId)}
      )
    )
  `
}

const getProjectRefreshBatchCursor = (rows: ProjectRefreshBatchRow[]): ProjectRefreshBatchCursor | null => {
  const [lastRow] = rows.slice(-1)

  return !lastRow ? null : {articleCreatedAt: lastRow.articleCreatedAt, articleId: lastRow.articleId}
}

const getProjectRefreshBatchArticleIds = (rows: ProjectRefreshBatchRow[]) => {
  return rows.map((row) => {
    return row.articleId
  })
}

const getProjectRefreshArticleIdsSql = (articleIds: string[]) => {
  return getQuotedStringList(articleIds).join(', ')
}

const getProjectRefreshArticleIdRowsSql = (articleIds: string[]) => {
  return articleIds
    .map((articleId) => {
      return `(${getSqlLiteral(articleId)})`
    })
    .join(', ')
}

const getProjectScopeResetSql = (projectId: string) => {
  const projectLiteral = getSqlLiteral(projectId)

  return `
    BEGIN TRANSACTION;
    DELETE FROM mart.project_scope_article WHERE project_id = ${projectLiteral};
    COMMIT;
  `
}

const getProjectScopeSourceBatchSql = (projectId: string, cursor: ProjectRefreshBatchCursor | null) => {
  const projectLiteral = getSqlLiteral(projectId)

  return `
    WITH route_scope AS (
      SELECT
        pir.project_id,
        air.article_id,
        TRUE AS in_route_scope,
        FALSE AS in_curated_scope
      FROM app.project_import_route pir
      INNER JOIN app.article_import_route air ON air.import_route_id = pir.import_route_id
      WHERE pir.project_id = ${projectLiteral}
    ),
    curated_scope AS (
      SELECT
        pa.project_id,
        pa.article_id,
        FALSE AS in_route_scope,
        TRUE AS in_curated_scope
      FROM app.project_article pa
      WHERE pa.project_id = ${projectLiteral}
    ),
    combined_scope AS (
      SELECT * FROM route_scope
      UNION ALL
      SELECT * FROM curated_scope
    ),
    aggregated_scope AS (
      SELECT
        project_id,
        article_id,
        COALESCE(BOOL_OR(in_curated_scope), FALSE) AS in_curated_scope,
        COALESCE(BOOL_OR(in_route_scope), FALSE) AS in_route_scope
      FROM combined_scope
      GROUP BY project_id, article_id
    )
    SELECT
      aggregated_scope.article_id AS articleId,
      article.article_created_at AS articleCreatedAt,
      article.article_updated_at AS articleUpdatedAt,
      aggregated_scope.in_curated_scope AS inCuratedScope,
      aggregated_scope.in_route_scope AS inRouteScope
    FROM aggregated_scope
    INNER JOIN app.project project
      ON project.id = aggregated_scope.project_id
     AND project.archived = FALSE
    INNER JOIN app.article article ON article.id = aggregated_scope.article_id
    WHERE aggregated_scope.project_id = ${projectLiteral}
      ${getProjectRefreshBatchCursorWhereSql({
        articleCreatedAtColumn: 'article.article_created_at',
        articleIdColumn: 'aggregated_scope.article_id',
        cursor,
      })}
    ORDER BY ${getProjectRefreshBatchOrderSql({
      articleCreatedAtColumn: 'article.article_created_at',
      articleIdColumn: 'aggregated_scope.article_id',
    })}
    LIMIT ${martRefreshProjectRebuildArticleBatchSize}
  `
}

const getProjectScopeBatchInsertSql = (projectId: string, rows: ProjectRefreshScopeBatchRow[]) => {
  return `
    BEGIN TRANSACTION;
    INSERT INTO mart.project_scope_article (
      project_id,
      article_id,
      in_curated_scope,
      in_route_scope,
      article_created_at,
      article_updated_at
    )
    VALUES ${rows
      .map((row) => {
        return `(${getSqlLiteral(projectId)}, ${getSqlLiteral(row.articleId)}, ${getSqlLiteral(row.inCuratedScope)}, ${getSqlLiteral(row.inRouteScope)}, ${getSqlLiteral(row.articleCreatedAt)}, ${getSqlLiteral(row.articleUpdatedAt)})`
      })
      .join(', ')};
    COMMIT;
  `
}

const getProjectScopeArticleBatchRefreshSql = (projectId: string, articleIds: string[]) => {
  const projectLiteral = getSqlLiteral(projectId)
  const articleRowsSql = getProjectRefreshArticleIdRowsSql(articleIds)

  return `
    BEGIN TRANSACTION;
    DROP TABLE IF EXISTS temp_project_scope_article_refresh;
    CREATE TEMP TABLE temp_project_scope_article_refresh AS
    SELECT DISTINCT article_id
    FROM (VALUES ${articleRowsSql}) AS requested_article(article_id)
    WHERE article_id IS NOT NULL;
    DELETE FROM mart.project_scope_article
    WHERE project_id = ${projectLiteral}
      AND EXISTS (
        SELECT 1
        FROM temp_project_scope_article_refresh requested_article
        WHERE requested_article.article_id = mart.project_scope_article.article_id
      );
    INSERT INTO mart.project_scope_article (
      project_id,
      article_id,
      in_curated_scope,
      in_route_scope,
      article_created_at,
      article_updated_at
    )
    WITH route_scope AS (
      SELECT
        pir.project_id,
        air.article_id,
        TRUE AS in_route_scope,
        FALSE AS in_curated_scope
      FROM app.project_import_route pir
      INNER JOIN app.article_import_route air ON air.import_route_id = pir.import_route_id
      INNER JOIN temp_project_scope_article_refresh requested_article
        ON requested_article.article_id = air.article_id
      WHERE pir.project_id = ${projectLiteral}
    ),
    curated_scope AS (
      SELECT
        pa.project_id,
        pa.article_id,
        FALSE AS in_route_scope,
        TRUE AS in_curated_scope
      FROM app.project_article pa
      INNER JOIN temp_project_scope_article_refresh requested_article
        ON requested_article.article_id = pa.article_id
      WHERE pa.project_id = ${projectLiteral}
    ),
    combined_scope AS (
      SELECT * FROM route_scope
      UNION ALL
      SELECT * FROM curated_scope
    ),
    aggregated_scope AS (
      SELECT
        project_id,
        article_id,
        COALESCE(BOOL_OR(in_curated_scope), FALSE) AS in_curated_scope,
        COALESCE(BOOL_OR(in_route_scope), FALSE) AS in_route_scope
      FROM combined_scope
      GROUP BY project_id, article_id
    )
    SELECT
      aggregated_scope.project_id,
      aggregated_scope.article_id,
      aggregated_scope.in_curated_scope,
      aggregated_scope.in_route_scope,
      article.article_created_at,
      article.article_updated_at
    FROM aggregated_scope
    INNER JOIN app.project project
      ON project.id = aggregated_scope.project_id
     AND project.archived = FALSE
    INNER JOIN app.article article ON article.id = aggregated_scope.article_id
    WHERE aggregated_scope.project_id = ${projectLiteral};
    DROP TABLE temp_project_scope_article_refresh;
    COMMIT;
  `
}

const getProjectScopeBatchSql = (projectId: string, cursor: ProjectRefreshBatchCursor | null) => {
  const projectLiteral = getSqlLiteral(projectId)

  return `
    SELECT
      article_id AS articleId,
      article_created_at AS articleCreatedAt
    FROM mart.project_scope_article
    WHERE project_id = ${projectLiteral}
      ${getProjectRefreshBatchCursorWhereSql({
        articleCreatedAtColumn: 'article_created_at',
        articleIdColumn: 'article_id',
        cursor,
      })}
    ORDER BY ${getProjectRefreshBatchOrderSql({
      articleCreatedAtColumn: 'article_created_at',
      articleIdColumn: 'article_id',
    })}
    LIMIT ${martRefreshProjectRebuildArticleBatchSize}
  `
}

const getArchivedProjectMartPurgeMode = (tableName: string): ArchivedProjectMartPurgeMode => {
  return tableName === 'mart.review_article_serving' ? 'rewrite' : 'delete_batches'
}

const getProjectTablePurgeBatchSql = ({projectId, tableName}: {projectId: string; tableName: string}) => {
  const projectLiteral = getSqlLiteral(projectId)

  return `
    SELECT
      rowid AS rowId
    FROM ${tableName}
    WHERE project_id = ${projectLiteral}
    ORDER BY rowid ASC
    LIMIT ${martRefreshProjectPurgeRowBatchSize}
  `
}

const getProjectTablePurgeDeleteSql = ({
  rowIds,
  tableName,
}: {
  rowIds: Array<bigint | number | string>
  tableName: string
}) => {
  return `
    BEGIN TRANSACTION;
    DELETE FROM ${tableName}
    WHERE rowid IN (${rowIds
      .map((rowId) => {
        return getSqlLiteral(rowId)
      })
      .join(', ')});
    COMMIT;
  `
}

const getReviewArticleServingRewritePurgeSetupSql = () => {
  return `
    BEGIN TRANSACTION;
    DROP TABLE IF EXISTS ${martReviewArticleServingPurgeReplacementTableName};
    CREATE TABLE ${martReviewArticleServingPurgeReplacementTableName} (
      project_id VARCHAR NOT NULL,
      generation BIGINT NOT NULL,
      article_id VARCHAR NOT NULL,
      article_created_at TIMESTAMPTZ,
      article_updated_at TIMESTAMPTZ,
      article_title VARCHAR NOT NULL,
      article_external_id VARCHAR,
      journal_title VARCHAR,
      url VARCHAR,
      full_text_pdf VARCHAR,
      full_text_fetched_at TIMESTAMPTZ,
      full_text_conversion_status VARCHAR,
      source_metadata JSON,
      has_all_llm_judgments BOOLEAN NOT NULL,
      llm_judged_prompt_count INTEGER NOT NULL,
      llm_judged_prompt_ids VARCHAR[],
      enabled_prompt_count INTEGER NOT NULL,
      human_answered_prompt_count INTEGER NOT NULL,
      human_answered_prompt_ids VARCHAR[],
      has_all_human_answers BOOLEAN NOT NULL,
      review_opened BOOLEAN NOT NULL,
      review_sections_completed INTEGER NOT NULL,
      latest_llm_created_at TIMESTAMPTZ,
      latest_human_updated_at TIMESTAMPTZ,
      latest_review_updated_at TIMESTAMPTZ,
      serving_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
      PRIMARY KEY(project_id, generation, article_id)
    );
    COMMIT;
  `
}

const getReviewArticleServingRewriteCopyBatchSql = ({
  cursor,
  projectId,
}: {
  cursor: ReviewArticleServingRewriteBatchCursor | null
  projectId: string
}) => {
  const projectLiteral = getSqlLiteral(projectId)

  return `
    SELECT
      rowid AS rowId
    FROM mart.review_article_serving
    WHERE project_id != ${projectLiteral}
      ${cursor === null ? '' : `AND rowid > ${getSqlLiteral(cursor.rowId)}`}
    ORDER BY rowid ASC
    LIMIT ${martReviewArticleServingRewriteBatchSize}
  `
}

const getReviewArticleServingRewriteBatchInsertSql = (rowIds: Array<bigint | number | string>) => {
  return `
    BEGIN TRANSACTION;
    INSERT INTO ${martReviewArticleServingPurgeReplacementTableName}
    (
      project_id,
      generation,
      article_id,
      article_created_at,
      article_updated_at,
      article_title,
      article_external_id,
      journal_title,
      url,
      full_text_pdf,
      full_text_fetched_at,
      full_text_conversion_status,
      source_metadata,
      has_all_llm_judgments,
      llm_judged_prompt_count,
      llm_judged_prompt_ids,
      enabled_prompt_count,
      human_answered_prompt_count,
      human_answered_prompt_ids,
      has_all_human_answers,
      review_opened,
      review_sections_completed,
      latest_llm_created_at,
      latest_human_updated_at,
      latest_review_updated_at,
      serving_updated_at
    )
    SELECT
      project_id,
      generation,
      article_id,
      article_created_at,
      article_updated_at,
      article_title,
      article_external_id,
      journal_title,
      url,
      full_text_pdf,
      full_text_fetched_at,
      full_text_conversion_status,
      source_metadata,
      has_all_llm_judgments,
      llm_judged_prompt_count,
      llm_judged_prompt_ids,
      enabled_prompt_count,
      human_answered_prompt_count,
      human_answered_prompt_ids,
      has_all_human_answers,
      review_opened,
      review_sections_completed,
      latest_llm_created_at,
      latest_human_updated_at,
      latest_review_updated_at,
      serving_updated_at
    FROM mart.review_article_serving
    WHERE rowid IN (${rowIds
      .map((rowId) => {
        return getSqlLiteral(rowId)
      })
      .join(', ')});
    COMMIT;
  `
}

const getReviewArticleServingRewritePurgeFinalizeSql = () => {
  return `
    BEGIN TRANSACTION;
    DROP TABLE mart.review_article_serving;
    ALTER TABLE ${martReviewArticleServingPurgeReplacementTableName} RENAME TO review_article_serving;
    COMMIT;
  `
}

const getReviewArticleServingRewritePurgeIndexSql = () => {
  return `
    BEGIN TRANSACTION;
    CREATE INDEX IF NOT EXISTS ${martReviewArticleServingOrderIndexName}
    ON mart.review_article_serving(project_id, generation, has_all_llm_judgments, article_created_at, article_id);
    COMMIT;
  `
}

const getProjectPurgeDeleteRetryParts = (rowIds: Array<bigint | number | string>) => {
  const middleIndex = Math.ceil(rowIds.length / 2)

  return [rowIds.slice(0, middleIndex), rowIds.slice(middleIndex)] as const
}

const isProjectPurgeDeleteRetryableError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)

  return message.includes(martRefreshProjectPurgeRetryableErrorFragment) && !isMartRefreshFatalInvalidationError(error)
}

const getProjectPromptAnswerFactResetSql = (projectId: string) => {
  const projectLiteral = getSqlLiteral(projectId)

  return `
    BEGIN TRANSACTION;
    DROP TABLE IF EXISTS ${martPromptAnswerFactResetReplacementTableName};
    CREATE TABLE ${martPromptAnswerFactResetReplacementTableName} (
      project_id VARCHAR NOT NULL,
      article_id VARCHAR NOT NULL,
      prompt_id VARCHAR NOT NULL,
      judgment_id VARCHAR NOT NULL,
      model_id VARCHAR NOT NULL,
      answer_value VARCHAR NOT NULL,
      answered_original VARCHAR,
      article_created_at TIMESTAMPTZ,
      article_updated_at TIMESTAMPTZ,
      judgment_created_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY(project_id, judgment_id, answer_value)
    );
    INSERT INTO ${martPromptAnswerFactResetReplacementTableName} (
      project_id,
      article_id,
      prompt_id,
      judgment_id,
      model_id,
      answer_value,
      answered_original,
      article_created_at,
      article_updated_at,
      judgment_created_at
    )
    SELECT
      project_id,
      article_id,
      prompt_id,
      judgment_id,
      model_id,
      answer_value,
      answered_original,
      article_created_at,
      article_updated_at,
      judgment_created_at
    FROM mart.prompt_answer_fact
    WHERE project_id != ${projectLiteral};
    DROP TABLE mart.prompt_answer_fact;
    ALTER TABLE ${martPromptAnswerFactResetReplacementTableName} RENAME TO prompt_answer_fact;
    CREATE INDEX IF NOT EXISTS ${martPromptAnswerFactLookupIndexName}
    ON mart.prompt_answer_fact(project_id, prompt_id, answer_value, article_id);
    COMMIT;
  `
}

const getProjectPromptAnswerFactBatchInsertBodySql = (projectId: string, articleIds: string[]) => {
  const projectLiteral = getSqlLiteral(projectId)
  const articleIdsSql = getProjectRefreshArticleIdsSql(articleIds)

  return `
    INSERT INTO mart.prompt_answer_fact (
      project_id,
      article_id,
      prompt_id,
      judgment_id,
      model_id,
      answer_value,
      answered_original,
      article_created_at,
      article_updated_at,
      judgment_created_at
    )
    WITH eligible_project_judgment AS (
      SELECT
        scope_article.project_id,
        judgment_fact.article_id,
        judgment_fact.prompt_id,
        judgment_fact.judgment_id,
        judgment_fact.model_id,
        judgment_fact.answered_original,
        judgment_fact.normalized_answers,
        judgment_fact.article_created_at,
        judgment_fact.article_updated_at,
        judgment_fact.created_at AS judgment_created_at
      FROM mart.project_scope_article scope_article
      INNER JOIN app.project project ON project.id = scope_article.project_id
      INNER JOIN app.project_prompt project_prompt
        ON project_prompt.project_id = scope_article.project_id
       AND project_prompt.enabled = TRUE
      INNER JOIN mart.judgment_fact judgment_fact
        ON ${getProjectVisibleJudgmentScopeSql({
          judgmentAlias: 'judgment_fact',
          projectAlias: 'project',
          projectPromptAlias: 'project_prompt',
          projectScopeAlias: 'scope_article',
        })}
      WHERE scope_article.project_id = ${projectLiteral}
        AND scope_article.article_id IN (${articleIdsSql})
    )
    SELECT DISTINCT
      eligible_project_judgment.project_id,
      eligible_project_judgment.article_id,
      eligible_project_judgment.prompt_id,
      eligible_project_judgment.judgment_id,
      eligible_project_judgment.model_id,
      TRIM(answer.answer_value) AS answer_value,
      eligible_project_judgment.answered_original,
      eligible_project_judgment.article_created_at,
      eligible_project_judgment.article_updated_at,
      eligible_project_judgment.judgment_created_at
    FROM eligible_project_judgment,
      UNNEST(eligible_project_judgment.normalized_answers) AS answer(answer_value)
    WHERE eligible_project_judgment.normalized_answers IS NOT NULL
      AND ARRAY_LENGTH(eligible_project_judgment.normalized_answers) > 0
      AND NULLIF(TRIM(answer.answer_value), '') IS NOT NULL;
  `
}

const getProjectPromptAnswerFactBatchInsertSql = (projectId: string, articleIds: string[]) => {
  return `
    BEGIN TRANSACTION;
    ${getProjectPromptAnswerFactBatchInsertBodySql(projectId, articleIds)}
    COMMIT;
  `
}

const getProjectPromptAnswerFactBatchRefreshSql = (projectId: string, articleIds: string[]) => {
  const projectLiteral = getSqlLiteral(projectId)
  const articleIdsSql = getProjectRefreshArticleIdsSql(articleIds)

  return `
    BEGIN TRANSACTION;
    DELETE FROM mart.prompt_answer_fact
    WHERE project_id = ${projectLiteral}
      AND article_id IN (${articleIdsSql});
    ${getProjectPromptAnswerFactBatchInsertBodySql(projectId, articleIds)}
    COMMIT;
  `
}

const getProjectReviewAnswerDictionaryRebuildSql = (projectId: string) => {
  const projectLiteral = getSqlLiteral(projectId)

  return `
    BEGIN TRANSACTION;
    DELETE FROM app.review_answer_dictionary WHERE project_id = ${projectLiteral};
    INSERT INTO app.review_answer_dictionary (
      project_id,
      prompt_id,
      answer_id,
      answer_value,
      numeric_answer_value,
      dictionary_updated_at
    )
    SELECT
      project_id,
      prompt_id,
      DENSE_RANK() OVER (PARTITION BY project_id, prompt_id ORDER BY answer_value ASC) AS answer_id,
      answer_value,
      TRY_CAST(answer_value AS BIGINT),
      current_timestamp
    FROM (
      SELECT DISTINCT project_id, prompt_id, answer_value
      FROM mart.prompt_answer_fact
      WHERE project_id = ${projectLiteral}
    ) answer_values;
    COMMIT;
  `
}

const getProjectReviewAnswerDictionaryMissingBatchInsertSql = (projectId: string, articleIds: string[]) => {
  const projectLiteral = getSqlLiteral(projectId)
  const articleIdsSql = getProjectRefreshArticleIdsSql(articleIds)

  return `
    BEGIN TRANSACTION;
    INSERT INTO app.review_answer_dictionary (
      project_id,
      prompt_id,
      answer_id,
      answer_value,
      numeric_answer_value,
      dictionary_updated_at
    )
    WITH answer_values AS (
      SELECT DISTINCT
        project_id,
        prompt_id,
        answer_value
      FROM mart.prompt_answer_fact
      WHERE project_id = ${projectLiteral}
        AND article_id IN (${articleIdsSql})
    ),
    missing_answer_values AS (
      SELECT answer_values.project_id, answer_values.prompt_id, answer_values.answer_value
      FROM answer_values
      LEFT JOIN app.review_answer_dictionary dictionary
        ON dictionary.project_id = answer_values.project_id
       AND dictionary.prompt_id = answer_values.prompt_id
       AND dictionary.answer_value = answer_values.answer_value
      WHERE dictionary.answer_id IS NULL
    ),
    current_answer_id AS (
      SELECT
        project_id,
        prompt_id,
        COALESCE(MAX(answer_id), 0) AS max_answer_id
      FROM app.review_answer_dictionary
      WHERE project_id = ${projectLiteral}
      GROUP BY project_id, prompt_id
    )
    SELECT
      missing_answer_values.project_id,
      missing_answer_values.prompt_id,
      COALESCE(current_answer_id.max_answer_id, 0)
        + ROW_NUMBER() OVER (
          PARTITION BY missing_answer_values.project_id, missing_answer_values.prompt_id
          ORDER BY missing_answer_values.answer_value ASC
        ) AS answer_id,
      missing_answer_values.answer_value,
      TRY_CAST(missing_answer_values.answer_value AS BIGINT),
      current_timestamp
    FROM missing_answer_values
    LEFT JOIN current_answer_id
      ON current_answer_id.project_id = missing_answer_values.project_id
     AND current_answer_id.prompt_id = missing_answer_values.prompt_id;
    COMMIT;
  `
}

const getProjectReviewArticleRollupResetSql = (projectId: string) => {
  const projectLiteral = getSqlLiteral(projectId)

  return `
    BEGIN TRANSACTION;
    DELETE FROM mart.review_article_rollup WHERE project_id = ${projectLiteral};
    COMMIT;
  `
}

const getProjectReviewArticleRollupBatchInsertSql = (projectId: string, articleIds: string[]) => {
  const projectLiteral = getSqlLiteral(projectId)
  const articleIdsSql = getProjectRefreshArticleIdsSql(articleIds)

  return `
    BEGIN TRANSACTION;
    DELETE FROM mart.review_article_rollup
    WHERE project_id = ${projectLiteral}
      AND article_id IN (${articleIdsSql});
    INSERT INTO mart.review_article_rollup (
      project_id,
      article_id,
      article_created_at,
      article_updated_at,
      enabled_prompt_count,
      llm_judged_prompt_count,
      human_answered_prompt_count,
      llm_judged_prompt_ids,
      human_answered_prompt_ids,
      has_all_llm_judgments,
      has_all_human_answers,
      in_curated_scope,
      in_route_scope,
      review_opened,
      review_sections_completed,
      latest_llm_created_at,
      latest_human_updated_at,
      latest_review_updated_at,
      rollup_updated_at
    )
    WITH enabled_project_prompt AS (
      SELECT project_id, prompt_id, enabled
      FROM app.project_prompt
      WHERE enabled = TRUE AND project_id = ${projectLiteral}
    ),
    enabled_project_prompt_count AS (
      SELECT project_id, COUNT(*) AS enabled_prompt_count
      FROM enabled_project_prompt
      GROUP BY project_id
    ),
    llm_project_prompt AS (
      SELECT
        scope_article.project_id,
        judgment_fact.article_id,
        judgment_fact.prompt_id,
        MAX(judgment_fact.created_at) AS latest_llm_created_at
      FROM mart.project_scope_article scope_article
      INNER JOIN app.project project ON project.id = scope_article.project_id
      INNER JOIN enabled_project_prompt enabled_prompt
        ON enabled_prompt.project_id = scope_article.project_id
      INNER JOIN mart.judgment_fact judgment_fact
        ON ${getProjectVisibleJudgmentScopeSql({
          judgmentAlias: 'judgment_fact',
          projectAlias: 'project',
          projectPromptAlias: 'enabled_prompt',
          projectScopeAlias: 'scope_article',
        })}
      WHERE scope_article.project_id = ${projectLiteral}
        AND scope_article.article_id IN (${articleIdsSql})
      GROUP BY scope_article.project_id, judgment_fact.article_id, judgment_fact.prompt_id
    ),
    llm_project_rollup AS (
      SELECT
        project_id,
        article_id,
        COUNT(DISTINCT prompt_id) AS llm_judged_prompt_count,
        LIST(DISTINCT prompt_id) AS llm_judged_prompt_ids,
        MAX(latest_llm_created_at) AS latest_llm_created_at
      FROM llm_project_prompt
      GROUP BY project_id, article_id
    ),
    prompt_mode_human_project_prompt AS (
      SELECT
        judgment_human.project_id,
        judgment_human.article_id,
        judgment_human.prompt_id,
        MAX(judgment_human.updated_at) AS latest_human_updated_at
      FROM app.judgment_human judgment_human
      INNER JOIN enabled_project_prompt enabled_prompt
        ON enabled_prompt.project_id = judgment_human.project_id
       AND enabled_prompt.prompt_id = judgment_human.prompt_id
      WHERE judgment_human.project_id = ${projectLiteral}
        AND judgment_human.article_id IN (${articleIdsSql})
        AND EXISTS (
          SELECT 1
          FROM app.project project
          WHERE project.id = judgment_human.project_id
            AND project.human_judgment_mode = 'prompt'
        )
        AND judgment_human.is_answered = TRUE
        AND NULLIF(TRIM(COALESCE(judgment_human.answer, '')), '') IS NOT NULL
      GROUP BY judgment_human.project_id, judgment_human.article_id, judgment_human.prompt_id
    ),
    prompt_mode_human_project_rollup AS (
      SELECT
        project_id,
        article_id,
        COUNT(DISTINCT prompt_id) AS human_answered_prompt_count,
        LIST(DISTINCT prompt_id) AS human_answered_prompt_ids,
        MAX(latest_human_updated_at) AS latest_human_updated_at
      FROM prompt_mode_human_project_prompt
      GROUP BY project_id, article_id
    ),
    summary_mode_human_project_rollup AS (
      SELECT
        judgment_human_summary.project_id,
        judgment_human_summary.article_id,
        1 AS human_answered_prompt_count,
        ['summary'] AS human_answered_prompt_ids,
        MAX(judgment_human_summary.updated_at) AS latest_human_updated_at
      FROM app.judgment_human_summary judgment_human_summary
      INNER JOIN app.project project
        ON project.id = judgment_human_summary.project_id
       AND project.human_judgment_mode = 'summary'
      WHERE judgment_human_summary.project_id = ${projectLiteral}
        AND judgment_human_summary.article_id IN (${articleIdsSql})
        AND NULLIF(TRIM(COALESCE(judgment_human_summary.answer, '')), '') IS NOT NULL
      GROUP BY judgment_human_summary.project_id, judgment_human_summary.article_id
    ),
    human_project_rollup AS (
      SELECT * FROM prompt_mode_human_project_rollup
      UNION ALL
      SELECT * FROM summary_mode_human_project_rollup
    ),
    review_state AS (
      SELECT
        review.project_id,
        review.article_id,
        MAX(review.updated_at) AS latest_review_updated_at,
        COALESCE(BOOL_OR(review.opened), FALSE) AS review_opened,
        MAX(
          CAST(review.reviewed_title AS INTEGER)
          + CAST(review.reviewed_abstract AS INTEGER)
          + CAST(review.reviewed_intro AS INTEGER)
          + CAST(review.reviewed_method AS INTEGER)
          + CAST(review.reviewed_results AS INTEGER)
          + CAST(review.reviewed_discussion AS INTEGER)
          + CAST(review.reviewed_conclusion AS INTEGER)
          + CAST(review.reviewed_appendix AS INTEGER)
          + CAST(review.reviewed_other AS INTEGER)
        ) AS review_sections_completed
      FROM app.review review
      WHERE review.project_id = ${projectLiteral}
        AND review.article_id IN (${articleIdsSql})
      GROUP BY project_id, article_id
    )
    SELECT
      scope_article.project_id,
      scope_article.article_id,
      scope_article.article_created_at,
      scope_article.article_updated_at,
      COALESCE(prompt_count.enabled_prompt_count, 0) AS enabled_prompt_count,
      COALESCE(llm_rollup.llm_judged_prompt_count, 0) AS llm_judged_prompt_count,
      COALESCE(human_rollup.human_answered_prompt_count, 0) AS human_answered_prompt_count,
      llm_rollup.llm_judged_prompt_ids,
      human_rollup.human_answered_prompt_ids,
      COALESCE(prompt_count.enabled_prompt_count, 0) > 0
        AND COALESCE(llm_rollup.llm_judged_prompt_count, 0) = COALESCE(prompt_count.enabled_prompt_count, 0) AS has_all_llm_judgments,
      CASE
        WHEN project.human_judgment_mode = 'summary' THEN COALESCE(human_rollup.human_answered_prompt_count, 0) > 0
        ELSE COALESCE(prompt_count.enabled_prompt_count, 0) > 0
          AND COALESCE(human_rollup.human_answered_prompt_count, 0) = COALESCE(prompt_count.enabled_prompt_count, 0)
      END AS has_all_human_answers,
      scope_article.in_curated_scope,
      scope_article.in_route_scope,
      COALESCE(review_state.review_opened, FALSE) AS review_opened,
      COALESCE(review_state.review_sections_completed, 0) AS review_sections_completed,
      llm_rollup.latest_llm_created_at,
      human_rollup.latest_human_updated_at,
      review_state.latest_review_updated_at,
      current_timestamp AS rollup_updated_at
    FROM mart.project_scope_article scope_article
    INNER JOIN app.project project ON project.id = scope_article.project_id
    LEFT JOIN enabled_project_prompt_count prompt_count ON prompt_count.project_id = scope_article.project_id
    LEFT JOIN llm_project_rollup llm_rollup
      ON llm_rollup.project_id = scope_article.project_id
     AND llm_rollup.article_id = scope_article.article_id
    LEFT JOIN human_project_rollup human_rollup
      ON human_rollup.project_id = scope_article.project_id
     AND human_rollup.article_id = scope_article.article_id
    LEFT JOIN review_state
      ON review_state.project_id = scope_article.project_id
     AND review_state.article_id = scope_article.article_id
    WHERE scope_article.project_id = ${projectLiteral}
      AND scope_article.article_id IN (${articleIdsSql});
    COMMIT;
  `
}

const getProjectReviewServingSetupSql = (projectId: string) => {
  const projectLiteral = getSqlLiteral(projectId)

  return `
    BEGIN TRANSACTION;
    INSERT INTO app.project_review_serving_generation (
      project_id,
      active_generation,
      generation_updated_at
    )
    VALUES (
      ${projectLiteral},
      0,
      current_timestamp
    )
    ON CONFLICT(project_id) DO NOTHING;
    DELETE FROM mart.review_article_serving
    WHERE project_id = ${projectLiteral}
      AND generation = (
        SELECT active_generation + 1
        FROM app.project_review_serving_generation
        WHERE project_id = ${projectLiteral}
      );
    DELETE FROM mart.review_article_filter_member
    WHERE project_id = ${projectLiteral}
      AND generation = (
        SELECT active_generation + 1
        FROM app.project_review_serving_generation
        WHERE project_id = ${projectLiteral}
      );
    DELETE FROM mart.review_article_serving_detail
    WHERE project_id = ${projectLiteral}
      AND generation = (
        SELECT active_generation + 1
        FROM app.project_review_serving_generation
        WHERE project_id = ${projectLiteral}
      );
    COMMIT;
  `
}

const getProjectReviewServingBatchSql = (projectId: string, articleIds: string[]) => {
  const projectLiteral = getSqlLiteral(projectId)
  const articleIdsSql = getProjectRefreshArticleIdsSql(articleIds)

  return `
    BEGIN TRANSACTION;
    INSERT INTO mart.review_article_serving (
      project_id,
      generation,
      article_id,
      article_created_at,
      article_updated_at,
      article_title,
      article_external_id,
      journal_title,
      url,
      full_text_pdf,
      full_text_fetched_at,
      full_text_conversion_status,
      source_metadata,
      has_all_llm_judgments,
      llm_judged_prompt_count,
      llm_judged_prompt_ids,
      enabled_prompt_count,
      human_answered_prompt_count,
      human_answered_prompt_ids,
      has_all_human_answers,
      review_opened,
      review_sections_completed,
      latest_llm_created_at,
      latest_human_updated_at,
      latest_review_updated_at,
      serving_updated_at
    )
    SELECT
      rollup.project_id,
      (
        SELECT active_generation + 1
        FROM app.project_review_serving_generation
        WHERE project_id = ${projectLiteral}
      ) AS generation,
      rollup.article_id,
      rollup.article_created_at,
      rollup.article_updated_at,
      article.article_title,
      article.article_id,
      json_extract_string(article.source_metadata, '$.journalTitle'),
      article.url,
      article.full_text_pdf,
      article.full_text_fetched_at,
      article.full_text_conversion_status,
      article.source_metadata,
      rollup.has_all_llm_judgments,
      rollup.llm_judged_prompt_count,
      rollup.llm_judged_prompt_ids,
      rollup.enabled_prompt_count,
      rollup.human_answered_prompt_count,
      rollup.human_answered_prompt_ids,
      rollup.has_all_human_answers,
      rollup.review_opened,
      rollup.review_sections_completed,
      rollup.latest_llm_created_at,
      rollup.latest_human_updated_at,
      rollup.latest_review_updated_at,
      current_timestamp
    FROM mart.review_article_rollup rollup
    INNER JOIN app.article article ON article.id = rollup.article_id
    WHERE rollup.project_id = ${projectLiteral}
      AND rollup.article_id IN (${articleIdsSql});
    INSERT INTO mart.review_article_filter_member (
      project_id,
      generation,
      prompt_id,
      answer_id,
      article_id,
      article_created_at,
      numeric_answer_value,
      member_updated_at
    )
    SELECT DISTINCT
      fact.project_id,
      (
        SELECT active_generation + 1
        FROM app.project_review_serving_generation
        WHERE project_id = ${projectLiteral}
      ) AS generation,
      fact.prompt_id,
      dict.answer_id,
      fact.article_id,
      rollup.article_created_at,
      dict.numeric_answer_value,
      current_timestamp
    FROM mart.prompt_answer_fact fact
    INNER JOIN app.review_answer_dictionary dict
      ON dict.project_id = fact.project_id
     AND dict.prompt_id = fact.prompt_id
     AND dict.answer_value = fact.answer_value
    INNER JOIN mart.review_article_rollup rollup
      ON rollup.project_id = fact.project_id
     AND rollup.article_id = fact.article_id
    WHERE fact.project_id = ${projectLiteral}
      AND fact.article_id IN (${articleIdsSql});
    INSERT INTO mart.review_article_serving_detail (
      project_id,
      generation,
      article_id,
      prompt_id,
      prompt_order,
      judgment_id,
      created_at,
      article_created_at,
      article_updated_at,
      model_id,
      answered_original,
      answered_original_as_array,
      detail_updated_at
    )
    SELECT
      scope_article.project_id,
      (
        SELECT active_generation + 1
        FROM app.project_review_serving_generation
        WHERE project_id = ${projectLiteral}
      ) AS generation,
      judgment_fact.article_id,
      judgment_fact.prompt_id,
      project_prompt.prompt_order,
      judgment_fact.judgment_id,
      judgment_fact.created_at,
      judgment_fact.article_created_at,
      judgment_fact.article_updated_at,
      judgment_fact.model_id,
      judgment_fact.answered_original,
      judgment_fact.answered_original_as_array,
      current_timestamp
    FROM mart.project_scope_article scope_article
    INNER JOIN app.project project ON project.id = scope_article.project_id
    INNER JOIN app.project_prompt project_prompt
      ON project_prompt.project_id = scope_article.project_id
     AND project_prompt.enabled = TRUE
    INNER JOIN mart.judgment_fact judgment_fact
      ON ${getProjectVisibleJudgmentScopeSql({
        judgmentAlias: 'judgment_fact',
        projectAlias: 'project',
        projectPromptAlias: 'project_prompt',
        projectScopeAlias: 'scope_article',
      })}
    WHERE scope_article.project_id = ${projectLiteral}
      AND scope_article.article_id IN (${articleIdsSql});
    COMMIT;
  `
}

const getProjectReviewActiveServingBatchRefreshSql = (projectId: string, articleIds: string[]) => {
  const projectLiteral = getSqlLiteral(projectId)
  const articleIdsSql = getProjectRefreshArticleIdsSql(articleIds)

  return `
    BEGIN TRANSACTION;
    DELETE FROM mart.review_article_serving_detail
    WHERE project_id = ${projectLiteral}
      AND article_id IN (${articleIdsSql})
      AND generation = (
        SELECT active_generation
        FROM app.project_review_serving_generation
        WHERE project_id = ${projectLiteral}
      );
    DELETE FROM mart.review_article_filter_member
    WHERE project_id = ${projectLiteral}
      AND article_id IN (${articleIdsSql})
      AND generation = (
        SELECT active_generation
        FROM app.project_review_serving_generation
        WHERE project_id = ${projectLiteral}
      );
    DELETE FROM mart.review_article_serving
    WHERE project_id = ${projectLiteral}
      AND article_id IN (${articleIdsSql})
      AND generation = (
        SELECT active_generation
        FROM app.project_review_serving_generation
        WHERE project_id = ${projectLiteral}
      );
    INSERT INTO mart.review_article_serving (
      project_id,
      generation,
      article_id,
      article_created_at,
      article_updated_at,
      article_title,
      article_external_id,
      journal_title,
      url,
      full_text_pdf,
      full_text_fetched_at,
      full_text_conversion_status,
      source_metadata,
      has_all_llm_judgments,
      llm_judged_prompt_count,
      llm_judged_prompt_ids,
      enabled_prompt_count,
      human_answered_prompt_count,
      human_answered_prompt_ids,
      has_all_human_answers,
      review_opened,
      review_sections_completed,
      latest_llm_created_at,
      latest_human_updated_at,
      latest_review_updated_at,
      serving_updated_at
    )
    SELECT
      rollup.project_id,
      (
        SELECT active_generation
        FROM app.project_review_serving_generation
        WHERE project_id = ${projectLiteral}
      ) AS generation,
      rollup.article_id,
      rollup.article_created_at,
      rollup.article_updated_at,
      article.article_title,
      article.article_id,
      json_extract_string(article.source_metadata, '$.journalTitle'),
      article.url,
      article.full_text_pdf,
      article.full_text_fetched_at,
      article.full_text_conversion_status,
      article.source_metadata,
      rollup.has_all_llm_judgments,
      rollup.llm_judged_prompt_count,
      rollup.llm_judged_prompt_ids,
      rollup.enabled_prompt_count,
      rollup.human_answered_prompt_count,
      rollup.human_answered_prompt_ids,
      rollup.has_all_human_answers,
      rollup.review_opened,
      rollup.review_sections_completed,
      rollup.latest_llm_created_at,
      rollup.latest_human_updated_at,
      rollup.latest_review_updated_at,
      current_timestamp
    FROM mart.review_article_rollup rollup
    INNER JOIN app.article article ON article.id = rollup.article_id
    WHERE rollup.project_id = ${projectLiteral}
      AND rollup.article_id IN (${articleIdsSql});
    INSERT INTO mart.review_article_filter_member (
      project_id,
      generation,
      prompt_id,
      answer_id,
      article_id,
      article_created_at,
      numeric_answer_value,
      member_updated_at
    )
    SELECT DISTINCT
      fact.project_id,
      (
        SELECT active_generation
        FROM app.project_review_serving_generation
        WHERE project_id = ${projectLiteral}
      ) AS generation,
      fact.prompt_id,
      dict.answer_id,
      fact.article_id,
      rollup.article_created_at,
      dict.numeric_answer_value,
      current_timestamp
    FROM mart.prompt_answer_fact fact
    INNER JOIN app.review_answer_dictionary dict
      ON dict.project_id = fact.project_id
     AND dict.prompt_id = fact.prompt_id
     AND dict.answer_value = fact.answer_value
    INNER JOIN mart.review_article_rollup rollup
      ON rollup.project_id = fact.project_id
     AND rollup.article_id = fact.article_id
    WHERE fact.project_id = ${projectLiteral}
      AND fact.article_id IN (${articleIdsSql});
    INSERT INTO mart.review_article_serving_detail (
      project_id,
      generation,
      article_id,
      prompt_id,
      prompt_order,
      judgment_id,
      created_at,
      article_created_at,
      article_updated_at,
      model_id,
      answered_original,
      answered_original_as_array,
      detail_updated_at
    )
    SELECT
      scope_article.project_id,
      (
        SELECT active_generation
        FROM app.project_review_serving_generation
        WHERE project_id = ${projectLiteral}
      ) AS generation,
      judgment_fact.article_id,
      judgment_fact.prompt_id,
      project_prompt.prompt_order,
      judgment_fact.judgment_id,
      judgment_fact.created_at,
      judgment_fact.article_created_at,
      judgment_fact.article_updated_at,
      judgment_fact.model_id,
      judgment_fact.answered_original,
      judgment_fact.answered_original_as_array,
      current_timestamp
    FROM mart.project_scope_article scope_article
    INNER JOIN app.project project ON project.id = scope_article.project_id
    INNER JOIN app.project_prompt project_prompt
      ON project_prompt.project_id = scope_article.project_id
     AND project_prompt.enabled = TRUE
    INNER JOIN mart.judgment_fact judgment_fact
      ON ${getProjectVisibleJudgmentScopeSql({
        judgmentAlias: 'judgment_fact',
        projectAlias: 'project',
        projectPromptAlias: 'project_prompt',
        projectScopeAlias: 'scope_article',
      })}
    WHERE scope_article.project_id = ${projectLiteral}
      AND scope_article.article_id IN (${articleIdsSql});
    COMMIT;
  `
}

const getProjectReviewServingFinalizeSql = (projectId: string) => {
  const projectLiteral = getSqlLiteral(projectId)

  return `
    BEGIN TRANSACTION;
    UPDATE app.project_review_serving_generation
    SET active_generation = active_generation + 1,
        generation_updated_at = current_timestamp
    WHERE project_id = ${projectLiteral};
    DELETE FROM mart.review_article_filter_member
    WHERE project_id = ${projectLiteral}
      AND generation < (
        SELECT active_generation - 1
        FROM app.project_review_serving_generation
        WHERE project_id = ${projectLiteral}
      );
    DELETE FROM mart.review_article_serving
    WHERE project_id = ${projectLiteral}
      AND generation < (
        SELECT active_generation - 1
        FROM app.project_review_serving_generation
        WHERE project_id = ${projectLiteral}
      );
    DELETE FROM mart.review_article_serving_detail
    WHERE project_id = ${projectLiteral}
      AND generation < (
        SELECT active_generation - 1
        FROM app.project_review_serving_generation
        WHERE project_id = ${projectLiteral}
      );
    COMMIT;
  `
}

const _judgmentFactCreateSql = `
  CREATE TABLE mart.judgment_fact (
    judgment_id VARCHAR PRIMARY KEY,
    article_id VARCHAR NOT NULL,
    prompt_id VARCHAR NOT NULL,
    model_id VARCHAR NOT NULL,
    project_id VARCHAR,
    snapshot_project_id VARCHAR,
    snapshot_project_model_name VARCHAR,
    use_title BOOLEAN NOT NULL,
    use_abstract BOOLEAN NOT NULL,
    use_fulltext BOOLEAN NOT NULL,
    use_fulltext_no_images BOOLEAN NOT NULL,
    chunking_strategy VARCHAR,
    is_answered BOOLEAN NOT NULL,
    answered_original VARCHAR,
    answered_original_as_array VARCHAR[],
    normalized_answers VARCHAR[],
    confidence_original INTEGER,
    explanation VARCHAR,
    quotes JSON,
    article_title VARCHAR NOT NULL,
    article_created_at TIMESTAMPTZ,
    article_updated_at TIMESTAMPTZ,
    article_import_route VARCHAR,
    article_publication_status VARCHAR,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
  )
`

const getJudgmentFactRefreshSourceSql = (articleFilterSql: string) => {
  return `
    SELECT
      judgment.id,
      judgment.article_id,
      judgment.prompt_id,
      judgment.model_id,
      judgment.project_id,
      judgment.snapshot_project_id,
      judgment.snapshot_project_model_name,
      judgment.use_title,
      judgment.use_abstract,
      judgment.use_fulltext,
      judgment.use_fulltext_no_images,
      judgment.chunking_strategy,
      judgment.is_answered,
      NULLIF(TRIM(COALESCE(judgment.answered_original, '')), '') AS answered_original,
      judgment.answered_original_as_array,
      CASE
        WHEN judgment.answered_original_as_array IS NOT NULL AND ARRAY_LENGTH(judgment.answered_original_as_array) > 0
          THEN judgment.answered_original_as_array
        WHEN NULLIF(TRIM(COALESCE(judgment.answered_original, '')), '') IS NOT NULL
          THEN [TRIM(COALESCE(judgment.answered_original, ''))]
        ELSE NULL
      END AS normalized_answers,
      judgment.confidence_original,
      judgment.explanation,
      judgment.quotes,
      article.article_title,
      article.article_created_at,
      article.article_updated_at,
      article.import_route,
      article.publication_status,
      judgment.created_at,
      judgment.updated_at
    FROM app.judgment judgment
    INNER JOIN app.article article ON article.id = judgment.article_id
    WHERE judgment.deleted_at IS NULL
      AND ${articleFilterSql}
  `
}

const getJudgmentFactSafeRefreshSql = ({dirtyArticlesSql}: {dirtyArticlesSql: string}) => {
  return `
    BEGIN TRANSACTION;
    DROP TABLE IF EXISTS temp_dirty_judgment_fact_article;
    CREATE TEMP TABLE temp_dirty_judgment_fact_article AS
    SELECT DISTINCT article_id
    FROM (${dirtyArticlesSql}) dirty_article_source
    WHERE article_id IS NOT NULL;
    DELETE FROM mart.judgment_fact
    WHERE EXISTS (
      SELECT 1
      FROM temp_dirty_judgment_fact_article dirty_article
      WHERE dirty_article.article_id = mart.judgment_fact.article_id
    );
    INSERT INTO mart.judgment_fact (
      judgment_id,
      article_id,
      prompt_id,
      model_id,
      project_id,
      snapshot_project_id,
      snapshot_project_model_name,
      use_title,
      use_abstract,
      use_fulltext,
      use_fulltext_no_images,
      chunking_strategy,
      is_answered,
      answered_original,
      answered_original_as_array,
      normalized_answers,
      confidence_original,
      explanation,
      quotes,
      article_title,
      article_created_at,
      article_updated_at,
      article_import_route,
      article_publication_status,
      created_at,
      updated_at
    )
    ${getJudgmentFactRefreshSourceSql(`
      EXISTS (
        SELECT 1
        FROM temp_dirty_judgment_fact_article dirty_article
        WHERE dirty_article.article_id = judgment.article_id
      )
    `)};
    DROP TABLE temp_dirty_judgment_fact_article;
    COMMIT;
  `
}

const getJudgmentArticleRefreshSql = (articleId: string) => {
  const articleLiteral = getSqlLiteral(articleId)

  return getJudgmentFactSafeRefreshSql({dirtyArticlesSql: `SELECT ${articleLiteral} AS article_id`})
}

const getJudgmentProjectClaimRefreshSql = ({
  claimedToken,
  lastCompletedToken,
  projectId,
}: {
  claimedToken: number
  lastCompletedToken: number
  projectId: string
}) => {
  return getJudgmentFactSafeRefreshSql({
    dirtyArticlesSql: `
      SELECT DISTINCT article_id
      FROM app.project_mart_refresh_article_state
      WHERE project_id = ${getSqlLiteral(projectId)}
        AND first_dirty_token <= ${claimedToken}
        AND last_dirty_token > ${lastCompletedToken}
    `,
  })
}

const getJudgmentProjectScopeBatchRefreshSql = (projectId: string, articleIds: string[]) => {
  const projectLiteral = getSqlLiteral(projectId)
  const articleRowsSql = getProjectRefreshArticleIdRowsSql(articleIds)

  return getJudgmentFactSafeRefreshSql({
    dirtyArticlesSql: `
      SELECT requested_article.article_id
      FROM (VALUES ${articleRowsSql}) AS requested_article(article_id)
      INNER JOIN mart.project_scope_article scope_article
        ON scope_article.project_id = ${projectLiteral}
       AND scope_article.article_id = requested_article.article_id
    `,
  })
}

const getQueuedArticleTasks = async () => {
  await ensureMartRefreshQueueSchema()
  return getAppDatabaseService().queryJson<MartRefreshTaskRow>(getQueuedArticleTasksSql())
}

const getHasQueuedDrainableTasks = async () => {
  await ensureMartRefreshQueueSchema()
  const rows = await getAppDatabaseService().queryJson<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.mart_refresh_queue
    WHERE completed_at IS NULL
      AND refresh_scope = 'judgment_article'
  `)

  return Number(rows[0]?.count ?? 0) > 0
}

const completeQueuedTask = async (task: MartRefreshTaskRow) => {
  await getAppDatabaseService().run(`
    UPDATE app.mart_refresh_queue
    SET completed_at = NOW(),
        updated_at = NOW()
    WHERE id = ${getSqlLiteral(task.id)}
      AND COALESCE(refresh_generation, 0) = ${task.refreshGeneration}
  `)
  await completeQueuedMaintenanceWorkTask(task)
}

const completeQueuedTasks = async (tasks: MartRefreshTaskRow[]): Promise<void> => {
  const [currentTask] = tasks

  if (!currentTask) {
    return
  }

  await completeQueuedTask(currentTask)
  return completeQueuedTasks(tasks.slice(1))
}

const getUniqueValues = (values: Array<string | null | undefined>) => {
  return Array.from(
    new Set(
      values.filter((value): value is string => {
        return typeof value === 'string' && value !== ''
      }),
    ),
  )
}

const queueLargeRebuildsForDirtyStates = async (
  states: MarkedProjectDirtyState[],
  runner: {queryJson: <T>(statement: string) => Promise<T[]>; run: (statement: string) => Promise<void>},
) => {
  return states.reduce<Promise<MarkedProjectDirtyState[]>>(async (accPromise, state) => {
    const acc = await accPromise

    await getProjectMartLargeRebuildStateService().queueLargeRebuild({
      projectId: state.projectId,
      rebuildPhase: 'project_scope_article',
      refreshToken: state.dirtyToken,
      runner,
    })

    return [...acc, state]
  }, Promise.resolve([]))
}

const queueProjectLargeRebuilds = async (projectIds: string[], reason: string) => {
  const refreshStateService = getProjectMartRefreshStateService()
  const uniqueProjectIds = getUniqueValues(projectIds)

  return uniqueProjectIds.length === 0
    ? []
    : (getAppDatabaseService().transaction(async (tx) => {
        const dirtyProjects = await refreshStateService.getDirtyProjectsForProjectIds(tx, uniqueProjectIds)
        const states = await refreshStateService.markProjectsDirtyAtomically({
          projects: dirtyProjects,
          reason,
          runner: tx,
        })

        return queueLargeRebuildsForDirtyStates(states, tx)
      }) as Promise<MarkedProjectDirtyState[]>)
}

const markProjectRefreshesDirty = async (projectIds: string[], reason: string) => {
  const refreshStateService = getProjectMartRefreshStateService()
  const uniqueProjectIds = getUniqueValues(projectIds)

  return uniqueProjectIds.length === 0
    ? []
    : (getAppDatabaseService().transaction(async (tx) => {
        const dirtyProjects = await refreshStateService.getDirtyProjectsForProjectIds(tx, uniqueProjectIds)

        return refreshStateService.markProjectsDirtyAtomically({projects: dirtyProjects, reason, runner: tx})
      }) as Promise<MarkedProjectDirtyState[]>)
}

const queueProjectLargeRebuildForDirtyArticles = async (projectId: string, articleIds: string[], reason: string) => {
  const refreshArticleIds = getUniqueValues(articleIds)

  return refreshArticleIds.length === 0
    ? []
    : (getAppDatabaseService().transaction(async (tx) => {
        const states = await getProjectMartRefreshStateService().markProjectsDirtyAtomically({
          projects: [{articleIds: refreshArticleIds, projectId}],
          reason,
          runner: tx,
        })

        return queueLargeRebuildsForDirtyStates(states, tx)
      }) as Promise<MarkedProjectDirtyState[]>)
}

const claimQueuedMaintenanceWorkTask = async (task: MartRefreshTaskRow) => {
  const workerId = getMartRefreshQueueWorkerId()

  return task.articleId
    ? getMaintenanceWorkLeaseService().claimMaintenanceWorkLease({
        articleId: task.articleId,
        consumerId: workerId,
        leaseMs: martRefreshQueueLeaseMs,
        queueId: task.id,
        requiredConsumerRole: 'maintenance-worker',
        scopeKind: 'article',
        workKind: 'review_index_article_refresh',
      })
    : Promise.resolve(null)
}

const completeQueuedMaintenanceWorkTask = async (task: MartRefreshTaskRow) => {
  const workerId = getMartRefreshQueueWorkerId()

  return task.articleId
    ? getMaintenanceWorkLeaseService().completeMaintenanceWorkLease({
        articleId: task.articleId,
        consumerId: workerId,
        queueId: task.id,
        scopeKind: 'article',
        workKind: 'review_index_article_refresh',
      })
    : Promise.resolve()
}

const failQueuedMaintenanceWorkTask = async (task: MartRefreshTaskRow, error: unknown) => {
  const workerId = getMartRefreshQueueWorkerId()
  const retryAfterAt = new Date(Date.now() + martRefreshRetryDelayMs)
  const recoveryContext = {error: error instanceof Error ? error.message : String(error), queueId: task.id}

  return task.articleId
    ? getMaintenanceWorkLeaseService().failMaintenanceWorkLease({
        articleId: task.articleId,
        consumerId: workerId,
        leaseMs: martRefreshQueueLeaseMs,
        queueId: task.id,
        recoveryContext,
        requiredConsumerRole: 'maintenance-worker',
        retryAfterAt,
        scopeKind: 'article',
        workKind: 'review_index_article_refresh',
      })
    : Promise.resolve()
}

const claimQueuedMaintenanceWorkTasks = async (tasks: MartRefreshTaskRow[]): Promise<void> => {
  const [currentTask] = tasks

  if (!currentTask) {
    return
  }

  await claimQueuedMaintenanceWorkTask(currentTask)
  return claimQueuedMaintenanceWorkTasks(tasks.slice(1))
}

const failQueuedMaintenanceWorkTasks = async (tasks: MartRefreshTaskRow[], error: unknown): Promise<void> => {
  const [currentTask] = tasks

  if (!currentTask) {
    return
  }

  await failQueuedMaintenanceWorkTask(currentTask, error)
  return failQueuedMaintenanceWorkTasks(tasks.slice(1), error)
}

const queryMartRefreshBackgroundJson = async <T>(statement: string): Promise<T[]> => {
  return getAppDatabaseService().queryJsonBackground<T>(statement)
}

const getNormalizedMartRefreshError = (error: unknown): Error => {
  return error instanceof Error ? error : new Error(String(error))
}

const isMartRefreshFatalInvalidationError = (error: unknown) => {
  const message = getNormalizedMartRefreshError(error).message

  return martRefreshFatalInvalidationErrorFragments.some((fragment) => {
    return message.includes(fragment)
  })
}

const isMartRefreshCommitFailureError = (error: unknown) => {
  return getNormalizedMartRefreshError(error).message.includes('Failed to commit:')
}

const getChainedMartRefreshError = (error: unknown, nextError: unknown, context: string): Error => {
  const normalizedError = getNormalizedMartRefreshError(error)
  const normalizedNextError = getNormalizedMartRefreshError(nextError)
  const combinedMessage =
    normalizedNextError.message === normalizedError.message
      ? normalizedError.message
      : `${normalizedError.message} -- ${context}: ${normalizedNextError.message}`

  return combinedMessage === normalizedError.message ? normalizedError : new Error(combinedMessage)
}

const hasMartRefreshExplicitTransaction = (statement: string) => {
  const normalizedStatement = statement.toUpperCase()

  return normalizedStatement.includes('BEGIN TRANSACTION') || normalizedStatement.includes('START TRANSACTION')
}

const shouldAttemptMartRefreshBackgroundRollback = (statement: string, error: unknown) => {
  const normalizedError = getNormalizedMartRefreshError(error)

  return (
    !isMartRefreshFatalInvalidationError(normalizedError)
    && !isMartRefreshCommitFailureError(normalizedError)
    && (hasMartRefreshExplicitTransaction(statement)
      || normalizedError.message.includes('Current transaction is aborted')
      || normalizedError.message.includes('please ROLLBACK'))
  )
}

const getMartRefreshBackgroundRollbackError = async (): Promise<Error | null> => {
  try {
    await getAppDatabaseService().runBackground('ROLLBACK')
    return null
  } catch (error) {
    return getNormalizedMartRefreshError(error)
  }
}

const getMartRefreshBackgroundRestartError = async (): Promise<Error | null> => {
  try {
    await getAppDatabaseService().close()
    return null
  } catch (error) {
    return getNormalizedMartRefreshError(error)
  }
}

const runMartRefreshBackgroundStatement = async (statement: string) => {
  try {
    await getAppDatabaseService().runBackground(statement)
  } catch (error) {
    const normalizedError = getNormalizedMartRefreshError(error)
    const isFatalInvalidationError = isMartRefreshFatalInvalidationError(normalizedError)
    const followOnError = isFatalInvalidationError
      ? await getMartRefreshBackgroundRestartError()
      : shouldAttemptMartRefreshBackgroundRollback(statement, normalizedError)
        ? await getMartRefreshBackgroundRollbackError()
        : null

    throw followOnError === null
      ? normalizedError
      : getChainedMartRefreshError(
          normalizedError,
          followOnError,
          isFatalInvalidationError ? 'runtime restart failed' : 'rollback failed',
        )
  }
}

const getImpactedProjectIdsForArticle = async (articleId: string) => {
  const rows = await queryMartRefreshBackgroundJson<{projectId: string}>(`
    SELECT project_article.project_id AS projectId
    FROM app.project_article project_article
    INNER JOIN app.project project ON project.id = project_article.project_id
    WHERE project_article.article_id = ${getSqlLiteral(articleId)}
      AND project.archived = FALSE
    UNION
    SELECT pir.project_id AS projectId
    FROM app.project_import_route pir
    INNER JOIN app.project project ON project.id = pir.project_id
    INNER JOIN app.article_import_route air ON air.import_route_id = pir.import_route_id
    WHERE air.article_id = ${getSqlLiteral(articleId)}
      AND project.archived = FALSE
  `)

  return rows.map((row) => {
    return row.projectId
  })
}

const getHasActiveProjectReviewServingGeneration = async (projectId: string) => {
  const rows = await queryMartRefreshBackgroundJson<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.project_review_serving_generation
    WHERE project_id = ${getSqlLiteral(projectId)}
      AND active_generation > 0
  `)

  return Number(rows[0]?.count ?? 0) > 0
}

const getProjectIsArchived = async (projectId: string) => {
  const [projectRow] = await queryMartRefreshBackgroundJson<{archived: boolean}>(`
    SELECT archived AS archived
    FROM app.project
    WHERE id = ${getSqlLiteral(projectId)}
    LIMIT 1
  `)

  return Boolean(projectRow?.archived)
}

const getProjectScopeSourceBatchRows = async (
  projectId: string,
  cursor: ProjectRefreshBatchCursor | null,
): Promise<ProjectRefreshScopeBatchRow[]> => {
  return queryMartRefreshBackgroundJson<ProjectRefreshScopeBatchRow>(getProjectScopeSourceBatchSql(projectId, cursor))
}

const getProjectScopeBatchRows = async (
  projectId: string,
  cursor: ProjectRefreshBatchCursor | null,
): Promise<ProjectRefreshBatchRow[]> => {
  return queryMartRefreshBackgroundJson<ProjectRefreshBatchRow>(getProjectScopeBatchSql(projectId, cursor))
}

const getProjectTablePurgeBatchRows = async ({
  projectId,
  tableName,
}: {
  projectId: string
  tableName: string
}): Promise<ProjectPurgeBatchRow[]> => {
  return queryMartRefreshBackgroundJson<ProjectPurgeBatchRow>(getProjectTablePurgeBatchSql({projectId, tableName}))
}

const getReviewArticleServingRewriteBatchRows = async ({
  cursor,
  projectId,
}: {
  cursor: ReviewArticleServingRewriteBatchCursor | null
  projectId: string
}): Promise<ProjectPurgeBatchRow[]> => {
  return queryMartRefreshBackgroundJson<ProjectPurgeBatchRow>(
    getReviewArticleServingRewriteCopyBatchSql({cursor, projectId}),
  )
}

const refreshProjectScopeBatches = async (
  projectId: string,
  cursor: ProjectRefreshBatchCursor | null = null,
): Promise<void> => {
  const batchRows = await getProjectScopeSourceBatchRows(projectId, cursor)

  return batchRows.length === 0
    ? Promise.resolve()
    : runMartRefreshBackgroundStatement(getProjectScopeBatchInsertSql(projectId, batchRows))
        .then(() => {
          return yieldToEventLoop()
        })
        .then(() => {
          return refreshProjectScopeBatches(projectId, getProjectRefreshBatchCursor(batchRows))
        })
}

const refreshProjectScopeArticleBatches = async ({
  cursor = null,
  processBatch,
  projectId,
}: {
  cursor?: ProjectRefreshBatchCursor | null
  processBatch: (articleIds: string[]) => Promise<void>
  projectId: string
}): Promise<void> => {
  const batchRows = await getProjectScopeBatchRows(projectId, cursor)
  const articleIds = getProjectRefreshBatchArticleIds(batchRows)

  return articleIds.length === 0
    ? Promise.resolve()
    : processBatch(articleIds)
        .then(() => {
          return yieldToEventLoop()
        })
        .then(() => {
          return refreshProjectScopeArticleBatches({
            cursor: getProjectRefreshBatchCursor(batchRows),
            processBatch,
            projectId,
          })
        })
}

const rebuildProjectScope = async (projectId: string): Promise<void> => {
  await runMartRefreshBackgroundStatement(getProjectScopeResetSql(projectId))
  return refreshProjectScopeBatches(projectId)
}

const refreshProjectScopeArticles = async (projectId: string, articleIds: string[]): Promise<void> => {
  const refreshArticleIds = getUniqueValues(articleIds)

  return refreshArticleIds.length === 0
    ? Promise.resolve()
    : runMartRefreshBackgroundStatement(getProjectScopeArticleBatchRefreshSql(projectId, refreshArticleIds)).then(
        () => {
          return yieldToEventLoop()
        },
      )
}

const refreshJudgmentFactsForProjectScope = async (projectId: string): Promise<void> => {
  return refreshProjectScopeArticleBatches({
    processBatch: async (articleIds) => {
      return runMartRefreshBackgroundStatement(getJudgmentProjectScopeBatchRefreshSql(projectId, articleIds))
    },
    projectId,
  })
}

const rebuildProjectPromptAnswerFact = async (projectId: string): Promise<void> => {
  await runMartRefreshBackgroundStatement(getProjectPromptAnswerFactResetSql(projectId))
  return refreshProjectScopeArticleBatches({
    processBatch: async (articleIds) => {
      return runMartRefreshBackgroundStatement(getProjectPromptAnswerFactBatchInsertSql(projectId, articleIds))
    },
    projectId,
  })
}

const rebuildProjectReviewArticleRollup = async (projectId: string): Promise<void> => {
  await runMartRefreshBackgroundStatement(getProjectReviewArticleRollupResetSql(projectId))
  return refreshProjectScopeArticleBatches({
    processBatch: async (articleIds) => {
      return runMartRefreshBackgroundStatement(getProjectReviewArticleRollupBatchInsertSql(projectId, articleIds))
    },
    projectId,
  })
}

const rebuildProjectReviewServing = async (projectId: string): Promise<void> => {
  await runMartRefreshBackgroundStatement(getProjectReviewServingSetupSql(projectId))
  await refreshProjectScopeArticleBatches({
    processBatch: async (articleIds) => {
      return runMartRefreshBackgroundStatement(getProjectReviewServingBatchSql(projectId, articleIds))
    },
    projectId,
  })
  return runMartRefreshBackgroundStatement(getProjectReviewServingFinalizeSql(projectId))
}

const copyReviewArticleServingRewriteBatches = async ({
  cursor = null,
  projectId,
}: {
  cursor?: ReviewArticleServingRewriteBatchCursor | null
  projectId: string
}): Promise<void> => {
  const batchRows = await getReviewArticleServingRewriteBatchRows({cursor, projectId})
  const rowIds = batchRows.map((row) => {
    return row.rowId
  })
  const [lastBatchRow] = batchRows.slice(-1)

  return rowIds.length === 0
    ? Promise.resolve()
    : runMartRefreshBackgroundStatement(getReviewArticleServingRewriteBatchInsertSql(rowIds))
        .then(() => {
          return yieldToEventLoop()
        })
        .then(() => {
          return copyReviewArticleServingRewriteBatches({cursor: lastBatchRow ?? null, projectId})
        })
}

const rewriteReviewArticleServingForArchivedProject = async (projectId: string): Promise<void> => {
  await runMartRefreshBackgroundStatement(getReviewArticleServingRewritePurgeSetupSql())
  await copyReviewArticleServingRewriteBatches({projectId})
  await runMartRefreshBackgroundStatement(getReviewArticleServingRewritePurgeFinalizeSql())
  return runMartRefreshBackgroundStatement(getReviewArticleServingRewritePurgeIndexSql())
}

const deleteProjectTablePurgeRowIds = async ({
  rowIds,
  tableName,
}: {
  rowIds: Array<bigint | number | string>
  tableName: string
}): Promise<void> => {
  return rowIds.length === 0
    ? Promise.resolve()
    : runMartRefreshBackgroundStatement(getProjectTablePurgeDeleteSql({rowIds, tableName})).catch((error) => {
        return !isProjectPurgeDeleteRetryableError(error) || rowIds.length === 1
          ? Promise.reject(error)
          : deleteProjectTablePurgeRowIds({rowIds: getProjectPurgeDeleteRetryParts(rowIds)[0], tableName}).then(() => {
              return deleteProjectTablePurgeRowIds({rowIds: getProjectPurgeDeleteRetryParts(rowIds)[1], tableName})
            })
      })
}

const deleteProjectTablePurgeBatches = async ({
  projectId,
  tableName,
}: {
  projectId: string
  tableName: string
}): Promise<void> => {
  const batchRows = await getProjectTablePurgeBatchRows({projectId, tableName})
  const rowIds = batchRows.map((row) => {
    return row.rowId
  })

  return rowIds.length === 0
    ? Promise.resolve()
    : deleteProjectTablePurgeRowIds({rowIds, tableName})
        .then(() => {
          return yieldToEventLoop()
        })
        .then(() => {
          return deleteProjectTablePurgeBatches({projectId, tableName})
        })
}

const purgeArchivedProjectMartTable = async ({
  projectId,
  tableName,
}: {
  projectId: string
  tableName: string
}): Promise<void> => {
  return getArchivedProjectMartPurgeMode(tableName) === 'rewrite'
    ? rewriteReviewArticleServingForArchivedProject(projectId)
    : deleteProjectTablePurgeBatches({projectId, tableName})
}

export const archivedProjectMartTableNames = [
  'mart.review_article_serving_detail',
  'mart.review_article_filter_member',
  'mart.review_article_serving',
  'mart.review_article_rollup',
  'mart.prompt_answer_fact',
  'mart.project_scope_article',
]

const purgeArchivedProjectMartData = async (projectId: string): Promise<void> => {
  await archivedProjectMartTableNames.reduce<Promise<void>>((promise, tableName) => {
    return promise.then(() => {
      return purgeArchivedProjectMartTable({projectId, tableName})
    })
  }, Promise.resolve())
  await runMartRefreshBackgroundStatement(`
    BEGIN TRANSACTION;
    DELETE FROM app.review_answer_dictionary WHERE project_id = ${getSqlLiteral(projectId)};
    DELETE FROM app.project_review_serving_generation WHERE project_id = ${getSqlLiteral(projectId)};
    COMMIT;
  `)
}

const _getProjectArticleServingRefreshSql = (projectId: string, articleId: string) => {
  const projectLiteral = getSqlLiteral(projectId)
  const articleLiteral = getSqlLiteral(articleId)

  return `
    BEGIN TRANSACTION;
    INSERT INTO app.review_answer_dictionary (
      project_id,
      prompt_id,
      answer_id,
      answer_value,
      numeric_answer_value,
      dictionary_updated_at
    )
    WITH article_scope AS (
      SELECT
        aggregated_scope.project_id,
        aggregated_scope.article_id,
        aggregated_scope.in_curated_scope,
        aggregated_scope.in_route_scope,
        article.article_created_at,
        article.article_updated_at
      FROM (
        SELECT
          combined_scope.project_id,
          combined_scope.article_id,
          COALESCE(BOOL_OR(combined_scope.in_curated_scope), FALSE) AS in_curated_scope,
          COALESCE(BOOL_OR(combined_scope.in_route_scope), FALSE) AS in_route_scope
        FROM (
          SELECT
            pir.project_id,
            air.article_id,
            FALSE AS in_curated_scope,
            TRUE AS in_route_scope
          FROM app.project_import_route pir
          INNER JOIN app.article_import_route air ON air.import_route_id = pir.import_route_id
          WHERE pir.project_id = ${projectLiteral}
            AND air.article_id = ${articleLiteral}
          UNION ALL
          SELECT
            pa.project_id,
            pa.article_id,
            TRUE AS in_curated_scope,
            FALSE AS in_route_scope
          FROM app.project_article pa
          WHERE pa.project_id = ${projectLiteral}
            AND pa.article_id = ${articleLiteral}
        ) combined_scope
        GROUP BY combined_scope.project_id, combined_scope.article_id
      ) aggregated_scope
      INNER JOIN app.project project
        ON project.id = aggregated_scope.project_id
       AND project.archived = FALSE
      INNER JOIN app.article article ON article.id = aggregated_scope.article_id
    ),
    enabled_project_prompt AS (
      SELECT project_id, prompt_id, enabled
      FROM app.project_prompt
      WHERE enabled = TRUE
        AND project_id = ${projectLiteral}
    ),
    eligible_project_judgment AS (
      SELECT
        article_scope.project_id,
        judgment_fact.prompt_id,
        judgment_fact.normalized_answers
      FROM article_scope
      INNER JOIN app.project project ON project.id = article_scope.project_id
      INNER JOIN enabled_project_prompt enabled_prompt
        ON enabled_prompt.project_id = article_scope.project_id
      INNER JOIN mart.judgment_fact judgment_fact
        ON ${getProjectVisibleJudgmentScopeSql({
          judgmentAlias: 'judgment_fact',
          projectAlias: 'project',
          projectPromptAlias: 'enabled_prompt',
          projectScopeAlias: 'article_scope',
        })}
    ),
    answer_values AS (
      SELECT DISTINCT
        eligible_project_judgment.project_id,
        eligible_project_judgment.prompt_id,
        TRIM(answer.answer_value) AS answer_value
      FROM eligible_project_judgment,
        UNNEST(eligible_project_judgment.normalized_answers) AS answer(answer_value)
      WHERE eligible_project_judgment.normalized_answers IS NOT NULL
        AND ARRAY_LENGTH(eligible_project_judgment.normalized_answers) > 0
        AND NULLIF(TRIM(answer.answer_value), '') IS NOT NULL
    ),
    missing_answer_values AS (
      SELECT answer_values.project_id, answer_values.prompt_id, answer_values.answer_value
      FROM answer_values
      LEFT JOIN app.review_answer_dictionary dictionary
        ON dictionary.project_id = answer_values.project_id
       AND dictionary.prompt_id = answer_values.prompt_id
       AND dictionary.answer_value = answer_values.answer_value
      WHERE dictionary.answer_id IS NULL
    ),
    current_answer_id AS (
      SELECT
        project_id,
        prompt_id,
        COALESCE(MAX(answer_id), 0) AS max_answer_id
      FROM app.review_answer_dictionary
      WHERE project_id = ${projectLiteral}
      GROUP BY project_id, prompt_id
    )
    SELECT
      missing_answer_values.project_id,
      missing_answer_values.prompt_id,
      COALESCE(current_answer_id.max_answer_id, 0)
        + ROW_NUMBER() OVER (
          PARTITION BY missing_answer_values.project_id, missing_answer_values.prompt_id
          ORDER BY missing_answer_values.answer_value ASC
        ) AS answer_id,
      missing_answer_values.answer_value,
      TRY_CAST(missing_answer_values.answer_value AS BIGINT),
      current_timestamp
    FROM missing_answer_values
    LEFT JOIN current_answer_id
      ON current_answer_id.project_id = missing_answer_values.project_id
     AND current_answer_id.prompt_id = missing_answer_values.prompt_id;

    DELETE FROM mart.review_article_filter_member
    WHERE project_id = ${projectLiteral}
      AND article_id = ${articleLiteral}
      AND generation = (
        SELECT active_generation
        FROM app.project_review_serving_generation
        WHERE project_id = ${projectLiteral}
      );

    DELETE FROM mart.review_article_serving
    WHERE project_id = ${projectLiteral}
      AND article_id = ${articleLiteral}
      AND generation = (
        SELECT active_generation
        FROM app.project_review_serving_generation
        WHERE project_id = ${projectLiteral}
      );

    INSERT INTO mart.review_article_serving (
      project_id,
      generation,
      article_id,
      article_created_at,
      article_updated_at,
      article_title,
      article_external_id,
      journal_title,
      url,
      full_text_pdf,
      full_text_fetched_at,
      full_text_conversion_status,
      source_metadata,
      has_all_llm_judgments,
      llm_judged_prompt_count,
      llm_judged_prompt_ids,
      enabled_prompt_count,
      human_answered_prompt_count,
      human_answered_prompt_ids,
      has_all_human_answers,
      review_opened,
      review_sections_completed,
      latest_llm_created_at,
      latest_human_updated_at,
      latest_review_updated_at,
      serving_updated_at
    )
    WITH article_scope AS (
      SELECT
        aggregated_scope.project_id,
        aggregated_scope.article_id,
        aggregated_scope.in_curated_scope,
        aggregated_scope.in_route_scope,
        article.article_created_at,
        article.article_updated_at
      FROM (
        SELECT
          combined_scope.project_id,
          combined_scope.article_id,
          COALESCE(BOOL_OR(combined_scope.in_curated_scope), FALSE) AS in_curated_scope,
          COALESCE(BOOL_OR(combined_scope.in_route_scope), FALSE) AS in_route_scope
        FROM (
          SELECT
            pir.project_id,
            air.article_id,
            FALSE AS in_curated_scope,
            TRUE AS in_route_scope
          FROM app.project_import_route pir
          INNER JOIN app.article_import_route air ON air.import_route_id = pir.import_route_id
          WHERE pir.project_id = ${projectLiteral}
            AND air.article_id = ${articleLiteral}
          UNION ALL
          SELECT
            pa.project_id,
            pa.article_id,
            TRUE AS in_curated_scope,
            FALSE AS in_route_scope
          FROM app.project_article pa
          WHERE pa.project_id = ${projectLiteral}
            AND pa.article_id = ${articleLiteral}
        ) combined_scope
        GROUP BY combined_scope.project_id, combined_scope.article_id
      ) aggregated_scope
      INNER JOIN app.project project
        ON project.id = aggregated_scope.project_id
       AND project.archived = FALSE
      INNER JOIN app.article article ON article.id = aggregated_scope.article_id
    ),
    enabled_project_prompt AS (
      SELECT project_id, prompt_id, enabled
      FROM app.project_prompt
      WHERE enabled = TRUE
        AND project_id = ${projectLiteral}
    ),
    enabled_project_prompt_count AS (
      SELECT project_id, COUNT(*) AS enabled_prompt_count
      FROM enabled_project_prompt
      GROUP BY project_id
    ),
    llm_project_prompt AS (
      SELECT
        article_scope.project_id,
        judgment_fact.article_id,
        judgment_fact.prompt_id,
        MAX(judgment_fact.created_at) AS latest_llm_created_at
      FROM article_scope
      INNER JOIN app.project project ON project.id = article_scope.project_id
      INNER JOIN enabled_project_prompt enabled_prompt
        ON enabled_prompt.project_id = article_scope.project_id
      INNER JOIN mart.judgment_fact judgment_fact
        ON ${getProjectVisibleJudgmentScopeSql({
          judgmentAlias: 'judgment_fact',
          projectAlias: 'project',
          projectPromptAlias: 'enabled_prompt',
          projectScopeAlias: 'article_scope',
        })}
      GROUP BY article_scope.project_id, judgment_fact.article_id, judgment_fact.prompt_id
    ),
    llm_project_rollup AS (
      SELECT
        project_id,
        article_id,
        COUNT(DISTINCT prompt_id) AS llm_judged_prompt_count,
        LIST(DISTINCT prompt_id) AS llm_judged_prompt_ids,
        MAX(latest_llm_created_at) AS latest_llm_created_at
      FROM llm_project_prompt
      GROUP BY project_id, article_id
    ),
    prompt_mode_human_project_prompt AS (
      SELECT
        judgment_human.project_id,
        judgment_human.article_id,
        judgment_human.prompt_id,
        MAX(judgment_human.updated_at) AS latest_human_updated_at
      FROM app.judgment_human judgment_human
      INNER JOIN enabled_project_prompt enabled_prompt
        ON enabled_prompt.project_id = judgment_human.project_id
       AND enabled_prompt.prompt_id = judgment_human.prompt_id
      WHERE judgment_human.project_id = ${projectLiteral}
        AND judgment_human.article_id = ${articleLiteral}
        AND EXISTS (
          SELECT 1
          FROM app.project project
          WHERE project.id = judgment_human.project_id
            AND project.human_judgment_mode = 'prompt'
        )
        AND judgment_human.is_answered = TRUE
        AND NULLIF(TRIM(COALESCE(judgment_human.answer, '')), '') IS NOT NULL
      GROUP BY judgment_human.project_id, judgment_human.article_id, judgment_human.prompt_id
    ),
    prompt_mode_human_project_rollup AS (
      SELECT
        project_id,
        article_id,
        COUNT(DISTINCT prompt_id) AS human_answered_prompt_count,
        LIST(DISTINCT prompt_id) AS human_answered_prompt_ids,
        MAX(latest_human_updated_at) AS latest_human_updated_at
      FROM prompt_mode_human_project_prompt
      GROUP BY project_id, article_id
    ),
    summary_mode_human_project_rollup AS (
      SELECT
        judgment_human_summary.project_id,
        judgment_human_summary.article_id,
        1 AS human_answered_prompt_count,
        ['summary'] AS human_answered_prompt_ids,
        MAX(judgment_human_summary.updated_at) AS latest_human_updated_at
      FROM app.judgment_human_summary judgment_human_summary
      INNER JOIN app.project project
        ON project.id = judgment_human_summary.project_id
       AND project.human_judgment_mode = 'summary'
      WHERE judgment_human_summary.project_id = ${projectLiteral}
        AND judgment_human_summary.article_id = ${articleLiteral}
        AND NULLIF(TRIM(COALESCE(judgment_human_summary.answer, '')), '') IS NOT NULL
      GROUP BY judgment_human_summary.project_id, judgment_human_summary.article_id
    ),
    human_project_rollup AS (
      SELECT * FROM prompt_mode_human_project_rollup
      UNION ALL
      SELECT * FROM summary_mode_human_project_rollup
    ),
    review_state AS (
      SELECT
        review.project_id,
        review.article_id,
        MAX(review.updated_at) AS latest_review_updated_at,
        COALESCE(BOOL_OR(review.opened), FALSE) AS review_opened,
        MAX(
          CAST(review.reviewed_title AS INTEGER)
          + CAST(review.reviewed_abstract AS INTEGER)
          + CAST(review.reviewed_intro AS INTEGER)
          + CAST(review.reviewed_method AS INTEGER)
          + CAST(review.reviewed_results AS INTEGER)
          + CAST(review.reviewed_discussion AS INTEGER)
          + CAST(review.reviewed_conclusion AS INTEGER)
          + CAST(review.reviewed_appendix AS INTEGER)
          + CAST(review.reviewed_other AS INTEGER)
        ) AS review_sections_completed
      FROM app.review review
      WHERE review.project_id = ${projectLiteral}
        AND review.article_id = ${articleLiteral}
      GROUP BY project_id, article_id
    )
    SELECT
      article_scope.project_id,
      (
        SELECT active_generation
        FROM app.project_review_serving_generation
        WHERE project_id = ${projectLiteral}
      ) AS generation,
      article_scope.article_id,
      article_scope.article_created_at,
      article_scope.article_updated_at,
      article.article_title,
      article.article_id,
      json_extract_string(article.source_metadata, '$.journalTitle'),
      article.url,
      article.full_text_pdf,
      article.full_text_fetched_at,
      article.full_text_conversion_status,
      article.source_metadata,
      COALESCE(prompt_count.enabled_prompt_count, 0) > 0
        AND COALESCE(llm_rollup.llm_judged_prompt_count, 0) = COALESCE(prompt_count.enabled_prompt_count, 0),
      COALESCE(llm_rollup.llm_judged_prompt_count, 0),
      llm_rollup.llm_judged_prompt_ids,
      COALESCE(prompt_count.enabled_prompt_count, 0),
      COALESCE(human_rollup.human_answered_prompt_count, 0),
      human_rollup.human_answered_prompt_ids,
      CASE
        WHEN project.human_judgment_mode = 'summary' THEN COALESCE(human_rollup.human_answered_prompt_count, 0) > 0
        ELSE COALESCE(prompt_count.enabled_prompt_count, 0) > 0
          AND COALESCE(human_rollup.human_answered_prompt_count, 0) = COALESCE(prompt_count.enabled_prompt_count, 0)
      END,
      COALESCE(review_state.review_opened, FALSE),
      COALESCE(review_state.review_sections_completed, 0),
      llm_rollup.latest_llm_created_at,
      human_rollup.latest_human_updated_at,
      review_state.latest_review_updated_at,
      current_timestamp
    FROM article_scope
    INNER JOIN app.project project ON project.id = article_scope.project_id
    INNER JOIN app.article article ON article.id = article_scope.article_id
    LEFT JOIN enabled_project_prompt_count prompt_count ON prompt_count.project_id = article_scope.project_id
    LEFT JOIN llm_project_rollup llm_rollup
      ON llm_rollup.project_id = article_scope.project_id
     AND llm_rollup.article_id = article_scope.article_id
    LEFT JOIN human_project_rollup human_rollup
      ON human_rollup.project_id = article_scope.project_id
     AND human_rollup.article_id = article_scope.article_id
    LEFT JOIN review_state
      ON review_state.project_id = article_scope.project_id
     AND review_state.article_id = article_scope.article_id;

    INSERT INTO mart.review_article_filter_member (
      project_id,
      generation,
      prompt_id,
      answer_id,
      article_id,
      article_created_at,
      numeric_answer_value,
      member_updated_at
    )
    WITH article_scope AS (
      SELECT aggregated_scope.project_id, aggregated_scope.article_id, article.article_created_at
      FROM (
        SELECT combined_scope.project_id, combined_scope.article_id
        FROM (
          SELECT pir.project_id, air.article_id
          FROM app.project_import_route pir
          INNER JOIN app.article_import_route air ON air.import_route_id = pir.import_route_id
          WHERE pir.project_id = ${projectLiteral}
            AND air.article_id = ${articleLiteral}
          UNION ALL
          SELECT pa.project_id, pa.article_id
          FROM app.project_article pa
          WHERE pa.project_id = ${projectLiteral}
            AND pa.article_id = ${articleLiteral}
        ) combined_scope
        GROUP BY combined_scope.project_id, combined_scope.article_id
      ) aggregated_scope
      INNER JOIN app.project project
        ON project.id = aggregated_scope.project_id
       AND project.archived = FALSE
      INNER JOIN app.article article ON article.id = aggregated_scope.article_id
    ),
    enabled_project_prompt AS (
      SELECT project_id, prompt_id, enabled
      FROM app.project_prompt
      WHERE enabled = TRUE
        AND project_id = ${projectLiteral}
    ),
    eligible_project_judgment AS (
      SELECT
        article_scope.project_id,
        article_scope.article_id,
        article_scope.article_created_at,
        judgment_fact.prompt_id,
        judgment_fact.normalized_answers
      FROM article_scope
      INNER JOIN app.project project ON project.id = article_scope.project_id
      INNER JOIN enabled_project_prompt enabled_prompt
        ON enabled_prompt.project_id = article_scope.project_id
      INNER JOIN mart.judgment_fact judgment_fact
        ON ${getProjectVisibleJudgmentScopeSql({
          judgmentAlias: 'judgment_fact',
          projectAlias: 'project',
          projectPromptAlias: 'enabled_prompt',
          projectScopeAlias: 'article_scope',
        })}
    )
    SELECT DISTINCT
      eligible_project_judgment.project_id,
      (
        SELECT active_generation
        FROM app.project_review_serving_generation
        WHERE project_id = ${projectLiteral}
      ) AS generation,
      eligible_project_judgment.prompt_id,
      dictionary.answer_id,
      eligible_project_judgment.article_id,
      eligible_project_judgment.article_created_at,
      dictionary.numeric_answer_value,
      current_timestamp
    FROM eligible_project_judgment,
      UNNEST(eligible_project_judgment.normalized_answers) AS answer(answer_value)
    INNER JOIN app.review_answer_dictionary dictionary
      ON dictionary.project_id = eligible_project_judgment.project_id
     AND dictionary.prompt_id = eligible_project_judgment.prompt_id
     AND dictionary.answer_value = TRIM(answer.answer_value)
    WHERE eligible_project_judgment.normalized_answers IS NOT NULL
      AND ARRAY_LENGTH(eligible_project_judgment.normalized_answers) > 0
      AND NULLIF(TRIM(answer.answer_value), '') IS NOT NULL;

    DELETE FROM mart.review_article_serving_detail
    WHERE project_id = ${projectLiteral}
      AND article_id = ${articleLiteral}
      AND generation = (
        SELECT active_generation
        FROM app.project_review_serving_generation
        WHERE project_id = ${projectLiteral}
      );

    INSERT INTO mart.review_article_serving_detail (
      project_id,
      generation,
      article_id,
      prompt_id,
      prompt_order,
      judgment_id,
      created_at,
      article_created_at,
      article_updated_at,
      model_id,
      answered_original,
      answered_original_as_array,
      detail_updated_at
    )
    WITH article_scope AS (
      SELECT aggregated_scope.project_id, aggregated_scope.article_id, article.article_created_at, article.article_updated_at
      FROM (
        SELECT combined_scope.project_id, combined_scope.article_id
        FROM (
          SELECT pir.project_id, air.article_id
          FROM app.project_import_route pir
          INNER JOIN app.article_import_route air ON air.import_route_id = pir.import_route_id
          WHERE pir.project_id = ${projectLiteral}
            AND air.article_id = ${articleLiteral}
          UNION ALL
          SELECT pa.project_id, pa.article_id
          FROM app.project_article pa
          WHERE pa.project_id = ${projectLiteral}
            AND pa.article_id = ${articleLiteral}
        ) combined_scope
        GROUP BY combined_scope.project_id, combined_scope.article_id
      ) aggregated_scope
      INNER JOIN app.project project
        ON project.id = aggregated_scope.project_id
       AND project.archived = FALSE
      INNER JOIN app.article article ON article.id = aggregated_scope.article_id
    )
    SELECT
      article_scope.project_id,
      (
        SELECT active_generation
        FROM app.project_review_serving_generation
        WHERE project_id = ${projectLiteral}
      ) AS generation,
      judgment_fact.article_id,
      judgment_fact.prompt_id,
      project_prompt.prompt_order,
      judgment_fact.judgment_id,
      judgment_fact.created_at,
      judgment_fact.article_created_at,
      judgment_fact.article_updated_at,
      judgment_fact.model_id,
      judgment_fact.answered_original,
      judgment_fact.answered_original_as_array,
      current_timestamp
    FROM article_scope
    INNER JOIN app.project project ON project.id = article_scope.project_id
    INNER JOIN app.project_prompt project_prompt
      ON project_prompt.project_id = article_scope.project_id
     AND project_prompt.enabled = TRUE
    INNER JOIN mart.judgment_fact judgment_fact
     ON ${getProjectVisibleJudgmentScopeSql({
       judgmentAlias: 'judgment_fact',
       projectAlias: 'project',
       projectPromptAlias: 'project_prompt',
       projectScopeAlias: 'article_scope',
     })};
    COMMIT;
  `
}

const refreshProjectPromptAnswerFactForArticles = async (projectId: string, articleIds: string[]): Promise<void> => {
  const refreshArticleIds = getUniqueValues(articleIds)

  return refreshArticleIds.length === 0
    ? Promise.resolve()
    : runMartRefreshBackgroundStatement(getProjectPromptAnswerFactBatchRefreshSql(projectId, refreshArticleIds)).then(
        () => {
          return yieldToEventLoop()
        },
      )
}

const refreshProjectReviewAnswerDictionaryForArticles = async (
  projectId: string,
  articleIds: string[],
): Promise<void> => {
  const refreshArticleIds = getUniqueValues(articleIds)

  return refreshArticleIds.length === 0
    ? Promise.resolve()
    : runMartRefreshBackgroundStatement(
        getProjectReviewAnswerDictionaryMissingBatchInsertSql(projectId, refreshArticleIds),
      ).then(() => {
        return yieldToEventLoop()
      })
}

const refreshProjectReviewArticleRollupForArticles = async (projectId: string, articleIds: string[]): Promise<void> => {
  const refreshArticleIds = getUniqueValues(articleIds)

  return refreshArticleIds.length === 0
    ? Promise.resolve()
    : runMartRefreshBackgroundStatement(getProjectReviewArticleRollupBatchInsertSql(projectId, refreshArticleIds)).then(
        () => {
          return yieldToEventLoop()
        },
      )
}

const refreshProjectActiveServingForArticles = async (projectId: string, articleIds: string[]): Promise<void> => {
  const refreshArticleIds = getUniqueValues(articleIds)

  return refreshArticleIds.length === 0
    ? Promise.resolve()
    : runMartRefreshBackgroundStatement(
        getProjectReviewActiveServingBatchRefreshSql(projectId, refreshArticleIds),
      ).then(() => {
        return yieldToEventLoop()
      })
}

const refreshProjectArticleMartsBatch = async (projectId: string, articleIds: string[]): Promise<void> => {
  const refreshArticleIds = getUniqueValues(articleIds)

  if (refreshArticleIds.length === 0) {
    return
  }

  if (!(await getHasActiveProjectReviewServingGeneration(projectId))) {
    await queueProjectLargeRebuildForDirtyArticles(
      projectId,
      refreshArticleIds,
      'missingActiveProjectReviewServingGeneration',
    )
    return
  }

  await refreshProjectPromptAnswerFactForArticles(projectId, refreshArticleIds)
  await refreshProjectReviewAnswerDictionaryForArticles(projectId, refreshArticleIds)
  await refreshProjectReviewArticleRollupForArticles(projectId, refreshArticleIds)
  return refreshProjectActiveServingForArticles(projectId, refreshArticleIds)
}

const refreshProjectArticleServingForArticles = async (projectId: string, articleIds: string[]): Promise<void> => {
  return refreshProjectArticleMartsBatch(projectId, articleIds)
}

const refreshProjectArticleServing = async (projectId: string, articleId: string): Promise<void> => {
  return refreshProjectArticleMartsBatch(projectId, [articleId])
}

const refreshProjectsForArticle = async (projectIds: string[], articleId: string): Promise<void> => {
  const [currentProjectId = ''] = projectIds

  if (!currentProjectId) {
    return
  }

  await refreshProjectScopeArticles(currentProjectId, [articleId])
  await refreshProjectArticleServing(currentProjectId, articleId)
  return refreshProjectsForArticle(projectIds.slice(1), articleId)
}

const refreshQueuedArticleTasks = async (articleIds: string[]): Promise<void> => {
  const [currentArticleId = ''] = articleIds

  if (!currentArticleId) {
    return
  }

  await refreshJudgmentArticle(currentArticleId)
  await refreshProjectsForArticle(await getImpactedProjectIdsForArticle(currentArticleId), currentArticleId)
  setProcessingArticleRefreshes(articleIds.slice(1))
  return refreshQueuedArticleTasks(articleIds.slice(1))
}

const refreshProject = async (projectId: string) => {
  await ensureReviewArticleRollupTable()

  if (await getProjectIsArchived(projectId)) {
    await purgeArchivedProjectMartData(projectId)
    return recordProjectRefreshCompletion()
  }

  await rebuildProjectScope(projectId)
  await refreshJudgmentFactsForProjectScope(projectId)
  await rebuildProjectPromptAnswerFact(projectId)
  await runMartRefreshBackgroundStatement(getProjectReviewAnswerDictionaryRebuildSql(projectId))
  await rebuildProjectReviewArticleRollup(projectId)
  await rebuildProjectReviewServing(projectId)
  return recordProjectRefreshCompletion()
}

const refreshJudgmentArticle = async (articleId: string) => {
  await runMartRefreshBackgroundStatement(getJudgmentArticleRefreshSql(articleId))
  await yieldToEventLoop()
  recordArticleRefreshCompletion()
}

const refreshJudgmentFactsForProjectClaim = async ({
  claimedToken,
  lastCompletedToken,
  projectId,
}: {
  claimedToken: number
  lastCompletedToken: number
  projectId: string
}) => {
  await runMartRefreshBackgroundStatement(
    getJudgmentProjectClaimRefreshSql({claimedToken, lastCompletedToken, projectId}),
  )
  await yieldToEventLoop()
  recordArticleRefreshCompletion()
}

const refreshJudgmentFactsForArticles = async (articleIds: string[]): Promise<void> => {
  const refreshArticleIds = getUniqueValues(articleIds)

  if (refreshArticleIds.length === 0) {
    return
  }

  await runMartRefreshBackgroundStatement(
    getJudgmentFactSafeRefreshSql({
      dirtyArticlesSql: `
        SELECT requested_article.article_id
        FROM (VALUES ${getProjectRefreshArticleIdRowsSql(refreshArticleIds)}) AS requested_article(article_id)
      `,
    }),
  )
  await yieldToEventLoop()
  recordArticleRefreshCompletion()
}

const processQueuedMartRefreshPass = async (): Promise<boolean> => {
  updateMartRefreshDebugSnapshot({
    lastPassStartedAt: new Date().toISOString(),
    passCount: martRefreshDebugSnapshot.passCount + 1,
  })
  const queuedArticleTasks = await getQueuedArticleTasks()
  updateMartRefreshDebugSnapshot({lastQueuedTaskCount: queuedArticleTasks.length})

  if (queuedArticleTasks.length === 0) {
    updateMartRefreshDebugSnapshot({lastHasMoreQueuedTasks: false, lastPassCompletedAt: new Date().toISOString()})
    return false
  }

  const claimedQueuedArticleIds = getUniqueValues(
    queuedArticleTasks.map((task) => {
      return task.articleId
    }),
  )

  setClaimedQueuedRefreshes(claimedQueuedArticleIds, [])
  await claimQueuedMaintenanceWorkTasks(queuedArticleTasks)

  try {
    await refreshQueuedArticleTasks(claimedQueuedArticleIds)
    await completeQueuedTasks(queuedArticleTasks)

    const hasMoreQueuedTasks = await getHasQueuedDrainableTasks()

    updateMartRefreshDebugSnapshot({
      lastHasMoreQueuedTasks: hasMoreQueuedTasks,
      lastPassCompletedAt: new Date().toISOString(),
    })
    return hasMoreQueuedTasks
  } catch (error) {
    await failQueuedMaintenanceWorkTasks(queuedArticleTasks, error)
    updateMartRefreshDebugSnapshot({
      lastErrorAt: new Date().toISOString(),
      lastErrorMessage: error instanceof Error ? error.message : String(error),
    })
    throw error
  } finally {
    resetMartRefreshProgressSnapshot()
  }
}

const yieldToEventLoop = async (): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve, martRefreshYieldDelayMs)
  })
}

const continueQueuedMartRefreshesAfterYield = async (): Promise<void> => {
  await yieldToEventLoop()
  return processQueuedMartRefreshesWithinBudget(Date.now() + martRefreshDrainBudgetMs)
}

const processQueuedMartRefreshesWithinBudget = async (deadlineMs: number): Promise<void> => {
  const hasMoreQueuedTasks = await processQueuedMartRefreshPass()

  if (!hasMoreQueuedTasks) {
    return
  }

  return Date.now() >= deadlineMs
    ? continueQueuedMartRefreshesAfterYield()
    : processQueuedMartRefreshesWithinBudget(deadlineMs)
}

const _processQueuedMartRefreshes = async (): Promise<void> => {
  return processQueuedMartRefreshesWithinBudget(Date.now() + martRefreshDrainBudgetMs)
}

const _scheduleQueuedMartRefreshes = (delayMs = martRefreshScheduleDelayMs) => {
  if (martRefreshDrainTimer || martRefreshDrainPromise) {
    return
  }

  martRefreshDrainTimer = setTimeout(() => {
    martRefreshDrainTimer = null
    void flushQueuedMartRefreshes().catch((error) => {
      console.error('[duckdbMartRefresh] failed to process refresh queue', error)
      _scheduleQueuedMartRefreshes(martRefreshRetryDelayMs)
    })
  }, delayMs)
  updateMartRefreshDebugSnapshot({drainTimerActive: true})
}

const getMartRefreshTaskKeys = (task: QueueMartRefreshTask) => {
  return {articleKey: task.articleId ?? '', projectKey: ''}
}

const getQueueMartRefreshTaskValueSql = (task: QueueMartRefreshTask) => {
  const {articleKey, projectKey} = getMartRefreshTaskKeys(task)

  return `(
    ${getSqlLiteral(globalThis.crypto.randomUUID())},
    ${getSqlLiteral(task.refreshScope)},
    ${getSqlLiteral(task.projectId ?? null)},
    ${getSqlLiteral(task.articleId ?? null)},
    ${getSqlLiteral(projectKey)},
    ${getSqlLiteral(articleKey)},
    0,
    ${getSqlLiteral(task.reason)}
  )`
}

const queueMartRefreshTasks = async (tasks: QueueMartRefreshTask[]) => {
  if (tasks.length === 0) {
    return
  }

  await ensureMartRefreshQueueSchema()
  await getAppDatabaseService().run(`
    INSERT INTO app.mart_refresh_queue (
      id,
      refresh_scope,
      project_id,
      article_id,
      project_key,
      article_key,
      refresh_generation,
      reason
    )
    VALUES ${tasks
      .map((task) => {
        return getQueueMartRefreshTaskValueSql(task)
      })
      .join(',\n')}
    ON CONFLICT (refresh_scope, project_key, article_key) DO UPDATE SET
      project_id = EXCLUDED.project_id,
      article_id = EXCLUDED.article_id,
      reason = EXCLUDED.reason,
      completed_at = NULL,
      refresh_generation = COALESCE(refresh_generation, 0) + 1,
      updated_at = NOW()
  `)

  if (isMartRefreshAutoDrainEnabled()) {
    _scheduleQueuedMartRefreshes()
  }
}

export const flushQueuedMartRefreshes = async (): Promise<void> => {
  if (martRefreshDrainTimer) {
    clearTimeout(martRefreshDrainTimer)
    martRefreshDrainTimer = null
  }

  if (martRefreshDrainPromise) {
    return martRefreshDrainPromise
  }

  updateMartRefreshDebugSnapshot({
    drainPromiseActive: true,
    drainTimerActive: false,
    flushInvocationCount: martRefreshDebugSnapshot.flushInvocationCount + 1,
    lastFlushAt: new Date().toISOString(),
  })

  martRefreshDrainPromise = _processQueuedMartRefreshes().finally(() => {
    martRefreshDrainPromise = null
    updateMartRefreshDebugSnapshot({drainPromiseActive: false, drainTimerActive: martRefreshDrainTimer !== null})
  })

  return martRefreshDrainPromise
}

const recoverQueuedArchivedProjectRefresh = async (projectId: string) => {
  if (!(await getProjectIsArchived(projectId))) {
    throw new Error(`Queued archived-project recovery requires an archived project: ${projectId}`)
  }

  const workerId = getMartRefreshQueueWorkerId()

  await getMaintenanceWorkLeaseService().claimMaintenanceWorkLease({
    consumerId: workerId,
    leaseMs: martRefreshQueueLeaseMs,
    projectId,
    recoveryMode: 'archived_project_mart_recovery',
    requiredConsumerRole: 'maintenance-worker',
    scopeKind: 'project',
    workKind: 'review_index_archived_project_recovery',
  })

  setMartRefreshProgressSnapshot({
    claimedQueuedArticleIds: [],
    claimedQueuedProjectIds: [projectId],
    processingArticleIds: [],
    processingProjectIds: [projectId],
  })

  try {
    await purgeArchivedProjectMartData(projectId)
    await getMaintenanceWorkLeaseService().completeMaintenanceWorkLease({
      consumerId: workerId,
      projectId,
      scopeKind: 'project',
      workKind: 'review_index_archived_project_recovery',
    })
    return {completedTaskCount: 1, projectId}
  } catch (error) {
    await getMaintenanceWorkLeaseService().failMaintenanceWorkLease({
      consumerId: workerId,
      leaseMs: martRefreshQueueLeaseMs,
      projectId,
      recoveryContext: {error: error instanceof Error ? error.message : String(error)},
      recoveryMode: 'archived_project_mart_recovery',
      requiredConsumerRole: 'maintenance-worker',
      scopeKind: 'project',
      workKind: 'review_index_archived_project_recovery',
    })
    throw error
  } finally {
    resetMartRefreshProgressSnapshot()
  }
}

const queueProjectRefreshes = async (projectIds: string[], reason: string) => {
  return queueProjectLargeRebuilds(projectIds, reason)
}

const queueJudgmentArticleRefreshes = async (articleIds: string[], reason: string) => {
  return queueMartRefreshTasks(
    getUniqueValues(articleIds).map((articleId) => {
      return {articleId, reason, refreshScope: 'judgment_article' as const}
    }),
  )
}

const queueProjectRefreshesByImportRouteIds = async (importRouteIds: string[], reason: string) => {
  if (importRouteIds.length === 0) {
    return
  }

  const rows = await getAppDatabaseService().queryJson<{projectId: string}>(`
    SELECT DISTINCT project_id AS projectId
    FROM app.project_import_route project_import_route
    INNER JOIN app.project project ON project.id = project_import_route.project_id
    WHERE import_route_id IN (${getQuotedStringList(getUniqueValues(importRouteIds)).join(', ')})
      AND project.archived = FALSE
  `)

  return markProjectRefreshesDirty(
    rows.map((row) => {
      return row.projectId
    }),
    reason,
  )
}

const queueProjectRefreshesByPromptIds = async (promptIds: string[], reason: string) => {
  if (promptIds.length === 0) {
    return
  }

  const rows = await getAppDatabaseService().queryJson<{projectId: string}>(`
    SELECT DISTINCT project_id AS projectId
    FROM app.project_prompt project_prompt
    INNER JOIN app.project project ON project.id = project_prompt.project_id
    WHERE prompt_id IN (${getQuotedStringList(getUniqueValues(promptIds)).join(', ')})
      AND project.archived = FALSE
  `)

  return markProjectRefreshesDirty(
    rows.map((row) => {
      return row.projectId
    }),
    reason,
  )
}

const queueJudgmentArticleRefreshesByJudgmentIds = async (judgmentIds: string[], reason: string) => {
  if (judgmentIds.length === 0) {
    return
  }

  const rows = await getAppDatabaseService().queryJson<{articleId: string}>(`
    SELECT DISTINCT article_id AS articleId
    FROM app.judgment
    WHERE id IN (${getQuotedStringList(getUniqueValues(judgmentIds)).join(', ')})
  `)

  return queueJudgmentArticleRefreshes(
    rows.map((row) => {
      return row.articleId
    }),
    reason,
  )
}

const queueJudgmentArticleRefreshesByPromptIds = async (promptIds: string[], reason: string) => {
  if (promptIds.length === 0) {
    return
  }

  const rows = await getAppDatabaseService().queryJson<{articleId: string}>(`
    SELECT DISTINCT article_id AS articleId
    FROM app.judgment
    WHERE prompt_id IN (${getQuotedStringList(getUniqueValues(promptIds)).join(', ')})
  `)

  return queueJudgmentArticleRefreshes(
    rows.map((row) => {
      return row.articleId
    }),
    reason,
  )
}

const duckdbMartRefreshService = {
  ensureQueueSchema: ensureMartRefreshQueueSchema,
  flush: flushQueuedMartRefreshes,
  getQueuedArticleTasksSqlForTests: getQueuedArticleTasksSql,
  isAutoDrainEnabled: isMartRefreshAutoDrainEnabled,
  getDebugSnapshot: getMartRefreshDebugSnapshot,
  getProgressSnapshot: getMartRefreshProgressSnapshot,
  getThroughputSnapshot: getMartRefreshThroughputSnapshot,
  hasActiveProjectReviewServingGeneration: getHasActiveProjectReviewServingGeneration,
  queueJudgmentArticleRefresh: async (articleId: string, reason: string) => {
    await queueJudgmentArticleRefreshes([articleId], reason)
  },
  queueJudgmentArticleRefreshes,
  queueJudgmentArticleRefreshesByJudgmentIds,
  queueJudgmentArticleRefreshesByPromptIds,
  queueProjectRefresh: async (projectId: string, reason: string) => {
    await queueProjectRefreshes([projectId], reason)
  },
  queueProjectRefreshes,
  queueProjectRefreshesByImportRouteIds,
  queueProjectRefreshesByPromptIds,
  queueProjectLargeRebuild: async (projectId: string, reason: string) => {
    await queueProjectLargeRebuilds([projectId], reason)
  },
  queueProjectLargeRebuilds,
  purgeArchivedProjectMartData,
  recoverQueuedArchivedProjectRefresh,
  refreshJudgmentArticle,
  refreshJudgmentFactsForArticles,
  refreshJudgmentFactsForProjectClaim,
  refreshProject,
  refreshProjectScopeArticles,
  refreshProjectArticleMartsBatch,
  refreshProjectArticleServing,
  refreshProjectArticleServingForArticles,
  resetProgressSnapshotForTests: () => {
    martRefreshQueueCompletedAtColumnReady = null
    martRefreshQueueCompletedAtColumnVerified = false
    martRefreshQueueGenerationColumnReady = null
    martRefreshQueueGenerationColumnVerified = false
    martRefreshReviewArticleRollupReady = null
    martRefreshReviewArticleRollupVerified = false
    resetMartRefreshDebugSnapshot()
    setMartRefreshAutoDrainEnabled(true)
    resetMartRefreshProgressSnapshot()
    resetMartRefreshThroughputSnapshot()
  },
  setAutoDrainEnabledForTests: setMartRefreshAutoDrainEnabled,
  setProgressSnapshotForTests: setMartRefreshProgressSnapshot,
}

export const getDuckdbMartRefreshService = () => {
  return duckdbMartRefreshService
}
