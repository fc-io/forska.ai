import {getAppDatabaseService} from './appDatabaseService.ts'
import {getSqlLiteral} from './appQueryHelpers.ts'

type ComparisonProjectServingCellBuilderRunner = {run: (statement: string) => Promise<void>}

type ComparisonProjectServingCellBuilderParams = {comparisonProjectId: string; generation: number}

type ComparisonProjectServingCellBuilderDependencies = {run: (statement: string) => Promise<void>}

const comparisonCellServingTable = 'mart.comparison_cell_serving'

const getDefaultComparisonProjectServingCellBuilderDependencies =
  (): ComparisonProjectServingCellBuilderDependencies => {
    const database = getAppDatabaseService()

    return {run: database.runBackground}
  }

const getComparisonProjectServingGenerationSql = (generation: number) => {
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    throw new Error(`Invalid comparison project serving generation: ${generation}`)
  }

  return getSqlLiteral(generation)
}

const getPromptModeComparisonProjectPredicateSql = () => {
  return `
      AND NOT (
        cp.compare_with_humans = TRUE
        AND COALESCE(cp.human_judgment_mode, 'prompt') = 'summary'
      )
    `
}

const getHumanPromptModeComparisonProjectPredicateSql = () => {
  return `
      AND cp.compare_with_humans = TRUE
      AND COALESCE(cp.human_judgment_mode, 'prompt') = 'prompt'
    `
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

const getComparisonProjectModelConfigCtesSql = () => {
  return `
    selected_model_source AS (
      SELECT selected_model.model_id, MIN(CAST(selected_model.ordinal - 1 AS INTEGER)) AS model_order
      FROM comparison_project cp
      CROSS JOIN UNNEST(cp.model_ids) WITH ORDINALITY AS selected_model(model_id, ordinal)
      INNER JOIN app.model m ON m.id = selected_model.model_id
      GROUP BY selected_model.model_id
    ),
    selected_model_config AS (
      SELECT
        selected_model_source.model_id,
        selected_model_source.model_order
      FROM selected_model_source
      CROSS JOIN comparison_project cp
      WHERE COALESCE(ARRAY_LENGTH(cp.model_ids), 0) > 0
    ),
    discovered_model_source AS (
      SELECT
        j.model_id,
        MIN(m.name) AS model_name
      FROM app.judgment j
      INNER JOIN scoped_article scoped_article ON scoped_article.article_id = j.article_id
      INNER JOIN prompt_config prompt_config ON prompt_config.prompt_id = j.prompt_id
      INNER JOIN content_variant content_variant
        ON content_variant.use_title = j.use_title
       AND content_variant.use_abstract = j.use_abstract
       AND content_variant.use_fulltext = j.use_fulltext
       AND content_variant.use_fulltext_no_images = j.use_fulltext_no_images
      INNER JOIN app.model m ON m.id = j.model_id
      WHERE j.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM selected_model_config)
      GROUP BY j.model_id
    ),
    discovered_model_config AS (
      SELECT
        discovered_model_source.model_id,
        CAST(
          ROW_NUMBER() OVER (
            ORDER BY discovered_model_source.model_name ASC, discovered_model_source.model_id ASC
          ) - 1 AS INTEGER
        ) AS model_order
      FROM discovered_model_source
    ),
    model_config AS (
      SELECT model_id, model_order FROM selected_model_config
      UNION ALL
      SELECT model_id, model_order FROM discovered_model_config
    ),
    cell_column_counts AS (
      SELECT
        (SELECT COUNT(*) FROM prompt_config) AS prompt_count,
        (SELECT COUNT(*) FROM model_config) AS model_count,
        (SELECT COUNT(*) FROM content_variant) AS content_variant_count
    )
  `
}

const getDisplayAnswerCtesSql = (sourceCteName: string) => {
  return `
    array_answer AS (
      SELECT
        ${sourceCteName}.*,
        list_filter(
          list_transform(
            COALESCE(${sourceCteName}.answered_original_as_array, []::VARCHAR[]),
            lambda answer_value : NULLIF(TRIM(answer_value), '')
          ),
          lambda answer_value : answer_value IS NOT NULL
        ) AS array_answer_values
      FROM ${sourceCteName}
    ),
    json_answer AS (
      SELECT
        array_answer.*,
        CASE
          WHEN ARRAY_LENGTH(array_answer.array_answer_values) > 0 THEN []::VARCHAR[]
          WHEN NOT STARTS_WITH(TRIM(COALESCE(array_answer.answered_original, '')), '[') THEN []::VARCHAR[]
          ELSE COALESCE(
            (
              SELECT ARRAY_AGG(json_answer_value ORDER BY json_answer_order)
              FROM (
                SELECT
                  CAST(json_value.key AS BIGINT) AS json_answer_order,
                  NULLIF(TRIM(json_extract_string(json_value.value, '$')), '') AS json_answer_value
                FROM json_each(TRY_CAST(array_answer.answered_original AS JSON)) json_value
                WHERE json_value.type = 'VARCHAR'
              ) json_answer_values
              WHERE json_answer_value IS NOT NULL
            ),
            []::VARCHAR[]
          )
        END AS json_answer_values
      FROM array_answer
    ),
    answer_value AS (
      SELECT
        json_answer.*,
        CASE
          WHEN ARRAY_LENGTH(json_answer.array_answer_values) > 0 THEN json_answer.array_answer_values
          WHEN ARRAY_LENGTH(json_answer.json_answer_values) > 0 THEN json_answer.json_answer_values
          ELSE CASE
            WHEN NULLIF(TRIM(COALESCE(json_answer.answered_original, '')), '') IS NULL THEN []::VARCHAR[]
            ELSE [TRIM(json_answer.answered_original)]
          END
        END AS answer_values
      FROM json_answer
    ),
    display_cell AS (
      SELECT
        answer_value.*,
        array_to_string(answer_value.answer_values, chr(10)) AS display_answer
      FROM answer_value
      WHERE ARRAY_LENGTH(answer_value.answer_values) > 0
    )
  `
}

const getNormalizedCellCteSql = () => {
  return `
    normalized_cell AS (
      SELECT
        display_cell.*,
        COALESCE(
          (
            SELECT ARRAY_AGG(normalized_answer ORDER BY first_ordinal)
            FROM (
              SELECT
                LOWER(TRIM(answer_part)) AS normalized_answer,
                MIN(ordinal) AS first_ordinal
              FROM UNNEST(string_split(display_cell.display_answer, chr(10))) WITH ORDINALITY AS parts(answer_part, ordinal)
              WHERE NULLIF(TRIM(answer_part), '') IS NOT NULL
              GROUP BY LOWER(TRIM(answer_part))
            ) normalized_answer_parts
          ),
          []::VARCHAR[]
        ) AS normalized_answers
      FROM display_cell
    )
  `
}

const getPromptModeComparisonProjectLlmCellServingInsertSql = ({
  comparisonProjectId,
  generation,
}: ComparisonProjectServingCellBuilderParams) => {
  const comparisonProjectLiteral = getSqlLiteral(comparisonProjectId)
  const generationLiteral = getComparisonProjectServingGenerationSql(generation)

  return `
    INSERT INTO ${comparisonCellServingTable} (
      comparison_project_id,
      generation,
      article_id,
      column_id,
      column_order,
      kind,
      prompt_id,
      model_id,
      source_project_id,
      content_key,
      display_answer,
      normalized_answers,
      source_created_at,
      source_updated_at
    )
    WITH comparison_project AS (
      SELECT *
      FROM app.comparison_project cp
      WHERE cp.id = ${comparisonProjectLiteral}
        ${getPromptModeComparisonProjectPredicateSql()}
    ),
    ${getComparisonProjectPromptConfigCteSql()},
    ${getComparisonProjectContentVariantCteSql()},
    ${getComparisonProjectScopeCtesSql()},
    ${getComparisonProjectModelConfigCtesSql()},
    llm_source AS (
      SELECT
        j.article_id,
        j.prompt_id,
        j.model_id,
        j.answered_original,
        j.answered_original_as_array,
        j.created_at AS source_created_at,
        j.updated_at AS source_updated_at,
        prompt_config.prompt_order,
        model_config.model_order,
        content_variant.content_order,
        content_variant.content_key
      FROM app.judgment j
      INNER JOIN scoped_article scoped_article ON scoped_article.article_id = j.article_id
      INNER JOIN prompt_config prompt_config ON prompt_config.prompt_id = j.prompt_id
      INNER JOIN model_config model_config ON model_config.model_id = j.model_id
      INNER JOIN content_variant content_variant
        ON content_variant.use_title = j.use_title
       AND content_variant.use_abstract = j.use_abstract
       AND content_variant.use_fulltext = j.use_fulltext
       AND content_variant.use_fulltext_no_images = j.use_fulltext_no_images
      WHERE j.deleted_at IS NULL
    ),
    ${getDisplayAnswerCtesSql('llm_source')},
    ${getNormalizedCellCteSql()}
    SELECT
      ${comparisonProjectLiteral} AS comparison_project_id,
      ${generationLiteral} AS generation,
      normalized_cell.article_id,
      'llm:' || normalized_cell.model_id || ':' || normalized_cell.content_key || ':' || normalized_cell.prompt_id AS column_id,
      CAST(
        normalized_cell.prompt_order * cell_column_counts.model_count * cell_column_counts.content_variant_count
          + normalized_cell.model_order * cell_column_counts.content_variant_count
          + normalized_cell.content_order AS INTEGER
      ) AS column_order,
      'llm' AS kind,
      normalized_cell.prompt_id,
      normalized_cell.model_id,
      NULL AS source_project_id,
      normalized_cell.content_key,
      normalized_cell.display_answer,
      normalized_cell.normalized_answers,
      normalized_cell.source_created_at,
      normalized_cell.source_updated_at
    FROM normalized_cell
    CROSS JOIN cell_column_counts
  `
}

const getPromptModeComparisonProjectHumanCellServingInsertSql = ({
  comparisonProjectId,
  generation,
}: ComparisonProjectServingCellBuilderParams) => {
  const comparisonProjectLiteral = getSqlLiteral(comparisonProjectId)
  const generationLiteral = getComparisonProjectServingGenerationSql(generation)

  return `
    INSERT INTO ${comparisonCellServingTable} (
      comparison_project_id,
      generation,
      article_id,
      column_id,
      column_order,
      kind,
      prompt_id,
      model_id,
      source_project_id,
      content_key,
      display_answer,
      normalized_answers,
      source_created_at,
      source_updated_at
    )
    WITH comparison_project AS (
      SELECT *
      FROM app.comparison_project cp
      WHERE cp.id = ${comparisonProjectLiteral}
        ${getHumanPromptModeComparisonProjectPredicateSql()}
    ),
    ${getComparisonProjectPromptConfigCteSql()},
    ${getComparisonProjectContentVariantCteSql()},
    ${getComparisonProjectScopeCtesSql()},
    ${getComparisonProjectModelConfigCtesSql()},
    llm_column_counts AS (
      SELECT prompt_count * model_count * content_variant_count AS llm_column_count
      FROM cell_column_counts
    ),
    ranked_human_answer AS (
      SELECT
        h.article_id,
        h.prompt_id,
        h.answer,
        h.created_at AS source_created_at,
        h.updated_at AS source_updated_at,
        prompt_config.prompt_order,
        ROW_NUMBER() OVER (
          PARTITION BY h.article_id, h.prompt_id
          ORDER BY h.updated_at DESC NULLS LAST, h.created_at DESC NULLS LAST, h.id DESC
        ) AS answer_rank
      FROM app.judgment_human h
      INNER JOIN scoped_article scoped_article ON scoped_article.article_id = h.article_id
      INNER JOIN prompt_config prompt_config ON prompt_config.prompt_id = h.prompt_id
      WHERE h.is_answered = TRUE
        AND NULLIF(TRIM(COALESCE(h.answer, '')), '') IS NOT NULL
    ),
    display_cell AS (
      SELECT
        ranked_human_answer.article_id,
        ranked_human_answer.prompt_id,
        ranked_human_answer.source_created_at,
        ranked_human_answer.source_updated_at,
        ranked_human_answer.prompt_order,
        TRIM(ranked_human_answer.answer) AS display_answer
      FROM ranked_human_answer
      WHERE ranked_human_answer.answer_rank = 1
    ),
    ${getNormalizedCellCteSql()}
    SELECT
      ${comparisonProjectLiteral} AS comparison_project_id,
      ${generationLiteral} AS generation,
      normalized_cell.article_id,
      'human:' || normalized_cell.prompt_id AS column_id,
      CAST(llm_column_counts.llm_column_count + normalized_cell.prompt_order AS INTEGER) AS column_order,
      'human' AS kind,
      normalized_cell.prompt_id,
      NULL AS model_id,
      NULL AS source_project_id,
      NULL AS content_key,
      normalized_cell.display_answer,
      normalized_cell.normalized_answers,
      normalized_cell.source_created_at,
      normalized_cell.source_updated_at
    FROM normalized_cell
    CROSS JOIN llm_column_counts
  `
}

const insertPromptModeComparisonProjectLlmCells = (
  params: ComparisonProjectServingCellBuilderParams,
  dependencies: ComparisonProjectServingCellBuilderDependencies = getDefaultComparisonProjectServingCellBuilderDependencies(),
) => {
  return dependencies.run(getPromptModeComparisonProjectLlmCellServingInsertSql(params))
}

const insertPromptModeComparisonProjectHumanCells = (
  params: ComparisonProjectServingCellBuilderParams,
  dependencies: ComparisonProjectServingCellBuilderDependencies = getDefaultComparisonProjectServingCellBuilderDependencies(),
) => {
  return dependencies.run(getPromptModeComparisonProjectHumanCellServingInsertSql(params))
}

const insertPromptModeComparisonProjectCells = async (
  params: ComparisonProjectServingCellBuilderParams,
  runner: ComparisonProjectServingCellBuilderRunner = getDefaultComparisonProjectServingCellBuilderDependencies(),
) => {
  await insertPromptModeComparisonProjectLlmCells(params, runner)
  await insertPromptModeComparisonProjectHumanCells(params, runner)
}

const comparisonProjectServingCellBuilder = {
  getPromptModeComparisonProjectHumanCellServingInsertSql,
  getPromptModeComparisonProjectLlmCellServingInsertSql,
  insertPromptModeComparisonProjectCells,
  insertPromptModeComparisonProjectHumanCells,
  insertPromptModeComparisonProjectLlmCells,
}

export const getComparisonProjectServingCellBuilder = () => {
  return comparisonProjectServingCellBuilder
}

export {getPromptModeComparisonProjectHumanCellServingInsertSql, getPromptModeComparisonProjectLlmCellServingInsertSql}

export type {ComparisonProjectServingCellBuilderParams}
