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

test('startBackgroundWork starts role monitor, writer heartbeat, and mart refresh heartbeat', () => {
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
        const writerConnectionHeartbeatModulePath = getModulePath('./src/server/utils/writerConnectionHeartbeat.ts')
        const calls = []

        void mock.module(martRefreshDrainHeartbeatModulePath, () => {
          return {
            startMartRefreshDrainHeartbeat: () => {
              calls.push('martRefreshDrainHeartbeat')
            },
          }
        })
        void mock.module(serverRuntimeRoleModulePath, () => {
          return {
            startServerRuntimeRoleMonitor: () => {
              calls.push('serverRuntimeRoleMonitor')
            },
          }
        })
        void mock.module(writerConnectionHeartbeatModulePath, () => {
          return {
            startWriterConnectionHeartbeat: () => {
              calls.push('writerConnectionHeartbeat')
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

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {calls: string[]}

  expect(result.calls).toEqual(['serverRuntimeRoleMonitor', 'writerConnectionHeartbeat', 'martRefreshDrainHeartbeat'])
})
