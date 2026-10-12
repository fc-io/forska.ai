import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import type {getAppDatabaseService} from '../server/services/appDatabaseService.ts'
import {createTempRuntimeRoot} from '../server/test/createTempRuntimeRoot.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('migrate-comparison-conflict-comment')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath

const migrationFileName = '0264_comparisonConflictComment.sql'
const previousMigrationFileName = '0263_judgmentJobStopConditions.sql'
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

const getTableColumns = (tableName: string) => {
  return getDatabase().queryJson<{columnName: string; dataType: string; isNullable: boolean}>(`
    SELECT column_name AS columnName, data_type AS dataType, is_nullable AS isNullable
    FROM duckdb_columns()
    WHERE schema_name = 'app'
      AND table_name = '${tableName}'
    ORDER BY column_index
  `)
}

const getEpochSeconds = (value: string) => {
  return String(Date.parse(value) / 1000)
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

test('the migration creates the comment table without secondary indexes and has no SQL comments', () => {
  expect(migrationSql).not.toMatch(/--/)
  expect(migrationSql).not.toMatch(/\bCREATE\s+(UNIQUE\s+)?INDEX\b/i)
  expect(migrationSql).not.toMatch(/\bUNIQUE\b/i)
  expect(migrationSql.match(/DROP COLUMN IF EXISTS/g)).toHaveLength(2)
})

test('comments move to the comment table and the resolution columns are dropped', async () => {
  await getDatabase().run(`
    INSERT INTO app.comparison_project_conflict_resolution (
      id, comparison_project_id, article_id, answer_value, reviewer_user_id, reviewer_display_name, origin,
      created_at, updated_at, comment, comment_updated_at
    )
    VALUES
      ('resolution-1', 'comparison-1', 'article-1', 'yes', 'reviewer-1', 'Reviewer One', 'ui',
        TIMESTAMPTZ '2026-10-01T09:00:00Z', TIMESTAMPTZ '2026-10-01T10:00:00Z',
        'Checked the full text; it''s a -- tricky one', TIMESTAMPTZ '2026-10-01T11:30:00Z'),
      ('resolution-2', 'comparison-1', 'article-2', 'no', NULL, NULL, NULL,
        TIMESTAMPTZ '2026-10-02T09:00:00Z', TIMESTAMPTZ '2026-10-02T10:00:00Z', NULL, NULL),
      ('resolution-3a', 'comparison-2', 'article-1', 'maybe', 'reviewer-2', NULL, 'file-import',
        TIMESTAMPTZ '2026-10-03T09:00:00Z', TIMESTAMPTZ '2026-10-03T10:00:00Z',
        'Older duplicate', TIMESTAMPTZ '2026-10-03T10:00:00Z'),
      ('resolution-3b', 'comparison-2', 'article-1', 'yes', 'reviewer-3', 'Reviewer Three', 'ui',
        TIMESTAMPTZ '2026-10-03T09:00:00Z', TIMESTAMPTZ '2026-10-03T10:00:00Z',
        'Newer duplicate', TIMESTAMPTZ '2026-10-04T10:00:00Z'),
      ('resolution-4', 'comparison-2', 'article-2', 'no', 'reviewer-2', NULL, NULL,
        TIMESTAMPTZ '2026-10-05T09:00:00Z', TIMESTAMPTZ '2026-10-05T10:00:00Z', '', TIMESTAMPTZ '2026-10-05T10:00:00Z');
  `)

  await getMigrateDuckdb()()

  expect(await getTableColumns('comparison_project_conflict_comment')).toEqual([
    {columnName: 'id', dataType: 'VARCHAR', isNullable: false},
    {columnName: 'comparison_project_id', dataType: 'VARCHAR', isNullable: false},
    {columnName: 'article_id', dataType: 'VARCHAR', isNullable: false},
    {columnName: 'comment', dataType: 'VARCHAR', isNullable: false},
    {columnName: 'author_user_id', dataType: 'VARCHAR', isNullable: true},
    {columnName: 'author_display_name', dataType: 'VARCHAR', isNullable: true},
    {columnName: 'created_at', dataType: 'TIMESTAMP WITH TIME ZONE', isNullable: false},
    {columnName: 'updated_at', dataType: 'TIMESTAMP WITH TIME ZONE', isNullable: false},
  ])
  expect(
    (await getTableColumns('comparison_project_conflict_resolution')).map((column) => {
      return column.columnName
    }),
  ).toEqual([
    'id',
    'comparison_project_id',
    'article_id',
    'prompt_id',
    'answer_value',
    'created_at',
    'updated_at',
    'reviewer_user_id',
    'judgment_context_id',
    'serving_generation',
    'reviewer_display_name',
    'origin',
    'origin_ref',
  ])
  expect(
    await getDatabase().queryJson(`
      SELECT
        comparison_project_id AS comparisonProjectId,
        article_id AS articleId,
        comment,
        author_user_id AS authorUserId,
        author_display_name AS authorDisplayName,
        CAST(epoch(created_at) AS BIGINT) AS createdAtEpoch,
        CAST(epoch(updated_at) AS BIGINT) AS updatedAtEpoch,
        length(id) AS idLength
      FROM app.comparison_project_conflict_comment
      ORDER BY comparison_project_id, article_id
    `),
  ).toEqual([
    {
      articleId: 'article-1',
      authorDisplayName: 'Reviewer One',
      authorUserId: 'reviewer-1',
      comment: "Checked the full text; it's a -- tricky one",
      comparisonProjectId: 'comparison-1',
      createdAtEpoch: getEpochSeconds('2026-10-01T11:30:00Z'),
      idLength: '36',
      updatedAtEpoch: getEpochSeconds('2026-10-01T11:30:00Z'),
    },
    {
      articleId: 'article-1',
      authorDisplayName: 'Reviewer Three',
      authorUserId: 'reviewer-3',
      comment: 'Newer duplicate',
      comparisonProjectId: 'comparison-2',
      createdAtEpoch: getEpochSeconds('2026-10-04T10:00:00Z'),
      idLength: '36',
      updatedAtEpoch: getEpochSeconds('2026-10-04T10:00:00Z'),
    },
  ])
  expect(
    await getDatabase().queryJson(`
      SELECT id, answer_value AS answerValue, reviewer_user_id AS reviewerUserId, CAST(epoch(updated_at) AS BIGINT) AS updatedAtEpoch
      FROM app.comparison_project_conflict_resolution
      ORDER BY id
    `),
  ).toEqual([
    {
      answerValue: 'yes',
      id: 'resolution-1',
      reviewerUserId: 'reviewer-1',
      updatedAtEpoch: getEpochSeconds('2026-10-01T10:00:00Z'),
    },
    {
      answerValue: 'no',
      id: 'resolution-2',
      reviewerUserId: null,
      updatedAtEpoch: getEpochSeconds('2026-10-02T10:00:00Z'),
    },
    {
      answerValue: 'maybe',
      id: 'resolution-3a',
      reviewerUserId: 'reviewer-2',
      updatedAtEpoch: getEpochSeconds('2026-10-03T10:00:00Z'),
    },
    {
      answerValue: 'yes',
      id: 'resolution-3b',
      reviewerUserId: 'reviewer-3',
      updatedAtEpoch: getEpochSeconds('2026-10-03T10:00:00Z'),
    },
    {
      answerValue: 'no',
      id: 'resolution-4',
      reviewerUserId: 'reviewer-2',
      updatedAtEpoch: getEpochSeconds('2026-10-05T10:00:00Z'),
    },
  ])
  expect(
    await getDatabase().queryJson(`
      SELECT table_name AS tableName, constraint_type AS constraintType, constraint_column_names AS columnNames
      FROM duckdb_constraints()
      WHERE schema_name = 'app'
        AND table_name IN ('comparison_project_conflict_comment', 'comparison_project_conflict_resolution')
        AND constraint_type IN ('PRIMARY KEY', 'UNIQUE')
      ORDER BY table_name, constraint_type
    `),
  ).toEqual([{columnNames: ['id'], constraintType: 'PRIMARY KEY', tableName: 'comparison_project_conflict_comment'}])
  expect(
    await getDatabase().queryJson(`
      SELECT index_name AS indexName
      FROM duckdb_indexes()
      WHERE schema_name = 'app'
        AND table_name IN ('comparison_project_conflict_comment', 'comparison_project_conflict_resolution')
    `),
  ).toEqual([])
})

test('both tables accept the save shapes after a checkpoint and a rerun is a no-op', async () => {
  await getDatabase().run('CHECKPOINT')
  await getDatabase().transaction(async (tx) => {
    await tx.queryJson(`
      DELETE FROM app.comparison_project_conflict_resolution
      WHERE comparison_project_id = 'comparison-1' AND article_id = 'article-1'
      RETURNING article_id AS articleId
    `)
    await tx.run(`
      INSERT INTO app.comparison_project_conflict_resolution (
        id, comparison_project_id, article_id, prompt_id, answer_value, reviewer_user_id, judgment_context_id,
        serving_generation, reviewer_display_name, origin, origin_ref
      )
      VALUES ('resolution-1b', 'comparison-1', 'article-1', NULL, 'no', 'reviewer-1', NULL, NULL, 'Reviewer One', 'ui', NULL)
    `)
    await tx.queryJson(`
      DELETE FROM app.comparison_project_conflict_comment
      WHERE comparison_project_id = 'comparison-1' AND article_id = 'article-1'
      RETURNING created_at AS createdAt
    `)
    await tx.run(`
      INSERT INTO app.comparison_project_conflict_comment (id, comparison_project_id, article_id, comment)
      VALUES ('comment-new', 'comparison-1', 'article-1', 'Edited')
    `)
  })
  await getDatabase().run('CHECKPOINT')

  expect(
    await getDatabase().queryJson(`
      SELECT
        (SELECT answer_value FROM app.comparison_project_conflict_resolution WHERE id = 'resolution-1b') AS answerValue,
        (SELECT comment FROM app.comparison_project_conflict_comment WHERE comparison_project_id = 'comparison-1') AS comment,
        (SELECT COUNT(*) FROM app.comparison_project_conflict_comment) AS commentCount
    `),
  ).toEqual([{answerValue: 'no', comment: 'Edited', commentCount: '2'}])

  await getMigrateDuckdb()()

  expect(
    await getDatabase().queryJson<{name: string}>(`
      SELECT name
      FROM app_schema_migration
      WHERE name = '${migrationFileName}'
    `),
  ).toEqual([{name: migrationFileName}])
  expect(
    await getDatabase().queryJson(`SELECT COUNT(*) AS commentCount FROM app.comparison_project_conflict_comment`),
  ).toEqual([{commentCount: '2'}])
})
