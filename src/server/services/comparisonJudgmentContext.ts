import {createHash} from 'node:crypto'

import {type as arktype} from 'arktype'

import {defaultSystemPromptVariant} from '../../agent/judge/systemPromptVariant.ts'
import {getDateValue, getJsonValue, getQuotedStringList, getSqlLiteral} from './appQueryHelpers.ts'

type ComparisonJudgmentContextRunner = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
}

type ComparisonJudgmentContextQueryRunner = Pick<ComparisonJudgmentContextRunner, 'queryJson'>

export type ComparisonJudgmentContextGenerationParams = {comparisonProjectId: string; generation: number}

export type ComparisonJudgmentContextHumanJudgmentMode = 'prompt' | 'summary'

export type ComparisonJudgmentContextCriterion = {
  criteriaDisposition: string | null
  promptHeading: string | null
  promptId: string
}

export type ComparisonJudgmentContextLlmColumn = {
  contentKey: string
  criteria?: ComparisonJudgmentContextCriterion[]
  kind: 'llm'
  modelId: string
  modelName: string | null
  promptHeading: string | null
  promptId: string
  sourceProjectId: string | null
  systemPromptVariant: string
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useMetadata: boolean
  useTitle: boolean
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

export type ComparisonJudgmentContextColumnRow = {
  contentKey: string | null
  kind: string
  modelId: string | null
  modelName: string | null
  promptHeading: string | null
  promptId: string
  sourceProjectId: string | null
  systemPromptVariant: string | null
  useAbstract: boolean | null
  useFulltext: boolean | null
  useFulltextNoImages: boolean | null
  useMetadata: boolean | null
  useTitle: boolean | null
}

export type ComparisonJudgmentContextCriterionRow = ComparisonJudgmentContextCriterion & {
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

type ComparisonJudgmentContextRecordRow = {contextJson: unknown; createdAt: unknown; id: string}

const comparisonJudgmentContextTable = 'app.comparison_judgment_context'
const comparisonJudgmentContextServingTable = 'mart.comparison_judgment_context_serving'
const comparisonJudgmentContextVersion = 1
const comparisonJudgmentContextIdPattern = /^[0-9a-f]{64}$/
const summaryPromptId = 'summary'
const comparisonJudgmentContextDisplayKeys = new Set(['modelName', 'promptHeading'])

const ComparisonJudgmentContextCriterionSchema = arktype({
  criteriaDisposition: 'string | null',
  promptHeading: 'string | null',
  promptId: 'string',
})
const ComparisonJudgmentContextLlmColumnSchema = arktype({
  contentKey: 'string',
  'criteria?': ComparisonJudgmentContextCriterionSchema.array(),
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

const getIdentityJsonValue = (value: unknown): unknown => {
  return Array.isArray(value)
    ? value.map(getIdentityJsonValue)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([key]) => {
              return !comparisonJudgmentContextDisplayKeys.has(key)
            })
            .map(([key, entryValue]) => {
              return [key, getIdentityJsonValue(entryValue)]
            }),
        )
      : value
}

const getSha256Hex = (value: string) => {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

const compareStrings = (left: string, right: string) => {
  return left < right ? -1 : left > right ? 1 : 0
}

const compareStringTuples = (left: readonly string[], right: readonly string[]) => {
  const differentIndex = left.findIndex((value, index) => {
    return value !== right[index]
  })

  return differentIndex < 0 ? 0 : compareStrings(left[differentIndex] ?? '', right[differentIndex] ?? '')
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

const getUniqueSortedByKey = <T>(values: readonly T[], getKey: (value: T) => string[]) => {
  return Array.from(
    values
      .reduce<Map<string, T>>((valueMap, value) => {
        const key = JSON.stringify(getKey(value))

        return valueMap.has(key) ? valueMap : valueMap.set(key, value)
      }, new Map<string, T>())
      .values(),
  ).sort((left, right) => {
    return compareStringTuples(getKey(left), getKey(right))
  })
}

const getCriterionSortKey = (criterion: ComparisonJudgmentContextCriterion) => {
  return [criterion.promptId, criterion.criteriaDisposition ?? '']
}

const getColumnSortKey = (column: ComparisonJudgmentContextColumn) => {
  return column.kind === 'llm'
    ? [column.kind, column.promptId, column.modelId, column.contentKey, column.sourceProjectId ?? '']
    : [column.kind, column.promptId, '', '', '']
}

const getCanonicalCriteria = (criteria: readonly ComparisonJudgmentContextCriterion[]) => {
  return getUniqueSortedByKey(
    criteria.map((criterion) => {
      return {
        criteriaDisposition: criterion.criteriaDisposition,
        promptHeading: criterion.promptHeading,
        promptId: criterion.promptId,
      }
    }),
    getCriterionSortKey,
  )
}

const getCanonicalLlmColumn = (column: ComparisonJudgmentContextLlmColumn): ComparisonJudgmentContextLlmColumn => {
  return {
    contentKey: column.contentKey,
    ...(column.criteria ? {criteria: getCanonicalCriteria(column.criteria)} : {}),
    kind: 'llm',
    modelId: column.modelId,
    modelName: column.modelName,
    promptHeading: column.promptHeading,
    promptId: column.promptId,
    sourceProjectId: column.sourceProjectId,
    systemPromptVariant: column.systemPromptVariant,
    useAbstract: column.useAbstract,
    useFulltext: column.useFulltext,
    useFulltextNoImages: column.useFulltextNoImages,
    useMetadata: column.useMetadata,
    useTitle: column.useTitle,
  }
}

const getCanonicalColumn = (column: ComparisonJudgmentContextColumn): ComparisonJudgmentContextColumn => {
  return column.kind === 'llm'
    ? getCanonicalLlmColumn(column)
    : {kind: 'human', promptHeading: column.promptHeading, promptId: column.promptId}
}

const getCanonicalComparisonJudgmentContext = (
  context: Omit<ComparisonJudgmentContext, 'v'>,
): ComparisonJudgmentContext => {
  return {
    columns: getUniqueSortedByKey(context.columns.map(getCanonicalColumn), getColumnSortKey),
    humanJudgmentMode: context.humanJudgmentMode,
    sourceProjectIds: getSortedUniqueStrings(context.sourceProjectIds),
    summarySourceProjectId: context.summarySourceProjectId,
    v: comparisonJudgmentContextVersion,
  }
}

const getColumnCriteria = (
  sourceProjectId: string | null,
  criteria: readonly ComparisonJudgmentContextCriterionRow[],
) => {
  return criteria.filter((criterion) => {
    return criterion.sourceProjectId === sourceProjectId
  })
}

const getLlmColumnFromRow = (
  row: ComparisonJudgmentContextColumnRow,
  criteria: readonly ComparisonJudgmentContextCriterionRow[],
): ComparisonJudgmentContextLlmColumn => {
  return {
    contentKey: row.contentKey ?? '',
    ...(row.promptId === summaryPromptId ? {criteria: getColumnCriteria(row.sourceProjectId, criteria)} : {}),
    kind: 'llm',
    modelId: row.modelId ?? '',
    modelName: row.modelName,
    promptHeading: row.promptHeading,
    promptId: row.promptId,
    sourceProjectId: row.sourceProjectId,
    systemPromptVariant: row.systemPromptVariant ?? defaultSystemPromptVariant,
    useAbstract: row.useAbstract === true,
    useFulltext: row.useFulltext === true,
    useFulltextNoImages: row.useFulltextNoImages === true,
    useMetadata: row.useMetadata === true,
    useTitle: row.useTitle === true,
  }
}

const getColumnFromRow = (
  row: ComparisonJudgmentContextColumnRow,
  criteria: readonly ComparisonJudgmentContextCriterionRow[],
): ComparisonJudgmentContextColumn => {
  return row.kind === 'human'
    ? {kind: 'human', promptHeading: row.promptHeading, promptId: row.promptId}
    : getLlmColumnFromRow(row, criteria)
}

export const getComparisonJudgmentContext = (params: {
  columns: readonly ComparisonJudgmentContextColumnRow[]
  criteria: readonly ComparisonJudgmentContextCriterionRow[]
  humanJudgmentMode: ComparisonJudgmentContextHumanJudgmentMode
  sourceProjectIds: readonly string[]
  summarySourceProjectId: string | null
}): ComparisonJudgmentContext => {
  return getCanonicalComparisonJudgmentContext({
    columns: params.columns.map((row) => {
      return getColumnFromRow(row, params.criteria)
    }),
    humanJudgmentMode: params.humanJudgmentMode,
    sourceProjectIds: [...params.sourceProjectIds],
    summarySourceProjectId: params.summarySourceProjectId,
  })
}

export const getComparisonJudgmentContextCanonicalJson = (context: ComparisonJudgmentContext) => {
  return getCanonicalJson(context)
}

export const getComparisonJudgmentContextId = (context: ComparisonJudgmentContext) => {
  return getSha256Hex(getCanonicalJson(getIdentityJsonValue(context)))
}

export const isComparisonJudgmentContextId = (value: unknown): value is string => {
  return typeof value === 'string' && comparisonJudgmentContextIdPattern.test(value)
}

export const getValidatedComparisonJudgmentContext = (value: unknown): ComparisonJudgmentContext | null => {
  const parsedValue = getJsonValue(value)

  return ComparisonJudgmentContextSchema.allows(parsedValue) ? getCanonicalComparisonJudgmentContext(parsedValue) : null
}

const getContextCriteria = (context: ComparisonJudgmentContext) => {
  return context.columns.flatMap((column) => {
    return column.kind === 'llm' ? (column.criteria ?? []) : []
  })
}

export const getComparisonJudgmentContextPromptIds = (context: ComparisonJudgmentContext) => {
  return getSortedUniqueStrings(
    [...context.columns, ...getContextCriteria(context)].map((entry) => {
      return entry.promptId === summaryPromptId ? null : entry.promptId
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

const getComparisonJudgmentContextPrompts = (context: ComparisonJudgmentContext) => {
  return Array.from(
    [...context.columns, ...getContextCriteria(context)]
      .reduce<Map<string, {heading: string | null; id: string}>>((promptMap, entry) => {
        return promptMap.get(entry.promptId)?.heading
          ? promptMap
          : promptMap.set(entry.promptId, {heading: entry.promptHeading, id: entry.promptId})
      }, new Map<string, {heading: string | null; id: string}>())
      .values(),
  )
}

const getComparisonJudgmentContextModels = (context: ComparisonJudgmentContext) => {
  return Array.from(
    context.columns
      .reduce<Map<string, {id: string; name: string | null}>>((modelMap, column) => {
        return column.kind !== 'llm' || modelMap.get(column.modelId)?.name
          ? modelMap
          : modelMap.set(column.modelId, {id: column.modelId, name: column.modelName})
      }, new Map<string, {id: string; name: string | null}>())
      .values(),
  )
}

export const getComparisonJudgmentContextGenerationLiteral = (generation: number) => {
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    throw new Error(`Invalid comparison judgment context generation: ${generation}`)
  }

  return getSqlLiteral(generation)
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

export const storeComparisonJudgmentContextForGeneration = async (
  runner: Pick<ComparisonJudgmentContextRunner, 'run'>,
  params: ComparisonJudgmentContextGenerationParams & {context: ComparisonJudgmentContext},
) => {
  const comparisonProjectLiteral = getSqlLiteral(params.comparisonProjectId)
  const generationLiteral = getComparisonJudgmentContextGenerationLiteral(params.generation)
  const judgmentContextId = await upsertComparisonJudgmentContext(runner, params.context)

  await runner.run(`
    DELETE FROM ${comparisonJudgmentContextServingTable}
    WHERE comparison_project_id = ${comparisonProjectLiteral}
      AND generation = ${generationLiteral}
  `)
  await runner.run(`
    INSERT INTO ${comparisonJudgmentContextServingTable} (comparison_project_id, generation, judgment_context_id)
    VALUES (${comparisonProjectLiteral}, ${generationLiteral}, ${getSqlLiteral(judgmentContextId)})
  `)

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

export {comparisonJudgmentContextServingTable, comparisonJudgmentContextTable}
