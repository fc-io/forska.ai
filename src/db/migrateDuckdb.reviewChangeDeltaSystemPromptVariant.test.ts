import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import type {getAppDatabaseService} from '../server/services/appDatabaseService.ts'
import {createTempRuntimeRoot} from '../server/test/createTempRuntimeRoot.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('migrate-review-change-delta-system-prompt-variant')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath

const migrationFileName = '0252_reviewChangeDeltaSystemPromptVariant.sql'
const previousMigrationFileName = '0251_judgmentSystemPromptVariant.sql'
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
  const [column] = await getDatabase().queryJson<{columnDefault: string | null; dataType: string}>(`
    SELECT data_type AS dataType, column_default AS columnDefault
    FROM duckdb_columns()
    WHERE schema_name = 'app'
      AND table_name = 'review_change_delta'
      AND column_name = 'system_prompt_variant'
  `)

  return column ?? null
}

const getDeltaVariants = async () => {
  return getDatabase().queryJson<{deltaId: string; systemPromptVariant: string | null}>(`
    SELECT delta_id AS deltaId, system_prompt_variant AS systemPromptVariant
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

test('existing review change deltas read legacy after the migration and new deltas default to legacy', async () => {
  expect(await getDeltaColumn()).toBeNull()

  await insertDelta({changeKind: 'judgment.llm.created', deltaId: 'delta-llm', useTitle: 'TRUE'})
  await insertDelta({changeKind: 'judgment.human.updated', deltaId: 'delta-human', useTitle: 'NULL'})

  await getMigrateDuckdb()()

  expect(await getDeltaColumn()).toEqual({columnDefault: "'legacy'", dataType: 'VARCHAR'})
  expect(await getDeltaVariants()).toEqual([
    {deltaId: 'delta-human', systemPromptVariant: 'legacy'},
    {deltaId: 'delta-llm', systemPromptVariant: 'legacy'},
  ])

  await insertDelta({changeKind: 'judgment.llm.updated', deltaId: 'delta-new', useTitle: 'FALSE'})

  expect(await getDeltaVariants()).toEqual([
    {deltaId: 'delta-human', systemPromptVariant: 'legacy'},
    {deltaId: 'delta-llm', systemPromptVariant: 'legacy'},
    {deltaId: 'delta-new', systemPromptVariant: 'legacy'},
  ])
  expect(
    await getDatabase().queryJson<{name: string}>(`
      SELECT name
      FROM app_schema_migration
      WHERE name = '${migrationFileName}'
    `),
  ).toEqual([{name: migrationFileName}])
})

test('bulk and single delta appends write the typed system prompt variant column', async () => {
  const [{appendLlmJudgmentReviewServingDeltas}, {appendReviewServingChangeDelta}] = await Promise.all([
    import('../server/reviewServing/llmJudgmentReviewServingDeltaService.ts'),
    import('../server/reviewServing/reviewServingDeltaLedger.ts'),
  ])
  const llmDelta = {
    articleId: 'article-append',
    judgmentId: 'judgment-append',
    modelId: 'model-1',
    projectId: 'project-1',
    promptId: 'prompt-1',
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
        sourceMutationKey: 'append:screening',
        sourceOperation: 'insert',
        systemPromptVariant: 'screening_v1',
      },
      {
        ...llmDelta,
        changeKind: 'judgment.llm.updated',
        judgmentId: 'judgment-append-legacy',
        sourceMutationKey: 'append:legacy',
        sourceOperation: 'upsert',
        systemPromptVariant: 'legacy',
      },
    ])
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
      contentFlagVariant: string | null
      judgmentId: string | null
      systemPromptVariant: string | null
      useTitle: boolean | null
    }>(`
      SELECT
        change_kind AS changeKind,
        judgment_id AS judgmentId,
        use_title AS useTitle,
        system_prompt_variant AS systemPromptVariant,
        json_extract_string(payload_json, '$.contentFlags.systemPromptVariant') AS contentFlagVariant
      FROM app.review_change_delta
      WHERE article_id = 'article-append'
      ORDER BY change_kind
    `),
  ).toEqual([
    {
      changeKind: 'article.display.updated',
      contentFlagVariant: null,
      judgmentId: null,
      systemPromptVariant: 'legacy',
      useTitle: null,
    },
    {
      changeKind: 'judgment.llm.created',
      contentFlagVariant: 'screening_v1',
      judgmentId: 'judgment-append',
      systemPromptVariant: 'screening_v1',
      useTitle: true,
    },
    {
      changeKind: 'judgment.llm.updated',
      contentFlagVariant: 'legacy',
      judgmentId: 'judgment-append-legacy',
      systemPromptVariant: 'legacy',
      useTitle: true,
    },
  ])
})

test('re-running the migration keeps the column and existing values', async () => {
  await getDatabase().run(`
    UPDATE app.review_change_delta
    SET system_prompt_variant = 'screening_v1'
    WHERE delta_id = 'delta-new'
  `)

  await getDatabase().run(migrationSql)

  expect(await getDeltaVariants()).toEqual([
    {deltaId: 'delta-human', systemPromptVariant: 'legacy'},
    {deltaId: 'delta-llm', systemPromptVariant: 'legacy'},
    {deltaId: 'delta-new', systemPromptVariant: 'screening_v1'},
  ])
})
