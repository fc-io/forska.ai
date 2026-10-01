import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import type {getAppDatabaseService} from '../server/services/appDatabaseService.ts'
import {createTempRuntimeRoot} from '../server/test/createTempRuntimeRoot.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('migrate-comparison-serving-use-metadata')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath

const migrationFileName = '0258_comparisonServingUseMetadata.sql'
const servedVariantTableMigrationFileName = '0253_comparisonServingSystemPromptVariant.sql'
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

const getUseMetadataColumns = () => {
  return getDatabase().queryJson<{columnDefault: string | null; dataType: string}>(`
    SELECT data_type AS dataType, column_default AS columnDefault
    FROM duckdb_columns()
    WHERE schema_name = 'mart'
      AND table_name = 'comparison_system_prompt_variant_serving'
      AND column_name = 'use_metadata'
  `)
}

const getServedRows = () => {
  return getDatabase().queryJson<{comparisonProjectId: string; systemPromptVariant: string; useMetadata: boolean}>(`
    SELECT
      comparison_project_id AS comparisonProjectId,
      system_prompt_variant AS systemPromptVariant,
      use_metadata AS useMetadata
    FROM mart.comparison_system_prompt_variant_serving
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
  await migrateDuckdb({throughFileName: servedVariantTableMigrationFileName})

  database = getAppDatabaseService()
})

afterAll(async () => {
  await database?.close()
  tempRuntimeRoot.cleanup()
})

test('the migration only adds the served metadata column', () => {
  expect(migrationSql).not.toMatch(/\bUPDATE\b/i)
  expect(migrationSql).not.toMatch(/\bINSERT\b/i)
  expect(migrationSql).not.toMatch(/\bDROP\b/i)
  expect(migrationSql).not.toMatch(/--/)
  expect(migrationSql).not.toMatch(/\bcomparison_project\b/i)
  expect(migrationSql.trim()).toBe(
    'ALTER TABLE mart.comparison_system_prompt_variant_serving ADD COLUMN IF NOT EXISTS use_metadata BOOLEAN DEFAULT FALSE;',
  )
})

test('existing served variants read as without metadata and the migration is idempotent', async () => {
  await getDatabase().run(`
    INSERT INTO mart.comparison_system_prompt_variant_serving (comparison_project_id, generation, system_prompt_variant)
    VALUES ('comparison-1', 1, 'legacy'), ('comparison-2', 3, 'screening_v1')
  `)

  expect(await getUseMetadataColumns()).toEqual([])

  await getMigrateDuckdb()()

  expect(await getUseMetadataColumns()).toEqual([{columnDefault: 'false', dataType: 'BOOLEAN'}])
  expect(await getServedRows()).toEqual([
    {comparisonProjectId: 'comparison-1', systemPromptVariant: 'legacy', useMetadata: false},
    {comparisonProjectId: 'comparison-2', systemPromptVariant: 'screening_v1', useMetadata: false},
  ])

  await getDatabase().run(`
    INSERT INTO mart.comparison_system_prompt_variant_serving (comparison_project_id, generation)
    VALUES ('comparison-3', 1)
  `)
  await getMigrateDuckdb()()

  expect(await getServedRows()).toEqual([
    {comparisonProjectId: 'comparison-1', systemPromptVariant: 'legacy', useMetadata: false},
    {comparisonProjectId: 'comparison-2', systemPromptVariant: 'screening_v1', useMetadata: false},
    {comparisonProjectId: 'comparison-3', systemPromptVariant: 'legacy', useMetadata: false},
  ])
  expect(
    await getDatabase().queryJson<{name: string}>(`
      SELECT name
      FROM app_schema_migration
      WHERE name = '${migrationFileName}'
    `),
  ).toEqual([{name: migrationFileName}])
  expect(
    await getDatabase().queryJson<{columnName: string}>(`
      SELECT column_name AS columnName
      FROM duckdb_columns()
      WHERE schema_name = 'app'
        AND table_name = 'comparison_project'
        AND column_name = 'use_metadata'
    `),
  ).toEqual([])
})
