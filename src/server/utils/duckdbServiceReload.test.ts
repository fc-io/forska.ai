import {existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {DuckDBInstance} from '@duckdb/node-api'
import {expect, test} from 'bun:test'

const removeFileIfExists = (filePath: string) => {
  if (existsSync(filePath)) {
    unlinkSync(filePath)
  }
}

const removePathIfExists = (path: string) => {
  rmSync(path, {force: true, recursive: true})
}

test('duckdb snapshots checkpoint before copying without copy-from-database', () => {
  const source = readFileSync('src/server/utils/duckdbService.ts', 'utf8')
  const copySnapshotSource = source.slice(
    source.indexOf('const copyDuckdbSnapshot'),
    source.indexOf('export const createDuckdbSnapshot'),
  )

  expect(source).toContain("runDuckdbStatementDirect('CHECKPOINT')")
  expect(source).toContain('checkpointBeforeDuckdbSnapshotCopy')
  expect(copySnapshotSource).toContain('shouldCheckpointBeforeDuckdbSnapshotCopy(runtimeConfig)')
  expect(copySnapshotSource).toContain('copyFile(runtimeConfig.databasePath, snapshotPath)')
  expect(copySnapshotSource).not.toContain('copyFile(sourceWalPath, snapshotWalPath)')
  expect(copySnapshotSource).toContain('materializeCopiedDuckdbSnapshot(snapshotPath, runtimeConfig)')
  expect(copySnapshotSource).not.toContain('COPY FROM DATABASE')
  expect(copySnapshotSource).not.toContain('ATTACH')
  expect(copySnapshotSource).not.toContain('DETACH')
})

test('duckdb snapshot creation fails when the pre-copy checkpoint fails', () => {
  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const serverRuntimeRoleModulePath = new URL('./src/server/utils/serverRuntimeRole.ts', 'file://' + process.cwd() + '/').pathname
        const runStatements = []

        void mock.module(serverRuntimeRoleModulePath, () => {
          return {
            canCurrentServerOwnDuckdb: () => true,
            ensureCurrentDuckdbOwnerLease: async () => {},
            registerDuckdbOwnerDemotionHandler: () => {},
            releaseCurrentDuckdbOwnerLease: async () => {},
          }
        })

        void mock.module('@duckdb/node-api', () => {
          class MockConnection {
            async run(statement) {
              runStatements.push(statement)
              if (statement === 'CHECKPOINT') {
                throw new Error('checkpoint failed with wal-backed changes')
              }
            }
            async runAndReadAll() {
              return {
                getRowObjectsJson() {
                  return [{value: 1}]
                },
              }
            }
            interrupt() {}
            closeSync() {}
          }

          class MockInstance {
            static async create() {
              return new MockInstance()
            }

            async connect() {
              return new MockConnection()
            }

            closeSync() {}
          }

          return {DuckDBConnection: MockConnection, DuckDBInstance: MockInstance}
        })

        const duckdbService = await import('./src/server/utils/duckdbService.ts?snapshot-checkpoint-failure-test=' + Date.now())
        let errorMessage = null

        try {
          await duckdbService.createDuckdbSnapshot()
        } catch (error) {
          errorMessage = error instanceof Error ? error.message : String(error)
        }

        console.log(JSON.stringify({errorMessage, runStatements}))
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: '3999',
        DUCKDB_MEMORY_LIMIT: '20GB',
        DUCKDB_PATH: '/tmp/f1-duckdb-service-snapshot-checkpoint-failure-test.duckdb',
        DUCKDB_TEMP_DIRECTORY: '/tmp/f1-duckdb-service-snapshot-checkpoint-failure-test-temp',
        RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
        RUN_SERVER_FULL_TEXT_FETCHING: 'false',
        SERVER_ROLE: 'maintenance-worker',
        SERVER_DUCKDB_OWNER_URL: '',
        VITE_PORT: '3000',
      },
    },
  )

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || result.stdout.toString() || 'DuckDB snapshot failure subprocess failed')
  }

  const parsed = JSON.parse(result.stdout.toString()) as {errorMessage: string | null; runStatements: string[]}

  expect(parsed.errorMessage).toContain('checkpoint failed with wal-backed changes')
  expect(parsed.runStatements).toEqual(['CHECKPOINT'])
})

test('duckdb snapshot WAL materialization makes read-only copies see committed WAL rows', async () => {
  const duckdbPath = `/tmp/f1-duckdb-snapshot-wal-source-${Date.now()}.duckdb`
  const dataRoot = `/tmp/f1-duckdb-snapshot-wal-data-${Date.now()}`

  removeFileIfExists(duckdbPath)
  removeFileIfExists(`${duckdbPath}.wal`)
  removePathIfExists(dataRoot)

  try {
    const result = globalThis.Bun.spawnSync(
      [
        'bun',
        '-e',
        `
          const {existsSync} = await import('node:fs')
          const {DuckDBInstance} = await import('@duckdb/node-api')
          const service = await import('./src/server/utils/duckdbService.ts?snapshot-wal-materialized=' + Date.now())

          await service.runDuckdbStatement('CREATE SCHEMA app')
          await service.runDuckdbStatement('CREATE TABLE app.snapshot_wal_test (id INTEGER)')
          await service.runDuckdbStatement('INSERT INTO app.snapshot_wal_test VALUES (1)')

          const snapshot = await service.createDuckdbSnapshot()
          const duckdbInstance = await DuckDBInstance.create(snapshot.snapshotPath, service.getReadOnlyDuckdbRuntimeOptions())
          const connection = await duckdbInstance.connect()
          const reader = await connection.runAndReadAll('SELECT count(*) AS count FROM app.snapshot_wal_test')
          const rows = reader.getRowObjectsJson()
          connection.closeSync()
          duckdbInstance.closeSync()

          console.log(JSON.stringify({rows, snapshotWalExists: existsSync(snapshot.snapshotPath + '.wal')}))
          await service.deleteDuckdbSnapshot(snapshot.snapshotPath)
          await service.closeDuckdbService({checkpointBeforeClose: false})
        `,
      ],
      {
        cwd: process.cwd(),
        env: {...process.env, DUCKDB_DATA_ROOT: dataRoot, DUCKDB_PATH: duckdbPath, SERVER_ROLE: 'maintenance-worker'},
      },
    )

    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString())
    }

    const parsed = JSON.parse(result.stdout.toString().trim()) as {
      rows: readonly {count: string}[]
      snapshotWalExists: boolean
    }

    expect(parsed.rows).toEqual([{count: '1'}])
    expect(parsed.snapshotWalExists).toBe(false)
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
    removePathIfExists(dataRoot)
  }
})

test('duckdb snapshot checkpoint prevents copied DDL WAL replay failures', async () => {
  const duckdbPath = `/tmp/f1-duckdb-snapshot-ddl-wal-source-${Date.now()}.duckdb`
  const dataRoot = `/tmp/f1-duckdb-snapshot-ddl-wal-data-${Date.now()}`

  removeFileIfExists(duckdbPath)
  removeFileIfExists(`${duckdbPath}.wal`)
  removePathIfExists(dataRoot)

  try {
    const result = globalThis.Bun.spawnSync(
      [
        'bun',
        '-e',
        `
          const {existsSync} = await import('node:fs')
          const {DuckDBInstance} = await import('@duckdb/node-api')
          const service = await import('./src/server/utils/duckdbService.ts?snapshot-ddl-wal=' + Date.now())

          await service.runDuckdbStatement('CREATE TABLE backup_check(value INTEGER)')
          await service.runDuckdbStatement('INSERT INTO backup_check VALUES (42)')

          const snapshot = await service.createDuckdbSnapshot()
          const duckdbInstance = await DuckDBInstance.create(snapshot.snapshotPath, service.getReadOnlyDuckdbRuntimeOptions())
          const connection = await duckdbInstance.connect()
          const reader = await connection.runAndReadAll('SELECT value FROM backup_check')
          const rows = reader.getRowObjectsJson()
          connection.closeSync()
          duckdbInstance.closeSync()

          console.log(JSON.stringify({rows, snapshotWalExists: existsSync(snapshot.snapshotPath + '.wal')}))
          await service.deleteDuckdbSnapshot(snapshot.snapshotPath)
          await service.closeDuckdbService({checkpointBeforeClose: false})
        `,
      ],
      {
        cwd: process.cwd(),
        env: {...process.env, DUCKDB_DATA_ROOT: dataRoot, DUCKDB_PATH: duckdbPath, SERVER_ROLE: 'maintenance-worker'},
      },
    )

    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString())
    }

    const parsed = JSON.parse(result.stdout.toString().trim()) as {
      rows: readonly {value: number}[]
      snapshotWalExists: boolean
    }

    expect(parsed.rows).toEqual([{value: 42}])
    expect(parsed.snapshotWalExists).toBe(false)
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
    removePathIfExists(dataRoot)
  }
})

test('duckdb service reuses the same embedded runtime across module reloads', async () => {
  const duckdbPath = `/tmp/f1-duckdb-service-reload-${Date.now()}.duckdb`
  const duckdbInstance = await DuckDBInstance.create(duckdbPath)
  const connection = await duckdbInstance.connect()

  await connection.run('CREATE SCHEMA app; CREATE TABLE app.sample (id VARCHAR PRIMARY KEY, value INTEGER NOT NULL);')
  connection.closeSync()
  duckdbInstance.closeSync()

  try {
    const result = globalThis.Bun.spawnSync(
      [
        'bun',
        '-e',
        `
          const first = await import('./src/server/utils/duckdbService.ts?reload=first')
          const [firstRow] = await first.runDuckdbJsonQuery('SELECT 1 AS value')
          const second = await import('./src/server/utils/duckdbService.ts?reload=second')
          const [secondRow] = await second.runDuckdbJsonQuery('SELECT 2 AS value')
          console.log(JSON.stringify({firstRow, secondRow}))
          await second.closeDuckdbService()
        `,
      ],
      {cwd: process.cwd(), env: {...process.env, DUCKDB_PATH: duckdbPath, SERVER_ROLE: 'maintenance-worker'}},
    )

    if (result.exitCode !== 0) {
      throw new Error(
        result.stderr.toString() || result.stdout.toString() || 'Failed to test DuckDB service reload reuse',
      )
    }

    const parsed = JSON.parse(result.stdout.toString()) as {firstRow: {value: number}; secondRow: {value: number}}

    expect(parsed).toEqual({firstRow: {value: 1}, secondRow: {value: 2}})
  } finally {
    removeFileIfExists(duckdbPath)
  }
})

test('duckdb service can close and reopen the database cleanly', async () => {
  const duckdbPath = `/tmp/f1-duckdb-service-reopen-${Date.now()}.duckdb`
  const duckdbInstance = await DuckDBInstance.create(duckdbPath)
  const connection = await duckdbInstance.connect()

  await connection.run('CREATE SCHEMA app; CREATE TABLE app.sample (id VARCHAR PRIMARY KEY, value INTEGER NOT NULL);')
  connection.closeSync()
  duckdbInstance.closeSync()

  try {
    const result = globalThis.Bun.spawnSync(
      [
        'bun',
        '-e',
        `
          const duckdbService = await import('./src/server/utils/duckdbService.ts?reload=' + Date.now())
          await duckdbService.runDuckdbStatement("INSERT INTO app.sample (id, value) VALUES ('a', 1)")
          await duckdbService.closeDuckdbService()
          const [row] = await duckdbService.runDuckdbJsonQuery("SELECT COUNT(*) AS total FROM app.sample")
          console.log(JSON.stringify({row}))
          await duckdbService.closeDuckdbService()
        `,
      ],
      {cwd: process.cwd(), env: {...process.env, DUCKDB_PATH: duckdbPath, SERVER_ROLE: 'maintenance-worker'}},
    )

    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString() || result.stdout.toString() || 'Failed to test DuckDB service reopen')
    }

    const parsed = JSON.parse(result.stdout.toString()) as {row: {total: string}}

    expect(parsed).toEqual({row: {total: '1'}})
  } finally {
    removeFileIfExists(duckdbPath)
  }
})

test('duckdb service checkpoints before close', () => {
  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const serverRuntimeRoleModulePath = new URL('./src/server/utils/serverRuntimeRole.ts', 'file://' + process.cwd() + '/').pathname
        const runStatements = []

        void mock.module(serverRuntimeRoleModulePath, () => {
          return {
            canCurrentServerOwnDuckdb: () => true,
            ensureCurrentDuckdbOwnerLease: async () => {},
            registerDuckdbOwnerDemotionHandler: () => {},
            releaseCurrentDuckdbOwnerLease: async () => {},
          }
        })

        void mock.module('@duckdb/node-api', () => {
          class MockConnection {
            async run(statement) {
              runStatements.push(statement)
            }
            async runAndReadAll() {
              return {
                getRowObjectsJson() {
                  return [{value: 1}]
                },
              }
            }
            interrupt() {}
            closeSync() {}
          }

          class MockInstance {
            static async create() {
              return new MockInstance()
            }

            async connect() {
              return new MockConnection()
            }

            closeSync() {}
          }

          return {DuckDBConnection: MockConnection, DuckDBInstance: MockInstance}
        })

        const duckdbService = await import('./src/server/utils/duckdbService.ts?checkpoint-close-test=' + Date.now())
        await duckdbService.runDuckdbJsonQuery('SELECT 1 AS value')
        await duckdbService.closeDuckdbService()
        console.log(JSON.stringify({runStatements}))
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: '3999',
        DUCKDB_MEMORY_LIMIT: '20GB',
        DUCKDB_PATH: '/tmp/f1-duckdb-service-checkpoint-close-test.duckdb',
        DUCKDB_TEMP_DIRECTORY: '/tmp/f1-duckdb-service-checkpoint-close-test-temp',
        RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
        RUN_SERVER_FULL_TEXT_FETCHING: 'false',
        SERVER_ROLE: 'maintenance-worker',
        SERVER_DUCKDB_OWNER_URL: '',
        VITE_PORT: '3000',
      },
    },
  )

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || result.stdout.toString() || 'DuckDB checkpoint close subprocess failed')
  }

  const parsed = JSON.parse(result.stdout.toString()) as {runStatements: string[]}

  expect(parsed.runStatements).toEqual(['CHECKPOINT'])
})

test('duckdb service runs only low-memory safe startup mutation preflight on low-memory workers', () => {
  const dataRoot = join(tmpdir(), `f1-duckdb-service-low-memory-safe-preflight-${Date.now()}`)
  const duckdbPath = join(dataRoot, 'test.duckdb')

  mkdirSync(dataRoot, {recursive: true})
  writeFileSync(duckdbPath, 'database')

  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {Buffer} = await import('node:buffer')
        const {mock} = await import('bun:test')

        const serverRuntimeRoleModulePath = new URL('./src/server/utils/serverRuntimeRole.ts', 'file://' + process.cwd() + '/').pathname

        let createCount = 0
        let preflightCount = 0
        let preflightSpecs = []
        const preflightSpecsHistory = []
        const originalSpawnSync = globalThis.Bun.spawnSync

        globalThis.Bun.spawnSync = ((command, options) => {
          if (!String(command[0]).includes('bun') || command[1] !== '-e') {
            return originalSpawnSync(command, options)
          }

          preflightCount += 1
          preflightSpecs = JSON.parse(String(command[5] ?? '[]'))
          preflightSpecsHistory.push(preflightSpecs)

          return {
            exitCode: 0,
            signalCode: null,
            stdout: Buffer.from(''),
            stderr: Buffer.from(''),
          }
        })

        void mock.module(serverRuntimeRoleModulePath, () => {
          return {
            canCurrentServerOwnDuckdb: () => true,
            ensureCurrentDuckdbOwnerLease: async () => {},
            registerDuckdbOwnerDemotionHandler: () => {},
            releaseCurrentDuckdbOwnerLease: async () => {},
          }
        })

        void mock.module('@duckdb/node-api', () => {
          class MockConnection {
            async run() {}
            async runAndReadAll() {
              return {
                getRowObjectsJson() {
                  return [{value: 1}]
                },
              }
            }
            interrupt() {}
            closeSync() {}
          }

          class MockInstance {
            static async create() {
              createCount += 1
              return new MockInstance()
            }

            async connect() {
              return new MockConnection()
            }

            closeSync() {}
          }

          return {DuckDBConnection: MockConnection, DuckDBInstance: MockInstance}
        })

        const duckdbService = await import('./src/server/utils/duckdbService.ts?low-memory-safe-preflight-test=' + Date.now())
        const rows = await duckdbService.runDuckdbJsonQuery('SELECT 1 AS value')
        console.log(JSON.stringify({createCount, preflightCount, preflightSpecs, rows}))
        await duckdbService.closeDuckdbService()
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: '3999',
        DUCKDB_MEMORY_LIMIT: '6400MiB',
        DUCKDB_PATH: duckdbPath,
        DUCKDB_TEMP_DIRECTORY: join(dataRoot, 'duckdb-temp'),
        RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
        RUN_SERVER_FULL_TEXT_FETCHING: 'false',
        SERVER_ROLE: 'maintenance-worker',
        SERVER_DUCKDB_OWNER_URL: '',
        VITE_PORT: '3000',
      },
    },
  )

  try {
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString() || result.stdout.toString() || 'DuckDB low-memory safe preflight failed')
    }

    const parsed = JSON.parse(result.stdout.toString().trim().split('\n').at(-1) ?? '{}') as {
      createCount: number
      preflightCount: number
      preflightSpecs: Array<{schemaName: string; tableName: string}>
      rows: Array<{value: number}>
    }

    expect(parsed.preflightCount).toBe(1)
    expect(
      parsed.preflightSpecs.map((spec) => {
        return `${spec.schemaName}.${spec.tableName}`
      }),
    ).toEqual(['app.review_rebuild_chunk_manifest'])
    expect(parsed.createCount).toBe(1)
    expect(parsed.rows).toEqual([{value: 1}])
  } finally {
    removePathIfExists(dataRoot)
  }
})

test('duckdb service keeps targeted startup preflight recovery on low-memory workers', () => {
  const dataRoot = join(tmpdir(), `f1-duckdb-service-low-memory-preflight-marker-${Date.now()}`)
  const duckdbPath = join(dataRoot, 'test.duckdb')
  const recoveryDirectory = duckdbPath + '.startup-recovery'
  const activeRepairSpecPath = join(recoveryDirectory, 'startup-preflight-active-table.json')

  mkdirSync(recoveryDirectory, {recursive: true})
  writeFileSync(duckdbPath, 'database')
  writeFileSync(`${duckdbPath}.wal`, 'committed-wal')
  writeFileSync(activeRepairSpecPath, JSON.stringify({schemaName: 'app', tableName: 'review_serving_dirty_work'}))

  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {Buffer} = await import('node:buffer')
        const {existsSync, readdirSync} = await import('node:fs')
        const {mock} = await import('bun:test')

        const activeRepairSpecPath = ${JSON.stringify(activeRepairSpecPath)}
        const serverRuntimeRoleModulePath = new URL('./src/server/utils/serverRuntimeRole.ts', 'file://' + process.cwd() + '/').pathname

        let createCount = 0
        let preflightCount = 0
        let preflightSpecs = []
        const preflightSpecsHistory = []
        const originalSpawnSync = globalThis.Bun.spawnSync

        globalThis.Bun.spawnSync = ((command, options) => {
          if (!String(command[0]).includes('bun') || command[1] !== '-e') {
            return originalSpawnSync(command, options)
          }

          preflightCount += 1
          preflightSpecs = JSON.parse(String(command[5] ?? '[]'))
          preflightSpecsHistory.push(preflightSpecs)

          return {
            exitCode: 0,
            signalCode: null,
            stdout: Buffer.from(''),
            stderr: Buffer.from(''),
          }
        })

        void mock.module(serverRuntimeRoleModulePath, () => {
          return {
            canCurrentServerOwnDuckdb: () => true,
            ensureCurrentDuckdbOwnerLease: async () => {},
            registerDuckdbOwnerDemotionHandler: () => {},
            releaseCurrentDuckdbOwnerLease: async () => {},
          }
        })

        void mock.module('@duckdb/node-api', () => {
          class MockConnection {
            async run() {}
            async runAndReadAll() {
              return {
                getRowObjectsJson() {
                  return [{value: 1}]
                },
              }
            }
            interrupt() {}
            closeSync() {}
          }

          class MockInstance {
            static async create() {
              createCount += 1
              return new MockInstance()
            }

            async connect() {
              return new MockConnection()
            }

            closeSync() {}
          }

          return {DuckDBConnection: MockConnection, DuckDBInstance: MockInstance}
        })

        const duckdbService = await import('./src/server/utils/duckdbService.ts?low-memory-preflight-marker-test=' + Date.now())
        const rows = await duckdbService.runDuckdbJsonQuery('SELECT 1 AS value')
        console.log(JSON.stringify({activeMarkerExists: existsSync(activeRepairSpecPath), createCount, preflightCount, preflightSpecs, preflightSpecsHistory, recoveryFiles: readdirSync(${JSON.stringify(recoveryDirectory)}), rows, walExists: existsSync(${JSON.stringify(`${duckdbPath}.wal`)})}))
        await duckdbService.closeDuckdbService()
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: '3999',
        DUCKDB_MEMORY_LIMIT: '6400MiB',
        DUCKDB_PATH: duckdbPath,
        DUCKDB_TEMP_DIRECTORY: join(dataRoot, 'duckdb-temp'),
        RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
        RUN_SERVER_FULL_TEXT_FETCHING: 'false',
        SERVER_ROLE: 'maintenance-worker',
        SERVER_DUCKDB_OWNER_URL: '',
        VITE_PORT: '3000',
      },
    },
  )

  try {
    if (result.exitCode !== 0) {
      throw new Error(
        result.stderr.toString() || result.stdout.toString() || 'DuckDB low-memory targeted preflight failed',
      )
    }

    const parsed = JSON.parse(result.stdout.toString()) as {
      activeMarkerExists: boolean
      createCount: number
      preflightCount: number
      preflightSpecs: Array<{schemaName: string; tableName: string}>
      preflightSpecsHistory: Array<Array<{schemaName: string; tableName: string}>>
      recoveryFiles: string[]
      rows: Array<{value: number}>
      walExists: boolean
    }

    expect(parsed.preflightCount).toBe(2)
    expect(
      parsed.preflightSpecsHistory[1]?.map((spec) => {
        return `${spec.schemaName}.${spec.tableName}`
      }),
    ).toEqual(['app.review_serving_dirty_work'])
    expect(parsed.activeMarkerExists).toBe(false)
    expect(
      parsed.recoveryFiles.some((fileName) => {
        return fileName.endsWith('.failed-replay.wal')
      }),
    ).toBe(false)
    expect(parsed.walExists).toBe(true)
    expect(parsed.createCount).toBe(1)
    expect(parsed.rows).toEqual([{value: 1}])
  } finally {
    removePathIfExists(dataRoot)
  }
})

test('duckdb service marks startup repair after fatal index-delete runtime recovery', () => {
  const dataRoot = join(tmpdir(), `f1-duckdb-service-fatal-index-marker-${Date.now()}`)
  const duckdbPath = join(dataRoot, 'test.duckdb')
  const activeRepairSpecPath = join(`${duckdbPath}.startup-recovery`, 'startup-preflight-active-table.json')

  mkdirSync(dataRoot, {recursive: true})
  writeFileSync(duckdbPath, 'database')

  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {Buffer} = await import('node:buffer')
        const {existsSync, readFileSync} = await import('node:fs')
        const {mock} = await import('bun:test')

        const activeRepairSpecPath = ${JSON.stringify(activeRepairSpecPath)}
        const serverRuntimeRoleModulePath = new URL('./src/server/utils/serverRuntimeRole.ts', 'file://' + process.cwd() + '/').pathname

        let createCount = 0
        let runCount = 0
        const originalSpawnSync = globalThis.Bun.spawnSync

        globalThis.Bun.spawnSync = ((command, options) => {
          if (!String(command[0]).includes('bun') || command[1] !== '-e') {
            return originalSpawnSync(command, options)
          }

          if (String(command[5] ?? '').startsWith('[')) {
            return {
              exitCode: 1,
              signalCode: null,
              stdout: Buffer.from(''),
              stderr: Buffer.from('forced repair failure'),
            }
          }

          return {
            exitCode: 0,
            signalCode: null,
            stdout: Buffer.from(''),
            stderr: Buffer.from(''),
          }
        })

        void mock.module(serverRuntimeRoleModulePath, () => {
          return {
            canCurrentServerOwnDuckdb: () => true,
            ensureCurrentDuckdbOwnerLease: async () => {},
            registerDuckdbOwnerDemotionHandler: () => {},
            releaseCurrentDuckdbOwnerLease: async () => {},
          }
        })

        void mock.module('@duckdb/node-api', () => {
          class MockConnection {
            async run(statement) {
              runCount += 1
              throw new Error('FATAL Error: Failed: database has been invalidated because of a previous fatal error. The database must be restarted prior to being used again. FatalException: Invalid Input Error: Failed to delete all rows from index. Only deleted 0 out of 1 rows.')
            }
            async runAndReadAll() {
              return {
                getRowObjectsJson() {
                  return [{value: 1}]
                },
              }
            }
            interrupt() {}
            closeSync() {}
          }

          class MockInstance {
            static async create() {
              createCount += 1
              return new MockInstance()
            }

            async connect() {
              return new MockConnection()
            }

            closeSync() {}
          }

          return {DuckDBConnection: MockConnection, DuckDBInstance: MockInstance}
        })

        const duckdbService = await import('./src/server/utils/duckdbService.ts?fatal-index-marker-test=' + Date.now())
        await duckdbService.runDuckdbJsonQuery('SELECT 1 AS value')
        await duckdbService.recoverDuckdbServiceAfterFatalError(
          new Error('FatalException: Invalid Input Error: Failed to delete all rows from index in mart.review_article_serving_v4. Only deleted 0 out of 1 rows.'),
        )

        const marker = existsSync(activeRepairSpecPath) ? JSON.parse(readFileSync(activeRepairSpecPath, 'utf8')) : null
        console.log(JSON.stringify({createCount, marker, runCount}))
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: '3999',
        DUCKDB_MEMORY_LIMIT: '20GB',
        DUCKDB_PATH: duckdbPath,
        DUCKDB_TEMP_DIRECTORY: join(dataRoot, 'duckdb-temp'),
        FORSKA_DUCKDB_STARTUP_WAL_PREFLIGHT: 'false',
        RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
        RUN_SERVER_FULL_TEXT_FETCHING: 'false',
        SERVER_ROLE: 'maintenance-worker',
        SERVER_DUCKDB_OWNER_URL: '',
        VITE_PORT: '3000',
      },
    },
  )

  try {
    if (result.exitCode !== 0) {
      throw new Error(
        result.stderr.toString() || result.stdout.toString() || 'DuckDB fatal index marker subprocess failed',
      )
    }

    const parsed = JSON.parse(result.stdout.toString()) as {
      createCount: number
      marker: {phase: string; schemaName: string; tableName: string} | null
      runCount: number
    }

    expect(parsed.marker).toEqual({
      phase: 'runtime-fatal-index-delete',
      schemaName: 'mart',
      tableName: 'review_article_serving_v4',
    })
    expect(parsed.createCount).toBeGreaterThanOrEqual(0)
    expect(parsed.runCount).toBeGreaterThanOrEqual(0)
  } finally {
    removePathIfExists(dataRoot)
  }
})

test('duckdb service retries startup after a recoverable WAL replay failure', () => {
  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const serverRuntimeRoleModulePath = new URL('./src/server/utils/serverRuntimeRole.ts', 'file://' + process.cwd() + '/').pathname

        let createCount = 0

        void mock.module(serverRuntimeRoleModulePath, () => {
          return {
            canCurrentServerOwnDuckdb: () => true,
            ensureCurrentDuckdbOwnerLease: async () => {},
            registerDuckdbOwnerDemotionHandler: () => {},
            releaseCurrentDuckdbOwnerLease: async () => {},
          }
        })

        void mock.module('@duckdb/node-api', () => {
          class MockConnection {
            async run() {}
            async runAndReadAll() {
              return {
                getRowObjectsJson() {
                  return [{value: 1}]
                },
              }
            }
            interrupt() {}
            closeSync() {}
          }

          class MockInstance {
            static async create() {
              createCount += 1

              if (createCount === 1) {
                throw new Error('INTERNAL Error: Failure while replaying WAL file "/tmp/test.duckdb.wal": Calling DatabaseManager::GetDefaultDatabase with no default database set')
              }

              return new MockInstance()
            }

            async connect() {
              return new MockConnection()
            }

            closeSync() {}
          }

          return {DuckDBConnection: MockConnection, DuckDBInstance: MockInstance}
        })

        const duckdbService = await import('./src/server/utils/duckdbService.ts?retry-test=' + Date.now())
        const rows = await duckdbService.runDuckdbJsonQuery('SELECT 1 AS value')
        console.log(JSON.stringify({createCount, rows}))
        await duckdbService.closeDuckdbService()
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: '3999',
        DUCKDB_MEMORY_LIMIT: '20GB',
        DUCKDB_PATH: '/tmp/f1-duckdb-service-retry-test.duckdb',
        DUCKDB_TEMP_DIRECTORY: '/tmp/f1-duckdb-service-retry-test-temp',
        RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
        RUN_SERVER_FULL_TEXT_FETCHING: 'false',
        SERVER_ROLE: 'maintenance-worker',
        SERVER_DUCKDB_OWNER_URL: '',
        VITE_PORT: '3000',
      },
    },
  )

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || result.stdout.toString() || 'DuckDB startup retry subprocess failed')
  }

  const parsed = JSON.parse(result.stdout.toString()) as {createCount: number; rows: Array<{value: number}>}

  expect(parsed).toEqual({createCount: 2, rows: [{value: 1}]})
})

test('duckdb service quarantines a WAL that repeatedly fails replay during startup', async () => {
  const dataRoot = join(tmpdir(), `f1-duckdb-service-wal-recovery-${Date.now()}`)
  const duckdbPath = join(dataRoot, 'test.duckdb')

  mkdirSync(dataRoot, {recursive: true})
  const duckdbInstance = await DuckDBInstance.create(duckdbPath)
  duckdbInstance.closeSync()
  writeFileSync(`${duckdbPath}.wal`, 'wal')

  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {existsSync, readdirSync} = await import('node:fs')
        const {mock} = await import('bun:test')

        const duckdbPath = ${JSON.stringify(duckdbPath)}
        const serverRuntimeRoleModulePath = new URL('./src/server/utils/serverRuntimeRole.ts', 'file://' + process.cwd() + '/').pathname

        let createCount = 0

        void mock.module(serverRuntimeRoleModulePath, () => {
          return {
            canCurrentServerOwnDuckdb: () => true,
            ensureCurrentDuckdbOwnerLease: async () => {},
            registerDuckdbOwnerDemotionHandler: () => {},
            releaseCurrentDuckdbOwnerLease: async () => {},
          }
        })

        void mock.module('@duckdb/node-api', () => {
          class MockConnection {
            async run() {}
            async runAndReadAll() {
              return {
                getRowObjectsJson() {
                  return [{value: 1}]
                },
              }
            }
            interrupt() {}
            closeSync() {}
          }

          class MockInstance {
            static async create() {
              createCount += 1

              if (createCount <= 2) {
                throw new Error('INTERNAL Error: Failure while replaying WAL file "' + duckdbPath + '.wal": Calling DatabaseManager::GetDefaultDatabase with no default database set')
              }

              return new MockInstance()
            }

            async connect() {
              return new MockConnection()
            }

            closeSync() {}
          }

          return {DuckDBConnection: MockConnection, DuckDBInstance: MockInstance}
        })

        const duckdbService = await import('./src/server/utils/duckdbService.ts?wal-recovery-test=' + Date.now())
        const rows = await duckdbService.runDuckdbJsonQuery('SELECT 1 AS value')
        const recoveryDirectory = duckdbPath + '.startup-recovery'
        const recoveryFiles = existsSync(recoveryDirectory) ? readdirSync(recoveryDirectory).sort() : []
        console.log(JSON.stringify({createCount, recoveryFiles, rows, walExists: existsSync(duckdbPath + '.wal')}))
        await duckdbService.closeDuckdbService()
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: '3999',
        DUCKDB_MEMORY_LIMIT: '20GB',
        DUCKDB_PATH: duckdbPath,
        DUCKDB_TEMP_DIRECTORY: join(dataRoot, 'duckdb-temp'),
        RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
        RUN_SERVER_FULL_TEXT_FETCHING: 'false',
        SERVER_ROLE: 'maintenance-worker',
        SERVER_DUCKDB_OWNER_URL: '',
        VITE_PORT: '3000',
      },
    },
  )

  try {
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString() || result.stdout.toString() || 'DuckDB WAL recovery subprocess failed')
    }

    const parsed = JSON.parse(result.stdout.toString()) as {
      createCount: number
      recoveryFiles: string[]
      rows: Array<{value: number}>
      walExists: boolean
    }

    expect(parsed.createCount).toBe(3)
    expect(parsed.rows).toEqual([{value: 1}])
    expect(parsed.walExists).toBe(false)
    expect(
      parsed.recoveryFiles.filter((fileName) => {
        return fileName.endsWith('.duckdb')
      }),
    ).toHaveLength(1)
    expect(
      parsed.recoveryFiles.filter((fileName) => {
        return fileName.endsWith('.failed-replay.wal')
      }),
    ).toHaveLength(1)
  } finally {
    removePathIfExists(dataRoot)
  }
})

test('duckdb service preflights startup WAL replay in a child before opening in-process', () => {
  const dataRoot = join(tmpdir(), `f1-duckdb-service-wal-preflight-${Date.now()}`)
  const duckdbPath = join(dataRoot, 'test.duckdb')

  mkdirSync(dataRoot, {recursive: true})
  writeFileSync(duckdbPath, 'database')
  writeFileSync(`${duckdbPath}.wal`, 'wal')

  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {Buffer} = await import('node:buffer')
        const {existsSync, readdirSync, readFileSync, writeFileSync} = await import('node:fs')
        const {mock} = await import('bun:test')

        const duckdbPath = ${JSON.stringify(duckdbPath)}
        const serverRuntimeRoleModulePath = new URL('./src/server/utils/serverRuntimeRole.ts', 'file://' + process.cwd() + '/').pathname

        let createCount = 0
        let preflightCount = 0
        const preflightSpecsHistory = []
        const originalSpawnSync = globalThis.Bun.spawnSync

        globalThis.Bun.spawnSync = ((command, options) => {
          if (!String(command[0]).includes('bun') || command[1] !== '-e') {
            return originalSpawnSync(command, options)
          }

          preflightCount += 1
          preflightSpecsHistory.push(JSON.parse(String(command[5] ?? '[]')))

          return preflightCount === 1
            ? {
                exitCode: 5,
                signalCode: 'SIGTRAP',
                stdout: Buffer.from(''),
                stderr: Buffer.from('native WAL replay crash'),
              }
            : {
                exitCode: 0,
                signalCode: null,
                stdout: Buffer.from(''),
                stderr: Buffer.from(''),
              }
        })

        void mock.module(serverRuntimeRoleModulePath, () => {
          return {
            canCurrentServerOwnDuckdb: () => true,
            ensureCurrentDuckdbOwnerLease: async () => {},
            registerDuckdbOwnerDemotionHandler: () => {},
            releaseCurrentDuckdbOwnerLease: async () => {},
          }
        })

        void mock.module('@duckdb/node-api', () => {
          class MockConnection {
            async run() {}
            async runAndReadAll() {
              return {
                getRowObjectsJson() {
                  return [{value: 1}]
                },
              }
            }
            interrupt() {}
            closeSync() {}
          }

          class MockInstance {
            static async create() {
              createCount += 1
              return new MockInstance()
            }

            async connect() {
              return new MockConnection()
            }

            closeSync() {}
          }

          return {DuckDBConnection: MockConnection, DuckDBInstance: MockInstance}
        })

        const duckdbService = await import('./src/server/utils/duckdbService.ts?wal-preflight-test=' + Date.now())
        const rows = await duckdbService.runDuckdbJsonQuery('SELECT 1 AS value')
        const recoveryDirectory = duckdbPath + '.startup-recovery'
        const recoveryFiles = existsSync(recoveryDirectory) ? readdirSync(recoveryDirectory).sort() : []
        const manifestName = recoveryFiles.find((fileName) => fileName.endsWith('.recovery.json'))
        const manifest = manifestName ? JSON.parse(readFileSync(recoveryDirectory + '/' + manifestName, 'utf8')) : null
        console.log(JSON.stringify({
          createCount,
          manifest,
          preflightCount,
          preflightSpecsHistory,
          recoveryFiles,
          rows,
          walExists: existsSync(duckdbPath + '.wal'),
        }))
        await duckdbService.closeDuckdbService()
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: '3999',
        DUCKDB_MEMORY_LIMIT: '20GB',
        DUCKDB_PATH: duckdbPath,
        DUCKDB_TEMP_DIRECTORY: join(dataRoot, 'duckdb-temp'),
        RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
        RUN_SERVER_FULL_TEXT_FETCHING: 'false',
        SERVER_ROLE: 'maintenance-worker',
        SERVER_DUCKDB_OWNER_URL: '',
        VITE_PORT: '3000',
      },
    },
  )

  try {
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString() || result.stdout.toString() || 'DuckDB WAL preflight subprocess failed')
    }

    const parsed = JSON.parse(result.stdout.toString()) as {
      createCount: number
      manifest: {error?: string; preservedDatabasePath?: string; recovery?: string; walQuarantinePath?: string} | null
      preflightCount: number
      preflightSpecsHistory: Array<Array<{schemaName: string; tableName: string}>>
      recoveryFiles: string[]
      rows: Array<{value: number}>
      walExists: boolean
    }

    expect(parsed.preflightCount).toBe(2)
    expect(parsed.preflightSpecsHistory[0]).toEqual([])
    expect(
      parsed.preflightSpecsHistory[1]?.map((spec) => {
        return `${spec.schemaName}.${spec.tableName}`
      }),
    ).toContain('app.review_rebuild_request')
    expect(parsed.createCount).toBe(1)
    expect(parsed.rows).toEqual([{value: 1}])
    expect(parsed.walExists).toBe(false)
    expect(parsed.manifest?.recovery).toBe('wal-quarantine-retry-from-last-checkpoint')
    expect(parsed.manifest?.error).toContain('native WAL replay crash')
    expect(
      parsed.recoveryFiles.filter((fileName) => {
        return fileName.endsWith('.duckdb')
      }),
    ).toHaveLength(1)
    expect(
      parsed.recoveryFiles.filter((fileName) => {
        return fileName.endsWith('.failed-replay.wal')
      }),
    ).toHaveLength(1)
    expect(
      parsed.recoveryFiles.filter((fileName) => {
        return fileName.endsWith('.recovery.json')
      }),
    ).toHaveLength(1)
  } finally {
    removePathIfExists(dataRoot)
  }
})

test('duckdb service retries startup WAL preflight locks without quarantining WAL', () => {
  const dataRoot = join(tmpdir(), `f1-duckdb-service-wal-preflight-lock-${Date.now()}`)
  const duckdbPath = join(dataRoot, 'test.duckdb')

  mkdirSync(dataRoot, {recursive: true})
  writeFileSync(duckdbPath, 'database')
  writeFileSync(`${duckdbPath}.wal`, 'wal')

  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {Buffer} = await import('node:buffer')
        const {existsSync, readdirSync, writeFileSync} = await import('node:fs')
        const {mock} = await import('bun:test')

        const duckdbPath = ${JSON.stringify(duckdbPath)}
        const serverRuntimeRoleModulePath = new URL('./src/server/utils/serverRuntimeRole.ts', 'file://' + process.cwd() + '/').pathname

        let createCount = 0
        let preflightCount = 0
        const preflightSpecsHistory = []
        const originalSpawnSync = globalThis.Bun.spawnSync

        globalThis.Bun.spawnSync = ((command, options) => {
          if (!String(command[0]).includes('bun') || command[1] !== '-e') {
            return originalSpawnSync(command, options)
          }

          const script = String(command[2] ?? '')

          if (!script.includes('const tableRepairSpecs')) {
            return originalSpawnSync(command, options)
          }

          preflightCount += 1
          preflightSpecsHistory.push(JSON.parse(String(command[5] ?? '[]')))

          return preflightCount < 3
            ? {
                exitCode: 1,
                signalCode: null,
                stdout: Buffer.from(''),
                stderr: Buffer.from(
                  'IO Error: Could not set lock on file "' + duckdbPath + '": Conflicting lock is held in bun (PID 12345) by user fredrik.',
                ),
              }
            : {
                exitCode: 0,
                signalCode: null,
                stdout: Buffer.from(''),
                stderr: Buffer.from(''),
              }
        })

        void mock.module(serverRuntimeRoleModulePath, () => {
          return {
            canCurrentServerOwnDuckdb: () => true,
            ensureCurrentDuckdbOwnerLease: async () => {},
            registerDuckdbOwnerDemotionHandler: () => {},
            releaseCurrentDuckdbOwnerLease: async () => {},
          }
        })

        void mock.module('@duckdb/node-api', () => {
          class MockConnection {
            async run() {}
            async runAndReadAll() {
              return {
                getRowObjectsJson() {
                  return [{value: 1}]
                },
              }
            }
            interrupt() {}
            closeSync() {}
          }

          class MockInstance {
            static async create() {
              createCount += 1
              return new MockInstance()
            }

            async connect() {
              return new MockConnection()
            }

            closeSync() {}
          }

          return {DuckDBConnection: MockConnection, DuckDBInstance: MockInstance}
        })

        const duckdbService = await import('./src/server/utils/duckdbService.ts?wal-preflight-lock-test=' + Date.now())
        const rows = await duckdbService.runDuckdbJsonQuery('SELECT 1 AS value')
        const recoveryDirectory = duckdbPath + '.startup-recovery'
        const recoveryFiles = existsSync(recoveryDirectory) ? readdirSync(recoveryDirectory).sort() : []
        console.log(JSON.stringify({
          createCount,
          preflightCount,
          preflightSpecsHistory,
          recoveryFiles,
          rows,
          walExists: existsSync(duckdbPath + '.wal'),
        }))
        await duckdbService.closeDuckdbService()
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: '3999',
        DUCKDB_MEMORY_LIMIT: '20GB',
        DUCKDB_PATH: duckdbPath,
        DUCKDB_TEMP_DIRECTORY: join(dataRoot, 'duckdb-temp'),
        RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
        RUN_SERVER_FULL_TEXT_FETCHING: 'false',
        SERVER_ROLE: 'maintenance-worker',
        SERVER_DUCKDB_OWNER_URL: '',
        VITE_PORT: '3000',
      },
    },
  )

  try {
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString() || result.stdout.toString() || 'DuckDB WAL lock retry subprocess failed')
    }

    const parsed = JSON.parse(result.stdout.toString()) as {
      createCount: number
      preflightCount: number
      preflightSpecsHistory: Array<Array<{schemaName: string; tableName: string}>>
      recoveryFiles: string[]
      rows: Array<{value: number}>
      walExists: boolean
    }

    expect(parsed.preflightCount).toBeGreaterThanOrEqual(3)
    expect(
      parsed.preflightSpecsHistory.every((specs) => {
        return specs.length === 0
      }),
    ).toBe(true)
    expect(parsed.createCount).toBe(1)
    expect(parsed.rows).toEqual([{value: 1}])
    expect(parsed.walExists).toBe(true)
    expect(parsed.recoveryFiles).toEqual([])
  } finally {
    removePathIfExists(dataRoot)
  }
})

test('duckdb service preserves recovery attempts after startup WAL preflight lock retries', () => {
  const dataRoot = join(tmpdir(), `f1-duckdb-service-wal-preflight-lock-recovery-${Date.now()}`)
  const duckdbPath = join(dataRoot, 'test.duckdb')

  mkdirSync(dataRoot, {recursive: true})
  writeFileSync(duckdbPath, 'database')
  writeFileSync(`${duckdbPath}.wal`, 'wal')

  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {Buffer} = await import('node:buffer')
        const {existsSync, readdirSync, readFileSync, writeFileSync} = await import('node:fs')
        const {mock} = await import('bun:test')

        const duckdbPath = ${JSON.stringify(duckdbPath)}
        const serverRuntimeRoleModulePath = new URL('./src/server/utils/serverRuntimeRole.ts', 'file://' + process.cwd() + '/').pathname

        let createCount = 0
        let preflightCount = 0
        const originalSpawnSync = globalThis.Bun.spawnSync

        globalThis.Bun.spawnSync = ((command, options) => {
          if (!String(command[0]).includes('bun') || command[1] !== '-e') {
            return originalSpawnSync(command, options)
          }

          const script = String(command[2] ?? '')

          if (!script.includes('const tableRepairSpecs')) {
            return originalSpawnSync(command, options)
          }

          preflightCount += 1

          if (preflightCount <= 4) {
            return {
              exitCode: 1,
              signalCode: null,
              stdout: Buffer.from(''),
              stderr: Buffer.from(
                'IO Error: Could not set lock on file "' + duckdbPath + '": Conflicting lock is held in bun (PID 12345) by user fredrik.',
              ),
            }
          }

          return preflightCount === 5
            ? {
                exitCode: 5,
                signalCode: 'SIGTRAP',
                stdout: Buffer.from(''),
                stderr: Buffer.from('native WAL replay crash after lock cleared'),
              }
            : {
                exitCode: 0,
                signalCode: null,
                stdout: Buffer.from(''),
                stderr: Buffer.from(''),
              }
        })

        void mock.module(serverRuntimeRoleModulePath, () => {
          return {
            canCurrentServerOwnDuckdb: () => true,
            ensureCurrentDuckdbOwnerLease: async () => {},
            registerDuckdbOwnerDemotionHandler: () => {},
            releaseCurrentDuckdbOwnerLease: async () => {},
          }
        })

        void mock.module('@duckdb/node-api', () => {
          class MockConnection {
            async run() {}
            async runAndReadAll() {
              return {
                getRowObjectsJson() {
                  return [{value: 1}]
                },
              }
            }
            interrupt() {}
            closeSync() {}
          }

          class MockInstance {
            static async create() {
              createCount += 1
              return new MockInstance()
            }

            async connect() {
              return new MockConnection()
            }

            closeSync() {}
          }

          return {DuckDBConnection: MockConnection, DuckDBInstance: MockInstance}
        })

        const duckdbService = await import('./src/server/utils/duckdbService.ts?wal-preflight-lock-recovery-test=' + Date.now())
        const rows = await duckdbService.runDuckdbJsonQuery('SELECT 1 AS value')
        const recoveryDirectory = duckdbPath + '.startup-recovery'
        const recoveryFiles = existsSync(recoveryDirectory) ? readdirSync(recoveryDirectory).sort() : []
        const manifestName = recoveryFiles.find((fileName) => fileName.endsWith('.recovery.json'))
        const manifest = manifestName ? JSON.parse(readFileSync(recoveryDirectory + '/' + manifestName, 'utf8')) : null
        console.log(JSON.stringify({
          createCount,
          manifest,
          preflightCount,
          recoveryFiles,
          rows,
          walExists: existsSync(duckdbPath + '.wal'),
        }))
        await duckdbService.closeDuckdbService()
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: '3999',
        DUCKDB_MEMORY_LIMIT: '20GB',
        DUCKDB_PATH: duckdbPath,
        DUCKDB_TEMP_DIRECTORY: join(dataRoot, 'duckdb-temp'),
        RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
        RUN_SERVER_FULL_TEXT_FETCHING: 'false',
        SERVER_ROLE: 'maintenance-worker',
        SERVER_DUCKDB_OWNER_URL: '',
        VITE_PORT: '3000',
      },
    },
  )

  try {
    if (result.exitCode !== 0) {
      throw new Error(
        result.stderr.toString() || result.stdout.toString() || 'DuckDB WAL lock recovery subprocess failed',
      )
    }

    const parsed = JSON.parse(result.stdout.toString()) as {
      createCount: number
      manifest: {error?: string; recovery?: string} | null
      preflightCount: number
      recoveryFiles: string[]
      rows: Array<{value: number}>
      walExists: boolean
    }

    expect(parsed.preflightCount).toBe(6)
    expect(parsed.createCount).toBe(1)
    expect(parsed.rows).toEqual([{value: 1}])
    expect(parsed.walExists).toBe(false)
    expect(parsed.manifest?.recovery).toBe('wal-quarantine-retry-from-last-checkpoint')
    expect(parsed.manifest?.error).toContain('native WAL replay crash after lock cleared')
    expect(
      parsed.recoveryFiles.filter((fileName) => {
        return fileName.endsWith('.duckdb')
      }),
    ).toHaveLength(1)
    expect(
      parsed.recoveryFiles.filter((fileName) => {
        return fileName.endsWith('.failed-replay.wal')
      }),
    ).toHaveLength(1)
  } finally {
    removePathIfExists(dataRoot)
  }
})

test('duckdb service retries transient startup indexed-table repair locks', () => {
  const dataRoot = join(tmpdir(), `f1-duckdb-service-index-repair-${Date.now()}`)
  const duckdbPath = join(dataRoot, 'test.duckdb')

  mkdirSync(dataRoot, {recursive: true})
  writeFileSync(duckdbPath, 'database')

  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {Buffer} = await import('node:buffer')
        const {existsSync, readdirSync, readFileSync, writeFileSync} = await import('node:fs')
        const {mock} = await import('bun:test')

        const duckdbPath = ${JSON.stringify(duckdbPath)}
        const serverRuntimeRoleModulePath = new URL('./src/server/utils/serverRuntimeRole.ts', 'file://' + process.cwd() + '/').pathname

        let createCount = 0
        let preflightCount = 0
        let firstPreflightSpecs = []
        let preflightScript = ''
        let preflightSpecs = []
        let repairSpecs = []
        let repairOptions = null
        let repairCount = 0
        let repairLockProbeCount = 0
        let repairScript = ''
        const originalSpawnSync = globalThis.Bun.spawnSync

        globalThis.Bun.spawnSync = ((command, options) => {
          if (!String(command[0]).includes('bun') || command[1] !== '-e') {
            return originalSpawnSync(command, options)
          }

          const script = String(command[2] ?? '')

          if (options?.env?.FORSKA_DUCKDB_STARTUP_LOCK_PROBE_CHILD === 'true') {
            repairLockProbeCount += 1

            return repairLockProbeCount === 1
              ? {
                  exitCode: 1,
                  signalCode: null,
                  stdout: Buffer.from(''),
                  stderr: Buffer.from((
                    writeFileSync(duckdbPath, 'database-after-lock-holder'),
                    'IO Error: Could not set lock on file "' + duckdbPath + '": Conflicting lock is held in bun (PID 12345) by user fredrik.'
                  )),
                }
              : {
                  exitCode: 0,
                  signalCode: null,
                  stdout: Buffer.from(''),
                  stderr: Buffer.from(''),
                }
          }

          if (script.includes('const repairId')) {
            repairCount += 1
            repairScript = script
            repairOptions = JSON.parse(String(command[4] ?? '{}'))
            repairSpecs = JSON.parse(String(command[5] ?? '[]'))

            return {
              exitCode: 0,
              signalCode: null,
              stdout: Buffer.from(''),
              stderr: Buffer.from(''),
            }
          }

          preflightCount += 1
          preflightScript = script
          preflightSpecs = JSON.parse(String(command[5] ?? '[]'))
          if (preflightCount === 1) {
            firstPreflightSpecs = preflightSpecs
          }
          const activeRepairSpecPath = JSON.parse(String(command[6] ?? '""'))

          return preflightCount === 1
            ? {
                exitCode: 5,
                signalCode: 'SIGTRAP',
                stdout: Buffer.from(''),
                stderr: Buffer.from((
                  writeFileSync(activeRepairSpecPath, JSON.stringify({
                    schemaName: 'mart',
                    tableName: 'review_article_judgment_detail_serving_v4',
                  })),
                  writeFileSync(duckdbPath + '.wal', 'probe wal'),
                  'PRIMARY_review_article_judgment_detail_serving_v4 duplicate key'
                )),
              }
            : {
                exitCode: 0,
                signalCode: null,
                stdout: Buffer.from(''),
                stderr: Buffer.from(''),
              }
        })

        void mock.module(serverRuntimeRoleModulePath, () => {
          return {
            canCurrentServerOwnDuckdb: () => true,
            ensureCurrentDuckdbOwnerLease: async () => {},
            registerDuckdbOwnerDemotionHandler: () => {},
            releaseCurrentDuckdbOwnerLease: async () => {},
          }
        })

        void mock.module('@duckdb/node-api', () => {
          class MockConnection {
            async run() {}
            async runAndReadAll() {
              return {
                getRowObjectsJson() {
                  return [{value: 1}]
                },
              }
            }
            interrupt() {}
            closeSync() {}
          }

          class MockInstance {
            static async create() {
              createCount += 1
              return new MockInstance()
            }

            async connect() {
              return new MockConnection()
            }

            closeSync() {}
          }

          return {DuckDBConnection: MockConnection, DuckDBInstance: MockInstance}
        })

        const duckdbService = await import('./src/server/utils/duckdbService.ts?index-repair-test=' + Date.now())
        const rows = await duckdbService.runDuckdbJsonQuery('SELECT 1 AS value')
        const recoveryDirectory = duckdbPath + '.startup-recovery'
        const recoveryFiles = existsSync(recoveryDirectory) ? readdirSync(recoveryDirectory).sort() : []
        const manifests = recoveryFiles
          .filter((fileName) => fileName.endsWith('.recovery.json'))
          .map((fileName) => JSON.parse(readFileSync(recoveryDirectory + '/' + fileName, 'utf8')))
        const repairManifest = manifests.find((manifest) => manifest.recovery === 'indexed-table-rebuild') ?? null
        const repairBackupContent =
          repairManifest?.preservedDatabasePath === undefined
            ? null
            : readFileSync(repairManifest.preservedDatabasePath, 'utf8')
        const preflightWalManifest =
          manifests.find((manifest) => manifest.recovery === 'startup-preflight-mutation-wal-quarantine') ?? null
        console.log(JSON.stringify({
          createCount,
          firstPreflightSpecs,
          preflightCount,
          preflightScript,
          preflightSpecs,
          preflightWalManifest,
          recoveryFiles,
          repairBackupContent,
          repairCount,
          repairLockProbeCount,
          repairManifest,
          repairOptions,
          repairScript,
          repairSpecs,
          rows,
          walExists: existsSync(duckdbPath + '.wal'),
        }))
        await duckdbService.closeDuckdbService()
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: '3999',
        DUCKDB_MEMORY_LIMIT: '20GB',
        DUCKDB_PATH: duckdbPath,
        DUCKDB_TEMP_DIRECTORY: join(dataRoot, 'duckdb-temp'),
        RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
        RUN_SERVER_FULL_TEXT_FETCHING: 'false',
        SERVER_ROLE: 'maintenance-worker',
        SERVER_DUCKDB_OWNER_URL: '',
        VITE_PORT: '3000',
      },
    },
  )

  try {
    if (result.exitCode !== 0) {
      throw new Error(
        result.stderr.toString() || result.stdout.toString() || 'DuckDB indexed-table repair subprocess failed',
      )
    }

    const parsed = JSON.parse(result.stdout.toString()) as {
      createCount: number
      firstPreflightSpecs: Array<{
        lowMemoryStartupPreflight?: boolean
        mutationProbeSql?: string
        postRepairSql?: string
        postRepairSchemaRequirements?: Array<{columnNames?: string[]; schemaName: string; tableName: string}>
        repairPrimaryKeyColumns?: string[]
        repairStrategy?: string
        schemaRequirements?: Array<{columnNames?: string[]; schemaName: string; tableName: string}>
        schemaName: string
        tableName: string
      }>
      preflightWalManifest: {error?: string; recovery?: string; walQuarantinePath?: string} | null
      preflightCount: number
      preflightScript: string
      preflightSpecs: Array<{
        lowMemoryStartupPreflight?: boolean
        mutationProbeSql?: string
        postRepairSql?: string
        postRepairSchemaRequirements?: Array<{columnNames?: string[]; schemaName: string; tableName: string}>
        repairPrimaryKeyColumns?: string[]
        repairStrategy?: string
        schemaRequirements?: Array<{columnNames?: string[]; schemaName: string; tableName: string}>
        schemaName: string
        tableName: string
      }>
      recoveryFiles: string[]
      repairBackupContent: string | null
      repairCount: number
      repairLockProbeCount: number
      repairManifest: {
        error?: string
        preservedDatabasePath?: string
        recovery?: string
        repairedTables?: string[]
      } | null
      repairOptions: {checkpoint_threshold?: string} | null
      repairScript: string
      repairSpecs: Array<{schemaName: string; tableName: string}>
      rows: Array<{value: number}>
      walExists: boolean
    }

    expect(parsed.preflightCount).toBe(1)
    expect(parsed.repairLockProbeCount).toBe(2)
    expect(parsed.repairCount).toBe(1)
    expect(parsed.createCount).toBe(1)
    expect(parsed.rows).toEqual([{value: 1}])
    expect(parsed.walExists).toBe(false)
    expect(parsed.preflightWalManifest?.recovery).toBe('startup-preflight-mutation-wal-quarantine')
    expect(parsed.preflightWalManifest?.error).toContain('PRIMARY_review_article_judgment_detail_serving_v4')
    expect(parsed.repairManifest?.recovery).toBe('indexed-table-rebuild')
    expect(parsed.repairManifest?.error).toContain('PRIMARY_review_article_judgment_detail_serving_v4')
    expect(parsed.repairManifest?.repairedTables).toEqual(['mart.review_article_judgment_detail_serving_v4'])
    expect(parsed.repairBackupContent).toBe('database-after-lock-holder')
    expect(parsed.repairOptions?.checkpoint_threshold).toBe('8GB')
    expect(parsed.repairScript).not.toContain("await connection.run('CHECKPOINT')")
    expect(parsed.repairScript).toContain("spec.repairStrategy !== 'empty-derived'")
    expect(parsed.repairScript).toContain('spec.postRepairSql')
    expect(parsed.repairScript).toContain('stripInlinePrimaryKeyConstraints')
    expect(parsed.repairScript).toContain('getRepairPrimaryKeyIndexSql')
    expect(parsed.repairScript).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_')
    expect(
      parsed.repairSpecs.map((spec) => {
        return {schemaName: spec.schemaName, tableName: spec.tableName}
      }),
    ).toEqual([{schemaName: 'mart', tableName: 'review_article_judgment_detail_serving_v4'}])
    expect(
      parsed.preflightSpecs.map((spec) => {
        return {schemaName: spec.schemaName, tableName: spec.tableName}
      }),
    ).toContainEqual({schemaName: 'mart', tableName: 'review_article_judgment_detail_serving_v4'})
    const articleServingProbe = parsed.firstPreflightSpecs.find((spec) => {
      return spec.schemaName === 'mart' && spec.tableName === 'review_article_serving_v4'
    })
    expect(articleServingProbe?.mutationProbeSql).toContain('Failed to delete all rows from index')
    expect(articleServingProbe?.mutationProbeSql).toContain('app.review_rebuild_chunk_manifest')
    expect(articleServingProbe?.mutationProbeSql).toContain('INSERT INTO mart.review_article_serving_v4 BY NAME')
    const selectedImportProbe = parsed.firstPreflightSpecs.find((spec) => {
      return spec.schemaName === 'app' && spec.tableName === 'review_selected_article_import_v4'
    })
    expect(selectedImportProbe?.mutationProbeSql).toContain("projection_component = 'selectedImport'")
    expect(selectedImportProbe?.mutationProbeSql).toContain('INSERT INTO app.review_selected_article_import_v4 BY NAME')
    const rebuildRequestProbe = parsed.firstPreflightSpecs.find((spec) => {
      return spec.schemaName === 'app' && spec.tableName === 'review_rebuild_request'
    })
    expect(rebuildRequestProbe?.lowMemoryStartupPreflight).toBeUndefined()
    expect(rebuildRequestProbe?.repairPrimaryKeyColumns).toEqual(['request_id'])
    expect(rebuildRequestProbe?.mutationProbeSql).toContain('UPDATE app.review_rebuild_request')
    expect(rebuildRequestProbe?.mutationProbeSql).toContain('startup_probe_review_rebuild_request')
    const chunkManifestProbe = parsed.firstPreflightSpecs.find((spec) => {
      return spec.schemaName === 'app' && spec.tableName === 'review_rebuild_chunk_manifest'
    })
    expect(chunkManifestProbe?.lowMemoryStartupPreflight).toBe(true)
    expect(chunkManifestProbe?.repairPrimaryKeyColumns).toEqual(['chunk_id'])
    expect(chunkManifestProbe?.mutationProbeSql).toContain("chunk.status IN ('pending', 'failed', 'running')")
    expect(chunkManifestProbe?.mutationProbeSql).toContain('LIMIT 64')
    expect(chunkManifestProbe?.mutationProbeSql).toContain("WHEN 'llmStatus' THEN 4")
    expect(chunkManifestProbe?.mutationProbeSql).not.toContain("chunk.projection_component = 'projectScope'")
    expect(chunkManifestProbe?.schemaRequirements).toContainEqual({
      columnNames: ['admission_state', 'request_id', 'retry_after'],
      schemaName: 'app',
      tableName: 'review_rebuild_chunk_manifest',
    })
    expect(chunkManifestProbe?.schemaRequirements).toContainEqual({
      columnNames: ['admission_state', 'priority', 'request_id', 'status'],
      schemaName: 'app',
      tableName: 'review_rebuild_request',
    })
    expect(parsed.preflightScript).toContain('schemaRequirementsSatisfied(spec.schemaRequirements)')
    expect(parsed.preflightScript).toContain('needsInlinePrimaryKeyRepairBeforeMutation')
    expect(parsed.preflightScript).toContain('inline-primary-key-repair')
    const judgmentDetailProbe = parsed.firstPreflightSpecs.find((spec) => {
      return spec.schemaName === 'mart' && spec.tableName === 'review_article_judgment_detail_serving_v4'
    })
    expect(judgmentDetailProbe?.mutationProbeSql).toContain("projection_component = 'judgmentInputContent'")
    expect(judgmentDetailProbe?.mutationProbeSql).toContain('Failed to delete all rows from index')
    expect(judgmentDetailProbe?.mutationProbeSql).toContain(
      'INSERT INTO mart.review_article_judgment_detail_serving_v4 BY NAME',
    )
    const legacyPatchProbeTables = parsed.firstPreflightSpecs
      .filter((spec) => {
        return (
          spec.schemaName === 'mart' && spec.tableName.startsWith('review_') && spec.tableName.endsWith('_patch_v4')
        )
      })
      .map((spec) => {
        return spec.tableName
      })
    expect(legacyPatchProbeTables).toEqual([])
    expect(
      parsed.recoveryFiles.filter((fileName) => {
        return fileName.endsWith('.pre-repair.duckdb')
      }),
    ).toHaveLength(1)
    expect(
      parsed.recoveryFiles.filter((fileName) => {
        return fileName.endsWith('.failed-startup-probe.wal')
      }),
    ).toHaveLength(1)
    expect(
      parsed.recoveryFiles.filter((fileName) => {
        return fileName.endsWith('.recovery.json')
      }),
    ).toHaveLength(2)
  } finally {
    removePathIfExists(dataRoot)
  }
})

test('duckdb service restarts and retries after a fatal invalidation error', () => {
  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const serverRuntimeRoleModulePath = new URL('./src/server/utils/serverRuntimeRole.ts', 'file://' + process.cwd() + '/').pathname

        let createCount = 0
        let firstReadInvalidated = false
        const runStatements = []

        void mock.module(serverRuntimeRoleModulePath, () => {
          return {
            canCurrentServerOwnDuckdb: () => true,
            ensureCurrentDuckdbOwnerLease: async () => {},
            registerDuckdbOwnerDemotionHandler: () => {},
            releaseCurrentDuckdbOwnerLease: async () => {},
          }
        })

        void mock.module('@duckdb/node-api', () => {
          class MockConnection {
            constructor(instanceId) {
              this.instanceId = instanceId
            }

            async run(statement) {
              if (statement === 'CHECKPOINT' && this.instanceId === 1) {
                throw new Error('recovery checkpoint should not run')
              }

              runStatements.push(this.instanceId + ':' + statement)
            }

            async runAndReadAll() {
              if (!firstReadInvalidated && this.instanceId === 1) {
                firstReadInvalidated = true
                throw new Error(
                  'FATAL Error: Failed: database has been invalidated because of a previous fatal error. The database must be restarted prior to being used again.',
                )
              }

              return {
                getRowObjectsJson() {
                  return [{value: 1}]
                },
              }
            }

            interrupt() {}
            closeSync() {}
          }

          class MockInstance {
            static async create() {
              createCount += 1
              return new MockInstance(createCount)
            }

            constructor(instanceId) {
              this.instanceId = instanceId
            }

            async connect() {
              return new MockConnection(this.instanceId)
            }

            closeSync() {}
          }

          return {DuckDBConnection: MockConnection, DuckDBInstance: MockInstance}
        })

        const duckdbService = await import('./src/server/utils/duckdbService.ts?fatal-restart-test=' + Date.now())
        const rows = await duckdbService.runDuckdbJsonQuery('SELECT 1 AS value')
        await duckdbService.closeDuckdbService()
        console.log(JSON.stringify({createCount, rows, runStatements}))
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: '3999',
        DUCKDB_MEMORY_LIMIT: '20GB',
        DUCKDB_PATH: '/tmp/f1-duckdb-service-fatal-restart-test.duckdb',
        DUCKDB_TEMP_DIRECTORY: '/tmp/f1-duckdb-service-fatal-restart-test-temp',
        RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
        RUN_SERVER_FULL_TEXT_FETCHING: 'false',
        SERVER_ROLE: 'maintenance-worker',
        SERVER_DUCKDB_OWNER_URL: '',
        VITE_PORT: '3000',
      },
    },
  )

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || result.stdout.toString() || 'DuckDB fatal restart subprocess failed')
  }

  const parsed = JSON.parse(result.stdout.toString()) as {
    createCount: number
    rows: Array<{value: number}>
    runStatements: string[]
  }

  expect(parsed).toEqual({createCount: 2, rows: [{value: 1}], runStatements: ['2:CHECKPOINT']})
})
