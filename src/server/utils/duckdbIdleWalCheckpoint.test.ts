import {existsSync, rmSync, statSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {expect, setDefaultTimeout, test} from 'bun:test'

setDefaultTimeout(60_000)

const removeDuckdbFiles = (duckdbPath: string) => {
  ;[
    duckdbPath,
    `${duckdbPath}.wal`,
    `${duckdbPath}.duckdb-owner.lock`,
    `${duckdbPath}.duckdb-owner.history.json`,
    `${duckdbPath}.startup-recovery`,
  ].map((filePath) => {
    return existsSync(filePath) ? rmSync(filePath, {force: true, recursive: true}) : null
  })
}

const runIdleWalCheckpointChild = async (memoryLimit: string) => {
  const duckdbPath = join(tmpdir(), `f1-duckdb-idle-wal-checkpoint-${memoryLimit}-${Date.now()}.duckdb`)
  const childProcess = globalThis.Bun.spawn(
    [
      'bun',
      '-e',
      `
        const {
          getDuckdbWalCheckpointRuntimeState,
          isDuckdbAutoCheckpointDeferred,
          runDuckdbIdleWalCheckpoint,
          runDuckdbStatement,
          runDuckdbTransaction,
        } = await import('./src/server/utils/duckdbService.ts')

        await runDuckdbStatement('CREATE TABLE sample (id INTEGER PRIMARY KEY, label VARCHAR)')
        await runDuckdbStatement("INSERT INTO sample SELECT i, repeat('x', 64) || i FROM range(20000) r(i)")
        const beforeCheckpoint = getDuckdbWalCheckpointRuntimeState()
        let duringTransaction = null
        await runDuckdbTransaction(async (tx) => {
          await tx.run("INSERT INTO sample VALUES (20001, 'in transaction')")
          duringTransaction = getDuckdbWalCheckpointRuntimeState()
        })
        const outcome = await runDuckdbIdleWalCheckpoint()
        const afterCheckpoint = getDuckdbWalCheckpointRuntimeState()
        console.log('RESULT ' + JSON.stringify({
          afterCheckpoint,
          autoCheckpointDeferred: isDuckdbAutoCheckpointDeferred(),
          beforeCheckpoint,
          duringTransactionWritesInFlight: duringTransaction.writesInFlight,
          outcome,
        }))
        process.exit(0)
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DUCKDB_MEMORY_LIMIT: memoryLimit,
        DUCKDB_PATH: duckdbPath,
        SERVER_ROLE: 'maintenance-worker',
      },
      stderr: 'pipe',
      stdout: 'pipe',
    },
  )
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(childProcess.stdout).text(),
    new Response(childProcess.stderr).text(),
    childProcess.exited,
  ])
  const resultLine = stdout.split('\n').find((line) => {
    return line.startsWith('RESULT ')
  })

  return {
    duckdbPath,
    exitCode,
    result:
      resultLine === undefined
        ? null
        : (JSON.parse(resultLine.slice('RESULT '.length)) as {
            afterCheckpoint: {runtimeOpen: boolean; walBytes: number | null; writesInFlight: boolean}
            autoCheckpointDeferred: boolean
            beforeCheckpoint: {runtimeOpen: boolean; walBytes: number | null; writesInFlight: boolean}
            duringTransactionWritesInFlight: boolean
            outcome: string
          }),
    stderr,
    stdout,
  }
}

test('the deferred-checkpoint 6400MiB owner reports its WAL, sees the write in flight inside a transaction and empties the WAL on an idle checkpoint', async () => {
  const child = await runIdleWalCheckpointChild('6400MiB')

  try {
    expect({exitCode: child.exitCode, stderr: child.stderr}).toMatchObject({exitCode: 0})
    expect(child.stdout).not.toContain('[duckdb] startup WAL')
    expect(child.result).toMatchObject({
      afterCheckpoint: {runtimeOpen: true, walBytes: 0, writesInFlight: false},
      autoCheckpointDeferred: true,
      beforeCheckpoint: {runtimeOpen: true, writesInFlight: false},
      duringTransactionWritesInFlight: true,
      outcome: 'completed',
    })
    expect(child.result?.beforeCheckpoint.walBytes ?? 0).toBeGreaterThan(0)
  } finally {
    removeDuckdbFiles(child.duckdbPath)
  }
})

test('owners above the low-memory band keep DuckDB auto-checkpoints and do not enable the idle policy', async () => {
  const child = await runIdleWalCheckpointChild('20GB')

  try {
    expect({exitCode: child.exitCode, stderr: child.stderr}).toMatchObject({exitCode: 0})
    expect(child.result?.autoCheckpointDeferred).toBe(false)
  } finally {
    removeDuckdbFiles(child.duckdbPath)
  }
})

test('a WAL left behind by a hard stop is printed with its size on the first open of the process', async () => {
  const duckdbPath = join(tmpdir(), `f1-duckdb-startup-wal-size-${Date.now()}.duckdb`)
  const childEnv = {
    ...process.env,
    DUCKDB_MEMORY_LIMIT: '6400MiB',
    DUCKDB_PATH: duckdbPath,
    SERVER_ROLE: 'maintenance-worker',
  }

  try {
    const seed = globalThis.Bun.spawnSync(
      [
        'bun',
        '-e',
        `
          const {DuckDBInstance} = await import('@duckdb/node-api')
          const {getDuckdbEngineOptions} = await import('./src/server/utils/duckdbEngineCompatibility.ts')
          const instance = await DuckDBInstance.create(process.env.DUCKDB_PATH, {memory_limit: '128MiB', ...getDuckdbEngineOptions()})
          const connection = await instance.connect()
          await connection.run('PRAGMA disable_checkpoint_on_shutdown')
          await connection.run('CREATE TABLE retained(id INTEGER, value VARCHAR)')
          await connection.run("INSERT INTO retained VALUES (1, 'committed before a hard stop')")
          connection.closeSync()
          instance.closeSync()
        `,
      ],
      {cwd: process.cwd(), env: childEnv, stderr: 'pipe', stdout: 'pipe'},
    )

    expect(seed.exitCode, seed.stderr.toString()).toBe(0)
    expect(statSync(`${duckdbPath}.wal`).size).toBeGreaterThan(0)

    const open = globalThis.Bun.spawnSync(
      [
        'bun',
        '-e',
        `
          const {runDuckdbJsonQuery} = await import('./src/server/utils/duckdbService.ts')
          console.log('RESULT ' + JSON.stringify(await runDuckdbJsonQuery('SELECT count(*)::INTEGER AS rows FROM retained')))
          process.exit(0)
        `,
      ],
      {cwd: process.cwd(), env: childEnv, stderr: 'pipe', stdout: 'pipe'},
    )
    const stdout = open.stdout.toString()

    expect(open.exitCode, open.stderr.toString()).toBe(0)
    expect(stdout).toMatch(/\[duckdb\] startup WAL [1-9]\d* bytes for /u)
    expect(stdout).toContain('RESULT [{"rows":1}]')
  } finally {
    removeDuckdbFiles(duckdbPath)
  }
})
