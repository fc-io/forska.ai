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

type StartupRepairSpecJson = {
  lowMemoryStartupPreflight?: boolean
  mutationProbeSql?: string
  postRepairDependencySpecs?: Array<{columnNames?: string[]; schemaName: string; tableName: string}>
  postRepairSql?: string
  postRepairSchemaRequirements?: Array<{columnNames?: string[]; schemaName: string; tableName: string}>
  recreateRepairPrimaryKeyIndex?: boolean
  recreateSecondaryIndexes?: boolean
  repairPrimaryKeyColumns?: string[]
  repairStrategy?: string
  schemaName: string
  schemaRequirements?: Array<{columnNames?: string[]; schemaName: string; tableName: string}>
  tableName: string
}

type DuckdbReloadSubprocessResult = {
  activeMarkerExists: boolean
  checkpointCount: number
  createCount: number
  errorMessage: string | null
  failedPreflightWalExists: boolean
  firstPreflightSpecs: StartupRepairSpecJson[]
  firstRow: {value: number}
  manifest: {error?: string; recovery?: string; walQuarantinePath?: string} | null
  marker: {
    phase: string
    reason?: string
    repairSpecs?: Array<{schemaName: string; tableName: string}>
    schemaName: string
    tableName: string
  } | null
  preflightCount: number
  preflightDatabasePaths: string[]
  preflightScript: string
  preflightSpecs: StartupRepairSpecJson[]
  preflightSpecsHistory: StartupRepairSpecJson[][]
  preflightWalManifest: {error?: string; recovery?: string; walQuarantinePath?: string} | null
  recoveryFiles: string[]
  repairBackupContent: string | null
  repairCount: number
  repairLockProbeCount: number
  repairManifest: {
    error?: string
    preservedDatabasePath?: string
    recovery?: string
    repairedTables?: string[]
    repairMarker?: {
      phase?: string
      repairSpecs?: Array<{schemaName: string; tableName: string}>
      schemaName?: string
      tableName?: string
    } | null
  } | null
  repairOptions: {checkpoint_threshold?: string} | null
  repairScript: string
  repairSpecs: Array<{schemaName: string; tableName: string}>
  row: {total: string}
  rows: Array<Record<string, number | string>>
  runCount: number
  runStatements: string[]
  secondRow: {value: number}
  snapshotWalExists: boolean
  walExists: boolean
}

const parseJsonSubprocessStdout = <T>(stdout: string): T => {
  const jsonLine = stdout
    .trim()
    .split('\n')
    .reverse()
    .find((line) => {
      return line.trim().startsWith('{') || line.trim().startsWith('[')
    })

  if (jsonLine === undefined) {
    throw new Error(`Subprocess stdout did not contain JSON: ${stdout}`)
  }

  return JSON.parse(jsonLine) as T
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

  const parsed = parseJsonSubprocessStdout<DuckdbReloadSubprocessResult>(result.stdout.toString())

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

    const parsed = parseJsonSubprocessStdout<DuckdbReloadSubprocessResult>(result.stdout.toString())

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

    const parsed = parseJsonSubprocessStdout<DuckdbReloadSubprocessResult>(result.stdout.toString())

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

  const parsed = parseJsonSubprocessStdout<DuckdbReloadSubprocessResult>(result.stdout.toString())

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
    ).toEqual([
      'app.review_projection_identity_manifest',
      'app.review_serving_projector_watermark',
      'app.review_serving_dirty_work',
      'app.review_serving_snapshot_manifest',
      'app.comparison_project_serving_generation',
      'app.review_serving_dirty_work_ack',
      'app.review_selected_import_snapshot',
      'app.review_selected_article_import_v4',
      'app.review_rebuild_chunk_manifest',
      'mart.review_article_count_serving_v4',
      'mart.review_filtered_count_serving_v4',
      'mart.review_filter_facet_serving_v4',
      'mart.review_filter_option_serving_v4',
      'mart.review_article_judgment_detail_serving_v4',
      'mart.review_title_search_serving_v4',
      'mart.review_unassessed_queue_serving_v4',
      'mart.review_article_filter_posting_serving_v4',
    ])
    expect(parsed.createCount).toBe(1)
    expect(parsed.rows).toEqual([{value: 1}])
  } finally {
    removePathIfExists(dataRoot)
  }
})

test('duckdb service skips compact filter posting startup repair before compact migration is applied', async () => {
  const dataRoot = join(tmpdir(), `f1-duckdb-service-precompact-filter-posting-preflight-${Date.now()}`)
  const duckdbPath = join(dataRoot, 'test.duckdb')

  mkdirSync(dataRoot, {recursive: true})

  const duckdbInstance = await DuckDBInstance.create(duckdbPath)
  const connection = await duckdbInstance.connect()
  await connection.run('CREATE SCHEMA mart')
  await connection.run(`
    CREATE TABLE mart.review_article_filter_posting_serving_v4 (
      project_id VARCHAR,
      review_config_hash VARCHAR,
      snapshot_id VARCHAR,
      filter_kind VARCHAR,
      filter_value VARCHAR,
      list_mode_key VARCHAR,
      article_id VARCHAR,
      PRIMARY KEY(project_id, review_config_hash, snapshot_id, filter_kind, filter_value, list_mode_key, article_id)
    )
  `)
  await connection.run(`
    INSERT INTO mart.review_article_filter_posting_serving_v4 VALUES
      ('project-1', 'review-config-1', 'snapshot-1', 'promptAnswer', 'answer:yes', 'llm', 'article-1'),
      ('project-1', 'review-config-1', 'snapshot-1', 'promptAnswer', 'answer:yes', 'llm', 'article-2')
  `)
  await connection.run('CHECKPOINT')
  connection.closeSync()
  duckdbInstance.closeSync()

  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const serverRuntimeRoleModulePath = new URL('./src/server/utils/serverRuntimeRole.ts', 'file://' + process.cwd() + '/').pathname

        void mock.module(serverRuntimeRoleModulePath, () => {
          return {
            canCurrentServerOwnDuckdb: () => true,
            ensureCurrentDuckdbOwnerLease: async () => {},
            registerDuckdbOwnerDemotionHandler: () => {},
            releaseCurrentDuckdbOwnerLease: async () => {},
          }
        })

        const duckdbService = await import('./src/server/utils/duckdbService.ts?precompact-filter-posting-preflight-test=' + Date.now())
        const rows = await duckdbService.runDuckdbJsonQuery('SELECT COUNT(*) AS total FROM mart.review_article_filter_posting_serving_v4')
        console.log(JSON.stringify({rows}))
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
        result.stderr.toString() || result.stdout.toString() || 'DuckDB precompact posting preflight failed',
      )
    }

    const parsed = parseJsonSubprocessStdout<DuckdbReloadSubprocessResult>(result.stdout.toString())

    expect(parsed.rows).toEqual([{total: '2'}])
  } finally {
    removePathIfExists(dataRoot)
  }
})

test('duckdb service skips compact unassessed queue startup repair before compact migration is applied', async () => {
  const dataRoot = join(tmpdir(), `f1-duckdb-service-precompact-queue-preflight-${Date.now()}`)
  const duckdbPath = join(dataRoot, 'test.duckdb')

  mkdirSync(dataRoot, {recursive: true})

  const duckdbInstance = await DuckDBInstance.create(duckdbPath)
  const connection = await duckdbInstance.connect()
  await connection.run('CREATE SCHEMA mart')
  await connection.run(`
    CREATE TABLE mart.review_unassessed_queue_serving_v4 (
      project_id VARCHAR,
      review_config_hash VARCHAR,
      snapshot_id VARCHAR,
      queue_kind VARCHAR,
      priority_bucket INTEGER,
      activity_sort_at TIMESTAMPTZ,
      article_id VARCHAR,
      prompt_id VARCHAR,
      queue_updated_at TIMESTAMPTZ,
      PRIMARY KEY(project_id, review_config_hash, snapshot_id, queue_kind, priority_bucket, activity_sort_at, article_id, prompt_id)
    )
  `)
  await connection.run(`
    INSERT INTO mart.review_unassessed_queue_serving_v4 VALUES
      ('project-1', 'review-config-1', 'snapshot-1', 'unassessed', 1, TIMESTAMPTZ '2026-01-01T00:00:00Z', 'article-1', 'prompt-1', TIMESTAMPTZ '2026-01-01T00:00:00Z'),
      ('project-1', 'review-config-1', 'snapshot-1', 'unassessed', 1, TIMESTAMPTZ '2026-01-01T00:00:00Z', 'article-1', 'prompt-2', TIMESTAMPTZ '2026-01-01T00:00:00Z')
  `)
  await connection.run('CHECKPOINT')
  connection.closeSync()
  duckdbInstance.closeSync()

  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const serverRuntimeRoleModulePath = new URL('./src/server/utils/serverRuntimeRole.ts', 'file://' + process.cwd() + '/').pathname

        void mock.module(serverRuntimeRoleModulePath, () => {
          return {
            canCurrentServerOwnDuckdb: () => true,
            ensureCurrentDuckdbOwnerLease: async () => {},
            registerDuckdbOwnerDemotionHandler: () => {},
            releaseCurrentDuckdbOwnerLease: async () => {},
          }
        })

        const duckdbService = await import('./src/server/utils/duckdbService.ts?precompact-queue-preflight-test=' + Date.now())
        const rows = await duckdbService.runDuckdbJsonQuery('SELECT COUNT(*) AS total FROM mart.review_unassessed_queue_serving_v4')
        console.log(JSON.stringify({rows}))
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
        result.stderr.toString() || result.stdout.toString() || 'DuckDB precompact queue preflight failed',
      )
    }

    const parsed = parseJsonSubprocessStdout<DuckdbReloadSubprocessResult>(result.stdout.toString())

    expect(parsed.rows).toEqual([{total: '2'}])
  } finally {
    removePathIfExists(dataRoot)
  }
})

test('duckdb service skips summary count startup repair before list-mode schema is applied', async () => {
  const dataRoot = join(tmpdir(), `f1-duckdb-service-pre-list-mode-summary-count-repair-${Date.now()}`)
  const duckdbPath = join(dataRoot, 'test.duckdb')
  const recoveryDirectory = `${duckdbPath}.startup-recovery`
  const activeRepairSpecPath = join(recoveryDirectory, 'startup-preflight-active-table.json')

  mkdirSync(recoveryDirectory, {recursive: true})

  const duckdbInstance = await DuckDBInstance.create(duckdbPath)
  const connection = await duckdbInstance.connect()
  await connection.run('CREATE SCHEMA mart')
  await connection.run(`
    CREATE TABLE mart.review_article_count_serving_v4 (
      project_id VARCHAR,
      review_config_hash VARCHAR,
      snapshot_id VARCHAR,
      count_kind VARCHAR,
      summary_definition_version VARCHAR,
      filter_key VARCHAR,
      count_value BIGINT,
      availability VARCHAR,
      stale_reason VARCHAR,
      count_updated_at TIMESTAMPTZ,
      PRIMARY KEY(project_id, review_config_hash, snapshot_id, count_kind, summary_definition_version, filter_key)
    )
  `)
  await connection.run(`
    INSERT INTO mart.review_article_count_serving_v4 VALUES (
      'project-1',
      'review-config-1',
      'snapshot-1',
      'review.list.total',
      'v1',
      'list:all',
      7,
      'ready',
      NULL,
      TIMESTAMPTZ '2026-01-01T00:00:00Z'
    )
  `)
  await connection.run('CHECKPOINT')
  connection.closeSync()
  duckdbInstance.closeSync()
  writeFileSync(
    activeRepairSpecPath,
    JSON.stringify({
      phase: 'inline-primary-key-repair',
      repairSpecs: [{schemaName: 'mart', tableName: 'review_article_count_serving_v4'}],
      schemaName: 'mart',
      tableName: 'review_article_count_serving_v4',
    }),
  )

  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {existsSync} = await import('node:fs')
        const {mock} = await import('bun:test')

        const activeRepairSpecPath = ${JSON.stringify(activeRepairSpecPath)}
        const serverRuntimeRoleModulePath = new URL('./src/server/utils/serverRuntimeRole.ts', 'file://' + process.cwd() + '/').pathname

        void mock.module(serverRuntimeRoleModulePath, () => {
          return {
            canCurrentServerOwnDuckdb: () => true,
            ensureCurrentDuckdbOwnerLease: async () => {},
            registerDuckdbOwnerDemotionHandler: () => {},
            releaseCurrentDuckdbOwnerLease: async () => {},
          }
        })

        const duckdbService = await import('./src/server/utils/duckdbService.ts?pre-list-mode-summary-count-repair-test=' + Date.now())
        const rows = await duckdbService.runDuckdbJsonQuery('SELECT COUNT(*) AS total FROM mart.review_article_count_serving_v4')
        const activeMarkerExists = existsSync(activeRepairSpecPath)
        console.log(JSON.stringify({activeMarkerExists, rows}))
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
        result.stderr.toString() || result.stdout.toString() || 'DuckDB pre-list-mode summary count repair failed',
      )
    }

    const parsed = parseJsonSubprocessStdout<DuckdbReloadSubprocessResult>(result.stdout.toString())

    expect(parsed.activeMarkerExists).toBe(false)
    expect(parsed.rows).toEqual([{total: '1'}])
  } finally {
    removePathIfExists(dataRoot)
  }
})

test('duckdb service keeps targeted startup preflight recovery on low-memory workers', () => {
  const dataRoot = join(tmpdir(), `f1-duckdb-service-low-memory-preflight-marker-${Date.now()}`)
  const duckdbPath = join(dataRoot, 'test.duckdb')
  const recoveryDirectory = duckdbPath + '.startup-recovery'
  const activeRepairSpecPath = join(recoveryDirectory, 'startup-preflight-active-table.json')
  const staleRecoveryPathPart = '2000-01-01T00-00-00.000Z.00000000-0000-4000-8000-000000000001'

  mkdirSync(recoveryDirectory, {recursive: true})
  writeFileSync(duckdbPath, 'database')
  writeFileSync(`${duckdbPath}.wal`, 'committed-wal')
  writeFileSync(activeRepairSpecPath, JSON.stringify({schemaName: 'app', tableName: 'review_serving_dirty_work'}))
  writeFileSync(join(recoveryDirectory, `${staleRecoveryPathPart}.pre-repair.duckdb`), 'stale-database')
  writeFileSync(join(recoveryDirectory, `${staleRecoveryPathPart}.recovery.json`), '{}')
  writeFileSync(join(recoveryDirectory, 'operator-note.json'), '{}')

  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {Buffer} = await import('node:buffer')
        const {existsSync, readdirSync, unlinkSync, writeFileSync} = await import('node:fs')
        const {mock} = await import('bun:test')

        const activeRepairSpecPath = ${JSON.stringify(activeRepairSpecPath)}
        const walPath = ${JSON.stringify(`${duckdbPath}.wal`)}
        const serverRuntimeRoleModulePath = new URL('./src/server/utils/serverRuntimeRole.ts', 'file://' + process.cwd() + '/').pathname

        let checkpointCount = 0
        let createCount = 0
        let preflightCount = 0
        const preflightSpecsHistory = []
        let repairCount = 0
        const originalSpawnSync = globalThis.Bun.spawnSync

        globalThis.Bun.spawnSync = ((command, options) => {
          if (!String(command[0]).includes('bun') || command[1] !== '-e') {
            return originalSpawnSync(command, options)
          }

          if (options?.env?.FORSKA_DUCKDB_STARTUP_LOCK_PROBE_CHILD === 'true') {
            return {
              exitCode: 0,
              signalCode: null,
              stdout: Buffer.from(''),
              stderr: Buffer.from(''),
            }
          }

          if (options?.env?.FORSKA_DUCKDB_STARTUP_INDEX_REPAIR_CHILD === 'true') {
            repairCount += 1
            return {
              exitCode: 0,
              signalCode: null,
              stdout: Buffer.from(''),
              stderr: Buffer.from(''),
            }
          }

          if (options?.env?.FORSKA_DUCKDB_STARTUP_WAL_CHECKPOINT_CHILD === 'true') {
            checkpointCount += 1
            if (existsSync(walPath)) {
              unlinkSync(walPath)
            }
            return {
              exitCode: 0,
              signalCode: null,
              stdout: Buffer.from(''),
              stderr: Buffer.from(''),
            }
          }

          if (options?.env?.FORSKA_DUCKDB_STARTUP_WAL_PREFLIGHT_CHILD === 'true') {
            preflightCount += 1
            preflightSpecsHistory.push(JSON.parse(String(command[5] ?? '[]')))

            if (preflightCount === 3) {
              writeFileSync(
                activeRepairSpecPath,
                JSON.stringify({
                  phase: 'custom-mutation-probe',
                  schemaName: 'app',
                  tableName: 'review_rebuild_chunk_manifest',
                }),
              )
              return {
                exitCode: 133,
                signalCode: 'SIGTRAP',
                stdout: Buffer.from(''),
                stderr: Buffer.from('native commit crash'),
              }
            }

            return {
              exitCode: 0,
              signalCode: null,
              stdout: Buffer.from(''),
              stderr: Buffer.from(''),
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
        console.log(JSON.stringify({activeMarkerExists: existsSync(activeRepairSpecPath), checkpointCount, createCount, preflightCount, preflightSpecsHistory, recoveryFiles: readdirSync(${JSON.stringify(recoveryDirectory)}), repairCount, rows, walExists: existsSync(walPath)}))
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

    const parsed = parseJsonSubprocessStdout<DuckdbReloadSubprocessResult>(result.stdout.toString())

    expect(parsed.preflightCount).toBe(5)
    expect(parsed.preflightSpecsHistory[0]).toEqual([])
    expect(
      parsed.preflightSpecsHistory[1]?.map((spec) => {
        return `${spec.schemaName}.${spec.tableName}`
      }),
    ).toContain('app.review_serving_dirty_work')
    expect(
      parsed.preflightSpecsHistory[3]?.map((spec) => {
        return `${spec.schemaName}.${spec.tableName}`
      }),
    ).toEqual(['app.review_rebuild_chunk_manifest'])
    expect(parsed.activeMarkerExists).toBe(false)
    expect(parsed.checkpointCount).toBe(1)
    expect(parsed.repairCount).toBe(2)
    expect(
      parsed.recoveryFiles.filter((fileName) => {
        return fileName.endsWith('.pre-repair.duckdb')
      }),
    ).toHaveLength(1)
    expect(
      parsed.recoveryFiles.filter((fileName) => {
        return fileName.endsWith('.recovery.json')
      }),
    ).toHaveLength(1)
    expect(parsed.recoveryFiles).toContain('operator-note.json')
    expect(
      parsed.recoveryFiles.some((fileName) => {
        return fileName.startsWith(staleRecoveryPathPart)
      }),
    ).toBe(false)
    expect(
      parsed.recoveryFiles.some((fileName) => {
        return fileName.endsWith('.failed-replay.wal')
      }),
    ).toBe(false)
    expect(parsed.walExists).toBe(false)
    expect(parsed.createCount).toBe(1)
    expect(parsed.rows).toEqual([{value: 1}])
  } finally {
    removePathIfExists(dataRoot)
  }
})

test('duckdb service repairs persisted mutation-probe markers before running another probe', () => {
  const dataRoot = join(tmpdir(), `f1-duckdb-service-stale-mutation-marker-${Date.now()}`)
  const duckdbPath = join(dataRoot, 'test.duckdb')
  const recoveryDirectory = duckdbPath + '.startup-recovery'
  const activeRepairSpecPath = join(recoveryDirectory, 'startup-preflight-active-table.json')

  mkdirSync(recoveryDirectory, {recursive: true})
  writeFileSync(duckdbPath, 'database')
  writeFileSync(
    activeRepairSpecPath,
    JSON.stringify({phase: 'custom-mutation-probe', schemaName: 'app', tableName: 'review_serving_dirty_work'}),
  )

  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {Buffer} = await import('node:buffer')
        const {existsSync} = await import('node:fs')
        const {mock} = await import('bun:test')

        const activeRepairSpecPath = ${JSON.stringify(activeRepairSpecPath)}
        const serverRuntimeRoleModulePath = new URL('./src/server/utils/serverRuntimeRole.ts', 'file://' + process.cwd() + '/').pathname

        let createCount = 0
        let preflightCount = 0
        const preflightSpecsHistory = []
        let repairCount = 0
        const originalSpawnSync = globalThis.Bun.spawnSync

        globalThis.Bun.spawnSync = ((command, options) => {
          if (!String(command[0]).includes('bun') || command[1] !== '-e') {
            return originalSpawnSync(command, options)
          }

          if (options?.env?.FORSKA_DUCKDB_STARTUP_LOCK_PROBE_CHILD === 'true') {
            return {
              exitCode: 0,
              signalCode: null,
              stdout: Buffer.from(''),
              stderr: Buffer.from(''),
            }
          }

          if (options?.env?.FORSKA_DUCKDB_STARTUP_INDEX_REPAIR_CHILD === 'true') {
            repairCount += 1
            return {
              exitCode: 0,
              signalCode: null,
              stdout: Buffer.from(''),
              stderr: Buffer.from(''),
            }
          }

          if (options?.env?.FORSKA_DUCKDB_STARTUP_WAL_PREFLIGHT_CHILD === 'true') {
            preflightCount += 1
            preflightSpecsHistory.push(JSON.parse(String(command[5] ?? '[]')))
            return {
              exitCode: 0,
              signalCode: null,
              stdout: Buffer.from(''),
              stderr: Buffer.from(''),
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

        const duckdbService = await import('./src/server/utils/duckdbService.ts?stale-mutation-marker-test=' + Date.now())
        const rows = await duckdbService.runDuckdbJsonQuery('SELECT 1 AS value')
        console.log(JSON.stringify({
          activeMarkerExists: existsSync(activeRepairSpecPath),
          createCount,
          preflightCount,
          preflightSpecsHistory,
          repairCount,
          rows,
        }))
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
        result.stderr.toString() || result.stdout.toString() || 'DuckDB stale mutation marker preflight failed',
      )
    }

    const parsed = parseJsonSubprocessStdout<DuckdbReloadSubprocessResult>(result.stdout.toString())

    expect(parsed.preflightCount).toBe(2)
    expect(
      parsed.preflightSpecsHistory[0]?.map((spec) => {
        return `${spec.schemaName}.${spec.tableName}`
      }),
    ).toEqual(['app.review_serving_dirty_work'])
    expect(parsed.activeMarkerExists).toBe(false)
    expect(parsed.repairCount).toBe(1)
    expect(parsed.createCount).toBe(1)
    expect(parsed.rows).toEqual([{value: 1}])
  } finally {
    removePathIfExists(dataRoot)
  }
})

test('duckdb service checkpoints replayed WAL before indexed-table startup preflight', () => {
  const dataRoot = join(tmpdir(), `f1-duckdb-service-wal-checkpoint-preflight-${Date.now()}`)
  const duckdbPath = join(dataRoot, 'test.duckdb')
  const walPath = `${duckdbPath}.wal`

  mkdirSync(dataRoot, {recursive: true})
  writeFileSync(duckdbPath, 'database')
  writeFileSync(walPath, 'committed-wal')

  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {Buffer} = await import('node:buffer')
        const {existsSync, unlinkSync} = await import('node:fs')
        const {mock} = await import('bun:test')

        const walPath = ${JSON.stringify(walPath)}
        const serverRuntimeRoleModulePath = new URL('./src/server/utils/serverRuntimeRole.ts', 'file://' + process.cwd() + '/').pathname

        let checkpointCount = 0
        let createCount = 0
        let preflightCount = 0
        const preflightSpecsHistory = []
        const originalSpawnSync = globalThis.Bun.spawnSync

        globalThis.Bun.spawnSync = ((command, options) => {
          if (!String(command[0]).includes('bun') || command[1] !== '-e') {
            return originalSpawnSync(command, options)
          }

          const maybePreflightSpecs = command[5]

          if (typeof maybePreflightSpecs === 'string' && maybePreflightSpecs.startsWith('[')) {
            preflightCount += 1
            preflightSpecsHistory.push(JSON.parse(maybePreflightSpecs))
            return {
              exitCode: 0,
              signalCode: null,
              stdout: Buffer.from(''),
              stderr: Buffer.from(''),
            }
          }

          checkpointCount += 1
          if (existsSync(walPath)) {
            unlinkSync(walPath)
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

        const duckdbService = await import('./src/server/utils/duckdbService.ts?wal-checkpoint-preflight-test=' + Date.now())
        const rows = await duckdbService.runDuckdbJsonQuery('SELECT 1 AS value')
        console.log(JSON.stringify({checkpointCount, createCount, preflightCount, preflightSpecsHistory, rows, walExists: existsSync(walPath)}))
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
        result.stderr.toString() || result.stdout.toString() || 'DuckDB WAL checkpoint preflight subprocess failed',
      )
    }

    const parsed = parseJsonSubprocessStdout<DuckdbReloadSubprocessResult>(result.stdout.toString())

    expect(parsed.preflightCount).toBe(2)
    expect(parsed.preflightSpecsHistory[0]).toEqual([])
    expect(
      parsed.preflightSpecsHistory[1]?.map((spec) => {
        return `${spec.schemaName}.${spec.tableName}`
      }),
    ).toContain('mart.review_article_filter_posting_serving_v4')
    expect(parsed.checkpointCount).toBe(1)
    expect(parsed.walExists).toBe(false)
    expect(parsed.createCount).toBe(1)
    expect(parsed.rows).toEqual([{value: 1}])
  } finally {
    removePathIfExists(dataRoot)
  }
})

test('duckdb service startup repair strips table primary key constraints once', () => {
  const dataRoot = join(tmpdir(), `f1-duckdb-service-real-index-repair-${Date.now()}`)
  const duckdbPath = join(dataRoot, 'test.duckdb')
  const recoveryDirectory = `${duckdbPath}.startup-recovery`
  const activeRepairSpecPath = join(recoveryDirectory, 'startup-preflight-active-table.json')

  mkdirSync(recoveryDirectory, {recursive: true})
  writeFileSync(
    activeRepairSpecPath,
    JSON.stringify({
      phase: 'inline-primary-key-repair',
      repairSpecs: [{schemaName: 'app', tableName: 'review_serving_projector_watermark'}],
      schemaName: 'app',
      tableName: 'review_serving_projector_watermark',
    }),
  )

  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {existsSync, readdirSync} = await import('node:fs')
        const {mock} = await import('bun:test')
        const {DuckDBInstance} = await import('@duckdb/node-api')

        const duckdbPath = ${JSON.stringify(duckdbPath)}
        const recoveryDirectory = ${JSON.stringify(recoveryDirectory)}
        const serverRuntimeRoleModulePath = new URL('./src/server/utils/serverRuntimeRole.ts', 'file://' + process.cwd() + '/').pathname

        const getRecoveryManifestCount = () => {
          return existsSync(recoveryDirectory)
            ? readdirSync(recoveryDirectory).filter((fileName) => fileName.endsWith('.recovery.json')).length
            : 0
        }

        const getCatalogRows = async (duckdbService) => {
          const tableRows = await duckdbService.runDuckdbJsonQuery(
            "SELECT sql FROM duckdb_tables() WHERE schema_name = 'app' AND table_name = 'review_serving_projector_watermark' LIMIT 1",
          )
          const indexRows = await duckdbService.runDuckdbJsonQuery(
            "SELECT sql FROM duckdb_indexes() WHERE schema_name = 'app' AND table_name = 'review_serving_projector_watermark' ORDER BY index_name",
          )

          return {
            indexSql: indexRows.map((row) => String(row.sql ?? '')),
            tableSql: String(tableRows[0]?.sql ?? ''),
          }
        }

        void mock.module(serverRuntimeRoleModulePath, () => {
          return {
            canCurrentServerOwnDuckdb: () => true,
            ensureCurrentDuckdbOwnerLease: async () => {},
            registerDuckdbOwnerDemotionHandler: () => {},
            releaseCurrentDuckdbOwnerLease: async () => {},
          }
        })

        const instance = await DuckDBInstance.create(duckdbPath, {
          checkpoint_threshold: '64MiB',
          memory_limit: '2GB',
          preserve_insertion_order: 'false',
          threads: '1',
        })
        const connection = await instance.connect()
        await connection.run('CREATE SCHEMA app')
        await connection.run(
          'CREATE TABLE app.review_serving_projector_watermark(watermark_id VARCHAR, updated_at TIMESTAMP, PRIMARY KEY(watermark_id))',
        )
        await connection.run(
          'CREATE INDEX idx_review_serving_projector_watermark_duplicate_lookup ON app.review_serving_projector_watermark(watermark_id)',
        )
        await connection.run("INSERT INTO app.review_serving_projector_watermark VALUES ('watermark', current_timestamp)")
        await connection.run('CHECKPOINT')
        connection.closeSync()
        instance.closeSync()

        const firstDuckdbService = await import('./src/server/utils/duckdbService.ts?real-index-repair-first=' + Date.now())
        const firstCatalog = await getCatalogRows(firstDuckdbService)
        const firstManifestCount = getRecoveryManifestCount()
        await firstDuckdbService.closeDuckdbService()

        const secondDuckdbService = await import('./src/server/utils/duckdbService.ts?real-index-repair-second=' + Date.now())
        const secondCatalog = await getCatalogRows(secondDuckdbService)
        const secondManifestCount = getRecoveryManifestCount()
        const rows = await secondDuckdbService.runDuckdbJsonQuery('SELECT watermark_id FROM app.review_serving_projector_watermark')
        await secondDuckdbService.closeDuckdbService()

        console.log(JSON.stringify({firstCatalog, firstManifestCount, rows, secondCatalog, secondManifestCount}))
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
        result.stderr.toString() || result.stdout.toString() || 'DuckDB real indexed-table repair subprocess failed',
      )
    }

    expect(result.stderr.toString()).toBe('')

    const parsed = parseJsonSubprocessStdout<{
      firstCatalog: {indexSql: string[]; tableSql: string}
      firstManifestCount: number
      rows: Array<{watermark_id: string}>
      secondCatalog: {indexSql: string[]; tableSql: string}
      secondManifestCount: number
    }>(result.stdout.toString())

    expect(parsed.firstManifestCount).toBe(1)
    expect(parsed.secondManifestCount).toBe(1)
    expect(parsed.firstCatalog.tableSql).not.toMatch(/\bPRIMARY\s+KEY\b/i)
    expect(parsed.secondCatalog.tableSql).not.toMatch(/\bPRIMARY\s+KEY\b/i)
    expect(
      parsed.secondCatalog.indexSql.some((sql) => {
        return /^CREATE UNIQUE INDEX\b/i.test(sql)
      }),
    ).toBe(false)
    expect(parsed.firstCatalog.indexSql).toEqual([])
    expect(parsed.secondCatalog.indexSql).toEqual([])
    expect(parsed.secondCatalog.indexSql.join('\n')).not.toContain(
      'idx_review_serving_projector_watermark_duplicate_lookup',
    )
    expect(parsed.rows).toEqual([{watermark_id: 'watermark'}])
  } finally {
    removePathIfExists(dataRoot)
  }
})

test('duckdb service removes repaired dirty-work and selected-import indexes before mutation', () => {
  const dataRoot = join(tmpdir(), `f1-duckdb-service-dirty-work-index-removal-${Date.now()}`)
  const duckdbPath = join(dataRoot, 'test.duckdb')
  const recoveryDirectory = `${duckdbPath}.startup-recovery`

  mkdirSync(dataRoot, {recursive: true})

  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {existsSync, readdirSync} = await import('node:fs')
        const {mock} = await import('bun:test')
        const {DuckDBInstance} = await import('@duckdb/node-api')

        const duckdbPath = ${JSON.stringify(duckdbPath)}
        const recoveryDirectory = ${JSON.stringify(recoveryDirectory)}
        const serverRuntimeRoleModulePath = new URL('./src/server/utils/serverRuntimeRole.ts', 'file://' + process.cwd() + '/').pathname

        void mock.module(serverRuntimeRoleModulePath, () => {
          return {
            canCurrentServerOwnDuckdb: () => true,
            ensureCurrentDuckdbOwnerLease: async () => {},
            registerDuckdbOwnerDemotionHandler: () => {},
            releaseCurrentDuckdbOwnerLease: async () => {},
          }
        })

        const instance = await DuckDBInstance.create(duckdbPath, {
          checkpoint_threshold: '64MiB',
          memory_limit: '2GB',
          preserve_insertion_order: 'false',
          threads: '1',
        })
        const connection = await instance.connect()
        await connection.run('CREATE SCHEMA app')
        await connection.run(\`
          CREATE TABLE app.review_serving_dirty_work (
            dirty_work_id VARCHAR,
            project_id VARCHAR,
            scope_kind VARCHAR NOT NULL,
            scope_id VARCHAR NOT NULL,
            article_id VARCHAR,
            projection_key VARCHAR,
            dirty_kind VARCHAR NOT NULL,
            source_partition VARCHAR NOT NULL,
            first_source_high_water_mark BIGINT NOT NULL,
            latest_source_high_water_mark BIGINT NOT NULL,
            latest_delta_id VARCHAR,
            dirty_range_start VARCHAR,
            dirty_range_end VARCHAR,
            status VARCHAR NOT NULL DEFAULT 'pending',
            created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
          )
        \`)
        await connection.run(
          'CREATE UNIQUE INDEX idx_review_serving_dirty_work_repaired_pk_legacy ON app.review_serving_dirty_work(dirty_work_id)',
        )
        await connection.run(
          'CREATE INDEX idx_review_serving_dirty_work_lookup ON app.review_serving_dirty_work(project_id, dirty_kind, latest_source_high_water_mark)',
        )
        await connection.run(\`
          CREATE TABLE app.review_rebuild_chunk_manifest (
            chunk_id VARCHAR,
            project_id VARCHAR,
            projection_component VARCHAR,
            chunk_start_key VARCHAR,
            chunk_end_key VARCHAR,
            status VARCHAR,
            last_error VARCHAR,
            updated_at TIMESTAMPTZ
          )
        \`)
        await connection.run(\`
          CREATE TABLE app.review_selected_article_import_v4 (
            project_id VARCHAR NOT NULL,
            project_scope_identity VARCHAR NOT NULL,
            selected_import_snapshot_id VARCHAR NOT NULL,
            article_id VARCHAR NOT NULL,
            import_route_id VARCHAR,
            source_record_key VARCHAR,
            selected_rank_key VARCHAR,
            selected_rank_numeric DOUBLE,
            tombstone BOOLEAN NOT NULL DEFAULT FALSE,
            selected_import_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
          )
        \`)
        await connection.run(\`
          CREATE UNIQUE INDEX idx_review_selected_article_import_v4_repaired_pk
          ON app.review_selected_article_import_v4(
            project_id,
            project_scope_identity,
            selected_import_snapshot_id,
            article_id
          )
        \`)
        await connection.run(\`
          CREATE INDEX idx_review_selected_article_import_v4_order
          ON app.review_selected_article_import_v4(
            project_id,
            project_scope_identity,
            selected_import_snapshot_id,
            selected_rank_key,
            article_id
          )
        \`)
        await connection.run(\`
          INSERT INTO app.review_serving_dirty_work (
            dirty_work_id,
            project_id,
            scope_kind,
            scope_id,
            article_id,
            projection_key,
            dirty_kind,
            source_partition,
            first_source_high_water_mark,
            latest_source_high_water_mark,
            latest_delta_id,
            dirty_range_start,
            dirty_range_end,
            status
          ) VALUES (
            'dirty-work-1',
            'project-1',
            'article',
            'article:1',
            'article-1',
            '{"projectionComponent":"selectedImport","projectionIdentity":"selectedImport:1"}',
            'source-change',
            'import-run-article',
            1,
            2,
            'delta-1',
            'article-1',
            'article-1',
            'failed'
          )
        \`)
        await connection.run(\`
          INSERT INTO app.review_selected_article_import_v4 (
            project_id,
            project_scope_identity,
            selected_import_snapshot_id,
            article_id,
            selected_rank_key,
            selected_rank_numeric
          ) VALUES (
            'project-1',
            'project-scope-1',
            'selected-import-snapshot-1',
            'article-1',
            'rank-1',
            1
          )
        \`)
        await connection.run('CHECKPOINT')
        connection.closeSync()
        instance.closeSync()

        const duckdbService = await import('./src/server/utils/duckdbService.ts?dirty-work-index-removal=' + Date.now())
        const constraints = await duckdbService.runDuckdbJsonQuery(\`
          SELECT constraint_type AS constraintType, constraint_column_names AS columnNames
          FROM duckdb_constraints()
          WHERE schema_name = 'app'
            AND table_name = 'review_serving_dirty_work'
            AND constraint_type = 'PRIMARY KEY'
        \`)
        const indexes = await duckdbService.runDuckdbJsonQuery(\`
          SELECT index_name AS indexName
          FROM duckdb_indexes()
          WHERE schema_name = 'app'
            AND table_name = 'review_serving_dirty_work'
          ORDER BY index_name
        \`)
        const rows = await duckdbService.runDuckdbJsonQuery(\`
          SELECT dirty_work_id AS dirtyWorkId, status
          FROM app.review_serving_dirty_work
        \`)
        const selectedImportConstraints = await duckdbService.runDuckdbJsonQuery(\`
          SELECT constraint_type AS constraintType, constraint_column_names AS columnNames
          FROM duckdb_constraints()
          WHERE schema_name = 'app'
            AND table_name = 'review_selected_article_import_v4'
            AND constraint_type = 'PRIMARY KEY'
        \`)
        const selectedImportIndexes = await duckdbService.runDuckdbJsonQuery(\`
          SELECT index_name AS indexName
          FROM duckdb_indexes()
          WHERE schema_name = 'app'
            AND table_name = 'review_selected_article_import_v4'
          ORDER BY index_name
        \`)
        const selectedImportRows = await duckdbService.runDuckdbJsonQuery(\`
          SELECT project_id AS projectId, article_id AS articleId
          FROM app.review_selected_article_import_v4
        \`)
        const recoveryManifestCount = existsSync(recoveryDirectory)
          ? readdirSync(recoveryDirectory).filter((fileName) => fileName.endsWith('.recovery.json')).length
          : 0
        await duckdbService.closeDuckdbService()

        console.log(JSON.stringify({
          constraints,
          indexes,
          recoveryManifestCount,
          rows,
          selectedImportConstraints,
          selectedImportIndexes,
          selectedImportRows,
        }))
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
        result.stderr.toString() || result.stdout.toString() || 'DuckDB dirty-work index removal subprocess failed',
      )
    }

    const parsed = parseJsonSubprocessStdout<{
      constraints: Array<{columnNames: string[]; constraintType: string}>
      indexes: Array<{indexName: string}>
      recoveryManifestCount: number
      rows: Array<{dirtyWorkId: string; status: string}>
      selectedImportConstraints: Array<{columnNames: string[]; constraintType: string}>
      selectedImportIndexes: Array<{indexName: string}>
      selectedImportRows: Array<{articleId: string; projectId: string}>
    }>(result.stdout.toString())

    expect(parsed.constraints).toEqual([])
    expect(parsed.indexes).toEqual([])
    expect(parsed.recoveryManifestCount).toBe(1)
    expect(parsed.rows).toEqual([{dirtyWorkId: 'dirty-work-1', status: 'failed'}])
    expect(parsed.selectedImportConstraints).toEqual([])
    expect(parsed.selectedImportIndexes).toEqual([])
    expect(parsed.selectedImportRows).toEqual([{articleId: 'article-1', projectId: 'project-1'}])
  } finally {
    removePathIfExists(dataRoot)
  }
})

test('duckdb service startup repair rebuilds comparison serving generation as stale derived rows', () => {
  const dataRoot = join(tmpdir(), `f1-duckdb-service-comparison-generation-repair-${Date.now()}`)
  const duckdbPath = join(dataRoot, 'test.duckdb')
  const recoveryDirectory = `${duckdbPath}.startup-recovery`
  const activeRepairSpecPath = join(recoveryDirectory, 'startup-preflight-active-table.json')

  mkdirSync(recoveryDirectory, {recursive: true})
  writeFileSync(
    activeRepairSpecPath,
    JSON.stringify({
      phase: 'runtime-fatal-index-delete',
      repairSpecs: [{schemaName: 'app', tableName: 'comparison_project_serving_generation'}],
      schemaName: 'app',
      tableName: 'comparison_project_serving_generation',
    }),
  )

  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')
        const {DuckDBInstance} = await import('@duckdb/node-api')

        const duckdbPath = ${JSON.stringify(duckdbPath)}
        const serverRuntimeRoleModulePath = new URL('./src/server/utils/serverRuntimeRole.ts', 'file://' + process.cwd() + '/').pathname

        void mock.module(serverRuntimeRoleModulePath, () => {
          return {
            canCurrentServerOwnDuckdb: () => true,
            ensureCurrentDuckdbOwnerLease: async () => {},
            registerDuckdbOwnerDemotionHandler: () => {},
            releaseCurrentDuckdbOwnerLease: async () => {},
          }
        })

        const instance = await DuckDBInstance.create(duckdbPath, {
          checkpoint_threshold: '64MiB',
          memory_limit: '2GB',
          preserve_insertion_order: 'false',
          threads: '1',
        })
        const connection = await instance.connect()
        await connection.run('CREATE SCHEMA app')
        await connection.run('CREATE SCHEMA mart')
        await connection.run(
          'CREATE TABLE app.comparison_project(id VARCHAR NOT NULL PRIMARY KEY, archived BOOLEAN NOT NULL)',
        )
        await connection.run(
          'CREATE TABLE mart.comparison_article_serving(comparison_project_id VARCHAR NOT NULL, generation BIGINT NOT NULL)',
        )
        await connection.run(\`
          CREATE TABLE app.comparison_project_serving_generation(
            comparison_project_id VARCHAR NOT NULL PRIMARY KEY,
            active_generation BIGINT NOT NULL,
            generation_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
            serving_status VARCHAR DEFAULT 'missing',
            serving_generation BIGINT,
            serving_started_at TIMESTAMPTZ,
            serving_completed_at TIMESTAMPTZ,
            serving_failed_at TIMESTAMPTZ,
            serving_error VARCHAR,
            serving_phase VARCHAR,
            serving_phase_started_at TIMESTAMPTZ,
            serving_last_progressed_at TIMESTAMPTZ,
            serving_staged_article_count BIGINT DEFAULT 0,
            serving_staged_cell_count BIGINT DEFAULT 0,
            serving_staged_filter_member_count BIGINT DEFAULT 0,
            serving_staged_filter_stats_count BIGINT DEFAULT 0,
            serving_total_article_count BIGINT,
            serving_total_cell_count BIGINT
          )
        \`)
        await connection.run("INSERT INTO app.comparison_project VALUES ('comparison-active', false), ('comparison-archived', true)")
        await connection.run("INSERT INTO mart.comparison_article_serving VALUES ('comparison-active', 7)")
        await connection.run(\`
          INSERT INTO app.comparison_project_serving_generation (
            comparison_project_id,
            active_generation,
            generation_updated_at,
            serving_status,
            serving_generation,
            serving_phase,
            serving_staged_cell_count
          ) VALUES (
            'comparison-active',
            7,
            current_timestamp,
            'refreshing',
            8,
            'prompt_cells',
            123
          )
        \`)
        await connection.run('CHECKPOINT')
        connection.closeSync()
        instance.closeSync()

        const duckdbService = await import('./src/server/utils/duckdbService.ts?comparison-generation-repair=' + Date.now())
        const rows = await duckdbService.runDuckdbJsonQuery(\`
          SELECT
            comparison_project_id AS comparisonProjectId,
            CAST(active_generation AS INTEGER) AS activeGeneration,
            serving_status AS servingStatus,
            CAST(serving_generation AS INTEGER) AS servingGeneration,
            serving_phase AS servingPhase,
            CAST(serving_staged_cell_count AS INTEGER) AS servingStagedCellCount
          FROM app.comparison_project_serving_generation
          ORDER BY comparison_project_id
        \`)
        const tableRows = await duckdbService.runDuckdbJsonQuery(
          "SELECT sql FROM duckdb_tables() WHERE schema_name = 'app' AND table_name = 'comparison_project_serving_generation' LIMIT 1",
        )
        const indexRows = await duckdbService.runDuckdbJsonQuery(
          "SELECT sql FROM duckdb_indexes() WHERE schema_name = 'app' AND table_name = 'comparison_project_serving_generation' ORDER BY index_name",
        )
        await duckdbService.closeDuckdbService()

        console.log(JSON.stringify({
          indexSql: indexRows.map((row) => String(row.sql ?? '')),
          rows,
          tableSql: String(tableRows[0]?.sql ?? ''),
        }))
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
        result.stderr.toString() || result.stdout.toString() || 'DuckDB comparison generation repair failed',
      )
    }

    const parsed = parseJsonSubprocessStdout<{
      indexSql: string[]
      rows: Array<{
        activeGeneration: number
        comparisonProjectId: string
        servingGeneration: number | null
        servingPhase: string | null
        servingStagedCellCount: number
        servingStatus: string
      }>
      tableSql: string
    }>(result.stdout.toString())

    expect(parsed.tableSql).not.toMatch(/\bPRIMARY\s+KEY\b/i)
    expect(
      parsed.indexSql.some((sql) => {
        return /^CREATE UNIQUE INDEX\b/i.test(sql) && sql.includes('comparison_project_id')
      }),
    ).toBe(false)
    expect(parsed.indexSql.join('\n')).not.toMatch(/\bUNIQUE\b/i)
    expect(parsed.rows).toEqual([
      {
        activeGeneration: 7,
        comparisonProjectId: 'comparison-active',
        servingGeneration: null,
        servingPhase: null,
        servingStagedCellCount: 0,
        servingStatus: 'stale',
      },
    ])
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
          new Error('FatalException: Invalid Input Error: Failed to delete all rows from index in mart.review_article_serving_base_v4. Only deleted 0 out of 1 rows.'),
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

    const parsed = parseJsonSubprocessStdout<DuckdbReloadSubprocessResult>(result.stdout.toString())

    expect(parsed.marker).toEqual({
      phase: 'runtime-fatal-index-delete',
      reason: 'index-delete',
      repairSpecs: [{schemaName: 'mart', tableName: 'review_article_serving_base_v4'}],
      schemaName: 'mart',
      tableName: 'review_article_serving_base_v4',
    })
    expect(parsed.createCount).toBeGreaterThanOrEqual(0)
    expect(parsed.runCount).toBeGreaterThanOrEqual(0)
  } finally {
    removePathIfExists(dataRoot)
  }
})

test('duckdb fatal index-delete repair target prefers table named by error over stale mutation target', () => {
  const source = readFileSync('src/server/utils/duckdbService.ts', 'utf8')
  const targetMatcherSource = source.slice(
    source.indexOf('const getDuckdbStartupRepairSpecsForFatalIndexedTableError'),
    source.indexOf('const isDuckdbStartupRetryableError'),
  )

  expect(targetMatcherSource).toContain('message.includes(spec.tableName)')
  expect(targetMatcherSource.indexOf('const unqualifiedMessageSpec')).toBeLessThan(
    targetMatcherSource.indexOf('getDuckdbStartupRepairSpecForTableName(failedMutatingTargetTable)'),
  )
  expect(targetMatcherSource).toContain('getDuckdbStartupRepairSpecForTableName(lastMutatingTargetTable)')
  expect(targetMatcherSource).not.toContain('spec.lowMemoryStartupPreflight === true')
})

test('duckdb fatal index-delete repair target recognizes snapshot manifest row dumps', () => {
  const source = readFileSync('src/server/utils/duckdbService.ts', 'utf8')
  const snapshotMatcherSource = source.slice(
    source.indexOf('const getDuckdbStartupRepairSpecForSnapshotManifestIndexError'),
    source.indexOf('const getDuckdbStartupRepairSpecsForFatalIndexedTableError'),
  )
  const targetMatcherSource = source.slice(
    source.indexOf('const getDuckdbStartupRepairSpecsForFatalIndexedTableError'),
    source.indexOf('const isDuckdbStartupRetryableError'),
  )

  expect(snapshotMatcherSource).toContain("message.includes('Chunk - [17 Columns]')")
  expect(snapshotMatcherSource).toContain("message.includes('snapshot:')")
  expect(snapshotMatcherSource).toContain(
    "getDuckdbStartupRepairSpecForTableName('app.review_serving_snapshot_manifest')",
  )
  expect(targetMatcherSource.indexOf('getDuckdbStartupRepairSpecForSnapshotManifestIndexError')).toBeLessThan(
    targetMatcherSource.indexOf('const fallbackSpec'),
  )
})

test('duckdb service marks recent mutating target after anonymous fatal index-delete runtime recovery', () => {
  const dataRoot = join(tmpdir(), `f1-duckdb-service-anonymous-fatal-index-marker-${Date.now()}`)
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

        const originalSpawnSync = globalThis.Bun.spawnSync

        globalThis.Bun.spawnSync = ((command, options) => {
          if (!String(command[0]).includes('bun') || command[1] !== '-e') {
            return originalSpawnSync(command, options)
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
            async run() {
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
              return new MockInstance()
            }

            async connect() {
              return new MockConnection()
            }

            closeSync() {}
          }

          return {DuckDBConnection: MockConnection, DuckDBInstance: MockInstance}
        })

        const duckdbService = await import('./src/server/utils/duckdbService.ts?anonymous-fatal-index-marker-test=' + Date.now())
        try {
          await duckdbService.runDuckdbStatement('DELETE FROM mart.review_filter_option_serving_v4 WHERE 1 = 0')
        } catch {}

        const marker = existsSync(activeRepairSpecPath) ? JSON.parse(readFileSync(activeRepairSpecPath, 'utf8')) : null
        console.log(JSON.stringify({marker}))
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
        result.stderr.toString() || result.stdout.toString() || 'DuckDB anonymous fatal index marker subprocess failed',
      )
    }

    const parsed = parseJsonSubprocessStdout<DuckdbReloadSubprocessResult>(result.stdout.toString())

    expect(parsed.marker).toEqual({
      phase: 'runtime-fatal-index-delete',
      reason: 'index-delete',
      repairSpecs: [{schemaName: 'mart', tableName: 'review_filter_option_serving_v4'}],
      schemaName: 'mart',
      tableName: 'review_filter_option_serving_v4',
    })
  } finally {
    removePathIfExists(dataRoot)
  }
})

test('duckdb service keeps all repairable indexed targets when a named-table transaction fails on commit', () => {
  const dataRoot = join(tmpdir(), `f1-duckdb-service-commit-fatal-index-marker-${Date.now()}`)
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
        const originalSpawnSync = globalThis.Bun.spawnSync

        globalThis.Bun.spawnSync = ((command, options) => {
          if (!String(command[0]).includes('bun') || command[1] !== '-e') {
            return originalSpawnSync(command, options)
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
            constructor(instanceId) {
              this.instanceId = instanceId
            }

            async run(statement) {
              if (this.instanceId === 1 && /^(COMMIT|ROLLBACK)\\b/i.test(statement.trim())) {
                throw new Error('FATAL Error: Failed: database has been invalidated because of a previous fatal error. The database must be restarted prior to being used again. FatalException: Invalid Input Error: Failed to delete all rows from index in mart.review_article_filter_posting_serving_v4. Only deleted 0 out of 8 rows. Chunk: Chunk - [10 Columns]')
              }
            }

            async runAndReadAll() {
              return {
                getRowObjectsJson() {
                  return []
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

        const duckdbService = await import('./src/server/utils/duckdbService.ts?commit-fatal-index-marker-test=' + Date.now())
        let indexedTargetAfterPosting = null
        await duckdbService.runDuckdbTransaction(async (tx) => {
          await tx.run('DELETE FROM mart.review_article_filter_posting_serving_v4 WHERE 1 = 0')
          indexedTargetAfterPosting = globalThis.__forskaDuckdbServiceState.controlTransactionIndexedMutationTarget
          await tx.run('UPDATE app.review_serving_dirty_work SET status = status WHERE 1 = 0')
          await tx.run(\`
            INSERT INTO app.review_serving_projector_watermark (watermark_id, updated_at)
            VALUES ('watermark-1', current_timestamp)
          \`)
        })

        const marker = existsSync(activeRepairSpecPath) ? JSON.parse(readFileSync(activeRepairSpecPath, 'utf8')) : null
        console.log(JSON.stringify({indexedTargetAfterPosting, marker}))
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
        result.stderr.toString() || result.stdout.toString() || 'DuckDB commit fatal index marker subprocess failed',
      )
    }

    const parsed = parseJsonSubprocessStdout<DuckdbReloadSubprocessResult & {indexedTargetAfterPosting: string | null}>(
      result.stdout.toString(),
    )

    expect(parsed.indexedTargetAfterPosting).toBe('mart.review_article_filter_posting_serving_v4')
    expect(parsed.marker).toEqual({
      phase: 'runtime-fatal-index-delete',
      reason: 'index-delete',
      repairSpecs: [
        {schemaName: 'mart', tableName: 'review_article_filter_posting_serving_v4'},
        {schemaName: 'app', tableName: 'review_serving_dirty_work'},
      ],
      schemaName: 'mart',
      tableName: 'review_article_filter_posting_serving_v4',
    })
  } finally {
    removePathIfExists(dataRoot)
  }
})

test('duckdb service marks insert-ignore indexed targets when a duplicate-key transaction fails on commit', () => {
  const dataRoot = join(tmpdir(), `f1-duckdb-service-commit-duplicate-index-marker-${Date.now()}`)
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
        const originalSpawnSync = globalThis.Bun.spawnSync

        globalThis.Bun.spawnSync = ((command, options) => {
          if (!String(command[0]).includes('bun') || command[1] !== '-e') {
            return originalSpawnSync(command, options)
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
            constructor(instanceId) {
              this.instanceId = instanceId
            }

            async run(statement) {
              if (this.instanceId === 1 && /^COMMIT\\b/i.test(statement.trim())) {
                throw new Error('FATAL Error: Failed: database has been invalidated because of a previous fatal error. The database must be restarted prior to being used again. Constraint Error: Duplicate key "watermark_id: watermark:cc3cf4724ec839766a0c74871dc2011b" violates unique constraint.')
              }
            }

            async runAndReadAll() {
              return {
                getRowObjectsJson() {
                  return []
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

        const duckdbService = await import('./src/server/utils/duckdbService.ts?commit-duplicate-index-marker-test=' + Date.now())
        let indexedTargetAfterWatermark = null
        await duckdbService.runDuckdbTransaction(async (tx) => {
          await tx.run(\`
            INSERT OR IGNORE INTO app.review_serving_projector_watermark (
              watermark_id,
              updated_at
            ) VALUES (
              'watermark:cc3cf4724ec839766a0c74871dc2011b',
              current_timestamp
            )
          \`)
          indexedTargetAfterWatermark = globalThis.__forskaDuckdbServiceState.controlTransactionIndexedMutationTarget
        })

        const marker = existsSync(activeRepairSpecPath) ? JSON.parse(readFileSync(activeRepairSpecPath, 'utf8')) : null
        console.log(JSON.stringify({indexedTargetAfterWatermark, marker}))
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
        result.stderr.toString()
          || result.stdout.toString()
          || 'DuckDB commit duplicate index marker subprocess failed',
      )
    }

    const parsed = parseJsonSubprocessStdout<
      DuckdbReloadSubprocessResult & {indexedTargetAfterWatermark: string | null}
    >(result.stdout.toString())

    expect(parsed.indexedTargetAfterWatermark).toBe('app.review_serving_projector_watermark')
    expect(parsed.marker).toEqual({
      phase: 'runtime-fatal-index-delete',
      reason: 'unique-index-duplicate',
      repairSpecs: [{schemaName: 'app', tableName: 'review_serving_projector_watermark'}],
      schemaName: 'app',
      tableName: 'review_serving_projector_watermark',
    })
  } finally {
    removePathIfExists(dataRoot)
  }
})

test('duckdb service prefers fatal error table name before stale mutating target', () => {
  const dataRoot = join(tmpdir(), `f1-duckdb-service-stale-fatal-index-marker-${Date.now()}`)
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

        const originalSpawnSync = globalThis.Bun.spawnSync

        globalThis.Bun.spawnSync = ((command, options) => {
          if (!String(command[0]).includes('bun') || command[1] !== '-e') {
            return originalSpawnSync(command, options)
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
              return new MockInstance()
            }

            async connect() {
              return new MockConnection()
            }

            closeSync() {}
          }

          return {DuckDBConnection: MockConnection, DuckDBInstance: MockInstance}
        })

        const duckdbService = await import('./src/server/utils/duckdbService.ts?stale-fatal-index-marker-test=' + Date.now())
        await duckdbService.runDuckdbStatement('DELETE FROM mart.review_filter_option_serving_v4 WHERE 1 = 0')
        await duckdbService.recoverDuckdbServiceAfterFatalError(
          new Error('FatalException: Invalid Input Error: Failed to delete all rows from index review_article_count_serving_v4. Only deleted 0 out of 1 rows.'),
        )

        const marker = existsSync(activeRepairSpecPath) ? JSON.parse(readFileSync(activeRepairSpecPath, 'utf8')) : null
        console.log(JSON.stringify({marker}))
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
        result.stderr.toString() || result.stdout.toString() || 'DuckDB stale fatal index marker subprocess failed',
      )
    }

    const parsed = parseJsonSubprocessStdout<DuckdbReloadSubprocessResult>(result.stdout.toString())

    expect(parsed.marker).toEqual({
      phase: 'runtime-fatal-index-delete',
      reason: 'index-delete',
      repairSpecs: [{schemaName: 'mart', tableName: 'review_article_count_serving_v4'}],
      schemaName: 'mart',
      tableName: 'review_article_count_serving_v4',
    })
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

  const parsed = parseJsonSubprocessStdout<DuckdbReloadSubprocessResult>(result.stdout.toString())

  expect(parsed).toEqual({createCount: 2, rows: [{value: 1}]})
})

test('duckdb service quarantines a WAL that repeatedly fails replay during startup', async () => {
  const dataRoot = join(tmpdir(), `f1-duckdb-service-wal-recovery-${Date.now()}`)
  const duckdbPath = join(dataRoot, 'test.duckdb')
  const recoveryDirectory = duckdbPath + '.startup-recovery'
  const staleRecoveryPathPart = '2000-01-01T00-00-00.000Z.00000000-0000-4000-8000-000000000002'

  mkdirSync(recoveryDirectory, {recursive: true})
  const duckdbInstance = await DuckDBInstance.create(duckdbPath)
  duckdbInstance.closeSync()
  writeFileSync(`${duckdbPath}.wal`, 'wal')
  writeFileSync(join(recoveryDirectory, `${staleRecoveryPathPart}.duckdb`), 'stale-database')
  writeFileSync(join(recoveryDirectory, `${staleRecoveryPathPart}.failed-replay.wal`), 'stale-wal')
  writeFileSync(join(recoveryDirectory, `${staleRecoveryPathPart}.recovery.json`), '{}')
  writeFileSync(join(recoveryDirectory, 'operator-note.json'), '{}')

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

    const parsed = parseJsonSubprocessStdout<DuckdbReloadSubprocessResult>(result.stdout.toString())

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
    expect(
      parsed.recoveryFiles.filter((fileName) => {
        return fileName.endsWith('.recovery.json')
      }),
    ).toHaveLength(1)
    expect(parsed.recoveryFiles).toContain('operator-note.json')
    expect(
      parsed.recoveryFiles.some((fileName) => {
        return fileName.startsWith(staleRecoveryPathPart)
      }),
    ).toBe(false)
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

    const parsed = parseJsonSubprocessStdout<DuckdbReloadSubprocessResult>(result.stdout.toString())

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

test('duckdb service keeps replayable WAL when startup checkpoint fails', () => {
  const dataRoot = join(tmpdir(), `f1-duckdb-service-wal-checkpoint-failure-${Date.now()}`)
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

        let childCount = 0
        const originalSpawnSync = globalThis.Bun.spawnSync

        globalThis.Bun.spawnSync = ((command, options) => {
          if (!String(command[0]).includes('bun') || command[1] !== '-e') {
            return originalSpawnSync(command, options)
          }

          childCount += 1

          return childCount === 1
            ? {
                exitCode: 0,
                signalCode: null,
                stdout: Buffer.from(''),
                stderr: Buffer.from(''),
              }
            : {
                exitCode: 7,
                signalCode: null,
                stdout: Buffer.from(''),
                stderr: Buffer.from('checkpoint temporarily failed'),
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

        let errorMessage = null

        try {
          const duckdbService = await import('./src/server/utils/duckdbService.ts?wal-checkpoint-failure-test=' + Date.now())
          await duckdbService.runDuckdbJsonQuery('SELECT 1 AS value')
        } catch (error) {
          errorMessage = error instanceof Error ? error.message : String(error)
        }

        const recoveryDirectory = duckdbPath + '.startup-recovery'
        const recoveryFiles = existsSync(recoveryDirectory) ? readdirSync(recoveryDirectory).sort() : []
        console.log(JSON.stringify({
          childCount,
          errorMessage,
          recoveryFiles,
          walExists: existsSync(duckdbPath + '.wal'),
        }))
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
      throw new Error(result.stderr.toString() || result.stdout.toString() || 'DuckDB WAL checkpoint subprocess failed')
    }

    const parsed = parseJsonSubprocessStdout<{
      childCount: number
      errorMessage: string | null
      recoveryFiles: string[]
      walExists: boolean
    }>(result.stdout.toString())

    expect(parsed.childCount).toBe(2)
    expect(parsed.errorMessage).toContain('DuckDB startup WAL checkpoint failed')
    expect(parsed.errorMessage).toContain('checkpoint temporarily failed')
    expect(parsed.walExists).toBe(true)
    expect(parsed.recoveryFiles).toEqual([])
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
        const {existsSync, readdirSync, unlinkSync, writeFileSync} = await import('node:fs')
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

          if (options?.env?.FORSKA_DUCKDB_STARTUP_WAL_CHECKPOINT_CHILD === 'true') {
            if (existsSync(duckdbPath + '.wal')) {
              unlinkSync(duckdbPath + '.wal')
            }
            return {
              exitCode: 0,
              signalCode: null,
              stdout: Buffer.from(''),
              stderr: Buffer.from(''),
            }
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

    const parsed = parseJsonSubprocessStdout<DuckdbReloadSubprocessResult>(result.stdout.toString())

    expect(parsed.preflightCount).toBeGreaterThanOrEqual(3)
    expect(
      parsed.preflightSpecsHistory.slice(0, 3).every((specs) => {
        return specs.length === 0
      }),
    ).toBe(true)
    expect(
      parsed.preflightSpecsHistory.some((specs) => {
        return specs.some((spec) => {
          return spec.schemaName === 'mart' && spec.tableName === 'review_article_filter_posting_serving_v4'
        })
      }),
    ).toBe(true)
    expect(parsed.createCount).toBe(1)
    expect(parsed.rows).toEqual([{value: 1}])
    expect(parsed.walExists).toBe(false)
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

    const parsed = parseJsonSubprocessStdout<DuckdbReloadSubprocessResult>(result.stdout.toString())

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

test('duckdb service isolates failed startup mutation WAL while retrying indexed-table repair locks', () => {
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
        let failedPreflightWalPath = ''
        let preflightCount = 0
        const preflightDatabasePaths = []
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

            return {
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

            return repairCount === 1
              ? {
                  exitCode: 1,
                  signalCode: null,
                  stdout: Buffer.from(''),
                  stderr: Buffer.from((
                    writeFileSync(duckdbPath, 'database-after-repair-lock'),
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

          preflightCount += 1
          preflightScript = script
          const preflightDatabasePath = JSON.parse(String(command[3] ?? '""'))
          preflightDatabasePaths.push(preflightDatabasePath)
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
                  failedPreflightWalPath = preflightDatabasePath + '.wal',
                  writeFileSync(failedPreflightWalPath, 'probe wal'),
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
          failedPreflightWalExists: existsSync(failedPreflightWalPath),
          firstPreflightSpecs,
          preflightCount,
          preflightDatabasePaths,
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

    const parsed = parseJsonSubprocessStdout<DuckdbReloadSubprocessResult>(result.stdout.toString())

    expect(parsed.preflightCount).toBe(3)
    expect(parsed.preflightDatabasePaths).toHaveLength(3)
    expect(new Set(parsed.preflightDatabasePaths).size).toBe(3)
    expect(
      parsed.preflightDatabasePaths.every((preflightDatabasePath) => {
        return (
          preflightDatabasePath !== duckdbPath
          && preflightDatabasePath.startsWith(`${duckdbPath}.startup-recovery/`)
          && preflightDatabasePath.endsWith('.startup-probe.duckdb')
        )
      }),
    ).toBe(true)
    expect(parsed.failedPreflightWalExists).toBe(false)
    expect(parsed.repairLockProbeCount).toBe(2)
    expect(parsed.repairCount).toBe(2)
    expect(parsed.createCount).toBe(1)
    expect(parsed.rows).toEqual([{value: 1}])
    expect(parsed.walExists).toBe(false)
    expect(parsed.preflightWalManifest).toBeNull()
    expect(parsed.repairManifest?.recovery).toBe('indexed-table-rebuild')
    expect(parsed.repairManifest?.error).toContain('PRIMARY_review_article_judgment_detail_serving_v4')
    expect(parsed.repairManifest?.repairMarker).toMatchObject({
      schemaName: 'mart',
      tableName: 'review_article_judgment_detail_serving_v4',
    })
    expect(parsed.repairManifest?.repairedTables).toEqual([
      'app.review_rebuild_request',
      'app.review_rebuild_chunk_manifest',
      'mart.review_article_judgment_detail_serving_v4',
    ])
    expect(parsed.repairBackupContent).toBe('database')
    expect(parsed.repairOptions?.checkpoint_threshold).toBe('8GB')
    expect(parsed.repairScript).toContain("await connection.run('CHECKPOINT')")
    expect(parsed.repairScript).toContain("spec.repairStrategy !== 'empty-derived'")
    expect(parsed.repairScript).toContain('spec.postRepairSql')
    expect(parsed.repairScript).toContain(
      "duplicateCount > 0 && !['dedupe-latest', 'empty-derived'].includes(spec.repairStrategy)",
    )
    expect(parsed.repairScript).toContain("spec.repairStrategy !== 'dedupe-latest'")
    expect(parsed.repairScript).toContain('ROW_NUMBER() OVER (PARTITION BY')
    expect(parsed.repairScript).toContain('stripInlinePrimaryKeyConstraints')
    expect(parsed.repairScript).toContain('PRIMARY\\s+KEY\\s*\\([^)]*\\)')
    expect(parsed.repairScript).toContain('getRepairPrimaryKeyIndexSql')
    expect(parsed.repairScript).toContain('primaryKeyColumns.length > 0')
    expect(parsed.repairScript).toContain("'DROP INDEX IF EXISTS ' + spec.schemaName")
    expect(parsed.repairScript).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_')
    expect(parsed.repairScript).toContain("'_repaired_pk_' + repairId")
    expect(parsed.repairScript).toContain('repaired table still contains indexes')
    expect(parsed.repairScript).toContain("startsWith('idx_' + spec.tableName + '_repaired_pk')")
    expect(parsed.repairScript).toContain("replace(/^CREATE UNIQUE INDEX /, 'CREATE UNIQUE INDEX IF NOT EXISTS ')")
    expect(
      parsed.repairSpecs.map((spec) => {
        return {schemaName: spec.schemaName, tableName: spec.tableName}
      }),
    ).toEqual([
      {schemaName: 'app', tableName: 'review_rebuild_request'},
      {schemaName: 'app', tableName: 'review_rebuild_chunk_manifest'},
      {schemaName: 'mart', tableName: 'review_article_judgment_detail_serving_v4'},
    ])
    expect(
      parsed.preflightSpecs.map((spec) => {
        return {schemaName: spec.schemaName, tableName: spec.tableName}
      }),
    ).toContainEqual({schemaName: 'mart', tableName: 'review_article_judgment_detail_serving_v4'})
    const watermarkProbe = parsed.firstPreflightSpecs.find((spec) => {
      return spec.schemaName === 'app' && spec.tableName === 'review_serving_projector_watermark'
    })
    expect(watermarkProbe?.lowMemoryStartupPreflight).toBe(true)
    expect(watermarkProbe?.repairPrimaryKeyColumns).toEqual(['watermark_id'])
    expect(watermarkProbe?.recreateRepairPrimaryKeyIndex).toBe(false)
    expect(watermarkProbe?.recreateSecondaryIndexes).toBe(false)
    const dirtyWorkProbe = parsed.firstPreflightSpecs.find((spec) => {
      return spec.schemaName === 'app' && spec.tableName === 'review_serving_dirty_work'
    })
    expect(dirtyWorkProbe?.mutationProbeSql).toContain('WITH eligible_lane AS')
    expect(dirtyWorkProbe?.mutationProbeSql).toContain('claim_candidates AS')
    expect(dirtyWorkProbe?.mutationProbeSql).toContain('{"projectionComponent":"selectedImport","projectionIdentity":')
    expect(dirtyWorkProbe?.mutationProbeSql).toContain('RETURNING dirty_work_id')
    expect(dirtyWorkProbe?.lowMemoryStartupPreflight).toBe(true)
    expect(dirtyWorkProbe?.recreateRepairPrimaryKeyIndex).toBe(false)
    expect(dirtyWorkProbe?.recreateSecondaryIndexes).toBe(false)
    expect(dirtyWorkProbe?.repairPrimaryKeyColumns).toEqual(['dirty_work_id'])
    expect(dirtyWorkProbe?.repairStrategy).toBe('dedupe-latest')
    const dirtyWorkAckProbe = parsed.firstPreflightSpecs.find((spec) => {
      return spec.schemaName === 'app' && spec.tableName === 'review_serving_dirty_work_ack'
    })
    expect(dirtyWorkAckProbe?.lowMemoryStartupPreflight).toBe(true)
    expect(dirtyWorkAckProbe?.recreateRepairPrimaryKeyIndex).toBe(false)
    expect(dirtyWorkAckProbe?.recreateSecondaryIndexes).toBe(false)
    expect(dirtyWorkAckProbe?.repairPrimaryKeyColumns).toEqual(['dirty_ack_id'])
    expect(dirtyWorkAckProbe?.repairStrategy).toBe('dedupe-latest')
    const projectionIdentityProbe = parsed.firstPreflightSpecs.find((spec) => {
      return spec.schemaName === 'app' && spec.tableName === 'review_projection_identity_manifest'
    })
    expect(projectionIdentityProbe?.lowMemoryStartupPreflight).toBe(true)
    expect(projectionIdentityProbe?.recreateRepairPrimaryKeyIndex).toBe(false)
    expect(projectionIdentityProbe?.recreateSecondaryIndexes).toBe(false)
    expect(projectionIdentityProbe?.mutationProbeSql).toContain('UPDATE app.review_projection_identity_manifest')
    expect(projectionIdentityProbe?.mutationProbeSql).toContain('UPDATE app.review_selected_import_snapshot')
    expect(projectionIdentityProbe?.postRepairDependencySpecs).toEqual([
      {schemaName: 'app', tableName: 'review_selected_import_snapshot'},
    ])
    expect(projectionIdentityProbe?.repairPrimaryKeyColumns).toEqual(['manifest_id'])
    expect(projectionIdentityProbe?.repairStrategy).toBe('dedupe-latest')
    const selectedImportSnapshotProbe = parsed.firstPreflightSpecs.find((spec) => {
      return spec.schemaName === 'app' && spec.tableName === 'review_selected_import_snapshot'
    })
    expect(selectedImportSnapshotProbe?.lowMemoryStartupPreflight).toBe(true)
    expect(selectedImportSnapshotProbe?.recreateRepairPrimaryKeyIndex).toBe(false)
    expect(selectedImportSnapshotProbe?.recreateSecondaryIndexes).toBe(false)
    expect(selectedImportSnapshotProbe?.repairPrimaryKeyColumns).toEqual(['selected_import_snapshot_id'])
    expect(selectedImportSnapshotProbe?.repairStrategy).toBe('dedupe-latest')
    const comparisonServingGenerationProbe = parsed.firstPreflightSpecs.find((spec) => {
      return spec.schemaName === 'app' && spec.tableName === 'comparison_project_serving_generation'
    })
    expect(comparisonServingGenerationProbe?.lowMemoryStartupPreflight).toBe(true)
    expect(comparisonServingGenerationProbe?.repairPrimaryKeyColumns).toEqual(['comparison_project_id'])
    expect(comparisonServingGenerationProbe?.repairStrategy).toBe('empty-derived')
    expect(comparisonServingGenerationProbe?.mutationProbeSql).toContain(
      'UPDATE app.comparison_project_serving_generation',
    )
    expect(comparisonServingGenerationProbe?.postRepairSql).toContain("'stale'")
    expect(comparisonServingGenerationProbe?.postRepairSql).toContain('FROM app.comparison_project project')
    expect(comparisonServingGenerationProbe?.postRepairSql).toContain('MAX(generation) AS active_generation')
    expect(comparisonServingGenerationProbe?.postRepairSql).toContain('PARTITION BY project.id')
    expect(comparisonServingGenerationProbe?.postRepairSchemaRequirements).toContainEqual({
      columnNames: ['id', 'archived'],
      schemaName: 'app',
      tableName: 'comparison_project',
    })
    expect(comparisonServingGenerationProbe?.postRepairSchemaRequirements).toContainEqual({
      columnNames: ['comparison_project_id', 'generation'],
      schemaName: 'mart',
      tableName: 'comparison_article_serving',
    })
    expect(comparisonServingGenerationProbe?.schemaRequirements).toContainEqual({
      columnNames: ['comparison_project_id', 'generation_updated_at'],
      schemaName: 'app',
      tableName: 'comparison_project_serving_generation',
    })
    const articleServingProbe = parsed.firstPreflightSpecs.find((spec) => {
      return spec.schemaName === 'mart' && spec.tableName === 'review_article_serving_base_v4'
    })
    expect(articleServingProbe?.mutationProbeSql).toContain('Failed to delete all rows from index')
    expect(articleServingProbe?.mutationProbeSql).toContain('app.review_rebuild_chunk_manifest')
    expect(articleServingProbe?.mutationProbeSql).toContain('INSERT INTO mart.review_article_serving_base_v4 BY NAME')
    expect(articleServingProbe?.mutationProbeSql).not.toContain('UPDATE mart.review_article_serving_base_v4')
    expect(articleServingProbe?.mutationProbeSql).not.toContain('serving_updated_at')
    const articleServingModeStateProbe = parsed.firstPreflightSpecs.find((spec) => {
      return spec.schemaName === 'mart' && spec.tableName === 'review_article_serving_list_mode_state_v4'
    })
    expect(articleServingModeStateProbe?.mutationProbeSql).toContain('Failed to delete all rows from index')
    expect(articleServingModeStateProbe?.mutationProbeSql).toContain('app.review_rebuild_chunk_manifest')
    expect(articleServingModeStateProbe?.mutationProbeSql).toContain(
      'INSERT INTO mart.review_article_serving_list_mode_state_v4 BY NAME',
    )
    expect(articleServingModeStateProbe?.mutationProbeSql).not.toContain(
      'UPDATE mart.review_article_serving_list_mode_state_v4',
    )
    const selectedImportProbe = parsed.firstPreflightSpecs.find((spec) => {
      return spec.schemaName === 'app' && spec.tableName === 'review_selected_article_import_v4'
    })
    expect(selectedImportProbe?.lowMemoryStartupPreflight).toBe(true)
    expect(selectedImportProbe?.recreateRepairPrimaryKeyIndex).toBe(false)
    expect(selectedImportProbe?.recreateSecondaryIndexes).toBe(false)
    expect(selectedImportProbe?.repairPrimaryKeyColumns).toEqual([
      'project_id',
      'project_scope_identity',
      'selected_import_snapshot_id',
      'article_id',
    ])
    expect(selectedImportProbe?.mutationProbeSql).toContain("projection_component = 'selectedImport'")
    expect(selectedImportProbe?.mutationProbeSql).toContain('INSERT INTO app.review_selected_article_import_v4 BY NAME')
    const snapshotManifestProbe = parsed.firstPreflightSpecs.find((spec) => {
      return spec.schemaName === 'app' && spec.tableName === 'review_serving_snapshot_manifest'
    })
    expect(snapshotManifestProbe?.lowMemoryStartupPreflight).toBe(true)
    expect(snapshotManifestProbe?.recreateSecondaryIndexes).toBe(false)
    expect(snapshotManifestProbe?.repairPrimaryKeyColumns).toEqual(['project_id', 'snapshot_id'])
    expect(snapshotManifestProbe?.repairStrategy).toBe('dedupe-latest')
    expect(snapshotManifestProbe?.repairDedupeOrderSql).toContain("snapshot_status = 'active'")
    expect(snapshotManifestProbe?.mutationProbeSql).toContain('startup_probe_review_serving_snapshot_manifest')
    expect(snapshotManifestProbe?.mutationProbeSql).toContain('UPDATE app.review_serving_snapshot_manifest')
    const rebuildRequestProbe = parsed.firstPreflightSpecs.find((spec) => {
      return spec.schemaName === 'app' && spec.tableName === 'review_rebuild_request'
    })
    expect(rebuildRequestProbe?.lowMemoryStartupPreflight).toBeUndefined()
    expect(rebuildRequestProbe?.repairPrimaryKeyColumns).toEqual(['request_id'])
    expect(rebuildRequestProbe?.recreateRepairPrimaryKeyIndex).toBe(false)
    expect(rebuildRequestProbe?.recreateSecondaryIndexes).toBe(false)
    expect(rebuildRequestProbe?.repairStrategy).toBe('dedupe-latest')
    expect(rebuildRequestProbe?.repairDedupeOrderSql).toContain("status IN ('admitted', 'running')")
    expect(rebuildRequestProbe?.mutationProbeSql).toContain('UPDATE app.review_rebuild_request')
    expect(rebuildRequestProbe?.mutationProbeSql).toContain('startup_probe_review_rebuild_request')
    const chunkManifestProbe = parsed.firstPreflightSpecs.find((spec) => {
      return spec.schemaName === 'app' && spec.tableName === 'review_rebuild_chunk_manifest'
    })
    expect(chunkManifestProbe?.lowMemoryStartupPreflight).toBe(true)
    expect(chunkManifestProbe?.repairPrimaryKeyColumns).toEqual(['chunk_id'])
    expect(chunkManifestProbe?.recreateRepairPrimaryKeyIndex).toBe(false)
    expect(chunkManifestProbe?.recreateSecondaryIndexes).toBe(false)
    expect(chunkManifestProbe?.repairStrategy).toBe('dedupe-latest')
    expect(chunkManifestProbe?.repairDedupeOrderSql).toContain("status = 'completed'")
    expect(chunkManifestProbe?.repairDedupeOrderSql).toContain("admission_state = 'admitted'")
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
    expect(parsed.preflightScript).toContain('needsIndexedTableShapeRepairBeforeMutation')
    expect(parsed.preflightScript).toContain('indexed-table-shape-repair')
    const judgmentDetailProbe = parsed.firstPreflightSpecs.find((spec) => {
      return spec.schemaName === 'mart' && spec.tableName === 'review_article_judgment_detail_serving_v4'
    })
    expect(judgmentDetailProbe?.lowMemoryStartupPreflight).toBe(true)
    expect(judgmentDetailProbe?.repairPrimaryKeyColumns).toEqual([
      'project_id',
      'review_config_hash',
      'snapshot_id',
      'payload_kind',
      'article_id',
      'prompt_id',
    ])
    expect(judgmentDetailProbe?.mutationProbeSql).toContain("projection_component = 'judgmentInputContent'")
    expect(judgmentDetailProbe?.mutationProbeSql).toContain('Failed to delete all rows from index')
    expect(judgmentDetailProbe?.mutationProbeSql).toContain(
      'DELETE FROM mart.review_article_judgment_detail_serving_v4',
    )
    expect(judgmentDetailProbe?.mutationProbeSql).toContain(
      'INSERT INTO mart.review_article_judgment_detail_serving_v4 BY NAME',
    )
    expect(judgmentDetailProbe?.skipGenericDeleteInsertProbe).toBe(true)
    expect(judgmentDetailProbe?.repairStrategy).toBe('empty-derived')
    expect(judgmentDetailProbe?.recreateRepairPrimaryKeyIndex).toBe(false)
    expect(judgmentDetailProbe?.recreateSecondaryIndexes).toBe(false)
    expect(judgmentDetailProbe?.postRepairDependencySpecs).toEqual([
      {schemaName: 'app', tableName: 'review_rebuild_request'},
      {schemaName: 'app', tableName: 'review_rebuild_chunk_manifest'},
    ])
    expect(judgmentDetailProbe?.postRepairSql).toContain("projection_component = 'judgmentInputContent'")
    expect(judgmentDetailProbe?.postRepairSql).toContain("status = 'pending'")
    expect(judgmentDetailProbe?.postRepairSql).toContain('app.review_rebuild_request')
    const titleSearchProbe = parsed.firstPreflightSpecs.find((spec) => {
      return spec.schemaName === 'mart' && spec.tableName === 'review_title_search_serving_v4'
    })
    expect(titleSearchProbe?.lowMemoryStartupPreflight).toBe(true)
    expect(titleSearchProbe?.recreateRepairPrimaryKeyIndex).toBe(false)
    expect(titleSearchProbe?.recreateSecondaryIndexes).toBe(false)
    expect(titleSearchProbe?.repairPrimaryKeyColumns).toEqual([
      'project_id',
      'search_identity',
      'project_scope_identity',
      'snapshot_id',
      'token',
    ])
    expect(titleSearchProbe?.mutationProbeSql).toContain('UPDATE mart.review_title_search_serving_v4')
    expect(titleSearchProbe?.repairStrategy).toBe('empty-derived')
    expect(titleSearchProbe?.postRepairSql).toContain("projection_component = 'search'")
    expect(titleSearchProbe?.postRepairSql).toContain("status = 'pending'")
    expect(titleSearchProbe?.postRepairSql).toContain('app.review_rebuild_request')
    const queueServingProbe = parsed.firstPreflightSpecs.find((spec) => {
      return spec.schemaName === 'mart' && spec.tableName === 'review_unassessed_queue_serving_v4'
    })
    expect(queueServingProbe?.lowMemoryStartupPreflight).toBe(true)
    expect(queueServingProbe?.recreateRepairPrimaryKeyIndex).toBe(false)
    expect(queueServingProbe?.recreateSecondaryIndexes).toBe(false)
    expect(queueServingProbe?.repairPrimaryKeyColumns).toEqual([
      'project_id',
      'review_config_hash',
      'snapshot_id',
      'queue_kind',
      'priority_bucket',
      'activity_sort_at',
      'article_id',
    ])
    expect(queueServingProbe?.mutationProbeSql).toContain('UPDATE mart.review_unassessed_queue_serving_v4')
    expect(queueServingProbe?.mutationProbeSql).toContain('prompt_ids')
    expect(queueServingProbe?.mutationProbeSql).not.toContain('queue_identity')
    const filterPostingProbe = parsed.firstPreflightSpecs.find((spec) => {
      return spec.schemaName === 'mart' && spec.tableName === 'review_article_filter_posting_serving_v4'
    })
    expect(filterPostingProbe?.lowMemoryStartupPreflight).toBe(true)
    expect(filterPostingProbe?.recreateRepairPrimaryKeyIndex).toBe(false)
    expect(filterPostingProbe?.recreateSecondaryIndexes).toBe(false)
    expect(filterPostingProbe?.repairPrimaryKeyColumns).toEqual([
      'project_id',
      'review_config_hash',
      'snapshot_id',
      'filter_kind',
      'filter_value',
      'list_mode_key',
    ])
    const countServingProbe = parsed.firstPreflightSpecs.find((spec) => {
      return spec.schemaName === 'mart' && spec.tableName === 'review_article_count_serving_v4'
    })
    expect(countServingProbe?.lowMemoryStartupPreflight).toBe(true)
    expect(countServingProbe?.repairPrimaryKeyColumns).toEqual([
      'project_id',
      'review_config_hash',
      'snapshot_id',
      'list_mode_key',
      'count_kind',
      'summary_definition_version',
      'filter_key',
    ])
    expect(countServingProbe?.mutationProbeSql).toContain('UPDATE mart.review_article_count_serving_v4')
    expect(countServingProbe?.mutationProbeSql).toContain('SET stale_reason = stale_reason')
    expect(countServingProbe?.mutationProbeSql).not.toContain('count_updated_at')
    expect(countServingProbe?.schemaRequirements).toEqual([
      {
        columnNames: [
          'project_id',
          'review_config_hash',
          'snapshot_id',
          'list_mode_key',
          'count_kind',
          'summary_definition_version',
          'filter_key',
          'stale_reason',
        ],
        schemaName: 'mart',
        tableName: 'review_article_count_serving_v4',
      },
    ])
    const filteredCountServingProbe = parsed.firstPreflightSpecs.find((spec) => {
      return spec.schemaName === 'mart' && spec.tableName === 'review_filtered_count_serving_v4'
    })
    expect(filteredCountServingProbe?.lowMemoryStartupPreflight).toBe(true)
    expect(filteredCountServingProbe?.repairPrimaryKeyColumns).toEqual([
      'project_id',
      'review_config_hash',
      'snapshot_id',
      'list_mode_key',
      'filter_signature',
      'component_identity',
    ])
    expect(filteredCountServingProbe?.mutationProbeSql).toContain('UPDATE mart.review_filtered_count_serving_v4')
    expect(filteredCountServingProbe?.schemaRequirements).toEqual([
      {
        columnNames: [
          'project_id',
          'review_config_hash',
          'snapshot_id',
          'list_mode_key',
          'filter_signature',
          'component_identity',
          'count_updated_at',
        ],
        schemaName: 'mart',
        tableName: 'review_filtered_count_serving_v4',
      },
    ])
    const facetServingProbe = parsed.firstPreflightSpecs.find((spec) => {
      return spec.schemaName === 'mart' && spec.tableName === 'review_filter_facet_serving_v4'
    })
    expect(facetServingProbe?.lowMemoryStartupPreflight).toBe(true)
    expect(facetServingProbe?.repairPrimaryKeyColumns).toEqual([
      'project_id',
      'review_config_hash',
      'snapshot_id',
      'summary_identity',
      'facet_kind',
      'facet_key',
      'facet_value',
      'summary_definition_version',
    ])
    expect(facetServingProbe?.mutationProbeSql).toContain('UPDATE mart.review_filter_facet_serving_v4')
    expect(facetServingProbe?.mutationProbeSql).toContain('SET availability = availability')
    expect(facetServingProbe?.mutationProbeSql).not.toContain('facet_updated_at')
    const filterOptionServingProbe = parsed.firstPreflightSpecs.find((spec) => {
      return spec.schemaName === 'mart' && spec.tableName === 'review_filter_option_serving_v4'
    })
    expect(filterOptionServingProbe?.lowMemoryStartupPreflight).toBe(true)
    expect(filterOptionServingProbe?.repairPrimaryKeyColumns).toEqual([
      'project_id',
      'review_config_hash',
      'snapshot_id',
      'search_identity',
      'filter_option_identity',
      'filter_kind',
      'facet_key',
      'option_value_key',
    ])
    expect(filterOptionServingProbe?.mutationProbeSql).toContain('UPDATE mart.review_filter_option_serving_v4')
    expect(filterOptionServingProbe?.mutationProbeSql).toContain('SET count_value = count_value')
    expect(filterOptionServingProbe?.mutationProbeSql).not.toContain('option_updated_at')
    const articleFilterPostingProbe = parsed.firstPreflightSpecs.find((spec) => {
      return spec.schemaName === 'mart' && spec.tableName === 'review_article_filter_posting_serving_v4'
    })
    expect(articleFilterPostingProbe?.lowMemoryStartupPreflight).toBe(true)
    expect(articleFilterPostingProbe?.repairPrimaryKeyColumns).toEqual([
      'project_id',
      'review_config_hash',
      'snapshot_id',
      'filter_kind',
      'filter_value',
      'list_mode_key',
    ])
    expect(articleFilterPostingProbe?.schemaRequirements).toEqual([
      {columnNames: ['article_ids'], schemaName: 'mart', tableName: 'review_article_filter_posting_serving_v4'},
    ])
    expect(articleFilterPostingProbe?.mutationProbeSql).toContain(
      'DELETE FROM mart.review_article_filter_posting_serving_v4',
    )
    expect(articleFilterPostingProbe?.mutationProbeSql).toContain(
      'INSERT INTO mart.review_article_filter_posting_serving_v4',
    )
    expect(articleFilterPostingProbe?.mutationProbeSql).not.toContain('sort_key')
    expect(articleFilterPostingProbe?.skipGenericDeleteInsertProbe).toBe(true)
    const postingStatsProbe = parsed.firstPreflightSpecs.find((spec) => {
      return spec.schemaName === 'mart' && spec.tableName === 'review_filter_posting_stats_v4'
    })
    expect(postingStatsProbe).toBeUndefined()
    const payloadProbe = parsed.firstPreflightSpecs.find((spec) => {
      return spec.schemaName === 'mart' && spec.tableName === 'review_article_serving_payload_v4'
    })
    expect(payloadProbe).toBeUndefined()
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
    ).toHaveLength(0)
    expect(
      parsed.recoveryFiles.filter((fileName) => {
        return fileName.endsWith('.startup-probe.duckdb')
      }),
    ).toHaveLength(0)
    expect(
      parsed.recoveryFiles.filter((fileName) => {
        return fileName.endsWith('.recovery.json')
      }),
    ).toHaveLength(1)
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
        let releaseCount = 0
        const runStatements = []

        void mock.module(serverRuntimeRoleModulePath, () => {
          return {
            canCurrentServerOwnDuckdb: () => true,
            ensureCurrentDuckdbOwnerLease: async () => {},
            registerDuckdbOwnerDemotionHandler: () => {},
            releaseCurrentDuckdbOwnerLease: async () => {
              releaseCount += 1
            },
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
        console.log(JSON.stringify({createCount, releaseCount, rows, runStatements}))
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

  const parsed = parseJsonSubprocessStdout<DuckdbReloadSubprocessResult>(result.stdout.toString())

  expect(parsed).toEqual({createCount: 2, releaseCount: 1, rows: [{value: 1}], runStatements: ['2:CHECKPOINT']})
})
