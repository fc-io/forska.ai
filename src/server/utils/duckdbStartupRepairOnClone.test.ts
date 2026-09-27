import {createHash} from 'node:crypto'
import {copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {expect, test} from 'bun:test'

type RepairManifest = {
  liveDatabaseModified?: boolean
  preservedDatabasePath?: string | null
  recovery?: string
  repairAttempts?: Array<{error: string | null; failedTables: string[]; outcome: string; rungs: Record<string, string>}>
  repairEvidence?: string | null
  repairRungs?: Record<string, string>
  repairWorkPath?: string
}
type ServiceRunResult = {
  firstQuery: {error?: string; rows?: Array<Record<string, number | string>>}
  indexNames: string[]
  manifests: RepairManifest[]
  repairChildCountAfterFirstQuery: number
  repairChildCount: number
  repairRungsHistory: Array<Record<string, string>>
  rewriteApplied: boolean
  secondQuery: {error?: string; rows?: Array<Record<string, number | string>>} | null
  tableSql: string[]
  updatedWalRowCount: number | null
}
type ScriptRewrite = {from: string; to: string}

const sourceRecordTable = 'app.article_import_route_source_record'
const duckdbSetupOptions = {checkpoint_threshold: '1GB', memory_limit: '1GB', threads: '1'}

const duckdbSetupScript = `
  const {writeFileSync} = await import('node:fs')
  const {DuckDBInstance} = await import('@duckdb/node-api')
  const databasePath = JSON.parse(process.argv[1])
  const mode = JSON.parse(process.argv[2])
  const options = JSON.parse(process.argv[3])
  const instance = await DuckDBInstance.create(databasePath, options)
  const connection = await instance.connect()
  const run = async (statement) => {
    await connection.run(statement)
  }

  if (mode === 'create') {
    await run('CREATE SCHEMA app')
    await run(\`
      CREATE TABLE app.article_import_route_source_record(
        id VARCHAR PRIMARY KEY,
        import_route_id VARCHAR NOT NULL,
        article_id VARCHAR NOT NULL,
        source_article_created_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
        raw_payload VARCHAR
      )
    \`)
    await run(\`
      CREATE INDEX idx_app_article_import_route_source_record_source_article_created_at
      ON app.article_import_route_source_record(import_route_id, source_article_created_at)
    \`)
    await run(\`
      CREATE INDEX idx_app_article_import_route_source_record_article
      ON app.article_import_route_source_record(article_id)
    \`)
    await run(\`
      INSERT INTO app.article_import_route_source_record
      SELECT
        'checkpointed-' || i,
        'route-1',
        'article-' || i,
        TIMESTAMPTZ '2026-01-01 00:00:00+00' + to_seconds(i),
        TIMESTAMPTZ '2026-01-01 00:00:00+00',
        repeat('x', 100)
      FROM range(5000) t(i)
    \`)
    await run('CHECKPOINT')
  }

  if (mode === 'wal-writer') {
    await run('PRAGMA disable_checkpoint_on_shutdown')
    await run(\`
      INSERT INTO app.article_import_route_source_record
      SELECT
        'wal-' || i,
        'route-1',
        'wal-article-' || i,
        TIMESTAMPTZ '2026-02-01 00:00:00+00' + to_seconds(i),
        current_timestamp,
        repeat('y', 100)
      FROM range(3000) t(i)
    \`)
    process.kill(process.pid, 'SIGKILL')
  }

  if (mode === 'probe') {
    try {
      await run('BEGIN')
      await run(\`
        UPDATE app.article_import_route_source_record
        SET source_article_created_at = source_article_created_at
        WHERE id IN (
          SELECT id FROM app.article_import_route_source_record ORDER BY updated_at DESC, id ASC LIMIT 256
        )
      \`)
      await run('COMMIT')
      writeFileSync(databasePath + '.probe-result', 'probe-passed')
    } catch (error) {
      writeFileSync(databasePath + '.probe-result', 'probe-failed ' + (error instanceof Error ? error.message : String(error)))
    }
    process.exit(0)
  }

  connection.closeSync()
  instance.closeSync()
`

const runDuckdbSetupChild = (databasePath: string, mode: string) => {
  return globalThis.Bun.spawnSync(
    [
      process.execPath,
      '-e',
      duckdbSetupScript,
      JSON.stringify(databasePath),
      JSON.stringify(mode),
      JSON.stringify(duckdbSetupOptions),
    ],
    {cwd: process.cwd(), env: process.env, stderr: 'pipe', stdout: 'pipe'},
  )
}

const getFileSha256 = (filePath: string) => {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

const getNonEmptyWalSize = (databasePath: string) => {
  const walPath = `${databasePath}.wal`

  return existsSync(walPath) ? statSync(walPath).size : 0
}

const createDatabaseWithLostSecondaryIndexEntries = (dataRoot: string) => {
  const databasePath = join(dataRoot, 'test.duckdb')
  const probeCopyPath = join(dataRoot, 'probe-copy.duckdb')

  mkdirSync(dataRoot, {recursive: true})
  expect(runDuckdbSetupChild(databasePath, 'create').exitCode).toBe(0)

  const writer = runDuckdbSetupChild(databasePath, 'wal-writer')

  expect(writer.signalCode).toBe('SIGKILL')
  expect(getNonEmptyWalSize(databasePath)).toBeGreaterThan(0)
  expect(runDuckdbSetupChild(databasePath, 'open-close').exitCode).toBe(0)
  expect(getNonEmptyWalSize(databasePath)).toBe(0)
  copyFileSync(databasePath, probeCopyPath)

  runDuckdbSetupChild(probeCopyPath, 'probe')

  expect(readFileSync(`${probeCopyPath}.probe-result`, 'utf8')).toContain('Failed to delete all rows from index')
  rmSync(probeCopyPath, {force: true})
  rmSync(`${probeCopyPath}.wal`, {force: true})
  rmSync(`${probeCopyPath}.probe-result`, {force: true})

  return databasePath
}

const getServiceScript = ({
  databasePath,
  resultPath,
  scriptRewrite,
}: {
  databasePath: string
  resultPath: string
  scriptRewrite: ScriptRewrite | null
}) => {
  return `
    const {existsSync, readdirSync, readFileSync, writeFileSync} = await import('node:fs')
    const {join} = await import('node:path')
    const {mock} = await import('bun:test')

    const duckdbPath = ${JSON.stringify(databasePath)}
    const recoveryDirectory = duckdbPath + '.startup-recovery'
    const resultPath = ${JSON.stringify(resultPath)}
    const scriptRewrite = ${JSON.stringify(scriptRewrite)}
    const originalSpawnSync = globalThis.Bun.spawnSync
    const repairRungsHistory = []
    let repairChildCount = 0
    let rewriteApplied = false

    void mock.module(new URL('./src/server/utils/duckdbStartupChildProcess.ts', import.meta.url).href, () => {
      return {
        getDuckdbStartupChildProcessInput: ({executablePath, script, serializedArguments}) => {
          return {command: [executablePath, '-e', script, ...serializedArguments], stdin: 'ignore'}
        },
      }
    })
    void mock.module(new URL('./src/server/utils/serverRuntimeRole.ts', import.meta.url).href, () => {
      return {
        canCurrentServerOwnDuckdb: () => true,
        ensureCurrentDuckdbOwnerLease: async () => {},
        registerDuckdbOwnerDemotionHandler: () => {},
        releaseCurrentDuckdbOwnerLease: async () => {},
      }
    })

    globalThis.Bun.spawnSync = ((command, options) => {
      if (options?.env?.FORSKA_DUCKDB_STARTUP_INDEX_REPAIR_CHILD !== 'true') {
        return originalSpawnSync(command, options)
      }

      repairChildCount += 1
      repairRungsHistory.push(JSON.parse(String(command[9])))

      if (scriptRewrite === null) {
        return originalSpawnSync(command, options)
      }

      rewriteApplied = String(command[2]).includes(scriptRewrite.from)
      return originalSpawnSync(
        [command[0], command[1], String(command[2]).replace(scriptRewrite.from, scriptRewrite.to), ...command.slice(3)],
        options,
      )
    })

    const settle = async (work) => {
      try {
        return {rows: await work()}
      } catch (error) {
        return {error: error instanceof Error ? error.message : String(error)}
      }
    }

    const duckdbService = await import('./src/server/utils/duckdbService.ts?repair-on-clone=' + Date.now())
    const firstQuery = await settle(() => {
      return duckdbService.runDuckdbJsonQuery(
        'SELECT COUNT(*)::INTEGER AS rowCount FROM app.article_import_route_source_record',
      )
    })
    const repairChildCountAfterFirstQuery = repairChildCount
    const served = firstQuery.error === undefined
    let secondQuery = null
    let updatedWalRowCount = null
    let indexNames = []
    let tableSql = []

    if (served) {
      await duckdbService.runDuckdbTransaction(async (tx) => {
        await tx.run(
          "UPDATE app.article_import_route_source_record SET source_article_created_at = source_article_created_at WHERE id LIKE 'wal-%'",
        )
      })
      const updatedRows = await duckdbService.runDuckdbJsonQuery(
        "SELECT COUNT(*)::INTEGER AS rowCount FROM app.article_import_route_source_record WHERE id LIKE 'wal-%'",
      )
      updatedWalRowCount = updatedRows[0]?.rowCount ?? null
      indexNames = (
        await duckdbService.runDuckdbJsonQuery(
          "SELECT index_name AS indexName FROM duckdb_indexes() WHERE table_name = 'article_import_route_source_record' ORDER BY index_name",
        )
      ).map((row) => row.indexName)
      tableSql = (
        await duckdbService.runDuckdbJsonQuery(
          "SELECT sql FROM duckdb_tables() WHERE schema_name = 'app' ORDER BY table_name",
        )
      ).map((row) => String(row.sql))
      await duckdbService.closeDuckdbService()
    } else {
      secondQuery = await settle(() => {
        return duckdbService.runDuckdbJsonQuery('SELECT 1 AS value')
      })
    }

    const manifests = existsSync(recoveryDirectory)
      ? readdirSync(recoveryDirectory)
          .filter((fileName) => fileName.endsWith('.recovery.json'))
          .map((fileName) => JSON.parse(readFileSync(join(recoveryDirectory, fileName), 'utf8')))
      : []

    writeFileSync(resultPath, JSON.stringify({
      firstQuery,
      indexNames,
      manifests,
      repairChildCount,
      repairChildCountAfterFirstQuery,
      repairRungsHistory,
      rewriteApplied,
      secondQuery,
      tableSql,
      updatedWalRowCount,
    }))
  `
}

const runServiceWithStartupRepair = ({
  databasePath,
  dataRoot,
  scriptRewrite,
}: {
  databasePath: string
  dataRoot: string
  scriptRewrite: ScriptRewrite | null
}) => {
  const resultPath = join(dataRoot, 'service-result.json')
  const result = globalThis.Bun.spawnSync(
    [process.execPath, '-e', getServiceScript({databasePath, resultPath, scriptRewrite})],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: '3999',
        DUCKDB_MEMORY_LIMIT: '20GB',
        DUCKDB_PATH: databasePath,
        DUCKDB_TEMP_DIRECTORY: join(dataRoot, 'duckdb-temp'),
        RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
        RUN_SERVER_FULL_TEXT_FETCHING: 'false',
        SERVER_DUCKDB_OWNER_URL: '',
        SERVER_ROLE: 'maintenance-worker',
        VITE_PORT: '3000',
      },
      stderr: 'pipe',
      stdout: 'pipe',
    },
  )

  if (result.exitCode !== 0 || !existsSync(resultPath)) {
    throw new Error(result.stderr.toString() || result.stdout.toString() || 'startup repair service child failed')
  }

  return JSON.parse(readFileSync(resultPath, 'utf8')) as ServiceRunResult
}

const getRepairWorkFilesLeft = (databasePath: string) => {
  return [
    `${databasePath}.repair-work.duckdb`,
    `${databasePath}.repair-work.duckdb.wal`,
    `${databasePath}.repair-work.duckdb.result.json`,
    `${databasePath}.repair-work.duckdb.probe-active-table.json`,
  ].filter((filePath) => {
    return existsSync(filePath)
  })
}

test('startup repair fixes lost secondary index entries by rebuilding that table secondary indexes on a clone', () => {
  const dataRoot = join(tmpdir(), `f1-duckdb-startup-repair-on-clone-rung-a-${Date.now()}`)

  try {
    const databasePath = createDatabaseWithLostSecondaryIndexEntries(dataRoot)
    const parsed = runServiceWithStartupRepair({databasePath, dataRoot, scriptRewrite: null})
    const [manifest] = parsed.manifests

    expect(parsed.firstQuery).toEqual({rows: [{rowCount: 8000}]})
    expect(parsed.updatedWalRowCount).toBe(3000)
    expect(parsed.repairChildCount).toBe(1)
    expect(parsed.repairRungsHistory).toEqual([{[sourceRecordTable]: 'secondary-indexes'}])
    expect(parsed.manifests).toHaveLength(1)
    expect(manifest?.recovery).toBe('indexed-table-rebuild')
    expect(manifest?.repairEvidence).toBe('probe')
    expect(manifest?.repairRungs).toEqual({[sourceRecordTable]: 'secondary-indexes'})
    expect(manifest?.repairWorkPath).toBe(`${databasePath}.repair-work.duckdb`)
    expect(
      manifest?.repairAttempts?.map((attempt) => {
        return attempt.outcome
      }),
    ).toEqual(['repaired'])
    expect(existsSync(manifest?.preservedDatabasePath ?? '')).toBe(true)
    expect(parsed.indexNames).toEqual([
      'idx_app_article_import_route_source_record_article',
      'idx_app_article_import_route_source_record_source_article_created_at',
    ])
    expect(getRepairWorkFilesLeft(databasePath)).toEqual([])
    expect(getNonEmptyWalSize(databasePath)).toBe(0)
  } finally {
    rmSync(dataRoot, {force: true, recursive: true})
  }
}, 120_000)

test('startup repair escalates to recreate-in-place on a clone when rebuilding secondary indexes does not fix the probe', () => {
  const dataRoot = join(tmpdir(), `f1-duckdb-startup-repair-on-clone-rung-b-${Date.now()}`)

  try {
    const databasePath = createDatabaseWithLostSecondaryIndexEntries(dataRoot)
    const parsed = runServiceWithStartupRepair({
      databasePath,
      dataRoot,
      scriptRewrite: {
        from: 'const rebuildTableSecondaryIndexes = async (spec) => {',
        to: 'const rebuildTableSecondaryIndexes = async (spec) => {\n      return []\n',
      },
    })
    const [manifest] = parsed.manifests

    expect(parsed.rewriteApplied).toBe(true)
    expect(parsed.firstQuery).toEqual({rows: [{rowCount: 8000}]})
    expect(parsed.updatedWalRowCount).toBe(3000)
    expect(parsed.repairRungsHistory).toEqual([
      {[sourceRecordTable]: 'secondary-indexes'},
      {[sourceRecordTable]: 'table-rebuild'},
    ])
    expect(manifest?.recovery).toBe('indexed-table-rebuild')
    expect(manifest?.repairRungs).toEqual({[sourceRecordTable]: 'table-rebuild'})
    expect(
      manifest?.repairAttempts?.map((attempt) => {
        return {failedTables: attempt.failedTables, outcome: attempt.outcome}
      }),
    ).toEqual([
      {failedTables: [sourceRecordTable], outcome: 'probe-failed'},
      {failedTables: [], outcome: 'repaired'},
    ])
    expect(parsed.tableSql).toHaveLength(1)
    expect(parsed.tableSql[0]).toMatch(/^CREATE TABLE app\.article_import_route_source_record\(/)
    expect(parsed.tableSql[0]).toMatch(/\bid VARCHAR PRIMARY KEY\b/)
    expect(parsed.indexNames).toEqual([
      'idx_app_article_import_route_source_record_article',
      'idx_app_article_import_route_source_record_source_article_created_at',
    ])
    expect(getRepairWorkFilesLeft(databasePath)).toEqual([])
  } finally {
    rmSync(dataRoot, {force: true, recursive: true})
  }
}, 120_000)

test('startup repair checkpoint failure on the clone leaves the live file byte-identical and stops serving', () => {
  const dataRoot = join(tmpdir(), `f1-duckdb-startup-repair-on-clone-checkpoint-failure-${Date.now()}`)

  try {
    const databasePath = createDatabaseWithLostSecondaryIndexEntries(dataRoot)
    const liveHashBefore = getFileSha256(databasePath)
    const parsed = runServiceWithStartupRepair({
      databasePath,
      dataRoot,
      scriptRewrite: {
        from: "await connection.run('CHECKPOINT')",
        to: "throw new Error('IO Error: Checkpoint failed: INTERNAL Error: Attempted to dereference shared_ptr that is NULL!')",
      },
    })
    const [manifest] = parsed.manifests

    expect(parsed.rewriteApplied).toBe(true)
    expect(parsed.firstQuery.error).toContain('DuckDB startup indexed-table repair stopped')
    expect(parsed.firstQuery.error).toContain('The live database file was not modified')
    expect(parsed.secondQuery?.error?.split(' -- ')[0]).toBe(parsed.firstQuery.error?.split(' -- ')[0])
    expect(parsed.repairChildCountAfterFirstQuery).toBe(3)
    expect(parsed.repairChildCount).toBe(3)
    expect(parsed.repairRungsHistory).toEqual([
      {[sourceRecordTable]: 'secondary-indexes'},
      {[sourceRecordTable]: 'table-rebuild'},
      {[sourceRecordTable]: 'all-secondary-indexes'},
    ])
    expect(manifest?.recovery).toBe('indexed-table-rebuild-failed')
    expect(manifest?.liveDatabaseModified).toBe(false)
    expect(
      manifest?.repairAttempts?.map((attempt) => {
        return attempt.outcome
      }),
    ).toEqual(['repair-failed', 'repair-failed', 'repair-failed'])
    expect(
      manifest?.repairAttempts?.map((attempt) => {
        return attempt.error
      }),
    ).toEqual(
      Array.from({length: 3}, () => {
        return 'checkpoint: IO Error: Checkpoint failed: INTERNAL Error: Attempted to dereference shared_ptr that is NULL!'
      }),
    )
    expect(getFileSha256(databasePath)).toBe(liveHashBefore)
    expect(getNonEmptyWalSize(databasePath)).toBe(0)
    expect(getRepairWorkFilesLeft(databasePath)).toEqual([])
  } finally {
    rmSync(dataRoot, {force: true, recursive: true})
  }
}, 120_000)
