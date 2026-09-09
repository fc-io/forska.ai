import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import {join, resolve} from 'node:path'

import {expect, test} from 'bun:test'

import {closePlaywrightApiServerRuntime} from './startPlaywrightApiServer.ts'
import {createScriptTestDirectory} from './testUtils/createScriptTestDirectory.ts'

const isProcessAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const waitUntil = async (predicate: () => boolean, timeoutMs: number, message: string) => {
  const deadline = Date.now() + timeoutMs

  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(message)
    }

    await Bun.sleep(100)
  }
}

const getAvailableLocalPort = async () => {
  const server = Bun.serve({
    fetch: () => {
      return new Response('ok')
    },
    hostname: '127.0.0.1',
    port: 0,
  })

  const port = server.port
  await server.stop(true)
  return port
}

test('parent-loss shutdown releases the DuckDB owner lease without forcing a checkpoint', async () => {
  const calls: Array<{checkpointBeforeClose?: boolean}> = []

  await closePlaywrightApiServerRuntime(async (options) => {
    calls.push(options ?? {})
  })

  expect(calls).toEqual([{checkpointBeforeClose: false}])
})

test(
  'Playwright API server releases the DuckDB owner lease when its parent exits',
  async () => {
    const fixture = createScriptTestDirectory('playwright-api-parent-exit')
    const runtimeDirectory = join(fixture.path, 'runtime')
    const duckdbPath = join(runtimeDirectory, 'forska.duckdb')
    const lockPath = `${duckdbPath}.duckdb-owner.lock`
    const childPidPath = join(fixture.path, 'child-pid.txt')
    const parentScriptPath = join(fixture.path, 'parent.mjs')
    const apiPort = await getAvailableLocalPort()
    const appPort = await getAvailableLocalPort()
    let childPid: number | null = null

    mkdirSync(runtimeDirectory, {recursive: true})
    writeFileSync(
      parentScriptPath,
      `
const {existsSync, writeFileSync} = await import('node:fs')

const child = Bun.spawn(['bun', 'scripts/startPlaywrightApiServer.ts'], {
  cwd: ${JSON.stringify(resolve('.'))},
  env: {
    ...process.env,
    API_SERVER_PORT: ${JSON.stringify(String(apiPort))},
    APP_SERVER_DIST_DIR: ${JSON.stringify(join(fixture.path, 'app-dist'))},
    APP_SERVER_PORT: ${JSON.stringify(String(appPort))},
    DUCKDB_PATH: ${JSON.stringify(duckdbPath)},
    DUCKDB_TEMP_DIRECTORY: ${JSON.stringify(join(fixture.path, 'duckdb-temp'))},
    FORSKA_DISABLE_SERVER_MUTATIONS: 'true',
    FORSKA_PLAYWRIGHT_RESET_DUCKDB: 'true',
    LOG_DIR: ${JSON.stringify(join(fixture.path, 'logs'))},
    RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
    RUN_SERVER_FULL_TEXT_FETCHING: 'false',
    SERVER_DUCKDB_OWNER_URL: '',
    SERVER_ROLE: 'dev-single',
    VITE_PORT: ${JSON.stringify(String(appPort))},
    VITE_SERVER_API: ${JSON.stringify(`http://127.0.0.1:${appPort}`)},
  },
  stderr: 'ignore',
  stdin: 'ignore',
  stdout: 'ignore',
})

writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid ?? ''))

const deadline = Date.now() + 90_000
while (true) {
  try {
    await fetch(${JSON.stringify(`http://127.0.0.1:${apiPort}/api/projects`)})
    break
  } catch {
    if (Date.now() >= deadline) {
      process.exit(2)
    }
    await Bun.sleep(100)
  }
}

while (!existsSync(${JSON.stringify(lockPath)})) {
  if (Date.now() >= deadline) {
    process.exit(2)
  }
  await Bun.sleep(100)
}

await Bun.sleep(250)
process.exit(0)
`,
    )

    try {
      const parent = Bun.spawn(['bun', parentScriptPath], {
        cwd: resolve('.'),
        stderr: 'inherit',
        stdin: 'ignore',
        stdout: 'inherit',
      })

      expect(await parent.exited).toBe(0)
      childPid = Number(readFileSync(childPidPath, 'utf8'))
      expect(Number.isInteger(childPid)).toBe(true)
      expect(childPid).toBeGreaterThan(0)

      await waitUntil(
        () => {
          return !isProcessAlive(childPid as number)
        },
        30_000,
        `Timed out waiting for Playwright API server pid=${childPid} to exit after parent loss`,
      )

      expect(existsSync(lockPath)).toBe(false)
    } finally {
      if (childPid !== null && isProcessAlive(childPid)) {
        process.kill(childPid, 'SIGTERM')
      }

      fixture.cleanup()
    }
  },
  120_000,
)
