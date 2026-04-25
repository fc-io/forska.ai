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

test('startMartRefreshDrainHeartbeat starts protected consumers at the low-memory cap', () => {
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
        const projectMartLargeRebuildHeartbeatModulePath = getModulePath('./src/server/utils/projectMartLargeRebuildHeartbeat.ts')
        const projectMartRefreshWorkerHeartbeatModulePath = getModulePath('./src/server/utils/projectMartRefreshWorkerHeartbeat.ts')
        const events = []

        process.env.DUCKDB_MEMORY_LIMIT = '6400MiB'

        void mock.module(projectMartLargeRebuildHeartbeatModulePath, () => {
          return {
            startProjectMartLargeRebuildHeartbeat: (options) => {
              events.push(['largeRebuildStart', options.pollIntervalMs])
              return () => {
                events.push(['largeRebuildStop'])
              }
            },
          }
        })
        void mock.module(projectMartRefreshWorkerHeartbeatModulePath, () => {
          return {
            startProjectMartRefreshWorkerHeartbeat: (options) => {
              events.push(['refreshWorkerStart', options.pollIntervalMs])
              return () => {
                events.push(['refreshWorkerStop'])
              }
            },
          }
        })

        const {startMartRefreshDrainHeartbeat} = await import(martRefreshDrainHeartbeatModulePath + '?low-memory=' + Date.now())
        const stop = startMartRefreshDrainHeartbeat({intervalMs: 10})

        stop()
        console.log(JSON.stringify({events, stopType: typeof stop}))
      `,
    ],
    {cwd: process.cwd(), env: {...process.env}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString() || runScript.stdout.toString() || 'Mart refresh heartbeat low-memory test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
    events: Array<Array<number | string>>
    stopType: string
  }

  expect(result.events).toEqual([
    ['refreshWorkerStart', 10],
    ['largeRebuildStart', 10],
    ['refreshWorkerStop'],
    ['largeRebuildStop'],
  ])
  expect(result.stopType).toBe('function')
})
