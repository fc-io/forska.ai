import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import type {getAppDatabaseService} from '../server/services/appDatabaseService.ts'
import {createTempRuntimeRoot} from '../server/test/createTempRuntimeRoot.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('migrate-user-config-figure-description-model')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath

const migrationFileName = '0272_userConfigFigureDescriptionModel.sql'
const previousMigrationFileName = '0270_comparisonServingFullTextStrategy.sql'
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

test('the migration only adds one nullable user_config column and has no comments', () => {
  expect(migrationSql.trim()).toBe(
    'ALTER TABLE app.user_config ADD COLUMN IF NOT EXISTS figure_description_model_id VARCHAR;',
  )
})

test('an existing local user keeps its settings and gets no figure-description model', async () => {
  await getDatabase().run(`
    INSERT INTO app.user_config (id, name, email, role, full_text_conversion_model_id)
    VALUES ('local-user', 'Local user', 'local@example.com', NULL, NULL)
  `)
  await getMigrateDuckdb()({throughFileName: migrationFileName})

  const [column] = await getDatabase().queryJson<{dataType: string; isNullable: boolean}>(`
    SELECT data_type AS dataType, is_nullable AS isNullable
    FROM duckdb_columns()
    WHERE schema_name = 'app' AND table_name = 'user_config' AND column_name = 'figure_description_model_id'
  `)
  const [row] = await getDatabase().queryJson<{figureDescriptionModelId: string | null; name: string}>(`
    SELECT name, figure_description_model_id AS figureDescriptionModelId FROM app.user_config WHERE id = 'local-user'
  `)

  expect(column).toEqual({dataType: 'VARCHAR', isNullable: true})
  expect(row).toEqual({figureDescriptionModelId: null, name: 'Local user'})

  await getDatabase().run(`UPDATE app.user_config SET figure_description_model_id = 'model-vlm'`)
  await getMigrateDuckdb()({throughFileName: migrationFileName})

  const [kept] = await getDatabase().queryJson<{figureDescriptionModelId: string | null}>(`
    SELECT figure_description_model_id AS figureDescriptionModelId FROM app.user_config WHERE id = 'local-user'
  `)

  expect(kept).toEqual({figureDescriptionModelId: 'model-vlm'})
})
