import {readFileSync} from 'node:fs'

import {beforeEach, expect, mock, test} from 'bun:test'

import {attachCodexTurnErrorEvents, type CodexTurnErrorEvent} from '../../utils/codexTurnErrors.ts'
import {
  codexRateLimitBackoffConstants,
  recordCodexConnectionRateLimit,
  resetCodexRateLimitBackoffForTests,
} from '../codexRateLimitBackoff.ts'
import {ProviderInvocationError} from '../providerTypes.ts'

const getCodexAppServerClientModulePath = new URL('../../utils/getCodexAppServerClient.ts', import.meta.url).href

const runJsonTurn = mock(async (_params: Record<string, unknown>): Promise<{text: string; usage: unknown}> => {
  return {text: 'codex-response', usage: null}
})

void mock.module(getCodexAppServerClientModulePath, () => {
  return {
    getCodexAppServerClient: () => {
      return {
        modelList: async () => {
          return {data: [], nextCursor: null}
        },
        runJsonTurn,
      }
    },
    getCodexBinPath: () => {
      return '/usr/local/bin/codex'
    },
  }
})

const loadTransport = () => {
  return import('./codexAppTransport.ts')
}

const invokeAndCatch = async (connectionId = 'codex-connection'): Promise<unknown> => {
  const {invokeCodexAppModel} = await loadTransport()

  return invokeCodexAppModel({
    connectionId,
    modelName: 'gpt-6-astra',
    outputSchema: {type: 'object'},
    prompt: 'hello',
    systemPrompt: 'system',
    version: 'xhigh',
  }).then(
    () => {
      return null
    },
    (caught: unknown) => {
      return caught
    },
  )
}

const retryLimit429Message =
  'codex app-server: turn failed: exceeded retry limit, last status: 429 Too Many Requests, request id: 935f6f8d-850a-4fb8-895e-2c2ef8027110'

const responseTooManyFailedAttemptsEvent: CodexTurnErrorEvent = {
  additionalDetails: null,
  codexErrorInfo: 'responseTooManyFailedAttempts',
  httpStatusCode: 429,
  message: 'exceeded retry limit, last status: 429 Too Many Requests, request id: 863be531-bef0-4c36-95c9-ca2cf3a79aeb',
  willRetry: true,
}

beforeEach(() => {
  runJsonTurn.mockReset()
  resetCodexRateLimitBackoffForTests()
})

test('invokeCodexAppModel maps Codex token usage into provider usage', async () => {
  runJsonTurn.mockResolvedValue({
    text: 'codex-response',
    usage: {
      last: {cachedInputTokens: 20, inputTokens: 120, outputTokens: 30, reasoningOutputTokens: 5, totalTokens: 155},
      modelContextWindow: 200_000,
      total: {cachedInputTokens: 20, inputTokens: 120, outputTokens: 30, reasoningOutputTokens: 5, totalTokens: 155},
    },
  })

  const {invokeCodexAppModel} = await loadTransport()
  const result = await invokeCodexAppModel({
    connectionId: 'codex-connection',
    modelName: 'codex-mini',
    outputSchema: {type: 'object'},
    prompt: 'hello',
    systemPrompt: 'system',
    version: 'medium',
  })

  expect(result).toEqual({text: 'codex-response', usage: {completionTokens: 35, promptTokens: 120, totalTokens: 155}})
})

test('invokeCodexAppModel forwards admission fencing abort signals to the app-server turn', async () => {
  runJsonTurn.mockResolvedValue({text: 'codex-response', usage: null})
  const controller = new AbortController()
  const {invokeCodexAppModel} = await loadTransport()

  await invokeCodexAppModel({
    connectionId: 'codex-connection',
    modelName: 'codex-mini',
    outputSchema: {type: 'object'},
    prompt: 'hello',
    signal: controller.signal,
    systemPrompt: 'system',
    version: 'medium',
  })

  expect(runJsonTurn.mock.calls[0]?.[0]).toMatchObject({signal: controller.signal})
})

test('invokeCodexAppModel wraps transient turn timeouts as provider invocation failures', async () => {
  runJsonTurn.mockRejectedValue(new Error('The operation timed out.'))

  const {invokeCodexAppModel} = await loadTransport()
  const error = await (async (): Promise<unknown> => {
    try {
      await invokeCodexAppModel({
        connectionId: 'codex-connection',
        modelName: 'codex-mini',
        outputSchema: {type: 'object'},
        prompt: 'hello',
        systemPrompt: 'system',
        version: 'medium',
      })
      return null
    } catch (caught) {
      return caught
    }
  })()

  expect(error).toBeInstanceOf(ProviderInvocationError)
  expect(error).toMatchObject({code: 'codex_transient_turn_failure', providerKind: 'codex'})
})

test('invokeCodexAppModel classifies an app-server retry-limit 429 as codex_rate_limited with the request id', async () => {
  runJsonTurn.mockRejectedValue(new Error(retryLimit429Message))

  const error = await invokeAndCatch()

  expect(error).toBeInstanceOf(ProviderInvocationError)
  expect(error).toMatchObject({
    code: 'codex_rate_limited',
    diagnostics: {
      httpStatusCode: 429,
      message: `Codex backend rate limited (429): ${retryLimit429Message}`,
      requestId: '935f6f8d-850a-4fb8-895e-2c2ef8027110',
      turnError: retryLimit429Message,
    },
    message: `Codex backend rate limited (429): ${retryLimit429Message}`,
    providerKind: 'codex',
  })
})

test('invokeCodexAppModel keeps the retry-after hint of a 429 in the rate-limited message', async () => {
  const message = 'codex app-server: turn failed: 429 Too Many Requests. Please try again in 30s.'
  runJsonTurn.mockRejectedValue(new Error(message))

  const error = await invokeAndCatch()

  expect(error).toMatchObject({
    code: 'codex_rate_limited',
    diagnostics: {requestId: null},
    message: `Codex backend rate limited (429): ${message}`,
  })
})

test('invokeCodexAppModel classifies a turn timeout after app-server 429 events as codex_rate_limited', async () => {
  runJsonTurn.mockRejectedValue(
    attachCodexTurnErrorEvents(new Error('codex app-server: turn timeout'), [responseTooManyFailedAttemptsEvent]),
  )

  const error = await invokeAndCatch()

  expect(error).toMatchObject({
    code: 'codex_rate_limited',
    diagnostics: {
      codexErrorInfo: 'responseTooManyFailedAttempts',
      requestId: '863be531-bef0-4c36-95c9-ca2cf3a79aeb',
      turnError: 'codex app-server: turn timeout',
      willRetry: true,
    },
    message: `Codex backend rate limited (429): codex app-server: turn timeout; app-server reported: ${responseTooManyFailedAttemptsEvent.message}`,
  })
})

test('invokeCodexAppModel classifies a turn timeout after a rateLimitExceeded event as codex_rate_limited', async () => {
  runJsonTurn.mockRejectedValue(
    attachCodexTurnErrorEvents(new Error('codex app-server: turn timeout'), [
      {
        additionalDetails: null,
        codexErrorInfo: 'rateLimitExceeded',
        httpStatusCode: null,
        message: 'Rate limit reached',
        willRetry: true,
      },
    ]),
  )

  expect(await invokeAndCatch()).toMatchObject({code: 'codex_rate_limited'})
})

test('invokeCodexAppModel keeps a turn timeout without 429 events as a transient turn failure', async () => {
  runJsonTurn.mockRejectedValue(
    attachCodexTurnErrorEvents(new Error('codex app-server: turn timeout'), [
      {
        additionalDetails: null,
        codexErrorInfo: 'responseStreamDisconnected',
        httpStatusCode: 502,
        message: 'stream disconnected before completion',
        willRetry: true,
      },
    ]),
  )

  expect(await invokeAndCatch()).toMatchObject({
    code: 'codex_transient_turn_failure',
    message: 'codex app-server: turn timeout',
  })
})

test('invokeCodexAppModel keeps a ChatGPT usage-limit 429 as the unchanged transient failure', async () => {
  const usageLimitMessage =
    "codex app-server: turn failed: You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Oct 3rd, 2026 9:33 PM."
  runJsonTurn.mockRejectedValue(
    attachCodexTurnErrorEvents(new Error(usageLimitMessage), [
      {
        additionalDetails: null,
        codexErrorInfo: 'usageLimitExceeded',
        httpStatusCode: 429,
        message: usageLimitMessage,
        willRetry: false,
      },
    ]),
  )

  expect(await invokeAndCatch()).toMatchObject({
    code: 'codex_transient_turn_failure',
    diagnostics: {message: usageLimitMessage},
    message: usageLimitMessage,
  })
})

test('invokeCodexAppModel keeps a 429 quota message as the unchanged transient failure', async () => {
  const quotaMessage = 'codex app-server: turn failed: 429 Too Many Requests: You exceeded your current quota.'
  runJsonTurn.mockRejectedValue(new Error(quotaMessage))

  expect(await invokeAndCatch()).toMatchObject({code: 'codex_transient_turn_failure', message: quotaMessage})
})

test('invokeCodexAppModel uses the shorter turn timeout only while its connection is in rate-limit backoff', async () => {
  runJsonTurn.mockResolvedValue({text: 'codex-response', usage: null})
  recordCodexConnectionRateLimit({
    configuredLimit: 35,
    key: 'throttled-connection',
    requestStartedAtMs: Date.now(),
    retryAfterAt: null,
  })

  await invokeAndCatch('healthy-connection')
  await invokeAndCatch('throttled-connection')

  expect(
    runJsonTurn.mock.calls.map((call) => {
      return call[0]?.timeoutMs
    }),
  ).toEqual([codexRateLimitBackoffConstants.healthyTurnTimeoutMs, codexRateLimitBackoffConstants.backoffTurnTimeoutMs])
  expect(codexRateLimitBackoffConstants).toMatchObject({backoffTurnTimeoutMs: 180_000, healthyTurnTimeoutMs: 900_000})
})

test('getProviderUsageFromCodexThreadTokenUsage falls back to output totals when needed', async () => {
  const {getProviderUsageFromCodexThreadTokenUsage} = await loadTransport()

  const result = getProviderUsageFromCodexThreadTokenUsage({
    last: {cachedInputTokens: 0, inputTokens: 0, outputTokens: 11, reasoningOutputTokens: 7, totalTokens: 0},
    modelContextWindow: null,
    total: {cachedInputTokens: 0, inputTokens: 0, outputTokens: 11, reasoningOutputTokens: 7, totalTokens: 0},
  })

  expect(result).toEqual({completionTokens: 18, promptTokens: 0, totalTokens: 0})
})

test('invokeCodexAppModel sends text-only prompts with exactly the previous turn parameters', async () => {
  runJsonTurn.mockResolvedValue({text: 'codex-response', usage: null})
  const {invokeCodexAppModel} = await loadTransport()

  await invokeCodexAppModel({
    connectionId: 'codex-connection',
    modelName: 'gpt-5.5',
    outputSchema: {type: 'object'},
    prompt: 'hello',
    systemPrompt: 'system',
    version: 'high',
  })

  expect(Object.keys(runJsonTurn.mock.calls[0]?.[0] ?? {}).sort()).toEqual([
    'effort',
    'inputText',
    'model',
    'outputSchema',
    'signal',
    'timeoutMs',
  ])
  expect(runJsonTurn.mock.calls[0]?.[0]).toMatchObject({inputText: 'system\n\nhello', model: 'gpt-5.5'})
})

test('invokeCodexAppModel flattens image parts and passes them as data URLs after the prompt text', async () => {
  runJsonTurn.mockResolvedValue({text: 'codex-response', usage: null})
  const {getProviderImageDataUrl} = await import('../providerImageInput.ts')
  const {flattenFigureImage} = await import('../../fullText/figureImageEncoding.ts')
  const transparent = {
    bytes: new Uint8Array(
      readFileSync(new URL('../../fullText/fixtures/figureImages/transparent-3x2.png', import.meta.url)),
    ),
    mimeType: 'image/png' as const,
  }
  const jpeg = {bytes: Uint8Array.of(0xff, 0xd8, 0xff, 0xe0), mimeType: 'image/jpeg' as const}
  const {invokeCodexAppModel} = await loadTransport()

  await invokeCodexAppModel({
    connectionId: 'codex-connection',
    modelName: 'gpt-5.5',
    outputSchema: {type: 'object'},
    prompt: {images: [transparent, jpeg], text: 'Article\n\n[figure:1]'},
    systemPrompt: 'system',
    version: 'high',
  })

  expect(runJsonTurn.mock.calls[0]?.[0]).toMatchObject({
    inputImageUrls: [getProviderImageDataUrl(flattenFigureImage(transparent)), 'data:image/jpeg;base64,/9j/4A=='],
    inputText: 'system\n\nArticle\n\n[figure:1]',
  })
  expect(getProviderImageDataUrl(flattenFigureImage(transparent))).not.toBe(getProviderImageDataUrl(transparent))
})
