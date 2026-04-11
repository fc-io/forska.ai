import {existsSync, rmSync, writeFileSync} from 'node:fs'

import {expect, test} from 'bun:test'

type SpawnedServer = ReturnType<typeof globalThis.Bun.spawn>

const removeFileIfExists = (filePath: string) => {
  if (existsSync(filePath)) {
    rmSync(filePath, {force: true})
  }
}

const waitForServer = async (port: number, timeoutMs: number): Promise<void> => {
  const startedAt = Date.now()

  await new Promise<void>((resolve, reject) => {
    const check = async () => {
      try {
        await fetch(`http://127.0.0.1:${port}/__healthcheck__`)
        resolve()
      } catch (error) {
        if (Date.now() - startedAt >= timeoutMs) {
          reject(error)
          return
        }

        setTimeout(() => {
          void check()
        }, 50)
      }
    }

    void check()
  })
}

const stopServer = async (server: SpawnedServer) => {
  server.kill('SIGTERM')
  await server.exited
}

const startServer = (envValues: Record<string, string>) => {
  return globalThis.Bun.spawn(['bun', 'run', 'src/server/index.ts'], {
    cwd: process.cwd(),
    env: {...process.env, ...envValues},
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

test('writer startup migrates DuckDB before judgment health queries run', async () => {
  const apiPort = 34988
  const duckdbPath = `/tmp/f1-index-startup-${Date.now()}.duckdb`
  const server = startServer({
    API_SERVER_PORT: String(apiPort),
    DUCKDB_PATH: duckdbPath,
    RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
    RUN_SERVER_FULL_TEXT_FETCHING: 'false',
    SERVER_ROLE: 'writer',
    VITE_PORT: '4308',
  })

  try {
    await waitForServer(apiPort, 10_000)

    const response = await fetch(`http://127.0.0.1:${apiPort}/api/judgmentsjobs-health`, {
      signal: AbortSignal.timeout(5_000),
    })
    const body = (await response.json()) as {
      data: {
        draining: number
        healthy: number
        offlineRepairRequired: number
        quarantined: number
        retainedOutbox: number
        staleImport: number
      }
      error: string | null
    }

    expect(response.ok).toBe(true)
    expect(body.error).toBe(null)
    expect(body.data).toEqual({
      draining: 0,
      healthy: 0,
      offlineRepairRequired: 0,
      quarantined: 0,
      retainedOutbox: 0,
      staleImport: 0,
    })
  } finally {
    await stopServer(server)
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
    removeFileIfExists(`${duckdbPath}.writer.history.json`)
    removeFileIfExists(`${duckdbPath}.writer.lock`)
  }
})

test('writer startup tolerates malformed DuckDB lease metadata files', async () => {
  const apiPort = 34989
  const duckdbPath = `/tmp/f1-index-startup-malformed-lease-${Date.now()}.duckdb`

  writeFileSync(`${duckdbPath}.writer.lock`, '')
  writeFileSync(`${duckdbPath}.writer.history.json`, '[{"event":"acquired"')

  const server = startServer({
    API_SERVER_PORT: String(apiPort),
    DUCKDB_PATH: duckdbPath,
    RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
    RUN_SERVER_FULL_TEXT_FETCHING: 'false',
    SERVER_ROLE: 'writer',
    VITE_PORT: '4309',
  })

  try {
    await waitForServer(apiPort, 10_000)

    const response = await fetch(`http://127.0.0.1:${apiPort}/api/judgmentsjobs-health`, {
      signal: AbortSignal.timeout(5_000),
    })
    const body = (await response.json()) as {
      data: {
        draining: number
        healthy: number
        offlineRepairRequired: number
        quarantined: number
        retainedOutbox: number
        staleImport: number
      }
      error: string | null
    }

    expect(response.ok).toBe(true)
    expect(body.error).toBe(null)
    expect(existsSync(`${duckdbPath}.writer.lock`)).toBe(true)
    expect(existsSync(`${duckdbPath}.writer.history.json`)).toBe(true)
  } finally {
    await stopServer(server)
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
    removeFileIfExists(`${duckdbPath}.writer.history.json`)
    removeFileIfExists(`${duckdbPath}.writer.lock`)
  }
})
