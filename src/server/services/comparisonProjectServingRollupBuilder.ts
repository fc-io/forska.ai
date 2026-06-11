import {
  type ComparisonProjectDifferenceFilter,
  comparisonProjectDifferenceFilters,
} from '../../utils/comparisonProjectDifferenceFilter.ts'
import {type ComparisonProjectRowFilter, comparisonProjectRowFilters} from '../../utils/comparisonProjectRowFilter.ts'
import {getAppDatabaseService} from './appDatabaseService.ts'
import {getSqlLiteral} from './appQueryHelpers.ts'
import {
  comparisonProjectServingGenerationConfigTables,
  ensureComparisonProjectServingGenerationConfig,
  getComparisonProjectServingGenerationSql,
} from './comparisonProjectServingGenerationConfig.ts'
import {
  getScopedArticleCombinedMetadataExpression,
  getScopedArticleExternalIdExpression,
} from './scopedArticleReadAdapter.ts'

type ComparisonProjectServingRollupBuilderRunner = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
}

type ComparisonProjectServingRollupBuilderParams = {comparisonProjectId: string; generation: number}

type ComparisonProjectArticleRollupBuilderParams = ComparisonProjectServingRollupBuilderParams & {articleIds?: string[]}

type ComparisonProjectFilterStatsBuilderParams = ComparisonProjectServingRollupBuilderParams & {
  differenceFilter?: ComparisonProjectDifferenceFilter
  rowFilter?: ComparisonProjectRowFilter
}

type ComparisonProjectServingRollupBuilderDependencies = {
  queryJson?: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
}

type ComparisonProjectArticleRollupBatch = {articleIds: string[]; hasMore: boolean}

const comparisonArticleServingTable = 'mart.comparison_article_serving'
const comparisonCellServingTable = 'mart.comparison_cell_serving'
const comparisonFilterStatsTable = 'mart.comparison_filter_stats'
const comparisonScopedImportAlias = 'selected_import'
const comparisonProjectServingArticleRollupBatchSize = 1000
const chineseArticleCategory = 'chinese'
const nonChineseArticleCategory = 'non_chinese'
const cjkHanScriptPattern = '\\p{Han}'
const chineseLanguageValues = ['zh', 'zho', 'chi', 'chinese', 'mandarin', 'cantonese', 'putonghua', 'guoyu', 'hanyu']
const articleLanguageMetadataPaths = [
  '$.language',
  '$.language.code',
  '$.language.name',
  '$.language.value',
  '$.lang',
  '$.languageCode',
  '$.language_code',
  '$.articleLanguage',
  '$.article_language',
  '$.locale',
  '$.languages[0]',
  '$.languageCodes[0]',
  '$.language_codes[0]',
  '$.metadata.language',
  '$.metadata.languageCode',
  '$.source.language',
  '$.openalex.language',
  '$.crossref.language',
  '$.pubmed.language',
] as const

const getDefaultComparisonProjectServingRollupBuilderDependencies = (): ComparisonProjectServingRollupBuilderRunner => {
  const database = getAppDatabaseService()

  return {queryJson: database.queryJsonBackground, run: database.runBackground}
}

const getNormalizedLanguageSql = (languageExpression: string) => {
  return `LOWER(REPLACE(REPLACE(TRIM(${languageExpression}), '_', '-'), ' ', '-'))`
}

const getChineseLanguageConditionSql = (languageExpression: string) => {
  const normalizedLanguageExpression = getNormalizedLanguageSql(languageExpression)

  return `(${normalizedLanguageExpression} IN (${chineseLanguageValues.map(getSqlLiteral).join(', ')})
          OR ${normalizedLanguageExpression} LIKE 'zh-%')`
}

const getChineseLanguageMetadataConditionSql = (metadataExpression: string) => {
  return `(${metadataExpression} IS NOT NULL
        AND (${articleLanguageMetadataPaths
          .map((path) => {
            return getChineseLanguageConditionSql(`json_extract_string(${metadataExpression}, ${getSqlLiteral(path)})`)
          })
          .join('\n          OR ')}))`
}

const getChineseScriptConditionSql = (titleExpression: string, abstractExpression: string) => {
  return `(regexp_matches(COALESCE(${titleExpression}, ''), ${getSqlLiteral(cjkHanScriptPattern)})
          OR regexp_matches(COALESCE(${abstractExpression}, ''), ${getSqlLiteral(cjkHanScriptPattern)}))`
}

const getComparisonProjectArticleCategorySql = ({
  abstractExpression,
  metadataExpression,
  titleExpression,
}: {
  abstractExpression: string
  metadataExpression: string
  titleExpression: string
}) => {
  return `CASE
        WHEN ${getChineseLanguageMetadataConditionSql(metadataExpression)}
          OR ${getChineseScriptConditionSql(titleExpression, abstractExpression)}
          THEN ${getSqlLiteral(chineseArticleCategory)}
        ELSE ${getSqlLiteral(nonChineseArticleCategory)}
      END`
}

const getComparisonProjectScopeCtesSql = () => {
  return `
    source_project_scope AS (
      SELECT pa.article_id
      FROM app.comparison_project_source_project cpsp
      INNER JOIN comparison_project cp ON cp.id = cpsp.comparison_project_id
      INNER JOIN app.project_article pa ON pa.project_id = cpsp.source_project_id
      GROUP BY pa.article_id
    ),
    import_route_scope AS (
      SELECT air.article_id
      FROM app.comparison_project_import_route cpir
      INNER JOIN comparison_project cp ON cp.id = cpir.comparison_project_id
      INNER JOIN app.article_import_route air ON air.import_route_id = cpir.import_route_id
      GROUP BY air.article_id
    ),
    scope_config AS (
      SELECT
        (
          SELECT COUNT(*)
          FROM app.comparison_project_source_project cpsp
          INNER JOIN comparison_project cp ON cp.id = cpsp.comparison_project_id
        ) AS source_project_link_count,
        (
          SELECT COUNT(*)
          FROM app.comparison_project_import_route cpir
          INNER JOIN comparison_project cp ON cp.id = cpir.comparison_project_id
        ) AS import_route_link_count
    ),
    scoped_article AS (
      SELECT a.id AS article_id
      FROM app.article a
      CROSS JOIN scope_config
      WHERE (
        scope_config.source_project_link_count > 0
        AND EXISTS (
          SELECT 1
          FROM source_project_scope source_scope
          WHERE source_scope.article_id = a.id
        )
      )
      OR (
        scope_config.source_project_link_count = 0
        AND scope_config.import_route_link_count > 0
        AND EXISTS (
          SELECT 1
          FROM import_route_scope import_scope
          WHERE import_scope.article_id = a.id
        )
      )
      OR (
        scope_config.source_project_link_count = 0
        AND scope_config.import_route_link_count = 0
      )
    )
  `
}

const getComparisonProjectArticleBatchCteSql = (articleIds: string[] | undefined) => {
  return articleIds
    ? `article_batch(article_id) AS (
      VALUES ${articleIds
        .map((articleId) => {
          return `(${getSqlLiteral(articleId)})`
        })
        .join(', ')}
    )`
    : null
}

const getComparisonProjectArticleBatchJoinSql = (articleIdExpression: string, useArticleBatch: boolean) => {
  return useArticleBatch ? `INNER JOIN article_batch ON article_batch.article_id = ${articleIdExpression}` : ''
}

const getComparisonProjectArticleCellScopeJoinSql = (useArticleBatch: boolean) => {
  return useArticleBatch ? '' : 'INNER JOIN scoped_article ON scoped_article.article_id = cell.article_id'
}

const getComparisonProjectScopedImportSelectionCteSql = ({useArticleBatch}: {useArticleBatch: boolean}) => {
  return `
    comparison_article_import_candidate AS (
      SELECT
        0 AS scope_order,
        cpsp.source_project_id,
        air.article_id,
        air.external_article_id,
        air.import_metadata,
        air.import_route_id,
        air.id AS import_record_id
      FROM app.comparison_project_source_project cpsp
      INNER JOIN comparison_project cp ON cp.id = cpsp.comparison_project_id
      INNER JOIN app.project_import_route pir ON pir.project_id = cpsp.source_project_id
      INNER JOIN app.article_import_route air ON air.import_route_id = pir.import_route_id
      ${getComparisonProjectArticleBatchJoinSql('air.article_id', useArticleBatch)}

      UNION ALL

      SELECT
        1 AS scope_order,
        NULL AS source_project_id,
        air.article_id,
        air.external_article_id,
        air.import_metadata,
        air.import_route_id,
        air.id AS import_record_id
      FROM app.comparison_project_import_route cpir
      INNER JOIN comparison_project cp ON cp.id = cpir.comparison_project_id
      INNER JOIN app.article_import_route air ON air.import_route_id = cpir.import_route_id
      ${getComparisonProjectArticleBatchJoinSql('air.article_id', useArticleBatch)}
    ),
    selected_comparison_article_import AS (
      SELECT
        article_id,
        external_article_id,
        import_metadata
      FROM (
        SELECT
          comparison_article_import_candidate.article_id,
          comparison_article_import_candidate.external_article_id,
          comparison_article_import_candidate.import_metadata,
          ROW_NUMBER() OVER (
            PARTITION BY comparison_article_import_candidate.article_id
            ORDER BY
              comparison_article_import_candidate.scope_order ASC,
              comparison_article_import_candidate.source_project_id ASC NULLS LAST,
              comparison_article_import_candidate.import_route_id ASC,
              comparison_article_import_candidate.import_record_id ASC
          ) AS selected_rank
        FROM comparison_article_import_candidate
        CROSS JOIN scope_config
        WHERE (
          scope_config.source_project_link_count > 0
          AND comparison_article_import_candidate.scope_order = 0
        )
        OR (
          scope_config.source_project_link_count = 0
          AND scope_config.import_route_link_count > 0
          AND comparison_article_import_candidate.scope_order = 1
        )
      ) ranked_comparison_article_import
      WHERE selected_rank = 1
    )
  `
}

const getMaterializedComparisonProjectRequiredColumnCteSql = ({
  comparisonProjectLiteral,
  generationLiteral,
}: {
  comparisonProjectLiteral: string
  generationLiteral: string
}) => {
  return `
    required_column AS (
      SELECT
        column_id,
        kind,
        prompt_id
      FROM ${comparisonProjectServingGenerationConfigTables.requiredColumn}
      WHERE comparison_project_id = ${comparisonProjectLiteral}
        AND generation = ${generationLiteral}
    )
  `
}

const getComparisonProjectArticleServingInsertSql = ({
  articleIds,
  comparisonProjectId,
  generation,
}: ComparisonProjectArticleRollupBuilderParams) => {
  const comparisonProjectLiteral = getSqlLiteral(comparisonProjectId)
  const generationLiteral = getComparisonProjectServingGenerationSql(generation)
  const articleBatchCte = getComparisonProjectArticleBatchCteSql(articleIds)
  const useArticleBatch = articleBatchCte !== null
  const articleExternalIdExpression = getScopedArticleExternalIdExpression({
    articleAlias: 'article',
    scopedImportAlias: comparisonScopedImportAlias,
  })
  const sourceMetadataExpression = getScopedArticleCombinedMetadataExpression({
    articleAlias: 'article',
    scopedImportAlias: comparisonScopedImportAlias,
  })

  return `
    INSERT INTO ${comparisonArticleServingTable} (
      comparison_project_id,
      generation,
      article_id,
      article_created_at,
      article_updated_at,
      article_title,
      article_summary,
      article_external_id,
      journal_title,
      url,
      full_text_pdf,
      full_text_fetched_at,
      full_text_conversion_status,
      source_metadata,
      article_category,
      row_sort_created_at,
      row_sort_title,
      row_sort_article_id,
      answered_prompt_count,
      answered_column_count,
      answered_llm_column_count,
      answered_human_column_count,
      required_column_count,
      required_llm_column_count,
      required_human_column_count,
      has_all_llm_columns,
      has_all_human_columns,
      has_multiple_answers,
      has_llm_answered_yes,
      has_llm_answered_no,
      has_llm_answered_maybe,
      has_human_answered_yes,
      has_human_answered_no,
      has_human_answered_maybe,
      is_fully_answered,
      passes_row_filter_multiple_answers,
      passes_row_filter_fully_answered,
      passes_row_filter_all,
      has_human_vs_llm_overlap,
      has_human_vs_llm_difference,
      has_human_vs_llm_true_conflict,
      has_llm_vs_llm_difference,
      has_any_disagreement,
      passes_difference_filter_human_vs_llm_overlap,
      passes_difference_filter_human_vs_llm,
      passes_difference_filter_human_vs_llm_true_conflict,
      passes_difference_filter_llm_vs_llm,
      passes_difference_filter_any_disagreement,
      passes_difference_filter_all,
      has_conflict,
      serving_updated_at
    )
    WITH comparison_project AS (
      SELECT *
      FROM app.comparison_project cp
      WHERE cp.id = ${comparisonProjectLiteral}
    ),
    project_mode AS (
      SELECT
        cp.compare_with_humans = TRUE
          AND COALESCE(cp.human_judgment_mode, 'prompt') = 'summary' AS is_summary_mode
      FROM comparison_project cp
    ),
    ${articleBatchCte ? `${articleBatchCte},` : ''}
    ${getComparisonProjectScopeCtesSql()},
    ${getMaterializedComparisonProjectRequiredColumnCteSql({comparisonProjectLiteral, generationLiteral})},
    ${getComparisonProjectScopedImportSelectionCteSql({useArticleBatch})},
    required_column_counts AS (
      SELECT
        CAST(COUNT(*) AS INTEGER) AS required_column_count,
        CAST(SUM(CASE WHEN kind = 'llm' THEN 1 ELSE 0 END) AS INTEGER) AS required_llm_column_count,
        CAST(SUM(CASE WHEN kind = 'human' THEN 1 ELSE 0 END) AS INTEGER) AS required_human_column_count
      FROM required_column
    ),
    required_prompt_column_counts AS (
      SELECT
        prompt_id,
        SUM(CASE WHEN kind = 'human' THEN 1 ELSE 0 END) AS human_column_count,
        SUM(CASE WHEN kind = 'llm' THEN 1 ELSE 0 END) AS llm_column_count
      FROM required_column
      GROUP BY prompt_id
    ),
    difference_filter_availability AS (
      SELECT
        COALESCE(BOOL_OR(human_column_count > 0 AND llm_column_count > 0), FALSE) AS has_human_vs_llm_filter,
        COALESCE(BOOL_OR(llm_column_count > 1), FALSE) AS has_llm_vs_llm_filter
      FROM required_prompt_column_counts
    ),
    article_cell AS (
      SELECT cell.*
      FROM ${comparisonCellServingTable} cell
      INNER JOIN required_column ON required_column.column_id = cell.column_id
      ${getComparisonProjectArticleCellScopeJoinSql(useArticleBatch)}
      ${getComparisonProjectArticleBatchJoinSql('cell.article_id', useArticleBatch)}
      WHERE cell.comparison_project_id = ${comparisonProjectLiteral}
        AND cell.generation = ${generationLiteral}
    ),
    article_cell_rollup AS (
      SELECT
        article_id,
        CAST(COUNT(DISTINCT prompt_id) AS INTEGER) AS answered_prompt_count,
        CAST(COUNT(DISTINCT column_id) AS INTEGER) AS answered_column_count,
        CAST(COUNT(DISTINCT column_id) FILTER (WHERE kind = 'llm') AS INTEGER) AS answered_llm_column_count,
        CAST(COUNT(DISTINCT column_id) FILTER (WHERE kind = 'human') AS INTEGER) AS answered_human_column_count
      FROM article_cell
      GROUP BY article_id
    ),
    cell_answer AS (
      SELECT
        article_cell.article_id,
        article_cell.prompt_id,
        article_cell.column_id,
        article_cell.kind,
        TRIM(answer.answer_value) AS answer_value
      FROM article_cell,
        UNNEST(article_cell.normalized_answers) AS answer(answer_value)
      WHERE article_cell.normalized_answers IS NOT NULL
        AND ARRAY_LENGTH(article_cell.normalized_answers) > 0
        AND NULLIF(TRIM(answer.answer_value), '') IS NOT NULL
    ),
    article_answer_value_rollup AS (
      SELECT
        article_id,
        COALESCE(BOOL_OR(kind = 'llm' AND LOWER(answer_value) = 'yes'), FALSE) AS has_llm_answered_yes,
        COALESCE(BOOL_OR(kind = 'llm' AND LOWER(answer_value) = 'no'), FALSE) AS has_llm_answered_no,
        COALESCE(BOOL_OR(kind = 'llm' AND LOWER(answer_value) = 'maybe'), FALSE) AS has_llm_answered_maybe,
        COALESCE(BOOL_OR(kind = 'human' AND LOWER(answer_value) = 'yes'), FALSE) AS has_human_answered_yes,
        COALESCE(BOOL_OR(kind = 'human' AND LOWER(answer_value) = 'no'), FALSE) AS has_human_answered_no,
        COALESCE(BOOL_OR(kind = 'human' AND LOWER(answer_value) = 'maybe'), FALSE) AS has_human_answered_maybe
      FROM cell_answer
      GROUP BY article_id
    ),
    prompt_answer_count AS (
      SELECT
        article_id,
        prompt_id,
        COUNT(DISTINCT column_id) AS all_answered_count,
        COUNT(DISTINCT column_id) FILTER (WHERE kind = 'human') AS human_answered_count,
        COUNT(DISTINCT column_id) FILTER (WHERE kind = 'llm') AS llm_answered_count
      FROM article_cell
      GROUP BY article_id, prompt_id
    ),
    prompt_answer_value_count AS (
      SELECT
        article_id,
        prompt_id,
        COUNT(DISTINCT answer_value) AS all_answer_count,
        COUNT(DISTINCT answer_value) FILTER (WHERE kind = 'human') AS human_answer_count,
        COUNT(DISTINCT answer_value) FILTER (WHERE kind = 'llm') AS llm_answer_count,
        COUNT(DISTINCT CASE
          WHEN kind = 'human' AND LOWER(answer_value) IN ('yes', 'maybe') THEN 'include'
          WHEN kind = 'human' AND LOWER(answer_value) = 'no' THEN 'exclude'
          ELSE NULL
        END) AS human_binary_decision_count,
        COUNT(DISTINCT CASE
          WHEN kind = 'llm' AND LOWER(answer_value) IN ('yes', 'maybe') THEN 'include'
          WHEN kind = 'llm' AND LOWER(answer_value) = 'no' THEN 'exclude'
          ELSE NULL
        END) AS llm_binary_decision_count,
        COUNT(DISTINCT CASE
          WHEN LOWER(answer_value) IN ('yes', 'maybe') THEN 'include'
          WHEN LOWER(answer_value) = 'no' THEN 'exclude'
          ELSE NULL
        END) AS all_binary_decision_count
      FROM cell_answer
      GROUP BY article_id, prompt_id
    ),
    prompt_difference AS (
      SELECT
        prompt_answer_count.article_id,
        prompt_answer_count.prompt_id,
        prompt_answer_count.human_answered_count > 0
          AND prompt_answer_count.llm_answered_count > 0 AS has_human_vs_llm_overlap,
        prompt_answer_count.human_answered_count > 0
          AND prompt_answer_count.llm_answered_count > 0
          AND COALESCE(prompt_answer_value_count.all_answer_count, 0) > 1 AS has_human_vs_llm_difference,
        COALESCE(prompt_answer_value_count.human_binary_decision_count, 0) > 0
          AND COALESCE(prompt_answer_value_count.llm_binary_decision_count, 0) > 0
          AND COALESCE(prompt_answer_value_count.all_binary_decision_count, 0) > 1 AS has_human_vs_llm_true_conflict,
        prompt_answer_count.llm_answered_count > 1
          AND COALESCE(prompt_answer_value_count.llm_answer_count, 0) > 1 AS has_llm_vs_llm_difference,
        prompt_answer_count.all_answered_count > 1
          AND COALESCE(prompt_answer_value_count.all_answer_count, 0) > 1 AS has_any_disagreement
      FROM prompt_answer_count
      LEFT JOIN prompt_answer_value_count
        ON prompt_answer_value_count.article_id = prompt_answer_count.article_id
       AND prompt_answer_value_count.prompt_id = prompt_answer_count.prompt_id
    ),
    article_difference_rollup AS (
      SELECT
        article_id,
        COALESCE(BOOL_OR(has_human_vs_llm_overlap), FALSE) AS has_human_vs_llm_overlap,
        COALESCE(BOOL_OR(has_human_vs_llm_difference), FALSE) AS has_human_vs_llm_difference,
        COALESCE(BOOL_OR(has_human_vs_llm_true_conflict), FALSE) AS has_human_vs_llm_true_conflict,
        COALESCE(BOOL_OR(has_llm_vs_llm_difference), FALSE) AS has_llm_vs_llm_difference,
        COALESCE(BOOL_OR(has_any_disagreement), FALSE) AS has_any_disagreement
      FROM prompt_difference
      GROUP BY article_id
    ),
    rollup_scoped_article AS (
      SELECT source_project_scope.article_id
      FROM source_project_scope
      ${getComparisonProjectArticleBatchJoinSql('source_project_scope.article_id', useArticleBatch)}
      CROSS JOIN scope_config
      WHERE scope_config.source_project_link_count > 0

      UNION

      SELECT import_route_scope.article_id
      FROM import_route_scope
      ${getComparisonProjectArticleBatchJoinSql('import_route_scope.article_id', useArticleBatch)}
      CROSS JOIN scope_config
      WHERE scope_config.source_project_link_count = 0
        AND scope_config.import_route_link_count > 0

      UNION

      SELECT article_cell_rollup.article_id
      FROM article_cell_rollup
      CROSS JOIN scope_config
      WHERE scope_config.source_project_link_count = 0
        AND scope_config.import_route_link_count = 0
    ),
    article_rollup AS (
      SELECT
        rollup_scoped_article.article_id,
        COALESCE(article_cell_rollup.answered_prompt_count, 0) AS answered_prompt_count,
        COALESCE(article_cell_rollup.answered_column_count, 0) AS answered_column_count,
        COALESCE(article_cell_rollup.answered_llm_column_count, 0) AS answered_llm_column_count,
        COALESCE(article_cell_rollup.answered_human_column_count, 0) AS answered_human_column_count,
        required_column_counts.required_column_count,
        required_column_counts.required_llm_column_count,
        required_column_counts.required_human_column_count,
        COALESCE(article_cell_rollup.answered_llm_column_count, 0) = required_column_counts.required_llm_column_count AS has_all_llm_columns,
        COALESCE(article_cell_rollup.answered_human_column_count, 0) = required_column_counts.required_human_column_count AS has_all_human_columns,
        CASE
          WHEN project_mode.is_summary_mode THEN COALESCE(article_cell_rollup.answered_column_count, 0) >= 2
          ELSE COALESCE(article_cell_rollup.answered_prompt_count, 0) >= 2
        END AS has_multiple_answers,
        COALESCE(article_answer_value_rollup.has_llm_answered_yes, FALSE) AS has_llm_answered_yes,
        COALESCE(article_answer_value_rollup.has_llm_answered_no, FALSE) AS has_llm_answered_no,
        COALESCE(article_answer_value_rollup.has_llm_answered_maybe, FALSE) AS has_llm_answered_maybe,
        COALESCE(article_answer_value_rollup.has_human_answered_yes, FALSE) AS has_human_answered_yes,
        COALESCE(article_answer_value_rollup.has_human_answered_no, FALSE) AS has_human_answered_no,
        COALESCE(article_answer_value_rollup.has_human_answered_maybe, FALSE) AS has_human_answered_maybe,
        COALESCE(article_difference_rollup.has_human_vs_llm_overlap, FALSE) AS has_human_vs_llm_overlap,
        COALESCE(article_difference_rollup.has_human_vs_llm_difference, FALSE) AS has_human_vs_llm_difference,
        COALESCE(article_difference_rollup.has_human_vs_llm_true_conflict, FALSE) AS has_human_vs_llm_true_conflict,
        COALESCE(article_difference_rollup.has_llm_vs_llm_difference, FALSE) AS has_llm_vs_llm_difference,
        COALESCE(article_difference_rollup.has_any_disagreement, FALSE) AS has_any_disagreement,
        difference_filter_availability.has_human_vs_llm_filter,
        difference_filter_availability.has_llm_vs_llm_filter,
        difference_filter_availability.has_human_vs_llm_filter
          AND difference_filter_availability.has_llm_vs_llm_filter AS has_any_disagreement_filter
      FROM rollup_scoped_article
      CROSS JOIN required_column_counts
      CROSS JOIN project_mode
      CROSS JOIN difference_filter_availability
      LEFT JOIN article_cell_rollup ON article_cell_rollup.article_id = rollup_scoped_article.article_id
      LEFT JOIN article_answer_value_rollup ON article_answer_value_rollup.article_id = rollup_scoped_article.article_id
      LEFT JOIN article_difference_rollup ON article_difference_rollup.article_id = article_cell_rollup.article_id
    ),
    serving_article AS (
      SELECT
        article_rollup.*,
        article.article_created_at,
        article.article_updated_at,
        COALESCE(article.article_title, '') AS article_title,
        article.article_summary,
        ${articleExternalIdExpression} AS article_external_id,
        article.url,
        article.full_text_pdf,
        article.full_text_fetched_at,
        article.full_text_conversion_status,
        ${sourceMetadataExpression} AS source_metadata
      FROM article_rollup
      INNER JOIN app.article article ON article.id = article_rollup.article_id
      LEFT JOIN selected_comparison_article_import ${comparisonScopedImportAlias}
        ON ${comparisonScopedImportAlias}.article_id = article_rollup.article_id
    )
    SELECT
      ${comparisonProjectLiteral} AS comparison_project_id,
      ${generationLiteral} AS generation,
      serving_article.article_id,
      serving_article.article_created_at,
      serving_article.article_updated_at,
      serving_article.article_title,
      serving_article.article_summary,
      serving_article.article_external_id,
      json_extract_string(serving_article.source_metadata, '$.journalTitle') AS journal_title,
      serving_article.url,
      serving_article.full_text_pdf,
      serving_article.full_text_fetched_at,
      serving_article.full_text_conversion_status,
      serving_article.source_metadata,
      ${getComparisonProjectArticleCategorySql({
        abstractExpression: 'serving_article.article_summary',
        metadataExpression: 'serving_article.source_metadata',
        titleExpression: 'serving_article.article_title',
      })} AS article_category,
      serving_article.article_created_at AS row_sort_created_at,
      serving_article.article_title AS row_sort_title,
      serving_article.article_id AS row_sort_article_id,
      serving_article.answered_prompt_count,
      serving_article.answered_column_count,
      serving_article.answered_llm_column_count,
      serving_article.answered_human_column_count,
      serving_article.required_column_count,
      serving_article.required_llm_column_count,
      serving_article.required_human_column_count,
      serving_article.has_all_llm_columns,
      serving_article.has_all_human_columns,
      serving_article.has_multiple_answers,
      serving_article.has_llm_answered_yes,
      serving_article.has_llm_answered_no,
      serving_article.has_llm_answered_maybe,
      serving_article.has_human_answered_yes,
      serving_article.has_human_answered_no,
      serving_article.has_human_answered_maybe,
      serving_article.has_all_llm_columns AND serving_article.has_all_human_columns AS is_fully_answered,
      serving_article.has_multiple_answers AS passes_row_filter_multiple_answers,
      serving_article.has_all_llm_columns AND serving_article.has_all_human_columns AS passes_row_filter_fully_answered,
      TRUE AS passes_row_filter_all,
      serving_article.has_human_vs_llm_overlap,
      serving_article.has_human_vs_llm_difference,
      serving_article.has_human_vs_llm_true_conflict,
      serving_article.has_llm_vs_llm_difference,
      serving_article.has_any_disagreement,
      CASE
        WHEN serving_article.has_human_vs_llm_filter THEN serving_article.has_human_vs_llm_overlap
        ELSE TRUE
      END AS passes_difference_filter_human_vs_llm_overlap,
      CASE
        WHEN serving_article.has_human_vs_llm_filter THEN serving_article.has_human_vs_llm_difference
        ELSE TRUE
      END AS passes_difference_filter_human_vs_llm,
      CASE
        WHEN serving_article.has_human_vs_llm_filter THEN serving_article.has_human_vs_llm_true_conflict
        ELSE TRUE
      END AS passes_difference_filter_human_vs_llm_true_conflict,
      CASE
        WHEN serving_article.has_llm_vs_llm_filter THEN serving_article.has_llm_vs_llm_difference
        ELSE TRUE
      END AS passes_difference_filter_llm_vs_llm,
      CASE
        WHEN serving_article.has_any_disagreement_filter THEN serving_article.has_any_disagreement
        ELSE TRUE
      END AS passes_difference_filter_any_disagreement,
      TRUE AS passes_difference_filter_all,
      serving_article.has_any_disagreement AS has_conflict,
      current_timestamp AS serving_updated_at
    FROM serving_article
  `
}

const getComparisonProjectFilterValuesCteSql = (params: {
  differenceFilter?: ComparisonProjectDifferenceFilter
  rowFilter?: ComparisonProjectRowFilter
}) => {
  const rowFilters = params.rowFilter ? [params.rowFilter] : comparisonProjectRowFilters
  const differenceFilters = params.differenceFilter ? [params.differenceFilter] : comparisonProjectDifferenceFilters
  const rowFilterValues = rowFilters
    .map((rowFilter) => {
      return `(${getSqlLiteral(rowFilter)})`
    })
    .join(', ')
  const differenceFilterValues = differenceFilters
    .map((differenceFilter) => {
      return `(${getSqlLiteral(differenceFilter)})`
    })
    .join(', ')

  return `
    row_filter AS (
      SELECT row_filter
      FROM (
        VALUES ${rowFilterValues}
      ) AS row_filter_value(row_filter)
    ),
    difference_filter AS (
      SELECT difference_filter
      FROM (
        VALUES ${differenceFilterValues}
      ) AS difference_filter_value(difference_filter)
    ),
    filter_combination AS (
      SELECT row_filter.row_filter, difference_filter.difference_filter
      FROM row_filter
      CROSS JOIN difference_filter
    )
  `
}

const getComparisonProjectArticleRowFilterPredicateSql = (rowFilterExpression: string, articleAlias: string) => {
  return `CASE ${rowFilterExpression}
          WHEN 'multiple-answers' THEN ${articleAlias}.passes_row_filter_multiple_answers
          WHEN 'fully-answered' THEN ${articleAlias}.passes_row_filter_fully_answered
          WHEN 'llm-answered-yes' THEN ${articleAlias}.has_llm_answered_yes
          WHEN 'llm-answered-no' THEN ${articleAlias}.has_llm_answered_no
          WHEN 'llm-answered-maybe' THEN ${articleAlias}.has_llm_answered_maybe
          WHEN 'human-answered-yes' THEN ${articleAlias}.has_human_answered_yes
          WHEN 'human-answered-no' THEN ${articleAlias}.has_human_answered_no
          WHEN 'human-answered-maybe' THEN ${articleAlias}.has_human_answered_maybe
          ELSE ${articleAlias}.passes_row_filter_all
        END`
}

const getComparisonProjectArticleDifferenceFilterPredicateSql = (
  differenceFilterExpression: string,
  articleAlias: string,
) => {
  return `CASE ${differenceFilterExpression}
          WHEN 'human-vs-llm-overlap' THEN ${articleAlias}.passes_difference_filter_human_vs_llm_overlap
          WHEN 'human-vs-llm' THEN ${articleAlias}.passes_difference_filter_human_vs_llm
          WHEN 'human-vs-llm-true-conflict' THEN ${articleAlias}.passes_difference_filter_human_vs_llm_true_conflict
          WHEN 'llm-vs-llm' THEN ${articleAlias}.passes_difference_filter_llm_vs_llm
          WHEN 'any-disagreement' THEN ${articleAlias}.passes_difference_filter_any_disagreement
          ELSE ${articleAlias}.passes_difference_filter_all
        END`
}

const getComparisonProjectFilterStatsInsertSql = ({
  comparisonProjectId,
  differenceFilter,
  generation,
  rowFilter,
}: ComparisonProjectFilterStatsBuilderParams) => {
  const comparisonProjectLiteral = getSqlLiteral(comparisonProjectId)
  const generationLiteral = getComparisonProjectServingGenerationSql(generation)
  const rowFilterPredicate = getComparisonProjectArticleRowFilterPredicateSql(
    'filter_combination.row_filter',
    'article',
  )
  const differenceFilterPredicate = getComparisonProjectArticleDifferenceFilterPredicateSql(
    'filter_combination.difference_filter',
    'article',
  )

  return `
    INSERT INTO ${comparisonFilterStatsTable} (
      comparison_project_id,
      generation,
      row_filter,
      difference_filter,
      total_count,
      stats_updated_at
    )
    WITH ${getComparisonProjectFilterValuesCteSql({differenceFilter, rowFilter})},
    member_count AS (
      SELECT
        filter_combination.row_filter,
        filter_combination.difference_filter,
        COUNT(article.article_id) AS total_count
      FROM filter_combination
      LEFT JOIN ${comparisonArticleServingTable} article
        ON article.comparison_project_id = ${comparisonProjectLiteral}
       AND article.generation = ${generationLiteral}
       AND ${rowFilterPredicate}
       AND ${differenceFilterPredicate}
      GROUP BY filter_combination.row_filter, filter_combination.difference_filter
    )
    SELECT
      ${comparisonProjectLiteral} AS comparison_project_id,
      ${generationLiteral} AS generation,
      filter_combination.row_filter,
      filter_combination.difference_filter,
      COALESCE(member_count.total_count, 0) AS total_count,
      current_timestamp AS stats_updated_at
    FROM filter_combination
    LEFT JOIN member_count
      ON member_count.row_filter = filter_combination.row_filter
     AND member_count.difference_filter = filter_combination.difference_filter
  `
}

const getComparisonProjectArticleRollupBatchSql = ({
  comparisonProjectId,
  cursor,
  generation,
}: ComparisonProjectServingRollupBuilderParams & {cursor: string | null}) => {
  const comparisonProjectLiteral = getSqlLiteral(comparisonProjectId)
  const generationLiteral = getComparisonProjectServingGenerationSql(generation)
  const cursorClause = cursor ? `WHERE rollup_scoped_article.article_id > ${getSqlLiteral(cursor)}` : ''

  return `
    WITH comparison_project AS (
      SELECT *
      FROM app.comparison_project cp
      WHERE cp.id = ${comparisonProjectLiteral}
    ),
    ${getComparisonProjectScopeCtesSql()},
    rollup_scoped_article AS (
      SELECT source_project_scope.article_id
      FROM source_project_scope
      CROSS JOIN scope_config
      WHERE scope_config.source_project_link_count > 0

      UNION

      SELECT import_route_scope.article_id
      FROM import_route_scope
      CROSS JOIN scope_config
      WHERE scope_config.source_project_link_count = 0
        AND scope_config.import_route_link_count > 0

      UNION

      SELECT cell.article_id
      FROM ${comparisonCellServingTable} cell
      CROSS JOIN scope_config
      WHERE scope_config.source_project_link_count = 0
        AND scope_config.import_route_link_count = 0
        AND cell.comparison_project_id = ${comparisonProjectLiteral}
        AND cell.generation = ${generationLiteral}
      GROUP BY cell.article_id
    )
    SELECT rollup_scoped_article.article_id AS articleId
    FROM rollup_scoped_article
    ${cursorClause}
    ORDER BY rollup_scoped_article.article_id ASC
    LIMIT ${comparisonProjectServingArticleRollupBatchSize + 1}
  `
}

const getComparisonProjectRollupQueryJson = (dependencies: ComparisonProjectServingRollupBuilderDependencies) => {
  if (dependencies.queryJson) {
    return dependencies.queryJson
  }

  throw new Error('Comparison project serving rollup batching requires queryJson')
}

const ensureComparisonProjectServingRollupGenerationConfig = (
  params: ComparisonProjectServingRollupBuilderParams,
  dependencies: ComparisonProjectServingRollupBuilderDependencies,
) => {
  return ensureComparisonProjectServingGenerationConfig(params, {
    queryJson: getComparisonProjectRollupQueryJson(dependencies),
    run: dependencies.run,
  })
}

const getComparisonProjectArticleRollupBatch = async (
  params: ComparisonProjectServingRollupBuilderParams & {cursor: string | null},
  dependencies: ComparisonProjectServingRollupBuilderDependencies,
): Promise<ComparisonProjectArticleRollupBatch> => {
  const queryJson = getComparisonProjectRollupQueryJson(dependencies)
  const rows = await queryJson<{articleId: string}>(getComparisonProjectArticleRollupBatchSql(params))
  const articleIds = rows.slice(0, comparisonProjectServingArticleRollupBatchSize).map((row) => {
    return row.articleId
  })

  return {articleIds, hasMore: rows.length > comparisonProjectServingArticleRollupBatchSize}
}

const getComparisonProjectArticleRollupBatchCursor = (batch: ComparisonProjectArticleRollupBatch) => {
  return batch.articleIds[batch.articleIds.length - 1] ?? null
}

const insertComparisonProjectArticleRollupBatches = async (
  params: ComparisonProjectServingRollupBuilderParams,
  dependencies: ComparisonProjectServingRollupBuilderDependencies,
  cursor: string | null = null,
): Promise<void> => {
  const batch = await getComparisonProjectArticleRollupBatch({...params, cursor}, dependencies)
  const nextCursor = getComparisonProjectArticleRollupBatchCursor(batch)

  if (batch.articleIds.length === 0 || nextCursor === null) {
    return
  }

  await dependencies.run(getComparisonProjectArticleServingInsertSql({...params, articleIds: batch.articleIds}))

  return batch.hasMore ? insertComparisonProjectArticleRollupBatches(params, dependencies, nextCursor) : undefined
}

const insertComparisonProjectArticleRollups = async (
  params: ComparisonProjectServingRollupBuilderParams,
  dependencies: ComparisonProjectServingRollupBuilderDependencies = getDefaultComparisonProjectServingRollupBuilderDependencies(),
) => {
  await ensureComparisonProjectServingRollupGenerationConfig(params, dependencies)

  return insertComparisonProjectArticleRollupBatches(params, dependencies)
}

const insertComparisonProjectFilterMembers = (
  params: ComparisonProjectServingRollupBuilderParams,
  dependencies: ComparisonProjectServingRollupBuilderDependencies = getDefaultComparisonProjectServingRollupBuilderDependencies(),
) => {
  void params
  void dependencies

  return Promise.resolve()
}

const getComparisonProjectFilterStatsInsertStatements = (params: ComparisonProjectServingRollupBuilderParams) => {
  return comparisonProjectRowFilters.flatMap((rowFilter) => {
    return comparisonProjectDifferenceFilters.map((differenceFilter) => {
      return getComparisonProjectFilterStatsInsertSql({...params, differenceFilter, rowFilter})
    })
  })
}

const runComparisonProjectRollupStatements = async (
  statements: readonly string[],
  dependencies: ComparisonProjectServingRollupBuilderDependencies,
  index = 0,
): Promise<void> => {
  const statement = statements[index]

  if (!statement) {
    return
  }

  await dependencies.run(statement)

  return runComparisonProjectRollupStatements(statements, dependencies, index + 1)
}

const insertComparisonProjectFilterStats = (
  params: ComparisonProjectServingRollupBuilderParams,
  dependencies: ComparisonProjectServingRollupBuilderDependencies = getDefaultComparisonProjectServingRollupBuilderDependencies(),
) => {
  return runComparisonProjectRollupStatements(getComparisonProjectFilterStatsInsertStatements(params), dependencies)
}

const insertComparisonProjectServingRollups = async (
  params: ComparisonProjectServingRollupBuilderParams,
  runner: ComparisonProjectServingRollupBuilderRunner = getDefaultComparisonProjectServingRollupBuilderDependencies(),
) => {
  await insertComparisonProjectArticleRollups(params, runner)
  await insertComparisonProjectFilterStats(params, runner)
}

const comparisonProjectServingRollupBuilder = {
  getComparisonProjectArticleServingInsertSql,
  getComparisonProjectFilterStatsInsertSql,
  insertComparisonProjectArticleRollups,
  insertComparisonProjectFilterMembers,
  insertComparisonProjectFilterStats,
  insertComparisonProjectServingRollups,
}

export const getComparisonProjectServingRollupBuilder = () => {
  return comparisonProjectServingRollupBuilder
}

export {getComparisonProjectArticleServingInsertSql, getComparisonProjectFilterStatsInsertSql}

export type {ComparisonProjectServingRollupBuilderParams}
