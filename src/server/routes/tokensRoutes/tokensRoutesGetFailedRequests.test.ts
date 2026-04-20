import {afterEach, expect, mock, test} from 'bun:test'

const tokenUseQueryServiceModulePath = new URL('../../services/tokenUseQueryService.ts', import.meta.url).pathname
type TokensRoutesGetFailedRequestByIdModule = typeof import('./tokensRoutesGetFailedRequestById.ts')
type TokensRoutesGetFailedRequestsModule = typeof import('./tokensRoutesGetFailedRequests.ts')

const getFailedRequestsRows = mock(async (_params: {limit: number; offset: number}) => {
  return [
    {
      createdAt: new Date('2026-04-19T19:30:59.216Z'),
      failedRequests: 3,
      failedRequestsDetails: [
        {
          error:
            'Anthropic returned no text content (failure_code=anthropic_empty_response; stop_reason=refusal; content_types=none)',
          failureType: 'retry' as const,
          modelId: 'model-a',
          promptIds: ['prompt-a'],
        },
      ],
      id: 'token-row-a',
      judgmentsJobId: 'job-a',
      modelName: 'fallback-model-name',
      projectId: 'project-a',
      projectName: 'Project A',
      totalTokens: 120,
    },
  ]
})
const getPromptHeadingMap = mock(async (_promptIds: string[]) => {
  return new Map([['prompt-a', 'Eligibility']])
})
const getModelInfoMap = mock(async (_modelIds: string[]) => {
  return new Map([['model-a', {modelName: 'claude-opus-4-7', provider: 'anthropic', version: 'max'}]])
})
const getFailedRequestsCount = mock(async () => {
  return 1
})
const getFailedRequestById = mock(async (_id: string) => {
  return {
    createdAt: new Date('2026-04-19T19:30:59.216Z'),
    failedRequests: 3,
    failedRequestsDetails: [
      {
        error:
          'Anthropic returned no text content (failure_code=anthropic_empty_response; stop_reason=refusal; content_types=none)',
        failureType: 'retry' as const,
        modelId: 'model-a',
        promptIds: ['prompt-a'],
      },
    ],
    id: 'token-row-a',
    judgmentsJobId: 'job-a',
    modelName: 'fallback-model-name',
    projectId: 'project-a',
    requests: 3,
    successfulRequests: 0,
    totalTokens: 120,
  }
})

const loadHandlers = async () => {
  void mock.module(tokenUseQueryServiceModulePath, () => {
    return {
      getTokenUseQueryService: () => {
        return {
          getFailedRequestById,
          getFailedRequestsCount,
          getFailedRequestsRows,
          getModelInfoMap,
          getPromptHeadingMap,
        }
      },
    }
  })

  const [listModule, detailModule] = await Promise.all([
    import(
      `./tokensRoutesGetFailedRequests.ts?test=${Date.now()}-${Math.random()}`
    ) as Promise<TokensRoutesGetFailedRequestsModule>,
    import(
      `./tokensRoutesGetFailedRequestById.ts?test=${Date.now()}-${Math.random()}`
    ) as Promise<TokensRoutesGetFailedRequestByIdModule>,
  ])

  return {
    tokensRoutesGetFailedRequestById: detailModule.tokensRoutesGetFailedRequestById,
    tokensRoutesGetFailedRequests: listModule.tokensRoutesGetFailedRequests,
  }
}

afterEach(() => {
  getFailedRequestsRows.mockClear()
  getPromptHeadingMap.mockClear()
  getModelInfoMap.mockClear()
  getFailedRequestsCount.mockClear()
  getFailedRequestById.mockClear()
  mock.restore()
})

test('failed-requests list preserves retry labeling and enriches prompt and model metadata', async () => {
  const {tokensRoutesGetFailedRequests} = await loadHandlers()
  const result = await tokensRoutesGetFailedRequests({limit: 50, offset: 0})

  expect(result).toEqual({
    data: [
      {
        createdAt: new Date('2026-04-19T19:30:59.216Z'),
        failedRequests: 3,
        failedRequestsDetails: [
          {
            error:
              'Anthropic returned no text content (failure_code=anthropic_empty_response; stop_reason=refusal; content_types=none)',
            failureType: 'retry',
            modelId: 'model-a',
            promptIds: ['prompt-a'],
          },
        ],
        id: 'token-row-a',
        judgmentsJobId: 'job-a',
        modelName: 'claude-opus-4-7',
        modelProvider: 'anthropic',
        modelVersion: 'max',
        projectId: 'project-a',
        projectName: 'Project A',
        promptHeadings: 'Eligibility',
        totalTokens: 120,
      },
    ],
    success: true,
    total: 1,
  })
})

test('failed-request detail preserves retry labeling and enriches model metadata', async () => {
  const {tokensRoutesGetFailedRequestById} = await loadHandlers()
  const result = await tokensRoutesGetFailedRequestById('token-row-a')

  expect(result).toEqual({
    data: {
      createdAt: new Date('2026-04-19T19:30:59.216Z'),
      failedRequests: 3,
      failedRequestsDetails: [
        {
          error:
            'Anthropic returned no text content (failure_code=anthropic_empty_response; stop_reason=refusal; content_types=none)',
          failureType: 'retry',
          modelId: 'model-a',
          promptIds: ['prompt-a'],
        },
      ],
      id: 'token-row-a',
      judgmentsJobId: 'job-a',
      modelName: 'claude-opus-4-7',
      modelProvider: 'anthropic',
      modelVersion: 'max',
      projectId: 'project-a',
      requests: 3,
      successfulRequests: 0,
      totalTokens: 120,
    },
    success: true,
  })
})
