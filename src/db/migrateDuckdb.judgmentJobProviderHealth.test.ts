import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import type {getAppDatabaseService} from '../server/services/appDatabaseService.ts'
import {createTempRuntimeRoot} from '../server/test/createTempRuntimeRoot.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('migrate-judgment-job-provider-health')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath

const migrationFileName = '0259_judgmentJobProviderHealth.sql'
const previousMigrationFileName = '0258_comparisonServingUseMetadata.sql'
const migrationSql = readFileSync(resolve(import.meta.dir, 'duckdbMigrations', migrationFileName), 'utf8')

let database: ReturnType<typeof getAppDatabaseService> | null = null
let migrateDuckdb: typeof import('./migrateDuckdb.ts').migrateDuckdb | null = null

const getDatabase = () => {
  if (database === null) {
    throw new Error('Database not initialized')
  }

  return database
}

const getMigrateDuckdb = () => {
  if (migrateDuckdb === null) {
    throw new Error('Migrations not initialized')
  }

  return migrateDuckdb
}

const getProviderHealthColumns = () => {
  return getDatabase().queryJson<{
    columnDefault: string | null
    columnName: string
    dataType: string
    isNullable: boolean
  }>(`
    SELECT
      column_name AS columnName,
      data_type AS dataType,
      is_nullable AS isNullable,
      lower(column_default) AS columnDefault
    FROM duckdb_columns()
    WHERE schema_name = 'app'
      AND table_name = 'judgment_job_provider_health'
    ORDER BY column_index
  `)
}

const getProviderHealthRows = () => {
  return getDatabase().queryJson<{consecutiveFailureCount: number; jobId: string; totalFailureCount: number}>(`
    SELECT
      job_id AS jobId,
      CAST(consecutive_failure_count AS INTEGER) AS consecutiveFailureCount,
      CAST(total_failure_count AS INTEGER) AS totalFailureCount
    FROM app.judgment_job_provider_health
    ORDER BY job_id
  `)
}

beforeAll(async () => {
  const [migrateModule, {getAppDatabaseService}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}] =
    await Promise.all([
      import('./migrateDuckdb.ts'),
      import('../server/services/appDatabaseService.ts'),
      import('../server/utils/duckdbService.ts'),
      import('../server/utils/serverRuntimeRole.ts'),
    ])

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()
  migrateDuckdb = migrateModule.migrateDuckdb
  await migrateDuckdb({throughFileName: previousMigrationFileName})

  database = getAppDatabaseService()
})

afterAll(async () => {
  await database?.close()
  tempRuntimeRoot.cleanup()
})

test('the migration only creates the provider health table and has no comments', () => {
  expect(migrationSql).not.toContain('--')
  expect(migrationSql).not.toMatch(/\bUPDATE\b/i)
  expect(migrationSql).not.toMatch(/\bINSERT\b/i)
  expect(migrationSql).not.toMatch(/\bINDEX\b/i)
  expect(migrationSql).toContain('CREATE TABLE IF NOT EXISTS app.judgment_job_provider_health (')
})

test('the migration creates app.judgment_job_provider_health with the provider health columns', async () => {
  expect(await getProviderHealthColumns()).toEqual([])

  await getMigrateDuckdb()({throughFileName: migrationFileName})

  expect(await getProviderHealthColumns()).toEqual([
    {columnDefault: null, columnName: 'job_id', dataType: 'VARCHAR', isNullable: false},
    {columnDefault: null, columnName: 'model_id', dataType: 'VARCHAR', isNullable: true},
    {columnDefault: null, columnName: 'status', dataType: 'VARCHAR', isNullable: false},
    {columnDefault: null, columnName: 'failure_kind', dataType: 'VARCHAR', isNullable: false},
    {columnDefault: null, columnName: 'failure_code', dataType: 'VARCHAR', isNullable: true},
    {columnDefault: null, columnName: 'failure_message', dataType: 'VARCHAR', isNullable: true},
    {columnDefault: null, columnName: 'retry_after_at', dataType: 'TIMESTAMP WITH TIME ZONE', isNullable: true},
    {columnDefault: null, columnName: 'first_failed_at', dataType: 'TIMESTAMP WITH TIME ZONE', isNullable: false},
    {columnDefault: null, columnName: 'last_failed_at', dataType: 'TIMESTAMP WITH TIME ZONE', isNullable: false},
    {columnDefault: '0', columnName: 'consecutive_failure_count', dataType: 'INTEGER', isNullable: false},
    {columnDefault: '0', columnName: 'total_failure_count', dataType: 'INTEGER', isNullable: false},
    {columnDefault: null, columnName: 'last_success_at', dataType: 'TIMESTAMP WITH TIME ZONE', isNullable: true},
    {columnDefault: null, columnName: 'recovered_at', dataType: 'TIMESTAMP WITH TIME ZONE', isNullable: true},
    {
      columnDefault: 'current_timestamp',
      columnName: 'created_at',
      dataType: 'TIMESTAMP WITH TIME ZONE',
      isNullable: false,
    },
    {
      columnDefault: 'current_timestamp',
      columnName: 'updated_at',
      dataType: 'TIMESTAMP WITH TIME ZONE',
      isNullable: false,
    },
  ])
  expect(
    await getDatabase().queryJson<{name: string}>(`
      SELECT name
      FROM app_schema_migration
      WHERE name = '${migrationFileName}'
    `),
  ).toEqual([{name: migrationFileName}])
})

test('the table keeps one row per job and re-running the migration keeps existing rows', async () => {
  await getDatabase().run(`
    INSERT INTO app.judgment_job_provider_health (
      job_id, status, failure_kind, first_failed_at, last_failed_at
    ) VALUES (
      'job-1', 'failing', 'usage_limit', TIMESTAMPTZ '2026-10-03T05:17:00Z', TIMESTAMPTZ '2026-10-03T05:17:00Z'
    )
  `)

  const duplicateInsertError = await getDatabase()
    .run(
      `
      INSERT INTO app.judgment_job_provider_health (
        job_id, status, failure_kind, first_failed_at, last_failed_at
      ) VALUES (
        'job-1', 'failing', 'other', TIMESTAMPTZ '2026-10-03T05:18:00Z', TIMESTAMPTZ '2026-10-03T05:18:00Z'
      )
    `,
    )
    .then(
      () => {
        return null
      },
      (error: unknown) => {
        return error
      },
    )

  expect(duplicateInsertError).toBeInstanceOf(Error)

  await getDatabase().run(migrationSql)

  expect(await getProviderHealthRows()).toEqual([{consecutiveFailureCount: 0, jobId: 'job-1', totalFailureCount: 0}])
})
