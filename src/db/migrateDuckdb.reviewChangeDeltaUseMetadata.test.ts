import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import type {getAppDatabaseService} from '../server/services/appDatabaseService.ts'
import {createTempRuntimeRoot} from '../server/test/createTempRuntimeRoot.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('migrate-review-change-delta-use-metadata')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath

const migrationFileName = '0256_reviewChangeDeltaUseMetadata.sql'
const previousMigrationFileName = '0255_judgmentUseMetadata.sql'
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

const insertDelta = async (input: {changeKind: string; deltaId: string; useTitle: string}) => {
  await getDatabase().run(`
    INSERT INTO app.review_change_delta (
      delta_id, change_kind, source_table, source_row_id, source_operation, source_partition,
      source_high_water_mark, idempotency_key, payload_version, project_id, article_id, use_title
    ) VALUES (
      '${input.deltaId}', '${input.changeKind}', 'app.judgment', 'row-${input.deltaId}', 'upsert',
      'llmJudgment:article-1', 1, 'key-${input.deltaId}', 1, 'project-1', 'article-1', ${input.useTitle}
    )
  `)
}

const getDeltaColumn = async () => {
  const [column] = await getDatabase().queryJson<{dataType: string; isNullable: boolean}>(`
    SELECT data_type AS dataType, is_nullable AS isNullable
    FROM duckdb_columns()
    WHERE schema_name = 'app'
      AND table_name = 'review_change_delta'
      AND column_name = 'use_metadata'
  `)

  return column ?? null
}

const getDeltaUseMetadata = async () => {
  return getDatabase().queryJson<{coalescedUseMetadata: boolean; deltaId: string; useMetadata: boolean | null}>(`
    SELECT
      delta_id AS deltaId,
      use_metadata AS useMetadata,
      COALESCE(use_metadata, FALSE) AS coalescedUseMetadata
    FROM app.review_change_delta
    WHERE delta_id LIKE 'delta-%'
    ORDER BY delta_id
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

test('the migration only adds the column', () => {
  expect(migrationSql).not.toMatch(/\bUPDATE\b/i)
  expect(migrationSql).not.toMatch(/\bINSERT\b/i)
  expect(migrationSql).not.toMatch(/--/)
})

test('existing review change deltas read false after the migration and new deltas default to false', async () => {
  expect(await getDeltaColumn()).toBeNull()

  await insertDelta({changeKind: 'judgment.llm.created', deltaId: 'delta-llm', useTitle: 'TRUE'})
  await insertDelta({changeKind: 'judgment.human.updated', deltaId: 'delta-human', useTitle: 'NULL'})

  await getMigrateDuckdb()()

  expect(await getDeltaColumn()).toEqual({dataType: 'BOOLEAN', isNullable: true})
  expect(await getDeltaUseMetadata()).toEqual([
    {coalescedUseMetadata: false, deltaId: 'delta-human', useMetadata: false},
    {coalescedUseMetadata: false, deltaId: 'delta-llm', useMetadata: false},
  ])

  await insertDelta({changeKind: 'judgment.llm.updated', deltaId: 'delta-new', useTitle: 'FALSE'})
  await getDatabase().run(`
    UPDATE app.review_change_delta
    SET use_metadata = NULL
    WHERE delta_id = 'delta-llm'
  `)

  expect(await getDeltaUseMetadata()).toEqual([
    {coalescedUseMetadata: false, deltaId: 'delta-human', useMetadata: false},
    {coalescedUseMetadata: false, deltaId: 'delta-llm', useMetadata: null},
    {coalescedUseMetadata: false, deltaId: 'delta-new', useMetadata: false},
  ])
  expect(
    await getDatabase().queryJson<{name: string}>(`
      SELECT name
      FROM app_schema_migration
      WHERE name = '${migrationFileName}'
    `),
  ).toEqual([{name: migrationFileName}])
})

test('bulk and single delta appends write the typed article metadata column', async () => {
  const [
    {appendLlmJudgmentReviewServingDelta, appendLlmJudgmentReviewServingDeltas},
    {appendReviewServingChangeDelta},
  ] = await Promise.all([
    import('../server/reviewServing/llmJudgmentReviewServingDeltaService.ts'),
    import('../server/reviewServing/reviewServingDeltaLedger.ts'),
  ])
  const llmDelta = {
    articleId: 'article-append',
    judgmentId: 'judgment-append',
    modelId: 'model-1',
    projectId: 'project-1',
    promptId: 'prompt-1',
    systemPromptVariant: 'legacy' as const,
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  }

  await getDatabase().transaction(async (tx) => {
    await appendLlmJudgmentReviewServingDeltas(tx, [
      {
        ...llmDelta,
        changeKind: 'judgment.llm.created',
        sourceMutationKey: 'append:metadata',
        sourceOperation: 'insert',
        useMetadata: true,
      },
      {
        ...llmDelta,
        changeKind: 'judgment.llm.updated',
        judgmentId: 'judgment-append-plain',
        sourceMutationKey: 'append:plain',
        sourceOperation: 'upsert',
        useMetadata: false,
      },
    ])
    await appendLlmJudgmentReviewServingDelta(tx, {
      ...llmDelta,
      changeKind: 'judgment.llm.deleted',
      judgmentId: 'judgment-append-single',
      sourceMutationKey: 'append:single',
      sourceOperation: 'delete',
      useMetadata: true,
    })
    await appendReviewServingChangeDelta(tx, {
      articleId: 'article-append',
      changeKind: 'article.display.updated',
      payloadVersion: 1,
      sourceMutationKey: 'append:display',
      sourceOperation: 'upsert',
      sourcePartition: 'article:article-append',
      sourceRowId: 'article-append',
      sourceTable: 'app.article',
      typedKey: {articleId: 'article-append'},
    })
  })

  expect(
    await getDatabase().queryJson<{
      changeKind: string
      contentFlagUseMetadata: boolean | null
      judgmentId: string | null
      useMetadata: boolean | null
    }>(`
      SELECT
        change_kind AS changeKind,
        judgment_id AS judgmentId,
        use_metadata AS useMetadata,
        CAST(json_extract(payload_json, '$.contentFlags.useMetadata') AS BOOLEAN) AS contentFlagUseMetadata
      FROM app.review_change_delta
      WHERE article_id = 'article-append'
      ORDER BY change_kind
    `),
  ).toEqual([
    {changeKind: 'article.display.updated', contentFlagUseMetadata: null, judgmentId: null, useMetadata: false},
    {
      changeKind: 'judgment.llm.created',
      contentFlagUseMetadata: true,
      judgmentId: 'judgment-append',
      useMetadata: true,
    },
    {
      changeKind: 'judgment.llm.deleted',
      contentFlagUseMetadata: true,
      judgmentId: 'judgment-append-single',
      useMetadata: true,
    },
    {
      changeKind: 'judgment.llm.updated',
      contentFlagUseMetadata: false,
      judgmentId: 'judgment-append-plain',
      useMetadata: false,
    },
  ])
})

test('re-running the migration keeps the column and existing values', async () => {
  await getDatabase().run(`
    UPDATE app.review_change_delta
    SET use_metadata = TRUE
    WHERE delta_id = 'delta-new'
  `)

  await getDatabase().run(migrationSql)

  expect(await getDeltaUseMetadata()).toEqual([
    {coalescedUseMetadata: false, deltaId: 'delta-human', useMetadata: false},
    {coalescedUseMetadata: false, deltaId: 'delta-llm', useMetadata: null},
    {coalescedUseMetadata: true, deltaId: 'delta-new', useMetadata: true},
  ])
})
