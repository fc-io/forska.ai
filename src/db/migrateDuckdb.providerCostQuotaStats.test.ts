import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import type {getAppDatabaseService} from '../server/services/appDatabaseService.ts'
import {createTempRuntimeRoot} from '../server/test/createTempRuntimeRoot.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('migrate-provider-cost-quota-stats')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath

const migrationFileName = '0277_providerCostQuotaStats.sql'
const previousMigrationFileName = '0276_reviewArticleServingLlmRefusedPromptCount.sql'
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

const getColumns = (tableName: string) => {
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
      column_default AS columnDefault
    FROM duckdb_columns()
    WHERE schema_name = 'app'
      AND table_name = '${tableName}'
    ORDER BY column_index
  `)
}

const getIndexCount = (tableName: string) => {
  return getDatabase().queryJson<{indexCount: number}>(`
    SELECT COUNT(*)::INTEGER AS indexCount
    FROM duckdb_indexes()
    WHERE schema_name = 'app'
      AND table_name = '${tableName}'
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

test('the migration has no line comments, no semicolons inside its block comment and no secondary index', () => {
  const blockComment = migrationSql.slice(migrationSql.indexOf('/*'), migrationSql.indexOf('*/'))

  expect(migrationSql).not.toContain('--')
  expect(blockComment).not.toContain(';')
  expect(migrationSql).not.toMatch(/CREATE\s+(UNIQUE\s+)?INDEX/i)
  expect(migrationSql).not.toMatch(/ADD COLUMN[^;]*DEFAULT/i)
})

test('existing token_use rows keep NULL in the seven new nullable columns', async () => {
  await getDatabase().run(`
    INSERT INTO app.token_use (id, requests, total_prompt_tokens, total_completion_tokens, total_tokens)
    VALUES ('before-migration', 1, 10, 5, 15)
  `)

  await getMigrateDuckdb()({throughFileName: migrationFileName})

  const newColumns = (await getColumns('token_use')).filter((column) => {
    return [
      'cache_creation_input_tokens',
      'cache_read_input_tokens',
      'thinking_tokens',
      'model_id',
      'provider_kind',
      'provider_connection_id',
      'model_name',
    ].includes(column.columnName)
  })

  expect(newColumns).toEqual([
    {columnDefault: null, columnName: 'cache_creation_input_tokens', dataType: 'BIGINT', isNullable: true},
    {columnDefault: null, columnName: 'cache_read_input_tokens', dataType: 'BIGINT', isNullable: true},
    {columnDefault: null, columnName: 'thinking_tokens', dataType: 'BIGINT', isNullable: true},
    {columnDefault: null, columnName: 'model_id', dataType: 'VARCHAR', isNullable: true},
    {columnDefault: null, columnName: 'provider_kind', dataType: 'VARCHAR', isNullable: true},
    {columnDefault: null, columnName: 'provider_connection_id', dataType: 'VARCHAR', isNullable: true},
    {columnDefault: null, columnName: 'model_name', dataType: 'VARCHAR', isNullable: true},
  ])
  expect(
    await getDatabase().queryJson(`
      SELECT cache_creation_input_tokens, cache_read_input_tokens, thinking_tokens, model_id, provider_kind,
        provider_connection_id, model_name
      FROM app.token_use
      WHERE id = 'before-migration'
    `),
  ).toEqual([
    {
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      model_id: null,
      model_name: null,
      provider_connection_id: null,
      provider_kind: null,
      thinking_tokens: null,
    },
  ])
  expect(await getIndexCount('token_use')).toEqual([{indexCount: 0}])
})

test('the weights table is seeded with the verified list-price ratios', async () => {
  expect(
    await getDatabase().queryJson(`
      SELECT
        provider_kind AS providerKind,
        model_name_pattern AS pattern,
        input_weight AS input,
        cache_creation_weight AS cacheCreation,
        cache_read_weight AS cacheRead,
        output_weight AS output,
        thinking_weight AS thinking
      FROM app.provider_token_weight
      ORDER BY provider_kind, model_name_pattern
    `),
  ).toEqual([
    {
      cacheCreation: 1.25,
      cacheRead: 0.1,
      input: 1,
      output: 5,
      pattern: 'claude-opus-%',
      providerKind: 'anthropic',
      thinking: 5,
    },
    {
      cacheCreation: 1.25,
      cacheRead: 0.05,
      input: 1,
      output: 5,
      pattern: 'claude-opus-5-5',
      providerKind: 'anthropic',
      thinking: 5,
    },
    {
      cacheCreation: 1.25,
      cacheRead: 0.1,
      input: 1,
      output: 5,
      pattern: 'claude-opus-%',
      providerKind: 'claude-code',
      thinking: 5,
    },
    {
      cacheCreation: 1.25,
      cacheRead: 0.05,
      input: 1,
      output: 5,
      pattern: 'claude-opus-5-5',
      providerKind: 'claude-code',
      thinking: 5,
    },
    {
      cacheCreation: 1.25,
      cacheRead: 0.1,
      input: 1,
      output: 5,
      pattern: 'gpt-6-astra',
      providerKind: 'codex',
      thinking: 5,
    },
    {
      cacheCreation: 1.25,
      cacheRead: 0.1,
      input: 1,
      output: 5,
      pattern: 'gpt-6-astra',
      providerKind: 'openai',
      thinking: 5,
    },
  ])
})

test('the quota reading table has no index and keeps raw JSON required', async () => {
  expect(
    (await getColumns('provider_quota_reading')).map((column) => {
      return `${column.columnName}:${column.dataType}:${column.isNullable ? 'null' : 'not null'}`
    }),
  ).toEqual([
    'provider_connection_id:VARCHAR:not null',
    'provider_kind:VARCHAR:not null',
    'limit_kind:VARCHAR:not null',
    'utilization_percent:DOUBLE:not null',
    'resets_at:TIMESTAMP WITH TIME ZONE:null',
    'is_active:BOOLEAN:null',
    'scope_json:JSON:null',
    'raw_json:JSON:not null',
    'observed_at:TIMESTAMP WITH TIME ZONE:not null',
    'created_at:TIMESTAMP WITH TIME ZONE:not null',
  ])
  expect(await getIndexCount('provider_quota_reading')).toEqual([{indexCount: 0}])
})

test('re-running the migration keeps the seeded weights and the columns', async () => {
  await getDatabase().run(migrationSql)

  expect(await getDatabase().queryJson(`SELECT COUNT(*)::INTEGER AS count FROM app.provider_token_weight`)).toEqual([
    {count: 6},
  ])
})
