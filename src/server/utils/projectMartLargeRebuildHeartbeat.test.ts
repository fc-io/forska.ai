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

const parseCallsResult = (value: string): {calls: Array<{batchSize: number; workerId: string}>} => {
  return JSON.parse(value) as {calls: Array<{batchSize: number; workerId: string}>}
}

test('projectMartLargeRebuildHeartbeat runs one background cycle with portable default batch size', () => {
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
        const runnerModulePath = getModulePath('./src/server/services/projectMartLargeRebuildRunner.ts')
        const serverRuntimeRoleModulePath = getModulePath('./src/server/utils/serverRuntimeRole.ts')
        const calls = []

        void mock.module(runnerModulePath, () => {
          return {
            runProjectMartLargeRebuildCycle: async (options) => {
              calls.push(options)
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
  expect(result.calls[0]?.workerId).toContain('project-mart-large-rebuild-heartbeat:')
})
