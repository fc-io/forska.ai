import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import type {getAppDatabaseService} from '../server/services/appDatabaseService.ts'
import {createTempRuntimeRoot} from '../server/test/createTempRuntimeRoot.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('migrate-project-use-metadata')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath

const migrationFileName = '0254_projectUseMetadata.sql'
const previousMigrationFileName = '0253_comparisonServingSystemPromptVariant.sql'
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

const insertProject = async (input: {humanJudgmentMode: 'prompt' | 'summary'; id: string; name: string}) => {
  await getDatabase().run(`
    INSERT INTO app.project (
      id, name, model_id, human_judgment_mode, use_title, use_abstract, archived, created_at, updated_at
    ) VALUES (
      '${input.id}', '${input.name}', 'model-1', '${input.humanJudgmentMode}', TRUE, TRUE,
      FALSE, TIMESTAMPTZ '2026-09-01T08:00:00Z', TIMESTAMPTZ '2026-09-02T09:30:00Z'
    )
  `)
}

const insertSnapshot = async (id: string) => {
  await getDatabase().run(`
    INSERT INTO app.judgment_execution_snapshot (
      id, job_id, project_id, queue_record_id, claim_id, article_id, prompt_id, model_id,
      use_title, use_abstract, use_fulltext, use_fulltext_no_images, payload_hash, payload_json
    ) VALUES (
      '${id}', 'job-1', 'project-manual', 'queue-${id}', 'claim-1', 'article-1', 'prompt-1', 'model-1',
      TRUE, TRUE, FALSE, FALSE, 'hash-${id}', '{}'
    )
  `)
}

const getUseMetadataColumns = () => {
  return getDatabase().queryJson<{columnDefault: string | null; dataType: string; tableName: string}>(`
    SELECT table_name AS tableName, data_type AS dataType, column_default AS columnDefault
    FROM duckdb_columns()
    WHERE schema_name = 'app'
      AND table_name IN ('project', 'judgment_execution_snapshot')
      AND column_name = 'use_metadata'
    ORDER BY table_name
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

test('the migration only adds the columns, has no comments and does not update any row', () => {
  expect(migrationSql).not.toContain('--')
  expect(migrationSql).not.toMatch(/\bUPDATE\b/i)
  expect(migrationSql).not.toMatch(/\bINSERT\b/i)
  expect(migrationSql).toContain('ALTER TABLE app.project ADD COLUMN IF NOT EXISTS use_metadata BOOLEAN DEFAULT FALSE;')
  expect(migrationSql).toContain(
    'ALTER TABLE app.judgment_execution_snapshot ADD COLUMN IF NOT EXISTS use_metadata BOOLEAN DEFAULT FALSE;',
  )
})

test('existing projects and execution snapshots read FALSE after the migration and new rows default to FALSE', async () => {
  expect(await getUseMetadataColumns()).toEqual([])

  await insertProject({humanJudgmentMode: 'prompt', id: 'project-manual', name: 'Manual project'})
  await insertProject({humanJudgmentMode: 'summary', id: 'project-covidence', name: 'Existing Covidence project'})
  await insertSnapshot('snapshot-before')

  await getMigrateDuckdb()({throughFileName: migrationFileName})

  expect(await getUseMetadataColumns()).toEqual([
    {columnDefault: 'false', dataType: 'BOOLEAN', tableName: 'judgment_execution_snapshot'},
    {columnDefault: 'false', dataType: 'BOOLEAN', tableName: 'project'},
  ])

  await insertProject({humanJudgmentMode: 'prompt', id: 'project-new', name: 'New project'})
  await insertSnapshot('snapshot-after')

  expect(
    await getDatabase().queryJson<{id: string; updatedAt: string; useMetadata: boolean | null}>(`
      SELECT
        id,
        use_metadata AS useMetadata,
        strftime(updated_at AT TIME ZONE 'UTC', '%Y-%m-%dT%H:%M:%SZ') AS updatedAt
      FROM app.project
      ORDER BY id
    `),
  ).toEqual([
    {id: 'project-covidence', updatedAt: '2026-09-02T09:30:00Z', useMetadata: false},
    {id: 'project-manual', updatedAt: '2026-09-02T09:30:00Z', useMetadata: false},
    {id: 'project-new', updatedAt: '2026-09-02T09:30:00Z', useMetadata: false},
  ])
  expect(
    await getDatabase().queryJson<{id: string; useMetadata: boolean | null}>(`
      SELECT id, use_metadata AS useMetadata
      FROM app.judgment_execution_snapshot
      ORDER BY id
    `),
  ).toEqual([
    {id: 'snapshot-after', useMetadata: false},
    {id: 'snapshot-before', useMetadata: false},
  ])
  expect(
    await getDatabase().queryJson<{name: string}>(`
      SELECT name
      FROM app_schema_migration
      WHERE name = '${migrationFileName}'
    `),
  ).toEqual([{name: migrationFileName}])
})

test('re-running the migration keeps the columns and existing values', async () => {
  await getDatabase().run(`
    UPDATE app.project
    SET use_metadata = TRUE
    WHERE id = 'project-covidence'
  `)

  await getDatabase().run(migrationSql)

  expect(
    await getDatabase().queryJson<{id: string; useMetadata: boolean | null}>(`
      SELECT id, use_metadata AS useMetadata
      FROM app.project
      ORDER BY id
    `),
  ).toEqual([
    {id: 'project-covidence', useMetadata: true},
    {id: 'project-manual', useMetadata: false},
    {id: 'project-new', useMetadata: false},
  ])
})
