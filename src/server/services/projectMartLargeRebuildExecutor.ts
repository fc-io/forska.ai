import {getAppDatabaseService} from './appDatabaseService.ts'
import {getSqlLiteral, getTimestampLiteral} from './appQueryHelpers.ts'
import {getMaintenanceWorkLeaseService} from './maintenanceWorkLeaseService.ts'
import {getProjectVisibleJudgmentScopeSql} from './projectVisibleJudgmentRule.ts'
import {
  getScopedArticleCombinedMetadataExpression,
  getScopedArticleExternalIdExpression,
  getScopedArticleImportJoinSql,
  getScopedArticleImportSelectionCteSql,
} from './scopedArticleReadAdapter.ts'

type ProjectMartLargeRebuildBatchCursor = {articleCreatedAt: Date | string | null; articleId: string}

type ProjectMartLargeRebuildScopeBatchRow = {
  articleCreatedAt: Date | string | null
  articleId: string
  articleUpdatedAt: Date | string | null
  inCuratedScope: boolean
  inRouteScope: boolean
}

type ProjectMartLargeRebuildGenerationCleanupBatchRow = {
  generation: bigint | number | string
  projectId: string
  rowId: bigint | number | string
}

type ProjectMartLargeRebuildGenerationCleanupTargetRow = {generation: bigint | number | string; projectId: string}

type ProjectMartLargeRebuildGenerationCleanupBatchResult = {
  deletedRowCount: number
  tables: Array<{deletedRowCount: number; tableName: ProjectMartLargeRebuildGenerationCleanupTableName}>
}

type ProjectMartLargeRebuildGenerationCleanupTableName =
  | 'mart.review_article_filter_member'
  | 'mart.review_article_serving'
  | 'mart.review_article_serving_detail'

type ProjectMartLargeRebuildExecutorDependencies = {
  database: {queryJson: <T>(statement: string) => Promise<T[]>; run: (statement: string) => Promise<void>}
}

type GetProjectScopeBatchParams = {
  batchSize?: number
  cursor?: ProjectMartLargeRebuildBatchCursor | null
  projectId: string
}

const defaultProjectMartLargeRebuildBatchSize = 1_000
const projectReviewServingGenerationCleanupBatchSize = 10_000
const projectReviewServingGenerationCleanupDefaultLeaseMs = 30_000
const projectReviewServingGenerationCleanupDefaultWorkerId = 'project-review-serving-generation-cleanup'
const batchEpochSql = "TIMESTAMPTZ '1970-01-01T00:00:00.000Z'"
const promptAnswerFactLookupIndexName = 'idx_mart_prompt_answer_fact_lookup'
const promptAnswerFactLookupIndexQualifiedName = `mart.${promptAnswerFactLookupIndexName}`
const reviewArticleServingScopedImportCteName = 'selected_review_article_serving_import'
const projectReviewServingGenerationCleanupRetryableErrorFragments = [
  'Failed to delete all rows from index',
  'Out of Memory Error',
  'failed to allocate data',
]
const projectReviewServingGenerationCleanupTableNames: ProjectMartLargeRebuildGenerationCleanupTableName[] = [
  'mart.review_article_serving',
  'mart.review_article_filter_member',
  'mart.review_article_serving_detail',
]

const getProjectMartLargeRebuildExecutorDatabase = (): ProjectMartLargeRebuildExecutorDependencies['database'] => {
  const database = getAppDatabaseService()

  return {queryJson: database.queryJsonBackground, run: database.runBackground}
}

const defaultProjectMartLargeRebuildExecutorDependencies: ProjectMartLargeRebuildExecutorDependencies = {
  database: getProjectMartLargeRebuildExecutorDatabase(),
}

const getBatchOrderSql = ({
  articleCreatedAtColumn,
  articleIdColumn,
}: {
  articleCreatedAtColumn: string
  articleIdColumn: string
}) => {
  return `COALESCE(${articleCreatedAtColumn}, ${batchEpochSql}) ASC, ${articleIdColumn} ASC`
}

const getBatchCursorWhereSql = ({
  articleCreatedAtColumn,
  articleIdColumn,
  cursor,
}: {
  articleCreatedAtColumn: string
  articleIdColumn: string
  cursor: ProjectMartLargeRebuildBatchCursor | null
}) => {
  if (cursor === null) {
    return ''
  }

  return `
    AND (
      COALESCE(${articleCreatedAtColumn}, ${batchEpochSql}) > COALESCE(${getSqlLiteral(cursor.articleCreatedAt)}, ${batchEpochSql})
      OR (
        COALESCE(${articleCreatedAtColumn}, ${batchEpochSql}) = COALESCE(${getSqlLiteral(cursor.articleCreatedAt)}, ${batchEpochSql})
        AND ${articleIdColumn} > ${getSqlLiteral(cursor.articleId)}
      )
    )
  `
}

const getProjectScopeSourceBatchSql = ({
  batchSize,
  cursor,
  projectId,
}: {
  batchSize: number
  cursor: ProjectMartLargeRebuildBatchCursor | null
  projectId: string
}) => {
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
      ${getBatchCursorWhereSql({
        articleCreatedAtColumn: 'article.article_created_at',
        articleIdColumn: 'aggregated_scope.article_id',
        cursor,
      })}
    ORDER BY ${getBatchOrderSql({
      articleCreatedAtColumn: 'article.article_created_at',
      articleIdColumn: 'aggregated_scope.article_id',
    })}
    LIMIT ${batchSize}
  `
}

const getProjectScopeMartBatchSql = ({
  batchSize,
  cursor,
  projectId,
}: {
  batchSize: number
  cursor: ProjectMartLargeRebuildBatchCursor | null
  projectId: string
}) => {
  const projectLiteral = getSqlLiteral(projectId)

  return `
    SELECT
      scope_article.article_id AS articleId,
      scope_article.article_created_at AS articleCreatedAt,
      scope_article.article_updated_at AS articleUpdatedAt,
      scope_article.in_curated_scope AS inCuratedScope,
      scope_article.in_route_scope AS inRouteScope
    FROM mart.project_scope_article scope_article
    WHERE scope_article.project_id = ${projectLiteral}
      ${getBatchCursorWhereSql({
        articleCreatedAtColumn: 'scope_article.article_created_at',
        articleIdColumn: 'scope_article.article_id',
        cursor,
      })}
    ORDER BY ${getBatchOrderSql({
      articleCreatedAtColumn: 'scope_article.article_created_at',
      articleIdColumn: 'scope_article.article_id',
    })}
    LIMIT ${batchSize}
  `
}

const getProjectRefreshArticleIdsSql = (articleIds: string[]) => {
  return articleIds
    .map((articleId) => {
      return getSqlLiteral(articleId)
    })
    .join(', ')
}

const getProjectRefreshArticleIdRowsSql = (articleIds: string[]) => {
  return articleIds
    .map((articleId) => {
      return `(${getSqlLiteral(articleId)})`
    })
    .join(', ')
}

const getProjectReviewServingTargetGenerationSql = (targetGeneration: number) => {
  if (!Number.isSafeInteger(targetGeneration) || targetGeneration <= 0) {
    throw new Error(`Invalid project review serving target generation: ${targetGeneration}`)
  }

  return getSqlLiteral(targetGeneration)
}

const getProjectReviewServingCleanupGenerationSql = (generation: bigint | number | string) => {
  return `CAST(${getSqlLiteral(generation)} AS BIGINT)`
}

const getProjectScopeResetSql = (projectId: string) => {
  const projectLiteral = getSqlLiteral(projectId)

  return `
    BEGIN TRANSACTION;
    DELETE FROM mart.project_scope_article WHERE project_id = ${projectLiteral};
    COMMIT;
  `
}

const getProjectScopeBatchInsertSql = (projectId: string, rows: ProjectMartLargeRebuildScopeBatchRow[]) => {
  const projectLiteral = getSqlLiteral(projectId)
  const articleIdsSql = getProjectRefreshArticleIdsSql(
    rows.map((row) => {
      return row.articleId
    }),
  )

  return `
    BEGIN TRANSACTION;
    DELETE FROM mart.project_scope_article
    WHERE project_id = ${projectLiteral}
      AND article_id IN (${articleIdsSql});
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

const getProjectJudgmentFactBatchInsertSql = (projectId: string, articleIds: string[]) => {
  const projectLiteral = getSqlLiteral(projectId)
  const articleRowsSql = getProjectRefreshArticleIdRowsSql(articleIds)

  return `
    BEGIN TRANSACTION;
    DROP TABLE IF EXISTS temp_project_judgment_fact_article;
    CREATE TEMP TABLE temp_project_judgment_fact_article AS
    SELECT DISTINCT requested_article.article_id
    FROM (VALUES ${articleRowsSql}) AS requested_article(article_id)
    INNER JOIN mart.project_scope_article scope_article
      ON scope_article.project_id = ${projectLiteral}
     AND scope_article.article_id = requested_article.article_id
    WHERE requested_article.article_id IS NOT NULL;
    DELETE FROM mart.judgment_fact
    WHERE EXISTS (
      SELECT 1
      FROM temp_project_judgment_fact_article dirty_article
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
      NULLIF(TRIM(COALESCE(judgment.answered_original, '')), ''),
      judgment.answered_original_as_array,
      CASE
        WHEN judgment.answered_original_as_array IS NOT NULL AND ARRAY_LENGTH(judgment.answered_original_as_array) > 0
          THEN judgment.answered_original_as_array
        WHEN NULLIF(TRIM(COALESCE(judgment.answered_original, '')), '') IS NOT NULL
          THEN [TRIM(COALESCE(judgment.answered_original, ''))]
        ELSE NULL
      END,
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
      AND EXISTS (
        SELECT 1
        FROM temp_project_judgment_fact_article dirty_article
        WHERE dirty_article.article_id = judgment.article_id
      );
    DROP TABLE temp_project_judgment_fact_article;
    COMMIT;
  `
}

const getProjectPromptAnswerFactResetSql = (projectId: string) => {
  const projectLiteral = getSqlLiteral(projectId)

  return `
    BEGIN TRANSACTION;
    DROP INDEX IF EXISTS ${promptAnswerFactLookupIndexQualifiedName};
    DELETE FROM mart.prompt_answer_fact WHERE project_id = ${projectLiteral};
    COMMIT;
  `
}

const getProjectPromptAnswerFactLookupIndexCreateSql = () => {
  return `
    CREATE INDEX IF NOT EXISTS ${promptAnswerFactLookupIndexName}
    ON mart.prompt_answer_fact(project_id, prompt_id, answer_value, article_id);
  `
}

const getProjectPromptAnswerFactBatchInsertSql = (projectId: string, articleIds: string[]) => {
  const projectLiteral = getSqlLiteral(projectId)
  const articleIdsSql = getProjectRefreshArticleIdsSql(articleIds)

  return `
    BEGIN TRANSACTION;
    DROP INDEX IF EXISTS ${promptAnswerFactLookupIndexQualifiedName};
    DELETE FROM mart.prompt_answer_fact
    WHERE project_id = ${projectLiteral}
      AND article_id IN (${articleIdsSql});
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
        fact.project_id,
        fact.prompt_id,
        fact.answer_value
      FROM mart.prompt_answer_fact fact
      INNER JOIN mart.project_scope_article scope_article
        ON scope_article.project_id = fact.project_id
       AND scope_article.article_id = fact.article_id
      WHERE fact.project_id = ${projectLiteral}
        AND fact.article_id IN (${articleIdsSql})
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
    missing_prompt AS (
      SELECT DISTINCT project_id, prompt_id
      FROM missing_answer_values
    ),
    current_answer_id AS (
      SELECT
        dictionary.project_id,
        dictionary.prompt_id,
        COALESCE(MAX(dictionary.answer_id), 0) AS max_answer_id
      FROM app.review_answer_dictionary dictionary
      INNER JOIN missing_prompt
        ON missing_prompt.project_id = dictionary.project_id
       AND missing_prompt.prompt_id = dictionary.prompt_id
      WHERE dictionary.project_id = ${projectLiteral}
      GROUP BY dictionary.project_id, dictionary.prompt_id
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

const getProjectReviewServingSetupSql = (projectId: string, targetGeneration: number) => {
  const projectLiteral = getSqlLiteral(projectId)
  const targetGenerationLiteral = getProjectReviewServingTargetGenerationSql(targetGeneration)

  return `
    BEGIN TRANSACTION;
    INSERT INTO app.project_review_serving_generation (
      project_id,
      active_generation,
      generation_updated_at
    ) VALUES (
      ${projectLiteral},
      0,
      current_timestamp
    ) ON CONFLICT(project_id) DO NOTHING;
    DELETE FROM mart.review_article_serving
    WHERE project_id = ${projectLiteral}
      AND generation = ${targetGenerationLiteral};
    DELETE FROM mart.review_article_filter_member
    WHERE project_id = ${projectLiteral}
      AND generation = ${targetGenerationLiteral};
    DELETE FROM mart.review_article_serving_detail
    WHERE project_id = ${projectLiteral}
      AND generation = ${targetGenerationLiteral};
    COMMIT;
  `
}

const getProjectReviewArticleFilterMemberBatchInsertSql = (
  projectId: string,
  articleIds: string[],
  targetGeneration: number,
) => {
  const projectLiteral = getSqlLiteral(projectId)
  const articleIdsSql = getProjectRefreshArticleIdsSql(articleIds)
  const targetGenerationLiteral = getProjectReviewServingTargetGenerationSql(targetGeneration)

  return `
    BEGIN TRANSACTION;
    DELETE FROM mart.review_article_filter_member
    WHERE project_id = ${projectLiteral}
      AND generation = ${targetGenerationLiteral}
      AND article_id IN (${articleIdsSql});
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
      ${targetGenerationLiteral},
      fact.prompt_id,
      dict.answer_id,
      fact.article_id,
      scope_article.article_created_at,
      dict.numeric_answer_value,
      current_timestamp
    FROM mart.prompt_answer_fact fact
    INNER JOIN app.review_answer_dictionary dict
      ON dict.project_id = fact.project_id
     AND dict.prompt_id = fact.prompt_id
     AND dict.answer_value = fact.answer_value
    INNER JOIN mart.project_scope_article scope_article
      ON scope_article.project_id = fact.project_id
     AND scope_article.article_id = fact.article_id
    WHERE fact.project_id = ${projectLiteral}
      AND fact.article_id IN (${articleIdsSql});
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
      INNER JOIN enabled_project_prompt enabled_prompt ON enabled_prompt.project_id = scope_article.project_id
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
      SELECT project_id, article_id, COUNT(DISTINCT prompt_id) AS llm_judged_prompt_count, LIST(DISTINCT prompt_id) AS llm_judged_prompt_ids, MAX(latest_llm_created_at) AS latest_llm_created_at
      FROM llm_project_prompt
      GROUP BY project_id, article_id
    ),
    prompt_mode_human_project_prompt AS (
      SELECT judgment_human.project_id, judgment_human.article_id, judgment_human.prompt_id, MAX(judgment_human.updated_at) AS latest_human_updated_at
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
      SELECT project_id, article_id, COUNT(DISTINCT prompt_id) AS human_answered_prompt_count, LIST(DISTINCT prompt_id) AS human_answered_prompt_ids, MAX(latest_human_updated_at) AS latest_human_updated_at
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
      GROUP BY review.project_id, review.article_id
    )
    SELECT
      scope_article.project_id,
      scope_article.article_id,
      scope_article.article_created_at,
      scope_article.article_updated_at,
      COALESCE(prompt_count.enabled_prompt_count, 0),
      COALESCE(llm_rollup.llm_judged_prompt_count, 0),
      COALESCE(human_rollup.human_answered_prompt_count, 0),
      llm_rollup.llm_judged_prompt_ids,
      human_rollup.human_answered_prompt_ids,
      COALESCE(prompt_count.enabled_prompt_count, 0) > 0 AND COALESCE(llm_rollup.llm_judged_prompt_count, 0) = COALESCE(prompt_count.enabled_prompt_count, 0),
      CASE
        WHEN project.human_judgment_mode = 'summary' THEN COALESCE(human_rollup.human_answered_prompt_count, 0) > 0
        ELSE COALESCE(prompt_count.enabled_prompt_count, 0) > 0 AND COALESCE(human_rollup.human_answered_prompt_count, 0) = COALESCE(prompt_count.enabled_prompt_count, 0)
      END,
      scope_article.in_curated_scope,
      scope_article.in_route_scope,
      COALESCE(review_state.review_opened, FALSE),
      COALESCE(review_state.review_sections_completed, 0),
      llm_rollup.latest_llm_created_at,
      human_rollup.latest_human_updated_at,
      review_state.latest_review_updated_at,
      current_timestamp
    FROM mart.project_scope_article scope_article
    INNER JOIN app.project project ON project.id = scope_article.project_id
    LEFT JOIN enabled_project_prompt_count prompt_count ON prompt_count.project_id = scope_article.project_id
    LEFT JOIN llm_project_rollup llm_rollup ON llm_rollup.project_id = scope_article.project_id AND llm_rollup.article_id = scope_article.article_id
    LEFT JOIN human_project_rollup human_rollup ON human_rollup.project_id = scope_article.project_id AND human_rollup.article_id = scope_article.article_id
    LEFT JOIN review_state ON review_state.project_id = scope_article.project_id AND review_state.article_id = scope_article.article_id
    WHERE scope_article.project_id = ${projectLiteral}
      AND scope_article.article_id IN (${articleIdsSql});
    COMMIT;
  `
}

const getProjectReviewServingScopedImportCteSql = (projectId: string, articleIds: string[]) => {
  return getScopedArticleImportSelectionCteSql({
    articleIds,
    cteName: reviewArticleServingScopedImportCteName,
    projectIds: [projectId],
  })
}

const getProjectReviewServingScopedImportJoinSql = (articleIdExpression: string) => {
  return getScopedArticleImportJoinSql({articleIdExpression, cteName: reviewArticleServingScopedImportCteName})
}

const getProjectReviewServingSourceMetadataExpression = () => {
  return getScopedArticleCombinedMetadataExpression({articleAlias: 'article'})
}

const getProjectReviewServingBatchInsertSql = (projectId: string, articleIds: string[], targetGeneration: number) => {
  const projectLiteral = getSqlLiteral(projectId)
  const articleIdsSql = getProjectRefreshArticleIdsSql(articleIds)
  const targetGenerationLiteral = getProjectReviewServingTargetGenerationSql(targetGeneration)

  return `
    BEGIN TRANSACTION;
    DELETE FROM mart.review_article_serving_detail
    WHERE project_id = ${projectLiteral}
      AND generation = ${targetGenerationLiteral}
      AND article_id IN (${articleIdsSql});
    DELETE FROM mart.review_article_serving
    WHERE project_id = ${projectLiteral}
      AND generation = ${targetGenerationLiteral}
      AND article_id IN (${articleIdsSql});
    INSERT INTO mart.review_article_serving (
      project_id, generation, article_id, article_created_at, article_updated_at, article_title, article_external_id,
      journal_title, url, full_text_pdf, full_text_fetched_at, full_text_conversion_status, source_metadata,
      has_all_llm_judgments, llm_judged_prompt_count, llm_judged_prompt_ids, enabled_prompt_count,
      human_answered_prompt_count, human_answered_prompt_ids, has_all_human_answers, review_opened,
      review_sections_completed, latest_llm_created_at, latest_human_updated_at, latest_review_updated_at, serving_updated_at
    )
    WITH ${getProjectReviewServingScopedImportCteSql(projectId, articleIds)}
    SELECT
      rollup.project_id,
      ${targetGenerationLiteral},
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
      AND rollup.article_id IN (${articleIdsSql});
    INSERT INTO mart.review_article_serving_detail (
      project_id, generation, article_id, prompt_id, prompt_order, judgment_id, created_at,
      article_created_at, article_updated_at, model_id, judgment_project_id, judgment_updated_at, use_title,
      use_abstract, use_fulltext, use_fulltext_no_images, chunking_strategy, is_answered, confidence_original,
      explanation, quotes, snapshot_project_id, snapshot_project_model_name, answered_original,
      answered_original_as_array, detail_updated_at
    )
    SELECT
      scope_article.project_id,
      ${targetGenerationLiteral},
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
    INNER JOIN app.project_prompt project_prompt ON project_prompt.project_id = scope_article.project_id AND project_prompt.enabled = TRUE
    INNER JOIN mart.judgment_fact judgment_fact
      ON ${getProjectVisibleJudgmentScopeSql({
        judgmentAlias: 'judgment_fact',
        projectAlias: 'project',
        projectPromptAlias: 'project_prompt',
        projectScopeAlias: 'scope_article',
      })}
    LEFT JOIN app.judgment judgment ON judgment.id = judgment_fact.judgment_id
    WHERE scope_article.project_id = ${projectLiteral}
      AND scope_article.article_id IN (${articleIdsSql});
    COMMIT;
  `
}

const getPromotionGuardSql = ({
  expectedRebuildPhase,
  expectedRefreshToken,
  expectedTargetGeneration,
  now,
  projectLiteral,
  targetGeneration,
  targetGenerationLiteral,
  workerId,
}: {
  expectedRebuildPhase?: string
  expectedRefreshToken?: number
  expectedTargetGeneration?: number | null
  now?: Date
  projectLiteral: string
  targetGeneration: number
  targetGenerationLiteral: string
  workerId?: string
}) => {
  return workerId === undefined
    ? ''
    : `
      AND EXISTS (
        SELECT 1
        FROM app.project_mart_large_rebuild_state rebuild_state
        WHERE rebuild_state.project_id = ${projectLiteral}
          AND rebuild_state.worker_id = ${getSqlLiteral(workerId)}
          AND rebuild_state.refresh_status = 'running'
          AND rebuild_state.refresh_token = ${expectedRefreshToken ?? -1}
          AND rebuild_state.rebuild_phase = ${getSqlLiteral(expectedRebuildPhase ?? 'review_article_serving')}
          AND rebuild_state.target_generation IS NOT DISTINCT FROM ${getSqlLiteral(
            expectedTargetGeneration === undefined ? targetGeneration : expectedTargetGeneration,
          )}
          AND rebuild_state.target_generation IS NOT DISTINCT FROM ${targetGenerationLiteral}
          AND rebuild_state.superseded_at IS NULL
          AND rebuild_state.lease_expires_at IS NOT NULL
          AND rebuild_state.lease_expires_at > ${now === undefined ? 'current_timestamp' : getTimestampLiteral(now)}
      )
    `
}

const getProjectReviewServingPromoteSql = (
  projectId: string,
  targetGeneration: number,
  guard?: {
    expectedRebuildPhase?: string
    expectedRefreshToken?: number
    expectedTargetGeneration?: number | null
    now?: Date
    workerId?: string
  },
) => {
  const projectLiteral = getSqlLiteral(projectId)
  const targetGenerationLiteral = getProjectReviewServingTargetGenerationSql(targetGeneration)

  return `
    UPDATE app.project_review_serving_generation
    SET active_generation = ${targetGenerationLiteral},
        generation_updated_at = current_timestamp
    WHERE project_id = ${projectLiteral}
      AND active_generation < ${targetGenerationLiteral}
      ${getPromotionGuardSql({...guard, projectLiteral, targetGeneration, targetGenerationLiteral})}
      AND EXISTS (
        SELECT 1
        FROM mart.review_article_serving
        WHERE project_id = ${projectLiteral}
          AND generation = ${targetGenerationLiteral}
      )
    RETURNING CAST(active_generation AS INTEGER) AS activeGeneration;
  `
}

const getProjectReviewServingGenerationCleanupTargetSql = ({
  projectId,
  tableName,
}: {
  projectId?: string
  tableName: ProjectMartLargeRebuildGenerationCleanupTableName
}) => {
  return `
    SELECT
      cleanup_row.project_id AS projectId,
      CAST(cleanup_row.generation AS VARCHAR) AS generation
    FROM ${tableName} cleanup_row
    INNER JOIN app.project_review_serving_generation generation
      ON generation.project_id = cleanup_row.project_id
    WHERE cleanup_row.generation < generation.active_generation - 1
      ${projectId === undefined ? '' : `AND cleanup_row.project_id = ${getSqlLiteral(projectId)}`}
      AND NOT EXISTS (
        SELECT 1
        FROM app.project_mart_large_rebuild_state rebuild_state
        WHERE rebuild_state.project_id = cleanup_row.project_id
          AND rebuild_state.refresh_token > 0
          AND rebuild_state.superseded_at IS NULL
          AND rebuild_state.target_generation IS NOT DISTINCT FROM cleanup_row.generation
      )
    GROUP BY cleanup_row.project_id, cleanup_row.generation
    ORDER BY cleanup_row.project_id ASC, cleanup_row.generation ASC
    LIMIT 1
  `
}

const getProjectReviewServingGenerationCleanupBatchSql = ({
  batchSize,
  generation,
  projectId,
  tableName,
}: {
  batchSize: number
  generation: bigint | number | string
  projectId: string
  tableName: ProjectMartLargeRebuildGenerationCleanupTableName
}) => {
  return `
    SELECT
      cleanup_row.project_id AS projectId,
      CAST(cleanup_row.generation AS VARCHAR) AS generation,
      cleanup_row.rowid AS rowId
    FROM ${tableName} cleanup_row
    INNER JOIN app.project_review_serving_generation generation
      ON generation.project_id = cleanup_row.project_id
    WHERE cleanup_row.project_id = ${getSqlLiteral(projectId)}
      AND cleanup_row.generation IS NOT DISTINCT FROM ${getProjectReviewServingCleanupGenerationSql(generation)}
      AND cleanup_row.generation < generation.active_generation - 1
      AND NOT EXISTS (
        SELECT 1
        FROM app.project_mart_large_rebuild_state rebuild_state
        WHERE rebuild_state.project_id = cleanup_row.project_id
          AND rebuild_state.refresh_token > 0
          AND rebuild_state.superseded_at IS NULL
          AND rebuild_state.target_generation IS NOT DISTINCT FROM cleanup_row.generation
      )
    ORDER BY cleanup_row.rowid ASC
    LIMIT ${Math.max(1, Math.floor(batchSize))}
  `
}

const getProjectReviewServingGenerationCleanupDeleteSql = ({
  generation,
  leaseExpiresAt,
  projectId,
  rowIds,
  tableName,
  workerId,
}: {
  generation: bigint | number | string
  leaseExpiresAt: Date
  projectId: string
  rowIds: Array<bigint | number | string>
  tableName: ProjectMartLargeRebuildGenerationCleanupTableName
  workerId: string
}) => {
  const leaseId = getMaintenanceWorkLeaseService().getMaintenanceWorkLeaseId({
    projectId,
    queueId: `generation:${generation}`,
    scopeKind: 'queue',
    workKind: 'review_index_serving_generation_cleanup',
  })

  return `
    DELETE FROM ${tableName}
    WHERE rowid IN (${rowIds
      .map((rowId) => {
        return getSqlLiteral(rowId)
      })
      .join(', ')})
      AND project_id = ${getSqlLiteral(projectId)}
      AND generation IS NOT DISTINCT FROM ${getProjectReviewServingCleanupGenerationSql(generation)}
      AND EXISTS (
        SELECT 1
        FROM app.maintenance_work_lease cleanup_lease
        WHERE cleanup_lease.id = ${getSqlLiteral(leaseId)}
          AND cleanup_lease.consumer_id = ${getSqlLiteral(workerId)}
          AND cleanup_lease.completed_at IS NULL
          AND cleanup_lease.lease_expires_at IS NOT NULL
          AND cleanup_lease.lease_expires_at >= ${getTimestampLiteral(leaseExpiresAt)}
      )
      AND EXISTS (
        SELECT 1
        FROM app.project_review_serving_generation active_generation
        WHERE active_generation.project_id = ${getSqlLiteral(projectId)}
          AND ${tableName}.generation < active_generation.active_generation - 1
          AND ${tableName}.generation <> active_generation.active_generation
          AND ${tableName}.generation <> active_generation.active_generation - 1
      )
      AND NOT EXISTS (
        SELECT 1
        FROM app.project_mart_large_rebuild_state rebuild_state
        WHERE rebuild_state.project_id = ${getSqlLiteral(projectId)}
          AND rebuild_state.refresh_token > 0
          AND rebuild_state.superseded_at IS NULL
          AND rebuild_state.target_generation IS NOT DISTINCT FROM ${tableName}.generation
      )
    RETURNING project_id AS projectId;
  `
}

const getProjectReviewServingGenerationCleanupDeleteRetryParts = (rowIds: Array<bigint | number | string>) => {
  const middleIndex = Math.ceil(rowIds.length / 2)

  return [rowIds.slice(0, middleIndex), rowIds.slice(middleIndex)] as const
}

const isProjectReviewServingGenerationCleanupRetryableError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)

  return projectReviewServingGenerationCleanupRetryableErrorFragments.some((fragment) => {
    return message.includes(fragment)
  })
}

const getProjectScopeSourceBatch = async (
  {batchSize = defaultProjectMartLargeRebuildBatchSize, cursor = null, projectId}: GetProjectScopeBatchParams,
  dependencies: ProjectMartLargeRebuildExecutorDependencies = defaultProjectMartLargeRebuildExecutorDependencies,
) => {
  return dependencies.database.queryJson<ProjectMartLargeRebuildScopeBatchRow>(
    getProjectScopeSourceBatchSql({batchSize, cursor, projectId}),
  )
}

const getProjectScopeMartBatch = async (
  {batchSize = defaultProjectMartLargeRebuildBatchSize, cursor = null, projectId}: GetProjectScopeBatchParams,
  dependencies: ProjectMartLargeRebuildExecutorDependencies = defaultProjectMartLargeRebuildExecutorDependencies,
) => {
  return dependencies.database.queryJson<ProjectMartLargeRebuildScopeBatchRow>(
    getProjectScopeMartBatchSql({batchSize, cursor, projectId}),
  )
}

const getNextBatchCursor = (rows: ProjectMartLargeRebuildScopeBatchRow[]) => {
  const [lastRow] = rows.slice(-1)

  return lastRow ? {articleCreatedAt: lastRow.articleCreatedAt, articleId: lastRow.articleId} : null
}

const resetProjectScope = async (
  projectId: string,
  dependencies: ProjectMartLargeRebuildExecutorDependencies = defaultProjectMartLargeRebuildExecutorDependencies,
) => {
  await dependencies.database.run(getProjectScopeResetSql(projectId))
}

const rebuildProjectScopeBatch = async (
  projectId: string,
  rows: ProjectMartLargeRebuildScopeBatchRow[],
  dependencies: ProjectMartLargeRebuildExecutorDependencies = defaultProjectMartLargeRebuildExecutorDependencies,
) => {
  if (rows.length === 0) {
    return
  }

  await dependencies.database.run(getProjectScopeBatchInsertSql(projectId, rows))
}

const rebuildProjectJudgmentFactBatch = async (
  projectId: string,
  articleIds: string[],
  dependencies: ProjectMartLargeRebuildExecutorDependencies = defaultProjectMartLargeRebuildExecutorDependencies,
) => {
  if (articleIds.length === 0) {
    return
  }

  await dependencies.database.run(getProjectJudgmentFactBatchInsertSql(projectId, articleIds))
}

const resetProjectPromptAnswerFact = async (
  projectId: string,
  dependencies: ProjectMartLargeRebuildExecutorDependencies = defaultProjectMartLargeRebuildExecutorDependencies,
) => {
  await dependencies.database.run(getProjectPromptAnswerFactResetSql(projectId))
}

const createProjectPromptAnswerFactLookupIndex = async (
  dependencies: ProjectMartLargeRebuildExecutorDependencies = defaultProjectMartLargeRebuildExecutorDependencies,
) => {
  await dependencies.database.run(getProjectPromptAnswerFactLookupIndexCreateSql())
}

const rebuildProjectPromptAnswerFactBatch = async (
  projectId: string,
  articleIds: string[],
  dependencies: ProjectMartLargeRebuildExecutorDependencies = defaultProjectMartLargeRebuildExecutorDependencies,
) => {
  if (articleIds.length === 0) {
    return
  }

  await dependencies.database.run(getProjectPromptAnswerFactBatchInsertSql(projectId, articleIds))
}

const rebuildProjectReviewAnswerDictionaryBatch = async (
  projectId: string,
  articleIds: string[],
  dependencies: ProjectMartLargeRebuildExecutorDependencies = defaultProjectMartLargeRebuildExecutorDependencies,
) => {
  if (articleIds.length === 0) {
    return
  }

  await dependencies.database.run(getProjectReviewAnswerDictionaryMissingBatchInsertSql(projectId, articleIds))
}

const setupProjectReviewServingStaging = async (
  projectId: string,
  targetGeneration: number,
  dependencies: ProjectMartLargeRebuildExecutorDependencies = defaultProjectMartLargeRebuildExecutorDependencies,
) => {
  await dependencies.database.run(getProjectReviewServingSetupSql(projectId, targetGeneration))
}

const rebuildProjectReviewArticleFilterMemberBatch = async (
  projectId: string,
  articleIds: string[],
  targetGeneration: number,
  dependencies: ProjectMartLargeRebuildExecutorDependencies = defaultProjectMartLargeRebuildExecutorDependencies,
) => {
  if (articleIds.length === 0) {
    return
  }

  await dependencies.database.run(
    getProjectReviewArticleFilterMemberBatchInsertSql(projectId, articleIds, targetGeneration),
  )
}

const resetProjectReviewArticleRollup = async (
  projectId: string,
  dependencies: ProjectMartLargeRebuildExecutorDependencies = defaultProjectMartLargeRebuildExecutorDependencies,
) => {
  await dependencies.database.run(getProjectReviewArticleRollupResetSql(projectId))
}

const rebuildProjectReviewArticleRollupBatch = async (
  projectId: string,
  articleIds: string[],
  dependencies: ProjectMartLargeRebuildExecutorDependencies = defaultProjectMartLargeRebuildExecutorDependencies,
) => {
  if (articleIds.length === 0) {
    return
  }

  await dependencies.database.run(getProjectReviewArticleRollupBatchInsertSql(projectId, articleIds))
}

const rebuildProjectReviewServingBatch = async (
  projectId: string,
  articleIds: string[],
  targetGeneration: number,
  dependencies: ProjectMartLargeRebuildExecutorDependencies = defaultProjectMartLargeRebuildExecutorDependencies,
) => {
  if (articleIds.length === 0) {
    return
  }

  await dependencies.database.run(getProjectReviewServingBatchInsertSql(projectId, articleIds, targetGeneration))
}

const getProjectReviewServingGenerationCleanupBatchRows = async (
  {
    batchSize,
    generation,
    projectId,
    tableName,
  }: {
    batchSize: number
    generation: bigint | number | string
    projectId: string
    tableName: ProjectMartLargeRebuildGenerationCleanupTableName
  },
  dependencies: ProjectMartLargeRebuildExecutorDependencies,
) => {
  return dependencies.database.queryJson<ProjectMartLargeRebuildGenerationCleanupBatchRow>(
    getProjectReviewServingGenerationCleanupBatchSql({batchSize, generation, projectId, tableName}),
  )
}

const deleteProjectReviewServingGenerationCleanupRowIds = async (
  {
    generation,
    leaseExpiresAt,
    projectId,
    rowIds,
    tableName,
    workerId,
  }: {
    generation: bigint | number | string
    leaseExpiresAt: Date
    projectId: string
    rowIds: Array<bigint | number | string>
    tableName: ProjectMartLargeRebuildGenerationCleanupTableName
    workerId: string
  },
  dependencies: ProjectMartLargeRebuildExecutorDependencies,
): Promise<number> => {
  return rowIds.length === 0
    ? Promise.resolve(0)
    : dependencies.database
        .queryJson<{projectId: string}>(
          getProjectReviewServingGenerationCleanupDeleteSql({
            generation,
            leaseExpiresAt,
            projectId,
            rowIds,
            tableName,
            workerId,
          }),
        )
        .then((deletedRows) => {
          return deletedRows.length
        })
        .catch((error) => {
          return !isProjectReviewServingGenerationCleanupRetryableError(error) || rowIds.length === 1
            ? Promise.reject(error)
            : deleteProjectReviewServingGenerationCleanupRowIds(
                {
                  generation,
                  leaseExpiresAt,
                  projectId,
                  rowIds: getProjectReviewServingGenerationCleanupDeleteRetryParts(rowIds)[0],
                  tableName,
                  workerId,
                },
                dependencies,
              ).then((deletedLeftCount) => {
                return deleteProjectReviewServingGenerationCleanupRowIds(
                  {
                    generation,
                    leaseExpiresAt,
                    projectId,
                    rowIds: getProjectReviewServingGenerationCleanupDeleteRetryParts(rowIds)[1],
                    tableName,
                    workerId,
                  },
                  dependencies,
                ).then((deletedRightCount) => {
                  return deletedLeftCount + deletedRightCount
                })
              })
        })
}

const deleteProjectReviewServingGenerationCleanupBatch = async (
  {
    batchSize,
    generation,
    leaseExpiresAt,
    projectId,
    tableName,
    workerId,
  }: {
    batchSize: number
    generation: bigint | number | string
    leaseExpiresAt: Date
    projectId: string
    tableName: ProjectMartLargeRebuildGenerationCleanupTableName
    workerId: string
  },
  dependencies: ProjectMartLargeRebuildExecutorDependencies,
): Promise<number> => {
  const batchRows = await getProjectReviewServingGenerationCleanupBatchRows(
    {batchSize, generation, projectId, tableName},
    dependencies,
  )
  const rowIds = batchRows.map((row) => {
    return row.rowId
  })

  return rowIds.length === 0
    ? Promise.resolve(0)
    : deleteProjectReviewServingGenerationCleanupRowIds(
        {generation, leaseExpiresAt, projectId, rowIds, tableName, workerId},
        dependencies,
      )
}

const getProjectReviewServingGenerationCleanupTarget = async (
  {projectId, tableName}: {projectId?: string; tableName: ProjectMartLargeRebuildGenerationCleanupTableName},
  dependencies: ProjectMartLargeRebuildExecutorDependencies,
) => {
  const [target] = await dependencies.database.queryJson<ProjectMartLargeRebuildGenerationCleanupTargetRow>(
    getProjectReviewServingGenerationCleanupTargetSql({projectId, tableName}),
  )

  return target ?? null
}

const claimProjectReviewServingGenerationCleanupLease = async ({
  generation,
  leaseMs,
  now,
  projectId,
  tableName,
  workerId,
}: {
  generation: bigint | number | string
  leaseMs: number
  now: Date
  projectId: string
  tableName: ProjectMartLargeRebuildGenerationCleanupTableName
  workerId: string
}) => {
  const lease = await getMaintenanceWorkLeaseService().claimMaintenanceWorkLease({
    consumerId: workerId,
    leaseMs,
    now,
    projectId,
    queueId: `generation:${generation}`,
    recoveryContext: {generation, tableName},
    requiredConsumerRole: 'maintenance-worker',
    scopeKind: 'queue',
    workKind: 'review_index_serving_generation_cleanup',
  })

  return lease?.leaseExpiresAt === null || lease?.leaseExpiresAt === undefined ? null : new Date(lease.leaseExpiresAt)
}

const cleanupProjectReviewServingGenerationsBatch = async (
  {
    batchSize = projectReviewServingGenerationCleanupBatchSize,
    leaseMs = projectReviewServingGenerationCleanupDefaultLeaseMs,
    now,
    projectId,
    workerId = projectReviewServingGenerationCleanupDefaultWorkerId,
  }: {batchSize?: number; leaseMs?: number; now?: Date; projectId?: string; workerId?: string} = {},
  dependencies: ProjectMartLargeRebuildExecutorDependencies = defaultProjectMartLargeRebuildExecutorDependencies,
): Promise<ProjectMartLargeRebuildGenerationCleanupBatchResult> => {
  const normalizedBatchSize = Math.max(1, Math.floor(batchSize))
  const currentNow = now ?? new Date()
  const tables = await projectReviewServingGenerationCleanupTableNames.reduce<
    Promise<Array<{deletedRowCount: number; tableName: ProjectMartLargeRebuildGenerationCleanupTableName}>>
  >((promise, tableName) => {
    return promise.then(async (acc) => {
      const target = await getProjectReviewServingGenerationCleanupTarget({projectId, tableName}, dependencies)
      const leaseExpiresAt =
        target === null
          ? null
          : await claimProjectReviewServingGenerationCleanupLease({
              generation: target.generation,
              leaseMs,
              now: currentNow,
              projectId: target.projectId,
              tableName,
              workerId,
            })
      const deletedRowCount =
        target === null || leaseExpiresAt === null
          ? 0
          : await deleteProjectReviewServingGenerationCleanupBatch(
              {
                batchSize: normalizedBatchSize,
                generation: target.generation,
                leaseExpiresAt,
                projectId: target.projectId,
                tableName,
                workerId,
              },
              dependencies,
            )

      return [...acc, {deletedRowCount, tableName}]
    })
  }, Promise.resolve([]))
  const deletedRowCount = tables.reduce((sum, table) => {
    return sum + table.deletedRowCount
  }, 0)

  return {deletedRowCount, tables}
}

const finalizeProjectReviewServing = async (
  projectId: string,
  targetGeneration: number,
  guard?: {
    expectedRebuildPhase?: string
    expectedRefreshToken?: number
    expectedTargetGeneration?: number | null
    now?: Date
    workerId?: string
  },
  dependencies: ProjectMartLargeRebuildExecutorDependencies = defaultProjectMartLargeRebuildExecutorDependencies,
) => {
  await dependencies.database.run(`
    INSERT INTO app.project_review_serving_generation (
      project_id,
      active_generation,
      generation_updated_at
    ) VALUES (
      ${getSqlLiteral(projectId)},
      0,
      current_timestamp
    ) ON CONFLICT(project_id) DO NOTHING
  `)

  const [promoted] = await dependencies.database.queryJson<{activeGeneration: number}>(
    getProjectReviewServingPromoteSql(projectId, targetGeneration, guard),
  )

  return Boolean(promoted)
}

const projectMartLargeRebuildExecutor = {
  cleanupProjectReviewServingGenerationsBatch,
  createProjectPromptAnswerFactLookupIndex,
  finalizeProjectReviewServing,
  getNextBatchCursor,
  getProjectScopeMartBatch,
  getProjectScopeSourceBatch,
  rebuildProjectJudgmentFactBatch,
  rebuildProjectPromptAnswerFactBatch,
  rebuildProjectScopeBatch,
  rebuildProjectReviewAnswerDictionaryBatch,
  rebuildProjectReviewArticleFilterMemberBatch,
  rebuildProjectReviewArticleRollupBatch,
  rebuildProjectReviewServingBatch,
  resetProjectPromptAnswerFact,
  resetProjectScope,
  resetProjectReviewArticleRollup,
  setupProjectReviewServingStaging,
}

export const getProjectMartLargeRebuildExecutor = () => {
  return projectMartLargeRebuildExecutor
}

export type {
  GetProjectScopeBatchParams,
  ProjectMartLargeRebuildBatchCursor,
  ProjectMartLargeRebuildExecutorDependencies,
  ProjectMartLargeRebuildScopeBatchRow,
}
