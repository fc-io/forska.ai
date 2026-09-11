import {mkdtempSync, readFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {expect, setDefaultTimeout, test} from 'bun:test'

setDefaultTimeout(10_000)

test('llm status returns a bounded fallback while a slow foreground diagnostic refresh continues', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'llm-status-routes-'))
  const outputPath = join(tempDirectory, 'result.json')

  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {writeFileSync} = await import('node:fs')
        const {mock} = await import('bun:test')

        const waitFor = async (ms) => {
          await new Promise((resolve) => {
            setTimeout(resolve, ms)
          })
        }

        const appDatabaseServiceModulePath = new URL(
          './src/server/services/appDatabaseService.ts',
          'file://' + process.cwd() + '/',
        ).href
        let queryCount = 0

        void mock.module(appDatabaseServiceModulePath, () => {
          return {
            getAppDatabaseService: () => {
              return {
                queryJson: async (statement) => {
                  queryCount += 1

                  if (statement.includes('COUNT(*) AS count')) {
                    await waitFor(2600)
                    return [{count: 1}]
                  }

                  if (statement.includes("table_name = 'llm_status'")) {
                    return [{tableName: 'llm_status'}]
                  }

                  return [
                    {
                      cacheHitRate: null,
                      engineVersion: null,
                      genTps: null,
                      inFlight: null,
                      instanceId: 'instance-1',
                      maxInFlight: null,
                      modelName: 'model-1',
                      numDecodePreallocQueueReqs: null,
                      numDecodeTransferQueueReqs: null,
                      numGrammarQueueReqs: null,
                      numPrefillInflightQueueReqs: null,
                      numPrefillPreallocQueueReqs: null,
                      numQueueReqs: null,
                      numRunningReqs: null,
                      numRunningReqsOfflineBatch: null,
                      prefillTps: null,
                      rps: null,
                      ts: '2026-09-05T11:00:00.000Z',
                      utilization: null,
                    },
                  ]
                },
              }
            },
          }
        })

        const {__resetLlmStatusCacheForTests, llmStatusRoutes} = await import(
          './src/server/routes/LlmStatusRoutes.ts?slow-cache=' + Date.now()
        )
        __resetLlmStatusCacheForTests()

        const startedAt = Date.now()
        const fallbackResponse = await llmStatusRoutes.handle(new Request('http://localhost/api/llmstatus'))
        const fallbackBody = await fallbackResponse.json()
        const fallbackDurationMs = Date.now() - startedAt

        await waitFor(200)

        const cachedResponse = await llmStatusRoutes.handle(new Request('http://localhost/api/llmstatus'))
        const cachedBody = await cachedResponse.json()

        writeFileSync(
          process.env.LLM_STATUS_ROUTE_TEST_OUTPUT_PATH,
          JSON.stringify({
            cachedBody,
            fallbackBody,
            fallbackDurationMs,
            fallbackStatus: fallbackResponse.status,
            queryCount,
          }),
        )
      `,
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        DUCKDB_MEMORY_LIMIT: '6400MiB',
        LLM_STATUS_ROUTE_TEST_OUTPUT_PATH: outputPath,
        SERVER_ROLE: 'maintenance-worker',
      },
    },
  )

  try {
    expect(runScript.exitCode).toBe(0)

    const result = JSON.parse(readFileSync(outputPath, 'utf8')) as {
      cachedBody: {
        data: unknown[]
        hasMetricsCompatibleJob: boolean
        metadata: {isStale: boolean; staleReason: string | null; tableExists: boolean | null}
      }
      fallbackBody: {
        data: unknown[]
        hasMetricsCompatibleJob: boolean
        metadata: {isStale: boolean; staleReason: string | null; tableExists: boolean | null}
      }
      fallbackDurationMs: number
      fallbackStatus: number
      queryCount: number
    }

    expect(result.fallbackStatus).toBe(200)
    expect(result.fallbackDurationMs).toBeLessThan(2700)
    expect(result.fallbackBody).toMatchObject({
      data: [],
      hasMetricsCompatibleJob: false,
      metadata: {isStale: false, staleReason: null, tableExists: null},
    })
    expect(result.cachedBody.hasMetricsCompatibleJob).toBe(true)
    expect(result.cachedBody.metadata).toMatchObject({
      isStale: true,
      staleReason: 'latest-row-stale',
      tableExists: true,
    })
    expect(result.cachedBody.data).toHaveLength(1)
    expect(result.queryCount).toBe(4)
  } finally {
    rmSync(tempDirectory, {force: true, recursive: true})
  }
})

test('llm status reports missing ingested rows for a metrics-compatible running job', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'llm-status-routes-'))
  const outputPath = join(tempDirectory, 'result.json')

  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {writeFileSync} = await import('node:fs')
        const {mock} = await import('bun:test')

        const appDatabaseServiceModulePath = new URL(
          './src/server/services/appDatabaseService.ts',
          'file://' + process.cwd() + '/',
        ).href

        void mock.module(appDatabaseServiceModulePath, () => {
          return {
            getAppDatabaseService: () => {
              return {
                queryJson: async (statement) => {
                  if (statement.includes('COUNT(*) AS count')) {
                    return [{count: 1}]
                  }

                  if (statement.includes("table_name = 'llm_status'")) {
                    return [{tableName: 'llm_status'}]
                  }

                  return []
                },
              }
            },
          }
        })

        const {__resetLlmStatusCacheForTests, llmStatusRoutes} = await import(
          './src/server/routes/LlmStatusRoutes.ts?missing-rows=' + Date.now()
        )
        __resetLlmStatusCacheForTests()

        const response = await llmStatusRoutes.handle(new Request('http://localhost/api/llmstatus'))
        writeFileSync(process.env.LLM_STATUS_ROUTE_TEST_OUTPUT_PATH, JSON.stringify(await response.json()))
      `,
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        DUCKDB_MEMORY_LIMIT: '6400MiB',
        LLM_STATUS_ROUTE_TEST_OUTPUT_PATH: outputPath,
        SERVER_ROLE: 'maintenance-worker',
      },
    },
  )

  try {
    expect(runScript.exitCode).toBe(0)

    const body = JSON.parse(readFileSync(outputPath, 'utf8')) as {
      data: unknown[]
      hasMetricsCompatibleJob: boolean
      metadata: {
        cron: {
          heavyMaintenanceCrons: {active: boolean; reason: string | null}
          operationalJudgmentCrons: {active: boolean; reason: string | null}
        }
        isStale: boolean
        staleReason: string | null
        tableExists: boolean | null
      }
    }

    expect(body.data).toEqual([])
    expect(body.hasMetricsCompatibleJob).toBe(true)
    expect(body.metadata).toMatchObject({isStale: true, staleReason: 'no-ingested-rows', tableExists: true})
    expect(body.metadata.cron.operationalJudgmentCrons).toMatchObject({active: true, reason: null})
    expect(body.metadata.cron.heavyMaintenanceCrons).toMatchObject({active: false, reason: 'deferred-low-memory-owner'})
  } finally {
    rmSync(tempDirectory, {force: true, recursive: true})
  }
})

test('llm status explains stale rows when ingestion cron work is inactive', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'llm-status-routes-'))
  const outputPath = join(tempDirectory, 'result.json')

  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {writeFileSync} = await import('node:fs')
        const {mock} = await import('bun:test')

        const appDatabaseServiceModulePath = new URL(
          './src/server/services/appDatabaseService.ts',
          'file://' + process.cwd() + '/',
        ).href

        void mock.module(appDatabaseServiceModulePath, () => {
          return {
            getAppDatabaseService: () => {
              return {
                queryJson: async (statement) => {
                  if (statement.includes('COUNT(*) AS count')) {
                    return [{count: 1}]
                  }

                  if (statement.includes("table_name = 'llm_status'")) {
                    return [{tableName: 'llm_status'}]
                  }

                  return [
                    {
                      cacheHitRate: null,
                      engineVersion: null,
                      genTps: null,
                      inFlight: null,
                      instanceId: 'instance-1',
                      maxInFlight: null,
                      modelName: 'model-1',
                      numDecodePreallocQueueReqs: null,
                      numDecodeTransferQueueReqs: null,
                      numGrammarQueueReqs: null,
                      numPrefillInflightQueueReqs: null,
                      numPrefillPreallocQueueReqs: null,
                      numQueueReqs: null,
                      numRunningReqs: null,
                      numRunningReqsOfflineBatch: null,
                      prefillTps: null,
                      rps: null,
                      ts: '2020-01-01T00:00:00.000Z',
                      utilization: null,
                    },
                  ]
                },
              }
            },
          }
        })

        const {__resetLlmStatusCacheForTests, llmStatusRoutes} = await import(
          './src/server/routes/LlmStatusRoutes.ts?inactive=' + Date.now()
        )
        __resetLlmStatusCacheForTests()

        const response = await llmStatusRoutes.handle(new Request('http://localhost/api/llmstatus'))
        writeFileSync(process.env.LLM_STATUS_ROUTE_TEST_OUTPUT_PATH, JSON.stringify(await response.json()))
      `,
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        DUCKDB_MEMORY_LIMIT: '6400MiB',
        FORSKA_DISABLE_SERVER_MUTATIONS: 'true',
        LLM_STATUS_ROUTE_TEST_OUTPUT_PATH: outputPath,
        SERVER_ROLE: 'maintenance-worker',
      },
    },
  )

  try {
    expect(runScript.exitCode).toBe(0)

    const body = JSON.parse(readFileSync(outputPath, 'utf8')) as {
      metadata: {
        cron: {operationalJudgmentCrons: {active: boolean; reason: string | null}}
        isStale: boolean
        latestIngestedAt: string | null
        staleMessage: string | null
        staleReason: string | null
      }
    }

    expect(body.metadata).toMatchObject({
      isStale: true,
      latestIngestedAt: '2020-01-01T00:00:00.000Z',
      staleReason: 'ingestion-cron-inactive',
    })
    expect(body.metadata.staleMessage).toContain('mutation-work-disabled')
    expect(body.metadata.cron.operationalJudgmentCrons).toMatchObject({active: false, reason: 'mutation-work-disabled'})
  } finally {
    rmSync(tempDirectory, {force: true, recursive: true})
  }
})
