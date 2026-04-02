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
        const {startMartRefreshDrainHeartbeat} = await import(martRefreshDrainHeartbeatModulePath + '?writer=' + Date.now())
        const stop = startMartRefreshDrainHeartbeat({intervalMs: 50})

        try {
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
      runScript.stderr.toString() || runScript.stdout.toString() || 'Mart refresh heartbeat writer test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {stopType: string}

  expect(result.stopType).toBe('function')
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
        const {startMartRefreshDrainHeartbeat} = await import(martRefreshDrainHeartbeatModulePath + '?promotion=' + Date.now())
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
      runScript.stderr.toString() || runScript.stdout.toString() || 'Mart refresh heartbeat promotion test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {stopType: string}

  expect(result.stopType).toBe('function')
})
