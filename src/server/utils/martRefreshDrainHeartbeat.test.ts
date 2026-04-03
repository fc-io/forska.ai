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

test('startMartRefreshDrainHeartbeat is inert and returns a stop function', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const getModulePath = (relativePath) => {
          return new URL(relativePath, 'file://' + process.cwd() + '/').pathname
        }

        const martRefreshDrainHeartbeatModulePath = getModulePath('./src/server/utils/martRefreshDrainHeartbeat.ts')
        const {startMartRefreshDrainHeartbeat} = await import(martRefreshDrainHeartbeatModulePath + '?inert=' + Date.now())
        const stop = startMartRefreshDrainHeartbeat({intervalMs: 10})

        try {
          await new Promise((resolve) => {
            setTimeout(resolve, 25)
          })
          console.log(JSON.stringify({stopType: typeof stop}))
        } finally {
          stop()
        }
      `,
    ],
    {cwd: process.cwd(), env: {...process.env}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString() || runScript.stdout.toString() || 'Mart refresh heartbeat inert test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {stopType: string}

  expect(result.stopType).toBe('function')
})
