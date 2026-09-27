import {copyFileSync, mkdtempSync, readFileSync, rmSync, statSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {DuckDBInstance} from '@duckdb/node-api'
import {expect, test} from 'bun:test'

import {createDuckdbInstance} from './createDuckdbInstance.ts'
import {duckdbEngineCompatibilityOptions} from './duckdbEngineContract.ts'

type Opener = 'attachWithoutCheckpoint' | 'createDuckdbInstance'

const options = {...duckdbEngineCompatibilityOptions, checkpoint_threshold: '1TB', memory_limit: '256MiB', threads: '1'}

const seedStatements = [
  `CREATE TABLE source_record (
    id VARCHAR PRIMARY KEY,
    import_route_id VARCHAR NOT NULL,
    source_record_key VARCHAR NOT NULL,
    source_article_created_at TIMESTAMPTZ,
    UNIQUE(import_route_id, source_record_key)
  )`,
  'CREATE INDEX idx_source_record_created_at ON source_record(import_route_id, source_article_created_at)',
  `INSERT INTO source_record
    SELECT 'checkpointed-' || i, 'route', 'checkpointed-' || i, TIMESTAMPTZ '2026-01-01 00:00:00+00' FROM range(100) r(i)`,
  'CHECKPOINT',
  'PRAGMA disable_checkpoint_on_shutdown',
  `INSERT INTO source_record
    SELECT 'replayed-' || i, 'route', 'replayed-' || i, TIMESTAMPTZ '2026-02-01 00:00:00+00' FROM range(500) r(i)`,
  `INSERT INTO source_record
    SELECT 'replayed-' || i, 'route', 'replayed-' || i, TIMESTAMPTZ '2026-03-01 00:00:00+00' + i * INTERVAL 1 MINUTE
    FROM range(250) r(i)
    ON CONFLICT (import_route_id, source_record_key) DO UPDATE SET
      source_article_created_at = excluded.source_article_created_at`,
]

const restarts = {
  automatic: {
    body: `
      await connection.run("SET checkpoint_threshold = '1KB'")
      await connection.run('CREATE TABLE later_write AS SELECT range AS value FROM range(20000)')
      process.kill(process.pid, 'SIGKILL')
    `,
    exit: {exitCode: null, signalCode: 'SIGKILL'},
  },
  shutdown: {
    body: `
      connection.closeSync()
      instance.closeSync()
    `,
    exit: {exitCode: 0, signalCode: null},
  },
}

const probeBody = `
  const replayedRows = (
    await connection.runAndReadAll("SELECT count(*)::INTEGER AS n FROM source_record WHERE id LIKE 'replayed-%'")
  ).getRowObjectsJson()
  const result = await connection
    .run('BEGIN')
    .then(() => connection.run("UPDATE source_record SET source_article_created_at = source_article_created_at WHERE id LIKE 'replayed-%'"))
    .then(() => connection.run('COMMIT'))
    .then(() => 'committed', (error) => error.message)
  console.log(JSON.stringify({replayedRows: replayedRows[0].n, result}))
`

const getChildScript = (databasePath: string, opener: Opener, body: string) => {
  return `
    const {DuckDBInstance} = await import('@duckdb/node-api')
    const {createDuckdbInstance} = await import(${JSON.stringify(join(import.meta.dir, 'createDuckdbInstance.ts'))})
    const databasePath = ${JSON.stringify(databasePath)}
    const options = ${JSON.stringify(options)}
    const attachWithoutCheckpoint = async () => {
      const bootstrap = await DuckDBInstance.create(':memory:', options)
      const attach = await bootstrap.connect()
      await attach.run("ATTACH ':memory:' AS bootstrap")
      await attach.run('USE bootstrap')
      await attach.run('DETACH memory')
      await attach.run("ATTACH '" + databasePath.replaceAll("'", "''") + "' AS replayed")
      await attach.run('USE replayed')
      await attach.run('DETACH bootstrap')
      attach.closeSync()
      return bootstrap
    }
    const instance = ${
      opener === 'attachWithoutCheckpoint'
        ? 'await attachWithoutCheckpoint()'
        : 'await createDuckdbInstance({create: DuckDBInstance.create.bind(DuckDBInstance), databasePath, options})'
    }
    const connection = await instance.connect()
    ${body}
  `
}

const runChild = (databasePath: string, opener: Opener, body: string) => {
  return globalThis.Bun.spawnSync([process.execPath, '-e', getChildScript(databasePath, opener, body)], {
    cwd: process.cwd(),
    stderr: 'pipe',
    stdout: 'pipe',
    timeout: 60_000,
  })
}

const seedKilledWriter = (databasePath: string) => {
  const statements = seedStatements.map((statement) => {
    return `await connection.run(${JSON.stringify(statement)})`
  })
  const result = runChild(
    databasePath,
    'createDuckdbInstance',
    `
    ${statements.join('\n')}
    process.kill(process.pid, 'SIGKILL')
  `,
  )

  expect(result.signalCode, result.stderr.toString()).toBe('SIGKILL')
  expect(statSync(`${databasePath}.wal`).size).toBeGreaterThan(0)
}

const restart = (databasePath: string, opener: Opener, checkpoint: keyof typeof restarts) => {
  const result = runChild(databasePath, opener, restarts[checkpoint].body)
  const exit: {exitCode: number | null; signalCode: string | null} = {
    exitCode: result.exitCode,
    signalCode: result.signalCode ?? null,
  }

  expect(exit, result.stderr.toString()).toEqual(restarts[checkpoint].exit)
  expect(statSync(`${databasePath}.wal`, {throwIfNoEntry: false})?.size ?? 0).toBe(0)
}

const probe = (databasePath: string) => {
  const result = runChild(databasePath, 'createDuckdbInstance', probeBody)

  expect(result.exitCode, result.stderr.toString() || result.stdout.toString()).toBe(0)

  return JSON.parse(result.stdout.toString().trim().split('\n').at(-1) ?? '{}') as {
    replayedRows: number
    result: string
  }
}

const copyDatabase = (sourcePath: string, targetPath: string) => {
  copyFileSync(sourcePath, targetPath)
  copyFileSync(`${sourcePath}.wal`, `${targetPath}.wal`)

  return targetPath
}

test.each(['shutdown', 'automatic'] as const)(
  'WAL-replayed index entries survive the next %s checkpoint only when the open checkpoints first',
  (checkpoint) => {
    const root = mkdtempSync(join(tmpdir(), 'forska-wal-replay-index-'))
    const seededPath = join(root, 'seeded.duckdb')

    try {
      seedKilledWriter(seededPath)
      const legacyPath = copyDatabase(seededPath, join(root, 'legacy.duckdb'))
      const currentPath = copyDatabase(seededPath, join(root, 'current.duckdb'))

      restart(legacyPath, 'attachWithoutCheckpoint', checkpoint)
      restart(currentPath, 'createDuckdbInstance', checkpoint)

      const legacy = probe(legacyPath)
      const current = probe(currentPath)

      expect(legacy.replayedRows).toBe(500)
      expect(legacy.result).toContain('Failed to delete all rows from index')
      expect(current).toEqual({replayedRows: 500, result: 'committed'})
    } finally {
      rmSync(root, {recursive: true, force: true})
    }
  },
  120_000,
)

test('owner startup after a killed writer keeps WAL-replayed rows in secondary indexes', () => {
  const root = mkdtempSync(join(tmpdir(), 'forska-wal-replay-index-startup-'))
  const databasePath = join(root, 'owner.duckdb')

  try {
    seedKilledWriter(databasePath)
    const startup = globalThis.Bun.spawnSync(
      [
        process.execPath,
        '-e',
        `
          const service = await import(${JSON.stringify(join(import.meta.dir, 'duckdbService.ts'))})
          await service.runDuckdbJsonQuery('SELECT 1')
          await service.closeDuckdbService()
        `,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DUCKDB_MEMORY_LIMIT: '512MiB',
          DUCKDB_PATH: databasePath,
          DUCKDB_TEMP_DIRECTORY: join(root, 'duckdb-temp'),
          FORSKA_DUCKDB_STARTUP_WAL_PREFLIGHT: 'true',
          SERVER_DUCKDB_OWNER_URL: '',
          SERVER_ROLE: 'maintenance-worker',
        },
        stderr: 'pipe',
        stdout: 'pipe',
        timeout: 120_000,
      },
    )

    expect(startup.exitCode, startup.stderr.toString() || startup.stdout.toString()).toBe(0)
    expect(statSync(`${databasePath}.wal`, {throwIfNoEntry: false})?.size ?? 0).toBe(0)
    expect(probe(databasePath)).toEqual({replayedRows: 500, result: 'committed'})
  } finally {
    rmSync(root, {recursive: true, force: true})
  }
}, 180_000)

const getCheckpointFailingFactory = (events: string[]) => {
  return async (path?: string, factoryOptions?: Record<string, string>) => {
    const instance = await DuckDBInstance.create(path, factoryOptions)

    return {
      connect: async () => {
        const connection = await instance.connect()

        return {
          runAndReadAll: async (statement: string) => {
            return connection.runAndReadAll(statement)
          },
          run: async (statement: string) => {
            events.push(statement)
            return statement.startsWith('CHECKPOINT')
              ? Promise.reject(new Error('simulated checkpoint failure'))
              : connection.run(statement)
          },
          closeSync: () => {
            events.push('close-connection')
            connection.closeSync()
          },
        }
      },
      closeSync: () => {
        events.push('close-instance')
        instance.closeSync()
      },
    } as unknown as DuckDBInstance
  }
}

test('a failed open checkpoint closes without a shutdown checkpoint and keeps the WAL for the next open', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forska-wal-replay-checkpoint-failure-'))
  const databasePath = join(root, 'source.duckdb')
  const events: string[] = []

  try {
    seedKilledWriter(databasePath)
    const walBefore = readFileSync(`${databasePath}.wal`)
    const error = (await createDuckdbInstance({
      create: getCheckpointFailingFactory(events),
      databasePath,
      options,
    }).catch((cause: unknown) => {
      return cause
    })) as Error

    expect(error.message).toContain(`DuckDB could not checkpoint ${databasePath} right after opening it for writing`)
    expect(error.message).toContain('Checkpoint error: simulated checkpoint failure')
    expect((error.cause as Error).message).toBe('simulated checkpoint failure')
    expect(events.slice(-4)).toEqual([
      'CHECKPOINT "source"',
      'PRAGMA disable_checkpoint_on_shutdown',
      'close-connection',
      'close-instance',
    ])
    expect(readFileSync(`${databasePath}.wal`)).toEqual(walBefore)
    expect(probe(databasePath)).toEqual({replayedRows: 500, result: 'committed'})
  } finally {
    rmSync(root, {recursive: true, force: true})
  }
}, 120_000)
