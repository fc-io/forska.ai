import {expect, test} from 'bun:test'

const getLastJsonLine = (value: string) => {
  const lines = value
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      return line.trim()
    })
    .filter((line) => {
      return line.startsWith('{') && line.endsWith('}')
    })

  const [lastLine = ''] = lines.slice(-1)

  if (lastLine === '') {
    throw new Error(`Expected JSON output but received: ${value}`)
  }

  return lastLine
}

test('review bulk operation worker heartbeat preserves the original loop error and restarts', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')
        const {resolve} = await import('node:path')
        const {pathToFileURL} = await import('node:url')

        const getModulePath = (relativePath) => {
          return pathToFileURL(resolve(relativePath)).href
        }

        const heartbeatModulePath = getModulePath('./src/server/utils/reviewBulkOperationWorkerHeartbeat.ts')
        const workerModulePath = getModulePath('./src/server/workers/reviewBulkOperationWorker.ts')
        const exclusiveWorkModulePath = getModulePath('./src/server/utils/duckdbExclusiveWork.ts')
        const runtimeRoleModulePath = getModulePath('./src/server/utils/serverRuntimeRole.ts')
        const events = []
        let runCount = 0

        void mock.module(runtimeRoleModulePath, () => {
          return {
            registerDuckdbOwnerDemotionHandler: () => {},
            shouldCurrentServerRunMaintenanceLoops: () => true,
          }
        })
        void mock.module(exclusiveWorkModulePath, () => {
          return {
            hasActiveDuckdbExclusiveWork: () => false,
            isDuckdbExclusiveWorkAdmissionError: () => false,
          }
        })
        void mock.module(workerModulePath, () => {
          return {
            runReviewBulkOperationWorker: async (options) => {
              const currentRun = runCount
              runCount += 1
              events.push(['run', currentRun])

              if (currentRun === 0) {
                throw new Error('bulk loop failed')
              }

              await new Promise((resolve) => {
                options.signal.addEventListener('abort', () => {
                  events.push(['abort', currentRun])
                  resolve()
                }, {once: true})
              })
            },
          }
        })

        const {startReviewBulkOperationWorkerHeartbeat} = await import(heartbeatModulePath)
        const stop = startReviewBulkOperationWorkerHeartbeat({pollIntervalMs: 1})

        await new Promise((resolve) => {
          setTimeout(resolve, 50)
        })
        stop()
        await new Promise((resolve) => {
          setTimeout(resolve, 5)
        })

        console.log(JSON.stringify({events}))
      `,
    ],
    {cwd: process.cwd(), env: {...process.env}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString()
        || runScript.stdout.toString()
        || 'Review bulk operation worker heartbeat logging test failed',
    )
  }

  const output = `${runScript.stdout.toString()}\n${runScript.stderr.toString()}`
  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {events: Array<Array<number | string>>}

  expect(result.events).toEqual([
    ['run', 0],
    ['run', 1],
    ['abort', 1],
  ])
  expect(output).toContain('bulk loop failed')
  expect(output).not.toContain('An unknown error occurred in Effect.tryPromise')
})

test('review bulk operation worker heartbeat pauses and resumes after an exclusive-work admission race', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')
        const {resolve} = await import('node:path')
        const {pathToFileURL} = await import('node:url')

        const getModulePath = (relativePath) => {
          return pathToFileURL(resolve(relativePath)).href
        }

        const heartbeatModulePath = getModulePath('./src/server/utils/reviewBulkOperationWorkerHeartbeat.ts')
        const workerModulePath = getModulePath('./src/server/workers/reviewBulkOperationWorker.ts')
        const exclusiveWorkModulePath = getModulePath('./src/server/utils/duckdbExclusiveWork.ts')
        const runtimeRoleModulePath = getModulePath('./src/server/utils/serverRuntimeRole.ts')
        let exclusiveWorkActive = false
        let runCount = 0

        void mock.module(runtimeRoleModulePath, () => {
          return {
            registerDuckdbOwnerDemotionHandler: () => {},
            shouldCurrentServerRunMaintenanceLoops: () => true,
          }
        })
        void mock.module(exclusiveWorkModulePath, () => {
          return {
            hasActiveDuckdbExclusiveWork: () => exclusiveWorkActive,
            isDuckdbExclusiveWorkAdmissionError: (error) => {
              return error instanceof Error && error.message.includes('DuckDB is reserved for project-transfer ')
            },
          }
        })
        void mock.module(workerModulePath, () => {
          return {
            runReviewBulkOperationWorker: async (options) => {
              runCount += 1

              if (runCount === 1) {
                exclusiveWorkActive = true
                setTimeout(() => {
                  exclusiveWorkActive = false
                }, 5)
                throw new Error(
                  'DuckDB is reserved for project-transfer commit work; rejecting backgroundQuery for review.bulk.worker',
                )
              }

              await new Promise((resolve) => {
                options.signal.addEventListener('abort', resolve, {once: true})
              })
            },
          }
        })

        const {startReviewBulkOperationWorkerHeartbeat} = await import(heartbeatModulePath)
        const stop = startReviewBulkOperationWorkerHeartbeat({pollIntervalMs: 1})

        await new Promise((resolve) => {
          setTimeout(resolve, 25)
        })
        stop()

        console.log(JSON.stringify({runCount}))
      `,
    ],
    {cwd: process.cwd(), env: {...process.env}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString()
        || runScript.stdout.toString()
        || 'Review bulk operation worker heartbeat exclusive-work race test failed',
    )
  }

  const output = `${runScript.stdout.toString()}\n${runScript.stderr.toString()}`
  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {runCount: number}

  expect(result.runCount).toBe(2)
  expect(output).not.toContain('background loop failed')
  expect(output).not.toContain('DuckDB is reserved for project-transfer')
})
