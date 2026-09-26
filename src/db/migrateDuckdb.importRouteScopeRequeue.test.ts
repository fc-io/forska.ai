import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import type {getAppDatabaseService} from '../server/services/appDatabaseService.ts'
import {createTempRuntimeRoot} from '../server/test/createTempRuntimeRoot.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('migrate-import-route-scope-requeue')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath

const migrationSql = readFileSync(
  resolve(import.meta.dir, 'duckdbMigrations', '0244_requeueImportRouteArticlesMissingFromProjectScope.sql'),
  'utf8',
)

let database: ReturnType<typeof getAppDatabaseService> | null = null

const getDatabase = () => {
  if (database === null) {
    throw new Error('Database not initialized')
  }

  return database
}

const insertProject = async (input: {archived: boolean; dateFrom: string | null; projectId: string}) => {
  await getDatabase().run(`
    INSERT INTO app.project (id, name, model_id, date_from, archived)
    VALUES (
      '${input.projectId}', '${input.projectId}', 'model-requeue',
      ${input.dateFrom === null ? 'NULL' : `TIMESTAMPTZ '${input.dateFrom}'`}, ${input.archived}
    )
  `)
  await getDatabase().run(`
    INSERT INTO app.project_import_route (id, project_id, import_route_id)
    VALUES ('route-link:${input.projectId}', '${input.projectId}', 'route-requeue')
  `)
}

const insertAddedArticle = async (input: {articleId: string; createdAt: string; linked: boolean}) => {
  await getDatabase().run(`
    INSERT INTO app.article (id, article_title, article_created_at)
    VALUES ('${input.articleId}', '${input.articleId}', TIMESTAMPTZ '${input.createdAt}')
  `)
  await getDatabase().run(`
    INSERT INTO app.import_run_article_delta (
      delta_id, change_kind, source_table, source_row_id, source_operation, source_partition, source_high_water_mark,
      idempotency_key, payload_version, import_route_id, article_id, source_record_key, reconciled_at
    ) VALUES (
      'delta:${input.articleId}', 'importRoute.article.added', 'app.article_import_route', 'row:${input.articleId}',
      'insert', 'import-route:route-requeue', 1, 'key:${input.articleId}', 1, 'route-requeue', '${input.articleId}',
      'record:${input.articleId}', TIMESTAMPTZ '2026-09-26T10:00:00Z'
    )
  `)

  if (input.linked) {
    await getDatabase().run(`
      INSERT INTO app.article_import_route (id, article_id, import_route_id)
      VALUES ('article-route:${input.articleId}', '${input.articleId}', 'route-requeue')
    `)
  }
}

beforeAll(async () => {
  const [{migrateDuckdb}, {getAppDatabaseService}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}] =
    await Promise.all([
      import('./migrateDuckdb.ts'),
      import('../server/services/appDatabaseService.ts'),
      import('../server/utils/duckdbService.ts'),
      import('../server/utils/serverRuntimeRole.ts'),
    ])

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()

  await migrateDuckdb()

  database = getAppDatabaseService()

  await getDatabase().run(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
    VALUES ('connection-requeue', 'sglang', 'SGLang', TRUE, 'none', 'https://worker.example.test')
  `)
  await getDatabase().run(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled, variant, metadata_json)
    VALUES ('model-requeue', 'connection-requeue', 'model', 'model', 'Model', 'manual', TRUE, 'thinking', '{}'::JSON)
  `)
  await getDatabase().run(
    "INSERT INTO app.import_route (id, route) VALUES ('route-requeue', '/api/datasources/import/pubmed')",
  )
  await insertProject({archived: false, dateFrom: '2026-01-01T00:00:00Z', projectId: 'project-open'})
  await insertProject({archived: true, dateFrom: null, projectId: 'project-archived'})
})

afterAll(async () => {
  await database?.close()
  tempRuntimeRoot.cleanup()
})

test('the migration reopens added deltas only for articles an unarchived project should scope but does not', async () => {
  await insertAddedArticle({articleId: 'article-missing', createdAt: '2026-09-02T00:00:00Z', linked: true})
  await insertAddedArticle({articleId: 'article-scoped', createdAt: '2026-09-02T00:00:00Z', linked: true})
  await insertAddedArticle({articleId: 'article-too-old', createdAt: '2025-06-01T00:00:00Z', linked: true})
  await insertAddedArticle({articleId: 'article-unlinked', createdAt: '2026-09-02T00:00:00Z', linked: false})
  await getDatabase().run(`
    INSERT INTO mart.project_scope_article (project_id, article_id, in_curated_scope, in_route_scope)
    VALUES ('project-open', 'article-scoped', FALSE, TRUE)
  `)

  await getDatabase().run(migrationSql)

  expect(
    await getDatabase().queryJson<{articleId: string; reopened: boolean}>(`
      SELECT article_id AS articleId, reconciled_at IS NULL AS reopened
      FROM app.import_run_article_delta
      WHERE import_route_id = 'route-requeue'
      ORDER BY article_id
    `),
  ).toEqual([
    {articleId: 'article-missing', reopened: true},
    {articleId: 'article-scoped', reopened: false},
    {articleId: 'article-too-old', reopened: false},
    {articleId: 'article-unlinked', reopened: false},
  ])
})
