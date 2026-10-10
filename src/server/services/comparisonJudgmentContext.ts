import {createHash} from 'node:crypto'

import {type as arktype} from 'arktype'

import {defaultSystemPromptVariant} from '../../agent/judge/systemPromptVariant.ts'
import {getDateValue, getJsonValue, getQuotedStringList, getSqlLiteral} from './appQueryHelpers.ts'

type ComparisonJudgmentContextRunner = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
}

type ComparisonJudgmentContextQueryRunner = Pick<ComparisonJudgmentContextRunner, 'queryJson'>

type ComparisonJudgmentContextGenerationParams = {comparisonProjectId: string; generation: number}

export type ComparisonJudgmentContextHumanJudgmentMode = 'prompt' | 'summary'

export type ComparisonJudgmentContextContentSettings = {
  systemPromptVariant: string
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useMetadata: boolean
  useTitle: boolean
}

export type ComparisonJudgmentContextLlmColumn = ComparisonJudgmentContextContentSettings & {
  criteriaDisposition: string | null
  kind: 'llm'
  modelId: string
  modelName: string | null
  promptHeading: string | null
  promptId: string
  sourceProjectId: string | null
}

export type ComparisonJudgmentContextHumanColumn = {kind: 'human'; promptHeading: string | null; promptId: string}

export type ComparisonJudgmentContextColumn = ComparisonJudgmentContextHumanColumn | ComparisonJudgmentContextLlmColumn

export type ComparisonJudgmentContext = {
  columns: ComparisonJudgmentContextColumn[]
  humanJudgmentMode: ComparisonJudgmentContextHumanJudgmentMode
  sourceProjectIds: string[]
  summarySourceProjectId: string | null
  v: 1
}

export type ComparisonJudgmentContextServedColumn = {
  contentKey: string | null
  criteriaDisposition: string | null
  kind: string
  modelId: string | null
  modelName: string | null
  promptHeading: string | null
  promptId: string
  sourceProjectId: string | null
}

export type ComparisonJudgmentContextSummary = {
  context: ComparisonJudgmentContext
  createdAt: Date | null
  id: string
  modelIds: string[]
  models: Array<{id: string; name: string | null}>
  promptIds: string[]
  prompts: Array<{heading: string | null; id: string}>
  systemPromptVariants: string[]
}

type ComparisonJudgmentContextProjectRow = {
  compareWithHumans: unknown
  humanJudgmentMode: string | null
  sourceProjectIds: unknown
  summarySourceProjectId: string | null
}

type ComparisonJudgmentContextRecordRow = {contextJson: unknown; createdAt: unknown; id: string}

type ComparisonJudgmentContextBackfillCandidateRow = {comparisonProjectId: string; generation: unknown}

const comparisonJudgmentContextTable = 'app.comparison_judgment_context'
const comparisonJudgmentContextServingTable = 'mart.comparison_judgment_context_serving'
const comparisonJudgmentContextVersion = 1
const comparisonJudgmentContextIdPattern = /^[0-9a-f]{64}$/
const comparisonContentKeyPattern = /^([01])([01])([01])([01])(m?)(?:-(.+))?$/
const summaryPromptId = 'summary'
const comparisonJudgmentContextDisplayKeys = new Set(['modelName', 'promptHeading'])

const ComparisonJudgmentContextLlmColumnSchema = arktype({
  criteriaDisposition: 'string | null',
  kind: '"llm"',
  modelId: 'string',
  modelName: 'string | null',
  promptHeading: 'string | null',
  promptId: 'string',
  sourceProjectId: 'string | null',
  systemPromptVariant: 'string',
  useAbstract: 'boolean',
  useFulltext: 'boolean',
  useFulltextNoImages: 'boolean',
  useMetadata: 'boolean',
  useTitle: 'boolean',
})
const ComparisonJudgmentContextHumanColumnSchema = arktype({
  kind: '"human"',
  promptHeading: 'string | null',
  promptId: 'string',
})
const ComparisonJudgmentContextSchema = arktype({
  columns: ComparisonJudgmentContextLlmColumnSchema.or(ComparisonJudgmentContextHumanColumnSchema).array(),
  humanJudgmentMode: '"prompt" | "summary"',
  sourceProjectIds: 'string[]',
  summarySourceProjectId: 'string | null',
  v: '1',
})

const getCanonicalJsonValue = (value: unknown): unknown => {
  return Array.isArray(value)
    ? value.map(getCanonicalJsonValue)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => {
              return [key, getCanonicalJsonValue((value as Record<string, unknown>)[key])]
            }),
        )
      : value
}

export const getCanonicalJson = (value: unknown) => {
  return JSON.stringify(getCanonicalJsonValue(value))
}

const getSha256Hex = (value: string) => {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

const getSortedUniqueStrings = (values: ReadonlyArray<string | null | undefined>) => {
  return Array.from(
    new Set(
      values.filter((value): value is string => {
        return typeof value === 'string' && value.length > 0
      }),
    ),
  ).sort(compareStrings)
}

const compareStrings = (left: string, right: string) => {
  return left < right ? -1 : left > right ? 1 : 0
}

export const getComparisonContentKey = (settings: ComparisonJudgmentContextContentSettings) => {
  const flagKey = [settings.useTitle, settings.useAbstract, settings.useFulltext, settings.useFulltextNoImages]
    .map((value) => {
      return value ? '1' : '0'
    })
    .join('')
  const contentKey = settings.useMetadata ? `${flagKey}m` : flagKey

  return settings.systemPromptVariant === defaultSystemPromptVariant
    ? contentKey
    : `${contentKey}-${settings.systemPromptVariant}`
}

export const getComparisonContentKeySettings = (
  contentKey: string | null | undefined,
): ComparisonJudgmentContextContentSettings | null => {
  const match = comparisonContentKeyPattern.exec(contentKey ?? '')

  return match
    ? {
        systemPromptVariant: match[6] ?? defaultSystemPromptVariant,
        useAbstract: match[2] === '1',
        useFulltext: match[3] === '1',
        useFulltextNoImages: match[4] === '1',
        useMetadata: match[5] === 'm',
        useTitle: match[1] === '1',
      }
    : null
}

const getComparisonJudgmentContextColumnSortKey = (column: ComparisonJudgmentContextColumn) => {
  return column.kind === 'llm'
    ? [
        column.kind,
        column.promptId,
        column.modelId,
        getComparisonContentKey(column),
        column.sourceProjectId ?? '',
        column.criteriaDisposition ?? '',
      ]
    : [column.kind, column.promptId, '', '', '', '']
}

const compareComparisonJudgmentContextColumns = (
  left: ComparisonJudgmentContextColumn,
  right: ComparisonJudgmentContextColumn,
) => {
  const leftKey = getComparisonJudgmentContextColumnSortKey(left)
  const rightKey = getComparisonJudgmentContextColumnSortKey(right)
  const differentIndex = leftKey.findIndex((value, index) => {
    return value !== rightKey[index]
  })

  return differentIndex < 0 ? 0 : compareStrings(leftKey[differentIndex] ?? '', rightKey[differentIndex] ?? '')
}

const getComparisonJudgmentContextLlmColumn = (
  column: ComparisonJudgmentContextServedColumn,
): ComparisonJudgmentContextLlmColumn | null => {
  const settings = getComparisonContentKeySettings(column.contentKey)

  return settings && column.modelId
    ? {
        ...settings,
        criteriaDisposition: column.criteriaDisposition,
        kind: 'llm',
        modelId: column.modelId,
        modelName: column.modelName,
        promptHeading: column.promptHeading,
        promptId: column.promptId,
        sourceProjectId: column.sourceProjectId,
      }
    : null
}

const getComparisonJudgmentContextColumn = (
  column: ComparisonJudgmentContextServedColumn,
): ComparisonJudgmentContextColumn | null => {
  return column.kind === 'human'
    ? {kind: 'human', promptHeading: column.promptHeading, promptId: column.promptId}
    : getComparisonJudgmentContextLlmColumn(column)
}

const getUniqueComparisonJudgmentContextColumns = (columns: readonly ComparisonJudgmentContextColumn[]) => {
  return Array.from(
    columns
      .reduce<Map<string, ComparisonJudgmentContextColumn>>((columnMap, column) => {
        const columnKey = getCanonicalJson(getComparisonJudgmentContextColumnSortKey(column))

        return columnMap.has(columnKey) ? columnMap : columnMap.set(columnKey, column)
      }, new Map<string, ComparisonJudgmentContextColumn>())
      .values(),
  )
}

export const getComparisonJudgmentContext = (params: {
  columns: readonly ComparisonJudgmentContextServedColumn[]
  humanJudgmentMode: ComparisonJudgmentContextHumanJudgmentMode
  sourceProjectIds: readonly string[]
  summarySourceProjectId: string | null
}): ComparisonJudgmentContext => {
  const columns = params.columns
    .map(getComparisonJudgmentContextColumn)
    .filter((column): column is ComparisonJudgmentContextColumn => {
      return column !== null
    })

  return {
    columns: getUniqueComparisonJudgmentContextColumns(columns).sort(compareComparisonJudgmentContextColumns),
    humanJudgmentMode: params.humanJudgmentMode,
    sourceProjectIds: getSortedUniqueStrings(params.sourceProjectIds),
    summarySourceProjectId: params.summarySourceProjectId,
    v: comparisonJudgmentContextVersion,
  }
}

const getComparisonJudgmentContextIdentityColumn = (column: ComparisonJudgmentContextColumn) => {
  return Object.fromEntries(
    Object.entries(column).filter(([key]) => {
      return !comparisonJudgmentContextDisplayKeys.has(key)
    }),
  )
}

export const getComparisonJudgmentContextCanonicalJson = (context: ComparisonJudgmentContext) => {
  return getCanonicalJson(context)
}

export const getComparisonJudgmentContextId = (context: ComparisonJudgmentContext) => {
  return getSha256Hex(
    getCanonicalJson({...context, columns: context.columns.map(getComparisonJudgmentContextIdentityColumn)}),
  )
}

export const isComparisonJudgmentContextId = (value: unknown): value is string => {
  return typeof value === 'string' && comparisonJudgmentContextIdPattern.test(value)
}

const getComparisonJudgmentContextServedColumnFromContextColumn = (
  column: ComparisonJudgmentContextColumn,
): ComparisonJudgmentContextServedColumn => {
  return column.kind === 'human'
    ? {
        contentKey: null,
        criteriaDisposition: null,
        kind: column.kind,
        modelId: null,
        modelName: null,
        promptHeading: column.promptHeading,
        promptId: column.promptId,
        sourceProjectId: null,
      }
    : {
        contentKey: getComparisonContentKey(column),
        criteriaDisposition: column.criteriaDisposition,
        kind: column.kind,
        modelId: column.modelId,
        modelName: column.modelName,
        promptHeading: column.promptHeading,
        promptId: column.promptId,
        sourceProjectId: column.sourceProjectId,
      }
}

const getComparisonJudgmentContextFromValidatedValue = (value: ComparisonJudgmentContext) => {
  return getComparisonJudgmentContext({
    columns: value.columns.map(getComparisonJudgmentContextServedColumnFromContextColumn),
    humanJudgmentMode: value.humanJudgmentMode,
    sourceProjectIds: value.sourceProjectIds,
    summarySourceProjectId: value.summarySourceProjectId,
  })
}

export const getValidatedComparisonJudgmentContext = (value: unknown): ComparisonJudgmentContext | null => {
  const parsedValue = getJsonValue(value)

  return ComparisonJudgmentContextSchema.allows(parsedValue)
    ? getComparisonJudgmentContextFromValidatedValue(parsedValue)
    : null
}

export const getComparisonJudgmentContextPromptIds = (context: ComparisonJudgmentContext) => {
  return getSortedUniqueStrings(
    context.columns.map((column) => {
      return column.promptId === summaryPromptId ? null : column.promptId
    }),
  )
}

export const getComparisonJudgmentContextModelIds = (context: ComparisonJudgmentContext) => {
  return getSortedUniqueStrings(
    context.columns.map((column) => {
      return column.kind === 'llm' ? column.modelId : null
    }),
  )
}

export const getComparisonJudgmentContextSystemPromptVariants = (context: ComparisonJudgmentContext) => {
  return getSortedUniqueStrings(
    context.columns.map((column) => {
      return column.kind === 'llm' ? column.systemPromptVariant : null
    }),
  )
}

const getComparisonJudgmentContextGenerationLiteral = (generation: number) => {
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    throw new Error(`Invalid comparison judgment context generation: ${generation}`)
  }

  return getSqlLiteral(generation)
}

export const getComparisonJudgmentContextServedColumnsSql = ({
  comparisonProjectId,
  generation,
}: ComparisonJudgmentContextGenerationParams) => {
  const comparisonProjectLiteral = getSqlLiteral(comparisonProjectId)

  return `
    WITH served_column AS (
      SELECT DISTINCT kind, prompt_id, model_id, content_key, source_project_id
      FROM mart.comparison_cell_serving
      WHERE comparison_project_id = ${comparisonProjectLiteral}
        AND generation = ${getComparisonJudgmentContextGenerationLiteral(generation)}
    ),
    summary_llm_column AS (
      SELECT kind, prompt_id, model_id, content_key, source_project_id
      FROM served_column
      WHERE kind = 'llm'
        AND prompt_id = ${getSqlLiteral(summaryPromptId)}
    ),
    source_summary_prompt AS (
      SELECT
        pp.project_id AS source_project_id,
        pp.prompt_id,
        CAST(pp.criteria_disposition AS VARCHAR) AS criteria_disposition
      FROM app.project_prompt pp
      WHERE pp.enabled = TRUE
        AND pp.criteria_disposition IS NOT NULL
        AND pp.criteria_section_key IS NOT NULL
        AND pp.project_id IN (
          SELECT source_project_id
          FROM summary_llm_column
          WHERE source_project_id IS NOT NULL
        )
    ),
    fallback_summary_prompt AS (
      SELECT cpp.prompt_id, CAST(cpp.criteria_disposition AS VARCHAR) AS criteria_disposition
      FROM app.comparison_project_prompt cpp
      WHERE cpp.comparison_project_id = ${comparisonProjectLiteral}
    ),
    context_column AS (
      SELECT
        kind,
        prompt_id,
        model_id,
        content_key,
        source_project_id,
        CAST(NULL AS VARCHAR) AS criteria_disposition
      FROM served_column
      WHERE NOT (kind = 'llm' AND prompt_id = ${getSqlLiteral(summaryPromptId)})

      UNION ALL

      SELECT
        summary_llm_column.kind,
        source_summary_prompt.prompt_id,
        summary_llm_column.model_id,
        summary_llm_column.content_key,
        summary_llm_column.source_project_id,
        source_summary_prompt.criteria_disposition
      FROM summary_llm_column
      INNER JOIN source_summary_prompt
        ON source_summary_prompt.source_project_id = summary_llm_column.source_project_id

      UNION ALL

      SELECT
        summary_llm_column.kind,
        fallback_summary_prompt.prompt_id,
        summary_llm_column.model_id,
        summary_llm_column.content_key,
        NULL AS source_project_id,
        fallback_summary_prompt.criteria_disposition
      FROM summary_llm_column
      CROSS JOIN fallback_summary_prompt
      WHERE summary_llm_column.source_project_id IS NULL
    )
    SELECT
      context_column.kind,
      context_column.prompt_id AS promptId,
      NULLIF(TRIM(prompt.prompt_heading), '') AS promptHeading,
      context_column.model_id AS modelId,
      model.name AS modelName,
      context_column.content_key AS contentKey,
      context_column.source_project_id AS sourceProjectId,
      context_column.criteria_disposition AS criteriaDisposition
    FROM context_column
    LEFT JOIN app.prompt prompt ON prompt.id = context_column.prompt_id
    LEFT JOIN app.model model ON model.id = context_column.model_id
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

const getComparisonJudgmentContextHumanJudgmentMode = (
  row: ComparisonJudgmentContextProjectRow,
): ComparisonJudgmentContextHumanJudgmentMode => {
  return row.compareWithHumans === true && row.humanJudgmentMode === 'summary' ? 'summary' : 'prompt'
}

const getComparisonJudgmentContextStringArray = (value: unknown) => {
  const parsedValue = getJsonValue(value)

  return Array.isArray(parsedValue)
    ? parsedValue.filter((entry): entry is string => {
        return typeof entry === 'string'
      })
    : []
}

export const computeComparisonJudgmentContextForGeneration = async (
  runner: ComparisonJudgmentContextQueryRunner,
  params: ComparisonJudgmentContextGenerationParams,
) => {
  const [projectRow] = await runner.queryJson<ComparisonJudgmentContextProjectRow>(
    getComparisonJudgmentContextProjectSql(params.comparisonProjectId),
  )

  if (!projectRow) {
    return null
  }

  const columns = await runner.queryJson<ComparisonJudgmentContextServedColumn>(
    getComparisonJudgmentContextServedColumnsSql(params),
  )

  return getComparisonJudgmentContext({
    columns,
    humanJudgmentMode: getComparisonJudgmentContextHumanJudgmentMode(projectRow),
    sourceProjectIds: getComparisonJudgmentContextStringArray(projectRow.sourceProjectIds),
    summarySourceProjectId: projectRow.summarySourceProjectId ?? null,
  })
}

export const getUpsertComparisonJudgmentContextSql = (context: ComparisonJudgmentContext) => {
  return `
    INSERT INTO ${comparisonJudgmentContextTable} (
      id,
      context_json,
      prompt_ids,
      model_ids,
      system_prompt_variants
    )
    VALUES (
      ${getSqlLiteral(getComparisonJudgmentContextId(context))},
      CAST(${getSqlLiteral(getComparisonJudgmentContextCanonicalJson(context))} AS JSON),
      CAST(${getSqlLiteral(getComparisonJudgmentContextPromptIds(context))} AS VARCHAR[]),
      CAST(${getSqlLiteral(getComparisonJudgmentContextModelIds(context))} AS VARCHAR[]),
      CAST(${getSqlLiteral(getComparisonJudgmentContextSystemPromptVariants(context))} AS VARCHAR[])
    )
    ON CONFLICT DO NOTHING
  `
}

export const upsertComparisonJudgmentContext = async (
  runner: Pick<ComparisonJudgmentContextRunner, 'run'>,
  context: ComparisonJudgmentContext,
) => {
  await runner.run(getUpsertComparisonJudgmentContextSql(context))

  return getComparisonJudgmentContextId(context)
}

const getReplaceComparisonJudgmentContextServingStatements = (
  params: ComparisonJudgmentContextGenerationParams & {judgmentContextId: string},
) => {
  const comparisonProjectLiteral = getSqlLiteral(params.comparisonProjectId)
  const generationLiteral = getComparisonJudgmentContextGenerationLiteral(params.generation)

  return [
    `
      DELETE FROM ${comparisonJudgmentContextServingTable}
      WHERE comparison_project_id = ${comparisonProjectLiteral}
        AND generation = ${generationLiteral}
    `,
    `
      INSERT INTO ${comparisonJudgmentContextServingTable} (
        comparison_project_id,
        generation,
        judgment_context_id
      )
      VALUES (
        ${comparisonProjectLiteral},
        ${generationLiteral},
        ${getSqlLiteral(params.judgmentContextId)}
      )
    `,
  ]
}

export const writeComparisonJudgmentContextForGeneration = async (
  runner: ComparisonJudgmentContextRunner,
  params: ComparisonJudgmentContextGenerationParams,
) => {
  const context = await computeComparisonJudgmentContextForGeneration(runner, params)

  if (context === null) {
    return null
  }

  const judgmentContextId = await upsertComparisonJudgmentContext(runner, context)
  const [deleteStatement = '', insertStatement = ''] = getReplaceComparisonJudgmentContextServingStatements({
    ...params,
    judgmentContextId,
  })

  await runner.run(deleteStatement)
  await runner.run(insertStatement)

  return judgmentContextId
}

export const getComparisonJudgmentContextIdForGeneration = async (
  runner: ComparisonJudgmentContextQueryRunner,
  params: ComparisonJudgmentContextGenerationParams,
) => {
  const [row] = await runner.queryJson<{judgmentContextId: string | null}>(`
    SELECT MAX(judgment_context_id) AS judgmentContextId
    FROM ${comparisonJudgmentContextServingTable}
    WHERE comparison_project_id = ${getSqlLiteral(params.comparisonProjectId)}
      AND generation = ${getComparisonJudgmentContextGenerationLiteral(params.generation)}
  `)

  return row?.judgmentContextId ?? null
}

const getComparisonJudgmentContextSummary = (
  row: ComparisonJudgmentContextRecordRow,
): ComparisonJudgmentContextSummary | null => {
  const context = getValidatedComparisonJudgmentContext(row.contextJson)

  return context
    ? {
        context,
        createdAt: getDateValue(row.createdAt),
        id: row.id,
        modelIds: getComparisonJudgmentContextModelIds(context),
        models: getComparisonJudgmentContextModels(context),
        promptIds: getComparisonJudgmentContextPromptIds(context),
        prompts: getComparisonJudgmentContextPrompts(context),
        systemPromptVariants: getComparisonJudgmentContextSystemPromptVariants(context),
      }
    : null
}

const getComparisonJudgmentContextPrompts = (context: ComparisonJudgmentContext) => {
  return Array.from(
    context.columns
      .reduce<Map<string, {heading: string | null; id: string}>>((promptMap, column) => {
        return promptMap.has(column.promptId) && promptMap.get(column.promptId)?.heading
          ? promptMap
          : promptMap.set(column.promptId, {heading: column.promptHeading, id: column.promptId})
      }, new Map<string, {heading: string | null; id: string}>())
      .values(),
  )
}

const getComparisonJudgmentContextModels = (context: ComparisonJudgmentContext) => {
  return Array.from(
    context.columns
      .reduce<Map<string, {id: string; name: string | null}>>((modelMap, column) => {
        return column.kind !== 'llm' || (modelMap.has(column.modelId) && modelMap.get(column.modelId)?.name)
          ? modelMap
          : modelMap.set(column.modelId, {id: column.modelId, name: column.modelName})
      }, new Map<string, {id: string; name: string | null}>())
      .values(),
  )
}

export const getComparisonJudgmentContextsByIds = async (
  runner: ComparisonJudgmentContextQueryRunner,
  ids: readonly string[],
) => {
  const contextIds = getSortedUniqueStrings(ids.filter(isComparisonJudgmentContextId))

  if (contextIds.length === 0) {
    return []
  }

  const rows = await runner.queryJson<ComparisonJudgmentContextRecordRow>(`
    SELECT
      id,
      CAST(context_json AS VARCHAR) AS contextJson,
      created_at AS createdAt
    FROM ${comparisonJudgmentContextTable}
    WHERE id IN (${getQuotedStringList(contextIds).join(', ')})
    ORDER BY id ASC
  `)

  return rows
    .map(getComparisonJudgmentContextSummary)
    .filter((summary): summary is ComparisonJudgmentContextSummary => {
      return summary !== null
    })
}

export const getNextComparisonJudgmentContextBackfillCandidateSql = () => {
  return `
    SELECT
      status.comparison_project_id AS comparisonProjectId,
      CAST(status.active_generation AS BIGINT) AS generation
    FROM app.comparison_project_serving_generation status
    INNER JOIN app.comparison_project project ON project.id = status.comparison_project_id
    WHERE status.active_generation > 0
      AND project.archived = FALSE
      AND NOT EXISTS (
        SELECT 1
        FROM ${comparisonJudgmentContextServingTable} context_serving
        WHERE context_serving.comparison_project_id = status.comparison_project_id
          AND context_serving.generation = status.active_generation
      )
    ORDER BY status.comparison_project_id ASC
    LIMIT 1
  `
}

export const backfillNextComparisonJudgmentContext = async (database: {
  queryJson: <T>(statement: string) => Promise<T[]>
  transaction: <T>(operation: (runner: ComparisonJudgmentContextRunner) => Promise<T>) => Promise<T>
}) => {
  const [candidate] = await database.queryJson<ComparisonJudgmentContextBackfillCandidateRow>(
    getNextComparisonJudgmentContextBackfillCandidateSql(),
  )
  const generation = Number(candidate?.generation ?? 0)

  if (!candidate || !Number.isSafeInteger(generation) || generation <= 0) {
    return {comparisonProjectId: null, generation: null, judgmentContextId: null}
  }

  const judgmentContextId = await database.transaction(async (runner) => {
    const [stillActive] = await runner.queryJson<{comparisonProjectId: string}>(`
      SELECT comparison_project_id AS comparisonProjectId
      FROM app.comparison_project_serving_generation
      WHERE comparison_project_id = ${getSqlLiteral(candidate.comparisonProjectId)}
        AND active_generation = ${getComparisonJudgmentContextGenerationLiteral(generation)}
      LIMIT 1
    `)

    return stillActive
      ? writeComparisonJudgmentContextForGeneration(runner, {
          comparisonProjectId: candidate.comparisonProjectId,
          generation,
        })
      : null
  })

  return {comparisonProjectId: candidate.comparisonProjectId, generation, judgmentContextId}
}

export {comparisonJudgmentContextServingTable, comparisonJudgmentContextTable}
