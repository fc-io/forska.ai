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
  config?: {
    automatic: {
      activeLargeRebuildProjectCount: number
      batchSize: number
      maxCyclesPerWake: number
      pollIntervalMs: number
    }
    batchSize: number
    maxCyclesPerWake: number
    pollIntervalMs: number
    sources: {batchSize: string; maxCyclesPerWake: string; pollIntervalMs: string}
  }
} => {
  return JSON.parse(value) as {
    calls: Array<{batchSize: number; maxCycles: number; workerId: string}>
    config?: {
      automatic: {
        activeLargeRebuildProjectCount: number
        batchSize: number
        maxCyclesPerWake: number
        pollIntervalMs: number
      }
      batchSize: number
      maxCyclesPerWake: number
      pollIntervalMs: number
      sources: {batchSize: string; maxCyclesPerWake: string; pollIntervalMs: string}
    }
  }
}

test('projectMartLargeRebuildHeartbeat runs one bounded burst with resolved tuning config', () => {
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
        const tuningModulePath = getModulePath('./src/server/utils/projectMartLargeRebuildTuning.ts')
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
        void mock.module(tuningModulePath, () => {
          return {
            getProjectMartLargeRebuildHeartbeatConfig: async () => {
              return {
                automatic: {
                  activeLargeRebuildProjectCount: 2,
                  batchSize: 128,
                  maxCyclesPerWake: 4,
                  pollIntervalMs: 1000,
                  profile: 'medium',
                  totalMemoryGb: 32,
                },
                batchSize: 128,
                maxCyclesPerWake: 4,
                pollIntervalMs: 1000,
                sources: {batchSize: 'automatic', maxCyclesPerWake: 'automatic', pollIntervalMs: 'automatic'},
                stored: {
                  backgroundWriterDuckdbMemoryLimit: null,
                  batchSize: null,
                  maxCyclesPerWake: null,
                  pollIntervalMs: null,
                  tuningMode: 'automatic',
                },
              }
            },
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

test('projectMartLargeRebuildHeartbeat resolves env overrides ahead of manual settings', () => {
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

        const tuningModulePath = getModulePath('./src/server/utils/projectMartLargeRebuildTuning.ts')
        const {resolveProjectMartLargeRebuildHeartbeatConfig} = await import(tuningModulePath + '?heartbeat=' + Date.now())
        console.log(JSON.stringify({config: resolveProjectMartLargeRebuildHeartbeatConfig({
          activeLargeRebuildProjectCount: 1,
          envValues: process.env,
          storedSettings: {
            backgroundWriterDuckdbMemoryLimit: '12GB',
            batchSize: 512,
            maxCyclesPerWake: 9,
            pollIntervalMs: 500,
            tuningMode: 'manual',
          },
          totalMemoryBytes: 64 * 1024 ** 3,
        })}))
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

  expect(result.config).toMatchObject({
    automatic: {batchSize: 512, maxCyclesPerWake: 4, pollIntervalMs: 1000},
    batchSize: 32,
    maxCyclesPerWake: 7,
    pollIntervalMs: 2500,
    sources: {batchSize: 'env', maxCyclesPerWake: 'env', pollIntervalMs: 'env'},
  })
})

test('projectMartLargeRebuildHeartbeat resolves machine-aware automatic config for a single active rebuild', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const getModulePath = (relativePath) => {
          return new URL(relativePath, 'file://' + process.cwd() + '/').pathname
        }

        const tuningModulePath = getModulePath('./src/server/utils/projectMartLargeRebuildTuning.ts')
        const {resolveProjectMartLargeRebuildHeartbeatConfig} = await import(tuningModulePath + '?heartbeat=' + Date.now())
        console.log(JSON.stringify({config: resolveProjectMartLargeRebuildHeartbeatConfig({
          activeLargeRebuildProjectCount: 1,
          envValues: {},
          storedSettings: {
            backgroundWriterDuckdbMemoryLimit: null,
            batchSize: null,
            maxCyclesPerWake: null,
            pollIntervalMs: null,
            tuningMode: 'automatic',
          },
          totalMemoryBytes: 64 * 1024 ** 3,
        })}))
      `,
    ],
    {cwd: process.cwd(), env: process.env},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString()
        || runScript.stdout.toString()
        || 'projectMartLargeRebuildHeartbeat automatic config test failed',
    )
  }

  const result = parseCallsResult(getLastJsonLine(runScript.stdout.toString()))

  expect(result.config).toMatchObject({
    automatic: {batchSize: 4096, maxCyclesPerWake: 16, pollIntervalMs: 250},
    batchSize: 4096,
    maxCyclesPerWake: 16,
    pollIntervalMs: 250,
    sources: {batchSize: 'automatic', maxCyclesPerWake: 'automatic', pollIntervalMs: 'automatic'},
  })
})
