import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import type {getAppDatabaseService} from '../server/services/appDatabaseService.ts'
import {createTempRuntimeRoot} from '../server/test/createTempRuntimeRoot.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('migrate-full-text-strategy')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath

const previousMigrationFileName = '0264_comparisonConflictComment.sql'
const migrationFileNames = [
  '0266_projectFullTextStrategy.sql',
  '0267_judgmentFullTextStrategy.sql',
  '0268_judgmentJobFullTextStrategy.sql',
  '0269_reviewChangeDeltaFullTextStrategy.sql',
  '0270_comparisonServingFullTextStrategy.sql',
]
const lastMigrationFileName = '0270_comparisonServingFullTextStrategy.sql'
const identityColumns =
  'article_id, prompt_id, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images, use_metadata, system_prompt_variant, full_text_strategy_id, delete_generation'

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

const getMigrationSql = (fileName: string) => {
  return readFileSync(resolve(import.meta.dir, 'duckdbMigrations', fileName), 'utf8')
}

const getColumn = async (schemaName: string, tableName: string, columnName: string) => {
  const [column] = await getDatabase().queryJson<{
    columnDefault: string | null
    dataType: string
    isNullable: boolean
  }>(`
    SELECT data_type AS dataType, is_nullable AS isNullable, column_default AS columnDefault
    FROM duckdb_columns()
    WHERE schema_name = '${schemaName}'
      AND table_name = '${tableName}'
      AND column_name = '${columnName}'
  `)

  return column ?? null
}

const insertJudgment = (input: {fullTextStrategyId: string; id: string}) => {
  return getDatabase().run(`
    INSERT INTO app.judgment (
      id, article_id, prompt_id, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images,
      use_metadata, system_prompt_variant, full_text_strategy_id, is_answered, answered_original
    ) VALUES (
      '${input.id}', 'article-1', 'prompt-1', 'model-fulltext', FALSE, FALSE, TRUE, FALSE,
      FALSE, 'legacy', '${input.fullTextStrategyId}', TRUE, 'yes'
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

test('the migrations contain no comment markers and the judgment rebuild puts the strategy in the identity', () => {
  migrationFileNames.map((fileName) => {
    return expect(getMigrationSql(fileName)).not.toContain('--')
  })

  const judgmentMigrationSql = getMigrationSql('0267_judgmentFullTextStrategy.sql')

  expect(judgmentMigrationSql).toContain(`UNIQUE(${identityColumns})`)
  expect(judgmentMigrationSql).toContain(`ON app.judgment(${identityColumns})`)
  expect(judgmentMigrationSql).toContain("full_text_strategy_id VARCHAR NOT NULL DEFAULT 'fts-none'")
})

test('existing projects and judgments get the none or legacy strategy and assessments survive', async () => {
  await getDatabase().run(`
    INSERT INTO app.article (id, article_title) VALUES ('article-1', 'Article 1')
  `)
  await getDatabase().run(`
    INSERT INTO app.prompt (id, original_text) VALUES ('prompt-1', 'Is this a trial?')
  `)
  await getDatabase().run(`
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES
      ('project-plain', 'Plain', 'model-a', TRUE, TRUE, FALSE, FALSE),
      ('project-fulltext', 'Full text', 'model-a', FALSE, FALSE, TRUE, FALSE),
      ('project-no-images', 'No images', 'model-a', FALSE, FALSE, FALSE, TRUE)
  `)
  await getDatabase().run(`
    INSERT INTO app.judgment (
      id, article_id, prompt_id, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images,
      system_prompt_variant, is_answered, answered_original
    ) VALUES
      ('judgment-plain', 'article-1', 'prompt-1', 'model-a', TRUE, TRUE, FALSE, FALSE, 'legacy', TRUE, 'yes'),
      ('judgment-fulltext', 'article-1', 'prompt-1', 'model-a', FALSE, FALSE, TRUE, FALSE, 'legacy', TRUE, 'no'),
      ('judgment-no-images', 'article-1', 'prompt-1', 'model-a', FALSE, FALSE, FALSE, TRUE, 'legacy', TRUE, 'maybe')
  `)
  await getDatabase().run(`
    INSERT INTO app.judgment_assessment (id, judgment_id, assessment_is_correct, assessment_comment)
    VALUES ('assessment-fulltext', 'judgment-fulltext', TRUE, 'checked')
  `)

  await getMigrateDuckdb()({throughFileName: lastMigrationFileName})

  expect(
    await getDatabase().queryJson<{
      fullTextChunkPolicy: unknown
      fullTextFigureMode: string | null
      fullTextStrategyId: string | null
      id: string
    }>(`
      SELECT
        id,
        full_text_figure_mode AS fullTextFigureMode,
        full_text_chunk_policy AS fullTextChunkPolicy,
        full_text_strategy_id AS fullTextStrategyId
      FROM app.project
      ORDER BY id
    `),
  ).toEqual([
    {
      fullTextChunkPolicy: null,
      fullTextFigureMode: 'none',
      fullTextStrategyId: 'fts-legacy-v0',
      id: 'project-fulltext',
    },
    {
      fullTextChunkPolicy: null,
      fullTextFigureMode: 'none',
      fullTextStrategyId: 'fts-legacy-v0',
      id: 'project-no-images',
    },
    {fullTextChunkPolicy: null, fullTextFigureMode: null, fullTextStrategyId: null, id: 'project-plain'},
  ])
  expect(
    await getDatabase().queryJson<{answeredOriginal: string; fullTextStrategyId: string; id: string}>(`
      SELECT id, answered_original AS answeredOriginal, full_text_strategy_id AS fullTextStrategyId
      FROM app.judgment
      ORDER BY id
    `),
  ).toEqual([
    {answeredOriginal: 'no', fullTextStrategyId: 'fts-legacy-v0', id: 'judgment-fulltext'},
    {answeredOriginal: 'maybe', fullTextStrategyId: 'fts-legacy-v0', id: 'judgment-no-images'},
    {answeredOriginal: 'yes', fullTextStrategyId: 'fts-none', id: 'judgment-plain'},
  ])
  expect(
    await getDatabase().queryJson<{id: string; judgmentId: string}>(`
      SELECT id, judgment_id AS judgmentId
      FROM app.judgment_assessment
    `),
  ).toEqual([{id: 'assessment-fulltext', judgmentId: 'judgment-fulltext'}])
})

test('the new columns have the expected types, nullability and defaults', async () => {
  expect(await getColumn('app', 'judgment', 'full_text_strategy_id')).toEqual({
    columnDefault: "'fts-none'",
    dataType: 'VARCHAR',
    isNullable: false,
  })
  expect(await getColumn('app', 'project', 'full_text_chunk_policy')).toMatchObject({dataType: 'JSON'})
  expect(await getColumn('app', 'project', 'full_text_figure_mode')).toMatchObject({dataType: 'VARCHAR'})
  expect(await getColumn('app', 'project', 'full_text_strategy_id')).toMatchObject({dataType: 'VARCHAR'})
  expect(await getColumn('app', 'judgment_job', 'full_text_strategy_id')).toMatchObject({dataType: 'VARCHAR'})
  expect(await getColumn('app', 'judgment_execution_snapshot', 'full_text_strategy_id')).toMatchObject({
    columnDefault: "'fts-none'",
    dataType: 'VARCHAR',
  })
  expect(await getColumn('app', 'review_change_delta', 'full_text_strategy_id')).toMatchObject({
    columnDefault: "'fts-none'",
    dataType: 'VARCHAR',
  })
  expect(await getColumn('mart', 'comparison_system_prompt_variant_serving', 'full_text_strategy_id')).toMatchObject({
    columnDefault: "'fts-none'",
    dataType: 'VARCHAR',
  })
  expect(await getColumn('app', 'full_text_strategy', 'inputs')).toEqual({
    columnDefault: null,
    dataType: 'JSON',
    isNullable: false,
  })
})

test('the unique constraint and the lookup index include full_text_strategy_id', async () => {
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

test('the same judgment under another strategy is a new identity and the same strategy is a duplicate', async () => {
  expect(await getInsertError({fullTextStrategyId: 'fts-0123456789abcdef', id: 'judgment-strategy-a'})).toBeNull()
  expect(await getInsertError({fullTextStrategyId: 'fts-fedcba9876543210', id: 'judgment-strategy-b'})).toBeNull()
  expect(await getInsertError({fullTextStrategyId: 'fts-0123456789abcdef', id: 'judgment-strategy-a-again'})).toContain(
    'Duplicate key',
  )
})

test('a judgment inserted without a strategy defaults to fts-none', async () => {
  await getDatabase().run(`
    INSERT INTO app.judgment (id, article_id, prompt_id, model_id, is_answered, answered_original)
    VALUES ('judgment-default', 'article-1', 'prompt-1', 'model-c', TRUE, 'maybe')
  `)

  expect(
    await getDatabase().queryJson<{fullTextStrategyId: string}>(`
      SELECT full_text_strategy_id AS fullTextStrategyId
      FROM app.judgment
      WHERE id = 'judgment-default'
    `),
  ).toEqual([{fullTextStrategyId: 'fts-none'}])
})
