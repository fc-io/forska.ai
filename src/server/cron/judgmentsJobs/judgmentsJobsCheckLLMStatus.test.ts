import {expect, test} from 'bun:test'

import {getSGLangMetrics} from './judgmentsJobsAdjustBatchSize/getSGLangMetrics.ts'

const fetchInputToString = (input: RequestInfo | URL): string => {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

const getLastJsonLine = (stdout: string) => {
  return (
    stdout
      .split('\n')
      .map((line) => {
        return line.trim()
      })
      .filter((line) => {
        return line !== ''
      })
      .at(-1) ?? ''
  )
}

test('SGLang metrics fetch uses a bounded abort signal and treats timeout failures as empty metrics', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{signal: AbortSignal | null; url: string}> = []

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({signal: init?.signal ?? null, url: fetchInputToString(input)})
    throw new DOMException('timed out', 'TimeoutError')
  }) as typeof fetch

  try {
    const metrics = await getSGLangMetrics('http://sglang-worker.local/v1')

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('http://sglang-worker.local/metrics')
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal)
    expect(metrics).toMatchObject({
      generationTokensTotal: 0,
      numQueueReqs: 0,
      numRequestsTotal: 0,
      numRunningReqs: 0,
      promptTokensTotal: 0,
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('llm status marks shared worker model attribution as multiple', () => {
  const run = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const appDatabaseServiceModulePath = new URL('./src/server/services/appDatabaseService.ts', 'file://' + process.cwd() + '/').href
        const metricsModulePath = new URL('./src/server/cron/judgmentsJobs/judgmentsJobsAdjustBatchSize/getSGLangMetrics.ts', 'file://' + process.cwd() + '/').href
        const insertStatements = []

        void mock.module(appDatabaseServiceModulePath, () => {
          return {
            getAppDatabaseService: () => {
              return {
                queryJson: async (statement) => {
                  return statement.includes('FROM app.judgment_job')
                    ? [
                        {
                          baseURL: 'http://shared-worker.local/v1',
                          modelName: 'model-a',
                          providerConfigJson: null,
                          providerKind: 'sglang',
                        },
                        {
                          baseURL: 'http://shared-worker.local/v1',
                          modelName: 'model-b',
                          providerConfigJson: null,
                          providerKind: 'sglang',
                        },
                      ]
                    : []
                },
                run: async (statement) => {
                  insertStatements.push(statement)
                },
              }
            },
          }
        })

        void mock.module(metricsModulePath, () => {
          return {
            getSGLangMetrics: async () => {
              return {
                cachedTokensTotal: 0,
                generationTokensTotal: 20,
                numQueueReqs: 0,
                numRequestsTotal: 3,
                numRunningReqs: 1,
                promptTokensTotal: 10,
              }
            },
          }
        })

        const {judgmentsJobsCheckLLMStatus} = await import('./src/server/cron/judgmentsJobs/judgmentsJobsCheckLLMStatus.ts?test=' + Date.now())
        await judgmentsJobsCheckLLMStatus()

        console.log(JSON.stringify({insertStatements}))
      `,
    ],
    {cwd: process.cwd(), env: process.env},
  )

  if (run.exitCode !== 0) {
    throw new Error(run.stderr.toString() || run.stdout.toString() || 'LLM status attribution test failed')
  }

  const parsed = JSON.parse(getLastJsonLine(run.stdout.toString())) as {insertStatements: string[]}

  expect(parsed.insertStatements).toHaveLength(1)
  expect(parsed.insertStatements[0]).toContain("'multiple'")
  expect(parsed.insertStatements[0]).not.toContain("'model-a'")
  expect(parsed.insertStatements[0]).not.toContain("'model-b'")
})
