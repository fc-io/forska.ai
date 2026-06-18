import {afterEach, expect, mock, test} from 'bun:test'
import {Elysia} from 'elysia'

const projectAccessGuardModulePath = new URL('./projectAccessGuard.ts', import.meta.url).pathname
const reviewServingRouteServiceModulePath = new URL(
  '../../reviewServing/reviewServingHumanBothUnassessedRouteService.ts',
  import.meta.url,
).pathname

const humanReviewArticlesFromServingRef = {
  current: async (_params: unknown): Promise<unknown> => {
    return {data: [], humanJudgmentMode: 'prompt', limit: 10, page: 1, totalCount: 0, totalPages: 0}
  },
}

const registerModuleMocks = () => {
  void mock.module(projectAccessGuardModulePath, () => {
    return {
      assertProjectIsActive: async () => {
        return {archived: false, id: 'project-1', name: 'Project 1'}
      },
    }
  })

  void mock.module(reviewServingRouteServiceModulePath, () => {
    return {
      getHumanReviewArticlesFromServing: (params: unknown) => {
        return humanReviewArticlesFromServingRef.current(params)
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

test('articles reviews human returns serving summary-mode overall judgments', async () => {
  humanReviewArticlesFromServingRef.current = async () => {
    return {
      data: [
        {
          id: 'article-1',
          articleTitle: 'Article 1',
          humanJudgmentMode: 'summary',
          humanSummaryAnswer: 'no',
          judgments: [
            {
              answer: 'no',
              articleId: 'article-1',
              createdAt: '2024-01-01T00:00:00.000Z',
              id: 'summary-1',
              projectId: 'project-1',
              promptId: 'summary',
              updatedAt: '2024-01-02T00:00:00.000Z',
            },
          ],
        },
      ],
      humanJudgmentMode: 'summary',
      limit: 10,
      page: 1,
      totalCount: 1,
      totalPages: 1,
    }
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
