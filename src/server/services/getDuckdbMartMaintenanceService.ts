import {getAppDatabaseService} from './appDatabaseService.ts'
import {getSqlLiteral} from './appQueryHelpers.ts'
import {
  getProjectMartDirtyRefreshStateService,
  type MarkedProjectDirtyState,
} from './projectMartDirtyRefreshStateService.ts'
import {getProjectMartLargeRebuildStateService} from './projectMartLargeRebuildStateService.ts'
import {getProjectVisibleJudgmentScopeSql} from './projectVisibleJudgmentRule.ts'
import {
  getScopedArticleCombinedMetadataExpression,
  getScopedArticleExternalIdExpression,
  getScopedArticleImportJoinSql,
  getScopedArticleImportSelectionCteSql,
} from './scopedArticleReadAdapter.ts'

type ProjectRefreshBatchCursor = {articleCreatedAt: Date | string | null; articleId: string}

type ProjectRefreshBatchRow = {articleCreatedAt: Date | string | null; articleId: string}

type ProjectCleanupBatchRow = {rowId: bigint | number | string}

type ArchivedProjectMartCleanupMode = 'delete_batches' | 'rewrite'

type ArchivedProjectMartCleanupBatchResult = {
  deletedRowCount: number
  projectId: string | null
  tableName: string | null
}

type ArchivedProjectMartCleanupCandidateRow = {projectId: string; tableName: string}

type ReviewArticleServingRewriteBatchCursor = {rowId: bigint | number | string}

type ProjectRefreshScopeBatchRow = ProjectRefreshBatchRow & {
  articleUpdatedAt: Date | string | null
  inCuratedScope: boolean
  inRouteScope: boolean
}

let martRefreshReviewArticleRollupReady: Promise<void> | null = null
let martRefreshReviewArticleRollupVerified = false
let martRefreshArticleCompletionTimes: number[] = []
let martRefreshProjectCompletionTimes: number[] = []

const martRefreshProjectCleanupRowBatchSize = 10
const martRefreshProjectRebuildArticleBatchSize = 20_000
const martRefreshArticleBatchInsertChunkSize = 256
const martReviewArticleServingRewriteBatchSize = 1_000
const martRefreshThroughputWindowMs = 15_000
const martRefreshYieldDelayMs = 0
const martRefreshBatchEpochSql = "TIMESTAMPTZ '1970-01-01T00:00:00.000Z'"
const martRefreshProjectCleanupRetryableErrorFragment = 'Failed to delete all rows from index'
const martPromptAnswerFactLookupIndexName = 'idx_mart_prompt_answer_fact_lookup'
const martPromptAnswerFactLookupIndexQualifiedName = `mart.${martPromptAnswerFactLookupIndexName}`
const martPromptAnswerFactResetReplacementTableName = 'mart.prompt_answer_fact_project_refresh_rewrite'
const martReviewArticleServingCleanupReplacementTableName = 'mart.review_article_serving_project_cleanup_rewrite'
const martReviewArticleServingOrderIndexName = 'idx_mart_review_article_serving_order'
const martReviewArticleServingScopedImportCteName = 'selected_review_article_serving_import'
const martRefreshArticleBatchTableName = 'temp_project_mart_refresh_article_batch'
const martRefreshJudgmentFactArticleBatchTableName = 'temp_dirty_judgment_fact_article'
const martRefreshFatalInvalidationErrorFragments = [
  'database has been invalidated because of a previous fatal error',
  'must be restarted prior to being used again',
]

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

const getValueChunks = <T>(values: T[], chunkSize: number): T[][] => {
  return values.length === 0 ? [] : [values.slice(0, chunkSize), ...getValueChunks(values.slice(chunkSize), chunkSize)]
}

const getProjectRefreshArticleBatchSelectSql = (articleIds: string[]) => {
  return articleIds
    .map((articleId) => {
      return `SELECT ${getSqlLiteral(articleId)} AS article_id`
    })
    .join('\nUNION ALL\n')
}

const getProjectRefreshArticleBatchInsertSql = (articleIds: string[]) => {
  return articleIds.length === 0
    ? ''
    : `
    INSERT INTO ${martRefreshArticleBatchTableName} (article_id)
    SELECT article_id
    FROM (
      ${getProjectRefreshArticleBatchSelectSql(articleIds)}
    ) AS article_batch
    WHERE article_id IS NOT NULL
    ON CONFLICT DO NOTHING;
  `
}

const getProjectRefreshArticleBatchSetupSql = (articleIds: string[]) => {
  const insertSql = getValueChunks(articleIds, martRefreshArticleBatchInsertChunkSize)
    .map((chunk) => {
      return getProjectRefreshArticleBatchInsertSql(chunk)
    })
    .join('\n')

  return `
    DROP TABLE IF EXISTS ${martRefreshArticleBatchTableName};
    CREATE TEMP TABLE ${martRefreshArticleBatchTableName} (article_id VARCHAR PRIMARY KEY);
    ${insertSql}
  `
}

const getProjectRefreshArticleBatchCleanupSql = () => {
  return `
    DROP TABLE IF EXISTS ${martRefreshArticleBatchTableName};
  `
}

const getProjectRefreshArticleBatchExistsSql = (articleIdColumn: string) => {
  return `EXISTS (
        SELECT 1
        FROM ${martRefreshArticleBatchTableName} refresh_article_batch
        WHERE refresh_article_batch.article_id = ${articleIdColumn}
      )`
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
  return `
    BEGIN TRANSACTION;
    ${getProjectRefreshArticleBatchSetupSql(articleIds)}
    ${getProjectScopeArticleBatchRefreshBodySql(projectId)}
    ${getProjectRefreshArticleBatchCleanupSql()}
    COMMIT;
  `
}

const getProjectScopeArticleBatchRefreshBodySql = (projectId: string) => {
  const projectLiteral = getSqlLiteral(projectId)

  return `
    DELETE FROM mart.project_scope_article
    WHERE project_id = ${projectLiteral}
      AND ${getProjectRefreshArticleBatchExistsSql('mart.project_scope_article.article_id')};
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
      INNER JOIN ${martRefreshArticleBatchTableName} requested_article
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
      INNER JOIN ${martRefreshArticleBatchTableName} requested_article
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

const getArchivedProjectMartCleanupMode = (_tableName: string): ArchivedProjectMartCleanupMode => {
  return 'delete_batches'
}

const getProjectTableCleanupBatchSql = ({projectId, tableName}: {projectId: string; tableName: string}) => {
  const projectLiteral = getSqlLiteral(projectId)

  return `
    SELECT
      rowid AS rowId
    FROM ${tableName}
    WHERE project_id = ${projectLiteral}
    ORDER BY rowid ASC
    LIMIT ${martRefreshProjectCleanupRowBatchSize}
  `
}

const getProjectTableCleanupDeleteSql = ({
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

const getReviewArticleServingRewriteCleanupSetupSql = () => {
  return `
    BEGIN TRANSACTION;
    DROP TABLE IF EXISTS ${martReviewArticleServingCleanupReplacementTableName};
    CREATE TABLE ${martReviewArticleServingCleanupReplacementTableName} (
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
    INSERT INTO ${martReviewArticleServingCleanupReplacementTableName}
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

const getReviewArticleServingRewriteCleanupFinalizeSql = () => {
  return `
    BEGIN TRANSACTION;
    DROP TABLE mart.review_article_serving;
    ALTER TABLE ${martReviewArticleServingCleanupReplacementTableName} RENAME TO review_article_serving;
    COMMIT;
  `
}

const getReviewArticleServingRewriteCleanupIndexSql = () => {
  return `
    BEGIN TRANSACTION;
    CREATE INDEX IF NOT EXISTS ${martReviewArticleServingOrderIndexName}
    ON mart.review_article_serving(project_id, generation, has_all_llm_judgments, article_created_at, article_id);
    COMMIT;
  `
}

const getProjectCleanupDeleteRetryParts = (rowIds: Array<bigint | number | string>) => {
  const middleIndex = Math.ceil(rowIds.length / 2)

  return [rowIds.slice(0, middleIndex), rowIds.slice(middleIndex)] as const
}

const isProjectCleanupDeleteRetryableError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)

  return (
    message.includes(martRefreshProjectCleanupRetryableErrorFragment) && !isMartRefreshFatalInvalidationError(error)
  )
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
    COMMIT;
  `
}

const getProjectPromptAnswerFactLookupIndexCreateSql = () => {
  return `
    CREATE INDEX IF NOT EXISTS ${martPromptAnswerFactLookupIndexName}
    ON mart.prompt_answer_fact(project_id, prompt_id, answer_value, article_id);
  `
}

const getProjectPromptAnswerFactBatchInsertBodySql = (projectId: string) => {
  const projectLiteral = getSqlLiteral(projectId)

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
        AND ${getProjectRefreshArticleBatchExistsSql('scope_article.article_id')}
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
    ${getProjectRefreshArticleBatchSetupSql(articleIds)}
    ${getProjectPromptAnswerFactBatchInsertBodySql(projectId)}
    ${getProjectRefreshArticleBatchCleanupSql()}
    COMMIT;
  `
}

const getProjectPromptAnswerFactBatchRefreshSql = (projectId: string, articleIds: string[]) => {
  return `
    BEGIN TRANSACTION;
    ${getProjectRefreshArticleBatchSetupSql(articleIds)}
    ${getProjectPromptAnswerFactBatchRefreshBodySql(projectId)}
    ${getProjectRefreshArticleBatchCleanupSql()}
    COMMIT;
  `
}

const getProjectPromptAnswerFactBatchRefreshBodySql = (
  projectId: string,
  options: {rebuildLookupIndex?: boolean} = {},
) => {
  const projectLiteral = getSqlLiteral(projectId)
  const rebuildLookupIndex = options.rebuildLookupIndex ?? true

  return `
    ${rebuildLookupIndex ? `DROP INDEX IF EXISTS ${martPromptAnswerFactLookupIndexQualifiedName};` : ''}
    DELETE FROM mart.prompt_answer_fact
    WHERE project_id = ${projectLiteral}
      AND ${getProjectRefreshArticleBatchExistsSql('mart.prompt_answer_fact.article_id')};
    ${getProjectPromptAnswerFactBatchInsertBodySql(projectId)}
  `
}

const getProjectReviewAnswerDictionaryRebuildSql = (projectId: string) => {
  const projectLiteral = getSqlLiteral(projectId)

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

const getProjectReviewAnswerDictionaryMissingBatchInsertSql = (projectId: string, articleIds: string[]) => {
  return `
    BEGIN TRANSACTION;
    ${getProjectRefreshArticleBatchSetupSql(articleIds)}
    ${getProjectReviewAnswerDictionaryMissingBatchInsertBodySql(projectId)}
    ${getProjectRefreshArticleBatchCleanupSql()}
    COMMIT;
  `
}

const getProjectReviewAnswerDictionaryMissingBatchInsertBodySql = (projectId: string) => {
  const projectLiteral = getSqlLiteral(projectId)

  return `
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
        AND ${getProjectRefreshArticleBatchExistsSql('mart.prompt_answer_fact.article_id')}
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
  return `
    BEGIN TRANSACTION;
    ${getProjectRefreshArticleBatchSetupSql(articleIds)}
    ${getProjectReviewArticleRollupBatchInsertBodySql(projectId)}
    ${getProjectRefreshArticleBatchCleanupSql()}
    COMMIT;
  `
}

const getProjectReviewArticleRollupBatchInsertBodySql = (projectId: string) => {
  const projectLiteral = getSqlLiteral(projectId)

  return `
    DELETE FROM mart.review_article_rollup
    WHERE project_id = ${projectLiteral}
      AND ${getProjectRefreshArticleBatchExistsSql('mart.review_article_rollup.article_id')};
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
        AND ${getProjectRefreshArticleBatchExistsSql('scope_article.article_id')}
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
        AND ${getProjectRefreshArticleBatchExistsSql('judgment_human.article_id')}
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
        AND ${getProjectRefreshArticleBatchExistsSql('judgment_human_summary.article_id')}
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
        AND ${getProjectRefreshArticleBatchExistsSql('review.article_id')}
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
      AND ${getProjectRefreshArticleBatchExistsSql('scope_article.article_id')};
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

const getProjectReviewServingScopedImportCteSql = (projectId: string) => {
  return getScopedArticleImportSelectionCteSql({
    articleIdFilterSql: getProjectRefreshArticleBatchExistsSql('air.article_id'),
    cteName: martReviewArticleServingScopedImportCteName,
    projectIds: [projectId],
  })
}

const getProjectReviewServingScopedImportJoinSql = (articleIdExpression: string) => {
  return getScopedArticleImportJoinSql({articleIdExpression, cteName: martReviewArticleServingScopedImportCteName})
}

const getProjectReviewServingSourceMetadataExpression = () => {
  return getScopedArticleCombinedMetadataExpression({articleAlias: 'article'})
}

const getProjectReviewServingBatchSql = (projectId: string, articleIds: string[]) => {
  return `
    BEGIN TRANSACTION;
    ${getProjectRefreshArticleBatchSetupSql(articleIds)}
    ${getProjectReviewServingBatchBodySql(projectId)}
    ${getProjectRefreshArticleBatchCleanupSql()}
    COMMIT;
  `
}

const getProjectReviewServingBatchBodySql = (projectId: string) => {
  const projectLiteral = getSqlLiteral(projectId)

  return `
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
    WITH ${getProjectReviewServingScopedImportCteSql(projectId)}
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
      ${getScopedArticleExternalIdExpression({articleAlias: 'article'})},
      json_extract_string(${getProjectReviewServingSourceMetadataExpression()}, '$.journalTitle'),
      article.url,
      article.full_text_pdf,
      article.full_text_fetched_at,
      article.full_text_conversion_status,
      ${getProjectReviewServingSourceMetadataExpression()},
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
    ${getProjectReviewServingScopedImportJoinSql('rollup.article_id')}
    WHERE rollup.project_id = ${projectLiteral}
      AND ${getProjectRefreshArticleBatchExistsSql('rollup.article_id')};
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
      AND ${getProjectRefreshArticleBatchExistsSql('fact.article_id')};
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
      judgment_project_id,
      judgment_updated_at,
      use_title,
      use_abstract,
      use_fulltext,
      use_fulltext_no_images,
      chunking_strategy,
      is_answered,
      confidence_original,
      explanation,
      quotes,
      snapshot_project_id,
      snapshot_project_model_name,
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
      judgment.project_id,
      judgment.updated_at,
      judgment_fact.use_title,
      judgment_fact.use_abstract,
      judgment_fact.use_fulltext,
      judgment_fact.use_fulltext_no_images,
      judgment_fact.chunking_strategy,
      judgment_fact.is_answered,
      judgment_fact.confidence_original,
      judgment_fact.explanation,
      judgment_fact.quotes,
      judgment.snapshot_project_id,
      judgment.snapshot_project_model_name,
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
    LEFT JOIN app.judgment judgment ON judgment.id = judgment_fact.judgment_id
    WHERE scope_article.project_id = ${projectLiteral}
      AND ${getProjectRefreshArticleBatchExistsSql('scope_article.article_id')};
  `
}

const getProjectReviewActiveServingBatchRefreshSql = (projectId: string, articleIds: string[]) => {
  return `
    BEGIN TRANSACTION;
    ${getProjectRefreshArticleBatchSetupSql(articleIds)}
    ${getProjectReviewActiveServingBatchRefreshBodySql(projectId)}
    ${getProjectRefreshArticleBatchCleanupSql()}
    COMMIT;
  `
}

const getProjectReviewActiveServingBatchRefreshBodySql = (projectId: string) => {
  const projectLiteral = getSqlLiteral(projectId)

  return `
    DELETE FROM mart.review_article_serving_detail
    WHERE project_id = ${projectLiteral}
      AND ${getProjectRefreshArticleBatchExistsSql('mart.review_article_serving_detail.article_id')}
      AND generation = (
        SELECT active_generation
        FROM app.project_review_serving_generation
        WHERE project_id = ${projectLiteral}
      );
    DELETE FROM mart.review_article_filter_member
    WHERE project_id = ${projectLiteral}
      AND ${getProjectRefreshArticleBatchExistsSql('mart.review_article_filter_member.article_id')}
      AND generation = (
        SELECT active_generation
        FROM app.project_review_serving_generation
        WHERE project_id = ${projectLiteral}
      );
    DELETE FROM mart.review_article_serving
    WHERE project_id = ${projectLiteral}
      AND ${getProjectRefreshArticleBatchExistsSql('mart.review_article_serving.article_id')}
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
    WITH ${getProjectReviewServingScopedImportCteSql(projectId)}
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
      ${getScopedArticleExternalIdExpression({articleAlias: 'article'})},
      json_extract_string(${getProjectReviewServingSourceMetadataExpression()}, '$.journalTitle'),
      article.url,
      article.full_text_pdf,
      article.full_text_fetched_at,
      article.full_text_conversion_status,
      ${getProjectReviewServingSourceMetadataExpression()},
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
    ${getProjectReviewServingScopedImportJoinSql('rollup.article_id')}
    WHERE rollup.project_id = ${projectLiteral}
      AND ${getProjectRefreshArticleBatchExistsSql('rollup.article_id')};
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
      AND ${getProjectRefreshArticleBatchExistsSql('fact.article_id')};
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
      judgment_project_id,
      judgment_updated_at,
      use_title,
      use_abstract,
      use_fulltext,
      use_fulltext_no_images,
      chunking_strategy,
      is_answered,
      confidence_original,
      explanation,
      quotes,
      snapshot_project_id,
      snapshot_project_model_name,
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
      judgment.project_id,
      judgment.updated_at,
      judgment_fact.use_title,
      judgment_fact.use_abstract,
      judgment_fact.use_fulltext,
      judgment_fact.use_fulltext_no_images,
      judgment_fact.chunking_strategy,
      judgment_fact.is_answered,
      judgment_fact.confidence_original,
      judgment_fact.explanation,
      judgment_fact.quotes,
      judgment.snapshot_project_id,
      judgment.snapshot_project_model_name,
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
    LEFT JOIN app.judgment judgment ON judgment.id = judgment_fact.judgment_id
    WHERE scope_article.project_id = ${projectLiteral}
      AND ${getProjectRefreshArticleBatchExistsSql('scope_article.article_id')};
  `
}

const getDirtyProjectArticleBatchRefreshSql = (projectId: string, articleIds: string[]) => {
  return `
    BEGIN TRANSACTION;
    ${getProjectRefreshArticleBatchSetupSql(articleIds)}
    ${getProjectScopeArticleBatchRefreshBodySql(projectId)}
    ${getJudgmentProjectScopeBatchRefreshBodySql(projectId)}
    ${getProjectPromptAnswerFactBatchRefreshBodySql(projectId, {rebuildLookupIndex: false})}
    ${getProjectReviewAnswerDictionaryMissingBatchInsertBodySql(projectId)}
    ${getProjectReviewArticleRollupBatchInsertBodySql(projectId)}
    ${getProjectReviewActiveServingBatchRefreshBodySql(projectId)}
    ${getProjectRefreshArticleBatchCleanupSql()}
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
    ${getJudgmentFactSafeRefreshBodySql({dirtyArticlesSql})}
    COMMIT;
  `
}

const getJudgmentFactSafeRefreshBodySql = ({dirtyArticlesSql}: {dirtyArticlesSql: string}) => {
  return `
    DROP TABLE IF EXISTS ${martRefreshJudgmentFactArticleBatchTableName};
    CREATE TEMP TABLE ${martRefreshJudgmentFactArticleBatchTableName} AS
    SELECT DISTINCT article_id
    FROM (${dirtyArticlesSql}) dirty_article_source
    WHERE article_id IS NOT NULL;
    DELETE FROM mart.judgment_fact
    WHERE EXISTS (
      SELECT 1
      FROM ${martRefreshJudgmentFactArticleBatchTableName} dirty_article
      WHERE dirty_article.article_id = mart.judgment_fact.article_id
    );
    INSERT INTO mart.judgment_fact (
      judgment_id,
      article_id,
      prompt_id,
      model_id,
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
        FROM ${martRefreshJudgmentFactArticleBatchTableName} dirty_article
        WHERE dirty_article.article_id = judgment.article_id
      )
    `)};
    DROP TABLE ${martRefreshJudgmentFactArticleBatchTableName};
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
  return `
    BEGIN TRANSACTION;
    ${getProjectRefreshArticleBatchSetupSql(articleIds)}
    ${getJudgmentProjectScopeBatchRefreshBodySql(projectId)}
    ${getProjectRefreshArticleBatchCleanupSql()}
    COMMIT;
  `
}

const getJudgmentProjectScopeBatchRefreshBodySql = (projectId: string) => {
  const projectLiteral = getSqlLiteral(projectId)

  return getJudgmentFactSafeRefreshBodySql({
    dirtyArticlesSql: `
      SELECT requested_article.article_id
      FROM ${martRefreshArticleBatchTableName} requested_article
      INNER JOIN mart.project_scope_article scope_article
        ON scope_article.project_id = ${projectLiteral}
       AND scope_article.article_id = requested_article.article_id
    `,
  })
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

const requestLargeRebuildsForDirtyStates = async (
  states: MarkedProjectDirtyState[],
  runner: {queryJson: <T>(statement: string) => Promise<T[]>; run: (statement: string) => Promise<void>},
) => {
  return states.reduce<Promise<MarkedProjectDirtyState[]>>(async (accPromise, state) => {
    const acc = await accPromise

    await getProjectMartLargeRebuildStateService().requestLargeRebuild({
      projectId: state.projectId,
      rebuildPhase: 'project_scope_article',
      refreshToken: state.dirtyToken,
      runner,
    })

    return [...acc, state]
  }, Promise.resolve([]))
}

const requestProjectLargeRebuilds = async (projectIds: string[], reason: string) => {
  const refreshStateService = getProjectMartDirtyRefreshStateService()
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

        return requestLargeRebuildsForDirtyStates(states, tx)
      }) as Promise<MarkedProjectDirtyState[]>)
}

const getProjectIsFreshForLargeRebuildBootstrap = async (
  projectId: string,
  runner: {queryJson: <T>(statement: string) => Promise<T[]>},
) => {
  const [row] = await runner.queryJson<{isFresh: boolean}>(`
    WITH refresh_state AS (
      SELECT project_id, dirty_token, last_completed_dirty_token, refresh_status
      FROM app.project_mart_refresh_state
      WHERE project_id = ${getSqlLiteral(projectId)}
      LIMIT 1
    ),
    materialization_summary AS (
      SELECT CAST(COUNT(*) AS INTEGER) AS incompleteCount
      FROM app.project_mart_dirty_materialization_state materialization
      INNER JOIN refresh_state state ON state.project_id = materialization.project_id
      WHERE state.dirty_token IS NOT NULL
        AND materialization.target_dirty_token <= state.dirty_token
        AND materialization.materialization_status <> 'completed'
    ),
    quarantine_summary AS (
      SELECT CAST(COUNT(*) AS INTEGER) AS unresolvedCount
      FROM app.project_mart_dirty_refresh_article_quarantine quarantine
      INNER JOIN refresh_state state ON state.project_id = quarantine.project_id
      WHERE state.dirty_token IS NOT NULL
        AND quarantine.dirty_token <= state.dirty_token
        AND quarantine.resolved_at IS NULL
    )
    SELECT
      COALESCE(
        state.dirty_token IS NULL
          OR (
            state.refresh_status <> 'failed'
            AND state.last_completed_dirty_token IS NOT NULL
            AND state.last_completed_dirty_token >= state.dirty_token
            AND COALESCE(materialization_summary.incompleteCount, 0) = 0
            AND COALESCE(quarantine_summary.unresolvedCount, 0) = 0
          ),
        TRUE
      ) AS isFresh
    FROM (SELECT 1) seed
    LEFT JOIN refresh_state state ON TRUE
    LEFT JOIN materialization_summary ON TRUE
    LEFT JOIN quarantine_summary ON TRUE
  `)

  return row?.isFresh === true
}

const requestProjectLargeRebuildIfNoLargeRebuild = async (projectId: string, reason: string) => {
  return getAppDatabaseService().transaction(async (tx) => {
    const [largeRebuildState] = await tx.queryJson<{refreshToken: number | null}>(`
      SELECT CAST(refresh_token AS INTEGER) AS refreshToken
      FROM app.project_mart_large_rebuild_state
      WHERE project_id = ${getSqlLiteral(projectId)}
      LIMIT 1
    `)

    if ((largeRebuildState?.refreshToken ?? 0) > 0) {
      return []
    }

    if (!(await getProjectIsFreshForLargeRebuildBootstrap(projectId, tx))) {
      return []
    }

    const refreshStateService = getProjectMartDirtyRefreshStateService()
    const dirtyProjects = await refreshStateService.getDirtyProjectsForProjectIds(tx, [projectId])
    const states = await refreshStateService.markProjectsDirtyAtomically({projects: dirtyProjects, reason, runner: tx})

    return requestLargeRebuildsForDirtyStates(states, tx)
  }) as Promise<MarkedProjectDirtyState[]>
}

const requestProjectLargeRebuildForDirtyArticles = async (projectId: string, articleIds: string[], reason: string) => {
  const refreshArticleIds = getUniqueValues(articleIds)

  return refreshArticleIds.length === 0
    ? []
    : (getAppDatabaseService().transaction(async (tx) => {
        const states = await getProjectMartDirtyRefreshStateService().markProjectsDirtyAtomically({
          projects: [{articleIds: refreshArticleIds, projectId}],
          reason,
          runner: tx,
        })

        return requestLargeRebuildsForDirtyStates(states, tx)
      }) as Promise<MarkedProjectDirtyState[]>)
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

const getProjectTableCleanupBatchRows = async ({
  projectId,
  tableName,
}: {
  projectId: string
  tableName: string
}): Promise<ProjectCleanupBatchRow[]> => {
  return queryMartRefreshBackgroundJson<ProjectCleanupBatchRow>(getProjectTableCleanupBatchSql({projectId, tableName}))
}

const getReviewArticleServingRewriteBatchRows = async ({
  cursor,
  projectId,
}: {
  cursor: ReviewArticleServingRewriteBatchCursor | null
  projectId: string
}): Promise<ProjectCleanupBatchRow[]> => {
  return queryMartRefreshBackgroundJson<ProjectCleanupBatchRow>(
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
  await refreshProjectScopeArticleBatches({
    processBatch: async (articleIds) => {
      return runMartRefreshBackgroundStatement(getProjectPromptAnswerFactBatchInsertSql(projectId, articleIds))
    },
    projectId,
  })
  return runMartRefreshBackgroundStatement(getProjectPromptAnswerFactLookupIndexCreateSql())
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
  await runMartRefreshBackgroundStatement(getReviewArticleServingRewriteCleanupSetupSql())
  await copyReviewArticleServingRewriteBatches({projectId})
  await runMartRefreshBackgroundStatement(getReviewArticleServingRewriteCleanupFinalizeSql())
  return runMartRefreshBackgroundStatement(getReviewArticleServingRewriteCleanupIndexSql())
}

const deleteProjectTableCleanupRowIds = async ({
  rowIds,
  tableName,
}: {
  rowIds: Array<bigint | number | string>
  tableName: string
}): Promise<void> => {
  return rowIds.length === 0
    ? Promise.resolve()
    : runMartRefreshBackgroundStatement(getProjectTableCleanupDeleteSql({rowIds, tableName})).catch((error) => {
        return !isProjectCleanupDeleteRetryableError(error) || rowIds.length === 1
          ? Promise.reject(error)
          : deleteProjectTableCleanupRowIds({rowIds: getProjectCleanupDeleteRetryParts(rowIds)[0], tableName}).then(
              () => {
                return deleteProjectTableCleanupRowIds({
                  rowIds: getProjectCleanupDeleteRetryParts(rowIds)[1],
                  tableName,
                })
              },
            )
      })
}

const deleteProjectTableCleanupBatches = async ({
  projectId,
  tableName,
}: {
  projectId: string
  tableName: string
}): Promise<void> => {
  const batchRows = await getProjectTableCleanupBatchRows({projectId, tableName})
  const rowIds = batchRows.map((row) => {
    return row.rowId
  })

  return rowIds.length === 0
    ? Promise.resolve()
    : deleteProjectTableCleanupRowIds({rowIds, tableName})
        .then(() => {
          return yieldToEventLoop()
        })
        .then(() => {
          return deleteProjectTableCleanupBatches({projectId, tableName})
        })
}

const deleteProjectTableCleanupBatch = async ({
  projectId,
  tableName,
}: {
  projectId: string
  tableName: string
}): Promise<number> => {
  const batchRows = await getProjectTableCleanupBatchRows({projectId, tableName})
  const rowIds = batchRows.map((row) => {
    return row.rowId
  })

  return rowIds.length === 0
    ? 0
    : deleteProjectTableCleanupRowIds({rowIds, tableName}).then(() => {
        return rowIds.length
      })
}

const cleanupArchivedProjectMartTable = async ({
  projectId,
  tableName,
}: {
  projectId: string
  tableName: string
}): Promise<void> => {
  return getArchivedProjectMartCleanupMode(tableName) === 'rewrite'
    ? rewriteReviewArticleServingForArchivedProject(projectId)
    : deleteProjectTableCleanupBatches({projectId, tableName})
}

export const archivedProjectMartTableNames = [
  'mart.review_article_serving_detail',
  'mart.review_article_filter_member',
  'mart.review_article_serving',
  'mart.review_article_rollup',
  'mart.prompt_answer_fact',
  'mart.project_scope_article',
]

const archivedProjectCleanupTableNames = [...archivedProjectMartTableNames, 'app.project_review_serving_generation']

const getArchivedProjectMartCleanupCandidateSql = () => {
  return `
    SELECT tableName, projectId
    FROM (
      ${archivedProjectCleanupTableNames
        .map((tableName, tableIndex) => {
          return `
            SELECT
              ${getSqlLiteral(tableName)} AS tableName,
              cleanup_row.project_id AS projectId,
              ${tableIndex} AS tableOrder
            FROM ${tableName} cleanup_row
            INNER JOIN app.project project
              ON project.id = cleanup_row.project_id
             AND project.archived = TRUE
            GROUP BY cleanup_row.project_id
          `
        })
        .join(' UNION ALL ')}
    ) candidate
    ORDER BY tableOrder ASC, projectId ASC
    LIMIT 1
  `
}

const cleanupArchivedProjectMartDataBatch = async (
  projectId: string,
): Promise<ArchivedProjectMartCleanupBatchResult> => {
  const rows = await archivedProjectCleanupTableNames.reduce<
    Promise<Array<{deletedRowCount: number; tableName: string}>>
  >((promise, tableName) => {
    return promise.then(async (acc) => {
      if (acc.length > 0) {
        return acc
      }

      const deletedRowCount = await deleteProjectTableCleanupBatch({projectId, tableName})

      return deletedRowCount === 0 ? acc : [{deletedRowCount, tableName}]
    })
  }, Promise.resolve([]))
  const [row] = rows

  return row
    ? {deletedRowCount: row.deletedRowCount, projectId, tableName: row.tableName}
    : {deletedRowCount: 0, projectId, tableName: null}
}

const cleanupNextArchivedProjectMartBatch = async (): Promise<ArchivedProjectMartCleanupBatchResult> => {
  const [candidate] = await queryMartRefreshBackgroundJson<ArchivedProjectMartCleanupCandidateRow>(
    getArchivedProjectMartCleanupCandidateSql(),
  )

  if (!candidate) {
    return {deletedRowCount: 0, projectId: null, tableName: null}
  }

  const deletedRowCount = await deleteProjectTableCleanupBatch({
    projectId: candidate.projectId,
    tableName: candidate.tableName,
  })

  return {deletedRowCount, projectId: candidate.projectId, tableName: candidate.tableName}
}

const cleanupArchivedProjectMartData = async (projectId: string): Promise<void> => {
  await archivedProjectCleanupTableNames.reduce<Promise<void>>((promise, tableName) => {
    return promise.then(() => {
      return cleanupArchivedProjectMartTable({projectId, tableName})
    })
  }, Promise.resolve())
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
      judgment_project_id,
      judgment_updated_at,
      use_title,
      use_abstract,
      use_fulltext,
      use_fulltext_no_images,
      chunking_strategy,
      is_answered,
      confidence_original,
      explanation,
      quotes,
      snapshot_project_id,
      snapshot_project_model_name,
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
      judgment.project_id,
      judgment.updated_at,
      judgment_fact.use_title,
      judgment_fact.use_abstract,
      judgment_fact.use_fulltext,
      judgment_fact.use_fulltext_no_images,
      judgment_fact.chunking_strategy,
      judgment_fact.is_answered,
      judgment_fact.confidence_original,
      judgment_fact.explanation,
      judgment_fact.quotes,
      judgment.snapshot_project_id,
      judgment.snapshot_project_model_name,
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
     })}
    LEFT JOIN app.judgment judgment ON judgment.id = judgment_fact.judgment_id;
    COMMIT;
  `
}

const refreshProjectPromptAnswerFactForArticles = async (projectId: string, articleIds: string[]): Promise<void> => {
  const refreshArticleIds = getUniqueValues(articleIds)

  return refreshArticleIds.length === 0
    ? Promise.resolve()
    : runMartRefreshBackgroundStatement(getProjectPromptAnswerFactBatchRefreshSql(projectId, refreshArticleIds))
        .then(() => {
          return runMartRefreshBackgroundStatement(getProjectPromptAnswerFactLookupIndexCreateSql())
        })
        .then(() => {
          return yieldToEventLoop()
        })
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
    await requestProjectLargeRebuildForDirtyArticles(
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

const refreshDirtyProjectArticleBatch = async (projectId: string, articleIds: string[]): Promise<void> => {
  const refreshArticleIds = getUniqueValues(articleIds)

  if (refreshArticleIds.length === 0) {
    return
  }

  if (!(await getHasActiveProjectReviewServingGeneration(projectId))) {
    await requestProjectLargeRebuildForDirtyArticles(
      projectId,
      refreshArticleIds,
      'missingActiveProjectReviewServingGeneration',
    )
    return
  }

  await runMartRefreshBackgroundStatement(getDirtyProjectArticleBatchRefreshSql(projectId, refreshArticleIds))
  await yieldToEventLoop()
  recordArticleRefreshCompletion()
}

const refreshProjectArticleServingForArticles = async (projectId: string, articleIds: string[]): Promise<void> => {
  return refreshProjectArticleMartsBatch(projectId, articleIds)
}

const refreshProjectArticleServing = async (projectId: string, articleId: string): Promise<void> => {
  return refreshProjectArticleMartsBatch(projectId, [articleId])
}

const refreshProject = async (projectId: string) => {
  await ensureReviewArticleRollupTable()

  if (await getProjectIsArchived(projectId)) {
    await cleanupArchivedProjectMartData(projectId)
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
    `
      BEGIN TRANSACTION;
      ${getProjectRefreshArticleBatchSetupSql(refreshArticleIds)}
      ${getJudgmentFactSafeRefreshBodySql({
        dirtyArticlesSql: `
          SELECT requested_article.article_id
          FROM ${martRefreshArticleBatchTableName} requested_article
        `,
      })}
      ${getProjectRefreshArticleBatchCleanupSql()}
      COMMIT;
    `,
  )
  await yieldToEventLoop()
  recordArticleRefreshCompletion()
}

const yieldToEventLoop = async (): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve, martRefreshYieldDelayMs)
  })
}

const duckdbMartMaintenanceService = {
  getThroughputSnapshot: getMartRefreshThroughputSnapshot,
  hasActiveProjectReviewServingGeneration: getHasActiveProjectReviewServingGeneration,
  requestProjectLargeRebuild: async (projectId: string, reason: string) => {
    return requestProjectLargeRebuilds([projectId], reason)
  },
  requestProjectLargeRebuildIfNoLargeRebuild,
  requestProjectLargeRebuilds,
  cleanupArchivedProjectMartData,
  cleanupArchivedProjectMartDataBatch,
  cleanupNextArchivedProjectMartBatch,
  refreshJudgmentArticle,
  refreshJudgmentFactsForArticles,
  refreshJudgmentFactsForProjectClaim,
  refreshDirtyProjectArticleBatch,
  refreshProject,
  refreshProjectScopeArticles,
  refreshProjectArticleMartsBatch,
  refreshProjectArticleServing,
  refreshProjectArticleServingForArticles,
  resetRuntimeStateForTests: () => {
    martRefreshReviewArticleRollupReady = null
    martRefreshReviewArticleRollupVerified = false
    resetMartRefreshThroughputSnapshot()
  },
}

export const getDuckdbMartMaintenanceService = () => {
  return duckdbMartMaintenanceService
}
