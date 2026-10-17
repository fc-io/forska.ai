import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import type {getAppDatabaseService} from '../server/services/appDatabaseService.ts'
import {createTempRuntimeRoot} from '../server/test/createTempRuntimeRoot.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('migrate-full-text-judging-chunk-plan')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath

const migrationFileName = '0271_fullTextJudgingChunkPlan.sql'
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

const getColumns = (tableName: string, columnNames: string[]) => {
  return getDatabase().queryJson<{columnName: string; dataType: string; isNullable: boolean}>(`
    SELECT column_name AS columnName, data_type AS dataType, is_nullable AS isNullable
    FROM duckdb_columns()
    WHERE schema_name = 'app'
      AND table_name = '${tableName}'
      AND column_name IN (${columnNames
        .map((columnName) => {
          return `'${columnName}'`
        })
        .join(', ')})
    ORDER BY column_index
  `)
}

const judgmentColumnNames = ['full_text_mode', 'chunk_count', 'chunk_plan_hash']

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

test('the migration has no comments, no backfill and keeps the judgment identity untouched', () => {
  expect(migrationSql).not.toContain('--')
  expect(migrationSql).not.toMatch(/\b(UPDATE|INSERT|INDEX|DROP|UNIQUE)\b/i)
})

test('a judgment with an assessment keeps its values and gets three nullable columns', async () => {
  await getDatabase().run(`INSERT INTO app.article (id, article_title) VALUES ('article-1', 'Article 1')`)
  await getDatabase().run(`INSERT INTO app.prompt (id, original_text) VALUES ('prompt-1', 'Is this a trial?')`)
  await getDatabase().run(`
    INSERT INTO app.judgment (id, article_id, prompt_id, model_id, is_answered, answered_original, chunking_strategy)
    VALUES ('judgment-1', 'article-1', 'prompt-1', 'model-1', TRUE, 'yes', 'article_heading_greedy')
  `)
  await getDatabase().run(`
    INSERT INTO app.judgment_assessment (id, judgment_id, assessment_is_correct)
    VALUES ('assessment-1', 'judgment-1', TRUE)
  `)

  expect(await getColumns('judgment', judgmentColumnNames)).toEqual([])

  await getMigrateDuckdb()({throughFileName: migrationFileName})

  expect(await getColumns('judgment', judgmentColumnNames)).toEqual([
    {columnName: 'full_text_mode', dataType: 'VARCHAR', isNullable: true},
    {columnName: 'chunk_count', dataType: 'INTEGER', isNullable: true},
    {columnName: 'chunk_plan_hash', dataType: 'VARCHAR', isNullable: true},
  ])
  expect(
    await getDatabase().queryJson(`
      SELECT
        answered_original AS answer,
        chunking_strategy AS chunkingStrategy,
        full_text_mode AS fullTextMode,
        chunk_count AS chunkCount,
        chunk_plan_hash AS chunkPlanHash,
        (SELECT COUNT(*) FROM app.judgment_assessment WHERE judgment_id = 'judgment-1')::INTEGER AS assessments
      FROM app.judgment
      WHERE id = 'judgment-1'
    `),
  ).toEqual([
    {
      answer: 'yes',
      assessments: 1,
      chunkCount: null,
      chunkingStrategy: 'article_heading_greedy',
      chunkPlanHash: null,
      fullTextMode: null,
    },
  ])
})

test('the chunk plan cache is keyed by article and strategy', async () => {
  const insertPlan = (planHash: string) => {
    return getDatabase().run(`
      INSERT INTO app.article_full_text_chunk_plan (article_id, full_text_strategy_id, plan_hash, text_hash, chunk_count, chunks)
      VALUES ('article-1', 'fts-0123456789abcdef', '${planHash}', 'text-hash', 1, '[{"index":0,"startOffset":0,"endOffset":10,"headingPath":null}]')
    `)
  }

  await insertPlan('plan-a')

  const duplicateError = await insertPlan('plan-b').then(
    () => {
      return null
    },
    (error: unknown) => {
      return error
    },
  )

  expect(duplicateError).toBeInstanceOf(Error)
  expect(
    await getDatabase().queryJson(`
      SELECT plan_hash AS planHash, chunk_count AS chunkCount, chunks->>'$[0].endOffset' AS endOffset
      FROM app.article_full_text_chunk_plan
    `),
  ).toEqual([{chunkCount: 1, endOffset: '10', planHash: 'plan-a'}])
})

test('re-running the migration keeps stored values', async () => {
  await getDatabase().run(`
    UPDATE app.judgment SET full_text_mode = 'chunked', chunk_count = 3, chunk_plan_hash = 'plan-a' WHERE id = 'judgment-1'
  `)

  await getDatabase().run(migrationSql)

  expect(
    await getDatabase().queryJson(`
      SELECT full_text_mode AS fullTextMode, chunk_count AS chunkCount, chunk_plan_hash AS chunkPlanHash
      FROM app.judgment
    `),
  ).toEqual([{chunkCount: 3, chunkPlanHash: 'plan-a', fullTextMode: 'chunked'}])
  expect(
    await getDatabase().queryJson(`SELECT COUNT(*)::INTEGER AS plans FROM app.article_full_text_chunk_plan`),
  ).toEqual([{plans: 1}])
})
