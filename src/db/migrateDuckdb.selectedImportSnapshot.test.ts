import {existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {DuckDBInstance} from '@duckdb/node-api'
import {expect, test} from 'bun:test'

import {createDuckdbInstance} from '../server/utils/createDuckdbInstance.ts'
import {duckdbEngineCompatibilityOptions} from '../server/utils/duckdbEngineContract.ts'

const migrationsFolder = join(import.meta.dir, 'duckdbMigrations')
const migrationName = '0243_rebuildReviewSelectedImportSnapshotWithoutIndexes.sql'
const tableName = 'review_selected_import_snapshot'

const withNativeDatabase = async <T>(
  databasePath: string,
  operation: (connection: Awaited<ReturnType<DuckDBInstance['connect']>>) => Promise<T>,
) => {
  const instance = await createDuckdbInstance({
    create: DuckDBInstance.create.bind(DuckDBInstance),
    databasePath,
    options: {...duckdbEngineCompatibilityOptions, memory_limit: '512MiB'},
  })
  const connection = await instance.connect()
  try {
    return await operation(connection)
  } finally {
    connection.closeSync()
    instance.closeSync()
  }
}

const seedIndexedSnapshot = async (databasePath: string, migrationApplied = false) => {
  const foundation = readFileSync(join(migrationsFolder, '0097_reviewServingV4Foundation.sql'), 'utf8')
  const createTableSql = foundation.slice(
    foundation.indexOf(`CREATE TABLE IF NOT EXISTS app.${tableName} (`),
    foundation.indexOf('CREATE TABLE IF NOT EXISTS app.review_selected_article_import_v4 ('),
  )
  const appliedMigrations = readdirSync(migrationsFolder)
    .filter((name) => {
      return name.endsWith('.sql') && (migrationApplied || name !== migrationName)
    })
    .map((name) => {
      return `('${name}')`
    })
    .join(', ')
  await withNativeDatabase(databasePath, async (connection) => {
    await connection.run(`
      CREATE SCHEMA app;
      CREATE TABLE app_schema_migration (name VARCHAR PRIMARY KEY, applied_at TIMESTAMP DEFAULT current_timestamp);
      INSERT INTO app_schema_migration (name) VALUES ${appliedMigrations};
      ${createTableSql}
      CREATE INDEX idx_review_selected_import_snapshot_active
      ON app.${tableName}(project_id, project_scope_identity, status, source_delta_high_water);
      INSERT INTO app.${tableName} VALUES (
        'selectedImport:one', 'project-one', 'scope-one', 5, '{"processedRowCount":1}', 'completed',
        'owner-one', 'lease-one', TIMESTAMPTZ '2026-09-26 00:00:00Z', TIMESTAMPTZ '2026-09-25 00:00:00Z',
        TIMESTAMPTZ '2026-09-25 01:00:00Z', 'retained diagnostic',
        TIMESTAMPTZ '2026-09-24 00:00:00Z', TIMESTAMPTZ '2026-09-25 01:00:00Z'
      );
      INSERT INTO app.${tableName} (selected_import_snapshot_id, project_id, project_scope_identity)
      VALUES ('selectedImport:other', 'project-other', 'scope-other');
      CHECKPOINT;
    `)
  })
}

const getSnapshot = (databasePath: string) => {
  return withNativeDatabase(databasePath, async (connection) => {
    const read = async (sql: string) => {
      return (await connection.runAndReadAll(sql)).getRowObjectsJson()
    }
    return {
      columns: await read(`
        SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'app' AND table_name = '${tableName}' ORDER BY ordinal_position
      `),
      checks: await read(`
        SELECT constraint_text FROM duckdb_constraints()
        WHERE schema_name = 'app' AND table_name = '${tableName}' AND constraint_type = 'CHECK'
        ORDER BY constraint_text
      `),
      constraints: await read(`
        SELECT constraint_type FROM duckdb_constraints()
        WHERE schema_name = 'app' AND table_name = '${tableName}' AND constraint_type IN ('PRIMARY KEY', 'UNIQUE')
      `),
      indexes: await read(
        `SELECT index_name FROM duckdb_indexes() WHERE schema_name = 'app' AND table_name = '${tableName}'`,
      ),
      rows: await read(`SELECT * FROM app.${tableName} ORDER BY selected_import_snapshot_id`),
    }
  })
}

const markRepair = (databasePath: string) => {
  const directory = `${databasePath}.startup-recovery`
  mkdirSync(directory, {recursive: true})
  writeFileSync(
    join(directory, 'startup-preflight-active-table.json'),
    JSON.stringify({phase: 'runtime-fatal-index-delete', reason: 'index-delete', schemaName: 'app', tableName}),
  )
}

const runManaged = (databasePath: string, action = 'await migrateDuckdb()', expectRepair = false) => {
  const result = globalThis.Bun.spawnSync(
    [
      process.execPath,
      '-e',
      `
      const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
      const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
      const {writeReviewServingProjectorComponent} = await import('./src/server/reviewServing/reviewServingProjectorWriter.ts')
      const database = getAppDatabaseService()
      try {
        ${action}
      } finally {
        await database.close()
      }
    `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DUCKDB_PATH: databasePath,
        DUCKDB_MEMORY_LIMIT: '20GB',
        SERVER_DUCKDB_OWNER_URL: '',
        SERVER_ROLE: 'maintenance-worker',
        FORSKA_DUCKDB_STARTUP_WAL_PREFLIGHT: 'true',
      },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 120_000,
    },
  )
  const output = `${result.stdout.toString()}\n${result.stderr.toString()}`
  expect(result.exitCode, output).toBe(0)
  if (!expectRepair) {
    expect(output).not.toMatch(
      /rebuilt indexed tables|restarting embedded runtime after fatal|marked indexed table repair/,
    )
  }
  return output
}

const expectIndexFree = (snapshot: Awaited<ReturnType<typeof getSnapshot>>) => {
  expect(snapshot.constraints).toEqual([])
  expect(snapshot.indexes).toEqual([])
}

const expectNoRecovery = (databasePath: string) => {
  const directory = `${databasePath}.startup-recovery`
  expect(existsSync(directory) ? readdirSync(directory) : []).toEqual([])
}

const exerciseWriter = (databasePath: string) => {
  runManaged(
    databasePath,
    `
    const input = {
      component: 'selectedImport',
      selectedImportSnapshotCursor: {
        selectedImportSnapshotId: 'selectedImport:one', projectId: 'project-one', projectScopeIdentity: 'scope-one',
        sourceDeltaHighWater: 8, cursorJson: {processedRowCount: 8}, status: 'completed',
      },
    }
    for (const status of ['candidate', 'completed', 'candidate', 'completed']) {
      await writeReviewServingProjectorComponent({
        ...input, selectedImportSnapshotCursor: {...input.selectedImportSnapshotCursor, status},
      }, database)
    }
    await Promise.all(Array.from({length: 4}, () => writeReviewServingProjectorComponent({
      ...input, selectedImportSnapshotCursor: {...input.selectedImportSnapshotCursor, selectedImportSnapshotId: 'selectedImport:new'},
    }, database)))
    const before = await database.queryJson('SELECT * FROM app.${tableName} ORDER BY selected_import_snapshot_id')
    let rollbackError = null
    try {
      await database.transaction(async (tx) => {
        await writeReviewServingProjectorComponent({
          ...input, selectedImportSnapshotCursor: {...input.selectedImportSnapshotCursor, status: 'candidate'},
        }, {...tx, transaction: async (operation) => operation(tx)})
        await tx.run('SELECT missing_selected_import_fixture_function()')
      })
    } catch (error) { rollbackError = String(error) }
    if (!rollbackError?.includes('missing_selected_import_fixture_function')) throw new Error('expected rollback failure')
    const after = await database.queryJson('SELECT * FROM app.${tableName} ORDER BY selected_import_snapshot_id')
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('rollback changed snapshot rows')
    await database.run('CHECKPOINT')
  `,
  )
}

test('selected-import snapshot migration preserves rows, defaults and checks, and serializes repeated cursor writes across reopen', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forska-selected-import-upgrade-'))
  const path = join(root, 'snapshot.duckdb')
  try {
    await seedIndexedSnapshot(path)
    const before = await getSnapshot(path)
    expect(before.indexes).toHaveLength(1)
    expect(before.constraints).toEqual([{constraint_type: 'PRIMARY KEY'}])
    runManaged(path)
    const migrated = await getSnapshot(path)
    expectIndexFree(migrated)
    expect(migrated.rows).toEqual(before.rows)
    expect(migrated.columns).toEqual(before.columns)
    expect(migrated.checks).toEqual(before.checks)
    runManaged(path)
    expect(await getSnapshot(path)).toEqual(migrated)
    exerciseWriter(path)
    exerciseWriter(path)
    const written = await getSnapshot(path)
    expectIndexFree(written)
    expect(written.rows).toHaveLength(3)
    expect(written.rows[1]).toMatchObject({
      selected_import_snapshot_id: 'selectedImport:one',
      status: 'completed',
      source_delta_high_water: '8',
      cursor_json: '{"processedRowCount":8}',
      last_error: null,
    })
    expect(written.rows[2]).toEqual(before.rows[1])
    expectNoRecovery(path)
  } finally {
    rmSync(root, {recursive: true, force: true})
  }
}, 120_000)

test('pending selected-import snapshot migration replays WAL and bypasses the old indexed-table repair marker', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forska-selected-import-wal-'))
  const path = join(root, 'snapshot.duckdb')
  try {
    await seedIndexedSnapshot(path)
    await withNativeDatabase(path, async (connection) => {
      await connection.run(`
        PRAGMA disable_checkpoint_on_shutdown;
        INSERT INTO app.${tableName} (selected_import_snapshot_id, project_id, project_scope_identity)
        VALUES ('selectedImport:wal', 'project-wal', 'scope-wal');
      `)
    })
    expect(statSync(`${path}.wal`).size).toBeGreaterThan(0)
    markRepair(path)
    runManaged(path)
    const migrated = await getSnapshot(path)
    expectIndexFree(migrated)
    expect(migrated.rows).toHaveLength(3)
    expect(migrated.rows[2]).toMatchObject({selected_import_snapshot_id: 'selectedImport:wal'})
    expectNoRecovery(path)
  } finally {
    rmSync(root, {recursive: true, force: true})
  }
}, 120_000)

test('selected-import snapshot runtime repair removes indexes without dropping rows or schema validation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forska-selected-import-repair-'))
  const path = join(root, 'snapshot.duckdb')
  try {
    await seedIndexedSnapshot(path, true)
    const before = await getSnapshot(path)
    markRepair(path)
    expect(runManaged(path, 'await database.queryJson("SELECT 1")', true)).toContain('rebuilt indexed tables')
    const repaired = await getSnapshot(path)
    expectIndexFree(repaired)
    expect(repaired.rows).toEqual(before.rows)
    expect(repaired.columns).toEqual(before.columns)
    expect(repaired.checks).toEqual(before.checks)
    exerciseWriter(path)
    expectIndexFree(await getSnapshot(path))
  } finally {
    rmSync(root, {recursive: true, force: true})
  }
}, 120_000)
