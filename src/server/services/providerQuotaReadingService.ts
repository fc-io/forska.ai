import type {DuckdbWorkloadContext} from '../utils/duckdbService.ts'
import {getAppDatabaseService} from './appDatabaseService.ts'
import {getDateValue, getJsonValue, getSqlLiteral, getTimestampLiteral} from './appQueryHelpers.ts'

export type ProviderQuotaReadingInsert = {
  isActive: boolean | null
  limitKind: string
  observedAt: Date
  providerConnectionId: string
  providerKind: string
  rawJson: unknown
  resetsAt: Date | null
  scopeJson: unknown
  utilizationPercent: number
}

export type ProviderQuotaReading = {
  isActive: boolean | null
  limitKind: string
  observedAt: string
  providerConnectionId: string
  providerKind: string
  resetsAt: string | null
  scopeJson: unknown
  utilizationPercent: number
}

export type ProviderQuotaHeadline = {
  label: string
  limitKind: string
  observedAt: string
  resetsAt: string | null
  utilizationPercent: number
}

type ProviderQuotaReadingRow = {
  isActive: boolean | null
  limitKind: string
  observedAt: unknown
  providerConnectionId: string
  providerKind: string
  resetsAt: unknown
  scopeJson: unknown
  utilizationPercent: number | string
}

type ProviderQuotaReadingWriter = {
  runBackground: (statement: string, workloadContext?: DuckdbWorkloadContext) => Promise<void>
}
type ProviderQuotaReadingReader = {
  queryJson: <T>(statement: string, workloadContext?: DuckdbWorkloadContext) => Promise<T[]>
}

export const providerQuotaLatestReadingMaxAgeMs = 24 * 60 * 60 * 1000

const providerQuotaInsertWorkloadContext: DuckdbWorkloadContext = {
  fallbackIntent: 'reject',
  routeOrJobKey: 'providerQuota.readings.insert',
  workloadClass: 'admin.telemetry',
}

const providerQuotaLatestWorkloadContext: DuckdbWorkloadContext = {
  fallbackIntent: 'reject',
  maxResultRows: 100,
  routeOrJobKey: 'providerQuota.readings.latest',
  workloadClass: 'admin.telemetry',
}

const getJsonLiteral = (value: unknown): string => {
  return value === null || value === undefined ? 'NULL' : `CAST(${getSqlLiteral(JSON.stringify(value))} AS JSON)`
}

const getNullableTimestampLiteral = (value: Date | null): string => {
  return value ? getTimestampLiteral(value) : 'NULL'
}

const getReadingValuesSql = (reading: ProviderQuotaReadingInsert): string => {
  return `(${[
    getSqlLiteral(reading.providerConnectionId),
    getSqlLiteral(reading.providerKind),
    getSqlLiteral(reading.limitKind),
    getSqlLiteral(reading.utilizationPercent),
    getNullableTimestampLiteral(reading.resetsAt),
    getSqlLiteral(reading.isActive),
    getJsonLiteral(reading.scopeJson),
    getJsonLiteral(reading.rawJson ?? {}),
    getTimestampLiteral(reading.observedAt),
  ].join(', ')})`
}

export const getProviderQuotaReadingsInsertSql = (readings: ProviderQuotaReadingInsert[]): string => {
  return `
    INSERT INTO app.provider_quota_reading (
      provider_connection_id, provider_kind, limit_kind, utilization_percent, resets_at, is_active, scope_json,
      raw_json, observed_at
    )
    VALUES ${readings.map(getReadingValuesSql).join(', ')}
  `
}

export const insertProviderQuotaReadings = async ({
  readings,
  writer = getAppDatabaseService(),
}: {
  readings: ProviderQuotaReadingInsert[]
  writer?: ProviderQuotaReadingWriter
}): Promise<number> => {
  if (readings.length === 0) {
    return 0
  }

  await writer.runBackground(getProviderQuotaReadingsInsertSql(readings), providerQuotaInsertWorkloadContext)

  return readings.length
}

export const getLatestProviderQuotaReadingsSql = ({
  now,
  providerConnectionId,
}: {
  now: Date
  providerConnectionId: string
}): string => {
  const connectionSql = getSqlLiteral(providerConnectionId)
  const cutoffSql = getTimestampLiteral(new Date(now.getTime() - providerQuotaLatestReadingMaxAgeMs))

  return `
    WITH recent_reading AS (
      SELECT *
      FROM app.provider_quota_reading
      WHERE provider_connection_id = ${connectionSql}
        AND observed_at >= ${cutoffSql}
    )
    SELECT
      provider_connection_id AS providerConnectionId,
      provider_kind AS providerKind,
      limit_kind AS limitKind,
      utilization_percent AS utilizationPercent,
      resets_at AS resetsAt,
      is_active AS isActive,
      TO_JSON(scope_json) AS scopeJson,
      observed_at AS observedAt
    FROM recent_reading
    WHERE observed_at = (SELECT max(observed_at) FROM recent_reading)
    ORDER BY limit_kind
  `
}

const getProviderQuotaReading = (row: ProviderQuotaReadingRow): ProviderQuotaReading => {
  return {
    isActive: row.isActive,
    limitKind: row.limitKind,
    observedAt: getDateValue(row.observedAt)?.toISOString() ?? '',
    providerConnectionId: row.providerConnectionId,
    providerKind: row.providerKind,
    resetsAt: getDateValue(row.resetsAt)?.toISOString() ?? null,
    scopeJson: getJsonValue(row.scopeJson),
    utilizationPercent: Number(row.utilizationPercent),
  }
}

export const getLatestProviderQuotaReadings = async ({
  now = new Date(),
  providerConnectionId,
  reader,
}: {
  now?: Date
  providerConnectionId: string
  reader: ProviderQuotaReadingReader
}): Promise<ProviderQuotaReading[]> => {
  const rows = await reader.queryJson<ProviderQuotaReadingRow>(
    getLatestProviderQuotaReadingsSql({now, providerConnectionId}),
    providerQuotaLatestWorkloadContext,
  )

  return rows.map(getProviderQuotaReading)
}

const claudeWindowLabels: Record<string, string> = {five_hour: 'Claude Max 5-hour', seven_day: 'Claude Max weekly'}

const getClaudeWindowLabel = (limitKind: string): string | null => {
  return (
    claudeWindowLabels[limitKind]
    ?? (limitKind.startsWith('seven_day_') ? `Claude Max weekly (${limitKind.slice('seven_day_'.length)})` : null)
  )
}

const getRecordValue = (value: unknown, key: string): unknown => {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined
}

const getCodexWindowName = (windowDurationMins: unknown): string => {
  return windowDurationMins === 10_080
    ? 'weekly'
    : windowDurationMins === 300
      ? '5-hour'
      : typeof windowDurationMins === 'number'
        ? `${windowDurationMins}-minute`
        : 'window'
}

const getCodexWindowLabel = (reading: ProviderQuotaReading): string | null => {
  const [limitId, window] = reading.limitKind.split(':')
  const limitName = getRecordValue(reading.scopeJson, 'limitName')
  const suffix = limitId === 'codex' ? '' : ` (${typeof limitName === 'string' && limitName ? limitName : limitId})`

  return window === 'primary' || window === 'secondary'
    ? `Codex ${getCodexWindowName(getRecordValue(reading.scopeJson, 'windowDurationMins'))}${suffix}`
    : null
}

const getProviderQuotaHeadlineLabel = (reading: ProviderQuotaReading): string | null => {
  return reading.providerKind === 'claude-code'
    ? getClaudeWindowLabel(reading.limitKind)
    : reading.providerKind === 'codex'
      ? getCodexWindowLabel(reading)
      : null
}

export const getProviderQuotaHeadlines = (readings: ProviderQuotaReading[]): ProviderQuotaHeadline[] => {
  return readings.flatMap((reading) => {
    const label = getProviderQuotaHeadlineLabel(reading)

    return label === null
      ? []
      : [
          {
            label,
            limitKind: reading.limitKind,
            observedAt: reading.observedAt,
            resetsAt: reading.resetsAt,
            utilizationPercent: reading.utilizationPercent,
          },
        ]
  })
}
