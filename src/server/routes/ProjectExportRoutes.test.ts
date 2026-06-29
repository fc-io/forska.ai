import {afterEach, expect, mock, test} from 'bun:test'
import {Elysia} from 'elysia'

const appDatabaseServiceModulePath = new URL('../services/appDatabaseService.ts', import.meta.url).pathname
const appQueryServiceModulePath = new URL('../services/getAppQueryService.ts', import.meta.url).pathname
const projectAccessGuardModulePath = new URL('./projectsRoutes/projectAccessGuard.ts', import.meta.url).pathname
const reviewBulkOperationServiceModulePath = new URL('../reviewServing/reviewBulkOperationService.ts', import.meta.url)
  .pathname
const reviewServingManifestRepositoryModulePath = new URL(
  '../reviewServing/reviewServingManifestRepository.ts',
  import.meta.url,
).pathname
const reviewServingProjectConfigIdentityModulePath = new URL(
  '../services/reviewServingProjectConfigIdentity.ts',
  import.meta.url,
).pathname

type ExportJobRequest = {criteria: Record<string, unknown>} & Record<string, unknown>

const queryStatements: string[] = []
const queryJsonRef = {
  current: async (_statement: string): Promise<unknown[]> => {
    return []
  },
}
const reviewConfigHashes = new Map<string, string | null>()
const activeSnapshotProjectIds = new Set<string>(['project-1', 'project-2'])
const pinnedSnapshotProjectIds = new Set<string>(['project-1', 'project-2'])
const pinnedSnapshotStatuses = new Map<string, string>()
const createReviewBulkOperationJobCalls: unknown[] = []

const projectReviewConfigRow = {
  modelId: null,
  useAbstract: true,
  useFulltext: false,
  useFulltextNoImages: false,
  useTitle: true,
}

const getProjectQueryRows = (statement: string) => {
  if (statement.includes('model_id AS modelId')) {
    return [projectReviewConfigRow]
  }

  return statement.includes('FROM app.project') ? [{id: 'project-1', name: 'Project 1'}] : []
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

  void mock.module(reviewServingManifestRepositoryModulePath, () => {
    return {
      getActiveReviewServingSnapshotManifest: async ({projectId}: {projectId: string}) => {
        return activeSnapshotProjectIds.has(projectId)
          ? {projectId, snapshotId: `active-${projectId}`, status: 'active'}
          : null
      },
      getReviewServingSnapshotManifest: async ({projectId, snapshotId}: {projectId: string; snapshotId: string}) => {
        return pinnedSnapshotProjectIds.has(projectId)
          ? {projectId, snapshotId, status: pinnedSnapshotStatuses.get(projectId) ?? 'active'}
          : null
      },
    }
  })

  void mock.module(reviewServingProjectConfigIdentityModulePath, () => {
    return {
      getCurrentReviewConfigHash: async (projectId: string) => {
        return reviewConfigHashes.get(projectId) ?? 'config-1'
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
  reviewConfigHashes.clear()
  activeSnapshotProjectIds.clear()
  activeSnapshotProjectIds.add('project-1')
  activeSnapshotProjectIds.add('project-2')
  pinnedSnapshotProjectIds.clear()
  pinnedSnapshotProjectIds.add('project-1')
  pinnedSnapshotProjectIds.add('project-2')
  pinnedSnapshotStatuses.clear()
  mock.restore()
})

test('project export creates a durable serving export job with explicit IDs and metadata contract', async () => {
  queryJsonRef.current = async (statement) => {
    return getProjectQueryRows(statement)
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
    reviewConfig: {modelId: null, useAbstract: true, useFulltext: false, useFulltextNoImages: false, useTitle: true},
  })
  expect(queryStatements.join('\n')).not.toContain('FROM app.judgment')
  expect(queryStatements.join('\n')).not.toContain('OFFSET')
})

test('project export preserves prompt-output filter semantics in durable criteria', async () => {
  queryJsonRef.current = async (statement) => {
    return getProjectQueryRows(statement)
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
    searchMode: 'tokenPrefix',
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

test('project export treats selecting every enum answer as no prompt filter', async () => {
  queryJsonRef.current = async (statement) => {
    if (statement.includes('model_id AS modelId') || statement.includes('FROM app.project')) {
      return getProjectQueryRows(statement)
    }

    if (statement.includes('FROM app.prompt')) {
      return [{id: 'prompt-1', originalText: 'Prompt text', promptHeading: 'Prompt 1', type: "'yes' | 'maybe'"}]
    }

    return []
  }
  const {projectExportRoutes} = await loadRoutes()
  const app = new Elysia().use(projectExportRoutes)
  const response = await app.handle(
    new Request('http://localhost/api/projects/project-1/export', {
      body: JSON.stringify({
        promptIds: ['prompt-1'],
        promptSelections: [{promptId: 'prompt-1', types: ['yes', 'maybe']}],
        sourceProjectIds: ['project-1'],
      }),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const jobRequest = createReviewBulkOperationJobCalls[0] as ExportJobRequest

  expect(response.status).toBe(202)
  expect(jobRequest).toMatchObject({criteria: {prompts: {}}, filters: {prompts: {}}})
})

test('project export rejects mixed source review configs before queueing a durable job', async () => {
  reviewConfigHashes.set('project-1', 'config-1')
  reviewConfigHashes.set('project-2', 'config-2')
  queryJsonRef.current = async (statement) => {
    return getProjectQueryRows(statement)
  }
  const {projectExportRoutes} = await loadRoutes()
  const app = new Elysia().use(projectExportRoutes)
  const response = await app.handle(
    new Request('http://localhost/api/projects/project-1/export', {
      body: JSON.stringify({promptIds: ['prompt-1'], sourceProjectIds: ['project-1', 'project-2']}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const json = (await response.json()) as unknown

  expect(response.status).toBe(400)
  expect(json).toMatchObject({error: 'Export sources must use the same review configuration', success: false})
  expect(createReviewBulkOperationJobCalls).toHaveLength(0)
})

test('project export allows metadata-only cross-project jobs with mixed review configs', async () => {
  reviewConfigHashes.set('project-1', 'config-1')
  reviewConfigHashes.set('project-2', 'config-2')
  queryJsonRef.current = async (statement) => {
    return getProjectQueryRows(statement)
  }
  const {projectExportRoutes} = await loadRoutes()
  const app = new Elysia().use(projectExportRoutes)
  const response = await app.handle(
    new Request('http://localhost/api/projects/project-1/export', {
      body: JSON.stringify({includeArticleId: true, promptIds: [], sourceProjectIds: ['project-1', 'project-2']}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const jobRequest = createReviewBulkOperationJobCalls[0] as ExportJobRequest

  expect(response.status).toBe(202)
  expect(jobRequest).toMatchObject({
    criteria: {
      sourceProjectIds: ['project-1', 'project-2'],
      sourceProjectReviewConfigHashes: {'project-1': 'config-1', 'project-2': 'config-2'},
    },
    reviewConfigHash: 'config-1',
  })
})

test('project export stores cross-project jobs under the downloadable project', async () => {
  queryJsonRef.current = async (statement) => {
    return getProjectQueryRows(statement)
  }
  const {projectExportRoutes} = await loadRoutes()
  const app = new Elysia().use(projectExportRoutes)
  const response = await app.handle(
    new Request('http://localhost/api/projects/project-1/export', {
      body: JSON.stringify({promptIds: ['prompt-1'], sourceProjectIds: ['project-2', 'project-1']}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const jobRequest = createReviewBulkOperationJobCalls[0] as ExportJobRequest
  const json = (await response.json()) as {downloadUrl?: string}

  expect(response.status).toBe(202)
  expect(jobRequest).toMatchObject({
    criteria: {sourceProjectId: 'project-2', sourceProjectIds: ['project-2', 'project-1']},
    projectId: 'project-1',
  })
  expect(json.downloadUrl).toBe('/api/projects/project-1/export/export-job-1/download')
})

test('project export rejects cross-project jobs when a source latest snapshot is not ready', async () => {
  activeSnapshotProjectIds.delete('project-2')
  queryJsonRef.current = async (statement) => {
    return getProjectQueryRows(statement)
  }
  const {projectExportRoutes} = await loadRoutes()
  const app = new Elysia().use(projectExportRoutes)
  const response = await app.handle(
    new Request('http://localhost/api/projects/project-1/export', {
      body: JSON.stringify({promptIds: ['prompt-1'], sourceProjectIds: ['project-1', 'project-2']}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const json = (await response.json()) as unknown

  expect(response.status).toBe(400)
  expect(json).toMatchObject({
    error: 'Export sources are missing a ready review serving snapshot: project-2',
    success: false,
  })
  expect(createReviewBulkOperationJobCalls).toHaveLength(0)
})

test('project export skips source snapshot preflight for explicit article IDs', async () => {
  activeSnapshotProjectIds.delete('project-2')
  queryJsonRef.current = async (statement) => {
    return getProjectQueryRows(statement)
  }
  const {projectExportRoutes} = await loadRoutes()
  const app = new Elysia().use(projectExportRoutes)
  const response = await app.handle(
    new Request('http://localhost/api/projects/project-1/export', {
      body: JSON.stringify({
        articleIds: ['article-1'],
        promptIds: ['prompt-1'],
        sourceProjectIds: ['project-1', 'project-2'],
      }),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const jobRequest = createReviewBulkOperationJobCalls[0] as ExportJobRequest

  expect(response.status).toBe(202)
  expect(jobRequest.criteria).toMatchObject({articleIds: ['article-1'], sourceProjectIds: ['project-1', 'project-2']})
})

test('project export rejects cross-project jobs when a source pinned snapshot is not ready', async () => {
  pinnedSnapshotProjectIds.delete('project-2')
  queryJsonRef.current = async (statement) => {
    return getProjectQueryRows(statement)
  }
  const {projectExportRoutes} = await loadRoutes()
  const app = new Elysia().use(projectExportRoutes)
  const response = await app.handle(
    new Request('http://localhost/api/projects/project-1/export', {
      body: JSON.stringify({
        promptIds: ['prompt-1'],
        snapshotId: 'snapshot-1',
        sourceProjectIds: ['project-1', 'project-2'],
      }),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const json = (await response.json()) as unknown

  expect(response.status).toBe(400)
  expect(json).toMatchObject({
    error: 'Export sources are missing a ready review serving snapshot: project-2',
    success: false,
  })
  expect(createReviewBulkOperationJobCalls).toHaveLength(0)
})

test('project export allows retired explicit pinned snapshots', async () => {
  pinnedSnapshotStatuses.set('project-2', 'retired')
  queryJsonRef.current = async (statement) => {
    return getProjectQueryRows(statement)
  }
  const {projectExportRoutes} = await loadRoutes()
  const app = new Elysia().use(projectExportRoutes)
  const response = await app.handle(
    new Request('http://localhost/api/projects/project-1/export', {
      body: JSON.stringify({
        promptIds: ['prompt-1'],
        snapshotId: 'snapshot-1',
        sourceProjectIds: ['project-1', 'project-2'],
      }),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )

  expect(response.status).toBe(202)
  expect(createReviewBulkOperationJobCalls).toHaveLength(1)
  expect(createReviewBulkOperationJobCalls[0]).toMatchObject({snapshot: {snapshotId: 'snapshot-1', type: 'pinned'}})
})

test('project export still rejects retired latest snapshots', async () => {
  activeSnapshotProjectIds.delete('project-2')
  queryJsonRef.current = async (statement) => {
    return getProjectQueryRows(statement)
  }
  const {projectExportRoutes} = await loadRoutes()
  const app = new Elysia().use(projectExportRoutes)
  const response = await app.handle(
    new Request('http://localhost/api/projects/project-1/export', {
      body: JSON.stringify({promptIds: ['prompt-1'], sourceProjectIds: ['project-1', 'project-2']}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )

  expect(response.status).toBe(400)
  expect(createReviewBulkOperationJobCalls).toHaveLength(0)
})

test('project export download hydrates completed durable job selection as CSV', async () => {
  queryJsonRef.current = async (statement) => {
    if (statement.includes('FROM app.project') && statement.includes('LIMIT 1') && statement.includes('id, name')) {
      return [{id: 'project-1', name: 'Project 1'}]
    }

    if (statement.includes('FROM app.review_bulk_operation_job')) {
      return [
        {
          criteriaJson: {
            sourceProjectIds: ['project-1'],
            exportContract: {
              promptOutput: {
                includeExplanation: true,
                includePromptContent: true,
                includePromptType: true,
                includeQuotes: true,
                promptIds: ['prompt-1'],
              },
              selectedMetadata: {
                includeArticleAuthors: true,
                includeArticleId: true,
                includeArticleLink: true,
                includeJournal: true,
                includeSummary: true,
              },
            },
            reviewConfig: {
              modelId: 'queued-model',
              useAbstract: false,
              useFulltext: true,
              useFulltextNoImages: true,
              useTitle: false,
            },
          },
          latestSnapshotSemantics: true,
          resultManifestJson: {batches: {'article-1': ['article-1']}},
          reviewConfigHash: 'config-1',
          snapshotId: null,
          status: 'completed',
        },
      ]
    }

    if (statement.includes('model_id AS modelId')) {
      return [{modelId: 'model-1', useAbstract: true, useFulltext: false, useFulltextNoImages: false, useTitle: true}]
    }

    if (statement.includes('mart.review_article_serving_v4')) {
      return [
        {
          articleCreatedAt: '2026-01-01T00:00:00.000Z',
          articleExternalId: 'article-1',
          articleId: 'article-1',
          articleOriginalData: null,
          articleAuthors: ['Alice Example', 'Bob Example'],
          articleSourceMetadata: null,
          articleSummary: 'Summary 1',
          articleTitle: 'Article 1',
          articleUpdatedAt: '2026-01-02T00:00:00.000Z',
          articleUrl: null,
          arxivId: null,
          biorxivId: null,
          doi: null,
          medrxivId: null,
          pubmedId: null,
        },
      ]
    }

    if (statement.includes('mart.review_article_judgment_detail_serving_v4')) {
      if (statement.includes("'$.prompt.promptHeading'")) {
        return [
          {
            id: 'prompt-1',
            originalText: 'V4 prompt content',
            promptHeading: 'V4 Prompt Heading',
            sourceProjectOrder: 0,
            type: 'V4 prompt type',
          },
        ]
      }

      return [
        {
          answeredOriginal: 'yes',
          answeredOriginalAsArray: null,
          articleId: 'article-1',
          explanation: 'Because',
          promptId: 'prompt-1',
          quotes: ['Quote 1'],
        },
      ]
    }

    return []
  }
  const {projectExportRoutes} = await loadRoutes()
  const app = new Elysia().use(projectExportRoutes)
  const response = await app.handle(new Request('http://localhost/api/projects/project-1/export/export-job-1/download'))
  const text = await response.text()

  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toContain('text/csv')
  expect(text).toContain(
    'Title,Article ID,Article Link,Article Authors,Abstract/Summary,Journal,"V4 Prompt Heading\nType: V4 prompt type\nContent: V4 prompt content",V4 Prompt Heading - Explanation,V4 Prompt Heading - Quotes',
  )
  expect(text).toContain('Article 1,article-1,,Alice Example; Bob Example,Summary 1,,yes,Because,Quote 1')
  expect(queryStatements.join('\n')).toContain('JOIN mart.review_article_serving_v4')
  expect(queryStatements.join('\n')).toContain('JOIN mart.review_article_judgment_detail_serving_v4')
  expect(queryStatements.join('\n')).toContain('ranked_export_article AS')
  expect(queryStatements.join('\n')).toContain('WHERE exportArticleRank = 1')
  expect(queryStatements.join('\n')).toContain('ranked_export_judgment AS')
  expect(queryStatements.join('\n')).toContain('WHERE exportJudgmentRank = 1')
  expect(queryStatements.join('\n')).not.toContain('FROM app.article')
  expect(queryStatements.join('\n')).not.toContain('FROM app.judgment')
  expect(queryStatements.join('\n')).not.toContain('FROM app.prompt')
  expect(queryStatements.join('\n')).not.toContain('OFFSET')
  expect(queryStatements.join('\n')).not.toContain('model_id AS modelId')
  expect(queryStatements.join('\n')).toContain(
    'detail.review_config_hash IS NOT DISTINCT FROM export_scope.review_config_hash',
  )
})

test('project export download rejects partially unavailable source snapshots', async () => {
  activeSnapshotProjectIds.delete('project-2')
  queryJsonRef.current = async (statement) => {
    if (statement.includes('FROM app.project') && statement.includes('LIMIT 1') && statement.includes('id, name')) {
      return [{id: 'project-1', name: 'Project 1'}]
    }

    if (statement.includes('FROM app.review_bulk_operation_job')) {
      return [
        {
          criteriaJson: {sourceProjectIds: ['project-1', 'project-2'], exportContract: {}},
          latestSnapshotSemantics: true,
          resultManifestJson: {batches: {'article-1': ['article-1']}},
          reviewConfigHash: 'config-1',
          snapshotId: null,
          status: 'completed',
        },
      ]
    }

    return []
  }
  const {projectExportRoutes} = await loadRoutes()
  const app = new Elysia().use(projectExportRoutes)
  const response = await app.handle(new Request('http://localhost/api/projects/project-1/export/export-job-1/download'))
  const body = (await response.json()) as {error: string; success: boolean}

  expect(response.status).toBe(409)
  expect(body).toEqual({error: 'Export serving snapshot is unavailable', success: false})
  expect(queryStatements.join('\n')).not.toContain('JOIN mart.review_article_serving_v4')
})
