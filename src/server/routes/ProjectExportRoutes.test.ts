import {afterEach, expect, mock, test} from 'bun:test'
import {Elysia} from 'elysia'

const appDatabaseServiceModulePath = new URL('../services/appDatabaseService.ts', import.meta.url).pathname
const appQueryServiceModulePath = new URL('../services/getAppQueryService.ts', import.meta.url).pathname
const projectAccessGuardModulePath = new URL('./projectsRoutes/projectAccessGuard.ts', import.meta.url).pathname

const queryStatements: string[] = []
const queryJsonRef = {
  current: async (_statement: string): Promise<unknown[]> => {
    return []
  },
}

const registerModuleMocks = () => {
  void mock.module(appDatabaseServiceModulePath, () => {
    return {
      getAppDatabaseService: () => {
        return {
          queryJson: (statement: string) => {
            queryStatements.push(statement)
            return queryJsonRef.current(statement)
          },
        }
      },
    }
  })

  void mock.module(appQueryServiceModulePath, () => {
    return {
      getAppQueryService: () => {
        return {
          getProjectReviewConfig: async () => {
            return {
              importRouteIds: ['route-1'],
              modelId: null,
              useAbstract: true,
              useFulltext: false,
              useFulltextNoImages: false,
              useTitle: true,
            }
          },
        }
      },
    }
  })

  void mock.module(projectAccessGuardModulePath, () => {
    return {
      assertProjectIsActive: async () => {
        return {archived: false, id: 'project-1', name: 'Project 1'}
      },
    }
  })
}

const loadRoutes = async (): Promise<typeof import('./ProjectExportRoutes.ts')> => {
  registerModuleMocks()
  return (await import(
    `./ProjectExportRoutes.ts?test=${Date.now()}-${Math.random()}`
  )) as typeof import('./ProjectExportRoutes.ts')
}

afterEach(() => {
  queryStatements.length = 0
  mock.restore()
})

test('project export uses scoped external article identity for metadata-only export', async () => {
  queryJsonRef.current = async (statement) => {
    return statement.includes('SELECT') && statement.includes('articleExternalId')
      ? [
          {
            articleAuthors: [],
            articleCreatedAt: null,
            articleExternalId: 'covidence:42',
            articleId: 'article-1',
            articleSourceMetadata: null,
            articleSummary: null,
            articleTitle: 'Scoped export article',
            articleUpdatedAt: null,
          },
        ]
      : statement.includes('SELECT count(a.id) AS count')
        ? [{count: 1}]
        : statement.includes('FROM app.project')
          ? [{id: 'project-1', name: 'Project 1'}]
          : []
  }
  const {projectExportRoutes} = await loadRoutes()
  const app = new Elysia().use(projectExportRoutes)
  const response = await app.handle(
    new Request('http://localhost/api/projects/project-1/export', {
      body: JSON.stringify({includeArticleId: true, promptIds: [], sourceProjectIds: ['project-1']}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const csv = await response.text()
  const exportQuery = queryStatements.find((statement) => {
    return statement.includes('articleExternalId')
  })

  expect(response.status).toBe(200)
  expect(csv).toContain('Title,Article ID')
  expect(csv).toContain('Scoped export article,covidence:42')
  expect(exportQuery).toContain('COALESCE(scoped_import.external_article_id, a.article_id) AS articleExternalId')
  expect(exportQuery).toContain('LEFT JOIN selected_scoped_article_import scoped_import')
})
