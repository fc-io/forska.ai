import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import type {getAppDatabaseService} from '../server/services/appDatabaseService.ts'
import {createTempRuntimeRoot} from '../server/test/createTempRuntimeRoot.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('migrate-comparison-serving-system-prompt-variant')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath

const migrationFileName = '0253_comparisonServingSystemPromptVariant.sql'
const previousMigrationFileName = '0252_reviewChangeDeltaSystemPromptVariant.sql'
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

const getVariantServingColumns = () => {
  return getDatabase().queryJson<{columnDefault: string | null; columnName: string; dataType: string}>(`
    SELECT column_name AS columnName, data_type AS dataType, column_default AS columnDefault
    FROM duckdb_columns()
    WHERE schema_name = 'mart'
      AND table_name = 'comparison_system_prompt_variant_serving'
    ORDER BY column_index
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

test('the migration only creates the served variant table', () => {
  expect(migrationSql).not.toMatch(/\bUPDATE\b/i)
  expect(migrationSql).not.toMatch(/\bINSERT\b/i)
  expect(migrationSql).not.toMatch(/\bDROP\b/i)
  expect(migrationSql).not.toMatch(/--/)
})

test('the migration creates an empty served variant table that defaults to legacy and is idempotent', async () => {
  expect(await getVariantServingColumns()).toEqual([])

  await getMigrateDuckdb()({throughFileName: migrationFileName})

  expect(await getVariantServingColumns()).toEqual([
    {columnDefault: null, columnName: 'comparison_project_id', dataType: 'VARCHAR'},
    {columnDefault: null, columnName: 'generation', dataType: 'BIGINT'},
    {columnDefault: "'legacy'", columnName: 'system_prompt_variant', dataType: 'VARCHAR'},
    {columnDefault: 'current_timestamp', columnName: 'variant_updated_at', dataType: 'TIMESTAMP WITH TIME ZONE'},
  ])

  await getDatabase().run(`
    INSERT INTO mart.comparison_system_prompt_variant_serving (comparison_project_id, generation)
    VALUES ('comparison-1', 1)
  `)
  await getMigrateDuckdb()({throughFileName: migrationFileName})

  expect(
    await getDatabase().queryJson<{systemPromptVariant: string}>(`
      SELECT system_prompt_variant AS systemPromptVariant
      FROM mart.comparison_system_prompt_variant_serving
    `),
  ).toEqual([{systemPromptVariant: 'legacy'}])
  expect(
    await getDatabase().queryJson<{name: string}>(`
      SELECT name
      FROM app_schema_migration
      WHERE name = '${migrationFileName}'
    `),
  ).toEqual([{name: migrationFileName}])
})
