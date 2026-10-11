import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import type {getAppDatabaseService} from '../server/services/appDatabaseService.ts'
import {createTempRuntimeRoot} from '../server/test/createTempRuntimeRoot.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('migrate-judgment-job-stop-conditions')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath

const migrationFileName = '0263_judgmentJobStopConditions.sql'
const previousMigrationFileName = '0262_comparisonConflictResolutionComment.sql'
const migrationSql = readFileSync(resolve(import.meta.dir, 'duckdbMigrations', migrationFileName), 'utf8')
const stopColumnNames = [
  'stop_after_articles',
  'stop_when_human_answered_done',
  'stop_after_total_tokens',
  'stop_at',
  'stop_reason',
  'stop_reason_at',
]

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

const getStopColumns = () => {
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
      AND table_name = 'judgment_job'
      AND column_name IN (${stopColumnNames
        .map((columnName) => {
          return `'${columnName}'`
        })
        .join(', ')})
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

test('the migration only adds nullable judgment job columns and has no comments', () => {
  expect(migrationSql).not.toContain('--')
  expect(migrationSql).not.toMatch(/\bUPDATE\b/i)
  expect(migrationSql).not.toMatch(/\bINSERT\b/i)
  expect(migrationSql).not.toMatch(/\bINDEX\b/i)
  expect(migrationSql).not.toMatch(/NOT NULL/i)
})

test('the migration adds the stop condition columns and keeps existing jobs unchanged', async () => {
  await getDatabase().run(`
    INSERT INTO app.project (id, name, model_id) VALUES ('stop-project', 'Stop project', 'stop-model')
  `)
  await getDatabase().run(`
    INSERT INTO app.judgment_job (id, project_id, status) VALUES ('stop-job', 'stop-project', 'running')
  `)

  expect(await getStopColumns()).toEqual([])

  await getMigrateDuckdb()({throughFileName: migrationFileName})

  expect(await getStopColumns()).toEqual([
    {columnDefault: null, columnName: 'stop_after_articles', dataType: 'INTEGER', isNullable: true},
    {columnDefault: 'false', columnName: 'stop_when_human_answered_done', dataType: 'BOOLEAN', isNullable: true},
    {columnDefault: null, columnName: 'stop_after_total_tokens', dataType: 'BIGINT', isNullable: true},
    {columnDefault: null, columnName: 'stop_at', dataType: 'TIMESTAMP WITH TIME ZONE', isNullable: true},
    {columnDefault: null, columnName: 'stop_reason', dataType: 'VARCHAR', isNullable: true},
    {columnDefault: null, columnName: 'stop_reason_at', dataType: 'TIMESTAMP WITH TIME ZONE', isNullable: true},
  ])
  expect(
    await getDatabase().queryJson<{
      stopAfterArticles: number | null
      stopReason: string | null
      stopWhenHumanAnsweredDone: boolean | null
      status: string
    }>(`
      SELECT
        status,
        stop_after_articles AS stopAfterArticles,
        stop_when_human_answered_done AS stopWhenHumanAnsweredDone,
        stop_reason AS stopReason
      FROM app.judgment_job
      WHERE id = 'stop-job'
    `),
  ).toEqual([{status: 'running', stopAfterArticles: null, stopReason: null, stopWhenHumanAnsweredDone: false}])
})

test('re-running the migration keeps stored stop conditions', async () => {
  await getDatabase().run(`
    UPDATE app.judgment_job
    SET stop_after_articles = 2000,
        stop_after_total_tokens = 5000000000,
        stop_when_human_answered_done = TRUE
    WHERE id = 'stop-job'
  `)

  await getDatabase().run(migrationSql)

  expect(
    await getDatabase().queryJson<{
      stopAfterArticles: number
      stopAfterTotalTokens: number
      stopWhenHumanAnsweredDone: boolean
    }>(`
      SELECT
        stop_after_articles AS stopAfterArticles,
        CAST(stop_after_total_tokens AS DOUBLE) AS stopAfterTotalTokens,
        stop_when_human_answered_done AS stopWhenHumanAnsweredDone
      FROM app.judgment_job
      WHERE id = 'stop-job'
    `),
  ).toEqual([{stopAfterArticles: 2000, stopAfterTotalTokens: 5_000_000_000, stopWhenHumanAnsweredDone: true}])
})
