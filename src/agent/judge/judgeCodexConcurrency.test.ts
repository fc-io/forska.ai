import {EventEmitter} from 'node:events'

import {afterEach, expect, mock, test} from 'bun:test'

import {createCodexAppServerClient, type SpawnCodexAppServer} from '../../server/utils/getCodexAppServerClient.ts'
import {JudgmentPersistenceError} from './storeSinglePromptJudgment.ts'

type JudgeModule = typeof import('../judge.ts')
type JudgeSinglePromptInput = Parameters<JudgeModule['judgeSinglePrompt']>[0]
type MockJsonRpcRequest = {id?: number; method?: string; params?: {input?: Array<{text?: string}>; threadId?: string}}

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

const createArticle = ({
  id,
  summary,
  title,
}: {
  id: string
  summary: string
  title: string
}): JudgeSinglePromptInput['article'] => {
  return {
    articleSummary: summary,
    articleTitle: title,
    createdAt: new Date(0),
    fullText: null,
    id,
    publicationStatus: null,
    updatedAt: new Date(0),
  } as JudgeSinglePromptInput['article']
}

const createPrompt = (): JudgeSinglePromptInput['prompt'] => {
  return {
    id: 'prompt-1',
    order: 1,
    originalText: 'Should this study be included?',
    promptHeading: 'Eligibility',
    type: 'string',
  }
}

const createModelConfig = (): JudgeSinglePromptInput['modelConfig'] => {
  return {
    baseURL: 'http://codex.test/v1',
    modelId: 'model-1',
    modelName: 'gpt-5.4',
    provider: 'codex',
    providerConnectionId: 'provider-1',
    providerMaxInflightRequests: 20,
    providerUsesFamilyDefault: false,
    workerUrls: [],
  }
}

const createContentSettings = (): JudgeSinglePromptInput['contentSettings'] => {
  return {useAbstract: true, useFulltext: false, useFulltextNoImages: false, useTitle: true}
}

const createJudgeSinglePromptInput = ({
  article,
  queueRecordId,
}: {
  article: JudgeSinglePromptInput['article']
  queueRecordId: string
}): JudgeSinglePromptInput => {
  return {
    article,
    contentSettings: createContentSettings(),
    judgmentsJobId: 'job-1',
    modelConfig: createModelConfig(),
    modelContext: 200_000,
    projectId: 'project-1',
    prompt: createPrompt(),
    queueRecordId,
    sessionId: null,
  }
}

const getInputKey = (inputText: string): 'failed' | 'success' => {
  return inputText.includes('Failed article title') ? 'failed' : 'success'
}

const getThreadReadText = (inputKey: 'failed' | 'success'): string => {
  return inputKey === 'success'
    ? JSON.stringify({answer: 'yes', explanation: 'success explanation', quotes: ['Success article title']})
    : JSON.stringify({answer: 'no', explanation: 'failed retry explanation', quotes: ['Failed article title']})
}

const createSharedCodexInvoker = () => {
  let threadCount = 0
  let turnCount = 0
  let initialNotificationsScheduled = false
  let failedRetryCompletionScheduled = false

  const turnIdByThreadId = new Map<string, string | null>()
  const inputKeyByThreadId = new Map<string, 'failed' | 'success'>()
  const turnIdByAttemptKey = new Map<string, string>()
  const attemptCountByInputKey = new Map<'failed' | 'success', number>()
  const invokeInputKeys: Array<'failed' | 'success'> = []

  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  const proc = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter
    stdin: {write: (data: string) => boolean}
    stdout: EventEmitter
  }

  const send = (message: unknown) => {
    stdout.emit('data', Buffer.from(`${JSON.stringify(message)}\n`))
  }

  const scheduleInitialNotificationsIfReady = () => {
    if (initialNotificationsScheduled || turnIdByAttemptKey.size < 2) {
      return
    }

    const failedTurnId = turnIdByAttemptKey.get('failed:1')
    const successTurnId = turnIdByAttemptKey.get('success:1')

    if (!failedTurnId || !successTurnId) {
      return
    }

    initialNotificationsScheduled = true

    setTimeout(() => {
      send({method: 'item/completed', params: {item: {type: 'agentMessage', text: 'failed partial text'}}})
      send({method: 'turn/completed', params: {turn: {id: failedTurnId, status: 'failed'}}})
      send({method: 'turn/completed', params: {turn: {id: successTurnId, status: 'completed'}}})
    }, 0)
  }

  const scheduleFailedRetryCompletionIfReady = (inputKey: 'failed' | 'success', attempt: number, turnId: string) => {
    if (inputKey !== 'failed' || attempt !== 2 || failedRetryCompletionScheduled) {
      return
    }

    failedRetryCompletionScheduled = true

    setTimeout(() => {
      send({method: 'turn/completed', params: {turn: {id: turnId, status: 'completed'}}})
    }, 0)
  }

  proc.stdout = stdout
  proc.stderr = stderr
  proc.stdin = {
    write(payload) {
      String(payload)
        .split('\n')
        .map((line) => {
          return line.trim()
        })
        .filter((line) => {
          return line.length > 0
        })
        .forEach((line) => {
          const message = JSON.parse(line) as MockJsonRpcRequest

          if (message.method === 'initialize') {
            send({id: message.id, result: {}})
            return
          }

          if (message.method === 'thread/start') {
            threadCount += 1
            const threadId = `thread-${threadCount}`
            turnIdByThreadId.set(threadId, null)
            send({id: message.id, result: {thread: {id: threadId}}})
            return
          }

          if (message.method === 'turn/start') {
            turnCount += 1
            const turnId = `turn-${turnCount}`
            const inputText = message.params?.input?.[0]?.text ?? ''
            const threadId = message.params?.threadId

            if (!threadId) {
              throw new Error('Missing threadId for turn/start')
            }

            const inputKey = getInputKey(inputText)
            const nextAttempt = (attemptCountByInputKey.get(inputKey) ?? 0) + 1
            attemptCountByInputKey.set(inputKey, nextAttempt)
            inputKeyByThreadId.set(threadId, inputKey)
            turnIdByThreadId.set(threadId, turnId)
            turnIdByAttemptKey.set(`${inputKey}:${nextAttempt}`, turnId)
            send({id: message.id, result: {turn: {id: turnId}}})
            scheduleInitialNotificationsIfReady()
            scheduleFailedRetryCompletionIfReady(inputKey, nextAttempt, turnId)
            return
          }

          if (message.method === 'thread/read') {
            const threadId = message.params?.threadId

            if (!threadId) {
              throw new Error('Missing threadId for thread/read')
            }

            const inputKey = inputKeyByThreadId.get(threadId)
            const turnId = turnIdByThreadId.get(threadId)

            if (!inputKey || !turnId) {
              throw new Error('Missing turn state for thread/read')
            }

            send({
              id: message.id,
              result: {
                thread: {turns: [{id: turnId, items: [{type: 'agentMessage', text: getThreadReadText(inputKey)}]}]},
              },
            })
          }
        })

      return true
    },
  }

  const spawnProcess: SpawnCodexAppServer = () => {
    return proc
  }

  const client = createCodexAppServerClient({spawnProcess})

  const invokeStoredProviderModel = mock(
    async ({outputSchema, prompt, systemPrompt}: {outputSchema: unknown; prompt: string; systemPrompt: string}) => {
      const inputKey = getInputKey(prompt)
      invokeInputKeys.push(inputKey)

      const result = await client.runJsonTurn({
        inputText: `${systemPrompt}\n\n${prompt}`,
        model: 'gpt-5.4',
        outputSchema,
        timeoutMs: 10_000,
      })

      return {text: result.text, usage: {completionTokens: 0, promptTokens: 0, totalTokens: 0}}
    },
  )

  return {invokeInputKeys, invokeStoredProviderModel}
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
  void mock.module(judgmentsRequestRuntimeModulePath, () => {
    return {
      withJudgmentRequest: async (
        {fallbackBaseURL}: {fallbackBaseURL: string},
        run: (baseURL: string) => Promise<unknown>,
      ) => {
        return run(fallbackBaseURL)
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

test('judgeSinglePrompt isolates concurrent Codex turns when another request fails with partial text', async () => {
  const {invokeInputKeys, invokeStoredProviderModel} = createSharedCodexInvoker()
  const storedJudgments: Array<{articleId: string; quotes: string[]}> = []
  const tokenEntriesByArticle = new Map<string, Array<{error: string | null; outcome: string}>>()

  const judgeStoreTokenUse = mock(
    async (entries: Array<{articleId: string; error: string | null; outcome: string}>) => {
      entries.forEach((entry) => {
        const current = tokenEntriesByArticle.get(entry.articleId) ?? []
        tokenEntriesByArticle.set(entry.articleId, [...current, {error: entry.error, outcome: entry.outcome}])
      })
    },
  )

  const storeSinglePromptJudgment = mock(async (input: {article: {id: string}; judgment: {quotes: string[]}}) => {
    storedJudgments.push({articleId: input.article.id, quotes: input.judgment.quotes})
  })

  const {judgeSinglePrompt} = await loadJudgeModule({
    invokeStoredProviderModel,
    judgeStoreTokenUse,
    storeSinglePromptJudgment,
  })

  await Promise.all([
    judgeSinglePrompt(
      createJudgeSinglePromptInput({
        article: createArticle({
          id: 'article-success',
          summary: 'Summary for the success article.',
          title: 'Success article title',
        }),
        queueRecordId: 'queue-success',
      }),
    ),
    judgeSinglePrompt(
      createJudgeSinglePromptInput({
        article: createArticle({
          id: 'article-failed',
          summary: 'Summary for the failed article.',
          title: 'Failed article title',
        }),
        queueRecordId: 'queue-failed',
      }),
    ),
  ])

  expect(storedJudgments).toEqual([
    {articleId: 'article-success', quotes: ['Success article title']},
    {articleId: 'article-failed', quotes: ['Failed article title']},
  ])
  expect(tokenEntriesByArticle.get('article-success')).toEqual([{error: null, outcome: 'success'}])
  expect(tokenEntriesByArticle.get('article-failed')).toEqual([
    {error: 'codex app-server: turn failed', outcome: 'failure'},
    {error: null, outcome: 'success'},
  ])
  expect(invokeInputKeys).toEqual(['success', 'failed', 'failed'])
})
