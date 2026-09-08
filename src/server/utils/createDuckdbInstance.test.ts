import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {DuckDBInstance} from '@duckdb/node-api'
import {expect, test} from 'bun:test'

import {createDuckdbInstance} from './createDuckdbInstance.ts'
import {getDuckdbEngineOptions} from './duckdbEngineCompatibility.ts'

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
