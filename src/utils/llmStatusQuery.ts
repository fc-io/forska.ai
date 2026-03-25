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

export type LlmMetricsSummary = {waiting: number; running: number; lastUpdate: Date | null}

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

export const fetchLlmStatus = async (): Promise<LlmStatusRow[]> => {
  const response = await apiClient.api.llmstatus.get()

  if (response.error) {
    throw new Error('Failed to fetch LLM status')
  }

  const entries = response.data?.data ?? []

  return entries.map((row: Record<string, unknown>) => {
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

export const getLlmMetricsSummary = (rows: LlmStatusRow[]): LlmMetricsSummary | null => {
  const latestRows = getLatestLlmStatusRowsByInstance(rows)

  if (latestRows.length === 0) {
    return null
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

  return {waiting, running, lastUpdate}
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
