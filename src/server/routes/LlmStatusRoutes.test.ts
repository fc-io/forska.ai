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
    {cwd: process.cwd(), encoding: 'utf8', env: {...process.env, LLM_STATUS_ROUTE_TEST_OUTPUT_PATH: outputPath}},
  )

  try {
    expect(runScript.exitCode).toBe(0)

    const result = JSON.parse(readFileSync(outputPath, 'utf8')) as {
      cachedBody: {data: unknown[]; hasMetricsCompatibleJob: boolean}
      fallbackBody: {data: unknown[]; hasMetricsCompatibleJob: boolean}
      fallbackDurationMs: number
      fallbackStatus: number
      queryCount: number
    }

    expect(result.fallbackStatus).toBe(200)
    expect(result.fallbackDurationMs).toBeLessThan(2700)
    expect(result.fallbackBody).toEqual({data: [], hasMetricsCompatibleJob: false})
    expect(result.cachedBody.hasMetricsCompatibleJob).toBe(true)
    expect(result.cachedBody.data).toHaveLength(1)
    expect(result.queryCount).toBe(4)
  } finally {
    rmSync(tempDirectory, {force: true, recursive: true})
  }
})
