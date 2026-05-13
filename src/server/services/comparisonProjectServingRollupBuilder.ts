import {getAppDatabaseService} from './appDatabaseService.ts'
import {getSqlLiteral} from './appQueryHelpers.ts'

type ComparisonProjectServingRollupBuilderRunner = {run: (statement: string) => Promise<void>}

type ComparisonProjectServingRollupBuilderParams = {comparisonProjectId: string; generation: number}

type ComparisonProjectServingRollupBuilderDependencies = {run: (statement: string) => Promise<void>}

const comparisonArticleServingTable = 'mart.comparison_article_serving'
const comparisonCellServingTable = 'mart.comparison_cell_serving'
const comparisonFilterMemberTable = 'mart.comparison_filter_member'
const comparisonFilterStatsTable = 'mart.comparison_filter_stats'
const summaryPromptId = 'summary'

const getDefaultComparisonProjectServingRollupBuilderDependencies =
  (): ComparisonProjectServingRollupBuilderDependencies => {
    const database = getAppDatabaseService()

    return {run: database.runBackground}
  }

const getComparisonProjectServingGenerationSql = (generation: number) => {
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    throw new Error(`Invalid comparison project serving generation: ${generation}`)
  }

  return getSqlLiteral(generation)
}

const getComparisonProjectContentVariantCteSql = () => {
  return `
    content_variant AS (
      SELECT
        0 AS content_order,
        CASE WHEN cp.use_title THEN '1' ELSE '0' END
          || CASE WHEN cp.use_abstract THEN '1' ELSE '0' END
          || '00' AS content_key,
        cp.use_title AS use_title,
        cp.use_abstract AS use_abstract,
        FALSE AS use_fulltext,
        FALSE AS use_fulltext_no_images
      FROM comparison_project cp
      WHERE cp.use_title = TRUE OR cp.use_abstract = TRUE

      UNION ALL

      SELECT
        1 AS content_order,
        '0010' AS content_key,
        FALSE AS use_title,
        FALSE AS use_abstract,
        TRUE AS use_fulltext,
        FALSE AS use_fulltext_no_images
      FROM comparison_project cp
      WHERE cp.use_fulltext = TRUE

      UNION ALL

      SELECT
        2 AS content_order,
        '0001' AS content_key,
        FALSE AS use_title,
        FALSE AS use_abstract,
        FALSE AS use_fulltext,
        TRUE AS use_fulltext_no_images
      FROM comparison_project cp
      WHERE cp.use_fulltext_no_images = TRUE
    )
  `
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

const getComparisonProjectPromptConfigCteSql = () => {
  return `
    prompt_config AS (
      SELECT
        cpp.prompt_id,
        CAST(
          ROW_NUMBER() OVER (
            ORDER BY cpp.prompt_order ASC NULLS LAST, p.created_at ASC, p.id ASC
          ) - 1 AS INTEGER
        ) AS prompt_order
      FROM app.comparison_project_prompt cpp
      INNER JOIN comparison_project cp ON cp.id = cpp.comparison_project_id
      INNER JOIN app.prompt p ON p.id = cpp.prompt_id
    )
  `
}

const getComparisonProjectModelConfigCtesSql = ({
  prefix,
  promptConfigCteName,
}: {
  prefix: string
  promptConfigCteName: string
}) => {
  return `
    ${prefix}_selected_model_source AS (
      SELECT selected_model.model_id, MIN(CAST(selected_model.ordinal - 1 AS INTEGER)) AS model_order
      FROM comparison_project cp
      CROSS JOIN UNNEST(cp.model_ids) WITH ORDINALITY AS selected_model(model_id, ordinal)
      INNER JOIN app.model m ON m.id = selected_model.model_id
      GROUP BY selected_model.model_id
    ),
    ${prefix}_selected_model_config AS (
      SELECT
        ${prefix}_selected_model_source.model_id,
        ${prefix}_selected_model_source.model_order
      FROM ${prefix}_selected_model_source
      CROSS JOIN comparison_project cp
      WHERE COALESCE(ARRAY_LENGTH(cp.model_ids), 0) > 0
    ),
    ${prefix}_discovered_model_source AS (
      SELECT
        j.model_id,
        MIN(m.name) AS model_name
      FROM app.judgment j
      INNER JOIN scoped_article scoped_article ON scoped_article.article_id = j.article_id
      INNER JOIN ${promptConfigCteName} prompt_config ON prompt_config.prompt_id = j.prompt_id
      INNER JOIN content_variant content_variant
        ON content_variant.use_title = j.use_title
       AND content_variant.use_abstract = j.use_abstract
       AND content_variant.use_fulltext = j.use_fulltext
       AND content_variant.use_fulltext_no_images = j.use_fulltext_no_images
      INNER JOIN app.model m ON m.id = j.model_id
      WHERE j.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM ${prefix}_selected_model_config)
      GROUP BY j.model_id
    ),
    ${prefix}_discovered_model_config AS (
      SELECT
        ${prefix}_discovered_model_source.model_id,
        CAST(
          ROW_NUMBER() OVER (
            ORDER BY ${prefix}_discovered_model_source.model_name ASC, ${prefix}_discovered_model_source.model_id ASC
          ) - 1 AS INTEGER
        ) AS model_order
      FROM ${prefix}_discovered_model_source
    ),
    ${prefix}_model_config AS (
      SELECT model_id, model_order FROM ${prefix}_selected_model_config
      UNION ALL
      SELECT model_id, model_order FROM ${prefix}_discovered_model_config
    )
  `
}

const getComparisonProjectSummaryModeConfigCtesSql = () => {
  return `
    source_project_config AS (
      SELECT
        p.id AS source_project_id,
        p.model_id,
        CAST(
          ROW_NUMBER() OVER (
            ORDER BY cpsp.created_at ASC NULLS LAST, cpsp.id ASC
          ) - 1 AS INTEGER
        ) AS source_project_order
      FROM app.comparison_project_source_project cpsp
      INNER JOIN comparison_project cp ON cp.id = cpsp.comparison_project_id
      INNER JOIN app.project p ON p.id = cpsp.source_project_id
    ),
    source_project_summary_prompt AS (
      SELECT
        source_project_config.source_project_id,
        source_project_config.model_id,
        source_project_config.source_project_order,
        pp.prompt_id,
        CAST(
          ROW_NUMBER() OVER (
            PARTITION BY source_project_config.source_project_id
            ORDER BY pp.prompt_order ASC NULLS LAST, p.created_at ASC, p.id ASC
          ) - 1 AS INTEGER
        ) AS prompt_order,
        CAST(pp.criteria_disposition AS VARCHAR) AS criteria_disposition
      FROM source_project_config
      INNER JOIN app.project_prompt pp ON pp.project_id = source_project_config.source_project_id
      INNER JOIN app.prompt p ON p.id = pp.prompt_id
      WHERE pp.enabled = TRUE
        AND pp.criteria_disposition IS NOT NULL
        AND pp.criteria_section_key IS NOT NULL
    ),
    source_project_summary_prompt_count AS (
      SELECT COUNT(*) AS prompt_count
      FROM source_project_summary_prompt
    ),
    fallback_summary_prompt AS (
      SELECT
        NULL AS source_project_id,
        NULL AS model_id,
        0 AS source_project_order,
        cpp.prompt_id,
        CAST(
          ROW_NUMBER() OVER (
            ORDER BY cpp.prompt_order ASC NULLS LAST, p.created_at ASC, p.id ASC
          ) - 1 AS INTEGER
        ) AS prompt_order,
        CAST(cpp.criteria_disposition AS VARCHAR) AS criteria_disposition
      FROM app.comparison_project_prompt cpp
      INNER JOIN comparison_project cp ON cp.id = cpp.comparison_project_id
      INNER JOIN app.prompt p ON p.id = cpp.prompt_id
      CROSS JOIN source_project_summary_prompt_count
      WHERE source_project_summary_prompt_count.prompt_count = 0
    ),
    summary_prompt_group AS (
      SELECT
        COALESCE(source_project_id, '__fallback__') AS summary_group_key,
        source_project_id,
        model_id,
        source_project_order,
        prompt_id,
        prompt_order,
        criteria_disposition
      FROM source_project_summary_prompt

      UNION ALL

      SELECT
        COALESCE(source_project_id, '__fallback__') AS summary_group_key,
        source_project_id,
        model_id,
        source_project_order,
        prompt_id,
        prompt_order,
        criteria_disposition
      FROM fallback_summary_prompt
    ),
    summary_prompt_id_config AS (
      SELECT prompt_id
      FROM summary_prompt_group
      GROUP BY prompt_id
    )
  `
}

const getComparisonProjectSummarySourceProjectColumnConfigCteSql = () => {
  return `
    source_project_column_config AS (
      SELECT
        source_project_config.source_project_id,
        source_project_config.model_id,
        source_project_config.source_project_order
      FROM source_project_config
      INNER JOIN summary_model_config ON summary_model_config.model_id = source_project_config.model_id
      CROSS JOIN source_project_summary_prompt_count
      WHERE source_project_summary_prompt_count.prompt_count > 0
    )
  `
}

const getComparisonProjectRequiredColumnCtesSql = () => {
  return `
    ${getComparisonProjectPromptConfigCteSql()},
    ${getComparisonProjectContentVariantCteSql()},
    ${getComparisonProjectScopeCtesSql()},
    ${getComparisonProjectModelConfigCtesSql({prefix: 'prompt', promptConfigCteName: 'prompt_config'})},
    ${getComparisonProjectSummaryModeConfigCtesSql()},
    ${getComparisonProjectModelConfigCtesSql({prefix: 'summary', promptConfigCteName: 'summary_prompt_id_config'})},
    ${getComparisonProjectSummarySourceProjectColumnConfigCteSql()},
    prompt_mode_llm_required_column AS (
      SELECT
        'llm:' || prompt_model_config.model_id || ':' || content_variant.content_key || ':' || prompt_config.prompt_id AS column_id,
        'llm' AS kind,
        prompt_config.prompt_id
      FROM comparison_project cp
      CROSS JOIN prompt_config
      CROSS JOIN prompt_model_config
      CROSS JOIN content_variant
      WHERE NOT (
        cp.compare_with_humans = TRUE
        AND COALESCE(cp.human_judgment_mode, 'prompt') = 'summary'
      )
    ),
    prompt_mode_human_required_column AS (
      SELECT
        'human:' || prompt_config.prompt_id AS column_id,
        'human' AS kind,
        prompt_config.prompt_id
      FROM comparison_project cp
      CROSS JOIN prompt_config
      WHERE cp.compare_with_humans = TRUE
        AND COALESCE(cp.human_judgment_mode, 'prompt') = 'prompt'
    ),
    summary_mode_source_project_llm_required_column AS (
      SELECT
        'llm:' || source_project_column_config.source_project_id || ':' || source_project_column_config.model_id || ':' || content_variant.content_key || ':${summaryPromptId}' AS column_id,
        'llm' AS kind,
        '${summaryPromptId}' AS prompt_id
      FROM comparison_project cp
      CROSS JOIN source_project_column_config
      CROSS JOIN content_variant
      WHERE cp.compare_with_humans = TRUE
        AND COALESCE(cp.human_judgment_mode, 'prompt') = 'summary'
    ),
    summary_mode_model_llm_required_column AS (
      SELECT
        'llm:' || summary_model_config.model_id || ':' || content_variant.content_key || ':${summaryPromptId}' AS column_id,
        'llm' AS kind,
        '${summaryPromptId}' AS prompt_id
      FROM comparison_project cp
      CROSS JOIN summary_model_config
      CROSS JOIN content_variant
      WHERE cp.compare_with_humans = TRUE
        AND COALESCE(cp.human_judgment_mode, 'prompt') = 'summary'
        AND (SELECT COUNT(*) FROM source_project_column_config) = 0
    ),
    summary_mode_human_required_column AS (
      SELECT
        'human:${summaryPromptId}' AS column_id,
        'human' AS kind,
        '${summaryPromptId}' AS prompt_id
      FROM comparison_project cp
      WHERE cp.compare_with_humans = TRUE
        AND COALESCE(cp.human_judgment_mode, 'prompt') = 'summary'
    ),
    required_column AS (
      SELECT DISTINCT column_id, kind, prompt_id FROM prompt_mode_llm_required_column
      UNION
      SELECT DISTINCT column_id, kind, prompt_id FROM prompt_mode_human_required_column
      UNION
      SELECT DISTINCT column_id, kind, prompt_id FROM summary_mode_source_project_llm_required_column
      UNION
      SELECT DISTINCT column_id, kind, prompt_id FROM summary_mode_model_llm_required_column
      UNION
      SELECT DISTINCT column_id, kind, prompt_id FROM summary_mode_human_required_column
    )
  `
}

const getComparisonProjectArticleServingInsertSql = ({
  comparisonProjectId,
  generation,
}: ComparisonProjectServingRollupBuilderParams) => {
  const comparisonProjectLiteral = getSqlLiteral(comparisonProjectId)
  const generationLiteral = getComparisonProjectServingGenerationSql(generation)

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
      is_fully_answered,
      passes_row_filter_multiple_answers,
      passes_row_filter_fully_answered,
      passes_row_filter_all,
      has_human_vs_llm_difference,
      has_llm_vs_llm_difference,
      has_any_disagreement,
      passes_difference_filter_human_vs_llm,
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
    ${getComparisonProjectRequiredColumnCtesSql()},
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
      INNER JOIN scoped_article ON scoped_article.article_id = cell.article_id
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
        COUNT(DISTINCT answer_value) FILTER (WHERE kind = 'llm') AS llm_answer_count
      FROM cell_answer
      GROUP BY article_id, prompt_id
    ),
    prompt_difference AS (
      SELECT
        prompt_answer_count.article_id,
        prompt_answer_count.prompt_id,
        prompt_answer_count.human_answered_count > 0
          AND prompt_answer_count.llm_answered_count > 0
          AND COALESCE(prompt_answer_value_count.all_answer_count, 0) > 1 AS has_human_vs_llm_difference,
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
        COALESCE(BOOL_OR(has_human_vs_llm_difference), FALSE) AS has_human_vs_llm_difference,
        COALESCE(BOOL_OR(has_llm_vs_llm_difference), FALSE) AS has_llm_vs_llm_difference,
        COALESCE(BOOL_OR(has_any_disagreement), FALSE) AS has_any_disagreement
      FROM prompt_difference
      GROUP BY article_id
    ),
    article_rollup AS (
      SELECT
        article_cell_rollup.article_id,
        article_cell_rollup.answered_prompt_count,
        article_cell_rollup.answered_column_count,
        article_cell_rollup.answered_llm_column_count,
        article_cell_rollup.answered_human_column_count,
        required_column_counts.required_column_count,
        required_column_counts.required_llm_column_count,
        required_column_counts.required_human_column_count,
        article_cell_rollup.answered_llm_column_count = required_column_counts.required_llm_column_count AS has_all_llm_columns,
        article_cell_rollup.answered_human_column_count = required_column_counts.required_human_column_count AS has_all_human_columns,
        CASE
          WHEN project_mode.is_summary_mode THEN article_cell_rollup.answered_column_count >= 2
          ELSE article_cell_rollup.answered_prompt_count >= 2
        END AS has_multiple_answers,
        COALESCE(article_difference_rollup.has_human_vs_llm_difference, FALSE) AS has_human_vs_llm_difference,
        COALESCE(article_difference_rollup.has_llm_vs_llm_difference, FALSE) AS has_llm_vs_llm_difference,
        COALESCE(article_difference_rollup.has_any_disagreement, FALSE) AS has_any_disagreement,
        difference_filter_availability.has_human_vs_llm_filter,
        difference_filter_availability.has_llm_vs_llm_filter,
        difference_filter_availability.has_human_vs_llm_filter
          AND difference_filter_availability.has_llm_vs_llm_filter AS has_any_disagreement_filter
      FROM article_cell_rollup
      CROSS JOIN required_column_counts
      CROSS JOIN project_mode
      CROSS JOIN difference_filter_availability
      LEFT JOIN article_difference_rollup ON article_difference_rollup.article_id = article_cell_rollup.article_id
    )
    SELECT
      ${comparisonProjectLiteral} AS comparison_project_id,
      ${generationLiteral} AS generation,
      article_rollup.article_id,
      article.article_created_at,
      article.article_updated_at,
      COALESCE(article.article_title, ''),
      article.article_summary,
      article.article_id AS article_external_id,
      json_extract_string(article.source_metadata, '$.journalTitle') AS journal_title,
      article.url,
      article.full_text_pdf,
      article.full_text_fetched_at,
      article.full_text_conversion_status,
      article.source_metadata,
      article.article_created_at AS row_sort_created_at,
      COALESCE(article.article_title, '') AS row_sort_title,
      article_rollup.article_id AS row_sort_article_id,
      article_rollup.answered_prompt_count,
      article_rollup.answered_column_count,
      article_rollup.answered_llm_column_count,
      article_rollup.answered_human_column_count,
      article_rollup.required_column_count,
      article_rollup.required_llm_column_count,
      article_rollup.required_human_column_count,
      article_rollup.has_all_llm_columns,
      article_rollup.has_all_human_columns,
      article_rollup.has_multiple_answers,
      article_rollup.has_all_llm_columns AND article_rollup.has_all_human_columns AS is_fully_answered,
      article_rollup.has_multiple_answers AS passes_row_filter_multiple_answers,
      article_rollup.has_all_llm_columns AND article_rollup.has_all_human_columns AS passes_row_filter_fully_answered,
      TRUE AS passes_row_filter_all,
      article_rollup.has_human_vs_llm_difference,
      article_rollup.has_llm_vs_llm_difference,
      article_rollup.has_any_disagreement,
      CASE
        WHEN article_rollup.has_human_vs_llm_filter THEN article_rollup.has_human_vs_llm_difference
        ELSE TRUE
      END AS passes_difference_filter_human_vs_llm,
      CASE
        WHEN article_rollup.has_llm_vs_llm_filter THEN article_rollup.has_llm_vs_llm_difference
        ELSE TRUE
      END AS passes_difference_filter_llm_vs_llm,
      CASE
        WHEN article_rollup.has_any_disagreement_filter THEN article_rollup.has_any_disagreement
        ELSE TRUE
      END AS passes_difference_filter_any_disagreement,
      TRUE AS passes_difference_filter_all,
      article_rollup.has_any_disagreement AS has_conflict,
      current_timestamp AS serving_updated_at
    FROM article_rollup
    INNER JOIN app.article article ON article.id = article_rollup.article_id
  `
}

const getComparisonProjectFilterValuesCteSql = () => {
  return `
    row_filter AS (
      SELECT row_filter
      FROM (
        VALUES ('multiple-answers'), ('fully-answered'), ('all')
      ) AS row_filter_value(row_filter)
    ),
    difference_filter AS (
      SELECT difference_filter
      FROM (
        VALUES ('all'), ('human-vs-llm'), ('llm-vs-llm'), ('any-disagreement')
      ) AS difference_filter_value(difference_filter)
    ),
    filter_combination AS (
      SELECT row_filter.row_filter, difference_filter.difference_filter
      FROM row_filter
      CROSS JOIN difference_filter
    )
  `
}

const getComparisonProjectFilterMemberInsertSql = ({
  comparisonProjectId,
  generation,
}: ComparisonProjectServingRollupBuilderParams) => {
  const comparisonProjectLiteral = getSqlLiteral(comparisonProjectId)
  const generationLiteral = getComparisonProjectServingGenerationSql(generation)

  return `
    INSERT INTO ${comparisonFilterMemberTable} (
      comparison_project_id,
      generation,
      row_filter,
      difference_filter,
      article_id,
      ordinal,
      article_created_at,
      article_title,
      member_updated_at
    )
    WITH ${getComparisonProjectFilterValuesCteSql()},
    eligible_member AS (
      SELECT
        article.comparison_project_id,
        article.generation,
        filter_combination.row_filter,
        filter_combination.difference_filter,
        article.article_id,
        article.article_created_at,
        article.article_title,
        article.row_sort_created_at,
        article.row_sort_title,
        article.row_sort_article_id
      FROM ${comparisonArticleServingTable} article
      CROSS JOIN filter_combination
      WHERE article.comparison_project_id = ${comparisonProjectLiteral}
        AND article.generation = ${generationLiteral}
        AND CASE filter_combination.row_filter
          WHEN 'multiple-answers' THEN article.passes_row_filter_multiple_answers
          WHEN 'fully-answered' THEN article.passes_row_filter_fully_answered
          ELSE article.passes_row_filter_all
        END
        AND CASE filter_combination.difference_filter
          WHEN 'human-vs-llm' THEN article.passes_difference_filter_human_vs_llm
          WHEN 'llm-vs-llm' THEN article.passes_difference_filter_llm_vs_llm
          WHEN 'any-disagreement' THEN article.passes_difference_filter_any_disagreement
          ELSE article.passes_difference_filter_all
        END
    )
    SELECT
      eligible_member.comparison_project_id,
      eligible_member.generation,
      eligible_member.row_filter,
      eligible_member.difference_filter,
      eligible_member.article_id,
      ROW_NUMBER() OVER (
        PARTITION BY eligible_member.row_filter, eligible_member.difference_filter
        ORDER BY
          eligible_member.row_sort_created_at DESC NULLS LAST,
          eligible_member.row_sort_title ASC,
          eligible_member.row_sort_article_id ASC
      ) - 1 AS ordinal,
      eligible_member.article_created_at,
      eligible_member.article_title,
      current_timestamp AS member_updated_at
    FROM eligible_member
  `
}

const getComparisonProjectFilterStatsInsertSql = ({
  comparisonProjectId,
  generation,
}: ComparisonProjectServingRollupBuilderParams) => {
  const comparisonProjectLiteral = getSqlLiteral(comparisonProjectId)
  const generationLiteral = getComparisonProjectServingGenerationSql(generation)

  return `
    INSERT INTO ${comparisonFilterStatsTable} (
      comparison_project_id,
      generation,
      row_filter,
      difference_filter,
      total_count,
      stats_updated_at
    )
    WITH ${getComparisonProjectFilterValuesCteSql()},
    member_count AS (
      SELECT
        row_filter,
        difference_filter,
        COUNT(*) AS total_count
      FROM ${comparisonFilterMemberTable}
      WHERE comparison_project_id = ${comparisonProjectLiteral}
        AND generation = ${generationLiteral}
      GROUP BY row_filter, difference_filter
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

const insertComparisonProjectArticleRollups = (
  params: ComparisonProjectServingRollupBuilderParams,
  dependencies: ComparisonProjectServingRollupBuilderDependencies = getDefaultComparisonProjectServingRollupBuilderDependencies(),
) => {
  return dependencies.run(getComparisonProjectArticleServingInsertSql(params))
}

const insertComparisonProjectFilterMembers = (
  params: ComparisonProjectServingRollupBuilderParams,
  dependencies: ComparisonProjectServingRollupBuilderDependencies = getDefaultComparisonProjectServingRollupBuilderDependencies(),
) => {
  return dependencies.run(getComparisonProjectFilterMemberInsertSql(params))
}

const insertComparisonProjectFilterStats = (
  params: ComparisonProjectServingRollupBuilderParams,
  dependencies: ComparisonProjectServingRollupBuilderDependencies = getDefaultComparisonProjectServingRollupBuilderDependencies(),
) => {
  return dependencies.run(getComparisonProjectFilterStatsInsertSql(params))
}

const insertComparisonProjectServingRollups = async (
  params: ComparisonProjectServingRollupBuilderParams,
  runner: ComparisonProjectServingRollupBuilderRunner = getDefaultComparisonProjectServingRollupBuilderDependencies(),
) => {
  await insertComparisonProjectArticleRollups(params, runner)
  await insertComparisonProjectFilterMembers(params, runner)
  await insertComparisonProjectFilterStats(params, runner)
}

const comparisonProjectServingRollupBuilder = {
  getComparisonProjectArticleServingInsertSql,
  getComparisonProjectFilterMemberInsertSql,
  getComparisonProjectFilterStatsInsertSql,
  insertComparisonProjectArticleRollups,
  insertComparisonProjectFilterMembers,
  insertComparisonProjectFilterStats,
  insertComparisonProjectServingRollups,
}

export const getComparisonProjectServingRollupBuilder = () => {
  return comparisonProjectServingRollupBuilder
}

export {
  getComparisonProjectArticleServingInsertSql,
  getComparisonProjectFilterMemberInsertSql,
  getComparisonProjectFilterStatsInsertSql,
}

export type {ComparisonProjectServingRollupBuilderParams}
