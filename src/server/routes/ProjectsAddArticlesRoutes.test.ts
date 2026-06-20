import {afterEach, expect, mock, test} from 'bun:test'
import {Elysia} from 'elysia'

const reviewBulkOperationServiceModulePath = new URL('../reviewServing/reviewBulkOperationService.ts', import.meta.url)
  .pathname
const reviewServingProjectConfigIdentityModulePath = new URL(
  '../services/reviewServingProjectConfigIdentity.ts',
  import.meta.url,
).pathname
const appDatabaseServiceModulePath = new URL('../services/appDatabaseService.ts', import.meta.url).pathname
const insertArticlesIntoProjectModulePath = new URL('../services/insertArticlesIntoProject.ts', import.meta.url)
  .pathname

afterEach(() => {
  mock.restore()
})

test('add articles by ids creates a durable article-id-only job', async () => {
  const jobRequests: unknown[] = []
  let insertCalled = false

  void mock.module(reviewBulkOperationServiceModulePath, () => {
    return {
      assertArticleIdOnlyBulkOperationCaps: () => {
        return undefined
      },
      createReviewBulkOperationJob: async (request: unknown) => {
        jobRequests.push(request)
        return {jobId: 'job-1', jobKind: 'review.bulk.selection', latestSnapshotSemantics: true, status: 'pending'}
      },
    }
  })
  void mock.module(reviewServingProjectConfigIdentityModulePath, () => {
    return {
      getCurrentReviewConfigHash: async () => {
        return 'config-1'
      },
    }
  })
  void mock.module(insertArticlesIntoProjectModulePath, () => {
    return {
      insertArticlesIntoProject: async () => {
        insertCalled = true
        return {acceptedCount: 0}
      },
    }
  })
  void mock.module(appDatabaseServiceModulePath, () => {
    return {
      getAppDatabaseService: () => {
        return {
          queryJson: async () => {
            return [
              {
                criteriaJson: {targetProjectId: 'target-1'},
                jobId: 'job-1',
                jobKind: 'review.bulk.selection',
                lastError: null,
                processedCount: 0,
                status: 'pending',
                totalEstimate: null,
              },
            ]
          },
        }
      },
    }
  })

  const routesModule = (await import(
    `./ProjectsAddArticlesRoutes.ts?test=add-by-ids-${Date.now()}-${Math.random()}`
  )) as typeof import('./ProjectsAddArticlesRoutes.ts')
  const app = new Elysia().use(routesModule.projectsAddArticlesRoutes)
  const response = await app.handle(
    new Request('http://localhost/api/projects/add_articles_by_ids', {
      body: JSON.stringify({
        articleIds: ['article-2', 'article-1'],
        sourceProjectId: 'source-1',
        targetProjectId: 'target-1',
      }),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const body = (await response.json()) as {
    job: {jobId: string}
    providedTotal: number
    status: string
    success: boolean
  }
  const jobRequest = jobRequests[0] as {
    criteria: {articleIds: string[]; operation: string; requestId?: string; targetProjectId: string}
    jobKind: string
    projectId: string
    searchMode: string
    snapshot: {type: string}
  }

  expect(response.status).toBe(202)
  expect(body).toMatchObject({job: {jobId: 'job-1'}, providedTotal: 2, status: 'pending', success: true})
  expect(jobRequest).toMatchObject({
    criteria: {articleIds: ['article-2', 'article-1'], operation: 'addToProject', targetProjectId: 'target-1'},
    jobKind: 'review.bulk.selection',
    projectId: 'source-1',
    searchMode: 'none',
    snapshot: {type: 'latest'},
  })
  expect(typeof jobRequest.criteria.requestId).toBe('string')
  expect(insertCalled).toBe(false)

  const jobResponse = await app.handle(
    new Request('http://localhost/api/projects/add_articles_jobs?jobId=job-1&sourceProjectId=source-1'),
  )
  const jobBody = (await jobResponse.json()) as {
    job: {jobId: string; jobKind: string; processedCount: number; status: string; totalEstimate: number | null}
    success: boolean
    targetProjectId: string | null
  }

  expect(jobResponse.status).toBe(200)
  expect(jobBody).toMatchObject({
    job: {jobId: 'job-1', jobKind: 'review.bulk.selection', processedCount: 0, status: 'pending', totalEstimate: null},
    success: true,
    targetProjectId: 'target-1',
  })
})
