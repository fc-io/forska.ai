import {getJsonValue, getSqlLiteral} from './appQueryHelpers.ts'
import {
  type ComparisonJudgmentContextColumnRow,
  type ComparisonJudgmentContextCriterionRow,
  type ComparisonJudgmentContextGenerationParams,
  type ComparisonJudgmentContextHumanJudgmentMode,
  getComparisonJudgmentContext,
  getComparisonJudgmentContextGenerationLiteral,
  storeComparisonJudgmentContextForGeneration,
} from './comparisonJudgmentContext.ts'
import {
  comparisonProjectServingGenerationConfigTables,
  ensureComparisonProjectServingGenerationConfig,
} from './comparisonProjectServingGenerationConfig.ts'

type ComparisonJudgmentContextDerivationRunner = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
}

type ComparisonJudgmentContextProjectRow = {
  compareWithHumans: unknown
  humanJudgmentMode: string | null
  sourceProjectIds: unknown
  summarySourceProjectId: string | null
}

const summaryPromptId = 'summary'

const getGenerationConfigFilterSql = (params: ComparisonJudgmentContextGenerationParams) => {
  return `comparison_project_id = ${getSqlLiteral(params.comparisonProjectId)}
        AND generation = ${getComparisonJudgmentContextGenerationLiteral(params.generation)}`
}

export const getComparisonJudgmentContextConfigColumnsSql = (params: ComparisonJudgmentContextGenerationParams) => {
  const filterSql = getGenerationConfigFilterSql(params)
  const tables = comparisonProjectServingGenerationConfigTables

  return `
    WITH comparison_project AS (
      SELECT
        cp.compare_with_humans = TRUE AND COALESCE(cp.human_judgment_mode, 'prompt') = 'summary' AS is_summary,
        cp.compare_with_humans = TRUE AND COALESCE(cp.human_judgment_mode, 'prompt') = 'prompt' AS has_prompt_humans
      FROM app.comparison_project cp
      WHERE cp.id = ${getSqlLiteral(params.comparisonProjectId)}
    ),
    prompt_config AS (
      SELECT prompt_id FROM ${tables.promptConfig} WHERE ${filterSql}
    ),
    content_variant AS (
      SELECT content_key, system_prompt_variant, use_title, use_abstract, use_fulltext, use_fulltext_no_images, use_metadata
      FROM ${tables.contentVariant}
      WHERE ${filterSql}
    ),
    prompt_model AS (
      SELECT model_id FROM ${tables.modelConfig} WHERE ${filterSql} AND mode = 'prompt'
    ),
    summary_model AS (
      SELECT model_id FROM ${tables.modelConfig} WHERE ${filterSql} AND mode = 'summary'
    ),
    source_column AS (
      SELECT source_project_id, model_id, system_prompt_variant, use_metadata
      FROM ${tables.sourceProjectColumnConfig}
      WHERE ${filterSql}
    ),
    context_column AS (
      SELECT
        'llm' AS kind,
        prompt_config.prompt_id,
        prompt_model.model_id,
        CAST(NULL AS VARCHAR) AS source_project_id,
        content_variant.*
      FROM comparison_project
      CROSS JOIN prompt_config
      CROSS JOIN prompt_model
      CROSS JOIN content_variant
      WHERE NOT comparison_project.is_summary

      UNION ALL BY NAME

      SELECT 'human' AS kind, prompt_config.prompt_id
      FROM comparison_project
      CROSS JOIN prompt_config
      WHERE comparison_project.has_prompt_humans

      UNION ALL BY NAME

      SELECT
        'llm' AS kind,
        ${getSqlLiteral(summaryPromptId)} AS prompt_id,
        source_column.model_id,
        source_column.source_project_id,
        content_variant.*
      FROM comparison_project
      CROSS JOIN source_column
      INNER JOIN content_variant
        ON content_variant.system_prompt_variant = source_column.system_prompt_variant
       AND content_variant.use_metadata = source_column.use_metadata
      WHERE comparison_project.is_summary

      UNION ALL BY NAME

      SELECT
        'llm' AS kind,
        ${getSqlLiteral(summaryPromptId)} AS prompt_id,
        summary_model.model_id,
        CAST(NULL AS VARCHAR) AS source_project_id,
        content_variant.*
      FROM comparison_project
      CROSS JOIN summary_model
      CROSS JOIN content_variant
      WHERE comparison_project.is_summary
        AND NOT EXISTS (SELECT 1 FROM source_column)

      UNION ALL BY NAME

      SELECT 'human' AS kind, ${getSqlLiteral(summaryPromptId)} AS prompt_id
      FROM comparison_project
      WHERE comparison_project.is_summary
    )
    SELECT
      context_column.kind,
      context_column.prompt_id AS promptId,
      NULLIF(TRIM(prompt.prompt_heading), '') AS promptHeading,
      context_column.model_id AS modelId,
      model.name AS modelName,
      context_column.source_project_id AS sourceProjectId,
      context_column.content_key AS contentKey,
      context_column.system_prompt_variant AS systemPromptVariant,
      context_column.use_title AS useTitle,
      context_column.use_abstract AS useAbstract,
      context_column.use_fulltext AS useFulltext,
      context_column.use_fulltext_no_images AS useFulltextNoImages,
      context_column.use_metadata AS useMetadata
    FROM context_column
    LEFT JOIN app.prompt prompt ON prompt.id = context_column.prompt_id
    LEFT JOIN app.model model ON model.id = context_column.model_id
  `
}

export const getComparisonJudgmentContextConfigCriteriaSql = (params: ComparisonJudgmentContextGenerationParams) => {
  return `
    SELECT
      summary_prompt_group.source_project_id AS sourceProjectId,
      summary_prompt_group.prompt_id AS promptId,
      NULLIF(TRIM(prompt.prompt_heading), '') AS promptHeading,
      summary_prompt_group.criteria_disposition AS criteriaDisposition
    FROM ${comparisonProjectServingGenerationConfigTables.summaryPromptGroup} summary_prompt_group
    LEFT JOIN app.prompt prompt ON prompt.id = summary_prompt_group.prompt_id
    WHERE summary_prompt_group.comparison_project_id = ${getSqlLiteral(params.comparisonProjectId)}
      AND summary_prompt_group.generation = ${getComparisonJudgmentContextGenerationLiteral(params.generation)}
  `
}

export const getComparisonJudgmentContextProjectSql = (comparisonProjectId: string) => {
  return `
    SELECT
      cp.compare_with_humans AS compareWithHumans,
      COALESCE(cp.human_judgment_mode, 'prompt') AS humanJudgmentMode,
      cp.summary_source_project_id AS summarySourceProjectId,
      TO_JSON(COALESCE((
        SELECT LIST(cpsp.source_project_id)
        FROM app.comparison_project_source_project cpsp
        WHERE cpsp.comparison_project_id = cp.id
      ), [])) AS sourceProjectIds
    FROM app.comparison_project cp
    WHERE cp.id = ${getSqlLiteral(comparisonProjectId)}
    LIMIT 1
  `
}

const getHumanJudgmentMode = (row: ComparisonJudgmentContextProjectRow): ComparisonJudgmentContextHumanJudgmentMode => {
  return row.compareWithHumans === true && row.humanJudgmentMode === 'summary' ? 'summary' : 'prompt'
}

const getStringArrayValue = (value: unknown) => {
  const parsedValue = getJsonValue(value)

  return Array.isArray(parsedValue)
    ? parsedValue.filter((entry): entry is string => {
        return typeof entry === 'string'
      })
    : []
}

export const computeComparisonJudgmentContextFromGenerationConfig = async (
  runner: ComparisonJudgmentContextDerivationRunner,
  params: ComparisonJudgmentContextGenerationParams,
) => {
  const [projectRow] = await runner.queryJson<ComparisonJudgmentContextProjectRow>(
    getComparisonJudgmentContextProjectSql(params.comparisonProjectId),
  )

  if (!projectRow) {
    return null
  }

  await ensureComparisonProjectServingGenerationConfig(params, runner, {persistSystemPromptVariantServing: false})

  const columns = await runner.queryJson<ComparisonJudgmentContextColumnRow>(
    getComparisonJudgmentContextConfigColumnsSql(params),
  )
  const criteria = await runner.queryJson<ComparisonJudgmentContextCriterionRow>(
    getComparisonJudgmentContextConfigCriteriaSql(params),
  )

  return getComparisonJudgmentContext({
    columns,
    criteria,
    humanJudgmentMode: getHumanJudgmentMode(projectRow),
    sourceProjectIds: getStringArrayValue(projectRow.sourceProjectIds),
    summarySourceProjectId: projectRow.summarySourceProjectId ?? null,
  })
}

const getErrorMessage = (error: unknown) => {
  return error instanceof Error ? error.message : String(error)
}

export const recordComparisonJudgmentContextForGenerationConfig = async (
  runner: ComparisonJudgmentContextDerivationRunner,
  params: ComparisonJudgmentContextGenerationParams,
) => {
  try {
    const context = await computeComparisonJudgmentContextFromGenerationConfig(runner, params)

    return context ? await storeComparisonJudgmentContextForGeneration(runner, {...params, context}) : null
  } catch (error) {
    console.warn('[comparison-serving] judgment context write failed; the maintenance backfill will retry', {
      comparisonProjectId: params.comparisonProjectId,
      errorMessage: getErrorMessage(error),
      generation: params.generation,
    })

    return null
  }
}
