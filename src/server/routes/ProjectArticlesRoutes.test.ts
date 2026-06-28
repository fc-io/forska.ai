import {afterAll, beforeAll, beforeEach, expect, mock, test} from 'bun:test'
import {Elysia} from 'elysia'

import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'

const projectMartDirtyRefreshStateServiceModulePath = new URL(
  '../services/projectMartDirtyRefreshStateService.ts',
  import.meta.url,
).pathname

const tempRuntimeRoot = createTempRuntimeRoot('f1-project-articles-routes')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

type DirtyMark = {
  hasRunner: boolean
  projects: Array<{articleIds?: string[]; projectId: string}>
  reason: string | null | undefined
}

const dirtyMarkState = {fail: false, marks: [] as DirtyMark[]}

let app: {handle: (request: Request) => Promise<Response>} | null = null
let database: {
  close: () => Promise<void>
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
} | null = null

const registerModuleMocks = () => {
  void mock.module(projectMartDirtyRefreshStateServiceModulePath, () => {
    return {
      getProjectMartDirtyRefreshStateService: () => {
        return {
          markProjectsDirtyAtomically: async (params: {
            projects: Array<{articleIds?: string[]; projectId: string}>
            reason?: string | null
            runner?: unknown
          }) => {
            dirtyMarkState.marks.push({
              hasRunner: params.runner != null,
              projects: params.projects,
              reason: params.reason,
            })

            if (dirtyMarkState.fail) {
              throw new Error('dirty mark failed')
            }
          },
        }
      },
    }
  })
}

const seedProjectArticleFixture = async (prefix: string) => {
  if (!database) {
    throw new Error('Database not initialized')
  }

  const articleId = `${prefix}-article`
  const connectionId = `${prefix}-connection`
  const modelId = `${prefix}-model`
  const projectId = `${prefix}-project`
  const projectArticleId = `${prefix}-project-article`

  await database.run(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode)
    VALUES ('${connectionId}', 'sglang', 'SGLang', TRUE, 'none');

    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('${modelId}', '${connectionId}', '${modelId}', '${modelId}', '${modelId}', 'manual', TRUE);

    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('${projectId}', '${projectId}', '${modelId}', TRUE, TRUE, FALSE, FALSE);

    INSERT INTO app.article (id, article_title)
    VALUES ('${articleId}', '${articleId}');

    INSERT INTO app.project_article (id, project_id, article_id)
    VALUES ('${projectArticleId}', '${projectId}', '${articleId}');
  `)

  return {articleId, projectId}
}

const seedProjectArticleMembershipFixture = async (prefix: string) => {
  if (!database) {
    throw new Error('Database not initialized')
  }

  const connectionId = `${prefix}-connection`
  const modelId = `${prefix}-model`
  const projectId = `${prefix}-project`
  const importedFromProjectId = `${prefix}-imported-from-project`
  const articleRows = [
    {createdAt: '2026-01-03T00:00:00.000Z', id: `${prefix}-article-3`, title: `${prefix} Article 3`},
    {createdAt: '2026-01-02T00:00:00.000Z', id: `${prefix}-article-2`, title: `${prefix} Article 2`},
    {createdAt: '2026-01-01T00:00:00.000Z', id: `${prefix}-article-1`, title: `${prefix} Article 1`},
  ]
  const importedArticle = articleRows[0]
  const required = ['display', 'projectScope', 'selectedImport', 'payload'].map((component) => {
    return {baseGeneration: '1', component, patchWatermark: '0', projectionIdentity: `${component}:${prefix}`}
  })

  if (!importedArticle) {
    throw new Error('Membership fixture article not initialized')
  }

  await database.run(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode)
    VALUES ('${connectionId}', 'sglang', 'SGLang', TRUE, 'none');

    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('${modelId}', '${connectionId}', '${modelId}', '${modelId}', '${modelId}', 'manual', TRUE);

    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES
      ('${projectId}', '${projectId}', '${modelId}', TRUE, TRUE, FALSE, FALSE),
      ('${importedFromProjectId}', '${prefix} Imported Project', '${modelId}', TRUE, TRUE, FALSE, FALSE);

    INSERT INTO app.article (id, article_title, article_created_at)
    VALUES ${articleRows
      .map((article) => {
        return `('${article.id}', '${article.id} stale source title', TIMESTAMPTZ '${article.createdAt}')`
      })
      .join(', ')};

    INSERT INTO app.project_article (id, project_id, article_id, imported_from_project_id)
    VALUES ('${prefix}-project-article-3', '${projectId}', '${importedArticle.id}', '${importedFromProjectId}');

    INSERT INTO mart.project_scope_article (project_id, article_id, in_curated_scope, in_route_scope, article_created_at)
    VALUES ${articleRows
      .map((article) => {
        return `('${projectId}', '${article.id}', TRUE, FALSE, TIMESTAMPTZ '${article.createdAt}')`
      })
      .join(', ')};

    INSERT INTO app.review_serving_snapshot_manifest (
      project_id,
      snapshot_id,
      snapshot_status,
      review_config_hash,
      composed_identity_json,
      component_state_json,
      required_components_json,
      optional_components_json,
      source_watermarks_json,
      activated_at,
      updated_at
    ) VALUES (
      '${projectId}',
      '${prefix}-snapshot',
      'active',
      '${prefix}-review-config',
      '{}'::JSON,
      '${JSON.stringify({optional: [], required}).replaceAll("'", "''")}'::JSON,
      '${JSON.stringify(required).replaceAll("'", "''")}'::JSON,
      '[]'::JSON,
      '{}'::JSON,
      TIMESTAMPTZ '2026-01-04T00:00:00.000Z',
      TIMESTAMPTZ '2026-01-04T00:00:00.000Z'
    );

    INSERT INTO mart.review_article_serving_v4 (
      project_id,
      review_config_hash,
      snapshot_id,
      base_generation,
      patch_watermark,
      display_identity,
      project_scope_identity,
      selected_import_identity,
      llm_status_identity,
      human_status_identity,
      posting_identity,
      summary_identity,
      payload_identity,
      list_mode_key,
      article_id,
      article_created_at,
      article_updated_at,
      sort_key,
      activity_sort_at,
      article_title
    ) VALUES ${articleRows
      .map((article) => {
        return `('${projectId}', '${prefix}-review-config', '${prefix}-snapshot', 1, 0, 'display:${prefix}', 'projectScope:${prefix}', 'selectedImport:${prefix}', 'llmStatus:${prefix}', 'humanStatus:${prefix}', 'posting:${prefix}', 'summary:${prefix}', 'payload:${prefix}', 'llm', '${article.id}', TIMESTAMPTZ '${article.createdAt}', NULL, TIMESTAMPTZ '${article.createdAt}', TIMESTAMPTZ '${article.createdAt}', '${article.title}')`
      })
      .join(', ')};
  `)

  return {articleRows, importedFromProjectId, projectId}
}

const getProjectArticleCount = async (fixture: {articleId: string; projectId: string}) => {
  if (!database) {
    throw new Error('Database not initialized')
  }

  const [row] = await database.queryJson<{rowCount: number}>(`
    SELECT CAST(COUNT(*) AS INTEGER) AS rowCount
    FROM app.project_article
    WHERE project_id = '${fixture.projectId}'
      AND article_id = '${fixture.articleId}'
  `)

  return row?.rowCount ?? 0
}

beforeAll(async () => {
  registerModuleMocks()

  const [
    {migrateDuckdb},
    {getAppDatabaseService},
    {resetDuckdbServiceForTests},
    {resetServerRuntimeRoleForTests},
    {projectArticlesRoutes},
  ] = await Promise.all([
    import('../../db/migrateDuckdb.ts'),
    import('../services/appDatabaseService.ts'),
    import('../utils/duckdbService.ts'),
    import('../utils/serverRuntimeRole.ts'),
    import('./ProjectArticlesRoutes.ts'),
  ])

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()
  await migrateDuckdb()

  database = getAppDatabaseService()
  app = new Elysia().use(projectArticlesRoutes)
})

beforeEach(() => {
  dirtyMarkState.fail = false
  dirtyMarkState.marks = []
})

afterAll(async () => {
  await database?.close()
  mock.restore()
  tempRuntimeRoot.cleanup()
})

test('project article delete commits the row deletion and dirty mark together', async () => {
  if (!app) {
    throw new Error('Test app not initialized')
  }

  const fixture = await seedProjectArticleFixture('project-article-delete-success')
  const response = await app.handle(
    new Request(`http://localhost/api/projects/${fixture.projectId}/articles/${fixture.articleId}`, {method: 'DELETE'}),
  )

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({success: true})
  expect(await getProjectArticleCount(fixture)).toBe(0)
  expect(dirtyMarkState.marks).toEqual([
    {
      hasRunner: true,
      projects: [{articleIds: [fixture.articleId], projectId: fixture.projectId}],
      reason: 'ProjectArticlesRoutes.delete',
    },
  ])
})

test('project article delete rolls back when dirty marking fails', async () => {
  if (!app) {
    throw new Error('Test app not initialized')
  }

  const fixture = await seedProjectArticleFixture('project-article-delete-rollback')
  dirtyMarkState.fail = true
  const response = await app.handle(
    new Request(`http://localhost/api/projects/${fixture.projectId}/articles/${fixture.articleId}`, {method: 'DELETE'}),
  )

  expect(response.status).toBe(500)
  expect(await getProjectArticleCount(fixture)).toBe(1)
  expect(dirtyMarkState.marks).toEqual([
    {
      hasRunner: true,
      projects: [{articleIds: [fixture.articleId], projectId: fixture.projectId}],
      reason: 'ProjectArticlesRoutes.delete',
    },
  ])
})

test('project article membership listing uses cursor pagination over project-scope and v4 state', async () => {
  if (!app) {
    throw new Error('Test app not initialized')
  }

  const fixture = await seedProjectArticleMembershipFixture('project-article-membership-cursor')
  const [newestArticle, middleArticle, oldestArticle] = fixture.articleRows

  if (!newestArticle || !middleArticle || !oldestArticle) {
    throw new Error('Membership fixture articles not initialized')
  }

  const firstResponse = await app.handle(
    new Request(`http://localhost/api/projects/${fixture.projectId}/articles?page=1&limit=2`),
  )
  const firstBody = (await firstResponse.json()) as {
    articles: Array<{
      articleTitle: string
      id: string
      importedFromProjectId: string | null
      importedFromProjectName: string | null
    }>
    hasMore: boolean
    nextCursor: string | null
    totalCount: number | null
    totalPages: number | null
  }

  expect(firstResponse.status).toBe(200)
  expect(firstBody.articles).toEqual([
    {
      articleTitle: newestArticle.title,
      id: newestArticle.id,
      importedFromProjectId: null,
      importedFromProjectName: null,
    },
    {
      articleTitle: middleArticle.title,
      id: middleArticle.id,
      importedFromProjectId: null,
      importedFromProjectName: null,
    },
  ])
  expect(firstBody.hasMore).toBe(true)
  expect(typeof firstBody.nextCursor).toBe('string')
  expect(firstBody.totalCount).toBeNull()
  expect(firstBody.totalPages).toBeNull()

  const secondResponse = await app.handle(
    new Request(
      `http://localhost/api/projects/${fixture.projectId}/articles?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor ?? '')}`,
    ),
  )
  const secondBody = (await secondResponse.json()) as {
    articles: Array<{id: string}>
    hasMore: boolean
    nextCursor: string | null
  }

  expect(secondResponse.status).toBe(200)
  expect(
    secondBody.articles.map((article) => {
      return article.id
    }),
  ).toEqual([oldestArticle.id])
  expect(secondBody.hasMore).toBe(false)
  expect(secondBody.nextCursor).toBeNull()
})

test('project article membership listing rejects unbounded legacy deep pages', async () => {
  if (!app) {
    throw new Error('Test app not initialized')
  }

  const fixture = await seedProjectArticleMembershipFixture('project-article-membership-deep-page')
  const response = await app.handle(
    new Request(`http://localhost/api/projects/${fixture.projectId}/articles?page=2&limit=2`),
  )

  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({
    error: 'Use cursor pagination for project article membership after the first page.',
  })
})
