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

const runStartBackgroundWork = (role: 'api' | 'judge-worker' | 'maintenance-worker') => {
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
        const martRefreshDrainHeartbeatModulePath = getModulePath('./src/server/utils/martRefreshDrainHeartbeat.ts')
        const serverRuntimeRoleModulePath = getModulePath('./src/server/utils/serverRuntimeRole.ts')
        const duckdbOwnerConnectionHeartbeatModulePath = getModulePath('./src/server/utils/duckdbOwnerConnectionHeartbeat.ts')
        const calls = []
        const role = ${JSON.stringify(role)}

        void mock.module(martRefreshDrainHeartbeatModulePath, () => {
          return {
            startMartRefreshDrainHeartbeat: () => {
              calls.push('martRefreshDrainHeartbeat')
            },
          }
        })
        void mock.module(serverRuntimeRoleModulePath, () => {
          return {
            shouldCurrentServerRunMaintenanceLoops: () => {
              return role === 'maintenance-worker'
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
  const result = runStartBackgroundWork('maintenance-worker')

  expect(result.calls).toEqual([
    'serverRuntimeRoleMonitor',
    'duckdbOwnerConnectionHeartbeat',
    'martRefreshDrainHeartbeat',
  ])
})

test('startBackgroundWork skips maintenance work when the current role lacks maintenance capability', () => {
  const result = runStartBackgroundWork('judge-worker')

  expect(result.calls).toEqual(['serverRuntimeRoleMonitor', 'duckdbOwnerConnectionHeartbeat'])
})
