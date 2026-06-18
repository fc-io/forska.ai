import {afterEach, expect, mock, test} from 'bun:test'
import {Elysia} from 'elysia'

const appDatabaseServiceModulePath = new URL('../services/appDatabaseService.ts', import.meta.url).pathname
const appQueryServiceModulePath = new URL('../services/getAppQueryService.ts', import.meta.url).pathname
const projectAccessGuardModulePath = new URL('./projectsRoutes/projectAccessGuard.ts', import.meta.url).pathname
const reviewBulkOperationServiceModulePath = new URL('../reviewServing/reviewBulkOperationService.ts', import.meta.url)
  .pathname

type ExportJobRequest = {criteria: Record<string, unknown>} & Record<string, unknown>

const queryStatements: string[] = []
const queryJsonRef = {
  current: async (_statement: string): Promise<unknown[]> => {
    return []
  },
}
const createReviewBulkOperationJobCalls: unknown[] = []

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

  void mock.module(reviewBulkOperationServiceModulePath, () => {
    return {
      createReviewBulkOperationJob: async (request: unknown) => {
        createReviewBulkOperationJobCalls.push(request)

        return {
          filterSignature: 'filter-signature-1',
          jobId: 'export-job-1',
          jobKind: 'review.export.selection',
          latestSnapshotSemantics: true,
          projectId: 'project-1',
          snapshotId: null,
          snapshotPinId: null,
          status: 'pending',
        }
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
  createReviewBulkOperationJobCalls.length = 0
  mock.restore()
})

test('project export creates a durable serving export job with explicit IDs and metadata contract', async () => {
  queryJsonRef.current = async (statement) => {
    return statement.includes('FROM app.project') ? [{id: 'project-1', name: 'Project 1'}] : []
  }
  const {projectExportRoutes} = await loadRoutes()
  const app = new Elysia().use(projectExportRoutes)
  const response = await app.handle(
    new Request('http://localhost/api/projects/project-1/export', {
      body: JSON.stringify({
        articleIds: ['article-1', 'article-2'],
        includeArticleAuthors: true,
        includeArticleId: true,
        listType: 'human',
        promptIds: ['prompt-1'],
        snapshotId: 'snapshot-1',
        snapshotPinExpiresAt: '2026-06-20T00:00:00.000Z',
        sourceProjectIds: ['project-1'],
      }),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const json = (await response.json()) as unknown
  const jobRequest = createReviewBulkOperationJobCalls[0] as ExportJobRequest

  expect(response.status).toBe(202)
  expect(json).toMatchObject({success: true, job: {jobId: 'export-job-1', jobKind: 'review.export.selection'}})
  expect(jobRequest).toMatchObject({
    batchSize: 500,
    criteria: {
      articleIds: ['article-1', 'article-2'],
      listType: 'human',
      operation: 'export',
      sourceProjectId: 'project-1',
      sourceProjectIds: ['project-1'],
    },
    filters: {listType: 'human'},
    jobKind: 'review.export.selection',
    projectId: 'project-1',
    snapshot: {expiresAt: '2026-06-20T00:00:00.000Z', snapshotId: 'snapshot-1', type: 'pinned'},
  })
  expect(jobRequest.criteria).toMatchObject({
    exportContract: {
      payloadBudgetBytes: 10_000_000,
      projectionIdentity: 'review.export.selection',
      selectedMetadata: {includeArticleAuthors: true, includeArticleId: true},
      snapshotCursor: {mode: 'keyset', orderBy: ['article_id']},
    },
  })
  expect(queryStatements.join('\n')).not.toContain('FROM app.judgment')
  expect(queryStatements.join('\n')).not.toContain('OFFSET')
})

test('project export preserves prompt-output filter semantics in durable criteria', async () => {
  queryJsonRef.current = async (statement) => {
    return statement.includes('FROM app.project') ? [{id: 'project-1', name: 'Project 1'}] : []
  }
  const {projectExportRoutes} = await loadRoutes()
  const app = new Elysia().use(projectExportRoutes)
  const response = await app.handle(
    new Request('http://localhost/api/projects/project-1/export', {
      body: JSON.stringify({
        includeExplanation: true,
        includePromptContent: true,
        includePromptType: true,
        includeQuotes: true,
        promptIds: ['prompt-1', 'prompt-2'],
        promptSelections: [{promptId: 'prompt-1', types: ['yes', 'maybe']}],
        search: 'screening',
        sourceProjectIds: ['project-1'],
      }),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const jobRequest = createReviewBulkOperationJobCalls[0] as ExportJobRequest

  expect(response.status).toBe(202)
  expect(jobRequest).toMatchObject({
    criteria: {prompts: {'prompt-1': ['yes', 'maybe']}, search: 'screening'},
    filters: {prompts: {'prompt-1': ['yes', 'maybe']}, search: 'screening'},
    searchMode: 'substring',
    searchText: 'screening',
  })
  expect(jobRequest.criteria).toMatchObject({
    exportContract: {
      promptOutput: {
        includeExplanation: true,
        includePromptContent: true,
        includePromptType: true,
        includeQuotes: true,
        promptIds: ['prompt-1', 'prompt-2'],
        promptSelections: [{promptId: 'prompt-1', types: ['yes', 'maybe']}],
      },
    },
  })
})
