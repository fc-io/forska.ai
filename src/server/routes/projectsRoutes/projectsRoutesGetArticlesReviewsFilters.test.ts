import {afterEach, expect, mock, test} from 'bun:test'
import {Elysia} from 'elysia'

const appQueryServiceModulePath = new URL('../../services/getAppQueryService.ts', import.meta.url).pathname
const projectAccessGuardModulePath = new URL('./projectAccessGuard.ts', import.meta.url).pathname
const reviewServingFilterRouteServiceModulePath = new URL(
  '../../reviewServing/reviewServingFilterRouteService.ts',
  import.meta.url,
).pathname

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

const reviewFiltersRef = {
  current: async (_input: unknown): Promise<unknown> => {
    return {diagnostics: [], facets: [], filterOptions: [], filters: [], searchScope: null}
  },
}

const registerModuleMocks = () => {
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

  void mock.module(reviewServingFilterRouteServiceModulePath, () => {
    return {
      getReviewFiltersFromServing: (input: unknown) => {
        return reviewFiltersRef.current(input)
      },
    }
  })
}

const loadHandler = async (): Promise<typeof import('./projectsRoutesGetArticlesReviewsFilters.ts')> => {
  registerModuleMocks()
  return (await import(
    `./projectsRoutesGetArticlesReviewsFilters.ts?test=${Date.now()}-${Math.random()}`
  )) as typeof import('./projectsRoutesGetArticlesReviewsFilters.ts')
}

afterEach(() => {
  mock.restore()
})

test('articles reviews filters route passes both mode and project human mode to serving filters', async () => {
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
    return [{id: 'prompt-1', originalText: 'Prompt 1', promptHeading: 'Prompt 1', type: "'yes' | 'no' | 'maybe'"}]
  }
  reviewFiltersRef.current = async (input) => {
    return {
      diagnostics: [],
      facets: [],
      filterOptions: [],
      filters: [],
      promptFilterDefinitions: [],
      searchScope: {mode: 'none'},
      serviceInput: input,
    }
  }

  const {projectsRoutesGetArticlesReviewsFilters} = await loadHandler()
  const app = new Elysia().use(projectsRoutesGetArticlesReviewsFilters)
  const response = await app.handle(
    new Request('http://localhost/api/articlesreviewsfilters?projectId=project-1&mode=both'),
  )
  const body = (await response.json()) as Record<string, unknown>

  expect(response.status).toBe(200)
  expect(body.serviceInput).toEqual({
    humanJudgmentMode: 'summary',
    mode: 'both',
    params: {mode: 'both', projectId: 'project-1'},
    promptRows: [{id: 'prompt-1', originalText: 'Prompt 1', promptHeading: 'Prompt 1', type: "'yes' | 'no' | 'maybe'"}],
  })
})
