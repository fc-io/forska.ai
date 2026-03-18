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

const waitForCondition = async (condition: () => Promise<boolean>, timeoutMs: number): Promise<void> => {
  const startedAt = Date.now()

  await new Promise<void>((resolve, reject) => {
    const check = async () => {
      try {
        const isReady = await condition()

        if (isReady) {
          resolve()
          return
        }
      } catch (error) {
        if (Date.now() - startedAt >= timeoutMs) {
          reject(error)
          return
        }
      }

      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error('Timed out waiting for condition'))
        return
      }

      setTimeout(() => {
        void check()
      }, 100)
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

test('writer connections endpoint lists follower api processes', async () => {
  const writerPort = 34993
  const apiPort = 34994
  const duckdbPath = `/tmp/f1-writer-connections-${Date.now()}.duckdb`
  const writerServer = startServer({
    API_SERVER_PORT: String(writerPort),
    DUCKDB_PATH: duckdbPath,
    RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
    RUN_SERVER_FULL_TEXT_FETCHING: 'false',
    RUN_SERVER_JUDGING: 'false',
    SERVER_ROLE: 'writer',
    VITE_PORT: '4313',
  })
  const apiServer = startServer({
    API_SERVER_PORT: String(apiPort),
    DUCKDB_PATH: duckdbPath,
    RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
    RUN_SERVER_FULL_TEXT_FETCHING: 'false',
    RUN_SERVER_JUDGING: 'false',
    SERVER_ROLE: 'api',
    SERVER_WRITER_URL: `http://127.0.0.1:${writerPort}`,
    VITE_PORT: '4314',
  })

  try {
    await waitForServer(writerPort, 10_000)
    await waitForServer(apiPort, 10_000)

    const response = await fetch(`http://127.0.0.1:${apiPort}/api/writer_connections`)
    const body = (await response.json()) as {
      data: {
        followers: Array<{
          apiServerPort: number
          lastHeartbeatAt: string | null
          lastRequestPath: string | null
          proxyCount: number
        }>
        writer: {apiServerPort: number}
      }
    }
    const follower = body.data.followers.find((row) => {
      return row.apiServerPort === apiPort
    })

    expect(response.ok).toBe(true)
    expect(body.data.writer.apiServerPort).toBe(writerPort)
    expect(follower?.lastHeartbeatAt ?? null).not.toBe(null)
    expect(follower?.lastRequestPath ?? null).toBe('/api/writer_connections')
    expect((follower?.proxyCount ?? 0) > 0).toBe(true)
  } finally {
    await stopServer(apiServer)
    await stopServer(writerServer)
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.writer.lock`)
  }
})

test('auto role elects one writer and follower takes over after writer exit', async () => {
  const firstPort = 34995
  const secondPort = 34996
  const duckdbPath = `/tmp/f1-auto-writer-${Date.now()}.duckdb`
  const firstServer = startServer({
    API_SERVER_PORT: String(firstPort),
    DUCKDB_PATH: duckdbPath,
    RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
    RUN_SERVER_FULL_TEXT_FETCHING: 'false',
    RUN_SERVER_JUDGING: 'false',
    SERVER_ROLE: 'auto',
    VITE_PORT: '4315',
  })

  try {
    await waitForServer(firstPort, 10_000)

    const secondServer = startServer({
      API_SERVER_PORT: String(secondPort),
      DUCKDB_PATH: duckdbPath,
      RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
      RUN_SERVER_FULL_TEXT_FETCHING: 'false',
      RUN_SERVER_JUDGING: 'false',
      SERVER_ROLE: 'auto',
      VITE_PORT: '4316',
    })

    try {
      await waitForServer(secondPort, 10_000)

      const initialResponse = await fetch(`http://127.0.0.1:${secondPort}/api/writer_connections`)
      const initialBody = (await initialResponse.json()) as {
        data: {history: Array<{apiServerPort: number; event: 'acquired' | 'released'}>; writer: {apiServerPort: number}}
      }

      expect(initialResponse.ok).toBe(true)
      expect(initialBody.data.writer.apiServerPort).toBe(firstPort)

      await stopServer(firstServer)

      await waitForCondition(async () => {
        const response = await fetch(`http://127.0.0.1:${secondPort}/api/writer_connections`)
        const body = (await response.json()) as {
          data: {
            history: Array<{apiServerPort: number; event: 'acquired' | 'released'}>
            writer: {apiServerPort: number}
          }
        }

        return (
          response.ok
          && body.data.writer.apiServerPort === secondPort
          && body.data.history.some((event) => {
            return event.apiServerPort === firstPort && event.event === 'acquired'
          })
          && body.data.history.some((event) => {
            return event.apiServerPort === secondPort && event.event === 'acquired'
          })
        )
      }, 15_000)
    } finally {
      await stopServer(secondServer)
    }
  } finally {
    if (firstServer.exitCode === null) {
      await stopServer(firstServer)
    }

    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.writer.lock`)
    removeFileIfExists(`${duckdbPath}.writer.history.json`)
  }
})
