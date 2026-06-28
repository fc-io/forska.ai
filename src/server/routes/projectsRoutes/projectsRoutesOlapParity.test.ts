import {expect, mock, test} from 'bun:test'
import {Elysia} from 'elysia'

const appQueryServiceModulePath = new URL('../../services/getAppQueryService.ts', import.meta.url).pathname
const llmReviewRouteServiceModulePath = new URL(
  '../../reviewServing/reviewServingLlmReviewRouteService.ts',
  import.meta.url,
).pathname
const humanBothUnassessedRouteServiceModulePath = new URL(
  '../../reviewServing/reviewServingHumanBothUnassessedRouteService.ts',
  import.meta.url,
).pathname
const projectAccessGuardModulePath = new URL('./projectAccessGuard.ts', import.meta.url).pathname

const reviewHydrationRowsRef = {
  current: async (_articleIds: string[]): Promise<unknown[]> => {
    return []
  },
}
const reviewHydrationCallCountRef = {current: 0}
const fullArticleRowsRef = {
  current: async (_articleIds: string[]): Promise<unknown[]> => {
    return []
  },
}
const projectReviewConfigRef = {
  current: async (_projectId: string): Promise<unknown> => {
    return null
  },
}
const countReviewsRef = {
  current: async (_params?: unknown): Promise<unknown> => {
    return {totalCount: 0, totalPages: 0}
  },
}
const queryReviewsRef = {
  current: async (_params?: unknown): Promise<unknown> => {
    return {data: [], totalCount: null, page: 1, limit: 100, totalPages: null}
  },
}
const queryReviewsParamsRef = {current: [] as unknown[]}
const queryBothRef = {
  current: async (_params?: unknown): Promise<unknown> => {
    return {data: [], totalCount: 0, page: 1, limit: 100, totalPages: 0}
  },
}
const queryUnassessedRef = {
  current: async (_params?: unknown): Promise<unknown> => {
    return {articles: [], totalCount: 0}
  },
}

void mock.module(appQueryServiceModulePath, () => {
  return {
    getAppQueryService: () => {
      return {
        getFullArticlesByIds: (articleIds: string[]) => {
          return fullArticleRowsRef.current(articleIds)
        },
        getProjectPromptRows: async () => {
          return []
        },
        getProjectReviewConfig: (projectId: string) => {
          return projectReviewConfigRef.current(projectId)
        },
        getReviewHydrationRows: (articleIds: string[]) => {
          reviewHydrationCallCountRef.current += 1
          return reviewHydrationRowsRef.current(articleIds)
        },
      }
    },
  }
})

void mock.module(llmReviewRouteServiceModulePath, () => {
  return {
    countLlmReviewArticlesFromServing: (params: unknown) => {
      return countReviewsRef.current(params)
    },
    getLlmReviewArticlesFromServing: (params: unknown) => {
      queryReviewsParamsRef.current = [...queryReviewsParamsRef.current, params]
      return queryReviewsRef.current(params)
    },
  }
})

void mock.module(humanBothUnassessedRouteServiceModulePath, () => {
  return {
    getBothReviewArticlesFromServing: (params: unknown) => {
      return queryBothRef.current(params)
    },
    getUnassessedReviewArticlesFromServing: async (params: unknown) => {
      const result = (await queryUnassessedRef.current(params)) as {articles?: unknown[]}
      return result.articles ? {...result, data: result.articles} : result
    },
  }
})

void mock.module(projectAccessGuardModulePath, () => {
  return {
    assertProjectIsActive: async () => {
      return {id: 'project-1', name: 'Project 1', archived: false}
    },
  }
})

test('articles reviews route forwards unfiltered request params to serving', async () => {
  queryReviewsParamsRef.current = []
  reviewHydrationCallCountRef.current = 0
  reviewHydrationRowsRef.current = async () => {
    return []
  }
  queryReviewsRef.current = async (_params?: unknown): Promise<unknown> => {
    return {data: [], totalCount: null, page: 1, limit: 10, totalPages: null}
  }

  const {projectsRoutesGetArticlesReviews} = await import('./projectsRoutesGetArticlesReviews.ts')
  const app = new Elysia().use(projectsRoutesGetArticlesReviews)
  const response = await app.handle(
    new Request('http://localhost/api/articlesreviews', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({projectId: 'project-1', page: '1', limit: '10', prompts: {}}),
    }),
  )

  expect(response.status).toBe(200)
  expect(queryReviewsParamsRef.current).toEqual([
    {projectId: 'project-1', page: 1, limit: 10, from: undefined, to: undefined, search: undefined, prompts: {}},
  ])
})

test('articles reviews route forwards filtered request params to serving', async () => {
  queryReviewsParamsRef.current = []
  reviewHydrationCallCountRef.current = 0
  reviewHydrationRowsRef.current = async () => {
    return []
  }
  queryReviewsRef.current = async (_params?: unknown): Promise<unknown> => {
    return {data: [], totalCount: null, page: 3, limit: 25, totalPages: null}
  }

  const {projectsRoutesGetArticlesReviews} = await import('./projectsRoutesGetArticlesReviews.ts')
  const app = new Elysia().use(projectsRoutesGetArticlesReviews)
  const response = await app.handle(
    new Request('http://localhost/api/articlesreviews', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        projectId: 'project-1',
        page: '3',
        limit: '25',
        from: '2024-01-01',
        hasDuplicateStudyRecords: true,
        hasStudyDecisionConflict: true,
        llmStatus: 'partial',
        to: '2024-02-01',
        search: 'covid',
        prompts: {'prompt-1': ['yes', 'no']},
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(queryReviewsParamsRef.current).toEqual([
    {
      projectId: 'project-1',
      page: 3,
      limit: 25,
      from: '2024-01-01',
      hasDuplicateStudyRecords: true,
      hasStudyDecisionConflict: true,
      llmStatus: 'partial',
      to: '2024-02-01',
      search: 'covid',
      prompts: {'prompt-1': ['yes', 'no']},
    },
  ])
})

test('articles reviews route forwards llmStatus modes to serving unchanged', async () => {
  queryReviewsParamsRef.current = []
  reviewHydrationCallCountRef.current = 0
  reviewHydrationRowsRef.current = async () => {
    return []
  }
  queryReviewsRef.current = async (params?: unknown): Promise<unknown> => {
    return {data: [], totalCount: null, page: 1, limit: 10, totalPages: null, echoed: params}
  }

  const {projectsRoutesGetArticlesReviews} = await import('./projectsRoutesGetArticlesReviews.ts')
  const app = new Elysia().use(projectsRoutesGetArticlesReviews)

  await Promise.all(
    ['complete', 'both', 'partial'].map((llmStatus) => {
      return app.handle(
        new Request('http://localhost/api/articlesreviews', {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify({projectId: 'project-1', page: '1', limit: '10', prompts: {}, llmStatus}),
        }),
      )
    }),
  )

  expect(queryReviewsParamsRef.current).toEqual([
    {
      projectId: 'project-1',
      page: 1,
      limit: 10,
      from: undefined,
      to: undefined,
      search: undefined,
      prompts: {},
      llmStatus: 'complete',
    },
    {
      projectId: 'project-1',
      page: 1,
      limit: 10,
      from: undefined,
      to: undefined,
      search: undefined,
      prompts: {},
      llmStatus: 'both',
    },
    {
      projectId: 'project-1',
      page: 1,
      limit: 10,
      from: undefined,
      to: undefined,
      search: undefined,
      prompts: {},
      llmStatus: 'partial',
    },
  ])
})

test('articles reviews count route forwards llmStatus to serving when present', async () => {
  const receivedParams: unknown[] = []
  countReviewsRef.current = async (params?: unknown): Promise<unknown> => {
    receivedParams.push(params)
    return {totalCount: 7, totalPages: 1}
  }

  const {projectsRoutesGetArticlesReviewsCount} = await import('./projectsRoutesGetArticlesReviewsCount.ts')
  const app = new Elysia().use(projectsRoutesGetArticlesReviewsCount)
  const response = await app.handle(
    new Request('http://localhost/api/articlesreviewscount', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({projectId: 'project-1', limit: '10', prompts: {}, llmStatus: 'complete'}),
    }),
  )

  expect(response.status).toBe(200)
  expect(receivedParams).toEqual([
    {
      projectId: 'project-1',
      page: 1,
      limit: 10,
      from: undefined,
      to: undefined,
      search: undefined,
      prompts: {},
      hasDuplicateStudyRecords: undefined,
      hasStudyDecisionConflict: undefined,
      llmStatus: 'complete',
    },
  ])
})

test('articles reviews count route forwards llmStatus modes to serving unchanged', async () => {
  const receivedParams: unknown[] = []
  countReviewsRef.current = async (params?: unknown): Promise<unknown> => {
    receivedParams.push(params)
    return {totalCount: 7, totalPages: 1}
  }

  const {projectsRoutesGetArticlesReviewsCount} = await import('./projectsRoutesGetArticlesReviewsCount.ts')
  const app = new Elysia().use(projectsRoutesGetArticlesReviewsCount)

  await Promise.all(
    ['complete', 'both', 'partial'].map((llmStatus) => {
      return app.handle(
        new Request('http://localhost/api/articlesreviewscount', {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify({projectId: 'project-1', limit: '10', prompts: {}, llmStatus}),
        }),
      )
    }),
  )

  expect(receivedParams).toEqual([
    {
      projectId: 'project-1',
      page: 1,
      limit: 10,
      from: undefined,
      to: undefined,
      search: undefined,
      prompts: {},
      hasDuplicateStudyRecords: undefined,
      hasStudyDecisionConflict: undefined,
      llmStatus: 'complete',
    },
    {
      projectId: 'project-1',
      page: 1,
      limit: 10,
      from: undefined,
      to: undefined,
      search: undefined,
      prompts: {},
      hasDuplicateStudyRecords: undefined,
      hasStudyDecisionConflict: undefined,
      llmStatus: 'both',
    },
    {
      projectId: 'project-1',
      page: 1,
      limit: 10,
      from: undefined,
      to: undefined,
      search: undefined,
      prompts: {},
      hasDuplicateStudyRecords: undefined,
      hasStudyDecisionConflict: undefined,
      llmStatus: 'partial',
    },
  ])
})

test('articles reviews route skips hydration query when serving already returns hydrated article fields', async () => {
  reviewHydrationCallCountRef.current = 0
  queryReviewsRef.current = async (_params?: unknown): Promise<unknown> => {
    return {
      data: [
        {
          id: 'article-1',
          articleId: 'external-1',
          articleTitle: 'Article 1',
          articleCreatedAt: '2024-01-01T00:00:00.000Z',
          articleUpdatedAt: '2024-01-02T00:00:00.000Z',
          url: 'https://example.com/article-1',
          fullTextPDF: null,
          fullTextFetchedAt: null,
          fullTextConversionStatus: null,
          journalTitle: 'Journal 1',
          judgments: [],
          judgedPromptIds: [],
          isFullyJudged: true,
        },
      ],
      totalCount: null,
      page: 1,
      limit: 10,
      totalPages: null,
      nextCursor: 'cursor-1',
    }
  }

  const {projectsRoutesGetArticlesReviews} = await import('./projectsRoutesGetArticlesReviews.ts')
  const app = new Elysia().use(projectsRoutesGetArticlesReviews)
  const response = await app.handle(
    new Request('http://localhost/api/articlesreviews', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({projectId: 'project-1', page: '1', limit: '10', prompts: {}}),
    }),
  )
  const rawBody: unknown = await response.json()
  const body = rawBody as {data: Array<{articleId: string}>}

  expect(response.status).toBe(200)
  expect(reviewHydrationCallCountRef.current).toBe(0)
  expect(body.data[0]?.articleId).toBe('external-1')
})

test('articles reviews route falls back to serving article fields when sqlite row is missing', async () => {
  reviewHydrationRowsRef.current = async () => {
    return []
  }
  queryReviewsRef.current = async (_params?: unknown): Promise<unknown> => {
    return {
      data: [
        {
          id: 'article-1',
          articleTitle: 'OLAP title',
          articleCreatedAt: new Date('2024-01-01T00:00:00.000Z'),
          articleUpdatedAt: new Date('2024-01-02T00:00:00.000Z'),
          judgments: [],
          judgedPromptIds: ['prompt-1'],
          isFullyJudged: true,
          journalTitle: 'Journal 1',
        },
      ],
      totalCount: null,
      page: 2,
      limit: 50,
      totalPages: null,
    }
  }

  const {projectsRoutesGetArticlesReviews} = await import('./projectsRoutesGetArticlesReviews.ts')
  const app = new Elysia().use(projectsRoutesGetArticlesReviews)
  const response = await app.handle(
    new Request('http://localhost/api/articlesreviews', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({projectId: 'project-1', page: '2', limit: '50', prompts: {}}),
    }),
  )
  const data = (await response.json()) as {page: number; data: Array<Record<string, unknown>>}

  expect(response.status).toBe(200)
  expect(data.page).toBe(2)
  expect(data.data[0]).toEqual({
    id: 'article-1',
    articleTitle: 'OLAP title',
    articleCreatedAt: '2024-01-01T00:00:00.000Z',
    articleUpdatedAt: '2024-01-02T00:00:00.000Z',
    judgments: [],
    judgedPromptIds: ['prompt-1'],
    isFullyJudged: true,
    journalTitle: 'Journal 1',
  })
})

test('articles reviews both route preserves page echo and missing-article fallback', async () => {
  reviewHydrationRowsRef.current = async () => {
    return []
  }
  queryBothRef.current = async (_params?: unknown): Promise<unknown> => {
    return {
      data: [
        {
          id: 'article-1',
          articleTitle: 'Both OLAP title',
          articleCreatedAt: new Date('2024-02-01T00:00:00.000Z'),
          articleUpdatedAt: null,
          judgments: [
            {
              id: 'judgment-1',
              createdAt: '2024-02-03T00:00:00.000Z',
              articleId: 'article-1',
              promptId: 'prompt-1',
              modelId: 'model-1',
              answeredOriginal: 'yes',
              answeredOriginalAsArray: [],
              explanation: null,
              quotes: ['quote'],
            },
          ],
          humanAnswersByPrompt: {['prompt-1']: ['no']},
          journalTitle: 'Journal 2',
        },
      ],
      totalCount: 1,
      page: 5,
      limit: 10,
      totalPages: 1,
    }
  }

  const {projectsRoutesGetArticlesReviewsBoth} = await import('./projectsRoutesGetArticlesReviewsBoth.ts')
  const app = new Elysia().use(projectsRoutesGetArticlesReviewsBoth)
  const response = await app.handle(
    new Request('http://localhost/api/articlesreviewsboth', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({projectId: 'project-1', page: '5', limit: '10', prompts: {}}),
    }),
  )
  const data = (await response.json()) as {page: number; data: Array<Record<string, unknown>>}

  expect(response.status).toBe(200)
  expect(data.page).toBe(5)
  expect(data.data[0]).toEqual({
    id: 'article-1',
    articleTitle: 'Both OLAP title',
    articleCreatedAt: '2024-02-01T00:00:00.000Z',
    articleUpdatedAt: null,
    journalTitle: 'Journal 2',
    judgments: [
      {
        id: 'judgment-1',
        createdAt: '2024-02-03T00:00:00.000Z',
        articleId: 'article-1',
        promptId: 'prompt-1',
        modelId: 'model-1',
        answeredOriginal: 'yes',
        answeredOriginalAsArray: [],
        explanation: null,
        quotes: ['quote'],
      },
    ],
    humanAnswersByPrompt: {['prompt-1']: ['no']},
  })
})

test('articles reviews both route preserves summary-mode overall answers', async () => {
  reviewHydrationRowsRef.current = async () => {
    return []
  }
  queryBothRef.current = async (): Promise<unknown> => {
    return {
      data: [
        {
          id: 'article-1',
          articleTitle: 'Summary OLAP title',
          articleCreatedAt: new Date('2024-02-01T00:00:00.000Z'),
          articleUpdatedAt: null,
          judgments: [],
          humanJudgmentMode: 'summary',
          humanSummaryAnswer: 'no',
          llmSummaryAnswer: 'yes',
          journalTitle: 'Journal 3',
        },
      ],
      totalCount: 1,
      page: 1,
      limit: 10,
      totalPages: 1,
    }
  }

  const {projectsRoutesGetArticlesReviewsBoth} = await import('./projectsRoutesGetArticlesReviewsBoth.ts')
  const app = new Elysia().use(projectsRoutesGetArticlesReviewsBoth)
  const response = await app.handle(
    new Request('http://localhost/api/articlesreviewsboth', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({projectId: 'project-1', page: '1', limit: '10', prompts: {}}),
    }),
  )
  const data = (await response.json()) as {data: Array<Record<string, unknown>>}

  expect(response.status).toBe(200)
  expect(data.data[0]).toEqual({
    id: 'article-1',
    articleTitle: 'Summary OLAP title',
    articleCreatedAt: '2024-02-01T00:00:00.000Z',
    articleUpdatedAt: null,
    journalTitle: 'Journal 3',
    judgments: [],
    humanJudgmentMode: 'summary',
    humanSummaryAnswer: 'no',
    llmSummaryAnswer: 'yes',
  })
})

test('articles reviews unassessed route preserves serving ordering after sqlite hydration', async () => {
  projectReviewConfigRef.current = async () => {
    return {
      dateFrom: null,
      dateTo: null,
      importRouteIds: ['route-1'],
      modelId: 'model-1',
      useTitle: true,
      useAbstract: true,
      useFulltext: false,
      useFulltextNoImages: false,
    }
  }
  fullArticleRowsRef.current = async () => {
    return [
      {id: 'article-a', articleTitle: 'A', articleCreatedAt: new Date('2024-01-02T00:00:00.000Z')},
      {id: 'article-b', articleTitle: 'B', articleCreatedAt: new Date('2024-01-01T00:00:00.000Z')},
    ]
  }
  queryUnassessedRef.current = async (_params?: unknown): Promise<unknown> => {
    return {articles: [{id: 'article-b'}, {id: 'article-a'}], totalCount: 2}
  }

  const {projectsRoutesGetArticlesReviewsUnassessed} = await import('./projectsRoutesGetArticlesReviewsUnassessed.ts')
  const app = new Elysia().use(projectsRoutesGetArticlesReviewsUnassessed)
  const response = await app.handle(
    new Request('http://localhost/api/articlesreviewsunassessed', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({projectId: 'project-1', page: '1', limit: '10'}),
    }),
  )
  const data = (await response.json()) as {data: Array<{id: string}>}

  expect(response.status).toBe(200)
  expect(
    data.data.map((row: {id: string}) => {
      return row.id
    }),
  ).toEqual(['article-b', 'article-a'])
})

test('articles reviews count route returns legacy error payload on serving failure', async () => {
  countReviewsRef.current = async (_params?: unknown): Promise<unknown> => {
    throw new Error('count failed')
  }

  const {projectsRoutesGetArticlesReviewsCount} = await import('./projectsRoutesGetArticlesReviewsCount.ts')
  const app = new Elysia().use(projectsRoutesGetArticlesReviewsCount)
  const response = await app.handle(
    new Request('http://localhost/api/articlesreviewscount', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({projectId: 'project-1', limit: '10', prompts: {}}),
    }),
  )
  const data = (await response.json()) as {totalCount: number; totalPages: number; error: string}

  expect(response.status).toBe(200)
  expect(data).toEqual({totalCount: 0, totalPages: 0, error: 'count failed'})
})
