import type {HumanJudgmentMode} from '../../../db/schemaTypes.ts'
import {
  type ComparisonProjectFullTextStrategySource,
  getComparisonProjectFullTextStrategyMixError,
} from '../../../utils/comparisonProjectFullTextStrategyMix.ts'
import {
  type FullTextStrategyInputs,
  getEffectiveFullTextStrategyId,
  getFullTextStrategyDisplayLabel,
  getProjectFullTextStrategyIdSql,
} from '../../fullText/fullTextStrategy.ts'
import {getJsonValue} from '../../services/appQueryHelpers.ts'
import {HttpError} from '../../utils/httpError.ts'
import {projectTable} from './comparisonProjectRouteConstants.ts'
import type {AppQueryRunner, ComparisonProjectSource} from './comparisonProjectRouteTypes.ts'
import {getInClause} from './comparisonProjectSqlClauses.ts'
import {getUniqueStringValues, isDefined} from './comparisonProjectValueHelpers.ts'

export type ComparisonProjectSourceRow = Omit<
  ComparisonProjectSource,
  'fullTextStrategyInputs' | 'fullTextStrategyLabel' | 'systemPromptVariant'
> & {fullTextStrategyInputs?: unknown; fullTextStrategyStoredLabel?: string | null; systemPromptVariant?: string | null}

const getFullTextStrategyInputsValue = (value: unknown): FullTextStrategyInputs | null => {
  const parsedValue = getJsonValue(value)

  return parsedValue !== null && typeof parsedValue === 'object' && !Array.isArray(parsedValue)
    ? (parsedValue as FullTextStrategyInputs)
    : null
}

export const getComparisonProjectSourceFullTextStrategy = (
  projectRow: Pick<
    ComparisonProjectSourceRow,
    'fullTextStrategyId' | 'fullTextStrategyInputs' | 'fullTextStrategyStoredLabel'
  >,
) => {
  const fullTextStrategyId = getEffectiveFullTextStrategyId(projectRow.fullTextStrategyId)

  return {
    fullTextStrategyId,
    fullTextStrategyInputs: getFullTextStrategyInputsValue(projectRow.fullTextStrategyInputs),
    fullTextStrategyLabel: getFullTextStrategyDisplayLabel(fullTextStrategyId, projectRow.fullTextStrategyStoredLabel),
  }
}

export const assertComparisonProjectSourcesShareFullTextStrategy = (
  sources: readonly ComparisonProjectFullTextStrategySource[],
) => {
  const fullTextStrategyMixError = getComparisonProjectFullTextStrategyMixError(sources)

  if (fullTextStrategyMixError) {
    throw new HttpError(400, fullTextStrategyMixError)
  }
}

const getComparisonProjectFullTextStrategySources = async (
  db: AppQueryRunner,
  sourceProjectIds: string[],
): Promise<ComparisonProjectFullTextStrategySource[]> => {
  const rows = await db.queryJson<
    Pick<
      ComparisonProjectSourceRow,
      'fullTextStrategyId' | 'fullTextStrategyInputs' | 'fullTextStrategyStoredLabel'
    > & {id: string; name: string}
  >(`
    SELECT
      p.id AS id,
      p.name AS name,
      ${getProjectFullTextStrategyIdSql('p')} AS fullTextStrategyId,
      fts.label AS fullTextStrategyStoredLabel,
      CAST(fts.inputs AS VARCHAR) AS fullTextStrategyInputs
    FROM ${projectTable} p
    LEFT JOIN app.full_text_strategy fts ON fts.id = p.full_text_strategy_id
    WHERE p.id IN (${getInClause(sourceProjectIds)})
  `)
  const rowsById = new Map(
    rows.map((row) => {
      return [row.id, row] as const
    }),
  )

  return sourceProjectIds
    .map((sourceProjectId) => {
      return rowsById.get(sourceProjectId)
    })
    .filter(isDefined)
    .map<ComparisonProjectFullTextStrategySource>((row) => {
      return {name: row.name, ...getComparisonProjectSourceFullTextStrategy(row)}
    })
}

export const assertComparisonProjectSourceProjectIdsShareFullTextStrategy = async (
  db: AppQueryRunner,
  sourceProjectIds: string[],
) => {
  const uniqueSourceProjectIds = getUniqueStringValues(sourceProjectIds)

  return uniqueSourceProjectIds.length > 1
    ? assertComparisonProjectSourcesShareFullTextStrategy(
        await getComparisonProjectFullTextStrategySources(db, uniqueSourceProjectIds),
      )
    : undefined
}

export const getComparisonProjectBodySourceProjectIds = (body: {
  humanJudgmentMode?: HumanJudgmentMode
  sourceProjectIds?: string[] | null
  summarySourceProjectId?: string | null
}) => {
  return [
    ...(body.humanJudgmentMode === 'summary' && body.summarySourceProjectId ? [body.summarySourceProjectId] : []),
    ...(body.sourceProjectIds ?? []),
  ]
}
