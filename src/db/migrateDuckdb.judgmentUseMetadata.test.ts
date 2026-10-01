import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import type {getAppDatabaseService} from '../server/services/appDatabaseService.ts'
import {createTempRuntimeRoot} from '../server/test/createTempRuntimeRoot.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('migrate-judgment-use-metadata')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath

const migrationFileName = '0255_judgmentUseMetadata.sql'
const previousMigrationFileName = '0254_projectUseMetadata.sql'
const migrationSql = readFileSync(resolve(import.meta.dir, 'duckdbMigrations', migrationFileName), 'utf8')
const identityColumns =
  'article_id, prompt_id, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images, use_metadata, system_prompt_variant, delete_generation'

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

const insertJudgment = (input: {id: string; modelId: string; systemPromptVariant: string; useMetadata: boolean}) => {
  return getDatabase().run(`
    INSERT INTO app.judgment (
      id, article_id, prompt_id, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images,
      use_metadata, system_prompt_variant, is_answered, answered_original, created_at, updated_at
    ) VALUES (
      '${input.id}', 'article-1', 'prompt-1', '${input.modelId}', TRUE, TRUE, FALSE, FALSE,
      ${input.useMetadata ? 'TRUE' : 'FALSE'}, '${input.systemPromptVariant}', TRUE, 'yes',
      TIMESTAMPTZ '2026-09-01T08:00:00Z', TIMESTAMPTZ '2026-09-01T08:00:00Z'
    )
  `)
}

const getInsertError = async (input: Parameters<typeof insertJudgment>[0]) => {
  return insertJudgment(input).then(
    () => {
      return null
    },
    (error: unknown) => {
      return error instanceof Error ? error.message : String(error)
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

test('the migration has no comments and recreates the judgment tables with use_metadata in the identity', () => {
  expect(migrationSql).not.toContain('--')
  expect(migrationSql).toContain(`UNIQUE(${identityColumns})`)
  expect(migrationSql).toContain(`ON app.judgment(${identityColumns})`)
  expect(migrationSql).toContain('use_metadata BOOLEAN NOT NULL DEFAULT FALSE')
})

test('the migration stamps every existing judgment use_metadata FALSE and keeps the assessments', async () => {
  await getDatabase().run(`
    INSERT INTO app.article (id, article_title) VALUES ('article-1', 'Article 1')
  `)
  await getDatabase().run(`
    INSERT INTO app.prompt (id, original_text) VALUES ('prompt-1', 'Is this a trial?')
  `)
  await getDatabase().run(`
    INSERT INTO app.judgment (
      id, article_id, prompt_id, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images,
      system_prompt_variant, is_answered, answered_original, created_at, updated_at
    ) VALUES
      ('judgment-a', 'article-1', 'prompt-1', 'model-a', TRUE, TRUE, FALSE, FALSE, 'legacy', TRUE, 'yes',
        TIMESTAMPTZ '2026-09-01T08:00:00Z', TIMESTAMPTZ '2026-09-01T08:00:00Z'),
      ('judgment-b', 'article-1', 'prompt-1', 'model-b', TRUE, TRUE, FALSE, FALSE, 'screening_v1', TRUE, 'no',
        TIMESTAMPTZ '2026-09-01T08:00:00Z', TIMESTAMPTZ '2026-09-01T08:00:00Z')
  `)
  await getDatabase().run(`
    INSERT INTO app.judgment_assessment (id, judgment_id, assessment_is_correct, assessment_comment)
    VALUES ('assessment-a', 'judgment-a', TRUE, 'checked')
  `)

  await getMigrateDuckdb()({throughFileName: migrationFileName})

  expect(
    await getDatabase().queryJson<{columnDefault: string | null; dataType: string; isNullable: boolean}>(`
      SELECT data_type AS dataType, is_nullable AS isNullable, column_default AS columnDefault
      FROM duckdb_columns()
      WHERE schema_name = 'app'
        AND table_name = 'judgment'
        AND column_name = 'use_metadata'
    `),
  ).toEqual([{columnDefault: 'false', dataType: 'BOOLEAN', isNullable: false}])
  expect(
    await getDatabase().queryJson<{
      answeredOriginal: string
      id: string
      systemPromptVariant: string
      useMetadata: boolean
    }>(`
      SELECT
        id,
        answered_original AS answeredOriginal,
        system_prompt_variant AS systemPromptVariant,
        use_metadata AS useMetadata
      FROM app.judgment
      ORDER BY id
    `),
  ).toEqual([
    {answeredOriginal: 'yes', id: 'judgment-a', systemPromptVariant: 'legacy', useMetadata: false},
    {answeredOriginal: 'no', id: 'judgment-b', systemPromptVariant: 'screening_v1', useMetadata: false},
  ])
  expect(
    await getDatabase().queryJson<{assessmentComment: string; id: string; judgmentId: string}>(`
      SELECT id, judgment_id AS judgmentId, assessment_comment AS assessmentComment
      FROM app.judgment_assessment
    `),
  ).toEqual([{assessmentComment: 'checked', id: 'assessment-a', judgmentId: 'judgment-a'}])
  expect(
    await getDatabase().queryJson<{name: string}>(`
      SELECT name
      FROM app_schema_migration
      WHERE name = '${migrationFileName}'
    `),
  ).toEqual([{name: migrationFileName}])
})

test('the unique constraint and the lookup index include use_metadata', async () => {
  const uniqueConstraints = await getDatabase().queryJson<{constraintColumnNames: string[]}>(`
    SELECT constraint_column_names AS constraintColumnNames
    FROM duckdb_constraints()
    WHERE schema_name = 'app'
      AND table_name = 'judgment'
      AND constraint_type = 'UNIQUE'
  `)
  const [lookupIndex] = await getDatabase().queryJson<{sql: string}>(`
    SELECT sql
    FROM duckdb_indexes()
    WHERE schema_name = 'app'
      AND index_name = 'idx_app_judgment_lookup'
  `)

  expect(uniqueConstraints).toEqual([{constraintColumnNames: identityColumns.split(', ')}])
  expect(lookupIndex?.sql).toContain(`(${identityColumns})`)
})

test('a judgment with the same flags but use_metadata TRUE is a new identity', async () => {
  expect(
    await getInsertError({
      id: 'judgment-a-metadata',
      modelId: 'model-a',
      systemPromptVariant: 'legacy',
      useMetadata: true,
    }),
  ).toBeNull()
  expect(
    await getInsertError({
      id: 'judgment-a-metadata-duplicate',
      modelId: 'model-a',
      systemPromptVariant: 'legacy',
      useMetadata: true,
    }),
  ).toContain('Duplicate key')
  expect(
    await getInsertError({
      id: 'judgment-b-duplicate',
      modelId: 'model-b',
      systemPromptVariant: 'screening_v1',
      useMetadata: false,
    }),
  ).toContain('Duplicate key')
  expect(
    await getDatabase().queryJson<{id: string; useMetadata: boolean}>(`
      SELECT id, use_metadata AS useMetadata
      FROM app.judgment
      WHERE model_id = 'model-a'
      ORDER BY id
    `),
  ).toEqual([
    {id: 'judgment-a', useMetadata: false},
    {id: 'judgment-a-metadata', useMetadata: true},
  ])
})

test('a judgment inserted without use_metadata defaults to FALSE', async () => {
  await getDatabase().run(`
    INSERT INTO app.judgment (id, article_id, prompt_id, model_id, is_answered, answered_original)
    VALUES ('judgment-c', 'article-1', 'prompt-1', 'model-c', TRUE, 'maybe')
  `)

  expect(
    await getDatabase().queryJson<{useMetadata: boolean}>(`
      SELECT use_metadata AS useMetadata
      FROM app.judgment
      WHERE id = 'judgment-c'
    `),
  ).toEqual([{useMetadata: false}])
})
