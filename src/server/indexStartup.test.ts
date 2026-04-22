import {existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {hostname} from 'node:os'
import {join} from 'node:path'

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

const readPipeText = async (pipe: ReadableStream<Uint8Array> | null) => {
  return pipe === null ? '' : await new Response(pipe).text()
}

const getStartupTestDirectory = () => {
  const startupTestRoot = join(process.cwd(), 'data', 'runtime')
  mkdirSync(startupTestRoot, {recursive: true})

  return mkdtempSync(join(startupTestRoot, 'index-startup-'))
}

const expectServerStartupFailure = async ({
  envValues,
  expectedMessage,
  port,
}: {
  envValues: Record<string, string>
  expectedMessage: string
  port: number
}) => {
  const server = startServer(envValues)
  const result = await Promise.race([
    server.exited.then((exitCode) => {
      return {exitCode, status: 'exited' as const}
    }),
    waitForServer(port, 2_000)
      .then(() => {
        return {exitCode: null, status: 'started' as const}
      })
      .catch(() => {
        return {exitCode: null, status: 'timeout' as const}
      }),
  ])

  if (result.status !== 'exited') {
    await stopServer(server)
    throw new Error(`Expected startup failure, but server ${result.status} on port ${port}`)
  }

  const stderr = await readPipeText(server.stderr)
  const stdout = await readPipeText(server.stdout)

  expect(result.exitCode).not.toBe(0)
  expect(`${stdout}\n${stderr}`).toContain(expectedMessage)
}

const runStartupCommand = (args: string[], envValues: Record<string, string>, failureMessage: string) => {
  const result = globalThis.Bun.spawnSync(args, {
    cwd: process.cwd(),
    env: {...process.env, ...envValues},
    stdout: 'pipe',
    stderr: 'pipe',
  })

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || result.stdout.toString() || failureMessage)
  }
}

const getJudgeWorkerStartupEnv = ({
  apiPort,
  duckdbPath,
  journalPath = '',
  workerId,
}: {
  apiPort: number
  duckdbPath: string
  journalPath?: string
  workerId: string
}) => {
  return {
    API_SERVER_PORT: String(apiPort),
    DUCKDB_PATH: duckdbPath,
    JUDGE_WORKER_ID: workerId,
    JUDGE_WORKER_JOURNAL_PATH: journalPath,
    RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
    RUN_SERVER_FULL_TEXT_FETCHING: 'false',
    SERVER_DUCKDB_OWNER_URL: '',
    SERVER_ROLE: 'judge-worker',
    VITE_PORT: '4311',
  }
}

test('judge-worker startup refuses a missing durable journal identity', async () => {
  const testDirectory = getStartupTestDirectory()
  const apiPort = 34991

  try {
    await expectServerStartupFailure({
      envValues: getJudgeWorkerStartupEnv({apiPort, duckdbPath: join(testDirectory, 'forska.duckdb'), workerId: ''}),
      expectedMessage: 'JUDGE_WORKER_ID is required',
      port: apiPort,
    })
  } finally {
    rmSync(testDirectory, {force: true, recursive: true})
  }
})

test('judge-worker startup refuses an unstable journal worker id', async () => {
  const testDirectory = getStartupTestDirectory()
  const apiPort = 34992

  try {
    await expectServerStartupFailure({
      envValues: getJudgeWorkerStartupEnv({
        apiPort,
        duckdbPath: join(testDirectory, 'forska.duckdb'),
        workerId: `worker-${process.pid}/runtime`,
      }),
      expectedMessage: 'JUDGE_WORKER_ID must be a stable filesystem-safe id',
      port: apiPort,
    })
  } finally {
    rmSync(testDirectory, {force: true, recursive: true})
  }
})

test('judge-worker startup refuses a non-durable explicit journal path', async () => {
  const testDirectory = getStartupTestDirectory()
  const apiPort = 34993

  try {
    await expectServerStartupFailure({
      envValues: getJudgeWorkerStartupEnv({
        apiPort,
        duckdbPath: join(testDirectory, 'forska.duckdb'),
        journalPath: `/tmp/forska-judge-worker-${Date.now()}.sqlite`,
        workerId: 'startup-nondurable-worker',
      }),
      expectedMessage: 'JUDGE_WORKER_JOURNAL_PATH must be on durable app-data storage',
      port: apiPort,
    })
  } finally {
    rmSync(testDirectory, {force: true, recursive: true})
  }
})

test('judge-worker startup refuses an unwritable journal target', async () => {
  const testDirectory = getStartupTestDirectory()
  const apiPort = 34994
  const notDirectoryPath = join(testDirectory, 'not-directory')

  writeFileSync(notDirectoryPath, 'not a directory', 'utf8')

  try {
    await expectServerStartupFailure({
      envValues: getJudgeWorkerStartupEnv({
        apiPort,
        duckdbPath: join(testDirectory, 'forska.duckdb'),
        journalPath: join(notDirectoryPath, 'journal.sqlite'),
        workerId: 'startup-unwritable-worker',
      }),
      expectedMessage: 'Judge-worker journal directory is missing or not a directory',
      port: apiPort,
    })
  } finally {
    rmSync(testDirectory, {force: true, recursive: true})
  }
})

test('judge-worker startup refuses a journal target held by another live worker', async () => {
  const testDirectory = getStartupTestDirectory()
  const apiPort = 34995
  const now = new Date().toISOString()
  const journalPath = join(testDirectory, 'journal.sqlite')

  writeFileSync(journalPath, '', 'utf8')
  writeFileSync(
    `${journalPath}.lock`,
    `${JSON.stringify(
      {
        acquiredAt: now,
        hostname: hostname(),
        journalPath,
        leaseId: 'live-worker-lease',
        pid: process.pid,
        workerId: 'startup-collision-worker',
      },
      null,
      2,
    )}\n`,
    'utf8',
  )

  try {
    await expectServerStartupFailure({
      envValues: getJudgeWorkerStartupEnv({
        apiPort,
        duckdbPath: join(testDirectory, 'forska.duckdb'),
        journalPath,
        workerId: 'startup-collision-worker',
      }),
      expectedMessage: 'collides with another live worker',
      port: apiPort,
    })
  } finally {
    rmSync(testDirectory, {force: true, recursive: true})
  }
})

test('maintenance-worker startup migrates DuckDB before judgment health queries run', async () => {
  const apiPort = 34988
  const duckdbPath = `/tmp/f1-index-startup-${Date.now()}.duckdb`
  const server = startServer({
    API_SERVER_PORT: String(apiPort),
    DUCKDB_PATH: duckdbPath,
    RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
    RUN_SERVER_FULL_TEXT_FETCHING: 'false',
    SERVER_ROLE: 'maintenance-worker',
    VITE_PORT: '4308',
  })

  try {
    await waitForServer(apiPort, 10_000)

    const response = await fetch(`http://127.0.0.1:${apiPort}/__duckdb-owner-rpc/api/judgmentsjobs-health`, {
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
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
  }
})

test('maintenance-worker startup migrates pre-cutover user config naming', async () => {
  const apiPort = 34990
  const duckdbPath = `/tmp/f1-index-startup-user-config-cutover-${Date.now()}.duckdb`
  const envValues = {
    API_SERVER_PORT: String(apiPort),
    DUCKDB_PATH: duckdbPath,
    RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
    RUN_SERVER_FULL_TEXT_FETCHING: 'false',
    SERVER_ROLE: 'maintenance-worker',
    VITE_PORT: '4310',
  }

  runStartupCommand(['bun', 'src/db/migrateDuckdb.ts'], envValues, 'Failed to prepare migrated DuckDB test database')
  runStartupCommand(
    [
      'duckdb',
      duckdbPath,
      `
        SET memory_limit = '20GB';
        ALTER TABLE app.user_config RENAME COLUMN maintenance_worker_duckdb_memory_limit TO background_writer_duckdb_memory_limit;
        DELETE FROM app_schema_migration WHERE name = '0044_maintenanceWorkerUserConfigNaming.sql';
        INSERT INTO app.user_config (
          id,
          name,
          email,
          role,
          background_writer_duckdb_memory_limit,
          project_mart_large_rebuild_tuning_mode
        )
        VALUES ('local-user', 'Local User', 'local@example.com', NULL, '12GB', 'automatic');
      `,
    ],
    envValues,
    'Failed to prepare pre-cutover user config test database',
  )

  const server = startServer(envValues)

  try {
    await waitForServer(apiPort, 10_000)

    const response = await fetch(`http://127.0.0.1:${apiPort}/__duckdb-owner-rpc/api/users`, {
      signal: AbortSignal.timeout(5_000),
    })
    const body = (await response.json()) as {
      data: Array<{backgroundWriterDuckdbMemoryLimit?: string; maintenanceWorkerDuckdbMemoryLimit?: string}>
    }
    const [user] = body.data

    expect(response.ok).toBe(true)
    expect(user?.maintenanceWorkerDuckdbMemoryLimit).toBe('12GB')
    expect(user?.backgroundWriterDuckdbMemoryLimit).toBeUndefined()
  } finally {
    await stopServer(server)
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
  }
})

test('maintenance-worker startup tolerates malformed DuckDB lease metadata files', async () => {
  const apiPort = 34989
  const duckdbPath = `/tmp/f1-index-startup-malformed-lease-${Date.now()}.duckdb`

  writeFileSync(`${duckdbPath}.duckdb-owner.lock`, '')
  writeFileSync(`${duckdbPath}.duckdb-owner.history.json`, '[{"event":"acquired"')

  const server = startServer({
    API_SERVER_PORT: String(apiPort),
    DUCKDB_PATH: duckdbPath,
    RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
    RUN_SERVER_FULL_TEXT_FETCHING: 'false',
    SERVER_ROLE: 'maintenance-worker',
    VITE_PORT: '4309',
  })

  try {
    await waitForServer(apiPort, 10_000)

    const response = await fetch(`http://127.0.0.1:${apiPort}/__duckdb-owner-rpc/api/judgmentsjobs-health`, {
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
    expect(existsSync(`${duckdbPath}.duckdb-owner.lock`)).toBe(true)
    expect(existsSync(`${duckdbPath}.duckdb-owner.history.json`)).toBe(true)
  } finally {
    await stopServer(server)
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
  }
})

test('api startup refuses a reachable pre-cutover DuckDB owner peer', async () => {
  const apiPort = 34987
  const duckdbPath = `/tmp/f1-index-startup-cutover-peer-${Date.now()}.duckdb`
  const preCutoverOwner = globalThis.Bun.serve({
    port: 0,
    fetch: () => {
      return Response.json({data: {owner: {apiServerPort: 34986}}})
    },
  })

  try {
    await expectServerStartupFailure({
      envValues: {
        API_SERVER_PORT: String(apiPort),
        DUCKDB_PATH: duckdbPath,
        RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
        RUN_SERVER_FULL_TEXT_FETCHING: 'false',
        SERVER_DUCKDB_OWNER_URL: `http://127.0.0.1:${preCutoverOwner.port}`,
        SERVER_ROLE: 'api',
        VITE_PORT: '4307',
      },
      expectedMessage: 'Incompatible Forska split runtime version',
      port: apiPort,
    })
  } finally {
    await preCutoverOwner.stop(true)
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
  }
})

test('api startup refuses ownerless routes without a file-backed ownerless-readable backend', async () => {
  const apiPort = 34985

  await expectServerStartupFailure({
    envValues: {
      API_SERVER_PORT: String(apiPort),
      DUCKDB_PATH: ':memory:',
      RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
      RUN_SERVER_FULL_TEXT_FETCHING: 'false',
      SERVER_DUCKDB_OWNER_URL: '',
      SERVER_ROLE: 'api',
      VITE_PORT: '4305',
    },
    expectedMessage: 'ownerless control-state backend requires file-backed DUCKDB_PATH',
    port: apiPort,
  })
})

test('maintenance-worker startup refuses a fresh pre-cutover legacy writer lease', async () => {
  const apiPort = 34986
  const duckdbPath = `/tmp/f1-index-startup-legacy-writer-cutover-${Date.now()}.duckdb`
  const now = new Date().toISOString()

  writeFileSync(
    `${duckdbPath}.writer.lock`,
    `${JSON.stringify(
      {
        acquiredAt: now,
        apiServerPort: 3999,
        databasePath: duckdbPath,
        heartbeatAt: now,
        hostname: hostname(),
        leaseId: 'fresh-pre-cutover-writer-lease',
        pid: 999_999,
        serverRole: 'maintenance-worker',
      },
      null,
      2,
    )}\n`,
  )

  try {
    await expectServerStartupFailure({
      envValues: {
        API_SERVER_PORT: String(apiPort),
        DUCKDB_PATH: duckdbPath,
        RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
        RUN_SERVER_FULL_TEXT_FETCHING: 'false',
        SERVER_DUCKDB_OWNER_URL: '',
        SERVER_ROLE: 'maintenance-worker',
        VITE_PORT: '4306',
      },
      expectedMessage: 'Incompatible Forska split runtime version',
      port: apiPort,
    })
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
    removeFileIfExists(`${duckdbPath}.writer.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
  }
})
