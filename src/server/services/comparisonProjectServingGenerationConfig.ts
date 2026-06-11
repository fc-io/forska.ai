import {getSqlLiteral} from './appQueryHelpers.ts'

type ComparisonProjectServingGenerationConfigRunner = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
}

type ComparisonProjectServingGenerationConfigParams = {comparisonProjectId: string; generation: number}

type ComparisonProjectServingGenerationConfigTableKey =
  | 'contentVariant'
  | 'modelConfig'
  | 'promptConfig'
  | 'requiredColumn'
  | 'sourceProjectColumnConfig'
  | 'sourceProjectConfig'
  | 'state'
  | 'summaryPromptGroup'

const summaryPromptId = 'summary'

const comparisonProjectServingGenerationConfigTables: Record<ComparisonProjectServingGenerationConfigTableKey, string> =
  {
    contentVariant: 'comparison_serving_generation_content_variant_config',
    modelConfig: 'comparison_serving_generation_model_config',
    promptConfig: 'comparison_serving_generation_prompt_config',
    requiredColumn: 'comparison_serving_generation_required_column_config',
    sourceProjectColumnConfig: 'comparison_serving_generation_source_project_column_config',
    sourceProjectConfig: 'comparison_serving_generation_source_project_config',
    state: 'comparison_serving_generation_config_state',
    summaryPromptGroup: 'comparison_serving_generation_summary_prompt_group_config',
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

const getCreateComparisonProjectServingGenerationConfigTableStatements = () => {
  return [
    `
      CREATE TEMP TABLE IF NOT EXISTS ${comparisonProjectServingGenerationConfigTables.state} (
        comparison_project_id VARCHAR NOT NULL,
        generation BIGINT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
        PRIMARY KEY(comparison_project_id, generation)
      )
    `,
    `
      CREATE TEMP TABLE IF NOT EXISTS ${comparisonProjectServingGenerationConfigTables.promptConfig} (
        comparison_project_id VARCHAR NOT NULL,
        generation BIGINT NOT NULL,
        prompt_id VARCHAR NOT NULL,
        prompt_order INTEGER NOT NULL
      )
    `,
    `
      CREATE TEMP TABLE IF NOT EXISTS ${comparisonProjectServingGenerationConfigTables.contentVariant} (
        comparison_project_id VARCHAR NOT NULL,
        generation BIGINT NOT NULL,
        content_order INTEGER NOT NULL,
        content_key VARCHAR NOT NULL,
        use_title BOOLEAN NOT NULL,
        use_abstract BOOLEAN NOT NULL,
        use_fulltext BOOLEAN NOT NULL,
        use_fulltext_no_images BOOLEAN NOT NULL
      )
    `,
    `
      CREATE TEMP TABLE IF NOT EXISTS ${comparisonProjectServingGenerationConfigTables.modelConfig} (
        comparison_project_id VARCHAR NOT NULL,
        generation BIGINT NOT NULL,
        mode VARCHAR NOT NULL,
        model_id VARCHAR NOT NULL,
        model_order INTEGER NOT NULL
      )
    `,
    `
      CREATE TEMP TABLE IF NOT EXISTS ${comparisonProjectServingGenerationConfigTables.sourceProjectConfig} (
        comparison_project_id VARCHAR NOT NULL,
        generation BIGINT NOT NULL,
        source_project_id VARCHAR NOT NULL,
        model_id VARCHAR NOT NULL,
        source_project_order INTEGER NOT NULL
      )
    `,
    `
      CREATE TEMP TABLE IF NOT EXISTS ${comparisonProjectServingGenerationConfigTables.summaryPromptGroup} (
        comparison_project_id VARCHAR NOT NULL,
        generation BIGINT NOT NULL,
        summary_group_key VARCHAR NOT NULL,
        source_project_id VARCHAR,
        model_id VARCHAR,
        source_project_order INTEGER NOT NULL,
        prompt_id VARCHAR NOT NULL,
        prompt_order INTEGER NOT NULL,
        criteria_disposition VARCHAR
      )
    `,
    `
      CREATE TEMP TABLE IF NOT EXISTS ${comparisonProjectServingGenerationConfigTables.sourceProjectColumnConfig} (
        comparison_project_id VARCHAR NOT NULL,
        generation BIGINT NOT NULL,
        source_project_id VARCHAR NOT NULL,
        model_id VARCHAR NOT NULL,
        source_project_order INTEGER NOT NULL
      )
    `,
    `
      CREATE TEMP TABLE IF NOT EXISTS ${comparisonProjectServingGenerationConfigTables.requiredColumn} (
        comparison_project_id VARCHAR NOT NULL,
        generation BIGINT NOT NULL,
        column_id VARCHAR NOT NULL,
        kind VARCHAR NOT NULL,
        prompt_id VARCHAR NOT NULL
      )
    `,
  ]
}

const getClearComparisonProjectServingGenerationConfigStatements = ({
  comparisonProjectId,
  generation,
}: ComparisonProjectServingGenerationConfigParams) => {
  const comparisonProjectLiteral = getSqlLiteral(comparisonProjectId)
  const generationLiteral = getComparisonProjectServingGenerationSql(generation)
  const tableNames = [
    comparisonProjectServingGenerationConfigTables.state,
    comparisonProjectServingGenerationConfigTables.promptConfig,
    comparisonProjectServingGenerationConfigTables.contentVariant,
    comparisonProjectServingGenerationConfigTables.modelConfig,
    comparisonProjectServingGenerationConfigTables.sourceProjectConfig,
    comparisonProjectServingGenerationConfigTables.summaryPromptGroup,
    comparisonProjectServingGenerationConfigTables.sourceProjectColumnConfig,
    comparisonProjectServingGenerationConfigTables.requiredColumn,
  ]

  return tableNames.map((tableName) => {
    return `
      DELETE FROM ${tableName}
      WHERE comparison_project_id = ${comparisonProjectLiteral}
        AND generation = ${generationLiteral}
    `
  })
}

const getPromptConfigInsertSql = ({
  comparisonProjectId,
  generation,
}: ComparisonProjectServingGenerationConfigParams) => {
  const comparisonProjectLiteral = getSqlLiteral(comparisonProjectId)
  const generationLiteral = getComparisonProjectServingGenerationSql(generation)

  return `
    INSERT INTO ${comparisonProjectServingGenerationConfigTables.promptConfig} (
      comparison_project_id,
      generation,
      prompt_id,
      prompt_order
    )
    WITH comparison_project AS (
      SELECT *
      FROM app.comparison_project cp
      WHERE cp.id = ${comparisonProjectLiteral}
    )
    SELECT
      ${comparisonProjectLiteral} AS comparison_project_id,
      ${generationLiteral} AS generation,
      cpp.prompt_id,
      CAST(
        ROW_NUMBER() OVER (
          ORDER BY cpp.prompt_order ASC NULLS LAST, p.created_at ASC, p.id ASC
        ) - 1 AS INTEGER
      ) AS prompt_order
    FROM app.comparison_project_prompt cpp
    INNER JOIN comparison_project cp ON cp.id = cpp.comparison_project_id
    INNER JOIN app.prompt p ON p.id = cpp.prompt_id
  `
}

const getContentVariantInsertSql = ({
  comparisonProjectId,
  generation,
}: ComparisonProjectServingGenerationConfigParams) => {
  const comparisonProjectLiteral = getSqlLiteral(comparisonProjectId)
  const generationLiteral = getComparisonProjectServingGenerationSql(generation)

  return `
    INSERT INTO ${comparisonProjectServingGenerationConfigTables.contentVariant} (
      comparison_project_id,
      generation,
      content_order,
      content_key,
      use_title,
      use_abstract,
      use_fulltext,
      use_fulltext_no_images
    )
    WITH comparison_project AS (
      SELECT *
      FROM app.comparison_project cp
      WHERE cp.id = ${comparisonProjectLiteral}
    )
    SELECT
      ${comparisonProjectLiteral} AS comparison_project_id,
      ${generationLiteral} AS generation,
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
      ${comparisonProjectLiteral} AS comparison_project_id,
      ${generationLiteral} AS generation,
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
      ${comparisonProjectLiteral} AS comparison_project_id,
      ${generationLiteral} AS generation,
      2 AS content_order,
      '0001' AS content_key,
      FALSE AS use_title,
      FALSE AS use_abstract,
      FALSE AS use_fulltext,
      TRUE AS use_fulltext_no_images
    FROM comparison_project cp
    WHERE cp.use_fulltext_no_images = TRUE
  `
}

const getSourceProjectConfigInsertSql = ({
  comparisonProjectId,
  generation,
}: ComparisonProjectServingGenerationConfigParams) => {
  const comparisonProjectLiteral = getSqlLiteral(comparisonProjectId)
  const generationLiteral = getComparisonProjectServingGenerationSql(generation)

  return `
    INSERT INTO ${comparisonProjectServingGenerationConfigTables.sourceProjectConfig} (
      comparison_project_id,
      generation,
      source_project_id,
      model_id,
      source_project_order
    )
    WITH comparison_project AS (
      SELECT *
      FROM app.comparison_project cp
      WHERE cp.id = ${comparisonProjectLiteral}
        ${getSummaryModeComparisonProjectPredicateSql()}
    )
    SELECT
      ${comparisonProjectLiteral} AS comparison_project_id,
      ${generationLiteral} AS generation,
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
  `
}

const getSummaryPromptGroupInsertSql = ({
  comparisonProjectId,
  generation,
}: ComparisonProjectServingGenerationConfigParams) => {
  const comparisonProjectLiteral = getSqlLiteral(comparisonProjectId)
  const generationLiteral = getComparisonProjectServingGenerationSql(generation)

  return `
    INSERT INTO ${comparisonProjectServingGenerationConfigTables.summaryPromptGroup} (
      comparison_project_id,
      generation,
      summary_group_key,
      source_project_id,
      model_id,
      source_project_order,
      prompt_id,
      prompt_order,
      criteria_disposition
    )
    WITH comparison_project AS (
      SELECT *
      FROM app.comparison_project cp
      WHERE cp.id = ${comparisonProjectLiteral}
        ${getSummaryModeComparisonProjectPredicateSql()}
    ),
    source_project_config AS (
      SELECT
        source_project_id,
        model_id,
        source_project_order
      FROM ${comparisonProjectServingGenerationConfigTables.sourceProjectConfig}
      WHERE comparison_project_id = ${comparisonProjectLiteral}
        AND generation = ${generationLiteral}
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
    )
    SELECT
      ${comparisonProjectLiteral} AS comparison_project_id,
      ${generationLiteral} AS generation,
      summary_group_key,
      source_project_id,
      model_id,
      source_project_order,
      prompt_id,
      prompt_order,
      criteria_disposition
    FROM summary_prompt_group
  `
}

const getModelConfigInsertSql = ({
  comparisonProjectId,
  generation,
  mode,
  modePredicateSql,
  promptConfigSql,
}: ComparisonProjectServingGenerationConfigParams & {
  mode: 'prompt' | 'summary'
  modePredicateSql: string
  promptConfigSql: string
}) => {
  const comparisonProjectLiteral = getSqlLiteral(comparisonProjectId)
  const generationLiteral = getComparisonProjectServingGenerationSql(generation)
  const modeLiteral = getSqlLiteral(mode)

  return `
    INSERT INTO ${comparisonProjectServingGenerationConfigTables.modelConfig} (
      comparison_project_id,
      generation,
      mode,
      model_id,
      model_order
    )
    WITH comparison_project AS (
      SELECT *
      FROM app.comparison_project cp
      WHERE cp.id = ${comparisonProjectLiteral}
        ${modePredicateSql}
    ),
    prompt_config AS (
      ${promptConfigSql}
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
    ${getComparisonProjectScopeCtesSql()},
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
    )
    SELECT
      ${comparisonProjectLiteral} AS comparison_project_id,
      ${generationLiteral} AS generation,
      ${modeLiteral} AS mode,
      model_id,
      model_order
    FROM model_config
  `
}

const getPromptModelConfigInsertSql = (params: ComparisonProjectServingGenerationConfigParams) => {
  const comparisonProjectLiteral = getSqlLiteral(params.comparisonProjectId)
  const generationLiteral = getComparisonProjectServingGenerationSql(params.generation)

  return getModelConfigInsertSql({
    ...params,
    mode: 'prompt',
    modePredicateSql: getPromptModeComparisonProjectPredicateSql(),
    promptConfigSql: `
      SELECT prompt_id
      FROM ${comparisonProjectServingGenerationConfigTables.promptConfig}
      WHERE comparison_project_id = ${comparisonProjectLiteral}
        AND generation = ${generationLiteral}
    `,
  })
}

const getSummaryModelConfigInsertSql = (params: ComparisonProjectServingGenerationConfigParams) => {
  const comparisonProjectLiteral = getSqlLiteral(params.comparisonProjectId)
  const generationLiteral = getComparisonProjectServingGenerationSql(params.generation)

  return getModelConfigInsertSql({
    ...params,
    mode: 'summary',
    modePredicateSql: getSummaryModeComparisonProjectPredicateSql(),
    promptConfigSql: `
      SELECT prompt_id
      FROM ${comparisonProjectServingGenerationConfigTables.summaryPromptGroup}
      WHERE comparison_project_id = ${comparisonProjectLiteral}
        AND generation = ${generationLiteral}
      GROUP BY prompt_id
    `,
  })
}

const getSourceProjectColumnConfigInsertSql = ({
  comparisonProjectId,
  generation,
}: ComparisonProjectServingGenerationConfigParams) => {
  const comparisonProjectLiteral = getSqlLiteral(comparisonProjectId)
  const generationLiteral = getComparisonProjectServingGenerationSql(generation)

  return `
    INSERT INTO ${comparisonProjectServingGenerationConfigTables.sourceProjectColumnConfig} (
      comparison_project_id,
      generation,
      source_project_id,
      model_id,
      source_project_order
    )
    WITH source_project_summary_prompt_count AS (
      SELECT COUNT(*) AS prompt_count
      FROM ${comparisonProjectServingGenerationConfigTables.summaryPromptGroup}
      WHERE comparison_project_id = ${comparisonProjectLiteral}
        AND generation = ${generationLiteral}
        AND source_project_id IS NOT NULL
    )
    SELECT
      ${comparisonProjectLiteral} AS comparison_project_id,
      ${generationLiteral} AS generation,
      source_project_config.source_project_id,
      source_project_config.model_id,
      source_project_config.source_project_order
    FROM ${comparisonProjectServingGenerationConfigTables.sourceProjectConfig} source_project_config
    INNER JOIN ${comparisonProjectServingGenerationConfigTables.modelConfig} summary_model_config
      ON summary_model_config.comparison_project_id = source_project_config.comparison_project_id
     AND summary_model_config.generation = source_project_config.generation
     AND summary_model_config.mode = 'summary'
     AND summary_model_config.model_id = source_project_config.model_id
    CROSS JOIN source_project_summary_prompt_count
    WHERE source_project_config.comparison_project_id = ${comparisonProjectLiteral}
      AND source_project_config.generation = ${generationLiteral}
      AND source_project_summary_prompt_count.prompt_count > 0
  `
}

const getRequiredColumnInsertSql = ({
  comparisonProjectId,
  generation,
}: ComparisonProjectServingGenerationConfigParams) => {
  const comparisonProjectLiteral = getSqlLiteral(comparisonProjectId)
  const generationLiteral = getComparisonProjectServingGenerationSql(generation)

  return `
    INSERT INTO ${comparisonProjectServingGenerationConfigTables.requiredColumn} (
      comparison_project_id,
      generation,
      column_id,
      kind,
      prompt_id
    )
    WITH comparison_project AS (
      SELECT *
      FROM app.comparison_project cp
      WHERE cp.id = ${comparisonProjectLiteral}
    ),
    prompt_config AS (
      SELECT prompt_id
      FROM ${comparisonProjectServingGenerationConfigTables.promptConfig}
      WHERE comparison_project_id = ${comparisonProjectLiteral}
        AND generation = ${generationLiteral}
    ),
    content_variant AS (
      SELECT content_key
      FROM ${comparisonProjectServingGenerationConfigTables.contentVariant}
      WHERE comparison_project_id = ${comparisonProjectLiteral}
        AND generation = ${generationLiteral}
    ),
    prompt_model_config AS (
      SELECT model_id
      FROM ${comparisonProjectServingGenerationConfigTables.modelConfig}
      WHERE comparison_project_id = ${comparisonProjectLiteral}
        AND generation = ${generationLiteral}
        AND mode = 'prompt'
    ),
    summary_model_config AS (
      SELECT model_id
      FROM ${comparisonProjectServingGenerationConfigTables.modelConfig}
      WHERE comparison_project_id = ${comparisonProjectLiteral}
        AND generation = ${generationLiteral}
        AND mode = 'summary'
    ),
    source_project_column_config AS (
      SELECT
        source_project_id,
        model_id
      FROM ${comparisonProjectServingGenerationConfigTables.sourceProjectColumnConfig}
      WHERE comparison_project_id = ${comparisonProjectLiteral}
        AND generation = ${generationLiteral}
    ),
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
    SELECT
      ${comparisonProjectLiteral} AS comparison_project_id,
      ${generationLiteral} AS generation,
      column_id,
      kind,
      prompt_id
    FROM required_column
  `
}

const getMarkComparisonProjectServingGenerationConfigReadySql = ({
  comparisonProjectId,
  generation,
}: ComparisonProjectServingGenerationConfigParams) => {
  return `
    INSERT INTO ${comparisonProjectServingGenerationConfigTables.state} (
      comparison_project_id,
      generation,
      created_at
    ) VALUES (
      ${getSqlLiteral(comparisonProjectId)},
      ${getComparisonProjectServingGenerationSql(generation)},
      current_timestamp
    )
  `
}

const getMaterializeComparisonProjectServingGenerationConfigStatements = (
  params: ComparisonProjectServingGenerationConfigParams,
) => {
  return [
    ...getClearComparisonProjectServingGenerationConfigStatements(params),
    getPromptConfigInsertSql(params),
    getContentVariantInsertSql(params),
    getSourceProjectConfigInsertSql(params),
    getSummaryPromptGroupInsertSql(params),
    getPromptModelConfigInsertSql(params),
    getSummaryModelConfigInsertSql(params),
    getSourceProjectColumnConfigInsertSql(params),
    getRequiredColumnInsertSql(params),
    getMarkComparisonProjectServingGenerationConfigReadySql(params),
  ]
}

const runComparisonProjectServingGenerationConfigStatements = async (
  runner: Pick<ComparisonProjectServingGenerationConfigRunner, 'run'>,
  statements: readonly string[],
  index = 0,
): Promise<void> => {
  if (index >= statements.length) {
    return
  }

  await runner.run(statements[index] ?? '')

  return runComparisonProjectServingGenerationConfigStatements(runner, statements, index + 1)
}

const getComparisonProjectServingGenerationConfigExists = async (
  params: ComparisonProjectServingGenerationConfigParams,
  runner: ComparisonProjectServingGenerationConfigRunner,
) => {
  const rows = await runner.queryJson<{ready: number}>(`
    SELECT 1 AS ready
    FROM ${comparisonProjectServingGenerationConfigTables.state}
    WHERE comparison_project_id = ${getSqlLiteral(params.comparisonProjectId)}
      AND generation = ${getComparisonProjectServingGenerationSql(params.generation)}
    LIMIT 1
  `)

  return rows.length > 0
}

const ensureComparisonProjectServingGenerationConfig = async (
  params: ComparisonProjectServingGenerationConfigParams,
  runner: ComparisonProjectServingGenerationConfigRunner,
) => {
  await runComparisonProjectServingGenerationConfigStatements(
    runner,
    getCreateComparisonProjectServingGenerationConfigTableStatements(),
  )

  const exists = await getComparisonProjectServingGenerationConfigExists(params, runner)

  return exists
    ? undefined
    : runComparisonProjectServingGenerationConfigStatements(
        runner,
        getMaterializeComparisonProjectServingGenerationConfigStatements(params),
      )
}

export {
  comparisonProjectServingGenerationConfigTables,
  ensureComparisonProjectServingGenerationConfig,
  getComparisonProjectServingGenerationSql,
}

export type {ComparisonProjectServingGenerationConfigParams, ComparisonProjectServingGenerationConfigRunner}
