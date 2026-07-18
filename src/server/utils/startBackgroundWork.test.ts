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

const runStartBackgroundWork = (input: {
  appendQueueDepth?: number
  backgroundQueueDepth?: number
  disableServerMutations?: boolean
  duckdbMemoryLimit?: string
  foregroundQueueDepth?: number
  pauseRecoveryMinAgeMs?: number
  pauseReviewServingProjector?: boolean
  reviewServingRebuildChunkBatchMaxRssBytes?: number
  promoteAfterStart?: boolean
  role: 'api' | 'dev-single' | 'judge-worker' | 'maintenance-worker'
  waitAfterStartMs?: number
}) => {
  const duckdbPath = `/tmp/forska-start-background-work-${process.pid}-${Date.now()}.duckdb`
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')
        const {rmSync, writeFileSync} = await import('node:fs')

        const getModulePath = (relativePath) => {
          return new URL(relativePath, 'file://' + process.cwd() + '/').pathname
        }

        const startBackgroundWorkModulePath = getModulePath('./src/server/utils/startBackgroundWork.ts')
        const reviewServingProjectorWorkerHeartbeatModulePath = getModulePath('./src/server/utils/reviewServingProjectorWorkerHeartbeat.ts')
        const comparisonProjectServingMaintenanceWorkerHeartbeatModulePath = getModulePath('./src/server/utils/comparisonProjectServingMaintenanceWorkerHeartbeat.ts')
        const duckdbServiceModulePath = getModulePath('./src/server/utils/duckdbService.ts')
        const requestAttemptCloseoutBackfillSchedulerModulePath = getModulePath('./src/server/utils/startRequestAttemptCloseoutBackfillScheduler.ts')
        const runtimeLoggerModulePath = getModulePath('./src/server/utils/runtimeLogger.ts')
        const serverRuntimeRoleModulePath = getModulePath('./src/server/utils/serverRuntimeRole.ts')
        const serverMutationModeModulePath = getModulePath('./src/server/utils/serverMutationMode.ts')
        const duckdbOwnerConnectionHeartbeatModulePath = getModulePath('./src/server/utils/duckdbOwnerConnectionHeartbeat.ts')
        const runtimeLogger = await import(runtimeLoggerModulePath)
        const calls = []
        const input = ${JSON.stringify(input)}
        const pauseMarkerPath = process.env.DUCKDB_PATH + '.review-serving-projector-paused'
        const promotionHandlers = []
        let currentRole = input.role

        if (input.pauseReviewServingProjector) {
          writeFileSync(pauseMarkerPath, 'operator recovery pause')
        }

        void mock.module(reviewServingProjectorWorkerHeartbeatModulePath, () => {
          return {
            startReviewServingProjectorWorkerHeartbeat: (options = {}) => {
              const exitsAfterBoundedRun = Object.hasOwn(options, 'exitProcessAfterBoundedRun')
              const maxCompletedRebuildChunksPerRun = options.maxCompletedRebuildChunksPerRun ?? 'default'
              const maxRunMs = options.maxRunMs ?? 'default'
              calls.push(
                'reviewServingProjectorWorkerHeartbeat:'
                + maxRunMs
                + ':'
                + maxCompletedRebuildChunksPerRun
                + ':'
                + exitsAfterBoundedRun,
              )
              return () => {
                calls.push('stopReviewServingProjectorWorkerHeartbeat')
              }
            },
          }
        })
        void mock.module(getModulePath('./src/server/utils/reviewBulkOperationWorkerHeartbeat.ts'), () => {
          return {
            startReviewBulkOperationWorkerHeartbeat: () => {
              calls.push('reviewBulkOperationWorkerHeartbeat')
              return () => {
                calls.push('stopReviewBulkOperationWorkerHeartbeat')
              }
            },
          }
        })
        void mock.module(comparisonProjectServingMaintenanceWorkerHeartbeatModulePath, () => {
          return {
            startComparisonProjectServingMaintenanceWorkerHeartbeat: () => {
              calls.push('comparisonProjectServingMaintenanceWorkerHeartbeat')
              return () => {
                calls.push('stopComparisonProjectServingMaintenanceWorkerHeartbeat')
              }
            },
          }
        })
        void mock.module(duckdbServiceModulePath, () => {
          return {
            closeDuckdbService: async () => {
              calls.push('closeDuckdbService')
            },
            getDuckdbAppendRuntimeMetrics: () => {
              return {queueDepth: input.appendQueueDepth ?? 0}
            },
            getDuckdbQueueRuntimeMetricsSnapshot: () => {
              return {
                background: {queueDepth: input.backgroundQueueDepth ?? 0},
                main: {queueDepth: input.foregroundQueueDepth ?? 0},
              }
            },
          }
        })
        void mock.module(requestAttemptCloseoutBackfillSchedulerModulePath, () => {
          return {
            startRequestAttemptCloseoutBackfillScheduler: () => {
              calls.push('requestAttemptCloseoutBackfillScheduler')
              return () => {
                calls.push('stopRequestAttemptCloseoutBackfillScheduler')
              }
            },
          }
        })
        void mock.module(serverRuntimeRoleModulePath, () => {
          return {
            registerDuckdbOwnerDemotionHandler: () => {},
            registerDuckdbOwnerPromotionHandler: (handler) => {
              promotionHandlers.push(handler)
            },
            shouldCurrentServerRunMaintenanceLoops: () => {
              return currentRole === 'maintenance-worker' || currentRole === 'dev-single'
            },
            startServerRuntimeRoleMonitor: () => {
              calls.push('serverRuntimeRoleMonitor')
            },
          }
        })
        void mock.module(serverMutationModeModulePath, () => {
          return {
            shouldDisableServerMutationWork: () => {
              return input.disableServerMutations === true
            },
          }
        })
        void mock.module(runtimeLoggerModulePath, () => {
          return {
            ...runtimeLogger,
            writeRuntimeOperatorLogEvent: ({event}) => {
              calls.push(event)
            },
          }
        })
        void mock.module(duckdbOwnerConnectionHeartbeatModulePath, () => {
          return {
            startDuckdbOwnerConnectionHeartbeat: () => {
              calls.push('duckdbOwnerConnectionHeartbeat')
            },
          }
        })

        const {startBackgroundWork} = await import(startBackgroundWorkModulePath + '?start=' + Date.now())
        startBackgroundWork()
        if (input.promoteAfterStart) {
          currentRole = 'maintenance-worker'
          await Promise.all(promotionHandlers.map((handler) => handler('test-promotion')))
        }
        if ((input.waitAfterStartMs ?? 0) > 0) {
          await new Promise((resolve) => setTimeout(resolve, input.waitAfterStartMs))
        }
        rmSync(pauseMarkerPath, {force: true})
        console.log(JSON.stringify({calls}))
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DUCKDB_PATH: duckdbPath,
        SERVER_ROLE: input.role,
        ...(input.duckdbMemoryLimit === undefined ? {} : {DUCKDB_MEMORY_LIMIT: input.duckdbMemoryLimit}),
        ...(input.pauseRecoveryMinAgeMs === undefined
          ? {}
          : {FORSKA_REVIEW_SERVING_PROJECTOR_PAUSE_RECOVERY_MIN_AGE_MS: String(input.pauseRecoveryMinAgeMs)}),
        ...(input.reviewServingRebuildChunkBatchMaxRssBytes === undefined
          ? {}
          : {
              FORSKA_REVIEW_SERVING_REBUILD_CHUNK_BATCH_MAX_RSS_BYTES: String(
                input.reviewServingRebuildChunkBatchMaxRssBytes,
              ),
            }),
        FORSKA_REVIEW_SERVING_PROJECTOR_PAUSE_RECOVERY_POLL_INTERVAL_MS: '10',
        FORSKA_REVIEW_SERVING_PROJECTOR_PAUSE_RECOVERY_QUEUE_RESAMPLE_DELAY_MS: '1',
      },
    },
  )

  if (runScript.exitCode !== 0) {
    throw new Error(runScript.stderr.toString() || runScript.stdout.toString() || 'startBackgroundWork test failed')
  }

  return JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {calls: string[]}
}

test('startBackgroundWork starts shared infrastructure and maintenance work for maintenance-worker', () => {
  const result = runStartBackgroundWork({duckdbMemoryLimit: '20GB', role: 'maintenance-worker'})

  expect(result.calls).toEqual([
    'serverRuntimeRoleMonitor',
    'duckdbOwnerConnectionHeartbeat',
    'requestAttemptCloseoutBackfillScheduler',
    'reviewBulkOperationWorkerHeartbeat',
    'comparisonProjectServingMaintenanceWorkerHeartbeat',
    'reviewServingProjectorWorkerHeartbeat:default:default:false',
  ])
})

test('startBackgroundWork skips maintenance work when the current role lacks maintenance capability', () => {
  const result = runStartBackgroundWork({role: 'judge-worker'})

  expect(result.calls).toEqual(['serverRuntimeRoleMonitor', 'duckdbOwnerConnectionHeartbeat'])
})

test('startBackgroundWork starts maintenance work after auto owner promotion', () => {
  const result = runStartBackgroundWork({duckdbMemoryLimit: '20GB', promoteAfterStart: true, role: 'api'})

  expect(result.calls).toEqual([
    'serverRuntimeRoleMonitor',
    'duckdbOwnerConnectionHeartbeat',
    'requestAttemptCloseoutBackfillScheduler',
    'reviewBulkOperationWorkerHeartbeat',
    'comparisonProjectServingMaintenanceWorkerHeartbeat',
    'reviewServingProjectorWorkerHeartbeat:default:default:false',
  ])
})

test('startBackgroundWork defers nonessential DuckDB maintenance under low-memory owner profile', () => {
  const result = runStartBackgroundWork({duckdbMemoryLimit: '6400MiB', role: 'maintenance-worker'})

  expect(result.calls).toEqual([
    'serverRuntimeRoleMonitor',
    'duckdbOwnerConnectionHeartbeat',
    'comparisonProjectServingMaintenanceWorkerHeartbeat',
    'reviewServingProjectorWorkerHeartbeat:60000:1:false',
  ])
})

test('startBackgroundWork defers nonessential DuckDB maintenance under normalized default owner limit', () => {
  const result = runStartBackgroundWork({duckdbMemoryLimit: '', role: 'maintenance-worker'})

  expect(result.calls).toEqual([
    'serverRuntimeRoleMonitor',
    'duckdbOwnerConnectionHeartbeat',
    'comparisonProjectServingMaintenanceWorkerHeartbeat',
    'reviewServingProjectorWorkerHeartbeat:60000:1:false',
  ])
})

test('startBackgroundWork keeps low-memory dev-single review serving restarts in process', () => {
  const result = runStartBackgroundWork({duckdbMemoryLimit: '6400MiB', role: 'dev-single'})

  expect(result.calls).toEqual([
    'serverRuntimeRoleMonitor',
    'duckdbOwnerConnectionHeartbeat',
    'comparisonProjectServingMaintenanceWorkerHeartbeat',
    'reviewServingProjectorWorkerHeartbeat:60000:1:false',
  ])
})

test('startBackgroundWork keeps owner infrastructure active while the review-serving projector is paused', () => {
  const result = runStartBackgroundWork({
    duckdbMemoryLimit: '6400MiB',
    pauseReviewServingProjector: true,
    role: 'maintenance-worker',
  })

  expect(result.calls).toEqual([
    'serverRuntimeRoleMonitor',
    'duckdbOwnerConnectionHeartbeat',
    'review-serving-projector.paused',
    'comparisonProjectServingMaintenanceWorkerHeartbeat',
  ])
})

test('startBackgroundWork auto-resumes paused review serving projector when queues are idle', () => {
  const result = runStartBackgroundWork({
    duckdbMemoryLimit: '6400MiB',
    pauseRecoveryMinAgeMs: 1,
    pauseReviewServingProjector: true,
    role: 'maintenance-worker',
    waitAfterStartMs: 25,
  })

  expect(result.calls).toEqual([
    'serverRuntimeRoleMonitor',
    'duckdbOwnerConnectionHeartbeat',
    'review-serving-projector.paused',
    'comparisonProjectServingMaintenanceWorkerHeartbeat',
    'review-serving-projector.pause-recovered',
    'reviewServingProjectorWorkerHeartbeat:60000:1:false',
  ])
})

test('startBackgroundWork keeps paused review serving projector stopped while DuckDB queues are active', () => {
  const result = runStartBackgroundWork({
    backgroundQueueDepth: 1,
    duckdbMemoryLimit: '6400MiB',
    pauseRecoveryMinAgeMs: 1,
    pauseReviewServingProjector: true,
    role: 'maintenance-worker',
    waitAfterStartMs: 25,
  })

  expect(result.calls.slice(0, 5)).toEqual([
    'serverRuntimeRoleMonitor',
    'duckdbOwnerConnectionHeartbeat',
    'review-serving-projector.paused',
    'comparisonProjectServingMaintenanceWorkerHeartbeat',
    'review-serving-projector.pause-recovery-wait',
  ])
  expect(result.calls).not.toContain('reviewServingProjectorWorkerHeartbeat:60000:1:false')
})

test('startBackgroundWork recycles DuckDB once before resuming paused review serving projector above RSS cap', () => {
  const result = runStartBackgroundWork({
    duckdbMemoryLimit: '6400MiB',
    pauseRecoveryMinAgeMs: 1,
    pauseReviewServingProjector: true,
    reviewServingRebuildChunkBatchMaxRssBytes: 1,
    role: 'maintenance-worker',
    waitAfterStartMs: 25,
  })

  expect(result.calls).toContain('review-serving-projector.pause-recovery-recycle-duckdb')
  expect(result.calls).toContain('closeDuckdbService')
  expect(result.calls).not.toContain('reviewServingProjectorWorkerHeartbeat:60000:1:false')
})

test('startBackgroundWork skips all background work when server mutations are disabled', () => {
  const result = runStartBackgroundWork({disableServerMutations: true, role: 'maintenance-worker'})

  expect(result.calls).toEqual([])
})
