import {afterEach, expect, mock, test} from 'bun:test'
import {Elysia} from 'elysia'

const projectAccessGuardModulePath = new URL('./projectAccessGuard.ts', import.meta.url).pathname
const rateLimitedLoggerModulePath = new URL('../../utils/rateLimitedLogger.ts', import.meta.url).pathname
const reviewServingRouteServiceModulePath = new URL(
  '../../reviewServing/reviewServingLlmReviewRouteService.ts',
  import.meta.url,
).pathname

const countRef = {
  current: async (_input: unknown): Promise<unknown> => {
    return {totalCount: 1, totalPages: 1}
  },
}

const logCalls: Array<{key: string; level?: string; message: string}> = []

const registerModuleMocks = () => {
  logCalls.length = 0

  void mock.module(projectAccessGuardModulePath, () => {
    return {
      assertProjectIsActive: async () => {
        return {archived: false, id: 'project-1', name: 'Project 1'}
      },
    }
  })

  void mock.module(rateLimitedLoggerModulePath, () => {
    return {
      createRateLimitedLogger: () => {
        return {
          force: (key: string, message: string, level?: string) => {
            logCalls.push({key, level, message})
          },
          log: () => {},
          warn: () => {},
          error: () => {},
          reset: () => {},
          resetAll: () => {},
        }
      },
    }
  })

  void mock.module(reviewServingRouteServiceModulePath, () => {
    return {
      countLlmReviewArticlesFromServing: (input: unknown) => {
        return countRef.current(input)
      },
    }
  })
}

const loadRoute = async (): Promise<typeof import('./projectsRoutesGetArticlesReviewsCount.ts')> => {
  registerModuleMocks()
  return (await import(
    `./projectsRoutesGetArticlesReviewsCount.ts?test=${Date.now()}-${Math.random()}`
  )) as typeof import('./projectsRoutesGetArticlesReviewsCount.ts')
}

const postCount = async () => {
  const {projectsRoutesGetArticlesReviewsCount} = await loadRoute()
  const app = new Elysia().use(projectsRoutesGetArticlesReviewsCount)

  return app.handle(
    new Request('http://localhost/api/articlesreviewscount', {
      body: JSON.stringify({limit: '100', projectId: 'project-1', prompts: {}}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
}

afterEach(() => {
  countRef.current = async () => {
    return {totalCount: 1, totalPages: 1}
  }
  mock.restore()
})

test('articles reviews count logs missing review serving snapshot as warning', async () => {
  countRef.current = async () => {
    throw new Error('Review serving snapshot is unavailable')
  }

  const response = await postCount()
  const body = (await response.json()) as Record<string, unknown>
  const warningLog = logCalls.find((call) => {
    return call.key === 'projects.articles-reviews-count.snapshot-unavailable'
  })

  expect(response.status).toBe(200)
  expect(body).toMatchObject({error: 'Review serving snapshot is unavailable', totalCount: 0, totalPages: 0})
  expect(warningLog).toEqual({
    key: 'projects.articles-reviews-count.snapshot-unavailable',
    level: 'warn',
    message: 'Articles reviews count request waiting for review serving snapshot',
  })
  expect(
    logCalls.some((call) => {
      return call.key === 'projects.articles-reviews-count.error' && call.level === 'error'
    }),
  ).toBe(false)
})

test('articles reviews count keeps unexpected failures at error level', async () => {
  countRef.current = async () => {
    throw new Error('DuckDB failed')
  }

  const response = await postCount()
  const body = (await response.json()) as Record<string, unknown>
  const errorLog = logCalls.find((call) => {
    return call.key === 'projects.articles-reviews-count.error'
  })

  expect(response.status).toBe(200)
  expect(body).toMatchObject({error: 'DuckDB failed', totalCount: 0, totalPages: 0})
  expect(errorLog).toEqual({
    key: 'projects.articles-reviews-count.error',
    level: 'error',
    message: 'Articles reviews count request failed',
  })
})
