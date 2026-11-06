import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import type {getAppDatabaseService} from '../server/services/appDatabaseService.ts'
import {createTempRuntimeRoot} from '../server/test/createTempRuntimeRoot.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('migrate-review-article-serving-llm-refused-prompt-count')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath

const migrationFileName = '0276_reviewArticleServingLlmRefusedPromptCount.sql'
const previousMigrationFileName = '0275_judgmentRefusal.sql'
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

const getListModeStateColumns = () => {
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
    WHERE schema_name = 'mart'
      AND table_name = 'review_article_serving_list_mode_state_v4'
    ORDER BY column_index
  `)
}

const getListModeStateIndexNames = () => {
  return getDatabase().queryJson<{indexName: string}>(`
    SELECT index_name AS indexName
    FROM duckdb_indexes()
    WHERE schema_name = 'mart'
      AND table_name = 'review_article_serving_list_mode_state_v4'
    ORDER BY index_name
  `)
}

const getListModeStateRows = () => {
  return getDatabase().queryJson<{
    articleId: string
    conflictFlag: boolean
    duplicateFlag: boolean
    hasLlmListMode: boolean
    llmHasJudgment: boolean
    llmPatchWatermark: number | null
    llmRefusedPromptCount: number
    llmStatus: string | null
  }>(`
    SELECT
      article_id AS articleId,
      has_llm_list_mode AS hasLlmListMode,
      CAST(llm_patch_watermark AS INTEGER) AS llmPatchWatermark,
      duplicate_flag AS duplicateFlag,
      conflict_flag AS conflictFlag,
      llm_status AS llmStatus,
      llm_has_judgment AS llmHasJudgment,
      llm_refused_prompt_count AS llmRefusedPromptCount
    FROM mart.review_article_serving_list_mode_state_v4
    ORDER BY article_id
  `)
}

const getRunError = async (statement: string) => {
  return getDatabase()
    .run(statement)
    .then(
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

test('the migration rebuilds the list-mode state table without comments, updates or indexes', () => {
  expect(migrationSql).not.toContain('--')
  expect(migrationSql).not.toMatch(/\bUPDATE\b/i)
  expect(migrationSql).not.toMatch(/\bINDEX\b/i)
  expect(migrationSql).toContain(
    'ALTER TABLE mart.review_article_serving_list_mode_state_v4_refused_count_repair RENAME TO review_article_serving_list_mode_state_v4;',
  )
})

test('existing list-mode state rows survive the rebuild with a zero refused prompt count', async () => {
  expect(await getListModeStateIndexNames()).toEqual([])

  await getDatabase().run(`
    INSERT INTO mart.review_article_serving_list_mode_state_v4 (
      project_id, review_config_hash, snapshot_id, article_id, has_llm_list_mode, llm_patch_watermark,
      duplicate_flag, conflict_flag, llm_status, llm_has_judgment
    ) VALUES
      ('project-1', 'config-1', 'snapshot-1', 'article-1', TRUE, 7, TRUE, FALSE, 'answered', TRUE),
      ('project-1', 'config-1', 'snapshot-1', 'article-2', FALSE, NULL, FALSE, TRUE, NULL, FALSE)
  `)

  await getMigrateDuckdb()({throughFileName: migrationFileName})

  expect(await getListModeStateRows()).toEqual([
    {
      articleId: 'article-1',
      conflictFlag: false,
      duplicateFlag: true,
      hasLlmListMode: true,
      llmHasJudgment: true,
      llmPatchWatermark: 7,
      llmRefusedPromptCount: 0,
      llmStatus: 'answered',
    },
    {
      articleId: 'article-2',
      conflictFlag: true,
      duplicateFlag: false,
      hasLlmListMode: false,
      llmHasJudgment: false,
      llmPatchWatermark: null,
      llmRefusedPromptCount: 0,
      llmStatus: null,
    },
  ])
  expect(
    await getDatabase().queryJson<{name: string}>(`
      SELECT name
      FROM app_schema_migration
      WHERE name = '${migrationFileName}'
    `),
  ).toEqual([{name: migrationFileName}])
})

test('the rebuilt table keeps the previous column shape and appends the refused prompt count', async () => {
  const columns = await getListModeStateColumns()

  expect(
    columns.map((column) => {
      return column.columnName
    }),
  ).toEqual([
    'project_id',
    'review_config_hash',
    'snapshot_id',
    'article_id',
    'has_llm_list_mode',
    'has_human_list_mode',
    'has_both_list_mode',
    'has_unassessed_list_mode',
    'llm_patch_watermark',
    'human_patch_watermark',
    'both_patch_watermark',
    'unassessed_patch_watermark',
    'duplicate_flag',
    'conflict_flag',
    'llm_status',
    'human_status',
    'llm_has_judgment',
    'llm_refused_prompt_count',
  ])
  expect(columns.at(-1)).toEqual({
    columnDefault: '0',
    columnName: 'llm_refused_prompt_count',
    dataType: 'INTEGER',
    isNullable: false,
  })
  expect(
    columns.find((column) => {
      return column.columnName === 'llm_has_judgment'
    }),
  ).toEqual({columnDefault: 'false', columnName: 'llm_has_judgment', dataType: 'BOOLEAN', isNullable: false})
  expect(await getListModeStateIndexNames()).toEqual([])
  expect(
    await getDatabase().queryJson<{tableName: string}>(`
      SELECT table_name AS tableName
      FROM duckdb_tables()
      WHERE schema_name = 'mart'
        AND table_name LIKE 'review_article_serving_list_mode_state_v4%'
      ORDER BY table_name
    `),
  ).toEqual([{tableName: 'review_article_serving_list_mode_state_v4'}])
})

test('the refused prompt count rejects NULL and negative values', async () => {
  expect(
    await getRunError(`
      INSERT INTO mart.review_article_serving_list_mode_state_v4 (
        project_id, review_config_hash, snapshot_id, article_id, llm_refused_prompt_count
      ) VALUES ('project-1', 'config-1', 'snapshot-1', 'article-3', NULL)
    `),
  ).toBeInstanceOf(Error)
  expect(
    await getRunError(`
      INSERT INTO mart.review_article_serving_list_mode_state_v4 (
        project_id, review_config_hash, snapshot_id, article_id, llm_refused_prompt_count
      ) VALUES ('project-1', 'config-1', 'snapshot-1', 'article-3', -1)
    `),
  ).toBeInstanceOf(Error)
  expect(
    await getRunError(`
      INSERT INTO mart.review_article_serving_list_mode_state_v4 (
        project_id, review_config_hash, snapshot_id, article_id
      ) VALUES ('project-1', 'config-1', 'snapshot-1', 'article-3')
    `),
  ).toBeNull()
})
