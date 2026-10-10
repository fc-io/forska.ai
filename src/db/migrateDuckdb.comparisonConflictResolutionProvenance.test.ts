import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import type {getAppDatabaseService} from '../server/services/appDatabaseService.ts'
import {createTempRuntimeRoot} from '../server/test/createTempRuntimeRoot.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('migrate-comparison-conflict-resolution-provenance')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath

const migrationFileName = '0261_comparisonConflictResolutionProvenance.sql'
const previousMigrationFileName = '0260_comparisonServingInvalidatedAt.sql'
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

const getProvenanceColumns = () => {
  return getDatabase().queryJson<{columnName: string; dataType: string; isNullable: boolean}>(`
    SELECT column_name AS columnName, data_type AS dataType, is_nullable AS isNullable
    FROM duckdb_columns()
    WHERE schema_name = 'app'
      AND table_name = 'comparison_project_conflict_resolution'
      AND column_name IN ('judgment_context_id', 'serving_generation', 'reviewer_display_name', 'origin', 'origin_ref')
    ORDER BY column_index
  `)
}

const getResolutionRows = () => {
  return getDatabase().queryJson<{
    articleId: string
    judgmentContextId: string | null
    origin: string | null
    originRef: string | null
    reviewerDisplayName: string | null
    servingGeneration: string | null
  }>(`
    SELECT
      article_id AS articleId,
      judgment_context_id AS judgmentContextId,
      CAST(serving_generation AS VARCHAR) AS servingGeneration,
      reviewer_display_name AS reviewerDisplayName,
      origin,
      origin_ref AS originRef
    FROM app.comparison_project_conflict_resolution
    ORDER BY article_id ASC
  `)
}

const getSecondaryIndexes = () => {
  return getDatabase().queryJson<{indexName: string; tableName: string}>(`
    SELECT table_name AS tableName, index_name AS indexName
    FROM duckdb_indexes()
    WHERE (schema_name = 'app' AND table_name IN ('comparison_project_conflict_resolution', 'comparison_judgment_context'))
      OR (schema_name = 'mart' AND table_name = 'comparison_judgment_context_serving')
    ORDER BY table_name, index_name
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

test('the migration adds nullable provenance columns without comments, drops or indexes', () => {
  expect(migrationSql).not.toMatch(/--/)
  expect(migrationSql).not.toMatch(/\bDROP\b/i)
  expect(migrationSql).not.toMatch(/\bCREATE\s+(UNIQUE\s+)?INDEX\b/i)
  expect(migrationSql).not.toMatch(/\bINSERT\b/i)
  expect(migrationSql.match(/ADD COLUMN IF NOT EXISTS/g)).toHaveLength(5)
})

test('existing resolutions read as provenance unknown, keep their reviewer and get the display-name snapshot', async () => {
  await getDatabase().run(`
    INSERT INTO app.user_config (id, name, email)
    VALUES
      ('local-reviewer', 'Fredrik', 'local@forska.local'),
      ('pdf-import:reviewer', '  ', 'pdf@forska.local');
    INSERT INTO app.article (id, article_title)
    VALUES ('article-1', 'One'), ('article-2', 'Two'), ('article-3', 'Three');
    INSERT INTO app.comparison_project_conflict_resolution (id, comparison_project_id, article_id, answer_value, reviewer_user_id)
    VALUES
      ('resolution-1', 'comparison-1', 'article-1', 'yes', 'local-reviewer'),
      ('resolution-2', 'comparison-1', 'article-2', 'no', 'pdf-import:reviewer'),
      ('resolution-3', 'comparison-1', 'article-3', 'maybe', NULL);
  `)

  expect(await getProvenanceColumns()).toEqual([])

  await getMigrateDuckdb()()

  expect(await getProvenanceColumns()).toEqual([
    {columnName: 'judgment_context_id', dataType: 'VARCHAR', isNullable: true},
    {columnName: 'serving_generation', dataType: 'BIGINT', isNullable: true},
    {columnName: 'reviewer_display_name', dataType: 'VARCHAR', isNullable: true},
    {columnName: 'origin', dataType: 'VARCHAR', isNullable: true},
    {columnName: 'origin_ref', dataType: 'VARCHAR', isNullable: true},
  ])
  expect(await getResolutionRows()).toEqual([
    {
      articleId: 'article-1',
      judgmentContextId: null,
      origin: null,
      originRef: null,
      reviewerDisplayName: 'Fredrik',
      servingGeneration: null,
    },
    {
      articleId: 'article-2',
      judgmentContextId: null,
      origin: null,
      originRef: null,
      reviewerDisplayName: null,
      servingGeneration: null,
    },
    {
      articleId: 'article-3',
      judgmentContextId: null,
      origin: null,
      originRef: null,
      reviewerDisplayName: null,
      servingGeneration: null,
    },
  ])
  expect(await getSecondaryIndexes()).toEqual([])
  expect(
    await getDatabase().queryJson<{constraintType: string; tableName: string}>(`
      SELECT table_name AS tableName, constraint_type AS constraintType
      FROM duckdb_constraints()
      WHERE (schema_name = 'app' AND table_name IN ('comparison_project_conflict_resolution', 'comparison_judgment_context'))
        OR (schema_name = 'mart' AND table_name = 'comparison_judgment_context_serving')
      ORDER BY table_name, constraint_type
    `),
  ).toEqual([
    {constraintType: 'NOT NULL', tableName: 'comparison_judgment_context'},
    {constraintType: 'NOT NULL', tableName: 'comparison_judgment_context'},
    {constraintType: 'NOT NULL', tableName: 'comparison_judgment_context'},
    {constraintType: 'NOT NULL', tableName: 'comparison_judgment_context'},
    {constraintType: 'NOT NULL', tableName: 'comparison_judgment_context'},
    {constraintType: 'NOT NULL', tableName: 'comparison_judgment_context'},
    {constraintType: 'PRIMARY KEY', tableName: 'comparison_judgment_context'},
    {constraintType: 'NOT NULL', tableName: 'comparison_judgment_context_serving'},
    {constraintType: 'NOT NULL', tableName: 'comparison_judgment_context_serving'},
    {constraintType: 'NOT NULL', tableName: 'comparison_judgment_context_serving'},
    {constraintType: 'NOT NULL', tableName: 'comparison_judgment_context_serving'},
    {constraintType: 'NOT NULL', tableName: 'comparison_project_conflict_resolution'},
    {constraintType: 'NOT NULL', tableName: 'comparison_project_conflict_resolution'},
    {constraintType: 'NOT NULL', tableName: 'comparison_project_conflict_resolution'},
    {constraintType: 'NOT NULL', tableName: 'comparison_project_conflict_resolution'},
    {constraintType: 'NOT NULL', tableName: 'comparison_project_conflict_resolution'},
  ])

  await getMigrateDuckdb()()

  expect(
    await getDatabase().queryJson<{name: string}>(`
      SELECT name
      FROM app_schema_migration
      WHERE name = '${migrationFileName}'
    `),
  ).toEqual([{name: migrationFileName}])
})

test('content-addressed contexts ignore duplicate inserts', async () => {
  await getDatabase().run(`
    INSERT INTO app.comparison_judgment_context (id, context_json, prompt_ids, model_ids, system_prompt_variants)
    VALUES ('context-1', '{"v":1}', ['prompt-1'], ['model-1'], ['legacy'])
    ON CONFLICT DO NOTHING;
    INSERT INTO app.comparison_judgment_context (id, context_json, prompt_ids, model_ids, system_prompt_variants)
    VALUES ('context-1', '{"v":2}', ['prompt-2'], ['model-2'], ['screening_v1'])
    ON CONFLICT DO NOTHING;
  `)

  expect(
    await getDatabase().queryJson<{contextJson: string; id: string}>(`
      SELECT id, CAST(context_json AS VARCHAR) AS contextJson
      FROM app.comparison_judgment_context
    `),
  ).toEqual([{contextJson: '{"v":1}', id: 'context-1'}])
})
