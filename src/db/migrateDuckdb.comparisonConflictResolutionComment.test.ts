import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import type {getAppDatabaseService} from '../server/services/appDatabaseService.ts'
import {createTempRuntimeRoot} from '../server/test/createTempRuntimeRoot.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('migrate-comparison-conflict-resolution-comment')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath

const migrationFileName = '0262_comparisonConflictResolutionComment.sql'
const previousMigrationFileName = '0261_comparisonConflictResolutionProvenance.sql'
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

const getCommentColumns = () => {
  return getDatabase().queryJson<{columnName: string; dataType: string; isNullable: boolean}>(`
    SELECT column_name AS columnName, data_type AS dataType, is_nullable AS isNullable
    FROM duckdb_columns()
    WHERE schema_name = 'app'
      AND table_name = 'comparison_project_conflict_resolution'
      AND column_name IN ('comment', 'comment_updated_at')
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

test('the migration only adds two nullable columns, without comments, drops, indexes or backfill', () => {
  expect(migrationSql).not.toMatch(/--/)
  expect(migrationSql).not.toMatch(/\bDROP\b/i)
  expect(migrationSql).not.toMatch(/\bCREATE\s+(UNIQUE\s+)?INDEX\b/i)
  expect(migrationSql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i)
  expect(migrationSql).not.toMatch(/NOT NULL|DEFAULT/i)
  expect(migrationSql.match(/ADD COLUMN IF NOT EXISTS/g)).toHaveLength(2)
})

test('existing resolutions keep their values and read as having no comment', async () => {
  await getDatabase().run(`
    INSERT INTO app.article (id, article_title)
    VALUES ('article-1', 'One'), ('article-2', 'Two');
    INSERT INTO app.comparison_project_conflict_resolution (
      id, comparison_project_id, article_id, answer_value, reviewer_user_id, origin, updated_at
    )
    VALUES
      ('resolution-1', 'comparison-1', 'article-1', 'yes', 'reviewer-1', 'ui', TIMESTAMPTZ '2026-10-01T10:00:00Z'),
      ('resolution-2', 'comparison-1', 'article-2', 'no', NULL, NULL, TIMESTAMPTZ '2026-10-02T10:00:00Z');
  `)

  expect(await getCommentColumns()).toEqual([])

  await getMigrateDuckdb()()

  expect(await getCommentColumns()).toEqual([
    {columnName: 'comment', dataType: 'VARCHAR', isNullable: true},
    {columnName: 'comment_updated_at', dataType: 'TIMESTAMP WITH TIME ZONE', isNullable: true},
  ])
  expect(
    await getDatabase().queryJson(`
      SELECT
        id,
        answer_value AS answerValue,
        reviewer_user_id AS reviewerUserId,
        origin,
        CAST(epoch(updated_at) AS BIGINT) AS updatedAtEpoch,
        comment,
        comment_updated_at AS commentUpdatedAt
      FROM app.comparison_project_conflict_resolution
      ORDER BY id
    `),
  ).toEqual([
    {
      answerValue: 'yes',
      comment: null,
      commentUpdatedAt: null,
      id: 'resolution-1',
      origin: 'ui',
      reviewerUserId: 'reviewer-1',
      updatedAtEpoch: String(Date.parse('2026-10-01T10:00:00Z') / 1000),
    },
    {
      answerValue: 'no',
      comment: null,
      commentUpdatedAt: null,
      id: 'resolution-2',
      origin: null,
      reviewerUserId: null,
      updatedAtEpoch: String(Date.parse('2026-10-02T10:00:00Z') / 1000),
    },
  ])
  expect(
    await getDatabase().queryJson(`
      SELECT index_name AS indexName
      FROM duckdb_indexes()
      WHERE schema_name = 'app'
        AND table_name = 'comparison_project_conflict_resolution'
    `),
  ).toEqual([])
  expect(
    await getDatabase().queryJson(`
      SELECT constraint_type AS constraintType
      FROM duckdb_constraints()
      WHERE schema_name = 'app'
        AND table_name = 'comparison_project_conflict_resolution'
        AND constraint_type IN ('PRIMARY KEY', 'UNIQUE')
    `),
  ).toEqual([])

  await getMigrateDuckdb()()

  expect(await getCommentColumns()).toHaveLength(2)
  expect(
    await getDatabase().queryJson<{name: string}>(`
      SELECT name
      FROM app_schema_migration
      WHERE name = '${migrationFileName}'
    `),
  ).toEqual([{name: migrationFileName}])
})
