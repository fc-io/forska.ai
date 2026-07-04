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

test('review serving projector worker heartbeat logs original loop failure and restarts', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const getModulePath = (relativePath) => {
          return new URL(relativePath, 'file://' + process.cwd() + '/').pathname
        }

        const heartbeatModulePath = getModulePath('./src/server/utils/reviewServingProjectorWorkerHeartbeat.ts')
        const workerModulePath = getModulePath('./src/server/workers/reviewServingProjectorWorker.ts')
        const runtimeRoleModulePath = getModulePath('./src/server/utils/serverRuntimeRole.ts')
        const events = []

        void mock.module(runtimeRoleModulePath, () => {
          return {
            registerDuckdbOwnerDemotionHandler: () => {},
            shouldCurrentServerRunMaintenanceLoops: () => true,
          }
        })

        void mock.module(workerModulePath, () => {
          return {
            runReviewServingProjectorWorker: async (options) => {
              events.push([
                'run',
                events.length,
                options.rebuildChunkBatchSize,
                options.rebuildChunkBatchMaxRssBytes,
              ])

              if (events.length === 1) {
                throw new Error('projector loop failed')
              }

              await new Promise((resolve) => {
                options.signal.addEventListener('abort', () => {
                  events.push(['abort'])
                  resolve()
                })
              })
            },
          }
        })

        const {startReviewServingProjectorWorkerHeartbeat} = await import(heartbeatModulePath + '?restart=' + Date.now())
        const stop = startReviewServingProjectorWorkerHeartbeat({
          pollIntervalMs: 1,
          rebuildChunkBatchMaxRssBytes: 100,
          rebuildChunkBatchSize: 3,
        })

        await new Promise((resolve) => {
          setTimeout(resolve, 25)
        })
        stop()
        await new Promise((resolve) => {
          setTimeout(resolve, 5)
        })

        console.log(JSON.stringify({events}))
      `,
    ],
    {cwd: process.cwd(), env: {...process.env}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString()
        || runScript.stdout.toString()
        || 'Review serving projector worker heartbeat logging test failed',
    )
  }

  const output = `${runScript.stdout.toString()}\n${runScript.stderr.toString()}`
  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {events: Array<Array<number | string>>}

  expect(result.events).toEqual([['run', 0, 3, 100], ['run', 1, 3, 100], ['abort']])
  expect(output).toContain('projector loop failed')
  expect(output).not.toContain('An unknown error occurred in Effect.tryPromise')
})
