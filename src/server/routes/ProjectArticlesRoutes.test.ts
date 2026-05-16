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
