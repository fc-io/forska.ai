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
  canRunMartRefreshDrain?: boolean
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
        const martRefreshDrainEligibilityModulePath = getModulePath('./src/server/utils/martRefreshDrainEligibility.ts')
        const projectMartLargeRebuildHeartbeatModulePath = getModulePath('./src/server/utils/projectMartLargeRebuildHeartbeat.ts')
        const projectMartRefreshWorkerHeartbeatModulePath = getModulePath('./src/server/utils/projectMartRefreshWorkerHeartbeat.ts')
        const reviewServingProjectorWorkerHeartbeatModulePath = getModulePath('./src/server/utils/reviewServingProjectorWorkerHeartbeat.ts')
        const requestAttemptCloseoutBackfillSchedulerModulePath = getModulePath('./src/server/utils/startRequestAttemptCloseoutBackfillScheduler.ts')
        const serverRuntimeRoleModulePath = getModulePath('./src/server/utils/serverRuntimeRole.ts')
        const duckdbOwnerConnectionHeartbeatModulePath = getModulePath('./src/server/utils/duckdbOwnerConnectionHeartbeat.ts')
        const calls = []
        const input = ${JSON.stringify(input)}

        void mock.module(martRefreshDrainEligibilityModulePath, () => {
          return {
            shouldCurrentRuntimeRunMartRefreshDrain: () => {
              return input.canRunMartRefreshDrain ?? true
            },
          }
        })
        void mock.module(projectMartLargeRebuildHeartbeatModulePath, () => {
          return {
            startProjectMartLargeRebuildHeartbeat: () => {
              calls.push('projectMartLargeRebuildHeartbeat')
            },
          }
        })
        void mock.module(projectMartRefreshWorkerHeartbeatModulePath, () => {
          return {
            startProjectMartRefreshWorkerHeartbeat: () => {
              calls.push('projectMartRefreshWorkerHeartbeat')
            },
          }
        })
        void mock.module(reviewServingProjectorWorkerHeartbeatModulePath, () => {
          return {
            startReviewServingProjectorWorkerHeartbeat: () => {
              calls.push('reviewServingProjectorWorkerHeartbeat')
            },
          }
        })
        void mock.module(getModulePath('./src/server/utils/reviewBulkOperationWorkerHeartbeat.ts'), () => {
          return {
            startReviewBulkOperationWorkerHeartbeat: () => {
              calls.push('reviewBulkOperationWorkerHeartbeat')
            },
          }
        })
        void mock.module(requestAttemptCloseoutBackfillSchedulerModulePath, () => {
          return {
            startRequestAttemptCloseoutBackfillScheduler: () => {
              calls.push('requestAttemptCloseoutBackfillScheduler')
            },
          }
        })
        void mock.module(serverRuntimeRoleModulePath, () => {
          return {
            shouldCurrentServerRunMaintenanceLoops: () => {
              return input.role === 'maintenance-worker'
            },
            startServerRuntimeRoleMonitor: () => {
              calls.push('serverRuntimeRoleMonitor')
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
        console.log(JSON.stringify({calls}))
      `,
    ],
    {cwd: process.cwd(), env: {...process.env}},
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
    'projectMartRefreshWorkerHeartbeat',
    'projectMartLargeRebuildHeartbeat',
    'reviewServingProjectorWorkerHeartbeat',
  ])
})

test('startBackgroundWork starts bulk worker when mart refresh drain is disabled', () => {
  const result = runStartBackgroundWork({canRunMartRefreshDrain: false, role: 'maintenance-worker'})

  expect(result.calls).toEqual([
    'serverRuntimeRoleMonitor',
    'duckdbOwnerConnectionHeartbeat',
    'requestAttemptCloseoutBackfillScheduler',
    'reviewBulkOperationWorkerHeartbeat',
  ])
})

test('startBackgroundWork skips maintenance work when the current role lacks maintenance capability', () => {
  const result = runStartBackgroundWork({role: 'judge-worker'})

  expect(result.calls).toEqual(['serverRuntimeRoleMonitor', 'duckdbOwnerConnectionHeartbeat'])
})
