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
  disableServerMutations?: boolean
  duckdbMemoryLimit?: string
  promoteAfterStart?: boolean
  role: 'api' | 'judge-worker' | 'maintenance-worker'
}) => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const getModulePath = (relativePath) => {
          return new URL(relativePath, 'file://' + process.cwd() + '/').pathname
        }

        const startBackgroundWorkModulePath = getModulePath('./src/server/utils/startBackgroundWork.ts')
        const reviewServingProjectorWorkerHeartbeatModulePath = getModulePath('./src/server/utils/reviewServingProjectorWorkerHeartbeat.ts')
        const requestAttemptCloseoutBackfillSchedulerModulePath = getModulePath('./src/server/utils/startRequestAttemptCloseoutBackfillScheduler.ts')
        const serverRuntimeRoleModulePath = getModulePath('./src/server/utils/serverRuntimeRole.ts')
        const serverMutationModeModulePath = getModulePath('./src/server/utils/serverMutationMode.ts')
        const duckdbOwnerConnectionHeartbeatModulePath = getModulePath('./src/server/utils/duckdbOwnerConnectionHeartbeat.ts')
        const calls = []
        const input = ${JSON.stringify(input)}
        const promotionHandlers = []
        let currentRole = input.role

        void mock.module(reviewServingProjectorWorkerHeartbeatModulePath, () => {
          return {
            startReviewServingProjectorWorkerHeartbeat: (options = {}) => {
              const maxCompletedRebuildChunksPerRun = options.maxCompletedRebuildChunksPerRun ?? 'default'
              const maxRunMs = options.maxRunMs ?? 'default'
              calls.push('reviewServingProjectorWorkerHeartbeat:' + maxRunMs + ':' + maxCompletedRebuildChunksPerRun)
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
              return currentRole === 'maintenance-worker'
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
        console.log(JSON.stringify({calls}))
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...(input.duckdbMemoryLimit === undefined ? {} : {DUCKDB_MEMORY_LIMIT: input.duckdbMemoryLimit}),
      },
    },
  )

  if (runScript.exitCode !== 0) {
    throw new Error(runScript.stderr.toString() || runScript.stdout.toString() || 'startBackgroundWork test failed')
  }

  return JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {calls: string[]}
}

test('startBackgroundWork starts shared infrastructure and maintenance work for maintenance-worker', () => {
  const result = runStartBackgroundWork({role: 'maintenance-worker'})

  expect(result.calls).toEqual([
    'serverRuntimeRoleMonitor',
    'duckdbOwnerConnectionHeartbeat',
    'requestAttemptCloseoutBackfillScheduler',
    'reviewBulkOperationWorkerHeartbeat',
    'reviewServingProjectorWorkerHeartbeat:default:default',
  ])
})

test('startBackgroundWork skips maintenance work when the current role lacks maintenance capability', () => {
  const result = runStartBackgroundWork({role: 'judge-worker'})

  expect(result.calls).toEqual(['serverRuntimeRoleMonitor', 'duckdbOwnerConnectionHeartbeat'])
})

test('startBackgroundWork starts maintenance work after auto owner promotion', () => {
  const result = runStartBackgroundWork({promoteAfterStart: true, role: 'api'})

  expect(result.calls).toEqual([
    'serverRuntimeRoleMonitor',
    'duckdbOwnerConnectionHeartbeat',
    'requestAttemptCloseoutBackfillScheduler',
    'reviewBulkOperationWorkerHeartbeat',
    'reviewServingProjectorWorkerHeartbeat:default:default',
  ])
})

test('startBackgroundWork defers nonessential DuckDB maintenance under low-memory owner profile', () => {
  const result = runStartBackgroundWork({duckdbMemoryLimit: '6400MiB', role: 'maintenance-worker'})

  expect(result.calls).toEqual([
    'serverRuntimeRoleMonitor',
    'duckdbOwnerConnectionHeartbeat',
    'reviewServingProjectorWorkerHeartbeat:default:16',
  ])
})

test('startBackgroundWork skips all background work when server mutations are disabled', () => {
  const result = runStartBackgroundWork({disableServerMutations: true, role: 'maintenance-worker'})

  expect(result.calls).toEqual([])
})
