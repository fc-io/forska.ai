import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import type {getAppDatabaseService} from '../server/services/appDatabaseService.ts'
import {createTempRuntimeRoot} from '../server/test/createTempRuntimeRoot.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('migrate-judgment-prompt-failure')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath

const migrationFileName = '0278_judgmentPromptFailure.sql'
const previousMigrationFileName = '0277_providerCostQuotaStats.sql'
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

const getFailureColumns = () => {
  return getDatabase().queryJson<{columnName: string; dataType: string; isNullable: boolean}>(`
    SELECT column_name AS columnName, data_type AS dataType, is_nullable AS isNullable
    FROM duckdb_columns()
    WHERE schema_name = 'app'
      AND table_name = 'judgment_prompt_failure'
    ORDER BY column_index
  `)
}

const getInsertFailureSql = (input: {claimId: string; failureCount?: number; modelId: string; reason?: string}) => {
  return `
    INSERT INTO app.judgment_prompt_failure (
      article_id, prompt_id, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images, use_metadata,
      system_prompt_variant, full_text_strategy_id, project_id, judgment_job_id, queue_prompt_id, last_claim_id,
      failure_code, reason, provider_kind, model_name, attempt_count, failure_count, first_failed_at, last_failed_at
    ) VALUES (
      'article-1', 'prompt-1', '${input.modelId}', TRUE, TRUE, FALSE, FALSE, TRUE, 'screening_v5', 'fts-none',
      'project-1', 'job-1', 'queue-1', '${input.claimId}', 'claude_code_request_failed',
      '${input.reason ?? 'Claude Code request failed: subtype=error_max_turns stderr='}', 'claude-code',
      'claude-opus-5-5', 3, ${input.failureCount ?? 1}, TIMESTAMPTZ '2026-10-27T19:40:05Z',
      TIMESTAMPTZ '2026-10-27T19:40:05Z'
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

test('the migration only creates the prompt failure table and has no comments', () => {
  expect(migrationSql).not.toContain('--')
  expect(migrationSql).not.toMatch(/\bUPDATE\b/i)
  expect(migrationSql).not.toMatch(/\bINSERT\b/i)
  expect(migrationSql).toContain('CREATE TABLE IF NOT EXISTS app.judgment_prompt_failure (')
})

test('the migration creates app.judgment_prompt_failure keyed on the judgment identity', async () => {
  expect(await getFailureColumns()).toEqual([])

  await getMigrateDuckdb()({throughFileName: migrationFileName})

  expect(await getFailureColumns()).toEqual([
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
    {columnName: 'last_claim_id', dataType: 'VARCHAR', isNullable: false},
    {columnName: 'failure_code', dataType: 'VARCHAR', isNullable: false},
    {columnName: 'reason', dataType: 'VARCHAR', isNullable: false},
    {columnName: 'provider_kind', dataType: 'VARCHAR', isNullable: true},
    {columnName: 'model_name', dataType: 'VARCHAR', isNullable: true},
    {columnName: 'attempt_count', dataType: 'INTEGER', isNullable: false},
    {columnName: 'failure_count', dataType: 'INTEGER', isNullable: false},
    {columnName: 'first_failed_at', dataType: 'TIMESTAMP WITH TIME ZONE', isNullable: false},
    {columnName: 'last_failed_at', dataType: 'TIMESTAMP WITH TIME ZONE', isNullable: false},
    {columnName: 'created_at', dataType: 'TIMESTAMP WITH TIME ZONE', isNullable: false},
    {columnName: 'updated_at', dataType: 'TIMESTAMP WITH TIME ZONE', isNullable: false},
  ])
})

test('one failure row per judgment identity, another model is a separate row, and re-running keeps rows', async () => {
  await getDatabase().run(getInsertFailureSql({claimId: 'claim-1', modelId: 'model-1'}))

  expect(
    await getRejection(getDatabase().run(getInsertFailureSql({claimId: 'claim-2', modelId: 'model-1'}))),
  ).toBeInstanceOf(Error)

  await getDatabase().run(getInsertFailureSql({claimId: 'claim-3', modelId: 'model-2'}))
  await getDatabase().run(migrationSql)

  expect(
    await getDatabase().queryJson<{lastClaimId: string; modelId: string}>(`
      SELECT model_id AS modelId, last_claim_id AS lastClaimId
      FROM app.judgment_prompt_failure
      ORDER BY model_id
    `),
  ).toEqual([
    {lastClaimId: 'claim-1', modelId: 'model-1'},
    {lastClaimId: 'claim-3', modelId: 'model-2'},
  ])
})

test('the failure table rejects an empty reason and a zero failure count', async () => {
  expect(
    await getRejection(getDatabase().run(getInsertFailureSql({claimId: 'claim-4', modelId: 'model-3', reason: ' '}))),
  ).toBeInstanceOf(Error)
  expect(
    await getRejection(
      getDatabase().run(getInsertFailureSql({claimId: 'claim-5', failureCount: 0, modelId: 'model-4'})),
    ),
  ).toBeInstanceOf(Error)
})
