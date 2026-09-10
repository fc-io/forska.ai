import {existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'

import {DuckDBInstance} from '@duckdb/node-api'
import {expect, test} from 'bun:test'

import {createDuckdbInstance} from '../server/utils/createDuckdbInstance.ts'
import {duckdbEngineCompatibilityOptions} from '../server/utils/duckdbEngineContract.ts'

const migrationsFolder = resolve(import.meta.dir, 'duckdbMigrations')
const targetMigrationFile = '0229_rebuildJudgmentWorkflowMutableTablesWithoutIndexes.sql'
const workflowTableNames = ['judgment_job', 'comparison_project_serving_generation'] as const
const workflowTableList = workflowTableNames
  .map((tableName) => {
    return `'${tableName}'`
  })
  .join(', ')

type WorkflowSnapshot = {
  columns: unknown[]
  constraints: unknown[]
  ddl: Array<{sql: string; tableName: string}>
  indexes: unknown[]
  judgmentJobs: unknown[]
  migrations: Array<{name: string}>
  servingGenerations: unknown[]
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

type DuckDBConnectionLike = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
}

const getWorkflowSnapshot = async (database: DuckDBConnectionLike): Promise<WorkflowSnapshot> => {
  return {
    columns: await database.queryJson(
      `
        SELECT table_name AS tableName, column_name AS columnName, data_type AS dataType,
          is_nullable AS isNullable, column_default AS columnDefault
        FROM information_schema.columns
        WHERE table_schema = 'app'
          AND table_name IN (${workflowTableList})
        ORDER BY table_name, ordinal_position
      `,
    ),
    constraints: await database.queryJson(
      `
        SELECT table_name AS tableName, constraint_type AS constraintType
        FROM duckdb_constraints()
        WHERE schema_name = 'app'
          AND table_name IN (${workflowTableList})
          AND constraint_type IN ('PRIMARY KEY', 'UNIQUE')
        ORDER BY table_name, constraint_type
      `,
    ),
    ddl: await database.queryJson(
      `
        SELECT table_name AS tableName, sql
        FROM duckdb_tables()
        WHERE schema_name = 'app'
          AND table_name IN (${workflowTableList})
        ORDER BY table_name
      `,
    ),
    indexes: await database.queryJson(
      `
        SELECT table_name AS tableName, index_name AS indexName
        FROM duckdb_indexes()
        WHERE schema_name = 'app'
          AND table_name IN (${workflowTableList})
        ORDER BY table_name, index_name
      `,
    ),
    judgmentJobs: await database.queryJson(
      `
        SELECT id, project_id AS projectId, status, CAST("error" AS VARCHAR) AS errorJson,
          storage_state AS storageState, quarantine_reason AS quarantineReason,
          CAST(last_import_exit_code AS INTEGER) AS lastImportExitCode,
          CAST(import_failure_count AS INTEGER) AS importFailureCount,
          CAST(send_to_llm_batch_size AS INTEGER) AS sendToLlmBatchSize,
          CAST(send_to_llm_interval AS INTEGER) AS sendToLlmInterval,
          cursor_last_article_id AS cursorLastArticleId
        FROM app.judgment_job
        ORDER BY id
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
    servingGenerations: await database.queryJson(
      `
        SELECT comparison_project_id AS comparisonProjectId,
          CAST(active_generation AS INTEGER) AS activeGeneration,
          serving_status AS servingStatus,
          CAST(serving_generation AS INTEGER) AS servingGeneration,
          serving_error AS servingError,
          serving_phase AS servingPhase,
          CAST(serving_staged_article_count AS INTEGER) AS servingStagedArticleCount,
          CAST(serving_staged_cell_count AS INTEGER) AS servingStagedCellCount,
          CAST(serving_staged_filter_member_count AS INTEGER) AS servingStagedFilterMemberCount,
          CAST(serving_staged_filter_stats_count AS INTEGER) AS servingStagedFilterStatsCount,
          CAST(serving_total_article_count AS INTEGER) AS servingTotalArticleCount,
          CAST(serving_total_cell_count AS INTEGER) AS servingTotalCellCount
        FROM app.comparison_project_serving_generation
        ORDER BY comparison_project_id
      `,
    ),
  }
}

const seedOldWorkflowDatabase = async (databasePath: string) => {
  await withNativeDatabase(databasePath, async (database) => {
    await database.run(`
      CREATE SCHEMA IF NOT EXISTS app;
      CREATE TABLE app_schema_migration (
        name VARCHAR PRIMARY KEY,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO app_schema_migration (name) VALUES ${getAppliedMigrationValues(targetMigrationFile)};

      CREATE TABLE app.judgment_job (
        id VARCHAR PRIMARY KEY,
        project_id VARCHAR NOT NULL,
        status VARCHAR NOT NULL,
        "error" JSON,
        storage_state VARCHAR NOT NULL DEFAULT 'active',
        quarantined_at TIMESTAMPTZ,
        quarantine_reason VARCHAR,
        last_import_started_at TIMESTAMPTZ,
        last_import_completed_at TIMESTAMPTZ,
        last_import_error_at TIMESTAMPTZ,
        last_import_error VARCHAR,
        last_import_exit_code INTEGER,
        import_failure_count INTEGER NOT NULL DEFAULT 0,
        pause_requested_at TIMESTAMPTZ,
        send_to_llm_batch_size INTEGER NOT NULL DEFAULT 5,
        send_to_llm_interval INTEGER NOT NULL DEFAULT 15,
        cursor_last_created_at TIMESTAMPTZ,
        cursor_last_article_id VARCHAR,
        created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
      );
      CREATE INDEX IF NOT EXISTS idx_app_judgment_job_status_storage_project
      ON app.judgment_job(status, storage_state, project_id);
      CREATE INDEX IF NOT EXISTS idx_app_judgment_job_storage_status_updated
      ON app.judgment_job(storage_state, status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_app_judgment_job_quarantine_recovery
      ON app.judgment_job(storage_state, quarantined_at, updated_at);

      CREATE TABLE app.comparison_project_serving_generation (
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
      );
      CREATE INDEX IF NOT EXISTS idx_app_comparison_project_serving_generation_active
      ON app.comparison_project_serving_generation(comparison_project_id, active_generation);

      INSERT INTO app.judgment_job (
        id, project_id, status, "error", storage_state, quarantine_reason,
        last_import_exit_code, import_failure_count, send_to_llm_batch_size,
        send_to_llm_interval, cursor_last_article_id, created_at, updated_at
      )
      VALUES
        (
          'job-active', 'project-a', 'running', '{"kind":"active"}'::JSON, 'active', NULL,
          NULL, 2, 7, 19, 'article-2',
          TIMESTAMPTZ '2026-09-01T10:00:00Z', TIMESTAMPTZ '2026-09-01T10:05:00Z'
        ),
        (
          'job-quarantined', 'project-b', 'failed', '{"kind":"failed"}'::JSON, 'quarantined',
          'fixture quarantine', 42, 3, 5, 15, NULL,
          TIMESTAMPTZ '2026-09-01T11:00:00Z', TIMESTAMPTZ '2026-09-01T11:05:00Z'
        );

      INSERT INTO app.comparison_project_serving_generation (
        comparison_project_id, active_generation, generation_updated_at, serving_status,
        serving_generation, serving_started_at, serving_completed_at, serving_failed_at,
        serving_error, serving_phase, serving_phase_started_at, serving_last_progressed_at,
        serving_staged_article_count, serving_staged_cell_count,
        serving_staged_filter_member_count, serving_staged_filter_stats_count,
        serving_total_article_count, serving_total_cell_count
      )
      VALUES
        (
          'comparison-a', 12, TIMESTAMPTZ '2026-09-01T12:00:00Z', 'running',
          11, TIMESTAMPTZ '2026-09-01T12:01:00Z', NULL, NULL,
          NULL, 'publish', TIMESTAMPTZ '2026-09-01T12:02:00Z',
          TIMESTAMPTZ '2026-09-01T12:03:00Z', 23, 29, 31, 37, 41, 43
        );
      CHECKPOINT;
    `)
  })
}

const appendPendingWorkflowWal = async (databasePath: string) => {
  await withNativeDatabase(databasePath, async (database) => {
    await database.run(`
      PRAGMA disable_checkpoint_on_shutdown;
      INSERT INTO app.judgment_job (
        id, project_id, status, "error", storage_state, quarantine_reason,
        last_import_exit_code, import_failure_count, send_to_llm_batch_size,
        send_to_llm_interval, cursor_last_article_id, created_at, updated_at
      )
      VALUES (
        'job-pending-wal', 'project-wal', 'ready', '{"kind":"pending-wal"}'::JSON,
        'active', NULL, NULL, 0, 5, 15, 'article-wal',
        TIMESTAMPTZ '2026-09-02T10:00:00Z',
        TIMESTAMPTZ '2026-09-02T10:05:00Z'
      );
    `)
  })
}

const writeWorkflowStartupRepairMarker = (databasePath: string) => {
  const recoveryDirectory = `${databasePath}.startup-recovery`
  mkdirSync(recoveryDirectory, {recursive: true})
  writeFileSync(
    join(recoveryDirectory, 'startup-preflight-active-table.json'),
    JSON.stringify({
      phase: 'runtime-fatal-index-delete',
      reason: 'index-delete',
      repairSpecs: [{schemaName: 'app', tableName: 'judgment_job'}],
      schemaName: 'app',
      tableName: 'judgment_job',
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

const expectWorkflowTablesAreIndexFree = (snapshot: WorkflowSnapshot) => {
  expect(snapshot.constraints).toEqual([])
  expect(snapshot.indexes).toEqual([])
  for (const table of snapshot.ddl) {
    expect(table.sql).not.toMatch(/\bPRIMARY\s+KEY\b/i)
  }
}

test('DuckDB migrations rebuild judgment workflow mutable tables before startup recovery is needed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forska-workflow-inline-pk-upgrade-'))
  const databasePath = join(root, 'workflow.duckdb')

  try {
    await seedOldWorkflowDatabase(databasePath)
    const before = await withNativeDatabase(databasePath, getWorkflowSnapshot)
    expect(before.constraints).toEqual([
      {constraintType: 'PRIMARY KEY', tableName: 'comparison_project_serving_generation'},
      {constraintType: 'PRIMARY KEY', tableName: 'judgment_job'},
    ])
    expect(before.indexes).toHaveLength(4)

    await runManagedMigration(databasePath)

    const migrated = await withNativeDatabase(databasePath, getWorkflowSnapshot)
    expectWorkflowTablesAreIndexFree(migrated)
    expect(migrated.columns).toEqual(before.columns)
    expect(migrated.judgmentJobs).toEqual(before.judgmentJobs)
    expect(migrated.servingGenerations).toEqual(before.servingGenerations)
    expect(migrated.migrations).toEqual([{name: targetMigrationFile}])
    expectNoRecoveryArtifacts(databasePath)

    await runManagedMigration(databasePath)
    expect(await withNativeDatabase(databasePath, getWorkflowSnapshot)).toEqual(migrated)
    expectNoRecoveryArtifacts(databasePath)
  } finally {
    rmSync(root, {recursive: true, force: true})
  }
}, 120_000)

test('DuckDB migrations replay pending WAL before workflow indexed-table startup repair', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forska-workflow-inline-pk-wal-upgrade-'))
  const databasePath = join(root, 'workflow.duckdb')

  try {
    await seedOldWorkflowDatabase(databasePath)
    await appendPendingWorkflowWal(databasePath)
    expect(statSync(`${databasePath}.wal`).size).toBeGreaterThan(0)

    await runManagedMigration(databasePath)

    const migrated = await withNativeDatabase(databasePath, getWorkflowSnapshot)
    expectWorkflowTablesAreIndexFree(migrated)
    expect(migrated.judgmentJobs).toContainEqual(
      expect.objectContaining({id: 'job-pending-wal', projectId: 'project-wal', status: 'ready'}),
    )
    expect(migrated.migrations).toEqual([{name: targetMigrationFile}])
    expectNoRecoveryArtifacts(databasePath)
  } finally {
    rmSync(root, {recursive: true, force: true})
  }
}, 120_000)

test('DuckDB migrations ignore stale workflow indexed-table repair marker when cleanup migration is pending', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forska-workflow-inline-pk-marker-wal-upgrade-'))
  const databasePath = join(root, 'workflow.duckdb')

  try {
    await seedOldWorkflowDatabase(databasePath)
    await appendPendingWorkflowWal(databasePath)
    writeWorkflowStartupRepairMarker(databasePath)
    expect(statSync(`${databasePath}.wal`).size).toBeGreaterThan(0)

    await runManagedMigration(databasePath)

    const migrated = await withNativeDatabase(databasePath, getWorkflowSnapshot)
    expectWorkflowTablesAreIndexFree(migrated)
    expect(migrated.judgmentJobs).toContainEqual(
      expect.objectContaining({id: 'job-pending-wal', projectId: 'project-wal', status: 'ready'}),
    )
    expect(migrated.migrations).toEqual([{name: targetMigrationFile}])
    expectNoRecoveryArtifacts(databasePath)
  } finally {
    rmSync(root, {recursive: true, force: true})
  }
}, 120_000)

test('fresh DuckDB migrations create judgment workflow mutable tables without primary keys or indexes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forska-workflow-inline-pk-fresh-'))
  const databasePath = join(root, 'workflow.duckdb')

  try {
    await runManagedMigration(databasePath)
    const snapshot = await withNativeDatabase(databasePath, getWorkflowSnapshot)
    expectWorkflowTablesAreIndexFree(snapshot)
    expect(snapshot.migrations).toEqual([{name: targetMigrationFile}])
    expectNoRecoveryArtifacts(databasePath)
  } finally {
    rmSync(root, {recursive: true, force: true})
  }
}, 120_000)
