import {existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'

import {DuckDBInstance} from '@duckdb/node-api'
import {expect, test} from 'bun:test'

import {createDuckdbInstance} from '../server/utils/createDuckdbInstance.ts'
import {duckdbEngineCompatibilityOptions} from '../server/utils/duckdbEngineContract.ts'

const migrationsFolder = resolve(import.meta.dir, 'duckdbMigrations')
const targetMigrationFile = '0230_rebuildComparisonConflictResolutionWithoutIndexes.sql'

type ConflictResolutionSnapshot = {
  columns: unknown[]
  constraints: unknown[]
  ddl: Array<{sql: string; tableName: string}>
  indexes: unknown[]
  migrations: Array<{name: string}>
  rows: unknown[]
}

type DuckDBConnectionLike = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
}

const getDuckdbMigrationFiles = () => {
  return readdirSync(migrationsFolder)
    .filter((fileName) => {
      return fileName.endsWith('.sql')
    })
    .sort((left, right) => {
      return left.localeCompare(right)
    })
}

const getAppliedMigrationValues = (omittedMigrationFile: string) => {
  return getDuckdbMigrationFiles()
    .filter((fileName) => {
      return fileName !== omittedMigrationFile
    })
    .map((fileName) => {
      return `('${fileName.replaceAll("'", "''")}')`
    })
    .join(', ')
}

const getAvailableLocalPorts = async (count: number) => {
  const servers = Array.from({length: count}, () => {
    return globalThis.Bun.serve({
      fetch: () => {
        return new Response('ok')
      },
      hostname: '127.0.0.1',
      port: 0,
    })
  })
  const ports = servers.map((server) => {
    return server.port
  })
  await Promise.all(
    servers.map((server) => {
      return server.stop(true)
    }),
  )

  return ports
}

const getManagedMigrationPorts = async () => {
  const ports = await getAvailableLocalPorts(2)

  if (ports.length !== 2) {
    throw new Error(`Expected 2 available ports, received ${ports.length}`)
  }

  return {apiPort: String(ports[0]), vitePort: String(ports[1])}
}

const withNativeDatabase = async <T>(
  databasePath: string,
  operation: (connection: DuckDBConnectionLike) => Promise<T>,
) => {
  const instance = await createDuckdbInstance({
    create: DuckDBInstance.create.bind(DuckDBInstance),
    databasePath,
    options: {...duckdbEngineCompatibilityOptions, memory_limit: '20GB'},
  })
  const connection = await instance.connect()

  try {
    return await operation({
      queryJson: async <R>(statement: string) => {
        return (await connection.runAndReadAll(statement)).getRowObjectsJson() as R[]
      },
      run: async (statement: string) => {
        await connection.run(statement)
      },
    })
  } finally {
    connection.closeSync()
    instance.closeSync()
  }
}

const getConflictResolutionSnapshot = async (database: DuckDBConnectionLike): Promise<ConflictResolutionSnapshot> => {
  return {
    columns: await database.queryJson(
      `
        SELECT table_name AS tableName, column_name AS columnName, data_type AS dataType,
          is_nullable AS isNullable, column_default AS columnDefault
        FROM information_schema.columns
        WHERE table_schema = 'app'
          AND table_name = 'comparison_project_conflict_resolution'
        ORDER BY ordinal_position
      `,
    ),
    constraints: await database.queryJson(
      `
        SELECT table_name AS tableName, constraint_type AS constraintType
        FROM duckdb_constraints()
        WHERE schema_name = 'app'
          AND table_name = 'comparison_project_conflict_resolution'
          AND constraint_type IN ('PRIMARY KEY', 'UNIQUE')
        ORDER BY constraint_type
      `,
    ),
    ddl: await database.queryJson(
      `
        SELECT table_name AS tableName, sql
        FROM duckdb_tables()
        WHERE schema_name = 'app'
          AND table_name = 'comparison_project_conflict_resolution'
        ORDER BY table_name
      `,
    ),
    indexes: await database.queryJson(
      `
        SELECT table_name AS tableName, index_name AS indexName
        FROM duckdb_indexes()
        WHERE schema_name = 'app'
          AND table_name = 'comparison_project_conflict_resolution'
        ORDER BY index_name
      `,
    ),
    migrations: await database.queryJson(
      `
        SELECT name
        FROM app_schema_migration
        WHERE name = '${targetMigrationFile}'
        ORDER BY name
      `,
    ),
    rows: await database.queryJson(
      `
        SELECT id, comparison_project_id AS comparisonProjectId, article_id AS articleId,
          prompt_id AS promptId, answer_value AS answerValue, reviewer_user_id AS reviewerUserId
        FROM app.comparison_project_conflict_resolution
        ORDER BY comparison_project_id, article_id, id
      `,
    ),
  }
}

const seedOldConflictResolutionDatabase = async (databasePath: string) => {
  await withNativeDatabase(databasePath, async (database) => {
    await database.run(`
      CREATE SCHEMA IF NOT EXISTS app;
      CREATE TABLE app_schema_migration (
        name VARCHAR PRIMARY KEY,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO app_schema_migration (name) VALUES ${getAppliedMigrationValues(targetMigrationFile)};

      CREATE TABLE app.article(id VARCHAR PRIMARY KEY);
      CREATE TABLE app.prompt(id VARCHAR PRIMARY KEY);
      INSERT INTO app.article(id) VALUES ('article-1'), ('article-2'), ('article-3');
      INSERT INTO app.prompt(id) VALUES ('prompt-1'), ('prompt-2');

      CREATE TABLE app.comparison_project_conflict_resolution (
        id VARCHAR PRIMARY KEY,
        comparison_project_id VARCHAR NOT NULL,
        article_id VARCHAR NOT NULL REFERENCES app.article(id),
        prompt_id VARCHAR REFERENCES app.prompt(id),
        answer_value VARCHAR,
        created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
        reviewer_user_id VARCHAR,
        UNIQUE(comparison_project_id, article_id)
      );
      CREATE INDEX IF NOT EXISTS idx_app_comparison_project_conflict_resolution_lookup
      ON app.comparison_project_conflict_resolution(comparison_project_id, article_id);

      INSERT INTO app.comparison_project_conflict_resolution (
        id, comparison_project_id, article_id, prompt_id, answer_value,
        created_at, updated_at, reviewer_user_id
      )
      VALUES
        (
          'resolution-1', 'comparison-1', 'article-1', NULL, 'maybe',
          TIMESTAMPTZ '2026-09-01T10:00:00Z',
          TIMESTAMPTZ '2026-09-01T10:05:00Z',
          'reviewer-1'
        ),
        (
          'resolution-2', 'comparison-1', 'article-2', 'prompt-2', NULL,
          TIMESTAMPTZ '2026-09-01T11:00:00Z',
          TIMESTAMPTZ '2026-09-01T11:05:00Z',
          'reviewer-2'
        );
      CHECKPOINT;
    `)
  })
}

const appendPendingConflictResolutionWal = async (databasePath: string) => {
  await withNativeDatabase(databasePath, async (database) => {
    await database.run(`
      PRAGMA disable_checkpoint_on_shutdown;
      INSERT INTO app.comparison_project_conflict_resolution (
        id, comparison_project_id, article_id, prompt_id, answer_value,
        reviewer_user_id
      )
      VALUES (
        'resolution-wal', 'comparison-1', 'article-3', NULL, 'yes',
        'reviewer-wal'
      );
    `)
  })
}

const writeConflictResolutionStartupRepairMarker = (databasePath: string) => {
  const recoveryDirectory = `${databasePath}.startup-recovery`
  mkdirSync(recoveryDirectory, {recursive: true})
  writeFileSync(
    join(recoveryDirectory, 'startup-preflight-active-table.json'),
    JSON.stringify({
      phase: 'runtime-fatal-index-delete',
      reason: 'index-delete',
      repairSpecs: [{schemaName: 'app', tableName: 'comparison_project_conflict_resolution'}],
      schemaName: 'app',
      tableName: 'comparison_project_conflict_resolution',
    }),
  )
}

const runManagedMigration = async (databasePath: string) => {
  const {apiPort, vitePort} = await getManagedMigrationPorts()
  const result = globalThis.Bun.spawnSync(
    [
      process.execPath,
      '-e',
      `
        const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
        const {closeDuckdbService} = await import('./src/server/utils/duckdbService.ts')
        try {
          await migrateDuckdb()
        } finally {
          await closeDuckdbService().catch(() => {})
        }
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: apiPort,
        DUCKDB_MEMORY_LIMIT: '20GB',
        DUCKDB_PATH: databasePath,
        FORSKA_DUCKDB_STARTUP_WAL_PREFLIGHT: 'true',
        SERVER_DUCKDB_OWNER_URL: '',
        SERVER_ROLE: 'maintenance-worker',
        VITE_PORT: vitePort,
      },
      stderr: 'pipe',
      stdout: 'pipe',
      timeout: 120_000,
    },
  )
  const output = `${result.stdout.toString()}\n${result.stderr.toString()}`
  expect(result.exitCode, output).toBe(0)
  expect(output).not.toMatch(
    /duckdb\.startup\.indexed-table-repair|rebuilt indexed tables|startup-preflight-active-table/,
  )
}

const expectNoRecoveryArtifacts = (databasePath: string) => {
  const recoveryPath = `${databasePath}.startup-recovery`
  const recoveryFiles = existsSync(recoveryPath) ? readdirSync(recoveryPath) : []
  expect(
    recoveryFiles.filter((fileName) => {
      return /recovery\.json$|pre-repair\.duckdb|startup-preflight-active-table/.test(fileName)
    }),
  ).toEqual([])
}

const expectConflictResolutionTableIsIndexFree = (snapshot: ConflictResolutionSnapshot) => {
  expect(snapshot.constraints).toEqual([])
  expect(snapshot.indexes).toEqual([])
  for (const table of snapshot.ddl) {
    expect(table.sql).not.toMatch(/\bPRIMARY\s+KEY\b/i)
    expect(table.sql).not.toMatch(/\bUNIQUE\b/i)
  }
}

test('DuckDB migrations rebuild comparison conflict resolutions without mutable indexes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forska-conflict-resolution-index-upgrade-'))
  const databasePath = join(root, 'conflict.duckdb')

  try {
    await seedOldConflictResolutionDatabase(databasePath)
    const before = await withNativeDatabase(databasePath, getConflictResolutionSnapshot)
    expect(before.constraints).toEqual([
      {constraintType: 'PRIMARY KEY', tableName: 'comparison_project_conflict_resolution'},
      {constraintType: 'UNIQUE', tableName: 'comparison_project_conflict_resolution'},
    ])
    expect(before.indexes).toHaveLength(1)

    await runManagedMigration(databasePath)

    const migrated = await withNativeDatabase(databasePath, getConflictResolutionSnapshot)
    expectConflictResolutionTableIsIndexFree(migrated)
    expect(migrated.columns).toEqual(before.columns)
    expect(migrated.rows).toEqual(before.rows)
    expect(migrated.migrations).toEqual([{name: targetMigrationFile}])
    expectNoRecoveryArtifacts(databasePath)

    await runManagedMigration(databasePath)
    expect(await withNativeDatabase(databasePath, getConflictResolutionSnapshot)).toEqual(migrated)
    expectNoRecoveryArtifacts(databasePath)
  } finally {
    rmSync(root, {recursive: true, force: true})
  }
}, 120_000)

test('DuckDB migrations replay pending WAL before conflict-resolution startup repair', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forska-conflict-resolution-index-wal-upgrade-'))
  const databasePath = join(root, 'conflict.duckdb')

  try {
    await seedOldConflictResolutionDatabase(databasePath)
    await appendPendingConflictResolutionWal(databasePath)
    writeConflictResolutionStartupRepairMarker(databasePath)
    expect(statSync(`${databasePath}.wal`).size).toBeGreaterThan(0)

    await runManagedMigration(databasePath)

    const migrated = await withNativeDatabase(databasePath, getConflictResolutionSnapshot)
    expectConflictResolutionTableIsIndexFree(migrated)
    expect(migrated.rows).toHaveLength(3)
    expect(
      migrated.rows.some((row) => {
        return (row as {id?: string}).id === 'resolution-wal'
      }),
    ).toBe(true)
    expectNoRecoveryArtifacts(databasePath)
  } finally {
    rmSync(root, {recursive: true, force: true})
  }
}, 120_000)
