import {afterEach, expect, mock, test} from 'bun:test'
import {Elysia} from 'elysia'

const appDatabaseServiceModulePath = new URL('../../services/appDatabaseService.ts', import.meta.url).pathname
const appQueryServiceModulePath = new URL('../../services/getAppQueryService.ts', import.meta.url).pathname
const systemActorModulePath = new URL('../../utils/getSystemActor.ts', import.meta.url).pathname
const projectAccessGuardModulePath = new URL('./projectAccessGuard.ts', import.meta.url).pathname

const fullArticlesByIdsRef = {
  current: async (_articleIds: string[]): Promise<unknown[]> => {
    return []
  },
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

const getFreshnessRow = (overrides: Partial<Record<string, unknown>> = {}) => {
  return {dirtyToken: null, lastCompletedDirtyToken: null, refreshStatus: 'idle', ...overrides}
}

const registerModuleMocks = () => {
  void mock.module(appQueryServiceModulePath, () => {
    return {
      getAppQueryService: () => {
        return {
          getFullArticlesByIds: (articleIds: string[]) => {
            return fullArticlesByIdsRef.current(articleIds)
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

const getPromptRow = (id: string, order: number) => {
  return {
    criteriaDisposition: order === 0 ? 'include' : 'exclude',
    enabled: true,
    id,
    order,
    originalText: `Prompt ${order}`,
    originProjectId: null,
    promptHeading: `Prompt ${order}`,
    type: 'string',
  }
}

const getArticleJudgmentRow = (overrides: Partial<Record<string, unknown>>) => {
  return {
    judgmentAnsweredOriginal: 'yes',
    judgmentAnsweredOriginalAsArray: ['yes'],
    judgmentArticleId: 'article-1',
    judgmentChunkingStrategy: null,
    judgmentConfidenceOriginal: 80,
    judgmentCreatedAt: '2024-01-03T00:00:00.000Z',
    judgmentDeletedAt: null,
    judgmentExplanation: 'because',
    judgmentId: 'judgment-1',
    judgmentIsAnswered: true,
    judgmentModelId: 'model-1',
    judgmentProjectId: 'project-1',
    judgmentPromptId: 'prompt-1',
    judgmentQuotes: [],
    judgmentSnapshotProjectId: null,
    judgmentSnapshotProjectModelName: null,
    judgmentUpdatedAt: '2024-01-04T00:00:00.000Z',
    judgmentUseAbstract: true,
    judgmentUseFulltext: false,
    judgmentUseFulltextNoImages: false,
    judgmentUseTitle: true,
    modelName: 'Model 1',
    modelProvider: 'sglang',
    modelVersion: 'v1',
    promptHeading: 'Prompt 1',
    promptOriginalText: 'Prompt 1',
    ...overrides,
  }
}

const getProjectReviewDetailJudgmentRow = (overrides: Partial<Record<string, unknown>>) => {
  return {
    judgmentAnsweredOriginal: 'yes',
    judgmentAnsweredOriginalAsArray: ['yes'],
    judgmentArticleId: 'article-1',
    judgmentChunkingStrategy: null,
    judgmentConfidenceOriginal: 80,
    judgmentCreatedAt: '2024-01-03T00:00:00.000Z',
    judgmentExplanation: 'because',
    judgmentId: 'judgment-1',
    judgmentIsAnswered: true,
    judgmentModelId: 'model-1',
    judgmentProjectId: 'project-1',
    judgmentPromptId: 'prompt-1',
    judgmentQuotes: [],
    judgmentSnapshotProjectId: null,
    judgmentSnapshotProjectModelName: null,
    judgmentUpdatedAt: '2024-01-04T00:00:00.000Z',
    judgmentUseAbstract: true,
    judgmentUseFulltext: false,
    judgmentUseFulltextNoImages: false,
    judgmentUseTitle: true,
    modelName: 'Model 1',
    modelProvider: 'sglang',
    modelVersion: 'v1',
    promptHeading: 'Prompt 1',
    promptOriginalText: 'Prompt 1',
    ...overrides,
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

test('project review details falls back to app judgments when detail mart rows are missing', async () => {
  fullArticlesByIdsRef.current = async () => {
    return [{articleTitle: 'Article 1', id: 'article-1'}]
  }
  projectReviewConfigRef.current = async () => {
    return {modelId: 'model-1', useAbstract: true, useFulltext: false, useFulltextNoImages: false, useTitle: true}
  }
  queryJsonRef.current = async (statement) => {
    return statement.includes('FROM app.project_prompt pp')
      ? [getPromptRow('prompt-1', 0)]
      : statement.includes('FROM app.project_mart_refresh_state')
        ? [getFreshnessRow()]
        : statement.includes('FROM app.judgment j')
          ? [getArticleJudgmentRow({judgmentId: 'judgment-fallback', judgmentPromptId: 'prompt-1'})]
          : []
  }

  const response = await postReviewDetailsRequest()
  const body = (await response.json()) as {judgments: Array<{id: string; promptId: string}>}

  expect(response.status).toBe(200)
  expect(
    body.judgments.map((judgment) => {
      return judgment.id
    }),
  ).toEqual(['judgment-fallback'])
})

test('project review details resolves covidence related records through scoped source records', async () => {
  let covidenceStatement = ''
  fullArticlesByIdsRef.current = async () => {
    return [
      {
        articleTitle: 'Article 1',
        id: 'article-1',
        selectedImportRouteId: 'route-1',
        selectedSourceRecordKey: 'record-1',
        sourceMetadata: {covidence: {studyKey: 'study-1'}},
      },
    ]
  }
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
    if (statement.includes('FROM app.article_import_route_source_record source_record')) {
      covidenceStatement = statement
      return [
        {
          articleExternalId: 'covidence:1',
          articleTitle: 'Article 1',
          id: 'source-record-1',
          isCurrentRecord: true,
          sourceMetadata: {
            covidence: {
              articleKey: 'covidence:1',
              articleKeySource: 'covidence',
              covidenceIds: ['1'],
              duplicateStudyRecordCount: 2,
              hasDuplicateStudyRecords: true,
              hasStudyDecisionConflict: true,
              isSeededHumanJudgmentAnswered: true,
              mode: null,
              recordKey: 'record-1',
              recordKeySource: 'covidence',
              referenceIds: ['ref-1'],
              seededHumanJudgmentAnswer: 'yes',
              sourceFileNames: [],
              stageMembership: {all: true, excluded: false, full_text: false, included: true, irrelevant: false},
              studyKey: 'study-1',
              studyKeySource: 'covidence',
              tags: [],
            },
            fullTextLinks: [],
            isPreprint: false,
            journalTitle: null,
            preprintHostLabel: null,
            preprintSource: null,
          },
        },
        {
          articleExternalId: 'covidence:2',
          articleTitle: 'Article 1 duplicate',
          id: 'source-record-2',
          isCurrentRecord: false,
          sourceMetadata: {
            covidence: {
              articleKey: 'covidence:2',
              articleKeySource: 'covidence',
              covidenceIds: ['2'],
              duplicateStudyRecordCount: 2,
              hasDuplicateStudyRecords: true,
              hasStudyDecisionConflict: true,
              isSeededHumanJudgmentAnswered: true,
              mode: null,
              recordKey: 'record-2',
              recordKeySource: 'covidence',
              referenceIds: ['ref-2'],
              seededHumanJudgmentAnswer: 'no',
              sourceFileNames: [],
              stageMembership: {all: true, excluded: true, full_text: false, included: false, irrelevant: false},
              studyKey: 'study-1',
              studyKeySource: 'covidence',
              tags: [],
            },
            fullTextLinks: [],
            isPreprint: false,
            journalTitle: null,
            preprintHostLabel: null,
            preprintSource: null,
          },
        },
      ]
    }

    return statement.includes('FROM app.project_prompt pp')
      ? [getPromptRow('prompt-1', 0)]
      : statement.includes('FROM app.project_mart_refresh_state')
        ? [getFreshnessRow()]
        : []
  }

  const response = await postReviewDetailsRequest()
  const body = (await response.json()) as {
    covidenceRelatedRecords: Array<{articleExternalId: string | null; id: string; isCurrentRecord: boolean}>
  }

  expect(response.status).toBe(200)
  expect(
    body.covidenceRelatedRecords.map((record) => {
      return {articleExternalId: record.articleExternalId, id: record.id, isCurrentRecord: record.isCurrentRecord}
    }),
  ).toEqual([
    {articleExternalId: 'covidence:1', id: 'source-record-1', isCurrentRecord: true},
    {articleExternalId: 'covidence:2', id: 'source-record-2', isCurrentRecord: false},
  ])
  expect(covidenceStatement).toContain("source_record.import_route_id = 'route-1'")
})

test('project review details falls back to legacy covidence related records when source records are absent', async () => {
  let covidenceStatement = ''
  fullArticlesByIdsRef.current = async () => {
    return [
      {
        articleTitle: 'Article 1',
        id: 'article-1',
        importRoute: 'legacy-route',
        selectedImportRouteId: null,
        selectedSourceRecordKey: null,
        sourceMetadata: {covidence: {studyKey: 'study-1'}},
      },
    ]
  }
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
    if (statement.includes('legacy_related_record AS')) {
      covidenceStatement = statement
      return [
        {
          articleExternalId: 'legacy:1',
          articleTitle: 'Legacy Article 1',
          id: 'article-1',
          isCurrentRecord: true,
          rawPayload: {},
          sourceMetadata: {
            covidence: {
              articleKey: 'legacy:1',
              articleKeySource: 'covidence',
              covidenceIds: ['legacy-1'],
              hasDuplicateStudyRecords: true,
              hasStudyDecisionConflict: false,
              isSeededHumanJudgmentAnswered: true,
              recordKey: 'legacy-record-1',
              recordKeySource: 'covidence',
              referenceIds: ['legacy-ref-1'],
              seededHumanJudgmentAnswer: 'yes',
              stageMembership: {all: true, included: true},
              studyKey: 'study-1',
            },
          },
        },
      ]
    }

    return statement.includes('FROM app.project_prompt pp')
      ? [getPromptRow('prompt-1', 0)]
      : statement.includes('FROM app.project_mart_refresh_state')
        ? [getFreshnessRow()]
        : []
  }

  const response = await postReviewDetailsRequest()
  const body = (await response.json()) as {
    covidenceRelatedRecords: Array<{
      articleExternalId: string | null
      covidenceIds: string[]
      id: string
      isCurrentRecord: boolean
      referenceIds: string[]
    }>
  }

  expect(response.status).toBe(200)
  expect(
    body.covidenceRelatedRecords.map((record) => {
      return {
        articleExternalId: record.articleExternalId,
        covidenceIds: record.covidenceIds,
        id: record.id,
        isCurrentRecord: record.isCurrentRecord,
        referenceIds: record.referenceIds,
      }
    }),
  ).toEqual([
    {
      articleExternalId: 'legacy:1',
      covidenceIds: ['legacy-1'],
      id: 'article-1',
      isCurrentRecord: true,
      referenceIds: ['legacy-ref-1'],
    },
  ])
  expect(covidenceStatement).toContain('legacy_related_record AS')
  expect(covidenceStatement).toContain("article.import_route = 'legacy-route'")
  expect(covidenceStatement).toContain('source_record.canonicalArticleId = legacy_related_record.canonicalArticleId')
  expect(covidenceStatement).not.toContain('WHERE NOT EXISTS (SELECT 1 FROM source_record_related_record)')
})

test('project review details keeps legacy covidence rows when source record coverage is partial', async () => {
  let covidenceStatement = ''
  fullArticlesByIdsRef.current = async () => {
    return [
      {
        articleTitle: 'Article 1',
        id: 'article-1',
        importRoute: 'legacy-route',
        selectedImportRouteId: 'route-1',
        selectedSourceRecordKey: 'record-1',
        sourceMetadata: {covidence: {studyKey: 'study-1'}},
      },
    ]
  }
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
    if (statement.includes('legacy_related_record AS')) {
      covidenceStatement = statement
      return [
        {
          articleExternalId: 'covidence:1',
          articleTitle: 'Article 1',
          id: 'source-record-1',
          isCurrentRecord: true,
          rawPayload: {},
          sourceMetadata: {covidence: {covidenceIds: ['1'], referenceIds: ['ref-1'], studyKey: 'study-1'}},
        },
        {
          articleExternalId: 'legacy:2',
          articleTitle: 'Legacy Article 2',
          id: 'article-2',
          isCurrentRecord: false,
          rawPayload: {},
          sourceMetadata: {
            covidence: {covidenceIds: ['legacy-2'], referenceIds: ['legacy-ref-2'], studyKey: 'study-1'},
          },
        },
      ]
    }

    return statement.includes('FROM app.project_prompt pp')
      ? [getPromptRow('prompt-1', 0)]
      : statement.includes('FROM app.project_mart_refresh_state')
        ? [getFreshnessRow()]
        : []
  }

  const response = await postReviewDetailsRequest()
  const body = (await response.json()) as {covidenceRelatedRecords: Array<{id: string}>}

  expect(response.status).toBe(200)
  expect(
    body.covidenceRelatedRecords.map((record) => {
      return record.id
    }),
  ).toEqual(['source-record-1', 'article-2'])
  expect(covidenceStatement).toContain('source_record.canonicalArticleId = legacy_related_record.canonicalArticleId')
})

test('project review details merges detail mart rows, raw fallback rows, and placeholders', async () => {
  let detailStatement = ''
  const getDetailRows = (statement: string) => {
    detailStatement = statement
    return [getProjectReviewDetailJudgmentRow({judgmentId: 'judgment-detail', judgmentPromptId: 'prompt-1'})]
  }

  fullArticlesByIdsRef.current = async () => {
    return [{articleTitle: 'Article 1', id: 'article-1'}]
  }
  projectReviewConfigRef.current = async () => {
    return {modelId: 'model-1', useAbstract: true, useFulltext: false, useFulltextNoImages: false, useTitle: true}
  }
  queryJsonRef.current = async (statement) => {
    return statement.includes('FROM app.project_prompt pp')
      ? [getPromptRow('prompt-1', 0), getPromptRow('prompt-2', 1), getPromptRow('prompt-3', 2)]
      : statement.includes('FROM app.project_mart_refresh_state')
        ? [getFreshnessRow()]
        : statement.includes('FROM mart.review_article_serving_detail j')
          ? getDetailRows(statement)
          : statement.includes('FROM app.judgment j')
            ? [
                getArticleJudgmentRow({judgmentId: 'judgment-detail', judgmentPromptId: 'prompt-1'}),
                getArticleJudgmentRow({judgmentId: 'judgment-fallback', judgmentPromptId: 'prompt-2'}),
              ]
            : statement.includes('FROM app.judgment_assessment')
              ? [
                  {
                    assessmentComment: 'looks good',
                    assessmentIsCorrect: true,
                    createdAt: '2024-01-05T00:00:00.000Z',
                    id: 'assessment-1',
                    judgmentId: 'judgment-detail',
                    updatedAt: '2024-01-05T00:00:00.000Z',
                  },
                ]
              : []
  }

  const response = await postReviewDetailsRequest()
  const body = (await response.json()) as {
    judgments: Array<{assessments: Array<{id: string}>; id: string; promptId: string}>
  }

  expect(response.status).toBe(200)
  expect(
    body.judgments.map((judgment) => {
      return judgment.id
    }),
  ).toEqual(['judgment-detail', 'judgment-fallback', 'placeholder:prompt-3'])
  expect(
    body.judgments[0]?.assessments.map((assessment) => {
      return assessment.id
    }),
  ).toEqual(['assessment-1'])
  expect(detailStatement).toContain('WITH active_generation AS')
  expect(detailStatement).toContain('active.generation = j.generation')
})

test('project review details reuses project-visible raw judgments from another source project', async () => {
  fullArticlesByIdsRef.current = async () => {
    return [{articleTitle: 'Article 1', id: 'article-1'}]
  }
  projectReviewConfigRef.current = async () => {
    return {modelId: 'model-1', useAbstract: true, useFulltext: false, useFulltextNoImages: false, useTitle: true}
  }
  queryJsonRef.current = async (statement) => {
    return statement.includes('FROM app.project_prompt pp')
      ? [getPromptRow('prompt-1', 0)]
      : statement.includes('FROM app.project_mart_refresh_state')
        ? [getFreshnessRow()]
        : statement.includes('FROM app.judgment j')
          ? [
              getArticleJudgmentRow({judgmentId: 'judgment-project', judgmentPromptId: 'prompt-1'}),
              getArticleJudgmentRow({
                judgmentId: 'judgment-cross-project',
                judgmentProjectId: 'project-other',
                judgmentSnapshotProjectId: 'project-other',
                judgmentPromptId: 'prompt-1',
              }),
            ]
          : []
  }

  const response = await postReviewDetailsRequest()
  const body = (await response.json()) as {allJudgments: Array<{id: string}>; judgments: Array<{id: string}>}

  expect(response.status).toBe(200)
  expect(
    body.judgments.map((judgment) => {
      return judgment.id
    }),
  ).toEqual(['judgment-project', 'judgment-cross-project'])
  expect(
    body.allJudgments.map((judgment) => {
      return judgment.id
    }),
  ).toEqual([])
})

test('project review details keeps active detail mart rows while surfacing stale freshness', async () => {
  let detailQueryCount = 0

  fullArticlesByIdsRef.current = async () => {
    return [{articleTitle: 'Article 1', id: 'article-1'}]
  }
  projectReviewConfigRef.current = async () => {
    return {modelId: 'model-1', useAbstract: true, useFulltext: false, useFulltextNoImages: false, useTitle: true}
  }
  queryJsonRef.current = async (statement) => {
    return statement.includes('FROM app.project_prompt pp')
      ? [getPromptRow('prompt-1', 0)]
      : statement.includes('FROM app.project_mart_refresh_state')
        ? [getFreshnessRow({dirtyToken: 4, lastCompletedDirtyToken: 3, refreshStatus: 'failed'})]
        : statement.includes('FROM mart.review_article_serving_detail j')
          ? ((detailQueryCount += 1),
            [
              getProjectReviewDetailJudgmentRow({
                judgmentAnsweredOriginal: 'old',
                judgmentExplanation: 'old detail',
                judgmentId: 'stale-detail',
              }),
            ])
          : statement.includes('FROM app.judgment j')
            ? [
                getArticleJudgmentRow({
                  judgmentAnsweredOriginal: 'new',
                  judgmentExplanation: 'new detail',
                  judgmentId: 'judgment-fallback',
                  judgmentProjectId: 'project-other',
                  judgmentPromptId: 'prompt-1',
                  judgmentSnapshotProjectId: 'project-other',
                }),
              ]
            : []
  }

  const response = await postReviewDetailsRequest()
  const body = (await response.json()) as {
    allJudgments: Array<{answeredOriginal: string; explanation: string; id: string}>
    judgments: Array<{answeredOriginal: string; explanation: string; id: string}>
    martFreshness: {isFresh: boolean; state: string}
  }

  expect(response.status).toBe(200)
  expect(detailQueryCount).toBe(1)
  expect(body.martFreshness).toMatchObject({isFresh: false, state: 'stale'})
  expect(
    body.judgments.map((judgment) => {
      return judgment.id
    }),
  ).toEqual(['stale-detail'])
  expect(body.judgments[0]).toMatchObject({answeredOriginal: 'old', explanation: 'old detail'})
  expect(
    body.allJudgments.map((judgment) => {
      return judgment.id
    }),
  ).toEqual(['judgment-fallback'])
  expect(body.allJudgments[0]).toMatchObject({answeredOriginal: 'new', explanation: 'new detail'})
})

test('project review details keeps active detail mart rows while surfacing running freshness', async () => {
  let detailQueryCount = 0

  fullArticlesByIdsRef.current = async () => {
    return [{articleTitle: 'Article 1', id: 'article-1'}]
  }
  projectReviewConfigRef.current = async () => {
    return {modelId: 'model-1', useAbstract: true, useFulltext: false, useFulltextNoImages: false, useTitle: true}
  }
  queryJsonRef.current = async (statement) => {
    return statement.includes('FROM app.project_prompt pp')
      ? [getPromptRow('prompt-1', 0)]
      : statement.includes('FROM app.project_mart_refresh_state')
        ? [getFreshnessRow({dirtyToken: 5, lastCompletedDirtyToken: 4, refreshStatus: 'running'})]
        : statement.includes('FROM mart.review_article_serving_detail j')
          ? ((detailQueryCount += 1),
            [
              getProjectReviewDetailJudgmentRow({
                judgmentAnsweredOriginal: 'old',
                judgmentExplanation: 'old detail',
                judgmentId: 'running-detail',
              }),
            ])
          : statement.includes('FROM app.judgment j')
            ? [
                getArticleJudgmentRow({
                  judgmentAnsweredOriginal: 'new',
                  judgmentExplanation: 'new detail',
                  judgmentId: 'judgment-fallback',
                  judgmentProjectId: 'project-other',
                  judgmentPromptId: 'prompt-1',
                  judgmentSnapshotProjectId: 'project-other',
                }),
              ]
            : []
  }

  const response = await postReviewDetailsRequest()
  const body = (await response.json()) as {
    allJudgments: Array<{answeredOriginal: string; explanation: string; id: string}>
    judgments: Array<{answeredOriginal: string; explanation: string; id: string}>
    martFreshness: {isFresh: boolean; state: string}
  }

  expect(response.status).toBe(200)
  expect(detailQueryCount).toBe(1)
  expect(body.martFreshness).toMatchObject({isFresh: false, state: 'running'})
  expect(
    body.judgments.map((judgment) => {
      return judgment.id
    }),
  ).toEqual(['running-detail'])
  expect(body.judgments[0]).toMatchObject({answeredOriginal: 'old', explanation: 'old detail'})
  expect(
    body.allJudgments.map((judgment) => {
      return judgment.id
    }),
  ).toEqual(['judgment-fallback'])
  expect(body.allJudgments[0]).toMatchObject({answeredOriginal: 'new', explanation: 'new detail'})
})

test('project review details raw fallback query uses project-visible scope without judgment project ownership', async () => {
  let judgmentStatement = ''

  fullArticlesByIdsRef.current = async () => {
    return [{articleTitle: 'Article 1', id: 'article-1'}]
  }
  projectReviewConfigRef.current = async () => {
    return {modelId: 'model-1', useAbstract: true, useFulltext: false, useFulltextNoImages: false, useTitle: true}
  }
  queryJsonRef.current = async (statement) => {
    if (statement.includes('FROM app.judgment j')) {
      judgmentStatement = statement
      return []
    }

    return statement.includes('FROM app.project_prompt pp')
      ? [getPromptRow('prompt-1', 0)]
      : statement.includes('FROM app.project_mart_refresh_state')
        ? [getFreshnessRow({dirtyToken: 5, lastCompletedDirtyToken: 4, refreshStatus: 'running'})]
        : []
  }

  const response = await postReviewDetailsRequest()

  expect(response.status).toBe(200)
  expect(judgmentStatement).toContain('project_prompt.project_id = project.id')
  expect(judgmentStatement).toContain('project_prompt.enabled = TRUE')
  expect(judgmentStatement).toContain('j.prompt_id = project_prompt.prompt_id')
  expect(judgmentStatement).toContain('j.article_id = scope_article.article_id')
  expect(judgmentStatement).toContain('j.model_id = project.model_id')
  expect(judgmentStatement).toContain('j.use_fulltext_no_images = project.use_fulltext_no_images')
  expect(judgmentStatement).not.toContain('j.project_id =')
})

test('project review details exposes summary-mode overall answers without prompt human map', async () => {
  fullArticlesByIdsRef.current = async () => {
    return [{articleTitle: 'Article 1', id: 'article-1'}]
  }
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
  queryJsonRef.current = async (statement) => {
    return statement.includes('FROM app.project_prompt pp')
      ? [getPromptRow('prompt-1', 0), getPromptRow('prompt-2', 1)]
      : statement.includes('FROM app.project_mart_refresh_state')
        ? [getFreshnessRow()]
        : statement.includes('FROM app.judgment j')
          ? [
              getArticleJudgmentRow({
                judgmentId: 'judgment-1',
                judgmentPromptId: 'prompt-1',
                judgmentAnsweredOriginal: 'yes',
                judgmentAnsweredOriginalAsArray: ['yes'],
              }),
              getArticleJudgmentRow({
                judgmentId: 'judgment-2',
                judgmentPromptId: 'prompt-2',
                judgmentAnsweredOriginal: 'no',
                judgmentAnsweredOriginalAsArray: ['no'],
              }),
            ]
          : statement.includes('FROM app.judgment_human_summary jhs')
            ? [
                {
                  judgmentId: 'human-summary-1',
                  promptId: 'summary',
                  answer: 'no',
                  comment: null,
                  promptOriginalText: 'Overall',
                },
              ]
            : []
  }

  const response = await postReviewDetailsRequest()
  const body = (await response.json()) as Record<string, unknown>

  expect(response.status).toBe(200)
  expect(body.humanJudgmentMode).toBe('summary')
  expect(body.humanSummaryAnswer).toBe('no')
  expect(body.llmSummaryAnswer).toBe('yes')
  expect(body.prompts).toEqual([
    expect.objectContaining({criteriaDisposition: 'include', id: 'prompt-1'}),
    expect.objectContaining({criteriaDisposition: 'exclude', id: 'prompt-2'}),
  ])
  expect(body.humanAnswersByPrompt).toBeUndefined()
})
