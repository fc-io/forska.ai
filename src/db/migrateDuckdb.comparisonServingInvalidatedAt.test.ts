import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import type {getAppDatabaseService} from '../server/services/appDatabaseService.ts'
import {createTempRuntimeRoot} from '../server/test/createTempRuntimeRoot.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('migrate-comparison-serving-invalidated-at')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath

const migrationFileName = '0259_comparisonServingInvalidatedAt.sql'
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

const getInvalidatedAtColumns = () => {
  return getDatabase().queryJson<{columnDefault: string | null; dataType: string; isNullable: boolean}>(`
    SELECT data_type AS dataType, column_default AS columnDefault, is_nullable AS isNullable
    FROM duckdb_columns()
    WHERE schema_name = 'app'
      AND table_name = 'comparison_project_serving_generation'
      AND column_name = 'serving_invalidated_at'
  `)
}

const getStatusRows = () => {
  return getDatabase().queryJson<{
    activeGeneration: string
    comparisonProjectId: string
    isInvalidated: boolean
    servingStatus: string | null
  }>(`
    SELECT
      comparison_project_id AS comparisonProjectId,
      CAST(active_generation AS VARCHAR) AS activeGeneration,
      serving_status AS servingStatus,
      serving_invalidated_at IS NOT NULL AS isInvalidated
    FROM app.comparison_project_serving_generation
    ORDER BY comparison_project_id ASC
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

test('the migration only adds the nullable invalidation timestamp column', () => {
  expect(migrationSql).not.toMatch(/\bUPDATE\b/i)
  expect(migrationSql).not.toMatch(/\bINSERT\b/i)
  expect(migrationSql).not.toMatch(/\bDROP\b/i)
  expect(migrationSql).not.toMatch(/--/)
  expect(migrationSql.trim()).toBe(
    'ALTER TABLE app.comparison_project_serving_generation ADD COLUMN IF NOT EXISTS serving_invalidated_at TIMESTAMPTZ;',
  )
})

test('existing status rows read as never invalidated and the migration is idempotent', async () => {
  await getDatabase().run(`
    INSERT INTO app.comparison_project_serving_generation (comparison_project_id, active_generation, serving_status)
    VALUES ('comparison-1', 1, 'ready'), ('comparison-2', 0, 'refreshing')
  `)

  expect(await getInvalidatedAtColumns()).toEqual([])

  await getMigrateDuckdb()()

  expect(await getInvalidatedAtColumns()).toEqual([
    {columnDefault: null, dataType: 'TIMESTAMP WITH TIME ZONE', isNullable: true},
  ])
  expect(await getStatusRows()).toEqual([
    {activeGeneration: '1', comparisonProjectId: 'comparison-1', isInvalidated: false, servingStatus: 'ready'},
    {activeGeneration: '0', comparisonProjectId: 'comparison-2', isInvalidated: false, servingStatus: 'refreshing'},
  ])

  await getDatabase().run(`
    INSERT INTO app.comparison_project_serving_generation (comparison_project_id, active_generation, serving_status, serving_invalidated_at)
    VALUES ('comparison-3', 2, 'stale', TIMESTAMPTZ '2026-10-03T12:00:00.000Z')
  `)
  await getMigrateDuckdb()()

  expect(await getStatusRows()).toEqual([
    {activeGeneration: '1', comparisonProjectId: 'comparison-1', isInvalidated: false, servingStatus: 'ready'},
    {activeGeneration: '0', comparisonProjectId: 'comparison-2', isInvalidated: false, servingStatus: 'refreshing'},
    {activeGeneration: '2', comparisonProjectId: 'comparison-3', isInvalidated: true, servingStatus: 'stale'},
  ])
  expect(
    await getDatabase().queryJson<{name: string}>(`
      SELECT name
      FROM app_schema_migration
      WHERE name = '${migrationFileName}'
    `),
  ).toEqual([{name: migrationFileName}])
})
