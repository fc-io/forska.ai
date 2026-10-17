import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import type {getAppDatabaseService} from '../server/services/appDatabaseService.ts'
import {createTempRuntimeRoot} from '../server/test/createTempRuntimeRoot.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('migrate-article-canonical-full-text')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath

const migrationFileName = '0265_articleCanonicalFullText.sql'
const previousMigrationFileName = '0264_comparisonConflictComment.sql'
const migrationSql = readFileSync(resolve(import.meta.dir, 'duckdbMigrations', migrationFileName), 'utf8')
const canonicalColumnNames = ['full_text_canonical_hash', 'full_text_canonical_version', 'full_text_figure_mode_built']

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

const getCanonicalColumns = () => {
  return getDatabase().queryJson<{columnName: string; dataType: string; isNullable: boolean}>(`
    SELECT column_name AS columnName, data_type AS dataType, is_nullable AS isNullable
    FROM duckdb_columns()
    WHERE schema_name = 'app'
      AND table_name = 'article'
      AND column_name IN (${canonicalColumnNames
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

test('the migration only adds nullable article columns and has no comments', () => {
  expect(migrationSql).not.toContain('--')
  expect(migrationSql).not.toMatch(/\b(UPDATE|INSERT|INDEX|DROP)\b/i)
  expect(migrationSql).not.toMatch(/NOT NULL/i)
})

test('the migration adds the canonical columns to an article referenced by judgments and keeps its text', async () => {
  await getDatabase().run(`
    INSERT INTO app.article (id, article_title, full_text) VALUES ('article-1', 'Article 1', '# Converter markdown')
  `)
  await getDatabase().run(`INSERT INTO app.prompt (id, original_text) VALUES ('prompt-1', 'Is this a trial?')`)
  await getDatabase().run(`
    INSERT INTO app.judgment (id, article_id, prompt_id, model_id, is_answered, answered_original)
    VALUES ('judgment-1', 'article-1', 'prompt-1', 'model-1', TRUE, 'yes')
  `)

  expect(await getCanonicalColumns()).toEqual([])

  await getMigrateDuckdb()({throughFileName: migrationFileName})

  expect(await getCanonicalColumns()).toEqual([
    {columnName: 'full_text_canonical_hash', dataType: 'VARCHAR', isNullable: true},
    {columnName: 'full_text_canonical_version', dataType: 'VARCHAR', isNullable: true},
    {columnName: 'full_text_figure_mode_built', dataType: 'VARCHAR', isNullable: true},
  ])
  expect(
    await getDatabase().queryJson(`
      SELECT
        full_text AS fullText,
        full_text_canonical_hash AS hash,
        full_text_canonical_version AS version,
        full_text_figure_mode_built AS figureMode
      FROM app.article
      WHERE id = 'article-1'
    `),
  ).toEqual([{figureMode: null, fullText: '# Converter markdown', hash: null, version: null}])
})

test('re-running the migration keeps stored canonical identities', async () => {
  await getDatabase().run(`
    UPDATE app.article
    SET full_text_canonical_hash = 'abc', full_text_canonical_version = 'canonical-v1', full_text_figure_mode_built = 'none'
    WHERE id = 'article-1'
  `)

  await getDatabase().run(migrationSql)

  expect(
    await getDatabase().queryJson(`
      SELECT full_text_canonical_hash AS hash, full_text_figure_mode_built AS figureMode
      FROM app.article
      WHERE id = 'article-1'
    `),
  ).toEqual([{figureMode: 'none', hash: 'abc'}])
})
