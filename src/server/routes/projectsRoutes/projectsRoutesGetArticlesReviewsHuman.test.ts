import {afterEach, expect, mock, test} from 'bun:test'
import {Elysia} from 'elysia'

const appDatabaseServiceModulePath = new URL('../../services/appDatabaseService.ts', import.meta.url).pathname
const appQueryServiceModulePath = new URL('../../services/getAppQueryService.ts', import.meta.url).pathname
const projectAccessGuardModulePath = new URL('./projectAccessGuard.ts', import.meta.url).pathname

const queryJsonRef = {
  current: async (_statement: string): Promise<unknown[]> => {
    return []
  },
}

const fullArticlesByIdsRef = {
  current: async (_articleIds: string[]): Promise<unknown[]> => {
    return []
  },
}

const projectReviewConfigRef = {
  current: async (_projectId: string): Promise<unknown> => {
    return null
  },
}

const registerModuleMocks = () => {
  void mock.module(appDatabaseServiceModulePath, () => {
    return {
      getAppDatabaseService: () => {
        return {
          queryJson: (statement: string) => {
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
          getFullArticlesByIds: (articleIds: string[]) => {
            return fullArticlesByIdsRef.current(articleIds)
          },
          getProjectReviewConfig: (projectId: string) => {
            return projectReviewConfigRef.current(projectId)
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

const loadHandler = async (): Promise<typeof import('./projectsRoutesGetArticlesReviewsHuman.ts')> => {
  registerModuleMocks()
  return (await import(
    `./projectsRoutesGetArticlesReviewsHuman.ts?test=${Date.now()}-${Math.random()}`
  )) as typeof import('./projectsRoutesGetArticlesReviewsHuman.ts')
}

afterEach(() => {
  mock.restore()
})

test('articles reviews human returns summary-mode overall judgments', async () => {
  projectReviewConfigRef.current = async () => {
    return {
      humanJudgmentMode: 'summary',
      importRouteIds: ['route-1'],
      dateFrom: null,
      dateTo: null,
      modelId: 'model-1',
      useTitle: true,
      useAbstract: true,
      useFulltext: false,
      useFulltextNoImages: false,
    }
  }
  fullArticlesByIdsRef.current = async () => {
    return [{id: 'article-1', articleTitle: 'Article 1'}]
  }
  queryJsonRef.current = async (statement) => {
    return statement.includes('FROM app.judgment_human_summary') && statement.includes('SELECT article_id AS articleId')
      ? [{articleId: 'article-1'}]
      : statement.includes('COUNT(*) AS count')
        ? [{count: 1}]
        : statement.includes('SELECT a.id AS id')
          ? [{id: 'article-1'}]
          : statement.includes('FROM app.judgment_human_summary')
            ? [
                {
                  id: 'summary-1',
                  createdAt: '2024-01-01T00:00:00.000Z',
                  updatedAt: '2024-01-02T00:00:00.000Z',
                  articleId: 'article-1',
                  answer: 'no',
                  projectId: 'project-1',
                },
              ]
            : []
  }

  const {projectsRoutesGetArticlesReviewsHuman} = await loadHandler()
  const app = new Elysia().use(projectsRoutesGetArticlesReviewsHuman)
  const response = await app.handle(
    new Request('http://localhost/api/articlesreviewshuman', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({projectId: 'project-1', page: '1', limit: '10', prompts: {}}),
    }),
  )
  const body = (await response.json()) as {data: Array<Record<string, unknown>>; humanJudgmentMode: string}
  const firstArticle = body.data[0] as Record<string, unknown> | undefined
  const firstJudgment = (firstArticle?.judgments as Array<Record<string, unknown>> | undefined)?.[0]

  expect(response.status).toBe(200)
  expect(body.humanJudgmentMode).toBe('summary')
  expect(firstArticle?.id).toBe('article-1')
  expect(firstArticle?.articleTitle).toBe('Article 1')
  expect(firstArticle?.humanJudgmentMode).toBe('summary')
  expect(firstArticle?.humanSummaryAnswer).toBe('no')
  expect(firstJudgment).toEqual({
    answer: 'no',
    articleId: 'article-1',
    createdAt: '2024-01-01T00:00:00.000Z',
    id: 'summary-1',
    projectId: 'project-1',
    promptId: 'summary',
    updatedAt: '2024-01-02T00:00:00.000Z',
  })
  expect(firstArticle?.humanAnswersByPrompt).toBeUndefined()
})
