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
      prefillTps: (row.prefillTps as number | null) ?? null,
      genTps: (row.genTps as number | null) ?? null,
      rps: (row.rps as number | null) ?? null,
      numQueueReqs: (row.numQueueReqs as number | null) ?? null,
      numRunningReqs: (row.numRunningReqs as number | null) ?? null,
      numGrammarQueueReqs: (row.numGrammarQueueReqs as number | null) ?? null,
      numRunningReqsOfflineBatch: (row.numRunningReqsOfflineBatch as number | null) ?? null,
      numPrefillPreallocQueueReqs: (row.numPrefillPreallocQueueReqs as number | null) ?? null,
      numPrefillInflightQueueReqs: (row.numPrefillInflightQueueReqs as number | null) ?? null,
      numDecodePreallocQueueReqs: (row.numDecodePreallocQueueReqs as number | null) ?? null,
      numDecodeTransferQueueReqs: (row.numDecodeTransferQueueReqs as number | null) ?? null,
      utilization: (row.utilization as number | null) ?? null,
      cacheHitRate: (row.cacheHitRate as number | null) ?? null,
      inFlight: (row.inFlight as number | null) ?? null,
      maxInFlight: (row.maxInFlight as number | null) ?? null,
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
    return sum + (row.numQueueReqs ?? 0)
  }, 0)
  const running = latestRows.reduce((sum, row) => {
    return sum + (row.numRunningReqs ?? 0)
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
  return (row.numQueueReqs ?? 0) > 0 || (row.numRunningReqs ?? 0) > 0
}

export const getLlmStatusRefetchInterval = (rows: LlmStatusRow[]) => {
  const latestRows = getLatestLlmStatusRowsByInstance(rows)

  return latestRows.some(isLlmStatusActive) ? 30 * 1000 : 60 * 1000
}
