import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import type {getAppDatabaseService} from '../server/services/appDatabaseService.ts'
import {createTempRuntimeRoot} from '../server/test/createTempRuntimeRoot.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('migrate-drop-user-config-figure-description-model')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath

const migrationFileName = '0273_dropUserConfigFigureDescriptionModel.sql'
const previousMigrationFileName = '0272_userConfigFigureDescriptionModel.sql'
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

test('the migration only drops the figure-description model column and has no comments', () => {
  expect(migrationSql.trim()).toBe('ALTER TABLE app.user_config DROP COLUMN IF EXISTS figure_description_model_id;')
})

const getFigureDescriptionColumnCount = async () => {
  const [row] = await getDatabase().queryJson<{columnCount: number | bigint}>(`
    SELECT COUNT(*) AS columnCount
    FROM duckdb_columns()
    WHERE schema_name = 'app' AND table_name = 'user_config' AND column_name = 'figure_description_model_id'
  `)

  return Number(row?.columnCount ?? 0)
}

test('the column is dropped and the local user keeps its other settings', async () => {
  await getDatabase().run(`
    INSERT INTO app.user_config (id, name, email, role, full_text_conversion_model_id, figure_description_model_id)
    VALUES ('local-user', 'Local user', 'local@example.com', NULL, 'model-mineru', 'model-vlm')
  `)

  expect(await getFigureDescriptionColumnCount()).toBe(1)

  await getMigrateDuckdb()({throughFileName: migrationFileName})

  const [row] = await getDatabase().queryJson<{email: string; fullTextConversionModelId: string | null; name: string}>(`
    SELECT name, email, full_text_conversion_model_id AS fullTextConversionModelId
    FROM app.user_config
    WHERE id = 'local-user'
  `)

  expect(await getFigureDescriptionColumnCount()).toBe(0)
  expect(row).toEqual({email: 'local@example.com', fullTextConversionModelId: 'model-mineru', name: 'Local user'})

  await getMigrateDuckdb()({throughFileName: migrationFileName})

  expect(await getFigureDescriptionColumnCount()).toBe(0)
})
