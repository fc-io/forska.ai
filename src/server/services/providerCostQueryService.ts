import type {DuckdbWorkloadContext} from '../utils/duckdbService.ts'
import {getCurrentServerRole} from '../utils/serverRuntimeRole.ts'
import {getAppDatabaseService} from './appDatabaseService.ts'
import {getDateValue, getSqlLiteral, getTimestampLiteral} from './appQueryHelpers.ts'
import {getApiReadOnlyAppDatabaseService} from './appReadOnlyDatabaseService.ts'

export type ProviderCostQuery = {from: Date | null; jobId: string | null; to: Date | null}

export type ProviderCostHour = {
  cacheCreationInputTokens: number | null
  cacheReadInputTokens: number | null
  completionTokens: number
  costWeightedTokens: number | null
  hourStart: string
  modelName: string | null
  promptTokens: number
  providerKind: string | null
  requests: number
  thinkingTokens: number | null
  tokenUseRows: number
  totalTokens: number
  weightEffectiveFrom: string | null
  weightPattern: string | null
}

export type ProviderQuotaHour = {
  firstObservedAt: string
  firstResetsAt: string | null
  firstUtilizationPercent: number
  hourStart: string
  lastObservedAt: string
  lastResetsAt: string | null
  lastUtilizationPercent: number
  limitKind: string
  providerConnectionId: string
  providerKind: string
  readings: number
}

type ProviderCostReader = {queryJson: <T>(statement: string, workloadContext?: DuckdbWorkloadContext) => Promise<T[]>}

type NumericValue = bigint | number | string | null

type ProviderCostHourRow = {
  cacheCreationInputTokens: NumericValue
  cacheReadInputTokens: NumericValue
  completionTokens: NumericValue
  costWeightedTokens: NumericValue
  hourStart: unknown
  modelName: string | null
  promptTokens: NumericValue
  providerKind: string | null
  requests: NumericValue
  thinkingTokens: NumericValue
  tokenUseRows: NumericValue
  totalTokens: NumericValue
  weightEffectiveFrom: unknown
  weightPattern: string | null
}

type ProviderQuotaHourRow = {
  firstObservedAt: unknown
  firstResetsAt: unknown
  firstUtilizationPercent: NumericValue
  hourStart: unknown
  lastObservedAt: unknown
  lastResetsAt: unknown
  lastUtilizationPercent: NumericValue
  limitKind: string
  providerConnectionId: string
  providerKind: string
  readings: NumericValue
}

export const providerCostHourMaxRows = 20_000

const providerCostHoursWorkloadContext: DuckdbWorkloadContext = {
  fallbackIntent: 'reject',
  maxResultRows: providerCostHourMaxRows,
  routeOrJobKey: 'tokens.costByHour.usage',
  workloadClass: 'admin.telemetry',
}

const providerQuotaHoursWorkloadContext: DuckdbWorkloadContext = {
  fallbackIntent: 'reject',
  maxResultRows: providerCostHourMaxRows,
  routeOrJobKey: 'tokens.costByHour.quota',
  workloadClass: 'admin.telemetry',
}

const getTokenUseFilterSql = (query: ProviderCostQuery): string => {
  return [
    'finished_at IS NOT NULL',
    query.from ? `finished_at >= ${getTimestampLiteral(query.from)}` : null,
    query.to ? `finished_at < ${getTimestampLiteral(query.to)}` : null,
    query.jobId ? `judgment_job_id = ${getSqlLiteral(query.jobId)}` : null,
  ]
    .filter((part): part is string => {
      return part !== null
    })
    .join(' AND ')
}

export const getProviderCostHoursSql = (query: ProviderCostQuery): string => {
  return `
    WITH usage_by_hour AS (
      SELECT
        time_bucket(INTERVAL '1 hour', finished_at) AS hour_start,
        provider_kind,
        model_name,
        COUNT(*) AS token_use_rows,
        SUM(requests) AS requests,
        SUM(total_prompt_tokens) AS prompt_tokens,
        SUM(total_completion_tokens) AS completion_tokens,
        SUM(total_tokens) AS total_tokens,
        SUM(cache_creation_input_tokens) AS cache_creation_input_tokens,
        SUM(cache_read_input_tokens) AS cache_read_input_tokens,
        SUM(thinking_tokens) AS thinking_tokens
      FROM app.token_use
      WHERE ${getTokenUseFilterSql(query)}
      GROUP BY ALL
    ),
    weight_candidate AS (
      SELECT
        usage_key.hour_start,
        usage_key.provider_kind,
        usage_key.model_name,
        weight.model_name_pattern,
        weight.effective_from,
        weight.input_weight,
        weight.cache_creation_weight,
        weight.cache_read_weight,
        weight.output_weight,
        weight.thinking_weight,
        weight.model_name_pattern = usage_key.model_name AS is_exact
      FROM (
        SELECT DISTINCT hour_start, provider_kind, model_name
        FROM usage_by_hour
        WHERE provider_kind IS NOT NULL
          AND model_name IS NOT NULL
      ) AS usage_key
      INNER JOIN app.provider_token_weight AS weight
        ON weight.provider_kind = usage_key.provider_kind
       AND weight.effective_from <= usage_key.hour_start
       AND (weight.model_name_pattern = usage_key.model_name OR usage_key.model_name LIKE weight.model_name_pattern)
    ),
    matched_weight AS (
      SELECT *
      FROM weight_candidate
      QUALIFY ROW_NUMBER() OVER (
        PARTITION BY hour_start, provider_kind, model_name
        ORDER BY is_exact DESC, length(model_name_pattern) DESC, effective_from DESC
      ) = 1
    )
    SELECT
      hourly.hour_start AS hourStart,
      hourly.provider_kind AS providerKind,
      hourly.model_name AS modelName,
      hourly.token_use_rows AS tokenUseRows,
      hourly.requests,
      hourly.prompt_tokens AS promptTokens,
      hourly.completion_tokens AS completionTokens,
      hourly.total_tokens AS totalTokens,
      hourly.cache_creation_input_tokens AS cacheCreationInputTokens,
      hourly.cache_read_input_tokens AS cacheReadInputTokens,
      hourly.thinking_tokens AS thinkingTokens,
      matched.model_name_pattern AS weightPattern,
      matched.effective_from AS weightEffectiveFrom,
      CASE
        WHEN matched.model_name_pattern IS NULL THEN NULL
        ELSE
          (hourly.prompt_tokens - COALESCE(hourly.cache_creation_input_tokens, 0) - COALESCE(hourly.cache_read_input_tokens, 0))
            * matched.input_weight
          + COALESCE(hourly.cache_creation_input_tokens, 0) * matched.cache_creation_weight
          + COALESCE(hourly.cache_read_input_tokens, 0) * matched.cache_read_weight
          + (hourly.completion_tokens - COALESCE(hourly.thinking_tokens, 0)) * matched.output_weight
          + COALESCE(hourly.thinking_tokens, 0) * matched.thinking_weight
      END AS costWeightedTokens
    FROM usage_by_hour AS hourly
    LEFT JOIN matched_weight AS matched
      ON matched.hour_start = hourly.hour_start
     AND matched.provider_kind = hourly.provider_kind
     AND matched.model_name = hourly.model_name
    ORDER BY hourly.hour_start, hourly.provider_kind NULLS LAST, hourly.model_name NULLS LAST
  `
}

const getQuotaWindowSql = (query: ProviderCostQuery): string => {
  return [
    query.from ? `reading.observed_at >= ${getTimestampLiteral(query.from)}` : null,
    query.to ? `reading.observed_at < ${getTimestampLiteral(query.to)}` : null,
  ]
    .filter((part): part is string => {
      return part !== null
    })
    .map((part) => {
      return `AND ${part}`
    })
    .join(' ')
}

export const getProviderQuotaHoursSql = (query: ProviderCostQuery): string => {
  return `
    WITH usage_hour AS (
      SELECT DISTINCT time_bucket(INTERVAL '1 hour', finished_at) AS hour_start, provider_connection_id
      FROM app.token_use
      WHERE ${getTokenUseFilterSql(query)}
        AND provider_connection_id IS NOT NULL
    )
    SELECT
      usage_hour.hour_start AS hourStart,
      reading.provider_connection_id AS providerConnectionId,
      reading.provider_kind AS providerKind,
      reading.limit_kind AS limitKind,
      COUNT(*) AS readings,
      min(reading.observed_at) AS firstObservedAt,
      max(reading.observed_at) AS lastObservedAt,
      arg_min(reading.utilization_percent, reading.observed_at) AS firstUtilizationPercent,
      arg_max(reading.utilization_percent, reading.observed_at) AS lastUtilizationPercent,
      arg_min(reading.resets_at, reading.observed_at) AS firstResetsAt,
      arg_max(reading.resets_at, reading.observed_at) AS lastResetsAt
    FROM app.provider_quota_reading AS reading
    INNER JOIN usage_hour
      ON usage_hour.provider_connection_id = reading.provider_connection_id
     AND usage_hour.hour_start = time_bucket(INTERVAL '1 hour', reading.observed_at)
    WHERE TRUE ${getQuotaWindowSql(query)}
    GROUP BY usage_hour.hour_start, reading.provider_connection_id, reading.provider_kind, reading.limit_kind
    ORDER BY usage_hour.hour_start, reading.provider_connection_id, reading.limit_kind
  `
}

const getNumber = (value: NumericValue): number => {
  return Number(value ?? 0)
}

const getNullableNumber = (value: NumericValue): number | null => {
  return value === null ? null : Number(value)
}

const getIsoString = (value: unknown): string => {
  return getDateValue(value)?.toISOString() ?? ''
}

const getNullableIsoString = (value: unknown): string | null => {
  return getDateValue(value)?.toISOString() ?? null
}

const getProviderCostHour = (row: ProviderCostHourRow): ProviderCostHour => {
  return {
    cacheCreationInputTokens: getNullableNumber(row.cacheCreationInputTokens),
    cacheReadInputTokens: getNullableNumber(row.cacheReadInputTokens),
    completionTokens: getNumber(row.completionTokens),
    costWeightedTokens: getNullableNumber(row.costWeightedTokens),
    hourStart: getIsoString(row.hourStart),
    modelName: row.modelName,
    promptTokens: getNumber(row.promptTokens),
    providerKind: row.providerKind,
    requests: getNumber(row.requests),
    thinkingTokens: getNullableNumber(row.thinkingTokens),
    tokenUseRows: getNumber(row.tokenUseRows),
    totalTokens: getNumber(row.totalTokens),
    weightEffectiveFrom: getNullableIsoString(row.weightEffectiveFrom),
    weightPattern: row.weightPattern,
  }
}

const getProviderQuotaHour = (row: ProviderQuotaHourRow): ProviderQuotaHour => {
  return {
    firstObservedAt: getIsoString(row.firstObservedAt),
    firstResetsAt: getNullableIsoString(row.firstResetsAt),
    firstUtilizationPercent: getNumber(row.firstUtilizationPercent),
    hourStart: getIsoString(row.hourStart),
    lastObservedAt: getIsoString(row.lastObservedAt),
    lastResetsAt: getNullableIsoString(row.lastResetsAt),
    lastUtilizationPercent: getNumber(row.lastUtilizationPercent),
    limitKind: row.limitKind,
    providerConnectionId: row.providerConnectionId,
    providerKind: row.providerKind,
    readings: getNumber(row.readings),
  }
}

const getBackgroundOwnerReader = (): ProviderCostReader => {
  return {queryJson: getAppDatabaseService().queryJsonBackground}
}

export const getProviderCostReadDatabase = (): ProviderCostReader => {
  return getCurrentServerRole() === 'api' ? getApiReadOnlyAppDatabaseService() : getBackgroundOwnerReader()
}

export const getProviderCostByHour = async ({
  query,
  reader = getProviderCostReadDatabase(),
}: {
  query: ProviderCostQuery
  reader?: ProviderCostReader
}): Promise<{hours: ProviderCostHour[]; quota: ProviderQuotaHour[]}> => {
  const [hourRows, quotaRows] = await Promise.all([
    reader.queryJson<ProviderCostHourRow>(getProviderCostHoursSql(query), providerCostHoursWorkloadContext),
    reader.queryJson<ProviderQuotaHourRow>(getProviderQuotaHoursSql(query), providerQuotaHoursWorkloadContext),
  ])

  return {hours: hourRows.map(getProviderCostHour), quota: quotaRows.map(getProviderQuotaHour)}
}
