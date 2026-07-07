import {expect, test} from 'bun:test'

import {getDefaultReviewServingRebuildChunkBatchMaxRssBytes} from './env.ts'

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

test('review serving projector worker heartbeat logs original loop failure and restarts', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const getModulePath = (relativePath) => {
          return new URL(relativePath, 'file://' + process.cwd() + '/').pathname
        }

        const heartbeatModulePath = getModulePath('./src/server/utils/reviewServingProjectorWorkerHeartbeat.ts')
        const workerModulePath = getModulePath('./src/server/workers/reviewServingProjectorWorker.ts')
        const runtimeRoleModulePath = getModulePath('./src/server/utils/serverRuntimeRole.ts')
        const events = []

        void mock.module(runtimeRoleModulePath, () => {
          return {
            registerDuckdbOwnerDemotionHandler: () => {},
            shouldCurrentServerRunMaintenanceLoops: () => true,
          }
        })

        void mock.module(workerModulePath, () => {
          return {
            runReviewServingProjectorWorker: async (options) => {
              events.push([
                'run',
                events.length,
                options.rebuildChunkBatchSize,
                options.rebuildChunkBatchMaxRssBytes,
              ])

              if (events.length === 1) {
                throw new Error('projector loop failed')
              }

              await new Promise((resolve) => {
                options.signal.addEventListener('abort', () => {
                  events.push(['abort'])
                  resolve()
                })
              })
            },
          }
        })

        const {startReviewServingProjectorWorkerHeartbeat} = await import(heartbeatModulePath + '?restart=' + Date.now())
        const stop = startReviewServingProjectorWorkerHeartbeat({
          pollIntervalMs: 1,
          rebuildChunkBatchMaxRssBytes: 100,
          rebuildChunkBatchSize: 3,
        })

        await new Promise((resolve) => {
          setTimeout(resolve, 75)
        })
        stop()
        await new Promise((resolve) => {
          setTimeout(resolve, 5)
        })

        console.log(JSON.stringify({events}))
      `,
    ],
    {cwd: process.cwd(), env: {...process.env, DUCKDB_MEMORY_LIMIT: ''}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString()
        || runScript.stdout.toString()
        || 'Review serving projector worker heartbeat logging test failed',
    )
  }

  const output = `${runScript.stdout.toString()}\n${runScript.stderr.toString()}`
  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {events: Array<Array<number | string>>}

  expect(result.events).toEqual([['run', 0, 3, 100], ['run', 1, 3, 100], ['abort']])
  expect(output).toContain('projector loop failed')
  expect(output).not.toContain('An unknown error occurred in Effect.tryPromise')
})

test('review serving projector worker heartbeat uses guarded maintenance batch defaults', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const getModulePath = (relativePath) => {
          return new URL(relativePath, 'file://' + process.cwd() + '/').pathname
        }

        const heartbeatModulePath = getModulePath('./src/server/utils/reviewServingProjectorWorkerHeartbeat.ts')
        const workerModulePath = getModulePath('./src/server/workers/reviewServingProjectorWorker.ts')
        const runtimeRoleModulePath = getModulePath('./src/server/utils/serverRuntimeRole.ts')
        const duckdbServiceModulePath = getModulePath('./src/server/utils/duckdbService.ts')
        const events = []

        void mock.module(runtimeRoleModulePath, () => {
          return {
            registerDuckdbOwnerDemotionHandler: () => {},
            shouldCurrentServerRunMaintenanceLoops: () => true,
          }
        })

        void mock.module(workerModulePath, () => {
          return {
            runReviewServingProjectorWorker: async (options) => {
              events.push({
                rebuildChunkBatchMaxRssBytes: options.rebuildChunkBatchMaxRssBytes,
                rebuildChunkBatchSize: options.rebuildChunkBatchSize,
              })
            },
          }
        })

        const {startReviewServingProjectorWorkerHeartbeat} = await import(heartbeatModulePath + '?defaults=' + Date.now())
        startReviewServingProjectorWorkerHeartbeat({pollIntervalMs: 1})()

        await new Promise((resolve) => {
          setTimeout(resolve, 5)
        })

        console.log(JSON.stringify({events}))
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DUCKDB_MEMORY_LIMIT: '',
        FORSKA_REVIEW_SERVING_REBUILD_CHUNK_BATCH_MAX_RSS_BYTES: '',
        FORSKA_REVIEW_SERVING_REBUILD_CHUNK_BATCH_SIZE: '',
      },
    },
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString()
        || runScript.stdout.toString()
        || 'Review serving projector worker heartbeat default batching test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
    events: Array<{rebuildChunkBatchMaxRssBytes: number; rebuildChunkBatchSize: number}>
  }

  expect(result.events).toEqual([
    {rebuildChunkBatchMaxRssBytes: getDefaultReviewServingRebuildChunkBatchMaxRssBytes(), rebuildChunkBatchSize: 2},
  ])
})

test('review serving projector worker heartbeat restarts bounded low-memory worker bursts', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const getModulePath = (relativePath) => {
          return new URL(relativePath, 'file://' + process.cwd() + '/').pathname
        }

        const heartbeatModulePath = getModulePath('./src/server/utils/reviewServingProjectorWorkerHeartbeat.ts')
        const workerModulePath = getModulePath('./src/server/workers/reviewServingProjectorWorker.ts')
        const runtimeRoleModulePath = getModulePath('./src/server/utils/serverRuntimeRole.ts')
        const duckdbServiceModulePath = getModulePath('./src/server/utils/duckdbService.ts')
        const events = []

        void mock.module(runtimeRoleModulePath, () => {
          return {
            registerDuckdbOwnerDemotionHandler: () => {},
            shouldCurrentServerRunMaintenanceLoops: () => true,
          }
        })

        void mock.module(workerModulePath, () => {
          return {
            runReviewServingProjectorWorker: async (options) => {
              const runIndex = events.filter((event) => {
                return event[0] === 'run'
              }).length
              events.push(['run', runIndex])

              await new Promise((resolve) => {
                options.signal.addEventListener('abort', () => {
                  events.push(['abort', runIndex])
                  resolve()
                }, {once: true})
              })
            },
          }
        })
        void mock.module(duckdbServiceModulePath, () => {
          return {
            closeDuckdbService: async () => {
              events.push(['recycle'])
            },
          }
        })

        const {startReviewServingProjectorWorkerHeartbeat} = await import(heartbeatModulePath + '?bounded=' + Date.now())
        const stop = startReviewServingProjectorWorkerHeartbeat({
          maxRunMs: 5,
          pollIntervalMs: 1,
          restartDelayMs: 1,
        })

        await new Promise((resolve) => {
          setTimeout(resolve, 75)
        })
        stop()
        await new Promise((resolve) => {
          setTimeout(resolve, 5)
        })

        console.log(JSON.stringify({events}))
      `,
    ],
    {cwd: process.cwd(), env: {...process.env, DUCKDB_MEMORY_LIMIT: '6400MiB'}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString()
        || runScript.stdout.toString()
        || 'Review serving projector worker heartbeat bounded restart test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {events: Array<Array<number | string>>}
  const runEvents = result.events.filter((event) => {
    return event[0] === 'run'
  })

  expect(runEvents.length).toBeGreaterThanOrEqual(2)
  expect(result.events).toContainEqual(['abort', 0])
  expect(result.events).toContainEqual(['recycle'])
})
