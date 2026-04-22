import {existsSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {hostname} from 'node:os'

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
        await fetch(`http://127.0.0.1:${port}/api/runtime/ready`)
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

test('api role proxies API requests to DuckDB owner server', async () => {
  const ownerPort = 34991
  const apiPort = 34992
  const duckdbPath = `/tmp/f1-duckdb-api-proxy-${Date.now()}.duckdb`
  const ownerServer = startServer({
    API_SERVER_PORT: String(ownerPort),
    DUCKDB_PATH: duckdbPath,
    RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
    RUN_SERVER_FULL_TEXT_FETCHING: 'false',
    SERVER_ROLE: 'maintenance-worker',
    VITE_PORT: '4311',
  })
  const apiServer = startServer({
    API_SERVER_PORT: String(apiPort),
    DUCKDB_PATH: duckdbPath,
    RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
    RUN_SERVER_FULL_TEXT_FETCHING: 'false',
    SERVER_ROLE: 'api',
    SERVER_DUCKDB_OWNER_URL: `http://127.0.0.1:${ownerPort}`,
    VITE_PORT: '4312',
  })

  try {
    await waitForServer(ownerPort, 10_000)
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
    await stopServer(ownerServer)
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
  }
})

test('api role rejects self-proxy DuckDB owner URLs that point at the same port via a different local alias', async () => {
  const apiPort = 34990
  const duckdbPath = `/tmp/f1-api-self-proxy-${Date.now()}.duckdb`
  const apiServer = startServer({
    API_SERVER_PORT: String(apiPort),
    DUCKDB_PATH: duckdbPath,
    RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
    RUN_SERVER_FULL_TEXT_FETCHING: 'false',
    SERVER_ROLE: 'api',
    SERVER_DUCKDB_OWNER_URL: `http://0.0.0.0:${apiPort}`,
    VITE_PORT: '4310',
  })

  try {
    await waitForServer(apiPort, 10_000)

    const response = await fetch(`http://127.0.0.1:${apiPort}/api/duckdb_owner_connections`, {
      signal: AbortSignal.timeout(5_000),
    })
    const body = (await response.json()) as {error?: string}

    expect(response.ok).toBe(false)
    expect(body.error ?? '').toContain('DuckDB owner proxy target must not point to this same API server')
  } finally {
    await stopServer(apiServer)
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})

test('api role rejects self-proxy DuckDB owner URLs that use the machine hostname alias', async () => {
  const apiPort = 34989
  const duckdbPath = `/tmp/f1-api-self-proxy-hostname-${Date.now()}.duckdb`
  const machineHostname = hostname().trim()

  if (machineHostname === '') {
    return
  }

  const apiServer = startServer({
    API_SERVER_PORT: String(apiPort),
    DUCKDB_PATH: duckdbPath,
    RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
    RUN_SERVER_FULL_TEXT_FETCHING: 'false',
    SERVER_ROLE: 'api',
    SERVER_DUCKDB_OWNER_URL: `http://${machineHostname}:${apiPort}`,
    VITE_PORT: '4309',
  })

  try {
    await waitForServer(apiPort, 10_000)

    const response = await fetch(`http://127.0.0.1:${apiPort}/api/duckdb_owner_connections`, {
      signal: AbortSignal.timeout(5_000),
    })
    const body = (await response.json()) as {error?: string}

    expect(response.ok).toBe(false)
    expect(body.error ?? '').toContain('DuckDB owner proxy target must not point to this same API server')
  } finally {
    await stopServer(apiServer)
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})

test('DuckDB owner connections endpoint lists follower api processes', async () => {
  const ownerPort = 34993
  const apiPort = 34994
  const duckdbPath = `/tmp/f1-duckdb-owner-connections-${Date.now()}.duckdb`
  const ownerServer = startServer({
    API_SERVER_PORT: String(ownerPort),
    DUCKDB_PATH: duckdbPath,
    RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
    RUN_SERVER_FULL_TEXT_FETCHING: 'false',
    SERVER_ROLE: 'maintenance-worker',
    VITE_PORT: '4313',
  })
  const apiServer = startServer({
    API_SERVER_PORT: String(apiPort),
    DUCKDB_PATH: duckdbPath,
    RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
    RUN_SERVER_FULL_TEXT_FETCHING: 'false',
    SERVER_ROLE: 'api',
    SERVER_DUCKDB_OWNER_URL: `http://127.0.0.1:${ownerPort}`,
    VITE_PORT: '4314',
  })

  try {
    await waitForServer(ownerPort, 10_000)
    await waitForServer(apiPort, 10_000)

    const response = await fetch(`http://127.0.0.1:${apiPort}/api/duckdb_owner_connections`)
    const body = (await response.json()) as {
      data: {
        followers: Array<{
          apiServerPort: number
          lastHeartbeatAt: string | null
          lastRequestPath: string | null
          proxyCount: number
        }>
        owner: {apiServerPort: number}
      }
    }
    const follower = body.data.followers.find((row) => {
      return row.apiServerPort === apiPort
    })

    expect(response.ok).toBe(true)
    expect(body.data.owner.apiServerPort).toBe(ownerPort)
    expect(follower?.lastHeartbeatAt ?? null).not.toBe(null)
    expect(follower?.lastRequestPath ?? null).toBe('/api/duckdb_owner_connections')
    expect((follower?.proxyCount ?? 0) > 0).toBe(true)
  } finally {
    await stopServer(apiServer)
    await stopServer(ownerServer)
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
  }
})

test('api server without DuckDB owner reports owner proxy disabled warning', async () => {
  const apiPort = 34999
  const duckdbPath = `/tmp/f1-owner-proxy-disabled-${Date.now()}.duckdb`
  const apiServer = startServer({
    API_SERVER_PORT: String(apiPort),
    DUCKDB_PATH: duckdbPath,
    RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
    RUN_SERVER_FULL_TEXT_FETCHING: 'false',
    SERVER_ROLE: 'api',
    SERVER_DUCKDB_OWNER_URL: '',
    VITE_PORT: '4319',
  })

  try {
    await waitForServer(apiPort, 10_000)

    const response = await fetch(`http://127.0.0.1:${apiPort}/api/duckdb_owner_connections`)
    const body = (await response.json()) as {
      data: {warnings: Array<{kind: string; message: string}>; owner: null | {apiServerPort: number}}
    }

    expect(response.ok).toBe(true)
    expect(body.data.owner).toBe(null)
    expect(
      body.data.warnings.some((warning) => {
        return warning.kind === 'owner-proxy-disabled' && warning.message.includes('DuckDB owner proxying is disabled')
      }),
    ).toBe(true)
  } finally {
    await stopServer(apiServer)
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})

test('api server without DuckDB owner fails closed for unclassified product routes', async () => {
  const apiPort = 34998
  const duckdbPath = `/tmp/f1-owner-proxy-fail-closed-${Date.now()}.duckdb`
  const apiServer = startServer({
    API_SERVER_PORT: String(apiPort),
    DUCKDB_PATH: duckdbPath,
    RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
    RUN_SERVER_FULL_TEXT_FETCHING: 'false',
    SERVER_ROLE: 'api',
    SERVER_DUCKDB_OWNER_URL: '',
    VITE_PORT: '4318',
  })

  try {
    await waitForServer(apiPort, 10_000)

    const response = await fetch(`http://127.0.0.1:${apiPort}/api/users`)
    const body = (await response.json()) as {data: null; error: string}

    expect(response.status).toBe(502)
    expect(body.error).toContain('DuckDB owner proxy target unavailable')
  } finally {
    await stopServer(apiServer)
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})

test('auto role elects one DuckDB owner and follower takes over after owner exit', async () => {
  const firstPort = 34995
  const secondPort = 34996
  const duckdbPath = `/tmp/f1-auto-owner-${Date.now()}.duckdb`
  const firstServer = startServer({
    API_SERVER_PORT: String(firstPort),
    DUCKDB_PATH: duckdbPath,
    RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
    RUN_SERVER_FULL_TEXT_FETCHING: 'false',
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
      SERVER_ROLE: 'auto',
      VITE_PORT: '4316',
    })

    try {
      await waitForServer(secondPort, 10_000)

      const initialResponse = await fetch(`http://127.0.0.1:${secondPort}/api/duckdb_owner_connections`)
      const initialBody = (await initialResponse.json()) as {
        data: {history: Array<{apiServerPort: number; event: 'acquired' | 'released'}>; owner: {apiServerPort: number}}
      }

      expect(initialResponse.ok).toBe(true)
      expect(initialBody.data.owner.apiServerPort).toBe(firstPort)

      await stopServer(firstServer)

      await waitForCondition(async () => {
        const response = await fetch(`http://127.0.0.1:${secondPort}/api/duckdb_owner_connections`)
        const body = (await response.json()) as {
          data: {
            history: Array<{apiServerPort: number; event: 'acquired' | 'released'}>
            owner: {apiServerPort: number}
          }
        }

        return (
          response.ok
          && body.data.owner.apiServerPort === secondPort
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
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})

test('auto follower does not take over from a responsive owner with a stale heartbeat', async () => {
  const ownerPort = 34997
  const followerPort = 34998
  const duckdbPath = `/tmp/f1-auto-stale-heartbeat-${Date.now()}.duckdb`
  const leasePath = `${duckdbPath}.duckdb-owner.lock`
  const ownerServer = startServer({
    API_SERVER_PORT: String(ownerPort),
    DUCKDB_PATH: duckdbPath,
    RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
    RUN_SERVER_FULL_TEXT_FETCHING: 'false',
    SERVER_ROLE: 'maintenance-worker',
    VITE_PORT: '4317',
  })

  try {
    await waitForServer(ownerPort, 10_000)

    const snapshotResponse = await fetch(`http://127.0.0.1:${ownerPort}/__duckdb-owner-rpc/api/duckdbStudioSnapshots`, {
      method: 'POST',
    })
    const snapshotBody = (await snapshotResponse.json()) as {data: {snapshotPath: string}; error?: string}

    expect(snapshotResponse.ok).toBe(true)
    removeFileIfExists(snapshotBody.data.snapshotPath)
    removeFileIfExists(`${snapshotBody.data.snapshotPath}.wal`)

    const followerServer = startServer({
      API_SERVER_PORT: String(followerPort),
      DUCKDB_PATH: duckdbPath,
      RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
      RUN_SERVER_FULL_TEXT_FETCHING: 'false',
      SERVER_ROLE: 'auto',
      VITE_PORT: '4318',
    })

    try {
      await waitForServer(followerPort, 10_000)

      const lease = JSON.parse(readFileSync(leasePath, 'utf8')) as {heartbeatAt: string}

      lease.heartbeatAt = new Date(Date.now() - 120_000).toISOString()
      writeFileSync(leasePath, JSON.stringify(lease, null, 2))

      await new Promise((resolve) => {
        setTimeout(resolve, 300)
      })

      const response = await fetch(`http://127.0.0.1:${followerPort}/api/duckdb_owner_connections`)
      const body = (await response.json()) as {
        data: {history: Array<{apiServerPort: number; event: 'acquired' | 'released'}>; owner: {apiServerPort: number}}
      }

      expect(response.ok).toBe(true)
      expect(body.data.owner.apiServerPort).toBe(ownerPort)
      expect(
        body.data.history.some((event) => {
          return event.apiServerPort === followerPort && event.event === 'acquired'
        }),
      ).toBe(false)
    } finally {
      await stopServer(followerServer)
    }
  } finally {
    await stopServer(ownerServer)
    removeFileIfExists(duckdbPath)
    removeFileIfExists(leasePath)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})

test('auto role takes over a stale unreachable owner lease on startup', async () => {
  const serverPort = 34999
  const duckdbPath = `/tmp/f1-auto-stale-legacy-${Date.now()}.duckdb`
  const leasePath = `${duckdbPath}.duckdb-owner.lock`

  writeFileSync(
    leasePath,
    `${JSON.stringify(
      {
        acquiredAt: '2026-03-01T00:00:00.000Z',
        apiServerPort: serverPort,
        databasePath: duckdbPath,
        heartbeatAt: '2026-03-01T00:00:00.000Z',
        hostname: 'fredriks-mbp.ki.se',
        machineFingerprint: 'legacy-machine-fingerprint',
        leaseId: 'stale-legacy-lease-id',
        pid: 79362,
        serverRole: 'maintenance-worker',
      },
      null,
      2,
    )}\n`,
  )

  const server = startServer({
    API_SERVER_PORT: String(serverPort),
    DUCKDB_PATH: duckdbPath,
    RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
    RUN_SERVER_FULL_TEXT_FETCHING: 'false',
    SERVER_ROLE: 'auto',
    VITE_PORT: '4319',
  })

  try {
    await waitForServer(serverPort, 10_000)

    const response = await fetch(`http://127.0.0.1:${serverPort}/api/duckdb_owner_connections`)
    const body = (await response.json()) as {
      data: {history: Array<{apiServerPort: number; event: 'acquired' | 'released'}>; owner: {apiServerPort: number}}
    }

    expect(response.ok).toBe(true)
    expect(body.data.owner.apiServerPort).toBe(serverPort)
    expect(
      body.data.history.some((event) => {
        return event.apiServerPort === serverPort && event.event === 'acquired'
      }),
    ).toBe(true)
  } finally {
    await stopServer(server)
    removeFileIfExists(duckdbPath)
    removeFileIfExists(leasePath)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})
