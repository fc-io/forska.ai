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
  reviewFiltersRef.current = async (input) => {
    return {
      diagnostics: [],
      facets: [],
      filterOptions: [
        {facet_key: 'promptAnswer', optionValueKey: 'human:promptAnswer:summary:no'},
        {facet_key: 'promptAnswer', optionValueKey: 'human:promptAnswer:summary:yes'},
      ],
      filters: [
        {promptId: 'summary', promptName: 'Overall human screening decision', answeredOriginalValues: ['no', 'yes']},
      ],
      searchScope: {mode: 'none'},
      serviceInput: input,
    }
  }

  const {projectsRoutesGetArticlesReviewsHumanFilters} = await loadHandler()
  const app = new Elysia().use(projectsRoutesGetArticlesReviewsHumanFilters)
  const response = await app.handle(
    new Request('http://localhost/api/articlesreviewshumanfilters?projectId=project-1&covidenceDuplicates=1'),
  )
  const body = (await response.json()) as Record<string, unknown>

  expect(response.status).toBe(200)
  expect(body).toEqual({
    diagnostics: [],
    facets: [],
    filterOptions: [
      {facet_key: 'promptAnswer', optionValueKey: 'human:promptAnswer:summary:no'},
      {facet_key: 'promptAnswer', optionValueKey: 'human:promptAnswer:summary:yes'},
    ],
    filters: [
      {promptId: 'summary', promptName: 'Overall human screening decision', answeredOriginalValues: ['no', 'yes']},
    ],
    humanJudgmentMode: 'summary',
    searchScope: {mode: 'none'},
    serviceInput: {mode: 'human', params: {covidenceDuplicates: '1', projectId: 'project-1'}, promptRows: []},
  })
})
