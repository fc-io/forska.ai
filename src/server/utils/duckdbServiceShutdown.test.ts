import {existsSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {DuckDBInstance} from '@duckdb/node-api'
import {expect, setDefaultTimeout, test} from 'bun:test'
import {Effect} from 'effect'

import {releaseStoppedServerLocks} from '../../../scripts/releaseStoppedServerLocks.ts'

setDefaultTimeout(60_000)

const removeFileIfExists = (filePath: string) => {
  if (existsSync(filePath)) {
    rmSync(filePath, {force: true, recursive: true})
  }
}

const removeDuckdbFiles = (duckdbPath: string) => {
  ;[
    duckdbPath,
    `${duckdbPath}.wal`,
    `${duckdbPath}.duckdb-owner.lock`,
    `${duckdbPath}.duckdb-owner.history.json`,
    `${duckdbPath}.startup-recovery`,
  ].map(removeFileIfExists)
}

const waitForTimeout = (timeoutMs: number) => {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, timeoutMs)
  })
}

const waitForProcessExit = async (childProcess: ReturnType<typeof globalThis.Bun.spawn>, timeoutMs: number) => {
  return Promise.race([
    childProcess.exited.then(() => {
      return true
    }),
    waitForTimeout(timeoutMs).then(() => {
      return false
    }),
  ])
}

const terminateCurrentProcessSource =
  process.platform === 'win32' ? "process.emit('SIGTERM')" : "process.kill(process.pid, 'SIGTERM')"

const signalCurrentProcessFunctionSource =
  process.platform === 'win32'
    ? 'const signalCurrentProcess = (signal) => { process.emit(signal) }'
    : 'const signalCurrentProcess = (signal) => { process.kill(process.pid, signal) }'

type ShutdownChildResult = {
  duckdbPath: string
  exitCode: number | null
  exited: boolean
  stderr: string
  stdout: string
}

const runDuckdbShutdownChild = async ({
  env = {},
  name,
  source,
  timeoutMs = 30_000,
}: {
  env?: Record<string, string>
  name: string
  source: string
  timeoutMs?: number
}): Promise<ShutdownChildResult> => {
  const duckdbPath = join(tmpdir(), `f1-duckdb-graceful-${name}-${Date.now()}.duckdb`)
  const childProcess = globalThis.Bun.spawn(['bun', '-e', `${signalCurrentProcessFunctionSource}\n${source}`], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DUCKDB_MEMORY_LIMIT: '20GB',
      DUCKDB_PATH: duckdbPath,
      SERVER_ROLE: 'maintenance-worker',
      ...env,
    },
    stderr: 'pipe',
    stdout: 'pipe',
  })

  try {
    const exited = await waitForProcessExit(childProcess, timeoutMs)
    const [stdout, stderr] = await Promise.all([
      new Response(childProcess.stdout).text(),
      new Response(childProcess.stderr).text(),
    ])

    return {duckdbPath, exitCode: childProcess.exitCode, exited, stderr, stdout}
  } finally {
    if (childProcess.exitCode === null) {
      childProcess.kill('SIGKILL')
      await childProcess.exited
    }
  }
}

const readDuckdbRowsAfterShutdown = async <T>(duckdbPath: string, statement: string) => {
  const duckdbInstance = await DuckDBInstance.create(duckdbPath, {access_mode: 'READ_ONLY'})
  const connection = await duckdbInstance.connect()

  try {
    const reader = await connection.runAndReadAll(statement)
    return reader.getRowObjectsJson() as T[]
  } finally {
    connection.closeSync()
    duckdbInstance.closeSync()
  }
}

const expectCleanGracefulExit = (result: ShutdownChildResult) => {
  expect({exitCode: result.exitCode, exited: result.exited, stderr: result.stderr}).toMatchObject({
    exitCode: 0,
    exited: true,
  })
  expect(result.stdout).toContain('[duckdb] shutdown checkpoint completed')
  expect(result.stdout).toContain('wal_bytes=0')
  expect(result.stdout).not.toContain('still alive')
  expect(existsSync(`${result.duckdbPath}.wal`)).toBe(false)
}

test('duckdb shutdown hook bypasses a stuck queue on SIGTERM', async () => {
  const duckdbPath = join(tmpdir(), `f1-duckdb-shutdown-${Date.now()}.duckdb`)
  const childProcess = globalThis.Bun.spawn(
    [
      'bun',
      '-e',
      `
        const {runDuckdbJsonQuery} = await import('./src/server/utils/duckdbService.ts')
        await runDuckdbJsonQuery('SELECT 1 AS value')
        globalThis.__forskaDuckdbServiceState.duckdbQueue = new Promise(() => {})
        ${terminateCurrentProcessSource}
        setTimeout(() => {
          console.log('still alive')
        }, 3_000)
      `,
    ],
    {
      cwd: process.cwd(),
      env: {...process.env, DUCKDB_MEMORY_LIMIT: '20GB', DUCKDB_PATH: duckdbPath, SERVER_ROLE: 'maintenance-worker'},
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )

  try {
    expect(await waitForProcessExit(childProcess, 5_000)).toBe(true)
    expect(childProcess.exitCode).toBe(0)
  } finally {
    if (childProcess.exitCode === null) {
      childProcess.kill('SIGKILL')
      await childProcess.exited
    }

    removeDuckdbFiles(duckdbPath)
  }
})

test('duckdb shutdown hook bypasses a stuck append queue on SIGTERM', async () => {
  const duckdbPath = join(tmpdir(), `f1-duckdb-append-shutdown-${Date.now()}.duckdb`)
  const childProcess = globalThis.Bun.spawn(
    [
      'bun',
      '-e',
      `
        const {runDuckdbJsonQuery} = await import('./src/server/utils/duckdbService.ts')
        await runDuckdbJsonQuery('SELECT 1 AS value')
        globalThis.__forskaDuckdbServiceState.appendQueues[0] = new Promise(() => {})
        ${terminateCurrentProcessSource}
        setTimeout(() => {
          console.log('still alive')
        }, 3_000)
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DUCKDB_APPEND_LANE_COUNT: '2',
        DUCKDB_MEMORY_LIMIT: '1GB',
        DUCKDB_PATH: duckdbPath,
        SERVER_ROLE: 'maintenance-worker',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )

  try {
    expect(await waitForProcessExit(childProcess, 5_000)).toBe(true)
    expect(childProcess.exitCode).toBe(0)
  } finally {
    if (childProcess.exitCode === null) {
      childProcess.kill('SIGKILL')
      await childProcess.exited
    }

    removeDuckdbFiles(duckdbPath)
  }
})

test('duckdb shutdown hook skips checkpoint and native close under low-memory maintenance profile', async () => {
  const duckdbPath = join(tmpdir(), `f1-duckdb-low-memory-shutdown-${Date.now()}.duckdb`)
  const processStartedAt = new Date().toISOString()
  const childProcess = globalThis.Bun.spawn(
    [
      'bun',
      '-e',
      `
        const {runDuckdbJsonQuery} = await import('./src/server/utils/duckdbService.ts')

        await runDuckdbJsonQuery('SELECT 1 AS value')
        globalThis.__forskaDuckdbServiceState.controlConnection.run = async (statement) => {
          if (statement === 'CHECKPOINT') {
            throw new Error('checkpoint should not run under low-memory runtime')
          }
        }
        globalThis.__forskaDuckdbServiceState.controlConnection.closeSync = () => {
          throw new Error('control close should not run under low-memory runtime')
        }
        globalThis.__forskaDuckdbServiceState.duckdbInstance.closeSync = () => {
          throw new Error('instance close should not run under low-memory runtime')
        }
        ${terminateCurrentProcessSource}
        setTimeout(() => {
          console.log('still alive')
        }, 3_000)
      `,
    ],
    {
      cwd: process.cwd(),
      env: {...process.env, DUCKDB_MEMORY_LIMIT: '6400MiB', DUCKDB_PATH: duckdbPath, SERVER_ROLE: 'maintenance-worker'},
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )

  try {
    expect(await waitForProcessExit(childProcess, 5_000)).toBe(true)
    const stderr = await new Response(childProcess.stderr).text()

    expect(childProcess.exitCode).toBe(0)
    expect(stderr).not.toContain('checkpoint should not run under low-memory runtime')
    expect(stderr).not.toContain('control close should not run under low-memory runtime')
    expect(stderr).not.toContain('instance close should not run under low-memory runtime')
    expect(stderr).not.toContain('failed to checkpoint before shutdown')
    expect(existsSync(`${duckdbPath}.duckdb-owner.lock`)).toBe(true)
    await Effect.runPromise(
      releaseStoppedServerLocks({
        pid: childProcess.pid,
        processStartedAt,
        exitedAt: new Date().toISOString(),
        role: 'maintenance',
        envValues: {DUCKDB_PATH: duckdbPath},
      }),
    )
    expect(existsSync(`${duckdbPath}.duckdb-owner.lock`)).toBe(false)
  } finally {
    if (childProcess.exitCode === null) {
      childProcess.kill('SIGKILL')
      await childProcess.exited
    }

    removeDuckdbFiles(duckdbPath)
  }
})

test('duckdb shutdown hook releases owner lease under low-memory dev-single profile', async () => {
  const duckdbPath = join(tmpdir(), `f1-duckdb-low-memory-dev-single-shutdown-${Date.now()}.duckdb`)
  const childProcess = globalThis.Bun.spawn(
    [
      'bun',
      '-e',
      `
        const {runDuckdbJsonQuery} = await import('./src/server/utils/duckdbService.ts')

        await runDuckdbJsonQuery('SELECT 1 AS value')
        globalThis.__forskaDuckdbServiceState.controlConnection.run = async (statement) => {
          if (statement === 'CHECKPOINT') {
            throw new Error('checkpoint should not run under low-memory runtime')
          }
        }
        globalThis.__forskaDuckdbServiceState.controlConnection.closeSync = () => {
          throw new Error('control close should not run under low-memory runtime')
        }
        globalThis.__forskaDuckdbServiceState.duckdbInstance.closeSync = () => {
          throw new Error('instance close should not run under low-memory runtime')
        }
        ${terminateCurrentProcessSource}
        setTimeout(() => {
          console.log('still alive')
        }, 3_000)
      `,
    ],
    {
      cwd: process.cwd(),
      env: {...process.env, DUCKDB_MEMORY_LIMIT: '6400MiB', DUCKDB_PATH: duckdbPath, SERVER_ROLE: 'dev-single'},
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )

  try {
    expect(await waitForProcessExit(childProcess, 5_000)).toBe(true)
    const stderr = await new Response(childProcess.stderr).text()

    expect(childProcess.exitCode).toBe(0)
    expect(stderr).not.toContain('checkpoint should not run under low-memory runtime')
    expect(stderr).not.toContain('control close should not run under low-memory runtime')
    expect(stderr).not.toContain('instance close should not run under low-memory runtime')
    expect(stderr).not.toContain('failed to checkpoint before shutdown')
    expect(existsSync(`${duckdbPath}.duckdb-owner.lock`)).toBe(false)
  } finally {
    if (childProcess.exitCode === null) {
      childProcess.kill('SIGKILL')
      await childProcess.exited
    }

    removeDuckdbFiles(duckdbPath)
  }
})

test('duckdb close can skip shutdown checkpoint explicitly', async () => {
  const duckdbPath = join(tmpdir(), `f1-duckdb-skip-close-checkpoint-${Date.now()}.duckdb`)
  const childProcess = globalThis.Bun.spawn(
    [
      'bun',
      '-e',
      `
        const {closeDuckdbService, runDuckdbJsonQuery} = await import('./src/server/utils/duckdbService.ts')
        await runDuckdbJsonQuery('SELECT 1 AS value')
        globalThis.__forskaDuckdbServiceState.controlConnection.run = async (statement) => {
          if (statement === 'CHECKPOINT') {
            throw new Error('checkpoint should not run')
          }
        }
        await closeDuckdbService({checkpointBeforeClose: false})
      `,
    ],
    {
      cwd: process.cwd(),
      env: {...process.env, DUCKDB_MEMORY_LIMIT: '1GB', DUCKDB_PATH: duckdbPath, SERVER_ROLE: 'maintenance-worker'},
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )

  try {
    expect(await waitForProcessExit(childProcess, 5_000)).toBe(true)
    const stderr = await new Response(childProcess.stderr).text()

    expect(childProcess.exitCode).toBe(0)
    expect(stderr).not.toContain('checkpoint should not run')
  } finally {
    if (childProcess.exitCode === null) {
      childProcess.kill('SIGKILL')
      await childProcess.exited
    }

    removeDuckdbFiles(duckdbPath)
  }
})

test('SIGTERM during an open transaction lets it commit, rejects new work, checkpoints and exits 0 without a WAL', async () => {
  const result = await runDuckdbShutdownChild({
    name: 'commit-during-drain',
    source: `
      const {runDuckdbJsonQuery, runDuckdbStatement, runDuckdbTransaction} = await import('./src/server/utils/duckdbService.ts')

      await runDuckdbStatement('CREATE TABLE sample (id INTEGER PRIMARY KEY, label VARCHAR)')
      await runDuckdbTransaction(async (tx) => {
        await tx.run("INSERT INTO sample SELECT i, 'row-' || i FROM range(1000) r(i)")
        signalCurrentProcess('SIGTERM')
        await new Promise((resolve) => setTimeout(resolve, 500))
        const newWork = await runDuckdbJsonQuery('SELECT 1 AS value').then(
          () => 'accepted',
          (error) => error.message,
        )
        console.log('new work after SIGTERM: ' + newWork)
        await tx.run("INSERT INTO sample VALUES (5000, 'last')")
      })
      console.log('transaction committed')
      setTimeout(() => {
        console.log('still alive')
      }, 20_000)
    `,
  })

  try {
    expectCleanGracefulExit(result)
    expect(result.stdout).toContain('new work after SIGTERM: DuckDB is shutting down')
    expect(result.stdout).toContain('transaction committed')
    expect(result.stdout).toContain('drain=idle')
    expect(
      await readDuckdbRowsAfterShutdown<{rowCount: number}>(
        result.duckdbPath,
        'SELECT count(*)::INTEGER AS rowCount FROM sample',
      ),
    ).toEqual([{rowCount: 1001}])
  } finally {
    removeDuckdbFiles(result.duckdbPath)
  }
})

test('SIGTERM interrupts a statement still running at the drain deadline, waits for rollback and checkpoints', async () => {
  const result = await runDuckdbShutdownChild({
    env: {FORSKA_DUCKDB_SHUTDOWN_DRAIN_TIMEOUT_MS: '300', FORSKA_DUCKDB_SHUTDOWN_ROLLBACK_TIMEOUT_MS: '10000'},
    name: 'interrupt-long-statement',
    source: `
      const {runDuckdbStatement, runDuckdbTransaction} = await import('./src/server/utils/duckdbService.ts')

      await runDuckdbStatement('CREATE TABLE sample (id BIGINT)')
      await runDuckdbStatement('INSERT INTO sample VALUES (1)')
      await runDuckdbTransaction(async (tx) => {
        await tx.run('INSERT INTO sample VALUES (2)')
        signalCurrentProcess('SIGTERM')
        await tx.run('INSERT INTO sample SELECT count(*) FROM range(50000000000) r(i) WHERE i % 7 = 3')
      }).catch((error) => {
        console.log('transaction failed: ' + error.message.split('\\n')[0])
      })
      setTimeout(() => {
        console.log('still alive')
      }, 20_000)
    `,
  })

  try {
    expectCleanGracefulExit(result)
    expect(result.stdout).toContain('transaction failed: INTERRUPT Error')
    expect(result.stdout).toContain('drain=interrupted')
    expect(
      await readDuckdbRowsAfterShutdown<{id: number}>(result.duckdbPath, 'SELECT id::INTEGER AS id FROM sample'),
    ).toEqual([{id: 1}])
  } finally {
    removeDuckdbFiles(result.duckdbPath)
  }
})

test('SIGTERM during a transaction that never finishes checkpoints on its own connection and rolls the transaction back', async () => {
  const result = await runDuckdbShutdownChild({
    env: {FORSKA_DUCKDB_SHUTDOWN_DRAIN_TIMEOUT_MS: '200', FORSKA_DUCKDB_SHUTDOWN_ROLLBACK_TIMEOUT_MS: '200'},
    name: 'hung-transaction',
    source: `
      const {runDuckdbStatement, runDuckdbTransaction} = await import('./src/server/utils/duckdbService.ts')

      await runDuckdbStatement('CREATE TABLE committed_sample (id INTEGER)')
      await runDuckdbStatement('INSERT INTO committed_sample VALUES (1)')
      await runDuckdbTransaction(async (tx) => {
        await tx.run('CREATE TABLE uncommitted_sample (id INTEGER)')
        await tx.run('INSERT INTO uncommitted_sample VALUES (1)')
        signalCurrentProcess('SIGTERM')
        await new Promise(() => {})
      })
    `,
  })

  try {
    expectCleanGracefulExit(result)
    expect(result.stdout).toContain('drain=busy')
    expect(result.stderr).not.toContain('Cannot CHECKPOINT')
    expect(
      await readDuckdbRowsAfterShutdown<{tableName: string}>(
        result.duckdbPath,
        "SELECT table_name AS tableName FROM information_schema.tables WHERE table_name LIKE '%sample' ORDER BY 1",
      ),
    ).toEqual([{tableName: 'committed_sample'}])
  } finally {
    removeDuckdbFiles(result.duckdbPath)
  }
})

test('duckdb shutdown hook checkpoints on its own connection when queued work never drains', async () => {
  const result = await runDuckdbShutdownChild({
    env: {FORSKA_DUCKDB_SHUTDOWN_DRAIN_TIMEOUT_MS: '200', FORSKA_DUCKDB_SHUTDOWN_ROLLBACK_TIMEOUT_MS: '200'},
    name: 'stuck-pending-count',
    source: `
      const {runDuckdbJsonQuery} = await import('./src/server/utils/duckdbService.ts')

      await runDuckdbJsonQuery('SELECT 1 AS value')
      globalThis.__forskaDuckdbServiceState.duckdbPendingCount = 1
      const controlConnection = globalThis.__forskaDuckdbServiceState.controlConnection
      const originalRun = controlConnection.run.bind(controlConnection)
      controlConnection.run = async (statement, ...args) => {
        if (statement === 'CHECKPOINT') {
          throw new Error('control connection checkpoint should not run')
        }
        return originalRun(statement, ...args)
      }
      signalCurrentProcess('SIGTERM')
      setTimeout(() => {
        console.log('still alive')
      }, 20_000)
    `,
  })

  try {
    expectCleanGracefulExit(result)
    expect(result.stdout).toContain('drain=busy')
    expect(result.stderr).not.toContain('control connection checkpoint should not run')
  } finally {
    removeDuckdbFiles(result.duckdbPath)
  }
})

test('repeated SIGTERM and SIGINT during drain and checkpoint are ignored and shutdown still exits 0 without a WAL', async () => {
  const result = await runDuckdbShutdownChild({
    name: 'repeated-signals',
    source: `
      const {runDuckdbStatement, runDuckdbTransaction} = await import('./src/server/utils/duckdbService.ts')

      await runDuckdbStatement('CREATE TABLE sample (id BIGINT, label VARCHAR)')
      await runDuckdbTransaction(async (tx) => {
        await tx.run("INSERT INTO sample SELECT i, repeat('x', 40) FROM range(3000000) r(i)")
        signalCurrentProcess('SIGTERM')
        setInterval(() => {
          signalCurrentProcess('SIGTERM')
          signalCurrentProcess('SIGINT')
        }, 25)
        await new Promise((resolve) => setTimeout(resolve, 300))
        await tx.run("INSERT INTO sample VALUES (-1, 'last')")
      })
      console.log('transaction committed')
    `,
  })

  try {
    expectCleanGracefulExit(result)
    expect(result.stderr).toContain('[server] SIGTERM ignored; graceful shutdown is already in progress')
    expect(result.stderr).toContain('[server] SIGINT ignored; graceful shutdown is already in progress')
    expect(
      await readDuckdbRowsAfterShutdown<{rowCount: number}>(
        result.duckdbPath,
        'SELECT count(*)::INTEGER AS rowCount FROM sample',
      ),
    ).toEqual([{rowCount: 3_000_001}])
  } finally {
    removeDuckdbFiles(result.duckdbPath)
  }
})

test('SIGTERM during DuckDB startup stops the open and never reopens the database afterwards', async () => {
  const result = await runDuckdbShutdownChild({
    name: 'startup-no-reopen',
    source: `
      const nodeApi = await import('@duckdb/node-api')
      const originalCreate = nodeApi.DuckDBInstance.create
      let openCount = 0
      nodeApi.DuckDBInstance.create = (...args) => {
        openCount += 1
        return originalCreate.apply(nodeApi.DuckDBInstance, args)
      }
      process.on('exit', () => {
        console.log('duckdb opens=' + openCount)
      })

      const {registerDuckdbShutdownHooks, runDuckdbJsonQuery} = await import('./src/server/utils/duckdbService.ts')
      registerDuckdbShutdownHooks()
      const firstQuery = runDuckdbJsonQuery('SELECT 1 AS value').then(
        () => 'accepted',
        (error) => error.message,
      )
      signalCurrentProcess('SIGTERM')
      console.log('first query: ' + (await firstQuery))
      const laterQueries = await Promise.all(
        [1, 2, 3].map(() => {
          return runDuckdbJsonQuery('SELECT 2 AS value').then(
            () => 'accepted',
            (error) => error.message,
          )
        }),
      )
      console.log('later queries: ' + laterQueries.join(' | '))
      setTimeout(() => {
        console.log('still alive')
      }, 20_000)
    `,
  })

  try {
    expect({exitCode: result.exitCode, exited: result.exited, stderr: result.stderr}).toMatchObject({
      exitCode: 0,
      exited: true,
    })
    expect(result.stdout).toContain('first query: DuckDB is shutting down')
    expect(result.stdout).not.toContain('later queries: accepted')
    expect(result.stdout).toContain('duckdb opens=0')
    expect(result.stdout).toContain('shutdown checkpoint skipped')
    expect(existsSync(`${result.duckdbPath}.wal`)).toBe(false)
  } finally {
    removeDuckdbFiles(result.duckdbPath)
  }
})
