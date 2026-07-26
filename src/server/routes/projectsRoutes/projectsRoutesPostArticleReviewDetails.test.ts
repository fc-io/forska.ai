import {readFileSync} from 'node:fs'

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
  queryJsonRef.current = async (_statement) => {
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
