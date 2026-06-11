import {getAppDatabaseService} from './appDatabaseService.ts'
import {getSqlLiteral} from './appQueryHelpers.ts'
import {
  comparisonProjectServingGenerationConfigTables,
  ensureComparisonProjectServingGenerationConfig,
  getComparisonProjectServingGenerationSql,
} from './comparisonProjectServingGenerationConfig.ts'

type ComparisonProjectServingCellBuilderRunner = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
}

type ComparisonProjectServingCellBuilderParams = {comparisonProjectId: string; generation: number}

type ComparisonProjectServingCellInsertParams = ComparisonProjectServingCellBuilderParams & {articleIds?: string[]}

type ComparisonProjectServingCellBuilderDependencies = {
  queryJson?: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
}

type ComparisonProjectArticleCellBatch = {articleIds: string[]; hasMore: boolean}

const comparisonCellServingTable = 'mart.comparison_cell_serving'
const comparisonProjectServingCellArticleBatchSize = 250
const summaryPromptId = 'summary'

const getDefaultComparisonProjectServingCellBuilderDependencies = (): ComparisonProjectServingCellBuilderRunner => {
  const database = getAppDatabaseService()

  return {queryJson: database.queryJsonBackground, run: database.runBackground}
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

const getSummaryModeComparisonProjectPredicateSql = () => {
  return `
      AND cp.compare_with_humans = TRUE
      AND COALESCE(cp.human_judgment_mode, 'prompt') = 'summary'
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

const getComparisonProjectArticleBatchCteSql = (articleIds: string[] | undefined) => {
  if (articleIds === undefined) {
    return null
  }

  return articleIds.length === 0
    ? `article_batch(article_id) AS (
      SELECT NULL::VARCHAR AS article_id
      WHERE FALSE
    )`
    : `article_batch(article_id) AS (
      VALUES ${articleIds
        .map((articleId) => {
          return `(${getSqlLiteral(articleId)})`
        })
        .join(', ')}
    )`
}

const getComparisonProjectArticleBatchCtePrefixSql = (articleIds: string[] | undefined) => {
  const cteSql = getComparisonProjectArticleBatchCteSql(articleIds)

  return cteSql === null ? '' : `${cteSql},`
}

const getComparisonProjectArticleBatchJoinSql = (articleIdExpression: string, useArticleBatch: boolean) => {
  return useArticleBatch ? `INNER JOIN article_batch ON article_batch.article_id = ${articleIdExpression}` : ''
}

const getMaterializedPromptModeComparisonProjectConfigCtesSql = ({
  comparisonProjectLiteral,
  generationLiteral,
}: {
  comparisonProjectLiteral: string
  generationLiteral: string
}) => {
  return `
    prompt_config AS (
      SELECT
        prompt_id,
        prompt_order
      FROM ${comparisonProjectServingGenerationConfigTables.promptConfig}
      WHERE comparison_project_id = ${comparisonProjectLiteral}
        AND generation = ${generationLiteral}
    ),
    content_variant AS (
      SELECT
        content_order,
        content_key,
        use_title,
        use_abstract,
        use_fulltext,
        use_fulltext_no_images
      FROM ${comparisonProjectServingGenerationConfigTables.contentVariant}
      WHERE comparison_project_id = ${comparisonProjectLiteral}
        AND generation = ${generationLiteral}
    ),
    model_config AS (
      SELECT
        model_id,
        model_order
      FROM ${comparisonProjectServingGenerationConfigTables.modelConfig}
      WHERE comparison_project_id = ${comparisonProjectLiteral}
        AND generation = ${generationLiteral}
        AND mode = 'prompt'
    ),
    cell_column_counts AS (
      SELECT
        (SELECT COUNT(*) FROM prompt_config) AS prompt_count,
        (SELECT COUNT(*) FROM model_config) AS model_count,
        (SELECT COUNT(*) FROM content_variant) AS content_variant_count
    )
  `
}

const getMaterializedSummaryModeComparisonProjectConfigCtesSql = ({
  comparisonProjectLiteral,
  generationLiteral,
}: {
  comparisonProjectLiteral: string
  generationLiteral: string
}) => {
  return `
    source_project_config AS (
      SELECT
        source_project_id,
        model_id,
        source_project_order
      FROM ${comparisonProjectServingGenerationConfigTables.sourceProjectConfig}
      WHERE comparison_project_id = ${comparisonProjectLiteral}
        AND generation = ${generationLiteral}
    ),
    summary_prompt_group AS (
      SELECT
        summary_group_key,
        source_project_id,
        model_id,
        source_project_order,
        prompt_id,
        prompt_order,
        criteria_disposition
      FROM ${comparisonProjectServingGenerationConfigTables.summaryPromptGroup}
      WHERE comparison_project_id = ${comparisonProjectLiteral}
        AND generation = ${generationLiteral}
    ),
    summary_prompt_id_config AS (
      SELECT prompt_id
      FROM summary_prompt_group
      GROUP BY prompt_id
    ),
    content_variant AS (
      SELECT
        content_order,
        content_key,
        use_title,
        use_abstract,
        use_fulltext,
        use_fulltext_no_images
      FROM ${comparisonProjectServingGenerationConfigTables.contentVariant}
      WHERE comparison_project_id = ${comparisonProjectLiteral}
        AND generation = ${generationLiteral}
    ),
    model_config AS (
      SELECT
        model_id,
        model_order
      FROM ${comparisonProjectServingGenerationConfigTables.modelConfig}
      WHERE comparison_project_id = ${comparisonProjectLiteral}
        AND generation = ${generationLiteral}
        AND mode = 'summary'
    ),
    source_project_column_config AS (
      SELECT
        source_project_id,
        model_id,
        source_project_order
      FROM ${comparisonProjectServingGenerationConfigTables.sourceProjectColumnConfig}
      WHERE comparison_project_id = ${comparisonProjectLiteral}
        AND generation = ${generationLiteral}
    ),
    summary_column_counts AS (
      SELECT
        CAST(
          CASE
            WHEN (SELECT COUNT(*) FROM source_project_column_config) > 0
              THEN (SELECT COUNT(*) FROM source_project_column_config)
            ELSE (SELECT COUNT(*) FROM model_config)
          END * (SELECT COUNT(*) FROM content_variant) AS INTEGER
        ) AS llm_column_count,
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

const getNormalizedSummaryAnswerSql = (expression: string) => {
  return `
    CASE
      WHEN LOWER(TRIM(${expression})) IN ('yes', 'no', 'maybe') THEN LOWER(TRIM(${expression}))
      WHEN NULLIF(TRIM(${expression}), '') IS NOT NULL THEN 'maybe'
      ELSE NULL
    END
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
  articleIds,
  comparisonProjectId,
  generation,
}: ComparisonProjectServingCellInsertParams) => {
  const comparisonProjectLiteral = getSqlLiteral(comparisonProjectId)
  const generationLiteral = getComparisonProjectServingGenerationSql(generation)
  const useArticleBatch = articleIds !== undefined

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
    ${getComparisonProjectArticleBatchCtePrefixSql(articleIds)}
    ${getMaterializedPromptModeComparisonProjectConfigCtesSql({comparisonProjectLiteral, generationLiteral})},
    ${getComparisonProjectScopeCtesSql()},
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
      ${getComparisonProjectArticleBatchJoinSql('j.article_id', useArticleBatch)}
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
  articleIds,
  comparisonProjectId,
  generation,
}: ComparisonProjectServingCellInsertParams) => {
  const comparisonProjectLiteral = getSqlLiteral(comparisonProjectId)
  const generationLiteral = getComparisonProjectServingGenerationSql(generation)
  const useArticleBatch = articleIds !== undefined

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
    ${getComparisonProjectArticleBatchCtePrefixSql(articleIds)}
    ${getMaterializedPromptModeComparisonProjectConfigCtesSql({comparisonProjectLiteral, generationLiteral})},
    ${getComparisonProjectScopeCtesSql()},
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
      ${getComparisonProjectArticleBatchJoinSql('h.article_id', useArticleBatch)}
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

const getSummaryModeComparisonProjectLlmCellServingInsertSql = ({
  articleIds,
  comparisonProjectId,
  generation,
}: ComparisonProjectServingCellInsertParams) => {
  const comparisonProjectLiteral = getSqlLiteral(comparisonProjectId)
  const generationLiteral = getComparisonProjectServingGenerationSql(generation)
  const useArticleBatch = articleIds !== undefined

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
        ${getSummaryModeComparisonProjectPredicateSql()}
    ),
    ${getComparisonProjectArticleBatchCtePrefixSql(articleIds)}
    ${getMaterializedSummaryModeComparisonProjectConfigCtesSql({comparisonProjectLiteral, generationLiteral})},
    ${getComparisonProjectScopeCtesSql()},
    llm_source AS (
      SELECT
        j.article_id,
        j.prompt_id,
        j.model_id,
        j.answered_original,
        j.answered_original_as_array,
        j.created_at AS source_created_at,
        j.updated_at AS source_updated_at,
        content_variant.content_order,
        content_variant.content_key
      FROM app.judgment j
      ${getComparisonProjectArticleBatchJoinSql('j.article_id', useArticleBatch)}
      INNER JOIN scoped_article scoped_article ON scoped_article.article_id = j.article_id
      INNER JOIN summary_prompt_id_config prompt_config ON prompt_config.prompt_id = j.prompt_id
      INNER JOIN model_config model_config ON model_config.model_id = j.model_id
      INNER JOIN content_variant content_variant
        ON content_variant.use_title = j.use_title
       AND content_variant.use_abstract = j.use_abstract
       AND content_variant.use_fulltext = j.use_fulltext
       AND content_variant.use_fulltext_no_images = j.use_fulltext_no_images
      WHERE j.deleted_at IS NULL
    ),
    ${getDisplayAnswerCtesSql('llm_source')},
    ${getNormalizedCellCteSql()},
    summary_prompt_answer AS (
      SELECT
        normalized_cell.article_id,
        normalized_cell.model_id,
        normalized_cell.content_key,
        normalized_cell.content_order,
        normalized_cell.prompt_id,
        normalized_cell.source_created_at,
        normalized_cell.source_updated_at,
        summary_prompt_group.summary_group_key,
        summary_prompt_group.source_project_id,
        summary_prompt_group.source_project_order,
        summary_prompt_group.criteria_disposition,
        ${getNormalizedSummaryAnswerSql('normalized_cell.display_answer')} AS normalized_summary_answer,
        ROW_NUMBER() OVER (
          PARTITION BY
            normalized_cell.article_id,
            normalized_cell.model_id,
            normalized_cell.content_key,
            summary_prompt_group.summary_group_key,
            normalized_cell.prompt_id
          ORDER BY
            normalized_cell.source_created_at DESC NULLS LAST,
            normalized_cell.source_updated_at DESC NULLS LAST
        ) AS answer_rank
      FROM normalized_cell
      INNER JOIN summary_prompt_group
        ON summary_prompt_group.prompt_id = normalized_cell.prompt_id
       AND (
         summary_prompt_group.model_id IS NULL
         OR summary_prompt_group.model_id = normalized_cell.model_id
       )
    ),
    latest_summary_prompt_answer AS (
      SELECT *
      FROM summary_prompt_answer
      WHERE answer_rank = 1
        AND normalized_summary_answer IS NOT NULL
    ),
    summary_candidate AS (
      SELECT
        article_id,
        model_id,
        content_key,
        content_order,
        summary_group_key,
        source_project_id,
        source_project_order
      FROM latest_summary_prompt_answer
      GROUP BY
        article_id,
        model_id,
        content_key,
        content_order,
        summary_group_key,
        source_project_id,
        source_project_order
    ),
    summary_rollup AS (
      SELECT
        summary_candidate.article_id,
        summary_candidate.model_id,
        summary_candidate.content_key,
        summary_candidate.content_order,
        summary_candidate.summary_group_key,
        summary_candidate.source_project_id,
        summary_candidate.source_project_order,
        MAX(latest_summary_prompt_answer.source_created_at) AS source_created_at,
        MAX(latest_summary_prompt_answer.source_updated_at) AS source_updated_at,
        SUM(CASE WHEN summary_prompt_group.criteria_disposition IS NULL THEN 1 ELSE 0 END) AS missing_disposition_count,
        SUM(CASE WHEN latest_summary_prompt_answer.prompt_id IS NULL THEN 1 ELSE 0 END) AS missing_answer_count,
        SUM(
          CASE
            WHEN summary_prompt_group.criteria_disposition = 'exclude'
              AND latest_summary_prompt_answer.normalized_summary_answer = 'yes'
              THEN 1
            WHEN summary_prompt_group.criteria_disposition = 'include'
              AND latest_summary_prompt_answer.normalized_summary_answer = 'no'
              THEN 1
            WHEN summary_prompt_group.criteria_disposition = 'combined'
              AND latest_summary_prompt_answer.normalized_summary_answer = 'no'
              THEN 1
            ELSE 0
          END
        ) AS hard_no_count,
        SUM(
          CASE
            WHEN latest_summary_prompt_answer.normalized_summary_answer = 'maybe' THEN 1
            ELSE 0
          END
        ) AS maybe_count
      FROM summary_candidate
      INNER JOIN summary_prompt_group
        ON summary_prompt_group.summary_group_key = summary_candidate.summary_group_key
      LEFT JOIN latest_summary_prompt_answer
        ON latest_summary_prompt_answer.article_id = summary_candidate.article_id
       AND latest_summary_prompt_answer.model_id = summary_candidate.model_id
       AND latest_summary_prompt_answer.content_key = summary_candidate.content_key
       AND latest_summary_prompt_answer.summary_group_key = summary_candidate.summary_group_key
       AND latest_summary_prompt_answer.prompt_id = summary_prompt_group.prompt_id
      GROUP BY
        summary_candidate.article_id,
        summary_candidate.model_id,
        summary_candidate.content_key,
        summary_candidate.content_order,
        summary_candidate.summary_group_key,
        summary_candidate.source_project_id,
        summary_candidate.source_project_order
    ),
    summary_cell AS (
      SELECT
        summary_rollup.*,
        CASE
          WHEN summary_rollup.hard_no_count > 0 THEN 'no'
          WHEN summary_rollup.maybe_count > 0 THEN 'maybe'
          ELSE 'yes'
        END AS display_answer
      FROM summary_rollup
      WHERE summary_rollup.missing_disposition_count = 0
        AND summary_rollup.missing_answer_count = 0
    )
    SELECT
      ${comparisonProjectLiteral} AS comparison_project_id,
      ${generationLiteral} AS generation,
      summary_cell.article_id,
      CASE
        WHEN summary_cell.source_project_id IS NOT NULL
          THEN 'llm:' || summary_cell.source_project_id || ':' || summary_cell.model_id || ':' || summary_cell.content_key || ':${summaryPromptId}'
        ELSE 'llm:' || summary_cell.model_id || ':' || summary_cell.content_key || ':${summaryPromptId}'
      END AS column_id,
      CAST(
        CASE
          WHEN summary_cell.source_project_id IS NOT NULL
            THEN summary_cell.source_project_order * summary_column_counts.content_variant_count
              + summary_cell.content_order
          ELSE model_config.model_order * summary_column_counts.content_variant_count
            + summary_cell.content_order
        END AS INTEGER
      ) AS column_order,
      'llm' AS kind,
      '${summaryPromptId}' AS prompt_id,
      summary_cell.model_id,
      summary_cell.source_project_id,
      summary_cell.content_key,
      summary_cell.display_answer,
      [summary_cell.display_answer] AS normalized_answers,
      summary_cell.source_created_at,
      summary_cell.source_updated_at
    FROM summary_cell
    INNER JOIN model_config ON model_config.model_id = summary_cell.model_id
    CROSS JOIN summary_column_counts
  `
}

const getSummaryModeComparisonProjectHumanCellServingInsertSql = ({
  articleIds,
  comparisonProjectId,
  generation,
}: ComparisonProjectServingCellInsertParams) => {
  const comparisonProjectLiteral = getSqlLiteral(comparisonProjectId)
  const generationLiteral = getComparisonProjectServingGenerationSql(generation)
  const useArticleBatch = articleIds !== undefined

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
        ${getSummaryModeComparisonProjectPredicateSql()}
        AND cp.summary_source_project_id IS NOT NULL
    ),
    ${getComparisonProjectArticleBatchCtePrefixSql(articleIds)}
    ${getMaterializedSummaryModeComparisonProjectConfigCtesSql({comparisonProjectLiteral, generationLiteral})},
    ${getComparisonProjectScopeCtesSql()},
    human_source AS (
      SELECT
        h.article_id,
        ${getNormalizedSummaryAnswerSql('h.answer')} AS display_answer,
        h.created_at AS source_created_at,
        h.updated_at AS source_updated_at
      FROM app.judgment_human_summary h
      ${getComparisonProjectArticleBatchJoinSql('h.article_id', useArticleBatch)}
      INNER JOIN comparison_project cp ON cp.summary_source_project_id = h.project_id
      INNER JOIN scoped_article scoped_article ON scoped_article.article_id = h.article_id
      WHERE NULLIF(TRIM(COALESCE(h.answer, '')), '') IS NOT NULL
    ),
    display_cell AS (
      SELECT *
      FROM human_source
      WHERE display_answer IS NOT NULL
    ),
    ${getNormalizedCellCteSql()}
    SELECT
      ${comparisonProjectLiteral} AS comparison_project_id,
      ${generationLiteral} AS generation,
      normalized_cell.article_id,
      'human:${summaryPromptId}' AS column_id,
      summary_column_counts.llm_column_count AS column_order,
      'human' AS kind,
      '${summaryPromptId}' AS prompt_id,
      NULL AS model_id,
      NULL AS source_project_id,
      NULL AS content_key,
      normalized_cell.display_answer,
      normalized_cell.normalized_answers,
      normalized_cell.source_created_at,
      normalized_cell.source_updated_at
    FROM normalized_cell
    CROSS JOIN summary_column_counts
  `
}

const getComparisonProjectArticleCellBatchSql = ({
  comparisonProjectId,
  cursor,
  modePredicateSql,
}: ComparisonProjectServingCellBuilderParams & {cursor: string | null; modePredicateSql: string}) => {
  const comparisonProjectLiteral = getSqlLiteral(comparisonProjectId)
  const cursorClause = cursor ? `WHERE scoped_article.article_id > ${getSqlLiteral(cursor)}` : ''

  return `
    WITH comparison_project AS (
      SELECT *
      FROM app.comparison_project cp
      WHERE cp.id = ${comparisonProjectLiteral}
        ${modePredicateSql}
    ),
    ${getComparisonProjectScopeCtesSql()}
    SELECT scoped_article.article_id AS articleId
    FROM scoped_article
    INNER JOIN comparison_project cp ON TRUE
    ${cursorClause}
    ORDER BY scoped_article.article_id ASC
    LIMIT ${comparisonProjectServingCellArticleBatchSize + 1}
  `
}

const getComparisonProjectCellQueryJson = (dependencies: ComparisonProjectServingCellBuilderDependencies) => {
  if (dependencies.queryJson) {
    return dependencies.queryJson
  }

  throw new Error('Comparison project serving cell batching requires queryJson')
}

const ensureComparisonProjectServingCellGenerationConfig = (
  params: ComparisonProjectServingCellBuilderParams,
  dependencies: ComparisonProjectServingCellBuilderDependencies,
) => {
  return ensureComparisonProjectServingGenerationConfig(params, {
    queryJson: getComparisonProjectCellQueryJson(dependencies),
    run: dependencies.run,
  })
}

const getComparisonProjectArticleCellBatch = async (
  params: ComparisonProjectServingCellBuilderParams & {cursor: string | null; modePredicateSql: string},
  dependencies: ComparisonProjectServingCellBuilderDependencies,
): Promise<ComparisonProjectArticleCellBatch> => {
  const queryJson = getComparisonProjectCellQueryJson(dependencies)
  const rows = await queryJson<{articleId: string}>(getComparisonProjectArticleCellBatchSql(params))
  const articleIds = rows.slice(0, comparisonProjectServingCellArticleBatchSize).map((row) => {
    return row.articleId
  })

  return {articleIds, hasMore: rows.length > comparisonProjectServingCellArticleBatchSize}
}

const getComparisonProjectArticleCellBatchCursor = (batch: ComparisonProjectArticleCellBatch) => {
  return batch.articleIds[batch.articleIds.length - 1] ?? null
}

const insertComparisonProjectArticleCellBatches = async (
  params: ComparisonProjectServingCellBuilderParams,
  dependencies: ComparisonProjectServingCellBuilderDependencies,
  modePredicateSql: string,
  insertBatch: (insertParams: ComparisonProjectServingCellInsertParams) => Promise<void>,
  cursor: string | null = null,
): Promise<void> => {
  const batch = await getComparisonProjectArticleCellBatch({...params, cursor, modePredicateSql}, dependencies)
  const nextCursor = getComparisonProjectArticleCellBatchCursor(batch)

  if (batch.articleIds.length === 0 || nextCursor === null) {
    return
  }

  await insertBatch({...params, articleIds: batch.articleIds})

  return batch.hasMore
    ? insertComparisonProjectArticleCellBatches(params, dependencies, modePredicateSql, insertBatch, nextCursor)
    : undefined
}

const insertPromptModeComparisonProjectLlmCells = async (
  params: ComparisonProjectServingCellBuilderParams,
  dependencies: ComparisonProjectServingCellBuilderDependencies = getDefaultComparisonProjectServingCellBuilderDependencies(),
) => {
  await ensureComparisonProjectServingCellGenerationConfig(params, dependencies)

  return insertComparisonProjectArticleCellBatches(
    params,
    dependencies,
    getPromptModeComparisonProjectPredicateSql(),
    (batch) => {
      return dependencies.run(getPromptModeComparisonProjectLlmCellServingInsertSql(batch))
    },
  )
}

const insertPromptModeComparisonProjectHumanCells = async (
  params: ComparisonProjectServingCellBuilderParams,
  dependencies: ComparisonProjectServingCellBuilderDependencies = getDefaultComparisonProjectServingCellBuilderDependencies(),
) => {
  await ensureComparisonProjectServingCellGenerationConfig(params, dependencies)

  return insertComparisonProjectArticleCellBatches(
    params,
    dependencies,
    getHumanPromptModeComparisonProjectPredicateSql(),
    (batch) => {
      return dependencies.run(getPromptModeComparisonProjectHumanCellServingInsertSql(batch))
    },
  )
}

const insertPromptModeComparisonProjectCells = async (
  params: ComparisonProjectServingCellBuilderParams,
  runner: ComparisonProjectServingCellBuilderRunner = getDefaultComparisonProjectServingCellBuilderDependencies(),
) => {
  await ensureComparisonProjectServingGenerationConfig(params, runner)

  return insertComparisonProjectArticleCellBatches(
    params,
    runner,
    getPromptModeComparisonProjectPredicateSql(),
    async (batch) => {
      await runner.run(getPromptModeComparisonProjectLlmCellServingInsertSql(batch))
      await runner.run(getPromptModeComparisonProjectHumanCellServingInsertSql(batch))
    },
  )
}

const insertSummaryModeComparisonProjectLlmCells = async (
  params: ComparisonProjectServingCellBuilderParams,
  dependencies: ComparisonProjectServingCellBuilderDependencies = getDefaultComparisonProjectServingCellBuilderDependencies(),
) => {
  await ensureComparisonProjectServingCellGenerationConfig(params, dependencies)

  return insertComparisonProjectArticleCellBatches(
    params,
    dependencies,
    getSummaryModeComparisonProjectPredicateSql(),
    (batch) => {
      return dependencies.run(getSummaryModeComparisonProjectLlmCellServingInsertSql(batch))
    },
  )
}

const insertSummaryModeComparisonProjectHumanCells = async (
  params: ComparisonProjectServingCellBuilderParams,
  dependencies: ComparisonProjectServingCellBuilderDependencies = getDefaultComparisonProjectServingCellBuilderDependencies(),
) => {
  await ensureComparisonProjectServingCellGenerationConfig(params, dependencies)

  return insertComparisonProjectArticleCellBatches(
    params,
    dependencies,
    getSummaryModeComparisonProjectPredicateSql(),
    (batch) => {
      return dependencies.run(getSummaryModeComparisonProjectHumanCellServingInsertSql(batch))
    },
  )
}

const insertSummaryModeComparisonProjectCells = async (
  params: ComparisonProjectServingCellBuilderParams,
  runner: ComparisonProjectServingCellBuilderRunner = getDefaultComparisonProjectServingCellBuilderDependencies(),
) => {
  await ensureComparisonProjectServingGenerationConfig(params, runner)

  return insertComparisonProjectArticleCellBatches(
    params,
    runner,
    getSummaryModeComparisonProjectPredicateSql(),
    async (batch) => {
      await runner.run(getSummaryModeComparisonProjectLlmCellServingInsertSql(batch))
      await runner.run(getSummaryModeComparisonProjectHumanCellServingInsertSql(batch))
    },
  )
}

const comparisonProjectServingCellBuilder = {
  getPromptModeComparisonProjectHumanCellServingInsertSql,
  getPromptModeComparisonProjectLlmCellServingInsertSql,
  getSummaryModeComparisonProjectHumanCellServingInsertSql,
  getSummaryModeComparisonProjectLlmCellServingInsertSql,
  insertPromptModeComparisonProjectCells,
  insertPromptModeComparisonProjectHumanCells,
  insertPromptModeComparisonProjectLlmCells,
  insertSummaryModeComparisonProjectCells,
  insertSummaryModeComparisonProjectHumanCells,
  insertSummaryModeComparisonProjectLlmCells,
}

export const getComparisonProjectServingCellBuilder = () => {
  return comparisonProjectServingCellBuilder
}

export {
  getPromptModeComparisonProjectHumanCellServingInsertSql,
  getPromptModeComparisonProjectLlmCellServingInsertSql,
  getSummaryModeComparisonProjectHumanCellServingInsertSql,
  getSummaryModeComparisonProjectLlmCellServingInsertSql,
}

export type {ComparisonProjectServingCellBuilderParams}
