import {afterEach, expect, mock, test} from 'bun:test'

import {ProviderInvocationError} from '../../server/providers/providerTypes.ts'
import {ProviderContentRefusalError} from './providerContentRefusalError.ts'
import {JudgmentPersistenceError} from './storeSinglePromptJudgment.ts'

type JudgeModule = typeof import('../judge.ts')
type JudgeSinglePromptInput = Parameters<JudgeModule['judgeSinglePrompt']>[0]

const judgeModulePath = new URL('../judge.ts', import.meta.url).href
const judgmentsRequestRuntimeModulePath = new URL(
  '../../server/cron/judgmentsJobs/judgmentsRequestRuntime.ts',
  import.meta.url,
).href
const providerInvocationServiceModulePath = new URL(
  '../../server/providers/providerInvocationService.ts',
  import.meta.url,
).href
const judgeStoreTokenUseModulePath = new URL('./judgeStoreTokenUse.ts', import.meta.url).href
const storeSinglePromptJudgmentModulePath = new URL('./storeSinglePromptJudgment.ts', import.meta.url).href

const createArticle = (): JudgeSinglePromptInput['article'] => {
  return {
    articleSummary: 'Preview summary',
    articleTitle: 'Preview title',
    createdAt: new Date(0),
    fullText: null,
    id: 'article-preview',
    publicationStatus: null,
    updatedAt: new Date(0),
  } as JudgeSinglePromptInput['article']
}

const createJudgeSinglePromptInput = (): JudgeSinglePromptInput => {
  return {
    article: createArticle(),
    contentSettings: {
      useAbstract: true,
      useFulltext: false,
      useFulltextNoImages: false,
      useMetadata: false,
      useTitle: true,
    },
    fullTextStrategyId: 'fts-none',
    judgmentsJobId: 'job-1',
    modelConfig: {
      baseURL: 'http://runtime.test/v1',
      modelId: 'model-1',
      modelName: 'gpt-5.4',
      provider: 'openai',
      providerConnectionId: 'provider-1',
      providerMaxInflightRequests: 20,
      providerUsesFamilyDefault: false,
      workerUrls: [],
    },
    modelContext: 200_000,
    projectId: 'project-1',
    prompt: {
      id: 'prompt-1',
      order: 1,
      originalText: 'Should this study be included?',
      promptHeading: 'Eligibility',
      type: 'string',
    },
    queueRecordId: 'queue-1',
    sessionId: null,
  }
}

const loadJudgeModule = ({
  invokeStoredProviderModel,
  judgeStoreTokenUse,
  storeSinglePromptJudgment,
}: {
  invokeStoredProviderModel: ReturnType<typeof mock>
  judgeStoreTokenUse: ReturnType<typeof mock>
  storeSinglePromptJudgment: ReturnType<typeof mock>
}): Promise<JudgeModule> => {
  let requestAttemptCount = 0

  void mock.module(judgmentsRequestRuntimeModulePath, () => {
    return {
      isProviderAdmissionLeaseLostError: () => {
        return false
      },
      updateJudgmentPromptRequestWork: () => {
        return undefined
      },
      withJudgmentRequest: async (
        {fallbackBaseURL}: {fallbackBaseURL: string},
        run: (
          baseURL: string,
          requestAttempt: {
            baseURL: string
            createdAt: string
            providerKey: string
            requestAttemptId: string
            startedAt: string
          },
        ) => Promise<unknown>,
      ) => {
        requestAttemptCount += 1
        const now = new Date(0).toISOString()

        return run(fallbackBaseURL, {
          baseURL: fallbackBaseURL,
          createdAt: now,
          providerKey: 'provider-key-1',
          requestAttemptId: `request-attempt-${requestAttemptCount}`,
          startedAt: now,
        })
      },
    }
  })

  void mock.module(providerInvocationServiceModulePath, () => {
    return {invokeStoredProviderModel}
  })

  void mock.module(judgeStoreTokenUseModulePath, () => {
    return {judgeStoreTokenUse}
  })

  void mock.module(storeSinglePromptJudgmentModulePath, () => {
    return {JudgmentPersistenceError, storeSinglePromptJudgment}
  })

  return import(`${judgeModulePath}?test=${Date.now()}-${Math.random()}`) as Promise<JudgeModule>
}

afterEach(() => {
  mock.restore()
})

test('judgeSinglePrompt sends the shared system and user prompts to the provider', async () => {
  let capturedRequest: {prompt: string; systemPrompt: string} | null = null
  const invokeStoredProviderModel = mock(async ({prompt, systemPrompt}: {prompt: string; systemPrompt: string}) => {
    capturedRequest = {prompt, systemPrompt}

    return {
      text: JSON.stringify({answer: 'yes', explanation: 'because', quotes: ['Preview title']}),
      usage: {completionTokens: 0, promptTokens: 0, totalTokens: 0},
    }
  })
  const judgeStoreTokenUse = mock(async () => {})
  const storeSinglePromptJudgment = mock(async () => {})
  const {judgeSinglePrompt} = await loadJudgeModule({
    invokeStoredProviderModel,
    judgeStoreTokenUse,
    storeSinglePromptJudgment,
  })

  await judgeSinglePrompt(createJudgeSinglePromptInput())

  expect(capturedRequest?.systemPrompt).toContain('You are a helpful deep research assistant.')
  expect(capturedRequest?.prompt).toContain('## article_title')
  expect(capturedRequest?.prompt).toContain('Preview title')
  expect(capturedRequest?.prompt).toContain('Should this study be included?')
})

const getProviderFailureRejection = async ({
  code,
  message,
  providerKind,
}: {
  code: string
  message: string
  providerKind: string
}) => {
  const invokeStoredProviderModel = mock(async () => {
    throw new ProviderInvocationError(message, {
      code,
      providerKind,
      usage: {
        cacheCreationInputTokens: 6875,
        cacheReadInputTokens: 7116,
        completionTokens: 0,
        promptTokens: 13_995,
        thinkingTokens: null,
        totalTokens: 13_995,
      },
    })
  })
  const judgeStoreTokenUse = mock(async (_tokenUse: Array<{failureCode?: string | null; outcome: string}>) => {})
  const storeSinglePromptJudgment = mock(async () => {})
  const {judgeSinglePrompt} = await loadJudgeModule({
    invokeStoredProviderModel,
    judgeStoreTokenUse,
    storeSinglePromptJudgment,
  })
  const error = await judgeSinglePrompt(createJudgeSinglePromptInput()).then(
    () => {
      return null
    },
    (caught: unknown) => {
      return caught
    },
  )

  return {error, invokeStoredProviderModel, judgeStoreTokenUse, storeSinglePromptJudgment}
}

test('a Claude Code content refusal aborts after exactly one provider attempt as a ProviderContentRefusalError', async () => {
  const message =
    "Claude Code content refusal (stop_reason=refusal): API Error: Opus 5's safeguards flagged this message"
  const {error, invokeStoredProviderModel, judgeStoreTokenUse, storeSinglePromptJudgment} =
    await getProviderFailureRejection({code: 'claude_code_content_refusal', message, providerKind: 'claude-code'})

  expect(invokeStoredProviderModel).toHaveBeenCalledTimes(1)
  expect(storeSinglePromptJudgment).not.toHaveBeenCalled()
  expect(error).toBeInstanceOf(ProviderContentRefusalError)
  expect(error instanceof ProviderContentRefusalError ? error.refusal : null).toMatchObject({
    failureCode: 'claude_code_content_refusal',
    modelName: 'gpt-5.4',
    providerKind: 'claude-code',
    reason: message,
  })
  expect(Number.isNaN(Date.parse(error instanceof ProviderContentRefusalError ? error.refusal.refusedAt : ''))).toBe(
    false,
  )
  expect(judgeStoreTokenUse.mock.calls[0]?.[0]).toEqual([
    expect.objectContaining({failureCode: 'claude_code_content_refusal', outcome: 'failure', pendingQueueRetry: false}),
  ])
})

test('a direct Anthropic refusal takes the same terminal path after exactly one provider attempt', async () => {
  const {error, invokeStoredProviderModel} = await getProviderFailureRejection({
    code: 'anthropic_refusal_empty_response',
    message: 'Anthropic returned no text content (failure_code=anthropic_refusal_empty_response; stop_reason=refusal)',
    providerKind: 'anthropic',
  })

  expect(invokeStoredProviderModel).toHaveBeenCalledTimes(1)
  expect(error).toBeInstanceOf(ProviderContentRefusalError)
  expect(error instanceof ProviderContentRefusalError ? error.refusal.failureCode : null).toBe(
    'anthropic_refusal_empty_response',
  )
})

test('a non-refusal Claude Code request failure still uses every provider attempt', async () => {
  const {error, invokeStoredProviderModel} = await getProviderFailureRejection({
    code: 'claude_code_request_failed',
    message: 'Claude Code request failed: not json at all',
    providerKind: 'claude-code',
  })

  expect(invokeStoredProviderModel).toHaveBeenCalledTimes(3)
  expect(error).not.toBeInstanceOf(ProviderContentRefusalError)
})
