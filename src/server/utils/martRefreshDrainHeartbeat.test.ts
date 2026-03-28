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

test('startMartRefreshDrainHeartbeat flushes immediately when writer work is enabled', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const getModulePath = (relativePath) => {
          return new URL(relativePath, 'file://' + process.cwd() + '/').pathname
        }

        const martRefreshDrainHeartbeatModulePath = getModulePath('./src/server/utils/martRefreshDrainHeartbeat.ts')
        const martRefreshServiceModulePath = getModulePath('./src/server/services/getDuckdbMartRefreshService.ts')
        const serverRuntimeRoleModulePath = getModulePath('./src/server/utils/serverRuntimeRole.ts')
        let flushCount = 0
        const actualServerRuntimeRoleModule = await import(serverRuntimeRoleModulePath + '?actual=' + Date.now())

        void mock.module(martRefreshServiceModulePath, () => {
          return {
            getDuckdbMartRefreshService: () => {
              return {
                flush: async () => {
                  flushCount += 1
                },
              }
            },
          }
        })
        void mock.module(serverRuntimeRoleModulePath, () => {
          return {
            ...actualServerRuntimeRoleModule,
            shouldCurrentServerRunWriterWork: () => {
              return true
            },
          }
        })

        const {startMartRefreshDrainHeartbeat} = await import(martRefreshDrainHeartbeatModulePath + '?writer=' + Date.now())
        const stop = startMartRefreshDrainHeartbeat({intervalMs: 50})

        try {
          await new Promise((resolve) => {
            setTimeout(resolve, 20)
          })
          console.log(JSON.stringify({flushCount}))
        } finally {
          stop()
        }
      `,
    ],
    {cwd: process.cwd(), env: {...process.env}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString() || runScript.stdout.toString() || 'Mart refresh heartbeat writer test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {flushCount: number}

  expect(result.flushCount).toBeGreaterThanOrEqual(1)
})

test('startMartRefreshDrainHeartbeat begins flushing after the server becomes writer', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const getModulePath = (relativePath) => {
          return new URL(relativePath, 'file://' + process.cwd() + '/').pathname
        }

        const martRefreshDrainHeartbeatModulePath = getModulePath('./src/server/utils/martRefreshDrainHeartbeat.ts')
        const martRefreshServiceModulePath = getModulePath('./src/server/services/getDuckdbMartRefreshService.ts')
        const serverRuntimeRoleModulePath = getModulePath('./src/server/utils/serverRuntimeRole.ts')
        let flushCount = 0
        let shouldRunWriterWork = false
        const actualServerRuntimeRoleModule = await import(serverRuntimeRoleModulePath + '?actual=' + Date.now())

        void mock.module(martRefreshServiceModulePath, () => {
          return {
            getDuckdbMartRefreshService: () => {
              return {
                flush: async () => {
                  flushCount += 1
                },
              }
            },
          }
        })
        void mock.module(serverRuntimeRoleModulePath, () => {
          return {
            ...actualServerRuntimeRoleModule,
            shouldCurrentServerRunWriterWork: () => {
              return shouldRunWriterWork
            },
          }
        })

        const {startMartRefreshDrainHeartbeat} = await import(martRefreshDrainHeartbeatModulePath + '?promotion=' + Date.now())
        const stop = startMartRefreshDrainHeartbeat({intervalMs: 10})

        try {
          await new Promise((resolve) => {
            setTimeout(resolve, 25)
          })
          const beforePromotionFlushCount = flushCount
          shouldRunWriterWork = true
          await new Promise((resolve) => {
            setTimeout(resolve, 30)
          })
          console.log(JSON.stringify({beforePromotionFlushCount, flushCount}))
        } finally {
          stop()
        }
      `,
    ],
    {cwd: process.cwd(), env: {...process.env}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString() || runScript.stdout.toString() || 'Mart refresh heartbeat promotion test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
    beforePromotionFlushCount: number
    flushCount: number
  }

  expect(result.beforePromotionFlushCount).toBe(0)
  expect(result.flushCount).toBeGreaterThanOrEqual(1)
})
