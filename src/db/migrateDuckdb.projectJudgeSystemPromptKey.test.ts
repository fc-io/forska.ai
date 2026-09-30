import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import type {getAppDatabaseService} from '../server/services/appDatabaseService.ts'
import {createTempRuntimeRoot} from '../server/test/createTempRuntimeRoot.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('migrate-project-judge-system-prompt-key')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath

const migrationFileName = '0250_projectJudgeSystemPromptKey.sql'
const previousMigrationFileName = '0249_dropReviewServingRetentionLeftovers.sql'
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

const insertProject = async (input: {
  archived?: boolean
  humanJudgmentMode: 'prompt' | 'summary'
  id: string
  importRoute?: string
  name: string
}) => {
  await getDatabase().run(`
    INSERT INTO app.project (
      id, name, model_id, human_judgment_mode, use_title, use_abstract, archived, created_at, updated_at
    ) VALUES (
      '${input.id}', '${input.name}', 'model-1', '${input.humanJudgmentMode}', TRUE, TRUE,
      ${input.archived ? 'TRUE' : 'FALSE'}, TIMESTAMPTZ '2026-09-01T08:00:00Z', TIMESTAMPTZ '2026-09-02T09:30:00Z'
    )
  `)

  if (input.importRoute) {
    await getDatabase().run(`
      INSERT INTO app.import_route (id, route, name, active)
      VALUES ('route-${input.id}', '${input.importRoute}', '${input.name}', TRUE)
    `)
    await getDatabase().run(`
      INSERT INTO app.project_import_route (id, project_id, import_route_id)
      VALUES ('project-route-${input.id}', '${input.id}', 'route-${input.id}')
    `)
  }
}

const getProjectColumn = async () => {
  const [column] = await getDatabase().queryJson<{dataType: string; isNullable: boolean}>(`
    SELECT data_type AS dataType, is_nullable AS isNullable
    FROM duckdb_columns()
    WHERE schema_name = 'app'
      AND table_name = 'project'
      AND column_name = 'judge_system_prompt_key'
  `)

  return column ?? null
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

test('the migration only adds the column and does not update any row', () => {
  expect(migrationSql).not.toMatch(/\bUPDATE\b/i)
  expect(migrationSql).not.toMatch(/\bINSERT\b/i)
  expect(migrationSql).not.toMatch(/\bDEFAULT\b/i)
})

test('the migration adds a nullable column and leaves every existing project, Covidence or not, on NULL', async () => {
  expect(await getProjectColumn()).toBeNull()

  await insertProject({humanJudgmentMode: 'prompt', id: 'project-manual', name: 'Manual project'})
  await insertProject({
    humanJudgmentMode: 'summary',
    id: 'project-covidence',
    importRoute: 'covidence:data-source-existing',
    name: 'Existing Covidence project',
  })
  await insertProject({
    archived: true,
    humanJudgmentMode: 'summary',
    id: 'project-covidence-archived',
    importRoute: 'covidence:data-source-archived',
    name: 'Archived Covidence project',
  })

  await getMigrateDuckdb()()

  expect(await getProjectColumn()).toEqual({dataType: 'VARCHAR', isNullable: true})
  expect(
    await getDatabase().queryJson<{id: string; judgeSystemPromptKey: string | null; updatedAt: string}>(`
      SELECT
        id,
        judge_system_prompt_key AS judgeSystemPromptKey,
        strftime(updated_at AT TIME ZONE 'UTC', '%Y-%m-%dT%H:%M:%SZ') AS updatedAt
      FROM app.project
      ORDER BY id
    `),
  ).toEqual([
    {id: 'project-covidence', judgeSystemPromptKey: null, updatedAt: '2026-09-02T09:30:00Z'},
    {id: 'project-covidence-archived', judgeSystemPromptKey: null, updatedAt: '2026-09-02T09:30:00Z'},
    {id: 'project-manual', judgeSystemPromptKey: null, updatedAt: '2026-09-02T09:30:00Z'},
  ])
  expect(
    await getDatabase().queryJson<{name: string}>(`
      SELECT name
      FROM app_schema_migration
      WHERE name = '${migrationFileName}'
    `),
  ).toEqual([{name: migrationFileName}])
})

test('re-running the migration keeps the column and existing values', async () => {
  await getDatabase().run(`
    UPDATE app.project
    SET judge_system_prompt_key = 'screening_v1'
    WHERE id = 'project-manual'
  `)

  await getDatabase().run(migrationSql)

  expect(
    await getDatabase().queryJson<{id: string; judgeSystemPromptKey: string | null}>(`
      SELECT id, judge_system_prompt_key AS judgeSystemPromptKey
      FROM app.project
      ORDER BY id
    `),
  ).toEqual([
    {id: 'project-covidence', judgeSystemPromptKey: null},
    {id: 'project-covidence-archived', judgeSystemPromptKey: null},
    {id: 'project-manual', judgeSystemPromptKey: 'screening_v1'},
  ])
})
