import {afterEach, expect, mock, test} from 'bun:test'
import {Effect, Fiber} from 'effect'

import * as realReadOnlyDatabaseModule from '../../services/appReadOnlyDatabaseService.ts'
import * as realReadOnlyQueryModule from '../../services/getAppReadOnlyQueryService.ts'
import {classifyConnectionFailure, ConnectionError, recordConnectionFailure} from './connectionHealth.ts'
import * as realSqliteModule from './judgmentJobSqliteService.ts'

type JudgmentsRequestRuntimeModule = typeof import('./judgmentsRequestRuntime.ts')
type ProcessPromptModule = typeof import('./judgmentsJobsSendToLLM/processPromptWithLLM.ts')
type PromptToProcess = import('./judgmentsJobsSendToLLM/getAndUpdateReadyPrompts.ts').PromptToProcess
type ProviderHealthResult = {lastError: string | null; message: string; modelCount: number | null; ok: boolean}

const providerConnectionRepositoryModulePath = new URL(
  '../../providers/providerConnectionRepository.ts',
  import.meta.url,
).pathname
const providerHealthServiceModulePath = new URL('../../providers/providerHealthService.ts', import.meta.url).pathname
const judgmentsCapacityModulePath = new URL('./getJudgmentsCapacity.ts', import.meta.url).pathname
const judgeModulePath = new URL('../../../agent/judge.ts', import.meta.url).pathname
const appReadOnlyDatabaseServiceModulePath = new URL('../../services/appReadOnlyDatabaseService.ts', import.meta.url)
  .pathname
const appReadOnlyQueryServiceModulePath = new URL('../../services/getAppReadOnlyQueryService.ts', import.meta.url)
  .pathname
const ensureFullTextModulePath = new URL('../../utils/ensureFullText.ts', import.meta.url).pathname
const sqliteServiceModulePath = new URL('./judgmentJobSqliteService.ts', import.meta.url).pathname
const getRealJudgeWorkerReadOnlyAppDatabaseService = realReadOnlyDatabaseModule.getJudgeWorkerReadOnlyAppDatabaseService
const getRealJudgeWorkerReadOnlyAppQueryService = realReadOnlyQueryModule.getJudgeWorkerReadOnlyAppQueryService
const getRealJudgmentJobSqliteService = realSqliteModule.getJudgmentJobSqliteService

const createJudgmentsCapacity = ({
  maxInflight = 2,
  perWorkerMaxInflightRequests = 1,
  workerCount = 2,
}: {maxInflight?: number; perWorkerMaxInflightRequests?: number; workerCount?: number} = {}) => {
  return {
    addToQueueMaxBatchSize: 10,
    maxBurst: maxInflight,
    maxInflight,
    perWorkerMaxBurstRequests: perWorkerMaxInflightRequests,
    perWorkerMaxInflightRequests,
    perWorkerMaxRunningRequests: perWorkerMaxInflightRequests,
    readyTargetPerJob: maxInflight,
    readyTargetTotal: maxInflight,
    workerCount,
  }
}

const createPromptRows = () => {
  return [{id: 'prompt-a', order: 1, originalText: 'Prompt text', promptHeading: 'Prompt', type: 'single'}]
}

const createArticleRows = () => {
  return [
    {
      articleSummary: 'Summary',
      articleTitle: 'Title',
      createdAt: new Date(0),
      fullText: null,
      id: 'article-a',
      publicationStatus: null,
      updatedAt: new Date(0),
    },
  ]
}

const getProviderConnection = mock(async (id: string) => {
  return {
    authMode: 'none' as const,
    baseURL: 'http://fallback-runtime.test/v1',
    config: {manualWorkerUrls: [], workerUrlMode: 'manual' as const},
    createdAt: null,
    enabled: true,
    hasSecret: false,
    id,
    label: `Connection ${id}`,
    lastCheckedAt: null,
    lastError: null,
    maxInflightRequests: null,
    providerKind: 'openai' as const,
    secretRef: null,
    updatedAt: null,
  }
})
const testProviderConnectionHealth = mock(
  async (_connection: unknown, _options: unknown): Promise<ProviderHealthResult> => {
    return {lastError: null, message: 'ok', modelCount: 1, ok: true}
  },
)
const getJudgmentsCapacityMock = mock((_runningJobCount: number) => {
  return createJudgmentsCapacity()
})
class RecoverableJudgeError extends Error {
  failureCode: string
  providerDiagnostics: unknown

  constructor(
    message: string,
    {failureCode, providerDiagnostics}: {failureCode: string; providerDiagnostics?: unknown},
  ) {
    super(message)
    this.name = 'RecoverableJudgeError'
    this.failureCode = failureCode
    this.providerDiagnostics = providerDiagnostics ?? null
  }
}
const judgeSinglePrompt = mock(async (_input: unknown) => {
  return undefined
})
const queryJson = mock(async (sql: string) => {
  if (sql.includes('FROM app.prompt p')) {
    return createPromptRows()
  }

  return []
})
const getFullArticlesByIds = mock(async (_articleIds: string[], _options: unknown) => {
  return createArticleRows()
})
const ensureFullTextMock = mock(async (article: {fullText: string | null}) => {
  return {reason: 'no_fulltext' as const, shouldSkip: true, text: article.fullText ?? 'Full text'}
})
const sqliteStateTransitions: string[] = []
let usePromptRuntimeMocks = false
const sqliteServiceMock = {
  hasJob: mock((_jobId: string) => {
    return true
  }),
  hasLocalJudgment: mock(async (_jobId: string, _articleId: string, _promptId: string) => {
    return false
  }),
  markPromptAsJudged: mock(async (_jobId: string, _recordId: string) => {
    sqliteStateTransitions.push('judged')
  }),
  markPromptAsRetry: mock(async (_jobId: string, _recordId: string) => {
    sqliteStateTransitions.push('ready')
  }),
  consumePromptExtraRetry: mock(
    async (_input: {errorCode: string; jobId: string; maxExtraRetries: number; recordId: string}) => {
      return true
    },
  ),
  markPromptAsRunning: mock(async (_jobId: string, _recordId: string) => {
    sqliteStateTransitions.push('running')
  }),
  markPromptAsSkipped: mock(async (_jobId: string, _recordId: string, _skipReason: string) => {
    sqliteStateTransitions.push('skipped')
  }),
}

const registerModuleMocks = () => {
  void mock.module(providerConnectionRepositoryModulePath, () => {
    return {getProviderConnection}
  })

  void mock.module(providerHealthServiceModulePath, () => {
    return {testProviderConnectionHealth}
  })

  void mock.module(judgmentsCapacityModulePath, () => {
    return {getJudgmentsCapacity: getJudgmentsCapacityMock}
  })
}

const loadRuntime = (): Promise<JudgmentsRequestRuntimeModule> => {
  registerModuleMocks()

  return import(
    `./judgmentsRequestRuntime.ts?test=${Date.now()}-${Math.random()}`
  ) as Promise<JudgmentsRequestRuntimeModule>
}

const registerPromptModuleMocks = () => {
  usePromptRuntimeMocks = true

  void mock.module(judgeModulePath, () => {
    return {judgeSinglePrompt, MAX_COMPLETION_TOKENS: 4000, RecoverableJudgeError}
  })

  void mock.module(appReadOnlyDatabaseServiceModulePath, () => {
    return {
      ...realReadOnlyDatabaseModule,
      getJudgeWorkerReadOnlyAppDatabaseService: () => {
        return usePromptRuntimeMocks ? {queryJson} : getRealJudgeWorkerReadOnlyAppDatabaseService()
      },
    }
  })

  void mock.module(appReadOnlyQueryServiceModulePath, () => {
    return {
      ...realReadOnlyQueryModule,
      getJudgeWorkerReadOnlyAppQueryService: () => {
        return usePromptRuntimeMocks ? {getFullArticlesByIds} : getRealJudgeWorkerReadOnlyAppQueryService()
      },
    }
  })

  void mock.module(ensureFullTextModulePath, () => {
    return {ensureFullText: ensureFullTextMock}
  })

  void mock.module(sqliteServiceModulePath, () => {
    return {
      ...realSqliteModule,
      getJudgmentJobSqliteService: () => {
        return usePromptRuntimeMocks ? sqliteServiceMock : getRealJudgmentJobSqliteService()
      },
    }
  })
}

const loadProcessPromptModule = (): Promise<ProcessPromptModule> => {
  registerPromptModuleMocks()

  return import(
    `./judgmentsJobsSendToLLM/processPromptWithLLM.ts?test=${Date.now()}-${Math.random()}`
  ) as Promise<ProcessPromptModule>
}

const createPromptToProcess = (): PromptToProcess => {
  return {
    articleId: 'article-a',
    claimId: 'claim-a',
    executionSnapshotHash: 'snapshot-hash-a',
    executionSnapshotId: 'snapshot-a',
    jobId: 'job-a',
    modelBaseUrl: 'http://runtime.test/v1',
    modelId: 'model-a',
    modelMetadataJson: null,
    modelName: 'model-a',
    modelProvider: 'openai',
    modelSecretRef: null,
    modelVersion: null,
    modelWorkerUrls: [],
    projectId: 'project-a',
    promptId: 'prompt-a',
    providerConnectionId: 'connection-a',
    providerMaxInflightRequests: 1,
    providerUsesFamilyDefault: false,
    recordId: 'record-a',
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  }
}

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

const createSignal = (): {promise: Promise<void>; resolve: () => void} => {
  let resolve: () => void = () => {
    return undefined
  }
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve
  })

  return {promise, resolve}
}

afterEach(async () => {
  const {resetJudgmentRequestRuntimeForTests} = await loadRuntime()
  resetJudgmentRequestRuntimeForTests()
  Date.now = realDateNow
  getProviderConnection.mockClear()
  testProviderConnectionHealth.mockClear()
  getJudgmentsCapacityMock.mockClear()
  judgeSinglePrompt.mockClear()
  queryJson.mockClear()
  getFullArticlesByIds.mockClear()
  ensureFullTextMock.mockClear()
  sqliteServiceMock.hasJob.mockClear()
  sqliteServiceMock.hasLocalJudgment.mockClear()
  sqliteServiceMock.markPromptAsJudged.mockClear()
  sqliteServiceMock.markPromptAsRetry.mockClear()
  sqliteServiceMock.consumePromptExtraRetry.mockClear()
  sqliteServiceMock.markPromptAsRunning.mockClear()
  sqliteServiceMock.markPromptAsSkipped.mockClear()
  sqliteStateTransitions.splice(0, sqliteStateTransitions.length)
  usePromptRuntimeMocks = false
  testProviderConnectionHealth.mockImplementation(async (_connection: unknown, _options: unknown) => {
    return {lastError: null, message: 'ok', modelCount: 1, ok: true}
  })
  getJudgmentsCapacityMock.mockImplementation((_runningJobCount: number) => {
    return createJudgmentsCapacity()
  })
  judgeSinglePrompt.mockImplementation(async (_input: unknown) => {
    return undefined
  })
  queryJson.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM app.prompt p')) {
      return createPromptRows()
    }

    return []
  })
  getFullArticlesByIds.mockImplementation(async (_articleIds: string[], _options: unknown) => {
    return createArticleRows()
  })
  ensureFullTextMock.mockImplementation(async (article: {fullText: string | null}) => {
    return {reason: 'no_fulltext' as const, shouldSkip: true, text: article.fullText ?? 'Full text'}
  })
  sqliteServiceMock.consumePromptExtraRetry.mockImplementation(async () => {
    return true
  })
  mock.restore()
})

const realDateNow = Date.now

test('fallback requests enforce provider caps and release after failure', async () => {
  const {withJudgmentRequest} = await loadRuntime()
  const firstRelease = createSignal()
  let firstStarted = false
  let secondStarted = false

  const firstRequest = withJudgmentRequest(
    {
      judgmentsJobId: 'job-fallback-1',
      provider: 'openai',
      fallbackBaseURL: 'http://fallback-runtime.test/v1',
      providerConnectionId: 'connection-shared',
      providerMaxInflightRequests: 1,
      providerUsesFamilyDefault: false,
      workerUrls: [],
    },
    async () => {
      firstStarted = true
      await firstRelease.promise
      throw new Error('expected fallback failure')
    },
  ).catch((error) => {
    expect(error).toBeInstanceOf(Error)
  })

  await flush()
  expect(firstStarted).toBe(true)

  const secondRequest = withJudgmentRequest(
    {
      judgmentsJobId: 'job-fallback-2',
      provider: 'openai',
      fallbackBaseURL: 'http://fallback-runtime.test/v1',
      providerConnectionId: 'connection-shared',
      providerMaxInflightRequests: 1,
      providerUsesFamilyDefault: false,
      workerUrls: [],
    },
    async () => {
      secondStarted = true
    },
  )

  await flush()
  expect(secondStarted).toBe(false)

  firstRelease.resolve()
  await firstRequest
  await flush()
  await secondRequest

  expect(secondStarted).toBe(true)
})

test('worker requests enforce provider caps and release after success', async () => {
  const {withJudgmentRequest} = await loadRuntime()
  const firstRelease = createSignal()
  let firstStarted = false
  let secondStarted = false
  let thirdStarted = false

  const firstRequest = withJudgmentRequest(
    {
      judgmentsJobId: 'job-worker-1',
      provider: 'sglang',
      fallbackBaseURL: 'http://unused-runtime.test/v1',
      providerConnectionId: 'connection-worker-shared',
      providerMaxInflightRequests: 1,
      providerUsesFamilyDefault: false,
      workerUrls: ['http://worker-runtime-a.test'],
    },
    async () => {
      firstStarted = true
      await firstRelease.promise
    },
  )

  await flush()
  expect(firstStarted).toBe(true)

  const secondRequest = withJudgmentRequest(
    {
      judgmentsJobId: 'job-worker-2',
      provider: 'sglang',
      fallbackBaseURL: 'http://unused-runtime.test/v1',
      providerConnectionId: 'connection-worker-shared',
      providerMaxInflightRequests: 1,
      providerUsesFamilyDefault: false,
      workerUrls: ['http://worker-runtime-a.test'],
    },
    async () => {
      secondStarted = true
    },
  )

  const thirdRequest = withJudgmentRequest(
    {
      judgmentsJobId: 'job-worker-3',
      provider: 'sglang',
      fallbackBaseURL: 'http://unused-runtime.test/v1',
      providerConnectionId: 'connection-worker-other',
      providerMaxInflightRequests: 1,
      providerUsesFamilyDefault: false,
      workerUrls: ['http://worker-runtime-b.test'],
    },
    async () => {
      thirdStarted = true
    },
  )

  await flush()
  expect(secondStarted).toBe(false)
  expect(thirdStarted).toBe(true)

  firstRelease.resolve()
  await firstRequest
  await flush()
  await secondRequest
  await thirdRequest

  expect(secondStarted).toBe(true)
})

test('fallback requests honor saved provider caps even when local runtime capacity is lower', async () => {
  getJudgmentsCapacityMock.mockImplementation((_runningJobCount: number) => {
    return createJudgmentsCapacity({maxInflight: 2})
  })

  const {withJudgmentRequest} = await loadRuntime()
  const firstRelease = createSignal()
  const secondRelease = createSignal()
  const thirdRelease = createSignal()
  let firstStarted = false
  let secondStarted = false
  let thirdStarted = false

  const firstRequest = withJudgmentRequest(
    {
      judgmentsJobId: 'job-fallback-plateau-1',
      provider: 'openai',
      fallbackBaseURL: 'http://fallback-runtime.test/v1',
      providerConnectionId: 'connection-fallback-plateau',
      providerMaxInflightRequests: 3,
      providerUsesFamilyDefault: false,
      workerUrls: [],
    },
    async () => {
      firstStarted = true
      await firstRelease.promise
    },
  )

  const secondRequest = withJudgmentRequest(
    {
      judgmentsJobId: 'job-fallback-plateau-2',
      provider: 'openai',
      fallbackBaseURL: 'http://fallback-runtime.test/v1',
      providerConnectionId: 'connection-fallback-plateau',
      providerMaxInflightRequests: 3,
      providerUsesFamilyDefault: false,
      workerUrls: [],
    },
    async () => {
      secondStarted = true
      await secondRelease.promise
    },
  )

  const thirdRequest = withJudgmentRequest(
    {
      judgmentsJobId: 'job-fallback-plateau-3',
      provider: 'openai',
      fallbackBaseURL: 'http://fallback-runtime.test/v1',
      providerConnectionId: 'connection-fallback-plateau',
      providerMaxInflightRequests: 3,
      providerUsesFamilyDefault: false,
      workerUrls: [],
    },
    async () => {
      thirdStarted = true
      await thirdRelease.promise
    },
  )

  await flush()
  expect(firstStarted).toBe(true)
  expect(secondStarted).toBe(true)
  expect(thirdStarted).toBe(true)

  firstRelease.resolve()
  secondRelease.resolve()
  thirdRelease.resolve()
  await firstRequest
  await secondRequest
  await thirdRequest
})

test('fallback requests plateau at local runtime capacity when using family defaults', async () => {
  getJudgmentsCapacityMock.mockImplementation((_runningJobCount: number) => {
    return createJudgmentsCapacity({maxInflight: 2})
  })

  const {withJudgmentRequest} = await loadRuntime()
  const firstRelease = createSignal()
  const secondRelease = createSignal()
  let firstStarted = false
  let secondStarted = false
  let thirdStarted = false

  const firstRequest = withJudgmentRequest(
    {
      judgmentsJobId: 'job-fallback-default-1',
      provider: 'openai',
      fallbackBaseURL: 'http://fallback-runtime.test/v1',
      providerConnectionId: null,
      providerMaxInflightRequests: 3,
      providerUsesFamilyDefault: true,
      workerUrls: [],
    },
    async () => {
      firstStarted = true
      await firstRelease.promise
    },
  )

  const secondRequest = withJudgmentRequest(
    {
      judgmentsJobId: 'job-fallback-default-2',
      provider: 'openai',
      fallbackBaseURL: 'http://fallback-runtime.test/v1',
      providerConnectionId: null,
      providerMaxInflightRequests: 3,
      providerUsesFamilyDefault: true,
      workerUrls: [],
    },
    async () => {
      secondStarted = true
      await secondRelease.promise
    },
  )

  await flush()
  expect(firstStarted).toBe(true)
  expect(secondStarted).toBe(true)

  const thirdRequest = withJudgmentRequest(
    {
      judgmentsJobId: 'job-fallback-default-3',
      provider: 'openai',
      fallbackBaseURL: 'http://fallback-runtime.test/v1',
      providerConnectionId: null,
      providerMaxInflightRequests: 3,
      providerUsesFamilyDefault: true,
      workerUrls: [],
    },
    async () => {
      thirdStarted = true
    },
  )

  await flush()
  expect(thirdStarted).toBe(false)

  firstRelease.resolve()
  await firstRequest
  await flush()
  await thirdRequest

  expect(thirdStarted).toBe(true)

  secondRelease.resolve()
  await secondRequest
})

test('worker requests plateau at worker capacity when it is lower than the saved provider cap', async () => {
  getJudgmentsCapacityMock.mockImplementation((_runningJobCount: number) => {
    return createJudgmentsCapacity({maxInflight: 4, perWorkerMaxInflightRequests: 1, workerCount: 2})
  })

  const {withJudgmentRequest} = await loadRuntime()
  const firstRelease = createSignal()
  const secondRelease = createSignal()
  let firstStarted = false
  let secondStarted = false
  let thirdStarted = false

  const firstRequest = withJudgmentRequest(
    {
      judgmentsJobId: 'job-worker-plateau-1',
      provider: 'sglang',
      fallbackBaseURL: 'http://unused-runtime.test/v1',
      providerConnectionId: 'connection-worker-plateau',
      providerMaxInflightRequests: 3,
      providerUsesFamilyDefault: false,
      workerUrls: ['http://worker-runtime-a.test', 'http://worker-runtime-b.test'],
    },
    async () => {
      firstStarted = true
      await firstRelease.promise
    },
  )

  const secondRequest = withJudgmentRequest(
    {
      judgmentsJobId: 'job-worker-plateau-2',
      provider: 'sglang',
      fallbackBaseURL: 'http://unused-runtime.test/v1',
      providerConnectionId: 'connection-worker-plateau',
      providerMaxInflightRequests: 3,
      providerUsesFamilyDefault: false,
      workerUrls: ['http://worker-runtime-a.test', 'http://worker-runtime-b.test'],
    },
    async () => {
      secondStarted = true
      await secondRelease.promise
    },
  )

  await flush()
  expect(firstStarted).toBe(true)
  expect(secondStarted).toBe(true)

  const thirdRequest = withJudgmentRequest(
    {
      judgmentsJobId: 'job-worker-plateau-3',
      provider: 'sglang',
      fallbackBaseURL: 'http://unused-runtime.test/v1',
      providerConnectionId: 'connection-worker-plateau',
      providerMaxInflightRequests: 3,
      providerUsesFamilyDefault: false,
      workerUrls: ['http://worker-runtime-a.test', 'http://worker-runtime-b.test'],
    },
    async () => {
      thirdStarted = true
    },
  )

  await flush()
  expect(thirdStarted).toBe(false)

  firstRelease.resolve()
  await firstRequest
  await flush()
  await thirdRequest

  expect(thirdStarted).toBe(true)

  secondRelease.resolve()
  await secondRequest
})

test('codex requests enforce saved provider caps per connection', async () => {
  const {withJudgmentRequest} = await loadRuntime()
  const firstRelease = createSignal()
  let firstStarted = false
  let secondStarted = false
  let thirdStarted = false

  const firstRequest = withJudgmentRequest(
    {
      judgmentsJobId: 'job-codex-1',
      provider: 'codex',
      fallbackBaseURL: 'codex://app-server',
      providerConnectionId: 'connection-codex-shared',
      providerMaxInflightRequests: 1,
      providerUsesFamilyDefault: false,
      workerUrls: [],
    },
    async () => {
      firstStarted = true
      await firstRelease.promise
    },
  )

  await flush()
  expect(firstStarted).toBe(true)

  const secondRequest = withJudgmentRequest(
    {
      judgmentsJobId: 'job-codex-2',
      provider: 'codex',
      fallbackBaseURL: 'codex://app-server',
      providerConnectionId: 'connection-codex-shared',
      providerMaxInflightRequests: 1,
      providerUsesFamilyDefault: false,
      workerUrls: [],
    },
    async () => {
      secondStarted = true
    },
  )

  const thirdRequest = withJudgmentRequest(
    {
      judgmentsJobId: 'job-codex-3',
      provider: 'codex',
      fallbackBaseURL: 'codex://app-server',
      providerConnectionId: 'connection-codex-other',
      providerMaxInflightRequests: 1,
      providerUsesFamilyDefault: false,
      workerUrls: [],
    },
    async () => {
      thirdStarted = true
    },
  )

  await flush()
  expect(secondStarted).toBe(false)
  expect(thirdStarted).toBe(true)

  firstRelease.resolve()
  await firstRequest
  await flush()
  await secondRequest
  await thirdRequest

  expect(secondStarted).toBe(true)
})

test('404 misroutes block dispatch during cooldown, allow one probe after expiry, and reopen only after probe success', async () => {
  const {withJudgmentRequest} = await loadRuntime()
  let now = 1_000
  Date.now = () => {
    return now
  }

  const providerConnectionId = 'connection-gated'
  const fallbackBaseURL = 'http://fallback-runtime-gated.test/v1'
  const failure = classifyConnectionFailure({
    context: {effectiveBaseURL: fallbackBaseURL, endpointPath: '/v1/chat/completions', providerKind: 'openai'},
    error: {status: 404},
  })

  recordConnectionFailure({effectiveBaseURL: fallbackBaseURL, failure, providerConnectionId})

  let blockedError: unknown = null

  try {
    await withJudgmentRequest(
      {
        judgmentsJobId: 'job-gated-blocked',
        provider: 'openai',
        fallbackBaseURL,
        providerConnectionId,
        providerMaxInflightRequests: 2,
        providerUsesFamilyDefault: false,
        workerUrls: [],
      },
      async () => {
        throw new Error('should not run while cooldown is active')
      },
    )
  } catch (error) {
    blockedError = error
  }

  expect(blockedError).toBeInstanceOf(ConnectionError)
  expect((blockedError as ConnectionError).failure.kind).toBe('circuit_open')

  now += 30_001

  const probeRelease = createSignal()
  testProviderConnectionHealth.mockImplementationOnce(async (_connection: unknown, _options: unknown) => {
    await probeRelease.promise
    return {lastError: null, message: 'ok', modelCount: 1, ok: true}
  })
  let probeStarted = false
  let secondStarted = false
  let thirdStarted = false

  const probeRequest = withJudgmentRequest(
    {
      judgmentsJobId: 'job-gated-probe-1',
      provider: 'openai',
      fallbackBaseURL,
      providerConnectionId,
      providerMaxInflightRequests: 2,
      providerUsesFamilyDefault: false,
      workerUrls: [],
    },
    async (baseURL) => {
      probeStarted = true
      expect(baseURL).toBe(fallbackBaseURL)
    },
  )

  await flush()
  expect(probeStarted).toBe(false)
  expect(testProviderConnectionHealth).toHaveBeenCalledTimes(1)

  let probingBlockedError: unknown = null

  try {
    await withJudgmentRequest(
      {
        judgmentsJobId: 'job-gated-probe-2',
        provider: 'openai',
        fallbackBaseURL,
        providerConnectionId,
        providerMaxInflightRequests: 2,
        providerUsesFamilyDefault: false,
        workerUrls: [],
      },
      async () => {
        secondStarted = true
      },
    )
  } catch (error) {
    probingBlockedError = error
  }

  expect(probingBlockedError).toBeInstanceOf(ConnectionError)
  expect(testProviderConnectionHealth).toHaveBeenCalledTimes(1)

  expect(secondStarted).toBe(false)
  expect(testProviderConnectionHealth.mock.calls[0]?.[1]).toEqual({effectiveBaseURL: fallbackBaseURL})

  probeRelease.resolve()
  await probeRequest
  expect(probeStarted).toBe(true)

  await withJudgmentRequest(
    {
      judgmentsJobId: 'job-gated-probe-3',
      provider: 'openai',
      fallbackBaseURL,
      providerConnectionId,
      providerMaxInflightRequests: 2,
      providerUsesFamilyDefault: false,
      workerUrls: [],
    },
    async () => {
      thirdStarted = true
    },
  )

  expect(thirdStarted).toBe(true)
})

test('failed resume probe blocks the real request and preserves the normalized failure', async () => {
  const {withJudgmentRequest} = await loadRuntime()
  let now = 1_000
  Date.now = () => {
    return now
  }

  const providerConnectionId = 'connection-failed-probe'
  const fallbackBaseURL = 'http://failed-probe-runtime.test/v1'
  const failure = classifyConnectionFailure({
    context: {effectiveBaseURL: fallbackBaseURL, endpointPath: '/v1/chat/completions', providerKind: 'openai'},
    error: {status: 503},
  })

  recordConnectionFailure({effectiveBaseURL: fallbackBaseURL, failure, providerConnectionId})
  now += 30_001

  testProviderConnectionHealth.mockImplementationOnce(async (_connection: unknown, _options: unknown) => {
    return {lastError: failure.message, message: failure.message, modelCount: null, ok: false}
  })

  let runStarted = false
  let probeError: unknown = null

  try {
    await withJudgmentRequest(
      {
        judgmentsJobId: 'job-failed-probe',
        provider: 'openai',
        fallbackBaseURL,
        providerConnectionId,
        providerMaxInflightRequests: 2,
        providerUsesFamilyDefault: false,
        workerUrls: [],
      },
      async () => {
        runStarted = true
      },
    )
  } catch (error) {
    probeError = error
  }

  expect(runStarted).toBe(false)
  expect(probeError).toBeInstanceOf(ConnectionError)
  expect((probeError as ConnectionError).message).toBe(failure.message)
  expect(testProviderConnectionHealth).toHaveBeenCalledTimes(1)
})

test('prompt release marks running then judged on success', async () => {
  const {processPromptWithLLM} = await loadProcessPromptModule()

  await processPromptWithLLM(createPromptToProcess())

  expect(sqliteStateTransitions).toEqual(['running', 'judged'])
  expect(sqliteServiceMock.markPromptAsRetry).not.toHaveBeenCalled()
  expect(sqliteServiceMock.markPromptAsSkipped).not.toHaveBeenCalled()
})

test('prompt release marks running then ready on connection failure', async () => {
  const {processPromptWithLLM} = await loadProcessPromptModule()
  const failure = classifyConnectionFailure({
    context: {effectiveBaseURL: 'http://runtime.test/v1', endpointPath: '/v1/chat/completions', providerKind: 'openai'},
    error: {status: 503},
  })
  let caughtError: unknown = null

  judgeSinglePrompt.mockImplementationOnce(async () => {
    throw new ConnectionError(failure.message, 'http://runtime.test/v1', failure)
  })

  try {
    await processPromptWithLLM(createPromptToProcess())
  } catch (error) {
    caughtError = error
  }

  expect(String(caughtError)).toContain('ConnectionError')
  expect(sqliteStateTransitions).toEqual(['running', 'ready'])
  expect(sqliteServiceMock.markPromptAsJudged).not.toHaveBeenCalled()
})

test('prompt release marks running then ready on interruption', async () => {
  const {processPromptWithLLMEffect} = await loadProcessPromptModule()
  const gate = createSignal()

  judgeSinglePrompt.mockImplementationOnce(async () => {
    await gate.promise
  })

  const fiber = Effect.runFork(processPromptWithLLMEffect(createPromptToProcess()))

  await flush()
  await Effect.runPromise(Fiber.interrupt(fiber))
  gate.resolve()
  await flush()

  expect(sqliteStateTransitions).toEqual(['running', 'ready'])
  expect(sqliteServiceMock.markPromptAsJudged).not.toHaveBeenCalled()
})

test('prompt release consumes one extra recoverable retry then marks ready', async () => {
  const {processPromptWithLLM} = await loadProcessPromptModule()
  let caughtError: unknown = null

  judgeSinglePrompt.mockImplementationOnce(async () => {
    throw new RecoverableJudgeError('recoverable anthropic empty response', {
      failureCode: 'anthropic_thinking_only_empty_response',
      providerDiagnostics: {contentTypes: ['redacted_thinking'], stopReason: 'end_turn'},
    })
  })

  try {
    await processPromptWithLLM(createPromptToProcess())
  } catch (error) {
    caughtError = error
  }

  expect(String(caughtError)).toContain('RecoverableJudgeError')
  expect(sqliteStateTransitions).toEqual(['running', 'ready'])
  expect(sqliteServiceMock.consumePromptExtraRetry).toHaveBeenCalledWith({
    errorCode: 'anthropic_thinking_only_empty_response',
    jobId: 'job-a',
    maxExtraRetries: 1,
    recordId: 'record-a',
  })
  expect(sqliteServiceMock.markPromptAsRetry).toHaveBeenCalledWith('job-a', 'record-a', null)
})

test('prompt release stops requeueing after recoverable retry budget is exhausted', async () => {
  const {processPromptWithLLM} = await loadProcessPromptModule()

  sqliteServiceMock.consumePromptExtraRetry.mockImplementationOnce(async () => {
    return false
  })
  judgeSinglePrompt.mockImplementationOnce(async () => {
    throw new RecoverableJudgeError('recoverable anthropic empty response', {
      failureCode: 'anthropic_thinking_only_empty_response',
      providerDiagnostics: {contentTypes: ['redacted_thinking'], stopReason: 'end_turn'},
    })
  })

  await processPromptWithLLM(createPromptToProcess())

  expect(sqliteStateTransitions).toEqual(['running', 'judged'])
  expect(sqliteServiceMock.markPromptAsRetry).not.toHaveBeenCalled()
})
