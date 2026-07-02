import {existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync} from 'node:fs'
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

test('duckdb service quarantines a WAL that repeatedly fails replay during startup', () => {
  const dataRoot = join(tmpdir(), `f1-duckdb-service-wal-recovery-${Date.now()}`)
  const duckdbPath = join(dataRoot, 'test.duckdb')

  mkdirSync(dataRoot, {recursive: true})
  writeFileSync(duckdbPath, 'database')
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
        const originalSpawnSync = globalThis.Bun.spawnSync

        globalThis.Bun.spawnSync = ((command, options) => {
          if (!String(command[0]).includes('bun') || command[1] !== '-e') {
            return originalSpawnSync(command, options)
          }

          preflightCount += 1

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
      recoveryFiles: string[]
      rows: Array<{value: number}>
      walExists: boolean
    }

    expect(parsed.preflightCount).toBe(2)
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

test('duckdb service repairs indexed tables when startup mutation preflight crashes without an active WAL', () => {
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
        let preflightSpecs = []
        let repairSpecs = []
        let repairOptions = null
        let repairCount = 0
        let repairScript = ''
        const originalSpawnSync = globalThis.Bun.spawnSync

        globalThis.Bun.spawnSync = ((command, options) => {
          if (!String(command[0]).includes('bun') || command[1] !== '-e') {
            return originalSpawnSync(command, options)
          }

          const script = String(command[2] ?? '')

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
          preflightSpecs = JSON.parse(String(command[5] ?? '[]'))
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
        const preflightWalManifest =
          manifests.find((manifest) => manifest.recovery === 'startup-preflight-mutation-wal-quarantine') ?? null
        console.log(JSON.stringify({
          createCount,
          preflightCount,
          preflightSpecs,
          preflightWalManifest,
          recoveryFiles,
          repairCount,
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
      preflightWalManifest: {error?: string; recovery?: string; walQuarantinePath?: string} | null
      preflightCount: number
      preflightSpecs: Array<{
        mutationProbeSql?: string
        postRepairSql?: string
        repairStrategy?: string
        schemaName: string
        tableName: string
      }>
      recoveryFiles: string[]
      repairCount: number
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

    expect(parsed.preflightCount).toBe(2)
    expect(parsed.repairCount).toBe(1)
    expect(parsed.createCount).toBe(1)
    expect(parsed.rows).toEqual([{value: 1}])
    expect(parsed.walExists).toBe(false)
    expect(parsed.preflightWalManifest?.recovery).toBe('startup-preflight-mutation-wal-quarantine')
    expect(parsed.preflightWalManifest?.error).toContain('PRIMARY_review_article_judgment_detail_serving_v4')
    expect(parsed.repairManifest?.recovery).toBe('indexed-table-rebuild')
    expect(parsed.repairManifest?.error).toContain('PRIMARY_review_article_judgment_detail_serving_v4')
    expect(parsed.repairManifest?.repairedTables).toEqual(['mart.review_article_judgment_detail_serving_v4'])
    expect(parsed.repairOptions?.checkpoint_threshold).toBe('8GB')
    expect(parsed.repairScript).not.toContain("await connection.run('CHECKPOINT')")
    expect(parsed.repairScript).toContain("spec.repairStrategy !== 'empty-derived'")
    expect(parsed.repairScript).toContain('spec.postRepairSql')
    expect(
      parsed.repairSpecs.map((spec) => {
        return {schemaName: spec.schemaName, tableName: spec.tableName}
      }),
    ).toEqual([{schemaName: 'mart', tableName: 'review_article_judgment_detail_serving_v4'}])
    const articleServingProbe = parsed.preflightSpecs.find((spec) => {
      return spec.schemaName === 'mart' && spec.tableName === 'review_article_serving_v4'
    })
    expect(articleServingProbe?.mutationProbeSql).toContain('Failed to delete all rows from index')
    expect(articleServingProbe?.mutationProbeSql).toContain('app.review_rebuild_chunk_manifest')
    expect(articleServingProbe?.mutationProbeSql).toContain('INSERT INTO mart.review_article_serving_v4 BY NAME')
    const selectedImportProbe = parsed.preflightSpecs.find((spec) => {
      return spec.schemaName === 'app' && spec.tableName === 'review_selected_article_import_v4'
    })
    expect(selectedImportProbe?.mutationProbeSql).toContain("projection_component = 'selectedImport'")
    expect(selectedImportProbe?.mutationProbeSql).toContain('INSERT INTO app.review_selected_article_import_v4 BY NAME')
    const chunkManifestProbe = parsed.preflightSpecs.find((spec) => {
      return spec.schemaName === 'app' && spec.tableName === 'review_rebuild_chunk_manifest'
    })
    expect(chunkManifestProbe?.mutationProbeSql).toContain("chunk.status IN ('pending', 'failed', 'running')")
    expect(chunkManifestProbe?.mutationProbeSql).toContain('LIMIT 64')
    expect(chunkManifestProbe?.mutationProbeSql).toContain("WHEN 'llmStatus' THEN 4")
    expect(chunkManifestProbe?.mutationProbeSql).not.toContain("chunk.projection_component = 'projectScope'")
    const judgmentDetailProbe = parsed.preflightSpecs.find((spec) => {
      return spec.schemaName === 'mart' && spec.tableName === 'review_article_judgment_detail_serving_v4'
    })
    expect(judgmentDetailProbe?.mutationProbeSql).toContain("projection_component = 'judgmentInputContent'")
    expect(judgmentDetailProbe?.mutationProbeSql).toContain('Failed to delete all rows from index')
    expect(judgmentDetailProbe?.mutationProbeSql).toContain(
      'INSERT INTO mart.review_article_judgment_detail_serving_v4 BY NAME',
    )
    const llmStatusProbe = parsed.preflightSpecs.find((spec) => {
      return spec.schemaName === 'mart' && spec.tableName === 'review_llm_status_patch_v4'
    })
    expect(llmStatusProbe?.mutationProbeSql).toContain("projection_component = 'llmStatus'")
    expect(llmStatusProbe?.mutationProbeSql).toContain('C++ exception')
    expect(llmStatusProbe?.mutationProbeSql).toContain('INSERT INTO mart.review_llm_status_patch_v4 BY NAME')
    expect(llmStatusProbe?.repairStrategy).toBe('empty-derived')
    expect(llmStatusProbe?.postRepairSql).toContain("projection_component = 'llmStatus'")
    expect(llmStatusProbe?.postRepairSql).toContain("status IN ('completed', 'running')")
    const humanStatusProbe = parsed.preflightSpecs.find((spec) => {
      return spec.schemaName === 'mart' && spec.tableName === 'review_human_status_patch_v4'
    })
    expect(humanStatusProbe?.mutationProbeSql).toContain("projection_component = 'humanStatus'")
    expect(humanStatusProbe?.mutationProbeSql).toContain('C++ exception')
    expect(humanStatusProbe?.mutationProbeSql).toContain('INSERT INTO mart.review_human_status_patch_v4 BY NAME')
    expect(humanStatusProbe?.repairStrategy).toBe('empty-derived')
    expect(humanStatusProbe?.postRepairSql).toContain("projection_component = 'humanStatus'")
    expect(humanStatusProbe?.postRepairSql).toContain("status IN ('completed', 'running')")
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
