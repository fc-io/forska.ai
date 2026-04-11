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

const projectPromptRowsRef = {
  current: async (_projectId: string): Promise<unknown[]> => {
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
          getProjectPromptRows: (projectId: string) => {
            return projectPromptRowsRef.current(projectId)
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

const loadHandler = async (): Promise<typeof import('./projectsRoutesGetArticlesReviewsHumanFilters.ts')> => {
  registerModuleMocks()
  return (await import(
    `./projectsRoutesGetArticlesReviewsHumanFilters.ts?test=${Date.now()}-${Math.random()}`
  )) as typeof import('./projectsRoutesGetArticlesReviewsHumanFilters.ts')
}

afterEach(() => {
  mock.restore()
})

test('articles reviews human filters returns overall summary filter in summary mode', async () => {
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
  projectPromptRowsRef.current = async () => {
    return []
  }
  queryJsonRef.current = async (statement) => {
    return statement.includes('FROM app.judgment_human_summary jhs') ? [{answer: 'no'}, {answer: 'yes'}] : []
  }

  const {projectsRoutesGetArticlesReviewsHumanFilters} = await loadHandler()
  const app = new Elysia().use(projectsRoutesGetArticlesReviewsHumanFilters)
  const response = await app.handle(new Request('http://localhost/api/articlesreviewshumanfilters?projectId=project-1'))
  const body = (await response.json()) as {filters: Array<Record<string, unknown>>; humanJudgmentMode: string}

  expect(response.status).toBe(200)
  expect(body).toEqual({
    filters: [
      {promptId: 'summary', promptName: 'Overall human screening decision', answeredOriginalValues: ['no', 'yes']},
    ],
    humanJudgmentMode: 'summary',
  })
})
