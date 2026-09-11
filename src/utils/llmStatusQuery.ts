import {fromUnixTime, isValid, parseISO} from 'date-fns'

import {apiClient} from '../services/apiClient.ts'

export type LlmStatusRow = {
  ts: Date | null
  instanceId: string
  modelName: string
  engineVersion: string | null
  prefillTps: number | null
  genTps: number | null
  rps: number | null
  numQueueReqs: number | null
  numRunningReqs: number | null
  numGrammarQueueReqs: number | null
  numRunningReqsOfflineBatch: number | null
  numPrefillPreallocQueueReqs: number | null
  numPrefillInflightQueueReqs: number | null
  numDecodePreallocQueueReqs: number | null
  numDecodeTransferQueueReqs: number | null
  utilization: number | null
  cacheHitRate: number | null
  inFlight: number | null
  maxInFlight: number | null
}

export type LlmMetricsSummary = {
  waiting: number
  running: number
  lastUpdate: Date | null
  hasMetricsCompatibleJob: boolean
}

export type LlmStatusStaleReason =
  | 'ingestion-cron-deferred'
  | 'ingestion-cron-inactive'
  | 'latest-row-stale'
  | 'llm-status-table-missing'
  | 'no-ingested-rows'

export type LlmStatusCronClassState = {
  active: boolean
  lastSuccessAt: Date | null
  lastTickAt: Date | null
  reason: string | null
  source: string
}

export type LlmStatusCronTickState = {
  lastFailureAt: Date | null
  lastFailureMessage: string | null
  lastSkippedAt: Date | null
  lastSuccessAt: Date | null
  lastTickAt: Date | null
  running: boolean
}

export type LlmStatusCronMetadata = {
  duckdbMemoryLimit: string | null
  duckdbMemoryLimitMiB: number | null
  heavyMaintenanceCrons: LlmStatusCronClassState
  llmStatusIngestionCron: LlmStatusCronTickState | null
  lowMemoryOwner: boolean
  lowMemoryThresholdMiB: number | null
  operationalJudgmentCrons: LlmStatusCronClassState
  serverRole: string
}

export type LlmStatusMetadata = {
  cron: LlmStatusCronMetadata | null
  generatedAt: Date | null
  isStale: boolean
  latestIngestedAgeMs: number | null
  latestIngestedAt: Date | null
  staleAfterMs: number | null
  staleMessage: string | null
  staleReason: LlmStatusStaleReason | null
  tableExists: boolean | null
}

export const llmStatusQueryKey = ['llmstatus', 'latest50'] as const

const normalizeLlmStatusTimestamp = (value: unknown): Date | null => {
  if (value instanceof Date) {
    return isValid(value) ? new Date(value.getTime()) : null
  }

  if (typeof value === 'string') {
    const parsed = parseISO(value)
    return isValid(parsed) ? parsed : null
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return null
    }

    const parsed = value > 1_000_000_000_000 ? new Date(value) : fromUnixTime(value)
    return isValid(parsed) ? parsed : null
  }

  return null
}

const normalizeLlmStatusNumber = (value: unknown): number | null => {
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN

  return Number.isFinite(parsed) ? parsed : null
}

const normalizeLlmStatusString = (value: unknown) => {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

const normalizeLlmStatusBoolean = (value: unknown) => {
  return typeof value === 'boolean' ? value : null
}

const normalizeLlmStatusCronClassState = (value: unknown): LlmStatusCronClassState => {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}

  return {
    active: record.active === true,
    lastSuccessAt: normalizeLlmStatusTimestamp(record.lastSuccessAt),
    lastTickAt: normalizeLlmStatusTimestamp(record.lastTickAt),
    reason: normalizeLlmStatusString(record.reason),
    source: normalizeLlmStatusString(record.source) ?? 'derived',
  }
}

const normalizeLlmStatusCronTickState = (value: unknown): LlmStatusCronTickState | null => {
  if (!value || typeof value !== 'object') {
    return null
  }

  const record = value as Record<string, unknown>

  return {
    lastFailureAt: normalizeLlmStatusTimestamp(record.lastFailureAt),
    lastFailureMessage: normalizeLlmStatusString(record.lastFailureMessage),
    lastSkippedAt: normalizeLlmStatusTimestamp(record.lastSkippedAt),
    lastSuccessAt: normalizeLlmStatusTimestamp(record.lastSuccessAt),
    lastTickAt: normalizeLlmStatusTimestamp(record.lastTickAt),
    running: record.running === true,
  }
}

const normalizeLlmStatusCronMetadata = (value: unknown): LlmStatusCronMetadata | null => {
  if (!value || typeof value !== 'object') {
    return null
  }

  const record = value as Record<string, unknown>

  return {
    duckdbMemoryLimit: normalizeLlmStatusString(record.duckdbMemoryLimit),
    duckdbMemoryLimitMiB: normalizeLlmStatusNumber(record.duckdbMemoryLimitMiB),
    heavyMaintenanceCrons: normalizeLlmStatusCronClassState(record.heavyMaintenanceCrons),
    llmStatusIngestionCron: normalizeLlmStatusCronTickState(record.llmStatusIngestionCron),
    lowMemoryOwner: record.lowMemoryOwner === true,
    lowMemoryThresholdMiB: normalizeLlmStatusNumber(record.lowMemoryThresholdMiB),
    operationalJudgmentCrons: normalizeLlmStatusCronClassState(record.operationalJudgmentCrons),
    serverRole: normalizeLlmStatusString(record.serverRole) ?? '',
  }
}

const normalizeLlmStatusStaleReason = (value: unknown): LlmStatusStaleReason | null => {
  return value === 'ingestion-cron-deferred'
    || value === 'ingestion-cron-inactive'
    || value === 'latest-row-stale'
    || value === 'llm-status-table-missing'
    || value === 'no-ingested-rows'
    ? value
    : null
}

const normalizeLlmStatusMetadata = (value: unknown): LlmStatusMetadata | null => {
  if (!value || typeof value !== 'object') {
    return null
  }

  const record = value as Record<string, unknown>

  return {
    cron: normalizeLlmStatusCronMetadata(record.cron),
    generatedAt: normalizeLlmStatusTimestamp(record.generatedAt),
    isStale: record.isStale === true,
    latestIngestedAgeMs: normalizeLlmStatusNumber(record.latestIngestedAgeMs),
    latestIngestedAt: normalizeLlmStatusTimestamp(record.latestIngestedAt),
    staleAfterMs: normalizeLlmStatusNumber(record.staleAfterMs),
    staleMessage: normalizeLlmStatusString(record.staleMessage),
    staleReason: normalizeLlmStatusStaleReason(record.staleReason),
    tableExists: normalizeLlmStatusBoolean(record.tableExists),
  }
}

export type LlmStatusResponse = {
  rows: LlmStatusRow[]
  hasMetricsCompatibleJob: boolean
  metadata: LlmStatusMetadata | null
}

export const fetchLlmStatus = async (): Promise<LlmStatusResponse> => {
  const response = await apiClient.api.llmstatus.get()

  if (response.error) {
    throw new Error('Failed to fetch LLM status')
  }

  const entries = response.data?.data ?? []
  const hasMetricsCompatibleJob =
    (response.data as Record<string, unknown> | undefined)?.hasMetricsCompatibleJob === true
  const metadata = normalizeLlmStatusMetadata((response.data as Record<string, unknown> | undefined)?.metadata)

  const rows = entries.map((row: Record<string, unknown>) => {
    return {
      ts: normalizeLlmStatusTimestamp(row.ts),
      instanceId: typeof row.instanceId === 'string' ? row.instanceId : '',
      modelName: typeof row.modelName === 'string' ? row.modelName : '',
      engineVersion: (row.engineVersion as string | null) ?? null,
      prefillTps: normalizeLlmStatusNumber(row.prefillTps),
      genTps: normalizeLlmStatusNumber(row.genTps),
      rps: normalizeLlmStatusNumber(row.rps),
      numQueueReqs: normalizeLlmStatusNumber(row.numQueueReqs),
      numRunningReqs: normalizeLlmStatusNumber(row.numRunningReqs),
      numGrammarQueueReqs: normalizeLlmStatusNumber(row.numGrammarQueueReqs),
      numRunningReqsOfflineBatch: normalizeLlmStatusNumber(row.numRunningReqsOfflineBatch),
      numPrefillPreallocQueueReqs: normalizeLlmStatusNumber(row.numPrefillPreallocQueueReqs),
      numPrefillInflightQueueReqs: normalizeLlmStatusNumber(row.numPrefillInflightQueueReqs),
      numDecodePreallocQueueReqs: normalizeLlmStatusNumber(row.numDecodePreallocQueueReqs),
      numDecodeTransferQueueReqs: normalizeLlmStatusNumber(row.numDecodeTransferQueueReqs),
      utilization: normalizeLlmStatusNumber(row.utilization),
      cacheHitRate: normalizeLlmStatusNumber(row.cacheHitRate),
      inFlight: normalizeLlmStatusNumber(row.inFlight),
      maxInFlight: normalizeLlmStatusNumber(row.maxInFlight),
    }
  })

  return {rows, hasMetricsCompatibleJob, metadata}
}

export const getLatestLlmStatusRowsByInstance = (rows: LlmStatusRow[]) => {
  const latestRowsByInstance = rows.reduce((rowMap, row) => {
    return rowMap.has(row.instanceId) ? rowMap : rowMap.set(row.instanceId, row)
  }, new Map<string, LlmStatusRow>())

  return [...latestRowsByInstance.values()]
}

const getLlmStatusTimestamps = (rows: LlmStatusRow[]) => {
  return rows
    .map((row) => {
      return row.ts
    })
    .filter((timestamp): timestamp is Date => {
      return timestamp !== null
    })
}

export const getLlmMetricsSummary = (response: LlmStatusResponse): LlmMetricsSummary | null => {
  const latestRows = getLatestLlmStatusRowsByInstance(response.rows)

  if (latestRows.length === 0) {
    return {waiting: 0, running: 0, lastUpdate: null, hasMetricsCompatibleJob: response.hasMetricsCompatibleJob}
  }

  const waiting = latestRows.reduce((sum, row) => {
    return sum + (normalizeLlmStatusNumber(row.numQueueReqs) ?? 0)
  }, 0)
  const running = latestRows.reduce((sum, row) => {
    return sum + (normalizeLlmStatusNumber(row.numRunningReqs) ?? 0)
  }, 0)
  const timestamps = getLlmStatusTimestamps(latestRows)
  const lastUpdate =
    timestamps.length > 0
      ? new Date(
          Math.max(
            ...timestamps.map((timestamp) => {
              return timestamp.getTime()
            }),
          ),
        )
      : null

  return {waiting, running, lastUpdate, hasMetricsCompatibleJob: response.hasMetricsCompatibleJob}
}

const isLlmStatusActive = (row: LlmStatusRow) => {
  return (
    (normalizeLlmStatusNumber(row.numQueueReqs) ?? 0) > 0 || (normalizeLlmStatusNumber(row.numRunningReqs) ?? 0) > 0
  )
}

export const getLlmStatusRefetchInterval = (rows: LlmStatusRow[]) => {
  const latestRows = getLatestLlmStatusRowsByInstance(rows)

  return latestRows.some(isLlmStatusActive) ? 30 * 1000 : 60 * 1000
}
