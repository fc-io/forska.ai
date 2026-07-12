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
        const nativeSetTimeout = globalThis.setTimeout

        globalThis.setTimeout = (callback, delayMs, ...args) => {
          const timer = nativeSetTimeout(callback, delayMs, ...args)
          const nativeUnref = timer.unref
          timer.unref = () => {
            events.push(['unref', delayMs])
            return nativeUnref.call(timer)
          }
          return timer
        }

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

  expect(result.events).toEqual([['run', 0, 3, 100], ['unref', 1], ['run', 2, 3, 100], ['abort']])
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

test('review serving projector worker heartbeat restarts bounded low-memory worker bursts without closing DuckDB', () => {
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
  expect(result.events).not.toContainEqual(['recycle'])
})

test('review serving projector worker heartbeat keeps bounded restart timer refed until stop clears it', () => {
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
        const nativeSetTimeout = globalThis.setTimeout
        const nativeClearTimeout = globalThis.clearTimeout
        let restartTimer = null
        let restartTimerCleared = false

        globalThis.setTimeout = (callback, delayMs, ...args) => {
          const timer = nativeSetTimeout(callback, delayMs, ...args)
          if (delayMs === 10_000) {
            restartTimer = timer
          }
          return timer
        }
        globalThis.clearTimeout = (timer) => {
          if (timer === restartTimer) {
            restartTimerCleared = true
          }
          return nativeClearTimeout(timer)
        }

        void mock.module(runtimeRoleModulePath, () => {
          return {
            registerDuckdbOwnerDemotionHandler: () => {},
            shouldCurrentServerRunMaintenanceLoops: () => true,
          }
        })
        void mock.module(workerModulePath, () => {
          return {
            runReviewServingProjectorWorker: async () => {},
          }
        })

        const {startReviewServingProjectorWorkerHeartbeat} = await import(heartbeatModulePath + '?refed=' + Date.now())
        const stop = startReviewServingProjectorWorkerHeartbeat({
          maxCompletedRebuildChunksPerRun: 1,
          restartDelayMs: 10_000,
        })

        await new Promise((resolve) => {
          nativeSetTimeout(resolve, 5)
        })

        const restartTimerWasRefed = restartTimer?.hasRef() ?? false
        stop()

        console.log(JSON.stringify({restartTimerCleared, restartTimerWasRefed}))
      `,
    ],
    {cwd: process.cwd(), env: {...process.env, DUCKDB_MEMORY_LIMIT: ''}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString()
        || runScript.stdout.toString()
        || 'Review serving projector worker heartbeat refed restart test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
    restartTimerCleared: boolean
    restartTimerWasRefed: boolean
  }

  expect(result).toEqual({restartTimerCleared: true, restartTimerWasRefed: true})
})

test('review serving projector worker heartbeat exits a dedicated process after one bounded run', () => {
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
              events.push(['run', options.maxCompletedRebuildChunksPerRun])
            },
          }
        })

        process.exit = (code) => {
          events.push(['exit', code])
        }

        const {startReviewServingProjectorWorkerHeartbeat} = await import(heartbeatModulePath + '?exit=' + Date.now())
        const stop = startReviewServingProjectorWorkerHeartbeat({
          exitProcessAfterBoundedRun: true,
          maxCompletedRebuildChunksPerRun: 1,
          restartDelayMs: 10_000,
        })

        await new Promise((resolve) => {
          setTimeout(resolve, 5)
        })
        stop()

        console.log(JSON.stringify({events}))
      `,
    ],
    {cwd: process.cwd(), env: {...process.env, DUCKDB_MEMORY_LIMIT: ''}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString()
        || runScript.stdout.toString()
        || 'Review serving projector worker heartbeat bounded process exit test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {events: Array<[string, number]>}

  expect(result.events).toEqual([
    ['run', 1],
    ['exit', 0],
  ])
})

test('review serving projector worker heartbeat preserves explicit null burst cap', () => {
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
              events.push({maxCompletedRebuildChunksPerRun: options.maxCompletedRebuildChunksPerRun})
            },
          }
        })

        const {startReviewServingProjectorWorkerHeartbeat} = await import(heartbeatModulePath + '?null-cap=' + Date.now())
        startReviewServingProjectorWorkerHeartbeat({maxCompletedRebuildChunksPerRun: null, pollIntervalMs: 1})()

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
        || 'Review serving projector worker heartbeat null burst cap test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
    events: Array<{maxCompletedRebuildChunksPerRun: number | null}>
  }

  expect(result.events).toEqual([{maxCompletedRebuildChunksPerRun: null}])
})
