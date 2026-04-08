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

const parseCallsResult = (
  value: string,
): {
  calls: Array<{batchSize: number; maxCycles: number; workerId: string}>
  config?: {batchSize: number; maxCyclesPerWake: number; pollIntervalMs: number}
} => {
  return JSON.parse(value) as {
    calls: Array<{batchSize: number; maxCycles: number; workerId: string}>
    config?: {batchSize: number; maxCyclesPerWake: number; pollIntervalMs: number}
  }
}

test('projectMartLargeRebuildHeartbeat runs one bounded burst with portable defaults', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const getModulePath = (relativePath) => {
          return new URL(relativePath, 'file://' + process.cwd() + '/').pathname
        }

        const heartbeatModulePath = getModulePath('./src/server/utils/projectMartLargeRebuildHeartbeat.ts')
        const cyclesModulePath = getModulePath('./src/server/services/projectMartLargeRebuildCyclesService.ts')
        const serverRuntimeRoleModulePath = getModulePath('./src/server/utils/serverRuntimeRole.ts')
        const calls = []

        void mock.module(cyclesModulePath, () => {
          return {
            runProjectMartLargeRebuildCycles: async (options) => {
              calls.push(options)
              await new Promise((resolve) => setTimeout(resolve, 5))
              return {backoffCount: 0, batchSize: options.batchSize, completedCycles: 2, cycleResults: [], maxCycles: options.maxCycles, status: 'completed', stopReason: 'idle', totalBackoffMs: 0, until: 'max-cycles', workerId: options.workerId}
            },
          }
        })
        void mock.module(serverRuntimeRoleModulePath, () => {
          return {
            registerWriterDemotionHandler: () => {},
            shouldCurrentServerRunWriterWork: () => true,
          }
        })

        const {startProjectMartLargeRebuildHeartbeat} = await import(heartbeatModulePath + '?heartbeat=' + Date.now())
        const stop = startProjectMartLargeRebuildHeartbeat({pollIntervalMs: 60_000})
        await new Promise((resolve) => setTimeout(resolve, 20))
        stop()
        console.log(JSON.stringify({calls}))
      `,
    ],
    {cwd: process.cwd(), env: process.env},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString() || runScript.stdout.toString() || 'projectMartLargeRebuildHeartbeat test failed',
    )
  }

  const result = parseCallsResult(getLastJsonLine(runScript.stdout.toString()))

  expect(result.calls).toHaveLength(1)
  expect(result.calls[0]?.batchSize).toBe(128)
  expect(result.calls[0]?.maxCycles).toBe(4)
  expect(result.calls[0]?.workerId).toContain('project-mart-large-rebuild-heartbeat:')
})

test('projectMartLargeRebuildHeartbeat exposes env-backed max cycles per wake and stop interval', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const getModulePath = (relativePath) => {
          return new URL(relativePath, 'file://' + process.cwd() + '/').pathname
        }

        process.env.PROJECT_MART_LARGE_REBUILD_BATCH_SIZE = '32'
        process.env.PROJECT_MART_LARGE_REBUILD_MAX_CYCLES_PER_WAKE = '7'
        process.env.PROJECT_MART_LARGE_REBUILD_POLL_INTERVAL_MS = '2500'

        const heartbeatModulePath = getModulePath('./src/server/utils/projectMartLargeRebuildHeartbeat.ts')
        const {getProjectMartLargeRebuildHeartbeatConfig} = await import(heartbeatModulePath + '?heartbeat=' + Date.now())
        console.log(JSON.stringify({config: getProjectMartLargeRebuildHeartbeatConfig()}))
      `,
    ],
    {cwd: process.cwd(), env: process.env},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString()
        || runScript.stdout.toString()
        || 'projectMartLargeRebuildHeartbeat config test failed',
    )
  }

  const result = parseCallsResult(getLastJsonLine(runScript.stdout.toString()))

  expect(result.config).toEqual({batchSize: 32, maxCyclesPerWake: 7, pollIntervalMs: 2500})
})
