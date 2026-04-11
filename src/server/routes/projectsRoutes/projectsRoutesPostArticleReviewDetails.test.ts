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
  return {dirtyToken: null, lastCompletedRefreshToken: null, refreshStatus: 'idle', ...overrides}
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

const loadHandler = () => {
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

test('project review details merges detail mart rows, raw fallback rows, and placeholders', async () => {
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
          ? [getProjectReviewDetailJudgmentRow({judgmentId: 'judgment-detail', judgmentPromptId: 'prompt-1'})]
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
})

test('project review details keeps cross-project raw judgments out of the main fallback list', async () => {
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
  ).toEqual(['judgment-project'])
  expect(
    body.allJudgments.map((judgment) => {
      return judgment.id
    }),
  ).toEqual(['judgment-cross-project'])
})

test('project review details bypasses stale detail mart rows and surfaces stale freshness', async () => {
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
        ? [getFreshnessRow({dirtyToken: 4, lastCompletedRefreshToken: 3, refreshStatus: 'failed'})]
        : statement.includes('FROM mart.review_article_serving_detail j')
          ? ((detailQueryCount += 1), [getProjectReviewDetailJudgmentRow({judgmentId: 'stale-detail'})])
          : statement.includes('FROM app.judgment j')
            ? [getArticleJudgmentRow({judgmentId: 'judgment-fallback', judgmentPromptId: 'prompt-1'})]
            : []
  }

  const response = await postReviewDetailsRequest()
  const body = (await response.json()) as {
    judgments: Array<{id: string}>
    martFreshness: {isFresh: boolean; state: string}
  }

  expect(response.status).toBe(200)
  expect(detailQueryCount).toBe(0)
  expect(body.martFreshness).toMatchObject({isFresh: false, state: 'stale'})
  expect(
    body.judgments.map((judgment) => {
      return judgment.id
    }),
  ).toEqual(['judgment-fallback'])
})

test('project review details surfaces running freshness while bypassing detail mart rows', async () => {
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
        ? [getFreshnessRow({dirtyToken: 5, lastCompletedRefreshToken: 4, refreshStatus: 'running'})]
        : statement.includes('FROM mart.review_article_serving_detail j')
          ? ((detailQueryCount += 1), [getProjectReviewDetailJudgmentRow({judgmentId: 'running-detail'})])
          : statement.includes('FROM app.judgment j')
            ? [getArticleJudgmentRow({judgmentId: 'judgment-fallback', judgmentPromptId: 'prompt-1'})]
            : []
  }

  const response = await postReviewDetailsRequest()
  const body = (await response.json()) as {
    judgments: Array<{id: string}>
    martFreshness: {isFresh: boolean; state: string}
  }

  expect(response.status).toBe(200)
  expect(detailQueryCount).toBe(0)
  expect(body.martFreshness).toMatchObject({isFresh: false, state: 'running'})
  expect(
    body.judgments.map((judgment) => {
      return judgment.id
    }),
  ).toEqual(['judgment-fallback'])
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
  expect(body.humanAnswersByPrompt).toBeUndefined()
})
