import {readFileSync} from 'node:fs'

import {beforeEach, expect, mock, test} from 'bun:test'

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

beforeEach(() => {
  runJsonTurn.mockReset()
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
