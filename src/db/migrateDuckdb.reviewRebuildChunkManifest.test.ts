import {existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'

import {DuckDBInstance} from '@duckdb/node-api'
import {expect, test} from 'bun:test'

import {createDuckdbInstance} from '../server/utils/createDuckdbInstance.ts'
import {duckdbEngineCompatibilityOptions} from '../server/utils/duckdbEngineContract.ts'

const migrationsFolder = resolve(import.meta.dir, 'duckdbMigrations')
const targetMigrationFile = '0231_rebuildReviewRebuildChunkManifestWithoutIndexes.sql'

type ChunkManifestSnapshot = {
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

const getChunkManifestSnapshot = async (database: DuckDBConnectionLike): Promise<ChunkManifestSnapshot> => {
  return {
    columns: await database.queryJson(
      `
        SELECT table_name AS tableName, column_name AS columnName, data_type AS dataType,
          is_nullable AS isNullable, column_default AS columnDefault
        FROM information_schema.columns
        WHERE table_schema = 'app'
          AND table_name = 'review_rebuild_chunk_manifest'
        ORDER BY ordinal_position
      `,
    ),
    constraints: await database.queryJson(
      `
        SELECT table_name AS tableName, constraint_type AS constraintType
        FROM duckdb_constraints()
        WHERE schema_name = 'app'
          AND table_name = 'review_rebuild_chunk_manifest'
          AND constraint_type IN ('PRIMARY KEY', 'UNIQUE')
        ORDER BY constraint_type
      `,
    ),
    ddl: await database.queryJson(
      `
        SELECT table_name AS tableName, sql
        FROM duckdb_tables()
        WHERE schema_name = 'app'
          AND table_name = 'review_rebuild_chunk_manifest'
        ORDER BY table_name
      `,
    ),
    indexes: await database.queryJson(
      `
        SELECT table_name AS tableName, index_name AS indexName
        FROM duckdb_indexes()
        WHERE schema_name = 'app'
          AND table_name = 'review_rebuild_chunk_manifest'
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
        SELECT chunk_id AS chunkId, request_id AS requestId, project_id AS projectId,
          projection_component AS projectionComponent, projection_identity AS projectionIdentity,
          status, admission_state AS admissionState, retry_count AS retryCount
        FROM app.review_rebuild_chunk_manifest
        ORDER BY chunk_id
      `,
    ),
  }
}

const seedIndexedChunkManifestDatabase = async (
  databasePath: string,
  options: {allowDuplicateChunkIds?: boolean} = {},
) => {
  const chunkIdColumnSql = options.allowDuplicateChunkIds ? 'chunk_id VARCHAR NOT NULL' : 'chunk_id VARCHAR PRIMARY KEY'
  const extraChunkManifestRows = options.allowDuplicateChunkIds
    ? `,
        ('chunk-1', 'project-1', 'search', 'identity-1', 'a', 'm', 'completed', 'request-1', 0)`
    : ''

  await withNativeDatabase(databasePath, async (database) => {
    await database.run(`
      CREATE SCHEMA IF NOT EXISTS app;
      CREATE TABLE app_schema_migration (
        name VARCHAR PRIMARY KEY,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO app_schema_migration (name) VALUES ${getAppliedMigrationValues(targetMigrationFile)};

      CREATE TABLE app.review_rebuild_request (
        request_id VARCHAR NOT NULL,
        project_id VARCHAR NOT NULL,
        reason VARCHAR NOT NULL,
        requested_components_json JSON NOT NULL DEFAULT '[]',
        source_watermarks_json JSON NOT NULL DEFAULT '{}',
        identity_json JSON NOT NULL DEFAULT '{}',
        priority INTEGER NOT NULL DEFAULT 100,
        status VARCHAR NOT NULL DEFAULT 'admitted',
        admission_state VARCHAR NOT NULL DEFAULT 'admitted',
        retry_policy_json JSON NOT NULL DEFAULT '{}',
        retry_count INTEGER NOT NULL DEFAULT 0,
        retry_after TIMESTAMPTZ,
        oom_category VARCHAR,
        over_budget_reason VARCHAR,
        diagnostics_json JSON NOT NULL DEFAULT '{}',
        lease_owner VARCHAR,
        lease_expires_at TIMESTAMPTZ,
        admitted_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        failed_at TIMESTAMPTZ,
        last_error VARCHAR,
        created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
      );

      CREATE TABLE app.review_rebuild_chunk_manifest (
        ${chunkIdColumnSql},
        project_id VARCHAR,
        projection_component VARCHAR NOT NULL,
        projection_identity VARCHAR NOT NULL,
        input_digest VARCHAR,
        input_watermark BIGINT NOT NULL DEFAULT 0,
        chunk_start_key VARCHAR NOT NULL,
        chunk_end_key VARCHAR NOT NULL,
        output_base_generation BIGINT NOT NULL DEFAULT 0,
        status VARCHAR NOT NULL DEFAULT 'pending',
        checksum VARCHAR,
        lease_owner VARCHAR,
        lease_expires_at TIMESTAMPTZ,
        last_error VARCHAR,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
        request_id VARCHAR,
        parent_chunk_id VARCHAR,
        split_depth INTEGER DEFAULT 0,
        snapshot_id VARCHAR,
        snapshot_count INTEGER DEFAULT 1,
        retry_count INTEGER DEFAULT 0,
        retry_after TIMESTAMPTZ,
        oom_category VARCHAR,
        over_budget_reason VARCHAR,
        estimated_input_rows BIGINT,
        max_input_rows BIGINT,
        actual_input_rows BIGINT,
        estimated_output_rows BIGINT,
        max_output_rows BIGINT,
        actual_output_rows BIGINT,
        estimated_output_bytes BIGINT,
        max_output_bytes BIGINT,
        actual_output_bytes BIGINT,
        estimated_payload_bytes BIGINT,
        max_payload_bytes BIGINT,
        actual_payload_bytes BIGINT,
        estimated_prompt_count BIGINT,
        max_prompt_count BIGINT,
        actual_prompt_count BIGINT,
        estimated_temp_bytes BIGINT,
        max_temp_bytes BIGINT,
        actual_temp_bytes BIGINT,
        duration_ms BIGINT,
        workload_class VARCHAR,
        admission_state VARCHAR DEFAULT 'admitted',
        budget_json JSON DEFAULT '{}',
        diagnostics_json JSON DEFAULT '{}'
      );
      CREATE INDEX idx_review_rebuild_chunk_manifest_status
      ON app.review_rebuild_chunk_manifest(project_id, projection_component, projection_identity, status, chunk_start_key);
      CREATE INDEX idx_review_rebuild_chunk_manifest_request_status
      ON app.review_rebuild_chunk_manifest(request_id, project_id, projection_component, status, admission_state, retry_after);

      INSERT INTO app.review_rebuild_request (request_id, project_id, reason)
      VALUES ('request-1', 'project-1', 'test');
      INSERT INTO app.review_rebuild_chunk_manifest (
        chunk_id, project_id, projection_component, projection_identity,
        chunk_start_key, chunk_end_key, status, request_id, retry_count
      )
      VALUES
        ('chunk-1', 'project-1', 'search', 'identity-1', 'a', 'm', 'pending', 'request-1', 2),
        ('chunk-2', 'project-1', 'summary', 'identity-1', 'n', 'z', 'completed', 'request-1', 0)
        ${extraChunkManifestRows};
      CHECKPOINT;
    `)
  })
}

const appendPendingChunkManifestWal = async (databasePath: string) => {
  await withNativeDatabase(databasePath, async (database) => {
    await database.run(`
      PRAGMA disable_checkpoint_on_shutdown;
      INSERT INTO app.review_rebuild_chunk_manifest (
        chunk_id, project_id, projection_component, projection_identity,
        chunk_start_key, chunk_end_key, status, request_id, retry_count
      )
      VALUES ('chunk-wal', 'project-1', 'display', 'identity-1', 'w', 'x', 'pending', 'request-1', 1);
    `)
  })
}

const writeChunkManifestStartupRepairMarker = (databasePath: string) => {
  const recoveryDirectory = `${databasePath}.startup-recovery`
  mkdirSync(recoveryDirectory, {recursive: true})
  writeFileSync(
    join(recoveryDirectory, 'startup-preflight-active-table.json'),
    JSON.stringify({
      phase: 'runtime-fatal-index-delete',
      reason: 'index-delete',
      repairSpecs: [{schemaName: 'app', tableName: 'review_rebuild_chunk_manifest'}],
      schemaName: 'app',
      tableName: 'review_rebuild_chunk_manifest',
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

const expectChunkManifestTableIsIndexFree = (snapshot: ChunkManifestSnapshot) => {
  expect(snapshot.constraints).toEqual([])
  expect(snapshot.indexes).toEqual([])
  for (const table of snapshot.ddl) {
    expect(table.sql).not.toMatch(/\bPRIMARY\s+KEY\b/i)
    expect(table.sql).not.toMatch(/\bUNIQUE\b/i)
  }
}

test('DuckDB migrations rebuild review rebuild chunk manifests without mutable indexes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forska-chunk-manifest-index-upgrade-'))
  const databasePath = join(root, 'chunk.duckdb')

  try {
    await seedIndexedChunkManifestDatabase(databasePath)
    const before = await withNativeDatabase(databasePath, getChunkManifestSnapshot)
    expect(before.constraints).toEqual([{constraintType: 'PRIMARY KEY', tableName: 'review_rebuild_chunk_manifest'}])
    expect(before.indexes).toHaveLength(2)

    await runManagedMigration(databasePath)

    const migrated = await withNativeDatabase(databasePath, getChunkManifestSnapshot)
    expectChunkManifestTableIsIndexFree(migrated)
    expect(migrated.columns).toEqual(before.columns)
    expect(migrated.rows).toEqual(before.rows)
    expect(migrated.migrations).toEqual([{name: targetMigrationFile}])
    expectNoRecoveryArtifacts(databasePath)

    await runManagedMigration(databasePath)
    expect(await withNativeDatabase(databasePath, getChunkManifestSnapshot)).toEqual(migrated)
    expectNoRecoveryArtifacts(databasePath)
  } finally {
    rmSync(root, {recursive: true, force: true})
  }
}, 120_000)

test('DuckDB migrations dedupe review rebuild chunk manifest rows by repair ordering', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forska-chunk-manifest-dedupe-upgrade-'))
  const databasePath = join(root, 'chunk.duckdb')

  try {
    await seedIndexedChunkManifestDatabase(databasePath, {allowDuplicateChunkIds: true})
    const before = await withNativeDatabase(databasePath, getChunkManifestSnapshot)
    expect(before.rows).toHaveLength(3)

    await runManagedMigration(databasePath)

    const migrated = await withNativeDatabase(databasePath, getChunkManifestSnapshot)
    expectChunkManifestTableIsIndexFree(migrated)
    expect(migrated.rows).toEqual([
      {
        admissionState: 'admitted',
        chunkId: 'chunk-1',
        projectId: 'project-1',
        projectionComponent: 'search',
        projectionIdentity: 'identity-1',
        requestId: 'request-1',
        retryCount: 0,
        status: 'completed',
      },
      {
        admissionState: 'admitted',
        chunkId: 'chunk-2',
        projectId: 'project-1',
        projectionComponent: 'summary',
        projectionIdentity: 'identity-1',
        requestId: 'request-1',
        retryCount: 0,
        status: 'completed',
      },
    ])
    expect(migrated.migrations).toEqual([{name: targetMigrationFile}])
    expectNoRecoveryArtifacts(databasePath)
  } finally {
    rmSync(root, {recursive: true, force: true})
  }
}, 120_000)

test('DuckDB migrations replay pending WAL before chunk-manifest startup repair', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forska-chunk-manifest-index-wal-upgrade-'))
  const databasePath = join(root, 'chunk.duckdb')

  try {
    await seedIndexedChunkManifestDatabase(databasePath)
    await appendPendingChunkManifestWal(databasePath)
    writeChunkManifestStartupRepairMarker(databasePath)
    expect(statSync(`${databasePath}.wal`).size).toBeGreaterThan(0)

    await runManagedMigration(databasePath)

    const migrated = await withNativeDatabase(databasePath, getChunkManifestSnapshot)
    expectChunkManifestTableIsIndexFree(migrated)
    expect(migrated.rows).toHaveLength(3)
    expect(
      migrated.rows.some((row) => {
        return (row as {chunkId?: string}).chunkId === 'chunk-wal'
      }),
    ).toBe(true)
    expectNoRecoveryArtifacts(databasePath)
  } finally {
    rmSync(root, {recursive: true, force: true})
  }
}, 120_000)
