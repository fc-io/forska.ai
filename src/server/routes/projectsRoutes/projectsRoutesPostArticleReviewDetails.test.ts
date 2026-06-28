import {afterEach, beforeEach, expect, mock, test} from 'bun:test'
import {Elysia} from 'elysia'

const appDatabaseServiceModulePath = new URL('../../services/appDatabaseService.ts', import.meta.url).pathname
const appQueryServiceModulePath = new URL('../../services/getAppQueryService.ts', import.meta.url).pathname
const reviewServingReaderModulePath = new URL('../../reviewServing/reviewServingReader.ts', import.meta.url).pathname
const reviewServingProjectConfigIdentityModulePath = new URL(
  '../../services/reviewServingProjectConfigIdentity.ts',
  import.meta.url,
).pathname
const systemActorModulePath = new URL('../../utils/getSystemActor.ts', import.meta.url).pathname
const projectAccessGuardModulePath = new URL('./projectAccessGuard.ts', import.meta.url).pathname

type ReviewServingRouteTestRequest = {
  articleId?: string | null
  contractKey: string
  cursor?: string | null
  limit?: number
  projectId?: string | null
}

const projectReviewConfigRef = {
  current: async (_projectId: string): Promise<unknown> => {
    return null
  },
}

const queryJsonRef = {
  current: async (_statement: string): Promise<unknown[]> => {
    return []
  },
}

const reviewServingRowsRef = {
  current: async (
    _request: ReviewServingRouteTestRequest,
  ): Promise<
    | {getCursorForRow?: (row: Record<string, unknown>) => string; rows: unknown[]; status: 'accepted'}
    | {diagnostics: unknown; reason: string; status: 'rejected'}
  > => {
    return {rows: [], status: 'accepted'}
  },
}

const registerModuleMocks = () => {
  void mock.module(appQueryServiceModulePath, () => {
    return {
      getAppQueryService: () => {
        return {
          getFullArticlesByIds: () => {
            throw new Error('legacy article hydration should not run')
          },
          getProjectReviewConfig: (projectId: string) => {
            return projectReviewConfigRef.current(projectId)
          },
        }
      },
    }
  })

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

  void mock.module(reviewServingReaderModulePath, () => {
    return {
      readReviewServingRows: (request: ReviewServingRouteTestRequest) => {
        return reviewServingRowsRef.current(request)
      },
    }
  })

  void mock.module(reviewServingProjectConfigIdentityModulePath, () => {
    return {
      getCurrentReviewConfigHash: async () => {
        return 'review-config-hash-1'
      },
    }
  })

  void mock.module(systemActorModulePath, () => {
    return {
      getSystemActor: () => {
        return {id: 'system-actor', name: 'System'}
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

const loadHandler = (): Promise<typeof import('./projectsRoutesPostArticleReviewDetails.ts')> => {
  registerModuleMocks()

  return import(`./projectsRoutesPostArticleReviewDetails.ts?test=${Date.now()}-${Math.random()}`)
}

afterEach(() => {
  mock.restore()
})

beforeEach(() => {
  projectReviewConfigRef.current = async () => {
    return {
      humanJudgmentMode: 'prompt',
      modelId: 'model-1',
      useAbstract: true,
      useFulltext: false,
      useFulltextNoImages: false,
      useTitle: true,
    }
  }
  queryJsonRef.current = async (statement) => {
    throw new Error(`legacy detail query should not run: ${statement}`)
  }
  reviewServingRowsRef.current = async () => {
    return {rows: [], status: 'accepted'}
  }
})

const getPromptRow = (id: string, order: number) => {
  return {
    criteriaDisposition: 'include',
    enabled: true,
    id,
    order,
    originalText: `Prompt ${order + 1}`,
    originProjectId: null,
    promptHeading: `Prompt ${order + 1}`,
    type: 'string',
  }
}

const getServingArticleRow = () => {
  return {
    article_created_at: '2024-01-01T00:00:00.000Z',
    article_external_id: 'external-1',
    article_id: 'article-1',
    article_title: 'Article 1',
    article_updated_at: '2024-01-02T00:00:00.000Z',
    arxiv_id: null,
    biorxiv_id: null,
    doi: '10.1000/example',
    full_text_conversion_status: null,
    full_text_fetched_at: null,
    full_text_pdf: null,
    journal_title: null,
    medrxiv_id: null,
    pmid: null,
    publication_year: 2024,
    source_metadata: {covidence: {covidenceIds: ['1'], stageMembership: {all: true}, studyKey: 'study-1'}},
    url: 'https://example.test/article-1',
  }
}

const getServingJudgmentRow = () => {
  return {
    answered_original: 'yes',
    answered_original_as_array: ['yes'],
    article_id: 'article-1',
    detail_updated_at: '2024-01-04T00:00:00.000Z',
    judgment_id: 'judgment-1',
    judgment_payload_json: {
      assessments: [
        {
          assessmentComment: 'looks good',
          assessmentIsCorrect: true,
          createdAt: '2024-01-05T00:00:00.000Z',
          id: 'assessment-1',
          judgmentId: 'judgment-1',
          updatedAt: '2024-01-05T00:00:00.000Z',
        },
      ],
      chunkingStrategy: null,
      confidenceOriginal: 80,
      createdAt: '2024-01-03T00:00:00.000Z',
      explanation: 'because',
      id: 'judgment-1',
      isAnswered: true,
      model: {id: 'model-1', name: 'Model One', provider: 'openai', thinking: 'high', version: 'v1'},
      prompt: getPromptRow('prompt-1', 0),
      quotes: [],
      updatedAt: '2024-01-04T00:00:00.000Z',
    },
    model_id: 'model-1',
    payload_kind: 'llm',
    placeholder_kind: null,
    prompt_id: 'prompt-1',
    prompt_order: 0,
  }
}

const postReviewDetailsRequest = async () => {
  const {projectsRoutesPostArticleReviewDetails} = await loadHandler()
  const app = new Elysia().use(projectsRoutesPostArticleReviewDetails)

  return app.handle(
    new Request('http://localhost/api/projectsreview', {
      body: JSON.stringify({articleId: 'article-1', projectId: 'project-1'}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
}

test('project review details hydrates article, judgments, and assessments from V4 detail contracts', async () => {
  const servingRequests: ReviewServingRouteTestRequest[] = []

  reviewServingRowsRef.current = async (request) => {
    servingRequests.push(request)

    return request.contractKey === 'review.detail.row'
      ? {rows: [getServingArticleRow()], status: 'accepted'}
      : request.contractKey === 'review.detail.payload'
        ? {
            rows: [{abstract_text: 'Abstract', article_id: 'article-1', full_text_preview: 'Full text'}],
            status: 'accepted',
          }
        : request.contractKey === 'review.detail.judgments'
          ? {rows: [getServingJudgmentRow()], status: 'accepted'}
          : {rows: [], status: 'accepted'}
  }

  const response = await postReviewDetailsRequest()
  const body = (await response.json()) as {
    article: {articleSummary: string; articleTitle: string; fullText: string; id: string}
    judgments: Array<{
      assessments: Array<{id: string}>
      id: string
      modelName: string | null
      modelProvider: string | null
      modelThinking: string | null
      modelVersion: string | null
      prompt: {originalText: string}
    }>
    martFreshness: null
    status?: string
  }

  expect(response.status).toBe(200)
  expect(body.status).toBeUndefined()
  expect(body.article).toMatchObject({
    articleSummary: 'Abstract',
    articleTitle: 'Article 1',
    fullText: 'Full text',
    id: 'article-1',
  })
  expect(body.judgments[0]?.id).toBe('judgment-1')
  expect(body.judgments[0]?.prompt.originalText).toBe('Prompt 1')
  expect(body.judgments[0]?.modelName).toBe('Model One')
  expect(body.judgments[0]?.modelProvider).toBe('openai')
  expect(body.judgments[0]?.modelThinking).toBe('high')
  expect(body.judgments[0]?.modelVersion).toBe('v1')
  expect(body.judgments[0]?.assessments[0]?.id).toBe('assessment-1')
  expect(body.martFreshness).toBeNull()
  expect(
    servingRequests.map((request) => {
      return request.contractKey
    }),
  ).toEqual(['review.detail.row', 'review.detail.payload', 'review.detail.judgments', 'review.detail.humanJudgments'])
})

test('project review details returns unavailable when V4 article detail is unavailable', async () => {
  reviewServingRowsRef.current = async (request) => {
    return request.contractKey === 'review.detail.row'
      ? {diagnostics: {snapshotId: null}, reason: 'snapshot unavailable', status: 'rejected'}
      : {rows: [], status: 'accepted'}
  }

  const response = await postReviewDetailsRequest()
  const body = (await response.json()) as {article: null; reason: string; status: string}

  expect(response.status).toBe(200)
  expect(body).toMatchObject({article: null, reason: 'snapshot unavailable', status: 'unavailable'})
})

test('project review details does not fall back to app judgments when V4 judgment detail is unavailable', async () => {
  reviewServingRowsRef.current = async (request) => {
    return request.contractKey === 'review.detail.row'
      ? {rows: [getServingArticleRow()], status: 'accepted'}
      : request.contractKey === 'review.detail.judgments'
        ? {diagnostics: {}, reason: 'judgment detail unavailable', status: 'rejected'}
        : {rows: [], status: 'accepted'}
  }

  const response = await postReviewDetailsRequest()
  const body = (await response.json()) as {judgments: unknown[]; reason: string; status: string}

  expect(response.status).toBe(200)
  expect(body).toMatchObject({judgments: [], reason: 'detail judgments unavailable', status: 'unavailable'})
})
