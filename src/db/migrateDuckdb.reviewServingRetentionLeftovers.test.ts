import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import type {getAppDatabaseService} from '../server/services/appDatabaseService.ts'
import {createTempRuntimeRoot} from '../server/test/createTempRuntimeRoot.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('migrate-review-serving-retention-leftovers')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath

const migrationSql = readFileSync(
  resolve(import.meta.dir, 'duckdbMigrations', '0249_dropReviewServingRetentionLeftovers.sql'),
  'utf8',
)
const startupRepairTables = [
  'review_article_filter_posting_serving_v4_startup_repair_2026_07_20T04_51_01_138Z_8ad6f4ba_e26d_4495_a08b_362903bcbd67',
  'review_article_judgment_detail_serving_v4_startup_repair_2026_07_09T07_52_46_601Z_0e39cf75_887e_4221_ad44_e67c5e6f9af5',
  'review_article_serving_v4_startup_repair_2026_07_09T07_59_40_396Z_3e972f40_3065_4a53_8f71_ca5c10946a85',
  'review_article_serving_v4_startup_repair_2026_07_09T08_01_49_917Z_917ddde6_a7e7_4c85_a5fe_a48cab7435a1',
] as const

let database: ReturnType<typeof getAppDatabaseService> | null = null

const getDatabase = () => {
  if (database === null) {
    throw new Error('Database not initialized')
  }

  return database
}

const getLeftoverTableNames = async () => {
  const rows = await getDatabase().queryJson<{tableName: string}>(`
    SELECT schema_name || '.' || table_name AS tableName
    FROM duckdb_tables()
    WHERE table_name LIKE '%\\_startup\\_repair\\_%' ESCAPE '\\'
      OR (schema_name = 'app' AND table_name = 'review_serving_retention_mark')
    ORDER BY tableName
  `)

  return rows.map((row) => {
    return row.tableName
  })
}

beforeAll(async () => {
  const [{migrateDuckdb}, {getAppDatabaseService}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}] =
    await Promise.all([
      import('./migrateDuckdb.ts'),
      import('../server/services/appDatabaseService.ts'),
      import('../server/utils/duckdbService.ts'),
      import('../server/utils/serverRuntimeRole.ts'),
    ])

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()
  await migrateDuckdb()

  database = getAppDatabaseService()
})

afterAll(async () => {
  await database?.close()
  tempRuntimeRoot.cleanup()
})

test('the migration drops the retention mark and the empty startup repair copies', async () => {
  expect(await getLeftoverTableNames()).toEqual([])

  await getDatabase().run(`
    CREATE TABLE app.review_serving_retention_mark (retention_scope VARCHAR PRIMARY KEY, cleanup_cursor_json JSON)
  `)
  await startupRepairTables.reduce<Promise<void>>(async (previous, tableName) => {
    await previous
    await getDatabase().run(`CREATE TABLE mart."${tableName}" (project_id VARCHAR, snapshot_id VARCHAR)`)
  }, Promise.resolve())

  expect(await getLeftoverTableNames()).toHaveLength(startupRepairTables.length + 1)

  await getDatabase().run(migrationSql)

  expect(await getLeftoverTableNames()).toEqual([])
})
