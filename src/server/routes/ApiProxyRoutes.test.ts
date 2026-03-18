import {existsSync, rmSync} from 'node:fs'

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

test('api role proxies API requests to writer server', async () => {
  const writerPort = 34991
  const apiPort = 34992
  const duckdbPath = `/tmp/f1-duckdb-api-proxy-${Date.now()}.duckdb`
  const writerServer = startServer({
    API_SERVER_PORT: String(writerPort),
    DUCKDB_PATH: duckdbPath,
    RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
    RUN_SERVER_FULL_TEXT_FETCHING: 'false',
    RUN_SERVER_JUDGING: 'false',
    SERVER_ROLE: 'writer',
    VITE_PORT: '4311',
  })
  const apiServer = startServer({
    API_SERVER_PORT: String(apiPort),
    DUCKDB_PATH: duckdbPath,
    RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
    RUN_SERVER_FULL_TEXT_FETCHING: 'false',
    RUN_SERVER_JUDGING: 'false',
    SERVER_ROLE: 'api',
    SERVER_WRITER_URL: `http://127.0.0.1:${writerPort}`,
    VITE_PORT: '4312',
  })

  try {
    await waitForServer(writerPort, 10_000)
    await waitForServer(apiPort, 10_000)

    const response = await fetch(`http://127.0.0.1:${apiPort}/api/duckdbStudioSnapshots`, {method: 'POST'})
    const body = (await response.json()) as {data: {snapshotPath: string; createdAt: string}; error?: string}

    expect(response.ok).toBe(true)
    expect(body.error ?? null).toBe(null)
    expect(body.data.createdAt).toContain('T')
    expect(existsSync(body.data.snapshotPath)).toBe(true)

    removeFileIfExists(body.data.snapshotPath)
    removeFileIfExists(`${body.data.snapshotPath}.wal`)
  } finally {
    await stopServer(apiServer)
    await stopServer(writerServer)
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.writer.lock`)
  }
})
