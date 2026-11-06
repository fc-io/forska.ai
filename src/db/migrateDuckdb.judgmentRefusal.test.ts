import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import type {getAppDatabaseService} from '../server/services/appDatabaseService.ts'
import {createTempRuntimeRoot} from '../server/test/createTempRuntimeRoot.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('migrate-judgment-refusal')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath

const migrationFileName = '0275_judgmentRefusal.sql'
const previousMigrationFileName = '0274_covidenceSourceUrlBackfill.sql'
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

const getRefusalColumns = () => {
  return getDatabase().queryJson<{columnName: string; dataType: string; isNullable: boolean}>(`
    SELECT column_name AS columnName, data_type AS dataType, is_nullable AS isNullable
    FROM duckdb_columns()
    WHERE schema_name = 'app'
      AND table_name = 'judgment_refusal'
    ORDER BY column_index
  `)
}

const getInsertRefusalSql = (queuePromptId: string, modelId: string) => {
  return `
    INSERT INTO app.judgment_refusal (
      article_id, prompt_id, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images, use_metadata,
      system_prompt_variant, full_text_strategy_id, project_id, judgment_job_id, queue_prompt_id, failure_code,
      provider_kind, model_name, reason, refused_at
    ) VALUES (
      'article-1', 'prompt-1', '${modelId}', TRUE, TRUE, FALSE, FALSE, FALSE, 'screening_v5', 'fts-none', 'project-1',
      'job-1', '${queuePromptId}', 'claude_code_content_refusal', 'claude-code', 'claude-opus-5-5',
      'safeguards flagged this message', TIMESTAMPTZ '2026-11-06T06:59:13Z'
    )
  `
}

const getRejection = (promise: Promise<unknown>) => {
  return promise.then(
    () => {
      return null
    },
    (error: unknown) => {
      return error
    },
  )
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

test('the migration only creates the refusal table and has no comments', () => {
  expect(migrationSql).not.toContain('--')
  expect(migrationSql).not.toMatch(/\bUPDATE\b/i)
  expect(migrationSql).not.toMatch(/\bINSERT\b/i)
  expect(migrationSql).toContain('CREATE TABLE IF NOT EXISTS app.judgment_refusal (')
})

test('the migration creates app.judgment_refusal keyed on the judgment identity', async () => {
  expect(await getRefusalColumns()).toEqual([])

  await getMigrateDuckdb()({throughFileName: migrationFileName})

  expect(await getRefusalColumns()).toEqual([
    {columnName: 'article_id', dataType: 'VARCHAR', isNullable: false},
    {columnName: 'prompt_id', dataType: 'VARCHAR', isNullable: false},
    {columnName: 'model_id', dataType: 'VARCHAR', isNullable: false},
    {columnName: 'use_title', dataType: 'BOOLEAN', isNullable: false},
    {columnName: 'use_abstract', dataType: 'BOOLEAN', isNullable: false},
    {columnName: 'use_fulltext', dataType: 'BOOLEAN', isNullable: false},
    {columnName: 'use_fulltext_no_images', dataType: 'BOOLEAN', isNullable: false},
    {columnName: 'use_metadata', dataType: 'BOOLEAN', isNullable: false},
    {columnName: 'system_prompt_variant', dataType: 'VARCHAR', isNullable: false},
    {columnName: 'full_text_strategy_id', dataType: 'VARCHAR', isNullable: false},
    {columnName: 'project_id', dataType: 'VARCHAR', isNullable: false},
    {columnName: 'judgment_job_id', dataType: 'VARCHAR', isNullable: false},
    {columnName: 'queue_prompt_id', dataType: 'VARCHAR', isNullable: false},
    {columnName: 'failure_code', dataType: 'VARCHAR', isNullable: false},
    {columnName: 'provider_kind', dataType: 'VARCHAR', isNullable: true},
    {columnName: 'model_name', dataType: 'VARCHAR', isNullable: false},
    {columnName: 'reason', dataType: 'VARCHAR', isNullable: false},
    {columnName: 'refused_at', dataType: 'TIMESTAMP WITH TIME ZONE', isNullable: false},
    {columnName: 'created_at', dataType: 'TIMESTAMP WITH TIME ZONE', isNullable: false},
  ])
})

test('one refusal per judgment identity, another model is a separate row, and re-running keeps rows', async () => {
  await getDatabase().run(getInsertRefusalSql('queue-1', 'model-1'))

  expect(await getRejection(getDatabase().run(getInsertRefusalSql('queue-2', 'model-1')))).toBeInstanceOf(Error)

  await getDatabase().run(getInsertRefusalSql('queue-3', 'model-2'))
  await getDatabase().run(migrationSql)

  expect(
    await getDatabase().queryJson<{modelId: string; queuePromptId: string}>(`
      SELECT model_id AS modelId, queue_prompt_id AS queuePromptId
      FROM app.judgment_refusal
      ORDER BY model_id
    `),
  ).toEqual([
    {modelId: 'model-1', queuePromptId: 'queue-1'},
    {modelId: 'model-2', queuePromptId: 'queue-3'},
  ])
})
