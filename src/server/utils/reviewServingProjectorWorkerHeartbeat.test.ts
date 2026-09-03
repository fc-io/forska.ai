import {spawnSync} from 'node:child_process'
import {tmpdir} from 'node:os'
import {resolve} from 'node:path'

import {expect, test} from 'bun:test'

import {getDefaultReviewServingRebuildChunkBatchMaxRssBytes} from './env.ts'
import {getReviewServingProjectorWorkerHardRestartRssBytes} from './reviewServingProjectorWorkerHeartbeat.ts'

const repoRoot = resolve(import.meta.dir, '../../..')

const getChildRuntimeEnv = (overrides: Record<string, string>) => {
  return {
    HOME: process.env.HOME ?? '',
    NODE_ENV: 'test',
    PATH: process.env.PATH ?? '',
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    USER: process.env.USER ?? '',
    ...overrides,
  }
}

const runBunEval = (script: string, env: Record<string, string>) => {
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: repoRoot,
    env: getChildRuntimeEnv(env),
    timeout: 10_000,
  })

  return {...result, exitCode: result.status ?? 1}
}

const readChildProcessOutput = (runScript: {stderr: {toString: () => string}; stdout: {toString: () => string}}) => {
  const stdout = runScript.stdout.toString()
  const stderr = runScript.stderr.toString()

  return {combined: `${stdout}\n${stderr}`, stderr, stdout}
}

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
          return new URL(relativePath, 'file://' + process.cwd() + '/').href
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
    const {stderr, stdout} = readChildProcessOutput(runScript)
    throw new Error(stderr || stdout || 'Review serving projector worker heartbeat logging test failed')
  }

  const {combined: output, stdout} = readChildProcessOutput(runScript)
  const result = JSON.parse(getLastJsonLine(stdout)) as {events: Array<Array<number | string>>}

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
          return new URL(relativePath, 'file://' + process.cwd() + '/').href
        }

        const heartbeatModulePath = getModulePath('./src/server/utils/reviewServingProjectorWorkerHeartbeat.ts')
        const workerModulePath = getModulePath('./src/server/workers/reviewServingProjectorWorker.ts')
        const runtimeRoleModulePath = getModulePath('./src/server/utils/serverRuntimeRole.ts')
        const duckdbServiceModulePath = getModulePath('./src/server/utils/duckdbService.ts')
        const projectTransferSessionRepositoryModulePath = getModulePath('./src/server/services/projectTransfer/projectTransferSessionRepository.ts')
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

test('review serving projector worker heartbeat does not start a loop while DuckDB exclusive work is active', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const getModulePath = (relativePath) => {
          return new URL(relativePath, 'file://' + process.cwd() + '/').href
        }

        const exclusiveWorkModulePath = getModulePath('./src/server/utils/duckdbExclusiveWork.ts')
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
            runReviewServingProjectorWorker: async () => {
              events.push(['run'])
            },
          }
        })

        const {prepareDuckdbExclusiveWork} = await import(exclusiveWorkModulePath)
        const handle = await prepareDuckdbExclusiveWork({
          kind: 'project_transfer_import',
          phase: 'commit',
          sessionId: 'session-1',
        })
        const {startReviewServingProjectorWorkerHeartbeat} = await import(heartbeatModulePath + '?exclusive-active=' + Date.now())
        const stop = startReviewServingProjectorWorkerHeartbeat({pollIntervalMs: 5})

        await new Promise((resolve) => {
          setTimeout(resolve, 20)
        })
        stop()
        await handle.release()

        console.log(JSON.stringify({events}))
      `,
    ],
    {cwd: process.cwd(), env: {...process.env, DUCKDB_MEMORY_LIMIT: ''}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString()
        || runScript.stdout.toString()
        || 'Review serving projector worker heartbeat exclusive-active guard test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {events: Array<Array<string>>}

  expect(result.events).toEqual([])
})

test('review serving projector worker hard RSS restart cap adds bounded restart grace', () => {
  const gibibyte = 1024 ** 3

  expect(getReviewServingProjectorWorkerHardRestartRssBytes(5 * gibibyte, 8 * gibibyte)).toBe(6 * gibibyte)
  expect(getReviewServingProjectorWorkerHardRestartRssBytes(12 * gibibyte, 128 * gibibyte)).toBe(13 * gibibyte)
})

test('review serving projector worker heartbeat restarts bounded low-memory worker bursts without closing DuckDB', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const getModulePath = (relativePath) => {
          return new URL(relativePath, 'file://' + process.cwd() + '/').href
        }

        const heartbeatModulePath = getModulePath('./src/server/utils/reviewServingProjectorWorkerHeartbeat.ts')
        const workerModulePath = getModulePath('./src/server/workers/reviewServingProjectorWorker.ts')
        const runtimeRoleModulePath = getModulePath('./src/server/utils/serverRuntimeRole.ts')
        const duckdbServiceModulePath = getModulePath('./src/server/utils/duckdbService.ts')
        const projectTransferSessionRepositoryModulePath = getModulePath('./src/server/services/projectTransfer/projectTransferSessionRepository.ts')
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

test('review serving projector worker heartbeat recycles DuckDB before high-RSS bounded restart', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const getModulePath = (relativePath) => {
          return new URL(relativePath, 'file://' + process.cwd() + '/').href
        }

        const heartbeatModulePath = getModulePath('./src/server/utils/reviewServingProjectorWorkerHeartbeat.ts')
        const workerModulePath = getModulePath('./src/server/workers/reviewServingProjectorWorker.ts')
        const runtimeRoleModulePath = getModulePath('./src/server/utils/serverRuntimeRole.ts')
        const duckdbServiceModulePath = getModulePath('./src/server/utils/duckdbService.ts')
        const projectTransferSessionRepositoryModulePath = getModulePath('./src/server/services/projectTransfer/projectTransferSessionRepository.ts')
        const events = []

        Object.defineProperty(process, 'memoryUsage', {
          value: () => {
            return {arrayBuffers: 0, external: 0, heapTotal: 0, heapUsed: 0, rss: 200}
          },
        })
        globalThis.Bun.gc = () => {
          events.push(['gc'])
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
              events.push(['run'])
              await new Promise((resolve) => {
                options.signal.addEventListener('abort', resolve, {once: true})
              })
            },
          }
        })
        void mock.module(duckdbServiceModulePath, () => {
          return {
            closeDuckdbService: async (options) => {
              events.push(['recycle', options.checkpointBeforeClose, options.releaseOwnerLease])
            },
          }
        })
        void mock.module(projectTransferSessionRepositoryModulePath, () => {
          return {
            getProjectTransferSessionRepository: () => ({
              hasActiveProjectTransferSessions: async () => false,
            }),
          }
        })
        const {startReviewServingProjectorWorkerHeartbeat} = await import(heartbeatModulePath + '?rss-recycle=' + Date.now())
        const stop = startReviewServingProjectorWorkerHeartbeat({
          maxRunMs: 5,
          pollIntervalMs: 1,
          rebuildChunkBatchMaxRssBytes: 100,
          restartDelayMs: 50,
        })

        await new Promise((resolve) => {
          setTimeout(resolve, 20)
        })
        stop()

        console.log(JSON.stringify({events}))
      `,
    ],
    {cwd: process.cwd(), env: {...process.env, DUCKDB_MEMORY_LIMIT: '6400MiB'}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString()
        || runScript.stdout.toString()
        || 'Review serving projector worker heartbeat high RSS recycle test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {events: Array<Array<boolean | string>>}

  expect(result.events).toContainEqual(['recycle', false, false])
  expect(result.events).toContainEqual(['gc'])
})

test('review serving projector worker heartbeat skips high-RSS recycle while foreground DuckDB work is active', () => {
  const runScript = runBunEval(
    `
        const {mock} = await import('bun:test')

        const getModulePath = (relativePath) => {
          return new URL(relativePath, 'file://' + process.cwd() + '/').href
        }

        const heartbeatModulePath = getModulePath('./src/server/utils/reviewServingProjectorWorkerHeartbeat.ts')
        const workerModulePath = getModulePath('./src/server/workers/reviewServingProjectorWorker.ts')
        const runtimeRoleModulePath = getModulePath('./src/server/utils/serverRuntimeRole.ts')
        const duckdbServiceModulePath = getModulePath('./src/server/utils/duckdbService.ts')
        const projectTransferSessionRepositoryModulePath = getModulePath('./src/server/services/projectTransfer/projectTransferSessionRepository.ts')
        const events = []

        Object.defineProperty(process, 'memoryUsage', {
          value: () => {
            events.push(['memoryUsage'])
            return {arrayBuffers: 0, external: 0, heapTotal: 0, heapUsed: 0, rss: 200}
          },
        })
        globalThis.Bun.gc = () => {
          events.push(['gc'])
        }
        process.exit = (code) => {
          events.push(['exit', code])
        }

        void mock.module(runtimeRoleModulePath, () => {
          return {
            registerDuckdbOwnerDemotionHandler: () => {},
            shouldCurrentServerRunMaintenanceLoops: () => true,
          }
        })
        void mock.module(workerModulePath, () => {
          return {
            runReviewServingProjectorWorker: async () => {
              events.push(['run'])
              return {reason: 'nativeHeavyChunkCompleted'}
            },
          }
        })
        void mock.module(duckdbServiceModulePath, () => {
          return {
            closeDuckdbService: async () => {
              events.push(['recycle'])
            },
            getDuckdbAppendRuntimeMetrics: () => {
              events.push(['appendMetrics'])
              return {queueDepth: 0}
            },
            getDuckdbQueueRuntimeMetricsSnapshot: () => {
              events.push(['queueMetrics'])
              return {main: {queueDepth: 1}}
            },
          }
        })
        void mock.module(projectTransferSessionRepositoryModulePath, () => {
          return {
            getProjectTransferSessionRepository: () => ({
              hasActiveProjectTransferSessions: async () => false,
            }),
          }
        })
        const {startReviewServingProjectorWorkerHeartbeat} = await import(heartbeatModulePath + '?foreground-active=' + Date.now())
        const stop = startReviewServingProjectorWorkerHeartbeat({
          maxCompletedRebuildChunksPerRun: 1,
          rebuildChunkBatchMaxRssBytes: 100,
          restartDelayMs: 50,
        })

        await new Promise((resolve) => {
          setTimeout(resolve, 20)
        })
        stop()

        console.log(JSON.stringify({events}))
      `,
    {DUCKDB_MEMORY_LIMIT: '6400MiB', FORSKA_RUNTIME_SERVICE: 'maintenance-worker-server'},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString()
        || runScript.stdout.toString()
        || 'Review serving projector worker heartbeat foreground-active recycle guard test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {events: Array<Array<number | string>>}

  expect(result.events).toContainEqual(['queueMetrics'])
  expect(result.events).toContainEqual(['appendMetrics'])
  expect(result.events).not.toContainEqual(['recycle'])
  expect(result.events).not.toContainEqual(['gc'])
  expect(result.events).not.toContainEqual(['exit', 0])
})

test('review serving projector worker heartbeat keeps skipping high-RSS recycle after repeated foreground DuckDB queue deferrals', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const getModulePath = (relativePath) => {
          return new URL(relativePath, 'file://' + process.cwd() + '/').href
        }

        const heartbeatModulePath = getModulePath('./src/server/utils/reviewServingProjectorWorkerHeartbeat.ts')
        const workerModulePath = getModulePath('./src/server/workers/reviewServingProjectorWorker.ts')
        const runtimeRoleModulePath = getModulePath('./src/server/utils/serverRuntimeRole.ts')
        const duckdbServiceModulePath = getModulePath('./src/server/utils/duckdbService.ts')
        const projectTransferSessionRepositoryModulePath = getModulePath('./src/server/services/projectTransfer/projectTransferSessionRepository.ts')
        const events = []

        Object.defineProperty(process, 'memoryUsage', {
          value: () => {
            events.push(['memoryUsage'])
            return {arrayBuffers: 0, external: 0, heapTotal: 0, heapUsed: 0, rss: 200}
          },
        })
        globalThis.Bun.gc = () => {
          events.push(['gc'])
        }
        process.exit = (code) => {
          events.push(['exit', code])
        }

        void mock.module(runtimeRoleModulePath, () => {
          return {
            registerDuckdbOwnerDemotionHandler: () => {},
            shouldCurrentServerRunMaintenanceLoops: () => true,
          }
        })
        void mock.module(workerModulePath, () => {
          return {
            runReviewServingProjectorWorker: async () => {
              events.push(['run'])
              return {reason: 'nativeHeavyChunkCompleted'}
            },
          }
        })
        void mock.module(duckdbServiceModulePath, () => {
          return {
            closeDuckdbService: async (options) => {
              events.push(['recycle', options.checkpointBeforeClose, options.releaseOwnerLease])
            },
            getDuckdbAppendRuntimeMetrics: () => {
              events.push(['appendMetrics'])
              return {queueDepth: 0}
            },
            getDuckdbQueueRuntimeMetricsSnapshot: () => {
              events.push(['queueMetrics'])
              return {main: {queueDepth: 1}}
            },
          }
        })
        void mock.module(projectTransferSessionRepositoryModulePath, () => {
          return {
            getProjectTransferSessionRepository: () => ({
              hasActiveProjectTransferSessions: async () => false,
            }),
          }
        })
        const {startReviewServingProjectorWorkerHeartbeat} = await import(heartbeatModulePath + '?foreground-bounded=' + Date.now())
        const stop = startReviewServingProjectorWorkerHeartbeat({
          maxCompletedRebuildChunksPerRun: 1,
          rebuildChunkBatchMaxRssBytes: 100,
          restartDelayMs: 1,
        })

        await new Promise((resolve) => {
          setTimeout(resolve, 60)
        })
        stop()

        console.log(JSON.stringify({events}))
      `,
    ],
    {
      cwd: process.cwd(),
      env: {...process.env, DUCKDB_MEMORY_LIMIT: '6400MiB', FORSKA_RUNTIME_SERVICE: 'maintenance-worker-server'},
    },
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString()
        || runScript.stdout.toString()
        || 'Review serving projector worker heartbeat bounded foreground recycle guard test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
    events: Array<Array<boolean | number | string>>
  }

  expect(
    result.events.filter((event) => {
      return event[0] === 'queueMetrics'
    }).length,
  ).toBeGreaterThanOrEqual(4)
  expect(result.events).not.toContainEqual(['recycle', false, false])
  expect(result.events).not.toContainEqual(['gc'])
  expect(result.events).not.toContainEqual(['exit', 0])
})

test('review serving projector worker heartbeat skips high-RSS recycle during project-transfer background activity', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const getModulePath = (relativePath) => {
          return new URL(relativePath, 'file://' + process.cwd() + '/').href
        }

        const activityModulePath = getModulePath('./src/server/services/projectTransfer/projectTransferBackgroundActivity.ts')
        const heartbeatModulePath = getModulePath('./src/server/utils/reviewServingProjectorWorkerHeartbeat.ts')
        const workerModulePath = getModulePath('./src/server/workers/reviewServingProjectorWorker.ts')
        const runtimeRoleModulePath = getModulePath('./src/server/utils/serverRuntimeRole.ts')
        const duckdbServiceModulePath = getModulePath('./src/server/utils/duckdbService.ts')
        const events = []

        Object.defineProperty(process, 'memoryUsage', {
          value: () => {
            events.push(['memoryUsage'])
            return {arrayBuffers: 0, external: 0, heapTotal: 0, heapUsed: 0, rss: 200}
          },
        })
        globalThis.Bun.gc = () => {
          events.push(['gc'])
        }
        process.exit = (code) => {
          events.push(['exit', code])
        }

        void mock.module(runtimeRoleModulePath, () => {
          return {
            registerDuckdbOwnerDemotionHandler: () => {},
            shouldCurrentServerRunMaintenanceLoops: () => true,
          }
        })
        void mock.module(workerModulePath, () => {
          return {
            runReviewServingProjectorWorker: async () => {
              events.push(['run'])
              return {reason: 'nativeHeavyChunkCompleted'}
            },
          }
        })
        void mock.module(duckdbServiceModulePath, () => {
          return {
            closeDuckdbService: async () => {
              events.push(['recycle'])
            },
            getDuckdbAppendRuntimeMetrics: () => {
              events.push(['appendMetrics'])
              return {queueDepth: 0}
            },
            getDuckdbQueueRuntimeMetricsSnapshot: () => {
              events.push(['queueMetrics'])
              return {main: {queueDepth: 0}}
            },
          }
        })

        const {runWithProjectTransferBackgroundActivity} = await import(activityModulePath)
        const {startReviewServingProjectorWorkerHeartbeat} = await import(heartbeatModulePath + '?project-transfer-active=' + Date.now())
        let stop = () => {}

        await runWithProjectTransferBackgroundActivity(async () => {
          stop = startReviewServingProjectorWorkerHeartbeat({
            maxCompletedRebuildChunksPerRun: 1,
            rebuildChunkBatchMaxRssBytes: 100,
            restartDelayMs: 50,
          })

          await new Promise((resolve) => {
            setTimeout(resolve, 20)
          })
        })
        stop()

        console.log(JSON.stringify({events}))
      `,
    ],
    {
      cwd: process.cwd(),
      env: {...process.env, DUCKDB_MEMORY_LIMIT: '6400MiB', FORSKA_RUNTIME_SERVICE: 'maintenance-worker-server'},
    },
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString()
        || runScript.stdout.toString()
        || 'Review serving projector worker heartbeat project-transfer activity recycle guard test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {events: Array<Array<number | string>>}

  expect(result.events).toContainEqual(['run'])
  expect(result.events).not.toContainEqual(['queueMetrics'])
  expect(result.events).not.toContainEqual(['appendMetrics'])
  expect(result.events).not.toContainEqual(['recycle'])
  expect(result.events).not.toContainEqual(['gc'])
  expect(result.events).not.toContainEqual(['exit', 0])
})

test('review serving projector worker heartbeat skips high-RSS recycle during active project-transfer sessions', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const getModulePath = (relativePath) => {
          return new URL(relativePath, 'file://' + process.cwd() + '/').href
        }

        const heartbeatModulePath = getModulePath('./src/server/utils/reviewServingProjectorWorkerHeartbeat.ts')
        const workerModulePath = getModulePath('./src/server/workers/reviewServingProjectorWorker.ts')
        const runtimeRoleModulePath = getModulePath('./src/server/utils/serverRuntimeRole.ts')
        const duckdbServiceModulePath = getModulePath('./src/server/utils/duckdbService.ts')
        const projectTransferSessionRepositoryModulePath = getModulePath('./src/server/services/projectTransfer/projectTransferSessionRepository.ts')
        const events = []

        Object.defineProperty(process, 'memoryUsage', {
          value: () => {
            events.push(['memoryUsage'])
            return {arrayBuffers: 0, external: 0, heapTotal: 0, heapUsed: 0, rss: 200}
          },
        })
        globalThis.Bun.gc = () => {
          events.push(['gc'])
        }
        process.exit = (code) => {
          events.push(['exit', code])
        }

        void mock.module(runtimeRoleModulePath, () => {
          return {
            registerDuckdbOwnerDemotionHandler: () => {},
            shouldCurrentServerRunMaintenanceLoops: () => true,
          }
        })
        void mock.module(workerModulePath, () => {
          return {
            runReviewServingProjectorWorker: async () => {
              events.push(['run'])
              return {reason: 'nativeHeavyChunkCompleted'}
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
        void mock.module(projectTransferSessionRepositoryModulePath, () => {
          return {
            getProjectTransferSessionRepository: () => ({
              hasActiveProjectTransferSessions: async () => {
                events.push(['activeTransferSessionCheck'])
                return true
              },
            }),
          }
        })

        const {startReviewServingProjectorWorkerHeartbeat} = await import(heartbeatModulePath + '?project-transfer-session-active=' + Date.now())
        const stop = startReviewServingProjectorWorkerHeartbeat({
          maxCompletedRebuildChunksPerRun: 1,
          rebuildChunkBatchMaxRssBytes: 100,
          restartDelayMs: 50,
        })

        await new Promise((resolve) => {
          setTimeout(resolve, 20)
        })
        stop()

        console.log(JSON.stringify({events}))
      `,
    ],
    {
      cwd: process.cwd(),
      env: {...process.env, DUCKDB_MEMORY_LIMIT: '6400MiB', FORSKA_RUNTIME_SERVICE: 'maintenance-worker-server'},
    },
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString()
        || runScript.stdout.toString()
        || 'Review serving projector worker heartbeat active transfer session recycle guard test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {events: Array<Array<number | string>>}

  expect(result.events).toContainEqual(['run'])
  expect(result.events).toContainEqual(['activeTransferSessionCheck'])
  expect(result.events).not.toContainEqual(['recycle'])
  expect(result.events).not.toContainEqual(['gc'])
  expect(result.events).not.toContainEqual(['exit', 0])
})

test('review serving projector worker heartbeat keeps bounded restart timer refed until stop clears it', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const getModulePath = (relativePath) => {
          return new URL(relativePath, 'file://' + process.cwd() + '/').href
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

test('review serving projector worker heartbeat restarts native-heavy completion in process after cooldown', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const getModulePath = (relativePath) => {
          return new URL(relativePath, 'file://' + process.cwd() + '/').href
        }

        const heartbeatModulePath = getModulePath('./src/server/utils/reviewServingProjectorWorkerHeartbeat.ts')
        const workerModulePath = getModulePath('./src/server/workers/reviewServingProjectorWorker.ts')
        const runtimeRoleModulePath = getModulePath('./src/server/utils/serverRuntimeRole.ts')
        const events = []
        const snapshots = []

        void mock.module(runtimeRoleModulePath, () => {
          return {
            registerDuckdbOwnerDemotionHandler: () => {},
            shouldCurrentServerRunMaintenanceLoops: () => true,
          }
        })
        void mock.module(workerModulePath, () => {
          return {
            runReviewServingProjectorWorker: async () => {
              events.push(['run'])
              return {reason: 'nativeHeavyChunkCompleted'}
            },
          }
        })

        process.kill = (pid, signal) => {
          events.push(['kill', pid, signal])
          return true
        }
        process.exit = (code) => {
          events.push(['exit', code])
        }

        const {startReviewServingProjectorWorkerHeartbeat} = await import(heartbeatModulePath + '?rotate=' + Date.now())
        const stop = startReviewServingProjectorWorkerHeartbeat({
          maxCompletedRebuildChunksPerRun: 1,
          restartDelayMs: 30,
        })

        await new Promise((resolve) => {
          setTimeout(resolve, 10)
        })
        snapshots.push([...events])
        await new Promise((resolve) => {
          setTimeout(resolve, 40)
        })
        stop()

        console.log(JSON.stringify({events, snapshots}))
      `,
    ],
    {cwd: process.cwd(), env: {...process.env, DUCKDB_MEMORY_LIMIT: ''}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString()
        || runScript.stdout.toString()
        || 'Review serving projector worker heartbeat native-heavy restart test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
    events: Array<[string, number?, string?]>
    snapshots: Array<Array<[string, number?, string?]>>
  }

  expect(result.snapshots).toEqual([[['run']]])
  expect(result.events).toEqual([['run'], ['run']])
})

test('review serving projector worker heartbeat exits supervised maintenance worker when recycle remains above restart RSS cap', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const getModulePath = (relativePath) => {
          return new URL(relativePath, 'file://' + process.cwd() + '/').href
        }

        const duckdbServiceModulePath = getModulePath('./src/server/utils/duckdbService.ts')
        const heartbeatModulePath = getModulePath('./src/server/utils/reviewServingProjectorWorkerHeartbeat.ts')
        const workerModulePath = getModulePath('./src/server/workers/reviewServingProjectorWorker.ts')
        const runtimeRoleModulePath = getModulePath('./src/server/utils/serverRuntimeRole.ts')
        const projectTransferSessionRepositoryModulePath = getModulePath('./src/server/services/projectTransfer/projectTransferSessionRepository.ts')
        const events = []

        void mock.module(runtimeRoleModulePath, () => {
          return {
            registerDuckdbOwnerDemotionHandler: () => {},
            shouldCurrentServerRunMaintenanceLoops: () => true,
          }
        })
        void mock.module(workerModulePath, () => {
          return {
            runReviewServingProjectorWorker: async () => {
              events.push(['run'])
              return {reason: 'nativeHeavyChunkCompleted'}
            },
          }
        })
        void mock.module(duckdbServiceModulePath, () => {
          return {
            closeDuckdbService: async (input) => {
              events.push(['closeDuckdb', input.checkpointBeforeClose, input.releaseOwnerLease])
            },
          }
        })
        void mock.module(projectTransferSessionRepositoryModulePath, () => {
          return {
            getProjectTransferSessionRepository: () => ({
              hasActiveProjectTransferSessions: async () => false,
            }),
          }
        })

        process.memoryUsage = () => {
          events.push(['memoryUsage'])
          return {rss: 3 * 1024 ** 3}
        }
        globalThis.Bun.gc = (force) => {
          events.push(['gc', force])
        }
        process.exit = (code) => {
          events.push(['exit', code])
        }

        const {startReviewServingProjectorWorkerHeartbeat} = await import(heartbeatModulePath + '?soft-high-rss=' + Date.now())
        const stop = startReviewServingProjectorWorkerHeartbeat({
          maxCompletedRebuildChunksPerRun: 1,
          rebuildChunkBatchMaxRssBytes: 1024 ** 3,
          restartDelayMs: 30,
        })

        await new Promise((resolve) => {
          setTimeout(resolve, 10)
        })
        stop()

        console.log(JSON.stringify({events}))
      `,
    ],
    {
      cwd: process.cwd(),
      env: {...process.env, DUCKDB_MEMORY_LIMIT: '', FORSKA_RUNTIME_SERVICE: 'maintenance-worker-server'},
    },
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString()
        || runScript.stdout.toString()
        || 'Review serving projector worker heartbeat high-RSS process restart test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
    events: Array<Array<boolean | number | string>>
  }

  expect(result.events).toEqual([
    ['run'],
    ['memoryUsage'],
    ['memoryUsage'],
    ['closeDuckdb', false, false],
    ['gc', true],
    ['memoryUsage'],
    ['exit', 0],
  ])
})

test('review serving projector worker heartbeat exits supervised maintenance worker when recycle remains above hard RSS cap', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const getModulePath = (relativePath) => {
          return new URL(relativePath, 'file://' + process.cwd() + '/').href
        }

        const duckdbServiceModulePath = getModulePath('./src/server/utils/duckdbService.ts')
        const heartbeatModulePath = getModulePath('./src/server/utils/reviewServingProjectorWorkerHeartbeat.ts')
        const workerModulePath = getModulePath('./src/server/workers/reviewServingProjectorWorker.ts')
        const runtimeRoleModulePath = getModulePath('./src/server/utils/serverRuntimeRole.ts')
        const projectTransferSessionRepositoryModulePath = getModulePath('./src/server/services/projectTransfer/projectTransferSessionRepository.ts')
        const events = []

        void mock.module(runtimeRoleModulePath, () => {
          return {
            registerDuckdbOwnerDemotionHandler: () => {},
            shouldCurrentServerRunMaintenanceLoops: () => true,
          }
        })
        void mock.module(workerModulePath, () => {
          return {
            runReviewServingProjectorWorker: async () => {
              events.push(['run'])
              return {reason: 'nativeHeavyChunkCompleted'}
            },
          }
        })
        void mock.module(duckdbServiceModulePath, () => {
          return {
            closeDuckdbService: async (input) => {
              events.push(['closeDuckdb', input.checkpointBeforeClose, input.releaseOwnerLease])
            },
          }
        })
        void mock.module(projectTransferSessionRepositoryModulePath, () => {
          return {
            getProjectTransferSessionRepository: () => ({
              hasActiveProjectTransferSessions: async () => false,
            }),
          }
        })

        process.memoryUsage = () => {
          events.push(['memoryUsage'])
          return {rss: 20 * 1024 ** 3}
        }
        globalThis.Bun.gc = (force) => {
          events.push(['gc', force])
        }
        process.exit = (code) => {
          events.push(['exit', code])
        }

        const {startReviewServingProjectorWorkerHeartbeat} = await import(heartbeatModulePath + '?exit-hard-rss=' + Date.now())
        const stop = startReviewServingProjectorWorkerHeartbeat({
          maxCompletedRebuildChunksPerRun: 1,
          rebuildChunkBatchMaxRssBytes: 5 * 1024 ** 3,
          restartDelayMs: 30,
        })

        await new Promise((resolve) => {
          setTimeout(resolve, 10)
        })
        stop()

        console.log(JSON.stringify({events}))
      `,
    ],
    {
      cwd: process.cwd(),
      env: {...process.env, DUCKDB_MEMORY_LIMIT: '', FORSKA_RUNTIME_SERVICE: 'maintenance-worker-server'},
    },
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString()
        || runScript.stdout.toString()
        || 'Review serving projector worker heartbeat hard high-RSS process restart test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
    events: Array<Array<boolean | number | string>>
  }

  expect(result.events).toEqual([
    ['run'],
    ['memoryUsage'],
    ['memoryUsage'],
    ['closeDuckdb', false, false],
    ['gc', true],
    ['memoryUsage'],
    ['exit', 0],
  ])
})

test('review serving projector worker heartbeat cancels pending native-heavy restart when stopped', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const getModulePath = (relativePath) => {
          return new URL(relativePath, 'file://' + process.cwd() + '/').href
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
            runReviewServingProjectorWorker: async () => {
              events.push(['run'])
              return {reason: 'nativeHeavyChunkCompleted'}
            },
          }
        })

        process.kill = (pid, signal) => {
          events.push(['kill', pid, signal])
          return true
        }
        process.exit = (code) => {
          events.push(['exit', code])
        }

        const {startReviewServingProjectorWorkerHeartbeat} = await import(heartbeatModulePath + '?cancel-restart=' + Date.now())
        const stop = startReviewServingProjectorWorkerHeartbeat({
          maxCompletedRebuildChunksPerRun: 1,
          restartDelayMs: 30,
        })

        await new Promise((resolve) => {
          setTimeout(resolve, 10)
        })
        stop()
        await new Promise((resolve) => {
          setTimeout(resolve, 40)
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
        || 'Review serving projector worker heartbeat native-heavy restart cancellation test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {events: Array<[string, number?, string?]>}

  expect(result.events).toEqual([['run']])
})

test('review serving projector worker heartbeat ignores obsolete immediate bounded process-exit requests', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const getModulePath = (relativePath) => {
          return new URL(relativePath, 'file://' + process.cwd() + '/').href
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
          restartDelayMs: 1,
        })

        await new Promise((resolve) => {
          setTimeout(resolve, 20)
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
        || 'Review serving projector worker heartbeat obsolete bounded process exit test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {events: Array<[string, number]>}

  expect(result.events.slice(0, 2)).toEqual([
    ['run', 1],
    ['run', 1],
  ])
  expect(result.events).not.toContainEqual(['exit', 0])
})

test('review serving projector worker heartbeat preserves explicit null burst cap', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const getModulePath = (relativePath) => {
          return new URL(relativePath, 'file://' + process.cwd() + '/').href
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
