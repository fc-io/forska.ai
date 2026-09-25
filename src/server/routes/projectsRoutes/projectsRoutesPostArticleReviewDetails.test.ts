import {readFileSync} from 'node:fs'

import {afterEach, beforeEach, expect, mock, test} from 'bun:test'
import {Elysia} from 'elysia'

const appDatabaseServiceModulePath = new URL('../../services/appDatabaseService.ts', import.meta.url).href
const appQueryServiceModulePath = new URL('../../services/getAppQueryService.ts', import.meta.url).href
const reviewServingReaderModulePath = new URL('../../reviewServing/reviewServingReader.ts', import.meta.url).href
const reviewServingV4RebuildRequestServiceModulePath = new URL(
  '../../reviewServing/reviewServingV4RebuildRequestService.ts',
  import.meta.url,
).href
const reviewServingProjectConfigIdentityModulePath = new URL(
  '../../services/reviewServingProjectConfigIdentity.ts',
  import.meta.url,
).href
const systemActorModulePath = new URL('../../utils/getSystemActor.ts', import.meta.url).href
const projectAccessGuardModulePath = new URL('./projectAccessGuard.ts', import.meta.url).href

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

const reviewServingV4RebuildRequestsRef = {
  current: [] as Array<{components?: readonly string[]; priority?: number; projectId: string; reason: string}>,
}
const rejectReviewServingV4RebuildRef = {current: false}
const reviewServingV4RebuildStatusRef = {current: 'admitted'}

const appRowsRef = {
  articleDetail: [] as unknown[],
  assessments: [] as unknown[],
  humanJudgments: [] as unknown[],
  judgments: [] as unknown[],
  statements: [] as string[],
}

const assertProjectIsActiveRef = {
  current: async (_projectId: string): Promise<unknown> => {
    return {archived: false, id: 'project-1', name: 'Project 1'}
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

  void mock.module(reviewServingV4RebuildRequestServiceModulePath, () => {
    return {
      requestReviewServingV4Rebuild: async (input: {
        components?: readonly string[]
        priority?: number
        projectId: string
        reason: string
      }) => {
        if (rejectReviewServingV4RebuildRef.current) {
          throw new Error('rebuild enqueue failed')
        }

        reviewServingV4RebuildRequestsRef.current.push(input)
        return {requestId: 'request-1', status: reviewServingV4RebuildStatusRef.current}
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
      archivedProjectAccessErrorMessage: 'Archived projects must be unarchived before use',
      assertProjectIsActive: async () => {
        return assertProjectIsActiveRef.current('project-1')
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
  reviewServingV4RebuildRequestsRef.current = []
  rejectReviewServingV4RebuildRef.current = false
  reviewServingV4RebuildStatusRef.current = 'admitted'
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
  appRowsRef.articleDetail = []
  appRowsRef.assessments = []
  appRowsRef.humanJudgments = []
  appRowsRef.judgments = []
  appRowsRef.statements = []
  queryJsonRef.current = async (_statement) => {
    appRowsRef.statements.push(_statement)

    if (_statement.includes('AS article_external_id')) {
      return appRowsRef.articleDetail
    }

    if (_statement.includes('FROM app.judgment_assessment')) {
      return appRowsRef.assessments
    }

    if (_statement.includes('AS judgmentId,')) {
      return appRowsRef.judgments
    }

    if (_statement.includes('FROM app.judgment_human')) {
      return appRowsRef.humanJudgments
    }

    if (_statement.includes('FROM app.project_prompt')) {
      return [
        {
          criteriaDisposition: 'include',
          enabled: true,
          id: 'prompt-1',
          order: 0,
          originalText: 'Prompt 1',
          originProjectId: null,
          promptHeading: 'Prompt 1',
          type: 'string',
        },
      ]
    }

    return _statement.includes('FROM app.article')
      ? [
          {
            articleSummary: 'Abstract',
            fullText: null,
            fullTextCharCount: null,
            fullTextHtml: null,
            fullTextOriginalFormat: null,
            fullTextSource: null,
            importRoute: null,
          },
        ]
      : []
  }
  reviewServingRowsRef.current = async () => {
    return {rows: [], status: 'accepted'}
  }
  assertProjectIsActiveRef.current = async () => {
    return {archived: false, id: 'project-1', name: 'Project 1'}
  }
})

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
    assessment_comment: 'looks good',
    assessment_created_at: '2024-01-05T00:00:00.000Z',
    assessment_id: 'assessment-1',
    assessment_is_correct: true,
    assessment_judgment_id: 'judgment-1',
    assessment_updated_at: '2024-01-05T00:00:00.000Z',
    chunking_strategy: null,
    confidence_original: 80,
    detail_updated_at: '2024-01-04T00:00:00.000Z',
    explanation: 'because',
    is_answered: true,
    judgment_id: 'judgment-1',
    judgment_model_id: 'model-1',
    judgment_created_at: '2024-01-03T00:00:00.000Z',
    judgment_updated_at: '2024-01-04T00:00:00.000Z',
    model_name: 'Model One',
    model_provider: 'openai',
    model_thinking: 'high',
    model_version: 'v1',
    payload_kind: 'llm',
    placeholder_kind: null,
    prompt_criteria_disposition: 'include',
    prompt_heading: 'Prompt 1',
    prompt_id: 'prompt-1',
    prompt_original_text: 'Prompt 1',
    prompt_order: 0,
    prompt_type: 'string',
    quotes: [],
    snapshot_project_id: null,
    snapshot_project_model_name: null,
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
      : request.contractKey === 'review.detail.judgments'
        ? {rows: [getServingJudgmentRow()], status: 'accepted'}
        : {rows: [], status: 'accepted'}
  }

  const response = await postReviewDetailsRequest()
  const body = (await response.json()) as {
    article: {articleSummary: string; articleTitle: string; fullText: string | null; id: string}
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
    fullText: null,
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
  expect(body).toMatchObject({prompts: [{id: 'prompt-1', originalText: 'Prompt 1'}]})
  expect(
    servingRequests.map((request) => {
      return request.contractKey
    }),
  ).toEqual(['review.detail.row', 'review.detail.judgments', 'review.detail.humanJudgments'])
})

test('project review details returns a typed conflict for archived projects', async () => {
  assertProjectIsActiveRef.current = async () => {
    throw new Error('Archived projects must be unarchived before use')
  }

  const response = await postReviewDetailsRequest()
  const body = (await response.json()) as {article: null; code: string; message: string; status: string}

  expect(response.status).toBe(409)
  expect(body).toMatchObject({
    article: null,
    code: 'PROJECT_ARCHIVED',
    message: 'Unarchive this project before reviewing articles.',
    status: 'archived',
  })
})

test('project review details builds prompt placeholders from project prompt metadata when serving detail has no judgment rows', async () => {
  reviewServingRowsRef.current = async (request) => {
    return request.contractKey === 'review.detail.row'
      ? {rows: [getServingArticleRow()], status: 'accepted'}
      : {rows: [], status: 'accepted'}
  }

  const response = await postReviewDetailsRequest()
  const body = (await response.json()) as {
    judgments: Array<{answeredOriginal: string; id: string; prompt: {originalText: string}; promptId: string}>
    prompts: Array<{id: string; originalText: string}>
  }

  expect(response.status).toBe(200)
  expect(body.prompts).toMatchObject([{id: 'prompt-1', originalText: 'Prompt 1'}])
  expect(body.judgments).toMatchObject([
    {
      answeredOriginal: 'not answered',
      id: 'placeholder:prompt-1',
      prompt: {originalText: 'Prompt 1'},
      promptId: 'prompt-1',
    },
  ])
})

test('project review details reads migrated V4 judgment fields from scalar columns', () => {
  const routeText = readFileSync('src/server/routes/projectsRoutes/projectsRoutesPostArticleReviewDetails.ts', 'utf8')
  const detailJudgmentHydration = routeText.slice(
    routeText.indexOf('const getProjectReviewDetailJudgmentRows'),
    routeText.indexOf('const getProjectReviewDetailHumanRows'),
  )

  expect(detailJudgmentHydration).toContain('judgmentAssessments: getServingAssessmentValues(row)')
  expect(detailJudgmentHydration).toContain('getPromptRowFromServingDetail(row)')
  expect(detailJudgmentHydration).toContain('judgmentCreatedAt: row.judgment_created_at ?? null')
  expect(detailJudgmentHydration).toContain(
    'judgmentUpdatedAt: row.judgment_updated_at ?? row.detail_updated_at ?? null',
  )
  expect(detailJudgmentHydration).toContain("judgmentModelId: getStringPayloadValue(row.judgment_model_id, '')")
  expect(detailJudgmentHydration).toContain('judgmentChunkingStrategy: row.chunking_strategy ?? null')
  expect(detailJudgmentHydration).toContain('judgmentIsAnswered: row.is_answered ?? false')
  expect(detailJudgmentHydration).toContain('judgmentConfidenceOriginal: row.confidence_original ?? 50')
  expect(detailJudgmentHydration).toContain('judgmentExplanation: row.explanation ?? null')
  expect(detailJudgmentHydration).toContain('judgmentQuotes: row.quotes ?? []')
  expect(detailJudgmentHydration).toContain('judgmentSnapshotProjectId: row.snapshot_project_id ?? null')
  expect(detailJudgmentHydration).toContain('judgmentSnapshotProjectModelName: row.snapshot_project_model_name ?? null')
  expect(detailJudgmentHydration).toContain('modelName: row.model_name ?? null')
  expect(detailJudgmentHydration).toContain('modelProvider: row.model_provider ?? null')
  expect(detailJudgmentHydration).toContain('modelThinking: row.model_thinking ?? null')
  expect(detailJudgmentHydration).toContain('modelVersion: row.model_version ?? null')
  expect(detailJudgmentHydration).not.toContain('payload.createdAt')
  expect(detailJudgmentHydration).not.toContain('payload.updatedAt')
  expect(detailJudgmentHydration).not.toContain('payload.chunkingStrategy')
  expect(detailJudgmentHydration).not.toContain('payload.confidenceOriginal')
  expect(detailJudgmentHydration).not.toContain('judgment_payload_json')
  expect(detailJudgmentHydration).not.toContain('getModelPayload')
})

test('project review details reads human answer and comment from scalar detail columns', () => {
  const routeText = readFileSync('src/server/routes/projectsRoutes/projectsRoutesPostArticleReviewDetails.ts', 'utf8')
  const detailHumanHydration = routeText.slice(
    routeText.indexOf('const getProjectReviewDetailHumanRows'),
    routeText.indexOf('const getArticleJudgmentRows'),
  )

  expect(detailHumanHydration).toContain('getPromptRowFromServingDetail(row)')
  expect(detailHumanHydration).toContain('answer: row.answered_original ?? null')
  expect(detailHumanHydration).toContain('comment: row.human_comment ?? null')
  expect(detailHumanHydration).toContain(
    "promptOriginalText: prompt.originalText || 'Overall human screening decision'",
  )
  expect(detailHumanHydration).toContain(
    "promptOrder: promptId === 'summary' ? 0 : (row.prompt_order ?? prompt.order ?? null)",
  )
  expect(detailHumanHydration).toContain(
    'updatedAt: getServingDateValue(row.detail_updated_at ?? row.judgment_created_at)',
  )
})

const getAppArticleDetailRow = () => {
  return {...getServingArticleRow(), article_title: 'App Article 1', publication_year: undefined}
}

const getAppJudgmentRow = () => {
  return {
    judgmentAnsweredOriginal: 'yes',
    judgmentAnsweredOriginalAsArray: '["yes"]',
    judgmentArticleId: 'article-1',
    judgmentAssessments: [],
    judgmentChunkingStrategy: null,
    judgmentConfidenceOriginal: 70,
    judgmentCreatedAt: '2024-01-03T00:00:00.000Z',
    judgmentDeletedAt: null,
    judgmentExplanation: 'app because',
    judgmentId: 'judgment-app-1',
    judgmentIsAnswered: true,
    judgmentModelId: 'model-1',
    judgmentProjectId: 'project-1',
    judgmentPromptId: 'prompt-1',
    judgmentQuotes: '[]',
    judgmentSnapshotProjectId: null,
    judgmentSnapshotProjectModelName: null,
    judgmentUpdatedAt: '2024-01-04T00:00:00.000Z',
    judgmentUseAbstract: true,
    judgmentUseFulltext: false,
    judgmentUseFulltextNoImages: false,
    judgmentUseTitle: true,
    modelMetadataJson: null,
    modelName: 'Model One',
    modelProvider: 'openai',
    modelThinking: null,
    modelVersion: 'v1',
    promptHeading: 'Prompt 1',
    promptOriginalText: 'Prompt 1',
  }
}

const getAppAssessmentRow = (input: {comment: string; id: string; updatedAt: string}) => {
  return {
    assessmentComment: input.comment,
    assessmentIsCorrect: true,
    createdAt: '2024-01-05T00:00:00.000Z',
    id: input.id,
    judgmentId: 'judgment-app-1',
    updatedAt: input.updatedAt,
  }
}

const rejectAllReviewServingReads = () => {
  reviewServingRowsRef.current = async () => {
    return {diagnostics: {}, reason: 'missingRequiredComponentState', status: 'rejected'}
  }
}

const detailReadinessRepairRequest = {
  components: ['posting', 'summary', 'payload'],
  priority: 1000,
  projectId: 'project-1',
  reason: 'detailReadinessDirtyWork',
}

test('project review details reads the article, judgments, assessments, and human answers from app tables when V4 detail state is missing', async () => {
  rejectAllReviewServingReads()
  appRowsRef.articleDetail = [getAppArticleDetailRow()]
  appRowsRef.judgments = [getAppJudgmentRow()]
  appRowsRef.assessments = [
    getAppAssessmentRow({comment: 'newest', id: 'assessment-new', updatedAt: '2024-01-07T00:00:00.000Z'}),
    getAppAssessmentRow({comment: 'older', id: 'assessment-old', updatedAt: '2024-01-06T00:00:00.000Z'}),
  ]
  appRowsRef.humanJudgments = [
    {
      answered_original: 'no',
      article_id: 'article-1',
      detail_updated_at: '2024-01-08T00:00:00.000Z',
      human_comment: 'human says no',
      judgment_created_at: '2024-01-08T00:00:00.000Z',
      judgment_id: 'human-1',
      prompt_heading: 'Prompt 1',
      prompt_id: 'prompt-1',
      prompt_order: 0,
      prompt_original_text: 'Prompt 1',
      prompt_type: 'string',
    },
  ]

  const response = await postReviewDetailsRequest()
  const body = (await response.json()) as {
    article: {articleTitle: string; id: string}
    detailSource: string
    humanAnswersByPrompt: Record<string, Array<{answer: string}>>
    humanAssessmentsByUser: Array<{judgments: Array<{answer: string; comment: string; id: string}>}>
    judgments: Array<{assessments: Array<{assessmentComment: string; id: string}>; explanation: string; id: string}>
    repairRequested: boolean
    status?: string
  }

  expect(response.status).toBe(200)
  expect(body.status).toBeUndefined()
  expect(body.article).toMatchObject({articleTitle: 'App Article 1', id: 'article-1'})
  expect(body.judgments).toHaveLength(1)
  expect(body.judgments[0]).toMatchObject({explanation: 'app because', id: 'judgment-app-1'})
  expect(body.judgments[0]?.assessments).toMatchObject([{assessmentComment: 'newest', id: 'assessment-new'}])
  expect(body.humanAssessmentsByUser[0]?.judgments).toMatchObject([
    {answer: 'no', comment: 'human says no', id: 'human-1'},
  ])
  expect(body.humanAnswersByPrompt).toEqual({'prompt-1': [{answer: 'no', userName: 'System'}]})
  expect(body.detailSource).toBe('app')
  expect(body.repairRequested).toBe(true)
  expect(reviewServingV4RebuildRequestsRef.current).toEqual([detailReadinessRepairRequest])
  expect(
    appRowsRef.statements.some((statement) => {
      return statement.includes('FROM app.judgment_human judgment_human')
    }),
  ).toBe(true)
})

test('project review details reads the human summary answer from app tables in summary mode when V4 detail state is missing', async () => {
  projectReviewConfigRef.current = async () => {
    return {
      humanJudgmentMode: 'summary',
      modelId: 'model-1',
      useAbstract: true,
      useFulltext: false,
      useFulltextNoImages: false,
      useTitle: true,
    }
  }
  rejectAllReviewServingReads()
  appRowsRef.articleDetail = [getAppArticleDetailRow()]
  appRowsRef.humanJudgments = [
    {
      answered_original: 'yes',
      article_id: 'article-1',
      detail_updated_at: '2024-01-08T00:00:00.000Z',
      human_comment: null,
      judgment_created_at: '2024-01-08T00:00:00.000Z',
      judgment_id: 'human-summary-1',
      prompt_heading: null,
      prompt_id: 'summary',
      prompt_order: -1,
      prompt_original_text: 'Overall human screening decision',
      prompt_type: 'summary',
    },
  ]

  const response = await postReviewDetailsRequest()
  const body = (await response.json()) as {detailSource: string; humanSummaryAnswer: string | null}

  expect(response.status).toBe(200)
  expect(body).toMatchObject({detailSource: 'app', humanSummaryAnswer: 'yes'})
  expect(
    appRowsRef.statements.some((statement) => {
      return statement.includes('FROM app.judgment_human_summary judgment_human_summary')
    }),
  ).toBe(true)
})

test('project review details reports repairRequested false on the app fallback when detail repair enqueue fails', async () => {
  rejectReviewServingV4RebuildRef.current = true
  rejectAllReviewServingReads()
  appRowsRef.articleDetail = [getAppArticleDetailRow()]

  const response = await postReviewDetailsRequest()
  const body = (await response.json()) as {detailSource: string; repairRequested: boolean; status?: string}

  expect(response.status).toBe(200)
  expect(body.status).toBeUndefined()
  expect(body).toMatchObject({detailSource: 'app', repairRequested: false})
  expect(reviewServingV4RebuildRequestsRef.current).toEqual([])
})

test('project review details reports repairRequested false on the app fallback when detail repair is blocked by budget', async () => {
  reviewServingV4RebuildStatusRef.current = 'blocked_over_budget'
  rejectAllReviewServingReads()
  appRowsRef.articleDetail = [getAppArticleDetailRow()]

  const response = await postReviewDetailsRequest()
  const body = (await response.json()) as {detailSource: string; repairRequested: boolean}

  expect(response.status).toBe(200)
  expect(body).toMatchObject({detailSource: 'app', repairRequested: false})
  expect(reviewServingV4RebuildRequestsRef.current).toHaveLength(1)
})

test('project review details returns terminal unavailable when V4 detail state is missing and the article is outside the project', async () => {
  rejectAllReviewServingReads()

  const response = await postReviewDetailsRequest()
  const body = (await response.json()) as {article: null; reason: string; repairRequested: boolean; status: string}

  expect(response.status).toBe(200)
  expect(body).toMatchObject({
    article: null,
    reason: 'article not in project scope',
    repairRequested: false,
    status: 'unavailable',
  })
  expect(reviewServingV4RebuildRequestsRef.current).toEqual([])
})

test('project review details treats absent out-of-scope detail rows as terminal', async () => {
  reviewServingRowsRef.current = async () => {
    return {rows: [], status: 'accepted'}
  }

  const response = await postReviewDetailsRequest()
  const body = (await response.json()) as {article: null; reason: string; repairRequested: boolean; status: string}

  expect(response.status).toBe(200)
  expect(body).toMatchObject({
    article: null,
    reason: 'article not in project scope',
    repairRequested: false,
    status: 'unavailable',
  })
  expect(reviewServingV4RebuildRequestsRef.current).toEqual([])
})

test('project review details falls back to app judgments when V4 judgment detail is unavailable', async () => {
  reviewServingRowsRef.current = async (request) => {
    return request.contractKey === 'review.detail.row'
      ? {rows: [getServingArticleRow()], status: 'accepted'}
      : request.contractKey === 'review.detail.judgments'
        ? {diagnostics: {}, reason: 'judgment detail unavailable', status: 'rejected'}
        : {rows: [], status: 'accepted'}
  }
  appRowsRef.judgments = [getAppJudgmentRow()]

  const response = await postReviewDetailsRequest()
  const body = (await response.json()) as {
    article: {articleTitle: string}
    detailSource: string
    judgments: Array<{id: string}>
    repairRequested: boolean
  }

  expect(response.status).toBe(200)
  expect(body.article.articleTitle).toBe('Article 1')
  expect(
    body.judgments.map((judgment) => {
      return judgment.id
    }),
  ).toEqual(['judgment-app-1'])
  expect(body).toMatchObject({detailSource: 'app', repairRequested: true})
  expect(reviewServingV4RebuildRequestsRef.current).toEqual([detailReadinessRepairRequest])
})

test('project review details does not request repair when V4 detail state serves every read', async () => {
  reviewServingRowsRef.current = async (request) => {
    return request.contractKey === 'review.detail.row'
      ? {rows: [getServingArticleRow()], status: 'accepted'}
      : {rows: [], status: 'accepted'}
  }

  const response = await postReviewDetailsRequest()
  const body = (await response.json()) as {detailSource: string; repairRequested: boolean}

  expect(response.status).toBe(200)
  expect(body).toMatchObject({detailSource: 'serving', repairRequested: false})
  expect(reviewServingV4RebuildRequestsRef.current).toEqual([])
  expect(
    appRowsRef.statements.some((statement) => {
      return statement.includes('AS article_external_id') || statement.includes('FROM app.judgment_human')
    }),
  ).toBe(false)
})

test('legacy judgment fallback does not cap visible project judgment history', () => {
  const routeText = readFileSync('src/server/routes/projectsRoutes/projectsRoutesPostArticleReviewDetails.ts', 'utf8')
  const legacyQuery = routeText.slice(
    routeText.indexOf('const getArticleJudgmentRows'),
    routeText.indexOf('const getProjectReviewDetailJudgmentValue'),
  )

  expect(legacyQuery).not.toContain('legacyArticleJudgmentRowsLimit')
  expect(legacyQuery).not.toContain('LIMIT ${detailReaderPageSize}')
  expect(legacyQuery).not.toContain('maxResultRows')
  expect(legacyQuery).toContain('ORDER BY j.created_at DESC NULLS LAST, j.id ASC')
})

test('covidence related records expose an overflow sentinel instead of silently truncating', () => {
  const routeText = readFileSync('src/server/routes/projectsRoutes/projectsRoutesPostArticleReviewDetails.ts', 'utf8')
  const covidenceRelatedRecordRead = routeText.slice(
    routeText.indexOf('const getCovidenceRelatedRecords'),
    routeText.indexOf('const getUnavailableReviewDetail'),
  )

  expect(routeText).toContain('const covidenceRelatedRecordsQueryLimit = covidenceRelatedRecordsLimit + 1')
  expect(covidenceRelatedRecordRead).toContain('LIMIT ${covidenceRelatedRecordsQueryLimit}')
  expect(covidenceRelatedRecordRead).toContain('maxResultRows: covidenceRelatedRecordsQueryLimit')
  expect(covidenceRelatedRecordRead).toContain(
    'ORDER BY isCurrentRecord DESC, articleTitle ASC, articleExternalId ASC NULLS LAST, id ASC',
  )
  expect(covidenceRelatedRecordRead).toContain('overflow: rows.length > covidenceRelatedRecordsLimit')
  expect(covidenceRelatedRecordRead).toContain('records: visibleRows.map')
})

test('covidence related record cap reserves the reviewed article before sorting by title', () => {
  const routeText = readFileSync('src/server/routes/projectsRoutes/projectsRoutesPostArticleReviewDetails.ts', 'utf8')
  const covidenceRelatedRecordRead = routeText.slice(
    routeText.indexOf('const getCovidenceRelatedRecords'),
    routeText.indexOf('const getUnavailableReviewDetail'),
  )
  const orderIndex = covidenceRelatedRecordRead.indexOf(
    'ORDER BY isCurrentRecord DESC, articleTitle ASC, articleExternalId ASC NULLS LAST, id ASC',
  )
  const limitIndex = covidenceRelatedRecordRead.indexOf('LIMIT ${covidenceRelatedRecordsQueryLimit}')

  expect(orderIndex).toBeGreaterThan(-1)
  expect(limitIndex).toBeGreaterThan(orderIndex)
  expect(covidenceRelatedRecordRead).toContain(
    'source_record.article_id = ${getSqlLiteral(article.id)} AS isCurrentRecord',
  )
  expect(covidenceRelatedRecordRead).toContain('article.id = ${getSqlLiteral(article.id)} AS isCurrentRecord')
  expect(covidenceRelatedRecordRead).toContain('isCurrentRecord: row.isCurrentRecord || row.id === article.id')
})
