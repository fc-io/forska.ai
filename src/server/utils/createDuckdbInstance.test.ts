import {createHash} from 'node:crypto'
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {gunzipSync} from 'node:zlib'

import {DuckDBInstance} from '@duckdb/node-api'
import {expect, test} from 'bun:test'

import {createDuckdbInstance} from './createDuckdbInstance.ts'
import {getDuckdbEngineOptions} from './duckdbEngineCompatibility.ts'
import statisticsFixture from './duckdbEngineCompatibility/fixtures/duckdb151StringStatsUpdateAlphaWal.json'
import {duckdbExpectedEngineIdentity} from './duckdbEngineContract.ts'

test.each(['memory.duckdb', 'main.duckdb', 'system.duckdb', 'temp.duckdb', "quote's database.duckdb"])(
  'all connections retain the persistent default catalog and read-only protection for %s',
  async (filename) => {
    const directory = mkdtempSync(join(tmpdir(), 'forska-default-catalog-'))
    const databasePath = join(directory, filename)
    const options = {...getDuckdbEngineOptions(), memory_limit: '128MiB', threads: '1'}

    try {
      const instance = await createDuckdbInstance({
        create: DuckDBInstance.create.bind(DuckDBInstance),
        databasePath,
        options,
      })

      try {
        const writer = await instance.connect()
        await writer.run(
          'CREATE SCHEMA app; CREATE TABLE app.retained(value INTEGER); INSERT INTO app.retained VALUES (42)',
        )
        writer.closeSync()
        const reader = await instance.connect()
        expect((await reader.runAndReadAll('SELECT value FROM app.retained')).getRowObjectsJson()).toEqual([
          {value: 42},
        ])
        expect(
          (
            await reader.runAndReadAll('SELECT database_name FROM duckdb_databases() WHERE NOT internal')
          ).getRowObjectsJson(),
        ).toHaveLength(1)
        expect(
          (await reader.runAndReadAll("SELECT current_setting('threads') AS threads")).getRowObjectsJson(),
        ).toEqual([{threads: '1'}])
        reader.closeSync()
      } finally {
        instance.closeSync()
      }

      const readOnly = await createDuckdbInstance({
        create: DuckDBInstance.create.bind(DuckDBInstance),
        databasePath,
        options: {...options, access_mode: 'READ_ONLY'},
      })

      try {
        const reader = await readOnly.connect()
        expect((await reader.runAndReadAll('SELECT value FROM app.retained')).getRowObjectsJson()).toEqual([
          {value: 42},
        ])
        const writeError = await reader.run('INSERT INTO app.retained VALUES (99)').catch((error: unknown) => {
          return error
        })
        expect(String(writeError)).toContain('read-only')
        reader.closeSync()
      } finally {
        readOnly.closeSync()
      }
    } finally {
      rmSync(directory, {recursive: true, force: true})
    }
  },
)

test('in-memory instances preserve the direct factory options', async () => {
  const options = {...getDuckdbEngineOptions(), memory_limit: '128MiB'}
  const instance = await createDuckdbInstance({
    create: DuckDBInstance.create.bind(DuckDBInstance),
    databasePath: ':memory:',
    options,
  })
  const connection = await instance.connect()

  try {
    expect((await connection.runAndReadAll('SELECT current_database() AS catalog')).getRowObjectsJson()).toEqual([
      {catalog: 'memory'},
    ])
  } finally {
    connection.closeSync()
    instance.closeSync()
  }
})

test.each(['connect', 'attach'])(
  'failed %s closes bootstrap resources once and preserves the original failure',
  async (phase) => {
    const events: string[] = []
    const failure = new Error('WAL replay needs a built-in function')
    const instance = {
      connect: async () => {
        events.push('connect')
        if (phase === 'connect') {
          throw failure
        }
        return {
          runAndReadAll: async () => {
            return {
              getRowObjectsJson: () => {
                return [
                  {
                    library_version: duckdbExpectedEngineIdentity.version,
                    source_id: duckdbExpectedEngineIdentity.sourceId,
                  },
                ]
              },
            }
          },
          run: async (statement: string) => {
            if (statement.startsWith('ATTACH') && !statement.includes(':memory:')) {
              throw failure
            }
          },
          closeSync: () => {
            events.push('close-connection')
            throw new Error('secondary invalidated-connection close error')
          },
        }
      },
      closeSync: () => {
        events.push('close-instance')
        throw new Error('secondary invalidated-instance close error')
      },
    }
    const create = async (path?: string) => {
      events.push(`create:${path}`)
      return instance as unknown as DuckDBInstance
    }

    const result = await createDuckdbInstance({create, databasePath: 'preserved.duckdb'}).catch((error: unknown) => {
      return error
    })
    expect(result).toBe(failure)
    expect(events).toEqual(
      phase === 'connect'
        ? ['create::memory:', 'connect', 'close-instance']
        : ['create::memory:', 'connect', 'close-connection', 'close-instance'],
    )
  },
)

const getObservedFactory = (events: string[]) => {
  return async (path?: string, options?: Record<string, string>) => {
    events.push(`create:${String(path)}`)
    const instance = await DuckDBInstance.create(path, options)

    return {
      connect: async () => {
        events.push('connect')
        const connection = await instance.connect()

        return {
          runAndReadAll: async (statement: string) => {
            events.push(statement)
            return connection.runAndReadAll(statement)
          },
          run: async (statement: string) => {
            events.push(statement)
            return connection.run(statement)
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

test.each(['version', 'sourceId'] as const)(
  'mismatched engine %s closes bootstrap before any ATTACH and preserves committed database/WAL bytes',
  async (field) => {
    const root = mkdtempSync(join(tmpdir(), 'forska-engine-identity-'))
    const databasePath = join(root, 'preserved.duckdb')
    const expectedEngine = {
      ...duckdbExpectedEngineIdentity,
      [field]: field === 'version' ? 'v0.0.0-wrong' : '0000000000',
    }
    const events: string[] = []

    try {
      for (const name of ['database', 'wal'] as const) {
        const bytes = gunzipSync(Buffer.from(statisticsFixture.files[name].gzipBase64, 'base64'))
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(statisticsFixture.files[name].sha256)
        writeFileSync(name === 'database' ? databasePath : `${databasePath}.wal`, bytes)
      }

      const before = [readFileSync(databasePath), readFileSync(`${databasePath}.wal`)]
      const error = await createDuckdbInstance({
        create: getObservedFactory(events),
        databasePath,
        expectedEngine,
        options: {...getDuckdbEngineOptions(), access_mode: 'READ_ONLY', memory_limit: '64MiB', threads: '1'},
      }).catch((cause: unknown) => {
        return cause
      })
      expect(String(error)).toContain(`source ${expectedEngine.sourceId}`)
      expect(String(error)).toContain('bun install --frozen-lockfile')
      expect(String(error)).toContain('The database was not opened')
      expect(events).toEqual(['create::memory:', 'connect', 'PRAGMA version', 'close-connection', 'close-instance'])
      expect([readFileSync(databasePath), readFileSync(`${databasePath}.wal`)]).toEqual(before)
    } finally {
      rmSync(root, {recursive: true, force: true})
    }
  },
)

test.each([undefined, '', ':memory:'])(
  'in-memory path %s also refuses the same-version engine with a different source identity',
  async (databasePath) => {
    const events: string[] = []
    const error = await createDuckdbInstance({
      create: getObservedFactory(events),
      databasePath,
      expectedEngine: {...duckdbExpectedEngineIdentity, sourceId: '0000000000'},
      options: {...getDuckdbEngineOptions(), memory_limit: '64MiB', threads: '1'},
    }).catch((cause: unknown) => {
      return cause
    })
    expect(String(error)).toContain('source 0000000000')
    expect(events).toEqual([
      `create:${String(databasePath)}`,
      'connect',
      'PRAGMA version',
      'close-connection',
      'close-instance',
    ])
  },
)
