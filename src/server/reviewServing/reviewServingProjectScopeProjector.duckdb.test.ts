import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import type {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'
import type {ReviewServingDirtyWorkClaim} from './reviewServingDirtyWorkService.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('review-serving-project-scope-patches')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath

const projectId = 'project-scope-patch'
const projectScopeIdentity = `projectScope:${projectId}`
const importRouteId = 'import-route-scope-patch'

let database: ReturnType<typeof getAppDatabaseService> | null = null

const getDatabase = () => {
  if (database === null) {
    throw new Error('Database not initialized')
  }

  return database
}

type ScopeRow = {
  articleCreatedAt: string
  articleId: string
  articleTitle: string
  inCuratedScope: boolean
  inRouteScope: boolean
}

const getArticleClaim = (articleId: string, sourceHighWaterMark: number): ReviewServingDirtyWorkClaim => {
  return {
    articleId,
    dirtyKind: 'importRoute.article.added',
    dirtyRangeEnd: null,
    dirtyRangeStart: null,
    dirtyWorkId: `dirty-work:${articleId}:${sourceHighWaterMark}`,
    firstSourceHighWaterMark: sourceHighWaterMark,
    latestDeltaId: `delta:${articleId}:${sourceHighWaterMark}`,
    latestSourceHighWaterMark: sourceHighWaterMark,
    projectId,
    projectionComponent: 'projectScope',
    projectionIdentity: projectScopeIdentity,
    scopeId: `${projectId}:${articleId}`,
    scopeKind: 'article',
    sourcePartition: `import-route:${importRouteId}`,
    status: 'running',
  }
}

const getProjectClaim = (sourceHighWaterMark: number): ReviewServingDirtyWorkClaim => {
  return {
    ...getArticleClaim('unused', sourceHighWaterMark),
    articleId: null,
    dirtyKind: 'projectScope.rebuild',
    dirtyWorkId: `dirty-work:project:${sourceHighWaterMark}`,
    scopeId: projectId,
    scopeKind: 'project',
  }
}

const insertArticle = async (input: {articleId: string; createdAt: string; title: string}) => {
  await getDatabase().run(`
    INSERT INTO app.article (id, article_title, article_created_at, article_updated_at)
    VALUES ('${input.articleId}', '${input.title}', TIMESTAMPTZ '${input.createdAt}', TIMESTAMPTZ '${input.createdAt}')
  `)
}

const linkArticleToRoute = async (articleId: string) => {
  await getDatabase().run(`
    INSERT INTO app.article_import_route (id, article_id, import_route_id)
    VALUES ('article-route:${articleId}', '${articleId}', '${importRouteId}')
  `)
}

const getScopeRows = async () => {
  return getDatabase().queryJson<ScopeRow>(`
    SELECT
      article_id AS articleId,
      article_title AS articleTitle,
      strftime(article_created_at AT TIME ZONE 'UTC', '%Y-%m-%d') AS articleCreatedAt,
      in_curated_scope AS inCuratedScope,
      in_route_scope AS inRouteScope
    FROM mart.project_scope_article
    WHERE project_id = '${projectId}'
    ORDER BY article_id
  `)
}

const projectScopeClaims = async (claims: readonly ReviewServingDirtyWorkClaim[]) => {
  const {projectReviewServingProjectScopePatches} = await import('./reviewServingProjectScopeProjector.ts')

  return projectReviewServingProjectScopePatches(
    {
      baseGeneration: 0,
      claims,
      definitionVersion: 'project-scope:test',
      projectId,
      projectionIdentity: projectScopeIdentity,
    },
    getDatabase() as never,
  )
}

beforeAll(async () => {
  const [{migrateDuckdb}, {getAppDatabaseService}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}] =
    await Promise.all([
      import('../../db/migrateDuckdb.ts'),
      import('../services/appDatabaseService.ts'),
      import('../utils/duckdbService.ts'),
      import('../utils/serverRuntimeRole.ts'),
    ])

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()

  await migrateDuckdb()

  database = getAppDatabaseService()

  await getDatabase().run(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
    VALUES ('connection-scope', 'sglang', 'SGLang', TRUE, 'none', 'https://worker.example.test')
  `)
  await getDatabase().run(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled, variant, metadata_json)
    VALUES ('model-scope', 'connection-scope', 'model', 'model', 'Model', 'manual', TRUE, 'thinking', '{}'::JSON)
  `)
  await getDatabase().run(`
    INSERT INTO app.project (id, name, model_id, date_from)
    VALUES ('${projectId}', '${projectId}', 'model-scope', TIMESTAMPTZ '2026-01-01T00:00:00Z')
  `)
  await getDatabase().run(
    `INSERT INTO app.import_route (id, route) VALUES ('${importRouteId}', '/api/datasources/import/pubmed')`,
  )
  await getDatabase().run(`
    INSERT INTO app.project_import_route (id, project_id, import_route_id)
    VALUES ('project-route-scope-patch', '${projectId}', '${importRouteId}')
  `)
  await insertArticle({articleId: 'article-existing', createdAt: '2026-03-01T00:00:00Z', title: 'Existing'})
  await linkArticleToRoute('article-existing')
  await getDatabase().run(`
    INSERT INTO mart.project_scope_article (
      project_id, article_id, in_curated_scope, in_route_scope, article_title, article_created_at, article_updated_at
    ) VALUES (
      '${projectId}', 'article-existing', FALSE, TRUE, 'Existing', TIMESTAMPTZ '2026-03-01T00:00:00Z',
      TIMESTAMPTZ '2026-03-01T00:00:00Z'
    )
  `)
})

afterAll(async () => {
  await database?.close()
  tempRuntimeRoot.cleanup()
})

test('an import-route added claim puts the article into project scope inside the project date bounds', async () => {
  await insertArticle({articleId: 'article-added', createdAt: '2026-09-02T00:00:00Z', title: 'Added'})
  await insertArticle({articleId: 'article-too-old', createdAt: '2025-12-31T00:00:00Z', title: 'Too old'})
  await linkArticleToRoute('article-added')
  await linkArticleToRoute('article-too-old')

  await projectScopeClaims([getArticleClaim('article-added', 10), getArticleClaim('article-too-old', 11)])

  expect(await getScopeRows()).toEqual([
    {
      articleCreatedAt: '2026-09-02',
      articleId: 'article-added',
      articleTitle: 'Added',
      inCuratedScope: false,
      inRouteScope: true,
    },
    {
      articleCreatedAt: '2026-03-01',
      articleId: 'article-existing',
      articleTitle: 'Existing',
      inCuratedScope: false,
      inRouteScope: true,
    },
  ])
})

test('curated membership and route removal refresh only the claimed articles', async () => {
  await insertArticle({articleId: 'article-curated', createdAt: '2026-09-03T00:00:00Z', title: 'Curated'})
  await getDatabase().run(`
    INSERT INTO app.project_article (id, project_id, article_id)
    VALUES ('project-article-curated', '${projectId}', 'article-curated')
  `)
  await getDatabase().run("DELETE FROM app.article_import_route WHERE article_id = 'article-added'")
  await getDatabase().run("DELETE FROM app.article_import_route WHERE article_id = 'article-existing'")

  await projectScopeClaims([getArticleClaim('article-added', 12), getArticleClaim('article-curated', 13)])

  expect(await getScopeRows()).toEqual([
    {
      articleCreatedAt: '2026-09-03',
      articleId: 'article-curated',
      articleTitle: 'Curated',
      inCuratedScope: true,
      inRouteScope: false,
    },
    {
      articleCreatedAt: '2026-03-01',
      articleId: 'article-existing',
      articleTitle: 'Existing',
      inCuratedScope: false,
      inRouteScope: true,
    },
  ])
})

test('project-scoped claims leave scope rows to the rebuild that owns them', async () => {
  const before = await getScopeRows()

  await projectScopeClaims([getProjectClaim(14)])

  expect(await getScopeRows()).toEqual(before)
})
