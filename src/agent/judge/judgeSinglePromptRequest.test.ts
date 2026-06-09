import {afterEach, expect, mock, test} from 'bun:test'

import {JudgmentPersistenceError} from './storeSinglePromptJudgment.ts'

type JudgeModule = typeof import('../judge.ts')
type JudgeSinglePromptInput = Parameters<JudgeModule['judgeSinglePrompt']>[0]

const judgeModulePath = new URL('../judge.ts', import.meta.url).pathname
const judgmentsRequestRuntimeModulePath = new URL(
  '../../server/cron/judgmentsJobs/judgmentsRequestRuntime.ts',
  import.meta.url,
).pathname
const providerInvocationServiceModulePath = new URL(
  '../../server/providers/providerInvocationService.ts',
  import.meta.url,
).pathname
const judgeStoreTokenUseModulePath = new URL('./judgeStoreTokenUse.ts', import.meta.url).pathname
const storeSinglePromptJudgmentModulePath = new URL('./storeSinglePromptJudgment.ts', import.meta.url).pathname

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
    contentSettings: {useAbstract: true, useFulltext: false, useFulltextNoImages: false, useTitle: true},
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
