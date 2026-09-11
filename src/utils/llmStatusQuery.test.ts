import {expect, mock, test} from 'bun:test'

import type {LlmStatusRow} from './llmStatusQuery.ts'

const apiClientModulePath = new URL('../services/apiClient.ts', import.meta.url).href

let llmStatusResponse: {
  error?: unknown
  data?: {data?: Record<string, unknown>[]; metadata?: Record<string, unknown>}
} = {data: {data: []}}

void mock.module(apiClientModulePath, () => {
  return {
    apiClient: {
      api: {
        llmstatus: {
          get: async () => {
            return llmStatusResponse
          },
        },
      },
    },
  }
})

const {fetchLlmStatus, getLlmMetricsSummary} = require('./llmStatusQuery.ts') as typeof import('./llmStatusQuery.ts')

const buildLlmStatusRow = ({
  instanceId,
  ts,
  numQueueReqs,
  numRunningReqs,
}: {
  instanceId: string
  ts: Date
  numQueueReqs: unknown
  numRunningReqs: unknown
}): LlmStatusRow => {
  return {
    ts,
    instanceId,
    modelName: 'openai/gpt-oss-120b',
    engineVersion: null,
    prefillTps: null,
    genTps: null,
    rps: null,
    numQueueReqs: numQueueReqs as number | null,
    numRunningReqs: numRunningReqs as number | null,
    numGrammarQueueReqs: null,
    numRunningReqsOfflineBatch: null,
    numPrefillPreallocQueueReqs: null,
    numPrefillInflightQueueReqs: null,
    numDecodePreallocQueueReqs: null,
    numDecodeTransferQueueReqs: null,
    utilization: null,
    cacheHitRate: null,
    inFlight: null,
    maxInFlight: null,
  }
}

test('fetchLlmStatus normalizes BIGINT counters returned as strings', async () => {
  llmStatusResponse = {
    data: {
      data: [
        {
          ts: '2026-03-25 10:07:00.073928+01',
          instanceId: 'http://localhost:30001',
          modelName: 'openai/gpt-oss-120b',
          engineVersion: null,
          prefillTps: 8728.480061033688,
          genTps: 1250.904009826032,
          rps: 8.188808628208115,
          numQueueReqs: '185',
          numRunningReqs: '204',
          numGrammarQueueReqs: '0',
          numRunningReqsOfflineBatch: '0',
          numPrefillPreallocQueueReqs: '0',
          numPrefillInflightQueueReqs: '0',
          numDecodePreallocQueueReqs: '0',
          numDecodeTransferQueueReqs: '0',
          utilization: 0,
          cacheHitRate: 0,
          inFlight: '389',
          maxInFlight: '400',
        },
      ],
      metadata: {
        cron: {
          duckdbMemoryLimit: '6400MiB',
          duckdbMemoryLimitMiB: 6400,
          heavyMaintenanceCrons: {
            active: false,
            lastSuccessAt: null,
            lastTickAt: null,
            reason: 'deferred-low-memory-owner',
            source: 'derived',
          },
          lowMemoryOwner: true,
          lowMemoryThresholdMiB: 8192,
          operationalJudgmentCrons: {
            active: true,
            lastSuccessAt: '2026-03-25T09:07:05.000Z',
            lastTickAt: '2026-03-25T09:07:00.000Z',
            reason: null,
            source: 'reported',
          },
          serverRole: 'maintenance-worker',
        },
        generatedAt: '2026-03-25T09:08:00.000Z',
        isStale: true,
        latestIngestedAgeMs: 60000,
        latestIngestedAt: '2026-03-25T09:07:00.073Z',
        staleAfterMs: 180000,
        staleMessage: 'Latest SGLang status row was ingested at 2026-03-25T09:07:00.073Z.',
        staleReason: 'latest-row-stale',
        tableExists: true,
      },
    },
  }

  const response = await fetchLlmStatus()
  const [row] = response.rows

  expect(row).toMatchObject({
    numQueueReqs: 185,
    numRunningReqs: 204,
    numGrammarQueueReqs: 0,
    inFlight: 389,
    maxInFlight: 400,
  })
  expect(response.metadata).toMatchObject({
    isStale: true,
    latestIngestedAgeMs: 60000,
    staleReason: 'latest-row-stale',
    tableExists: true,
  })
  expect(response.metadata?.latestIngestedAt?.toISOString()).toBe('2026-03-25T09:07:00.073Z')
  expect(response.metadata?.cron?.operationalJudgmentCrons).toMatchObject({
    active: true,
    lastSuccessAt: new Date('2026-03-25T09:07:05.000Z'),
    lastTickAt: new Date('2026-03-25T09:07:00.000Z'),
    source: 'reported',
  })
})

test('getLlmMetricsSummary keeps waiting and running counts numeric when runtime rows contain strings', () => {
  const summary = getLlmMetricsSummary({
    rows: [
      buildLlmStatusRow({
        instanceId: 'http://localhost:30001',
        ts: new Date('2026-03-25T09:07:00.073Z'),
        numQueueReqs: '185',
        numRunningReqs: '204',
      }),
      buildLlmStatusRow({
        instanceId: 'http://localhost:30000/v1',
        ts: new Date('2026-03-25T09:00:00.011Z'),
        numQueueReqs: '0',
        numRunningReqs: '0',
      }),
      buildLlmStatusRow({
        instanceId: 'http://127.0.0.1:30000/v1',
        ts: new Date('2026-03-25T09:00:00.013Z'),
        numQueueReqs: '0',
        numRunningReqs: '0',
      }),
    ],
    hasMetricsCompatibleJob: true,
    metadata: null,
  })

  expect(summary?.waiting).toBe(185)
  expect(summary?.running).toBe(204)
  expect(summary?.lastUpdate?.toISOString()).toBe('2026-03-25T09:07:00.073Z')
})
